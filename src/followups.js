const cron = require('node-cron');
const config = require('./config');
const store = require('./store');
const { sendWhatsAppMessage } = require('./whatsapp');

function followupText(template, name) {
  const fallback = "Hi {name}, just checking back about your free measure with KSC Carpets - would you like to go ahead? Reply STOP if you'd rather we didn't contact you again.";
  const text = template || fallback;
  return text.replace('{name}', name || 'there');
}

function reviewRequestText(name) {
  const { name: businessName, googleReviewLink } = config.business;
  const greeting = name ? `Hi ${name}, ` : 'Hi, ';
  return `${greeting}thanks for choosing ${businessName}! If you're happy with your new carpet, we'd really appreciate a quick Google review: ${googleReviewLink}`;
}

function reviewReminderText(template, name) {
  const { googleReviewLink } = config.business;
  const fallback = "Hi {name}, just a quick reminder - we'd really appreciate a Google review when you get a moment: {reviewLink}";
  const text = template || fallback;
  return text.replace('{name}', name || 'there').replace('{reviewLink}', googleReviewLink);
}

async function runFollowups() {
  const settings = store.getSettings();

  if (settings.followupEnabled === false) {
    console.log('Follow-ups are paused from the dashboard - skipping this run.');
    return;
  }

  const leads = store.getLeadsNeedingFollowup();

  for (const lead of leads) {
    try {
      await sendWhatsAppMessage(lead.phone, followupText(settings.followupMessage, lead.name));
      // Awaited sync: followupCount is an anti-spam gate - if a restart's
      // Sheet-restore rolled it back to a stale value, this customer would
      // get the same follow-up sent again.
      await store.upsertLeadAwaitSync(lead.phone, {
        lastContacted: new Date().toISOString(),
        followupCount: Number(lead.followupCount || 0) + 1,
      });
      console.log(`Follow-up sent to ${lead.phone}`);
    } catch (err) {
      console.error(`Follow-up failed for ${lead.phone}:`, err);
    }
  }
}

async function runReviewRequests() {
  const leads = store.getLeadsAwaitingReview();

  for (const lead of leads) {
    try {
      await sendWhatsAppMessage(lead.phone, reviewRequestText(lead.name));
      // Awaited sync: reviewSent is the anti-spam gate for this whole
      // function - a stale Sheet-restore of it is exactly what caused the
      // duplicate-review-request bug, so this one must actually land in
      // the Sheet before we move on.
      await store.upsertLeadAwaitSync(lead.phone, { reviewSent: true, reviewRequestedAt: new Date().toISOString(), reviewReminderCount: 0 });
      console.log(`Review request sent via WhatsApp to ${lead.phone}`);
    } catch (err) {
      console.error(`Review request failed for ${lead.phone}:`, err);
    }
  }
}

async function runReviewReminders() {
  const settings = store.getSettings();

  if (settings.reviewReminderEnabled === false) {
    return;
  }

  const leads = store.getLeadsNeedingReviewReminder();

  for (const lead of leads) {
    try {
      await sendWhatsAppMessage(lead.phone, reviewReminderText(settings.reviewReminderMessage, lead.name));
      await store.upsertLeadAwaitSync(lead.phone, {
        reviewRequestedAt: new Date().toISOString(),
        reviewReminderCount: Number(lead.reviewReminderCount || 0) + 1,
      });
      console.log(`Review reminder sent to ${lead.phone}`);
    } catch (err) {
      console.error(`Review reminder failed for ${lead.phone}:`, err);
    }
  }
}

function startFollowupScheduler() {
  // Every 15 minutes: check who needs a nudge, a review request, or a review
  // reminder. The delay/attempt limits themselves are enforced in the store
  // queries, so this just needs to run often enough that nobody waits too
  // long past their due time. Each one is caught individually - an error in
  // one must never crash the whole process (which would also kill the live
  // WhatsApp connection).
  cron.schedule('*/15 * * * *', () => {
    runFollowups().catch((err) => console.error('runFollowups crashed:', err));
    runReviewRequests().catch((err) => console.error('runReviewRequests crashed:', err));
    runReviewReminders().catch((err) => console.error('runReviewReminders crashed:', err));
  });
  console.log('Follow-up scheduler started (every 15 minutes).');
}

module.exports = { startFollowupScheduler, runFollowups, runReviewRequests, runReviewReminders };
