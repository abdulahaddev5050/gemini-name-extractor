// sidepanel.js - Updated to use IndexedDB for large data storage

// --- HTML Elements ---
const computerBtn = document.getElementById('computerBtn');
const hiddenInput = document.getElementById('hiddenFileInput');
const logBox = document.getElementById('logBox');
const jobTableBody = document.getElementById('jobTableBody');
const startBtn = document.getElementById('startBtn');
const resetAllBtn = document.getElementById('resetAllBtn');
const clearCompletedBtn = document.getElementById('clearCompletedBtn');
const storageInfo = document.getElementById('storageInfo');
const exportCsvBtn = document.getElementById('exportCsvBtn');
const clearResultsBtn = document.getElementById('clearResultsBtn');
const resultsInfo = document.getElementById('resultsInfo');

// --- 1. Initialize on Startup ---
document.addEventListener('DOMContentLoaded', async () => {
    // Initialize IndexedDB
    await window.ExtractorDB.init();
    
    loadTableFromStorage();
    updateStorageInfo();
    updateResultsInfo();
});

// --- 2. Button Logic ---

// A. Computer Upload Button
computerBtn.addEventListener('click', () => {
    hiddenInput.click();
});

// B. Start Button Logic
startBtn.addEventListener('click', () => {
    if (startBtn.disabled) {
        log("⚠️ No jobs loaded yet.");
        return;
    }
    log("🚀 Start button clicked. Sending signal to Background...");
    chrome.runtime.sendMessage({ action: "START_PROCESSING" });
});

// C. Reset All Button
if (resetAllBtn) {
    resetAllBtn.addEventListener('click', () => {
        if(confirm("Are you sure you want to reset ALL files to pending?")) {
            resetAllFiles();
        }
    });
}

// D. Clear Completed Button
if (clearCompletedBtn) {
    clearCompletedBtn.addEventListener('click', () => {
        if(confirm("Remove all COMPLETED files from storage? This frees up memory.")) {
            clearCompletedFiles();
        }
    });
}

// E. Export CSV Button
if (exportCsvBtn) {
    exportCsvBtn.addEventListener('click', () => {
        exportResultsAsCsv();
    });
}

// F. Clear Results Button
if (clearResultsBtn) {
    clearResultsBtn.addEventListener('click', async () => {
        if(confirm("Clear all extracted results? Make sure you've exported first!")) {
            await window.ExtractorDB.clearAllResults();
            log('🗑️ Results cleared.');
            updateResultsInfo();
        }
    });
}

