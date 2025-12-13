// background.js - Fixed race condition with proper locking

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

// ============ STATE MANAGEMENT ============
const ALARM_NAME = 'processNextJob';
const TIMEOUT_ALARM = 'typingTimeout';
const STATE_KEY = 'processingState';
const TYPING_TIMEOUT_SECONDS = 180; // 3 minutes max for any single job

async function getState() {
    return new Promise((resolve) => {
        chrome.storage.local.get([STATE_KEY], (result) => {
            resolve(result[STATE_KEY] || {
                isProcessing: false,
                promptSent: false,
                currentTabId: null,
                isTyping: false,
                typingStartedAt: null  // Track when typing started
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
    chrome.alarms.clear(TIMEOUT_ALARM);
    return setState({
        isProcessing: false,
        promptSent: false,
        currentTabId: null,
        isTyping: false,
        typingStartedAt: null
    });
}

// ============ ALARM HANDLER ============
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === ALARM_NAME) {
        const state = await getState();
        
        // CRITICAL: Don't process if already typing
        if (state.isTyping) {
            console.log('⏳ Still typing, skipping alarm');
            return;
        }
        
        console.log('⏰ Alarm fired - processing next job');
        await processNextJob();
    }
    
    // SAFETY TIMEOUT: If typing takes too long, force reset and retry
    if (alarm.name === TIMEOUT_ALARM) {
        const state = await getState();
        
        if (state.isTyping && state.typingStartedAt) {
            const elapsed = Date.now() - state.typingStartedAt;
            console.log(`⚠️ Typing timeout! Elapsed: ${elapsed}ms`);
            
            chrome.runtime.sendMessage({ 
                action: "UI_LOG", 
                message: `⚠️ Job timed out (${Math.round(elapsed/1000)}s). Retrying...` 
            });
            
            // Force reset the lock and retry the same job
            await setState({ isTyping: false, typingStartedAt: null });
            scheduleNextJob(2);
        }
    }
});

function scheduleNextJob(delaySeconds = 3) {
    // ALWAYS clear existing alarm first to prevent duplicates
    chrome.alarms.clear(ALARM_NAME, () => {
        chrome.alarms.create(ALARM_NAME, { delayInMinutes: delaySeconds / 60 });
        console.log(`📅 Scheduled next job in ${delaySeconds}s`);
    });
}

function cancelScheduledJob() {
    chrome.alarms.clear(ALARM_NAME);
}

// ============ SERVICE WORKER STARTUP ============
chrome.runtime.onStartup.addListener(async () => {
    console.log('🔄 Service worker started');
    const state = await getState();
    if (state.isProcessing && !state.isTyping) {
        chrome.runtime.sendMessage({ action: "UI_LOG", message: "🔄 Resuming processing..." });
        scheduleNextJob(2);
    }
});

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
    if (request.action === "LOG") {
        try { chrome.runtime.sendMessage({ action: "UI_LOG", message: request.message }); } catch(e) {}
    }
    if (request.action === "PROMPT_SENT") handlePromptSent();
    if (request.action === "JOB_PROCESSED") processCompletedJob(request.aiResult, request.originalJob, request.fileId);
    if (request.action === "STOP_PROCESSING") stopProcessing();
});

async function stopProcessing() {
    cancelScheduledJob();
    chrome.alarms.clear(TIMEOUT_ALARM);
    await clearState();
    chrome.runtime.sendMessage({ action: "UI_LOG", message: "⏹️ Processing stopped." });
    chrome.runtime.sendMessage({ action: "JOB_PROCESSED_UI_UPDATE" });
}

async function handlePromptSent() {
    chrome.alarms.clear(TIMEOUT_ALARM);
    await setState({ promptSent: true, isTyping: false, typingStartedAt: null });
    chrome.runtime.sendMessage({ action: "UI_LOG", message: "✅ Prompt acknowledged. Starting jobs..." });
    scheduleNextJob(2);
}

async function handleStartRequest() {
    try {
        const state = await getState();
        
        // Prevent double-start
        if (state.isTyping) {
            chrome.runtime.sendMessage({ action: "UI_LOG", message: "⏳ Already processing, please wait..." });
            return;
        }
        
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url.includes("gemini.google.com")) {
            chrome.runtime.sendMessage({ action: "UI_LOG", message: "❌ Open Gemini first!" });
            return;
        }
        
        await setState({
            isProcessing: true,
            currentTabId: tab.id,
            isTyping: false
        });
        
        chrome.runtime.sendMessage({ action: "UI_LOG", message: "✅ Connected to Gemini tab." });
        
        try {
            await initDB();
        } catch (dbError) {
            chrome.runtime.sendMessage({ action: "UI_LOG", message: `❌ Database error: ${dbError.message}` });
            await clearState();
            return;
        }
        
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["content.js"]
        }, async () => {
            if (chrome.runtime.lastError) {
                chrome.runtime.sendMessage({ action: "UI_LOG", message: `❌ Script error: ${chrome.runtime.lastError.message}` });
                await clearState();
                return;
            }
            
            const currentState = await getState();
            if (!currentState.promptSent) {
                chrome.runtime.sendMessage({ action: "UI_LOG", message: "📝 Sending prompt to Gemini..." });
                await setState({ isTyping: true, typingStartedAt: Date.now() });
                chrome.alarms.create(TIMEOUT_ALARM, { delayInMinutes: TYPING_TIMEOUT_SECONDS / 60 });
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
    
    // CRITICAL: Check if already typing
    if (state.isTyping) {
        console.log('Already typing - skipping');
        return;
    }

    try {
        const result = await chrome.storage.local.get(['fileQueue']);
        const files = result.fileQueue || [];
        
        // Find first incomplete file
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
            await clearState();
            chrome.runtime.sendMessage({ action: "UI_LOG", message: "🎉 All files finished!" });
            chrome.runtime.sendMessage({ action: "AUTO_EXPORT_CSV" });
            return;
        }

        // Get job data
        let jobs;
        try {
            jobs = await getJobData(targetFile.id);
        } catch (dbError) {
            chrome.runtime.sendMessage({ action: "UI_LOG", message: `❌ DB error: ${dbError.message}` });
            files[targetFileIndex].status = 'complete';
            await chrome.storage.local.set({ fileQueue: files });
            scheduleNextJob(2);
            return;
        }
        
        if (!jobs || jobs.length === 0) {
            chrome.runtime.sendMessage({ action: "UI_LOG", message: `⚠️ No jobs in "${targetFile.name}", skipping...` });
            files[targetFileIndex].status = 'complete';
            await chrome.storage.local.set({ fileQueue: files });
            chrome.runtime.sendMessage({ action: "JOB_PROCESSED_UI_UPDATE" });
            scheduleNextJob(1);
            return;
        }

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

        // Update status
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
            message: `📤 Job ${displayNum}/${totalJobs}: ${jobTitle.substring(0, 25)}...`
        });

        // SET LOCK before sending to content script
        await setState({ isTyping: true, typingStartedAt: Date.now() });
        
        // Start safety timeout timer
        chrome.alarms.create(TIMEOUT_ALARM, { delayInMinutes: TYPING_TIMEOUT_SECONDS / 60 });

        // Send to content script
        chrome.tabs.sendMessage(state.currentTabId, {
            action: "PROMPT_GEMINI",
            job: currentJob,
            fileId: targetFile.id,
            jobIndex: currentJobIndex
        });
        
        // Note: We do NOT schedule next job here!
        // It will be scheduled by processCompletedJob when content.js responds

    } catch (error) {
        chrome.runtime.sendMessage({ action: "UI_LOG", message: `❌ Error: ${error.message}` });
        chrome.alarms.clear(TIMEOUT_ALARM);
        await setState({ isTyping: false, typingStartedAt: null });
        scheduleNextJob(5);
    }
}

async function processCompletedJob(aiResult, originalJob, fileId) {
    try {
        // RELEASE LOCK and clear timeout alarm
        chrome.alarms.clear(TIMEOUT_ALARM);
        await setState({ isTyping: false, typingStartedAt: null });
        
        chrome.runtime.sendMessage({ action: "UI_LOG", message: `✅ AI responded. Saving...` });

        if (!aiResult) {
            aiResult = { personName: [], companyName: "", clientWebsite: "", confidence: 0, reasoning: "Empty response" };
        }

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
            chrome.runtime.sendMessage({ action: "UI_LOG", message: `💾 Saved to database` });
        } catch (dbError) {
            chrome.runtime.sendMessage({ action: "UI_LOG", message: `⚠️ Save warning: ${dbError.message}` });
        }

        // Update progress
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

        // Schedule next job (only place this should be called during normal processing)
        scheduleNextJob(3);
        
    } catch (error) {
        chrome.runtime.sendMessage({ action: "UI_LOG", message: `❌ Completion error: ${error.message}` });
        chrome.alarms.clear(TIMEOUT_ALARM);
        await setState({ isTyping: false, typingStartedAt: null });
        scheduleNextJob(3);
    }
}
