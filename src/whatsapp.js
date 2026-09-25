const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} = require('@itsliaaa/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { getAIResponse } = require('./ai');
const store = require('./store');
const config = require('./config');
const sheets = require('./sheets');
const log = require('./errors');

const logger = pino({ level: 'warn' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ============================================================================
 * SESSION BACKUP / RESTORE  (Google Sheet, because Render's disk is wiped)
 * ==========================================================================*/

const SESSION_CHUNK_SIZE = 40000; // a Sheet cell caps out around 50k chars
const SESSION_FORMAT = 'GZ1:';    // marker so we can still read old plain-JSON backups
const CHUNK_PREFIX = '#';         // keeps Sheets from treating "+abc" as a formula
const BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // safety re-backup every 6h

/**
 * Only these files are worth backing up.
 *
 * The old version bundled the ENTIRE auth folder - including every
 * session-*.json and sender-key-*.json, which is one file per contact the
 * number has ever messaged. That grew to megabytes, which became hundreds of
 * Sheet rows, and saveSession (which clears the sheet FIRST, then appends row
 * by row) timed out halfway through - leaving the Session tab empty. That is
 * exactly why a redeploy always came back to a QR screen.
 *
 * creds.json is the actual login. pre-keys and app-state-sync keys are small
 * and worth keeping. Per-contact session/sender keys re-establish themselves.
 */
function shouldBackupFile(file) {
  if (file === 'creds.json') return true;
  if (file.startsWith('app-state-sync-key-')) return true;
  if (file.startsWith('app-state-sync-version-')) return true;
  if (file.startsWith('pre-key-')) return true;
  return false;
}

/** Bundles the essential auth files into gzipped, chunked strings for the Sheet. */
function buildSessionChunks() {
  const dir = config.authDir;
  if (!fs.existsSync(dir)) return { chunks: [], files: 0, rawBytes: 0, packedBytes: 0 };

  const bundle = {};
  for (const file of fs.readdirSync(dir)) {
    if (!shouldBackupFile(file)) continue;
    try {
      bundle[file] = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch (err) {
      log.logWarn('session', `Could not read auth file ${file}: ${err.message}`);
    }
  }
  if (!bundle['creds.json']) return { chunks: [], files: 0, rawBytes: 0, packedBytes: 0 };

  const json = JSON.stringify(bundle);
  const packed = SESSION_FORMAT + zlib.gzipSync(Buffer.from(json, 'utf8')).toString('base64');

  const chunks = [];
  for (let i = 0; i < packed.length; i += SESSION_CHUNK_SIZE) {
    chunks.push(CHUNK_PREFIX + packed.slice(i, i + SESSION_CHUNK_SIZE));
  }
  return {
    chunks,
    files: Object.keys(bundle).length,
    rawBytes: Buffer.byteLength(json, 'utf8'),
    packedBytes: packed.length,
  };
}

/** Reverses buildSessionChunks. Still understands the old uncompressed format. */
function unpackSessionChunks(chunks) {
  const joined = chunks
    .map((c) => (typeof c === 'string' && c.startsWith(CHUNK_PREFIX) ? c.slice(1) : String(c)))
    .join('');
  if (joined.startsWith(SESSION_FORMAT)) {
    const base64 = joined.slice(SESSION_FORMAT.length);
    return JSON.parse(zlib.gunzipSync(Buffer.from(base64, 'base64')).toString('utf8'));
  }
  return JSON.parse(joined); // legacy backup written by the old code
}

let backupInFlight = false;
let lastBackupAt = null;
let lastBackupError = null;
let lastRestoreInfo = null;
let backupIntervalHandle = null;

async function backupSessionToSheet(reason = '') {
  if (backupInFlight) return false; // never let two backups race - that's what emptied the sheet
  backupInFlight = true;
  try {
    const credsPath = path.join(config.authDir, 'creds.json');
    if (!fs.existsSync(credsPath)) return false;

    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    // The "registered" flag isn't reliable on this fork, so we check for real
    // pairing data instead: a WhatsApp identity plus a signed account.
    if (!creds.me || !creds.me.id || !creds.account || !creds.account.accountSignatureKey) {
      log.logInfo('session', 'Not paired yet - skipping session backup for now.');
      return false;
    }

    const { chunks, files, rawBytes, packedBytes } = buildSessionChunks();
    if (!chunks.length) {
      log.logWarn('session', 'Nothing to back up - creds.json missing from the bundle.');
      return false;
    }

    await sheets.saveSessionChunks(chunks, {
      savedAt: new Date().toISOString(),
      me: creds.me.id,
      files,
      rawBytes,
      packedBytes,
      format: 'gzip+base64',
    });

    lastBackupAt = new Date().toISOString();
    lastBackupError = null;
    log.logInfo(
      'session',
      `Session backed up to the Sheet${reason ? ` (${reason})` : ''}: ${files} file(s), ${rawBytes} bytes raw -> ${packedBytes} packed, ${chunks.length} chunk(s).`
    );
    return true;
  } catch (err) {
    lastBackupError = err.message;
    log.logError('session', err, 'Session backup to the Google Sheet FAILED - a redeploy will ask for a new QR/pairing code');
    return false;
  } finally {
    backupInFlight = false;
  }
}

/** Restores the session from the Sheet when the local disk has none (i.e. after every Render restart). */
async function restoreSessionFromSheetIfNeeded() {
  const dir = config.authDir;
  if (fs.existsSync(path.join(dir, 'creds.json'))) {
    lastRestoreInfo = { source: 'local disk', at: new Date().toISOString() };
    log.logInfo('session', 'Local session found on disk - no restore needed.');
    return false;
  }

  log.logInfo('session', 'No local session - trying to restore from the Google Sheet backup...');
  try {
    const { chunks, meta } = await sheets.loadSessionChunks();
    if (!chunks.length) {
      lastRestoreInfo = { source: 'none', at: new Date().toISOString() };
      log.logWarn('session', 'No session backup in the Sheet - a QR scan or pairing code will be needed.');
      return false;
    }

    const bundle = unpackSessionChunks(chunks);
    if (!bundle || !bundle['creds.json']) {
      log.logWarn('session', 'Session backup in the Sheet is incomplete (no creds.json) - a fresh pairing will be needed.');
      return false;
    }

    fs.mkdirSync(dir, { recursive: true });
    for (const [file, content] of Object.entries(bundle)) {
      fs.writeFileSync(path.join(dir, file), content);
    }
    lastRestoreInfo = { source: 'google sheet', at: new Date().toISOString(), savedAt: meta && meta.savedAt ? meta.savedAt : null };
    log.logInfo(
      'session',
      `Session restored from the Sheet backup (backup saved ${meta && meta.savedAt ? meta.savedAt : 'at an unknown time'}) - no QR needed.`
    );
    return true;
  } catch (err) {
    log.logError('session', err, 'Session restore from the Sheet failed - a fresh QR/pairing code will be needed');
    return false;
  }
}

/** Wipes the session locally AND in the Sheet, so a dead session can't be restored on the next boot. */
async function wipeSession(reason) {
  try {
    fs.rmSync(config.authDir, { recursive: true, force: true });
  } catch (err) {
    log.logError('session', err, 'Could not delete the local auth folder');
  }
  try {
    await sheets.clearSessionRemote();
  } catch (err) {
    log.logError('session', err, 'Could not clear the Sheet session backup');
  }
  lastBackupAt = null;
  log.logWarn('session', `Session cleared - ${reason}. A new QR scan or pairing code is now required.`);
}

/* ============================================================================
 * CONNECTION STATE
 * ==========================================================================*/

const conversations = new Map(); // in-memory chat history, keyed by phone
const MAX_HISTORY_TURNS = 10;

let sock = null;
let connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'
let latestQrDataUrl = null;
let latestQrAt = null;
let latestPairingCode = null;
let latestPairingCodeAt = null;
let pendingPairingNumber = null;
let pairingRequestedForThisSocket = false;
let needsRelink = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let starting = false;
let lastDisconnectInfo = null;
let credsBackupTimer = null;

function isConnected() {
  return connectionStatus === 'connected' && Boolean(sock && sock.user && sock.user.id);
}

/**
 * WhatsApp rejects the pairing-code flow when the browser identifier is a
 * made-up name - that produces "Couldn't link device, check the phone number
 * or get a new code" on the phone, even when the number and code are right.
 * A standard identifier is required. QR linking doesn't care, so the custom
 * name is only used when we're not pairing by number.
 */
function browserSignature(usingPairingCode) {
  if (usingPairingCode) {
    if (Browsers && typeof Browsers.ubuntu === 'function') return Browsers.ubuntu('Chrome');
    return ['Ubuntu', 'Chrome', '110.0.5585.95'];
  }
  return ['KSC Carpets Bot', 'Chrome', '120.0.0'];
}

function disconnectReasonName(statusCode) {
  const match = Object.keys(DisconnectReason).find((key) => DisconnectReason[key] === statusCode);
  return match || 'unknown';
}

function scheduleReconnect(ms, reason) {
  if (reconnectTimer) return; // one pending reconnect at a time - never stack them
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startWhatsApp().catch((err) => log.logError('whatsapp', err, 'Reconnect attempt failed'));
  }, ms);
  log.logInfo('whatsapp', `Reconnecting in ${Math.round(ms / 1000)}s (attempt ${reconnectAttempts}) - reason: ${reason}`);
}

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

/* ============================================================================
 * LEAD STATUS + MESSAGE HANDLING  (unchanged behaviour)
 * ==========================================================================*/

function computeStatus({ intent, currentStatus, hasRequiredInfo }) {
  if (intent === 'not_interested') return 'not_interested';
  if (currentStatus === 'booked' || currentStatus === 'completed') return currentStatus;
  if (hasRequiredInfo) return 'booked';
  if (intent === 'interested') return 'interested';
  return currentStatus || 'new';
}

function buildReplyText(ai) {
  const options = (ai.options || []).filter(Boolean).slice(0, 10);
  if (!options.length) return ai.reply;
  const numbered = options.map((opt, i) => `${i + 1}. ${opt}`).join('\n');
  return `${ai.reply}\n\n${numbered}`;
}

async function handleIncomingMessage(msg) {
  if (msg.key.fromMe) return;
  if (!msg.message) return; // failed decrypt, reaction, receipt etc.

  const jid = msg.key.remoteJid;
  const isDirectMessage = jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
  if (!isDirectMessage) return; // ignore groups, channels, broadcasts, status

  const phone = jidToPhone(jid);

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

  if (!text) return;

  const pushName = msg.pushName || '';
  console.log(`[whatsapp] Message from ${phone} (${pushName}): ${text}`);

  store.logMessage(phone, 'user', text);
  const settings = store.getSettings();
  const lead = store.getLead(phone);

  if (settings.botEnabled === false) return;
  if (lead?.humanTakeover === true) return;

  sock.readMessages([msg.key]).catch(() => {});
  sock.sendPresenceUpdate('composing', jid).catch(() => {});

  const history = pushHistory(phone, 'user', text);

  const known = {
    name: lead?.name || '',
    carpetType: lead?.carpetType || '',
    room: lead?.room || '',
    size: lead?.size || '',
    colour: lead?.colour || '',
    budget: lead?.budget || '',
    preferredTime: lead?.preferredTime || '',
    customerAddress: lead?.customerAddress || '',
    postcode: lead?.postcode || '',
    contactNumber: lead?.contactNumber || '',
  };

  let ai;
  try {
    ai = await getAIResponse(history, known);
  } catch (err) {
    log.logError('ai', err, `OpenAI call failed for ${phone} - no reply was sent`);
    return;
  }

  const replyText = buildReplyText(ai);
  pushHistory(phone, 'assistant', replyText);

  await sock.sendPresenceUpdate('composing', jid).catch(() => {});
  await sleep(2000 + Math.floor(Math.random() * 3000));

  await sock.sendMessage(jid, { text: replyText });
  store.logMessage(phone, 'assistant', replyText);

  const carpetType = ai.carpetType || lead?.carpetType || '';
  const room = ai.room || lead?.room || '';
  const size = ai.size || lead?.size || '';
  const colour = ai.colour || lead?.colour || '';
  const budget = ai.budget || lead?.budget || '';
  const preferredTime = ai.preferredTime || lead?.preferredTime || '';
  const name = ai.name || lead?.name || pushName;
  const customerAddress = ai.customerAddress || lead?.customerAddress || '';
  const postcode = ai.postcode || lead?.postcode || '';
  const contactNumber = ai.contactNumber || lead?.contactNumber || '';
  const hasRequiredInfo = Boolean(name && room && (budget || preferredTime));
  const status = computeStatus({ intent: ai.intent, currentStatus: lead?.status, hasRequiredInfo });

  const updatedLead = store.upsertLead(phone, {
    jid,
    name,
    status,
    carpetType,
    room,
    size,
    colour,
    budget,
    preferredTime,
    customerAddress,
    postcode,
    contactNumber,
    source: lead?.source || 'whatsapp',
    lastContacted: new Date().toISOString(),
    followupCount: 0,
  });

  if (status === 'booked' && !updatedLead.bookedNotified) {
    notifyAdmin(updatedLead, 'booked');
    await store.upsertLeadAwaitSync(phone, { bookedNotified: true });
  }

  if (ai.wantsPriceCallback && !updatedLead.priceCallbackNotified) {
    notifyAdmin(updatedLead, 'price_callback');
    await store.upsertLeadAwaitSync(phone, { priceCallbackNotified: true });
  }
}

async function notifyAdmin(lead, reason = 'booked') {
  try {
    const settings = store.getSettings();
    const adminNumber = String(settings.adminNotificationNumber || '').replace(/\D/g, '');
    if (!adminNumber || !isConnected()) return;

    const headline = reason === 'price_callback'
      ? `Customer wants a PRICE CALL (declined a visit) - ${lead.name || 'Unknown name'} (${lead.phone})`
      : `Lead ready to book - ${lead.name || 'Unknown name'} (${lead.phone})`;

    const lines = [
      headline,
      lead.carpetType ? `Carpet: ${lead.carpetType}` : null,
      lead.room ? `Room: ${lead.room}` : null,
      lead.size ? `Size: ${lead.size}` : null,
      lead.colour ? `Colour: ${lead.colour}` : null,
      lead.budget ? `Budget: ${lead.budget}` : null,
      lead.customerAddress ? `Address: ${lead.customerAddress}` : null,
      lead.postcode ? `Postcode: ${lead.postcode}` : null,
      lead.contactNumber ? `Contact number given: ${lead.contactNumber}` : null,
      reason === 'price_callback'
        ? 'Call them with a price - they did not want a measure visit.'
        : `Wants to meet: ${lead.preferredTime || 'no time given yet - ask them'}`,
    ].filter(Boolean);

    await sock.sendMessage(`${adminNumber}@s.whatsapp.net`, { text: lines.join('\n') });
  } catch (err) {
    log.logError('whatsapp', err, 'Admin notification failed');
  }
}

/* ============================================================================
 * SOCKET LIFECYCLE
 * ==========================================================================*/

async function startWhatsApp() {
  if (starting) return sock;
  starting = true;

  try {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    // Tear the old socket down completely before building a new one, so two
    // sockets can never hold the same session at once (that produced the
    // "conflict: replaced" disconnects in the logs).
    if (sock) {
      try { sock.ev.removeAllListeners(); } catch (err) { /* best effort */ }
      try { sock.end(undefined); } catch (err) { /* best effort */ }
      sock = null;
    }

    await restoreSessionFromSheetIfNeeded();

    const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
    const alreadyPaired = Boolean(state.creds && state.creds.me && state.creds.me.id);
    needsRelink = !alreadyPaired;

    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch (err) {
      log.logWarn('whatsapp', `Could not fetch the latest Baileys version (${err.message}) - using the pinned fallback.`);
      version = [2, 3000, 1015901307];
    }

    const usingPairingCode = Boolean(!alreadyPaired && pendingPairingNumber);

    connectionStatus = 'connecting';
    sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      browser: browserSignature(usingPairingCode),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
    });

    pairingRequestedForThisSocket = false;
    if (usingPairingCode) {
      log.logInfo('whatsapp', `Pairing-code mode for +${pendingPairingNumber} (browser id: ${JSON.stringify(browserSignature(true))}).`);
    }

    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds();
      } catch (err) {
        log.logError('session', err, 'Saving creds to disk failed');
        return;
      }
      // creds.update fires in bursts during pairing - debounce so we push to
      // the Sheet once, after things settle.
      clearTimeout(credsBackupTimer);
      credsBackupTimer = setTimeout(() => {
        backupSessionToSheet('creds changed').catch(() => {});
      }, 5000);
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        connectionStatus = 'connecting';
        latestQrAt = new Date().toISOString();

        // The arrival of a QR is the reliable signal that the socket is up and
        // ready to accept a pairing-code request. Asking on a fixed timer (the
        // old behaviour) could fire before the socket was ready, which
        // produced a code the phone then refused.
        if (pendingPairingNumber && !pairingRequestedForThisSocket) {
          pairingRequestedForThisSocket = true;
          const numberForPairing = pendingPairingNumber;
          const socketForPairing = sock;
          try {
            if (typeof sock.requestPairingCode !== 'function') {
              throw new Error('This Baileys build does not expose requestPairingCode - use the QR code instead.');
            }
            const raw = await sock.requestPairingCode(numberForPairing);
            if (socketForPairing === sock) {
              const formatted = String(raw).replace(/[\s-]/g, '').match(/.{1,4}/g).join('-');
              latestPairingCode = formatted;
              latestPairingCodeAt = new Date().toISOString();
              log.logInfo('whatsapp', `Pairing code ready for +${numberForPairing}: ${formatted} (valid for a couple of minutes).`);
            }
          } catch (err) {
            latestPairingCode = null;
            log.logError('whatsapp', err, `Requesting a pairing code for +${numberForPairing} failed`);
          }
        }

        try {
          console.log(await QRCode.toString(qr, { type: 'terminal', small: true }));
          console.log('Scan the QR above with the KSC Carpets WhatsApp number (or use the pairing code on the dashboard).');
          latestQrDataUrl = await QRCode.toDataURL(qr);
        } catch (err) {
          log.logError('whatsapp', err, 'Could not render the QR code');
        }
      }

      if (connection === 'close') {
        connectionStatus = 'disconnected';
        const err = lastDisconnect && lastDisconnect.error;
        const statusCode = err && err.output ? err.output.statusCode : null;
        const reasonName = disconnectReasonName(statusCode);
        const message = err && err.message ? err.message : 'unknown';

        lastDisconnectInfo = { at: new Date().toISOString(), statusCode, reason: reasonName, message };
        log.logWarn('whatsapp', `Connection closed - code ${statusCode} (${reasonName}): ${message}`);

        // 401 / loggedOut / device_removed: the phone side killed this device.
        // The saved creds are dead, so keeping them would just loop forever.
        if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
          needsRelink = true;
          latestPairingCode = null;
          log.logWarn('whatsapp', 'WhatsApp logged this device out (someone removed it in Linked Devices, or WhatsApp removed it). Clearing the saved session and starting a fresh pairing.');
          await wipeSession('logged out by WhatsApp / the phone (401)');
          reconnectAttempts = 0;
          scheduleReconnect(5000, 'fresh pairing after logout');
          return;
        }

        // 500 / badSession: the stored keys are corrupt - same treatment.
        if (statusCode === DisconnectReason.badSession) {
          needsRelink = true;
          await wipeSession('the stored session was corrupt (bad session)');
          reconnectAttempts = 0;
          scheduleReconnect(5000, 'fresh pairing after a bad session');
          return;
        }

        // 440 / connectionReplaced: the same session is running somewhere else
        // (your local PC, or an overlapping Render deploy). Reconnecting fast
        // just makes the two fight, so back right off and shout about it.
        if (statusCode === DisconnectReason.connectionReplaced) {
          log.logWarn('whatsapp', 'Another copy of this bot took the session over. Make sure it is only running in ONE place (do not run it locally with the live number).');
          reconnectAttempts += 1;
          scheduleReconnect(120000, 'connection replaced by another instance');
          return;
        }

        reconnectAttempts += 1;
        if (reconnectAttempts % 10 === 0) {
          log.logWarn('whatsapp', `Still not connected after ${reconnectAttempts} attempts. If a QR/pairing code is showing on the dashboard, it needs to be scanned or entered on the phone.`);
        }
        const backoffMs = Math.min(60000, 5000 * reconnectAttempts);
        scheduleReconnect(backoffMs, reasonName);
        return;
      }

      if (connection === 'open') {
        connectionStatus = 'connected';
        latestQrDataUrl = null;
        latestQrAt = null;
        latestPairingCode = null;
        pendingPairingNumber = null;
        needsRelink = false;
        reconnectAttempts = 0;
        lastDisconnectInfo = null;
        log.logInfo('whatsapp', `WhatsApp connected as ${sock && sock.user ? sock.user.id : 'unknown'}.`);
        backupSessionToSheet('on connect').catch(() => {});
      }
    });

    sock.ev.on('messages.upsert', async (upsert) => {
      if (upsert.type !== 'notify') return;
      for (const msg of upsert.messages || []) {
        try {
          await handleIncomingMessage(msg);
        } catch (err) {
          log.logError('whatsapp', err, `Handling an incoming message from ${msg?.key?.remoteJid || 'unknown'} failed`);
        }
      }
    });

    // Safety net: re-back-up the session every few hours while connected, so a
    // sudden restart never falls back on a very old key set.
    if (!backupIntervalHandle) {
      backupIntervalHandle = setInterval(() => {
        if (isConnected()) backupSessionToSheet('periodic safety backup').catch(() => {});
      }, BACKUP_INTERVAL_MS);
    }

    return sock;
  } catch (err) {
    log.logError('whatsapp', err, 'Starting the WhatsApp socket failed');
    reconnectAttempts += 1;
    scheduleReconnect(Math.min(60000, 5000 * reconnectAttempts), 'startup failure');
    return null;
  } finally {
    starting = false;
  }
}

