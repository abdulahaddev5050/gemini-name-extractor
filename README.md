# Gemini Client Extractor

A Chrome extension that uses **Google Gemini AI** to automatically extract client information (names, company names, and websites) from job posting data.

## 🎯 What Does This Extension Do?

This extension helps you **batch process job posting data** and extract:
- **Person Names** - Client/hiring manager names
- **Company Names** - The actual hiring company
- **Client Websites** - Company-owned URLs (not target/source URLs)
- **Confidence Score** - How confident the AI is in the extraction
- **Reasoning** - Why the AI made these extractions

## 🔄 How It Works

```
1. You upload JSON files containing job posting data
2. Extension sends each job to Gemini AI (one at a time)
3. Gemini extracts client info using NER (Named Entity Recognition)
4. Results are stored locally in IndexedDB
5. When all jobs complete → CSV auto-downloads
6. Storage auto-cleans for next batch
```

## 📋 Required JSON Format

Your JSON files should contain an array of job objects with these fields:

```json
[
  {
    "title": "Job Title Here",
    "summary": "Full job description text...",
    "feedback_received_From_Freelancer": [
      "Freelancer review 1...",
      "Freelancer review 2..."
    ],
    "job_url": "https://...",
    "job_id": "123456",
    "parent_id": "789"
  }
]
```

**Required fields:**
- `title` - Job title
- `summary` - Job description

**Optional fields:**
- `feedback_received_From_Freelancer` - Array of freelancer reviews (helps find names)
- `job_url`, `job_id`, `parent_id` - Passed through to CSV output

## 🚀 How To Use

### Step 1: Install the Extension
1. Open `chrome://extensions/`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select this folder

### Step 2: Prepare Your Data
- Create JSON files with job data in the format above
- You can upload multiple files at once

### Step 3: Run Extraction
1. Open **gemini.google.com** in a browser tab
2. Click the extension icon to open the side panel
3. Click "📁 Select Files from Computer" to upload JSON files
4. Click "▶️ Start Processing"
5. **Leave browser open** - you can do other things while it runs

### Step 4: Get Results
- When all jobs complete, CSV **auto-downloads**
- Storage **auto-cleans** for next batch
- You can also manually export anytime with "📥 Export Results as CSV"

## 📊 CSV Output Format

The exported CSV contains:

| Column | Description |
|--------|-------------|
| Person Name(s) | Extracted client/manager names (semicolon-separated if multiple) |
| Company Name | The hiring company name |
| Client Website | Company-owned website URL |
| Confidence | AI confidence score (0.0 - 1.0) |
| Reasoning | Brief explanation of extraction |
| Job URL | Original job URL (from input) |
| Job ID | Original job ID (from input) |
| Parent ID | Original parent ID (from input) |

## 💾 Storage Architecture

The extension uses two storage systems:

| Storage | Purpose | Limit |
|---------|---------|-------|
| **IndexedDB** | Job data & results (large) | ~50MB+ |
| **chrome.storage.local** | File metadata only (tiny) | 5MB |

This allows processing **unlimited files** without hitting storage limits.

## ⚙️ Management Buttons

| Button | Purpose |
|--------|---------|
| **🔄 Reset All Jobs** | Resets files to Pending so you can reprocess |
| **🗑️ Clear Completed** | Removes finished files (keeps results) |
| **🗑️ Clear All Results** | Deletes all extracted results |

## 🔧 Troubleshooting

**"Open Gemini first!"**
- Make sure gemini.google.com is open in a browser tab

**Processing stops**
- Check the Progress Log for errors
- Try resetting the file and running again

**No results exported**
- Check "X jobs extracted" counter
- Make sure Gemini is responding (check the Gemini tab)

## 📁 File Structure

```
├── manifest.json      # Extension configuration
├── background.js      # Service worker (processing logic)
├── content.js         # Injected into Gemini page
├── sidepanel.html     # Extension UI
├── sidepanel.js       # UI logic
├── db.js              # IndexedDB helper
└── README.md          # This file
```

## 🔒 Privacy

- All processing happens locally in your browser
- Job data is stored in IndexedDB (local)
- Results are stored locally until you export
- No data is sent to external servers (except Gemini for AI processing)

---

**Version:** 2.0  
**Author:** TheWoofLab
