// background.js - Updated to use IndexedDB for large data storage

// ============ INDEXEDDB SETUP (duplicated for service worker context) ============
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

// ============ MAIN EXTENSION LOGIC ============

chrome.action.onClicked.addListener((tab) => {
    chrome.sidePanel.open({ windowId: tab.windowId });
});

let isProcessing = false;
let currentTabId = null;
let promptSent = false;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "START_PROCESSING") handleStartRequest();
    if (request.action === "LOG") chrome.runtime.sendMessage({ action: "UI_LOG", message: request.message });
    if (request.action === "PROMPT_SENT") handlePromptSent();
    if (request.action === "JOB_PROCESSED") processCompletedJob(request.aiResult, request.originalJob, request.fileId);
});

function handlePromptSent() {
    promptSent = true;
    chrome.runtime.sendMessage({ action: "UI_LOG", message: "✅ Prompt sent. Starting jobs..." });
    setTimeout(processNextJob, 2000);
}

async function handleStartRequest() {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url.includes("gemini.google.com")) {
            chrome.runtime.sendMessage({ action: "UI_LOG", message: "❌ Open Gemini first!" });
            return;
        }
        currentTabId = tab.id;
        isProcessing = true;
        chrome.runtime.sendMessage({ action: "UI_LOG", message: "✅ Connected to Gemini tab." });
        
        // Initialize DB
        try {
            await initDB();
            chrome.runtime.sendMessage({ action: "UI_LOG", message: "✅ Database initialized." });
        } catch (dbError) {
            chrome.runtime.sendMessage({ action: "UI_LOG", message: `❌ Database init failed: ${dbError.message}` });
            isProcessing = false;
            return;
        }
        
        chrome.scripting.executeScript({
            target: { tabId: currentTabId },
            files: ["content.js"]
        }, (results) => {
            if (chrome.runtime.lastError) {
                chrome.runtime.sendMessage({ action: "UI_LOG", message: `❌ Script injection failed: ${chrome.runtime.lastError.message}` });
                isProcessing = false;
                return;
            }
            
            if (!promptSent) {
                chrome.runtime.sendMessage({ action: "UI_LOG", message: "📝 Sending initial prompt to Gemini..." });
                chrome.tabs.sendMessage(currentTabId, { action: "SEND_INITIAL_PROMPT" });
            } else {
                processNextJob();
            }
        });
    } catch (error) {
        chrome.runtime.sendMessage({ action: "UI_LOG", message: `❌ Start failed: ${error.message}` });
        isProcessing = false;
    }
}

async function processNextJob() {
    if (!isProcessing) return;

    try {
        chrome.storage.local.get(['fileQueue'], async (result) => {
            try {
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
                    isProcessing = false;
                    promptSent = false;
                    chrome.runtime.sendMessage({ action: "UI_LOG", message: "🎉 All files finished! Preparing export..." });
                    
                    // AUTO-EXPORT CSV (sidepanel will handle cleanup)
                    chrome.runtime.sendMessage({ action: "AUTO_EXPORT_CSV" });
                    return;
                }

                // Get job data from IndexedDB
                let jobs;
                try {
                    jobs = await getJobData(targetFile.id);
                } catch (dbError) {
                    chrome.runtime.sendMessage({ action: "UI_LOG", message: `❌ DB read error: ${dbError.message}` });
                    // Skip this file and continue
                    files[targetFileIndex].status = 'complete';
                    chrome.storage.local.set({ fileQueue: files });
                    setTimeout(processNextJob, 1000);
                    return;
                }
                
                if (!jobs || jobs.length === 0) {
                    chrome.runtime.sendMessage({ action: "UI_LOG", message: `⚠️ No jobs found for file "${targetFile.name}", skipping...` });
                    files[targetFileIndex].status = 'complete';
                    chrome.storage.local.set({ fileQueue: files });
                    setTimeout(processNextJob, 1000);
                    return;
                }

                // Find the next unprocessed job in this file
                const currentJobIndex = targetFile.currentJobIndex || 0;
                
                if (currentJobIndex >= jobs.length) {
                    files[targetFileIndex].status = 'complete';
                    chrome.storage.local.set({ fileQueue: files }, () => {
                        chrome.runtime.sendMessage({ action: "UI_LOG", message: `🏁 File "${targetFile.name}" completed!` });
                        chrome.runtime.sendMessage({ action: "JOB_PROCESSED_UI_UPDATE" });
                        setTimeout(processNextJob, 1000);
                    });
                    return;
                }

                const currentJob = jobs[currentJobIndex];

                // Update status to processing
                if (targetFile.status === 'pending') {
                    files[targetFileIndex].status = 'processing';
                    chrome.storage.local.set({ fileQueue: files });
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
                chrome.tabs.sendMessage(currentTabId, {
                    action: "PROMPT_GEMINI",
                    job: currentJob,
                    fileId: targetFile.id,
                    jobIndex: currentJobIndex
                }, (response) => {
                    if (chrome.runtime.lastError) {
                        chrome.runtime.sendMessage({ action: "UI_LOG", message: `⚠️ Message send warning: ${chrome.runtime.lastError.message}` });
                    }
                });
            } catch (innerError) {
                chrome.runtime.sendMessage({ action: "UI_LOG", message: `❌ Processing error: ${innerError.message}` });
                setTimeout(processNextJob, 3000); // Retry after delay
            }
        });
    } catch (error) {
        chrome.runtime.sendMessage({ action: "UI_LOG", message: `❌ Critical error: ${error.message}` });
        isProcessing = false;
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
            // Continue anyway - don't block the queue
        }

        // Update file progress in chrome.storage
        chrome.storage.local.get(['fileQueue'], (result) => {
            if (chrome.runtime.lastError) {
                chrome.runtime.sendMessage({ action: "UI_LOG", message: `❌ Storage read error: ${chrome.runtime.lastError.message}` });
                setTimeout(processNextJob, 2000);
                return;
            }

            const files = result.fileQueue || [];
            const fileIndex = files.findIndex(f => f.id === fileId);
            
            if (fileIndex !== -1) {
                files[fileIndex].currentJobIndex = (files[fileIndex].currentJobIndex || 0) + 1;
                files[fileIndex].processedCount = files[fileIndex].currentJobIndex;

                // Check if this file is complete
                if (files[fileIndex].currentJobIndex >= files[fileIndex].totalJobs) {
                    files[fileIndex].status = 'complete';
                    chrome.runtime.sendMessage({ action: "UI_LOG", message: `🏁 File "${files[fileIndex].name}" completed!` });
                }

                chrome.storage.local.set({ fileQueue: files }, () => {
                    if (chrome.runtime.lastError) {
                        chrome.runtime.sendMessage({ action: "UI_LOG", message: `❌ Storage write error: ${chrome.runtime.lastError.message}` });
                    }
                    chrome.runtime.sendMessage({ action: "JOB_PROCESSED_UI_UPDATE" });
                    setTimeout(processNextJob, 2000);
                });
            } else {
                chrome.runtime.sendMessage({ action: "UI_LOG", message: `⚠️ File tracking error (ID: ${fileId}), continuing...` });
                setTimeout(processNextJob, 2000);
            }
        });
    } catch (error) {
        chrome.runtime.sendMessage({ action: "UI_LOG", message: `❌ Job completion error: ${error.message}` });
        // Don't stop - try to continue with next job
        setTimeout(processNextJob, 2000);
    }
}
