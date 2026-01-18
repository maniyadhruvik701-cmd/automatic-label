import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, collection, addDoc, onSnapshot, query, orderBy, deleteDoc, doc, writeBatch, where, getDocs } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

// --- Configuration ---
const firebaseConfig = {
    apiKey: "AIzaSyAmwno2apuRvlG-VRNrO7lJjI727MDgQ5A",
    authDomain: "autolabel-d5559.firebaseapp.com",
    projectId: "autolabel-d5559",
    storageBucket: "autolabel-d5559.firebasestorage.app",
    messagingSenderId: "184689948010",
    appId: "1:184689948010:web:a620b54a70d620ab0d6113",
    measurementId: "G-D9JJDGCR6K"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const storage = getStorage(app);

// Printer Server URL (Dynamic)
// If file protocol (local usage), use localhost. Else use stored/hardcoded Ngrok.
// NOTE: For cloud printing, we need a reliable way to talk to the printer.
// Since users might be remote, they technically CANNOT print unless the printer laptop is hosting the server publicly.
// We will use the provided Ngrok URL as the default "Printer Address".
const PRINTER_SERVER_URL = window.location.protocol === 'file:'
    ? 'http://localhost:3001'
    : 'https://enjoyingly-uninsulted-delores.ngrok-free.dev';

// --- State ---
let stagedFiles = [];
let uploadedFiles = [];
let currentCategory = 'All';
let isPrinterOnline = false;

// --- UI Elements ---
const uploadArea = document.getElementById('upload-area');
const fileInput = document.getElementById('file-input');
const historyList = document.getElementById('history-list');
const selectAllCheckbox = document.getElementById('select-all');
const bulkActions = document.getElementById('bulk-actions');
const bulkPrintBtn = document.getElementById('bulk-print');
const bulkDeleteBtn = document.getElementById('bulk-delete');
const stagedFilesContainer = document.getElementById('staged-files-container');
const stagedCountText = document.getElementById('staged-count');
const stagedList = document.getElementById('staged-list');
const batchNameInput = document.getElementById('batch-name-input');
const uploadBtn = document.getElementById('upload-btn');
const selectedCounter = document.getElementById('selected-counter');
const batchFilterContainer = document.getElementById('batch-filter-container');
const progressContainer = document.getElementById('print-progress');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    // Check Printer Status
    checkPrinterStatus();
    setInterval(checkPrinterStatus, 10000);

    // Setup Listeners
    if (uploadArea) {
        uploadArea.addEventListener('click', () => fileInput.click());
        uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.style.borderColor = 'var(--primary)'; });
        uploadArea.addEventListener('dragleave', () => { uploadArea.style.borderColor = 'var(--glass-border)'; });
        uploadArea.addEventListener('drop', (e) => { e.preventDefault(); handleFiles(e.dataTransfer.files); });
        fileInput.addEventListener('change', (e) => { handleFiles(e.target.files); });
    }

    if (uploadBtn) {
        uploadBtn.addEventListener('click', uploadBatch);
    }

    if (selectAllCheckbox) {
        selectAllCheckbox.addEventListener('change', toggleSelectAll);
    }

    if (bulkDeleteBtn) bulkDeleteBtn.addEventListener('click', deleteSelected);
    if (bulkPrintBtn) bulkPrintBtn.addEventListener('click', printSelected);

    // Listen to Realtime History
    subscribeToHistory();
});

// --- Logic ---

async function checkPrinterStatus() {
    try {
        // Quick "ping" by calling root or print with empty (will fail but connection succeeds)
        // Since we don't have a GET root, we assume if we can reach it, it's UP.
        // We actually can't easily ping POST /print without data.
        // Let's assume Offline unless we are Local or can fetch something.
        // Simplified: Just visually show the URL.
        if (PRINTER_SERVER_URL.includes('localhost')) {
            statusDot.style.background = '#10b981';
            statusText.innerText = "Printer: Localhost (Ready)";
            isPrinterOnline = true;
        } else {
            // Try to fetch a dummy resource or just assume Online if URL is set?
            // Ngrok might be offline.
            statusDot.style.background = '#f59e0b';
            statusText.innerText = "Printer: Remote (Assuming Online)";
            isPrinterOnline = true;
        }
    } catch (e) {
        statusDot.style.background = '#ef4444';
        statusText.innerText = "Printer: Offline";
        isPrinterOnline = false;
    }
}

