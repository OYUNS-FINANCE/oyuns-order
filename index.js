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
  console.error('❌ BOT_TOKEN байхгүй байна. Render -> Environment Variables дээр BOT_TOKEN тавина уу.');
  process.exit(1);
}

// ========== GOOGLE SERVICE ACCOUNT LOAD ==========
function loadGoogleCredentials() {
  const keyFile = CONFIG.GOOGLE_APPLICATION_CREDENTIALS;

  if (!fs.existsSync(keyFile)) {
    console.error(`❌ Service account файл олдсонгүй: ${keyFile}`);
    console.error('💡 Render Secret File нэр/зам зөв эсэхийг шалга. Эсвэл GOOGLE_APPLICATION_CREDENTIALS env var тавь.');
    process.exit(1);
  }

  let raw = fs.readFileSync(keyFile, 'utf8');
  let creds;

  try {
    creds = JSON.parse(raw);
  } catch (e) {
    console.error('❌ Service account JSON parse хийхэд алдаа гарлаа.');
    console.error('Файлын формат JSON мөн эсэхийг шалгана уу.');
    process.exit(1);
  }

  // Node/OpenSSL дээр хамгийн их асуудал гаргадаг хэсэг: newline escape
  if (creds.private_key) {
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  }

  return creds;
}

const GOOGLE_CREDENTIALS = loadGoogleCredentials();

// ========== BOT ==========
const bot = new Telegraf(CONFIG.BOT_TOKEN);

// ========== GOOGLE SHEETS ==========
const auth = new google.auth.GoogleAuth({
  credentials: GOOGLE_CREDENTIALS,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });
const SHEET_NAME = 'Transactions2';

// Sheets Lock для предотвращения race condition
let sheetsLock = Promise.resolve();
const lockSheets = (fn) => {
  sheetsLock = sheetsLock.then(fn).catch(fn);
  return sheetsLock;
};

// ========== STATE STORAGE ==========
const transactionStates = new Map(); // key: `${chatId}_${messageId}`
let cachedRates = { org: 45.10, person: 45.20, lastUpdate: 0 };

// ========== HELPER FUNCTIONS ==========
function parseNumber(str) {
  if (!str) return 0;
  return parseFloat(str.toString().replace(/,/g, '').trim());
}

function formatNumber(num) {
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatCalculation(rub, commission, rubTotal, rate, mntTotal, mntReceived = null) {
  let calc = `<pre>`;
  calc += `+  ${formatNumber(rub).padStart(13)}\n`;
  calc += `+  ${formatNumber(commission).padStart(13)}\n`;
  calc += `${'-'.repeat(15)}\n`;
  calc += `+  ${formatNumber(rubTotal).padStart(13)}\n`;
  calc += `*  ${formatNumber(rate).padStart(13)}\n`;
  calc += `${'-'.repeat(15)}\n`;
  calc += `+  ${formatNumber(mntTotal).padStart(13)}\n`;

  if (mntReceived !== null && mntReceived > 0) {
    calc += `-  ${formatNumber(mntReceived).padStart(13)}\n`;
    calc += `${'-'.repeat(15)}\n`;
    calc += `+  ${formatNumber(mntTotal - mntReceived).padStart(13)}\n`;
  }

  calc += `</pre>`;
  return calc;
}

// ========== GOOGLE SHEETS OPERATIONS ==========
async function appendTransaction(data) {
  return lockSheets(async () => {
    const values = [[
      data.number,
      data.date,
      data.назначение,
      data.rub,
      data.rate,
      data.commission,
      data.rubTotal,
      data.mntTotal,
      data.mntReceived || 0,
      data.mntRemaining,
      data.status,
      data.startedAt,
      data.completedAt || '',
      data.minutes || '',
      data.chatId,
      data.txMessageId,
      data.calcMessageId || '',
      data.rateType || '',
      data.costRate || ''
    ]];

    await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:S`,
      valueInputOption: 'USER_ENTERED',
      resource: { values }
    });
  });
}

async function findTransactionRow(txMessageId, chatId) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:S`
  });

  const rows = response.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][15] == txMessageId && rows[i][14] == chatId) {
      return i + 1; // Row number (1-based)
    }
  }
  return null;
}

