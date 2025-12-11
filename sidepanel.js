// sidepanel.js

// --- HTML Elements ---
const computerBtn = document.getElementById('computerBtn');
const hiddenInput = document.getElementById('hiddenFileInput');
const logBox = document.getElementById('logBox');
const jobTableBody = document.getElementById('jobTableBody');
const startBtn = document.getElementById('startBtn');

// --- 1. Load Data on Startup ---
document.addEventListener('DOMContentLoaded', loadTableFromStorage);

// --- 2. Button Logic ---

// A. Computer Upload Button
computerBtn.addEventListener('click', () => {
    hiddenInput.click();
});

// B. >>> THIS WAS MISSING! Start Button Logic <<<
startBtn.addEventListener('click', () => {
    // 1. Check if we have jobs to process
    if (startBtn.disabled) {
        log("⚠️ No jobs loaded yet.");
        return;
    }

    log("🚀 Start button clicked. Sending signal to Background...");
    
    // 2. Send message to background.js
    chrome.runtime.sendMessage({ action: "START_PROCESSING" });
});

// C. Handle File Selection
hiddenInput.addEventListener('change', async (event) => {
    const files = Array.from(event.target.files);
    if (files.length === 0) return;

    log(`⏳ Reading ${files.length} file(s)...`);

    for (const file of files) {
        try {
            const text = await readFileAsText(file);
            const jsonData = JSON.parse(text);
            
            // Extract name (e.g. "n8n" from filename)
            let extractedName = "Unknown";
            const nameParts = file.name.split('-');
            if (nameParts.length > 2) {
                extractedName = nameParts[2]; 
            }

            const fileEntry = {
                id: Date.now() + Math.random(),
                filename: file.name,
                name: extractedName,
                totalJobs: jsonData.length || 0,
                processedCount: 0,
                status: 'pending',
                data: jsonData
            };

            await addFileToStorage(fileEntry);

        } catch (err) {
            log(`❌ Error reading ${file.name}: ${err.message}`);
        }
    }

    loadTableFromStorage();
    hiddenInput.value = ''; 
});

// --- 3. Helper Functions ---

function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsText(file);
    });
}

function addFileToStorage(newEntry) {
    return new Promise((resolve) => {
        chrome.storage.local.get(['jobFiles'], (result) => {
            const currentFiles = result.jobFiles || [];
            currentFiles.push(newEntry);
            
            chrome.storage.local.set({ jobFiles: currentFiles }, () => {
                log(`✅ Saved "${newEntry.filename}" (${newEntry.totalJobs} jobs)`);
                resolve();
            });
        });
    });
}

// --- 4. Render Table ---
function loadTableFromStorage() {
    chrome.storage.local.get(['jobFiles'], (result) => {
        const files = result.jobFiles || [];
        jobTableBody.innerHTML = ''; 

        if (files.length === 0) {
            jobTableBody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#999;">No jobs loaded yet</td></tr>';
            startBtn.disabled = true;
            return;
        }

        startBtn.disabled = false;

        files.forEach((file) => {
            const row = document.createElement('tr');

            let statusColor = 'red';
            let statusText = 'Pending';
            
            if (file.status === 'complete') {
                statusColor = 'green';
                statusText = 'Complete';
            } else if (file.status === 'processing') {
                 statusColor = 'orange';
                 statusText = 'Running...';
            }

            row.innerHTML = `
                <td><strong>${file.name}</strong></td>
                <td>${file.totalJobs}</td>
                <td style="color: ${statusColor}; font-weight:bold;">${statusText}</td>
                <td><button class="delete-btn" data-id="${file.id}">🗑️</button></td>
            `;

            jobTableBody.appendChild(row);
        });

        document.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idToDelete = parseFloat(e.target.getAttribute('data-id'));
                deleteFile(idToDelete);
            });
        });
    });
}

function deleteFile(id) {
    chrome.storage.local.get(['jobFiles'], (result) => {
        const files = result.jobFiles || [];
        const newFiles = files.filter(f => f.id !== id);
        
        chrome.storage.local.set({ jobFiles: newFiles }, () => {
            log('🗑️ File removed.');
            loadTableFromStorage();
        });
    });
}

// Listen for logs from Background Script
chrome.runtime.onMessage.addListener((request) => {
    if (request.action === "UI_LOG") {
        log(request.message);
    }
    if (request.action === "JOB_PROCESSED_UI_UPDATE") {
        loadTableFromStorage();
    }
});

function log(message) {
    logBox.innerHTML += `<div>${message}</div>`;
    logBox.scrollTop = logBox.scrollHeight; 
}