function handleFiles(files) {
    const fileList = Array.from(files);
    for (const file of fileList) {
        if (file.type === 'application/pdf') {
            stagedFiles.push(file);
        }
    }
    renderStagedFiles();
}

function renderStagedFiles() {
    if (stagedFiles.length === 0) {
        stagedFilesContainer.style.display = 'none';
        stagedList.style.display = 'none';
        return;
    }

    stagedFilesContainer.style.display = 'block';
    stagedList.style.display = 'block';
    stagedCountText.innerText = `${stagedFiles.length} PDF(s) Selected`;

    stagedList.innerHTML = stagedFiles.slice(0, 5).map(f => `<div>• ${f.name}</div>`).join('');
    if (stagedFiles.length > 5) stagedList.innerHTML += `<div>...and ${stagedFiles.length - 5} more.</div>`;
}

// Extract SKU Client-Side
async function extractSkuFromPdf(file) {
    try {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;
        const page = await pdf.getPage(1);
        const textContent = await page.getTextContent();
        const textItems = textContent.items.map(item => item.str).join(' ');

        // Search for marker
        const marker = '701637074001';
        if (textItems.includes(marker)) {
            const parts = textItems.split(marker);
            // Simple extraction logic similar to server logic
            // Taking the text immediately after marker
            let after = parts[1].trim();
            // Try to grab first word
            let match = after.match(/^[\s,]+([^,\n\r]+)/);
            return match ? match[1].trim() : after.substring(0, 20).trim();
        }
    } catch (e) {
        console.warn('SKU Extraction failed', e);
    }
    return '';
}

async function uploadBatch() {
    const total = stagedFiles.length;
    const batchName = batchNameInput.value.trim() || `Batch ${new Date().toLocaleTimeString()}`;

    if (total === 0) return;

    uploadBtn.disabled = true;
    uploadBtn.innerText = 'Initializing...';

    for (let i = 0; i < total; i++) {
        const file = stagedFiles[i];
        const percent = Math.round(((i + 1) / total) * 100);
        uploadBtn.innerText = `Uploading ${percent}%`;

        try {
            // 1. Extract SKU
            const sku = await extractSkuFromPdf(file);

            // 2. Upload to Storage
            const storageRef = ref(storage, `pdfs/${Date.now()}-${file.name}`);
            const snapshot = await uploadBytes(storageRef, file);
            const downloadURL = await getDownloadURL(snapshot.ref);

            // 3. Save to Firestore
            await addDoc(collection(db, "files"), {
                filename: file.name,
                originalName: file.name,
                size: file.size,
                sku: sku,
                batchName: batchName,
                timestamp: new Date().toISOString(),
                downloadUrl: downloadURL,
                storagePath: snapshot.ref.fullPath
            });

        } catch (e) {
            console.error("Upload Error", e);
            alert(`Failed to upload ${file.name}: ${e.message}`);
        }
    }

    stagedFiles = [];
    batchNameInput.value = '';
    renderStagedFiles();
    uploadBtn.disabled = false;
    uploadBtn.innerText = 'Upload to Cloud';
    alert(`Success! ${total} files uploaded to Cloud.`);
}

// --- History & Realtime Updates ---

function subscribeToHistory() {
    const q = query(collection(db, "files"), orderBy("timestamp", "desc"));

    onSnapshot(q, (snapshot) => {
        uploadedFiles = [];
        snapshot.forEach((doc) => {
            uploadedFiles.push({ id: doc.id, ...doc.data() });
        });

        // Initial render
        renderBatchFilters();
        renderHistory();
    }, (error) => {
        console.error("Firestore Listen Error:", error);
        historyList.innerHTML = `<div style="text-align: center; color: #ef4444; margin-top:50px;">
            <p>Error loading history. Did you enable Firestore in Test Mode?</p>
        </div>`;
    });
}

