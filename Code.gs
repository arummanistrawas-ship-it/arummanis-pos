function doGet(e) {
  var action = e.parameter.action;
  
  if (action === 'getProducts') {
    return getProducts();
  }
  
  if (action === 'get_settings') {
    return getSettings();
  }
  
  if (action === 'get_transactions') {
    return getTransactions();
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
        } else if (payload.type === 'restock') {
            return processRestock(payload.data);
        } else if (payload.type === 'save_settings') {
            return saveSettings(payload.data);
        } else if (payload.type === 'update_batch') {
            return updateBatch(payload.data);
        } else if (payload.type === 'delete_transaction') {
            return deleteTransaction(payload.data);
        }
    }
    
    return ContentService.createTextOutput(JSON.stringify({status: 'error', message: 'Action not found'}))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({status: 'error', message: error.toString()}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Menu otomatis saat Google Spreadsheet dibuka
function onOpen() {
  try {
    var ui = SpreadsheetApp.getUi();
    ui.createMenu('🏪 Kasir Arummanis')
      .addItem('💰 Update Harga Modal dari Batch Terakhir', 'menuSyncMasterCosts')
      .addItem('🔄 Sinkronkan Nama Produk di StokBatch', 'fixAndFillStokBatchNames')
      .addItem('🛠️ Inisialisasi & Rapikan Semua Sheet', 'initSheets')
      .addToUi();
  } catch (e) {
    Logger.log("onOpen error: " + e);
  }
}

function menuSyncMasterCosts() {
  var res = syncMasterProductCostsFromBatches();
  try { Browser.msgBox(res); } catch(e){}
}

// Inisialisasi Sheet jika belum lengkap
function initSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  
  var pSheet = ss.getSheetByName("DatabaseProduk");
  if (!pSheet) {
    pSheet = ss.insertSheet("DatabaseProduk");
    pSheet.appendRow(["Barcode_ID", "Nama_Camilan", "Harga_Jual", "Harga_Modal"]);
  } else {
    var pHeaders = pSheet.getDataRange().getDisplayValues()[0];
    if (pHeaders.indexOf("Harga_Modal") === -1 && pHeaders.indexOf("Harga_Beli") === -1) {
      var pLastCol = pSheet.getLastColumn();
      pSheet.getRange(1, pLastCol + 1).setValue("Harga_Modal");
    }
  }
  
  var bSheet = ss.getSheetByName("StokBatch");
  if (!bSheet) {
    bSheet = ss.insertSheet("StokBatch");
    bSheet.appendRow(["Batch_ID", "Barcode_ID", "Nama_Camilan", "Tanggal_Masuk", "Tanggal_Expired", "Stok_Awal", "Stok_Sisa", "Harga_Beli", "Status"]);
  } else {
    // Pastikan kolom Nama_Camilan ada jika sheet sudah ada sebelumnya
    var bHeaders = bSheet.getDataRange().getDisplayValues()[0];
    if (bHeaders.indexOf("Nama_Camilan") === -1) {
      bSheet.insertColumnAfter(2); // Sisipkan di kolom 3
      bSheet.getRange(1, 3).setValue("Nama_Camilan");
    }
  }
  
  var tSheet = ss.getSheetByName("DatabaseTransaksi");
  if (!tSheet) {
    tSheet = ss.insertSheet("DatabaseTransaksi");
    tSheet.appendRow(["ID", "Waktu", "Pelanggan", "Item (Detail)", "Subtotal", "Diskon", "Total", "Metode", "Tunai", "Kembalian", "Status", "HPP", "Laba_Bersih"]);
  } else {
    // Pastikan kolom HPP dan Laba_Bersih ada jika sheet sudah ada sebelumnya
    var lastCol = tSheet.getLastColumn();
    if (lastCol < 13) {
      tSheet.getRange(1, 12).setValue("HPP");
      tSheet.getRange(1, 13).setValue("Laba_Bersih");
    }
  }
  
  var sSheet = ss.getSheetByName("Pengaturan");
  if (!sSheet) {
    sSheet = ss.insertSheet("Pengaturan");
    sSheet.appendRow(["Key", "Value"]);
  }
  
  // Otomatis sinkronkan Nama_Camilan pada sheet StokBatch dengan DatabaseProduk
  syncStokBatchProductNames();
  // Otomatis sinkronkan Harga_Modal pada DatabaseProduk dari batch terbaru
  syncMasterProductCostsFromBatches();
}

function syncStokBatchProductNames() {
  return fixAndFillStokBatchNames();
}

