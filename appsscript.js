/**
 * OYUNS BOT — Google Apps Script (Web App)
 *
 * Байршуулах заавар:
 * 1. Google Sheets → Extensions → Apps Script
 * 2. Энэ кодыг бүгдийг нь paste хийнэ
 * 3. Deploy → New deployment → Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 *
 * Sheets:
 *   Transactions — A:№  B:Огноо  C:Тайлбар  D:Дүн(руб)  E:Ханш  F:Timestamp  G:(хоосон)
 *   SWIFT        — A:№  B:Текст  C:Гүйцэтгэгч  D:Дүн  E:Валют  F:Ханш  G:USDT  H:Баланс
 */

const SHEET_ID = '1qbxJsI4Ns3a8lluxlRZl5r5AKHA3hp9yS7YZLwY469A'

// ─── GET запрос ────────────────────────────────────────────────
function doGet(e) {
  const action = e.parameter.action
  const sheet  = e.parameter.sheet || 'Transactions'

  try {
    if (action === 'summary') return jsonResponse(getSummary())

    const ss = SpreadsheetApp.openById(SHEET_ID)
    const ws = ss.getSheetByName(sheet)
    if (!ws) return jsonResponse({ error: 'Sheet олдсонгүй: ' + sheet })

    const data = ws.getDataRange().getValues()
    return jsonResponse({ sheet, data })
  } catch (err) {
    return jsonResponse({ error: err.message })
  }
}

// ─── POST запрос ───────────────────────────────────────────────
function doPost(e) {
  try {
    const body   = JSON.parse(e.postData.contents)
    const action = body.action

    switch (action) {
      case 'recalculateSwift': return jsonResponse(recalculateSwiftBalance())
      case 'updateSwiftRate':  return jsonResponse(updateSwiftRate(body))
      default: return jsonResponse({ error: 'Тодорхойгүй action: ' + action })
    }
  } catch (err) {
    return jsonResponse({ error: err.message })
  }
}

// ─── onOpen: цэс ───────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('OYUNS')
    .addItem('SWIFT: Баланс шинэчлэх', 'recalculateSwiftBalance')
    .addItem('SWIFT: Өдрийн тайлан',   'swiftDailySummary')
    .addSeparator()
    .addItem('Transactions: Өдрийн тайлан', 'transactionsDailySummary')
    .addToUi()
}

// ─── onEdit: SWIFT-ийн Ханш оруулах үед автоматаар тооцно ──────
function onEdit(e) {
  const sheet = e.range.getSheet()
  if (sheet.getName() !== 'SWIFT') return
  if (e.range.getColumn() === 6) {   // F = Ханш
    recalculateSwiftBalance()
  }
}

// ─── Summary: бүх үндсэн мэдээлэл ─────────────────────────────
function getSummary() {
  const ss  = SpreadsheetApp.openById(SHEET_ID)
  const trWs = ss.getSheetByName('Transactions')
  const swWs = ss.getSheetByName('SWIFT')

  const today = Utilities.formatDate(new Date(), 'Asia/Ulaanbaatar', 'yyyy.MM.dd')

  // ── Transactions тайлан ──
  const trSummary = parseTransactionsSheet(trWs, today)

  // ── SWIFT тайлан ──
  const swSummary = parseSwiftSheet(swWs)

  return {
    today,
    transactions: trSummary,
    swift:        swSummary,
  }
}

// Transactions sheet-с өнөөдрийн тайлан
function parseTransactionsSheet(ws, today) {
  if (!ws) return null

  const data = ws.getDataRange().getValues()
  let todayRub  = 0
  let todayUsdt = 0
  let txCount   = 0
  let lastRate  = null

  for (var i = data.length - 1; i >= 1; i--) {
    var row  = data[i]
    var date = (row[1] || '').toString().trim()
    var dun  = parseFloat(row[3]) || 0
    var rate = parseFloat(row[4]) || 0

    if (rate > 0 && lastRate === null) lastRate = rate

    if (date === today && dun > 0) {
      todayRub += dun
      if (rate > 0) todayUsdt += dun / rate
      txCount++
    }
  }

  return {
    lastRate:  lastRate,
    todayRub:  todayRub,
    todayUsdt: parseFloat(todayUsdt.toFixed(2)),
    txCount:   txCount,
  }
}

// SWIFT sheet-с тайлан
function parseSwiftSheet(ws) {
  if (!ws) return null

  const data = ws.getDataRange().getValues()
  const byCurrency = {}
  let totalUsdt  = 0
  let lastBalance = 0
  let txCount    = 0

  for (var i = 1; i < data.length; i++) {
    var row      = data[i]
    var dun      = parseFloat(row[3]) || 0
    var currency = (row[4] || '').toString().toUpperCase()
    var usdt     = parseFloat(row[6]) || 0
    var bal      = parseFloat(row[7]) || 0

    if (dun > 0 && currency) {
      byCurrency[currency] = (byCurrency[currency] || 0) + dun
      txCount++
    }
    if (usdt > 0) totalUsdt += usdt
    if (bal !== 0) lastBalance = bal
  }

  return {
    byCurrency:  byCurrency,
    totalUsdt:   parseFloat(totalUsdt.toFixed(2)),
    lastBalance: parseFloat(lastBalance.toFixed(2)),
    txCount:     txCount,
  }
}

