const config = require('../config');

const SLOT_DURATION_HOURS = 1;
const DAYS_TO_OFFER = 3;
const SLOTS_PER_DAY = 3;
const MAX_SLOTS = 6; // keep the SMS short and easy to reply to

function isWeekend(date) {
  const day = date.getDay();
  return day === 0 || day === 6;
}

function nextBusinessDays(count, fromDate = new Date()) {
  const days = [];
  const cursor = new Date(fromDate);
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() + 1); // start tomorrow — don't offer "5 minutes from now"
  while (days.length < count) {
    if (!isWeekend(cursor)) days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function buildSlotsForDay(day, hoursStart, hoursEnd, slotsPerDay) {
  const span = hoursEnd - hoursStart;
  const step = Math.max(1, Math.floor(span / slotsPerDay));
  const slots = [];
  for (let i = 0; i < slotsPerDay; i++) {
    const hour = hoursStart + i * step;
    if (hour >= hoursEnd) break;
    const start = new Date(day);
    start.setHours(hour, 0, 0, 0);
    slots.push(start);
  }
  return slots;
}

function formatSlotLabel(date) {
  return date.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Generates a short numbered list of callback windows over the next few
 * business days, e.g. for texting to a customer as "reply with a number".
 */
function generateCallbackSlots({
  hoursStart = config.business.hoursStart,
  hoursEnd = config.business.hoursEnd,
} = {}) {
  const days = nextBusinessDays(DAYS_TO_OFFER);
  const raw = days.flatMap((day) => buildSlotsForDay(day, hoursStart, hoursEnd, SLOTS_PER_DAY));

  return raw.slice(0, MAX_SLOTS).map((date, index) => ({
    id: index + 1,
    iso: date.toISOString(),
    label: formatSlotLabel(date),
  }));
}

function formatSlotsForSms(slots) {
  return slots.map((s) => `${s.id}) ${s.label}`).join('\n');
}

/** Pulls the first number out of a customer's SMS reply and matches it to a slot. */
function pickSlotFromReply(replyText, slots) {
  const match = String(replyText || '').trim().match(/\d+/);
  if (!match) return null;
  const id = parseInt(match[0], 10);
  return slots.find((s) => s.id === id) || null;
}

/** Builds a no-auth-required "Add to Google Calendar" link for a confirmed slot. */
function googleCalendarLink({ title, description, startIso, durationHours = SLOT_DURATION_HOURS }) {
  const start = new Date(startIso);
  const end = new Date(start.getTime() + durationHours * 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    details: description || '',
    dates: `${fmt(start)}/${fmt(end)}`,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

module.exports = {
  generateCallbackSlots,
  formatSlotsForSms,
  pickSlotFromReply,
  googleCalendarLink,
  formatSlotLabel,
};
