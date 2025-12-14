// content.js - Wrapped to prevent duplicate injection errors

// Guard: Only run if not already injected
if (typeof window.__GEMINI_EXTRACTOR_LOADED__ === 'undefined') {
    window.__GEMINI_EXTRACTOR_LOADED__ = true;

    // --- CONFIGURATION ---
    const MAX_WAIT_TIME = 90000; // 90 seconds max timeout per job

    // --- SYSTEM PROMPT (sent with each job) ---
    const SYSTEM_PROMPT = `You are an advanced Information Extraction AI with deep semantic understanding. Your goal is to read a job post and identify the **Identity of the Client** (Person/Company) and their **Owned Digital Assets** (Website). 

You must distinguish between the **Subject** (the client hiring), the **Objects** (tools, targets, platforms being used), and the **Topic** (the work being done).

**Core Extraction Logic:**

1. **Person Name (The "Who"):**
   - **Goal:** Identify the specific human managing this project.
   - **Intelligence Check:** Look for names used in a communicative context (e.g., "Thanks, Keith", "Contact Sarah", "I am David"). 
   - **Avoid:** Famous figures mentioned as examples (e.g., "Write like Shakespeare") or personas (e.g., "Act like a customer").

2. **Company Name (The "Entity"):**
   - **Goal:** Extract the **explicit legal or trade name** of the hiring organization.
   - **Intelligence Check (Agent vs. Instrument):** - "We are **Google**" -> EXTRACT (Agent).
     - "We use **Slack**" -> IGNORE (Instrument/Tool).
     - "We need an **SEO Expert**" -> IGNORE (Job Title/Topic).
   - **CRITICAL ANTI-HALLUCINATION RULE:** Do not "summarize" the job into a company name. If the user says "I have a food blog," and never names it, the Company Name is \`""\`. **Do not** output "Food Blog Client" or "SEO Project Client". If the name is not explicitly written, return an empty string.

3. **Client Website (The "Property"):**
   - **Goal:** Extract the URL that belongs to the client.
   - **Intelligence Check (Ownership vs. Target):**
     - **Ownership Signals:** "My site", "Our portal", "Redesign [URL]", "Login to [URL]". -> EXTRACT.
     - **Target Signals:** "Scrape [URL]", "Research [URL]", "Competitor is [URL]", "Leads from [URL]". -> IGNORE (This is a target, not the client).

**Strict JSON Output:**

{
  "personName": ["Name1"], 
  "companyName": "Explicit Name OR Empty String",
  "clientWebsite": "URL OR Empty String",
  "confidence": 0.0 to 1.0,
  "reasoning": "Explain WHY you extracted these. Explicitly state why a URL was kept (Ownership) or rejected (Target). Explain why a text string was identified as a Company and not a Tool."
}

`;

    // --- HELPER FUNCTIONS ---
    function sendLog(msg) {
        chrome.runtime.sendMessage({ action: "LOG", message: msg });
    }

    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // --- SEND JOB DATA (prompt + data combined each time) ---
    async function sendJobData(rawJobData, fileId) {
        try {
            sendLog(`📋 Processing: ${rawJobData.title?.substring(0, 25) || "Untitled"}...`);

            // Rename keys to match the prompt's expected format
            const dataToSendToAI = {
                jobTitle: rawJobData.title || "",
                jobDescription: rawJobData.summary || "",
                feedbackReceivedFromFreelancers: Array.isArray(rawJobData.feedback_received_From_Freelancer) 
                    ? rawJobData.feedback_received_From_Freelancer 
                    : []
            };

            // Combine prompt + data in every message
            const fullMessage = `${SYSTEM_PROMPT}

--------------------------------------------------
HERE IS THE NEW INPUT DATA:

${JSON.stringify(dataToSendToAI, null, 2)}`;

            // --- TYPE & SEND ---
            const initialCount = document.querySelectorAll('.model-response-text').length;
            await humanTypeAndSend(fullMessage, initialCount);
            await waitForTextStability();

            // --- EXTRACT RESPONSE ---
            const responseContainers = document.querySelectorAll('.model-response-text');
            if (responseContainers.length === 0) throw new Error("No response found");
            
            const lastResponse = responseContainers[responseContainers.length - 1];
            let responseText = lastResponse.innerText;

            // Clean Markdown
            responseText = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
            
            // Parse JSON
            let parsedAI = {};
            const jsonStart = responseText.indexOf('{');
            const jsonEnd = responseText.lastIndexOf('}');
            
            if (jsonStart !== -1 && jsonEnd !== -1) {
                try {
                    parsedAI = JSON.parse(responseText.substring(jsonStart, jsonEnd + 1));
                } catch (e) {
                    parsedAI = { reasoning: "Error Parsing JSON: " + e.message };
                }
            } else {
                parsedAI = { reasoning: "No JSON found in response" };
            }

            // --- DONE ---
            chrome.runtime.sendMessage({
                action: "JOB_PROCESSED",
                aiResult: parsedAI,
                originalJob: rawJobData,
                fileId: fileId
            });

        } catch (error) {
            sendLog("❌ Error: " + error.message);
            // Still send JOB_PROCESSED so the loop continues
            chrome.runtime.sendMessage({
                action: "JOB_PROCESSED",
                aiResult: { 
                    personName: [],
                    companyName: "",
                    clientWebsite: "",
                    confidence: 0,
                    reasoning: "Script Error: " + error.message 
                },
                originalJob: rawJobData,
                fileId: fileId
            });
        }
    }

    // *** HUMAN TYPING SIMULATION ***
    async function humanTypeAndSend(text, initialCount) {
        // Try multiple selectors for Gemini input
        const editor = document.querySelector('.ql-editor') || 
                       document.querySelector('[contenteditable="true"]') ||
                       document.querySelector('rich-textarea');
        if (!editor) throw new Error("Input box not found - Gemini UI may have changed");
        
        // 1. CLEAR EDITOR
        editor.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        editor.innerHTML = '<p><br></p>'; 
        await delay(800); 

        // 2. TYPE THE TEXT (Chunked for speed + reliability)
        const chunks = text.match(/.{1,15}/g) || [];
        
        for (const chunk of chunks) {
            document.execCommand('insertText', false, chunk);
            await delay(Math.random() * 40 + 10);
            editor.scrollTop = editor.scrollHeight;
        }

        // 3. FINAL DELAY
        await delay(1000);

        // 4. PRESS ENTER
        const enterEvent = new KeyboardEvent('keydown', {
            bubbles: true, cancelable: true, keyCode: 13, key: 'Enter', code: 'Enter'
        });
        editor.dispatchEvent(enterEvent);
        
        await delay(500);

        // 5. SAFETY CHECK: CLICK SEND BUTTON IF ENTER FAILED
        let attempts = 0;
        while (attempts < 15) {
            const currentCount = document.querySelectorAll('.model-response-text').length;
            if (currentCount > initialCount) {
                sendLog("✅ Gemini started generating...");
                return;
            }

            const stopBtn = document.querySelector('button[aria-label="Stop response"]') ||
                            document.querySelector('button[aria-label="Stop"]');
            if (stopBtn) {
                sendLog("✅ Gemini is generating (Stop button visible)...");
                return;
            }

            const sendBtn = document.querySelector('button[aria-label="Send message"]');
                            
            if (sendBtn && !sendBtn.disabled && sendBtn.getAttribute('aria-disabled') !== 'true') {
                sendLog(`🔄 Attempt ${attempts + 1}: Clicking Send button...`);
                sendBtn.click();
                await delay(2000);
            } else {
                sendLog(`⏳ Attempt ${attempts + 1}: Waiting for Send button...`);
                document.execCommand('insertText', false, " ");
                await delay(1500);
            }

            attempts++;
        }
        
        throw new Error("Failed to start Gemini response after 15 attempts.");
    }

    async function waitForTextStability() {
        sendLog("Waiting for text to complete...");
        
        let stableCount = 0;
        let lastLength = 0;
        let timeElapsed = 0;

        while (timeElapsed < MAX_WAIT_TIME) {
            await delay(1000);
            timeElapsed += 1000;

            const responses = document.querySelectorAll('.model-response-text');
            if (responses.length === 0) continue;

            const lastResponse = responses[responses.length - 1];
            const currentLength = lastResponse.innerText.length;

            if (currentLength > 0 && currentLength === lastLength) {
                stableCount++;
                if (stableCount >= 3) {
                    return;
                }
            } else {
                stableCount = 0;
                lastLength = currentLength;
            }
        }
        throw new Error("Timeout waiting for text stability.");
    }

    // --- MESSAGE LISTENER (only set up once) ---
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === "PROMPT_GEMINI") {
            sendJobData(request.job, request.fileId);
        }
    });

    console.log("✅ Gemini Client Extractor: Content script loaded");
} else {
    console.log("ℹ️ Gemini Client Extractor: Content script already loaded, skipping...");
}
