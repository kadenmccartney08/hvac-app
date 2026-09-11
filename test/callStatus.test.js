const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

// Stub the side-effecting modules (DB, Twilio, Anthropic) *before* requiring
// the app, so the route handlers — which hold a reference to these module
// objects — pick up the stubbed functions instead of hitting real services.
const db = require('../src/db/db');
const twilioService = require('../src/services/twilio');
const anthropicService = require('../src/services/anthropic');

const calls = [];
const messages = [];
const callbackRequests = [];

function resetFixtures() {
  calls.length = 0;
  messages.length = 0;
  callbackRequests.length = 0;
}

db.getBusinessByTwilioNumber = async (number) => ({
  id: 1,
  name: 'Acme HVAC',
  twilio_phone_number: number,
  google_review_link: 'https://g.page/r/acme/review',
});

db.insertCall = async (call) => {
  const row = { id: calls.length + 1, ...call };
  calls.push(row);
  return row;
};

db.insertMessage = async (msg) => {
  const row = { id: messages.length + 1, ...msg };
  messages.push(row);
  return row;
};

db.insertCallbackRequest = async (cb) => {
  const row = { id: callbackRequests.length + 1, ...cb };
  callbackRequests.push(row);
  return row;
};

twilioService.validateTwilioRequest = () => true;
twilioService.sendSms = async ({ to, from, body }) => {
  return { sid: 'SMtest0000000000000000000000000' };
};

anthropicService.generateMissedCallText = async ({ businessName }) =>
  `Sorry we missed your call! This is ${businessName}, reply with a number to schedule a callback.`;

const app = require('../src/app');

test('missed call webhook sends an apology text and offers callback slots', async () => {
  resetFixtures();

  const res = await request(app).post('/webhooks/twilio/call-status').type('form').send({
    CallSid: 'CA123',
    From: '+15551234567',
    To: '+15557654321',
    CallStatus: 'no-answer',
  });

  assert.equal(res.status, 200);

  // the handler finishes its async work after the response is sent
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].missed, true);
  assert.equal(callbackRequests.length, 1);

  const outbound = messages.find((m) => m.type === 'missed_call_text');
  assert.ok(outbound, 'expected an outbound missed-call text to be recorded');
  assert.match(outbound.body, /Acme HVAC/);
});

test('answered calls do not trigger a text or callback offer', async () => {
  resetFixtures();

  const res = await request(app).post('/webhooks/twilio/call-status').type('form').send({
    CallSid: 'CA456',
    From: '+15551234567',
    To: '+15557654321',
    CallStatus: 'completed',
  });

  assert.equal(res.status, 200);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].missed, false);
  assert.equal(callbackRequests.length, 0);
  assert.equal(messages.length, 0);
});

test('rejects the webhook when Twilio signature validation fails', async () => {
  resetFixtures();
  twilioService.validateTwilioRequest = () => false;

  const res = await request(app).post('/webhooks/twilio/call-status').type('form').send({
    CallSid: 'CA789',
    From: '+15551234567',
    To: '+15557654321',
    CallStatus: 'no-answer',
  });

  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);

  twilioService.validateTwilioRequest = () => true; // restore for any later tests
});
