// background.js - Uses chrome.alarms to survive service worker sleep

// ============ INDEXEDDB SETUP ============
const DB_NAME = 'GeminiExtractorDB';
const DB_VERSION = 1;
const STORES = { JOB_DATA: 'jobData', RESULTS: 'results' };

let dbInstance = null;

function initDB() {
    return new Promise((resolve, reject) => {
        if (dbInstance) { resolve(dbInstance); return; }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => { dbInstance = request.result; resolve(dbInstance); };
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORES.JOB_DATA)) {
                db.createObjectStore(STORES.JOB_DATA, { keyPath: 'fileId' });
            }
            if (!db.objectStoreNames.contains(STORES.RESULTS)) {
                const store = db.createObjectStore(STORES.RESULTS, { keyPath: 'id', autoIncrement: true });
                store.createIndex('fileId', 'fileId', { unique: false });
            }
        };
    });
}

async function getJobData(fileId) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.JOB_DATA, 'readonly');
        const store = tx.objectStore(STORES.JOB_DATA);
        const request = store.get(fileId);
        request.onsuccess = () => resolve(request.result ? request.result.jobs : null);
        request.onerror = () => reject(request.error);
    });
}

async function addResult(result) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.RESULTS, 'readwrite');
        const store = tx.objectStore(STORES.RESULTS);
        const request = store.add(result);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// ============ STATE MANAGEMENT (persisted to storage) ============
const ALARM_NAME = 'processNextJob';
const STATE_KEY = 'processingState';

async function getState() {
    return new Promise((resolve) => {
        chrome.storage.local.get([STATE_KEY], (result) => {
            resolve(result[STATE_KEY] || {
                isProcessing: false,
                promptSent: false,
                currentTabId: null
            });
        });
    });
}

async function setState(updates) {
    const current = await getState();
    const newState = { ...current, ...updates };
    return new Promise((resolve) => {
        chrome.storage.local.set({ [STATE_KEY]: newState }, resolve);
    });
}

async function clearState() {
    return setState({
        isProcessing: false,
        promptSent: false,
        currentTabId: null
    });
}

// ============ ALARM HANDLER (wakes up service worker) ============
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === ALARM_NAME) {
        console.log('⏰ Alarm fired - processing next job');
        await processNextJob();
    }
});

// Schedule next job using alarm (survives service worker sleep)
function scheduleNextJob(delaySeconds = 2) {
    chrome.alarms.create(ALARM_NAME, { delayInMinutes: delaySeconds / 60 });
}

// Cancel any pending alarms
function cancelScheduledJob() {
    chrome.alarms.clear(ALARM_NAME);
}

// ============ SERVICE WORKER STARTUP - Auto-resume ============
chrome.runtime.onStartup.addListener(async () => {
    console.log('🔄 Service worker started - checking for pending work');
    const state = await getState();
    if (state.isProcessing) {
        chrome.runtime.sendMessage({ action: "UI_LOG", message: "🔄 Resuming processing..." });
        scheduleNextJob(1);
    }
});

// Also check on install/update
chrome.runtime.onInstalled.addListener(async () => {
    console.log('📦 Extension installed/updated');
    await clearState();
});

// ============ MAIN EXTENSION LOGIC ============

chrome.action.onClicked.addListener((tab) => {
    chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "START_PROCESSING") handleStartRequest();
    if (request.action === "LOG") chrome.runtime.sendMessage({ action: "UI_LOG", message: request.message });
    if (request.action === "PROMPT_SENT") handlePromptSent();
    if (request.action === "JOB_PROCESSED") processCompletedJob(request.aiResult, request.originalJob, request.fileId);
    if (request.action === "STOP_PROCESSING") stopProcessing();
});

async function stopProcessing() {
    cancelScheduledJob();
    await clearState();
    chrome.runtime.sendMessage({ action: "UI_LOG", message: "⏹️ Processing stopped." });
}

