const TelegramBot = require('node-telegram-bot-api');
const { pool } = require('./db');
require('dotenv').config();

module.exports = function startBot() {
  const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
  const MAIN_ADMIN_ID = process.env.MAIN_ADMIN_ID || '8158960738';
  const ADMIN_ID = MAIN_ADMIN_ID;

  // Configure bot profile text shown in bot profile/about section.
  async function configureBotProfileText() {
    try {
      await bot._request('setMyShortDescription', {
        form: { short_description: 'Deposit, Withdraw, PromoCode support for 1xBet, Melbet, Paripulse.' }
      });
      await bot._request('setMyDescription', {
        form: { description: 'Welcome to Bullet Bets Bot. Use /start to begin and /help to see all commands.' }
      });

      const shortDesc = await bot._request('getMyShortDescription', { form: {} });
      const desc = await bot._request('getMyDescription', { form: {} });
      console.log('Bot short description set to:', shortDesc?.short_description || 'N/A');
      console.log('Bot description set to:', desc?.description || 'N/A');
    } catch (error) {
      console.error('Bot profile text configuration error:', error.message);
    }
  }

  configureBotProfileText();

  function parseAdminIds(rawValue) {
    return String(rawValue || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
  }

  const PLATFORMS = ['1xBet', 'Melbet', 'Paripulse'];
  const PROMO_CODES = {
    '1xBet': 'BULLETBETS',
    'Melbet': 'BBNPL',
    'Paripulse': 'BBNPL'
  };
  const PLATFORM_ADMINS = {
    '1xBet': parseAdminIds(process.env.ADMIN_ID_1XBET || '8760970149'),
    'Melbet': parseAdminIds(process.env.ADMIN_ID_MELBET || '6287664824,7596443202'),
    'Paripulse': parseAdminIds(process.env.ADMIN_ID_PARIPULSE || '7409544646')
  };
  const ALL_ADMIN_IDS = new Set(
    [ADMIN_ID, ...Object.values(PLATFORM_ADMINS).flat()]
      .filter(Boolean)
      .map((id) => String(id))
  );
  const userStates = {};

  bot.on('polling_error', async (error) => {
    const message = error?.message || '';
    if (error?.code === 'ETELEGRAM' && message.includes('409 Conflict')) {
      console.error('Polling conflict detected. Another bot instance is running. Stopping this instance.');
      try {
        await bot.stopPolling();
      } catch (stopError) {
        console.error('Error stopping polling:', stopError);
      }
      process.exit(1);
    }
    console.error('Polling error:', error);
  });

  function isAdmin(id) {
    return ALL_ADMIN_IDS.has(String(id));
  }

  function isMainAdmin(id) {
    return String(id) === String(MAIN_ADMIN_ID);
  }

  function normalizePlatform(input) {
    if (!input) return null;
    const normalized = String(input).trim().toLowerCase().replace(/\s+/g, '');
    return PLATFORMS.find((platform) => platform.toLowerCase().replace(/\s+/g, '') === normalized) || null;
  }

  function getAdminPlatforms(adminId) {
    return PLATFORMS.filter((platform) => getPlatformAdminIds(platform).includes(String(adminId)));
  }

  function canManagePlatform(adminId, platform) {
    return getPlatformAdminIds(platform).includes(String(adminId));
  }

  function resolveTargetPlatformForAdmin(adminId, requestedPlatformRaw) {
    const requestedPlatform = normalizePlatform(requestedPlatformRaw);
    const myPlatforms = getAdminPlatforms(adminId);

    if (!myPlatforms.length) return { error: 'No platform is assigned to this admin.' };

    if (isMainAdmin(adminId)) {
      const target = requestedPlatform || '1xBet';
      if (!PLATFORMS.includes(target)) return { error: 'Invalid platform.' };
      return { platform: target };
    }

    if (!requestedPlatform) return { platform: myPlatforms[0] };
    if (!myPlatforms.includes(requestedPlatform)) {
      return { error: `You can only manage: ${myPlatforms.join(', ')}` };
    }

    return { platform: requestedPlatform };
  }

  function getPlatformAdminIds(platform) {
    const ids = PLATFORM_ADMINS[platform] || [];
    return ids.length ? ids.map((id) => String(id)) : [String(ADMIN_ID)];
  }

  function getPlatformAdminId(platform) {
    return getPlatformAdminIds(platform)[0] || ADMIN_ID;
  }

  async function sendToAdminIds(adminIds, sendFn) {
    const uniqueAdminIds = [...new Set((adminIds || []).map((id) => String(id)).filter(Boolean))];
    for (const adminId of uniqueAdminIds) {
      try {
        await sendFn(adminId);
      } catch (error) {
        console.error(`Error sending message to admin ${adminId}:`, error.message);
      }
    }
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  async function getLocationString(msg) {
    if (msg.location) {
      const lat = msg.location.latitude;
      const lon = msg.location.longitude;
      return `📍 Lat: ${lat.toFixed(4)}, Lon: ${lon.toFixed(4)}`;
    }
    return null;
  }

  async function ensureUser(msg) {
    const { id, username } = msg.from;
    const locationStr = await getLocationString(msg);
    try {
      await pool.query(
        'UPDATE users SET last_seen_at = CURRENT_TIMESTAMP, location = COALESCE($2, location) WHERE id = $1',
        [id, locationStr]
      );
      await pool.query(
        'INSERT INTO users (id, username, location, last_seen_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING',
        [id, username || 'unknown', locationStr]
      );
    } catch (error) {
      console.error('Error ensuring user:', error);
      bot.sendMessage(ADMIN_ID, `⚠️ Error registering user ${id}: ${error.message}`);
    }
  }

  function formatTransactions(transactions, isAdminView = false) {
    if (!transactions.length) return '📭 No transactions found.';
    let text = isAdminView ? '📋 *Pending Transactions:*\n\n' : '📋 *Your Recent Transactions:*\n\n';
    for (const tx of transactions) {
      text += `🆔 *#${tx.id}*\n` +
        `• User: @${tx.username || 'unknown'} (ID: ${tx.user_id})\n` +
        `• Type: ${tx.type.toUpperCase()}\n` +
        `• Amount: Rs. ${tx.amount || 'N/A'}\n` +
        `• Status: ${tx.status}\n` +
        `• Date: ${tx.date}\n`;
      if (tx.platform) text += `• Platform: ${tx.platform}\n`;
      if (tx.reason) text += `• Reason: ${tx.reason}\n`;
      text += '\n';
    }
    return text;
  }

  function platformKeyboard() {
    const inline_keyboard = [];
    for (let i = 0; i < PLATFORMS.length; i += 2) {
      const row = [{ text: PLATFORMS[i], callback_data: `platform_${PLATFORMS[i]}` }];
      if (i + 1 < PLATFORMS.length) {
        row.push({ text: PLATFORMS[i + 1], callback_data: `platform_${PLATFORMS[i + 1]}` });
      }
      inline_keyboard.push(row);
    }
    return inline_keyboard;
  }

  function platformKeyboardByPrefix(prefix) {
    const inline_keyboard = [];
    for (let i = 0; i < PLATFORMS.length; i += 2) {
      const row = [{ text: PLATFORMS[i], callback_data: `${prefix}${PLATFORMS[i]}` }];
      if (i + 1 < PLATFORMS.length) {
        row.push({ text: PLATFORMS[i + 1], callback_data: `${prefix}${PLATFORMS[i + 1]}` });
      }
      inline_keyboard.push(row);
    }
    return inline_keyboard;
  }

  function sendWithdrawPlatformSelector(chatId) {
    return bot.sendMessage(chatId, '🎫 <b>Withdraw Request</b>\n<blockquote>Select your platform to continue.</blockquote>', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: platformKeyboardByPrefix('wd_platform_') }
    });
  }

  function sendDepositPlatformSelector(chatId) {
    return bot.sendMessage(chatId, '🎫 <b>Deposit Request</b>\n<blockquote>Select your platform to continue.</blockquote>', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: platformKeyboardByPrefix('dep_platform_') }
    });
  }

  function sendPromoPlatformSelector(chatId) {
    return bot.sendMessage(chatId, '🎁 <b>Promo Code Request</b>\n<blockquote>Select your platform to continue.</blockquote>', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: platformKeyboardByPrefix('promo_platform_') }
    });
  }

  const userCommands = [
    { cmd: '/start', desc: 'Start bot and view welcome guide' },
    { cmd: '/help', desc: 'View all available commands and promo codes' },
    { cmd: '/deposit', desc: 'Create a new deposit request' },
    { cmd: '/withdraw', desc: 'Create a new withdrawal request' },
    { cmd: '/promocode', desc: 'Submit promo-code proof request' },
    { cmd: 'depo', desc: 'Shortcut for /deposit' },
    { cmd: 'wd', desc: 'Shortcut for /withdraw' },
    { cmd: 'promo', desc: 'Shortcut for /promocode' },
  ];

  const mainAdminCommands = [
    { cmd: '/pending', desc: 'List all pending transactions' },
    { cmd: '/dashboard', desc: 'Show summary of users and transactions' },
    { cmd: '/fullreport', desc: 'Full report: promo users, approved/non-approved details' },
    { cmd: '/ads', desc: 'Broadcast advertisement to all bot users' },
    { cmd: '/cancelads', desc: 'Cancel pending ad broadcast mode' },
  ];
  const platformAdminCommands = [
    { cmd: '/setqr [platform]', desc: 'Update your platform QR (photo in next message)' },
    { cmd: '/showqr [platform]', desc: 'Show active QR for your platform' },
    { cmd: '/melbetqr', desc: 'Update Melbet QR (photo in next message)' },
    { cmd: '/paripulseqr', desc: 'Update Paripulse QR (photo in next message)' },
    { cmd: '/1xbetqr', desc: 'Update 1xBet QR (photo in next message)' }
  ];

  function getScopedPlatformAdminCommands(adminId) {
    const assignedPlatforms = getAdminPlatforms(adminId);
    const scoped = [];

    if (assignedPlatforms.includes('Melbet')) {
      scoped.push({ cmd: '/melbetqr', desc: 'Update Melbet QR (photo in next message)' });
    }
    if (assignedPlatforms.includes('Paripulse')) {
      scoped.push({ cmd: '/paripulseqr', desc: 'Update Paripulse QR (photo in next message)' });
    }
    if (assignedPlatforms.includes('1xBet')) {
      scoped.push({ cmd: '/1xbetqr', desc: 'Update 1xBet QR (photo in next message)' });
    }

    return scoped;
  }

  async function sendLargeMessage(chatId, text) {
    const maxLen = 3500;
    if (text.length <= maxLen) {
      await bot.sendMessage(chatId, text);
      return;
    }

    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + maxLen, text.length);
      if (end < text.length) {
        const splitAt = text.lastIndexOf('\n', end);
        if (splitAt > start + 500) end = splitAt;
      }
      await bot.sendMessage(chatId, text.slice(start, end));
      start = end;
    }
  }

  async function sendStyledMessage(chatId, title, body) {
    return bot.sendMessage(
      chatId,
      `<b>${escapeHtml(title)}</b>\n<blockquote>${escapeHtml(body)}</blockquote>`,
      { parse_mode: 'HTML' }
    );
  }

  async function broadcastAdvertisement(content) {
    const usersRes = await pool.query('SELECT id FROM users ORDER BY id ASC');
    let sent = 0;
    let failed = 0;

    for (const row of usersRes.rows) {
      const targetUserId = row.id;
      try {
        if (content.type === 'text') {
          await bot.sendMessage(targetUserId, content.text, { parse_mode: 'HTML' });
        } else if (content.type === 'photo') {
          await bot.sendPhoto(targetUserId, content.fileId, {
            caption: content.caption || '📢 <b>Advertisement</b>',
            parse_mode: 'HTML'
          });
        } else if (content.type === 'document') {
          await bot.sendDocument(targetUserId, content.fileId, {
            caption: content.caption || '📢 <b>Advertisement</b>',
            parse_mode: 'HTML'
          });
        }
        sent += 1;
      } catch (error) {
        failed += 1;
      }
    }

    return { total: usersRes.rows.length, sent, failed };
  }

  function qrKeyForPlatform(platform) {
    const slug = String(platform).toLowerCase().replace(/[^a-z0-9]/g, '');
    return `deposit_qr_file_id_${slug}`;
  }

  function legacyQrKeyForPlatform(platform) {
    const slug = String(platform).toLowerCase().replace(/[^a-z0-9]/g, '');
    return `deposit_image_url_${slug}`;
  }

  async function getDepositQrAsset(platform) {
    const qrKeys = [
      qrKeyForPlatform(platform),
      legacyQrKeyForPlatform(platform),
      'deposit_qr_file_id',
      'deposit_image_url'
    ];
    const qrRes = await pool.query(
      'SELECT key, value FROM config WHERE key = ANY($1)',
      [qrKeys]
    );

    const configMap = {};
    for (const row of qrRes.rows) {
      configMap[row.key] = row.value;
    }

    return configMap[qrKeyForPlatform(platform)] ||
      configMap[legacyQrKeyForPlatform(platform)] ||
      configMap.deposit_qr_file_id ||
      configMap.deposit_image_url ||
      null;
  }

  async function sendDepositQrGuide(chatId, platform, promoCode) {
    const qrAsset = await getDepositQrAsset(platform);
    const caption =
      `💳 <b>Deposit QR - ${escapeHtml(platform)}</b>\n` +
      `<blockquote>Promo Code: <b>${escapeHtml(promoCode)}</b>\n` +
      `Now send payment to this QR and upload payment screenshot proof.</blockquote>`;

    if (qrAsset) {
      try {
        await bot.sendPhoto(chatId, qrAsset, { caption, parse_mode: 'HTML' });
        return;
      } catch (error) {
        console.error('Error sending QR photo:', error.message);
        // Fall back to text message if invalid file
        await bot.sendMessage(chatId, caption, { parse_mode: 'HTML' });
        return;
      }
    }

    await bot.sendMessage(
      chatId,
      '⚠️ <b>Deposit QR is not set yet.</b>\n<blockquote>Please contact admin. You can still continue by entering amount.</blockquote>',
      { parse_mode: 'HTML' }
    );
  }

  bot.onText(/\/start/, async (msg) => {
    await ensureUser(msg);
    const firstName = escapeHtml(msg.from.first_name || 'User');
    const supportedPlatformsText = PLATFORMS.map((platform) => `• ${escapeHtml(platform)}`).join('\n');
    const promoLines = PLATFORMS
      .map((platform) => {
        const code = PROMO_CODES[platform] || 'N/A';
        return `${escapeHtml(platform)}: <b>${escapeHtml(code)}</b> bonus available 🎉`;
      })
      .join('\n');
    await bot.sendMessage(
      msg.chat.id,
      `👋 <b>Welcome ${firstName}</b> to <b>Bullet Bets Bot</b> 📖\n\n` +
      `<b>⦿ Supported Platforms</b>\n` +
      `<blockquote>${supportedPlatformsText}</blockquote>\n\n` +
      `<b>⦿ Important</b>\n` +
      `<blockquote>Make sure you understand betting risks before placing any wagers.</blockquote>\n\n` +
      `<b>⦿ Promo Code</b>\n` +
      `<blockquote>${promoLines}</blockquote>\n\n` +
      `<b>⦿ Become Agent</b>\n` +
      `<blockquote>Interested users can apply to become an official agent and earn commissions.</blockquote>\n\n` +
      `<b>⦿ Need Help?</b>\n` +
      `<blockquote>Message <a href="https://t.me/BULLET_BETS">@BULLET_BETS</a> for any questions or issues.\nHappy betting and good luck! 🍀</blockquote>`,
      { parse_mode: 'HTML' }
    );

    await bot.sendMessage(
      msg.chat.id,
      '📌 <b>Quick Start</b>\n<blockquote>Use <b>/help</b> to begin a <b>deposit</b>, <b>withdrawal</b>, or <b>promocode</b> request.</blockquote>',
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📢 Join Group', url: 'https://t.me/bulletbetsnpl' },
              { text: '💬 Join Chat', url: 'https://t.me/bulletbetsparipulse' }
            ]
          ]
        }
      }
    );
  });

  bot.onText(/\/help/, async (msg) => {
    await ensureUser(msg);
    const isUserAdmin = isAdmin(msg.from.id);
    const isMain = isMainAdmin(msg.from.id);
    const scopedPlatformCommands = getScopedPlatformAdminCommands(msg.from.id);
    const commandsToShow = !isUserAdmin
      ? userCommands
      : isMain
        ? [...userCommands, ...mainAdminCommands, ...platformAdminCommands]
        : [...userCommands, ...scopedPlatformCommands];

    let helpText = '📘 <b>Available Commands</b>\n\n';

    for (const cmd of commandsToShow) {
      helpText += `<blockquote><b>${escapeHtml(cmd.cmd)}</b>\n${escapeHtml(cmd.desc)}</blockquote>\n`;
    }

    helpText += '\n🎁 <b>Promo Codes</b>\n';
    for (const platform of PLATFORMS) {
      helpText += `<blockquote><b>${escapeHtml(platform)}</b>: ${escapeHtml(PROMO_CODES[platform] || 'N/A')}</blockquote>\n`;
    }

    bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'HTML' });
  });

  bot.on('callback_query', async (query) => {
    const userId = query.from.id;
    const data = query.data;

    try {
      if (data.startsWith('owner_approve_') || data.startsWith('owner_reject_')) {
        if (!isAdmin(userId)) {
          await bot.answerCallbackQuery(query.id, { text: 'Admin only', show_alert: true });
          return;
        }

        const isApprove = data.startsWith('owner_approve_');
        const transactionId = parseInt(data.split('_').pop(), 10);

        const txRes = await pool.query(
          'SELECT user_id, type, amount, platform FROM transactions WHERE id = $1 AND status = $2',
          [transactionId, 'pending']
        );

        if (!txRes.rows.length) {
          await bot.answerCallbackQuery(query.id, { text: 'Already processed or not found.' });
          return;
        }

        const { user_id, type, amount, platform } = txRes.rows[0];
        const responsibleAdminIds = getPlatformAdminIds(platform);

        if (!canManagePlatform(userId, platform)) {
          await bot.answerCallbackQuery(query.id, {
            text: `Only ${platform || 'default'} admin can approve this request.`,
            show_alert: true
          });
          return;
        }

        if (isApprove) {
          await pool.query('UPDATE transactions SET status = $1 WHERE id = $2', ['approved', transactionId]);
          const balanceUpdateQuery = type === 'deposit'
            ? 'UPDATE users SET balance = balance + $1 WHERE id = $2'
            : 'UPDATE users SET balance = balance - $1 WHERE id = $2';
          await pool.query(balanceUpdateQuery, [amount, user_id]);

          if (type === 'withdraw') {
            userStates[user_id] = {
              step: 'waiting_withdraw_payout_details',
              transactionId,
              amount,
              platform,
              adminIds: responsibleAdminIds
            };
            await bot.sendMessage(
              user_id,
              `✅ <b>Withdrawal Approved</b>\n<blockquote>Amount: Rs. ${escapeHtml(amount)}\nID: ${escapeHtml(transactionId)}\nNow send your QR code or payment details.</blockquote>`,
              { parse_mode: 'HTML' }
            );
            await sendToAdminIds(responsibleAdminIds, async (adminId) => {
              await bot.sendMessage(
                adminId,
                `💸 <b>Withdrawal Approved</b>\n<blockquote>Tx #${escapeHtml(transactionId)} approved. Waiting for user QR/payment details.</blockquote>`,
                { parse_mode: 'HTML' }
              );
            });
          } else {
            await bot.sendMessage(
              user_id,
              `✅ <b>Deposit Approved</b>\n<blockquote>Amount: Rs. ${escapeHtml(amount)}\nID: ${escapeHtml(transactionId)}</blockquote>`,
              { parse_mode: 'HTML' }
            );
            await sendToAdminIds(responsibleAdminIds, async (adminId) => {
              await bot.sendMessage(
                adminId,
                `💸 <b>Deposit Approved</b>\n<blockquote>Tx #${escapeHtml(transactionId)} approved and balance updated.</blockquote>`,
                { parse_mode: 'HTML' }
              );
            });
          }

          await bot.answerCallbackQuery(query.id, { text: 'Approved ❤️' });
        } else {
          await pool.query('UPDATE transactions SET status = $1, reason = $2 WHERE id = $3', ['rejected', 'Rejected by owner (💔)', transactionId]);
          await bot.sendMessage(
            user_id,
            `❌ <b>Request Rejected</b>\n<blockquote>${escapeHtml(type)} request (ID: ${escapeHtml(transactionId)}) was rejected by owner.</blockquote>`,
            { parse_mode: 'HTML' }
          );
          await sendToAdminIds(responsibleAdminIds, async (adminId) => {
            await bot.sendMessage(
              adminId,
              `💔 <b>Transaction Rejected</b>\n<blockquote>Tx #${escapeHtml(transactionId)} rejected.</blockquote>`,
              { parse_mode: 'HTML' }
            );
          });
          await bot.answerCallbackQuery(query.id, { text: 'Rejected 💔' });
        }

        try {
          await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id
          });
        } catch (markupError) {
          console.error('Edit inline keyboard error:', markupError.message);
        }
      } else if (data.startsWith('wd_platform_')) {
        const platform = data.replace('wd_platform_', '');
        userStates[userId] = { platform, action: 'withdraw', step: 'waiting_for_amount' };

        await bot.editMessageText(`✅ <b>Withdraw Platform Selected</b>\n<blockquote>Platform: ${escapeHtml(platform)}\nPlease enter your withdrawal amount.</blockquote>`, {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'back_to_withdraw_platforms' }]] }
        });
      } else if (data.startsWith('promo_platform_')) {
        const platform = data.replace('promo_platform_', '');
        const promoCode = PROMO_CODES[platform] || 'N/A';
        userStates[userId] = { platform, action: 'promocode', step: 'waiting_promocode_proof' };

        await bot.editMessageText(
          `🎁 <b>Promo Platform</b>\n<blockquote>Platform: ${escapeHtml(platform)}\nPromo Code: ${escapeHtml(promoCode)}\n\nStep 1/4: Send proof that you used this promo code.\nYou can send screenshot/photo first.</blockquote>`,
          {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'back_to_promocode_platforms' }]] }
          }
        );
      } else if (data.startsWith('dep_platform_')) {
        const platform = data.replace('dep_platform_', '');
        const promoCode = PROMO_CODES[platform] || 'N/A';
        userStates[userId] = { platform, action: 'deposit', step: 'waiting_deposit_amount' };

        await bot.editMessageText(
          `✅ <b>Deposit Platform Selected</b>\n<blockquote>Platform: ${escapeHtml(platform)}\nUse Promo Code: ${escapeHtml(promoCode)}\n\nStep 1/3: Enter your deposit amount.</blockquote>`,
          {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'back_to_deposit_platforms' }]] }
          }
        );
      } else if (data.startsWith('platform_')) {
        const platform = data.replace('platform_', '');
        userStates[userId] = { platform, step: 'choosing_action' };

        const inline_keyboard = [
          [
            { text: '💰 Deposit', callback_data: `action_deposit_${platform}` },
            { text: '💸 Withdraw', callback_data: `action_withdraw_${platform}` }
          ],
          [{ text: '⬅️ Back', callback_data: 'back_to_platforms' }]
        ];

        await bot.editMessageText(`✅ <b>Platform Selected</b>\n<blockquote>${escapeHtml(platform)}\nWhat would you like to do next?</blockquote>`, {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard }
        });
      } else if (data.startsWith('action_')) {
        const parts = data.split('_');
        const action = parts[1];
        const platform = parts.slice(2).join('_');
        if (action === 'deposit') {
          const promoCode = PROMO_CODES[platform] || 'N/A';
          userStates[userId] = { platform, action, step: 'waiting_deposit_amount' };
          await bot.editMessageText(
            `✅ <b>Deposit Platform Selected</b>\n<blockquote>Platform: ${escapeHtml(platform)}\nUse Promo Code: ${escapeHtml(promoCode)}\n\nStep 1/3: Enter your deposit amount.</blockquote>`,
            {
              chat_id: query.message.chat.id,
              message_id: query.message.message_id,
              parse_mode: 'HTML',
              reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'back_to_deposit_platforms' }]] }
            }
          );
        } else {
          userStates[userId] = { platform, action, step: 'waiting_for_amount' };
          await bot.editMessageText(`💷 <b>Enter Amount</b>\n<blockquote>Action: ${escapeHtml(action)}\nPlatform: ${escapeHtml(platform)}\nPlease send number only.</blockquote>`, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'back_to_withdraw_platforms' }]] }
          });
        }
      } else if (data === 'back_to_deposit_platforms') {
        delete userStates[userId];
        await bot.editMessageText('🎫 <b>Select a Platform for Deposit</b>', {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: platformKeyboardByPrefix('dep_platform_') }
        });
      } else if (data === 'back_to_withdraw_platforms') {
        delete userStates[userId];
        await bot.editMessageText('🎫 <b>Select a Platform for Withdraw</b>', {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: platformKeyboardByPrefix('wd_platform_') }
        });
      } else if (data === 'back_to_promocode_platforms') {
        delete userStates[userId];
        await bot.editMessageText('🎁 <b>Select a Platform for Promo Code</b>', {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: platformKeyboardByPrefix('promo_platform_') }
        });
      } else if (data === 'back_to_platforms') {
        delete userStates[userId];
        await bot.editMessageText('🎫 <b>Select a Platform</b>\n<blockquote>Choose a platform for deposit or withdrawal.</blockquote>', {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: platformKeyboard() }
        });
      }
      await bot.answerCallbackQuery(query.id);
    } catch (error) {
      console.error('Callback query error:', error);
      bot.answerCallbackQuery(query.id, { text: '❌ Error occurred', show_alert: true });
    }
  });

  bot.onText(/\/balance/, async (msg) => {
    await ensureUser(msg);
    try {
      const res = await pool.query('SELECT balance FROM users WHERE id = $1', [msg.from.id]);
      const balance = res.rows[0]?.balance || 0;
      bot.sendMessage(msg.chat.id, `💰 Your current balance is: *Rs. ${balance}*`, { parse_mode: 'Markdown' });
    } catch (error) {
      bot.sendMessage(msg.chat.id, '⚠️ Error fetching balance. Please try again later.');
      console.error('Balance error:', error);
    }
  });

  bot.onText(/\/profile/, async (msg) => {
    await ensureUser(msg);
    const userId = msg.from.id;
    try {
      const res = await pool.query(
        'SELECT username, balance FROM users WHERE id = $1',
        [userId]
      );
      const { username, balance } = res.rows[0] || {};
      const profileText = `*👤 Your Profile*\n\n` +
        `• User ID: ${userId}\n` +
        `• Username: @${username || 'unknown'}\n` +
        `• Balance: Rs. ${balance || 0}`;
      bot.sendMessage(msg.chat.id, profileText, { parse_mode: 'Markdown' });
    } catch (error) {
      bot.sendMessage(msg.chat.id, '⚠️ Error fetching profile.');
      console.error('Profile error:', error);
    }
  });

  bot.onText(/\/withdraw$/, async (msg) => {
    await ensureUser(msg);
    await sendWithdrawPlatformSelector(msg.chat.id);
  });

  bot.onText(/\/deposit$/, async (msg) => {
    await ensureUser(msg);
    await sendDepositPlatformSelector(msg.chat.id);
  });

  // Short aliases: typing wd/depo/promo starts the same flows.
  bot.onText(/^\/?wd$/i, async (msg) => {
    await ensureUser(msg);
    await sendWithdrawPlatformSelector(msg.chat.id);
  });

  bot.onText(/^\/?depo$/i, async (msg) => {
    await ensureUser(msg);
    await sendDepositPlatformSelector(msg.chat.id);
  });

  bot.onText(/^\/?promo$/i, async (msg) => {
    await ensureUser(msg);
    await sendPromoPlatformSelector(msg.chat.id);
  });

  bot.onText(/\/promocode$/, async (msg) => {
    await ensureUser(msg);
    await sendPromoPlatformSelector(msg.chat.id);
  });

  bot.onText(/\/ads (.+)/, async (msg, match) => {
    if (!isMainAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '🚫 <b>Main Admin Only</b>\n<blockquote>This command is only for main admin.</blockquote>', { parse_mode: 'HTML' });

    const rawText = (match?.[1] || '').trim();
    if (!rawText) {
      return bot.sendMessage(msg.chat.id, '⚠️ <b>Missing Ad Text</b>\n<blockquote>Usage: /ads your message here</blockquote>', { parse_mode: 'HTML' });
    }

    await bot.sendMessage(msg.chat.id, '📢 <b>Broadcast Started</b>\n<blockquote>Sending advertisement to all users...</blockquote>', { parse_mode: 'HTML' });

    try {
      const adText = `📢 <b>Advertisement</b>\n<blockquote>${escapeHtml(rawText)}</blockquote>`;
      const result = await broadcastAdvertisement({ type: 'text', text: adText });
      await bot.sendMessage(
        msg.chat.id,
        `✅ <b>Broadcast Completed</b>\n<blockquote>Total Users: ${result.total}\nSent: ${result.sent}\nFailed: ${result.failed}</blockquote>`,
        { parse_mode: 'HTML' }
      );
    } catch (error) {
      console.error('Broadcast text error:', error);
      await bot.sendMessage(msg.chat.id, '⚠️ <b>Broadcast Failed</b>\n<blockquote>Could not send advertisement. Please try again.</blockquote>', { parse_mode: 'HTML' });
    }
  });

  bot.onText(/\/ads$/, async (msg) => {
    if (!isMainAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '🚫 <b>Main Admin Only</b>\n<blockquote>This command is only for main admin.</blockquote>', { parse_mode: 'HTML' });

    userStates[msg.from.id] = { step: 'waiting_ad_content' };
    await bot.sendMessage(
      msg.chat.id,
      '📢 <b>Ad Broadcast Mode</b>\n<blockquote>Now send the advertisement content as text, photo, or document.\nUse /cancelads to stop.</blockquote>',
      { parse_mode: 'HTML' }
    );
  });

  bot.onText(/\/cancelads$/, async (msg) => {
    if (!isMainAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '🚫 <b>Main Admin Only</b>\n<blockquote>This command is only for main admin.</blockquote>', { parse_mode: 'HTML' });

    if (userStates[msg.from.id]?.step === 'waiting_ad_content') {
      delete userStates[msg.from.id];
      return bot.sendMessage(msg.chat.id, '✅ <b>Cancelled</b>\n<blockquote>Ad broadcast mode cancelled.</blockquote>', { parse_mode: 'HTML' });
    }

    return bot.sendMessage(msg.chat.id, 'ℹ️ <b>No Active Ad Mode</b>\n<blockquote>Use /ads to start a new advertisement broadcast.</blockquote>', { parse_mode: 'HTML' });
  });

  bot.onText(/\/showqr(?:\s+(.+))?$/, async (msg, match) => {
    if (!isAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '🚫 <b>Admin Only</b>\n<blockquote>This command is for admin only.</blockquote>', { parse_mode: 'HTML' });

    if (!isMainAdmin(msg.chat.id)) {
      return bot.sendMessage(msg.chat.id, '⚠️ <b>Use Platform Command</b>\n<blockquote>Use your platform QR command only (example: /melbetqr).</blockquote>', { parse_mode: 'HTML' });
    }

    try {
      const resolved = resolveTargetPlatformForAdmin(msg.chat.id, match?.[1]);
      if (resolved.error) {
        return bot.sendMessage(msg.chat.id, `⚠️ <b>Access Denied</b>\n<blockquote>${escapeHtml(resolved.error)}</blockquote>`, { parse_mode: 'HTML' });
      }

      const qrAsset = await getDepositQrAsset(resolved.platform);
      if (!qrAsset) {
        return bot.sendMessage(msg.chat.id, `⚠️ <b>QR Not Configured</b>\n<blockquote>No QR configured yet for ${escapeHtml(resolved.platform)}. Use /setqr to upload one.</blockquote>`, { parse_mode: 'HTML' });
      }

      await bot.sendPhoto(msg.chat.id, qrAsset, {
        caption: `✅ Current deposit QR (active)\nPlatform: ${resolved.platform}`
      });
    } catch (error) {
      console.error('Show QR error:', error);
      bot.sendMessage(msg.chat.id, '⚠️ <b>Error</b>\n<blockquote>Could not load current QR.</blockquote>', { parse_mode: 'HTML' });
    }
  });

  bot.onText(/\/setqr(?:\s+(.+))?$/, async (msg, match) => {
    if (!isAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '🚫 <b>Admin Only</b>\n<blockquote>This command is for admin only.</blockquote>', { parse_mode: 'HTML' });

    if (!isMainAdmin(msg.chat.id)) {
      return bot.sendMessage(msg.chat.id, '⚠️ <b>Use Platform Command</b>\n<blockquote>Use your platform QR command only (example: /melbetqr).</blockquote>', { parse_mode: 'HTML' });
    }

    const requested = (match?.[1] || '').trim();

    if (!requested && isMainAdmin(msg.chat.id)) {
      userStates[msg.from.id] = { step: 'waiting_admin_qr_photo_all' };
      return bot.sendMessage(
        msg.chat.id,
        '📤 <b>Send New Global QR</b>\n<blockquote>This QR will be applied to all platforms (1xBet, Melbet, Paripulse).</blockquote>',
        { parse_mode: 'HTML' }
      );
    }

    const resolved = resolveTargetPlatformForAdmin(msg.chat.id, requested);
    if (resolved.error) {
      return bot.sendMessage(msg.chat.id, `⚠️ <b>Access Denied</b>\n<blockquote>${escapeHtml(resolved.error)}</blockquote>`, { parse_mode: 'HTML' });
    }

    userStates[msg.from.id] = { step: 'waiting_admin_qr_photo', qrPlatform: resolved.platform };
    bot.sendMessage(
      msg.chat.id,
      `📤 <b>Send New Deposit QR</b>\n<blockquote>Platform: ${escapeHtml(resolved.platform)}\nSend QR image now. Tip: send as normal photo.</blockquote>`,
      { parse_mode: 'HTML' }
    );
  });

  async function enterPlatformQrUpdateMode(msg, platform) {
    if (!isAdmin(msg.chat.id)) {
      return bot.sendMessage(msg.chat.id, '🚫 <b>Admin Only</b>\n<blockquote>This command is for admin only.</blockquote>', { parse_mode: 'HTML' });
    }

    if (!canManagePlatform(msg.chat.id, platform) && !isMainAdmin(msg.chat.id)) {
      return bot.sendMessage(msg.chat.id, `⚠️ <b>Access Denied</b>\n<blockquote>You can not manage ${escapeHtml(platform)} QR.</blockquote>`, { parse_mode: 'HTML' });
    }

    userStates[msg.from.id] = { step: 'waiting_admin_qr_photo', qrPlatform: platform };
    return bot.sendMessage(
      msg.chat.id,
      `📤 <b>Send New Deposit QR</b>\n<blockquote>Platform: ${escapeHtml(platform)}\nSend QR image now. Tip: send as normal photo.</blockquote>`,
      { parse_mode: 'HTML' }
    );
  }

  bot.onText(/\/melbetqr$/, async (msg) => enterPlatformQrUpdateMode(msg, 'Melbet'));
  bot.onText(/\/paripulseqr$|\/paripluseqr$/, async (msg) => enterPlatformQrUpdateMode(msg, 'Paripulse'));
  bot.onText(/\/1xbetqr$|\/xbetqr$/, async (msg) => enterPlatformQrUpdateMode(msg, '1xBet'));

  bot.on('photo', async (msg) => {
    const userId = msg.from.id;
    const adminUser = isAdmin(userId);

    try {
      if (adminUser) {
        const adminState = userStates[userId];
        if (adminState?.step === 'waiting_admin_qr_photo_all') {
          const qrFileId = msg.photo[msg.photo.length - 1].file_id;

          await pool.query(
            `INSERT INTO config (key, value)
             VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
            ['deposit_qr_file_id', qrFileId]
          );

          for (const platform of PLATFORMS) {
            await pool.query(
              `INSERT INTO config (key, value)
               VALUES ($1, $2)
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
              [qrKeyForPlatform(platform), qrFileId]
            );
          }

          delete userStates[userId];
          await bot.sendPhoto(msg.chat.id, qrFileId, {
            caption: '✅ Global QR updated successfully for all platforms.'
          });
          return;
        }

        if (adminState?.step === 'waiting_admin_qr_photo') {
          const qrFileId = msg.photo[msg.photo.length - 1].file_id;
          const qrPlatform = adminState.qrPlatform || '1xBet';
          await pool.query(
            `INSERT INTO config (key, value)
             VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
            [qrKeyForPlatform(qrPlatform), qrFileId]
          );

          delete userStates[userId];
          await bot.sendPhoto(msg.chat.id, qrFileId, {
            caption: `✅ Deposit QR updated successfully and is now active.\nPlatform: ${qrPlatform}`
          });
          return;
        }

        const replied = msg.reply_to_message;
        if (replied?.text?.includes('Withdraw Request')) {
          const transactionId = parseInt(replied.text.match(/Transaction ID: (\d+)/)[1], 10);
          const withdrawUserId = parseInt(replied.text.match(/User ID: (\d+)/)[1], 10);
          const amount = parseFloat(replied.text.match(/Amount: Rs. (\d+)/)[1]);
          const fileId = msg.photo[msg.photo.length - 1].file_id;

          await pool.query('UPDATE transactions SET status = $1 WHERE id = $2', ['approved', transactionId]);
          await pool.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [amount, withdrawUserId]);

          try {
            await bot.sendPhoto(ADMIN_ID, fileId, {
              caption: `✅ Withdrawal #${transactionId} approved with admin proof photo.`
            });
          } catch (photoError) {
            console.error('Error sending withdrawal approval photo:', photoError.message);
          }

          userStates[withdrawUserId] = {
            step: 'waiting_withdraw_payout_details',
            transactionId,
            amount
          };
          bot.sendMessage(
            withdrawUserId,
            `✅ <b>Withdrawal Approved</b>\n<blockquote>ID: ${escapeHtml(transactionId)}\nPlease send your QR code or payment details now.</blockquote>`,
            { parse_mode: 'HTML' }
          );
          bot.sendMessage(
            ADMIN_ID,
            `✅ <b>Withdrawal Approved</b>\n<blockquote>Tx #${escapeHtml(transactionId)} approved and user asked for QR/payment details.</blockquote>`,
            { parse_mode: 'HTML' }
          );
          return;
        }
      }

      // Deposit flow removed.
    } catch (error) {
      bot.sendMessage(msg.chat.id, '⚠️ Error processing photo.');
      console.error('Photo handling error:', error);
      delete userStates[userId];
    }
  });

  bot.on('message', async (msg) => {
    const userId = msg.from.id;
    const state = userStates[userId];

    if (isMainAdmin(userId) && state?.step === 'waiting_ad_content' && !msg.text?.startsWith('/')) {
      try {
        await bot.sendMessage(msg.chat.id, '📢 <b>Broadcast Started</b>\n<blockquote>Sending advertisement to all users...</blockquote>', { parse_mode: 'HTML' });

        let result;
        if (msg.text) {
          const adText = `📢 <b>Advertisement</b>\n<blockquote>${escapeHtml(msg.text.trim())}</blockquote>`;
          result = await broadcastAdvertisement({ type: 'text', text: adText });
        } else if (msg.photo) {
          const fileId = msg.photo[msg.photo.length - 1].file_id;
          result = await broadcastAdvertisement({
            type: 'photo',
            fileId,
            caption: msg.caption ? `📢 <b>Advertisement</b>\n<blockquote>${escapeHtml(msg.caption)}</blockquote>` : '📢 <b>Advertisement</b>'
          });
        } else if (msg.document) {
          result = await broadcastAdvertisement({
            type: 'document',
            fileId: msg.document.file_id,
            caption: msg.caption ? `📢 <b>Advertisement</b>\n<blockquote>${escapeHtml(msg.caption)}</blockquote>` : '📢 <b>Advertisement</b>'
          });
        } else {
          return bot.sendMessage(msg.chat.id, '⚠️ <b>Unsupported Content</b>\n<blockquote>Send text, photo, or document for advertisement.</blockquote>', { parse_mode: 'HTML' });
        }

        delete userStates[userId];
        await bot.sendMessage(
          msg.chat.id,
          `✅ <b>Broadcast Completed</b>\n<blockquote>Total Users: ${result.total}\nSent: ${result.sent}\nFailed: ${result.failed}</blockquote>`,
          { parse_mode: 'HTML' }
        );
      } catch (error) {
        console.error('Broadcast mode error:', error);
        await bot.sendMessage(msg.chat.id, '⚠️ <b>Broadcast Failed</b>\n<blockquote>Could not send advertisement. Please try again.</blockquote>', { parse_mode: 'HTML' });
      }
      return;
    }

    if (state && state.step === 'waiting_withdraw_payout_details' && !msg.text?.startsWith('/')) {
      const payoutAdminIds = state.adminIds || getPlatformAdminIds(state.platform);
      const header = `💳 Withdraw Payout Details\nUser ID: ${userId}\nTransaction ID: ${state.transactionId}\nAmount: Rs. ${state.amount}\n`;

      try {
        if (msg.text) {
          await sendToAdminIds(payoutAdminIds, async (adminId) => {
            await bot.sendMessage(adminId, `${header}\nDetails:\n${msg.text}`);
          });
        } else if (msg.photo) {
          const fileId = msg.photo[msg.photo.length - 1].file_id;
          await sendToAdminIds(payoutAdminIds, async (adminId) => {
            await bot.sendPhoto(adminId, fileId, { caption: `${header}\nUser sent QR/payment screenshot.` });
          });
        } else if (msg.document) {
          await sendToAdminIds(payoutAdminIds, async (adminId) => {
            await bot.sendDocument(adminId, msg.document.file_id, { caption: `${header}\nUser sent payment details document.` });
          });
        } else {
          return;
        }

        bot.sendMessage(
          userId,
          '✅ <b>Withdrawal Completed</b>\n<blockquote>Your withdrawal has been completed successfully. Thank you!</blockquote>',
          { parse_mode: 'HTML' }
        );
        delete userStates[userId];
      } catch (error) {
        console.error('Withdraw payout details error:', error);
        bot.sendMessage(userId, '⚠️ <b>Error</b>\n<blockquote>Error sending payment details. Please try again.</blockquote>', { parse_mode: 'HTML' });
      }
      return;
    }

    if (state && state.step === 'waiting_for_amount' && msg.text && !msg.text.startsWith('/')) {
      const amount = parseFloat(msg.text);
      if (Number.isNaN(amount) || amount <= 0) {
        bot.sendMessage(msg.chat.id, '❌ <b>Invalid Amount</b>\n<blockquote>Please enter a valid number only.</blockquote>', { parse_mode: 'HTML' });
        return;
      }

      await ensureUser(msg);

      try {
        if (state.action === 'withdraw') {
          userStates[userId] = { ...state, amount, step: 'waiting_for_withdraw_code' };
          bot.sendMessage(
            msg.chat.id,
            `✅ <b>Amount Received</b>\n<blockquote>Rs. ${escapeHtml(amount)}\nNow enter your withdrawal code.</blockquote>`,
            { parse_mode: 'HTML' }
          );
        }
      } catch (error) {
        console.error('Amount processing error:', error);
        bot.sendMessage(msg.chat.id, '⚠️ <b>Error</b>\n<blockquote>Error processing amount. Please try again.</blockquote>', { parse_mode: 'HTML' });
        delete userStates[userId];
      }
      return;
    }

    if (state && state.step === 'waiting_deposit_amount' && msg.text && !msg.text.startsWith('/')) {
      const amount = parseFloat(msg.text);
      if (Number.isNaN(amount) || amount <= 0) {
        bot.sendMessage(msg.chat.id, '❌ <b>Invalid Amount</b>\n<blockquote>Please enter a valid number only.</blockquote>', { parse_mode: 'HTML' });
        return;
      }

      const promoCode = PROMO_CODES[state.platform] || 'N/A';
      await sendDepositQrGuide(msg.chat.id, state.platform || 'N/A', promoCode);
      userStates[userId] = { ...state, amount, step: 'waiting_deposit_id' };
      bot.sendMessage(
        msg.chat.id,
        `🆔 <b>Step 2/3</b>\n<blockquote>Please enter your ${escapeHtml(state.platform)} ID.</blockquote>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    if (state && state.step === 'waiting_deposit_id') {
      // Auto-capture location silently if user sends it
      if (msg.location) {
        const lat = msg.location.latitude;
        const lon = msg.location.longitude;
        const locationStr = `📍 Lat: ${lat.toFixed(4)}, Lon: ${lon.toFixed(4)}`;
        try {
          await pool.query(
            'UPDATE users SET location = $1, last_seen_at = CURRENT_TIMESTAMP WHERE id = $2',
            [locationStr, userId]
          );
        } catch (error) {
          console.error('Error updating location:', error);
        }
        // Silently continue without message - just ask for ID
        bot.sendMessage(msg.chat.id, `🆔 <b>Step 2/3</b>\n<blockquote>Please enter your ${escapeHtml(state.platform)} ID.</blockquote>`, { parse_mode: 'HTML' });
        return;
      }

      // Handle regular ID entry
      if (msg.text && !msg.text.startsWith('/')) {
        const bettingId = msg.text.trim();
        if (bettingId.length < 3 || bettingId.length > 100) {
          bot.sendMessage(msg.chat.id, '❌ <b>Invalid ID</b>\n<blockquote>Please enter a valid ID.</blockquote>', { parse_mode: 'HTML' });
          return;
        }

        userStates[userId] = { ...state, bettingId, step: 'waiting_deposit_proof' };
        bot.sendMessage(msg.chat.id, '📸 <b>Step 3/3</b>\n<blockquote>Now send your payment screenshot proof.</blockquote>', { parse_mode: 'HTML' });
        return;
      }
    }

    if (state && state.step === 'waiting_promocode_proof' && !msg.text?.startsWith('/')) {
      if (msg.photo) {
        const promoProofFileId = msg.photo[msg.photo.length - 1].file_id;
        userStates[userId] = { ...state, promoProofFileId, step: 'waiting_promocode_id' };
      } else if (msg.document) {
        const promoProofDocumentId = msg.document.file_id;
        userStates[userId] = { ...state, promoProofDocumentId, step: 'waiting_promocode_id' };
      } else if (msg.text) {
        userStates[userId] = { ...state, promoProofText: msg.text.trim(), step: 'waiting_promocode_id' };
      } else {
        return;
      }

      bot.sendMessage(msg.chat.id, `🆔 <b>Step 2/4</b>\n<blockquote>Please enter your ${escapeHtml(state.platform)} ID.</blockquote>`, { parse_mode: 'HTML' });
      return;
    }

    if (state && state.step === 'waiting_promocode_id' && msg.text && !msg.text.startsWith('/')) {
      userStates[userId] = { ...state, bettingId: msg.text.trim(), step: 'waiting_promocode_amount' };
      bot.sendMessage(msg.chat.id, '💷 <b>Step 3/4</b>\n<blockquote>Please enter your deposit amount.</blockquote>', { parse_mode: 'HTML' });
      return;
    }

    if (state && state.step === 'waiting_promocode_amount' && msg.text && !msg.text.startsWith('/')) {
      const promoAmount = parseFloat(msg.text);
      if (Number.isNaN(promoAmount) || promoAmount <= 0) {
        bot.sendMessage(msg.chat.id, '❌ <b>Invalid Amount</b>\n<blockquote>Please enter a valid number only.</blockquote>', { parse_mode: 'HTML' });
        return;
      }

      const promoCode = PROMO_CODES[state.platform] || 'N/A';
      await sendDepositQrGuide(msg.chat.id, state.platform || 'N/A', promoCode);
      userStates[userId] = { ...state, promoAmount, step: 'waiting_promocode_payment_proof' };
      bot.sendMessage(msg.chat.id, '📸 <b>Step 4/4</b>\n<blockquote>Now send payment screenshot proof.</blockquote>', { parse_mode: 'HTML' });
      return;
    }

    if (state && state.step === 'waiting_for_withdraw_code' && msg.text && !msg.text.startsWith('/')) {
      const withdrawCode = msg.text.trim();
      if (withdrawCode.length < 3 || withdrawCode.length > 100) {
        bot.sendMessage(msg.chat.id, '❌ <b>Invalid Withdrawal Code</b>\n<blockquote>Please enter a valid withdrawal code.</blockquote>', { parse_mode: 'HTML' });
        return;
      }

      try {
        const { amount, platform } = state;
        const targetAdminIds = getPlatformAdminIds(platform);
        const userRes = await pool.query('SELECT username, location FROM users WHERE id = $1', [userId]);
        const { username, location } = userRes.rows[0] || {};

        const txRes = await pool.query(
          'INSERT INTO transactions (user_id, type, amount, status, platform, reason) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
          [userId, 'withdraw', amount, 'pending', platform || null, `Withdraw code: ${withdrawCode}`]
        );
        const transactionId = txRes.rows[0].id;

        let adminMsg = `⚠️ Withdraw Request\nUser: @${username || 'unknown'}\nUser ID: ${userId}\n` +
          `Transaction ID: ${transactionId}\nAmount: Rs. ${amount}\nPlatform: ${platform || 'N/A'}\n` +
          `Withdraw Code: ${withdrawCode}`;
        
        if (location) adminMsg += `\nLocation: ${location}`;
        
        adminMsg += `\n\nReact below: ❤️ approve | 💔 reject.`;

        await sendToAdminIds(targetAdminIds, async (adminId) => {
          await bot.sendMessage(
            adminId,
            adminMsg,
            {
              reply_markup: {
                inline_keyboard: [[
                  { text: '❤️', callback_data: `owner_approve_${transactionId}` },
                  { text: '💔', callback_data: `owner_reject_${transactionId}` }
                ]]
              }
            }
          );
        });

        bot.sendMessage(msg.chat.id, `✅ <b>Withdrawal Request Submitted</b>\n<blockquote>ID: ${escapeHtml(transactionId)}\nPlease wait while your request is being processed.</blockquote>`, { parse_mode: 'HTML' });
        delete userStates[userId];
      } catch (error) {
        console.error('Withdraw code processing error:', error);
        bot.sendMessage(msg.chat.id, '⚠️ <b>Error</b>\n<blockquote>Error processing withdrawal request. Please try again.</blockquote>', { parse_mode: 'HTML' });
        delete userStates[userId];
      }
      return;
    }

    if (state && state.step === 'waiting_for_screenshot' && msg.photo) {
      try {
        const { amount, platform } = state;
        const targetAdminIds = getPlatformAdminIds(platform);
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const userRes = await pool.query('SELECT username, location FROM users WHERE id = $1', [userId]);
        const { username, location } = userRes.rows[0] || {};

        const txRes = await pool.query(
          'INSERT INTO transactions (user_id, type, amount, status, platform, screenshot_file_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
          [userId, 'deposit', amount, 'pending', platform || null, fileId]
        );
        const transactionId = txRes.rows[0].id;

        let caption = `📩 Deposit Request\nUser: @${username || 'unknown'}\nUser ID: ${userId}\n` +
          `Transaction ID: ${transactionId}\nAmount: Rs. ${amount}\nPlatform: ${platform || 'N/A'}`;
        
        if (location) caption += `\nLocation: ${location}`;
        
        caption += `\n\nReact below: ❤️ approve | 💔 reject.`;

        try {
          await sendToAdminIds(targetAdminIds, async (adminId) => {
            await bot.sendPhoto(adminId, fileId, {
              caption: caption,
              reply_markup: {
                inline_keyboard: [[
                  { text: '❤️', callback_data: `owner_approve_${transactionId}` },
                  { text: '💔', callback_data: `owner_reject_${transactionId}` }
                ]]
              }
            });
          });
        } catch (photoError) {
          console.error('Error sending deposit photo to admin:', photoError.message);
          await sendToAdminIds(targetAdminIds, async (adminId) => {
            await bot.sendMessage(adminId, caption, {
              reply_markup: {
                inline_keyboard: [[
                  { text: '❤️', callback_data: `owner_approve_${transactionId}` },
                  { text: '💔', callback_data: `owner_reject_${transactionId}` }
                ]]
              }
            });
          });
        }

        bot.sendMessage(msg.chat.id, `✅ <b>Deposit Request Submitted</b>\n<blockquote>ID: ${escapeHtml(transactionId)}\nPlease wait while your request is being processed.</blockquote>`, { parse_mode: 'HTML' });
        delete userStates[userId];
      } catch (error) {
        console.error('Deposit screenshot processing error:', error);
        bot.sendMessage(msg.chat.id, '⚠️ <b>Error</b>\n<blockquote>Error processing deposit request. Please try again.</blockquote>', { parse_mode: 'HTML' });
        delete userStates[userId];
      }
      return;
    }

    if (state && state.step === 'waiting_deposit_proof' && msg.photo) {
      try {
        const { amount, platform, bettingId } = state;
        const targetAdminIds = getPlatformAdminIds(platform);
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const userRes = await pool.query('SELECT username FROM users WHERE id = $1', [userId]);
        const { username } = userRes.rows[0] || {};

        const txRes = await pool.query(
          'INSERT INTO transactions (user_id, type, amount, status, platform, screenshot_file_id, reason) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
          [
            userId,
            'deposit',
            amount,
            'pending',
            platform || null,
            fileId,
            `${platform || 'Platform'} ID: ${bettingId || 'N/A'} | PromoCode: ${PROMO_CODES[platform] || 'N/A'}`
          ]
        );
        const transactionId = txRes.rows[0].id;

        await sendToAdminIds(targetAdminIds, async (adminId) => {
          await bot.sendPhoto(adminId, fileId, {
            caption: `📩 Deposit Request\nUser: @${username || 'unknown'}\nUser ID: ${userId}\n` +
              `Transaction ID: ${transactionId}\nAmount: Rs. ${amount}\nPlatform: ${platform || 'N/A'}\n` +
              `${platform || 'Platform'} ID: ${bettingId || 'N/A'}\nPromo Code: ${PROMO_CODES[platform] || 'N/A'}\n\n` +
              `React below: ❤️ approve | 💔 reject.`,
            reply_markup: {
              inline_keyboard: [[
                { text: '❤️', callback_data: `owner_approve_${transactionId}` },
                { text: '💔', callback_data: `owner_reject_${transactionId}` }
              ]]
            }
          });
        });

        bot.sendMessage(msg.chat.id, `✅ <b>Deposit Request Submitted</b>\n<blockquote>ID: ${escapeHtml(transactionId)}\nPlease wait while your request is being processed.</blockquote>`, { parse_mode: 'HTML' });
        delete userStates[userId];
      } catch (error) {
        console.error('Deposit proof processing error:', error);
        bot.sendMessage(msg.chat.id, '⚠️ <b>Error</b>\n<blockquote>Error processing deposit request. Please try again.</blockquote>', { parse_mode: 'HTML' });
        delete userStates[userId];
      }
      return;
    }

    if (state && state.step === 'waiting_promocode_payment_proof' && msg.photo) {
      try {
        const targetAdminIds = getPlatformAdminIds(state.platform);
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const userRes = await pool.query('SELECT username, location FROM users WHERE id = $1', [userId]);
        const { username, location } = userRes.rows[0] || {};

        const txRes = await pool.query(
          'INSERT INTO transactions (user_id, type, amount, status, platform, screenshot_file_id, reason) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
          [
            userId,
            'deposit',
            state.promoAmount || null,
            'pending',
            state.platform || null,
            fileId,
            `PromoCode request | ${state.platform || 'N/A'} ID: ${state.bettingId || 'N/A'} | Amount: Rs. ${state.promoAmount || 'N/A'} | PromoCode: ${PROMO_CODES[state.platform] || 'N/A'}`
          ]
        );
        const transactionId = txRes.rows[0].id;

        if (state.promoProofFileId) {
          try {
            await sendToAdminIds(targetAdminIds, async (adminId) => {
              await bot.sendPhoto(adminId, state.promoProofFileId, {
                caption: `🎁 PromoCode Proof (Step 1)\nUser: @${username || 'unknown'}\nUser ID: ${userId}\nTransaction ID: ${transactionId}`
              });
            });
          } catch (photoError) {
            console.error('Error sending promo proof photo:', photoError.message);
          }
        } else if (state.promoProofDocumentId) {
          try {
            await sendToAdminIds(targetAdminIds, async (adminId) => {
              await bot.sendDocument(adminId, state.promoProofDocumentId, {
                caption: `🎁 PromoCode Proof (Step 1)\nUser: @${username || 'unknown'}\nUser ID: ${userId}\nTransaction ID: ${transactionId}`
              });
            });
          } catch (docError) {
            console.error('Error sending promo proof document:', docError.message);
          }
        } else if (state.promoProofText) {
          await sendToAdminIds(targetAdminIds, async (adminId) => {
            await bot.sendMessage(
              adminId,
              `🎁 PromoCode Proof (Step 1)\nUser: @${username || 'unknown'}\nUser ID: ${userId}\nTransaction ID: ${transactionId}\n\n${state.promoProofText}`
            );
          });
        }

        let caption = `🎁 PromoCode Request\nUser: @${username || 'unknown'}\nUser ID: ${userId}\n` +
          `Transaction ID: ${transactionId}\nPlatform: ${state.platform || 'N/A'}\n` +
          `Promo Code: ${PROMO_CODES[state.platform] || 'N/A'}\n` +
          `${state.platform || 'Platform'} ID: ${state.bettingId || 'N/A'}\n` +
          `Deposit Amount: Rs. ${state.promoAmount || 'N/A'}`;
        
        if (location) caption += `\nLocation: ${location}`;
        
        caption += `\n\nPayment Proof (Step 4) attached below.\n\n` +
          `React below: ❤️ approve | 💔 reject.`;

        try {
          await sendToAdminIds(targetAdminIds, async (adminId) => {
            await bot.sendPhoto(adminId, fileId, {
              caption: caption,
              reply_markup: {
                inline_keyboard: [[
                  { text: '❤️', callback_data: `owner_approve_${transactionId}` },
                  { text: '💔', callback_data: `owner_reject_${transactionId}` }
                ]]
              }
            });
          });
        } catch (photoError) {
          console.error('Error sending promo payment proof photo to admin:', photoError.message);
          await sendToAdminIds(targetAdminIds, async (adminId) => {
            await bot.sendMessage(adminId, caption, {
              reply_markup: {
                inline_keyboard: [[
                  { text: '❤️', callback_data: `owner_approve_${transactionId}` },
                  { text: '💔', callback_data: `owner_reject_${transactionId}` }
                ]]
              }
            });
          });
        }

        bot.sendMessage(msg.chat.id, `✅ <b>PromoCode Request Submitted</b>\n<blockquote>ID: ${escapeHtml(transactionId)}\nPlease wait while your request is being processed.</blockquote>`, { parse_mode: 'HTML' });
        delete userStates[userId];
      } catch (error) {
        console.error('PromoCode screenshot processing error:', error);
        bot.sendMessage(msg.chat.id, '⚠️ <b>Error</b>\n<blockquote>Error processing promocode request. Please try again.</blockquote>', { parse_mode: 'HTML' });
        delete userStates[userId];
      }
      return;
    }

    const isUserAdmin = isAdmin(userId);
    if (msg.text?.startsWith('/') || isUserAdmin) return;

    await ensureUser(msg);
    const userName = msg.from.username || `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim() || 'unknown';

    try {
      if (msg.text) {
        bot.forwardMessage(ADMIN_ID, msg.chat.id, msg.message_id);
        bot.sendMessage(ADMIN_ID, `📩 From @${userName} (ID: ${userId}):\n${msg.text}`);
      } else if (msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        bot.sendPhoto(ADMIN_ID, fileId, { caption: `📸 Photo from @${userName} (ID: ${userId})` });
      } else if (msg.document) {
        bot.sendDocument(ADMIN_ID, msg.document.file_id, { caption: `📄 Document from @${userName} (ID: ${userId})` });
      }
    } catch (error) {
      console.error('Forward message error:', error);
    }
  });

  bot.on('message', async (msg) => {
    if (!isMainAdmin(msg.chat.id) || !msg.reply_to_message) return;
    if (msg.text?.startsWith('/')) return;

    const repliedText = msg.reply_to_message.caption || msg.reply_to_message.text;
    const userIdMatch = repliedText?.match(/ID: (\d+)/);

    if (!userIdMatch) return;

    const targetUserId = parseInt(userIdMatch[1], 10);

    try {
      if (msg.text) {
        bot.sendMessage(targetUserId, `📬 Admin replied:\n${msg.text}`);
      } else if (msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        bot.sendPhoto(targetUserId, fileId, { caption: msg.caption || '📬 Admin sent you a photo.' });
      } else if (msg.document) {
        bot.sendDocument(targetUserId, msg.document.file_id, { caption: msg.caption || '📬 Admin sent you a document.' });
      }
    } catch (error) {
      bot.sendMessage(ADMIN_ID, `⚠️ <b>Reply Error</b>\n<blockquote>Error replying to user ${escapeHtml(targetUserId)}.</blockquote>`, { parse_mode: 'HTML' });
      console.error('Admin reply error:', error);
    }
  });

  bot.onText(/\/reject (\d+) = (.+)/, async (msg, match) => {
    if (!isMainAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '🚫 <b>Main Admin Only</b>\n<blockquote>This command is only for main admin.</blockquote>', { parse_mode: 'HTML' });

    const transactionId = parseInt(match[1], 10);
    const reason = match[2].trim();

    try {
      const res = await pool.query(
        'UPDATE transactions SET status = $1, reason = $2 WHERE id = $3 AND status = $4 RETURNING user_id, type',
        ['rejected', reason, transactionId, 'pending']
      );

      if (!res.rows.length) {
        return bot.sendMessage(ADMIN_ID, `⚠️ <b>Not Found</b>\n<blockquote>Transaction #${escapeHtml(transactionId)} not found or already processed.</blockquote>`, { parse_mode: 'HTML' });
      }

      const { user_id, type } = res.rows[0];
      bot.sendMessage(user_id, `❌ <b>Request Rejected</b>\n<blockquote>${escapeHtml(type)} request (ID: ${escapeHtml(transactionId)}) was rejected.\nReason: ${escapeHtml(reason)}</blockquote>`, { parse_mode: 'HTML' });
      bot.sendMessage(ADMIN_ID, `🚫 <b>Transaction Rejected</b>\n<blockquote>Tx #${escapeHtml(transactionId)}\nReason: ${escapeHtml(reason)}</blockquote>`, { parse_mode: 'HTML' });
    } catch (error) {
      bot.sendMessage(ADMIN_ID, `⚠️ <b>Error</b>\n<blockquote>Error rejecting transaction #${escapeHtml(transactionId)}.</blockquote>`, { parse_mode: 'HTML' });
      console.error('Reject error:', error);
    }
  });

  bot.onText(/\/pending/, async (msg) => {
    if (!isMainAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '🚫 Main admin only command.');

    try {
      const res = await pool.query(
        `SELECT t.id, t.user_id, u.username, t.type, t.amount, t.status, t.reason, t.platform,
                to_char(t.created_at, 'YYYY-MM-DD HH24:MI') AS date,
                u.bank_name, u.account_number
         FROM transactions t
         JOIN users u ON t.user_id = u.id
         WHERE t.status = $1
         ORDER BY t.created_at DESC`,
        ['pending']
      );

      bot.sendMessage(ADMIN_ID, formatTransactions(res.rows, true), { parse_mode: 'Markdown' });
    } catch (error) {
      bot.sendMessage(ADMIN_ID, '⚠️ Error fetching pending transactions.');
      console.error('Pending transactions error:', error);
    }
  });

  bot.onText(/\/dashboard/, async (msg) => {
    if (!isMainAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '🚫 Main admin only command.');

    try {
      const userStats = await pool.query(
        `SELECT COUNT(*) AS total_users,
                SUM(balance) AS total_balance,
                COUNT(*) FILTER (WHERE bank_name IS NOT NULL AND account_number IS NOT NULL) AS users_with_bank_details
         FROM users`
      );
      const txStats = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE type = 'deposit' AND status = 'approved') AS approved_deposits,
           COUNT(*) FILTER (WHERE type = 'withdraw' AND status = 'approved') AS approved_withdrawals,
           COUNT(*) FILTER (WHERE status = 'pending') AS pending_transactions
         FROM transactions`
      );

      const { total_users, total_balance, users_with_bank_details } = userStats.rows[0];
      const { approved_deposits, approved_withdrawals, pending_transactions } = txStats.rows[0];

      const dashboardText = `*📊 Admin Dashboard*\n\n` +
        `👥 *Users*\n` +
        `• Total Users: ${total_users}\n` +
        `• Users with Bank Details: ${users_with_bank_details}\n` +
        `• Total Balance: Rs. ${total_balance || 0}\n\n` +
        `💸 *Transactions*\n` +
        `• Approved Deposits: ${approved_deposits}\n` +
        `• Approved Withdrawals: ${approved_withdrawals}\n` +
        `• Pending Transactions: ${pending_transactions}`;

      bot.sendMessage(ADMIN_ID, dashboardText, { parse_mode: 'Markdown' });
    } catch (error) {
      bot.sendMessage(ADMIN_ID, '⚠️ Error generating dashboard.');
      console.error('Dashboard error:', error);
    }
  });

  bot.onText(/\/fullreport/, async (msg) => {
    if (!isMainAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '🚫 Main admin only command.');

    try {
      const approvedStats = await pool.query(
        `SELECT
           type,
           COUNT(*)::int AS count,
           COALESCE(SUM(amount), 0)::numeric AS total_amount
         FROM transactions
         WHERE status = 'approved'
         GROUP BY type`
      );

      const approvedDetails = await pool.query(
        `SELECT t.id, t.user_id, u.username, u.balance, u.location, t.type, t.amount, t.platform, t.reason,
                to_char(t.created_at, 'YYYY-MM-DD HH24:MI') AS date
         FROM transactions t
         JOIN users u ON u.id = t.user_id
         WHERE t.status = 'approved'
         ORDER BY t.created_at DESC`
      );

      const nonApprovedDetails = await pool.query(
        `SELECT t.id, t.user_id, u.username, u.balance, u.location, t.type, t.amount, t.status, t.platform, t.reason,
                to_char(t.created_at, 'YYYY-MM-DD HH24:MI') AS date
         FROM transactions t
         JOIN users u ON u.id = t.user_id
         WHERE t.status IN ('pending', 'rejected')
         ORDER BY t.created_at DESC`
      );

      const promoDetails = await pool.query(
        `SELECT t.id, t.user_id, u.username, u.balance, u.location, t.amount, t.status, t.platform, t.reason,
                to_char(t.created_at, 'YYYY-MM-DD HH24:MI') AS date
         FROM transactions t
         JOIN users u ON u.id = t.user_id
         WHERE t.reason ILIKE 'PromoCode request%'
         ORDER BY t.created_at DESC`
      );

      const approvedMap = { deposit: { count: 0, total: 0 }, withdraw: { count: 0, total: 0 } };
      for (const row of approvedStats.rows) {
        approvedMap[row.type] = {
          count: Number(row.count) || 0,
          total: Number(row.total_amount) || 0
        };
      }

      let report = '📊 FULL ADMIN REPORT\n';
      report += '======================\n\n';
      report += '✅ APPROVED SUMMARY\n';
      report += `• Deposits: ${approvedMap.deposit.count} | Total: Rs. ${approvedMap.deposit.total}\n`;
      report += `• Withdrawals: ${approvedMap.withdraw.count} | Total: Rs. ${approvedMap.withdraw.total}\n`;
      report += `• All Approved Tx: ${approvedDetails.rows.length}\n\n`;

      report += '🎁 PROMOCODE CUSTOMERS (ALL STATUSES)\n';
      if (!promoDetails.rows.length) {
        report += '• No promo-code based customers found.\n\n';
      } else {
        for (const tx of promoDetails.rows) {
          report += `• Tx#${tx.id} | ${tx.status.toUpperCase()} | ${tx.platform || 'N/A'} | Rs. ${tx.amount || 0}\n`;
          report += `  User: @${tx.username || 'unknown'} (ID: ${tx.user_id}) | Balance: Rs. ${tx.balance || 0}\n`;
          if (tx.location) report += `  📍 Location: ${tx.location}\n`;
          if (tx.reason) report += `  Note: ${tx.reason}\n`;
          report += `  Date: ${tx.date}\n\n`;
        }
      }

      report += '✅ APPROVED TRANSACTION DETAILS\n';
      if (!approvedDetails.rows.length) {
        report += '• No approved transactions found.\n\n';
      } else {
        for (const tx of approvedDetails.rows) {
          report += `• Tx#${tx.id} | ${tx.type.toUpperCase()} | Rs. ${tx.amount || 0} | ${tx.platform || 'N/A'}\n`;
          report += `  User: @${tx.username || 'unknown'} (ID: ${tx.user_id}) | Balance: Rs. ${tx.balance || 0}\n`;
          if (tx.location) report += `  📍 Location: ${tx.location}\n`;
          if (tx.reason) report += `  Note: ${tx.reason}\n`;
          report += `  Date: ${tx.date}\n\n`;
        }
      }

      report += '🟡🔴 NON-APPROVED DETAILS (PENDING + REJECTED)\n';
      if (!nonApprovedDetails.rows.length) {
        report += '• No pending/rejected transactions found.\n';
      } else {
        for (const tx of nonApprovedDetails.rows) {
          report += `• Tx#${tx.id} | ${tx.status.toUpperCase()} | ${tx.type.toUpperCase()} | Rs. ${tx.amount || 0} | ${tx.platform || 'N/A'}\n`;
          report += `  User: @${tx.username || 'unknown'} (ID: ${tx.user_id}) | Balance: Rs. ${tx.balance || 0}\n`;
          if (tx.location) report += `  📍 Location: ${tx.location}\n`;
          if (tx.reason) report += `  Note: ${tx.reason}\n`;
          report += `  Date: ${tx.date}\n\n`;
        }
      }

      await sendLargeMessage(ADMIN_ID, report);
    } catch (error) {
      bot.sendMessage(ADMIN_ID, '⚠️ Error generating full report.');
      console.error('Full report error:', error);
    }
  });

  bot.onText(/\/transactions/, async (msg) => {
    await ensureUser(msg);
    const userId = msg.from.id;

    try {
      const res = await pool.query(
        `SELECT t.id, t.user_id, u.username, t.type, t.amount, t.status, t.reason, t.platform,
                to_char(t.created_at, 'YYYY-MM-DD HH24:MI') AS date,
                u.bank_name, u.account_number
         FROM transactions t
         JOIN users u ON t.user_id = u.id
         WHERE t.user_id = $1
         ORDER BY t.created_at DESC
         LIMIT 10`,
        [userId]
      );

      bot.sendMessage(msg.chat.id, formatTransactions(res.rows), { parse_mode: 'Markdown' });
    } catch (error) {
      bot.sendMessage(msg.chat.id, '⚠️ Error fetching transactions.');
      console.error('User transactions error:', error);
    }
  });

  console.log('🤖 PayMe Telegram Bot is up and running!');
};
