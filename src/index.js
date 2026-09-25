const path = require('path');
const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const log = require('./errors');
const {
  startWhatsApp,
  getStatusPayload,
  resetConnection,
  startPairingWithNumber,
  switchToQrMode,
  sendManualMessage,
  backupSessionToSheet,
} = require('./whatsapp');
const { startFollowupScheduler, runFollowups, runReviewRequests, runReviewReminders } = require('./followups');
const sheets = require('./sheets');
const store = require('./store');

// Records anything that escaped a try/catch and keeps the process alive - a
// crash here would also drop the live WhatsApp connection.
log.installProcessHandlers();

const COOKIE_NAME = 'ksc_auth';
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
  log.logInfo('startup', `Starting the bot for ${config.business.name}...`);

  await store.restoreFromSheetIfNeeded();
  await startWhatsApp();
  startFollowupScheduler();

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  app.get('/', (req, res) => res.redirect('/dashboard'));

  // Keep this public and cheap - it's what an uptime pinger (UptimeRobot etc.)
  // hits every few minutes to stop Render's free tier spinning the app down.
  app.get('/health', (req, res) => {
    const status = getStatusPayload();
    res.json({
      ok: true,
      business: config.business.name,
      whatsapp: status.whatsapp,
      connected: status.connected,
      time: new Date().toISOString(),
    });
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

  /* ------------------------- Leads / chats / settings ------------------------- */

  app.get('/api/leads', requireDashboardAuth, (req, res) => {
    res.json(store.getAllLeads());
  });

  app.get('/api/settings', requireDashboardAuth, (req, res) => {
    res.json(store.getSettings());
  });

  app.post('/api/settings', requireDashboardAuth, async (req, res) => {
    try {
      const updated = await store.updateSettingsAwaitSync(req.body);
      res.json(updated);
    } catch (err) {
      log.logError('dashboard', err, 'Saving settings failed');
      res.status(500).json({ error: err.message });
    }
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
      log.logError('dashboard', err, `Manual message to ${req.params.phone} failed`);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/run-now', requireDashboardAuth, async (req, res) => {
    try {
      await runFollowups();
      await runReviewRequests();
      await runReviewReminders();
      res.json({ ok: true });
    } catch (err) {
      log.logError('dashboard', err, 'Manual "run now" failed');
      res.status(500).json({ error: err.message });
    }
  });

  /* ------------------------- WhatsApp connection ------------------------- */

  app.get('/api/status', requireDashboardAuth, (req, res) => {
    res.json({ ...getStatusPayload(), sheetsQueue: sheets.getStatus(), errorCounts: log.getCounts() });
  });

  // Full relink: clears the session locally and in the Sheet, comes back on QR.
  app.post('/api/whatsapp/relink', requireDashboardAuth, async (req, res) => {
    try {
      await resetConnection();
      res.json({ ok: true });
    } catch (err) {
      log.logError('dashboard', err, 'Relink failed');
      res.status(500).json({ error: err.message });
    }
  });

  // Phone-number pairing code, as an alternative to scanning a QR.
  app.post('/api/whatsapp/pairing-code', requireDashboardAuth, async (req, res) => {
    try {
      const code = await startPairingWithNumber(req.body.number);
      res.json({ ok: true, code });
    } catch (err) {
      log.logError('dashboard', err, 'Requesting a pairing code failed');
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/whatsapp/use-qr', requireDashboardAuth, async (req, res) => {
    try {
      await switchToQrMode();
      res.json({ ok: true });
    } catch (err) {
      log.logError('dashboard', err, 'Switching to QR mode failed');
      res.status(500).json({ error: err.message });
    }
  });

  // Manual "back up the session now" - handy right after a fresh pairing.
  app.post('/api/whatsapp/backup-session', requireDashboardAuth, async (req, res) => {
    try {
      const ok = await backupSessionToSheet('manual backup from the dashboard');
      res.json({ ok, ...getStatusPayload().session });
    } catch (err) {
      log.logError('dashboard', err, 'Manual session backup failed');
      res.status(500).json({ error: err.message });
    }
  });

  // Proves the backup actually exists in the Sheet.
  app.get('/api/whatsapp/session-info', requireDashboardAuth, async (req, res) => {
    try {
      res.json(await sheets.getSessionInfo());
    } catch (err) {
      log.logError('dashboard', err, 'Reading session info from the Sheet failed');
      res.status(500).json({ error: err.message });
    }
  });

  /* ------------------------- Error log ------------------------- */

  app.get('/api/errors', requireDashboardAuth, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 300);
    const level = req.query.level || null;
    res.json({ counts: log.getCounts(), entries: log.getEntries(limit, level) });
  });

  app.post('/api/errors/clear', requireDashboardAuth, (req, res) => {
    res.json(log.clear());
  });

  /* ------------------------- Express error handler ------------------------- */

  app.use((err, req, res, next) => {
    log.logError('dashboard', err, `Unhandled error on ${req.method} ${req.path}`);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: err.message });
  });

  app.listen(config.port, () => {
    log.logInfo('startup', `Server listening on port ${config.port}.`);
  });
}

main().catch((err) => {
  log.logError('startup', err, 'Fatal startup error');
  process.exit(1);
});