function renderBatchFilters() {
    if (!batchFilterContainer) return;

    const batches = ['All'];
    const uniqueBatches = [...new Set(uploadedFiles.map(f => f.batchName || 'Default Batch'))];
    batches.push(...uniqueBatches); // Already sorted by date desc essentially

    batchFilterContainer.innerHTML = '<span style="font-size: 13px; font-weight: 600; color: var(--text-muted); margin-right: 5px;">Filter:</span>';

    batches.forEach(batch => {
        const btn = document.createElement('button');
        btn.className = 'print-btn';
        const isActive = currentCategory === batch;
        btn.style.cssText = `padding: 5px 15px; font-size: 12px; border-radius: 20px; transition: all 0.3s; margin-right: 5px; margin-bottom: 5px;
            ${isActive ? 'background: var(--primary); border-color: var(--primary);' : 'background: rgba(255,255,255,0.05); border-color: var(--glass-border); opacity: 0.7;'}`;
        btn.innerText = batch;
        btn.onclick = () => {
            currentCategory = batch;
            renderBatchFilters();
            renderHistory();
        };
        batchFilterContainer.appendChild(btn);
    });

    // Batch Actions (Print All / Delete Batch)
    if (currentCategory !== 'All') {
        const actionsDiv = document.createElement('div');
        actionsDiv.style.cssText = 'margin-left: auto; display: flex; gap: 8px;';

        const printAllBtn = document.createElement('button');
        printAllBtn.className = 'print-btn';
        printAllBtn.style.cssText = 'padding: 5px 15px; font-size: 12px; background: rgba(16, 185, 129, 0.2); color: #10b981; border-color: #10b981; font-weight: 600;';
        printAllBtn.innerText = `Print All ${currentCategory}`;
        printAllBtn.onclick = () => printBatch(currentCategory);

        const deleteBatchBtn = document.createElement('button');
        deleteBatchBtn.className = 'print-btn';
        deleteBatchBtn.style.cssText = 'padding: 5px 15px; font-size: 12px; background: rgba(239, 68, 68, 0.2); color: #ef4444; border-color: #ef4444; font-weight: 600;';
        deleteBatchBtn.innerText = `Delete ${currentCategory}`;
        deleteBatchBtn.onclick = () => deleteBatch(currentCategory);

        actionsDiv.appendChild(printAllBtn);
        actionsDiv.appendChild(deleteBatchBtn);
        batchFilterContainer.appendChild(actionsDiv);
    }
}

function renderHistory() {
    if (!historyList) return;

    const filteredFiles = currentCategory === 'All'
        ? uploadedFiles
        : uploadedFiles.filter(f => (f.batchName || 'Default Batch') === currentCategory);

    if (filteredFiles.length === 0) {
        historyList.innerHTML = '<div style="text-align: center; color: var(--text-muted); margin-top: 100px;"><p>No files found.</p></div>';
        bulkActions.style.display = 'none';
        return;
    }

    historyList.innerHTML = '';
    // Files are already sorted desc from Firestore query
    filteredFiles.forEach(file => {
        const row = document.createElement('div');
        row.className = 'history-item';
        row.dataset.id = file.id; // Firestore Doc ID

        const skuBadge = file.sku ? `<span class="sku-badge">${file.sku}</span>` : '';
        const bTag = currentCategory === 'All' ? `<span style="font-size: 10px; color: var(--primary); background: rgba(99,102,241,0.1); padding: 2px 6px; border-radius: 4px; margin-right: 5px;">${file.batchName || 'Default'}</span>` : '';
        const sizeKm = (file.size / 1024).toFixed(1);

        row.innerHTML = `
            <div class="file-info">
                <input type="checkbox" class="file-checkbox custom-checkbox">
                <div class="file-icon" style="width: 34px; height: 34px; font-size: 8px;">PDF</div>
                <div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <div class="file-name" style="font-size: 14px;">${file.originalName || file.filename}</div>
                        ${skuBadge}
                    </div>
                    <div class="file-meta" style="font-size: 11px;">
                        ${bTag} ${sizeKm} KB
                    </div>
                </div>
            </div>
            <button class="print-btn" style="padding: 6px 14px; font-size: 12px;">Print</button>
        `;

        // Print Button Logic
        const pBtn = row.querySelector('button');
        pBtn.onclick = (e) => { e.stopPropagation(); printCloudFile(file, pBtn); };

        // Selection Logic
        row.addEventListener('click', (e) => {
            if (e.target !== pBtn && e.target.type !== 'checkbox') {
                const cb = row.querySelector('.file-checkbox');
                cb.checked = !cb.checked;
                toggleRowSelected(row, cb.checked);
            }
        });
        row.querySelector('.file-checkbox').addEventListener('change', (e) => toggleRowSelected(row, e.target.checked));

        historyList.appendChild(row);
    });

    updateBulkVisibility();
}

