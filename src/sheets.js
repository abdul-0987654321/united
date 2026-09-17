'use strict';
/**
 * sheets.js - background sync to the Google Sheet ONLY.
 *
 * This file is never awaited by the bot's reply path or the dashboard's
 * page loads - store.js is the source of truth for that (local JSON,
 * instant). This file just best-effort mirrors every write to the Sheet
 * in the background, with its own retry queue, so a slow or unreachable
 * Sheet never slows down or breaks the bot itself.
 */

const fetch = require('node-fetch');
const https = require('https');
const config = require('./config');

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
    const json = await res.json();
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
          console.error(`[sheets] giving up on "${job.action}" after ${job.attempt} attempts: ${err.message}`);
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

/* ---------------- Critical writes - directly awaited, not queued ----------------
 * Render's free tier wipes local disk on every restart (redeploy, or
 * free-tier sleep/wake) and restores from this Sheet if local data is
 * empty. For MOST writes that's fine (fire-and-forget above, so a slow
 * Sheet never delays a WhatsApp reply) - a redeploy happening a second
 * before the background queue flushes just means the customer's carpet
 * type etc. gets re-asked once, harmless.
 *
 * But a few flags are anti-spam gates: if a restart's Sheet-restore rolls
 * one of these back to a stale value, the customer gets a DUPLICATE
 * follow-up or review message. Those specific writes are awaited directly
 * (bypassing the retry queue/backoff) so the caller knows the Sheet is
 * updated (or knows it failed) before moving on. Best-effort still - if
 * the Sheet call itself fails, we log and continue rather than throwing,
 * since local data (source of truth for a live, non-restarted process)
 * is already correct either way. */

async function syncSettingsAwait(settings) {
  try {
    await callScript('updateSettings', { fields: settings }, 15000);
    return true;
  } catch (err) {
    console.error('[sheets] awaited settings sync failed (non-fatal, will retry in background):', err.message);
    enqueue('updateSettings', { fields: settings }); // fall back to the retry queue
    return false;
  }
}

async function syncLeadAwait(lead) {
  try {
    await callScript('upsertLead', { phone: lead.phone, fields: lead }, 15000);
    return true;
  } catch (err) {
    console.error(`[sheets] awaited lead sync failed for ${lead.phone} (non-fatal, will retry in background):`, err.message);
    enqueue('upsertLead', { phone: lead.phone, fields: lead }); // fall back to the retry queue
    return false;
  }
}

/* ---------------- Session backup/restore - directly awaited, not queued ----------------
 * Restoring must finish before the bot starts, and backing up should be a
 * definite success/failure the caller can react to - so these bypass the
 * background queue and call the script directly. */

async function saveSessionChunks(chunks) {
  return callScript('saveSession', { chunks }, 40000);
}

async function loadSessionChunks() {
  const data = await callScript('loadSession', {}, 40000);
  return data?.chunks || [];
}

async function clearSessionRemote() {
  try {
    await callScript('clearSession', {}, 15000);
  } catch (err) {
    console.error('Clearing remote session backup failed (non-fatal):', err.message);
  }
}

/* ---------------- Full restore from Sheet - used once at startup if local data is missing ----------------
 * Same "directly awaited, not queued" reasoning as the session restore above:
 * this needs a definite success/failure before the app decides whether it
 * has data to serve. */

async function loadAllLeadsFromSheet() {
  return callScript('getAllLeads', {}, 30000);
}

async function loadAllMessagesFromSheet() {
  return callScript('getAllMessages', {}, 30000);
}

async function loadSettingsFromSheet() {
  return callScript('getSettings', {}, 20000);
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
  loadAllLeadsFromSheet,
  loadAllMessagesFromSheet,
  loadSettingsFromSheet,
};