async function updateTransaction(rowNum, updates) {
  return lockSheets(async () => {
    const requests = [];

    for (const [col, value] of Object.entries(updates)) {
      const colIndex = getColumnIndex(col);
      requests.push({
        range: `${SHEET_NAME}!${String.fromCharCode(65 + colIndex)}${rowNum}`,
        values: [[value]]
      });
    }

    if (requests.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: CONFIG.SPREADSHEET_ID,
        resource: {
          valueInputOption: 'USER_ENTERED',
          data: requests
        }
      });
    }
  });
}

function getColumnIndex(colName) {
  const cols = {
    'number': 0, 'date': 1, 'назначение': 2, 'rub': 3, 'rate': 4,
    'commission': 5, 'rubTotal': 6, 'mntTotal': 7, 'mntReceived': 8,
    'mntRemaining': 9, 'status': 10, 'startedAt': 11, 'completedAt': 12,
    'minutes': 13, 'chatId': 14, 'txMessageId': 15, 'calcMessageId': 16,
    'rateType': 17, 'costRate': 18
  };
  return cols[colName];
}

async function getTodayTransactions() {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:S`
  });

  const rows = response.data.values || [];
  const today = new Date().toISOString().split('T')[0];

  const transactions = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const date = row[1] ? row[1].split('T')[0] : '';
    if (date === today) {
      transactions.push({
        number: row[0],
        date: row[1],
        назначение: row[2],
        rub: parseNumber(row[3]),
        rate: parseNumber(row[4]),
        commission: parseNumber(row[5]),
        rubTotal: parseNumber(row[6]),
        mntTotal: parseNumber(row[7]),
        mntReceived: parseNumber(row[8]),
        mntRemaining: parseNumber(row[9]),
        status: row[10],
        costRate: parseNumber(row[18])
      });
    }
  }

  return transactions;
}

// ========== RATE FETCHING ==========
async function fetchLatestRatesFromChannel() {
  console.log('⏳ Сувгаас шинэ ханш хүлээж байна...');
  console.log('💡 Сувагт ханш нийтлэх эсвэл /debug командаар одоогийн ханш шалгана уу');
}

async function fetchLatestRates() {
  return cachedRates;
}

// ========== BOT HANDLERS ==========

// Каналын мессежийг сонсох (ханш шинэчлэгдэх үед)
bot.on('channel_post', async (ctx) => {
  try {
    console.log('📥 Channel post ирлээ:', ctx.channelPost.chat.id);

    if (ctx.channelPost.chat.id == CONFIG.RATE_CHANNEL_ID && ctx.channelPost.text) {
      const text = ctx.channelPost.text;
      console.log('📝 Текст:', text.substring(0, 100));

      const orgMatch = text.match(/🏦[^:]*:\s*([\d.,]+)/);
      const personMatch = text.match(/👤[^:]*:\s*([\d.,]+)/);

      if (orgMatch) {
        cachedRates.org = parseFloat(orgMatch[1].replace(',', '.'));
        console.log('🏦 Байгууллагын ханш шинэчлэгдлээ:', cachedRates.org);
      }
      if (personMatch) {
        cachedRates.person = parseFloat(personMatch[1].replace(',', '.'));
        console.log('👤 Хувь хүний ханш шинэчлэгдлээ:', cachedRates.person);
      }

      if (orgMatch || personMatch) {
        cachedRates.lastUpdate = Date.now();
        console.log(`✅ ХАНШ ШИНЭЧЛЭГДЛЭЭ: 🏦 ${cachedRates.org} | 👤 ${cachedRates.person}`);
      }
    }
  } catch (err) {
    console.error('❌ Channel post алдаа:', err);
  }
});

// Зургатай гүйлгээний мессеж (photo with caption)
bot.on('photo', async (ctx) => {
  try {
    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;
    const caption = (ctx.message.caption || '').trim();

    console.log(`📸 Зураг ирлээ: chatId=${chatId}, caption="${caption.substring(0, 50)}..."`);

    if (chatId !== CONFIG.ALLOWED_GROUP_ID && !CONFIG.ADMIN_IDS.includes(ctx.from.id)) {
      console.log('⚠️ Зөвшөөрөгдөөгүй chat-аас зураг');
      return;
    }

    const numberMatch = caption.match(/^(\d+)\./m);
    const назначениеMatch = caption.match(/Назначение:\s*(.+)/i);
    const суммаMatch = caption.match(/Сумма:\s*([\d,]+\.?\d*)/i);

    if (numberMatch && назначениеMatch && суммаMatch) {
      const number = numberMatch[1];
      const назначение = назначениеMatch[1].trim();
      const rub = parseNumber(суммаMatch[1]);

      console.log(`✅ Гүйлгээ таньсан (зургаас): №${number}, ${назначение}, ${rub} RUB`);

      const stateKey = `${chatId}_${messageId}`;
      transactionStates.set(stateKey, {
        number,
        назначение,
        rub,
        chatId,
        txMessageId: messageId,
        step: 'waiting_cost_rate',
        startedAt: new Date().toISOString()
      });

      await ctx.reply('💰 <b>Өртөг ханш оруулна уу:</b>', { parse_mode: 'HTML' });
      return;
    }
  } catch (err) {
    console.error('❌ Photo handler алдаа:', err);
    try { await ctx.reply('❌ Алдаа гарлаа. Дахин оролдоно уу.'); } catch (e) {}
  }
});

// Обработка входящих сообщений о транзакциях
bot.on('text', async (ctx, next) => {
  try {
    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;
    const text = (ctx.message.text || '').trim();

    console.log(`📩 Мессеж ирлээ: chatId=${chatId}, text="${text.substring(0, 50)}..."`);

    if (text.startsWith('/')) return next();

    if (chatId !== CONFIG.ALLOWED_GROUP_ID && !CONFIG.ADMIN_IDS.includes(ctx.from.id)) {
      console.log('⚠️ Зөвшөөрөгдөөгүй chat-аас мессеж');
      return;
    }

    const numberMatch = text.match(/^(\d+)\./m);
    const назначениеMatch = text.match(/Назначение:\s*(.+)/i);
    const суммаMatch = text.match(/Сумма:\s*([\d,]+\.?\d*)/i);

    if (numberMatch && назначениеMatch && суммаMatch) {
      const number = numberMatch[1];
      const назначение = назначениеMatch[1].trim();
      const rub = parseNumber(суммаMatch[1]);

      console.log(`✅ Гүйлгээ таньсан: №${number}, ${назначение}, ${rub} RUB`);

      const stateKey = `${chatId}_${messageId}`;
      transactionStates.set(stateKey, {
        number,
        назначение,
        rub,
        chatId,
        txMessageId: messageId,
        step: 'waiting_cost_rate',
        startedAt: new Date().toISOString()
      });

      await ctx.reply('💰 <b>Өртөг ханш оруулна уу:</b>', { parse_mode: 'HTML' });
      return;
    }

    if (ctx.message.reply_to_message) {
      for (const [key, state] of transactionStates.entries()) {
        if (!key.includes(`${chatId}_`)) continue;

        if (state.step === 'waiting_cost_rate' && state.txMessageId) {
          const costRate = parseNumber(text);
          if (costRate > 0) {
            state.costRate = costRate;
            state.step = 'waiting_sell_rate';

            const rates = await fetchLatestRates();
            await ctx.reply('📊 <b>Зарах ханш сонгоно уу:</b>', {
              reply_to_message_id: state.txMessageId,
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard([
                [
                  Markup.button.callback(`🏦 ${rates.org.toFixed(2)}`, `rate_org_${state.txMessageId}`),
                  Markup.button.callback(`👤 ${rates.person.toFixed(2)}`, `rate_person_${state.txMessageId}`)
                ],
                [Markup.button.callback('✍️ Өөр ханш оруулах', `rate_custom_${state.txMessageId}`)]
              ])
            });
          }
          return;
        }

        if (state.step === 'waiting_custom_rate' && state.txMessageId == ctx.message.reply_to_message.reply_to_message?.message_id) {
          const customRate = parseNumber(text);
          if (customRate > 0) {
            state.rate = customRate;
            state.rateType = 'Өөр';
            await processCommission(ctx, state);
          }
          return;
        }

        if (state.step === 'waiting_commission' && state.calcMessageId == ctx.message.reply_to_message.message_id) {
          const commission = parseNumber(text);
          if (commission > 0) {
            state.commission = commission;
            await showCalculation(ctx, state);
          }
          return;
        }

        if (state.step === 'waiting_partial_mnt') {
          const mntReceived = parseNumber(text);
          if (mntReceived > 0) {
            state.mntReceived = (state.mntReceived || 0) + mntReceived;
            state.mntRemaining = state.mntTotal - state.mntReceived;

            const rowNum = await findTransactionRow(state.txMessageId, chatId);
            if (rowNum) {
              await updateTransaction(rowNum, {
                'mntReceived': state.mntReceived,
                'mntRemaining': state.mntRemaining,
                'status': state.mntRemaining <= 0 ? 'Амжилттай' : 'Хэсэгчлэн орсон'
              });
            }

            const calc = formatCalculation(state.rub, state.commission, state.rubTotal, state.rate, state.mntTotal, state.mntReceived);

            await ctx.reply(`✅ <b>Хэсэгчлэн орлоо:</b> ${formatNumber(mntReceived)} MNT\n\n${calc}`, { parse_mode: 'HTML' });

            if (state.mntRemaining <= 0) {
              const completedAt = new Date().toISOString();
              const minutes = Math.round((new Date(completedAt) - new Date(state.startedAt)) / 60000);

              if (rowNum) {
                await updateTransaction(rowNum, {
                  'completedAt': completedAt,
                  'minutes': minutes,
                  'status': 'Амжилттай'
                });
              }

              await ctx.reply('🎉 <b>Гүйлгээ амжилттай хаагдлаа!</b>', { parse_mode: 'HTML' });
              transactionStates.delete(key);
            } else {
              state.step = 'waiting_confirmation';
              await ctx.reply(
                '💵 <b>MNT бүтэн орсон уу?</b>',
                Markup.inlineKeyboard([
                  [Markup.button.callback('✅ Бүтэн орсон', `confirm_full_${state.txMessageId}`)],
                  [Markup.button.callback('🟠 Дахин хэсэгчлэн орсон', `confirm_partial_${state.txMessageId}`)]
                ])
              );
            }
          }
          return;
        }
      }
    }

    // ✅ Reply хийхгүйгээр дараагийн мессежээр хариулах
    for (const [key, state] of transactionStates.entries()) {
      if (!key.includes(`${chatId}_`)) continue;

      if (state.step === 'waiting_cost_rate') {
        const costRate = parseNumber(text);
        if (costRate > 0) {
          state.costRate = costRate;
          state.step = 'waiting_sell_rate';

          const rates = await fetchLatestRates();
          await ctx.reply('📊 <b>Зарах ханш сонгоно уу:</b>', {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback(`🏦 ${rates.org.toFixed(2)}`, `rate_org_${state.txMessageId}`),
                Markup.button.callback(`👤 ${rates.person.toFixed(2)}`, `rate_person_${state.txMessageId}`)
              ],
              [Markup.button.callback('✍️ Өөр ханш оруулах', `rate_custom_${state.txMessageId}`)]
            ])
          });
          return;
        }
      }

      if (state.step === 'waiting_custom_rate') {
        const customRate = parseNumber(text);
        if (customRate > 0) {
          state.rate = customRate;
          state.rateType = 'Өөр';
          await processCommission(ctx, state);
          return;
        }
      }

      if (state.step === 'waiting_commission') {
        const commission = parseNumber(text);
        if (commission > 0) {
          state.commission = commission;
          await showCalculation(ctx, state);
          return;
        }
      }

      if (state.step === 'waiting_partial_mnt') {
        const mntReceived = parseNumber(text);
        if (mntReceived > 0) {
          state.mntReceived = (state.mntReceived || 0) + mntReceived;
          state.mntRemaining = state.mntTotal - state.mntReceived;

          const rowNum = await findTransactionRow(state.txMessageId, chatId);
          if (rowNum) {
            await updateTransaction(rowNum, {
              'mntReceived': state.mntReceived,
              'mntRemaining': state.mntRemaining,
              'status': state.mntRemaining <= 0 ? 'Амжилттай' : 'Хэсэгчлэн орсон'
            });
          }

          const calc = formatCalculation(state.rub, state.commission, state.rubTotal, state.rate, state.mntTotal, state.mntReceived);
          await ctx.reply(`✅ <b>Хэсэгчлэн орлоо:</b> ${formatNumber(mntReceived)} MNT\n\n${calc}`, { parse_mode: 'HTML' });

          if (state.mntRemaining <= 0) {
            const completedAt = new Date().toISOString();
            const minutes = Math.round((new Date(completedAt) - new Date(state.startedAt)) / 60000);

            if (rowNum) {
              await updateTransaction(rowNum, {
                'completedAt': completedAt,
                'minutes': minutes,
                'status': 'Амжилттай'
              });
            }

            await ctx.reply('🎉 <b>Гүйлгээ амжилттай хаагдлаа!</b>', { parse_mode: 'HTML' });
            transactionStates.delete(key);
          } else {
            state.step = 'waiting_confirmation';
            await ctx.reply(
              '💵 <b>MNT бүтэн орсон уу?</b>',
              Markup.inlineKeyboard([
                [Markup.button.callback('✅ Бүтэн орсон', `confirm_full_${state.txMessageId}`)],
                [Markup.button.callback('🟠 Дахин хэсэгчлэн орсон', `confirm_partial_${state.txMessageId}`)]
              ])
            );
          }
          return;
        }
      }
    }
  } catch (err) {
    console.error('❌ Text handler алдаа:', err);
    try { await ctx.reply('❌ Алдаа гарлаа. Дахин оролдоно уу.'); } catch (e) {}
  }
});

// Callback handlers
bot.action(/rate_(org|person|custom)_(.+)/, async (ctx) => {
  const [, type, txMessageId] = ctx.match;
  const chatId = ctx.chat.id;

  const state = findStateByTxId(chatId, txMessageId);
  if (!state) return;

  const rates = await fetchLatestRates();

  if (type === 'org') {
    state.rate = rates.org;
    state.rateType = 'Байгууллага';
    await ctx.answerCbQuery('🏦 Байгууллагын ханш сонгогдлоо');
    await processCommission(ctx, state);
  } else if (type === 'person') {
    state.rate = rates.person;
    state.rateType = 'Хувь хүн';
    await ctx.answerCbQuery('👤 Хувь хүний ханш сонгогдлоо');
    await processCommission(ctx, state);
  } else {
    state.step = 'waiting_custom_rate';
    await ctx.answerCbQuery();
    await ctx.reply('✍️ <b>Зарах ханш оруулна уу:</b>', {
      reply_to_message_id: state.txMessageId,
      parse_mode: 'HTML'
    });
  }
});

bot.action(/change_commission_(.+)/, async (ctx) => {
  const txMessageId = ctx.match[1];
  const chatId = ctx.chat.id;

  const state = findStateByTxId(chatId, txMessageId);
  if (!state) return;

  state.step = 'waiting_commission';
  await ctx.answerCbQuery();
  await ctx.reply('💰 <b>Шимтгэл оруулна уу:</b>', {
    reply_to_message_id: state.calcMessageId,
    parse_mode: 'HTML'
  });
});

bot.action(/change_rate_(.+)/, async (ctx) => {
  const txMessageId = ctx.match[1];
  const chatId = ctx.chat.id;

  const state = findStateByTxId(chatId, txMessageId);
  if (!state) return;

  await ctx.answerCbQuery();
  const rates = await fetchLatestRates();

  await ctx.editMessageReplyMarkup({
    inline_keyboard: [
      [
        { text: `🏦 ${rates.org.toFixed(2)}`, callback_data: `rate_org_${txMessageId}` },
        { text: `👤 ${rates.person.toFixed(2)}`, callback_data: `rate_person_${txMessageId}` }
      ],
      [{ text: '✍️ Өөр ханш оруулах', callback_data: `rate_custom_${txMessageId}` }]
    ]
  });
});

bot.action(/confirm_transaction_(.+)/, async (ctx) => {
  const txMessageId = ctx.match[1];
  const chatId = ctx.chat.id;

  const state = findStateByTxId(chatId, txMessageId);
  if (!state) return;

  await ctx.answerCbQuery();

  const rowNum = await findTransactionRow(state.txMessageId, chatId);
  if (!rowNum) {
    await appendTransaction({
      number: state.number,
      date: new Date().toISOString(),
      назначение: state.назначение,
      rub: state.rub,
      rate: state.rate,
      commission: state.commission,
      rubTotal: state.rubTotal,
      mntTotal: state.mntTotal,
      mntReceived: 0,
      mntRemaining: state.mntTotal,
      status: 'Хүлээгдэж буй',
      startedAt: state.startedAt,
      chatId: state.chatId,
      txMessageId: state.txMessageId,
      calcMessageId: state.calcMessageId,
      rateType: state.rateType,
      costRate: state.costRate
    });
  }

  state.step = 'waiting_confirmation';

  await ctx.reply(
    '💵 <b>MNT бүтэн орсон уу?</b>',
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Бүтэн орсон', `confirm_full_${txMessageId}`)],
      [Markup.button.callback('🟠 Хэсэгчлэн орсон', `confirm_partial_${txMessageId}`)]
    ])
  );
});

bot.action(/confirm_full_(.+)/, async (ctx) => {
  const txMessageId = ctx.match[1];
  const chatId = ctx.chat.id;

  const state = findStateByTxId(chatId, txMessageId);
  if (!state) return;

  await ctx.answerCbQuery('✅ Амжилттай');

  state.mntReceived = state.mntTotal;
  state.mntRemaining = 0;

  const completedAt = new Date().toISOString();
  const minutes = Math.round((new Date(completedAt) - new Date(state.startedAt)) / 60000);

  const rowNum = await findTransactionRow(txMessageId, chatId);
  if (rowNum) {
    await updateTransaction(rowNum, {
      'mntReceived': state.mntTotal,
      'mntRemaining': 0,
      'status': 'Амжилттай',
      'completedAt': completedAt,
      'minutes': minutes
    });
  }

  await ctx.editMessageText('🎉 <b>Гүйлгээ амжилттай хаагдлаа!</b>', { parse_mode: 'HTML' });

  transactionStates.delete(`${chatId}_${txMessageId}`);
});

bot.action(/confirm_partial_(.+)/, async (ctx) => {
  const txMessageId = ctx.match[1];
  const chatId = ctx.chat.id;

  const state = findStateByTxId(chatId, txMessageId);
  if (!state) return;

  await ctx.answerCbQuery();

  state.step = 'waiting_partial_mnt';

  await ctx.reply('💸 <b>Ороод ирсэн MNT дүнг оруулна уу:</b>', {
    reply_to_message_id: state.calcMessageId || txMessageId,
    parse_mode: 'HTML'
  });
});

// Helper functions
function findStateByTxId(chatId, txMessageId) {
  for (const [key, state] of transactionStates.entries()) {
    if (key.includes(`${chatId}_`) && state.txMessageId == txMessageId) {
      return state;
    }
  }
  return null;
}

async function processCommission(ctx, state) {
  const defaultCommission = state.rub >= 10000000 ? 10000 : 5000;

  if (state.rub >= 10000000) {
    state.step = 'waiting_commission';
    await ctx.reply(
      `💰 <b>Шимтгэл хэд вэ?</b>\n(Санал: ${formatNumber(defaultCommission)} RUB)`,
      {
        reply_to_message_id: state.txMessageId,
        parse_mode: 'HTML'
      }
    );
  } else {
    state.commission = defaultCommission;
    await showCalculation(ctx, state);
  }
}

async function showCalculation(ctx, state) {
  state.rubTotal = state.rub + state.commission;
  state.mntTotal = state.rubTotal * state.rate;
  state.mntReceived = 0;
  state.mntRemaining = state.mntTotal;

  const calc = formatCalculation(
    state.rub,
    state.commission,
    state.rubTotal,
    state.rate,
    state.mntTotal
  );

  const msg = await ctx.reply(`📊 <b>Тооцоо:</b>\n\n${calc}`, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('💰 Шимтгэл өөрчлөх', `change_commission_${state.txMessageId}`)],
      [Markup.button.callback('📊 Зарах ханш өөрчлөх', `change_rate_${state.txMessageId}`)],
      [Markup.button.callback('✅ Гүйлгээг батлах', `confirm_transaction_${state.txMessageId}`)]
    ])
  });

  state.calcMessageId = msg.message_id;
  state.step = 'calculation_shown';
}

// /start команд
bot.command('start', async (ctx) => {
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  const isAdmin = CONFIG.ADMIN_IDS.includes(userId);
  const isGroup = chatId === CONFIG.ALLOWED_GROUP_ID;

  let msg = '👋 <b>Сайн байна уу!</b>\n\n';

  if (isAdmin || isGroup) {
    msg += '✅ Та энэ ботыг ашиглах эрхтэй байна.\n\n';
    msg += '<b>📋 Командууд:</b>\n';
    msg += '/debug - Тохиргоо болон ханш шалгах\n';
    msg += '/report - Өнөөдрийн тайлан харах\n\n';
    msg += '<b>📖 Хэрэглээ:</b>\n';
    msg += '1. Группт гүйлгээний мессеж явуулна\n';
    msg += '2. Бот автоматаар таних болно\n';
    msg += '3. Ханш, шимтгэл оруулна\n';
    msg += '4. Тооцоо харах\n';
    msg += '5. MNT орохыг баталгаажуулна';
  } else {
    msg += '⚠️ Та энэ ботыг ашиглах эрхгүй байна.\n';
    msg += 'Зөвхөн зөвшөөрөлтэй хэрэглэгчид ашиглах боломжтой.';
  }

  await ctx.reply(msg, { parse_mode: 'HTML' });
});

// /report команд
bot.command('report', async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;

  if (chatId !== CONFIG.ALLOWED_GROUP_ID && !CONFIG.ADMIN_IDS.includes(userId)) {
    await ctx.reply('⚠️ Энэ команд зөвхөн зөвшөөрөгдсөн группт эсвэл админд ажиллана.');
    return;
  }

  try {
    const transactions = await getTodayTransactions();

    const completed = transactions.filter(t => t.status === 'Амжилттай');
    const pending = transactions.filter(t => t.status !== 'Амжилттай');

    let report = '📊 <b>ӨНӨӨДРИЙН ТАЙЛАН</b>\n\n';

    if (completed.length > 0) {
      report += '✅ <b>MNT бүтэн орсон:</b>\n';
      report += `   Тоо: ${completed.length}\n`;

      const totalRub = completed.reduce((sum, t) => sum + t.rub, 0);
      const totalMnt = completed.reduce((sum, t) => sum + t.mntTotal, 0);
      const totalProfit = completed.reduce((sum, t) => sum + (t.rate - t.costRate) * t.rub, 0);

      report += `   Нийт RUB: ${formatNumber(totalRub)}\n`;
      report += `   Нийт MNT: ${formatNumber(totalMnt)}\n`;
      report += `   Нийт ашиг: ${formatNumber(totalProfit)} MNT\n\n`;
    }

    if (pending.length > 0) {
      report += '🟠 <b>MNT дутуу орсон:</b>\n<pre>';

      let totalRemaining = 0;
      pending.forEach(t => {
        const shortName = t.назначение.substring(0, 20);
        report += `${t.number}. ${shortName}... - ${formatNumber(t.mntRemaining)}\n`;
        totalRemaining += t.mntRemaining;
      });

      report += `</pre>\n   Нийт хүлээгдэж буй: ${formatNumber(totalRemaining)} MNT\n`;
    }

    if (completed.length === 0 && pending.length === 0) {
      report += 'Өнөөдөр гүйлгээ байхгүй байна.';
    }

    await ctx.reply(report, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('Report error:', err);
    await ctx.reply('❌ Тайлан гаргахад алдаа гарлаа.');
  }
});

// /debug команд
bot.command('debug', async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;

  if (chatId !== CONFIG.ALLOWED_GROUP_ID && !CONFIG.ADMIN_IDS.includes(userId)) {
    await ctx.reply('⚠️ Энэ команд зөвхөн зөвшөөрөгдсөн группт эсвэл админд ажиллана.');
    return;
  }

  let info = '🔍 <b>DEBUG МЭДЭЭЛЭЛ</b>\n\n';
  info += `💬 Одоогийн Chat ID: <code>${chatId}</code>\n`;
  info += `👤 Таны User ID: <code>${userId}</code>\n`;
  info += `📝 Chat төрөл: ${ctx.chat.type}\n\n`;
  info += `📊 Тохиргоо:\n`;
  info += `- Зөвшөөрөлтэй group: <code>${CONFIG.ALLOWED_GROUP_ID}</code>\n`;
  info += `- Admin IDs: <code>${CONFIG.ADMIN_IDS.join(', ')}</code>\n`;
  info += `- Ханшийн суваг: <code>${CONFIG.RATE_CHANNEL_ID}</code>\n\n`;
  info += `💰 Ханш:\n`;
  info += `- 🏦 Байгууллага: ${cachedRates.org}\n`;
  info += `- 👤 Хувь хүн: ${cachedRates.person}\n`;
  info += `- Сүүлд шинэчлэгдсэн: ${cachedRates.lastUpdate > 0 ? new Date(cachedRates.lastUpdate).toLocaleString('mn-MN') : 'Хэзээ ч'}\n\n`;

  const isAllowed = chatId === CONFIG.ALLOWED_GROUP_ID || CONFIG.ADMIN_IDS.includes(userId);
  info += `${isAllowed ? '✅' : '❌'} Энэ chat-д бот ${isAllowed ? '<b>ажиллана</b>' : '<b>ажиллахгүй</b>'}\n\n`;

  await ctx.reply(info, { parse_mode: 'HTML' });
});

// ========== SERVER SETUP (для Render) ==========
if (!CONFIG.WEBHOOK_DOMAIN) {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OYUNS Bot is running!');
  });

  server.listen(CONFIG.PORT, () => {
    console.log(`Server running on port ${CONFIG.PORT}`);
  });
}

// ========== BOT LAUNCH ==========
async function startBot() {
  try {
    console.log('🔄 Bot эхлүүлж байна...');

    const isProduction = !!CONFIG.WEBHOOK_DOMAIN;

    if (isProduction) {
      console.log('🌐 Webhook mode эхлүүлж байна...');

      const webhookUrl = `${CONFIG.WEBHOOK_DOMAIN}/webhook/${CONFIG.BOT_TOKEN}`;

      try {
        await bot.telegram.setWebhook(webhookUrl, {
          drop_pending_updates: true,
          allowed_updates: ['message', 'callback_query', 'channel_post']
        });
        console.log('✅ Webhook тохируулагдлаа:', webhookUrl);
      } catch (err) {
        console.error('❌ Webhook тохируулахад алдаа:', err.message);
        process.exit(1);
      }

      bot.startWebhook(`/webhook/${CONFIG.BOT_TOKEN}`, null, CONFIG.PORT);

      console.log('\n✅ Bot амжилттай эхэллээ! (Webhook mode)');
      console.log('📡 Webhook URL:', webhookUrl);
    } else {
      console.log('🔄 Polling mode эхлүүлж байна...');

      try {
        const me = await bot.telegram.getMe();
        console.log(`✅ Bot олдлоо: @${me.username} (${me.first_name})`);
      } catch (err) {
        console.error('❌ Bot token эсвэл интернэт холболт алдаатай:', err.message);
        process.exit(1);
      }

      try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        console.log('✅ Webhook цэвэрлэгдлээ');
      } catch (err) {
        console.log('⚠️ Webhook цэвэрлэхэд алдаа:', err.message);
      }

      const launchTimeout = setTimeout(() => {
        console.error('\n❌ Polling 30 секундээс хэтэрлээ');
        process.exit(1);
      }, 30000);

      await bot.launch({
        allowedUpdates: ['message', 'callback_query', 'channel_post'],
        dropPendingUpdates: true,
        polling: {
          timeout: 30,
          limit: 100,
          allowedUpdates: ['message', 'callback_query', 'channel_post']
        }
      });

      clearTimeout(launchTimeout);
      console.log('\n✅ Bot амжилттай эхэллээ! (Polling mode)');
    }

    console.log('📡 Ханшийн суваг сонсож байна:', CONFIG.RATE_CHANNEL_ID);
    console.log('👥 Зөвшөөрөгдсөн group:', CONFIG.ALLOWED_GROUP_ID);
    console.log(`💰 Одоогийн ханш: 🏦 ${cachedRates.org} | 👤 ${cachedRates.person}`);
    console.log('💡 Суваг дээр шинэ ханш нийтлэх үед автоматаар шинэчлэгдэнэ\n');

  } catch (err) {
    console.error('\n❌ Bot эхлүүлэхэд алдаа:', err);
    console.error('Дэлгэрэнгүй:', err.stack);
    process.exit(1);
  }
}

console.log('🔧 Bot тохиргоо уншиж байна...');
console.log('🌐 HTTP server эхэлж байна...');

startBot();

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
