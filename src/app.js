const express = require('express');

const callStatusRoute = require('./routes/callStatus');
const smsRoute = require('./routes/sms');
const reviewsRoute = require('./routes/reviews');
const businessesRoute = require('./routes/businesses');

const app = express();

app.get('/health', (req, res) => res.json({ ok: true }));

// Twilio webhooks
app.use('/webhooks/twilio/call-status', callStatusRoute);
app.use('/webhooks/twilio/sms', smsRoute);

// Internal/admin API
app.use('/api/businesses', businessesRoute);
app.use('/api/reviews', reviewsRoute);

app.use((req, res) => {
  res.status(404).json({ error: 'not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'internal error' });
});

module.exports = app;
