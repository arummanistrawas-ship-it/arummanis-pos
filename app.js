// Konfigurasi GAS Web App URL
let GAS_URL = localStorage.getItem('pos_gas_url') || 'https://script.google.com/macros/s/AKfycbxShfwNUtXVeZB_hReUyB8y5oRplJp2y2j-p-eoyiOmZcx_Ad6dhQZFlMIEsD2xgEMc-Q/exec';

// Tier komisi mitra travel/sopir → persentase dari total belanja grup
const MITRA_TIERS = { 'Biasa': 5, 'Aktif': 7, 'Premium': 10 };

// Utility format uang
const formatRupiah = (number) => {
    const val = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(parseFloat(number) || 0);
    return val.replace(/\s+/g, ' '); // Ganti NBSP (No-Break Space) bawaan Intl formatter dengan spasi biasa untuk mencegah karakter corrupt (┬á) di printer thermal
};

// Helper untuk merapikan baris struk belanja (kanan-kiri pas untuk 58mm printer / 32 kolom)
const makePrintRow = (left, right, maxLen = 32) => {
    const leftStr = left.toString();
    const rightStr = right.toString();
    const spacesNeeded = maxLen - leftStr.length - rightStr.length;
    if (spacesNeeded > 0) {
        return leftStr + ' '.repeat(spacesNeeded) + rightStr + '\n';
    }
    return leftStr + ' ' + rightStr + '\n';
};

// Helper untuk merapikan baris tulisan rata tengah dengan spasi manual (agar kompatibel di semua printer thermal)
const makeCenterRow = (text, maxLen = 32) => {
    const cleanText = text.toString().trim();
    if (cleanText.length >= maxLen) return cleanText + '\n';
    const spacesNeeded = Math.floor((maxLen - cleanText.length) / 2);
    return ' '.repeat(spacesNeeded) + cleanText + '\n';
};

// Efek suara scanner bip konvensional menggunakan Web Audio API (Bekerja offline, latency 0ms)
const playBeep = () => {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        
        osc.connect(gain);
        gain.connect(ctx.destination);
        
        osc.type = 'triangle'; // Gunakan triangle wave untuk bunyi digital yang tajam & nyaring mirip bip scanner kasir fisik
        osc.frequency.setValueAtTime(1300, ctx.currentTime); // Frekuensi lebih tinggi (1300 Hz) agar suaranya melengking bersih
        gain.gain.setValueAtTime(0.7, ctx.currentTime); // Perkeras volume menjadi 0.7 (70%)
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.08); // Pudar sangat cepat dalam durasi 80ms agar bersuara "TIT" pendek padat
        
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.08);
    } catch (e) {
        console.error("Gagal memutar bunyi bip:", e);
    }
};

// Konversi Tanggal dari Format Sheet (DD/MM/YYYY) ke Format Date Picker (YYYY-MM-DD)
const convertDateToPickerFormat = (dateStr) => {
    if (!dateStr) return '';
    const parts = dateStr.split('/');
    if (parts.length === 3) {
        return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    }
    return dateStr;
};

// Konversi Tanggal dari Format Date Picker (YYYY-MM-DD) ke Format Sheet (DD/MM/YYYY)
const convertDateToSheetFormat = (dateStr) => {
    if (!dateStr) return '';
    const parts = dateStr.split('-');
    if (parts.length === 3) {
        return `${parts[2]}/${parts[1]}/${parts[0]}`;
    }
    return dateStr;
};

// Helper pembanding barcode tahan crash tipe data (String/Number/Scientific/Controls) dan Null/Undefined
const compareBarcode = (a, b) => {
    if (a === null || a === undefined || b === null || b === undefined) return false;
    const strA = a.toString().trim().replace(/[\r\n\t]/g, '').toLowerCase();
    const strB = b.toString().trim().replace(/[\r\n\t]/g, '').toLowerCase();
    if (strA === "" || strB === "") return false;
    if (strA === strB) return true;
    
    // Penanganan angka atau scientific notation (e.g. 8.99123E+12 vs 8991234567890)
    const numA = parseFloat(strA);
    const numB = parseFloat(strB);
    if (!isNaN(numA) && !isNaN(numB) && numA === numB) return true;
    
    return false;
};

// Helper pencari produk yang mendukung pencocokan Barcode_ID maupun Nama_Camilan
const findProduct = (products, identifier, name) => {
    if (!products || !Array.isArray(products)) return null;
    if (identifier && identifier.toString().trim() !== "") {
        const found = products.find(x => compareBarcode(x.Barcode_ID, identifier));
        if (found) return found;
    }
    if (name && name.toString().trim() !== "") {
        const cleanName = name.toString().trim().toLowerCase();
        const found = products.find(x => x.Nama_Camilan && x.Nama_Camilan.toString().trim().toLowerCase() === cleanName);
        if (found) return found;
    }
    // Fallback: periksa jika identifier sebenarnya adalah nama produk
    if (identifier && identifier.toString().trim() !== "") {
        const cleanId = identifier.toString().trim().toLowerCase();
        const found = products.find(x => x.Nama_Camilan && x.Nama_Camilan.toString().trim().toLowerCase() === cleanId);
        if (found) return found;
    }
    return null;
};

// Helper parsing angka/mata uang tahan segala format (IDR, ribuan titik, koma desimal, teks Rp, null, undefined)
const cleanNumber = (val) => {
    if (val === null || val === undefined || val === '') return 0;
    if (typeof val === 'number') return isNaN(val) ? 0 : val;
    let str = val.toString().trim();
    // Hapus awalan Rp, Rp., IDR, dan spasi
    str = str.replace(/^(?:Rp\.?|IDR)\s*/i, '').trim();
    if (!str) return 0;
    
    // Jika integer murni
    if (/^-?\d+$/.test(str)) return parseInt(str, 10);
    
    // Format Indonesia dengan pemisah ribuan titik: "10.000" atau "1.500.000" atau "10.000,50"
    if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(str)) {
        str = str.replace(/\./g, '').replace(',', '.');
        return parseFloat(str) || 0;
    }
    
    // Format Inggris dengan koma: "10,000" atau "1,500,000" atau "10,000.50"
    if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(str)) {
        str = str.replace(/,/g, '');
        return parseFloat(str) || 0;
    }
    
    // Format koma desimal: "10000,50"
    if (/^-?\d+,\d+$/.test(str)) {
        str = str.replace(',', '.');
        return parseFloat(str) || 0;
    }
    
    // Pembersihan umum jika ada sisa karakter
    const cleaned = str.replace(/[^0-9.,-]/g, '');
    if (cleaned.indexOf('.') > -1 && cleaned.indexOf(',') === -1) {
        const parts = cleaned.split('.');
        if (parts.length === 2 && parts[1].length === 3) {
            return parseInt(parts[0] + parts[1], 10) || 0;
        } else if (parts.length > 2) {
            return parseInt(parts.join(''), 10) || 0;
        }
    }
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
};

// Daftar UUID Service Bluetooth Thermal Printer (ESC/POS & BLE UART)
const PRINTER_SERVICES = [
    '000018f0-0000-1000-8000-00805f9b34fb', // Standard ESC/POS
    'e7810a71-73ae-499d-8c15-faa9aef0c3f2', // Mini POS / Goojprt / Panda
    '0000fee7-0000-1000-8000-00805f9b34fb', // Tencent / Chinese POS
    '0000ffe0-0000-1000-8000-00805f9b34fb', // HM-10 / CC2541 BLE UART (Sangat Populer)
    '0000fff0-0000-1000-8000-00805f9b34fb', // MPT-II / Zjiang / Netum
    '0000ff00-0000-1000-8000-00805f9b34fb', // Zjiang POS
    '0000ff02-0000-1000-8000-00805f9b34fb',
    '49535343-fe7d-4ae5-8fa9-9fafd205e455', // ISSC Transparent UART
    '00001101-0000-1000-8000-00805f9b34fb', // SPP UUID
    '0000ae00-0000-1000-8000-00805f9b34fb',
    '0000af00-0000-1000-8000-00805f9b34fb'
];

// Helper pencocokan cerdas produk (Barcode, Nama, Multi-kata, Tanpa Spasi)
function matchProductSearch(p, query) {
    if (!p || !query) return false;
    const cleanQuery = query.toLowerCase().trim().replace(/[\r\n\t]/g, '');
    if (!cleanQuery) return false;
    
    const bc = p.Barcode_ID ? String(p.Barcode_ID).toLowerCase().trim().replace(/[\r\n\t]/g, '') : '';
    const name = p.Nama_Camilan ? String(p.Nama_Camilan).toLowerCase().trim() : '';
    
    // 1. Pencocokan Barcode (tepat, scientific notation, atau mengandung)
    if (bc && (bc === cleanQuery || compareBarcode(p.Barcode_ID, cleanQuery) || bc.includes(cleanQuery))) {
        return true;
    }
    
    // 2. Pencocokan Nama langsung
    if (name && (name === cleanQuery || name.includes(cleanQuery))) {
        return true;
    }
    
    // 3. Pencocokan tanpa spasi (misal "arummanis" vs "Arum Manis")
    const cleanQueryNoSpaces = cleanQuery.replace(/\s+/g, '');
    const nameNoSpaces = name.replace(/\s+/g, '');
    if (cleanQueryNoSpaces && nameNoSpaces.includes(cleanQueryNoSpaces)) {
        return true;
    }
    
    // 4. Pencocokan Multi-kata (seluruh kata yang diketik ada di nama atau barcode)
    const words = cleanQuery.split(/\s+/).filter(w => w.length > 0);
    if (words.length > 1) {
        const allWordsMatch = words.every(w => name.includes(w) || bc.includes(w));
        if (allWordsMatch) return true;
    }
    
    return false;
}