/* ============================================================================
 * SENDING
 * ==========================================================================*/

function assertConnected() {
  if (!isConnected()) {
    const detail = lastDisconnectInfo
      ? ` Last disconnect: code ${lastDisconnectInfo.statusCode} (${lastDisconnectInfo.reason}).`
      : '';
    throw new Error(`WhatsApp is not connected - the message was not sent.${detail}`);
  }
}

/** Used by followups.js to send a nudge without going through the AI. */
async function sendWhatsAppMessage(phone, text) {
  assertConnected();
  const lead = store.getLead(phone);
  const jid = lead?.jid || `${phone}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text });
  pushHistory(phone, 'assistant', text);
}

/** Used by the dashboard when a human takes over and types a manual reply. */
async function sendManualMessage(phone, text) {
  assertConnected();
  const lead = store.getLead(phone);
  const jid = lead?.jid || `${phone}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text });
  pushHistory(phone, 'assistant', text);
  store.logMessage(phone, 'human', text);
}

/* ============================================================================
 * STATUS + RELINK CONTROLS (used by the dashboard)
 * ==========================================================================*/

function getConnectionStatus() {
  return connectionStatus;
}

function getLatestQr() {
  return latestQrDataUrl;
}

function getPairingCode() {
  return latestPairingCode;
}

