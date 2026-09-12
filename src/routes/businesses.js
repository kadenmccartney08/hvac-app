const express = require('express');
const router = express.Router();

const db = require('../db/db');

/**
 * Minimal tenant management. In this MVP, one "business" = one HVAC/plumbing
 * company = one Twilio phone number. Register a business here first, so the
 * webhooks below know which company an incoming call/SMS belongs to.
 *
 * `forwardToNumber` is the real phone that should ring when a customer calls
 * this business's Twilio number (their cell, office line, etc.) — set it and
 * the /webhooks/twilio/voice endpoint handles forwarding + missed-call
 * detection automatically, with no manual TwiML Bin needed per client.
 *
 * Body: { name, twilioPhoneNumber, forwardToNumber?, googleReviewLink?, timezone? }
 */
router.post('/', express.json(), async (req, res) => {
  try {
    const { name, twilioPhoneNumber, forwardToNumber, googleReviewLink, timezone } = req.body;
    if (!name || !twilioPhoneNumber) {
      return res.status(400).json({ error: 'name and twilioPhoneNumber are required' });
    }

    const business = await db.createBusiness({
      name,
      twilioPhoneNumber,
      forwardToNumber,
      googleReviewLink,
      timezone,
    });
    res.status(201).json({ business });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'a business is already registered with that Twilio phone number' });
    }
    console.error('[businesses] error creating business', err);
    res.status(500).json({ error: 'internal error' });
  }
});

router.get('/', async (req, res) => {
  try {
    const businesses = await db.listBusinesses();
    res.json({ businesses });
  } catch (err) {
    console.error('[businesses] error listing businesses', err);
    res.status(500).json({ error: 'internal error' });
  }
});

/**
 * Update any subset of a business's fields — e.g. set forwardToNumber on a
 * business that was registered before you had it, or update its review link.
 * Body: any of { name, twilioPhoneNumber, forwardToNumber, googleReviewLink, timezone }
 */
router.patch('/:id', express.json(), async (req, res) => {
  try {
    const business = await db.updateBusiness(req.params.id, req.body);
    if (!business) return res.status(404).json({ error: 'business not found' });
    res.json({ business });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'a business is already registered with that Twilio phone number' });
    }
    console.error('[businesses] error updating business', err);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
