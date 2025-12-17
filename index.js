const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const { google } = require('googleapis');

// ========== CONFIG ==========
const CONFIG = {
  BOT_TOKEN: process.env.BOT_TOKEN || '7716759809:AAHRwI4cgQJd8KXcJcHbQVw2FZFueBja1G0',
  SPREADSHEET_ID: process.env.SPREADSHEET_ID || '1qbxJsI4Ns3a8lluxlRZl5r5AKHA3hp9yS7YZLwY469A',
  RATE_CHANNEL_ID: '-1003355216653',
  ALLOWED_GROUP_ID: '-5069100118',
  ADMIN_IDS: [1447446407, 1920453419],
  PORT: Number(process.env.PORT || 3000),
  WEBHOOK_DOMAIN: process.env.WEBHOOK_DOMAIN || process.env.RENDER_EXTERNAL_URL
};

if (!CONFIG.BOT_TOKEN) throw new Error('BOT_TOKEN байхгүй');
if (!CONFIG.WEBHOOK_DOMAIN) console.warn('⚠️ WEBHOOK_DOMAIN байхгүй - polling mode ашиглана');

const bot = new Telegraf(CONFIG.BOT_TOKEN);

// ========== GOOGLE SHEETS ==========
const auth = new google.auth.GoogleAuth({
  keyFile: '/etc/secrets/service-account.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({ version: 'v4', auth });
const SHEET_NAME = 'Transactions2';

let sheetsLock = Promise.resolve();
const lockSheets = (fn) => { sheetsLock = sheetsLock.then(fn).catch(fn); return sheetsLock; };

// ========== STATE ==========
const transactionStates = new Map();
let cachedRates = { org: 45.10, person: 45.20, lastUpdate: 0 };

// ========== HELPERS ==========
function isUserAllowed(ctx) {
  const chatId = String(ctx.chat?.id || '');
  const userId = ctx.from?.id;
  return chatId === CONFIG.ALLOWED_GROUP_ID || CONFIG.ADMIN_IDS.includes(userId);
}

function parseNumber(str) {
  if (!str) return 0;
  return parseFloat(String(str).replace(/[,\s]/g, '').trim()) || 0;
}

function formatNumber(num, decimals = 2) {
  return Number(num || 0).toLocaleString('en-US', { 
    minimumFractionDigits: decimals, 
    maximumFractionDigits: decimals 
  });
}

function formatMNT(num) {
  return '₮' + Number(num || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatRUB(num) {
  return '₽' + formatNumber(num, 2);
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

function findStateByTxId(chatId, txMessageId) {
  for (const [key, state] of transactionStates.entries()) {
    if (key.startsWith(`${chatId}_`) && String(state.txMessageId) === String(txMessageId)) return state;
  }
  return null;
}

function findActiveState(chatId) {
  for (const [key, state] of transactionStates.entries()) {
    if (key.startsWith(`${chatId}_`)) return state;
  }
  return null;
}

// ========== SHEETS OPS ==========
async function appendTransaction(data) {
  return lockSheets(async () => {
    await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:S`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          data.number, data.date, data.назначение, data.rub, data.rate,
          data.commission, data.rubTotal, data.mntTotal, data.mntReceived || 0,
          data.mntRemaining, data.status, data.startedAt, data.completedAt || '',
          data.minutes || '', data.chatId, data.txMessageId, data.calcMessageId || '',
          data.rateType || '', data.costRate || ''
        ]]
      }
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
    if (String(rows[i][15]) === String(txMessageId) && String(rows[i][14]) === String(chatId)) return i + 1;
  }
  return null;
}

async function updateTransaction(rowNum, updates) {
  return lockSheets(async () => {
    const cols = {
      number: 0, date: 1, назначение: 2, rub: 3, rate: 4, commission: 5,
      rubTotal: 6, mntTotal: 7, mntReceived: 8, mntRemaining: 9, status: 10,
      startedAt: 11, completedAt: 12, minutes: 13, chatId: 14, txMessageId: 15,
      calcMessageId: 16, rateType: 17, costRate: 18
    };

    const requests = [];
    for (const [col, value] of Object.entries(updates)) {
      const colIndex = cols[col];
      if (colIndex !== undefined) {
        requests.push({
          range: `${SHEET_NAME}!${String.fromCharCode(65 + colIndex)}${rowNum}`,
          values: [[value]]
        });
      }
    }

    if (requests.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: CONFIG.SPREADSHEET_ID,
        resource: { valueInputOption: 'USER_ENTERED', data: requests }
      });
    }
  });
}

async function getTransactionsByDateRange(startDate, endDate) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:S`
  });

  const rows = response.data.values || [];
  const transactions = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const date = row[1] ? String(row[1]).split('T')[0] : '';
    
    if (date >= startDate && date <= endDate) {
      transactions.push({
        number: row[0],
        date: row[1],
        назначение: row[2] || '',
        rub: parseNumber(row[3]),
        rate: parseNumber(row[4]),
        commission: parseNumber(row[5]),
        rubTotal: parseNumber(row[6]),
        mntTotal: parseNumber(row[7]),
        mntReceived: parseNumber(row[8]),
        mntRemaining: parseNumber(row[9]),
        status: row[10] || '',
        costRate: parseNumber(row[18])
      });
    }
  }

  return transactions;
}

// ========== RATE HANDLING ==========
async function fetchLatestRates() {
  return cachedRates;
}

bot.on('channel_post', async (ctx) => {
  try {
    if (String(ctx.channelPost?.chat?.id) !== String(CONFIG.RATE_CHANNEL_ID) || !ctx.channelPost.text) return;

    const text = ctx.channelPost.text;
    const orgMatch = text.match(/🏦[^:]*:\s*([\d.,]+)/);
    const personMatch = text.match(/👤[^:]*:\s*([\d.,]+)/);

    if (orgMatch) cachedRates.org = parseFloat(orgMatch[1].replace(',', '.'));
    if (personMatch) cachedRates.person = parseFloat(personMatch[1].replace(',', '.'));

    if (orgMatch || personMatch) {
      cachedRates.lastUpdate = Date.now();
      console.log(`✅ Ханш: 🏦 ${cachedRates.org} | 👤 ${cachedRates.person}`);
    }
  } catch (err) {
    console.error('❌ channel_post:', err);
  }
});

// ========== FLOW HELPERS ==========
async function processCommission(ctx, state) {
  const defaultCommission = state.rub >= 10000000 ? 10000 : 5000;

  if (state.rub >= 10000000) {
    state.step = 'waiting_commission';
    await ctx.reply(
      `💰 <b>Шимтгэл хэд вэ?</b>\n(Санал: ${formatNumber(defaultCommission)} RUB)`,
      { parse_mode: 'HTML' }
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

  const calc = formatCalculation(state.rub, state.commission, state.rubTotal, state.rate, state.mntTotal);

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

// ========== COMMANDS ==========
bot.start(async (ctx) => {
  const msg = `👋 Сайн байна уу!

Би OYUNS Bot. Гүйлгээний тооцоо, бүртгэл болон тайлан гаргахад тусална.

🧾 *Шинэ гүйлгээ оруулах формат:*
1.
назначение: Тайлбар
сумма: 10000

📊 Тайлан:
- /report — өнөөдрийн тайлан
- /report 7 — 7 хоногийн тайлан
- /report 2024-01-01 2024-01-31 — огнооны хоорондох тайлан`;

  await ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('ping', async (ctx) => {
  await ctx.reply(`pong ✅\nchatId=${ctx.chat.id}\nuserId=${ctx.from.id}`);
});

bot.command('debug', async (ctx) => {
  const info = `🔍 <b>DEBUG</b>

💬 Chat ID: <code>${ctx.chat.id}</code>
👤 User ID: <code>${ctx.from.id}</code>

💰 Ханш:
- 🏦 Байгууллага: ${cachedRates.org}
- 👤 Хувь хүн: ${cachedRates.person}

${isUserAllowed(ctx) ? '✅' : '❌'} Allowed`;
  await ctx.reply(info, { parse_mode: 'HTML' });
});

// ========== REPORT COMMAND ==========
bot.command('report', async (ctx) => {
  if (!isUserAllowed(ctx)) return;

  try {
    const args = ctx.message.text.split(' ').slice(1);
    let startDate, endDate;

    const today = new Date();
    today.setHours(today.getHours() + 1); // Europe/Amsterdam ~UTC+1
    const todayStr = today.toISOString().split('T')[0];

    if (args.length === 0) {
      startDate = endDate = todayStr;
    } else if (args.length === 1 || (args.length === 2 && args[1] === 'хоног')) {
      const days = parseInt(args[0]) || 1;
      const start = new Date(today);
      start.setDate(start.getDate() - days + 1);
      startDate = start.toISOString().split('T')[0];
      endDate = todayStr;
    } else if (args.length === 2) {
      startDate = args[0];
      endDate = args[1];
    } else {
      await ctx.reply('❌ Буруу формат. Жишээ:\n/report\n/report 7\n/report 2024-01-01 2024-01-31');
      return;
    }

    const transactions = await getTransactionsByDateRange(startDate, endDate);

    if (transactions.length === 0) {
      await ctx.reply('📊 Тайлан\nСонгосон хугацаанд гүйлгээ байхгүй байна.');
      return;
    }

    const completed = transactions.filter(t => t.status === 'Амжилттай');
    const pending = transactions.filter(t => t.status !== 'Амжилттай');

    const totalMNT = transactions.reduce((s, t) => s + t.mntTotal, 0);
    const totalRUB = transactions.reduce((s, t) => s + t.rubTotal, 0);
    const totalProfit = transactions.reduce((s, t) => s + (t.rate - t.costRate) * t.rub, 0);
    const lossTransactions = transactions.filter(t => (t.rate - t.costRate) * t.rub < 0);
    const totalLoss = Math.abs(lossTransactions.reduce((s, t) => s + (t.rate - t.costRate) * t.rub, 0));

    let report = `📊 <b>Тайлан</b> (${startDate} — ${endDate})\n\n`;
    report += `📈 Товч мэдээлэл:\n`;
    report += `Нийт гүйлгээний дүн: ${formatMNT(totalMNT)} / ${formatRUB(totalRUB)}\n`;
    report += `Нийт ашиг: ${formatMNT(totalProfit)}\n`;
    report += `Нийт гүйлгээний тоо: ${transactions.length}\n\n`;

    report += `📊 Гүйлгээний төлөв:\n`;
    report += `Амжилттай: ${completed.length}\n`;
    report += `Хүлээгдэж байгаа: ${pending.length}\n\n`;

    if (lossTransactions.length > 0) {
      report += `🔽 Алдагдалтай гүйлгээний тоо: ${lossTransactions.length}\n`;
      report += `Алдагдлын хэмжээ: ${formatMNT(totalLoss)}\n\n`;
    }

    if (pending.length > 0) {
      report += `<b>Хүлээгдэж буй гүйлгээ:</b>\n\n`;
      
      for (const t of pending) {
        report += `${t.number}. Назначение: ${t.назначение}\n`;
        
        const calc = formatCalculation(t.rub, t.commission, t.rubTotal, t.rate, t.mntTotal, t.mntReceived);
        report += `Тооцоо:\n${calc}\n`;
        report += `Үлдэгдэл: ${formatMNT(t.mntRemaining)}\n\n`;
      }
    } else {
      report += `<b>Хүлээгдэж буй гүйлгээ:</b> Байхгүй`;
    }

    // Split long messages
    if (report.length > 4096) {
      const chunks = [];
      let current = '';
      
      for (const line of report.split('\n')) {
        if ((current + line + '\n').length > 4000) {
          chunks.push(current);
          current = line + '\n';
        } else {
          current += line + '\n';
        }
      }
      if (current) chunks.push(current);

      for (const chunk of chunks) {
        await ctx.reply(chunk, { parse_mode: 'HTML' });
      }
    } else {
      await ctx.reply(report, { parse_mode: 'HTML' });
    }
  } catch (err) {
    console.error('❌ Report error:', err);
    await ctx.reply('❌ Тайлан гаргахад алдаа гарлаа.');
  }
});

// ========== TEXT HANDLER ==========
bot.on('text', async (ctx, next) => {
  try {
    const text = ctx.message?.text || '';
    if (text.startsWith('/')) return next();
    if (!isUserAllowed(ctx)) return;

    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;

    const numberMatch = text.match(/^(\d+)\./m);
    const назначениеMatch = text.match(/назначени[её][^:]*:\s*(.+)/im);
    const суммаMatch = text.match(/сумма:\s*([\d,.\s]+)/im);

    if (numberMatch && назначениеMatch && суммаMatch) {
      const stateKey = `${chatId}_${messageId}`;
      transactionStates.set(stateKey, {
        number: numberMatch[1],
        назначение: назначениеMatch[1].trim(),
        rub: parseNumber(суммаMatch[1]),
        chatId,
        txMessageId: messageId,
        step: 'waiting_cost_rate',
        startedAt: new Date().toISOString()
      });

      await ctx.reply('💰 <b>Өртөг ханш оруулна уу:</b>', {
        reply_to_message_id: messageId,
        parse_mode: 'HTML'
      });
      return;
    }

    // Идэвхтэй гүйлгээ хайх (reply шаардлагагүй)
    let activeState = findActiveState(chatId);
    if (!activeState) return;

    if (activeState.step === 'waiting_cost_rate') {
      const costRate = parseNumber(text);
      if (costRate <= 0) {
        await ctx.reply('❌ Зөв тоо оруулна уу!');
        return;
      }

      activeState.costRate = costRate;
      activeState.step = 'waiting_sell_rate';

      const rates = await fetchLatestRates();
      await ctx.reply('📊 <b>Зарах ханш сонгоно уу:</b>', {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(`🏦 ${rates.org.toFixed(2)}`, `rate_org_${activeState.txMessageId}`),
            Markup.button.callback(`👤 ${rates.person.toFixed(2)}`, `rate_person_${activeState.txMessageId}`)
          ],
          [Markup.button.callback('✍️ Өөр ханш оруулах', `rate_custom_${activeState.txMessageId}`)]
        ])
      });
      return;
    }

    if (activeState.step === 'waiting_custom_rate') {
      const customRate = parseNumber(text);
      if (customRate <= 0) {
        await ctx.reply('❌ Зөв ханш оруулна уу!');
        return;
      }
      activeState.rate = customRate;
      activeState.rateType = 'Өөр';
      await processCommission(ctx, activeState);
      return;
    }

    if (activeState.step === 'waiting_commission') {
      const commission = parseNumber(text);
      if (commission <= 0) {
        await ctx.reply('❌ Зөв дүн оруулна уу!');
        return;
      }
      activeState.commission = commission;
      await showCalculation(ctx, activeState);
      return;
    }

    if (activeState.step === 'waiting_partial_mnt') {
      const mnt = parseNumber(text);
      if (mnt <= 0) return;

      activeState.mntReceived = (activeState.mntReceived || 0) + mnt;
      activeState.mntRemaining = activeState.mntTotal - activeState.mntReceived;

      const rowNum = await findTransactionRow(activeState.txMessageId, chatId);
      if (rowNum) {
        await updateTransaction(rowNum, {
          mntReceived: activeState.mntReceived,
          mntRemaining: activeState.mntRemaining,
          status: activeState.mntRemaining <= 0 ? 'Амжилттай' : 'Хэсэгчлэн орсон'
        });
      }

      const calc = formatCalculation(activeState.rub, activeState.commission, activeState.rubTotal, activeState.rate, activeState.mntTotal, activeState.mntReceived);

      await ctx.reply(`✅ <b>Хэсэгчлэн орлоо:</b> ${formatNumber(mnt)} MNT\n\n${calc}`, { parse_mode: 'HTML' });

      if (activeState.mntRemaining <= 0) {
        const completedAt = new Date().toISOString();
        const minutes = Math.round((new Date(completedAt) - new Date(activeState.startedAt)) / 60000);

        if (rowNum) await updateTransaction(rowNum, { completedAt, minutes, status: 'Амжилттай' });

        await ctx.reply('🎉 <b>Гүйлгээ амжилттай хаагдлаа!</b>', { parse_mode: 'HTML' });
        transactionStates.delete(`${chatId}_${activeState.txMessageId}`);
      } else {
        activeState.step = 'waiting_confirmation';
        await ctx.reply('💵 <b>MNT бүтэн орсон уу?</b>', {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ Бүтэн орсон', `confirm_full_${activeState.txMessageId}`)],
            [Markup.button.callback('🟠 Дахин хэсэгчлэн орсон', `confirm_partial_${activeState.txMessageId}`)]
          ])
        });
      }
    }
  } catch (err) {
    console.error('❌ Text handler:', err);
  }
});

// ========== CALLBACKS ==========
bot.action(/rate_(org|person|custom)_(.+)/, async (ctx) => {
  if (!isUserAllowed(ctx)) return;

  const [, type, txMessageId] = ctx.match;
  const state = findStateByTxId(ctx.chat.id, txMessageId);
  if (!state) return;

  const rates = await fetchLatestRates();

  if (type === 'org') {
    state.rate = rates.org;
    state.rateType = 'Байгууллага';
    await ctx.answerCbQuery('🏦 Сонгогдлоо');
    await processCommission(ctx, state);
  } else if (type === 'person') {
    state.rate = rates.person;
    state.rateType = 'Хувь хүн';
    await ctx.answerCbQuery('👤 Сонгогдлоо');
    await processCommission(ctx, state);
  } else {
    state.step = 'waiting_custom_rate';
    await ctx.answerCbQuery();
    await ctx.reply('✍️ <b>Зарах ханш оруулна уу:</b>', { parse_mode: 'HTML' });
  }
});

bot.action(/change_commission_(.+)/, async (ctx) => {
  if (!isUserAllowed(ctx)) return;
  const state = findStateByTxId(ctx.chat.id, ctx.match[1]);
  if (!state) return;

  state.step = 'waiting_commission';
  await ctx.answerCbQuery();
  await ctx.reply('💰 <b>Шимтгэл оруулна уу:</b>', { parse_mode: 'HTML' });
});

bot.action(/change_rate_(.+)/, async (ctx) => {
  if (!isUserAllowed(ctx)) return;
  const state = findStateByTxId(ctx.chat.id, ctx.match[1]);
  if (!state) return;

  const rates = await fetchLatestRates();
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup({
    inline_keyboard: [
      [
        { text: `🏦 ${rates.org.toFixed(2)}`, callback_data: `rate_org_${ctx.match[1]}` },
        { text: `👤 ${rates.person.toFixed(2)}`, callback_data: `rate_person_${ctx.match[1]}` }
      ],
      [{ text: '✍️ Өөр ханш оруулах', callback_data: `rate_custom_${ctx.match[1]}` }]
    ]
  });
});

bot.action(/confirm_transaction_(.+)/, async (ctx) => {
  if (!isUserAllowed(ctx)) return;
  const state = findStateByTxId(ctx.chat.id, ctx.match[1]);
  if (!state) return;

  await ctx.answerCbQuery();

  const rowNum = await findTransactionRow(state.txMessageId, ctx.chat.id);
  if (!rowNum) {
    await appendTransaction({
      number: state.number, date: new Date().toISOString(), назначение: state.назначение,
      rub: state.rub, rate: state.rate, commission: state.commission, rubTotal: state.rubTotal,
      mntTotal: state.mntTotal, mntReceived: 0, mntRemaining: state.mntTotal,
      status: 'Хүлээгдэж буй', startedAt: state.startedAt, chatId: state.chatId,
      txMessageId: state.txMessageId, calcMessageId: state.calcMessageId,
      rateType: state.rateType, costRate: state.costRate
    });
  }

  state.step = 'waiting_confirmation';
  await ctx.reply('💵 <b>MNT бүтэн орсон уу?</b>', {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Бүтэн орсон', `confirm_full_${ctx.match[1]}`)],
      [Markup.button.callback('🟠 Хэсэгчлэн орсон', `confirm_partial_${ctx.match[1]}`)]
    ])
  });
});

bot.action(/confirm_partial_(.+)/, async (ctx) => {
  try {
    if (!isUserAllowed(ctx)) return;

    const state = findStateByTxId(ctx.chat.id, ctx.match[1]);
    if (!state) return;

    await ctx.answerCbQuery();
    state.step = 'waiting_partial_mnt';

    await ctx.reply('💸 <b>Ороод ирсэн MNT дүнг оруулна уу:</b>', {
      parse_mode: 'HTML',
      reply_to_message_id: state.calcMessageId || state.txMessageId
    });
  } catch (err) {
    console.error('❌ confirm_partial error:', err);
  }
});

// ========== WEBHOOK SERVER (Render) / POLLING FALLBACK ==========
const app = express();
app.use(express.json());

app.get('/', (req, res) => res.status(200).send('OYUNS Bot is running!'));
app.get('/health', (req, res) => res.status(200).send('OK'));

const webhookPath = `/telegraf/${CONFIG.BOT_TOKEN}`;
app.post(webhookPath, (req, res) => bot.handleUpdate(req.body, res));

async function start() {
  // Always start HTTP server (Render health checks etc.)
  app.listen(CONFIG.PORT, () => {
    console.log(`✅ Server listening on port ${CONFIG.PORT}`);
  });

  // If WEBHOOK_DOMAIN exists → use webhook; else use polling
  if (CONFIG.WEBHOOK_DOMAIN) {
    const webhookUrl = `${CONFIG.WEBHOOK_DOMAIN}${webhookPath}`;

    await bot.telegram.setWebhook(webhookUrl, {
      drop_pending_updates: true,
      allowed_updates: ['message', 'callback_query', 'channel_post']
    });

    console.log(`✅ Webhook set: ${webhookUrl}`);
  } else {
    console.log('ℹ️ WEBHOOK_DOMAIN байхгүй тул polling mode асаалаа.');
    await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
    bot.launch();
    console.log('✅ Bot launched (polling)');
  }
}

start().catch((err) => {
  console.error('❌ Start error:', err);
  process.exit(1);
});

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