function getStatusPayload() {
  return {
    whatsapp: connectionStatus,
    connected: isConnected(),
    me: sock && sock.user ? sock.user.id : null,
    needsRelink,
    qr: latestQrDataUrl,
    qrAt: latestQrAt,
    pairingCode: latestPairingCode,
    pairingCodeAt: latestPairingCodeAt,
    pairingNumber: pendingPairingNumber,
    reconnectAttempts,
    lastDisconnect: lastDisconnectInfo,
    session: {
      lastBackupAt,
      lastBackupError,
      restoredFrom: lastRestoreInfo,
    },
  };
}

/** Full relink: clears the session everywhere and comes back on the QR flow. */
async function resetConnection() {
  try {
    if (sock && isConnected()) await sock.logout();
  } catch (err) {
    log.logWarn('whatsapp', `Logout call failed (continuing anyway): ${err.message}`);
  }
  pendingPairingNumber = null;
  latestPairingCode = null;
  latestQrDataUrl = null;
  connectionStatus = 'disconnected';
  reconnectAttempts = 0;
  needsRelink = true;
  await wipeSession('manual relink from the dashboard');
  return startWhatsApp();
}

/**
 * Phone-number pairing: WhatsApp shows an 8-character code that the client
 * types into their phone, instead of scanning a QR off a screenshot.
 * Phone: WhatsApp > Linked Devices > Link a device > "Link with phone number instead".
 */