// ─── SWIFT: USDT + Баланс тооцоо ───────────────────────────────
// USDT = Дүн (D) / Ханш (F)    Баланс = нийлбэр (withdrawal-ийг сөрөгөөр тооцно)
function recalculateSwiftBalance() {
  const ss = SpreadsheetApp.openById(SHEET_ID)
  const ws = ss.getSheetByName('SWIFT')
  if (!ws) return { error: 'SWIFT sheet олдсонгүй' }

  const lastRow = ws.getLastRow()
  if (lastRow < 2) return { updated: 0 }

  const numRows = lastRow - 1
  const data    = ws.getRange(2, 1, numRows, 7).getValues()

  const usdtOut = []
  const balOut  = []
  let balance   = 0

  for (var i = 0; i < data.length; i++) {
    var dun   = data[i][3]  // D
    var hansh = data[i][5]  // F
    var usdt  = data[i][6]  // G одоогийн утга

    // D ба F хоёулаа эерэг тоо байвал шинээр тооцно
    if (isPos(dun) && isPos(hansh)) {
      usdt = dun / hansh
    }

    var usdtVal = (typeof usdt === 'number' && !isNaN(usdt)) ? usdt : ''
    usdtOut.push([usdtVal])

    // Тоон утга байвал (сөрөг withdrawal-ийг ч тооцно)
    if (typeof usdtVal === 'number' && usdtVal !== 0) {
      balance += usdtVal
      balOut.push([balance])
    } else {
      balOut.push([''])
    }
  }

  // Batch write
  ws.getRange(2, 7, numRows, 1).setValues(usdtOut)
  ws.getRange(2, 8, numRows, 1).setValues(balOut)

  // G, H форматлах: $#,##0.00
  ws.getRange(2, 7, numRows, 2).setNumberFormat('"$"#,##0.00')

  return { success: true, updated: numRows, lastBalance: parseFloat(balance.toFixed(2)) }
}

// ─── SWIFT: тодорхой мөрийн Ханш шинэчлэх ─────────────────────
// body: { rowIndex: 5, rate: 158.80 }
function updateSwiftRate(body) {
  var rowIndex = parseInt(body.rowIndex)
  var rate     = parseFloat(body.rate)
  if (!rowIndex || !rate || rate <= 0) return { error: 'Буруу параметр' }

  const ss = SpreadsheetApp.openById(SHEET_ID)
  const ws = ss.getSheetByName('SWIFT')
  if (!ws) return { error: 'SWIFT sheet олдсонгүй' }

  ws.getRange(rowIndex, 6).setValue(rate)   // F = Ханш
  recalculateSwiftBalance()
  return { success: true, rowIndex, rate }
}

// ─── Цэсний тайлан функцүүд ────────────────────────────────────
function swiftDailySummary() {
  const ss  = SpreadsheetApp.openById(SHEET_ID)
  const res = parseSwiftSheet(ss.getSheetByName('SWIFT'))
  if (!res) { showAlert('SWIFT sheet олдсонгүй.'); return }

  var lines = ['Нийт гүйлгээ: ' + res.txCount + '\n']
  for (var cur in res.byCurrency) {
    lines.push(cur + ': ' + fmtNum(res.byCurrency[cur]))
  }
  lines.push('\nНийт USDT:       $' + res.totalUsdt.toFixed(2))
  lines.push('Одоогийн баланс: $' + res.lastBalance.toFixed(2))
  showAlert('SWIFT өдрийн тайлан', lines.join('\n'))
}

function transactionsDailySummary() {
  const ss    = SpreadsheetApp.openById(SHEET_ID)
  const today = Utilities.formatDate(new Date(), 'Asia/Ulaanbaatar', 'yyyy.MM.dd')
  const res   = parseTransactionsSheet(ss.getSheetByName('Transactions'), today)
  if (!res) { showAlert('Transactions sheet олдсонгүй.'); return }

  var lines = [
    'Огноо: ' + today,
    'Гүйлгээний тоо: ' + res.txCount,
    'Нийт дүн: ' + fmtNum(res.todayRub) + ' руб',
    'Одоогийн ханш: ' + (res.lastRate || '—'),
    'Нийт USDT: $' + res.todayUsdt.toFixed(2),
  ]
  showAlert('Transactions өдрийн тайлан', lines.join('\n'))
}

// ─── Туслах функцүүд ───────────────────────────────────────────
function isPos(val) {
  return typeof val === 'number' && !isNaN(val) && val > 0
}

function fmtNum(n) {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

function showAlert(title, msg) {
  if (msg === undefined) { msg = title; title = 'OYUNS' }
  SpreadsheetApp.getUi().alert(title, msg, SpreadsheetApp.getUi().ButtonSet.OK)
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON)
}