const app = {
    state: {
        products: [],
        cart: [],
        transactions: [],
        syncQueue: [],
        currentView: 'dashboard',
        scanner: null,
        isScannerRunning: false,
        lastScannedBarcode: '',
        lastScannedTime: 0,
        lastTransaction: null,
        tempSubtotal: 0,
        tempDiscount: 0,
        tempTotal: 0,
        productScanner: null,
        restockScanner: null,
        bluetoothDevice: null,
        bluetoothChar: null,
        bluetoothService: null,
        _printChain: null,
        _keepAliveTimer: null,
        _reconnecting: false,
        _printing: false,
        checkoutMode: 'new',
        repaymentTransactionId: null,
        savedTransactions: [],
        mitra: [],              // Master mitra travel/sopir (referral)
        mitraSessions: [],      // Sesi rombongan (buka/tutup)
        komisiLog: [],          // Catatan komisi per transaksi (sumber kebenaran Laporan Mitra)
        activeSessionId: null,  // Sesi rombongan terpilih utk transaksi berjalan
        settings: {
            shopName: 'Kasir Manis',
            shopAddress: 'Store Camilan dan Oleh-oleh',
            shopPhone: '08123456789',
            shopLogo: '🏪',
            cashierName: 'Admin',
            shopWA: '',
            receiptFooter: 'Terima Kasih!'
        }
    },

    init: async function() {
        this.initServiceWorker();
        this.setupNetworkListeners();
        await this.loadData();
        this.bindEvents();
        this.preloadBluetoothDevice(); // Preload paired bluetooth devices di background
        this.updateSavedBadge();
        
        // Baca view dari hash URL untuk mendukung refresh halaman langsung ke menu aktif
        const initialView = window.location.hash ? window.location.hash.substring(1) : 'dashboard';
        history.replaceState({ view: initialView }, '', '#' + initialView);
        
        // Blokir popstate pertama kali (ghost event di WebView)
        let isInitialLoad = true;
        window.addEventListener('popstate', (event) => {
            if (isInitialLoad) {
                isInitialLoad = false;
                return;
            }

            // Prioritas 1: Jika ada popup / modal / scanner yang sedang terbuka saat tombol Back HP ditekan, tutup modalnya
            if (this.closeAnyOpenModal()) {
                // Pastikan state URL tetap konsisten pada menu aktif saat ini
                history.replaceState({ view: this.state.currentView }, '', '#' + this.state.currentView);
                return;
            }

            // Prioritas 2: Navigasi mundur antar halaman
            if (event.state && event.state.view) {
                this.navigate(event.state.view, false);
            } else {
                this.navigate('dashboard', false);
            }
        });
        setTimeout(() => { isInitialLoad = false; }, 500);
        
        // Pastikan kolom input produk selalu bersih saat app pertama kali dibuka
        const initialManualInput = document.getElementById('manualBarcode');
        if (initialManualInput) initialManualInput.value = '';
        const initialSuggestions = document.getElementById('searchSuggestions');
        if (initialSuggestions) { initialSuggestions.classList.add('hidden'); initialSuggestions.innerHTML = ''; }
        
        this.navigate(initialView, false);
        
        // Dummy data jika kosong (hanya untuk testing lokal sebelum konek GAS)
        if (this.state.products.length === 0 && GAS_URL === 'YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL') {
            this.state.products = [
                { Barcode_ID: "1111", Nama_Camilan: "Camilan Original", Harga: 15000, Stok: 50, Status: "Ready" },
                { Barcode_ID: "2222", Nama_Camilan: "Camilan Coklat", Harga: 17000, Stok: 30, Status: "Ready" }
            ];
            this.saveData();
            this.updateProductDatalist();
        }
    },

    // Helper untuk menutup modal, dialog, scanner, atau popup form yang sedang aktif
    closeAnyOpenModal: function() {
        let closedSomething = false;

        // 1. Tutup SweetAlert2 jika sedang aktif
        if (typeof Swal !== 'undefined' && Swal.isVisible && Swal.isVisible()) {
            Swal.close();
            closedSomething = true;
        }

        // 2. Tutup Scanner aktif
        if (this.state.isScannerRunning) {
            this.stopScanner();
            closedSomething = true;
        }
        if (this.state.productScanner) {
            this.stopProductScanner();
            closedSomething = true;
        }
        if (this.state.restockScanner) {
            this.stopRestockScanner();
            closedSomething = true;
        }

        // 3. Tutup Overlay Form Produk
        const prodOverlay = document.getElementById('productFormOverlay');
        if (prodOverlay && !prodOverlay.classList.contains('hidden')) {
            prodOverlay.classList.add('hidden');
            closedSomething = true;
        }

        // 4. Tutup Overlay Form Restok
        const restockOverlay = document.getElementById('restockFormOverlay');
        if (restockOverlay && !restockOverlay.classList.contains('hidden')) {
            restockOverlay.classList.add('hidden');
            closedSomething = true;
        }

        // 5. Tutup dropdown sugesti pencarian kasir
        const suggestionsBox = document.getElementById('searchSuggestions');
        if (suggestionsBox && !suggestionsBox.classList.contains('hidden')) {
            suggestionsBox.classList.add('hidden');
            closedSomething = true;
        }

        return closedSomething;
    },

    // Handler tombol Back Terpadu (digunakan oleh tombol back header & tombol back smartphone)
    handleBack: function() {
        // Jika ada modal / scanner / overlay yang aktif, tutup terlebih dahulu
        if (this.closeAnyOpenModal()) {
            return;
        }

        // Jika sedang di layar Checkout (Pembayaran), kembali ke Transaksi (POS)
        if (this.state.currentView === 'checkout') {
            this.navigate('pos');
            return;
        }

        // Jika sedang di layar Struk Transaksi, kembali ke Transaksi (POS)
        if (this.state.currentView === 'receipt') {
            this.navigate('pos');
            return;
        }

        // Jika sedang di sub-menu manapun selain dashboard, kembali ke Menu Utama (Dashboard)
        if (this.state.currentView !== 'dashboard') {
            this.navigate('dashboard');
            return;
        }
    },

    // --- Core & Navigation ---
    navigate: function(viewId, pushHistory = true) {
        document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        
        const container = document.querySelector('.app-container');
        if (container) {
            if (viewId === 'pos') {
                container.classList.add('pos-active');
            } else {
                container.classList.remove('pos-active');
            }
        }
        
        const view = document.getElementById(`view-${viewId}`);
        if(!view) {
            this.navigate('dashboard', false);
            return;
        }
        view.classList.remove('hidden');
        setTimeout(() => view.classList.add('active'), 10);
        
        this.state.currentView = viewId;
        
        // Catat di history browser jika navigasi maju
        if (pushHistory) {
            history.pushState({ view: viewId }, '', '#' + viewId);
        }
        
        // UI Updates based on view
        const titleEl = document.getElementById('pageTitle');
        const backBtn = document.getElementById('backBtn');
        
        if (viewId === 'dashboard') {
            titleEl.textContent = 'Menu Utama';
            backBtn.classList.add('hidden');
        } else {
            backBtn.classList.remove('hidden');
            if(viewId === 'pos') { 
                titleEl.textContent = 'Transaksi Baru'; 
                // Selalu bersihkan kolom input produk & sugesti saat masuk menu Transaksi
                const manualInput = document.getElementById('manualBarcode');
                if (manualInput) {
                    manualInput.value = '';
                }
                const suggestionsBox = document.getElementById('searchSuggestions');
                if (suggestionsBox) {
                    suggestionsBox.classList.add('hidden');
                    suggestionsBox.innerHTML = '';
                }
                this.updateCartUI();
                this.renderSessionChips();
                this.refreshProductsFromServer();
            }
            if(viewId === 'checkout') titleEl.textContent = 'Pembayaran';
            if(viewId === 'receipt') { titleEl.textContent = 'Struk Transaksi'; backBtn.classList.add('hidden'); }
            if(viewId === 'history') { titleEl.textContent = 'Histori Transaksi'; this.renderTransactionList('all', 'transactionListContainer', 'searchTransaction'); this.refreshTransactionsFromServer(); }
            if(viewId === 'debt') { titleEl.textContent = 'Belum Lunas (Kasbon)'; this.renderTransactionList('Kasbon', 'debtListContainer', 'searchDebt'); this.refreshTransactionsFromServer(); }
            if(viewId === 'products') { titleEl.textContent = 'Manajemen Produk'; this.renderProductList(); this.refreshProductsFromServer(); }
            if(viewId === 'settings') { titleEl.textContent = 'Pengaturan'; this.showSettingsForm(); }
            if(viewId === 'saved') { titleEl.textContent = 'Transaksi Tersimpan'; this.renderSavedTransactions(); }
            if(viewId === 'reports') { titleEl.textContent = 'Laporan Keuangan'; this.initReports(); this.refreshTransactionsFromServer(); }
            if(viewId === 'mitra') { titleEl.textContent = 'Mitra Travel'; this.renderMitraList(); }
            if(viewId === 'mitraReport') { titleEl.textContent = 'Laporan Mitra'; this.initMitraReport(); }
        }
    },

    loadData: async function() {
        // C2 Fix: Try/catch to prevent crash on corrupted localStorage
        try {
            this.state.products = JSON.parse(localStorage.getItem('pos_products') || '[]');
        } catch (e) { this.state.products = []; console.error('Corrupt pos_products, reset:', e); }
        try {
            this.state.transactions = JSON.parse(localStorage.getItem('pos_transactions') || '[]');
        } catch (e) { this.state.transactions = []; console.error('Corrupt pos_transactions, reset:', e); }
        try {
            this.state.syncQueue = JSON.parse(localStorage.getItem('pos_queue') || '[]');
        } catch (e) { this.state.syncQueue = []; console.error('Corrupt pos_queue, reset:', e); }
        
        try {
            const savedSettings = localStorage.getItem('pos_settings');
            if (savedSettings) {
                this.state.settings = JSON.parse(savedSettings);
            }
        } catch (e) { console.error('Corrupt pos_settings, using defaults:', e); }
        
        // Load saved/held transactions
        try {
            this.state.savedTransactions = JSON.parse(localStorage.getItem('pos_saved_transactions') || '[]');
        } catch (e) { this.state.savedTransactions = []; }

        // Load data Mitra Travel (referral/komisi)
        try {
            this.state.mitra = JSON.parse(localStorage.getItem('pos_mitra') || '[]');
        } catch (e) { this.state.mitra = []; }
        try {
            this.state.mitraSessions = JSON.parse(localStorage.getItem('pos_mitra_sessions') || '[]');
        } catch (e) { this.state.mitraSessions = []; }
        try {
            this.state.komisiLog = JSON.parse(localStorage.getItem('pos_komisi_log') || '[]');
        } catch (e) { this.state.komisiLog = []; }

        this.checkOfflineQueue();

        // PENTING: jangan blokir startup menunggu server. Data lokal (cache) sudah dimuat di atas,
        // jadi scan & pencarian produk langsung aktif. Sinkronisasi server dijalankan di LATAR BELAKANG.
        this._backgroundServerSync();
    },

    // Sinkronisasi data dari Google Sheets tanpa memblokir UI (dipanggil setelah cache lokal siap)
    _backgroundServerSync: async function() {
        if (!navigator.onLine || GAS_URL === 'YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL') return;
        // refreshProductsFromServer sudah aman-merge (mempertahankan antrean lokal) & auto re-render POS/produk
        try { await this.refreshProductsFromServer(); } catch (e) { console.error('BG produk:', e); }
        try { await this.refreshSettingsFromServer(); } catch (e) { console.error('BG settings:', e); }
        try { await this.refreshTransactionsFromServer(); } catch (e) { console.error('BG transaksi:', e); }
        // Kirim antrean offline yang tertunda setelah konek kembali
        this.syncData();
    },
    // C1 Fix: saveData now also persists settings
    saveData: function() {
        localStorage.setItem('pos_products', JSON.stringify(this.state.products));
        localStorage.setItem('pos_transactions', JSON.stringify(this.state.transactions));
        localStorage.setItem('pos_queue', JSON.stringify(this.state.syncQueue));
        localStorage.setItem('pos_settings', JSON.stringify(this.state.settings));
        localStorage.setItem('pos_saved_transactions', JSON.stringify(this.state.savedTransactions));
        localStorage.setItem('pos_mitra', JSON.stringify(this.state.mitra));
        localStorage.setItem('pos_mitra_sessions', JSON.stringify(this.state.mitraSessions));
        localStorage.setItem('pos_komisi_log', JSON.stringify(this.state.komisiLog));
    },

    // --- POS & Cart Logic ---
    bindEvents: function() {
        document.getElementById('toggleCameraBtn').addEventListener('click', () => this.toggleScanner());
        document.getElementById('addManualBtn').addEventListener('click', () => this.handleManualAdd());
        
        const manualInput = document.getElementById('manualBarcode');
        const suggestionsBox = document.getElementById('searchSuggestions');

        manualInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.handleManualAdd();
        });

        // Event listener untuk memfilter produk secara real-time saat mengetik
        manualInput.addEventListener('input', (e) => {
            const term = e.target.value.trim().toLowerCase();
            if (!term) {
                suggestionsBox.classList.add('hidden');
                suggestionsBox.innerHTML = '';
                return;
            }
            this.renderSearchSuggestions(term);
        });

        // Sembunyikan sugesti pencarian jika mengklik di luar area input / dropdown
        document.addEventListener('click', (e) => {
            if (!manualInput.contains(e.target) && !suggestionsBox.contains(e.target)) {
                suggestionsBox.classList.add('hidden');
            }
        });

        // Munculkan kembali sugesti jika input mendapat fokus kembali dan tidak kosong
        manualInput.addEventListener('focus', () => {
            if (manualInput.value.trim()) {
                this.renderSearchSuggestions(manualInput.value.trim().toLowerCase());
            }
        });

        document.getElementById('discountType').addEventListener('change', () => this.updateCartUI());
        document.getElementById('discountValue').addEventListener('input', () => this.updateCartUI());

        document.getElementById('processCheckoutBtn').addEventListener('click', () => {
            if(this.state.cart.length > 0) this.prepareCheckout();
        });

        document.getElementById('checkoutMethod').addEventListener('change', (e) => {
            const cashSection = document.getElementById('cashInputSection');
            const label = cashSection.querySelector('label');
            if (e.target.value === 'Tunai' || e.target.value === 'Kasbon') {
                cashSection.classList.remove('hidden');
                if (e.target.value === 'Kasbon') {
                    label.textContent = "Uang Muka / Bayar Sebagian (Rp)";
                } else {
                    label.textContent = "Uang Tunai Diterima (Rp)";
                }
            } else {
                cashSection.classList.add('hidden');
            }
            this.calculateChange();
        });
        document.getElementById('checkoutCash').addEventListener('input', () => {
            this.calculateChange();
            this.updateActiveQuickCashBtn(null); // Matikan status aktif tombol cepat jika diinput manual
        });

        document.getElementById('printReceiptBtn').addEventListener('click', () => this.printReceipt());
        document.getElementById('editTransactionBtn').addEventListener('click', () => this.editLastTransaction());

        // --- Restock Autocomplete Search ---
        const restockInput = document.getElementById('restockProductSearch');
        const restockSuggestions = document.getElementById('restockSuggestions');

        restockInput.addEventListener('input', (e) => {
            const term = e.target.value.trim().toLowerCase();
            if (!term) {
                restockSuggestions.classList.add('hidden');
                restockSuggestions.innerHTML = '';
                return;
            }

            const matches = this.state.products.filter(p => 
                (p.Barcode_ID && p.Barcode_ID.toLowerCase().includes(term)) || 
                (p.Nama_Camilan && p.Nama_Camilan.toLowerCase().includes(term))
            );

            if (matches.length === 0) {
                restockSuggestions.innerHTML = '<div class="suggestion-item" style="color: #999; cursor: default;">Produk tidak ditemukan</div>';
                restockSuggestions.classList.remove('hidden');
                return;
            }

            restockSuggestions.innerHTML = '';
            matches.slice(0, 8).forEach(p => {
                const item = document.createElement('div');
                item.className = 'suggestion-item';
                item.innerHTML = `
                    <div>
                        <div class="suggestion-name">${p.Nama_Camilan}</div>
                        <div class="suggestion-meta">Barcode: ${p.Barcode_ID || '—'} (Stok: ${p.Stok})</div>
                    </div>
                    <div style="font-weight: 600; color: var(--primary); font-size: 0.95rem;">${formatRupiah(p.Harga)}</div>
                `;
                item.addEventListener('click', () => {
                    this.selectRestockProduct(p);
                    restockInput.value = '';
                    restockSuggestions.classList.add('hidden');
                    restockSuggestions.innerHTML = '';
                });
                restockSuggestions.appendChild(item);
            });
            restockSuggestions.classList.remove('hidden');
        });

        restockInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                const term = restockInput.value.trim();
                if (!term) return;
                const p = this.state.products.find(x => 
                    (x.Barcode_ID && compareBarcode(x.Barcode_ID, term)) || 
                    (x.Nama_Camilan && String(x.Nama_Camilan).toLowerCase() === term.toLowerCase()) ||
                    (x.Nama_Camilan && String(x.Nama_Camilan).toLowerCase().includes(term.toLowerCase()))
                );
                if (p) {
                    this.selectRestockProduct(p);
                    restockInput.value = '';
                    restockSuggestions.classList.add('hidden');
                } else {
                    Swal.fire('Gagal', 'Produk tidak ditemukan!', 'warning');
                }
            }
        });

        document.addEventListener('click', (e) => {
            if (!restockInput.contains(e.target) && !restockSuggestions.contains(e.target)) {
                restockSuggestions.classList.add('hidden');
            }
        });
    },

    // M4 Fix: Removed dead datalist code (productList element doesn't exist in HTML)
    updateProductDatalist: function() { /* no-op, search suggestions used instead */ },

    handleManualAdd: function() {
        const manualInput = document.getElementById('manualBarcode');
        if (!manualInput) return;
        const input = manualInput.value.trim();
        if(!input) return;
        
        // Cari produk dengan pencocokan pintar (barcode, nama, multi-kata)
        const p = this.state.products.find(x => matchProductSearch(x, input));
        if(p) {
            this.addToCart(p);
            manualInput.value = '';
            const suggestionsBox = document.getElementById('searchSuggestions');
            if (suggestionsBox) {
                suggestionsBox.classList.add('hidden');
                suggestionsBox.innerHTML = '';
            }
        } else {
            Swal.fire({
                title: 'Produk Tidak Ditemukan',
                text: `Barcode / Kata kunci "${input}" tidak cocok dengan produk manapun di database.`,
                icon: 'warning',
                confirmButtonText: 'OK'
            });
        }
    },

     addToCart: function(product, forceOverride) {
        // Cek ketersediaan stok sebelum menambahkan ke keranjang
        const currentStok = parseInt(product.Stok) || 0;
        const existing = this.state.cart.find(x => {
            if (product.Barcode_ID && product.Barcode_ID.toString().trim() !== "") {
                return x.Barcode_ID && compareBarcode(x.Barcode_ID, product.Barcode_ID);
            }
            return x.Nama_Camilan === product.Nama_Camilan;
        });

        // Total pcs di keranjang (semuanya berbayar, mengurangi stok)
        const qtyInCart = existing ? (parseInt(existing.qty) || 0) : 0;
        const willExceed = qtyInCart >= currentStok;

        // Jika stok habis/melebihi DAN belum di-override → tanya kasir
        if (willExceed && !forceOverride) {
            const sisaText = currentStok <= 0
                ? 'Stok di sistem: <b>HABIS (0)</b>'
                : `Stok di sistem: <b>${currentStok}</b>, sudah <b>${qtyInCart}</b> di keranjang`;

            Swal.fire({
                title: 'Stok Tidak Cukup',
                html: `<div style="text-align:left; font-size: 0.92rem;">
                    <p><b>${product.Nama_Camilan}</b></p>
                    <p>${sisaText}</p>
                    <hr style="margin: 8px 0; border-color: #f1f5f9;">
                    <p style="color: #64748b;">Jika barang <b>fisik masih ada di etalase</b>, Anda bisa tetap menjual. Stok akan tercatat minus sebagai pengingat untuk restok/stock opname.</p>
                </div>`,
                icon: 'warning',
                showCancelButton: true,
                confirmButtonText: '🛒 Tetap Jual',
                cancelButtonText: 'Batal',
                confirmButtonColor: '#F39C12'
            }).then((res) => {
                if (res.isConfirmed) {
                    this.addToCart(product, true); // Panggil ulang dengan forceOverride=true
                }
            });
            return;
        }

        if(existing) {
            existing.qty = (parseInt(existing.qty) || 0) + 1;
        } else {
            this.state.cart.push({ ...product, qty: 1, editPrice: parseInt(product.Harga) || 0 });
        }
        this.updateCartUI();

        // Auto-scroll keranjang ke item terbaru di paling bawah
        const cartContainer = document.getElementById('cartItems');
        if (cartContainer) {
            setTimeout(() => { cartContainer.scrollTop = cartContainer.scrollHeight; }, 50);
        }

        // Refresh dropdown saran produk agar stok terupdate tanpa menutup dropdown
        const manualInput = document.getElementById('manualBarcode');
        const currentTerm = manualInput ? manualInput.value.trim().toLowerCase() : '';
        if (currentTerm) {
            this.renderSearchSuggestions(currentTerm);
        }

        const sisaSetelah = currentStok - qtyInCart - 1;
        if (sisaSetelah < 0) {
            Swal.fire({ toast: true, position: 'top-end', icon: 'info', title: `${product.Nama_Camilan} ditambahkan (Stok minus: ${sisaSetelah})`, showConfirmButton: false, timer: 2000 });
        } else {
            Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: `${product.Nama_Camilan} ditambahkan (Sisa: ${sisaSetelah})`, showConfirmButton: false, timer: 1500 });
        }
    },

    updateCartItem: function(identifier, field, value) {
        const item = this.state.cart.find(x => 
            (x.Barcode_ID && compareBarcode(x.Barcode_ID, identifier)) || 
            (x.Nama_Camilan === identifier.toString())
        );
        if(item) {
            if(field === 'qty') {
                const q = parseInt(value);
                if (isNaN(q) || q <= 0) {
                    this.removeCartItem(identifier);
                    return;
                }
                // Peringatan jika melebihi stok, tapi tetap izinkan
                const product = this.state.products.find(p =>
                    (p.Barcode_ID && item.Barcode_ID && compareBarcode(p.Barcode_ID, item.Barcode_ID)) ||
                    p.Nama_Camilan === item.Nama_Camilan
                );
                if (product) {
                    const maxStok = parseInt(product.Stok) || 0;
                    if (q > maxStok) {
                        Swal.fire({ toast: true, position: 'top-end', icon: 'info', title: `${item.Nama_Camilan} — Qty (${q}) melebihi stok sistem (${maxStok})`, showConfirmButton: false, timer: 2500 });
                    }
                }
                item.qty = q;
            }
            if(field === 'price') item.editPrice = parseInt(value) || 0;
            this.updateCartUI();
        }
    },

    // Render dropdown saran pencarian produk dengan tombol '+' (tetap terbuka setelah tambah item)
    renderSearchSuggestions: function(term) {
        const suggestionsBox = document.getElementById('searchSuggestions');
        if (!suggestionsBox) return;
        if (!term) {
            suggestionsBox.classList.add('hidden');
            suggestionsBox.innerHTML = '';
            return;
        }

        // Tampilkan indikator jika database produk masih dalam proses loading dari server
        if (!this.state.products || this.state.products.length === 0) {
            suggestionsBox.innerHTML = '<div class="suggestion-item" style="color: #64748b; cursor: default; padding: 12px; text-align: center;"><i class="fas fa-spinner fa-spin" style="margin-right: 6px;"></i>Sedang memuat database produk...</div>';
            suggestionsBox.classList.remove('hidden');
            return;
        }

        const cleanTerm = term.trim().toLowerCase().replace(/[\r\n\t]/g, '');
        const matches = this.state.products.filter(p => matchProductSearch(p, cleanTerm));

        if (matches.length === 0) {
            suggestionsBox.innerHTML = '<div class="suggestion-item" style="color: #999; cursor: default; padding: 12px; text-align: center;"><i class="fas fa-search" style="margin-right: 6px; opacity: 0.5;"></i>Produk tidak ditemukan</div>';
            suggestionsBox.classList.remove('hidden');
            return;
        }

        // Simpan posisi scroll saat ini agar tidak loncat ke atas setelah re-render
        const prevScroll = suggestionsBox.scrollTop;

        suggestionsBox.innerHTML = '';
        matches.slice(0, 30).forEach(p => {
            // Hitung jumlah item ini yang sudah di keranjang
            const inCart = this.state.cart.find(c => {
                if (p.Barcode_ID && p.Barcode_ID.toString().trim() !== "") {
                    return c.Barcode_ID && compareBarcode(c.Barcode_ID, p.Barcode_ID);
                }
                return c.Nama_Camilan === p.Nama_Camilan;
            });
            const qtyInCart = inCart ? (parseInt(inCart.qty) || 0) : 0;
            const currentStok = parseInt(p.Stok) || 0;
            const sisaStok = currentStok - qtyInCart;

            const item = document.createElement('div');
            item.className = 'suggestion-item';
            item.innerHTML = `
                <div class="suggestion-info">
                    <div class="suggestion-name">${p.Nama_Camilan}</div>
                    <div class="suggestion-meta">${formatRupiah(p.Harga)} · Stok: <b style="color: ${sisaStok <= 0 ? 'var(--danger)' : 'inherit'}">${sisaStok}</b>${qtyInCart > 0 ? ` (${qtyInCart} di keranjang)` : ''}</div>
                </div>
                <button class="suggestion-add-btn" title="Tambah ke keranjang">+</button>
            `;

            // Klik tombol '+' untuk tambah ke keranjang (dropdown tetap terbuka)
            const addBtn = item.querySelector('.suggestion-add-btn');
            addBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.addToCart(p);
            });

            // Klik area info produk juga bisa menambahkan
            const infoArea = item.querySelector('.suggestion-info');
            infoArea.addEventListener('click', (e) => {
                e.stopPropagation();
                this.addToCart(p);
            });

            suggestionsBox.appendChild(item);
        });
        suggestionsBox.classList.remove('hidden');

        // Restore posisi scroll
        suggestionsBox.scrollTop = prevScroll;
    },

    updateCartItemVal: function(identifier, field, el) {
        const item = this.state.cart.find(x => 
            (x.Barcode_ID && x.Barcode_ID.toString().trim() === identifier.toString().trim()) || 
            (x.Nama_Camilan === identifier.toString())
        );
        if (item) {
            const val = parseInt(el.value) || 0;
            if (field === 'price') {
                // C4 Fix: Prevent negative prices
                item.editPrice = Math.max(0, val);
            } else if (field === 'qty') {
                item.qty = Math.max(0, val);
            }

            // Hitung ulang total tanpa rebuild list DOM (pendapatan = qty berbayar × harga; item = berbayar + bonus)
            let subtotal = 0;
            let count = 0;
            this.state.cart.forEach(i => {
                const q = this._itemQtys(i);
                subtotal += q.lineRevenue;
                count += q.total;
            });

            // Update subtotal per baris
            const thisQ = this._itemQtys(item);
            const rowTotalEl = el.closest('.cart-item').querySelector('.item-header span:last-child');
            if (rowTotalEl) rowTotalEl.textContent = formatRupiah(thisQ.lineRevenue);

            // Hitung Diskon (C3 Fix: clamp negative discounts)
            const dType = document.getElementById('discountType').value;
            const dVal = Math.max(0, parseInt(document.getElementById('discountValue').value) || 0);
            let discountAmount = 0;
            if (dType === 'nominal') discountAmount = dVal;
            if (dType === 'percent') discountAmount = subtotal * (dVal / 100);
            const grandTotal = subtotal - discountAmount;
            
            document.getElementById('itemCount').textContent = `${count} item`;
            document.getElementById('subtotalPrice').textContent = formatRupiah(subtotal);
            document.getElementById('totalPrice').textContent = formatRupiah(grandTotal);
            
            this.state.tempSubtotal = subtotal;
            this.state.tempDiscount = discountAmount;
            this.state.tempTotal = grandTotal;
            this.saveData();
        }
    },

    cleanCartItemInput: function(identifier, field, el) {
        const item = this.state.cart.find(x => 
            (x.Barcode_ID && x.Barcode_ID.toString().trim() === identifier.toString().trim()) || 
            (x.Nama_Camilan === identifier.toString())
        );
        if (item) {
            if (field === 'qty') {
                const val = parseInt(el.value) || 0;
                if (val <= 0) {
                    this.removeCartItem(identifier);
                }
            }
        }
    },

    removeCartItem: function(identifier) {
        this.state.cart = this.state.cart.filter(x => 
            !((x.Barcode_ID && x.Barcode_ID.toString().trim() === identifier.toString().trim()) || 
              (x.Nama_Camilan === identifier.toString()))
        );
        this.updateCartUI();
    },

    updateCartUI: function() {
        const container = document.getElementById('cartItems');
        container.innerHTML = '';
        
        let subtotal = 0;
        let count = 0;

        if (this.state.cart.length === 0) {
            container.innerHTML = '<div class="empty-cart"><p>Keranjang kosong</p></div>';
            document.getElementById('processCheckoutBtn').disabled = true;
        } else {
            document.getElementById('processCheckoutBtn').disabled = false;
            
            this.state.cart.forEach(item => {
                const paidQty = parseInt(item.qty) || 0;
                subtotal += (item.editPrice || 0) * paidQty;
                count += paidQty;

                const div = document.createElement('div');
                div.className = 'cart-item';
                const idKey = (item.Barcode_ID && item.Barcode_ID.toString().trim() !== "") ? item.Barcode_ID.toString().trim() : item.Nama_Camilan;

                div.innerHTML = `
                    <div class="item-header">
                        <span>${item.Nama_Camilan}</span>
                        <span>${formatRupiah((item.editPrice || 0) * paidQty)}</span>
                    </div>
                    <div class="item-editor">
                        <label>Rp</label>
                        <input type="number" value="${item.editPrice}" oninput="app.updateCartItemVal('${idKey}', 'price', this)" onblur="app.cleanCartItemInput('${idKey}', 'price', this)" style="width:65px;">
                        <label>x</label>
                        <div class="qty-controls">
                            <button class="qty-btn" onclick="app.updateCartItem('${idKey}', 'qty', ${paidQty - 1})">-</button>
                            <input type="number" class="qty-input" value="${paidQty}" oninput="app.updateCartItemVal('${idKey}', 'qty', this)" onblur="app.cleanCartItemInput('${idKey}', 'qty', this)">
                            <button class="qty-btn" onclick="app.updateCartItem('${idKey}', 'qty', ${paidQty + 1})">+</button>
                            <button class="qty-btn del" onclick="app.removeCartItem('${idKey}')"><i class="fas fa-trash"></i></button>
                        </div>
                    </div>
                `;
                container.appendChild(div);
            });
        }

        // Hitung Diskon (C3 Fix: clamp negative discounts)
        const dType = document.getElementById('discountType').value;
        const dVal = Math.max(0, parseInt(document.getElementById('discountValue').value) || 0);
        let discountAmount = 0;
        
        if (dType === 'nominal') discountAmount = dVal;
        if (dType === 'percent') discountAmount = subtotal * (dVal / 100);
        
        const grandTotal = subtotal - discountAmount;
        
        document.getElementById('itemCount').textContent = `${count} item`;
        document.getElementById('subtotalPrice').textContent = formatRupiah(subtotal);
        document.getElementById('totalPrice').textContent = formatRupiah(grandTotal);
        
        this.state.tempSubtotal = subtotal;
        this.state.tempDiscount = discountAmount;
        this.state.tempTotal = grandTotal;
    },

    // --- Checkout Logic ---
    prepareCheckout: function() {
        if (this.state.cart.length === 0) {
            Swal.fire('Gagal', 'Keranjang belanja masih kosong!', 'warning');
            return;
        }
        if (this.state.tempSubtotal - this.state.tempDiscount < 0) {
            Swal.fire('Gagal', 'Total pembayaran tidak boleh bernilai minus! Silakan periksa kembali nominal diskon Anda.', 'warning');
            return;
        }
        const total = this.state.tempTotal;
        if (this.state.isScannerRunning) this.stopScanner();

        this.state.checkoutMode = 'new';
        this.state.repaymentTransactionId = null;

        // Set judul kembali ke Proses Pembayaran
        document.getElementById('checkoutViewTitle').textContent = 'Proses Pembayaran';
        document.getElementById('checkoutTotal').textContent = formatRupiah(total);
        
        // Re-enable input nama pelanggan
        const custInput = document.getElementById('checkoutCustomer');
        custInput.value = '';
        custInput.disabled = false;
        
        document.getElementById('checkoutCash').value = '';
        document.getElementById('checkoutChange').textContent = 'Rp 0';
        document.getElementById('checkoutChange').className = 'success-text';

        // Kembalikan opsi metode pembayaran lengkap
        const methodSelect = document.getElementById('checkoutMethod');
        methodSelect.innerHTML = `
            <option value="Tunai">Tunai</option>
            <option value="Transfer">Transfer Bank</option>
            <option value="QRIS">QRIS</option>
            <option value="Kasbon">Belum Lunas (Kasbon)</option>
        `;
        methodSelect.value = 'Tunai';
        
        const cashSection = document.getElementById('cashInputSection');
        cashSection.classList.remove('hidden');
        cashSection.querySelector('label').textContent = "Uang Tunai Diterima (Rp)";
        
        // Reset tombol checkout
        this.resetCheckoutButtons();

        // Render tombol nominal uang bulat cepat secara dinamis
        const quickCashBox = document.getElementById('quickCashContainer');
        quickCashBox.innerHTML = '';
        
        // 1. Tambahkan tombol Uang Pas jika total belanja > 0
        if (total > 0) {
            const btnPas = document.createElement('button');
            btnPas.className = 'quick-cash-btn';
            btnPas.textContent = 'Uang Pas';
            btnPas.addEventListener('click', () => {
                document.getElementById('checkoutCash').value = total;
                this.calculateChange();
                this.updateActiveQuickCashBtn(btnPas);
            });
            quickCashBox.appendChild(btnPas);
        }
        
        // 2. Tambahkan tombol nominal bulat: 10k, 20k, 30k, 50k, 60k, 70k, 80k, 90k, 100k
        const nominals = [10000, 20000, 30000, 50000, 60000, 70000, 80000, 90000, 100000];
        nominals.forEach(nom => {
            // Tampilkan hanya nominal yang bernilai lebih besar atau sama dengan total belanja
            if (nom >= total) {
                const btnNom = document.createElement('button');
                btnNom.className = 'quick-cash-btn';
                btnNom.textContent = nom.toLocaleString('id-ID');
                btnNom.addEventListener('click', () => {
                    document.getElementById('checkoutCash').value = nom;
                    this.calculateChange();
                    this.updateActiveQuickCashBtn(btnNom);
                });
                quickCashBox.appendChild(btnNom);
            }
        });
        
        this.navigate('checkout');
    },

    prepareRepayment: function(trxId) {
        const trx = this.state.transactions.find(x => x.id === trxId);
        if (!trx) return;

        this.state.checkoutMode = 'repayment';
        this.state.repaymentTransactionId = trxId;

        const currentDebt = trx.remainingDebt !== undefined ? trx.remainingDebt : Math.max(0, trx.total - (trx.cash || 0));

        // Ubah judul checkout & sisa hutang yang harus dibayar
        document.getElementById('checkoutViewTitle').textContent = 'Pelunasan Kasbon';
        document.getElementById('checkoutTotal').textContent = formatRupiah(currentDebt);
        
        // Kunci input nama pelanggan (read-only)
        const custInput = document.getElementById('checkoutCustomer');
        custInput.value = trx.customer;
        custInput.disabled = true;
        
        document.getElementById('checkoutCash').value = '';
        document.getElementById('checkoutChange').textContent = 'Rp 0';
        document.getElementById('checkoutChange').className = 'success-text';

        // Sembunyikan opsi "Kasbon" saat pelunasan hutang (tidak masuk akal mencicil hutang dengan hutang)
        const methodSelect = document.getElementById('checkoutMethod');
        methodSelect.innerHTML = `
            <option value="Tunai">Tunai</option>
            <option value="Transfer">Transfer Bank</option>
            <option value="QRIS">QRIS</option>
        `;
        methodSelect.value = 'Tunai';
        
        const cashSection = document.getElementById('cashInputSection');
        cashSection.classList.remove('hidden');
        cashSection.querySelector('label').textContent = "Jumlah Pembayaran / Cicilan (Rp)";

        // Reset tombol checkout untuk mode pelunasan
        this.resetCheckoutButtons();

        // Render tombol nominal cepat berdasarkan sisa hutang
        const quickCashBox = document.getElementById('quickCashContainer');
        quickCashBox.innerHTML = '';
        
        // 1. Tombol Bayar Lunas (Uang Pas)
        if (currentDebt > 0) {
            const btnPas = document.createElement('button');
            btnPas.className = 'quick-cash-btn';
            btnPas.textContent = 'Bayar Lunas';
            btnPas.addEventListener('click', () => {
                document.getElementById('checkoutCash').value = currentDebt;
                this.calculateChange();
                this.updateActiveQuickCashBtn(btnPas);
            });
            quickCashBox.appendChild(btnPas);
        }
        
        // 2. Tombol nominal bulat >= sisa hutang
        const nominals = [10000, 20000, 30000, 50000, 60000, 70000, 80000, 90000, 100000];
        nominals.forEach(nom => {
            if (nom >= currentDebt) {
                const btnNom = document.createElement('button');
                btnNom.className = 'quick-cash-btn';
                btnNom.textContent = nom.toLocaleString('id-ID');
                btnNom.addEventListener('click', () => {
                    document.getElementById('checkoutCash').value = nom;
                    this.calculateChange();
                    this.updateActiveQuickCashBtn(btnNom);
                });
                quickCashBox.appendChild(btnNom);
            }
        });

        // Reset kode referral manual & tampilkan info mitra (sesi aktif / kosong)
        const refInput = document.getElementById('checkoutReferral');
        if (refInput) refInput.value = '';
        this.updateCheckoutMitraInfo();

        this.navigate('checkout');
    },

    cancelCheckout: function() {
        if (this.state.checkoutMode === 'repayment') {
            this.navigate('debt');
        } else {
            this.navigate('pos');
        }
    },

    resetCheckoutButtons: function() {
        const btnKasbon = document.getElementById('btnCheckoutKasbon');
        const btnLunas = document.getElementById('btnCheckoutLunas');
        if (btnLunas) {
            btnLunas.disabled = false;
            btnLunas.innerHTML = this.state.checkoutMode === 'repayment' 
                ? '<i class="fas fa-print"></i> Simpan & Cetak Resi' 
                : '<i class="fas fa-print"></i> Lanjut Cetak Resi';
        }
        if (btnKasbon) {
            if (this.state.checkoutMode === 'repayment') {
                btnKasbon.classList.add('hidden');
            } else {
                btnKasbon.classList.remove('hidden');
                btnKasbon.disabled = false;
            }
        }
    },

    processCheckoutKasbon: function() {
        const customer = document.getElementById('checkoutCustomer').value.trim();
        if (!customer) {
            return Swal.fire('Gagal', 'Nama Pelanggan wajib diisi untuk transaksi Kasbon!', 'warning');
        }
        document.getElementById('checkoutMethod').value = 'Kasbon';
        this.processTransaction();
    },

    processCheckoutLunas: function() {
        if (this.state.checkoutMode === 'repayment') {
            this.processRepayment();
            return;
        }
        let method = document.getElementById('checkoutMethod').value;
        if (method === 'Kasbon') {
            const customer = document.getElementById('checkoutCustomer').value.trim();
            if (customer) {
                this.processTransaction();
                return;
            } else {
                document.getElementById('checkoutMethod').value = 'Tunai';
            }
        }
        this.processTransaction();
    },

    processRepayment: function() {
        const method = document.getElementById('checkoutMethod').value;
        const cash = parseInt(document.getElementById('checkoutCash').value) || 0;
        
        if (cash <= 0) {
            Swal.fire('Gagal', 'Nominal pembayaran tidak boleh kosong atau 0!', 'warning');
            return;
        }

        const trx = this.state.transactions.find(x => x.id === this.state.repaymentTransactionId);
        if (!trx) return;

        const currentDebt = trx.remainingDebt !== undefined ? trx.remainingDebt : Math.max(0, trx.total - (trx.cash || 0));

        // Mencegah double submit
        const btnLunas = document.getElementById('btnCheckoutLunas');
        if (btnLunas && btnLunas.disabled) return;
        if (btnLunas) {
            btnLunas.disabled = true;
            btnLunas.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Memproses...';
        }

        // Hitung nominal pembayaran aktual (tidak boleh melebihi sisa hutang)
        const paymentAmount = Math.min(cash, currentDebt);
        const newDebt = currentDebt - paymentAmount;

        // Hitung kembalian tunai jika bayar tunai lebih dari sisa hutang
        const changeAmount = method === 'Tunai' ? Math.max(0, cash - currentDebt) : 0;

        // Update data transaksi lokal
        trx.cash = (trx.cash || 0) + paymentAmount;
        trx.remainingDebt = newDebt;
        trx.change = method === 'Tunai' ? changeAmount : -newDebt;
        trx.status = newDebt === 0 ? 'Lunas' : 'Belum Lunas';

        // Simpan detail pembayaran/pelunasan terakhir untuk ditampilkan di struk
        trx.lastRepaymentCash = cash;
        trx.lastRepaymentChange = changeAmount;
        trx.lastRepaymentMethod = method;

        // Catat ke syncQueue
        this.state.syncQueue.push({ 
            type: 'update_status', 
            data: { 
                id: trx.id, 
                status: trx.status,
                cash: trx.cash,
                remainingDebt: trx.remainingDebt
            } 
        });

        this.saveData();
        this.syncData();

        Swal.fire({
            title: 'Pembayaran Berhasil',
            text: newDebt === 0 
                ? 'Kasbon telah LUNAS!' 
                : `Pembayaran sebesar ${formatRupiah(paymentAmount)} dicatat. Sisa hutang: ${formatRupiah(newDebt)}`,
            icon: 'success',
            timer: 2000,
            showConfirmButton: false
        }).then(() => {
            this.showReceipt(trx);
        });
    },

    updateActiveQuickCashBtn: function(activeBtn) {
        document.querySelectorAll('.quick-cash-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        if (activeBtn) {
            activeBtn.classList.add('active');
        }
    },

    calculateChange: function() {
        const cash = parseInt(document.getElementById('checkoutCash').value) || 0;
        const method = document.getElementById('checkoutMethod').value;
        const changeEl = document.getElementById('checkoutChange');
        const changeLabelEl = changeEl.previousElementSibling; // Span berlabel "Kembalian:"
        
        if (this.state.checkoutMode === 'repayment') {
            const trx = this.state.transactions.find(x => x.id === this.state.repaymentTransactionId);
            if (!trx) return;
            const currentDebt = trx.remainingDebt !== undefined ? trx.remainingDebt : Math.max(0, trx.total - (trx.cash || 0));

            if (method === 'Tunai') {
                const diff = cash - currentDebt;
                if (diff < 0) {
                    // Masih kurang (dicicil)
                    changeEl.textContent = formatRupiah(Math.abs(diff));
                    changeEl.className = 'danger-text';
                    if (changeLabelEl) changeLabelEl.textContent = 'Sisa Hutang:';
                } else {
                    // Lunas & ada kembalian tunai
                    changeEl.textContent = formatRupiah(diff);
                    changeEl.className = 'success-text';
                    if (changeLabelEl) changeLabelEl.textContent = 'Kembalian:';
                }
            } else {
                // Transfer / QRIS (langsung dikurangi tanpa hitung kembalian fisik)
                const remaining = Math.max(0, currentDebt - cash);
                changeEl.textContent = formatRupiah(remaining);
                changeEl.className = remaining > 0 ? 'danger-text' : 'success-text';
                if (changeLabelEl) changeLabelEl.textContent = remaining > 0 ? 'Sisa Hutang:' : 'Kembalian:';
            }
            return;
        }

        if (method !== 'Tunai' && method !== 'Kasbon') {
            changeEl.textContent = 'Rp 0';
            changeEl.className = 'success-text';
            if (changeLabelEl) changeLabelEl.textContent = 'Kembalian:';
            return;
        }

        if (method === 'Kasbon') {
            const remaining = Math.max(0, this.state.tempTotal - cash);
            changeEl.textContent = formatRupiah(remaining);
            changeEl.className = remaining > 0 ? 'danger-text' : 'success-text';
            if (changeLabelEl) changeLabelEl.textContent = 'Sisa Hutang:';
        } else {
            // Tunai
            const change = cash - this.state.tempTotal;
            if (change < 0) {
                changeEl.textContent = `Uang Kurang! (${formatRupiah(change)})`;
                changeEl.className = 'danger-text';
            } else {
                changeEl.textContent = formatRupiah(change);
                changeEl.className = 'success-text';
            }
            if (changeLabelEl) changeLabelEl.textContent = 'Kembalian:';
        }
    },

    processTransaction: function() {
        const method = document.getElementById('checkoutMethod').value;
        const customer = document.getElementById('checkoutCustomer').value.trim();
        const cash = parseInt(document.getElementById('checkoutCash').value) || 0;
        
        if (this.state.tempSubtotal - this.state.tempDiscount < 0) {
            Swal.fire('Gagal', 'Total pembayaran tidak boleh bernilai minus! Silakan periksa kembali nominal diskon Anda.', 'warning');
            return;
        }
        if (method === 'Kasbon' && !customer) {
            Swal.fire('Gagal', 'Nama Pelanggan wajib diisi untuk transaksi Kasbon!', 'warning');
            return;
        }
        if (method === 'Tunai' && cash < this.state.tempTotal) {
            Swal.fire('Gagal', 'Uang tunai kurang dari total belanja!', 'warning');
            return;
        }

        // Mencegah klik ganda (race condition)
        const btnLunas = document.getElementById('btnCheckoutLunas');
        const btnKasbon = document.getElementById('btnCheckoutKasbon');
        if (btnLunas && btnLunas.disabled) return;
        if (btnLunas) { btnLunas.disabled = true; btnLunas.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Memproses...'; }
        if (btnKasbon) { btnKasbon.disabled = true; }

        const remainingDebt = method === 'Kasbon' ? Math.max(0, this.state.tempTotal - cash) : 0;
        const trx = {
            id: 'TRX-' + Date.now(),
            timestamp: new Date().toISOString(),
            customer: customer || 'Umum',
            items: [...this.state.cart],
            subtotal: this.state.tempSubtotal,
            discount: this.state.tempDiscount,
            total: this.state.tempTotal,
            method: method,
            cash: (method === 'Tunai' || method === 'Kasbon') ? cash : 0,
            change: method === 'Tunai' ? (cash - this.state.tempTotal) : (method === 'Kasbon' ? -remainingDebt : 0),
            remainingDebt: remainingDebt,
            initialDeposit: method === 'Kasbon' ? cash : 0, // Simpan DP awal secara permanen
            status: (method === 'Kasbon' && remainingDebt > 0) ? 'Belum Lunas' : 'Lunas'
        };

        // Update local stock + hitung HPP FIFO akurat langsung saat checkout (data batch masih di memori).
        // Fix #6: HPP dihitung dari harga beli batch yang benar-benar terpakai (FIFO), bukan estimasi getProductCostPrice.
        const batchDeductions = [];
        let localHPP = 0;
        trx.items.forEach(item => {
            // Total pcs = berbayar (qty) + bonus (gratis). Keduanya mengurangi stok & punya modal (HPP).
            const iq = this._itemQtys(item);
            const itemQty = iq.total;
            let remainingForHpp = itemQty; // qty yang belum tertutup oleh batch (untuk fallback modal)
            const p = findProduct(this.state.products, item.Barcode_ID, item.Nama_Camilan);
            if(p) {
                p.Stok = parseInt(p.Stok) - itemQty;
                if(p.Stok <= 0) p.Status = 'Habis';

                // Kurangi stok batch lokal secara FIFO
                if (p.batches && Array.isArray(p.batches)) {
                    let qtyToDeduct = itemQty;
                    // M3 Fix: Safe date parse with fallback
                    p.batches.sort((a, b) => {
                        const dateA = new Date(convertDateToPickerFormat(a.expiredDate));
                        const dateB = new Date(convertDateToPickerFormat(b.expiredDate));
                        return (isNaN(dateA) ? Infinity : dateA) - (isNaN(dateB) ? Infinity : dateB);
                    });
                    const itemDeductions = [];
                    for (let b = 0; b < p.batches.length; b++) {
                        if (qtyToDeduct <= 0) break;
                        const batch = p.batches[b];
                        const deduct = Math.min(qtyToDeduct, batch.stokSisa);
                        const batchCost = cleanNumber(batch.hargaBeli) || 0;
                        batch.stokSisa -= deduct;
                        qtyToDeduct -= deduct;
                        localHPP += deduct * batchCost;       // HPP dari modal batch aktual
                        remainingForHpp -= deduct;
                        itemDeductions.push({ batchId: batch.batchId, qty: deduct, hargaBeli: batchCost });
                    }
                    batchDeductions.push({ barcode: item.Barcode_ID || item.Nama_Camilan, deductions: itemDeductions });
                    // Hanya pertahankan batch yang masih memiliki stok sisa
                    p.batches = p.batches.filter(b => b.stokSisa > 0);
                }
            }
            // Sisa qty yang tak tertutup batch (produk tanpa batch / oversold) → pakai estimasi modal
            if (remainingForHpp > 0) {
                localHPP += remainingForHpp * this.getProductCostPrice(item);
            }
        });
        trx.batchDeductions = batchDeductions; // Store for rollback
        trx.hpp = localHPP;

        // --- Komisi Mitra Travel (referral) ---
        // Atribusi dari sesi rombongan terpilih, atau kode referral manual di checkout.
        const mitra = this.getCheckoutMitra();
        let komisiAmount = 0;
        if (mitra) {
            komisiAmount = Math.round((parseFloat(trx.total) || 0) * mitra.persen / 100);
            trx.mitraKode = mitra.kode;
            trx.mitraNama = mitra.nama;
            trx.mitraTier = mitra.tier;
            trx.komisiPersen = mitra.persen;
            trx.komisiAmount = komisiAmount;
            trx.sesiId = mitra.sesiId || null;
            // Catat di log komisi (sumber kebenaran Laporan Mitra, lepas dari sync server)
            this.state.komisiLog.unshift({
                id: trx.id,
                timestamp: trx.timestamp,
                mitraKode: mitra.kode,
                mitraNama: mitra.nama,
                tier: mitra.tier,
                persen: mitra.persen,
                omset: parseFloat(trx.total) || 0,
                komisi: komisiAmount,
                sesiId: mitra.sesiId || null,
                paid: false,        // default: belum ditransfer ke sopir
                paidAt: null,
                paidMethod: null
            });
        }
        // Laba bersih = omset − HPP − komisi (komisi diambil dari margin)
        trx.netProfit = (parseFloat(trx.total) || 0) - localHPP - komisiAmount;

        // Insert at beginning
        this.state.transactions.unshift(trx);
        this.state.syncQueue.push({ type: 'transaction', data: trx });
        this.state.lastTransaction = trx;
        this.saveData();

        // Kosongkan keranjang & bersihkan input pencarian
        this.state.cart = [];
        document.getElementById('discountValue').value = '';
        const manualInput = document.getElementById('manualBarcode');
        if (manualInput) manualInput.value = '';
        const suggestionsBox = document.getElementById('searchSuggestions');
        if (suggestionsBox) {
            suggestionsBox.classList.add('hidden');
            suggestionsBox.innerHTML = '';
        }
        // Reset kode referral manual (sesi rombongan tetap terbuka utk transaksi berikutnya)
        const refInput = document.getElementById('checkoutReferral');
        if (refInput) refInput.value = '';
        this.updateCartUI();
        this.renderSessionChips();

        this.showReceipt(trx);
        this.syncData();
    },

    // ==================== MITRA TRAVEL (REFERRAL & KOMISI) ====================

    tierPersen: function(tier) { return MITRA_TIERS[tier] || 0; },

    findMitra: function(kode) {
        if (!kode) return null;
        const k = kode.toString().trim().toLowerCase();
        return this.state.mitra.find(m => (m.kode || '').toLowerCase() === k) || null;
    },

    generateMitraKode: function(nama) {
        const abbr = (nama || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4) || 'MTR';
        let n = 1, kode;
        do {
            kode = 'LKT-' + abbr + '-' + String(n).padStart(2, '0');
            n++;
        } while (this.state.mitra.some(m => m.kode === kode));
        return kode;
    },

    // Helper: tanggal lokal YYYY-MM-DD dari ISO/Date
    _localYMD: function(ts) {
        const d = ts ? new Date(ts) : new Date();
        if (isNaN(d)) return '';
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${d.getFullYear()}-${mm}-${dd}`;
    },

    // ---------- Daftar & CRUD Mitra ----------
    renderMitraList: function() {
        const container = document.getElementById('mitraList');
        if (!container) return;
        const term = (document.getElementById('searchMitraInput')?.value || '').trim().toLowerCase();
        const thisMonth = this._localYMD().slice(0, 7);
        let list = this.state.mitra.slice();
        if (term) {
            list = list.filter(m =>
                (m.nama || '').toLowerCase().includes(term) ||
                (m.kode || '').toLowerCase().includes(term) ||
                (m.hp || '').toLowerCase().includes(term) ||
                (m.travel || '').toLowerCase().includes(term));
        }
        if (list.length === 0) {
            container.innerHTML = '<div class="empty-cart" style="padding:1.5rem;"><p>Belum ada mitra. Tekan "Daftar Mitra Baru".</p></div>';
            return;
        }
        container.innerHTML = '';
        list.forEach(m => {
            const persen = this.tierPersen(m.tier);
            const trxBulan = (this.state.komisiLog || []).filter(k => k.mitraKode === m.kode && (this._localYMD(k.timestamp) || '').slice(0, 7) === thisMonth).length;
            const nonaktif = m.status === 'nonaktif';
            const tierColor = m.tier === 'Premium' ? '#8b5cf6' : (m.tier === 'Aktif' ? '#0ea5e9' : '#64748b');
            const div = document.createElement('div');
            div.className = 'product-card';
            div.style.cssText = 'display:flex; justify-content:space-between; align-items:flex-start; gap:10px;' + (nonaktif ? 'opacity:0.55;' : '');
            div.innerHTML = `
                <div style="flex:1; min-width:0;">
                    <div style="font-weight:700; color:#1e293b;">${m.nama}${nonaktif ? ' <span style="font-size:0.72rem; color:#ef4444;">(nonaktif)</span>' : ''}</div>
                    <div style="font-family:monospace; font-size:0.8rem; color:#475569; margin-top:2px;">${m.kode}</div>
                    <div style="font-size:0.78rem; color:#94a3b8; margin-top:2px;">
                        <span style="background:${tierColor}; color:#fff; padding:1px 7px; border-radius:10px; font-weight:600;">${m.tier} ${persen}%</span>
                        ${m.hp ? ` · ${m.hp}` : ''}${m.travel ? ` · ${m.travel}` : ''}
                    </div>
                    <div style="font-size:0.74rem; color:#94a3b8; margin-top:3px;">${trxBulan} transaksi bulan ini</div>
                </div>
                <div style="display:flex; flex-direction:column; gap:5px;">
                    <button class="btn btn-sm btn-secondary" onclick="app.showMitraForm('${m.kode}')" style="font-size:0.75rem;"><i class="fas fa-edit"></i></button>
                    <button class="btn btn-sm ${nonaktif ? 'btn-success' : 'btn-warning'}" onclick="app.toggleMitraStatus('${m.kode}')" style="font-size:0.75rem;" title="${nonaktif ? 'Aktifkan' : 'Nonaktifkan'}"><i class="fas fa-power-off"></i></button>
                </div>`;
            container.appendChild(div);
        });
    },

    showMitraForm: function(kode) {
        const m = kode ? this.findMitra(kode) : null;
        const tierOptions = Object.keys(MITRA_TIERS).map(t =>
            `<option value="${t}" ${m && m.tier === t ? 'selected' : ''}>${t} (${MITRA_TIERS[t]}%)</option>`).join('');
        Swal.fire({
            title: m ? 'Edit Mitra' : 'Daftar Mitra Baru',
            html: `
                <div style="text-align:left; font-size:0.9rem;">
                    <label style="font-weight:600; color:#475569;">Nama Sopir/Travel *</label>
                    <input id="mf_nama" class="swal2-input" style="margin:4px 0 10px;" placeholder="Cth: Budi" value="${m ? (m.nama || '') : ''}">
                    <label style="font-weight:600; color:#475569;">No. HP</label>
                    <input id="mf_hp" class="swal2-input" style="margin:4px 0 10px;" placeholder="08xx" value="${m ? (m.hp || '') : ''}">
                    <label style="font-weight:600; color:#475569;">Nama Travel / Kendaraan</label>
                    <input id="mf_travel" class="swal2-input" style="margin:4px 0 10px;" placeholder="Cth: Trip Hotel X" value="${m ? (m.travel || '') : ''}">
                    <label style="font-weight:600; color:#475569;">Tier Komisi</label>
                    <select id="mf_tier" class="swal2-select" style="margin:4px 0; width:100%;">${tierOptions}</select>
                    ${m ? `<div style="font-family:monospace; font-size:0.8rem; color:#94a3b8; margin-top:8px;">Kode: ${m.kode}</div>` : ''}
                </div>`,
            showCancelButton: true,
            confirmButtonText: m ? 'Simpan' : 'Daftar',
            cancelButtonText: 'Batal',
            confirmButtonColor: '#10b981',
            focusConfirm: false,
            preConfirm: () => {
                const nama = document.getElementById('mf_nama').value.trim();
                if (!nama) { Swal.showValidationMessage('Nama wajib diisi'); return false; }
                return {
                    nama,
                    hp: document.getElementById('mf_hp').value.trim(),
                    travel: document.getElementById('mf_travel').value.trim(),
                    tier: document.getElementById('mf_tier').value
                };
            }
        }).then(res => {
            if (!res.isConfirmed) return;
            const d = res.value;
            if (m) {
                Object.assign(m, d);
            } else {
                this.state.mitra.push({
                    kode: this.generateMitraKode(d.nama),
                    nama: d.nama, hp: d.hp, travel: d.travel, tier: d.tier,
                    status: 'aktif', catatan: '', createdAt: new Date().toISOString()
                });
            }
            this.saveData();
            this.renderMitraList();
            Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: m ? 'Mitra diperbarui' : 'Mitra terdaftar', showConfirmButton: false, timer: 1400 });
        });
    },

    toggleMitraStatus: function(kode) {
        const m = this.findMitra(kode);
        if (!m) return;
        m.status = (m.status === 'nonaktif') ? 'aktif' : 'nonaktif';
        this.saveData();
        this.renderMitraList();
    },

    // ---------- Sesi Rombongan ----------
    openSessionPrompt: function() {
        const aktif = this.state.mitra.filter(m => m.status !== 'nonaktif');
        if (aktif.length === 0) {
            Swal.fire({
                title: 'Belum ada mitra', text: 'Daftarkan mitra travel/sopir dulu di menu Mitra Travel.',
                icon: 'info', confirmButtonText: 'Buka Mitra Travel', showCancelButton: true, cancelButtonText: 'Tutup'
            }).then(r => { if (r.isConfirmed) this.navigate('mitra'); });
            return;
        }
        const opts = aktif.map(m => `<option value="${m.kode}">${m.nama} · ${m.tier} ${this.tierPersen(m.tier)}% (${m.kode})</option>`).join('');
        Swal.fire({
            title: '🚐 Buka Rombongan',
            html: `
                <div style="text-align:left; font-size:0.9rem;">
                    <label style="font-weight:600; color:#475569;">Pilih Mitra</label>
                    <select id="ses_mitra" class="swal2-select" style="margin:4px 0 10px; width:100%;">${opts}</select>
                    <label style="font-weight:600; color:#475569;">Label Grup (opsional)</label>
                    <input id="ses_label" class="swal2-input" style="margin:4px 0 10px;" placeholder="Cth: Hotel X / Trip ABC">
                    <label style="font-weight:600; color:#475569;">Jumlah Orang (pax)</label>
                    <input id="ses_pax" type="number" min="1" class="swal2-input" style="margin:4px 0;" placeholder="Cth: 10">
                </div>`,
            showCancelButton: true, confirmButtonText: 'Buka Sesi', cancelButtonText: 'Batal',
            confirmButtonColor: '#D85A30', focusConfirm: false,
            preConfirm: () => {
                const kode = document.getElementById('ses_mitra').value;
                const m = this.findMitra(kode);
                if (!m) { Swal.showValidationMessage('Pilih mitra'); return false; }
                return { kode, label: document.getElementById('ses_label').value.trim(), pax: parseInt(document.getElementById('ses_pax').value) || 0 };
            }
        }).then(res => {
            if (!res.isConfirmed) return;
            const m = this.findMitra(res.value.kode);
            const sesiId = 'SES-' + Date.now();
            this.state.mitraSessions.unshift({
                sesiId, mitraKode: m.kode, mitraNama: m.nama, mitraTier: m.tier,
                label: res.value.label, pax: res.value.pax,
                openedAt: new Date().toISOString(), closedAt: null
            });
            this.state.activeSessionId = sesiId;
            this.saveData();
            this.renderSessionChips();
            Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: `Rombongan ${m.nama} dibuka`, showConfirmButton: false, timer: 1400 });
        });
    },

    sessionStats: function(sesiId) {
        let trxCount = 0, omset = 0, komisi = 0;
        (this.state.komisiLog || []).forEach(k => {
            if (k.sesiId === sesiId) { trxCount++; omset += cleanNumber(k.omset) || 0; komisi += cleanNumber(k.komisi) || 0; }
        });
        return { trxCount, omset, komisi };
    },

    selectSession: function(sesiId) {
        this.state.activeSessionId = (this.state.activeSessionId === sesiId) ? null : sesiId;
        this.renderSessionChips();
    },

    closeSession: function(sesiId) {
        const s = this.state.mitraSessions.find(x => x.sesiId === sesiId);
        if (!s) return;
        const st = this.sessionStats(sesiId);
        const kurang = s.pax > 0 && st.trxCount < s.pax;
        const html = `<div style="text-align:left; font-size:0.9rem;">
            <div><b>${s.mitraNama}</b>${s.label ? ' · ' + s.label : ''}</div>
            <div style="margin-top:6px;">Belanja: <b>${st.trxCount}${s.pax ? ' / ' + s.pax : ''}</b> orang</div>
            <div>Omset: <b>${formatRupiah(st.omset)}</b></div>
            <div>Komisi (${this.tierPersen(s.mitraTier)}%): <b style="color:#D85A30;">${formatRupiah(st.komisi)}</b></div>
            ${kurang ? `<div style="margin-top:8px; color:#b45309; background:#fef3c7; padding:6px 8px; border-radius:6px;">⚠️ Hanya ${st.trxCount} dari ${s.pax} orang yang belanja.</div>` : ''}
        </div>`;
        Swal.fire({
            title: 'Tutup Rombongan?', html, icon: kurang ? 'warning' : 'question',
            showCancelButton: true, confirmButtonText: 'Tutup Sesi', cancelButtonText: 'Batal', confirmButtonColor: '#D85A30'
        }).then(r => {
            if (!r.isConfirmed) return;
            s.closedAt = new Date().toISOString();
            s.finalTrxCount = st.trxCount;
            if (this.state.activeSessionId === sesiId) this.state.activeSessionId = null;
            this.saveData();
            this.renderSessionChips();
        });
    },

    renderSessionChips: function() {
        const box = document.getElementById('sessionChips');
        if (!box) return;
        const open = this.state.mitraSessions.filter(s => !s.closedAt);
        if (open.length === 0) {
            box.innerHTML = '<div style="font-size:0.78rem; color:#94a3b8; padding:2px 0;">Tidak ada rombongan aktif. Pelanggan biasa? Lewati saja.</div>';
            return;
        }
        box.innerHTML = '';
        open.forEach(s => {
            const st = this.sessionStats(s.sesiId);
            const sel = this.state.activeSessionId === s.sesiId;
            const chip = document.createElement('div');
            chip.style.cssText = `flex:1; min-width:150px; border-radius:12px; padding:8px 10px; cursor:pointer; ${sel ? 'background:#FAECE7; border:2px solid #D85A30;' : 'background:#f8fafc; border:1px solid #e2e8f0;'}`;
            chip.onclick = () => this.selectSession(s.sesiId);
            chip.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; gap:6px;">
                    <span style="font-weight:700; font-size:0.84rem; color:${sel ? '#712B13' : '#1e293b'}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">🚐 ${s.mitraNama}</span>
                    <span onclick="event.stopPropagation(); app.closeSession('${s.sesiId}')" title="Tutup sesi" style="color:#94a3b8; font-size:0.9rem; padding:0 2px;"><i class="fas fa-times-circle"></i></span>
                </div>
                <div style="font-size:0.72rem; color:${sel ? '#993C1D' : '#94a3b8'}; margin-top:1px;">${s.label ? s.label + ' · ' : ''}${s.mitraTier} ${this.tierPersen(s.mitraTier)}%</div>
                <div style="display:flex; justify-content:space-between; margin-top:4px; font-size:0.78rem; color:${sel ? '#712B13' : '#475569'};">
                    <span><i class="fas fa-users"></i> ${st.trxCount}${s.pax ? '/' + s.pax : ''}</span>
                    <span style="font-weight:600;">${formatRupiah(st.omset)}</span>
                </div>
                ${sel ? '<div style="font-size:0.68rem; color:#993C1D; margin-top:3px; text-align:center;">● transaksi ditandai ke grup ini</div>' : ''}`;
            box.appendChild(chip);
        });
    },

    // ---------- Atribusi mitra di checkout ----------
    getCheckoutMitra: function() {
        // Prioritas 1: sesi rombongan terpilih (masih terbuka)
        if (this.state.activeSessionId) {
            const s = this.state.mitraSessions.find(x => x.sesiId === this.state.activeSessionId && !x.closedAt);
            if (s) {
                const m = this.findMitra(s.mitraKode);
                const tier = m ? m.tier : s.mitraTier;
                return { kode: s.mitraKode, nama: s.mitraNama, tier, persen: this.tierPersen(tier), sesiId: s.sesiId };
            }
        }
        // Prioritas 2: kode referral manual (pelanggan lepasan 1-2 orang)
        const el = document.getElementById('checkoutReferral');
        const code = el ? el.value.trim() : '';
        if (code) {
            const m = this.findMitra(code);
            if (m && m.status !== 'nonaktif') {
                return { kode: m.kode, nama: m.nama, tier: m.tier, persen: this.tierPersen(m.tier), sesiId: null };
            }
        }
        return null;
    },

    updateCheckoutMitraInfo: function() {
        const infoEl = document.getElementById('checkoutMitraInfo');
        const refWrap = document.getElementById('checkoutReferralWrap');
        if (!infoEl) return;
        const sesiAktif = this.state.activeSessionId && this.state.mitraSessions.some(x => x.sesiId === this.state.activeSessionId && !x.closedAt);
        // Sembunyikan input manual bila sudah ada sesi terpilih
        if (refWrap) refWrap.style.display = sesiAktif ? 'none' : '';
        const mitra = this.getCheckoutMitra();
        if (!mitra) {
            infoEl.style.display = 'none';
            infoEl.innerHTML = '';
            return;
        }
        const total = this.state.tempTotal || 0;
        const komisi = Math.round(total * mitra.persen / 100);
        // Estimasi HPP keranjang utk peringatan margin
        let estHpp = 0;
        this.state.cart.forEach(it => { estHpp += this.getProductCostPrice(it) * this._itemQtys(it).total; });
        const margin = total - estHpp;
        const rugi = komisi > margin;
        infoEl.style.display = 'block';
        infoEl.innerHTML = `
            <div style="background:${rugi ? '#fef2f2' : '#faf5ff'}; border:1px solid ${rugi ? '#fecaca' : '#e9d5ff'}; border-radius:8px; padding:8px 10px; font-size:0.85rem;">
                <div style="display:flex; justify-content:space-between;">
                    <span>🚐 ${mitra.nama} <span style="color:#8b5cf6;">(${mitra.tier} ${mitra.persen}%)</span>${mitra.sesiId ? ' · sesi' : ' · manual'}</span>
                    <b style="color:#8b5cf6;">Komisi ${formatRupiah(komisi)}</b>
                </div>
                ${rugi ? `<div style="color:#b91c1c; margin-top:4px; font-size:0.78rem;">⚠️ Komisi melebihi margin (est. ${formatRupiah(margin)}) — laba transaksi ini akan minus.</div>` : ''}
            </div>`;
    },

    // ---------- Laporan Mitra ----------
    initMitraReport: function() {
        const today = this._localYMD();
        const fromEl = document.getElementById('mitraReportFrom');
        const toEl = document.getElementById('mitraReportTo');
        if (fromEl && !fromEl.value) fromEl.value = today;
        if (toEl && !toEl.value) toEl.value = today;
        this.renderMitraReport();
    },

    renderMitraReport: function() {
        const from = document.getElementById('mitraReportFrom')?.value || this._localYMD();
        const to = document.getElementById('mitraReportTo')?.value || this._localYMD();
        const rows = (this.state.komisiLog || []).filter(k => {
            const d = this._localYMD(k.timestamp);
            return d >= from && d <= to;
        });
        const summaryEl = document.getElementById('mitraReportSummary');
        const bodyEl = document.getElementById('mitraReportBody');
        if (!bodyEl) return;

        if (rows.length === 0) {
            if (summaryEl) summaryEl.innerHTML = '';
            bodyEl.innerHTML = '<div class="empty-cart" style="padding:1.5rem;"><p>Belum ada komisi pada rentang tanggal ini.</p></div>';
            return;
        }

        const byMitra = {};
        let totOmset = 0, totKomisi = 0, totBelum = 0;
        const sesiSet = {};
        rows.forEach(k => {
            if (!byMitra[k.mitraKode]) byMitra[k.mitraKode] = { nama: k.mitraNama, tier: k.tier, trx: 0, omset: 0, komisi: 0, belum: 0, sesi: new Set() };
            const g = byMitra[k.mitraKode];
            g.trx++; g.omset += cleanNumber(k.omset) || 0; g.komisi += cleanNumber(k.komisi) || 0;
            if (!k.paid) g.belum += cleanNumber(k.komisi) || 0;
            if (k.sesiId) g.sesi.add(k.sesiId);
            totOmset += cleanNumber(k.omset) || 0; totKomisi += cleanNumber(k.komisi) || 0;
            if (!k.paid) totBelum += cleanNumber(k.komisi) || 0;
        });

        if (summaryEl) {
            summaryEl.innerHTML = `
                <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px;">
                    <div style="flex:1; min-width:110px; background:#f0fdf4; border-radius:10px; padding:10px;"><div style="font-size:0.72rem; color:#16a34a;">Omset Referral</div><div style="font-weight:700; color:#15803d;">${formatRupiah(totOmset)}</div></div>
                    <div style="flex:1; min-width:110px; background:#faf5ff; border-radius:10px; padding:10px;"><div style="font-size:0.72rem; color:#9333ea;">Total Komisi</div><div style="font-weight:700; color:#7e22ce;">${formatRupiah(totKomisi)}</div></div>
                    <div style="flex:1; min-width:110px; background:#fef2f2; border-radius:10px; padding:10px;"><div style="font-size:0.72rem; color:#dc2626;">Belum Ditransfer</div><div style="font-weight:700; color:#b91c1c;">${formatRupiah(totBelum)}</div></div>
                </div>`;
        }

        bodyEl.innerHTML = '';
        Object.keys(byMitra).forEach(kode => {
            const g = byMitra[kode];
            const div = document.createElement('div');
            div.className = 'product-card';
            div.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px;">
                    <div style="flex:1;">
                        <div style="font-weight:700; color:#1e293b;">${g.nama} <span style="font-size:0.72rem; color:#8b5cf6;">${g.tier} ${this.tierPersen(g.tier)}%</span></div>
                        <div style="font-size:0.78rem; color:#94a3b8; margin-top:2px;">${g.trx} transaksi · ${g.sesi.size} rombongan · omset ${formatRupiah(g.omset)}</div>
                        <div style="font-size:0.9rem; margin-top:4px;">Komisi: <b style="color:#8b5cf6;">${formatRupiah(g.komisi)}</b>${g.belum > 0 ? ` · <span style="color:#dc2626;">belum ${formatRupiah(g.belum)}</span>` : ' · <span style="color:#16a34a;">lunas</span>'}</div>
                    </div>
                    ${g.belum > 0 ? `<button class="btn btn-sm btn-success" style="font-size:0.75rem; white-space:nowrap;" onclick="app.markMitraTransferred('${kode}')"><i class="fas fa-check"></i> Tandai Transfer</button>` : ''}
                </div>`;
            bodyEl.appendChild(div);
        });
    },

    markMitraTransferred: function(kode) {
        const from = document.getElementById('mitraReportFrom')?.value || this._localYMD();
        const to = document.getElementById('mitraReportTo')?.value || this._localYMD();
        const m = this.findMitra(kode);
        const nama = m ? m.nama : kode;
        let total = 0, count = 0;
        (this.state.komisiLog || []).forEach(k => {
            const d = this._localYMD(k.timestamp);
            if (k.mitraKode === kode && !k.paid && d >= from && d <= to) { total += cleanNumber(k.komisi) || 0; count++; }
        });
        if (count === 0) return;
        Swal.fire({
            title: 'Tandai Sudah Ditransfer?',
            html: `<div style="font-size:0.9rem;">Komisi <b>${nama}</b><br>${count} transaksi = <b style="color:#8b5cf6;">${formatRupiah(total)}</b></div>`,
            icon: 'question', showCancelButton: true, confirmButtonText: 'Sudah Ditransfer', cancelButtonText: 'Batal', confirmButtonColor: '#10b981'
        }).then(r => {
            if (!r.isConfirmed) return;
            const now = new Date().toISOString();
            (this.state.komisiLog || []).forEach(k => {
                const d = this._localYMD(k.timestamp);
                if (k.mitraKode === kode && !k.paid && d >= from && d <= to) { k.paid = true; k.paidAt = now; k.paidMethod = 'Transfer'; }
            });
            this.saveData();
            this.renderMitraReport();
            Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: `Komisi ${nama} ditandai transfer`, showConfirmButton: false, timer: 1500 });
        });
    },

    showReceipt: function(trx) {
        this.navigate('receipt');
        this.state.lastTransaction = trx; // untuk keperluan print
        const rc = document.getElementById('receiptContent');
        const settings = this.state.settings || { shopName: 'Kasir Manis', shopLogo: '🏪', cashierName: 'Admin' };
        
        let headerHtml = '';
        if (settings.shopLogo && settings.shopLogo.startsWith('data:image')) {
            headerHtml += `<img src="${settings.shopLogo}" style="max-height: 60px; max-width: 120px; display: block; margin: 0 auto 8px; object-fit: contain;">`;
        } else {
            headerHtml += `<div style="font-size: 2rem; text-align: center; margin-bottom: 5px;">🏪</div>`;
        }
        
        headerHtml += `<h2 style="font-size: 1.4rem; font-weight: bold; text-align: center; margin: 0 0 4px 0; color: var(--dark);">${settings.shopName || 'ARUMMANIS'}</h2>`;
        
        if (settings.shopAddress) {
            headerHtml += `<div style="text-align: center; font-size: 0.85rem; color: #64748b; margin-bottom: 2px; line-height: 1.2;">${settings.shopAddress}</div>`;
        }
        if (settings.shopPhone) {
            headerHtml += `<div style="text-align: center; font-size: 0.85rem; color: #64748b; margin-bottom: 8px; line-height: 1.2;">Telp: ${settings.shopPhone}</div>`;
        }
        
        let html = `
            ${headerHtml}
            <div class="r-row"><span>No:</span> <span>${trx.id}</span></div>
            <div class="r-row"><span>Tgl:</span> <span>${(app._parseTransactionDate(trx.timestamp) || new Date(trx.timestamp)).toLocaleString('id-ID')}</span></div>
            <div class="r-row"><span>Kasir:</span> <span>${settings.cashierName || 'Admin'}</span></div>
            <div class="r-row"><span>Pelanggan:</span> <span>${trx.customer}</span></div>
            <hr>
        `;
        
        if (trx.items && trx.items.length > 0) {
            trx.items.forEach(i => {
                const iq = this._itemQtys(i);
                html += `<div>${i.Nama_Camilan}</div>`;
                if (iq.paid > 0) {
                    html += `<div class="r-row"><span>${iq.paid} x ${formatRupiah(iq.unit)}</span> <span>${formatRupiah(iq.lineRevenue)}</span></div>`;
                }
                if (iq.bonus > 0) {
                    html += `<div class="r-row"><span style="color:#8b5cf6;">🎁 Bonus ${iq.bonus} pcs</span> <span style="color:#8b5cf6; font-weight:bold;">GRATIS</span></div>`;
                }
            });
        } else {
            html += `<div style="text-align: center; color: #999; margin: 10px 0;">Tidak ada detail item (Hanya nominal transaksi)</div>`;
        }
        
        html += `<hr>
            <div class="r-row"><span>Subtotal:</span> <span>${formatRupiah(trx.subtotal)}</span></div>
            <div class="r-row"><span>Diskon:</span> <span>- ${formatRupiah(trx.discount)}</span></div>
            <div class="r-row"><strong>TOTAL:</strong> <strong>${formatRupiah(trx.total)}</strong></div>
            <hr>
            <div class="r-row"><span>Pembayaran:</span> <span>${trx.method}</span></div>
        `;
        
        if (trx.method === 'Tunai') {
            html += `<div class="r-row"><span>Tunai:</span> <span>${formatRupiah(trx.cash)}</span></div>
                     <div class="r-row"><span>Kembali:</span> <span>${formatRupiah(trx.change)}</span></div>`;
        } else if (trx.method === 'Transfer' || trx.method === 'QRIS') {
            // H3 Fix: Show payment info for Transfer/QRIS
            html += `<div class="r-row"><span>Total Dibayar:</span> <span>${formatRupiah(trx.total)}</span></div>`;
        } else if (trx.method === 'Kasbon') {
            const initDP = trx.initialDeposit || 0;
            const totalPaid = trx.cash || 0;
            const subsequentPay = totalPaid - initDP;
            const debt = trx.remainingDebt !== undefined ? trx.remainingDebt : Math.max(0, trx.total - totalPaid);
            
            html += `<div class="r-row"><span>Uang Muka (DP):</span> <span>${formatRupiah(initDP)}</span></div>`;
            if (subsequentPay > 0) {
                html += `<div class="r-row"><span>Pelunasan/Cicil:</span> <span>${formatRupiah(subsequentPay)}</span></div>`;
                html += `<div class="r-row"><span>Total Terbayar:</span> <span>${formatRupiah(totalPaid)}</span></div>`;
            }
            html += `
                <div class="r-row"><span>Sisa Hutang:</span> <span class="${debt > 0 ? 'danger-text' : 'success-text'}" style="font-weight:bold;">${formatRupiah(debt)}</span></div>
                <div class="r-row"><strong>STATUS:</strong> <strong class="${debt === 0 ? 'success-text' : 'danger-text'}">${debt === 0 ? 'LUNAS' : 'BELUM LUNAS'}</strong></div>
            `;

            // Tambahkan rincian pembayaran kasbon hari ini jika ada pelunasan
            if (trx.lastRepaymentCash !== undefined) {
                html += `<hr>`;
                html += `<div style="text-align: center; font-weight: bold; margin-bottom: 5px; font-size: 0.9rem; color: var(--dark);">Pembayaran Pelunasan Hari Ini:</div>`;
                html += `<div class="r-row"><span>Metode:</span> <span>${trx.lastRepaymentMethod}</span></div>`;
                if (trx.lastRepaymentMethod === 'Tunai') {
                    html += `<div class="r-row"><span>Uang Bayar:</span> <span>${formatRupiah(trx.lastRepaymentCash)}</span></div>`;
                    html += `<div class="r-row"><span>Kembalian:</span> <span>${formatRupiah(trx.lastRepaymentChange)}</span></div>`;
                } else {
                    html += `<div class="r-row"><span>Uang Bayar:</span> <span>${formatRupiah(trx.lastRepaymentCash)}</span></div>`;
                }
            }
        }
        
        html += `<hr><div class="text-center">
            <strong>${settings.receiptFooter || 'Terima Kasih!'}</strong>
        </div>`;
        rc.innerHTML = html;
    },

    newTransaction: function() {
        this.state.cart = [];
        document.getElementById('discountValue').value = '';
        const manualInput = document.getElementById('manualBarcode');
        if (manualInput) manualInput.value = '';
        const suggestionsBox = document.getElementById('searchSuggestions');
        if (suggestionsBox) {
            suggestionsBox.classList.add('hidden');
            suggestionsBox.innerHTML = '';
        }
        this.updateCartUI();
        this.navigate('pos');
    },

    editLastTransaction: function() {
        if(!this.state.lastTransaction) return;
        const trx = this.state.lastTransaction;
        
        Swal.fire({
            title: 'Edit Ulang Transaksi Ini?',
            text: 'Ini akan membatalkan transaksi sebelumnya, mengembalikan stok, dan memuat kembali semua barang ke keranjang kasir untuk ditambahkan/diubah. Lanjutkan?',
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'Ya, Edit Ulang',
            cancelButtonText: 'Batal'
        }).then((res) => {
            if(res.isConfirmed) {
                // 1. Kembalikan stok produk lokal (berbayar + bonus)
                trx.items.forEach(item => {
                    const p = findProduct(this.state.products, item.Barcode_ID, item.Nama_Camilan);
                    if(p) {
                        p.Stok = parseInt(p.Stok) + this._itemQtys(item).total;
                        if(p.Status === 'Habis') p.Status = 'Ready';
                    }
                });
                
                // 2. Restore batch deductions
                if (trx.batchDeductions && Array.isArray(trx.batchDeductions)) {
                    trx.batchDeductions.forEach(bd => {
                        const p = findProduct(this.state.products, bd.barcode, bd.barcode);
                        if (p && p.batches && Array.isArray(p.batches)) {
                            bd.deductions.forEach(d => {
                                const batch = p.batches.find(b => b.batchId === d.batchId);
                                if (batch) {
                                    batch.stokSisa += d.qty;
                                } else {
                                    p.batches.push({ batchId: d.batchId, stokSisa: d.qty, expiredDate: '', hargaBeli: 0 });
                                }
                            });
                        }
                    });
                }
                
                // 3. Hapus dari riwayat lokal
                this.state.transactions = this.state.transactions.filter(t => t.id !== trx.id);
                
                // 4. Penanganan Sinkronisasi Server (Google Sheets)
                const pendingIdx = this.state.syncQueue.findIndex(q => q.type === 'transaction' && q.data.id === trx.id);
                if (pendingIdx > -1) {
                    // Jika masih ada di antrean sync (belum terkirim), hapus dari syncQueue
                    this.state.syncQueue.splice(pendingIdx, 1);
                } else {
                    // Jika sudah telanjur tersimpan di Google Sheets, kirim perintah hapus transaksi ke server
                    this.state.syncQueue.push({
                        type: 'delete_transaction',
                        data: { id: trx.id, batchDeductions: trx.batchDeductions }
                    });
                }
                
                // 5. Pindahkan item kembali ke keranjang kasir
                this.state.cart = [...trx.items];
                this.saveData();
                this.syncData();
                this.navigate('pos');

                Swal.fire({
                    toast: true,
                    position: 'top-end',
                    icon: 'success',
                    title: 'Transaksi dimuat ulang ke keranjang',
                    showConfirmButton: false,
                    timer: 2000
                });
            }
        });
    },

    // ===== LAPORAN KEUANGAN & PENJUALAN =====
    _reportState: {
        period: 'daily',
        salesChart: null,
        paymentChart: null,
        currentRankTab: 'terlaris',
        cachedTransactions: [],
        cachedPrevTransactions: []
    },

    initReports: function() {
        // Set default date to today
        const today = new Date();
        const dateInput = document.getElementById('reportDate');
        if (dateInput) dateInput.value = today.toISOString().split('T')[0];

        const fromInput = document.getElementById('reportDateFrom');
        const toInput = document.getElementById('reportDateTo');
        if (fromInput) fromInput.value = today.toISOString().split('T')[0];
        if (toInput) toInput.value = today.toISOString().split('T')[0];

        this._reportState.period = 'daily';
        this._reportState.currentRankTab = 'terlaris';

        // Activate default period button
        document.querySelectorAll('.report-period-btn').forEach(btn => btn.classList.remove('active'));
        const defaultBtn = document.querySelector('.report-period-btn[data-period="daily"]');
        if (defaultBtn) defaultBtn.classList.add('active');

        this.updateDatePickerVisibility();
        this.renderReports();
    },

    changeReportPeriod: function(period) {
        this._reportState.period = period;
        document.querySelectorAll('.report-period-btn').forEach(btn => btn.classList.remove('active'));
        const activeBtn = document.querySelector(`.report-period-btn[data-period="${period}"]`);
        if (activeBtn) activeBtn.classList.add('active');
        this.updateDatePickerVisibility();

        // Auto-set default date saat pindah tab agar tidak kosong
        const dateInput = document.getElementById('reportDate');
        const today = new Date();
        if (period === 'daily') {
            dateInput.value = today.toISOString().split('T')[0];
        } else if (period === 'weekly') {
            // Default 7 hari ke belakang (misal 11/08 s/d 17/08)
            const toDate = new Date(today);
            const fromDate = new Date(today);
            fromDate.setDate(today.getDate() - 6);
            
            const toVal = toDate.getFullYear() + '-' + String(toDate.getMonth() + 1).padStart(2, '0') + '-' + String(toDate.getDate()).padStart(2, '0');
            const fromVal = fromDate.getFullYear() + '-' + String(fromDate.getMonth() + 1).padStart(2, '0') + '-' + String(fromDate.getDate()).padStart(2, '0');
            
            const fromInput = document.getElementById('reportWeeklyFrom');
            const toInput = document.getElementById('reportWeeklyTo');
            if (fromInput) fromInput.value = fromVal;
            if (toInput) toInput.value = toVal;
            this.updateWeeklyBadgeLabel(fromVal, toVal);
        } else if (period === 'monthly') {
            dateInput.value = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0');
        } else if (period === 'yearly') {
            dateInput.value = today.getFullYear();
        }

        this.renderReports();
    },

    handleWeeklyFromChange: function(fromVal) {
        if (!fromVal) return;
        const parts = fromVal.split('-');
        if (parts.length !== 3) return;
        const fromDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        const toDate = new Date(fromDate);
        toDate.setDate(fromDate.getDate() + 6);
        
        const toVal = toDate.getFullYear() + '-' + String(toDate.getMonth() + 1).padStart(2, '0') + '-' + String(toDate.getDate()).padStart(2, '0');
        const toInput = document.getElementById('reportWeeklyTo');
        if (toInput) toInput.value = toVal;
        
        this.updateWeeklyBadgeLabel(fromVal, toVal);
        this.renderReports();
    },

    handleWeeklyToChange: function(toVal) {
        if (!toVal) return;
        const parts = toVal.split('-');
        if (parts.length !== 3) return;
        const toDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        const fromDate = new Date(toDate);
        fromDate.setDate(toDate.getDate() - 6);
        
        const fromVal = fromDate.getFullYear() + '-' + String(fromDate.getMonth() + 1).padStart(2, '0') + '-' + String(fromDate.getDate()).padStart(2, '0');
        const fromInput = document.getElementById('reportWeeklyFrom');
        if (fromInput) fromInput.value = fromVal;
        
        this.updateWeeklyBadgeLabel(fromVal, toVal);
        this.renderReports();
    },

    updateWeeklyBadgeLabel: function(fromVal, toVal) {
        const badge = document.getElementById('weeklyRangeLabel');
        if (!badge || !fromVal || !toVal) return;
        const p1 = fromVal.split('-');
        const p2 = toVal.split('-');
        const d1 = new Date(parseInt(p1[0]), parseInt(p1[1]) - 1, parseInt(p1[2]));
        const d2 = new Date(parseInt(p2[0]), parseInt(p2[1]) - 1, parseInt(p2[2]));
        const fmt1 = d1.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
        const fmt2 = d2.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
        badge.textContent = `Periode 7 Hari Terkunci: ${fmt1} s/d ${fmt2}`;
    },

    updateDatePickerVisibility: function() {
        const period = this._reportState.period;
        const singlePicker = document.getElementById('reportDatePicker');
        const weeklyRange = document.getElementById('reportWeeklyRange');
        const customRange = document.getElementById('reportCustomRange');
        const dateInput = document.getElementById('reportDate');

        if (period === 'custom') {
            singlePicker.classList.add('hidden');
            if (weeklyRange) weeklyRange.classList.add('hidden');
            customRange.classList.remove('hidden');
        } else if (period === 'weekly') {
            singlePicker.classList.add('hidden');
            customRange.classList.add('hidden');
            if (weeklyRange) weeklyRange.classList.remove('hidden');
        } else {
            if (weeklyRange) weeklyRange.classList.add('hidden');
            customRange.classList.add('hidden');
            singlePicker.classList.remove('hidden');

            if (period === 'daily') {
                dateInput.type = 'date';
                singlePicker.querySelector('label').textContent = 'Tanggal:';
            } else if (period === 'monthly') {
                dateInput.type = 'month';
                singlePicker.querySelector('label').textContent = 'Bulan:';
            } else if (period === 'yearly') {
                dateInput.type = 'number';
                dateInput.min = '2020';
                dateInput.max = '2099';
                dateInput.value = new Date().getFullYear();
                singlePicker.querySelector('label').textContent = 'Tahun:';
            }
        }
    },

    getFilteredTransactions: function(period, refDate) {
        const transactions = this.state.transactions || [];
        if (!transactions.length) return [];

        let startDate, endDate;

        if (period === 'daily') {
            startDate = new Date(refDate);
            startDate.setHours(0, 0, 0, 0);
            endDate = new Date(refDate);
            endDate.setHours(23, 59, 59, 999);
        } else if (period === 'weekly') {
            if (refDate && refDate.from && refDate.to) {
                const p1 = refDate.from.split('-');
                const p2 = refDate.to.split('-');
                startDate = new Date(parseInt(p1[0]), parseInt(p1[1]) - 1, parseInt(p1[2]), 0, 0, 0, 0);
                endDate = new Date(parseInt(p2[0]), parseInt(p2[1]) - 1, parseInt(p2[2]), 23, 59, 59, 999);
            } else {
                startDate = new Date(refDate);
                startDate.setHours(0, 0, 0, 0);
                endDate = new Date(startDate);
                endDate.setDate(startDate.getDate() + 6);
                endDate.setHours(23, 59, 59, 999);
            }
        } else if (period === 'monthly') {
            startDate = new Date(refDate.getFullYear(), refDate.getMonth(), 1, 0, 0, 0, 0);
            endDate = new Date(refDate.getFullYear(), refDate.getMonth() + 1, 0, 23, 59, 59, 999);
        } else if (period === 'yearly') {
            startDate = new Date(refDate.getFullYear(), 0, 1, 0, 0, 0, 0);
            endDate = new Date(refDate.getFullYear(), 11, 31, 23, 59, 59, 999);
        } else if (period === 'custom') {
            startDate = new Date(refDate.from);
            startDate.setHours(0, 0, 0, 0);
            endDate = new Date(refDate.to);
            endDate.setHours(23, 59, 59, 999);
        }

        return transactions.filter(trx => {
            const trxDate = this._parseTransactionDate(trx.timestamp);
            if (!trxDate || isNaN(trxDate.getTime())) return false;
            return trxDate >= startDate && trxDate <= endDate;
        });
    },

    // Smart parser: menangani format ISO (lokal) DAN DD/MM/YYYY HH:MM:SS (dari Google Sheets)
    _parseTransactionDate: function(timestamp) {
        if (!timestamp) return null;
        // Jika sudah Date object
        if (timestamp instanceof Date) return timestamp;
        const str = timestamp.toString().trim();
        // Coba parse ISO format dulu (2026-08-17T09:00:00.000Z)
        const isoDate = new Date(str);
        if (!isNaN(isoDate.getTime()) && str.includes('-') && (str.includes('T') || str.length === 10)) {
            return isoDate;
        }
        // Parse DD/MM/YYYY atau DD/MM/YYYY HH:MM:SS (format Google Sheets Indonesia)
        const match = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
        if (match) {
            const day = parseInt(match[1]);
            const month = parseInt(match[2]) - 1;
            const year = parseInt(match[3]);
            const hour = parseInt(match[4]) || 0;
            const min = parseInt(match[5]) || 0;
            const sec = parseInt(match[6]) || 0;
            return new Date(year, month, day, hour, min, sec);
        }
        // Fallback: coba parse langsung
        const fallback = new Date(str);
        return isNaN(fallback.getTime()) ? null : fallback;
    },

    getPreviousPeriodDate: function(period, refDate) {
        if (period === 'daily') {
            const prev = new Date(refDate);
            prev.setDate(prev.getDate() - 1);
            return prev;
        } else if (period === 'weekly') {
            if (refDate && refDate.from && refDate.to) {
                const p1 = refDate.from.split('-');
                const p2 = refDate.to.split('-');
                const prevFromDate = new Date(parseInt(p1[0]), parseInt(p1[1]) - 1, parseInt(p1[2]) - 7);
                const prevToDate = new Date(parseInt(p2[0]), parseInt(p2[1]) - 1, parseInt(p2[2]) - 7);
                const prevFrom = prevFromDate.getFullYear() + '-' + String(prevFromDate.getMonth() + 1).padStart(2, '0') + '-' + String(prevFromDate.getDate()).padStart(2, '0');
                const prevTo = prevToDate.getFullYear() + '-' + String(prevToDate.getMonth() + 1).padStart(2, '0') + '-' + String(prevToDate.getDate()).padStart(2, '0');
                return { from: prevFrom, to: prevTo };
            }
            const prev = new Date(refDate);
            prev.setDate(prev.getDate() - 7);
            return prev;
        } else if (period === 'monthly') {
            return new Date(refDate.getFullYear(), refDate.getMonth() - 1, 1);
        } else if (period === 'yearly') {
            return new Date(refDate.getFullYear() - 1, 0, 1);
        }
        return null;
    },

    getRefDateFromInputs: function() {
        const period = this._reportState.period;
        const dateInput = document.getElementById('reportDate');

        if (period === 'custom') {
            return {
                from: document.getElementById('reportDateFrom').value,
                to: document.getElementById('reportDateTo').value
            };
        } else if (period === 'weekly') {
            const fromVal = document.getElementById('reportWeeklyFrom')?.value;
            const toVal = document.getElementById('reportWeeklyTo')?.value;
            return { from: fromVal, to: toVal };
        } else if (period === 'yearly') {
            const year = parseInt(dateInput.value) || new Date().getFullYear();
            return new Date(year, 0, 1);
        } else if (period === 'monthly') {
            // dateInput.value = "2026-08" → parse as local date
            const parts = dateInput.value.split('-');
            if (parts.length >= 2) {
                return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, 1);
            }
            return new Date();
        } else {
            // daily
            const parts = dateInput.value.split('-');
            if (parts.length === 3) {
                return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
            }
            return new Date();
        }
    },

    // Normalisasi qty berbayar & bonus per item. Kompatibel dengan format lama (isBonus = seluruh baris gratis).
    // Mengembalikan: paid (dibayar), bonus (gratis), total (stok terpakai), unit (harga satuan), lineRevenue (paid*unit)
    _itemQtys: function(item) {
        if (!item) return { paid: 0, bonus: 0, total: 0, unit: 0, lineRevenue: 0 };
        let paid = parseInt(item.qty) || 0;
        let bonus = parseInt(item.bonusQty) || 0;
        // Format lama: isBonus true tanpa bonusQty berarti SELURUH qty adalah bonus gratis
        if (item.isBonus && (item.bonusQty === undefined || item.bonusQty === null)) {
            bonus = paid;
            paid = 0;
        }
        // Harga satuan: pakai editPrice bila terdefinisi; fallback originalPrice (item bonus lama) lalu Harga
        let unit;
        if (item.editPrice !== undefined && item.editPrice !== null && item.editPrice !== '') {
            unit = cleanNumber(item.editPrice);
        } else {
            unit = cleanNumber(item.Harga) || 0;
        }
        if (unit === 0 && item.isBonus && item.originalPrice !== undefined) {
            unit = cleanNumber(item.originalPrice);
        }
        return { paid: paid, bonus: bonus, total: paid + bonus, unit: unit, lineRevenue: paid * unit };
    },

    getProductCostPrice: function(item) {
        if (!item) return 0;
        const p = findProduct(this.state.products, item.Barcode_ID, item.Nama_Camilan);
        let costPrice = 0;
        
        if (p) {
            // 1. Cek Harga_Modal atau Harga_Beli di objek produk
            costPrice = cleanNumber(p.Harga_Modal) || cleanNumber(p.Harga_Beli) || 0;
            
            // 2. Jika 0, cek dari rincian batch produk di StokBatch
            if (costPrice === 0 && p.batches && Array.isArray(p.batches) && p.batches.length > 0) {
                const validBatch = p.batches.find(b => cleanNumber(b.hargaBeli) > 0);
                if (validBatch) {
                    costPrice = cleanNumber(validBatch.hargaBeli);
                }
            }
        }
        
        // 3. Jika masih 0, cek dari item transaksi langsung
        if (costPrice === 0) {
            costPrice = cleanNumber(item.Harga_Beli) || cleanNumber(item.Harga_Modal) || 0;
        }
        
        // 4. Default Fallback Cerdas:
        // Jika produk sama sekali belum pernah diinput harga modalnya (0),
        // gunakan estimasi modal wajar (80% dari harga normal produk atau harga jual)
        // agar tidak menyebabkan margin 100% atau laba Rp 0 palsu
        if (costPrice === 0) {
            const basePrice = (p ? cleanNumber(p.Harga) : 0) || cleanNumber(item.Harga) || cleanNumber(item.editPrice) || 0;
            if (basePrice > 0) {
                costPrice = Math.floor(basePrice * 0.8);
            }
        }
        
        return costPrice;
    },

    calculateMetrics: function(transactions) {
        let omset = 0, laba = 0, totalItems = 0, totalDiskon = 0, totalKomisi = 0;
        const trxCount = transactions.length;

        // Peta komisi per transaksi (dari komisiLog) agar laba otomatis dikurangi komisi mitra
        const komisiMap = {};
        (this.state.komisiLog || []).forEach(k => { komisiMap[k.id] = (komisiMap[k.id] || 0) + (cleanNumber(k.komisi) || 0); });

        transactions.forEach(trx => {
            const trxKomisi = komisiMap[trx.id] || (cleanNumber(trx.komisiAmount) || 0);
            totalKomisi += trxKomisi;
            const trxTotal = cleanNumber(trx.total) || 0;
            const trxDisc = cleanNumber(trx.discount) || 0;
            omset += trxTotal;
            totalDiskon += trxDisc;

            // Hitung total item (berbayar + bonus, karena keduanya barang yang keluar)
            if (trx.items && Array.isArray(trx.items)) {
                trx.items.forEach(item => {
                    totalItems += this._itemQtys(item).total;
                });
            }

            // Fix #2: Prioritaskan HPP FIFO akurat yang tersimpan (dari server saat transaksi / recalculate_profits).
            // HPP tersimpan (> 0) menandakan modal riil telah tercatat; ini juga otomatis mengikuti revisi harga modal
            // setelah server melakukan recalculate. Estimasi hanya dipakai bila benar-benar tidak ada data modal.
            const storedHpp = cleanNumber(trx.hpp);
            const hasStoredHpp = trx.hpp !== undefined && trx.hpp !== null && trx.hpp !== '' && !isNaN(storedHpp) && storedHpp > 0;

            if (hasStoredHpp) {
                // Sumber utama: HPP FIFO akurat dari server. Laba = Omset - HPP (boleh nol/negatif, apa adanya).
                laba += (trxTotal - storedHpp);
            } else {
                // Tidak ada HPP tersimpan (mis. transaksi offline belum tersinkron) → hitung ulang dari rincian item
                let trxHpp = 0;
                let hasItemCosts = false;
                if (trx.items && Array.isArray(trx.items) && trx.items.length > 0) {
                    trx.items.forEach(item => {
                        const totalPcs = this._itemQtys(item).total; // modal dihitung utk berbayar + bonus
                        const costPrice = this.getProductCostPrice(item);
                        if (costPrice > 0) hasItemCosts = true;
                        trxHpp += costPrice * totalPcs;
                    });
                }
                if (hasItemCosts && trxHpp > 0) {
                    laba += (trxTotal - trxHpp);
                } else {
                    // Fallback terakhir: estimasi 20% margin jika benar-benar tanpa data modal apa pun
                    laba += Math.floor(trxTotal * 0.2);
                }
            }
        });

        // Komisi mitra mengurangi laba bersih (diambil dari margin)
        laba -= totalKomisi;

        const avg = trxCount > 0 ? omset / trxCount : 0;

        return { omset, laba, trxCount, totalItems, totalDiskon, totalKomisi, avg };
    },

    formatRupiah: function(num) {
        if (isNaN(num) || num === null || num === undefined) return 'Rp 0';
        const abs = Math.abs(Math.round(num));
        const formatted = abs.toLocaleString('id-ID');
        return (num < 0 ? '-Rp ' : 'Rp ') + formatted;
    },

    calculateTrend: function(current, previous) {
        if (previous === 0 && current === 0) return { pct: 0, dir: 'neutral' };
        if (previous === 0) return { pct: 100, dir: 'up' };
        const pct = ((current - previous) / Math.abs(previous)) * 100;
        const rounded = Math.round(pct * 10) / 10;
        if (rounded > 0) return { pct: rounded, dir: 'up' };
        if (rounded < 0) return { pct: Math.abs(rounded), dir: 'down' };
        return { pct: 0, dir: 'neutral' };
    },

    renderTrendBadge: function(elementId, trend) {
        const el = document.getElementById(elementId);
        if (!el) return;
        if (trend.dir === 'up') {
            el.className = 'metric-trend trend-up';
            el.innerHTML = `<i class="fas fa-arrow-up"></i> ${trend.pct}%`;
        } else if (trend.dir === 'down') {
            el.className = 'metric-trend trend-down';
            el.innerHTML = `<i class="fas fa-arrow-down"></i> ${trend.pct}%`;
        } else {
            el.className = 'metric-trend trend-neutral';
            el.innerHTML = `— 0%`;
        }
    },

    renderReports: function() {
        const period = this._reportState.period;
        const refDate = this.getRefDateFromInputs();

        // Validate inputs — 'weekly' & 'custom' memakai objek {from,to}, sisanya memakai Date
        if (period === 'custom' || period === 'weekly') {
            if (!refDate || !refDate.from || !refDate.to) return;
        } else {
            if (!refDate || !(refDate instanceof Date) || isNaN(refDate.getTime())) return;
        }

        // Get filtered transactions
        const filtered = this.getFilteredTransactions(period, refDate);
        this._reportState.cachedTransactions = filtered;

        // Get previous period transactions for comparison
        let prevFiltered = [];
        if (period !== 'custom') {
            const prevDate = this.getPreviousPeriodDate(period, refDate);
            if (prevDate) {
                prevFiltered = this.getFilteredTransactions(period, prevDate);
            }
        }
        this._reportState.cachedPrevTransactions = prevFiltered;

        // Calculate metrics
        const metrics = this.calculateMetrics(filtered);
        const prevMetrics = this.calculateMetrics(prevFiltered);

        // Update metric cards
        document.getElementById('metricOmset').textContent = this.formatRupiah(metrics.omset);
        document.getElementById('metricLaba').textContent = this.formatRupiah(metrics.laba);
        document.getElementById('metricTrx').textContent = metrics.trxCount.toLocaleString('id-ID');
        document.getElementById('metricItem').textContent = metrics.totalItems.toLocaleString('id-ID');
        document.getElementById('metricDiskon').textContent = this.formatRupiah(metrics.totalDiskon);
        document.getElementById('metricAvg').textContent = this.formatRupiah(metrics.avg);

        // Update trend badges
        this.renderTrendBadge('trendOmset', this.calculateTrend(metrics.omset, prevMetrics.omset));
        this.renderTrendBadge('trendLaba', this.calculateTrend(metrics.laba, prevMetrics.laba));
        this.renderTrendBadge('trendTrx', this.calculateTrend(metrics.trxCount, prevMetrics.trxCount));
        this.renderTrendBadge('trendItem', this.calculateTrend(metrics.totalItems, prevMetrics.totalItems));
        this.renderTrendBadge('trendDiskon', this.calculateTrend(metrics.totalDiskon, prevMetrics.totalDiskon));
        this.renderTrendBadge('trendAvg', this.calculateTrend(metrics.avg, prevMetrics.avg));

        // Render charts
        this.renderSalesChart(filtered, period, refDate);
        this.renderPaymentChart(filtered);

        // Render product ranking
        this.renderProductRankTable(filtered, this._reportState.currentRankTab);
    },

    getTopProducts: function(transactions, sortBy) {
        const productMap = {};

        transactions.forEach(trx => {
            if (!trx.items || !Array.isArray(trx.items)) return;

            trx.items.forEach(item => {
                const name = item.Nama_Camilan || 'Unknown';
                const iq = this._itemQtys(item); // paid, bonus, total, unit
                if (iq.total <= 0) return;

                const costPrice = this.getProductCostPrice(item);
                const revenue = iq.lineRevenue;                 // hanya qty berbayar × harga
                const profit = revenue - (costPrice * iq.total); // modal semua pcs (termasuk bonus) mengurangi laba

                if (!productMap[name]) {
                    productMap[name] = { name, totalQty: 0, totalRevenue: 0, totalProfit: 0 };
                }
                productMap[name].totalQty += iq.total;          // pcs terjual = berbayar + bonus
                productMap[name].totalRevenue += revenue;
                productMap[name].totalProfit += profit;
            });
        });

        const products = Object.values(productMap);

        if (sortBy === 'terlaris') {
            products.sort((a, b) => b.totalQty - a.totalQty);
        } else {
            products.sort((a, b) => b.totalProfit - a.totalProfit);
        }

        return products.slice(0, 10);
    },

    renderSalesChart: function(transactions, period, refDate) {
        const canvas = document.getElementById('salesTrendChart');
        if (!canvas) return;

        // Destroy previous chart
        if (this._reportState.salesChart) {
            this._reportState.salesChart.destroy();
            this._reportState.salesChart = null;
        }

        // Build labels and data based on period granularity
        let labels = [];
        let dataMap = {};

        if (period === 'daily') {
            // Hourly breakdown for daily
            for (let h = 0; h < 24; h++) {
                const label = String(h).padStart(2, '0') + ':00';
                labels.push(label);
                dataMap[label] = 0;
            }
            transactions.forEach(trx => {
                const d = this._parseTransactionDate(trx.timestamp);
                if (!d || isNaN(d.getTime())) return;
                const key = String(d.getHours()).padStart(2, '0') + ':00';
                if (dataMap.hasOwnProperty(key)) dataMap[key] += (cleanNumber(trx.total) || 0);
            });
        } else if (period === 'weekly') {
            const dayNames = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
            let startDate;
            if (refDate && refDate.from) {
                const p1 = refDate.from.split('-');
                startDate = new Date(parseInt(p1[0]), parseInt(p1[1]) - 1, parseInt(p1[2]));
            } else {
                startDate = new Date(refDate);
            }

            for (let i = 0; i < 7; i++) {
                const current = new Date(startDate);
                current.setDate(startDate.getDate() + i);
                const dateKey = current.getFullYear() + '-' + String(current.getMonth() + 1).padStart(2, '0') + '-' + String(current.getDate()).padStart(2, '0');
                const dayLabel = `${dayNames[current.getDay()]} (${current.getDate()}/${current.getMonth() + 1})`;
                labels.push(dayLabel);
                dataMap[dateKey] = 0;
            }
            const dateKeys = Object.keys(dataMap);
            transactions.forEach(trx => {
                const parsed = app._parseTransactionDate(trx.timestamp);
                if (parsed) {
                    const trxDateKey = parsed.getFullYear() + '-' + String(parsed.getMonth() + 1).padStart(2, '0') + '-' + String(parsed.getDate()).padStart(2, '0');
                    if (dataMap.hasOwnProperty(trxDateKey)) {
                        dataMap[trxDateKey] += (cleanNumber(trx.total) || 0);
                    }
                }
            });
            // Convert to array by order
            const dataValues = dateKeys.map(k => dataMap[k]);
            dataMap = {};
            labels.forEach((l, i) => { dataMap[l] = dataValues[i]; });
        } else if (period === 'monthly') {
            const year = refDate.getFullYear();
            const month = refDate.getMonth();
            const daysInMonth = new Date(year, month + 1, 0).getDate();
            for (let d = 1; d <= daysInMonth; d++) {
                const label = String(d);
                labels.push(label);
                const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                dataMap[dateStr] = 0;
            }
            transactions.forEach(trx => {
                const d = this._parseTransactionDate(trx.timestamp);
                if (!d || isNaN(d.getTime())) return;
                const trxDate = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
                if (dataMap.hasOwnProperty(trxDate)) {
                    dataMap[trxDate] += (cleanNumber(trx.total) || 0);
                }
            });
            const dateKeys = Object.keys(dataMap);
            const dataValues = dateKeys.map(k => dataMap[k]);
            dataMap = {};
            labels.forEach((l, i) => { dataMap[l] = dataValues[i]; });
        } else if (period === 'yearly') {
            const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
            labels = [...monthNames];
            monthNames.forEach(m => { dataMap[m] = 0; });
            transactions.forEach(trx => {
                const d = this._parseTransactionDate(trx.timestamp);
                if (!d || isNaN(d.getTime())) return;
                const key = monthNames[d.getMonth()];
                if (dataMap.hasOwnProperty(key)) dataMap[key] += (cleanNumber(trx.total) || 0);
            });
        } else if (period === 'custom') {
            // Group by date — parse & format sebagai tanggal LOKAL agar tidak bergeser sehari (bug UTC toISOString)
            const fp = (refDate.from || '').split('-');
            const tp = (refDate.to || '').split('-');
            const from = new Date(parseInt(fp[0]), parseInt(fp[1]) - 1, parseInt(fp[2]));
            const to = new Date(parseInt(tp[0]), parseInt(tp[1]) - 1, parseInt(tp[2]));
            const localKey = (dt) => dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
            const diffDays = Math.ceil((to - from) / (1000 * 60 * 60 * 24)) + 1;
            for (let i = 0; i < diffDays && i < 90; i++) {
                const current = new Date(from);
                current.setDate(from.getDate() + i);
                const dateStr = localKey(current);
                const label = current.getDate() + '/' + (current.getMonth() + 1);
                labels.push(label);
                dataMap[dateStr] = 0;
            }
            transactions.forEach(trx => {
                const d = this._parseTransactionDate(trx.timestamp);
                if (!d || isNaN(d.getTime())) return;
                const trxDate = localKey(d);
                if (dataMap.hasOwnProperty(trxDate)) {
                    dataMap[trxDate] += (cleanNumber(trx.total) || 0);
                }
            });
            const dateKeys = Object.keys(dataMap);
            const dataValues = dateKeys.map(k => dataMap[k]);
            dataMap = {};
            labels.forEach((l, i) => { dataMap[l] = dataValues[i]; });
        }

        const data = labels.map(l => dataMap[l] || 0);

        this._reportState.salesChart = new Chart(canvas, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Omset (Rp)',
                    data: data,
                    borderColor: '#FF6B6B',
                    backgroundColor: 'rgba(255, 107, 107, 0.1)',
                    borderWidth: 2.5,
                    fill: true,
                    tension: 0.35,
                    pointRadius: data.length > 31 ? 0 : 3,
                    pointBackgroundColor: '#FF6B6B',
                    pointHoverRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: function(ctx) {
                                return 'Rp ' + (ctx.raw || 0).toLocaleString('id-ID');
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: { font: { size: 10, family: 'Outfit' }, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }
                    },
                    y: {
                        grid: { color: 'rgba(0,0,0,0.05)' },
                        ticks: {
                            font: { size: 10, family: 'Outfit' },
                            callback: function(val) {
                                if (val >= 1000000) return (val / 1000000).toFixed(1) + 'jt';
                                if (val >= 1000) return (val / 1000).toFixed(0) + 'rb';
                                return val;
                            }
                        },
                        beginAtZero: true
                    }
                }
            }
        });
    },

    renderPaymentChart: function(transactions) {
        const canvas = document.getElementById('paymentMethodChart');
        if (!canvas) return;

        if (this._reportState.paymentChart) {
            this._reportState.paymentChart.destroy();
            this._reportState.paymentChart = null;
        }

        const methodMap = { 'Tunai': 0, 'Transfer': 0, 'QRIS': 0, 'Kasbon': 0 };
        transactions.forEach(trx => {
            const method = trx.method || 'Tunai';
            if (methodMap.hasOwnProperty(method)) {
                methodMap[method] += (parseFloat(trx.total) || 0);
            } else {
                methodMap[method] = (methodMap[method] || 0) + (parseFloat(trx.total) || 0);
            }
        });

        const labels = Object.keys(methodMap).filter(k => methodMap[k] > 0);
        const data = labels.map(k => methodMap[k]);
        const colors = {
            'Tunai': '#2ECC71',
            'Transfer': '#3498DB',
            'QRIS': '#9B59B6',
            'Kasbon': '#F39C12'
        };
        const bgColors = labels.map(l => colors[l] || '#95a5a6');

        if (data.length === 0) {
            labels.push('Belum ada data');
            data.push(1);
            bgColors.push('#e2e8f0');
        }

        this._reportState.paymentChart = new Chart(canvas, {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    data: data,
                    backgroundColor: bgColors,
                    borderWidth: 2,
                    borderColor: '#fff',
                    hoverOffset: 8
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { font: { size: 11, family: 'Outfit' }, padding: 12, usePointStyle: true, pointStyle: 'circle' }
                    },
                    tooltip: {
                        callbacks: {
                            label: function(ctx) {
                                const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                                const pct = total > 0 ? ((ctx.raw / total) * 100).toFixed(1) : 0;
                                return ctx.label + ': Rp ' + ctx.raw.toLocaleString('id-ID') + ' (' + pct + '%)';
                            }
                        }
                    }
                },
                cutout: '60%'
            }
        });
    },

    switchProductRankTab: function(tab) {
        this._reportState.currentRankTab = tab;
        const tabs = document.querySelectorAll('#productRankTabs .report-tab-btn');
        tabs.forEach(t => t.classList.remove('active'));
        if (tab === 'terlaris') {
            tabs[0].classList.add('active');
        } else {
            tabs[1].classList.add('active');
        }
        const trxs = (this._reportState.cachedTransactions && this._reportState.cachedTransactions.length > 0) 
            ? this._reportState.cachedTransactions 
            : this.getFilteredTransactions(this._reportState.period, this.getRefDateFromInputs());
        this.renderProductRankTable(trxs, tab);
    },

    renderProductRankTable: function(transactions, sortBy) {
        const tbody = document.getElementById('productRankBody');
        if (!tbody) return;

        const top = this.getTopProducts(transactions, sortBy);
        if (top.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: #94a3b8; padding: 20px;"><i class="fas fa-box-open" style="font-size: 1.5rem; display: block; margin-bottom: 8px; opacity: 0.4;"></i>Belum ada data penjualan</td></tr>';
            return;
        }

        // Update header based on tab
        const headerRow = tbody.closest('table').querySelector('thead tr');
        if (sortBy === 'terlaris') {
            headerRow.innerHTML = '<th>#</th><th>Produk</th><th>Qty</th><th>Omset</th>';
        } else {
            headerRow.innerHTML = '<th>#</th><th>Produk</th><th>Qty</th><th>Laba</th>';
        }

        tbody.innerHTML = top.map((p, i) => {
            let rankBadge;
            if (i === 0) rankBadge = '<span class="rank-badge gold">1</span>';
            else if (i === 1) rankBadge = '<span class="rank-badge silver">2</span>';
            else if (i === 2) rankBadge = '<span class="rank-badge bronze">3</span>';
            else rankBadge = `<span style="font-weight: 700; color: #94a3b8;">${i + 1}</span>`;

            const valueCol = sortBy === 'terlaris'
                ? this.formatRupiah(p.totalRevenue)
                : this.formatRupiah(p.totalProfit);

            return `<tr>
                <td>${rankBadge}</td>
                <td style="font-weight: 500;">${p.name}</td>
                <td>${p.totalQty}</td>
                <td>${valueCol}</td>
            </tr>`;
        }).join('');
    },

    shareReportWhatsApp: function() {
        const period = this._reportState.period;
        const filtered = this._reportState.cachedTransactions || [];
        const metrics = this.calculateMetrics(filtered);
        const top5 = this.getTopProducts(filtered, 'terlaris').slice(0, 5);

        const settings = this.state.settings || {};
        const shopName = settings.shopName || 'Kasir Manis';

        // Build period label
        let periodLabel = '';
        const dateInput = document.getElementById('reportDate');
        if (period === 'daily') {
            const d = new Date(dateInput.value);
            periodLabel = 'Harian — ' + d.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        } else if (period === 'weekly') {
            const from = document.getElementById('reportWeeklyFrom')?.value || '';
            const to = document.getElementById('reportWeeklyTo')?.value || '';
            periodLabel = `Mingguan (7 Hari) — ${from} s/d ${to}`;
        } else if (period === 'monthly') {
            const parts = dateInput.value.split('-');
            const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1);
            periodLabel = 'Bulanan — ' + d.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
        } else if (period === 'yearly') {
            periodLabel = 'Tahunan — ' + dateInput.value;
        } else if (period === 'custom') {
            const from = document.getElementById('reportDateFrom').value;
            const to = document.getElementById('reportDateTo').value;
            periodLabel = 'Kustom — ' + from + ' s/d ' + to;
        }

        let text = `📊 *LAPORAN ${shopName.toUpperCase()}*\n`;
        text += `📅 ${periodLabel}\n`;
        text += `━━━━━━━━━━━━━━━━━━\n`;
        text += `💰 OMSET: ${this.formatRupiah(metrics.omset)}\n`;
        text += `📈 LABA: ${this.formatRupiah(metrics.laba)}\n`;
        text += `🧾 Transaksi: ${metrics.trxCount}\n`;
        text += `📦 Item Terjual: ${metrics.totalItems}\n`;
        text += `🏷️ Total Diskon: ${this.formatRupiah(metrics.totalDiskon)}\n`;
        text += `💵 Rata-Rata/Trx: ${this.formatRupiah(metrics.avg)}\n`;
        text += `━━━━━━━━━━━━━━━━━━\n`;

        if (top5.length > 0) {
            text += `🏆 *TOP 5 PRODUK TERLARIS:*\n`;
            top5.forEach((p, i) => {
                text += `${i + 1}. ${p.name} (${p.totalQty} pcs) — ${this.formatRupiah(p.totalRevenue)}\n`;
            });
        }

        text += `\n_Dikirim via ${shopName} POS_`;

        const encoded = encodeURIComponent(text);
        window.open(`https://wa.me/?text=${encoded}`, '_blank');
    },

    // --- History & Debt ---
    renderTransactionList: function(filter, containerId, searchId) {
        // Default container IDs untuk backward compatibility
        const cId = containerId || 'transactionListContainer';
        const sId = searchId || 'searchTransaction';
        const container = document.getElementById(cId);
        if (!container) return;
        container.innerHTML = '';
        
        const searchEl = document.getElementById(sId);
        const term = searchEl ? searchEl.value.toLowerCase() : '';
        
        let filtered = this.state.transactions.filter(t => {
            if (filter === 'Kasbon' && t.status !== 'Belum Lunas') return false;
            if (term && !t.id.toLowerCase().includes(term) && !t.customer.toLowerCase().includes(term)) return false;
            return true;
        });

        if(filtered.length === 0) {
            container.innerHTML = `<div class="text-center mt-1">${filter === 'Kasbon' ? 'Tidak ada kasbon aktif.' : 'Tidak ada transaksi ditemukan.'}</div>`;
            return;
        }

        filtered.forEach(t => {
            const div = document.createElement('div');
            div.className = 'list-item';
            div.innerHTML = `
                <div class="list-item-header">
                    <strong>${t.id}</strong>
                    <span class="status-badge ${t.status === 'Lunas' ? 'bg-success' : 'bg-warning'}">${t.status}</span>
                </div>
                <div>Pelanggan: ${t.customer}</div>
                <div>Metode: ${t.method}</div>
                <div>Total: <strong>${formatRupiah(t.total)}</strong></div>
                <div class="action-buttons mt-1">
                    <button onclick="app.showReceipt(app.state.transactions.find(x=>x.id==='${t.id}'))" class="btn btn-sm btn-secondary">Lihat Struk</button>
                    ${t.status === 'Belum Lunas' ? `<button onclick="app.markAsPaid('${t.id}')" class="btn btn-sm btn-success">Lunasi</button>` : ''}
                </div>
            `;
            container.appendChild(div);
        });
        
        // Setup filter typing listener
        if (searchEl) searchEl.oninput = () => this.renderTransactionList(filter, cId, sId);
    },

    markAsPaid: function(id) {
        this.prepareRepayment(id);
    },

    // --- Product Management ---
    renderProductList: function() {
        const container = document.getElementById('productManageList');
        container.innerHTML = '';
        const term = document.getElementById('searchProductInput').value.toLowerCase();
        
        this.state.products.forEach((p, idx) => {
            // Filter pencarian
            const barcodeStr = (p.Barcode_ID || '').toLowerCase();
            const nameStr = (p.Nama_Camilan || '').toLowerCase();
            if (term && !barcodeStr.includes(term) && !nameStr.includes(term)) return;

            const div = document.createElement('div');
            div.className = 'list-item';
            div.innerHTML = `
                <div class="list-item-header">
                    <strong>${p.Nama_Camilan || '(Tanpa Nama)'}</strong>
                    <span class="status-badge ${p.Barcode_ID ? 'bg-success' : 'bg-warning'}">${p.Barcode_ID ? 'Barcode: ✓' : 'Belum Ada Barcode'}</span>
                </div>
                <div>Barcode: ${p.Barcode_ID || '<i style="color:#999">— kosong —</i>'}</div>
                <div>Harga Jual: ${formatRupiah(p.Harga)}${p.Harga_Modal ? ' | Modal: ' + formatRupiah(p.Harga_Modal) : ''}</div>
                <div class="action-buttons mt-1">
                    <button onclick="app.showProductForm(${idx})" class="btn btn-sm btn-warning"><i class="fas fa-edit"></i> Edit</button>
                    <button onclick="app.deleteProduct(${idx})" class="btn btn-sm btn-danger"><i class="fas fa-trash"></i> Hapus</button>
                </div>
            `;
            container.appendChild(div);
        });
        
        if (container.innerHTML === '') {
            container.innerHTML = `<div class="text-center mt-1">Produk tidak ditemukan.</div>`;
        }
        
        document.getElementById('searchProductInput').oninput = () => this.renderProductList();
    },

    showProductForm: function(indexOrNull) {
        document.getElementById('productFormOverlay').classList.remove('hidden');
        const batchFields = document.getElementById('prodFormBatchFields');
        const regBatches = document.getElementById('prodFormRegisteredBatches');
        const stockInput = document.getElementById('prodFormStock');
        
        if (indexOrNull !== null && indexOrNull !== undefined && typeof indexOrNull === 'number') {
            const p = this.state.products[indexOrNull];
            if (!p) return;
            document.getElementById('productFormTitle').textContent = 'Edit Produk';
            document.getElementById('prodFormId').value = indexOrNull; // Simpan INDEX, bukan barcode
            document.getElementById('prodFormBarcode').value = p.Barcode_ID || '';
            document.getElementById('prodFormName').value = p.Nama_Camilan || '';
            document.getElementById('prodFormPrice').value = p.Harga || '';
            
            // Kunci total stok karena dihitung otomatis dari batch
            stockInput.value = p.Stok || 0;
            stockInput.disabled = true;
            stockInput.title = "Stok total dihitung otomatis dari rincian batch";
            
            // Sembunyikan input batch awal (hanya untuk produk baru)
            batchFields.classList.add('hidden');
            
            // Tampilkan rincian batch terdaftar
            regBatches.classList.remove('hidden');
            
            let batchesHtml = '';
            if (p.batches && p.batches.length > 0) {
                // Urutkan berdasarkan Tanggal Expired (FIFO)
                const sortedBatches = [...p.batches].sort((a, b) => new Date(convertDateToPickerFormat(a.expiredDate)) - new Date(convertDateToPickerFormat(b.expiredDate)));
                sortedBatches.forEach((b, idx) => {
                    batchesHtml += `
                        <div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 10px; border-radius: 8px; font-size: 0.9rem; margin-bottom: 8px;">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                                <strong style="color: var(--primary);">Batch ${idx + 1}</strong>
                                <span style="font-size: 0.8rem; color: #64748b;">Exp: ${b.expiredDate || '—'}</span>
                            </div>
                            <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                                <div style="display: flex; align-items: center; gap: 4px;">
                                    <label style="font-size: 0.85rem; white-space: nowrap;">Stok:</label>
                                    <input type="number" class="input-sm batch-stok-input" data-batch-id="${b.batchId}" value="${b.stokSisa}" min="0" style="width: 65px; text-align: center;" onchange="app.recalcBatchTotal()">
                                    <span style="font-size: 0.8rem; color: #64748b;">pcs</span>
                                </div>
                                <div style="display: flex; align-items: center; gap: 4px;">
                                    <label style="font-size: 0.85rem; white-space: nowrap;">Modal: Rp</label>
                                    <input type="number" class="input-sm batch-modal-input" data-batch-id="${b.batchId}" value="${b.hargaBeli || 0}" min="0" style="width: 85px; text-align: right;">
                                </div>
                            </div>
                        </div>
                    `;
                });
            } else {
                batchesHtml = '<div style="color: #94a3b8; font-size: 0.85rem; font-style: italic; text-align: center;">Tidak ada batch aktif (Stok 0)</div>';
            }
            document.getElementById('prodFormBatchesList').innerHTML = batchesHtml;
        } else {
            document.getElementById('productFormTitle').textContent = 'Tambah Produk';
            document.getElementById('prodFormId').value = '';
            document.getElementById('prodFormBarcode').value = '';
            document.getElementById('prodFormName').value = '';
            document.getElementById('prodFormPrice').value = '';
            
            stockInput.value = '';
            stockInput.disabled = false;
            stockInput.title = "";
            
            batchFields.classList.remove('hidden');
            document.getElementById('prodFormPriceBuy').value = '';
            document.getElementById('prodFormExpired').value = '';
            
            // Sembunyikan rincian batch terdaftar
            regBatches.classList.add('hidden');
            document.getElementById('prodFormBatchesList').innerHTML = '';
        }
    },
    showRestockForm: function() {
        document.getElementById('restockProductSearch').value = '';
        document.getElementById('restockQty').value = '';
        document.getElementById('restockPriceBuy').value = '';
        document.getElementById('restockExpired').value = '';
        document.getElementById('restockSelectedBarcode').value = '';
        document.getElementById('restockSelectedProductName').value = '';
        document.getElementById('restockSelectedName').textContent = '—';
        document.getElementById('restockSelectedCurrentStock').textContent = '—';
        document.getElementById('restockSelectedDetails').classList.add('hidden');
        document.getElementById('restockFormOverlay').classList.remove('hidden');
    },

    closeRestockForm: function() {
        this.stopRestockScanner();
        document.getElementById('restockFormOverlay').classList.add('hidden');
    },

    selectRestockProduct: function(product) {
        document.getElementById('restockSelectedBarcode').value = product.Barcode_ID || '';
        document.getElementById('restockSelectedProductName').value = product.Nama_Camilan || '';
        document.getElementById('restockSelectedName').textContent = product.Nama_Camilan || '—';
        document.getElementById('restockSelectedCurrentStock').textContent = `${product.Stok || 0} pcs`;
        
        // Prefill modal / harga beli untuk menghemat waktu input
        document.getElementById('restockPriceBuy').value = product.Harga_Beli || product.Harga_Modal || '';
        document.getElementById('restockSelectedDetails').classList.remove('hidden');
    },

    saveRestock: function() {
        const barcode = document.getElementById('restockSelectedBarcode').value.trim();
        const productName = document.getElementById('restockSelectedProductName').value.trim();
        const qty = parseInt(document.getElementById('restockQty').value) || 0;
        const priceBuy = parseInt(document.getElementById('restockPriceBuy').value) || 0;
        const expiredRaw = document.getElementById('restockExpired').value;
        const expired = convertDateToSheetFormat(expiredRaw);

        if (!barcode && !productName) return Swal.fire('Error', 'Silakan pilih produk terlebih dahulu!', 'warning');
        if (qty <= 0) return Swal.fire('Error', 'Jumlah stok masuk harus lebih dari 0!', 'warning');
        if (priceBuy <= 0) return Swal.fire('Error', 'Harga beli modal harus lebih dari 0!', 'warning');

        // Cari produk lokal untuk diupdate
        const p = this.state.products.find(x => {
            if (barcode) {
                return x.Barcode_ID && compareBarcode(x.Barcode_ID, barcode);
            }
            return x.Nama_Camilan === productName;
        });

        if (p) {
            p.Stok = (parseInt(p.Stok) || 0) + qty;
            p.Status = 'Ready';
            // Update harga beli default di data produk jika harga belinya berubah
            p.Harga_Beli = priceBuy;
            p.Harga_Modal = priceBuy;

            // Tambahkan ke rincian batch lokal
            if (!p.batches) p.batches = [];
            p.batches.push({
                batchId: 'B-' + Date.now(),
                stokSisa: qty,
                expiredDate: expired || convertDateToSheetFormat(new Date(Date.now() + 365*24*60*60*1000).toISOString().split('T')[0]),
                hargaBeli: priceBuy
            });
        }

        const restockData = {
            id: 'RESTOCK-' + Date.now(),
            Barcode_ID: barcode,
            Nama_Camilan: p ? p.Nama_Camilan : productName,
            qty: qty,
            priceBuy: priceBuy,
            expired: expired
        };

        // Antrekan sinkronisasi ke sheet StokBatch
        this.state.syncQueue.push({ type: 'restock', data: restockData });
        
        this.saveData();
        this.closeRestockForm();
        this.renderProductList();
        this.syncData();
        Swal.fire('Berhasil', 'Stok baru berhasil ditambahkan!', 'success');
    },

    startRestockScanner: function() {
        const reader = document.getElementById('restockScannerReader');
        const btn = document.getElementById('scanRestockBarcodeBtn');
        
        if (!reader.classList.contains('hidden')) {
            this.stopRestockScanner();
            return;
        }
        
        reader.classList.remove('hidden');
        this.state.restockScanner = new Html5Qrcode("restockScannerReader");
        
        const readerWidth = reader.clientWidth || 300;
        const boxSize = Math.floor(Math.min(readerWidth * 0.8, 280));
        const config = { 
            fps: 15, 
            qrbox: { width: boxSize, height: boxSize }
        };
        
        const onScanSuccess = (text) => {
            if (!text) return;
            const cleanText = text.trim().replace(/[\r\n\t]/g, '');
            playBeep();
            if ("vibrate" in navigator) navigator.vibrate([100, 50, 100]);
            
            // Cari produk berdasarkan barcode yang discan
            const product = this.state.products.find(x => compareBarcode(x.Barcode_ID, cleanText));
            if (product) {
                this.selectRestockProduct(product);
                Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: `Produk: ${product.Nama_Camilan}`, showConfirmButton: false, timer: 1500 });
            } else {
                Swal.fire('Gagal', `Barcode "${cleanText}" belum terdaftar! Silakan daftarkan produk baru terlebih dahulu.`, 'warning');
            }
            this.stopRestockScanner();
        };
        
        this.state.restockScanner.start({ facingMode: "environment" }, config, onScanSuccess, (err) => {})
        .then(() => {
            btn.classList.replace('btn-secondary', 'btn-danger');
            btn.innerHTML = '<i class="fas fa-times"></i>';
        }).catch(err => {
            // Fallback kamera depan
            this.state.restockScanner.start({ facingMode: "user" }, config, onScanSuccess, (err) => {})
            .then(() => {
                btn.classList.replace('btn-secondary', 'btn-danger');
                btn.innerHTML = '<i class="fas fa-times"></i>';
            }).catch(e => {
                Swal.fire('Error', 'Gagal menyalakan kamera.', 'error');
                reader.classList.add('hidden');
            });
        });
    },

    stopRestockScanner: function() {
        const btn = document.getElementById('scanRestockBarcodeBtn');
        if(this.state.restockScanner) {
            this.state.restockScanner.stop().then(() => {
                document.getElementById('restockScannerReader').classList.add('hidden');
                btn.classList.replace('btn-danger', 'btn-secondary');
                btn.innerHTML = '<i class="fas fa-camera"></i>';
                this.state.restockScanner = null;
            }).catch(() => {
                document.getElementById('restockScannerReader').classList.add('hidden');
                btn.classList.replace('btn-danger', 'btn-secondary');
                btn.innerHTML = '<i class="fas fa-camera"></i>';
                this.state.restockScanner = null;
            });
        }
    },

    setQuickExpired: function(inputId, monthsToAdd) {
        const today = new Date();
        today.setMonth(today.getMonth() + monthsToAdd);
        
        const year = today.getFullYear();
        const month = String(today.getMonth() + 1).padStart(2, '0');
        const day = String(today.getDate()).padStart(2, '0');
        
        document.getElementById(inputId).value = `${year}-${month}-${day}`;
    },

    closeProductForm: function() {
        this.stopProductScanner();
        document.getElementById('productFormOverlay').classList.add('hidden');
    },
    recalcBatchTotal: function() {
        const inputs = document.querySelectorAll('.batch-stok-input');
        let total = 0;
        inputs.forEach(inp => {
            total += Math.max(0, parseInt(inp.value) || 0);
        });
        const stockInput = document.getElementById('prodFormStock');
        if (stockInput) stockInput.value = total;
    },

    saveProduct: function() {
        const editIndex = document.getElementById('prodFormId').value;
        const isEdit = editIndex !== '' && editIndex !== null && editIndex !== undefined;
        const newBarcode = document.getElementById('prodFormBarcode').value.trim();
        const name = document.getElementById('prodFormName').value.trim();
        const price = parseInt(document.getElementById('prodFormPrice').value) || 0;
        let stock = parseInt(document.getElementById('prodFormStock').value) || 0;
        
        const priceBuy = parseInt(document.getElementById('prodFormPriceBuy').value) || 0;
        const expiredRaw = document.getElementById('prodFormExpired').value;
        const expired = convertDateToSheetFormat(expiredRaw);
        
        if(!name) return Swal.fire('Error', 'Nama Produk wajib diisi!', 'error');
        // M1 Fix: Validate non-negative price and stock
        if(price < 0) return Swal.fire('Error', 'Harga jual tidak boleh negatif!', 'error');
        if(stock < 0) return Swal.fire('Error', 'Stok tidak boleh negatif!', 'error');
        if(priceBuy < 0) return Swal.fire('Error', 'Harga beli tidak boleh negatif!', 'error');

        const product = { 
            Barcode_ID: newBarcode, 
            Nama_Camilan: name, 
            Harga: price, 
            Stok: stock, 
            Status: stock > 0 ? 'Ready' : 'Habis',
            Harga_Beli: priceBuy,
            Harga_Modal: priceBuy,
            Tanggal_Expired: expired,
            batches: stock > 0 ? [{
                batchId: 'B-' + Date.now(),
                stokSisa: stock,
                expiredDate: expired || convertDateToSheetFormat(new Date(Date.now() + 365*24*60*60*1000).toISOString().split('T')[0]),
                hargaBeli: priceBuy
            }] : []
        };

        if (isEdit) {
            const idx = parseInt(editIndex);
            const oldProduct = this.state.products[idx];
            if (!oldProduct) return;
            
            // Cek duplikat barcode jika barcode baru diisi dan berbeda dari yang lama
            if (newBarcode && oldProduct.Barcode_ID !== newBarcode) {
                const duplicate = this.state.products.find((x, i) => i !== idx && x.Barcode_ID && compareBarcode(x.Barcode_ID, newBarcode));
                if (duplicate) {
                    return Swal.fire('Error', 'Barcode sudah dipakai produk lain!', 'error');
                }
            }
            
            // Update stok & modal batch jika ada input editable batch
            const batchInputs = document.querySelectorAll('.batch-stok-input');
            const modalInputs = document.querySelectorAll('.batch-modal-input');
            let updatedBatches = oldProduct.batches ? [...oldProduct.batches] : [];
            
            if (batchInputs.length > 0) {
                let calcStock = 0;
                batchInputs.forEach(inp => {
                    const bId = inp.dataset.batchId;
                    const val = Math.max(0, parseInt(inp.value) || 0);
                    const bObj = updatedBatches.find(b => b.batchId === bId);
                    if (bObj) {
                        bObj.stokSisa = val;
                    }
                    calcStock += val;
                });
                stock = calcStock;
            }

            if (modalInputs.length > 0) {
                modalInputs.forEach(inp => {
                    const bId = inp.dataset.batchId;
                    const val = Math.max(0, parseInt(inp.value) || 0);
                    const bObj = updatedBatches.find(b => b.batchId === bId);
                    if (bObj) {
                        bObj.hargaBeli = val;
                    }
                });
            }
            
            // Pertahankan _sheetRow
            product._sheetRow = oldProduct._sheetRow;
            product.batches = updatedBatches;
            product.Stok = stock;
            product.Status = stock > 0 ? 'Ready' : 'Habis';
            
            this.state.products[idx] = product;
            
            this.state.syncQueue.push({ 
                type: 'product', 
                data: { ...product, oldBarcode: oldProduct.Barcode_ID || '' } 
            });

            // Antrekan sync pembaruan batch (stok & harga modal) ke StokBatch jika ada batch
            if (updatedBatches.length > 0) {
                this.state.syncQueue.push({
                    type: 'update_batch',
                    data: { Barcode_ID: product.Barcode_ID, batches: updatedBatches }
                });
            }
        } else {
            // Produk baru — cek duplikat barcode jika diisi
            if (newBarcode && this.state.products.find(x => x.Barcode_ID && compareBarcode(x.Barcode_ID, newBarcode))) {
                return Swal.fire('Error', 'Barcode sudah ada!', 'error');
            }
            this.state.products.push(product);
            this.state.syncQueue.push({ type: 'product', data: { ...product, oldBarcode: '' } });
        }

        this.saveData();
        this.updateProductDatalist();
        this.closeProductForm();
        this.renderProductList();
        this.syncData();
        Swal.fire('Berhasil', 'Produk tersimpan', 'success');
    },
    deleteProduct: function(index) {
        const p = this.state.products[index];
        if (!p) return;
        Swal.fire({
            title: 'Hapus Produk?', text: `Hapus "${p.Nama_Camilan}" dari sistem?`, icon: 'warning', showCancelButton: true
        }).then(res => {
            if(res.isConfirmed) {
                this.state.products.splice(index, 1);
                // H4 Fix: Always sync deletion, use name as fallback identifier
                this.state.syncQueue.push({ type: 'delete_product', data: { Barcode_ID: p.Barcode_ID || '', Nama_Camilan: p.Nama_Camilan, _sheetRow: p._sheetRow } });
                this.saveData();
                this.updateProductDatalist();
                this.renderProductList();
                this.syncData();
            }
        });
    },

    startProductScanner: function() {
        const reader = document.getElementById('productScannerReader');
        const btn = document.getElementById('scanProductBarcodeBtn');
        
        if (!reader.classList.contains('hidden')) {
            this.stopProductScanner();
            return;
        }
        
        reader.classList.remove('hidden');
        this.state.productScanner = new Html5Qrcode("productScannerReader");
        
        const readerWidth = reader.clientWidth || 300;
        const boxSize = Math.floor(Math.min(readerWidth * 0.8, 280));
        const config = { 
            fps: 15, 
            qrbox: { width: boxSize, height: boxSize }
        };
        
        const onScanSuccess = (text) => {
            if (!text) return;
            const cleanText = text.trim().replace(/[\r\n\t]/g, '');
            playBeep();
            if ("vibrate" in navigator) navigator.vibrate([100, 50, 100]);
            document.getElementById('prodFormBarcode').value = cleanText;
            this.stopProductScanner();
            Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: `Barcode: ${cleanText}`, showConfirmButton: false, timer: 1500 });
        };
        
        // Coba kamera belakang dahulu
        this.state.productScanner.start({ facingMode: "environment" }, config, onScanSuccess, (err) => {})
        .then(() => {
            btn.classList.replace('btn-secondary', 'btn-danger');
            btn.innerHTML = '<i class="fas fa-times"></i>';
        }).catch(err => {
            // Fallback kamera depan
            this.state.productScanner.start({ facingMode: "user" }, config, onScanSuccess, (err) => {})
            .then(() => {
                btn.classList.replace('btn-secondary', 'btn-danger');
                btn.innerHTML = '<i class="fas fa-times"></i>';
            }).catch(e => {
                Swal.fire('Error', 'Gagal menyalakan kamera.', 'error');
                reader.classList.add('hidden');
            });
        });
    },

    stopProductScanner: function() {
        if(this.state.productScanner) {
            this.state.productScanner.stop().then(() => {
                document.getElementById('productScannerReader').classList.add('hidden');
                const btn = document.getElementById('scanProductBarcodeBtn');
                btn.classList.replace('btn-danger', 'btn-secondary');
                btn.innerHTML = '<i class="fas fa-camera"></i>';
                this.state.productScanner = null;
            }).catch(e => console.log(e));
        }
    },

    // --- Offline Queue & Sync ---
    checkOfflineQueue: function() {
        const banner = document.getElementById('syncBanner');
        if (this.state.syncQueue.length > 0) {
            banner.classList.remove('hidden');
            document.getElementById('syncText').textContent = `${this.state.syncQueue.length} data menunggu sinkronisasi`;
        } else {
            banner.classList.add('hidden');
        }
    },

    syncData: async function() {
        if (!navigator.onLine || GAS_URL === 'YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL') {
            this.checkOfflineQueue();
            return;
        }
        
        if (this.state.syncQueue.length === 0) {
            this.checkOfflineQueue();
            return;
        }
        
        document.getElementById('syncBanner').classList.remove('hidden');
        document.getElementById('syncText').textContent = `Menyinkronkan ${this.state.syncQueue.length} data...`;
        
        // Buat salinan queue untuk iterasi aman
        const queueCopy = [...this.state.syncQueue];
        let successCount = 0;
        this.state.lastSyncErrors = [];
        
        for (let i = 0; i < queueCopy.length; i++) {
            const item = queueCopy[i];
            try {
                document.getElementById('syncText').textContent = `Sync ${i+1}/${queueCopy.length}...`;
                
                const response = await fetch(GAS_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                    body: JSON.stringify({ action: 'syncData', payload: item }),
                    redirect: 'follow'
                });
                
                const responseText = await response.text();
                let result;
                try {
                    result = JSON.parse(responseText);
                } catch(parseErr) {
                    console.error('Response bukan JSON:', responseText.substring(0, 200));
                    this.state.lastSyncErrors.push({
                        type: item.type,
                        msg: 'Respon server bukan JSON (Periksa Web App URL)'
                    });
                    continue;
                }
                
                if (result.status === 'success') {
                    successCount++;
                    // Hapus item dari queue secara aman berdasarkan index
                    const idx = this.state.syncQueue.indexOf(item);
                    if (idx > -1) this.state.syncQueue.splice(idx, 1);
                    this.saveData();
                } else {
                    console.error('Sync gagal dari server:', result.message);
                    this.state.lastSyncErrors.push({
                        type: item.type,
                        msg: result.message || 'Ditolak server'
                    });
                }
            } catch (error) {
                console.error('Gagal sync (network):', error);
                this.state.lastSyncErrors.push({
                    type: item.type,
                    msg: 'Koneksi terputus (Network error)'
                });
                break; // Berhenti di network failure pertama
            }
        }
        
        if (successCount > 0) {
            document.getElementById('syncText').textContent = `${successCount} data tersinkronisasi! Memperbarui stok, profil & riwayat...`;
            // Refresh data produk, pengaturan, dan transaksi dari server agar sinkron dengan Google Sheets
            await this.refreshProductsFromServer();
            await this.refreshSettingsFromServer();
            await this.refreshTransactionsFromServer();
            setTimeout(() => this.checkOfflineQueue(), 2000);
        } else {
            this.checkOfflineQueue();
        }
    },

    refreshProductsFromServer: async function() {
        if (!navigator.onLine || GAS_URL === 'YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL') return;
        try {
            const response = await fetch(`${GAS_URL}?action=getProducts`);
            const resData = await response.json();
            if (resData.status === 'success' && Array.isArray(resData.data)) {
                const serverProducts = resData.data;

                // 1. Kumpulkan produk lokal baru dan produk yang dihapus di syncQueue (belum diproses server)
                const pendingNewProducts = [];
                const pendingDeletedBarcodes = new Set();
                const pendingDeletedNames = new Set();
                const pendingTrxItems = [];
                const pendingRestocks = []; // Fix #3: restok yang belum tersinkron ke server

                this.state.syncQueue.forEach(q => {
                    if (q.type === 'product' && q.data) {
                        pendingNewProducts.push(q.data);
                    } else if (q.type === 'delete_product' && q.data) {
                        if (q.data.Barcode_ID) pendingDeletedBarcodes.add(q.data.Barcode_ID.toString().trim().toLowerCase());
                        if (q.data.Nama_Camilan) pendingDeletedNames.add(q.data.Nama_Camilan.toString().trim().toLowerCase());
                    } else if (q.type === 'transaction' && q.data && q.data.items) {
                        q.data.items.forEach(item => {
                            pendingTrxItems.push({
                                barcode: item.Barcode_ID,
                                name: item.Nama_Camilan,
                                qty: parseInt(item.qty) || 0
                            });
                        });
                    } else if (q.type === 'restock' && q.data) {
                        pendingRestocks.push({
                            barcode: q.data.Barcode_ID,
                            name: q.data.Nama_Camilan,
                            qty: parseInt(q.data.qty) || 0,
                            priceBuy: cleanNumber(q.data.priceBuy),
                            expired: q.data.expired || ''
                        });
                    }
                });

                // 2. Filter server products (hilangkan yang sudah dihapus secara lokal di antrean sync)
                let mergedProducts = serverProducts.filter(sp => {
                    const bc = sp.Barcode_ID ? sp.Barcode_ID.toString().trim().toLowerCase() : '';
                    const nm = sp.Nama_Camilan ? sp.Nama_Camilan.toString().trim().toLowerCase() : '';
                    if (bc !== '' && pendingDeletedBarcodes.has(bc)) return false;
                    if (nm !== '' && pendingDeletedNames.has(nm)) return false;
                    return true;
                });

                // 3. Tambahkan produk lokal baru jika belum ada di server
                pendingNewProducts.forEach(localP => {
                    const exists = mergedProducts.some(sp => 
                        (localP.Barcode_ID && sp.Barcode_ID && compareBarcode(localP.Barcode_ID, sp.Barcode_ID)) ||
                        (localP.Nama_Camilan && sp.Nama_Camilan && localP.Nama_Camilan.toString().trim().toLowerCase() === sp.Nama_Camilan.toString().trim().toLowerCase())
                    );
                    if (!exists) {
                        mergedProducts.push(localP);
                    }
                });

                // 4. Terapkan pengurangan stok lokal untuk transaksi offline yang belum terkirim
                //    (Fix #4: kurangi juga batch secara FIFO agar checkout offline berikutnya tidak menghitung ganda)
                mergedProducts.forEach(sp => {
                    pendingTrxItems.forEach(pending => {
                        const match = (sp.Barcode_ID && pending.barcode && compareBarcode(sp.Barcode_ID, pending.barcode)) ||
                                      (sp.Nama_Camilan && pending.name && sp.Nama_Camilan.toString().trim().toLowerCase() === pending.name.toString().trim().toLowerCase());
                        if (match) {
                            sp.Stok = Math.max(0, (parseInt(sp.Stok) || 0) - pending.qty);
                            if (sp.Stok === 0) sp.Status = 'Habis';

                            if (sp.batches && Array.isArray(sp.batches) && sp.batches.length > 0) {
                                sp.batches.sort((a, b) => {
                                    const da = new Date(convertDateToPickerFormat(a.expiredDate));
                                    const db = new Date(convertDateToPickerFormat(b.expiredDate));
                                    return (isNaN(da) ? Infinity : da) - (isNaN(db) ? Infinity : db);
                                });
                                let toDeduct = pending.qty;
                                sp.batches.forEach(b => {
                                    if (toDeduct <= 0) return;
                                    const d = Math.min(toDeduct, b.stokSisa);
                                    b.stokSisa -= d;
                                    toDeduct -= d;
                                });
                                sp.batches = sp.batches.filter(b => b.stokSisa > 0);
                            }
                        }
                    });
                });

                // 4b. Terapkan restok lokal yang belum tersinkron (Fix #3: cegah stok restok hilang saat refresh)
                pendingRestocks.forEach(r => {
                    if (r.qty <= 0) return;
                    const sp = mergedProducts.find(x =>
                        (x.Barcode_ID && r.barcode && compareBarcode(x.Barcode_ID, r.barcode)) ||
                        (x.Nama_Camilan && r.name && x.Nama_Camilan.toString().trim().toLowerCase() === r.name.toString().trim().toLowerCase())
                    );
                    if (sp) {
                        sp.Stok = (parseInt(sp.Stok) || 0) + r.qty;
                        sp.Status = 'Ready';
                        if (!sp.batches) sp.batches = [];
                        sp.batches.push({
                            batchId: 'B-pending-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
                            stokSisa: r.qty,
                            expiredDate: r.expired || '',
                            hargaBeli: r.priceBuy || 0
                        });
                    }
                });

                this.state.products = mergedProducts;
                this.saveData();

                // Perbarui tampilan jika sedang di halaman Manajemen Produk atau Transaksi
                if (this.state.currentView === 'products' && typeof this.renderProductList === 'function') {
                    this.renderProductList();
                } else if (this.state.currentView === 'pos') {
                    const manualInput = document.getElementById('manualBarcode');
                    const term = manualInput ? manualInput.value.trim().toLowerCase() : '';
                    if (term && typeof this.renderSearchSuggestions === 'function') {
                        this.renderSearchSuggestions(term);
                    }
                }
                console.log('Stok & daftar produk berhasil disinkronkan dari server:', mergedProducts.length);
            }
        } catch (e) {
            console.error('Gagal refresh produk dari server:', e);
        }
    },

    refreshProductsFromServerWithToast: async function() {
        if (!navigator.onLine) {
            return Swal.fire('Offline', 'Koneksi internet tidak tersedia untuk menyinkronkan data produk dengan Google Sheets.', 'warning');
        }
        Swal.fire({ title: 'Menyinkronkan Produk...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        await this.refreshProductsFromServer();
        Swal.fire({ 
            icon: 'success', 
            title: 'Produk Tersinkronisasi', 
            text: `${this.state.products.length} produk siap digunakan di kasir!`, 
            timer: 1500, 
            showConfirmButton: false 
        });
    },

    refreshTransactionsFromServer: async function() {
        if (!navigator.onLine || GAS_URL === 'YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL') return;
        try {
            const response = await fetch(`${GAS_URL}?action=get_transactions`);
            const resData = await response.json();
            if (resData.status === 'success' && Array.isArray(resData.data)) {
                const serverTrxs = resData.data;

                // Dapatkan ID transaksi yang masih menggantung di syncQueue (belum terkirim)
                const pendingTrxIds = new Set();
                this.state.syncQueue.forEach(q => {
                    if (q.type === 'transaction' && q.data && q.data.id) {
                        pendingTrxIds.add(q.data.id);
                    }
                });

                // Pertahankan transaksi lokal yang masih di antrean sync
                const localPending = this.state.transactions.filter(t => pendingTrxIds.has(t.id));

                // Gabungkan transaksi dari server dengan transaksi pending lokal (tanpa duplikat)
                const mergedMap = new Map();
                serverTrxs.forEach(t => mergedMap.set(t.id, t));
                localPending.forEach(t => mergedMap.set(t.id, t));

                // Urutkan dari terbaru ke terlama
                const sorted = Array.from(mergedMap.values()).sort((a, b) => {
                    return new Date(b.timestamp || 0) - new Date(a.timestamp || 0);
                });

                this.state.transactions = sorted;
                this.saveData();

                // Refresh tampilan aktif sesuai layar saat ini
                if (this.state.currentView === 'reports' && typeof this.renderReports === 'function') {
                    this.renderReports();
                } else if (this.state.currentView === 'history' && typeof this.renderTransactionList === 'function') {
                    this.renderTransactionList('all', 'transactionListContainer', 'searchTransaction');
                } else if (this.state.currentView === 'debt' && typeof this.renderTransactionList === 'function') {
                    this.renderTransactionList('Kasbon', 'debtListContainer', 'searchDebt');
                }
                console.log('Daftar transaksi tersinkronisasi dari server:', sorted.length);
            }
        } catch (e) {
            console.error('Gagal refresh transaksi dari server:', e);
        }
    },

    refreshTransactionsFromServerWithToast: async function() {
        if (!navigator.onLine) {
            return Swal.fire('Offline', 'Koneksi internet tidak tersedia untuk menyinkronkan data dengan Google Sheets.', 'warning');
        }
        Swal.fire({ title: 'Menyingkronkan & Menghitung Ulang...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        try {
            // Minta server hitung ulang laba berdasarkan harga modal terbaru di sheet
            if (GAS_URL !== 'YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL') {
                await fetch(`${GAS_URL}?action=recalculate_profits`).catch(e => console.log('Recalculate trigger:', e));
            }
            await this.refreshProductsFromServer();
            await this.refreshTransactionsFromServer();
            if (this.state.currentView === 'reports') {
                this.renderReports();
            }
            Swal.fire({ icon: 'success', title: 'Data Tersinkronisasi', text: 'Harga modal & laba transaksi berhasil diperbarui!', timer: 1500, showConfirmButton: false });
        } catch (e) {
            console.error('Sync error:', e);
            Swal.fire('Info', 'Data transaksi berhasil dimuat ulang.', 'info');
        }
    },

    refreshSettingsFromServer: async function() {
        if (!navigator.onLine || GAS_URL === 'YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL') return;
        try {
            const settingsResp = await fetch(`${GAS_URL}?action=get_settings`);
            const settingsData = await settingsResp.json();
            if (settingsData.status === 'success' && settingsData.data && Object.keys(settingsData.data).length > 0) {
                const localLogo = this.state.settings.shopLogo;
                Object.assign(this.state.settings, settingsData.data);
                // Pertahankan logo gambar lokal jika server tidak menyimpan logo
                if (localLogo && !this.state.settings.shopLogo) {
                    this.state.settings.shopLogo = localLogo;
                }
                localStorage.setItem('pos_settings', JSON.stringify(this.state.settings));
                if (this.state.currentView === 'settings') {
                    this.showSettingsForm();
                }
                console.log('Profil usaha diperbarui dari server:', this.state.settings.shopName);
            }
        } catch (e) {
            console.error('Gagal memuat settings dari server:', e);
        }
    },

    showSettingsForm: function() {
        document.getElementById('setShopName').value = this.state.settings.shopName || '';
        document.getElementById('setShopAddress').value = this.state.settings.shopAddress || '';
        document.getElementById('setShopPhone').value = this.state.settings.shopPhone || '';
        document.getElementById('setCashierName').value = this.state.settings.cashierName || '';
        document.getElementById('setShopWA').value = this.state.settings.shopWA || '';
        document.getElementById('setReceiptFooter').value = this.state.settings.receiptFooter || '';
        document.getElementById('setGasUrl').value = localStorage.getItem('pos_gas_url') || '';

        // Tampilkan preview logo jika ada
        const logoPreviewImg = document.getElementById('logoPreviewImg');
        const logoPreviewContainer = document.getElementById('logoPreviewContainer');
        if (this.state.settings.shopLogo && this.state.settings.shopLogo.startsWith('data:image')) {
            logoPreviewImg.src = this.state.settings.shopLogo;
            logoPreviewContainer.classList.remove('hidden');
        } else {
            logoPreviewImg.src = '';
            logoPreviewContainer.classList.add('hidden');
        }

        // Update status printer Bluetooth di halaman Pengaturan
        this.updatePrinterStatusUI();
    },

    handleLogoUpload: function(event) {
        const file = event.target.files[0];
        if (!file) return;

        if (!file.type.startsWith('image/')) {
            return Swal.fire('Error', 'File harus berupa gambar JPG/PNG!', 'error');
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                // Resize logo ke lebar maksimal 128px demi efisiensi storage
                const canvas = document.createElement('canvas');
                const maxW = 128;
                const scale = maxW / img.width;
                canvas.width = maxW;
                canvas.height = Math.round(img.height * scale);

                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

                const compressedBase64 = canvas.toDataURL('image/png');
                this.state.settings.shopLogo = compressedBase64;

                const previewImg = document.getElementById('logoPreviewImg');
                const previewContainer = document.getElementById('logoPreviewContainer');
                previewImg.src = compressedBase64;
                previewContainer.classList.remove('hidden');
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    },

    removeLogo: function() {
        this.state.settings.shopLogo = '';
        document.getElementById('logoPreviewImg').src = '';
        document.getElementById('logoPreviewContainer').classList.add('hidden');
        document.getElementById('setShopLogoFile').value = '';
    },

    saveSettings: function() {
        const name = document.getElementById('setShopName').value.trim();
        const address = document.getElementById('setShopAddress').value.trim();
        const phone = document.getElementById('setShopPhone').value.trim();
        const cashier = document.getElementById('setCashierName').value.trim();
        const wa = document.getElementById('setShopWA').value.trim();
        const footer = document.getElementById('setReceiptFooter').value.trim();
        const gasUrl = document.getElementById('setGasUrl').value.trim();

        if (!name) return Swal.fire('Error', 'Nama Usaha wajib diisi!', 'warning');

        this.state.settings.shopName = name;
        this.state.settings.shopAddress = address;
        this.state.settings.shopPhone = phone;
        this.state.settings.cashierName = cashier;
        this.state.settings.shopWA = wa;
        this.state.settings.receiptFooter = footer;

        localStorage.setItem('pos_settings', JSON.stringify(this.state.settings));
        
        // Sync settings ke server agar tersedia di device lain
        this.state.syncQueue.push({
            type: 'save_settings',
            data: { ...this.state.settings }
        });
        this.saveData();
        this.syncData();
        
        if (gasUrl) {
            localStorage.setItem('pos_gas_url', gasUrl);
            GAS_URL = gasUrl;
        } else {
            localStorage.removeItem('pos_gas_url');
            GAS_URL = 'https://script.google.com/macros/s/AKfycbxShfwNUtXVeZB_hReUyB8y5oRplJp2y2j-p-eoyiOmZcx_Ad6dhQZFlMIEsD2xgEMc-Q/exec';
        }

        Swal.fire('Berhasil', 'Semua pengaturan berhasil disimpan!', 'success').then(() => {
            this.navigate('dashboard');
        });
    },

    resetLocalData: function() {
        Swal.fire({
            title: 'Hapus Riwayat Data Lokal?',
            text: 'Tindakan ini akan mengosongkan riwayat transaksi, keranjang, dan daftar produk ter-cache. Profil pengaturan toko Anda akan tetap aman.',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#d33',
            confirmButtonText: 'Ya, Bersihkan!',
            cancelButtonText: 'Batal'
        }).then((result) => {
            if (result.isConfirmed) {
                // H7 Fix: Preserve settings
                const savedGas = localStorage.getItem('pos_gas_url');
                const savedSettings = localStorage.getItem('pos_settings');
                
                localStorage.clear();
                
                if (savedGas) localStorage.setItem('pos_gas_url', savedGas);
                if (savedSettings) localStorage.setItem('pos_settings', savedSettings);
                
                Swal.fire('Berhasil', 'Riwayat database lokal telah dibersihkan. Aplikasi akan dimuat ulang.', 'success').then(() => {
                    window.location.reload();
                });
            }
        });
    },

    syncDataManual: async function() {
        if (!navigator.onLine) {
            Swal.fire('Offline', 'Tidak dapat melakukan sinkronisasi karena perangkat Anda sedang offline.', 'warning');
            return;
        }
        if (this.state.syncQueue.length === 0) {
            Swal.fire('Info', 'Semua data sudah tersinkronisasi sempurna dengan Google Sheets!', 'info');
            return;
        }
        
        Swal.fire({
            title: 'Sinkronisasi Manual',
            text: `Terdapat ${this.state.syncQueue.length} data dalam antrean. Mulai sinkronisasi sekarang?`,
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'Ya, Sinkronkan',
            cancelButtonText: 'Batal'
        }).then(async (res) => {
            if (res.isConfirmed) {
                Swal.fire({
                    title: 'Sinkronisasi Sedang Berjalan',
                    text: 'Harap tunggu...',
                    allowOutsideClick: false,
                    didOpen: () => {
                        Swal.showLoading();
                    }
                });
                
                await this.syncData();
                
                Swal.close();
                if (this.state.syncQueue.length === 0) {
                    Swal.fire('Berhasil', 'Semua data berhasil tersinkronisasi ke Google Sheets!', 'success');
                } else {
                    const queueSummary = this.state.syncQueue.map((q, i) => {
                        let desc = q.type || 'Data';
                        if (q.type === 'transaction' && q.data) desc += ` (ID: ${q.data.id || '—'})`;
                        if (q.type === 'product' && q.data) desc += ` (${q.data.Nama_Camilan || q.data.Barcode_ID || '—'})`;
                        if (q.type === 'restock' && q.data) desc += ` (${q.data.Nama_Camilan || q.data.Barcode_ID || '—'})`;
                        const err = this.state.lastSyncErrors && this.state.lastSyncErrors[i] ? `<br><small style="color:#dc2626;">↳ Respon Server: ${this.state.lastSyncErrors[i].msg}</small>` : '';
                        return `${i+1}. <b>${desc}</b>${err}`;
                    }).join('<br><br>');

                    Swal.fire({
                        title: 'Perhatian',
                        html: `<div style="text-align: left; font-size: 0.9rem;">
                            <p>Sinkronisasi selesai dengan <b>${this.state.syncQueue.length} data tersisa</b> yang belum diterima Google Sheets.</p>
                            <div style="background: #f8fafc; padding: 10px; border-radius: 8px; border: 1px solid #e2e8f0; margin: 10px 0; font-size: 0.85rem; max-height: 120px; overflow-y: auto;">
                                <b>Daftar antrean tertunda:</b><br>${queueSummary}
                            </div>
                            <p style="color: #64748b; font-size: 0.85rem;">
                                <b>Solusi:</b> Silakan lakukan <b>Deploy Ulang (New Deployment)</b> pada Google Apps Script Anda agar server mengenali fungsi terbaru.
                            </p>
                        </div>`,
                        icon: 'warning',
                        showCancelButton: true,
                        confirmButtonText: 'OK, Saya Cek Apps Script',
                        cancelButtonText: '🗑️ Bersihkan Antrean',
                        cancelButtonColor: '#e74c3c'
                    }).then((r) => {
                        if (r.dismiss === Swal.DismissReason.cancel) {
                            this.state.syncQueue = [];
                            this.saveData();
                            this.checkOfflineQueue();
                            Swal.fire('Dibersihkan', 'Antrean sinkronisasi telah dikosongkan.', 'success');
                        }
                    });
                }
            }
        });
    },

    // --- Scanner Logic ---
    toggleScanner: function() {
        if(this.state.isScannerRunning) this.stopScanner();
        else this.startScanner();
    },
    startScanner: function() {
        document.getElementById('reader').classList.remove('hidden');
        this.state.scanner = new Html5Qrcode("reader");
        this.state.lastScannedBarcode = '';
        this.state.lastScannedTime = 0;
        
        const readerEl = document.getElementById('reader');
        const readerWidth = readerEl.clientWidth || 300;
        const boxSize = Math.floor(Math.min(readerWidth * 0.8, 280));
        // Kotak scan berbentuk square sesuai permintaan user
        const config = { 
            fps: 15,
            qrbox: { width: boxSize, height: boxSize }
        };
        
        // Callback scan berhasil — Kamera tetap membaca (tanpa pause)
        const onScanSuccess = (text) => {
            if (!text) return;
            const cleanText = text.trim().replace(/[\r\n\t]/g, '');
            const now = Date.now();
            
            // Cooldown 1.5 detik HANYA jika menscan barcode yang SAMA berturut-turut.
            // Barcode BERBEDA bisa discan secara instan tanpa delay/pause.
            if (cleanText === this.state.lastScannedBarcode && (now - this.state.lastScannedTime < 1500)) {
                return;
            }
            
            this.state.lastScannedBarcode = cleanText;
            this.state.lastScannedTime = now;
            
            playBeep();
            if ("vibrate" in navigator) navigator.vibrate(80);
            
            const p = this.state.products.find(x => 
                compareBarcode(x.Barcode_ID, cleanText) || 
                (x.Barcode_ID && String(x.Barcode_ID).toLowerCase().trim() === cleanText.toLowerCase()) ||
                (x.Nama_Camilan && String(x.Nama_Camilan).toLowerCase().trim() === cleanText.toLowerCase())
            );
            if(p) {
                this.addToCart(p);
            } else {
                Swal.fire({
                    toast: true,
                    position: 'top-end',
                    icon: 'error',
                    title: `Barcode "${cleanText}" tidak ditemukan`,
                    showConfirmButton: false,
                    timer: 2000
                });
            }
        };
        
        // Coba kamera belakang dahulu (autofokus HP)
        this.state.scanner.start({ facingMode: "environment" }, config, onScanSuccess, (err) => {})
        .then(() => {
            this.state.isScannerRunning = true;
            document.getElementById('cameraBtnText').textContent = 'Tutup';
            document.getElementById('toggleCameraBtn').classList.replace('btn-primary', 'btn-danger');
        }).catch(err => {
            // Fallback ke kamera depan (laptop/PC)
            this.state.scanner.start({ facingMode: "user" }, config, onScanSuccess, (err) => {})
            .then(() => {
                this.state.isScannerRunning = true;
                document.getElementById('cameraBtnText').textContent = 'Tutup';
                document.getElementById('toggleCameraBtn').classList.replace('btn-primary', 'btn-danger');
            }).catch(e => {
                Swal.fire('Error', 'Gagal menyalakan kamera. Pastikan izin kamera sudah diberikan.', 'error');
                document.getElementById('reader').classList.add('hidden');
            });
        });
    },
    stopScanner: function() {
        if(this.state.scanner) {
            this.state.scanner.stop().then(() => {
                document.getElementById('reader').classList.add('hidden');
                this.state.isScannerRunning = false;
                document.getElementById('cameraBtnText').textContent = 'Scan';
                document.getElementById('toggleCameraBtn').classList.replace('btn-danger', 'btn-primary');
            });
        }
    },

    // --- Utilities ---
    initServiceWorker: function() {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('sw.js').then(reg => {
                reg.onupdatefound = () => {
                    const installingWorker = reg.installing;
                    if (installingWorker) {
                        installingWorker.onstatechange = () => {
                            if (installingWorker.state === 'installed') {
                                if (navigator.serviceWorker.controller) {
                                    // Ada service worker lama yang sedang mengontrol, ini artinya ada update baru!
                                    Swal.fire({
                                        title: 'Update Aplikasi',
                                        text: 'Versi aplikasi baru tersedia. Muat ulang sekarang untuk menerapkan pembaruan?',
                                        icon: 'info',
                                        showCancelButton: true,
                                        confirmButtonText: 'Muat Ulang',
                                        cancelButtonText: 'Nanti'
                                    }).then((result) => {
                                        if (result.isConfirmed) {
                                            window.location.reload();
                                        }
                                    });
                                }
                            }
                        };
                    }
                };
            }).catch(err => console.log('Gagal registrasi SW:', err));
        }
    },
    setupNetworkListeners: function() {
        window.addEventListener('online', () => {
            document.querySelector('.status-dot').className = 'status-dot online';
            document.getElementById('statusText').textContent = 'Online';
            this.syncData();
        });
        window.addEventListener('offline', () => {
            document.querySelector('.status-dot').className = 'status-dot offline';
            document.getElementById('statusText').textContent = 'Offline';
        });
    },

    shareReceipt: function() {
        if (!navigator.onLine) {
            return Swal.fire('Offline', 'Maaf, Anda harus online untuk membagikan struk via WhatsApp.', 'warning');
        }
        const trx = this.state.lastTransaction;
        if (!trx) return;
        
        const settings = this.state.settings || { shopName: 'Kasir Manis', shopLogo: '🏪', cashierName: 'Admin' };
        let text = `${settings.shopLogo || '🏪'} *${(settings.shopName || 'KASIR MANIS').toUpperCase()}*\n`;
        if (settings.shopAddress) text += `📍 ${settings.shopAddress}\n`;
        text += `━━━━━━━━━━━━━━━━━━━━\n`;
        text += `No   : ${trx.id}\n`;
        text += `Tgl  : ${(app._parseTransactionDate(trx.timestamp) || new Date(trx.timestamp)).toLocaleString('id-ID')}\n`;
        text += `Kasir: ${settings.cashierName || 'Admin'}\n`;
        text += `Pel  : ${trx.customer}\n`;
        text += `━━━━━━━━━━━━━━━━━━━━\n`;
        trx.items.forEach(i => {
            const iq = app._itemQtys(i);
            text += `${i.Nama_Camilan}\n`;
            if (iq.paid > 0) text += `  ${iq.paid} x ${formatRupiah(iq.unit)} = ${formatRupiah(iq.lineRevenue)}\n`;
            if (iq.bonus > 0) text += `  🎁 Bonus ${iq.bonus} pcs = GRATIS\n`;
        });
        text += `━━━━━━━━━━━━━━━━━━━━\n`;
        text += `Subtotal : ${formatRupiah(trx.subtotal)}\n`;
        if (trx.discount > 0) text += `Diskon   : -${formatRupiah(trx.discount)}\n`;
        text += `*TOTAL   : ${formatRupiah(trx.total)}*\n`;
        if (trx.method === 'Tunai') {
            text += `Bayar    : Tunai\n`;
            text += `Tunai    : ${formatRupiah(trx.cash)}\n`;
            text += `Kembali  : ${formatRupiah(trx.change)}\n`;
        } else if (trx.method === 'Transfer' || trx.method === 'QRIS') {
            text += `Bayar    : ${trx.method}\n`;
            text += `Status   : LUNAS\n`;
        } else if (trx.method === 'Kasbon') {
            const initDP = trx.initialDeposit || 0;
            const totalPaid = trx.cash || 0;
            const subsequentPay = totalPaid - initDP;
            const debt = trx.remainingDebt !== undefined ? trx.remainingDebt : Math.max(0, trx.total - totalPaid);

            text += `Bayar    : Kasbon\n`;
            text += `DP Awal  : ${formatRupiah(initDP)}\n`;
            if (subsequentPay > 0) {
                text += `Cicilan  : ${formatRupiah(subsequentPay)}\n`;
                text += `Total    : ${formatRupiah(totalPaid)}\n`;
            }
            text += `Hutang   : ${formatRupiah(debt)}\n`;
            text += `*STATUS  : ${debt === 0 ? 'LUNAS' : 'BELUM LUNAS'}*\n`;
        }
        text += `━━━━━━━━━━━━━━━━━━━━\n`;
        text += `${settings.receiptFooter || 'Terima kasih sudah berbelanja! 🙏'}`;
        
        const encoded = encodeURIComponent(text);
        window.open(`https://wa.me/?text=${encoded}`, '_blank');
    },

    preloadBluetoothDevice: async function() {
        // Ambil device yang sudah pernah di-pair saat page load, cocokkan dengan printer yang DIPILIH terakhir (by id)
        if (navigator.bluetooth && navigator.bluetooth.getDevices) {
            try {
                const devices = await navigator.bluetooth.getDevices();
                if (devices && devices.length > 0) {
                    let savedId = '';
                    try { savedId = localStorage.getItem('pos_printer_id') || ''; } catch (e) {}
                    // Prioritaskan printer yang tersimpan; jika tidak ada, ambil perangkat pertama sebagai fallback
                    const chosen = (savedId && devices.find(d => d.id === savedId)) || devices[0];
                    this.state.bluetoothDevice = chosen;
                    this.setupBluetoothDisconnectListener(chosen);
                    console.log("Preloaded Bluetooth device:", chosen.name, chosen.id);
                    // Hangatkan koneksi di latar belakang + jaga tetap hidup agar cetak pertama langsung siap
                    this._startPrinterKeepAlive();
                    setTimeout(() => { this._silentReconnect(); }, 1000);
                }
            } catch (err) {
                console.error("Gagal preloading paired devices:", err);
            }
        }
        this.updatePrinterStatusUI();
    },

    updatePrinterStatusUI: function() {
        const badge = document.getElementById('printerStatusBadge');
        const nameEl = document.getElementById('printerDeviceName');
        const discBtn = document.getElementById('btnDisconnectPrinter');
        
        if (!badge || !nameEl) return;

        if (this.state.bluetoothDevice && (this.state.bluetoothDevice.name || this.state.bluetoothDevice.id)) {
            const devName = this.state.bluetoothDevice.name || 'Printer Bluetooth';
            const isGattConnected = this.state.bluetoothDevice.gatt && this.state.bluetoothDevice.gatt.connected;
            badge.textContent = isGattConnected ? 'Terhubung ✓' : 'Tersimpan (Siap)';
            badge.className = isGattConnected ? 'status-badge bg-success' : 'status-badge bg-secondary';
            nameEl.textContent = `Printer: ${devName}`;
            if (discBtn) discBtn.classList.remove('hidden');
        } else {
            badge.textContent = 'Belum Terhubung';
            badge.className = 'status-badge bg-warning';
            nameEl.textContent = 'Belum ada printer Bluetooth yang tersambung.';
            if (discBtn) discBtn.classList.add('hidden');
        }
    },

    disconnectPrinter: function() {
        if (this.state.bluetoothDevice && this.state.bluetoothDevice.gatt && this.state.bluetoothDevice.gatt.connected) {
            try { this.state.bluetoothDevice.gatt.disconnect(); } catch (e) {}
        }
        this.state.bluetoothDevice = null;
        this.state.bluetoothChar = null;
        this.state.bluetoothService = null;
        try { localStorage.removeItem('pos_printer_id'); localStorage.removeItem('pos_printer_name'); } catch (e) {}
        this.updatePrinterStatusUI();
        Swal.fire({ toast: true, position: 'top-end', icon: 'info', title: 'Koneksi printer diputuskan', showConfirmButton: false, timer: 2000 });
    },

    previewTestPrint: function() {
        const dummyTrx = {
            id: 'TEST-' + Math.floor(1000 + Math.random() * 9000),
            timestamp: new Date().toISOString(),
            customer: 'Pelanggan Contoh',
            items: [
                { Nama_Camilan: 'Camilan Oleh-Oleh A', qty: 2, editPrice: 15000 },
                { Nama_Camilan: 'Camilan Oleh-Oleh B', qty: 1, editPrice: 20000 }
            ],
            subtotal: 50000,
            discount: 5000,
            total: 45000,
            method: 'Tunai',
            cash: 50000,
            change: 5000,
            status: 'Lunas'
        };
        this.showReceipt(dummyTrx);
    },

    getBluetoothDevice: async function(forceNew = false) {
        // 1. Gunakan device yang sudah tersimpan di state jika tidak dipaksa baru
        if (!forceNew && this.state.bluetoothDevice) {
            return this.state.bluetoothDevice;
        }

        // 2. Minta user pairing lewat popup browser
        if (!navigator.bluetooth) throw new Error('Web Bluetooth tidak didukung di browser ini. Gunakan Google Chrome di Android/PC.');
        const device = await navigator.bluetooth.requestDevice({
            acceptAllDevices: true,
            optionalServices: PRINTER_SERVICES
        });

        if (device) {
            this.state.bluetoothDevice = device;
            this.state.bluetoothChar = null;
            this.state.bluetoothService = null;
            // Ingat printer yang dipilih agar bisa auto-connect di sesi berikutnya
            try {
                localStorage.setItem('pos_printer_id', device.id);
                if (device.name) localStorage.setItem('pos_printer_name', device.name);
            } catch (e) {}
            this.setupBluetoothDisconnectListener(device);
            this.updatePrinterStatusUI();
        }
        return device;
    },

    setupBluetoothDisconnectListener: function(device) {
        // Cegah listener ganda pada device yang sama
        if (!device || device._kasirListenerAttached) return;
        device._kasirListenerAttached = true;
        device.addEventListener('gattserverdisconnected', () => {
            console.log('Koneksi printer Bluetooth terputus.');
            this.state.bluetoothChar = null;
            this.state.bluetoothService = null;
            this.updatePrinterStatusUI();
            // Pulihkan koneksi diam-diam agar saat cetak nanti sudah siap (tanpa perlu sambung ulang manual)
            setTimeout(() => { this._silentReconnect(); }, 1500);
        });
    },

    // Reconnect di latar belakang TANPA popup/UI. Dipakai keep-alive & saat koneksi tiba-tiba putus.
    _silentReconnect: async function() {
        if (this.state._reconnecting || this.state._printing) return;
        const device = this.state.bluetoothDevice;
        if (!device) return;
        // Sudah tersambung & siap → tidak perlu apa-apa
        if (device.gatt && device.gatt.connected && this.state.bluetoothChar) return;
        this.state._reconnecting = true;
        try {
            const server = await this._gattConnectWithTimeout(device, 8000);
            const found = await this._findPrintCharacteristic(server);
            if (found.char) {
                this.state.bluetoothChar = found.char;
                this.state.bluetoothService = found.service;
                this.updatePrinterStatusUI();
                console.log('Keep-alive: printer tersambung ulang diam-diam.');
            }
        } catch (e) {
            // Diam saja — akan dicoba lagi pada interval berikutnya atau saat menekan cetak
        } finally {
            this.state._reconnecting = false;
        }
    },

    // Jaga koneksi tetap hidup: cek berkala, sambung ulang bila putus (hanya saat app terlihat)
    _startPrinterKeepAlive: function() {
        if (this.state._keepAliveTimer) return;
        this.state._keepAliveTimer = setInterval(() => {
            const dev = this.state.bluetoothDevice;
            if (!dev) return;
            const ready = dev.gatt && dev.gatt.connected && this.state.bluetoothChar;
            if (!ready && document.visibilityState === 'visible' && !this.state._printing && !this.state._reconnecting) {
                this._silentReconnect();
            }
        }, 20000); // cek tiap 20 detik
    },

    // Koneksi GATT dengan timeout agar tidak menggantung selamanya
    _gattConnectWithTimeout: function(device, ms) {
        const connectPromise = device.gatt.connect();
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Koneksi timeout. Pastikan printer menyala & dekat.')), ms)
        );
        return Promise.race([connectPromise, timeoutPromise]);
    },

    // Temukan characteristic untuk mencetak: utamakan service printer yang dikenal, lalu full-scan
    _findPrintCharacteristic: async function(server) {
        const pick = (chars) => {
            // Utamakan write-with-response (andal), fallback ke writeWithoutResponse
            return chars.find(c => c.properties.write) ||
                   chars.find(c => c.properties.writeWithoutResponse) || null;
        };
        // Fast-path: daftar service printer ESC/POS & BLE UART yang umum
        for (const uuid of PRINTER_SERVICES) {
            try {
                const service = await server.getPrimaryService(uuid);
                const chars = await service.getCharacteristics();
                const char = pick(chars);
                if (char) {
                    console.log(`Print char via service ${uuid} (write=${char.properties.write}, noResp=${char.properties.writeWithoutResponse})`);
                    return { char: char, service: service };
                }
            } catch (e) { continue; }
        }
        // Slow-path: scan seluruh primary service
        try {
            const services = await server.getPrimaryServices();
            for (const service of services) {
                try {
                    const chars = await service.getCharacteristics();
                    const char = pick(chars);
                    if (char) {
                        console.log(`Print char via full-scan (write=${char.properties.write}, noResp=${char.properties.writeWithoutResponse})`);
                        return { char: char, service: service };
                    }
                } catch (e) {}
            }
        } catch (e) {}
        return { char: null, service: null };
    },

    connectToPrinter: async function(forceReconnect = false) {
        let device = await this.getBluetoothDevice();
        if (!device) throw new Error('Printer tidak dipilih.');

        // Fast-path: koneksi & characteristic masih valid → langsung pakai (cetak instan)
        if (!forceReconnect && device.gatt && device.gatt.connected && this.state.bluetoothChar) {
            this._startPrinterKeepAlive();
            return this.state.bluetoothChar;
        }

        Swal.fire({
            title: 'Menghubungkan ke Printer...',
            html: `Menghubungkan ke <b>${device.name || 'Printer Bluetooth'}</b>...`,
            allowOutsideClick: false,
            didOpen: () => Swal.showLoading()
        });

        // Tandai sedang menyambung agar keep-alive tidak ikut campur
        this.state._reconnecting = true;
        // Coba hingga 3x dengan jeda bertingkat (backoff)
        let lastErr = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                // Bersihkan koneksi yang mungkin nyangkut sebelum menyambung ulang
                if (device.gatt && device.gatt.connected) {
                    try { device.gatt.disconnect(); } catch (e) {}
                    await new Promise(r => setTimeout(r, 400));
                }

                const server = await this._gattConnectWithTimeout(device, 10000);
                const found = await this._findPrintCharacteristic(server);
                if (!found.char) throw new Error('Karakteristik Bluetooth untuk Print tidak ditemukan pada printer ini.');

                this.state.bluetoothChar = found.char;
                this.state.bluetoothService = found.service;
                this.state._reconnecting = false;
                this.updatePrinterStatusUI();
                this._startPrinterKeepAlive();
                Swal.close();
                return found.char;
            } catch (err) {
                lastErr = err;
                console.warn(`Percobaan koneksi #${attempt + 1} gagal:`, err && err.message ? err.message : err);
                await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
            }
        }
        this.state._reconnecting = false;

        Swal.close();
        // Setelah 3x gagal → tawarkan pilih ulang perangkat
        const res = await Swal.fire({
            title: 'Gagal Terhubung ke Printer',
            html: `<p style="font-size:0.9rem; color:#64748b;">Tidak dapat tersambung ke <b>${device.name || 'Printer Bluetooth'}</b>.<br>Pastikan printer menyala, kertas terpasang, Bluetooth HP aktif, dan printer dekat dengan HP.</p>`,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: '🔄 Pilih Ulang Printer',
            cancelButtonText: 'Batal',
            confirmButtonColor: '#FF6B6B'
        });

        if (res.isConfirmed) {
            this.state.bluetoothDevice = null;
            this.state.bluetoothChar = null;
            this.state.bluetoothService = null;
            try { localStorage.removeItem('pos_printer_id'); } catch (e) {}
            const dev = await this.getBluetoothDevice(true);
            if (!dev) throw (lastErr || new Error('Printer tidak dipilih.'));
            return this.connectToPrinter(true);
        }

        throw (lastErr || new Error('Gagal terhubung ke printer.'));
    },

    // Fungsi sentral pengiriman data byte ke printer BLE.
    // Semua panggilan diserialkan lewat antrean (_printChain) agar tidak terjadi
    // "GATT operation already in progress" saat cetak dipicu beruntun (mis. logo + teks / double tap).
    _writeChunksToPrinter: function(printChar, fullBytes) {
        const task = () => this._doWriteChunks(printChar, fullBytes);
        // Jalankan setelah antrean sebelumnya selesai (baik sukses maupun gagal)
        const result = (this.state._printChain || Promise.resolve()).then(task, task);
        // Simpan versi yang tidak menolak agar rantai antrean tetap hidup untuk cetakan berikutnya
        this.state._printChain = result.catch(() => {});
        return result;
    },

    _doWriteChunks: async function(printChar, fullBytes) {
        this.state._printing = true; // cegah keep-alive menyela di tengah cetak
        try {
        let char = printChar || this.state.bluetoothChar;
        if (!char) char = await this.connectToPrinter();

        // Metode tulis menentukan ukuran chunk aman:
        //  - write-with-response: Chrome fragmen otomatis & printer meng-ACK → chunk boleh besar (180B)
        //  - writeWithoutResponse: dibatasi MTU (default ±20B) → wajib kecil agar tidak drop
        let withResp = !!char.properties.write;
        let CHUNK = withResp ? 180 : 20;
        const DELAY = withResp ? 20 : 15;

        const writeOne = (view) => {
            if (withResp && char.properties.write) return char.writeValue(view);
            if (char.properties.writeWithoutResponse && char.writeValueWithoutResponse) return char.writeValueWithoutResponse(view);
            return char.writeValue(view);
        };

        console.log(`BLE Print: ${fullBytes.length} bytes, withResp=${withResp}, chunk=${CHUNK}`);

        let reconnectedOnce = false;
        let i = 0;
        while (i < fullBytes.length) {
            const chunk = fullBytes.subarray(i, i + CHUNK);
            const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
            try {
                await writeOne(view);
                i += CHUNK;
                if (i < fullBytes.length && DELAY) await new Promise(r => setTimeout(r, DELAY));
            } catch (err) {
                console.warn(`BLE write gagal di offset ${i} (chunk=${CHUNK}):`, err && err.message ? err.message : err);

                // 1) Kemungkinan chunk melebihi MTU → perkecil ke 20B lalu ulangi offset yang sama
                if (CHUNK > 20) {
                    CHUNK = 20;
                    await new Promise(r => setTimeout(r, 80));
                    continue;
                }

                // 2) Kemungkinan koneksi putus → reconnect penuh 1x, lalu lanjut dari offset ini
                if (!reconnectedOnce) {
                    reconnectedOnce = true;
                    try {
                        char = await this.connectToPrinter(true);
                        withResp = !!char.properties.write;
                        // setelah reconnect, tetap konservatif pakai chunk kecil untuk sisa data
                        CHUNK = withResp ? 180 : 20;
                        await new Promise(r => setTimeout(r, 150));
                        continue;
                    } catch (reErr) {
                        console.error('Reconnect saat cetak gagal:', reErr);
                    }
                }

                throw new Error('Gagal mengirim data ke printer. Pastikan printer menyala, kertas ada, dan printer dekat dengan HP, lalu coba cetak lagi.');
            }
        }
        console.log('BLE Print: Seluruh data terkirim.');
        } finally {
            this.state._printing = false;
        }
    },

    testConnectPrinter: async function() {
        try {
            if (!navigator.bluetooth) {
                return Swal.fire('Tidak Didukung', 'Web Bluetooth tidak didukung di browser ini. Gunakan Chrome di Android/PC.', 'warning');
            }

            // Jika belum ada device tersimpan, minta user pairing
            if (!this.state.bluetoothDevice) {
                const device = await this.getBluetoothDevice(true);
                if (!device) return;
            }

            const printChar = await this.connectToPrinter();
            if (!printChar) return;

            // Print test receipt via ESC/POS
            const settings = this.state.settings || { shopName: 'Kasir Manis', shopAddress: '', shopPhone: '', cashierName: 'Admin', receiptFooter: 'Terima Kasih!' };
            const now = new Date();
            const timeStr = now.toLocaleDateString('id-ID') + ' ' + now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

            const boldOn = new Uint8Array([0x1B, 0x45, 1]);
            const boldOff = new Uint8Array([0x1B, 0x45, 0]);
            const encoder = new TextEncoder();

            let dataBuffer = [];

            // Add logo if exists
            if (settings.shopLogo && settings.shopLogo.startsWith('data:image/')) {
                try {
                    const logoBytes = await this.getLogoEscPosBytes(settings.shopLogo);
                    dataBuffer.push(...logoBytes);
                } catch (err) { console.error('Logo render error:', err); }
            }

            // Header text
            dataBuffer.push(...encoder.encode('\n'));
            dataBuffer.push(...boldOn);
            dataBuffer.push(...encoder.encode((settings.shopName || 'Kasir Manis') + '\n'));
            dataBuffer.push(...boldOff);
            if (settings.shopAddress) dataBuffer.push(...encoder.encode(settings.shopAddress + '\n'));
            if (settings.shopPhone) dataBuffer.push(...encoder.encode('Telp: ' + settings.shopPhone + '\n'));
            
            dataBuffer.push(...encoder.encode('--------------------------------\n'));
            dataBuffer.push(...boldOn);
            dataBuffer.push(...encoder.encode('*** TEST PRINT BERHASIL ***\n'));
            dataBuffer.push(...boldOff);
            dataBuffer.push(...encoder.encode('--------------------------------\n'));
            
            dataBuffer.push(...encoder.encode(`Waktu: ${timeStr}\n`));
            dataBuffer.push(...encoder.encode(`Kasir: ${settings.cashierName || 'Admin'}\n`));
            dataBuffer.push(...encoder.encode(`Status: PRINTER TERHUBUNG OK\n`));
            dataBuffer.push(...encoder.encode('--------------------------------\n'));
            dataBuffer.push(...encoder.encode('1x Test Print Item      Rp 0\n'));
            dataBuffer.push(...encoder.encode('--------------------------------\n'));
            dataBuffer.push(...boldOn);
            dataBuffer.push(...encoder.encode('TOTAL:                  Rp 0\n'));
            dataBuffer.push(...boldOff);
            dataBuffer.push(...encoder.encode('--------------------------------\n'));
            dataBuffer.push(...encoder.encode((settings.receiptFooter || 'Terima Kasih!') + '\n\n\n'));

            // Kirim data ke printer dalam chunk kecil (maks 100 byte)
            const fullBytes = new Uint8Array(dataBuffer);
            await this._writeChunksToPrinter(printChar, fullBytes);

            this.updatePrinterStatusUI();

            Swal.fire({
                icon: 'success',
                title: 'Test Print Berhasil!',
                text: `Printer "${this.state.bluetoothDevice.name || 'Bluetooth'}" berhasil terhubung & tersimpan. Saat checkout transaksi nanti, printer akan mencetak otomatis tanpa perlu pairing ulang!`
            });

        } catch (e) {
            console.error('Test print error:', e);
            if (e.name !== 'NotFoundError') {
                Swal.fire('Gagal Test Print', e.message || 'Gagal terhubung ke printer Bluetooth.', 'error');
            }
        }
    },

    printReceipt: async function() {
        const trx = this.state.lastTransaction;
        if (!trx) return;
        
        try {
            const printChar = await this.connectToPrinter();
            const settings = this.state.settings || { shopName: 'Arummanis', shopAddress: '', shopPhone: '', shopLogo: '', cashierName: 'Admin', receiptFooter: 'Terima Kasih!' };

            // We use default left alignment ESC/POS commands to keep total control over custom margins
            const boldOn = new Uint8Array([0x1B, 0x45, 1]);
            const boldOff = new Uint8Array([0x1B, 0x45, 0]);
            const sizeLarge = new Uint8Array([0x1D, 0x21, 0x11]); // GS ! 0x11 (Double height & width)
            const sizeNormal = new Uint8Array([0x1D, 0x21, 0x00]); // Normal size
            const lineFeed = new TextEncoder().encode("\n");

            // Text wrapping helper to prevent messy printer auto-wraps
            const wrapText = (text, limit) => {
                const words = text.split(' ');
                const lines = [];
                let currentLine = '';
                words.forEach(word => {
                    if ((currentLine + word).length > limit) {
                        if (currentLine) lines.push(currentLine.trim());
                        currentLine = word + ' ';
                    } else {
                        currentLine += word + ' ';
                    }
                });
                if (currentLine) lines.push(currentLine.trim());
                return lines;
            };

            // Custom manual centering helpers (using 28 character printable area + 3 spaces margin)
            const centerDouble = (text) => {
                const limit = 14; // Max double-width chars inside 28-char limit
                const len = text.length;
                if (len >= limit) return text.slice(0, limit);
                const padLeft = Math.floor((limit - len) / 2);
                const padRight = limit - len - padLeft;
                return " ".repeat(padLeft) + text + " ".repeat(padRight);
            };

            const centerNormal = (text) => {
                const limit = 28; // Max normal-width chars inside 28-char limit
                const len = text.length;
                if (len >= limit) return text.slice(0, limit);
                const padLeft = Math.floor((limit - len) / 2);
                return " ".repeat(padLeft) + text;
            };

            const headerParts = [];
            // 1. Initialize printer (defaults to left aligned ESC a 0)
            headerParts.push(new Uint8Array([0x1B, 0x40])); // ESC @ (Init)

            // 2. Render logo image at the very top center if exists (pre-centered in getLogoEscPosBytes)
            let logoBytes = null;
            if (settings.shopLogo && settings.shopLogo.startsWith('data:image')) {
                try {
                    logoBytes = await this.getLogoEscPosBytes(settings.shopLogo);
                } catch (logoErr) {
                    console.error("Gagal mengonversi logo ke ESC/POS:", logoErr);
                }
            }
            if (logoBytes) {
                headerParts.push(logoBytes);
                headerParts.push(lineFeed);
            }

            // 3. Shop Name (Centered, Bold, Normal Size to prevent pipih/wrapping)
            const shopNameLines = wrapText(settings.shopName || "ARUMMANIS", 28);
            shopNameLines.forEach(line => {
                headerParts.push(new TextEncoder().encode("   ")); // Left margin
                headerParts.push(boldOn);
                headerParts.push(new TextEncoder().encode(centerNormal(line)));
                headerParts.push(boldOff);
                headerParts.push(lineFeed);
            });

            // 4. Shop Address (Centered, normal size, wrapped to 28 chars)
            if (settings.shopAddress) {
                const addressLines = wrapText(settings.shopAddress, 28);
                addressLines.forEach(line => {
                    headerParts.push(new TextEncoder().encode("   " + centerNormal(line) + "\n"));
                });
            }

            // 5. Shop Phone (Centered, normal size)
            if (settings.shopPhone) {
                headerParts.push(new TextEncoder().encode("   " + centerNormal("Telp: " + settings.shopPhone) + "\n"));
            }

            // Build receipt body text with left-margin padding (3 spaces)
            let bodyTxt = "";
            bodyTxt += "   ----------------------------\n";
            bodyTxt += `   No   : ${trx.id}\n   Tgl  : ${(app._parseTransactionDate(trx.timestamp) || new Date(trx.timestamp)).toLocaleString('id-ID')}\n   Kasir: ${settings.cashierName || 'Admin'}\n   Pel  : ${trx.customer}\n`;
            bodyTxt += "   ----------------------------\n";
            
            // Items list (baris berbayar + baris bonus terpisah)
            trx.items.forEach(i => {
                const iq = this._itemQtys(i);
                bodyTxt += `   ${i.Nama_Camilan}\n`;
                if (iq.paid > 0) {
                    bodyTxt += "   " + makePrintRow(`${iq.paid} x ${formatRupiah(iq.unit)}`, formatRupiah(iq.lineRevenue), 28);
                }
                if (iq.bonus > 0) {
                    bodyTxt += "   " + makePrintRow(`Bonus ${iq.bonus} pcs`, "GRATIS", 28);
                }
            });
            bodyTxt += "   ----------------------------\n";
            
            // Totals
            bodyTxt += "   " + makePrintRow("Subtotal:", formatRupiah(trx.subtotal), 28);
            bodyTxt += "   " + makePrintRow("Diskon:", "-" + formatRupiah(trx.discount || 0), 28);
            bodyTxt += "   " + makePrintRow("TOTAL:", formatRupiah(trx.total), 28);
            bodyTxt += "   ----------------------------\n";
            
            // Payment info
            if (trx.method === 'Kasbon') {
                const initDP = trx.initialDeposit || 0;
                const totalPaid = trx.cash || 0;
                const subsequentPay = totalPaid - initDP;
                const debt = trx.remainingDebt !== undefined ? trx.remainingDebt : Math.max(0, trx.total - totalPaid);
                
                bodyTxt += "   " + makePrintRow("Metode:", "Kasbon", 28);
                bodyTxt += "   " + makePrintRow("Uang Muka (DP):", formatRupiah(initDP), 28);
                if (subsequentPay > 0) {
                    bodyTxt += "   " + makePrintRow("Pelunasan/Cicil:", formatRupiah(subsequentPay), 28);
                    bodyTxt += "   " + makePrintRow("Total Terbayar:", formatRupiah(totalPaid), 28);
                }
                bodyTxt += "   " + makePrintRow("Sisa Hutang:", formatRupiah(debt), 28);
                bodyTxt += "   ----------------------------\n";

                // Tambahkan rincian pembayaran kasbon hari ini jika ada pelunasan untuk printout fisik
                if (trx.lastRepaymentCash !== undefined) {
                    bodyTxt += "   " + centerNormal("Bayar Pelunasan Hari Ini:") + "\n";
                    bodyTxt += "   " + makePrintRow("Metode:", trx.lastRepaymentMethod, 28);
                    if (trx.lastRepaymentMethod === 'Tunai') {
                        bodyTxt += "   " + makePrintRow("Uang Tunai:", formatRupiah(trx.lastRepaymentCash), 28);
                        bodyTxt += "   " + makePrintRow("Kembali:", formatRupiah(trx.lastRepaymentChange), 28);
                    } else {
                        bodyTxt += "   " + makePrintRow("Uang Bayar:", formatRupiah(trx.lastRepaymentCash), 28);
                    }
                    bodyTxt += "   ----------------------------\n";
                }
            } else {
                bodyTxt += "   " + makePrintRow(`Bayar (${trx.method}):`, formatRupiah(trx.cash || 0), 28);
                bodyTxt += "   " + makePrintRow("Kembali:", formatRupiah(trx.change || 0), 28);
                bodyTxt += "   ----------------------------\n";
            }

            const bodyBytes = new TextEncoder().encode(bodyTxt);

            const footerParts = [];
            // Centering Status Kasbon jika metodenya Kasbon
            if (trx.method === 'Kasbon') {
                const initDP = trx.initialDeposit || 0;
                const totalPaid = trx.cash || 0;
                const debt = trx.remainingDebt !== undefined ? trx.remainingDebt : Math.max(0, trx.total - totalPaid);
                
                footerParts.push(new TextEncoder().encode("   " + centerNormal(debt === 0 ? "STATUS: LUNAS" : "STATUS: BELUM LUNAS") + "\n"));
                footerParts.push(new TextEncoder().encode("   ----------------------------\n"));
            }

            // Pesan Penutup Struk (Center, normal size)
            footerParts.push(new TextEncoder().encode("   " + centerNormal(settings.receiptFooter || "Terima Kasih!") + "\n"));
            footerParts.push(new Uint8Array([0x0A, 0x0A, 0x0A, 0x0A])); // Feed lines for physical cutting

            // Gabungkan semua Uint8Array secara berurutan
            const allArrays = [];
            headerParts.forEach(p => allArrays.push(p));
            allArrays.push(bodyBytes);
            footerParts.forEach(p => allArrays.push(p));

            let totalLen = 0;
            allArrays.forEach(arr => totalLen += arr.length);

            const finalBytes = new Uint8Array(totalLen);
            let offset = 0;
            allArrays.forEach(arr => {
                finalBytes.set(arr, offset);
                offset += arr.length;
            });

            await this._writeChunksToPrinter(printChar, finalBytes);
            Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Struk berhasil dicetak', showConfirmButton: false, timer: 2000 });
        } catch (e) {
            if (e.name !== 'NotFoundError') Swal.fire('Gagal', e.message, 'error');
        }
    },

    // --- Hold / Saved Transactions ---
    updateSavedBadge: function() {
        const badge = document.getElementById('savedBadge');
        if (badge) {
            const count = this.state.savedTransactions.length;
            badge.textContent = count;
            if (count > 0) {
                badge.classList.remove('hidden');
            } else {
                badge.classList.add('hidden');
            }
        }
    },

    holdTransaction: function() {
        if (this.state.cart.length === 0) {
            return Swal.fire('Keranjang Kosong', 'Tidak ada barang di keranjang untuk disimpan!', 'warning');
        }

        Swal.fire({
            title: 'Simpan Transaksi',
            text: 'Masukkan nama pelanggan / catatan transaksi ini:',
            input: 'text',
            inputPlaceholder: 'Cth: Mas Budi / Meja 3',
            showCancelButton: true,
            confirmButtonText: 'Simpan',
            cancelButtonText: 'Batal',
            inputValidator: (value) => {
                if (!value || !value.trim()) {
                    return 'Nama pelanggan wajib diisi!';
                }
            }
        }).then((res) => {
            if (res.isConfirmed && res.value) {
                const customerName = res.value.trim();
                const now = new Date();
                const timeStr = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
                
                const savedItem = {
                    id: 'HOLD-' + Date.now(),
                    customer: customerName,
                    time: timeStr,
                    date: now.toLocaleDateString('id-ID'),
                    items: [...this.state.cart],
                    subtotal: this.state.tempSubtotal,
                    discount: this.state.tempDiscount,
                    total: this.state.tempTotal,
                    discountType: document.getElementById('discountType')?.value || 'nominal',
                    discountValue: document.getElementById('discountValue')?.value || 0
                };

                this.state.savedTransactions.push(savedItem);
                this.state.cart = [];
                this.saveData();
                this.updateCartUI();
                this.updateSavedBadge();

                Swal.fire({
                    toast: true,
                    position: 'top-end',
                    icon: 'success',
                    title: `Transaksi ${customerName} berhasil disimpan`,
                    showConfirmButton: false,
                    timer: 2000
                });
            }
        });
    },

    renderSavedTransactions: function() {
        const container = document.getElementById('savedListContainer');
        if (!container) return;

        this.updateSavedBadge();
        container.innerHTML = '';

        if (this.state.savedTransactions.length === 0) {
            container.innerHTML = `
                <div class="empty-state text-center" style="padding: 40px 20px; color: #94a3b8;">
                    <i class="fas fa-inbox" style="font-size: 3rem; margin-bottom: 12px;"></i>
                    <p style="font-size: 1.1rem; font-weight: 600; margin-bottom: 4px;">Tidak Ada Transaksi Tersimpan</p>
                    <p style="font-size: 0.9rem;">Transaksi yang Anda simpan sementara dari menu kasir akan muncul di sini.</p>
                </div>
            `;
            return;
        }

        this.state.savedTransactions.forEach((trx, idx) => {
            const card = document.createElement('div');
            card.className = 'card mb-1';
            card.style.position = 'relative';
            
            const itemCount = trx.items.reduce((sum, i) => sum + this._itemQtys(i).total, 0);
            const itemSummary = trx.items.map(i => {
                const iq = this._itemQtys(i);
                return `${i.Nama_Camilan} (${iq.paid}x${iq.bonus > 0 ? ` +${iq.bonus} bonus` : ''})`;
            }).join(', ');

            card.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
                    <div>
                        <h3 style="margin: 0; color: var(--primary); font-size: 1.1rem;"><i class="fas fa-user-clock"></i> ${trx.customer}</h3>
                        <span style="font-size: 0.8rem; color: #64748b;"><i class="far fa-clock"></i> ${trx.time} (${trx.date || 'Hari ini'})</span>
                    </div>
                    <div style="text-align: right;">
                        <span style="font-size: 1.1rem; font-weight: 700; color: #1e293b;">${formatRupiah(trx.total)}</span>
                        <div style="font-size: 0.8rem; color: #64748b;">${itemCount} item</div>
                    </div>
                </div>
                <div style="font-size: 0.85rem; color: #475569; background: #f8fafc; padding: 8px 12px; border-radius: 6px; margin-bottom: 12px; border: 1px solid #e2e8f0;">
                    ${itemSummary}
                </div>
                <div style="display: flex; gap: 8px; justify-content: flex-end;">
                    <button class="btn btn-sm btn-danger" onclick="app.deleteSavedTransaction(${idx})">
                        <i class="fas fa-trash"></i> Hapus
                    </button>
                    <button class="btn btn-sm btn-success" onclick="app.resumeSavedTransaction(${idx})">
                        <i class="fas fa-play"></i> Lanjutkan Transaksi
                    </button>
                </div>
            `;
            container.appendChild(card);
        });
    },

    resumeSavedTransaction: function(idx) {
        const item = this.state.savedTransactions[idx];
        if (!item) return;

        const doResume = () => {
            this.state.cart = [...item.items];
            this.state.savedTransactions.splice(idx, 1);
            this.saveData();
            this.updateSavedBadge();
            
            this.navigate('pos');
            
            if (item.discountType && document.getElementById('discountType')) {
                document.getElementById('discountType').value = item.discountType;
            }
            if (item.discountValue && document.getElementById('discountValue')) {
                document.getElementById('discountValue').value = item.discountValue;
            }
            this.updateCartUI();

            Swal.fire({
                toast: true,
                position: 'top-end',
                icon: 'success',
                title: `Transaksi ${item.customer} dimuat ke keranjang`,
                showConfirmButton: false,
                timer: 2000
            });
        };

        if (this.state.cart.length > 0) {
            Swal.fire({
                title: 'Ganti Keranjang?',
                text: 'Keranjang kasir saat ini berisi barang. Apakah Anda ingin menggantinya dengan transaksi tersimpan ini?',
                icon: 'warning',
                showCancelButton: true,
                confirmButtonText: 'Ya, Ganti',
                cancelButtonText: 'Batal'
            }).then(res => {
                if (res.isConfirmed) doResume();
            });
        } else {
            doResume();
        }
    },

    deleteSavedTransaction: function(idx) {
        const item = this.state.savedTransactions[idx];
        if (!item) return;

        Swal.fire({
            title: 'Hapus Transaksi Tersimpan?',
            text: `Hapus transaksi milik "${item.customer}"?`,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#d33',
            confirmButtonText: 'Ya, Hapus',
            cancelButtonText: 'Batal'
        }).then(res => {
            if (res.isConfirmed) {
                this.state.savedTransactions.splice(idx, 1);
                this.saveData();
                this.renderSavedTransactions();
                Swal.fire('Terhapus', 'Transaksi tersimpan berhasil dihapus', 'success');
            }
        });
    },

    getLogoEscPosBytes: function(base64Str) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                // Set total canvas width to exactly 384 pixels (48 bytes) for standard 58mm paper.
                // This centers the logo image natively without needing printer alignment commands.
                const canvasWidth = 384; 
                const logoWidth = 144; // Lebar logo yang pas (18 byte)
                const logoHeight = Math.round(img.height * (logoWidth / img.width));

                canvas.width = canvasWidth;
                canvas.height = logoHeight;

                const ctx = canvas.getContext('2d');
                // Fill background with white to avoid transparent pixel issues
                ctx.fillStyle = '#FFFFFF';
                ctx.fillRect(0, 0, canvasWidth, logoHeight);

                // Draw logo in the center of the 384px canvas, shifted 12px (1.5 bytes / 1 char) to the right
                // to compensate for the physical printer margin shift (matching the text offset).
                const xOffset = Math.floor((canvasWidth - logoWidth) / 2) + 12;
                ctx.drawImage(img, xOffset, 0, logoWidth, logoHeight);

                const imgData = ctx.getImageData(0, 0, canvasWidth, logoHeight);
                const pixels = imgData.data;
                const bytesWidth = canvasWidth / 8; // 48 bytes
                const escposData = [];

                // ESC/POS Command: GS v 0 m xL xH yL yH d1...dk
                escposData.push(0x1D, 0x76, 0x30, 0, bytesWidth & 0xFF, (bytesWidth >> 8) & 0xFF, logoHeight & 0xFF, (logoHeight >> 8) & 0xFF);

                for (let y = 0; y < logoHeight; y++) {
                    for (let x = 0; x < bytesWidth; x++) {
                        let byteVal = 0;
                        for (let bit = 0; bit < 8; bit++) {
                            const pixelX = x * 8 + bit;
                            const idx = (y * canvasWidth + pixelX) * 4;
                            const r = pixels[idx];
                            const g = pixels[idx + 1];
                            const b = pixels[idx + 2];
                            const alpha = pixels[idx + 3];

                            const gray = (r * 0.299 + g * 0.587 + b * 0.114);
                            const isBlack = (alpha >= 128 && gray < 128);

                            if (isBlack) {
                                byteVal |= (1 << (7 - bit));
                            }
                        }
                        escposData.push(byteVal);
                    }
                }
                resolve(new Uint8Array(escposData));
            };
            img.onerror = (err) => reject(err);
            img.src = base64Str;
        });
    }
};

document.addEventListener('DOMContentLoaded', () => app.init());