// Fungsi Otomatis untuk Mengisi & Memperbarui Harga_Modal di DatabaseProduk dari Batch Kulakan Terakhir di StokBatch
function syncMasterProductCostsFromBatches() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var pSheet = ss.getSheetByName("DatabaseProduk") || ss.getSheetByName("Database Produk");
    var bSheet = ss.getSheetByName("StokBatch") || ss.getSheetByName("Stok Batch") || ss.getSheetByName("Stok_Batch");
    
    if (!pSheet || !bSheet) return "Sheet DatabaseProduk atau StokBatch tidak ditemukan";
    
    var pLastRow = pSheet.getLastRow();
    var pLastCol = pSheet.getLastColumn();
    var bLastRow = bSheet.getLastRow();
    var bLastCol = bSheet.getLastColumn();
    
    if (pLastRow < 2 || bLastRow < 2) return "Data produk atau batch masih kosong";
    
    var pData = pSheet.getRange(1, 1, pLastRow, pLastCol).getDisplayValues();
    var bData = bSheet.getRange(1, 1, bLastRow, bLastCol).getDisplayValues();
    
    var pHeaders = pData[0];
    var bHeaders = bData[0];
    
    // Temukan kolom di DatabaseProduk
    var pBcCol = pHeaders.indexOf("Barcode_ID"); if (pBcCol === -1) pBcCol = pHeaders.indexOf("Barcode"); if (pBcCol === -1) pBcCol = 0;
    var pNmCol = pHeaders.indexOf("Nama_Camilan"); if (pNmCol === -1) pNmCol = pHeaders.indexOf("Nama"); if (pNmCol === -1) pNmCol = 1;
    var pModalCol = pHeaders.indexOf("Harga_Modal");
    if (pModalCol === -1) pModalCol = pHeaders.indexOf("Harga_Beli");
    if (pModalCol === -1) {
      // Buat kolom Harga_Modal di ujung
      pSheet.getRange(1, pLastCol + 1).setValue("Harga_Modal");
      pModalCol = pLastCol;
      pLastCol++;
    }
    
    // Temukan kolom di StokBatch
    var bBcCol = bHeaders.indexOf("Barcode_ID"); if (bBcCol === -1) bBcCol = bHeaders.indexOf("Barcode"); if (bBcCol === -1) bBcCol = 1;
    var bNmCol = bHeaders.indexOf("Nama_Camilan"); if (bNmCol === -1) bNmCol = bHeaders.indexOf("Nama");
    var bBuyCol = bHeaders.indexOf("Harga_Beli"); if (bBuyCol === -1) bBuyCol = bHeaders.indexOf("Harga_Modal");
    
    if (bBuyCol === -1) return "Kolom Harga_Beli di StokBatch tidak ditemukan";
    
    // Petakan harga beli batch TERAKHIR per barcode dan per nama produk (baris bawah menimpa baris atas = latest)
    var latestCostByBc = {};
    var latestCostByNm = {};
    
    for (var b = 1; b < bData.length; b++) {
      var bBc = bBcCol > -1 && bData[b][bBcCol] ? bData[b][bBcCol].toString().trim() : "";
      var bNm = bNmCol > -1 && bData[b][bNmCol] ? bData[b][bNmCol].toString().trim() : "";
      var bBuy = parseFloat(bData[b][bBuyCol]) || 0;
      
      if (bBuy > 0) {
        if (bBc !== "") {
          latestCostByBc[bBc.toLowerCase()] = bBuy;
          var numBc = parseFloat(bBc);
          if (!isNaN(numBc)) latestCostByBc[numBc.toString()] = bBuy;
        }
        if (bNm !== "") {
          latestCostByNm[bNm.toLowerCase()] = bBuy;
        }
      }
    }
    
    // Update ke DatabaseProduk
    var updatedCount = 0;
    for (var p = 1; p < pData.length; p++) {
      var pBc = pData[p][pBcCol] ? pData[p][pBcCol].toString().trim() : "";
      var pNm = pData[p][pNmCol] ? pData[p][pNmCol].toString().trim() : "";
      var currentModal = parseFloat(pData[p][pModalCol]) || 0;
      
      var targetModal = 0;
      if (pBc !== "" && latestCostByBc[pBc.toLowerCase()]) {
        targetModal = latestCostByBc[pBc.toLowerCase()];
      } else if (pNm !== "" && latestCostByNm[pNm.toLowerCase()]) {
        targetModal = latestCostByNm[pNm.toLowerCase()];
      }
      
      if (targetModal > 0 && targetModal !== currentModal) {
        pSheet.getRange(p + 1, pModalCol + 1).setValue(targetModal);
        updatedCount++;
      }
    }
    
    SpreadsheetApp.flush();
    var msg = "BERHASIL! Menyelaraskan " + updatedCount + " harga modal produk di DatabaseProduk dengan batch kulakan terakhir.";
    Logger.log(msg);
    return msg;
  } catch (err) {
    Logger.log("Error syncMasterProductCostsFromBatches: " + err);
    return "Error: " + err.toString();
  }
}

