function doGet(e) {
  var action = e.parameter.action;
  
  if (action === 'getProducts') {
    return getProducts();
  }
  
  return ContentService.createTextOutput(JSON.stringify({status: 'error', message: 'Action not found'}))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    
    // Sinkronisasi data dari queue (Offline-First)
    if (data.action === 'syncData' && data.payload) {
        var payload = data.payload;
        if (payload.type === 'transaction') {
            return processTransaction(payload.data);
        } else if (payload.type === 'update_status') {
            return updateTransactionStatus(payload.data);
        } else if (payload.type === 'product') {
            return saveProduct(payload.data);
        } else if (payload.type === 'delete_product') {
            return deleteProduct(payload.data);
        }
    }
    
    return ContentService.createTextOutput(JSON.stringify({status: 'error', message: 'Action not found'}))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({status: 'error', message: error.toString()}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Inisialisasi Sheet jika belum lengkap
function initSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  
  var pSheet = ss.getSheetByName("DatabaseProduk");
  if (!pSheet) {
    pSheet = ss.insertSheet("DatabaseProduk");
    pSheet.appendRow(["Barcode_ID", "Nama_Camilan", "Harga_Jual"]);
  }
  
  var bSheet = ss.getSheetByName("StokBatch");
  if (!bSheet) {
    bSheet = ss.insertSheet("StokBatch");
    bSheet.appendRow(["Batch_ID", "Barcode_ID", "Tanggal_Masuk", "Tanggal_Expired", "Stok_Awal", "Stok_Sisa", "Harga_Beli", "Status"]);
  }
  
  var tSheet = ss.getSheetByName("DatabaseTransaksi");
  if (!tSheet) {
    tSheet = ss.insertSheet("DatabaseTransaksi");
    tSheet.appendRow(["ID", "Waktu", "Pelanggan", "Item (Detail)", "Subtotal", "Diskon", "Total", "Metode", "Tunai", "Kembalian", "Status"]);
  }
}

function getProducts() {
  initSheets();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var pSheet = ss.getSheetByName("DatabaseProduk");
  var bSheet = ss.getSheetByName("StokBatch");
  
  var pData = pSheet.getDataRange().getDisplayValues();
  var bData = bSheet.getDataRange().getDisplayValues();
  
  if (pData.length < 2) return successResponse([]);
  
  var pHeaders = pData[0];
  var bHeaders = bData[0];
  
  // Hitung total Stok_Sisa per Barcode_ID dari tab StokBatch
  var stokMap = {};
  var bBarcodeCol = bHeaders.indexOf("Barcode_ID");
  var bSisaCol = bHeaders.indexOf("Stok_Sisa");
  
  if (bData.length > 1 && bBarcodeCol > -1 && bSisaCol > -1) {
    for (var i = 1; i < bData.length; i++) {
      var barcode = bData[i][bBarcodeCol].toString().trim();
      if (barcode === "") continue;
      var sisa = parseInt(bData[i][bSisaCol]) || 0;
      if (!stokMap[barcode]) stokMap[barcode] = 0;
      stokMap[barcode] += sisa;
    }
  }
  
  var products = [];
  var pBarcodeCol = pHeaders.indexOf("Barcode_ID");
  if (pBarcodeCol === -1) pBarcodeCol = 0;
  var pNameCol = pHeaders.indexOf("Nama_Camilan");
  if (pNameCol === -1) pNameCol = 1;
  var pPriceCol = pHeaders.indexOf("Harga_Jual");
  if (pPriceCol === -1) pPriceCol = pHeaders.indexOf("Harga");
  if (pPriceCol === -1) pPriceCol = 2;
  var pModalCol = pHeaders.indexOf("Harga_Modal");
  if (pModalCol === -1) pModalCol = pHeaders.indexOf("Harga_Beli");
  
  for (var i = 1; i < pData.length; i++) {
    var barcode = pData[i][pBarcodeCol] ? pData[i][pBarcodeCol].toString().trim() : "";
    var name = pData[i][pNameCol] || "";
    if (!name && !barcode) continue; // Skip baris benar-benar kosong
    var price = parseFloat(pData[i][pPriceCol]) || 0;
    var modal = pModalCol > -1 ? (parseFloat(pData[i][pModalCol]) || 0) : 0;
    var totalStok = barcode ? (stokMap[barcode] || 0) : 0;
    
    products.push({
      Barcode_ID: barcode,
      Nama_Camilan: name,
      Harga: price,
      Harga_Modal: modal,
      Stok: totalStok,
      Status: totalStok > 0 ? "Ready" : "Habis",
      _sheetRow: i + 1 // Nomor baris di sheet (untuk update tanpa barcode)
    });
  }
  
  return successResponse(products);
}

// Logika Pengurangan Stok FIFO (First In, First Out)
function processTransaction(transaction) {
  initSheets();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var bSheet = ss.getSheetByName("StokBatch");
  var tSheet = ss.getSheetByName("DatabaseTransaksi");
  
  var bData = bSheet.getDataRange().getDisplayValues();
  var bHeaders = bData[0];
  
  var bIdCol = bHeaders.indexOf("Batch_ID");
  var bBarcodeCol = bHeaders.indexOf("Barcode_ID");
  var bExpCol = bHeaders.indexOf("Tanggal_Expired");
  var bSisaCol = bHeaders.indexOf("Stok_Sisa");
  var bStatusCol = bHeaders.indexOf("Status");
  
  // Lakukan FIFO untuk setiap item yang dibeli
  transaction.items.forEach(item => {
    var qtyToDeduct = parseInt(item.qty);
    var matchingBatches = [];
    
    // 1. Kumpulkan semua batch produk yang masih memiliki stok
    for (var i = 1; i < bData.length; i++) {
      if (bData[i][bBarcodeCol].toString() === item.Barcode_ID.toString()) {
        var sisa = parseInt(bData[i][bSisaCol]) || 0;
        if (sisa > 0) {
          matchingBatches.push({
            rowIndex: i + 1, // 1-indexed row in Sheet
            batchId: bData[i][bIdCol],
            expiredDate: parseDate(bData[i][bExpCol]),
            stokSisa: sisa
          });
        }
      }
    }
    
    // 2. Urutkan berdasarkan Tanggal Expired (FIFO) - terdekat ke terjauh
    matchingBatches.sort((a, b) => a.expiredDate - b.expiredDate);
    
    // 3. Potong stok dari batch secara berurutan
    for (var k = 0; k < matchingBatches.length; k++) {
      if (qtyToDeduct <= 0) break;
      
      var batch = matchingBatches[k];
      var deductAmount = Math.min(qtyToDeduct, batch.stokSisa);
      var newSisa = batch.stokSisa - deductAmount;
      qtyToDeduct -= deductAmount;
      
      // Update sisa stok di Google Sheet
      bSheet.getRange(batch.rowIndex, bSisaCol + 1).setValue(newSisa);
      bSheet.getRange(batch.rowIndex, bStatusCol + 1).setValue(newSisa === 0 ? "Habis" : "Ready");
    }
  });

  // Simpan detail transaksi ke database transaksi
  var detailItems = transaction.items.map(i => i.Nama_Camilan + " (" + i.qty + "x" + i.editPrice + ")").join(" | ");
  
  tSheet.appendRow([
    transaction.id,
    transaction.timestamp,
    transaction.customer,
    detailItems,
    transaction.subtotal,
    transaction.discount,
    transaction.total,
    transaction.method,
    transaction.cash,
    transaction.change,
    transaction.status
  ]);
  
  return successResponse('Transaksi berhasil diproses dengan sistem FIFO');
}

function updateTransactionStatus(data) {
  initSheets();
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("DatabaseTransaksi");
  if (!sheet) return errorResponse('Sheet "DatabaseTransaksi" tidak ditemukan');
  
  var table = sheet.getDataRange().getDisplayValues();
  var headers = table[0];
  var idCol = headers.indexOf("ID");
  
  var statusCol = headers.indexOf("Status");
  if (statusCol === -1) statusCol = 10; // Kolom ke-11
  
  var cashCol = headers.indexOf("Uang_Bayar");
  if (cashCol === -1) cashCol = headers.indexOf("Cash");
  if (cashCol === -1) cashCol = 8; // Kolom ke-9
  
  var changeCol = headers.indexOf("Kembalian");
  if (changeCol === -1) changeCol = headers.indexOf("Change");
  if (changeCol === -1) changeCol = 9; // Kolom ke-10
  
  if (idCol > -1) {
    for (var i = 1; i < table.length; i++) {
      if (table[i][idCol] === data.id) {
        // 1. Update Status (Lunas / Belum Lunas)
        sheet.getRange(i + 1, statusCol + 1).setValue(data.status);
        
        // 2. Update Total Uang Bayar yang diterima
        if (data.cash !== undefined) {
          sheet.getRange(i + 1, cashCol + 1).setValue(data.cash);
        }
        
        // 3. Update Kolom Kembalian / Sisa Hutang (sisa hutang ditulis negatif)
        if (data.remainingDebt !== undefined) {
          sheet.getRange(i + 1, changeCol + 1).setValue(-data.remainingDebt);
        } else if (data.status === 'Lunas') {
          sheet.getRange(i + 1, changeCol + 1).setValue(0);
        }
        
        return successResponse('Status transaksi diperbarui');
      }
    }
  }
  return errorResponse('Transaksi tidak ditemukan');
}

// Simpan data produk baru beserta batch awalnya
function saveProduct(product) {
  initSheets();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var pSheet = ss.getSheetByName("DatabaseProduk");
  var bSheet = ss.getSheetByName("StokBatch");
  
  var pData = pSheet.getDataRange().getDisplayValues();
  var pHeaders = pData[0];
  var pBarcodeCol = pHeaders.indexOf("Barcode_ID");
  
  // 1. Update/Insert ke DatabaseProduk
  var exists = false;
  var prodRow = -1;
  var searchBarcode = (product.oldBarcode && product.oldBarcode !== "") ? product.oldBarcode : product.Barcode_ID;
  
  // Cari berdasarkan barcode ATAU berdasarkan _sheetRow (untuk produk tanpa barcode)
  if (product._sheetRow && product._sheetRow > 1) {
    // Lookup langsung via nomor baris sheet
    prodRow = product._sheetRow;
    exists = true;
  } else if (searchBarcode && searchBarcode !== "") {
    for (var i = 1; i < pData.length; i++) {
      if (pData[i][pBarcodeCol].toString().trim() === searchBarcode.toString().trim()) {
        exists = true;
        prodRow = i + 1;
        break;
      }
    }
  }
  
  // Fallback: cari berdasarkan Nama_Camilan jika barcode kosong
  if (!exists && product.Nama_Camilan) {
    var pNameCol = pHeaders.indexOf("Nama_Camilan");
    if (pNameCol === -1) pNameCol = 1;
    for (var i = 1; i < pData.length; i++) {
      if (pData[i][pNameCol].toString().trim() === product.Nama_Camilan.toString().trim()) {
        exists = true;
        prodRow = i + 1;
        break;
      }
    }
  }
  
  // Tentukan jumlah kolom yang akan ditulis berdasarkan header sheet
  var pPriceCol = pHeaders.indexOf("Harga_Jual");
  if (pPriceCol === -1) pPriceCol = pHeaders.indexOf("Harga");
  if (pPriceCol === -1) pPriceCol = 2;
  var pModalCol = pHeaders.indexOf("Harga_Modal");
  if (pModalCol === -1) pModalCol = pHeaders.indexOf("Harga_Beli");
  
  if (exists) {
    // Update kolom yang ada
    pSheet.getRange(prodRow, pBarcodeCol + 1).setValue(product.Barcode_ID || "");
    var pNameColIdx = pHeaders.indexOf("Nama_Camilan");
    if (pNameColIdx === -1) pNameColIdx = 1;
    pSheet.getRange(prodRow, pNameColIdx + 1).setValue(product.Nama_Camilan);
    pSheet.getRange(prodRow, pPriceCol + 1).setValue(product.Harga);
    if (pModalCol > -1 && product.Harga_Beli) {
      pSheet.getRange(prodRow, pModalCol + 1).setValue(product.Harga_Beli);
    }
    
    // Jika barcode diubah, perbarui juga Barcode_ID di seluruh batch StokBatch
    if (product.oldBarcode && product.oldBarcode !== "" && product.oldBarcode.toString() !== product.Barcode_ID.toString()) {
      var bData = bSheet.getDataRange().getDisplayValues();
      var bBarcodeCol = bData[0].indexOf("Barcode_ID");
      if (bBarcodeCol > -1) {
        for (var j = 1; j < bData.length; j++) {
          if (bData[j][bBarcodeCol].toString() === product.oldBarcode.toString()) {
            bSheet.getRange(j + 1, bBarcodeCol + 1).setValue(product.Barcode_ID);
          }
        }
      }
    }
  } else {
    pSheet.appendRow([product.Barcode_ID, product.Nama_Camilan, product.Harga]);
  }
  
  // 2. Buat Batch Awal di StokBatch (HANYA jika produk BARU dan stok > 0)
  if (!product.oldBarcode && parseInt(product.Stok) > 0) {
    var batchId = "B-" + Date.now();
    var tanggalMasuk = formatDate(new Date());
    var tanggalExpired = product.Tanggal_Expired || formatDate(new Date(Date.now() + 365*24*60*60*1000)); // Default 1 tahun
    var hargaBeli = product.Harga_Beli || Math.floor(product.Harga * 0.8); // Default modal 80% harga jual
    
    bSheet.appendRow([
      batchId,
      product.Barcode_ID,
      tanggalMasuk,
      tanggalExpired,
      product.Stok,
      product.Stok, // Stok_Sisa awal = Stok_Awal
      hargaBeli,
      "Ready"
    ]);
  }
  
  return successResponse('Produk dan batch berhasil disimpan');
}

function deleteProduct(data) {
  initSheets();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var pSheet = ss.getSheetByName("DatabaseProduk");
  var bSheet = ss.getSheetByName("StokBatch");
  
  // 1. Hapus dari DatabaseProduk
  var pTable = pSheet.getDataRange().getDisplayValues();
  var pBarcodeCol = pTable[0].indexOf("Barcode_ID");
  for (var i = 1; i < pTable.length; i++) {
    if (pTable[i][pBarcodeCol].toString() === data.Barcode_ID.toString()) {
      pSheet.deleteRow(i + 1);
      break;
    }
  }
  
  // 2. Hapus seluruh batch yang bersangkutan dari StokBatch
  var bTable = bSheet.getDataRange().getDisplayValues();
  var bBarcodeCol = bTable[0].indexOf("Barcode_ID");
  // Hapus dari bawah ke atas agar indeks baris tidak bergeser salah
  for (var j = bTable.length - 1; j >= 1; j--) {
    if (bTable[j][bBarcodeCol].toString() === data.Barcode_ID.toString()) {
      bSheet.deleteRow(j + 1);
    }
  }
  
  return successResponse('Produk dan seluruh batch berhasil dihapus');
}

// --- Utilities Helper ---

// Mengubah teks DD/MM/YYYY menjadi objek Date javascript
function parseDate(dateStr) {
  if (dateStr instanceof Date) return dateStr;
  var parts = dateStr.toString().split("/");
  if (parts.length === 3) {
    return new Date(parts[2], parts[1] - 1, parts[0]);
  }
  return new Date(dateStr); // fallback jika tipenya objek date default sheet
}

// Format objek Date menjadi string DD/MM/YYYY
function formatDate(date) {
  var d = new Date(date),
      month = '' + (d.getMonth() + 1),
      day = '' + d.getDate(),
      year = d.getFullYear();

  if (month.length < 2) month = '0' + month;
  if (day.length < 2) day = '0' + day;

  return [day, month, year].join('/');
}

function successResponse(data) {
  return ContentService.createTextOutput(JSON.stringify({ status: 'success', data: data })).setMimeType(ContentService.MimeType.JSON);
}
function errorResponse(msg) {
  return ContentService.createTextOutput(JSON.stringify({ status: 'error', message: msg })).setMimeType(ContentService.MimeType.JSON);
}
