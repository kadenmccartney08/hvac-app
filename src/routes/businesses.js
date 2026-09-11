const express = require('express');
const router = express.Router();

const db = require('../db/db');

/**
 * Minimal tenant management. In this MVP, one "business" = one HVAC/plumbing
 * company = one Twilio phone number. Register a business here first, so the
 * webhooks below know which company an incoming call/SMS belongs to.
 *
 * Body: { name, twilioPhoneNumber, googleReviewLink?, timezone? }
 */
router.post('/', express.json(), async (req, res) => {
  try {
    const { name, twilioPhoneNumber, googleReviewLink, timezone } = req.body;
    if (!name || !twilioPhoneNumber) {
      return res.status(400).json({ error: 'name and twilioPhoneNumber are required' });
    }

    const business = await db.createBusiness({ name, twilioPhoneNumber, googleReviewLink, timezone });
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

module.exports = router;