function fixAndFillStokBatchNames() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var pSheet = ss.getSheetByName("DatabaseProduk") || ss.getSheetByName("Database Produk");
    var bSheet = ss.getSheetByName("StokBatch") || ss.getSheetByName("Stok Batch") || ss.getSheetByName("Stok_Batch");
    
    if (!pSheet) {
      var err1 = "Error: Sheet DatabaseProduk tidak ditemukan!";
      try { Browser.msgBox(err1); } catch(e){}
      return err1;
    }
    if (!bSheet) {
      var err2 = "Error: Sheet StokBatch tidak ditemukan!";
      try { Browser.msgBox(err2); } catch(e){}
      return err2;
    }
    
    // 1. Pastikan Header StokBatch memiliki kolom Nama_Camilan
    var bLastCol = bSheet.getLastColumn();
    var bLastRow = bSheet.getLastRow();
    if (bLastRow < 2) {
      var err3 = "Info: Sheet StokBatch belum memiliki baris data!";
      try { Browser.msgBox(err3); } catch(e){}
      return err3;
    }
    
    var bHeaders = bSheet.getRange(1, 1, 1, bLastCol).getDisplayValues()[0];
    var bNmCol = -1;
    for (var h = 0; h < bHeaders.length; h++) {
      var hStr = bHeaders[h].toString().trim().toLowerCase();
      if (hStr === "nama_camilan" || hStr === "nama camilan" || hStr === "nama produk" || hStr === "nama") {
        bNmCol = h;
        break;
      }
    }
    
    if (bNmCol === -1) {
      // Sisipkan kolom Nama_Camilan di kolom 3 (C)
      bSheet.insertColumnAfter(2);
      bSheet.getRange(1, 3).setValue("Nama_Camilan");
      SpreadsheetApp.flush();
      bLastCol = bSheet.getLastColumn();
      bHeaders = bSheet.getRange(1, 1, 1, bLastCol).getDisplayValues()[0];
      bNmCol = 2; // Kolom C (0-indexed = 2)
    }
    
    var bBcCol = -1;
    for (var h = 0; h < bHeaders.length; h++) {
      var hStr = bHeaders[h].toString().trim().toLowerCase();
      if (hStr === "barcode_id" || hStr === "barcode" || hStr === "barcode id") {
        bBcCol = h;
        break;
      }
    }
    if (bBcCol === -1) bBcCol = 1;
    
    // 2. Ambil data dari DatabaseProduk
    var pLastRow = pSheet.getLastRow();
    var pLastCol = pSheet.getLastColumn();
    if (pLastRow < 2) return "DatabaseProduk belum memiliki data produk";
    
    var pData = pSheet.getRange(1, 1, pLastRow, pLastCol).getDisplayValues();
    var pHeaders = pData[0];
    
    var pBcCol = -1, pNmCol = -1;
    for (var ph = 0; ph < pHeaders.length; ph++) {
      var pHeadLower = pHeaders[ph].toString().trim().toLowerCase();
      if (pHeadLower === "barcode_id" || pHeadLower === "barcode") pBcCol = ph;
      if (pHeadLower === "nama_camilan" || pHeadLower === "nama camilan" || pHeadLower === "nama produk") pNmCol = ph;
    }
    if (pBcCol === -1) pBcCol = 0;
    if (pNmCol === -1) pNmCol = 1;
    
    // Build normalizer map
    var mapByBc = {};
    var mapByNm = {};
    
    for (var i = 1; i < pData.length; i++) {
      var rawBc = pData[i][pBcCol] ? pData[i][pBcCol].toString().trim() : "";
      var rawNm = pData[i][pNmCol] ? pData[i][pNmCol].toString().trim() : "";
      
      if (rawNm !== "") {
        if (rawBc !== "") {
          mapByBc[rawBc.toLowerCase()] = rawNm;
          var numBc = parseFloat(rawBc);
          if (!isNaN(numBc)) {
            mapByBc[numBc.toString()] = rawNm;
          }
        }
        mapByNm[rawNm.toLowerCase()] = rawNm;
      }
    }
    
    // 3. Ambil data StokBatch & Update
    var bData = bSheet.getRange(1, 1, bLastRow, bLastCol).getDisplayValues();
    var updatedCount = 0;
    
    for (var j = 1; j < bData.length; j++) {
      var rawRowBc = bData[j][bBcCol] ? bData[j][bBcCol].toString().trim() : "";
      var rawRowNm = bNmCol > -1 && bData[j][bNmCol] ? bData[j][bNmCol].toString().trim() : "";
      
      var targetName = "";
      
      // Pencocokan 1: Lewat Barcode
      if (rawRowBc !== "" && mapByBc[rawRowBc.toLowerCase()]) {
        targetName = mapByBc[rawRowBc.toLowerCase()];
      }
      // Pencocokan 2: Lewat Barcode (jika kolom barcode berisi nama produk)
      else if (rawRowBc !== "" && mapByNm[rawRowBc.toLowerCase()]) {
        targetName = mapByNm[rawRowBc.toLowerCase()];
      }
      // Pencocokan 3: Lewat Nama yang ada
      else if (rawRowNm !== "" && mapByNm[rawRowNm.toLowerCase()]) {
        targetName = mapByNm[rawRowNm.toLowerCase()];
      }
      
      if (targetName !== "") {
        bSheet.getRange(j + 1, bNmCol + 1).setValue(targetName);
        updatedCount++;
      }
    }
    
    SpreadsheetApp.flush();
    var msg = "BERHASIL! Menyuplai " + updatedCount + " baris Nama_Camilan di sheet StokBatch.";
    Logger.log(msg);
    try { Browser.msgBox(msg); } catch(e){}
    return msg;
  } catch (err) {
    console.error("Gagal fixAndFillStokBatchNames:", err);
    var errMsg = "Error: " + err.toString();
    try { Browser.msgBox(errMsg); } catch(e){}
    return errMsg;
  }
}

function getSettings() {
  initSheets();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Pengaturan");
  if (!sheet) return successResponse({});
  
  var data = sheet.getDataRange().getValues();
  var settings = {};
  for (var i = 1; i < data.length; i++) {
    if (data[i][0]) settings[data[i][0]] = data[i][1];
  }
  return successResponse(settings);
}

