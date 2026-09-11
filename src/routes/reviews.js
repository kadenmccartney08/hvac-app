const express = require('express');
const router = express.Router();

const db = require('../db/db');
const twilioService = require('../services/twilio');
const anthropicService = require('../services/anthropic');

/**
 * Trigger a "please leave us a Google review" text after a completed job.
 * Wire this up from wherever job completion happens today — your scheduling
 * software's webhook/Zapier step, or a manual call from a dispatcher's tool.
 *
 * Body: { businessId, customerName?, customerNumber, jobDescription? }
 */
router.post('/request', express.json(), async (req, res) => {
  try {
    const { businessId, customerName, customerNumber, jobDescription } = req.body;
    if (!businessId || !customerNumber) {
      return res.status(400).json({ error: 'businessId and customerNumber are required' });
    }

    const business = await db.getBusinessById(businessId);
    if (!business) return res.status(404).json({ error: 'business not found' });
    if (!business.google_review_link) {
      return res.status(400).json({ error: 'business has no google_review_link configured' });
    }

    const text = await anthropicService.generateReviewRequestText({
      businessName: business.name,
      customerName,
      reviewLink: business.google_review_link,
    });

    const sent = await twilioService.sendSms({
      to: customerNumber,
      from: business.twilio_phone_number,
      body: text,
    });

    await db.insertMessage({
      businessId: business.id,
      callId: null,
      to: customerNumber,
      from: business.twilio_phone_number,
      body: text,
      direction: 'outbound',
      twilioSid: sent.sid,
      type: 'review_request',
    });

    const reviewRequest = await db.insertReviewRequest({
      businessId: business.id,
      customerName,
      customerNumber,
      jobDescription,
    });

    res.status(201).json({ reviewRequest, message: text });
  } catch (err) {
    console.error('[reviews] error sending review request', err);
    res.status(500).json({ error: 'internal error' });
  }
});

/**
 * Generate (and store) a draft reply for an incoming review, for a human to
 * approve/edit before posting it to Google. There's no public webhook for
 * "a new Google review just came in" without the Business Profile API + OAuth,
 * so feed this from a Zapier/Make automation watching your listing, or call
 * it manually by pasting in the review.
 *
 * Body: { businessId, reviewerName?, rating?, reviewText, source? }
 */
router.post('/reply-draft', express.json(), async (req, res) => {
  try {
    const { businessId, reviewerName, rating, reviewText, source } = req.body;
    if (!businessId || !reviewText) {
      return res.status(400).json({ error: 'businessId and reviewText are required' });
    }

    const business = await db.getBusinessById(businessId);
    if (!business) return res.status(404).json({ error: 'business not found' });

    const draft = await anthropicService.generateReviewReplyDraft({
      businessName: business.name,
      reviewerName,
      rating,
      reviewText,
    });

    const review = await db.insertReview({
      businessId: business.id,
      reviewerName,
      rating,
      reviewText,
      source: source || 'google',
      replyDraft: draft,
    });

    res.status(201).json({ review, draft });
  } catch (err) {
    console.error('[reviews] error generating reply draft', err);
    res.status(500).json({ error: 'internal error' });
  }
});

/** List stored reviews + drafts for a business (for a simple approval dashboard). */
router.get('/', async (req, res) => {
  try {
    const businessId = parseInt(req.query.businessId, 10);
    if (!businessId) return res.status(400).json({ error: 'businessId query param is required' });

    const reviews = await db.listReviewsForBusiness(businessId);
    res.json({ reviews });
  } catch (err) {
    console.error('[reviews] error listing reviews', err);
    res.status(500).json({ error: 'internal error' });
  }
});

/** Mark a review's draft as posted, after a human approves it and posts it (manually or via the Google API). */
router.post('/:id/mark-sent', express.json(), async (req, res) => {
  try {
    const review = await db.markReviewReplySent(req.params.id);
    if (!review) return res.status(404).json({ error: 'review not found' });
    res.json({ review });
  } catch (err) {
    console.error('[reviews] error marking review reply sent', err);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
