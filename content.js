// content.js - Wrapped to prevent duplicate injection errors

// Guard: Only run if not already injected
if (typeof window.__GEMINI_EXTRACTOR_LOADED__ === 'undefined') {
    window.__GEMINI_EXTRACTOR_LOADED__ = true;

    // --- CONFIGURATION ---
    const MAX_WAIT_TIME = 90000; // 90 seconds max timeout per job

    // --- INITIAL PROMPT (sent only once per session) ---
    const SYSTEM_PROMPT = `You are an expert Information Extraction and Named Entity Recognition (NER) system. Your task is to analyze the provided JSON data, which represents a job posting, and extract three specific entities: the **Hiring Company Name(s)**, the **Specific Person Name(s)** associated with managing the job or communicating with freelancers, and the **Client Website URL**.

Constraints & Guidelines:
1. Scope: The entities can appear anywhere within the jobTitle, jobDescription, or feedbackReceivedFromFreelancers fields.
2. Person Name Extraction: Focus on the names of individuals who appear to be the client, manager, or point of contact (e.g., "Keith"). Multiple names should be captured in the list.
3. Company Name Extraction: Focus on the actual Hiring Company/Client. Distinguish between the actual hiring company and any other organizations, tools, or platforms (e.g., Slack).
4. Client Website Extraction (CRITICAL): 
   - Extract a single, complete website URL ONLY if the context implies **ownership** or **affiliation** (e.g., "check our website at...", "rebuild my site [URL]").
   - **EXCLUSION RULE:** Do NOT extract URLs that are the **Target** or **Source** of the work. If the job is to "scrape data from [URL]", "generate leads from [URL]", or "analyze competitor [URL]", this is a tool/source, NOT the client's website. Return an empty string in these cases.
5. No Tool/Platform Names: Do not extract names of programming languages, databases, or non-hiring-client tools (e.g., PHP, MySQL, Zapier).
6. Confidence: Provide a numerical confidence score (0.0 to 1.0). A high confidence (e.g., 0.9 or 1.0) means the name/website is explicitly confirmed as the hiring entity.
7. Reasoning (CONCISE): Provide a **brief, factual, step-by-step justification**. For the website, explicitly state if the URL is a "Target/Source" or "Owned Entity".

Required Output Format (Strict JSON):
{
  "personName": [
    "Name 1",
    "Name 2"
  ],
  "companyName": "The Company Name",
  "clientWebsite": "http://example.com",
  "confidence": 0.0,
  "reasoning": "1. Person Name(s) found in [Section] as 'Text Fragment'. 2. Company Name found in [Section] as 'Text Fragment'. 3. Client Website determination: [URL] identified as [Target/Source/Owned] based on 'Text Fragment'."
}

Please wait for the JSON data to be provided in the user message.`;

    // --- HELPER FUNCTIONS ---
    function sendLog(msg) {
        chrome.runtime.sendMessage({ action: "LOG", message: msg });
    }

    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // --- STEP 1: SEND INITIAL PROMPT (only once) ---
    async function sendInitialPrompt() {
        try {
            sendLog("📝 Sending system prompt...");
            
            const initialCount = document.querySelectorAll('.model-response-text').length;
            await humanTypeAndSend(SYSTEM_PROMPT, initialCount);
            await waitForTextStability();
            
            sendLog("✅ Gemini acknowledged prompt.");
            
            // Notify background that prompt is done, start sending jobs
            chrome.runtime.sendMessage({ action: "PROMPT_SENT" });
            
        } catch (error) {
            sendLog("❌ Error sending prompt: " + error.message);
        }
    }

    // --- STEP 2: SEND JOB DATA (for each job) ---
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

            // Just send the JSON data (not the prompt)
            const jsonMessage = JSON.stringify(dataToSendToAI, null, 2);

            // --- TYPE & SEND ---
            const initialCount = document.querySelectorAll('.model-response-text').length;
            await humanTypeAndSend(jsonMessage, initialCount);
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
        if (request.action === "SEND_INITIAL_PROMPT") {
            sendInitialPrompt();
        }
        if (request.action === "PROMPT_GEMINI") {
            sendJobData(request.job, request.fileId);
        }
    });

    console.log("✅ Gemini Client Extractor: Content script loaded");
} else {
    console.log("ℹ️ Gemini Client Extractor: Content script already loaded, skipping...");
}
