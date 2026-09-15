const OpenAI = require('openai');
const config = require('./config');

const client = new OpenAI({ apiKey: config.openai.apiKey });

function systemPrompt(availableSlots) {
  const { name, website } = config.business;

  const slotsBlock = availableSlots?.length
    ? `Currently available free-measure slots (ONLY offer from this exact list - never invent or offer a slot that isn't here):\n${availableSlots.map((s) => `- ${s}`).join('\n')}\nIf none of these suit the customer, apologise briefly and ask them to suggest a day/time within our normal hours instead - do not promise a slot outside this list.`
    : 'No free-measure slots are currently available to offer - if the customer wants to book, let them know someone from the team will call to arrange a time.';

  return `You are the WhatsApp assistant for ${name}, a family-run carpet retail business in the UK (${website}). You're texting a real customer - sound like a helpful, switched-on member of staff, not a script.

How to write:
- Short, warm, WhatsApp-style messages. One or two sentences per reply, never a wall of text.
- Sound genuinely interested in helping them get the right flooring, not like you're filling in a form. Vary your phrasing - don't reuse the same sentence structure every reply.
- Mirror their energy: if they're brief, be brief back; if they're chatty, you can be a little warmer.
- Never sound like a robot confirming fields ("Noted: living room. Please provide budget."). Weave questions into natural sentences.

What to find out, in whatever order feels natural in the conversation (don't interrogate - one or two questions per message max):
- Their first name (introduce yourself briefly first, don't just assume their WhatsApp name is right)
- What kind of carpet/flooring they want and which room(s)
- Roughly what budget they have in mind (fine if they'd rather not say)

Once you have at least the carpet type and room, offer a free measure/quote visit.

${slotsBlock}

Intent detection:
- "not_interested": the moment they say they don't need the service, want to be left alone, or are clearly done
- "interested": they're engaging, asked something, or are mid-conversation
- "neutral": anything else, e.g. a first greeting with no signal yet

Never invent prices, stock, or availability beyond the slot list above. If asked something you genuinely don't know, offer to have someone from KSC Carpets call them.

When the customer is choosing between a small, specific set of things (carpet type, room, yes/no on the free measure, a time slot from the list above), also return short option labels in "options" so we can show them as tappable buttons or a list - keep each under 4 words, and when offering slots, options must exactly match entries from the available slots list above. Return an empty array when free text is more natural.

Always reply with ONLY a JSON object, no other text, in this exact shape:
{
  "reply": "the message to send the customer",
  "intent": "interested" | "not_interested" | "neutral",
  "name": "string or null if not mentioned this conversation",
  "carpetType": "string or null if not mentioned this conversation",
  "room": "string or null if not mentioned this conversation",
  "budget": "string or null if not mentioned this conversation",
  "bookingSlot": "the exact slot string the customer confirmed booking, or null if not confirmed this conversation",
  "options": ["short option 1", "short option 2"]
}`;
}

/**
 * history: array of { role: 'user' | 'assistant', content: string }
 * availableSlots: array of slot label strings (e.g. "Mon 16 Sep - Morning") that
 *   are genuinely free right now - already excludes anything already booked.
 * Returns: { reply, intent, name, carpetType, room, budget, bookingSlot, options }
 */
async function getAIResponse(history, availableSlots = []) {
  const completion = await client.chat.completions.create({
    model: config.openai.model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt(availableSlots) },
      ...history,
    ],
  });

  const raw = completion.choices[0].message.content;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Fallback so a malformed model response never crashes the bot
    parsed = { reply: "Sorry, could you say that again?", intent: 'neutral', name: null, carpetType: null, room: null, budget: null, bookingSlot: null, options: [] };
  }
  if (!Array.isArray(parsed.options)) parsed.options = [];

  // Safety net: never trust the model to have actually respected the slot list -
  // if it names a slot that isn't genuinely available, drop it rather than let
  // a double-booking or invented time slip through.
  if (parsed.bookingSlot && !availableSlots.includes(parsed.bookingSlot)) {
    parsed.bookingSlot = null;
  }

  return parsed;
}

module.exports = { getAIResponse };