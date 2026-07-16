# Panduan Setup Arummanis POS

Aplikasi ini menggunakan Google Apps Script (GAS) sebagai backend untuk menyimpan data ke Google Sheets, dan Progressive Web App (PWA) untuk antarmuka kasir yang bisa bekerja secara offline.

## Langkah 1: Persiapan Google Sheets
1. Buka [Google Sheets](https://sheets.google.com) dan buat spreadsheet baru.
2. Ubah nama Sheet pertama (biasanya "Sheet1") menjadi **`DatabaseProduk`**. Perhatikan huruf besar-kecilnya.
3. Buat kolom berikut pada baris pertama (A1 sampai E1):
   - Kolom A: `Barcode_ID`
   - Kolom B: `Nama_Camilan`
   - Kolom C: `Harga`
   - Kolom D: `Stok`
   - Kolom E: `Status`
4. Isi beberapa data produk uji coba. Kolom `Status` isi dengan `Ready`.

## Langkah 2: Deploy Google Apps Script
1. Dari menu Google Sheets, klik **Ekstensi** > **Apps Script**.
2. Hapus semua kode default dan salin seluruh isi dari file `Code.gs` ke editor tersebut.
3. Simpan dengan menekan ikon Disket (Save) atau menekan `Ctrl + S`.
4. Klik tombol **Terapkan (Deploy)** di pojok kanan atas, lalu pilih **Deployment baru (New deployment)**.
5. Pada ikon roda gigi (Select type), pilih **Aplikasi Web (Web app)**.
6. Konfigurasi deployment:
   - **Deskripsi:** Arummanis POS API
   - **Jalankan sebagai:** Pilih *SAYA (Me)* (email Anda).
   - **Siapa yang memiliki akses:** Pilih *Siapa saja (Anyone)*. **PENTING**: Harus "Anyone" agar aplikasi dari luar dapat memanggil API ini.
7. Klik **Terapkan (Deploy)**. Anda mungkin akan diminta untuk memberikan izin akses (Authorize access). Lanjutkan dan berikan izin (Jika muncul "Aplikasi belum diverifikasi / App isn't verified", klik *Lanjutan / Advanced* lalu *Buka / Go to...*).
8. Setelah berhasil, salin **URL Aplikasi Web (Web app URL)** yang diberikan.

## Langkah 3: Hubungkan Aplikasi
1. Buka file `app.js` menggunakan text editor (seperti Notepad, VSCode, dll).
2. Pada baris paling atas, cari variabel `GAS_URL`.
3. Ganti teks `'YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL'` dengan URL yang Anda salin pada langkah sebelumnya.
   Contoh: 
   ```javascript
   const GAS_URL = 'https://script.google.com/macros/s/AKfycby.../exec';
   ```
4. Simpan file `app.js`.

## Langkah 4: Jalankan Aplikasi
1. Agar Service Worker berfungsi (PWA), aplikasi harus berjalan pada protokol `http://localhost` atau `https://`.
2. Anda bisa menjalankannya di komputer secara lokal menggunakan ekstensi **Live Server** (di VSCode), server web Python (`python -m http.server`), atau menghosting foldernya ke layanan seperti Vercel / GitHub Pages.
3. Buka aplikasi di peramban seluler (Chrome), lalu ketuk **Tambahkan ke Layar Utama** (Add to Home Screen) untuk menginstalnya selayaknya aplikasi Android.
