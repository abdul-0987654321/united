const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@itsliaaa/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const { getAIResponse } = require('./ai');
const store = require('./store');
const config = require('./config');
const sheets = require('./sheets');

const logger = pino({ level: 'warn' });
const SESSION_CHUNK_SIZE = 40000; // stay comfortably under a Sheet cell's ~50k char limit

/** Bundles every file in the auth folder into one JSON string, split into chunks. */
function readAuthFolderAsChunks() {
  const dir = config.authDir;
  if (!fs.existsSync(dir)) return [];
  const bundle = {};
  for (const file of fs.readdirSync(dir)) {
    bundle[file] = fs.readFileSync(path.join(dir, file), 'utf8');
  }
  const json = JSON.stringify(bundle);
  const chunks = [];
  for (let i = 0; i < json.length; i += SESSION_CHUNK_SIZE) {
    chunks.push(json.slice(i, i + SESSION_CHUNK_SIZE));
  }
  return chunks;
}

/** Backs up the current session to the Google Sheet - best-effort, never blocks anything. */
async function backupSessionToSheet() {
  try {
    const chunks = readAuthFolderAsChunks();
    if (!chunks.length) return;
    await sheets.saveSessionChunks(chunks);
    console.log('WhatsApp session backed up to Google Sheet.');
  } catch (err) {
    console.error('Session backup failed (non-fatal, will retry next connect):', err.message);
  }
}

/** Restores a session from the Sheet backup if there's no local session yet - e.g. after a redeploy wiped the filesystem. */
async function restoreSessionFromSheetIfNeeded() {
  const dir = config.authDir;
  const hasLocalSession = fs.existsSync(path.join(dir, 'creds.json'));
  if (hasLocalSession) return;

  try {
    const chunks = await sheets.loadSessionChunks();
    if (!chunks.length) return; // nothing backed up yet - a fresh QR scan is expected
    const bundle = JSON.parse(chunks.join(''));
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, content] of Object.entries(bundle)) {
      fs.writeFileSync(path.join(dir, file), content);
    }
    console.log('WhatsApp session restored from Google Sheet backup - no QR scan needed.');
  } catch (err) {
    console.error('Session restore failed, a fresh QR scan will be needed:', err.message);
  }
}

// In-memory conversation history, keyed by phone. Resets on restart -
// fine for an MVP; store.js (local JSON) is the source of truth for lead status.
const conversations = new Map();
const MAX_HISTORY_TURNS = 10;

let sock = null;
let connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'
let latestQrDataUrl = null;
let reconnectAttempts = 0;

function jidToPhone(jid) {
  return jid.split('@')[0];
}

function pushHistory(phone, role, content) {
  const history = conversations.get(phone) || [];
  history.push({ role, content });
  while (history.length > MAX_HISTORY_TURNS) history.shift();
  conversations.set(phone, history);
  return history;
}

function statusFromIntent(intent, currentStatus) {
  if (intent === 'not_interested') return 'not_interested';
  if (intent === 'interested') return 'interested';
  return currentStatus || 'new';
}

