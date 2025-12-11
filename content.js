// content.js

// --- CONFIGURATION ---
const MAX_WAIT_TIME = 90000; // 90 seconds max timeout per job

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "PROMPT_GEMINI") {
    runGeminiAutomation(request.job, request.fileId);
  }
});

async function runGeminiAutomation(rawJobData, fileId) {
  try {
    sendLog(`Processing: ${rawJobData.title?.substring(0, 15)}...`);

    // --- STEP 1: PREPARE DATA ---
    let dataToSendToAI = {};
    if (rawJobData.job_url) {
        dataToSendToAI = {
            type: "Main Job Post",
            title: rawJobData.title,
            summary: rawJobData.summary,
            freelancer_feedback: Array.isArray(rawJobData.feedback_received_From_Freelancer) 
                ? rawJobData.feedback_received_From_Freelancer : [],
            client_context: rawJobData.about_the_client || {}
        };
    } else {
        dataToSendToAI = {
            type: "Past Job History",
            title: rawJobData.title,
            summary: rawJobData.summary
        };
    }

    // --- STEP 2: CONSTRUCT PROMPT ---
    const prompt = `
You are an expert Information Extraction and Named Entity Recognition (NER) system. Your task is to analyze the provided JSON data, which represents a job posting, and extract three specific entities: the **Hiring Company Name(s)**, the **Specific Person Name(s)** associated with managing the job or communicating with freelancers, and the **Client Website URL**.

Constraints & Guidelines:
1. Scope: The entities can appear anywhere within the jobTitle, jobDescription, or feedbackReceivedFromFreelancers fields.
2. Person Name Extraction: Focus on the names of individuals who appear to be the client, manager, or point of contact (e.g., "Keith"). Multiple names should be captured in the list.
3. Company Name Extraction: Focus on the actual Hiring Company/Client. Distinguish between the actual hiring company and any other organizations, tools, or platforms (e.g., Slack). If the company name is part of a team name (e.g., "PeopleMovers Team"), extract the company-specific part ("PeopleMovers").
4. Client Website Extraction: Extract a single, complete website URL (e.g., www.example.com or https://example.net) mentioned by the client/company in the job post. If no website is explicitly mentioned, return an empty string for this field.
5. No Tool/Platform Names: Do not extract names of programming languages, databases, or non-hiring-client tools (e.g., PHP, MySQL, Zapier).
6. Confidence: Provide a numerical confidence score (0.0 to 1.0) for the extraction quality. A high confidence (e.g., 0.9 or 1.0) means the name is explicitly confirmed, typically within the feedback section.
7. Reasoning (CONCISE): Provide a **brief, factual, step-by-step justification** that **only** states the specific section (e.g., jobDescription, feedbackReceivedFromFreelancers) and the corresponding text fragment where each entity (person name, company name, and website) was found. **DO NOT over-explain the entity classification or the constraint logic.**

DATA:
${JSON.stringify(dataToSendToAI)}

Required Output Format (Strict JSON):
\`\`\`json
{
  "personName": [
    "Name 1",
    "Name 2"
  ],
  "companyName": "The Company Name",
  "clientWebsite": "http://example.com",
  "confidence": 0.0,
  "reasoning": "1. Person Name(s) found in [Section] as 'Text Fragment'. 2. Company Name found in [Section] as 'Text Fragment'. 3. Client Website found in [Section] as 'Text Fragment'."
}\`\`\`
`;

    // --- STEP 3: HUMAN TYPING & SEND ---
    const initialCount = document.querySelectorAll('.model-response-text').length;
    
    // Use the new human-like typer
    await humanTypeAndSend(prompt, initialCount);

    // --- STEP 4: WAIT FOR TEXT STABILITY ---
    await waitForTextStability();

    // --- STEP 5: EXTRACT RESPONSE ---
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

    // --- STEP 6: DONE ---
    chrome.runtime.sendMessage({
        action: "JOB_PROCESSED",
        aiResult: parsedAI,
        originalJob: rawJobData,
        fileId: fileId
    });

  } catch (error) {
    sendLog("Error: " + error.message);
    chrome.runtime.sendMessage({
        action: "JOB_PROCESSED",
        aiResult: { reasoning: "Script Error: " + error.message },
        originalJob: rawJobData,
        fileId: fileId
    });
  }
}

// --- HELPER FUNCTIONS ---

function sendLog(msg) {
    chrome.runtime.sendMessage({ action: "LOG", message: msg });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// *** NEW: HUMAN TYPING SIMULATION ***
async function humanTypeAndSend(text, initialCount) {
    const editor = document.querySelector('.ql-editor');
    if (!editor) throw new Error("Input box not found");
    
    // 1. CLEAR EDITOR (Fast)
    editor.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    editor.innerHTML = '<p><br></p>'; 
    await delay(800); 

    // 2. TYPE THE TEXT (Chunked for speed + reliability)
    // Typing 1000 characters one-by-one is too slow. 
    // We type in "chunks" of words to be fast but still trigger events.
    const chunks = text.match(/.{1,15}/g); // Split into chunks of 15 chars
    
    for (const chunk of chunks) {
        // Insert chunk
        document.execCommand('insertText', false, chunk);
        
        // Random "thinking" delay between chunks (10ms - 50ms)
        // This mimics fast typing without freezing the browser
        await delay(Math.random() * 40 + 10);
        
        // Force scroll to bottom so Gemini sees activity
        editor.scrollTop = editor.scrollHeight;
    }

    // 3. FINAL DELAY (Let UI catch up)
    await delay(1000);

    // 4. PRESS ENTER (Simulate KeyPress)
    // This is often better than clicking the button
    const enterEvent = new KeyboardEvent('keydown', {
        bubbles: true, cancelable: true, keyCode: 13, key: 'Enter', code: 'Enter'
    });
    editor.dispatchEvent(enterEvent);
    
    await delay(500); // Wait for enter to register

    // 5. SAFETY CHECK: CLICK BUTTON IF ENTER FAILED
    let attempts = 0;
    while (attempts < 10) {
        const currentCount = document.querySelectorAll('.model-response-text').length;
        if (currentCount > initialCount) {
            console.log("Gemini started generating.");
            return;
        }

        const sendBtn = document.querySelector('button[aria-label="Send message"]');
        if (sendBtn && !sendBtn.disabled && sendBtn.getAttribute('aria-disabled') !== 'true') {
            console.log("Enter didn't work, clicking Send...");
            sendBtn.click();
        } else {
            console.log("Button disabled, adding space...");
            document.execCommand('insertText', false, " "); // Add space to wake button
        }

        await delay(2000);
        attempts++;
    }
    
    throw new Error("Failed to start Gemini response.");
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

        console.log(`Length: ${currentLength}`);

        if (currentLength > 0 && currentLength === lastLength) {
            stableCount++;
            if (stableCount >= 3) {
                console.log("Text stable.");
                return;
            }
        } else {
            stableCount = 0;
            lastLength = currentLength;
        }
    }
    throw new Error("Timeout waiting for text stability.");
}