function getProducts() {
  initSheets();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var pSheet = ss.getSheetByName("DatabaseProduk");
  var bSheet = ss.getSheetByName("StokBatch");
  
  var pData = pSheet.getDataRange().getDisplayValues();
  var bData = bSheet ? bSheet.getDataRange().getDisplayValues() : [];
  
  if (pData.length < 2) return successResponse([]);
  
  var pHeaders = pData[0];
  var bHeaders = bData.length > 0 ? bData[0] : [];
  
  // Ambil data batch detail per Barcode_ID DAN Nama_Camilan dari tab StokBatch
  var stokMap = {};
  var batchesMap = {}; // Map identifier (barcode atau nama) ke list batch aktif
  var bBarcodeCol = bHeaders.indexOf("Barcode_ID");
  var bNameCol = bHeaders.indexOf("Nama_Camilan");
  var bSisaCol = bHeaders.indexOf("Stok_Sisa");
  var bExpCol = bHeaders.indexOf("Tanggal_Expired");
  var bBuyCol = bHeaders.indexOf("Harga_Beli");
  var bIdCol = bHeaders.indexOf("Batch_ID");
  
  if (bData.length > 1 && bSisaCol > -1) {
    for (var i = 1; i < bData.length; i++) {
      var batchBc = bBarcodeCol > -1 ? bData[i][bBarcodeCol].toString().trim() : "";
      var batchNm = bNameCol > -1 ? bData[i][bNameCol].toString().trim() : "";
      
      // Jika kedua identifier kosong, abaikan
      if (batchBc === "" && batchNm === "") continue;
      
      var sisa = parseInt(bData[i][bSisaCol]) || 0;
      if (sisa <= 0) continue; // Hanya ambil batch yang masih aktif memiliki sisa stok
      
      var exp = bExpCol > -1 ? bData[i][bExpCol] : "";
      var buy = bBuyCol > -1 ? (parseInt(bData[i][bBuyCol]) || 0) : 0;
      var bid = bIdCol > -1 ? bData[i][bIdCol] : "";
      
      var batchItem = {
        batchId: bid,
        stokSisa: sisa,
        expiredDate: exp,
        hargaBeli: buy
      };
      
      // Petakan ke Barcode jika ada
      if (batchBc !== "") {
        if (!stokMap[batchBc]) stokMap[batchBc] = 0;
        stokMap[batchBc] += sisa;
        if (!batchesMap[batchBc]) batchesMap[batchBc] = [];
        batchesMap[batchBc].push(batchItem);
      }
      
      // Petakan juga ke Nama Camilan agar produk tanpa barcode atau pencarian nama tetap memiliki stok
      if (batchNm !== "") {
        if (!stokMap[batchNm]) stokMap[batchNm] = 0;
        stokMap[batchNm] += sisa;
        if (!batchesMap[batchNm]) batchesMap[batchNm] = [];
        // Hindari duplikasi jika batchBc sudah sama persis dengan batchNm
        if (batchBc === "" || batchBc !== batchNm) {
          batchesMap[batchNm].push(batchItem);
        }
      }
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
  var pStokCol = pHeaders.indexOf("Stok");
  if (pStokCol === -1) pStokCol = pHeaders.indexOf("Stok_Awal");
  if (pStokCol === -1) pStokCol = pHeaders.indexOf("Stock");
  
  for (var i = 1; i < pData.length; i++) {
    var barcode = pData[i][pBarcodeCol] ? pData[i][pBarcodeCol].toString().trim() : "";
    var name = pData[i][pNameCol] ? pData[i][pNameCol].toString().trim() : "";
    if (!name && !barcode) continue; // Skip baris benar-benar kosong
    var price = parseFloat(pData[i][pPriceCol]) || 0;
    var modal = pModalCol > -1 ? (parseFloat(pData[i][pModalCol]) || 0) : 0;
    
    // Lookup stok: periksa barcode dulu, jika tidak ada/kosong, fallback ke nama produk
    var totalStok = 0;
    var productBatches = [];
    if (barcode && barcode !== "" && stokMap[barcode] !== undefined) {
      totalStok = stokMap[barcode];
      productBatches = batchesMap[barcode] || [];
    } else if (name && name !== "" && stokMap[name] !== undefined) {
      totalStok = stokMap[name];
      productBatches = batchesMap[name] || [];
    } else if (pStokCol > -1) {
      // Fallback jika produk diisi langsung di DatabaseProduk dengan kolom Stok
      totalStok = parseInt(pData[i][pStokCol]) || 0;
      if (totalStok > 0) {
        productBatches = [{
          batchId: "B-" + Date.now() + "-" + i,
          stokSisa: totalStok,
          expiredDate: "",
          hargaBeli: modal
        }];
      }
    }
    
    products.push({
      Barcode_ID: barcode,
      Nama_Camilan: name,
      Harga: price,
      Harga_Modal: modal,
      Stok: totalStok,
      Status: totalStok > 0 ? "Ready" : "Habis",
      batches: productBatches,
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
  
  // Anti-Duplikasi: Cegah transaksi dikurangi/dicatat dua kali jika koneksi internet terputus saat sync
  var tData = tSheet.getDataRange().getDisplayValues();
  if (tData.length > 1) {
    var tIdCol = tData[0].indexOf("ID");
    if (tIdCol === -1) tIdCol = 0;
    for (var tx = 1; tx < tData.length; tx++) {
      if (tData[tx][tIdCol].toString().trim() === transaction.id.toString().trim()) {
        return successResponse('Transaksi ' + transaction.id + ' sudah pernah diproses (diabaikan duplikasi)');
      }
    }
  }
  
  var bData = bSheet.getDataRange().getDisplayValues();
  var bHeaders = bData[0];
  
  var bIdCol = bHeaders.indexOf("Batch_ID");
  var bBarcodeCol = bHeaders.indexOf("Barcode_ID");
  var bExpCol = bHeaders.indexOf("Tanggal_Expired");
  var bSisaCol = bHeaders.indexOf("Stok_Sisa");
  var bStatusCol = bHeaders.indexOf("Status");
  
  var totalHPP = 0;

  // Lakukan FIFO untuk setiap item yang dibeli & hitung HPP aktual
  transaction.items.forEach(function(item) {
    var qtyToDeduct = parseInt(item.qty) || 0;
    if (qtyToDeduct <= 0) return;
    var matchingBatches = [];
    
    var itemBarcode = item.Barcode_ID ? item.Barcode_ID.toString().trim() : "";
    var itemName = item.Nama_Camilan ? item.Nama_Camilan.toString().trim() : "";
    
    // 1. Kumpulkan semua batch produk yang masih memiliki stok
    for (var i = 1; i < bData.length; i++) {
      var batchIdentifier = bBarcodeCol > -1 ? bData[i][bBarcodeCol].toString().trim() : "";
      var batchName = bNameCol > -1 ? bData[i][bNameCol].toString().trim() : "";
      var isMatch = false;
      if (itemBarcode !== "") {
        isMatch = (batchIdentifier === itemBarcode || batchName === itemBarcode);
      } else if (itemName !== "") {
        isMatch = (batchName === itemName || batchIdentifier === itemName);
      }
      
      if (isMatch) {
        var sisa = parseInt(bData[i][bSisaCol]) || 0;
        if (sisa > 0) {
          matchingBatches.push({
            rowIndex: i + 1,
            batchId: bData[i][bIdCol],
            expiredDate: parseDate(bData[i][bExpCol]),
            stokSisa: sisa,
            hargaBeli: bBuyCol > -1 ? (parseFloat(bData[i][bBuyCol]) || 0) : 0
          });
        }
      }
    }
    
    // 2. Urutkan berdasarkan Tanggal Expired (FIFO)
    matchingBatches.sort(function(a, b) { return a.expiredDate - b.expiredDate; });
    
    // 3. Potong stok dari batch secara berurutan & akumulasi HPP aktual dari batch
    for (var k = 0; k < matchingBatches.length; k++) {
      if (qtyToDeduct <= 0) break;
      
      var batch = matchingBatches[k];
      var deductAmount = Math.min(qtyToDeduct, batch.stokSisa);
      var newSisa = batch.stokSisa - deductAmount;
      qtyToDeduct -= deductAmount;
      
      totalHPP += deductAmount * batch.hargaBeli;
      
      bSheet.getRange(batch.rowIndex, bSisaCol + 1).setValue(newSisa);
      bSheet.getRange(batch.rowIndex, bStatusCol + 1).setValue(newSisa === 0 ? "Habis" : "Ready");
    }
    
    // 4. Jika masih ada sisa qty (stok habis/minus), gunakan modal dari DatabaseProduk
    if (qtyToDeduct > 0) {
      var pModal = 0;
      var pSheet = ss.getSheetByName("DatabaseProduk");
      if (pSheet) {
        var pData = pSheet.getDataRange().getDisplayValues();
        var pHeaders = pData[0];
        var pBarcodeCol = pHeaders.indexOf("Barcode_ID"); if (pBarcodeCol === -1) pBarcodeCol = 0;
        var pNameCol = pHeaders.indexOf("Nama_Camilan"); if (pNameCol === -1) pNameCol = 1;
        var pModalCol = pHeaders.indexOf("Harga_Modal"); if (pModalCol === -1) pModalCol = pHeaders.indexOf("Harga_Beli");
        
        for (var pRow = 1; pRow < pData.length; pRow++) {
          var pBc = pData[pRow][pBarcodeCol].toString().trim();
          var pNm = pData[pRow][pNameCol].toString().trim();
          if ((itemBarcode !== "" && pBc === itemBarcode) || (itemName !== "" && pNm === itemName)) {
            pModal = pModalCol > -1 ? (parseFloat(pData[pRow][pModalCol]) || 0) : 0;
            break;
          }
        }
      }
      totalHPP += qtyToDeduct * pModal;
    }
  });

  // Simpan detail transaksi ke database transaksi
  var detailItems = transaction.items.map(function(i) {
    var bonusTag = i.isBonus ? ' [BONUS]' : '';
    return i.Nama_Camilan + bonusTag + " (" + i.qty + "x" + (i.editPrice || 0) + ")";
  }).join(" | ");
  
  // Hitung Laba Bersih = Total Omset Ditargetkan - Total HPP (Modal)
  var netProfit = parseFloat(transaction.total) - totalHPP;
  
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
    transaction.status,
    totalHPP,
    netProfit
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
  if (pBarcodeCol === -1) pBarcodeCol = 0;
  var pNameCol = pHeaders.indexOf("Nama_Camilan");
  if (pNameCol === -1) pNameCol = 1;
  var pPriceCol = pHeaders.indexOf("Harga_Jual");
  if (pPriceCol === -1) pPriceCol = pHeaders.indexOf("Harga");
  if (pPriceCol === -1) pPriceCol = 2;
  var pModalCol = pHeaders.indexOf("Harga_Modal");
  if (pModalCol === -1) pModalCol = pHeaders.indexOf("Harga_Beli");

  var searchBarcode = (product.oldBarcode && product.oldBarcode !== "") ? product.oldBarcode : product.Barcode_ID;
  var exists = false;
  var prodRow = -1;
  
  // 1. Cari apakah produk sudah ada di DatabaseProduk
  if (product._sheetRow && product._sheetRow > 1) {
    prodRow = product._sheetRow;
    exists = true;
  } else if (searchBarcode && searchBarcode.toString().trim() !== "") {
    for (var i = 1; i < pData.length; i++) {
      if (pData[i][pBarcodeCol].toString().trim() === searchBarcode.toString().trim()) {
        exists = true;
        prodRow = i + 1;
        break;
      }
    }
  }
  
  // Fallback: cari berdasarkan Nama_Camilan jika barcode tidak cocok/kosong
  if (!exists && product.Nama_Camilan) {
    for (var i = 1; i < pData.length; i++) {
      if (pData[i][pNameCol].toString().trim() === product.Nama_Camilan.toString().trim()) {
        exists = true;
        prodRow = i + 1;
        break;
      }
    }
  }
  
  if (exists) {
    // Update data produk di baris prodRow sesuai indeks header
    pSheet.getRange(prodRow, pBarcodeCol + 1).setValue(product.Barcode_ID || "");
    pSheet.getRange(prodRow, pNameCol + 1).setValue(product.Nama_Camilan || "");
    pSheet.getRange(prodRow, pPriceCol + 1).setValue(product.Harga || 0);
    if (pModalCol > -1) {
      pSheet.getRange(prodRow, pModalCol + 1).setValue(product.Harga_Beli || product.Harga_Modal || 0);
    }
    
    // Update Barcode_ID & Nama_Camilan di seluruh baris batch di StokBatch agar selalu tersinkron presisi
    var bData = bSheet.getDataRange().getDisplayValues();
    var bHeaders = bData[0];
    var bBarcodeCol = bHeaders.indexOf("Barcode_ID");
    var bNameCol = bHeaders.indexOf("Nama_Camilan");
    
    if (bBarcodeCol > -1 || bNameCol > -1) {
      var oldBc = (product.oldBarcode && product.oldBarcode.toString().trim() !== "") ? product.oldBarcode.toString().trim() : (product.Barcode_ID ? product.Barcode_ID.toString().trim() : "");
      for (var j = 1; j < bData.length; j++) {
        var rowBc = bBarcodeCol > -1 ? bData[j][bBarcodeCol].toString().trim() : "";
        var rowNm = bNameCol > -1 ? bData[j][bNameCol].toString().trim() : "";
        
        var isMatch = false;
        if (oldBc !== "" && rowBc === oldBc) isMatch = true;
        if (product.Barcode_ID && rowBc === product.Barcode_ID.toString().trim()) isMatch = true;
        if (product.Nama_Camilan && rowNm === product.Nama_Camilan.toString().trim()) isMatch = true;
        
        if (isMatch) {
          if (bBarcodeCol > -1) bSheet.getRange(j + 1, bBarcodeCol + 1).setValue(product.Barcode_ID || "");
          if (bNameCol > -1) bSheet.getRange(j + 1, bNameCol + 1).setValue(product.Nama_Camilan || "");
        }
      }
    }
  } else {
    // Sisipkan produk baru sesuai urutan header kolom sheet
    var maxCol = Math.max(pBarcodeCol, pNameCol, pPriceCol, pModalCol) + 1;
    var newRow = new Array(maxCol).fill("");
    newRow[pBarcodeCol] = product.Barcode_ID || "";
    newRow[pNameCol] = product.Nama_Camilan || "";
    newRow[pPriceCol] = product.Harga || 0;
    if (pModalCol > -1) newRow[pModalCol] = product.Harga_Beli || product.Harga_Modal || 0;
    pSheet.appendRow(newRow);
  }
  
  // 2. Buat Batch Awal di StokBatch jika belum ada batch aktif untuk produk ini dan stok > 0
  var stokVal = parseInt(product.Stok) || 0;
  if (stokVal > 0) {
    var bData = bSheet.getDataRange().getDisplayValues();
    var bHeaders = bData[0];
    var bIdCol = bHeaders.indexOf("Batch_ID"); if (bIdCol === -1) bIdCol = 0;
    var bBarcodeCol = bHeaders.indexOf("Barcode_ID"); if (bBarcodeCol === -1) bBarcodeCol = 1;
    var bNameCol = bHeaders.indexOf("Nama_Camilan");
    var bMasukCol = bHeaders.indexOf("Tanggal_Masuk");
    var bExpCol = bHeaders.indexOf("Tanggal_Expired");
    var bAwalCol = bHeaders.indexOf("Stok_Awal");
    var bSisaCol = bHeaders.indexOf("Stok_Sisa");
    var bBuyCol = bHeaders.indexOf("Harga_Beli");
    var bStatusCol = bHeaders.indexOf("Status");
    
    var barcode = product.Barcode_ID || '';
    var name = product.Nama_Camilan || '';
      
    var hasBatch = false;
    for (var k = 1; k < bData.length; k++) {
      var rowBarcode = bBarcodeCol > -1 ? bData[k][bBarcodeCol].toString().trim() : "";
      var rowName = bNameCol > -1 ? bData[k][bNameCol].toString().trim() : "";
      if ((barcode !== "" && rowBarcode === barcode) || (name !== "" && (rowName === name || rowBarcode === name))) {
        hasBatch = true;
        break;
      }
    }
    
    // Jika belum ada batch sama sekali di StokBatch untuk produk ini, buat batch pertamanya
    if (!hasBatch) {
      var batchId = "B-" + Date.now();
      var tanggalMasuk = formatDate(new Date());
      var tanggalExpired = product.Tanggal_Expired || formatDate(new Date(Date.now() + 365*24*60*60*1000));
      var hargaBeli = product.Harga_Beli || product.Harga_Modal || Math.floor(product.Harga * 0.8);
      
      var maxCol = Math.max(bIdCol, bBarcodeCol, bNameCol > -1 ? bNameCol : 0, bMasukCol, bExpCol, bAwalCol, bSisaCol, bBuyCol, bStatusCol) + 1;
      var newBatchRow = new Array(maxCol).fill("");
      newBatchRow[bIdCol] = batchId;
      newBatchRow[bBarcodeCol] = barcode;
      if (bNameCol > -1) newBatchRow[bNameCol] = name;
      if (bMasukCol > -1) newBatchRow[bMasukCol] = tanggalMasuk;
      if (bExpCol > -1) newBatchRow[bExpCol] = tanggalExpired;
      if (bAwalCol > -1) newBatchRow[bAwalCol] = stokVal;
      if (bSisaCol > -1) newBatchRow[bSisaCol] = stokVal;
      if (bBuyCol > -1) newBatchRow[bBuyCol] = hargaBeli;
      if (bStatusCol > -1) newBatchRow[bStatusCol] = "Ready";
      
      bSheet.appendRow(newBatchRow);
    }
  }
  
  syncStokBatchProductNames();
  return successResponse('Produk dan batch berhasil disimpan');
}

function getTransactions() {
  initSheets();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tSheet = ss.getSheetByName("DatabaseTransaksi");
  if (!tSheet) return successResponse([]);
  
  var tData = tSheet.getDataRange().getDisplayValues();
  if (tData.length < 2) return successResponse([]);
  
  var headers = tData[0];
  var idCol = headers.indexOf("ID"); if (idCol === -1) idCol = 0;
  var timeCol = headers.indexOf("Waktu"); if (timeCol === -1) timeCol = 1;
  var custCol = headers.indexOf("Pelanggan"); if (custCol === -1) custCol = 2;
  var detailCol = headers.indexOf("Item (Detail)"); if (detailCol === -1) detailCol = 3;
  var subCol = headers.indexOf("Subtotal"); if (subCol === -1) subCol = 4;
  var discCol = headers.indexOf("Diskon"); if (discCol === -1) discCol = 5;
  var totalCol = headers.indexOf("Total"); if (totalCol === -1) totalCol = 6;
  var methodCol = headers.indexOf("Metode"); if (methodCol === -1) methodCol = 7;
  var cashCol = headers.indexOf("Tunai"); if (cashCol === -1) cashCol = headers.indexOf("Uang_Bayar"); if (cashCol === -1) cashCol = 8;
  var changeCol = headers.indexOf("Kembalian"); if (changeCol === -1) changeCol = 9;
  var statusCol = headers.indexOf("Status"); if (statusCol === -1) statusCol = 10;
  var hppCol = headers.indexOf("HPP"); if (hppCol === -1) hppCol = 11;
  var profitCol = headers.indexOf("Laba_Bersih"); if (profitCol === -1) profitCol = 12;
  
  var transactions = [];
  for (var i = 1; i < tData.length; i++) {
    var row = tData[i];
    var id = row[idCol] ? row[idCol].toString().trim() : "";
    if (!id) continue;
    
    var timestamp = row[timeCol] || "";
    var customer = row[custCol] || "";
    var detailText = row[detailCol] || "";
    var subtotal = parseFloat(row[subCol]) || 0;
    var discount = parseFloat(row[discCol]) || 0;
    var total = parseFloat(row[totalCol]) || 0;
    var method = row[methodCol] || "Tunai";
    var cash = parseFloat(row[cashCol]) || 0;
    var changeVal = parseFloat(row[changeCol]) || 0;
    var status = row[statusCol] || "Lunas";
    var hpp = hppCol > -1 ? (parseFloat(row[hppCol]) || 0) : 0;
    var netProfit = profitCol > -1 ? (parseFloat(row[profitCol]) || 0) : 0;
    
    var items = [];
    if (detailText) {
      var itemParts = detailText.split(" | ");
      itemParts.forEach(function(part) {
        var match = part.match(/^(.+?)\s*\((?:(\d+)x([\d\.]+))\)$/);
        if (match) {
          var nameWithBonus = match[1].trim();
          var isBonus = nameWithBonus.indexOf("[BONUS]") > -1;
          var cleanName = nameWithBonus.replace(/\s*\[BONUS\]/g, "").trim();
          var qty = parseInt(match[2]) || 1;
          var price = parseFloat(match[3]) || 0;
          items.push({
            Nama_Camilan: cleanName,
            qty: qty,
            editPrice: price,
            isBonus: isBonus
          });
        } else {
          items.push({ Nama_Camilan: part, qty: 1, editPrice: 0 });
        }
      });
    }
    
    var remainingDebt = 0;
    if (status !== "Lunas") {
      remainingDebt = Math.max(0, total - cash);
    }
    
    transactions.push({
      id: id,
      timestamp: timestamp,
      customer: customer,
      detailItems: detailText,
      items: items,
      subtotal: subtotal,
      discount: discount,
      total: total,
      method: method,
      cash: cash,
      change: changeVal,
      remainingDebt: remainingDebt,
      status: status,
      hpp: hpp,
      netProfit: netProfit
    });
  }
  
  return successResponse(transactions);
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
  for (var j = bTable.length - 1; j >= 1; j--) {
    if (bTable[j][bBarcodeCol].toString() === data.Barcode_ID.toString()) {
      bSheet.deleteRow(j + 1);
    }
  }
  
  return successResponse('Produk dan seluruh batch berhasil dihapus');
}

// --- Utilities Helper ---

function parseDate(dateStr) {
  if (dateStr instanceof Date) return dateStr;
  var parts = dateStr.toString().split("/");
  if (parts.length === 3) {
    return new Date(parts[2], parts[1] - 1, parts[0]);
  }
  return new Date(dateStr);
}

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

// Tambahkan batch baru saat melakukan restok produk
function processRestock(data) {
  initSheets();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var bSheet = ss.getSheetByName("StokBatch");
  if (!bSheet) return errorResponse('Sheet "StokBatch" tidak ditemukan');
  
  var bHeaders = bSheet.getDataRange().getDisplayValues()[0];
  var bIdCol = bHeaders.indexOf("Batch_ID"); if (bIdCol === -1) bIdCol = 0;
  var bBarcodeCol = bHeaders.indexOf("Barcode_ID"); if (bBarcodeCol === -1) bBarcodeCol = 1;
  var bNameCol = bHeaders.indexOf("Nama_Camilan");
  var bMasukCol = bHeaders.indexOf("Tanggal_Masuk");
  var bExpCol = bHeaders.indexOf("Tanggal_Expired");
  var bAwalCol = bHeaders.indexOf("Stok_Awal");
  var bSisaCol = bHeaders.indexOf("Stok_Sisa");
  var bBuyCol = bHeaders.indexOf("Harga_Beli");
  var bStatusCol = bHeaders.indexOf("Status");
  
  var batchId = "B-" + Date.now();
  var tanggalMasuk = formatDate(new Date());
  var tanggalExpired = data.expired || formatDate(new Date(Date.now() + 365*24*60*60*1000));
  var hargaBeli = data.priceBuy || 0;
  var barcode = data.Barcode_ID || '';
  var name = data.Nama_Camilan || '';
  
  var maxCol = Math.max(bIdCol, bBarcodeCol, bNameCol > -1 ? bNameCol : 0, bMasukCol, bExpCol, bAwalCol, bSisaCol, bBuyCol, bStatusCol) + 1;
  var row = new Array(maxCol).fill("");
  row[bIdCol] = batchId;
  row[bBarcodeCol] = barcode;
  if (bNameCol > -1) row[bNameCol] = name;
  if (bMasukCol > -1) row[bMasukCol] = tanggalMasuk;
  if (bExpCol > -1) row[bExpCol] = tanggalExpired;
  if (bAwalCol > -1) row[bAwalCol] = data.qty;
  if (bSisaCol > -1) row[bSisaCol] = data.qty;
  if (bBuyCol > -1) row[bBuyCol] = hargaBeli;
  if (bStatusCol > -1) row[bStatusCol] = "Ready";
  
  bSheet.appendRow(row);
  syncStokBatchProductNames();
  syncMasterProductCostsFromBatches();
  return successResponse('Restok berhasil disimpan ke StokBatch');
}

function saveSettings(data) {
  initSheets();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Pengaturan");
  if (!sheet) return errorResponse('Sheet "Pengaturan" tidak ditemukan');
  
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, 2).clearContent();
  }
  
  var keys = Object.keys(data);
  var rows = [];
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (key === 'shopLogo') continue;
    var value = data[key] !== undefined && data[key] !== null ? data[key].toString() : '';
    rows.push([key, value]);
  }
  
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, 2).setValues(rows);
  }
  
  return successResponse('Pengaturan berhasil disimpan');
}

