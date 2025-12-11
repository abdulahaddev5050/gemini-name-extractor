// background.js
const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxIZO-LIzGXWpu-co75_3ONCqGOuN4Lj_OCKyJ5bKHuZ8Z3asDA7MAGuKovOiT_I40C/exec";

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

let isProcessing = false;
let currentTabId = null;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "START_PROCESSING") handleStartRequest();
  if (request.action === "LOG") chrome.runtime.sendMessage({ action: "UI_LOG", message: request.message });
  if (request.action === "JOB_PROCESSED") processCompletedJob(request.aiResult, request.originalJob, request.fileId);
});

async function handleStartRequest() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url.includes("gemini.google.com")) {
    chrome.runtime.sendMessage({ action: "UI_LOG", message: "❌ Open Gemini first!" });
    return;
  }
  currentTabId = tab.id;
  isProcessing = true;
  chrome.runtime.sendMessage({ action: "UI_LOG", message: "✅ Connected." });
  
  chrome.scripting.executeScript({
    target: { tabId: currentTabId },
    files: ["content.js"]
  }, () => { processNextJob(); });
}

function processNextJob() {
  if (!isProcessing) return;

  chrome.storage.local.get(['jobFiles'], (result) => {
    const files = result.jobFiles || [];
    let foundJob = null;
    let foundFileId = null;
    let foundFileIndex = -1;

    // Find the first job not marked as geminiDone
    for (let i = 0; i < files.length; i++) {
      if (foundJob) break;
      
      // If file is pending or processing, look inside
      if (files[i].status !== 'complete') {
          for (const job of files[i].data) {
            if (!job.geminiDone) {
                foundJob = job;
                foundFileId = files[i].id;
                foundFileIndex = i;
                break; 
            }
          }
      }
    }

    if (foundJob) {
      // Set status to processing if it's currently pending
      if (files[foundFileIndex].status === 'pending') {
          files[foundFileIndex].status = 'processing';
          chrome.storage.local.set({ jobFiles: files });
          chrome.runtime.sendMessage({ action: "JOB_PROCESSED_UI_UPDATE" }); // Update UI to Orange
      }

      const currentJobNum = files[foundFileIndex].processedCount + 1;
      const totalJobs = files[foundFileIndex].totalJobs;

      chrome.runtime.sendMessage({ 
          action: "UI_LOG", 
          message: `📤 Sending (${currentJobNum}/${totalJobs}): ${foundJob.title?.substring(0,20)}...` 
      });

      chrome.tabs.sendMessage(currentTabId, {
        action: "PROMPT_GEMINI",
        job: foundJob,
        fileId: foundFileId
      });
    } else {
      isProcessing = false;
      chrome.runtime.sendMessage({ action: "UI_LOG", message: "🎉 All jobs finished!" });
    }
  });
}

async function processCompletedJob(aiResult, originalJob, fileId) {
    chrome.runtime.sendMessage({ action: "UI_LOG", message: `✅ AI Responded. Saving...` });

    // --- SHEET LOGIC ---
    let finalJobUrl = originalJob.job_url || "";
    let finalJobId = originalJob.job_id || "";
    let finalParentId = originalJob.parent_id || "";

    const sheetPayload = {
        personName: aiResult.personName || [],
        companyName: aiResult.companyName || "",
        clientWebsite: aiResult.clientWebsite || "",
        confidence: aiResult.confidence || 0,
        reasoning: aiResult.reasoning || "",
        job_url: finalJobUrl,
        job_id: finalJobId,
        parent_id: finalParentId
    };

    // --- SEND TO GOOGLE SHEETS ---
    try {
        await fetch(GOOGLE_SCRIPT_URL, {
            method: "POST",
            mode: "no-cors",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(sheetPayload)
        });
        chrome.runtime.sendMessage({ action: "UI_LOG", message: `📊 Saved to Sheet` });
    } catch (e) {
        chrome.runtime.sendMessage({ action: "UI_LOG", message: `❌ Sheet Error: ${e.message}` });
    }

    // --- MARK JOB AS DONE IN LOCAL STORAGE ---
    chrome.storage.local.get(['jobFiles'], (result) => {
        const files = result.jobFiles || [];
        const fileIndex = files.findIndex(f => f.id === fileId);
        
        if (fileIndex !== -1) {
            const jobIndex = files[fileIndex].data.findIndex(j => 
                (j.job_url && j.job_url === originalJob.job_url) || 
                (j.job_id && j.job_id === originalJob.job_id)
            );

            if (jobIndex !== -1) {
                files[fileIndex].data[jobIndex].geminiDone = true;
                files[fileIndex].processedCount++;

                // CHECK COMPLETION
                if(files[fileIndex].processedCount >= files[fileIndex].totalJobs) {
                    files[fileIndex].status = "complete";
                    chrome.runtime.sendMessage({ action: "UI_LOG", message: `🏁 File Completed!` });
                }

                chrome.storage.local.set({ jobFiles: files }, () => {
                    // Update the UI Table (Pending -> Running -> Complete)
                    chrome.runtime.sendMessage({ action: "JOB_PROCESSED_UI_UPDATE" });
                    
                    // Loop next job
                    setTimeout(processNextJob, 3000); 
                });
            }
        }
    });
}