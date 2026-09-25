'use strict';
/**
 * sheets.js - background sync to the Google Sheet ONLY.
 *
 * This file is never awaited by the bot's reply path or the dashboard's
 * page loads - store.js is the source of truth for that (local JSON,
 * instant). This file just best-effort mirrors every write to the Sheet
 * in the background, with its own retry queue, so a slow or unreachable
 * Sheet never slows down or breaks the bot itself.
 *
 * The session backup/restore calls at the bottom are the exception: those
 * are awaited, because the WhatsApp login itself depends on them.
 */

const fetch = require('node-fetch');
const https = require('https');
const config = require('./config');
const log = require('./errors');

const { webAppUrl, secret } = config.sheets;

// Some Windows setups have a broken/blackholed IPv6 route that Node tries
// first and stalls on, even though the OS itself can reach the host fine
// over IPv4. Force IPv4 so background sync attempts fail fast instead of
// hanging.
const ipv4Agent = new https.Agent({ family: 4 });

const queue = [];
let workerRunning = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = { lastSyncAt: null, lastError: null, queued: 0 };

async function callScript(action, payload = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(webAppUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, action, payload }),
      agent: ipv4Agent,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Apps Script replied HTTP ${res.status} for "${action}"`);
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      // Usually means the Web App URL is wrong, the deployment is stale, or
      // Google returned an HTML sign-in page instead of JSON.
      throw new Error(`Apps Script did not return JSON for "${action}" - check SHEETS_WEBAPP_URL and that the deployment is "Anyone" access. First 120 chars: ${text.slice(0, 120)}`);
    }
    if (!json.ok) throw new Error(json.error || `Sheet action "${action}" failed`);
    return json.data;
  } finally {
    clearTimeout(timer);
  }
}

function enqueue(action, payload) {
  queue.push({ action, payload, attempt: 0 });
  state.queued = queue.length;
  void runWorker();
}

async function runWorker() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      state.queued = queue.length;
      try {
        await callScript(job.action, job.payload);
        state.lastSyncAt = new Date().toISOString();
        state.lastError = null;
      } catch (err) {
        job.attempt += 1;
        state.lastError = `${job.action}: ${err.message}`;
        if (job.attempt < 4) {
          queue.push(job);
          state.queued = queue.length;
          await sleep(2000 * job.attempt * job.attempt); // ~2s, 8s, 18s
        } else {
          log.logError('sheets', err, `Gave up on "${job.action}" after ${job.attempt} attempts`);
        }
      }
      await sleep(300); // be gentle on Apps Script's quota
    }
  } finally {
    workerRunning = false;
    state.queued = queue.length;
  }
}

/* ---------------- Public sync calls - all fire-and-forget ---------------- */

function syncLead(lead) {
  enqueue('upsertLead', { phone: lead.phone, fields: lead });
}

function syncDeleteLead(phone) {
  enqueue('deleteLead', { phone });
}

function syncMessage(phone, entry) {
  enqueue('logMessage', { phone, role: entry.role, text: entry.text });
}

function syncSettings(settings) {
  enqueue('updateSettings', { fields: settings });
}

function getStatus() {
  return { ...state };
}

/* ---------------- Critical writes - directly awaited, not queued ---------------- */

async function syncSettingsAwait(settings) {
  try {
    await callScript('updateSettings', { fields: settings }, 15000);
    return true;
  } catch (err) {
    log.logError('sheets', err, 'Awaited settings sync failed (non-fatal, falling back to the retry queue)');
    enqueue('updateSettings', { fields: settings });
    return false;
  }
}

async function syncLeadAwait(lead) {
  try {
    await callScript('upsertLead', { phone: lead.phone, fields: lead }, 15000);
    return true;
  } catch (err) {
    log.logError('sheets', err, `Awaited lead sync failed for ${lead.phone} (non-fatal, falling back to the retry queue)`);
    enqueue('upsertLead', { phone: lead.phone, fields: lead });
    return false;
  }
}

/* ---------------- Session backup/restore - directly awaited, not queued ----------------
 * Restoring must finish before the bot starts, and backing up must be a
 * definite success/failure the caller can react to - so these bypass the
 * background queue and call the script directly.
 *
 * saveSession now sends the whole payload in one go and the Apps Script side
 * writes it in a single setValues() call. The old version cleared the Session
 * tab first and then appended one row at a time, which timed out on big
 * payloads and left the tab EMPTY - the reason redeploys kept coming back to
 * a QR screen. */

async function saveSessionChunks(chunks, meta = {}) {
  return callScript('saveSession', { chunks, meta }, 60000);
}

async function loadSessionChunks() {
  const data = await callScript('loadSession', {}, 60000);
  return {
    chunks: (data && data.chunks) || [],
    meta: (data && data.meta) || null,
  };
}

async function clearSessionRemote() {
  await callScript('clearSession', {}, 20000);
}

/* ---------------- Full restore from Sheet - used once at startup if local data is missing ---------------- */

async function loadAllLeadsFromSheet() {
  return callScript('getAllLeads', {}, 30000);
}

async function loadAllMessagesFromSheet() {
  return callScript('getAllMessages', {}, 30000);
}

async function loadSettingsFromSheet() {
  return callScript('getSettings', {}, 20000);
}

/** Used by the dashboard to prove the backup is actually there. */
async function getSessionInfo() {
  return callScript('sessionInfo', {}, 20000);
}

module.exports = {
  syncLead,
  syncDeleteLead,
  syncMessage,
  syncSettings,
  syncSettingsAwait,
  syncLeadAwait,
  getStatus,
  saveSessionChunks,
  loadSessionChunks,
  clearSessionRemote,
  getSessionInfo,
  loadAllLeadsFromSheet,
  loadAllMessagesFromSheet,
  loadSettingsFromSheet,
};