// G. Handle File Selection - UPDATED to use IndexedDB
hiddenInput.addEventListener('change', async (event) => {
    const files = Array.from(event.target.files);
    if (files.length === 0) return;

    log(`⏳ Reading ${files.length} file(s)...`);

    for (const file of files) {
        try {
            const text = await readFileAsText(file);
            const jsonData = JSON.parse(text);
            
            // Extract name from filename
            let extractedName = "Unknown";
            const nameParts = file.name.split('-');
            if (nameParts.length > 2) {
                extractedName = nameParts[2]; 
            }

            const fileId = Date.now() + Math.random();

            // Store METADATA in chrome.storage.local (tiny)
            const fileMetadata = {
                id: fileId,
                filename: file.name,
                name: extractedName,
                totalJobs: jsonData.length || 0,
                processedCount: 0,
                currentJobIndex: 0,  // Track which job we're on
                status: 'pending'
                // NOTE: No 'data' field here! Data goes to IndexedDB
            };

            // Store actual JOB DATA in IndexedDB (large)
            await window.ExtractorDB.saveJobData(fileId, jsonData);

            // Save metadata to chrome.storage
            await addFileMetadata(fileMetadata);

            log(`✅ Saved "${file.name}" (${jsonData.length} jobs)`);

        } catch (err) {
            log(`❌ Error reading ${file.name}: ${err.message}`);
        }
    }

    loadTableFromStorage();
    updateStorageInfo();
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

// Save file METADATA only (not the actual data)
function addFileMetadata(metadata) {
    return new Promise((resolve) => {
        chrome.storage.local.get(['fileQueue'], (result) => {
            const queue = result.fileQueue || [];
            queue.push(metadata);
            
            chrome.storage.local.set({ fileQueue: queue }, resolve);
        });
    });
}

// --- 4. Render Table ---
function loadTableFromStorage() {
    chrome.storage.local.get(['fileQueue'], (result) => {
        const files = result.fileQueue || [];
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
                <td>${file.processedCount} / ${file.totalJobs}</td>
                <td style="color: ${statusColor}; font-weight:bold;">${statusText}</td>
                <td style="white-space: nowrap;">
                    <button class="reset-btn" data-id="${file.id}" title="Reset to Pending">🔄</button>
                    <button class="delete-btn" data-id="${file.id}" title="Delete File">🗑️</button>
                </td>
            `;

            jobTableBody.appendChild(row);
        });

        // Attach event listeners
        document.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idToDelete = parseFloat(e.target.getAttribute('data-id'));
                deleteFile(idToDelete);
            });
        });

        document.querySelectorAll('.reset-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idToReset = parseFloat(e.target.getAttribute('data-id'));
                resetFile(idToReset);
            });
        });
    });
}

// --- DELETE FILE ---
async function deleteFile(id) {
    // Delete from IndexedDB
    await window.ExtractorDB.deleteJobData(id);
    
    // Delete from chrome.storage
    chrome.storage.local.get(['fileQueue'], (result) => {
        const files = result.fileQueue || [];
        const newFiles = files.filter(f => f.id !== id);
        
        chrome.storage.local.set({ fileQueue: newFiles }, () => {
            log('🗑️ File removed.');
            loadTableFromStorage();
            updateStorageInfo();
        });
    });
}

// --- RESET SINGLE FILE ---
async function resetFile(id) {
    chrome.storage.local.get(['fileQueue'], (result) => {
        const files = result.fileQueue || [];
        const fileIndex = files.findIndex(f => f.id === id);

        if (fileIndex !== -1) {
            files[fileIndex].status = 'pending';
            files[fileIndex].processedCount = 0;
            files[fileIndex].currentJobIndex = 0;

            chrome.storage.local.set({ fileQueue: files }, () => {
                log(`🔄 Reset "${files[fileIndex].name}".`);
                loadTableFromStorage();
            });
        }
    });
}

// --- RESET ALL FILES ---
function resetAllFiles() {
    chrome.storage.local.get(['fileQueue'], (result) => {
        const files = result.fileQueue || [];

        if (files.length === 0) {
            log("⚠️ No files to reset.");
            return;
        }

        files.forEach(file => {
            file.status = 'pending';
            file.processedCount = 0;
            file.currentJobIndex = 0;
        });

        chrome.storage.local.set({ fileQueue: files }, () => {
            log(`🔄 All ${files.length} files have been reset.`);
            loadTableFromStorage();
        });
    });
}

// --- CLEAR COMPLETED FILES ---
async function clearCompletedFiles() {
    chrome.storage.local.get(['fileQueue'], async (result) => {
        const files = result.fileQueue || [];
        const completedIds = files.filter(f => f.status === 'complete').map(f => f.id);
        const remainingFiles = files.filter(f => f.status !== 'complete');
        
        // Delete job data from IndexedDB for completed files
        for (const id of completedIds) {
            await window.ExtractorDB.deleteJobData(id);
        }
        
        chrome.storage.local.set({ fileQueue: remainingFiles }, () => {
            log(`🗑️ Cleared ${completedIds.length} completed file(s).`);
            loadTableFromStorage();
            updateStorageInfo();
        });
    });
}

// --- Listen for messages from Background ---
chrome.runtime.onMessage.addListener((request) => {
    if (request.action === "UI_LOG") {
        log(request.message);
    }
    if (request.action === "JOB_PROCESSED_UI_UPDATE") {
        loadTableFromStorage();
        updateStorageInfo();
        updateResultsInfo();
    }
    if (request.action === "AUTO_EXPORT_CSV") {
        // Auto-export triggered when all files complete
        log("🎉 All files complete! Auto-exporting CSV...");
        exportResultsAsCsv(true); // true = auto-cleanup after export
    }
});

function log(message) {
    logBox.innerHTML += `<div>${message}</div>`;
    logBox.scrollTop = logBox.scrollHeight;
}

// --- Storage Info (now shows IndexedDB usage) ---
async function updateStorageInfo() {
    const estimate = await window.ExtractorDB.getStorageEstimate();
    
    // Also get chrome.storage usage for metadata
    chrome.storage.local.getBytesInUse(null, (chromeBytes) => {
        const chromeMB = (chromeBytes / (1024 * 1024)).toFixed(2);
        
        storageInfo.innerHTML = `💾 IndexedDB: ${estimate.usageMB} MB | Chrome: ${chromeMB} MB / 5 MB`;
    });
}

// --- Results Count (from IndexedDB) ---
async function updateResultsInfo() {
    const count = await window.ExtractorDB.getResultsCount();
    resultsInfo.innerHTML = `📊 ${count} jobs extracted - ready for export`;
}

// --- Export Results as CSV (from IndexedDB) ---
// autoCleanup: if true, clears all data after successful export
async function exportResultsAsCsv(autoCleanup = false) {
    try {
        const results = await window.ExtractorDB.getAllResults();
        
        if (results.length === 0) {
            log('⚠️ No results to export!');
            return;
        }

        // CSV Headers
        const headers = [
            'Person Name(s)',
            'Company Name',
            'Client Website',
            'Confidence',
            'Reasoning',
            'Job URL',
            'Job ID',
            'Parent ID'
        ];

        // Escape CSV values
        const escapeCSV = (value) => {
            if (value === null || value === undefined) return '';
            const str = String(value);
            if (str.includes(',') || str.includes('"') || str.includes('\n')) {
                return '"' + str.replace(/"/g, '""') + '"';
            }
            return str;
        };

        // Build CSV content
        let csvContent = headers.join(',') + '\n';
        
        for (const row of results) {
            const csvRow = [
                escapeCSV(row.personName),
                escapeCSV(row.companyName),
                escapeCSV(row.clientWebsite),
                escapeCSV(row.confidence),
                escapeCSV(row.reasoning),
                escapeCSV(row.job_url),
                escapeCSV(row.job_id),
                escapeCSV(row.parent_id)
            ];
            csvContent += csvRow.join(',') + '\n';
        }

        // Create and download file
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `gemini-extraction-${new Date().toISOString().slice(0,10)}.csv`;
        link.click();
        URL.revokeObjectURL(url);

        log(`📥 Exported ${results.length} rows to CSV!`);

        // AUTO-CLEANUP after successful export
        if (autoCleanup) {
            log('🧹 Auto-cleaning storage...');
            
            try {
                // 1. Clear all results from IndexedDB
                await window.ExtractorDB.clearAllResults();
                log('✅ Cleared results from database');
                
                // 2. Clear all job data from IndexedDB
                await window.ExtractorDB.clearAllJobData();
                log('✅ Cleared job data from database');
                
                // 3. Clear file queue from chrome.storage
                chrome.storage.local.set({ fileQueue: [] }, () => {
                    log('✅ Cleared file queue');
                    log('🎉 All done! Storage is clean and ready for new files.');
                    
                    // Refresh UI
                    loadTableFromStorage();
                    updateStorageInfo();
                    updateResultsInfo();
                });
            } catch (cleanupError) {
                log(`⚠️ Cleanup warning: ${cleanupError.message}`);
                log('📝 You can manually clear using the buttons above.');
            }
        }
    } catch (error) {
        log(`❌ Export error: ${error.message}`);
    }
}
