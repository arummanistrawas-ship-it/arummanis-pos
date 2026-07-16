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

function getProducts() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("DatabaseProduk");
  if (!sheet) return errorResponse('Sheet "DatabaseProduk" tidak ditemukan');

  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return successResponse([]);

  var headers = data[0];
  var products = [];
  
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var product = {};
    for (var j = 0; j < headers.length; j++) {
      product[headers[j]] = row[j];
    }
    products.push(product);
  }
  
  return successResponse(products);
}

function processTransaction(transaction) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // 1. Update Stok di DatabaseProduk
  var pSheet = ss.getSheetByName("DatabaseProduk");
  if (pSheet) {
    var pData = pSheet.getDataRange().getValues();
    var pHeaders = pData[0];
    var bCol = pHeaders.indexOf("Barcode_ID");
    var sCol = pHeaders.indexOf("Stok");
    var stCol = pHeaders.indexOf("Status");
    
    if (bCol > -1 && sCol > -1 && stCol > -1) {
      transaction.items.forEach(item => {
        for (var j = 1; j < pData.length; j++) {
          if (pData[j][bCol] == item.Barcode_ID) {
            var currentStok = parseInt(pData[j][sCol]);
            var newStok = Math.max(0, currentStok - parseInt(item.qty));
            pSheet.getRange(j + 1, sCol + 1).setValue(newStok);
            pSheet.getRange(j + 1, stCol + 1).setValue(newStok === 0 ? 'Habis' : 'Ready');
            break;
          }
        }
      });
    }
  }

  // 2. Simpan ke DatabaseTransaksi
  var tSheet = ss.getSheetByName("DatabaseTransaksi");
  if (!tSheet) {
    // Buat otomatis jika belum ada
    tSheet = ss.insertSheet("DatabaseTransaksi");
    tSheet.appendRow(["ID", "Waktu", "Pelanggan", "Item (Detail)", "Subtotal", "Diskon", "Total", "Metode", "Tunai", "Kembalian", "Status"]);
  }
  
  // Gabungkan item ke string untuk direkap
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
  
  return successResponse('Transaksi berhasil disinkronkan');
}

function updateTransactionStatus(data) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("DatabaseTransaksi");
  if (!sheet) return errorResponse('Sheet "DatabaseTransaksi" tidak ditemukan');
  
  var table = sheet.getDataRange().getValues();
  var headers = table[0];
  var idCol = headers.indexOf("ID");
  var statusCol = headers.indexOf("Status");
  
  if (idCol > -1 && statusCol > -1) {
    for (var i = 1; i < table.length; i++) {
      if (table[i][idCol] === data.id) {
        sheet.getRange(i + 1, statusCol + 1).setValue(data.status);
        return successResponse('Status diperbarui');
      }
    }
  }
  return errorResponse('Transaksi tidak ditemukan');
}

function saveProduct(product) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("DatabaseProduk");
  if (!sheet) return errorResponse('Sheet "DatabaseProduk" tidak ditemukan');
  
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var bCol = headers.indexOf("Barcode_ID");
  
  // Update jika ada, Insert jika tidak
  for (var i = 1; i < data.length; i++) {
    if (data[i][bCol] == product.Barcode_ID) {
      sheet.getRange(i + 1, 1, 1, 5).setValues([[
        product.Barcode_ID, product.Nama_Camilan, product.Harga, product.Stok, product.Status
      ]]);
      return successResponse('Produk diperbarui');
    }
  }
  
  // Kolom A-E: Barcode_ID, Nama_Camilan, Harga, Stok, Status
  sheet.appendRow([product.Barcode_ID, product.Nama_Camilan, product.Harga, product.Stok, product.Status]);
  return successResponse('Produk ditambahkan');
}

function deleteProduct(data) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("DatabaseProduk");
  if (!sheet) return errorResponse('Sheet "DatabaseProduk" tidak ditemukan');
  
  var table = sheet.getDataRange().getValues();
  var headers = table[0];
  var bCol = headers.indexOf("Barcode_ID");
  
  for (var i = 1; i < table.length; i++) {
    if (table[i][bCol] == data.Barcode_ID) {
      sheet.deleteRow(i + 1);
      return successResponse('Produk dihapus');
    }
  }
  return successResponse('Produk tidak ada (mungkin sudah dihapus)');
}

function successResponse(data) {
  return ContentService.createTextOutput(JSON.stringify({ status: 'success', data: data })).setMimeType(ContentService.MimeType.JSON);
}
function errorResponse(msg) {
  return ContentService.createTextOutput(JSON.stringify({ status: 'error', message: msg })).setMimeType(ContentService.MimeType.JSON);
}
