require('dotenv').config();

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const config = {
  openai: {
    apiKey: required('OPENAI_API_KEY'),
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  },

  sheets: {
    webAppUrl: required('SHEETS_WEBAPP_URL'),
    secret: required('SHEETS_WEBAPP_SECRET'),
  },

  dashboard: {
    password: process.env.DASHBOARD_PASSWORD || 'dash123',
  },

  business: {
    name: process.env.BUSINESS_NAME || 'KSC Carpets',
    googleReviewLink: process.env.BUSINESS_GOOGLE_REVIEW_LINK || '',
    website: process.env.BUSINESS_WEBSITE || '',
  },

  // Where the WhatsApp session (login) is stored. On Render, point this at
  // the persistent disk (e.g. /var/data/auth_info) so a redeploy doesn't
  // force a fresh QR scan every time.
  authDir: process.env.AUTH_DIR || 'auth_info',

  port: Number(process.env.PORT || 3000),
};

module.exports = config;
