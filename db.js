// db.js - IndexedDB Helper for Large Data Storage

const DB_NAME = 'GeminiExtractorDB';
const DB_VERSION = 1;

// Store names
const STORES = {
    JOB_DATA: 'jobData',      // Actual job arrays (large)
    RESULTS: 'results'         // Extracted results (large)
};

let dbInstance = null;

// Initialize the database
function initDB() {
    return new Promise((resolve, reject) => {
        if (dbInstance) {
            resolve(dbInstance);
            return;
        }

        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => {
            console.error('IndexedDB error:', request.error);
            reject(request.error);
        };

        request.onsuccess = () => {
            dbInstance = request.result;
            console.log('IndexedDB initialized');
            resolve(dbInstance);
        };

        request.onupgradeneeded = (event) => {
            const db = event.target.result;

            // Store for job data: key = fileId, value = array of jobs
            if (!db.objectStoreNames.contains(STORES.JOB_DATA)) {
                db.createObjectStore(STORES.JOB_DATA, { keyPath: 'fileId' });
            }

            // Store for results: auto-increment key, each result is an object
            if (!db.objectStoreNames.contains(STORES.RESULTS)) {
                const resultsStore = db.createObjectStore(STORES.RESULTS, { 
                    keyPath: 'id', 
                    autoIncrement: true 
                });
                resultsStore.createIndex('fileId', 'fileId', { unique: false });
            }
        };
    });
}

// ============ JOB DATA OPERATIONS ============

// Save job data for a file
async function saveJobData(fileId, jobs) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.JOB_DATA, 'readwrite');
        const store = tx.objectStore(STORES.JOB_DATA);
        
        const request = store.put({ fileId, jobs, savedAt: Date.now() });
        
        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(request.error);
    });
}

// Get job data for a file
async function getJobData(fileId) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.JOB_DATA, 'readonly');
        const store = tx.objectStore(STORES.JOB_DATA);
        
        const request = store.get(fileId);
        
        request.onsuccess = () => {
            resolve(request.result ? request.result.jobs : null);
        };
        request.onerror = () => reject(request.error);
    });
}

// Delete job data for a file (cleanup after processing)
async function deleteJobData(fileId) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.JOB_DATA, 'readwrite');
        const store = tx.objectStore(STORES.JOB_DATA);
        
        const request = store.delete(fileId);
        
        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(request.error);
    });
}

// Clear all job data
async function clearAllJobData() {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.JOB_DATA, 'readwrite');
        const store = tx.objectStore(STORES.JOB_DATA);
        
        const request = store.clear();
        
        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(request.error);
    });
}

// ============ RESULTS OPERATIONS ============

// Add a single result
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

// Get all results
async function getAllResults() {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.RESULTS, 'readonly');
        const store = tx.objectStore(STORES.RESULTS);
        
        const request = store.getAll();
        
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    });
}

// Get results count
async function getResultsCount() {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.RESULTS, 'readonly');
        const store = tx.objectStore(STORES.RESULTS);
        
        const request = store.count();
        
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// Clear all results
async function clearAllResults() {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.RESULTS, 'readwrite');
        const store = tx.objectStore(STORES.RESULTS);
        
        const request = store.clear();
        
        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(request.error);
    });
}

// ============ UTILITY ============

// Get storage usage estimate
async function getStorageEstimate() {
    if (navigator.storage && navigator.storage.estimate) {
        const estimate = await navigator.storage.estimate();
        return {
            usage: estimate.usage || 0,
            quota: estimate.quota || 0,
            usageMB: ((estimate.usage || 0) / (1024 * 1024)).toFixed(2),
            quotaMB: ((estimate.quota || 0) / (1024 * 1024)).toFixed(0)
        };
    }
    return { usage: 0, quota: 0, usageMB: '0', quotaMB: 'Unknown' };
}

// Export functions for use in other scripts
// Since this runs in extension context, we attach to window
window.ExtractorDB = {
    init: initDB,
    saveJobData,
    getJobData,
    deleteJobData,
    clearAllJobData,
    addResult,
    getAllResults,
    getResultsCount,
    clearAllResults,
    getStorageEstimate
};

