'use strict';

const fs = require('fs');
const http = require('http');
const { Telegraf, Markup } = require('telegraf');
const { google } = require('googleapis');

// ========== CONFIG (БҮГД ЭНЭ ХЭСЭГТ) ==========
const CONFIG = {
  // ⚠️ BOT_TOKEN-оо кодонд БҮҮ бич. Render -> Environment Variables дээр BOT_TOKEN гэж тавина.
  BOT_TOKEN: process.env.BOT_TOKEN || '',

  // Spreadsheet болон бусад тохиргоонууд (хүсвэл env болгож болно)
  SPREADSHEET_ID: process.env.SPREADSHEET_ID || '1qbxJsI4Ns3a8lluxlRZl5r5AKHA3hp9yS7YZLwY469A',
  RATE_CHANNEL_ID: process.env.RATE_CHANNEL_ID || '-1003355216653',
  ALLOWED_GROUP_ID: process.env.ALLOWED_GROUP_ID ? Number(process.env.ALLOWED_GROUP_ID) : -5069100118,
  ADMIN_IDS: process.env.ADMIN_IDS
    ? process.env.ADMIN_IDS.split(',').map((x) => Number(x.trim())).filter(Boolean)
    : [1447446407, 1920453419],

  PORT: process.env.PORT || 3000,
  WEBHOOK_DOMAIN: process.env.WEBHOOK_DOMAIN || '', // Render дээр: https://your-app.onrender.com

  // Render Secret File зам (default: /etc/secrets/service-account.json)
  GOOGLE_APPLICATION_CREDENTIALS:
    process.env.GOOGLE_APPLICATION_CREDENTIALS || '/etc/secrets/service-account.json',
};

if (!CONFIG.BOT_TOKEN) {
  console.error('❌ BOT_TOKEN байхгүй');
  process.exit(1);
}

/* ================= GOOGLE AUTH ================= */
function loadGoogleCredentials() {
  const raw = fs.readFileSync(CONFIG.GOOGLE_APPLICATION_CREDENTIALS, 'utf8');
  const creds = JSON.parse(raw);
  if (creds.private_key) {
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  }
  return creds;
}

const sheets = google.sheets({
  version: 'v4',
  auth: new google.auth.GoogleAuth({
    credentials: loadGoogleCredentials(),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  }),
});

const SHEET_NAME = 'Transactions2';

/* ================= BOT ================= */
const bot = new Telegraf(CONFIG.BOT_TOKEN);

/* ================= STATE ================= */
const transactionStates = new Map();
let cachedRates = { org: 45.1, person: 45.2, lastUpdate: 0 };

/* ================= HELPERS ================= */
function parseNumber(str) {
  if (!str) return 0;
  return parseFloat(str.toString().replace(/,/g, '').trim());
}

function formatNumber(num) {
  return Number(num || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function escapeHtml(str) {
  return (str ?? '')
    .toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* === CALCULATION (partials цувж харуулна) === */
function formatCalculation(rub, commission, rubTotal, rate, mntTotal, partials = []) {
  let out = `<pre>`;
  out += `+  ${formatNumber(rub).padStart(13)}\n`;
  out += `+  ${formatNumber(commission).padStart(13)}\n`;
  out += `${'-'.repeat(15)}\n`;
  out += `+  ${formatNumber(rubTotal).padStart(13)}\n`;
  out += `*  ${formatNumber(rate).padStart(13)}\n`;
  out += `${'-'.repeat(15)}\n`;
  out += `+  ${formatNumber(mntTotal).padStart(13)}\n`;

  let sum = 0;
  for (const p of partials) {
    sum += p;
    out += `-  ${formatNumber(p).padStart(13)}\n`;
  }

  if (partials.length) {
    out += `${'-'.repeat(15)}\n`;
    out += `+  ${formatNumber(mntTotal - sum).padStart(13)}\n`;
  }

  out += `</pre>`;
  return out;
}

/* ================= SHEETS ================= */
async function appendTransaction(data) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:S`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [[
      data.number, data.date, data.назначение, data.rub, data.rate,
      data.commission, data.rubTotal, data.mntTotal,
      data.mntReceived, data.mntRemaining, data.status,
      data.startedAt, data.completedAt || '', data.minutes || '',
      data.chatId, data.txMessageId, data.calcMessageId || '',
      data.rateType || '', data.costRate || ''
    ]]},
  });
}

async function findTransactionRow(txMessageId, chatId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:S`,
  });
  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][15] == txMessageId && rows[i][14] == chatId) return i + 1;
  }
  return null;
}