async function handleIncomingMessage(msg) {
  if (msg.key.fromMe) return;
  if (!msg.message) {
    console.log(`[WhatsApp] Received a message with no decryptable content from ${msg.key.remoteJid} - likely a failed decrypt or a non-content event (reaction, receipt, etc).`);
    return;
  }
  const jid = msg.key.remoteJid;
  const isDirectMessage = jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
  if (!isDirectMessage) return; // ignore groups, channels/newsletters, broadcasts, status

  const phone = jidToPhone(jid);

  // Disappearing messages / view-once wrap the real content one level deeper.
  const unwrapped =
    msg.message.ephemeralMessage?.message ||
    msg.message.viewOnceMessage?.message ||
    msg.message.viewOnceMessageV2?.message ||
    msg.message.viewOnceMessageV2Extension?.message ||
    msg.message;

  const text =
    unwrapped.conversation ||
    unwrapped.extendedTextMessage?.text ||
    unwrapped.buttonsResponseMessage?.selectedDisplayText ||
    unwrapped.listResponseMessage?.title ||
    unwrapped.imageMessage?.caption ||
    unwrapped.videoMessage?.caption ||
    '';

  if (!text) {
    console.log(`[WhatsApp] No extractable text from ${phone}. Message type(s): ${Object.keys(unwrapped).join(', ')}`);
    return;
  }

  const pushName = msg.pushName || '';
  console.log(`[WhatsApp] Message from ${phone} (${pushName}): ${text}`);

  // Instant local read/write - no network call, so this never delays a reply.
  store.logMessage(phone, 'user', text);
  const settings = store.getSettings();
  const lead = store.getLead(phone);

  if (settings.botEnabled === false) {
    console.log(`[WhatsApp] Bot is paused from the dashboard - not replying to ${phone}.`);
    return;
  }

  if (lead?.humanTakeover === true) {
    console.log(`[WhatsApp] Human has taken over ${phone} - AI staying quiet.`);
    return;
  }

  // Mark as read (blue tick) and show "typing" - fire-and-forget, since these
  // are cosmetic touches that hit WhatsApp's own servers and must never be
  // allowed to delay the actual reply if that connection is slow.
  sock.readMessages([msg.key]).catch((err) => console.error('Read receipt failed (non-fatal):', err));
  sock.sendPresenceUpdate('composing', jid).catch((err) => console.error('Presence update failed (non-fatal):', err));

  const history = pushHistory(phone, 'user', text);

  const availableSlots = store.getAvailableSlots();
  const ai = await getAIResponse(history, availableSlots);
  pushHistory(phone, 'assistant', ai.reply);

  await sendBotReply(jid, ai);
  store.logMessage(phone, 'assistant', ai.reply);

  store.upsertLead(phone, {
    jid, // remember the real address - may be @lid, not always @s.whatsapp.net
    name: ai.name || lead?.name || pushName,
    status: ai.bookingSlot ? 'booked' : statusFromIntent(ai.intent, lead?.status),
    carpetType: ai.carpetType || lead?.carpetType || '',
    room: ai.room || lead?.room || '',
    budget: ai.budget || lead?.budget || '',
    bookingSlot: ai.bookingSlot || lead?.bookingSlot || '',
    source: lead?.source || 'whatsapp',
    lastContacted: new Date().toISOString(),
    followupCount: 0, // they just replied, so the follow-up clock resets
  });
}

/**
 * Sends the AI's reply as tappable buttons (2-3 options) or a list (4-10 options)
 * when options are given, otherwise plain text. Falls back to plain text if the
 * interactive message fails to send - WhatsApp's rendering of buttons/lists on
 * non-Business numbers is not fully guaranteed, so this must never block the reply.
 */
async function sendBotReply(jid, ai) {
  const options = (ai.options || []).filter(Boolean).slice(0, 10);

  try {
    if (options.length >= 4) {
      await sock.sendMessage(jid, {
        text: ai.reply,
        footer: 'KSC Carpets',
        buttonText: 'Choose an option',
        sections: [{
          title: 'Options',
          rows: options.map((opt, i) => ({ title: opt, rowId: `opt_${i}` })),
        }],
      });
    } else if (options.length >= 2) {
      await sock.sendMessage(jid, {
        text: ai.reply,
        footer: 'KSC Carpets',
        buttons: options.map((opt, i) => ({
          buttonId: `opt_${i}`,
          buttonText: { displayText: opt },
          type: 1,
        })),
        headerType: 1,
      });
    } else {
      await sock.sendMessage(jid, { text: ai.reply });
    }
  } catch (err) {
    console.error('Interactive message failed, sending plain text instead:', err);
    await sock.sendMessage(jid, { text: ai.reply });
  }
}

