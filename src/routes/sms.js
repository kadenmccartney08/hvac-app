const express = require('express');
const router = express.Router();

const db = require('../db/db');
const twilioService = require('../services/twilio');
const scheduling = require('../services/scheduling');

/**
 * Twilio incoming-SMS webhook. Configure this as the "A message comes in"
 * webhook on your Twilio number. Handles a customer replying with a number
 * to pick one of the callback times offered by the missed-call text.
 */
router.post('/', express.urlencoded({ extended: false }), async (req, res) => {
  if (!twilioService.validateTwilioRequest(req)) {
    return res.status(403).send('Invalid Twilio signature');
  }

  // Empty TwiML = "don't send an auto-reply", we send replies ourselves via the REST API.
  res.set('Content-Type', 'text/xml');
  res.status(200).send('<Response></Response>');

  const { From, To, Body, MessageSid } = req.body;

  try {
    const business = await db.getBusinessByTwilioNumber(To);
    if (!business) {
      console.warn(`[sms] no business registered for Twilio number ${To}`);
      return;
    }

    await db.insertMessage({
      businessId: business.id,
      callId: null,
      to: To,
      from: From,
      body: Body,
      direction: 'inbound',
      twilioSid: MessageSid,
      type: 'inbound_sms',
    });

    const pending = await db.getPendingCallbackRequest({ businessId: business.id, customerNumber: From });
    if (!pending) return; // no scheduling flow in progress for this number — nothing more to do

    const slot = scheduling.pickSlotFromReply(Body, pending.slot_options);

    if (!slot) {
      const clarify = `Sorry, I didn't catch a time. Please reply with the number next to the time that works:\n${scheduling.formatSlotsForSms(
        pending.slot_options
      )}`;
      const sent = await twilioService.sendSms({ to: From, from: To, body: clarify });
      await db.insertMessage({
        businessId: business.id,
        callId: pending.call_id,
        to: From,
        from: To,
        body: clarify,
        direction: 'outbound',
        twilioSid: sent.sid,
        type: 'callback_clarify',
      });
      return;
    }

    await db.updateCallbackRequestSelection(pending.id, slot, 'confirmed');

    const calendarLink = scheduling.googleCalendarLink({
      title: `Callback from ${business.name}`,
      description: `Scheduled callback with ${business.name}`,
      startIso: slot.iso,
    });

    const confirmText = `You're all set — ${business.name} will call you ${slot.label}. Add to calendar: ${calendarLink}`;
    const sent = await twilioService.sendSms({ to: From, from: To, body: confirmText });

    await db.insertMessage({
      businessId: business.id,
      callId: pending.call_id,
      to: From,
      from: To,
      body: confirmText,
      direction: 'outbound',
      twilioSid: sent.sid,
      type: 'callback_confirmation',
    });
  } catch (err) {
    console.error('[sms] error handling inbound SMS', err);
  }
});

module.exports = router;
