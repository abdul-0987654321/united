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

function syncMessage(phone, entry) {
  enqueue('logMessage', { phone, role: entry.role, text: entry.text });
}

function syncSettings(settings) {
  enqueue('updateSettings', { fields: settings });
}

function getStatus() {
  return { ...state };
}

module.exports = { syncLead, syncMessage, syncSettings, getStatus };