function updateBatch(data) {
  initSheets();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var bSheet = ss.getSheetByName("StokBatch");
  if (!bSheet) return errorResponse('Sheet "StokBatch" tidak ditemukan');
  
  var bData = bSheet.getDataRange().getValues();
  var headers = bData[0];
  var bIdCol = headers.indexOf("Batch_ID");
  var bSisaCol = headers.indexOf("Stok_Sisa");
  var bStatusCol = headers.indexOf("Status");
  var bBuyCol = headers.indexOf("Harga_Beli");
  
  if (bIdCol === -1 || bSisaCol === -1) return errorResponse('Kolom Batch_ID atau Stok_Sisa tidak ditemukan');
  
  var batches = data.batches || [];
  var updatedCount = 0;
  
  for (var b = 0; b < batches.length; b++) {
    var batchId = batches[b].batchId;
    var newStok = parseInt(batches[b].stokSisa) || 0;
    var newBuy = batches[b].hargaBeli !== undefined ? (parseInt(batches[b].hargaBeli) || 0) : null;
    
    for (var i = 1; i < bData.length; i++) {
      if (bData[i][bIdCol] === batchId) {
        bSheet.getRange(i + 1, bSisaCol + 1).setValue(newStok);
        if (bStatusCol > -1) {
          bSheet.getRange(i + 1, bStatusCol + 1).setValue(newStok > 0 ? 'Ready' : 'Habis');
        }
        if (bBuyCol > -1 && newBuy !== null) {
          bSheet.getRange(i + 1, bBuyCol + 1).setValue(newBuy);
        }
        updatedCount++;
        break;
      }
    }
  }
  
  syncMasterProductCostsFromBatches();
  return successResponse('Berhasil mengupdate ' + updatedCount + ' batch');
}

