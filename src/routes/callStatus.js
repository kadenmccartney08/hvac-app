const express = require('express');
const router = express.Router();

const db = require('../db/db');
const twilioService = require('../services/twilio');
const anthropicService = require('../services/anthropic');
const scheduling = require('../services/scheduling');

/**
 * Twilio Voice status callback webhook.
 * Configure this as the "Call Status Changes" webhook on your Twilio number
 * (or as the statusCallback on your <Dial>/incoming call handling), listening
 * for at least: completed, no-answer, busy, failed, canceled.
 */
router.post('/', express.urlencoded({ extended: false }), async (req, res) => {
  if (!twilioService.validateTwilioRequest(req)) {
    return res.status(403).send('Invalid Twilio signature');
  }

  // Ack immediately — Twilio doesn't wait on this endpoint, and everything
  // below (DB writes, an LLM call, an SMS send) shouldn't hold up the response.
  res.sendStatus(200);

  const { CallSid, From, To, CallStatus } = req.body;

  try {
    const business = await db.getBusinessByTwilioNumber(To);
    if (!business) {
      console.warn(`[callStatus] no business registered for Twilio number ${To}`);
      return;
    }

    const missed = twilioService.isMissedCallStatus(CallStatus);
    const call = await db.insertCall({
      businessId: business.id,
      callSid: CallSid,
      from: From,
      to: To,
      status: CallStatus,
      missed,
    });

    if (!missed) return;

    const slots = scheduling.generateCallbackSlots();
    const slotsText = scheduling.formatSlotsForSms(slots);

    const text = await anthropicService.generateMissedCallText({
      businessName: business.name,
      slotsText,
    });

    const sent = await twilioService.sendSms({ to: From, from: To, body: text });

    await db.insertMessage({
      businessId: business.id,
      callId: call.id,
      to: From,
      from: To,
      body: text,
      direction: 'outbound',
      twilioSid: sent.sid,
      type: 'missed_call_text',
    });

    await db.insertCallbackRequest({
      businessId: business.id,
      callId: call.id,
      customerNumber: From,
      slotOptions: slots,
    });
  } catch (err) {
    console.error('[callStatus] error handling webhook', err);
  }
});

module.exports = router;