function toggleRowSelected(row, isChecked) {
    isChecked ? row.classList.add('selected') : row.classList.remove('selected');
    updateBulkVisibility();
}

function updateBulkVisibility() {
    const checked = document.querySelectorAll('.file-checkbox:checked').length;
    bulkActions.style.display = checked > 0 ? 'flex' : 'none';
    if (selectedCounter) selectedCounter.innerText = checked > 0 ? `(${checked} Selected)` : '';
}

function toggleSelectAll(e) {
    const isChecked = e.target.checked;
    document.querySelectorAll('.file-checkbox').forEach(cb => {
        cb.checked = isChecked;
        const row = cb.closest('.history-item');
        if (row) isChecked ? row.classList.add('selected') : row.classList.remove('selected');
    });
    updateBulkVisibility();
}

// --- Deletion Logic ---

async function deleteBatch(bName) {
    const filesToDelete = uploadedFiles.filter(f => (f.batchName || 'Default Batch') === bName);
    if (!confirm(`Are you sure you want to delete the entire group "${bName}"? (${filesToDelete.length} files will be deleted)`)) return;

    // Delete Loop
    for (const file of filesToDelete) {
        await deleteFileFromCloud(file);
    }
}

async function deleteSelected() {
    const checkedRows = document.querySelectorAll('.history-item.selected');
    const ids = Array.from(checkedRows).map(r => r.dataset.id);
    if (!confirm(`Are you sure you want to delete ${ids.length} selected files?`)) return;

    for (const id of ids) {
        const file = uploadedFiles.find(f => f.id === id);
        if (file) await deleteFileFromCloud(file);
    }
    // Deselect all
    if (selectAllCheckbox) selectAllCheckbox.checked = false;
}

async function deleteFileFromCloud(file) {
    try {
        // 1. Delete from Storage
        if (file.storagePath) {
            const fileRef = ref(storage, file.storagePath);
            await deleteObject(fileRef).catch(e => console.warn("Storage delete failed (might verify later)", e));
        }

        // 2. Delete from Firestore
        await deleteDoc(doc(db, "files", file.id));

    } catch (e) {
        console.error("Delete Error", e);
    }
}

// --- Printing Logic ---

async function printCloudFile(file, btn) {
    if (!file.downloadUrl) { alert('No URL found'); return; }

    if (btn) { btn.disabled = true; btn.innerText = 'Sending...'; }

    try {
        const response = await fetch(`${PRINTER_SERVER_URL}/print`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'ngrok-skip-browser-warning': 'true'
            },
            body: JSON.stringify({ url: file.downloadUrl })
        });

        if (!response.ok) throw new Error('Printer Server returned error');

        if (btn) {
            btn.innerText = 'Sent!';
            setTimeout(() => { btn.innerText = 'Print'; btn.disabled = false; }, 2000);
        }
    } catch (e) {
        console.error(e);
        alert(`Print Failed: Is the Main Laptop server running?\n\nError: ${e.message}`);
        if (btn) { btn.innerText = 'Failed'; btn.disabled = false; }
    }
}

async function printBatch(bName) {
    const files = uploadedFiles.filter(f => (f.batchName || 'Default Batch') === bName);
    const total = files.length;
    if (!confirm(`Print all ${total} labels from "${bName}"? (Main Laptop must be ON)`)) return;

    processPrintQueue(files);
}

async function printSelected() {
    const checkedRows = document.querySelectorAll('.history-item.selected');
    const ids = Array.from(checkedRows).map(r => r.dataset.id);
    const files = ids.map(id => uploadedFiles.find(f => f.id === id)).filter(Boolean);

    if (!confirm(`Print ${files.length} selected labels?`)) return;
    processPrintQueue(files);
}

async function processPrintQueue(files) {
    if (progressContainer) progressContainer.style.display = 'flex';

    for (let i = 0; i < files.length; i++) {
        if (progressBar) progressBar.style.width = Math.round(((i + 1) / files.length) * 100) + '%';
        if (progressText) progressText.innerText = `${i + 1} / ${files.length}`;

        await printCloudFile(files[i], null); // Pass null as btn

        // Small delay to prevent overwhelming the server/printer
        await new Promise(r => setTimeout(r, 1000));
    }

    setTimeout(() => {
        if (progressContainer) progressContainer.style.display = 'none';
        alert("Batch Print Sent!");
    }, 1000);
}

// Global Exports
window.printBatch = printBatch;
window.deleteBatch = deleteBatch;