function deleteTransaction(data) {
  initSheets();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tSheet = ss.getSheetByName("DatabaseTransaksi");
  var bSheet = ss.getSheetByName("StokBatch");
  if (!tSheet) return errorResponse('Sheet "DatabaseTransaksi" tidak ditemukan');
  
  // 1. Kembalikan stok batch di Google Sheets jika ada data batchDeductions
  if (bSheet && data.batchDeductions && Array.isArray(data.batchDeductions)) {
    var bData = bSheet.getDataRange().getDisplayValues();
    var bHeaders = bData[0];
    var bIdCol = bHeaders.indexOf("Batch_ID");
    var bSisaCol = bHeaders.indexOf("Stok_Sisa");
    var bStatusCol = bHeaders.indexOf("Status");
    
    if (bIdCol > -1 && bSisaCol > -1) {
      data.batchDeductions.forEach(function(bd) {
        if (bd.deductions && Array.isArray(bd.deductions)) {
          bd.deductions.forEach(function(d) {
            for (var row = 1; row < bData.length; row++) {
              if (bData[row][bIdCol].toString().trim() === d.batchId.toString().trim()) {
                var currentSisa = parseInt(bData[row][bSisaCol]) || 0;
                var restoredSisa = currentSisa + (parseInt(d.qty) || 0);
                bSheet.getRange(row + 1, bSisaCol + 1).setValue(restoredSisa);
                if (bStatusCol > -1) {
                  bSheet.getRange(row + 1, bStatusCol + 1).setValue(restoredSisa > 0 ? "Ready" : "Habis");
                }
                break;
              }
            }
          });
        }
      });
    }
  }
  
  // 2. Hapus baris transaksi dari DatabaseTransaksi
  var tData = tSheet.getDataRange().getValues();
  if (tData.length < 2) return successResponse('Sheet transaksi kosong');
  
  var idCol = tData[0].indexOf("ID");
  if (idCol === -1) idCol = 0;
  
  for (var i = 1; i < tData.length; i++) {
    if (tData[i][idCol].toString().trim() === data.id.toString().trim()) {
      tSheet.deleteRow(i + 1);
      return successResponse('Transaksi ' + data.id + ' berhasil dihapus & stok dikembalikan di Google Sheets');
    }
  }
  return successResponse('Transaksi ' + data.id + ' tidak ditemukan di Google Sheets');
}
