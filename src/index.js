const path = require('path');
const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const { startWhatsApp, getConnectionStatus, getLatestQr, resetConnection, sendManualMessage } = require('./whatsapp');
const { startFollowupScheduler, runFollowups, runReviewRequests, runReviewReminders } = require('./followups');
const store = require('./store');

// A single unhandled error anywhere in the app must never be allowed to
// silently kill the whole process - that would also drop the live WhatsApp
// connection and force a full reconnect/re-pair for no good reason.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection (process kept alive):', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (process kept alive):', err);
});

const COOKIE_NAME = 'ksc_auth';
// Derived from the password itself - no separate session store needed, and
// changing DASHBOARD_PASSWORD automatically invalidates any old cookie.
const AUTH_TOKEN = crypto.createHash('sha256').update(config.dashboard.password).digest('hex');

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  header.split(';').forEach((pair) => {
    const [key, ...rest] = pair.trim().split('=');
    if (key) cookies[key] = decodeURIComponent(rest.join('='));
  });
  return cookies;
}

function requireDashboardAuth(req, res, next) {
  const cookies = parseCookies(req);
  if (cookies[COOKIE_NAME] === AUTH_TOKEN) return next();

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  return res.redirect('/login');
}

async function main() {
  console.log(`Starting bot for ${config.business.name}...`);

  await store.restoreFromSheetIfNeeded();

  await startWhatsApp();
  startFollowupScheduler();

  // Render (and most hosts) require an open HTTP port to keep the service alive.
  // This also gives you a place to hang the real dashboard later.
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  app.get('/', (req, res) => {
    res.redirect('/dashboard');
  });

  app.get('/health', (req, res) => {
    res.json({ ok: true, business: config.business.name });
  });

  app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
  });

  app.post('/login', (req, res) => {
    if (req.body.password === config.dashboard.password) {
      res.cookie(COOKIE_NAME, AUTH_TOKEN, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 });
      return res.redirect('/dashboard');
    }
    return res.redirect('/login?error=1');
  });

  app.get('/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Max-Age=0; Path=/`);
    res.redirect('/login');
  });

  app.get('/dashboard', requireDashboardAuth, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
  });

  // Everything below reads/writes the local store (instant) - the Google
  // Sheet is a background mirror only and never sits on these paths.

  app.get('/api/leads', requireDashboardAuth, (req, res) => {
    res.json(store.getAllLeads());
  });

  app.get('/api/status', requireDashboardAuth, (req, res) => {
    res.json({ whatsapp: getConnectionStatus(), qr: getLatestQr() });
  });

  app.post('/api/whatsapp/relink', requireDashboardAuth, async (req, res) => {
    try {
      await resetConnection();
      res.json({ ok: true });
    } catch (err) {
      console.error('Relink failed:', err);
      res.status(500).json({ error: 'Relink failed' });
    }
  });

  app.get('/api/settings', requireDashboardAuth, (req, res) => {
    res.json(store.getSettings());
  });

  app.post('/api/settings', requireDashboardAuth, (req, res) => {
    res.json(store.updateSettings(req.body));
  });

  app.post('/api/leads/:phone/status', requireDashboardAuth, (req, res) => {
    res.json(store.upsertLead(req.params.phone, { status: req.body.status }));
  });

  app.delete('/api/leads/:phone', requireDashboardAuth, (req, res) => {
    store.deleteLead(req.params.phone);
    res.json({ ok: true });
  });

  app.get('/api/chats', requireDashboardAuth, (req, res) => {
    res.json(store.getChats());
  });

  app.get('/api/chats/:phone/messages', requireDashboardAuth, (req, res) => {
    res.json(store.getMessages(req.params.phone));
  });

  app.post('/api/chats/:phone/takeover', requireDashboardAuth, (req, res) => {
    res.json(store.setTakeover(req.params.phone, req.body.humanTakeover));
  });

  app.post('/api/chats/:phone/send', requireDashboardAuth, async (req, res) => {
    try {
      await sendManualMessage(req.params.phone, req.body.text);
      res.json({ ok: true });
    } catch (err) {
      console.error('Failed to send manual message:', err);
      res.status(500).json({ error: 'Failed to send message' });
    }
  });

  app.post('/api/run-now', requireDashboardAuth, async (req, res) => {
    try {
      await runFollowups();
      await runReviewRequests();
      await runReviewReminders();
      res.json({ ok: true });
    } catch (err) {
      console.error('Manual run-now failed:', err);
      res.status(500).json({ error: 'Run failed' });
    }
  });

  app.listen(config.port, () => {
    console.log(`Server listening on port ${config.port}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
