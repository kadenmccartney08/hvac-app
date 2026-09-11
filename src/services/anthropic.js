const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');

const client = config.anthropic.apiKey ? new Anthropic({ apiKey: config.anthropic.apiKey }) : null;

async function complete({ system, prompt, maxTokens = 300 }) {
  if (!client) {
    console.warn('[anthropic] ANTHROPIC_API_KEY not set — using fallback template text');
    return null;
  }
  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  const block = response.content?.find((b) => b.type === 'text');
  return block ? block.text.trim() : null;
}

// --- Missed-call apology text ---

function fallbackMissedCallText({ businessName, slotsText }) {
  return `Sorry we missed your call! This is ${businessName}. We'd love to call you back — reply with a number for a time that works:\n${slotsText}\nOr just text us a better time.`;
}

async function generateMissedCallText({ businessName, slotsText }) {
  const system = [
    'You write short, warm, professional SMS messages on behalf of home service businesses',
    '(HVAC, plumbing) apologizing for a missed incoming call.',
    'Rules: under 320 characters. No emojis. No markdown. Sign off with the business name.',
    'Always invite the customer to reply with the number of a callback time, or text a better time.',
  ].join(' ');

  const prompt = `Business name: ${businessName}\nWe just missed an incoming call from this customer. Write the apology text. Offer these callback time options (the customer will reply with the number):\n${slotsText}`;

  const text = await complete({ system, prompt, maxTokens: 200 });
  return text || fallbackMissedCallText({ businessName, slotsText });
}

// --- Google review request text ---

function fallbackReviewRequestText({ businessName, customerName, reviewLink }) {
  return `Hi ${customerName || 'there'}, thanks for choosing ${businessName}! If you have a minute, a Google review helps us a lot: ${reviewLink}`;
}

async function generateReviewRequestText({ businessName, customerName, reviewLink }) {
  const system = [
    'You write short, friendly SMS messages on behalf of home service businesses asking a',
    'recent customer for a Google review. Under 300 characters. No emojis. Warm, genuine,',
    'not pushy. Include the review link exactly as given, once.',
  ].join(' ');

  const prompt = `Business name: ${businessName}\nCustomer name: ${customerName || 'there'}\nReview link: ${reviewLink}\nWrite the text message asking for a quick Google review after their recent completed job.`;

  const text = await complete({ system, prompt, maxTokens: 200 });
  return text || fallbackReviewRequestText({ businessName, customerName, reviewLink });
}

// --- Google review reply drafts ---

function fallbackReviewReplyDraft({ businessName, reviewerName }) {
  return `Thank you for your feedback, ${reviewerName || 'valued customer'} — ${businessName}`;
}

async function generateReviewReplyDraft({ businessName, reviewerName, rating, reviewText }) {
  const isLowRating = typeof rating === 'number' && rating <= 3;
  const tone = isLowRating
    ? 'The review is negative or mixed. Be sincerely apologetic and empathetic, avoid sounding defensive, ' +
      'briefly acknowledge the specific issue raised, and invite them to contact the business directly to ' +
      'make it right. Do not make excuses or over-explain.'
    : 'The review is positive. Be warm and specific — reference something concrete from their review if ' +
      'possible — and thank them by name.';

  const system = [
    'You write professional, human-sounding public replies to Google reviews on behalf of home service',
    'businesses (HVAC/plumbing). Under 500 characters. Sign off with the business name. Never sound like a',
    'generic template.',
  ].join(' ');

  const prompt = [
    `Business name: ${businessName}`,
    `Reviewer name: ${reviewerName || 'the customer'}`,
    `Rating: ${rating ?? 'unknown'}/5`,
    `Review text: "${reviewText}"`,
    '',
    tone,
    '',
    'Write the public reply.',
  ].join('\n');

  const text = await complete({ system, prompt, maxTokens: 250 });
  return text || fallbackReviewReplyDraft({ businessName, reviewerName });
}

module.exports = {
  generateMissedCallText,
  generateReviewRequestText,
  generateReviewReplyDraft,
};