async function updateTransaction(row, updates) {
  const data = [];
  const cols = {
    number:0,date:1,назначение:2,rub:3,rate:4,commission:5,
    rubTotal:6,mntTotal:7,mntReceived:8,mntRemaining:9,status:10,
    startedAt:11,completedAt:12,minutes:13,chatId:14,txMessageId:15,
    calcMessageId:16,rateType:17,costRate:18
  };

  for (const [k,v] of Object.entries(updates)) {
    data.push({
      range: `${SHEET_NAME}!${String.fromCharCode(65+cols[k])}${row}`,
      values: [[v]]
    });
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    resource: { valueInputOption: 'USER_ENTERED', data }
  });
}

/* ================= TRANSACTION FLOW ================= */
async function showCalculation(ctx, state) {
  state.rubTotal = state.rub + state.commission;
  state.mntTotal = state.rubTotal * state.rate;
  state.mntRemaining = state.mntTotal;
  state.partialMntHistory = [];

  const calc = formatCalculation(
    state.rub, state.commission, state.rubTotal, state.rate, state.mntTotal
  );

  const msg = await ctx.reply(
    `📊 <b>Тооцоо:</b>\n\n${calc}`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💰 Шимтгэл өөрчлөх', `change_commission_${state.txMessageId}`)],
        [Markup.button.callback('📊 Ханш өөрчлөх', `change_rate_${state.txMessageId}`)],
        [Markup.button.callback('✅ Батлах', `confirm_transaction_${state.txMessageId}`)]
      ])
    }
  );

  state.calcMessageId = msg.message_id;
  state.step = 'waiting_confirmation';
}

/* ================= CALLBACKS ================= */
bot.action(/confirm_transaction_(.+)/, async (ctx) => {
  const txMessageId = ctx.match[1];
  const state = [...transactionStates.values()].find(s => s.txMessageId == txMessageId);
  if (!state) return;

  await appendTransaction({
    ...state,
    date: new Date().toISOString(),
    mntReceived: 0,
    mntRemaining: state.mntTotal,
    status: 'Хүлээгдэж буй',
  });

  await ctx.reply(
    '💵 <b>MNT бүтэн орсон уу?</b>',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Бүтэн орсон', `confirm_full_${txMessageId}`)],
        [Markup.button.callback('🟠 Хэсэгчлэн орсон', `confirm_partial_${txMessageId}`)]
      ])
    }
  );
});

/* ================= PARTIAL ================= */
bot.action(/confirm_partial_(.+)/, async (ctx) => {
  const txMessageId = ctx.match[1];
  const state = [...transactionStates.values()].find(s => s.txMessageId == txMessageId);
  if (!state) return;

  state.step = 'waiting_partial_mnt';
  await ctx.reply('💸 <b>Хүлээн авсан MNT дүн:</b>', { parse_mode: 'HTML' });
});

/* ================= REPORT ================= */
bot.command('report', async (ctx) => {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:S`,
  });

  const rows = res.data.values || [];
  const pending = rows.slice(1).filter(r => r[10] !== 'Амжилттай');

  let text = '🟠 <b>MNT дутуу орсон:</b>\n\n';

  let total = 0;
  for (const r of pending) {
    total += parseNumber(r[9]);
    text += `№${escapeHtml(r[0])}\n`;
    text += `Назначение: ${escapeHtml(r[2])}\n`;
    text += `Үлдэгдэл тооцоо: <code>${formatNumber(r[9])} MNT</code>\n\n`;
  }

  text += `Нийт: <b>${formatNumber(total)} MNT</b>`;
  await ctx.reply(text, { parse_mode: 'HTML' });
});

/* ================= START ================= */
bot.launch();
console.log('✅ Bot running');

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
});

server.listen(CONFIG.PORT, () => {
  console.log(`✅ HTTP server listening on ${CONFIG.PORT}`);
});
