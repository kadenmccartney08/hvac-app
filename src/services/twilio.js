const twilio = require('twilio');
const config = require('../config');

const client =
  config.twilio.accountSid && config.twilio.authToken
    ? twilio(config.twilio.accountSid, config.twilio.authToken)
    : null;

/**
 * Send an SMS. Falls back to a console-logged "dry run" if Twilio credentials
 * aren't configured yet, so the rest of the app is testable without them.
 */
async function sendSms({ to, from, body }) {
  if (!client) {
    console.warn('[twilio] not configured — dry-run SMS (not actually sent):', { to, from, body });
    return { sid: 'DRY_RUN', status: 'not_sent' };
  }
  return client.messages.create({ to, from, body });
}

/**
 * Twilio's CallStatus values for a call that rang the business line but was
 * never picked up. "canceled" covers the caller hanging up before answer.
 */
function isMissedCallStatus(status) {
  return ['no-answer', 'busy', 'failed', 'canceled'].includes(String(status || '').toLowerCase());
}

/**
 * Verify that an incoming webhook request actually came from Twilio.
 * Requires PUBLIC_BASE_URL to exactly match the URL Twilio was configured
 * to call (scheme + host + path), since that's part of what gets signed.
 */
function validateTwilioRequest(req) {
  if (!config.twilio.validateSignature) return true;

  const signature = req.headers['x-twilio-signature'];
  if (!signature || !config.twilio.authToken) return false;

  if (!config.publicBaseUrl) {
    console.warn('[twilio] PUBLIC_BASE_URL is not set — cannot validate signature, rejecting request');
    return false;
  }

  const url = `${config.publicBaseUrl}${req.originalUrl}`;
  return twilio.validateRequest(config.twilio.authToken, signature, url, req.body);
}

module.exports = { client, sendSms, isMissedCallStatus, validateTwilioRequest };
