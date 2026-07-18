// Konfigurasi GAS Web App URL
let GAS_URL = localStorage.getItem('pos_gas_url') || 'https://script.google.com/macros/s/AKfycbxShfwNUtXVeZB_hReUyB8y5oRplJp2y2j-p-eoyiOmZcx_Ad6dhQZFlMIEsD2xgEMc-Q/exec';

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

// Helper pembanding barcode tahan crash tipe data (String/Number) dan Null/Undefined
const compareBarcode = (a, b) => {
    if (a === null || a === undefined || b === null || b === undefined) return false;
    return a.toString().trim() === b.toString().trim();
};

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
        checkoutMode: 'new',
        repaymentTransactionId: null,
        settings: {
            shopName: 'Arummanis',
            shopAddress: 'Camilan Manis & Gurih',
            shopPhone: '08123456789',
            shopLogo: '🍬',
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
            if (event.state && event.state.view) {
                this.navigate(event.state.view, false);
            } else {
                this.navigate('dashboard', false);
            }
        });
        setTimeout(() => { isInitialLoad = false; }, 500);
        
        this.navigate(initialView, false);
        
        // Dummy data jika kosong (hanya untuk testing lokal sebelum konek GAS)
        if (this.state.products.length === 0 && GAS_URL === 'YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL') {
            this.state.products = [
                { Barcode_ID: "1111", Nama_Camilan: "Arummanis Original", Harga: 15000, Stok: 50, Status: "Ready" },
                { Barcode_ID: "2222", Nama_Camilan: "Arummanis Coklat", Harga: 17000, Stok: 30, Status: "Ready" }
            ];
            this.saveData();
            this.updateProductDatalist();
        }
    },

    // --- Core & Navigation ---
    navigate: function(viewId, pushHistory = true) {
        document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        
        const view = document.getElementById(`view-${viewId}`);
        if(view) {
            view.classList.remove('hidden');
            // Sedikit delay agar display block diaplikasikan sebelum animasi
            setTimeout(() => view.classList.add('active'), 10);
        }
        
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
            if(viewId === 'pos') { titleEl.textContent = 'Transaksi Baru'; this.updateCartUI(); }
            if(viewId === 'checkout') titleEl.textContent = 'Pembayaran';
            if(viewId === 'receipt') { titleEl.textContent = 'Struk Transaksi'; backBtn.classList.add('hidden'); }
            if(viewId === 'history') { titleEl.textContent = 'Histori Transaksi'; this.renderTransactionList('all', 'transactionListContainer', 'searchTransaction'); }
            if(viewId === 'debt') { titleEl.textContent = 'Belum Lunas (Kasbon)'; this.renderTransactionList('Kasbon', 'debtListContainer', 'searchDebt'); }
            if(viewId === 'products') { titleEl.textContent = 'Manajemen Produk'; this.renderProductList(); }
            if(viewId === 'settings') { titleEl.textContent = 'Pengaturan'; this.showSettingsForm(); }
        }
    },

    loadData: async function() {
        this.state.products = JSON.parse(localStorage.getItem('pos_products') || '[]');
        this.state.transactions = JSON.parse(localStorage.getItem('pos_transactions') || '[]');
        this.state.syncQueue = JSON.parse(localStorage.getItem('pos_queue') || '[]');
        
        const savedSettings = localStorage.getItem('pos_settings');
        if (savedSettings) {
            this.state.settings = JSON.parse(savedSettings);
        }
        
        this.updateProductDatalist();
        this.checkOfflineQueue();
        
        if (navigator.onLine && GAS_URL !== 'YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL') {
            try {
                const response = await fetch(`${GAS_URL}?action=getProducts`);
                const resData = await response.json();
                if (resData.status === 'success' && resData.data) {
                    this.state.products = resData.data;
                    this.saveData();
                    this.updateProductDatalist();
                }
            } catch (error) {
                console.error('Gagal memuat produk dari Sheets:', error);
            }
            // Sinkronisasi antrean offline yang tertunda setelah konek kembali
            this.syncData();
        }
    },
    saveData: function() {
        localStorage.setItem('pos_products', JSON.stringify(this.state.products));
        localStorage.setItem('pos_transactions', JSON.stringify(this.state.transactions));
        localStorage.setItem('pos_queue', JSON.stringify(this.state.syncQueue));
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

            const matches = this.state.products.filter(p => 
                (p.Barcode_ID && p.Barcode_ID.toLowerCase().includes(term)) || 
                (p.Nama_Camilan && p.Nama_Camilan.toLowerCase().includes(term))
            );

            if (matches.length === 0) {
                suggestionsBox.innerHTML = '<div class="suggestion-item" style="color: #999; cursor: default;">Produk tidak ditemukan</div>';
                suggestionsBox.classList.remove('hidden');
                return;
            }

            suggestionsBox.innerHTML = '';
            matches.slice(0, 8).forEach(p => { // Batasi maksimal 8 saran untuk performa terbaik di HP
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
                    this.addToCart(p);
                    manualInput.value = '';
                    suggestionsBox.classList.add('hidden');
                    suggestionsBox.innerHTML = '';
                });
                suggestionsBox.appendChild(item);
            });
            suggestionsBox.classList.remove('hidden');
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
                manualInput.dispatchEvent(new Event('input'));
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
        document.getElementById('confirmCheckoutBtn').addEventListener('click', () => {
            if (this.state.checkoutMode === 'repayment') {
                this.processRepayment();
            } else {
                this.processTransaction();
            }
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

        document.addEventListener('click', (e) => {
            if (!restockInput.contains(e.target) && !restockSuggestions.contains(e.target)) {
                restockSuggestions.classList.add('hidden');
            }
        });
    },

    updateProductDatalist: function() {
        const dl = document.getElementById('productList');
        if(!dl) return;
        dl.innerHTML = '';
        this.state.products.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.Barcode_ID;
            opt.textContent = `${p.Nama_Camilan} - Rp ${p.Harga} (Stok: ${p.Stok})`;
            dl.appendChild(opt);
        });
    },

    handleManualAdd: function() {
        const input = document.getElementById('manualBarcode').value.trim();
        if(!input) return;
        
        const p = this.state.products.find(x => x.Barcode_ID == input || x.Nama_Camilan.toLowerCase().includes(input.toLowerCase()));
        if(p) {
            this.addToCart(p);
            document.getElementById('manualBarcode').value = '';
            document.getElementById('searchSuggestions').classList.add('hidden');
        } else {
            Swal.fire('Error', 'Produk tidak ditemukan!', 'error');
        }
    },

    addToCart: function(product) {
        const existing = this.state.cart.find(x => compareBarcode(x.Barcode_ID, product.Barcode_ID));
        if(existing) {
            existing.qty += 1;
        } else {
            this.state.cart.push({ ...product, qty: 1, editPrice: parseInt(product.Harga) });
        }
        this.updateCartUI();
        Swal.fire({ toast:true, position:'top-end', icon:'success', title:`${product.Nama_Camilan} ditambahkan`, showConfirmButton:false, timer:1500 });
    },

    updateCartItem: function(barcode, field, value) {
        const item = this.state.cart.find(x => compareBarcode(x.Barcode_ID, barcode));
        if(item) {
            if(field === 'qty') {
                const q = parseInt(value) || 1;
                if (q <= 0) {
                    this.removeCartItem(barcode);
                    return;
                } else {
                    item.qty = q;
                }
            }
            if(field === 'price') item.editPrice = parseInt(value) || 0;
            this.updateCartUI();
        }
    },

    updateCartItemVal: function(barcode, field, el) {
        const item = this.state.cart.find(x => compareBarcode(x.Barcode_ID, barcode));
        if (item) {
            const val = parseInt(el.value) || 0;
            if (field === 'price') {
                item.editPrice = val;
            } else if (field === 'qty') {
                item.qty = val;
            }
            
            // Hitung ulang total tanpa rebuild list DOM
            let subtotal = 0;
            let count = 0;
            this.state.cart.forEach(i => {
                subtotal += i.editPrice * i.qty;
                count += i.qty;
            });
            
            // Update subtotal per baris
            const rowTotalEl = el.closest('.cart-item').querySelector('.item-header span:last-child');
            if (rowTotalEl) rowTotalEl.textContent = formatRupiah(item.editPrice * item.qty);
            
            // Hitung Diskon
            const dType = document.getElementById('discountType').value;
            const dVal = parseInt(document.getElementById('discountValue').value) || 0;
            let discountAmount = 0;
            if (dType === 'nominal') discountAmount = dVal;
            if (dType === 'percent') discountAmount = subtotal * (dVal / 100);
            const grandTotal = Math.max(0, subtotal - discountAmount);
            
            document.getElementById('itemCount').textContent = `${count} item`;
            document.getElementById('subtotalPrice').textContent = formatRupiah(subtotal);
            document.getElementById('totalPrice').textContent = formatRupiah(grandTotal);
            
            this.state.tempSubtotal = subtotal;
            this.state.tempDiscount = discountAmount;
            this.state.tempTotal = grandTotal;
            this.saveData();
        }
    },

    cleanCartItemInput: function(barcode, field, el) {
        const item = this.state.cart.find(x => compareBarcode(x.Barcode_ID, barcode));
        if (item) {
            if (field === 'qty') {
                const val = parseInt(el.value) || 0;
                if (val <= 0) {
                    this.removeCartItem(barcode);
                }
            }
        }
    },

    removeCartItem: function(barcode) {
        this.state.cart = this.state.cart.filter(x => !compareBarcode(x.Barcode_ID, barcode));
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
                subtotal += item.editPrice * item.qty;
                count += item.qty;
                
                const div = document.createElement('div');
                div.className = 'cart-item';
                div.innerHTML = `
                    <div class="item-header">
                        <span>${item.Nama_Camilan}</span>
                        <span>${formatRupiah(item.editPrice * item.qty)}</span>
                    </div>
                    <div class="item-editor">
                        <label>Rp</label>
                        <input type="number" value="${item.editPrice}" oninput="app.updateCartItemVal('${item.Barcode_ID}', 'price', this)" onblur="app.cleanCartItemInput('${item.Barcode_ID}', 'price', this)">
                        <label>x</label>
                        <div class="qty-controls">
                            <button class="qty-btn" onclick="app.updateCartItem('${item.Barcode_ID}', 'qty', ${item.qty - 1})">-</button>
                            <input type="number" class="qty-input" value="${item.qty}" oninput="app.updateCartItemVal('${item.Barcode_ID}', 'qty', this)" onblur="app.cleanCartItemInput('${item.Barcode_ID}', 'qty', this)">
                            <button class="qty-btn" onclick="app.updateCartItem('${item.Barcode_ID}', 'qty', ${item.qty + 1})">+</button>
                            <button class="qty-btn del" onclick="app.removeCartItem('${item.Barcode_ID}')"><i class="fas fa-trash"></i></button>
                        </div>
                    </div>
                `;
                container.appendChild(div);
            });
        }

        // Hitung Diskon
        const dType = document.getElementById('discountType').value;
        const dVal = parseInt(document.getElementById('discountValue').value) || 0;
        let discountAmount = 0;
        
        if (dType === 'nominal') discountAmount = dVal;
        if (dType === 'percent') discountAmount = subtotal * (dVal / 100);
        
        const grandTotal = Math.max(0, subtotal - discountAmount);
        
        document.getElementById('itemCount').textContent = `${count} item`;
        document.getElementById('subtotalPrice').textContent = formatRupiah(subtotal);
        document.getElementById('totalPrice').textContent = formatRupiah(grandTotal);
        
        this.state.tempSubtotal = subtotal;
        this.state.tempDiscount = discountAmount;
        this.state.tempTotal = grandTotal;
    },

    // --- Checkout Logic ---
    prepareCheckout: function() {
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
        
        // Reset tombol confirm checkout dari status loading
        const confirmBtn = document.getElementById('confirmCheckoutBtn');
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Simpan Transaksi';

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

        // Reset tombol confirm
        const confirmBtn = document.getElementById('confirmCheckoutBtn');
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Simpan Pembayaran';

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

        this.navigate('checkout');
    },

    cancelCheckout: function() {
        if (this.state.checkoutMode === 'repayment') {
            this.navigate('debt');
        } else {
            this.navigate('pos');
        }
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
        const confirmBtn = document.getElementById('confirmCheckoutBtn');
        if (confirmBtn.disabled) return;
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Memproses...';

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
        
        if (method === 'Kasbon' && !customer) {
            Swal.fire('Gagal', 'Nama Pelanggan wajib diisi untuk transaksi Kasbon!', 'warning');
            return;
        }
        if (method === 'Tunai' && cash < this.state.tempTotal) {
            Swal.fire('Gagal', 'Uang tunai kurang dari total belanja!', 'warning');
            return;
        }

        // Mencegah klik ganda (race condition) yang memicu duplikasi transaksi Rp 0
        const confirmBtn = document.getElementById('confirmCheckoutBtn');
        if (confirmBtn.disabled) return;
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Memproses...';

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

        // Update local stock
        trx.items.forEach(item => {
            const p = this.state.products.find(x => compareBarcode(x.Barcode_ID, item.Barcode_ID));
            if(p) {
                p.Stok = Math.max(0, parseInt(p.Stok) - item.qty);
                if(p.Stok === 0) p.Status = 'Habis';

                // Kurangi stok batch lokal secara FIFO
                if (p.batches && Array.isArray(p.batches)) {
                    let qtyToDeduct = parseInt(item.qty);
                    // Urutkan batch dari expired terdekat ke terjauh (FIFO)
                    p.batches.sort((a, b) => new Date(convertDateToPickerFormat(a.expiredDate)) - new Date(convertDateToPickerFormat(b.expiredDate)));
                    for (let b = 0; b < p.batches.length; b++) {
                        if (qtyToDeduct <= 0) break;
                        const batch = p.batches[b];
                        const deduct = Math.min(qtyToDeduct, batch.stokSisa);
                        batch.stokSisa -= deduct;
                        qtyToDeduct -= deduct;
                    }
                    // Hanya pertahankan batch yang masih memiliki stok sisa
                    p.batches = p.batches.filter(b => b.stokSisa > 0);
                }
            }
        });

        // Insert at beginning
        this.state.transactions.unshift(trx);
        this.state.syncQueue.push({ type: 'transaction', data: trx });
        this.state.lastTransaction = trx;
        this.saveData();

        // Kosongkan keranjang
        this.state.cart = [];
        document.getElementById('discountValue').value = '';
        this.updateCartUI();
        
        this.showReceipt(trx);
        this.syncData();
    },

    showReceipt: function(trx) {
        this.navigate('receipt');
        this.state.lastTransaction = trx; // untuk keperluan print
        const rc = document.getElementById('receiptContent');
        const settings = this.state.settings || { shopName: 'Arummanis', shopLogo: '🍬', cashierName: 'Admin' };
        
        let logoHtml = `<h2>🍬 ${settings.shopName || 'ARUMMANIS'}</h2>`;
        if (settings.shopLogo && settings.shopLogo.startsWith('data:image')) {
            logoHtml = `<img src="${settings.shopLogo}" style="max-height: 50px; max-width: 100px; display: block; margin: 0 auto 10px; object-fit: contain;">
                        <h2 style="margin-top: 5px;">${settings.shopName || 'ARUMMANIS'}</h2>`;
        }
        
        let html = `
            ${logoHtml}
            ${settings.shopAddress ? `<div style="text-align: center; font-size: 0.8rem; color: #64748b; margin-top: -5px; margin-bottom: 10px;">${settings.shopAddress}</div>` : ''}
            <div class="r-row"><span>No:</span> <span>${trx.id}</span></div>
            <div class="r-row"><span>Tgl:</span> <span>${new Date(trx.timestamp).toLocaleString('id-ID')}</span></div>
            <div class="r-row"><span>Kasir:</span> <span>${settings.cashierName || 'Admin'}</span></div>
            <div class="r-row"><span>Pelanggan:</span> <span>${trx.customer}</span></div>
            <hr>
        `;
        
        if (trx.items && trx.items.length > 0) {
            trx.items.forEach(i => {
                html += `
                    <div>${i.Nama_Camilan}</div>
                    <div class="r-row"><span>${i.qty} x ${formatRupiah(i.editPrice)}</span> <span>${formatRupiah(i.qty * i.editPrice)}</span></div>
                `;
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
        }
        
        html += `<hr><div class="text-center">${settings.receiptFooter || 'Terima Kasih!'}</div>`;
        rc.innerHTML = html;
    },

    newTransaction: function() {
        this.state.cart = [];
        document.getElementById('discountValue').value = '';
        this.updateCartUI();
        this.navigate('pos');
    },

    editLastTransaction: function() {
        if(!this.state.lastTransaction) return;
        const trx = this.state.lastTransaction;
        
        Swal.fire({
            title: 'Edit Transaksi Ini?',
            text: 'Ini akan membatalkan transaksi sebelumnya dan mengembalikan barang ke keranjang. Lanjutkan?',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'Ya, Edit'
        }).then((res) => {
            if(res.isConfirmed) {
                // Kembalikan stok
                trx.items.forEach(item => {
                    const p = this.state.products.find(x => compareBarcode(x.Barcode_ID, item.Barcode_ID));
                    if(p) p.Stok = parseInt(p.Stok) + item.qty;
                });
                
                // Hapus dari histori dan antrean sync
                this.state.transactions = this.state.transactions.filter(t => t.id !== trx.id);
                this.state.syncQueue = this.state.syncQueue.filter(q => !(q.type==='transaction' && q.data.id === trx.id));
                
                // Masukkan ke keranjang lagi
                this.state.cart = [...trx.items];
                this.saveData();
                this.navigate('pos');
            }
        });
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
                        <div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 10px; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; font-size: 0.9rem;">
                            <div>
                                <strong style="color: var(--primary);">Stok ${idx + 1}:</strong> ${b.stokSisa} pcs
                                <div style="font-size: 0.8rem; color: #64748b; margin-top: 2px;">Exp: ${b.expiredDate || '—'}</div>
                            </div>
                            <div style="font-size: 0.85rem; font-weight: 600; color: #475569;">
                                Modal: ${formatRupiah(b.hargaBeli)}
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
        document.getElementById('restockSelectedName').textContent = product.Nama_Camilan;
        document.getElementById('restockSelectedCurrentStock').textContent = `${product.Stok} pcs`;
        
        // Prefill modal / harga beli untuk menghemat waktu input
        document.getElementById('restockPriceBuy').value = product.Harga_Beli || product.Harga_Modal || '';
        document.getElementById('restockSelectedDetails').classList.remove('hidden');
    },

    saveRestock: function() {
        const barcode = document.getElementById('restockSelectedBarcode').value;
        const qty = parseInt(document.getElementById('restockQty').value) || 0;
        const priceBuy = parseInt(document.getElementById('restockPriceBuy').value) || 0;
        const expiredRaw = document.getElementById('restockExpired').value;
        const expired = convertDateToSheetFormat(expiredRaw);

        if (!barcode) return Swal.fire('Error', 'Silakan pilih produk terlebih dahulu!', 'warning');
        if (qty <= 0) return Swal.fire('Error', 'Jumlah stok masuk harus lebih dari 0!', 'warning');
        if (priceBuy <= 0) return Swal.fire('Error', 'Harga beli modal harus lebih dari 0!', 'warning');

        // Cari produk lokal untuk diupdate
        const p = this.state.products.find(x => compareBarcode(x.Barcode_ID, barcode));
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
            playBeep();
            if ("vibrate" in navigator) navigator.vibrate([100, 50, 100]);
            
            // Cari produk berdasarkan barcode yang discan
            const product = this.state.products.find(x => compareBarcode(x.Barcode_ID, text));
            if (product) {
                this.selectRestockProduct(product);
                Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: `Produk: ${product.Nama_Camilan}`, showConfirmButton: false, timer: 1500 });
            } else {
                Swal.fire('Gagal', `Barcode "${text}" belum terdaftar! Silakan daftarkan produk baru terlebih dahulu.`, 'warning');
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
    saveProduct: function() {
        const editIndex = document.getElementById('prodFormId').value;
        const isEdit = editIndex !== '' && editIndex !== null && editIndex !== undefined;
        const newBarcode = document.getElementById('prodFormBarcode').value.trim();
        const name = document.getElementById('prodFormName').value.trim();
        const price = parseInt(document.getElementById('prodFormPrice').value) || 0;
        const stock = parseInt(document.getElementById('prodFormStock').value) || 0;
        
        const priceBuy = parseInt(document.getElementById('prodFormPriceBuy').value) || 0;
        const expiredRaw = document.getElementById('prodFormExpired').value;
        const expired = convertDateToSheetFormat(expiredRaw);
        
        if(!name) return Swal.fire('Error', 'Nama Produk wajib diisi!', 'error');

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
            
            // Pertahankan _sheetRow, batches, dan Stok lama
            product._sheetRow = oldProduct._sheetRow;
            product.batches = oldProduct.batches || [];
            product.Stok = oldProduct.Stok || 0;
            product.Status = product.Stok > 0 ? 'Ready' : 'Habis';
            
            this.state.products[idx] = product;
            
            this.state.syncQueue.push({ 
                type: 'product', 
                data: { ...product, oldBarcode: oldProduct.Barcode_ID || '' } 
            });
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
                if (p.Barcode_ID) {
                    this.state.syncQueue.push({ type: 'delete_product', data: { Barcode_ID: p.Barcode_ID, Nama_Camilan: p.Nama_Camilan, _sheetRow: p._sheetRow } });
                }
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
            playBeep();
            if ("vibrate" in navigator) navigator.vibrate([100, 50, 100]);
            document.getElementById('prodFormBarcode').value = text;
            this.stopProductScanner();
            Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: `Barcode: ${text}`, showConfirmButton: false, timer: 1500 });
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
                }
            } catch (error) {
                console.error('Gagal sync (network):', error);
                break; // Berhenti di network failure pertama
            }
        }
        
        if (successCount > 0) {
            document.getElementById('syncText').textContent = `${successCount} data tersinkronisasi!`;
            setTimeout(() => this.checkOfflineQueue(), 2000);
        } else {
            this.checkOfflineQueue();
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
            title: 'Hapus Semua Data Lokal?',
            text: 'Tindakan ini akan mengosongkan transaksi offline, produk ter-cache, dan pengaturan lokal di perangkat ini. Data di Google Sheets akan tetap aman.',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#d33',
            confirmButtonText: 'Ya, Hapus Semua!',
            cancelButtonText: 'Batal'
        }).then((result) => {
            if (result.isConfirmed) {
                localStorage.clear();
                Swal.fire('Terhapus', 'Semua database lokal telah dibersihkan. Aplikasi akan dimuat ulang.', 'success').then(() => {
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
                    Swal.fire('Perhatian', `Sinkronisasi selesai dengan ${this.state.syncQueue.length} data tersisa (kemungkinan Apps Script perlu di-deploy ulang).`, 'warning');
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
            const now = Date.now();
            
            // Cooldown 1.5 detik HANYA jika menscan barcode yang SAMA berturut-turut.
            // Barcode BERBEDA bisa discan secara instan tanpa delay/pause.
            if (text === this.state.lastScannedBarcode && (now - this.state.lastScannedTime < 1500)) {
                return;
            }
            
            this.state.lastScannedBarcode = text;
            this.state.lastScannedTime = now;
            
            playBeep();
            if ("vibrate" in navigator) navigator.vibrate(80);
            
            const p = this.state.products.find(x => compareBarcode(x.Barcode_ID, text));
            if(p) {
                this.addToCart(p);
            } else {
                Swal.fire({
                    toast: true,
                    position: 'top-end',
                    icon: 'error',
                    title: `Barcode "${text}" tidak ditemukan`,
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
        const trx = this.state.lastTransaction;
        if (!trx) return;
        
        const settings = this.state.settings || { shopName: 'Arummanis', shopLogo: '🍬', cashierName: 'Admin' };
        let text = `${settings.shopLogo || '🍬'} *${(settings.shopName || 'ARUMMANIS').toUpperCase()}*\n`;
        if (settings.shopAddress) text += `📍 ${settings.shopAddress}\n`;
        text += `━━━━━━━━━━━━━━━━━━━━\n`;
        text += `No   : ${trx.id}\n`;
        text += `Tgl  : ${new Date(trx.timestamp).toLocaleString('id-ID')}\n`;
        text += `Kasir: ${settings.cashierName || 'Admin'}\n`;
        text += `Pel  : ${trx.customer}\n`;
        text += `━━━━━━━━━━━━━━━━━━━━\n`;
        trx.items.forEach(i => {
            text += `${i.Nama_Camilan}\n  ${i.qty} x ${formatRupiah(i.editPrice)} = ${formatRupiah(i.qty * i.editPrice)}\n`;
        });
        text += `━━━━━━━━━━━━━━━━━━━━\n`;
        text += `Subtotal : ${formatRupiah(trx.subtotal)}\n`;
        if (trx.discount > 0) text += `Diskon   : -${formatRupiah(trx.discount)}\n`;
        text += `*TOTAL   : ${formatRupiah(trx.total)}*\n`;
        if (trx.method === 'Tunai') {
            text += `Bayar    : Tunai\n`;
            text += `Tunai    : ${formatRupiah(trx.cash)}\n`;
            text += `Kembali  : ${formatRupiah(trx.change)}\n`;
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
        // Coba ambil device yang sudah pernah di-pair sebelumnya saat page load
        if (navigator.bluetooth && navigator.bluetooth.getDevices) {
            try {
                const devices = await navigator.bluetooth.getDevices();
                if (devices && devices.length > 0) {
                    this.state.bluetoothDevice = devices[0];
                    this.setupBluetoothDisconnectListener(devices[0]);
                    console.log("Preloaded paired Bluetooth device:", devices[0].name);
                }
            } catch (err) {
                console.error("Gagal preloading paired devices:", err);
            }
        }
    },

    getBluetoothDevice: async function() {
        // 1. Gunakan device yang sudah tersimpan di state (baik dari preload maupun pairing sebelumnya)
        if (this.state.bluetoothDevice) {
            return this.state.bluetoothDevice;
        }

        // 2. Jika belum ada, minta user pairing lewat popup browser. 
        // Wajib dipanggil sinkron di awal user gesture click (tanpa await sebelumnya) agar tidak diblokir browser.
        if (!navigator.bluetooth) throw new Error('Web Bluetooth tidak didukung di browser ini.');
        const device = await navigator.bluetooth.requestDevice({
            acceptAllDevices: true,
            optionalServices: ['000018f0-0000-1000-8000-00805f9b34fb', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '0000fee7-0000-1000-8000-00805f9b34fb']
        });
        
        if (device) {
            this.state.bluetoothDevice = device;
            this.setupBluetoothDisconnectListener(device);
        }
        return device;
    },

    setupBluetoothDisconnectListener: function(device) {
        device.addEventListener('gattserverdisconnected', () => {
            console.log('Koneksi printer Bluetooth terputus.');
            this.state.bluetoothChar = null;
        });
    },

    connectToPrinter: async function() {
        const device = await this.getBluetoothDevice();
        if (!device) throw new Error('Printer tidak dipilih.');

        // Jika printer masih tersambung dan karakteristik tulis siap, gunakan langsung (instant print)
        if (device.gatt.connected && this.state.bluetoothChar) {
            return this.state.bluetoothChar;
        }

        // Hubungkan kembali ke GATT Server (tanpa popup pairing browser ulang)
        Swal.fire({ title: 'Menghubungkan ke Printer...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        const server = await device.gatt.connect();
        
        let printChar = null;
        const knownServices = ['000018f0-0000-1000-8000-00805f9b34fb', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '0000fee7-0000-1000-8000-00805f9b34fb'];
        
        // Fast-path: Coba dapatkan primary service yang dikenal secara langsung (Sangat cepat <1 detik)
        for (const serviceUuid of knownServices) {
            try {
                const service = await server.getPrimaryService(serviceUuid);
                const chars = await service.getCharacteristics();
                printChar = chars.find(c => c.properties.write || c.properties.writeWithoutResponse);
                if (printChar) break;
            } catch (e) {
                // Lanjut ke UUID berikutnya jika service tidak ada
                continue;
            }
        }
        
        // Slow-path fallback: Jika fast-path gagal, scan seluruh primary service (kompatibilitas 100% printer lain)
        if (!printChar) {
            console.log("Fast-path Bluetooth gagal, memindai seluruh service...");
            const services = await server.getPrimaryServices();
            for (const s of services) {
                const chars = await s.getCharacteristics();
                printChar = chars.find(c => c.properties.write || c.properties.writeWithoutResponse);
                if (printChar) break;
            }
        }
        
        if (!printChar) throw new Error('Karakteristik Bluetooth untuk Print tidak ditemukan.');
        
        this.state.bluetoothChar = printChar;
        Swal.close();
        return printChar;
    },

    printReceipt: async function() {
        const trx = this.state.lastTransaction;
        if (!trx) return;
        
        try {
            const printChar = await this.connectToPrinter();

            const ESC = '\x1B'; const textBoldOn = ESC + 'E\x01'; const textBoldOff = ESC + 'E\x00';
            let txt = ESC + '@' + ESC + 'a\x00'; // Set default left alignment secara eksplisit
            
            const settings = this.state.settings || { shopName: 'Arummanis', shopAddress: 'Camilan Manis & Gurih', cashierName: 'Admin' };
            
            // Header struk (Dibuat center manual dengan lebar 28 karakter + 3 spasi margin untuk mengimbangi pergeseran fisik printer)
            txt += textBoldOn + "   " + makeCenterRow(settings.shopName || "ARUMMANIS", 28) + textBoldOff;
            if (settings.shopAddress) {
                txt += "   " + makeCenterRow(settings.shopAddress, 28);
            }
            if (settings.shopPhone) {
                txt += "   " + makeCenterRow("Telp: " + settings.shopPhone, 28);
            }
            txt += "   ----------------------------\n"; // 3 spasi + 28 strip
            
            // Metadata transaksi
            txt += `   No   : ${trx.id}\n   Tgl  : ${new Date(trx.timestamp).toLocaleString('id-ID')}\n   Kasir: ${settings.cashierName || 'Admin'}\n   Pel  : ${trx.customer}\n`;
            txt += "   ----------------------------\n";
            
            // Daftar barang belanjaan
            trx.items.forEach(i => {
                txt += `   ${i.Nama_Camilan}\n`;
                const left = `${i.qty} x ${formatRupiah(i.editPrice)}`;
                const right = formatRupiah(i.qty * i.editPrice);
                txt += "   " + makePrintRow(left, right, 28);
            });
            txt += "   ----------------------------\n";
            
            // Ringkasan Total
            txt += "   " + makePrintRow("Subtotal:", formatRupiah(trx.subtotal), 28);
            txt += "   " + makePrintRow("Diskon:", "-" + formatRupiah(trx.discount || 0), 28);
            txt += textBoldOn + "   " + makePrintRow("TOTAL:", formatRupiah(trx.total), 28) + textBoldOff;
            txt += "   ----------------------------\n";
            
            // Info Pembayaran
            if (trx.method === 'Kasbon') {
                const initDP = trx.initialDeposit || 0;
                const totalPaid = trx.cash || 0;
                const subsequentPay = totalPaid - initDP;
                const debt = trx.remainingDebt !== undefined ? trx.remainingDebt : Math.max(0, trx.total - totalPaid);
                
                txt += "   " + makePrintRow("Metode:", "Kasbon", 28);
                txt += "   " + makePrintRow("Uang Muka (DP):", formatRupiah(initDP), 28);
                if (subsequentPay > 0) {
                    txt += "   " + makePrintRow("Pelunasan/Cicil:", formatRupiah(subsequentPay), 28);
                    txt += "   " + makePrintRow("Total Terbayar:", formatRupiah(totalPaid), 28);
                }
                txt += "   " + makePrintRow("Sisa Hutang:", formatRupiah(debt), 28);
                txt += "   ----------------------------\n";
                txt += textBoldOn + "   " + makeCenterRow(debt === 0 ? "STATUS: LUNAS" : "STATUS: BELUM LUNAS", 28) + textBoldOff;
            } else {
                txt += "   " + makePrintRow(`Bayar (${trx.method}):`, formatRupiah(trx.cash || 0), 28);
                txt += "   " + makePrintRow("Kembali:", formatRupiah(trx.change || 0), 28);
            }
            
            txt += "   ----------------------------\n";
            txt += "   " + makeCenterRow(settings.receiptFooter || "Terima Kasih!", 28) + "\n\n";

            let logoBytes = null;
            if (settings.shopLogo && settings.shopLogo.startsWith('data:image')) {
                try {
                    logoBytes = await this.getLogoEscPosBytes(settings.shopLogo);
                } catch (logoErr) {
                    console.error("Gagal mengonversi logo ke ESC/POS:", logoErr);
                }
            }

            const data = new TextEncoder().encode(txt);
            let finalBytes = data;
            if (logoBytes) {
                const centerAlignCmd = new Uint8Array([0x1B, 0x61, 1]);
                const leftAlignCmd = new Uint8Array([0x1B, 0x61, 0]);
                const feedLines = new Uint8Array([0x0A, 0x0A, 0x0A]);
                
                const merged = new Uint8Array(data.length + centerAlignCmd.length + logoBytes.length + leftAlignCmd.length + feedLines.length);
                merged.set(data);
                merged.set(centerAlignCmd, data.length);
                merged.set(logoBytes, data.length + centerAlignCmd.length);
                merged.set(leftAlignCmd, data.length + centerAlignCmd.length + logoBytes.length);
                merged.set(feedLines, data.length + centerAlignCmd.length + logoBytes.length + leftAlignCmd.length);
                finalBytes = merged;
            } else {
                const feedLines = new Uint8Array([0x0A, 0x0A, 0x0A]);
                const merged = new Uint8Array(data.length + feedLines.length);
                merged.set(data);
                merged.set(feedLines, data.length);
                finalBytes = merged;
            }

            for (let i = 0; i < finalBytes.length; i += 256) {
                await printChar.writeValue(finalBytes.slice(i, i + 256));
                await new Promise(r => setTimeout(r, 50));
            }
            Swal.fire('Berhasil', 'Struk dicetak', 'success');
        } catch (e) {
            if (e.name !== 'NotFoundError') Swal.fire('Gagal', e.message, 'error');
        }
    },

    getLogoEscPosBytes: function(base64Str) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const width = 128;
                const height = Math.round(img.height * (width / img.width));
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                const imgData = ctx.getImageData(0, 0, width, height);
                const pixels = imgData.data;
                const bytesWidth = width / 8;
                const escposData = [];
                escposData.push(0x1D, 0x76, 0x30, 0, bytesWidth & 0xFF, (bytesWidth >> 8) & 0xFF, height & 0xFF, (height >> 8) & 0xFF);
                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < bytesWidth; x++) {
                        let byteVal = 0;
                        for (let bit = 0; bit < 8; bit++) {
                            const pixelX = x * 8 + bit;
                            const idx = (y * width + pixelX) * 4;
                            const gray = (pixels[idx] * 0.299 + pixels[idx + 1] * 0.587 + pixels[idx + 2] * 0.114);
                            if (pixels[idx + 3] >= 128 && gray < 128) byteVal |= (1 << (7 - bit));
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
