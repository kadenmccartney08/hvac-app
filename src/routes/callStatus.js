const express = require('express');
const router = express.Router();

const db = require('../db/db');
const twilioService = require('../services/twilio');
const anthropicService = require('../services/anthropic');
const scheduling = require('../services/scheduling');

/**
 * Twilio Voice webhook. This URL serves two roles, both pointed here:
 *
 * 1. As the plain "Call status changes" webhook — fires with just CallStatus
 *    for the parent (inbound) call. If nothing ever answers the call at all
 *    (no <Dial>/TwiML configured), CallStatus itself becomes "no-answer".
 *
 * 2. As the `action` callback on a <Dial> that forwards the call to the
 *    business's real phone (see README for the TwiML Bin setup). In that
 *    case CallStatus on the parent call is usually "completed" (Twilio
 *    itself answered to run the TwiML) even if nobody picked up the
 *    forwarded leg — the real answer/no-answer outcome comes through as
 *    DialCallStatus instead, so we prefer that field when it's present.
 */
router.post('/', express.urlencoded({ extended: false }), async (req, res) => {
  if (!twilioService.validateTwilioRequest(req)) {
    return res.status(403).send('Invalid Twilio signature');
  }

  // Ack immediately with valid (empty) TwiML — everything below (DB writes,
  // an LLM call, an SMS send) shouldn't hold up the response. This URL also
  // serves as the <Dial> action callback, where Twilio expects a real TwiML
  // document to continue the still-connected caller's call; a bodyless 200
  // isn't valid TwiML and causes Twilio to play "an application error has
  // occurred" to the caller. An empty <Response/> just ends the call quietly.
  res.set('Content-Type', 'text/xml');
  res.status(200).send('<Response></Response>');

  const { CallSid, From, To, CallStatus, DialCallStatus } = req.body;
  const effectiveStatus = DialCallStatus || CallStatus;

  try {
    const business = await db.getBusinessByTwilioNumber(To);
    if (!business) {
      console.warn(`[callStatus] no business registered for Twilio number ${To}`);
      return;
    }

    const missed = twilioService.isMissedCallStatus(effectiveStatus);
    const call = await db.insertCall({
      businessId: business.id,
      callSid: CallSid,
      from: From,
      to: To,
      status: effectiveStatus,
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