async function startPairingWithNumber(rawNumber) {
  const number = String(rawNumber || '').replace(/\D/g, '');
  if (number.length < 8) {
    throw new Error('Enter the full WhatsApp number with country code and digits only, e.g. 447911123456.');
  }

  log.logInfo('whatsapp', `Starting phone-number pairing for +${number}.`);
  pendingPairingNumber = number;
  latestPairingCode = null;
  latestQrDataUrl = null;
  needsRelink = true;

  try {
    if (sock && isConnected()) await sock.logout();
  } catch (err) {
    log.logWarn('whatsapp', `Logout before pairing failed (continuing anyway): ${err.message}`);
  }

  await wipeSession('starting phone-number pairing');
  await startWhatsApp();

  const deadline = Date.now() + 25000;
  while (!latestPairingCode && Date.now() < deadline) {
    await sleep(500);
  }
  if (!latestPairingCode) {
    throw new Error('WhatsApp did not return a pairing code in time. Try again, or scan the QR code instead.');
  }
  return latestPairingCode;
}

/** Drops pairing-code mode and goes back to showing a QR. */
async function switchToQrMode() {
  pendingPairingNumber = null;
  latestPairingCode = null;
  log.logInfo('whatsapp', 'Switched back to QR code mode.');
  return startWhatsApp();
}

module.exports = {
  startWhatsApp,
  sendWhatsAppMessage,
  sendManualMessage,
  getConnectionStatus,
  getLatestQr,
  getPairingCode,
  getStatusPayload,
  resetConnection,
  startPairingWithNumber,
  switchToQrMode,
  isConnected,
  backupSessionToSheet,
};