async function startWhatsApp() {
  if (sock) {
    try { sock.ev.removeAllListeners(); } catch (err) { /* best-effort cleanup */ }
  }

  await restoreSessionFromSheetIfNeeded();
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch (err) {
    console.error('Could not fetch latest Baileys version, using a pinned fallback:', err.message);
    version = [2, 3000, 1015901307];
  }

  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    browser: ['KSC Carpets Bot', 'Chrome', '120.0.0'],
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionStatus = 'connecting';
      const qrText = await QRCode.toString(qr, { type: 'terminal', small: true });
      console.log(qrText);
      console.log('Scan the QR code above with the KSC Carpets WhatsApp number.');
      latestQrDataUrl = await QRCode.toDataURL(qr);
    }

    if (connection === 'close') {
      connectionStatus = 'disconnected';
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      const reason = lastDisconnect?.error?.message || 'unknown';
      if (shouldReconnect) {
        reconnectAttempts += 1;
        const backoffMs = Math.min(60000, 3000 * reconnectAttempts);
        console.log(`Connection closed (${reason}). Reconnecting in ${backoffMs / 1000}s (attempt ${reconnectAttempts})...`);
        setTimeout(() => startWhatsApp(), backoffMs);
      } else {
        console.log(`Connection closed (${reason}). Logged out - scan a new QR code to relink.`);
      }
    } else if (connection === 'open') {
      connectionStatus = 'connected';
      latestQrDataUrl = null;
      reconnectAttempts = 0;
      console.log('WhatsApp connected.');
      backupSessionToSheet(); // fire-and-forget - no disk needed to survive a redeploy
    }
  });

  sock.ev.on('messages.upsert', async (upsert) => {
    console.log(`[WhatsApp] messages.upsert received: type=${upsert.type}, count=${upsert.messages?.length || 0}`);
    if (upsert.type !== 'notify') return; // ignore history-sync style upserts, only handle live new messages

    for (const msg of upsert.messages || []) {
      const rawJid = msg.key?.remoteJid || '(no jid)';
      console.log(`[WhatsApp] Raw message jid: ${rawJid}, fromMe: ${msg.key?.fromMe}`);
      try {
        await handleIncomingMessage(msg);
      } catch (err) {
        console.error('Error handling message:', err);
      }
    }
  });

  return sock;
}

/** Used by followups.js to send a nudge without going through the AI. */
async function sendWhatsAppMessage(phone, text) {
  if (!sock) throw new Error('WhatsApp socket not ready yet');
  const lead = store.getLead(phone);
  const jid = lead?.jid || `${phone}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text });
  pushHistory(phone, 'assistant', text);
}

/** Used by the dashboard when a human takes over and types a manual reply. */
async function sendManualMessage(phone, text) {
  if (!sock) throw new Error('WhatsApp socket not ready yet');
  const lead = store.getLead(phone);
  const jid = lead?.jid || `${phone}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text });
  pushHistory(phone, 'assistant', text);
  store.logMessage(phone, 'human', text);
}

function getConnectionStatus() {
  return connectionStatus;
}

function getLatestQr() {
  return latestQrDataUrl;
}

/** Logs out and clears the saved session so a fresh QR is generated - used to relink a different number from the dashboard. */
async function resetConnection() {
  try {
    if (sock) await sock.logout();
  } catch (err) {
    console.error('Logout error (continuing anyway):', err);
  }
  fs.rmSync(config.authDir, { recursive: true, force: true });
  await sheets.clearSessionRemote(); // don't let a stale session get restored next startup
  connectionStatus = 'disconnected';
  latestQrDataUrl = null;
  reconnectAttempts = 0;
  return startWhatsApp();
}

module.exports = {
  startWhatsApp,
  sendWhatsAppMessage,
  sendManualMessage,
  getConnectionStatus,
  getLatestQr,
  resetConnection,
};