async function handlePromptSent() {
    await setState({ promptSent: true });
    chrome.runtime.sendMessage({ action: "UI_LOG", message: "✅ Prompt sent. Starting jobs..." });
    scheduleNextJob(2);
}

async function handleStartRequest() {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url.includes("gemini.google.com")) {
            chrome.runtime.sendMessage({ action: "UI_LOG", message: "❌ Open Gemini first!" });
            return;
        }
        
        // Save state
        await setState({
            isProcessing: true,
            currentTabId: tab.id
        });
        
        chrome.runtime.sendMessage({ action: "UI_LOG", message: "✅ Connected to Gemini tab." });
        
        // Initialize DB
        try {
            await initDB();
            chrome.runtime.sendMessage({ action: "UI_LOG", message: "✅ Database initialized." });
        } catch (dbError) {
            chrome.runtime.sendMessage({ action: "UI_LOG", message: `❌ Database init failed: ${dbError.message}` });
            await clearState();
            return;
        }
        
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["content.js"]
        }, async (results) => {
            if (chrome.runtime.lastError) {
                chrome.runtime.sendMessage({ action: "UI_LOG", message: `❌ Script injection failed: ${chrome.runtime.lastError.message}` });
                await clearState();
                return;
            }
            
            const state = await getState();
            if (!state.promptSent) {
                chrome.runtime.sendMessage({ action: "UI_LOG", message: "📝 Sending initial prompt to Gemini..." });
                chrome.tabs.sendMessage(tab.id, { action: "SEND_INITIAL_PROMPT" });
            } else {
                scheduleNextJob(1);
            }
        });
    } catch (error) {
        chrome.runtime.sendMessage({ action: "UI_LOG", message: `❌ Start failed: ${error.message}` });
        await clearState();
    }
}

async function processNextJob() {
    const state = await getState();
    if (!state.isProcessing) {
        console.log('Not processing - skipping');
        return;
    }

    try {
        const result = await chrome.storage.local.get(['fileQueue']);
        const files = result.fileQueue || [];
        
        // Find the first file that's not complete
        let targetFile = null;
        let targetFileIndex = -1;
        
        for (let i = 0; i < files.length; i++) {
            if (files[i].status !== 'complete') {
                targetFile = files[i];
                targetFileIndex = i;
                break;
            }
        }

        if (!targetFile) {
            // ALL FILES COMPLETE!
            await clearState();
            chrome.runtime.sendMessage({ action: "UI_LOG", message: "🎉 All files finished! Preparing export..." });
            chrome.runtime.sendMessage({ action: "AUTO_EXPORT_CSV" });
            return;
        }

        // Get job data from IndexedDB
        let jobs;
        try {
            jobs = await getJobData(targetFile.id);
        } catch (dbError) {
            chrome.runtime.sendMessage({ action: "UI_LOG", message: `❌ DB read error: ${dbError.message}` });
            files[targetFileIndex].status = 'complete';
            await chrome.storage.local.set({ fileQueue: files });
            scheduleNextJob(1);
            return;
        }
        
        if (!jobs || jobs.length === 0) {
            chrome.runtime.sendMessage({ action: "UI_LOG", message: `⚠️ No jobs found for file "${targetFile.name}", skipping...` });
            files[targetFileIndex].status = 'complete';
            await chrome.storage.local.set({ fileQueue: files });
            scheduleNextJob(1);
            return;
        }

        // Find the next unprocessed job in this file
        const currentJobIndex = targetFile.currentJobIndex || 0;
        
        if (currentJobIndex >= jobs.length) {
            files[targetFileIndex].status = 'complete';
            await chrome.storage.local.set({ fileQueue: files });
            chrome.runtime.sendMessage({ action: "UI_LOG", message: `🏁 File "${targetFile.name}" completed!` });
            chrome.runtime.sendMessage({ action: "JOB_PROCESSED_UI_UPDATE" });
            scheduleNextJob(1);
            return;
        }

        const currentJob = jobs[currentJobIndex];

        // Update status to processing
        if (targetFile.status === 'pending') {
            files[targetFileIndex].status = 'processing';
            await chrome.storage.local.set({ fileQueue: files });
            chrome.runtime.sendMessage({ action: "JOB_PROCESSED_UI_UPDATE" });
        }

        const displayNum = currentJobIndex + 1;
        const totalJobs = jobs.length;
        const jobTitle = currentJob.title || currentJob.jobTitle || "Untitled";

        chrome.runtime.sendMessage({
            action: "UI_LOG",
            message: `📤 Sending (${displayNum}/${totalJobs}): ${jobTitle.substring(0, 20)}...`
        });

        // Send job to content script
        chrome.tabs.sendMessage(state.currentTabId, {
            action: "PROMPT_GEMINI",
            job: currentJob,
            fileId: targetFile.id,
            jobIndex: currentJobIndex
        }, (response) => {
            if (chrome.runtime.lastError) {
                chrome.runtime.sendMessage({ action: "UI_LOG", message: `⚠️ Message error: ${chrome.runtime.lastError.message}` });
                // Try to continue anyway after a delay
                scheduleNextJob(5);
            }
        });
    } catch (error) {
        chrome.runtime.sendMessage({ action: "UI_LOG", message: `❌ Processing error: ${error.message}` });
        scheduleNextJob(3); // Retry after delay
    }
}

