const express = require('express');
const router = express.Router();

const config = require('../config');
const db = require('../db/db');
const twilioService = require('../services/twilio');

/**
 * Twilio "A call comes in" webhook. Replaces having to hand-create a TwiML
 * Bin per client: this generates the same <Dial> TwiML on the fly, using
 * whatever forward_to_number is stored on the business matching the called
 * (Twilio) number — so onboarding a new client needs no TwiML Bin at all,
 * just registering them with a forwardToNumber and pointing their number's
 * webhooks here (see README).
 *
 * The <Dial>'s action points back at /webhooks/twilio/call-status, which is
 * what actually detects a missed call (see that route's comments for why).
 */
router.post('/', express.urlencoded({ extended: false }), async (req, res) => {
  if (!twilioService.validateTwilioRequest(req)) {
    return res.status(403).send('Invalid Twilio signature');
  }

  res.set('Content-Type', 'text/xml');

  const { To } = req.body;

  try {
    const business = await db.getBusinessByTwilioNumber(To);

    if (!business || !business.forward_to_number) {
      console.warn(`[voice] no business/forward number configured for Twilio number ${To}`);
      // Nothing to forward to — just decline cleanly instead of erroring.
      return res.send('<Response><Reject/></Response>');
    }

    const actionUrl = `${config.publicBaseUrl}/webhooks/twilio/call-status`;
    const twiml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Response><Dial timeout="12" action="${actionUrl}" method="POST">` +
      `${business.forward_to_number}</Dial></Response>`;

    res.send(twiml);
  } catch (err) {
    console.error('[voice] error handling webhook', err);
    res.send('<Response><Reject/></Response>');
  }
});

module.exports = router;
