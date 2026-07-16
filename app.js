// Konfigurasi GAS Web App URL
const GAS_URL = 'https://script.google.com/macros/s/AKfycbxShfwNUtXVeZB_hReUyB8y5oRplJp2y2j-p-eoyiOmZcx_Ad6dhQZFlMIEsD2xgEMc-Q/exec';

// Utility format uang
const formatRupiah = (number) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(parseFloat(number) || 0);

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
        lastTransaction: null,
        tempSubtotal: 0,
        tempDiscount: 0,
        tempTotal: 0,
        productScanner: null
    },

    init: async function() {
        this.initServiceWorker();
        this.setupNetworkListeners();
        await this.loadData();
        this.bindEvents();
        
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
            if(viewId === 'receipt') { titleEl.textContent = 'Struk Transaksi'; backBtn.classList.add('hidden'); } // Sembunyikan back di receipt agar dipaksa pakai tombol yang ada
            if(viewId === 'history') { titleEl.textContent = 'Histori Transaksi'; this.renderTransactionList('all'); }
            if(viewId === 'debt') { titleEl.textContent = 'Belum Lunas (Kasbon)'; this.renderTransactionList('Kasbon'); }
            if(viewId === 'products') { titleEl.textContent = 'Manajemen Produk'; this.renderProductList(); }
        }
    },

    loadData: async function() {
        this.state.products = JSON.parse(localStorage.getItem('pos_products') || '[]');
        this.state.transactions = JSON.parse(localStorage.getItem('pos_transactions') || '[]');
        this.state.syncQueue = JSON.parse(localStorage.getItem('pos_queue') || '[]');
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
        document.getElementById('manualBarcode').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.handleManualAdd();
        });

        document.getElementById('discountType').addEventListener('change', () => this.updateCartUI());
        document.getElementById('discountValue').addEventListener('input', () => this.updateCartUI());

        document.getElementById('processCheckoutBtn').addEventListener('click', () => {
            if(this.state.cart.length > 0) this.prepareCheckout();
        });

        document.getElementById('checkoutMethod').addEventListener('change', (e) => {
            const cashSection = document.getElementById('cashInputSection');
            if (e.target.value === 'Tunai') cashSection.classList.remove('hidden');
            else cashSection.classList.add('hidden');
            this.calculateChange();
        });
        document.getElementById('checkoutCash').addEventListener('input', () => this.calculateChange());
        document.getElementById('confirmCheckoutBtn').addEventListener('click', () => this.processTransaction());

        document.getElementById('printReceiptBtn').addEventListener('click', () => this.printReceipt());
        document.getElementById('editTransactionBtn').addEventListener('click', () => this.editLastTransaction());
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
        } else {
            Swal.fire('Error', 'Produk tidak ditemukan!', 'error');
        }
    },

    addToCart: function(product) {
        if(product.Status === 'Habis' || parseInt(product.Stok) <= 0) {
            Swal.fire('Stok Habis', `${product.Nama_Camilan} sedang kosong.`, 'warning');
            return;
        }

        const existing = this.state.cart.find(x => compareBarcode(x.Barcode_ID, product.Barcode_ID));
        if(existing) {
            if(existing.qty >= parseInt(product.Stok)) {
                Swal.fire('Stok Terbatas', `Hanya tersedia ${product.Stok} item`, 'warning');
                return;
            }
            existing.qty += 1;
        } else {
            this.state.cart.push({ ...product, qty: 1, editPrice: parseInt(product.Harga) });
        }
        this.updateCartUI();
        Swal.fire({ toast:true, position:'top-end', icon:'success', title:`${product.Nama_Camilan} masuk keranjang`, showConfirmButton:false, timer:1000 });
    },

    updateCartItem: function(barcode, field, value) {
        const item = this.state.cart.find(x => compareBarcode(x.Barcode_ID, barcode));
        if(item) {
            if(field === 'qty') {
                const q = parseInt(value) || 1;
                const p = this.state.products.find(x => compareBarcode(x.Barcode_ID, barcode));
                if(q > parseInt(p.Stok)) {
                    Swal.fire('Stok Terbatas', `Maksimal ${p.Stok}`, 'warning');
                    item.qty = parseInt(p.Stok);
                } else if (q <= 0) {
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

    removeCartItem: function(barcode) {
        this.state.cart = this.state.cart.filter(x => !compareBarcode(x.Barcode_ID, barcode));
        this.updateCartUI();
    },

    updateCartUI: function() {
        const container = document.getElementById('cartItems');
        const emptyMsg = document.getElementById('emptyCartMessage');
        container.innerHTML = '';
        
        let subtotal = 0;
        let count = 0;

        if (this.state.cart.length === 0) {
            container.appendChild(emptyMsg);
            emptyMsg.classList.remove('hidden');
            document.getElementById('processCheckoutBtn').disabled = true;
        } else {
            emptyMsg.classList.add('hidden');
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
                        <input type="number" value="${item.editPrice}" onchange="app.updateCartItem('${item.Barcode_ID}', 'price', this.value)">
                        <label>x</label>
                        <div class="qty-controls">
                            <button class="qty-btn" onclick="app.updateCartItem('${item.Barcode_ID}', 'qty', ${item.qty - 1})">-</button>
                            <input type="number" class="qty-input" value="${item.qty}" onchange="app.updateCartItem('${item.Barcode_ID}', 'qty', this.value)">
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
        document.getElementById('checkoutTotal').textContent = formatRupiah(this.state.tempTotal);
        document.getElementById('checkoutCustomer').value = '';
        document.getElementById('checkoutCash').value = '';
        document.getElementById('checkoutChange').textContent = 'Rp 0';
        document.getElementById('checkoutChange').className = 'success-text';
        document.getElementById('checkoutMethod').value = 'Tunai';
        document.getElementById('cashInputSection').classList.remove('hidden');
        this.navigate('checkout');
    },

    calculateChange: function() {
        const cash = parseInt(document.getElementById('checkoutCash').value) || 0;
        const method = document.getElementById('checkoutMethod').value;
        const changeEl = document.getElementById('checkoutChange');
        
        if (method !== 'Tunai') {
            changeEl.textContent = 'Rp 0';
            changeEl.className = 'success-text';
            return;
        }

        const change = cash - this.state.tempTotal;
        if (change < 0) {
            changeEl.textContent = `Uang Kurang! (${formatRupiah(change)})`;
            changeEl.className = 'danger-text';
        } else {
            changeEl.textContent = formatRupiah(change);
            changeEl.className = 'success-text';
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

        const trx = {
            id: 'TRX-' + Date.now(),
            timestamp: new Date().toISOString(),
            customer: customer || 'Umum',
            items: [...this.state.cart],
            subtotal: this.state.tempSubtotal,
            discount: this.state.tempDiscount,
            total: this.state.tempTotal,
            method: method,
            cash: method === 'Tunai' ? cash : 0,
            change: method === 'Tunai' ? (cash - this.state.tempTotal) : 0,
            status: method === 'Kasbon' ? 'Belum Lunas' : 'Lunas'
        };

        // Update local stock
        trx.items.forEach(item => {
            const p = this.state.products.find(x => compareBarcode(x.Barcode_ID, item.Barcode_ID));
            if(p) {
                p.Stok = Math.max(0, parseInt(p.Stok) - item.qty);
                if(p.Stok === 0) p.Status = 'Habis';
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
        
        let html = `
            <h2>🍬 ARUMMANIS</h2>
            <div class="r-row"><span>No:</span> <span>${trx.id}</span></div>
            <div class="r-row"><span>Tgl:</span> <span>${new Date(trx.timestamp).toLocaleString('id-ID')}</span></div>
            <div class="r-row"><span>Kasir:</span> <span>Admin</span></div>
            <div class="r-row"><span>Pelanggan:</span> <span>${trx.customer}</span></div>
            <hr>
        `;
        
        trx.items.forEach(i => {
            html += `
                <div>${i.Nama_Camilan}</div>
                <div class="r-row"><span>${i.qty} x ${formatRupiah(i.editPrice)}</span> <span>${formatRupiah(i.qty * i.editPrice)}</span></div>
            `;
        });
        
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
        }
        if (trx.status === 'Belum Lunas') {
            html += `<div class="r-row"><strong>STATUS:</strong> <strong class="danger-text">BELUM LUNAS</strong></div>`;
        }
        
        html += `<hr><div class="text-center">Terima Kasih!</div>`;
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
    renderTransactionList: function(filter) {
        const container = document.getElementById('transactionListContainer');
        container.innerHTML = '';
        
        const term = document.getElementById('searchTransaction').value.toLowerCase();
        
        let filtered = this.state.transactions.filter(t => {
            if (filter === 'Kasbon' && t.status !== 'Belum Lunas') return false;
            if (term && !t.id.toLowerCase().includes(term) && !t.customer.toLowerCase().includes(term)) return false;
            return true;
        });

        if(filtered.length === 0) {
            container.innerHTML = `<div class="text-center mt-1">Tidak ada transaksi ditemukan.</div>`;
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
        document.getElementById('searchTransaction').oninput = () => this.renderTransactionList(filter);
    },

    markAsPaid: function(id) {
        Swal.fire({
            title: 'Lunasi Kasbon?',
            text: 'Tandai transaksi ini sebagai Lunas?',
            icon: 'question',
            showCancelButton: true
        }).then(res => {
            if(res.isConfirmed) {
                const t = this.state.transactions.find(x => x.id === id);
                if(t) {
                    t.status = 'Lunas';
                    this.state.syncQueue.push({ type: 'update_status', data: { id: t.id, status: 'Lunas' } });
                    this.saveData();
                    this.renderTransactionList('Kasbon');
                    this.syncData();
                    Swal.fire('Berhasil', 'Transaksi telah dilunasi', 'success');
                }
            }
        });
    },

    // --- Product Management ---
    renderProductList: function() {
        const container = document.getElementById('productManageList');
        container.innerHTML = '';
        const term = document.getElementById('searchProductInput').value.toLowerCase();
        
        const filtered = this.state.products.filter(p => 
            p.Barcode_ID.toLowerCase().includes(term) || p.Nama_Camilan.toLowerCase().includes(term)
        );

        if(filtered.length === 0) {
            container.innerHTML = `<div class="text-center mt-1">Produk tidak ditemukan.</div>`;
            return;
        }

        filtered.forEach(p => {
            const div = document.createElement('div');
            div.className = 'list-item';
            div.innerHTML = `
                <div class="list-item-header">
                    <strong>${p.Nama_Camilan}</strong>
                    <span class="status-badge ${p.Stok > 0 ? 'bg-success' : 'bg-warning'}">Stok: ${p.Stok}</span>
                </div>
                <div>Barcode: ${p.Barcode_ID}</div>
                <div>Harga Dasar: ${formatRupiah(p.Harga)}</div>
                <div class="action-buttons mt-1">
                    <button onclick="app.showProductForm('${p.Barcode_ID}')" class="btn btn-sm btn-warning"><i class="fas fa-edit"></i> Edit</button>
                    <button onclick="app.deleteProduct('${p.Barcode_ID}')" class="btn btn-sm btn-danger"><i class="fas fa-trash"></i> Hapus</button>
                </div>
            `;
            container.appendChild(div);
        });
        
        document.getElementById('searchProductInput').oninput = () => this.renderProductList();
    },

    showProductForm: function(barcode = null) {
        document.getElementById('productFormOverlay').classList.remove('hidden');
        const batchFields = document.getElementById('prodFormBatchFields');
        
        if (barcode && typeof barcode === 'string') {
            const p = this.state.products.find(x => compareBarcode(x.Barcode_ID, barcode));
            document.getElementById('productFormTitle').textContent = 'Edit Produk';
            document.getElementById('prodFormId').value = p.Barcode_ID;
            document.getElementById('prodFormBarcode').value = p.Barcode_ID;
            document.getElementById('prodFormName').value = p.Nama_Camilan;
            document.getElementById('prodFormPrice').value = p.Harga;
            document.getElementById('prodFormStock').value = p.Stok;
            
            // Sembunyikan field batch saat edit (stok batch diatur via restock di Sheets)
            batchFields.classList.add('hidden');
        } else {
            document.getElementById('productFormTitle').textContent = 'Tambah Produk';
            document.getElementById('prodFormId').value = '';
            document.getElementById('prodFormBarcode').value = '';
            document.getElementById('prodFormName').value = '';
            document.getElementById('prodFormPrice').value = '';
            document.getElementById('prodFormStock').value = '';
            
            // Tampilkan field batch saat produk baru
            batchFields.classList.remove('hidden');
            document.getElementById('prodFormPriceBuy').value = '';
            document.getElementById('prodFormExpired').value = '';
        }
    },
    closeProductForm: function() {
        this.stopProductScanner();
        document.getElementById('productFormOverlay').classList.add('hidden');
    },
    saveProduct: function() {
        const oldId = document.getElementById('prodFormId').value;
        const newBarcode = document.getElementById('prodFormBarcode').value.trim();
        const name = document.getElementById('prodFormName').value.trim();
        const price = parseInt(document.getElementById('prodFormPrice').value) || 0;
        const stock = parseInt(document.getElementById('prodFormStock').value) || 0;
        
        const priceBuy = parseInt(document.getElementById('prodFormPriceBuy').value) || 0;
        const expired = document.getElementById('prodFormExpired').value.trim();
        
        if(!newBarcode || !name) return Swal.fire('Error', 'Lengkapi form (Barcode dan Nama)!', 'error');

        // Validasi input batch jika produk baru dengan stok > 0
        if (!oldId && stock > 0) {
            const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/;
            if (!expired || !dateRegex.test(expired)) {
                return Swal.fire('Error', 'Format Tanggal Expired wajib DD/MM/YYYY! (Cth: 31/12/2026)', 'error');
            }
            if (!priceBuy) {
                return Swal.fire('Error', 'Harga Beli/Modal wajib diisi!', 'error');
            }
        }

        const product = { 
            Barcode_ID: newBarcode, 
            Nama_Camilan: name, 
            Harga: price, 
            Stok: stock, 
            Status: stock > 0 ? 'Ready' : 'Habis',
            Harga_Beli: priceBuy,
            Tanggal_Expired: expired
        };

        if (oldId) {
            // Jika ganti barcode, pastikan barcode baru belum dipakai produk lain
            if(!compareBarcode(oldId, newBarcode) && this.state.products.find(x => compareBarcode(x.Barcode_ID, newBarcode))) {
                return Swal.fire('Error', 'Barcode sudah dipakai produk lain!', 'error');
            }
            const index = this.state.products.findIndex(x => compareBarcode(x.Barcode_ID, oldId));
            if(index > -1) this.state.products[index] = product;
        } else {
            if(this.state.products.find(x => compareBarcode(x.Barcode_ID, newBarcode))) return Swal.fire('Error', 'Barcode sudah ada!', 'error');
            this.state.products.push(product);
        }

        this.state.syncQueue.push({ type: 'product', data: { ...product, oldBarcode: oldId } });
        this.saveData();
        this.updateProductDatalist();
        this.closeProductForm();
        this.renderProductList();
        this.syncData();
        Swal.fire('Berhasil', 'Produk tersimpan', 'success');
    },
    deleteProduct: function(barcode) {
        Swal.fire({
            title: 'Hapus Produk?', text: 'Produk ini akan dihapus dari sistem', icon: 'warning', showCancelButton: true
        }).then(res => {
            if(res.isConfirmed) {
                this.state.products = this.state.products.filter(x => !compareBarcode(x.Barcode_ID, barcode));
                this.state.syncQueue.push({ type: 'delete_product', data: { Barcode_ID: barcode } });
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
        
        const minSide = Math.min(reader.clientWidth || 300, window.innerHeight || 600);
        const boxSize = Math.floor(minSide * 0.75);
        const config = { 
            fps: 10, 
            qrbox: { width: boxSize, height: boxSize },
            useBarCodeDetectorIfSupported: true
        };
        
        // Coba kamera belakang dahulu (untuk HP agar mendapat lensa autofocus)
        this.state.productScanner.start({ facingMode: "environment" }, config, 
            (text) => {
                if ("vibrate" in navigator) navigator.vibrate(100);
                document.getElementById('prodFormBarcode').value = text;
                this.stopProductScanner();
            }, 
            (err) => {}
        ).then(() => {
            btn.classList.replace('btn-secondary', 'btn-danger');
            btn.innerHTML = '<i class="fas fa-times"></i>';
        }).catch(err => {
            // Fallback ke kamera depan (untuk laptop/PC)
            this.state.productScanner.start({ facingMode: "user" }, config, (text) => {
                if ("vibrate" in navigator) navigator.vibrate(100);
                document.getElementById('prodFormBarcode').value = text;
                this.stopProductScanner();
            }, (err) => {}).then(() => {
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
        
        if (this.state.syncQueue.length === 0) return;
        
        document.getElementById('syncBanner').classList.remove('hidden');
        document.getElementById('syncText').textContent = `Menyinkronkan ${this.state.syncQueue.length} data...`;
        
        let remainingQueue = [...this.state.syncQueue];
        
        for (const item of this.state.syncQueue) {
            try {
                // Gunakan text/plain untuk bypass CORS preflight di Apps Script
                const response = await fetch(GAS_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                    body: JSON.stringify({ action: 'syncData', payload: item })
                });
                
                const result = await response.json();
                if (result.status === 'success') {
                    remainingQueue = remainingQueue.filter(q => q !== item);
                    this.state.syncQueue = remainingQueue;
                    this.saveData();
                }
            } catch (error) {
                console.error('Gagal sync:', error);
                break; // Stop syncing on first network failure
            }
        }
        
        this.checkOfflineQueue();
    },

    // --- Scanner Logic ---
    toggleScanner: function() {
        if(this.state.isScannerRunning) this.stopScanner();
        else this.startScanner();
    },
    startScanner: function() {
        document.getElementById('reader').classList.remove('hidden');
        this.state.scanner = new Html5Qrcode("reader");
        
        const readerEl = document.getElementById('reader');
        const minSide = Math.min(readerEl.clientWidth || 300, window.innerHeight || 600);
        const boxSize = Math.floor(minSide * 0.75);
        const config = { 
            fps: 10, 
            qrbox: { width: boxSize, height: boxSize },
            useBarCodeDetectorIfSupported: true
        };
        
        // Coba kamera belakang dahulu (autofokus HP)
        this.state.scanner.start({ facingMode: "environment" }, config, 
            (text) => {
                if ("vibrate" in navigator) navigator.vibrate(100);
                const p = this.state.products.find(x => compareBarcode(x.Barcode_ID, text));
                if(p) this.addToCart(p);
                else Swal.fire('Error', 'Barcode tidak ditemukan', 'error');
                
                this.stopScanner();
            }, 
            (err) => {}
        ).then(() => {
            this.state.isScannerRunning = true;
            document.getElementById('cameraBtnText').textContent = 'Tutup';
            document.getElementById('toggleCameraBtn').classList.replace('btn-primary', 'btn-danger');
        }).catch(err => {
            // Fallback ke kamera depan (laptop/PC)
            this.state.scanner.start({ facingMode: "user" }, config, (text) => {
                if ("vibrate" in navigator) navigator.vibrate(100);
                const p = this.state.products.find(x => compareBarcode(x.Barcode_ID, text));
                if(p) this.addToCart(p);
                else Swal.fire('Error', 'Barcode tidak ditemukan', 'error');
                
                this.stopScanner();
            }, (err) => {}).then(() => {
                this.state.isScannerRunning = true;
                document.getElementById('cameraBtnText').textContent = 'Tutup';
                document.getElementById('toggleCameraBtn').classList.replace('btn-primary', 'btn-danger');
            }).catch(e => {
                Swal.fire('Error', 'Gagal menyalakan kamera.', 'error');
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
        if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
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

    printReceipt: async function() {
        const trx = this.state.lastTransaction;
        if (!trx) return;
        
        try {
            if (!navigator.bluetooth) throw new Error('Web Bluetooth tidak didukung di browser ini.');
            const device = await navigator.bluetooth.requestDevice({
                acceptAllDevices: true,
                optionalServices: ['000018f0-0000-1000-8000-00805f9b34fb', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '0000fee7-0000-1000-8000-00805f9b34fb']
            });
            if (!device) return;
            Swal.fire({ title: 'Menghubungkan...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

            const server = await device.gatt.connect();
            const services = await server.getPrimaryServices();
            let printChar = null;
            for (const s of services) {
                const chars = await s.getCharacteristics();
                printChar = chars.find(c => c.properties.write || c.properties.writeWithoutResponse);
                if (printChar) break;
            }
            if (!printChar) throw new Error('Karakteristik Bluetooth untuk Print tidak ditemukan.');

            const ESC = '\x1B'; const textBoldOn = ESC + 'E\x01'; const textBoldOff = ESC + 'E\x00';
            let txt = ESC + '@' + ESC + 'a\x01' + textBoldOn + "ARUMMANIS\n" + textBoldOff;
            txt += "Camilan Manis & Gurih\n--------------------------------\n" + ESC + 'a\x00';
            txt += `No : ${trx.id}\nTgl: ${new Date(trx.timestamp).toLocaleString('id-ID')}\nPel: ${trx.customer}\n--------------------------------\n`;
            
            trx.items.forEach(i => {
                txt += `${i.Nama_Camilan}\n${i.qty} x ${formatRupiah(i.editPrice)} = ${formatRupiah(i.qty * i.editPrice)}\n`;
            });
            txt += `--------------------------------\n`;
            txt += `Subtotal: ${formatRupiah(trx.subtotal)}\nDiskon: -${formatRupiah(trx.discount)}\n`;
            txt += textBoldOn + `TOTAL: ${formatRupiah(trx.total)}\n` + textBoldOff;
            txt += `Bayar(${trx.method}): ${formatRupiah(trx.cash || 0)}\nKembali: ${formatRupiah(trx.change || 0)}\n`;
            if(trx.status === 'Belum Lunas') txt += `STATUS: BELUM LUNAS (KASBON)\n`;
            txt += `--------------------------------\n` + ESC + 'a\x01' + "Terima Kasih!\n\n\n";

            const data = new TextEncoder().encode(txt);
            for (let i = 0; i < data.length; i += 256) {
                await printChar.writeValue(data.slice(i, i + 256));
                await new Promise(r => setTimeout(r, 50));
            }
            await device.gatt.disconnect();
            Swal.fire('Berhasil', 'Struk dicetak', 'success');
        } catch (e) {
            if (e.name !== 'NotFoundError') Swal.fire('Gagal', e.message, 'error');
        }
    }
};

document.addEventListener('DOMContentLoaded', () => app.init());