async function processCompletedJob(aiResult, originalJob, fileId) {
    try {
        chrome.runtime.sendMessage({ action: "UI_LOG", message: `✅ AI Responded. Saving...` });

        // Validate AI result
        if (!aiResult) {
            chrome.runtime.sendMessage({ action: "UI_LOG", message: `⚠️ Empty AI result, using defaults` });
            aiResult = { personName: [], companyName: "", clientWebsite: "", confidence: 0, reasoning: "Empty response" };
        }

        // Save result to IndexedDB
        const resultEntry = {
            fileId: fileId,
            timestamp: new Date().toISOString(),
            jobTitle: originalJob?.title || originalJob?.jobTitle || "",
            personName: (aiResult.personName || []).join("; "),
            companyName: aiResult.companyName || "",
            clientWebsite: aiResult.clientWebsite || "",
            confidence: aiResult.confidence || 0,
            reasoning: aiResult.reasoning || "",
            job_url: originalJob?.job_url || "",
            job_id: originalJob?.job_id || "",
            parent_id: originalJob?.parent_id || ""
        };

        try {
            await addResult(resultEntry);
            chrome.runtime.sendMessage({ action: "UI_LOG", message: `💾 Saved to local database` });
        } catch (dbError) {
            chrome.runtime.sendMessage({ action: "UI_LOG", message: `❌ DB save error: ${dbError.message}` });
        }

        // Update file progress
        const storageResult = await chrome.storage.local.get(['fileQueue']);
        const files = storageResult.fileQueue || [];
        const fileIndex = files.findIndex(f => f.id === fileId);
        
        if (fileIndex !== -1) {
            files[fileIndex].currentJobIndex = (files[fileIndex].currentJobIndex || 0) + 1;
            files[fileIndex].processedCount = files[fileIndex].currentJobIndex;

            if (files[fileIndex].currentJobIndex >= files[fileIndex].totalJobs) {
                files[fileIndex].status = 'complete';
                chrome.runtime.sendMessage({ action: "UI_LOG", message: `🏁 File "${files[fileIndex].name}" completed!` });
            }

            await chrome.storage.local.set({ fileQueue: files });
            chrome.runtime.sendMessage({ action: "JOB_PROCESSED_UI_UPDATE" });
        }

        // Schedule next job
        scheduleNextJob(2);
        
    } catch (error) {
        chrome.runtime.sendMessage({ action: "UI_LOG", message: `❌ Job completion error: ${error.message}` });
        scheduleNextJob(2);
    }
}
