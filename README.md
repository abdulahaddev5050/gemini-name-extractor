🤖 Gemini Job Analyzer

📌 Project Overview

This Chrome Extension automates the process of extracting high-value data from job postings (specifically from Upwork).
It takes raw job data (JSON file) containing job titles, summaries, and freelancer feedback.
It uses Google Gemini (the web interface) to analyze this data using AI.
It extracts hidden details like Client Name, Company Name, and Website.
It automatically saves the results into a Google Sheet.

🛠️ System Architecture

The extension consists of 4 main parts that talk to each other:
Side Panel (sidepanel.html / sidepanel.js):
The User Interface.
Handles file uploads (.json).
Displays the job queue table (Pending/Running/Complete).
Has "Start", "Reset", and "Delete" controls.
Background Script (background.js):
The "Brain" of the operation.
Manages the queue (decides which job to send next).
Receives the AI result from the Content Script.
Sends the final data to the Google Apps Script.
Content Script (content.js):
Injected into gemini.google.com.
Simulates Human Typing: It types the prompt into the chat box character-by-character to avoid UI bugs.
Detects Completion: It watches the response text length to know when Gemini is done talking (Text Stability Check).
Scrapes the JSON response from the chat bubble.
Google Apps Script (Backend):
Receives data via HTTP POST.
Appends a new row to your Google Sheet.

🚀 Setup Instructions (Step-by-Step)

Phase 1: The Google Sheet (Backend)
Create a new Google Sheet.
Go to Extensions > Apps Script.
Delete any code there and paste the following:
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000); // Wait 10 seconds for lock
  } catch (e) {
    return ContentService.createTextOutput(JSON.stringify({"result": "error", "error": "Server busy"}));
  }

  try {
    // 1. Parse Data
    var data = JSON.parse(e.postData.contents);
    
    // 2. Open Sheet
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var timeZone = Session.getScriptTimeZone();
    var todaySheetName = Utilities.formatDate(new Date(), timeZone, "dd-MM-yyyy");
    
    var sheet = ss.getSheetByName(todaySheetName);
    
    // 3. Create Sheet if not exists
    if (!sheet) {
      sheet = ss.insertSheet(todaySheetName);
      // YOUR SPECIFIC HEADERS
      sheet.appendRow([
        "personName", 
        "companyName", 
        "clientWebsite", 
        "confidence", 
        "reasoning", 
        "job_url", 
        "job_id", 
        "parent_id"
      ]);
      sheet.getRange(1, 1, 1, 8).setFontWeight("bold");
      sheet.setFrozenRows(1);
    }

    // 4. Handle Array Fields (personName might be an array)
    var personNameStr = Array.isArray(data.personName) ? data.personName.join(" & ") : data.personName;

    // 5. Append Row (Mapping your variables to columns)
    sheet.appendRow([
      personNameStr || "",
      data.companyName || "",
      data.clientWebsite || "",
      data.confidence || "",
      data.reasoning || "",
      data.job_url || "",
      data.job_id || "",
      data.parent_id || ""
    ]);

    return ContentService.createTextOutput(JSON.stringify({"result": "success"}));

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({"result": "error", "error": error.message}));
  } finally {
    lock.releaseLock();
  }
}

Click Deploy > New Deployment.
Select type: Web App.
Configuration:
Description: Gemini Saver
Execute as: Me (your email).
Who has access: Anyone (Crucial for the extension to send data).
Click Deploy.
Copy the Web App URL (starts with https://script.google.com/...).
Paste this URL into your background.js file at the top:

const GOOGLE_SCRIPT_URL = "YOUR_COPIED_URL_HERE";

Phase 2: Installing the Extension

Make sure all your files (manifest.json, background.js, content.js, sidepanel.html, sidepanel.js, and icons) are in one folder.
Open Chrome and go to chrome://extensions.
Turn on Developer Mode (top right switch).
Click Load Unpacked.
Select your folder.

📖 How to Use

Open Gemini: Go to https://gemini.google.com/app and log in.
Open Extension: Click the extension icon to open the Side Panel.
Upload Data: Click "💻 My Computer" and select your job JSON files.
Input Format Requirement: Your JSON must be an Array of Objects.
Each object must have either a job_url (for main jobs) or job_id/parent_id (for history).
Start: Click the green Start button.
Sit Back:
The extension will open the Gemini tab.
It will type the prompt "human-like" into the box.
It will wait for the answer.
It will save the data to the Sheet.
It will automatically move to the next job.

🧠 Technical Deep Dive (The "Why")

Why "Human Typing"?
We use a function humanTypeAndSend in content.js.
Problem: Simply pasting text (innerText = ...) often fails because modern web apps (Angular/React) don't realize the text changed. The "Send" button stays disabled.
Solution: We type chunks of 15 characters at a time and fire keyboard events. This forces the browser to wake up the "Send" button.
Why "Text Stability Check"?
We use waitForTextStability instead of looking for the "Stop" button.
Problem: The "Stop Generating" button appears and disappears too fast, or the UI changes classes. Relying on buttons caused the script to freeze.
Solution: We measure the length of the AI's response text. If the length stays the same for 3 seconds (e.g., 500 chars... 500 chars... 500 chars), we know Gemini is finished.

Why "Nuclear Clear"?

Before every job, we run document.execCommand('delete').
Problem: Sometimes the previous job's text remains in the box, causing Gemini to get two prompts at once.
Solution: We aggressively select all text and delete it before starting the new typing sequence.

File,Purpose

manifest.json,"The configuration file. Tells Chrome we need permissions for sidePanel, storage, and scripting on Gemini."
background.js,"The manager. It holds the queue of jobs in memory/storage. It acts as the courier between the Side Panel, the Content Script, and Google Sheets."
content.js,"The worker. It lives inside the Gemini tab. It handles the DOM (typing, clicking, scraping)."
sidepanel.html,"The visual layout. The buttons, the log box, and the table."
sidepanel.js,"The logic for the UI. Handles reading files, updating the status table (colors), and Reset/Delete buttons."

❓ Troubleshooting

Issue: The extension stops at "Processing..."
Cause: The browser tab might have lost focus or Gemini changed its HTML.
Fix: Refresh the Gemini page. The extension tracks progress in LocalStorage, so just click "Start" again, and it will resume from where it left off (it skips completed jobs).
Issue: "Fetch API cannot load..." in Console
Cause: These are Google's own ad/tracking scripts failing.
Fix: Ignore them. They do not affect your data extraction.
Issue: Data is not showing in Sheet
Cause: The Apps Script might be restricted.
Fix: Check your Apps Script deployment. Ensure "Who has access" is set to "Anyone".
