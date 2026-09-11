const { Pool } = require('pg');
const config = require('../config');

const pool = config.databaseUrl
  ? new Pool({
      connectionString: config.databaseUrl,
      // Managed Postgres on Railway/Render requires SSL; local dev usually doesn't.
      ssl: /localhost|127\.0\.0\.1/.test(config.databaseUrl) ? false : { rejectUnauthorized: false },
    })
  : null;

function query(text, params) {
  if (!pool) throw new Error('DATABASE_URL is not configured');
  return pool.query(text, params);
}

async function initDb() {
  if (!pool) {
    console.warn('[db] DATABASE_URL not set — skipping schema init');
    return;
  }

  await query(`
    CREATE TABLE IF NOT EXISTS businesses (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      twilio_phone_number TEXT UNIQUE NOT NULL,
      google_review_link TEXT,
      timezone TEXT DEFAULT 'America/Chicago',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS calls (
      id SERIAL PRIMARY KEY,
      business_id INTEGER NOT NULL REFERENCES businesses(id),
      call_sid TEXT UNIQUE,
      from_number TEXT NOT NULL,
      to_number TEXT NOT NULL,
      status TEXT,
      missed BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      business_id INTEGER NOT NULL REFERENCES businesses(id),
      call_id INTEGER REFERENCES calls(id),
      to_number TEXT NOT NULL,
      from_number TEXT NOT NULL,
      body TEXT NOT NULL,
      direction TEXT NOT NULL,
      twilio_sid TEXT,
      type TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS callback_requests (
      id SERIAL PRIMARY KEY,
      business_id INTEGER NOT NULL REFERENCES businesses(id),
      call_id INTEGER REFERENCES calls(id),
      customer_number TEXT NOT NULL,
      slot_options JSONB NOT NULL,
      selected_slot JSONB,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS review_requests (
      id SERIAL PRIMARY KEY,
      business_id INTEGER NOT NULL REFERENCES businesses(id),
      customer_name TEXT,
      customer_number TEXT NOT NULL,
      job_description TEXT,
      status TEXT NOT NULL DEFAULT 'sent',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id SERIAL PRIMARY KEY,
      business_id INTEGER NOT NULL REFERENCES businesses(id),
      reviewer_name TEXT,
      rating INTEGER,
      review_text TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'google',
      reply_draft TEXT,
      reply_sent BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  console.log('[db] schema ready');
}

// --- businesses ---

async function createBusiness({ name, twilioPhoneNumber, googleReviewLink, timezone }) {
  const { rows } = await query(
    `INSERT INTO businesses (name, twilio_phone_number, google_review_link, timezone)
     VALUES ($1, $2, $3, COALESCE($4, 'America/Chicago'))
     RETURNING *`,
    [name, twilioPhoneNumber, googleReviewLink || null, timezone || null]
  );
  return rows[0];
}

async function getBusinessByTwilioNumber(number) {
  const { rows } = await query(`SELECT * FROM businesses WHERE twilio_phone_number = $1`, [number]);
  return rows[0] || null;
}

async function getBusinessById(id) {
  const { rows } = await query(`SELECT * FROM businesses WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function listBusinesses() {
  const { rows } = await query(`SELECT * FROM businesses ORDER BY created_at DESC`);
  return rows;
}

// --- calls ---

async function insertCall({ businessId, callSid, from, to, status, missed }) {
  const { rows } = await query(
    `INSERT INTO calls (business_id, call_sid, from_number, to_number, status, missed)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (call_sid) DO UPDATE SET status = EXCLUDED.status, missed = EXCLUDED.missed
     RETURNING *`,
    [businessId, callSid, from, to, status, missed]
  );
  return rows[0];
}

// --- messages ---

async function insertMessage({ businessId, callId, to, from, body, direction, twilioSid, type }) {
  const { rows } = await query(
    `INSERT INTO messages (business_id, call_id, to_number, from_number, body, direction, twilio_sid, type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [businessId, callId || null, to, from, body, direction, twilioSid || null, type || null]
  );
  return rows[0];
}

// --- callback requests ---

async function insertCallbackRequest({ businessId, callId, customerNumber, slotOptions }) {
  const { rows } = await query(
    `INSERT INTO callback_requests (business_id, call_id, customer_number, slot_options)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [businessId, callId || null, customerNumber, JSON.stringify(slotOptions)]
  );
  return rows[0];
}

async function getPendingCallbackRequest({ businessId, customerNumber }) {
  const { rows } = await query(
    `SELECT * FROM callback_requests
     WHERE business_id = $1 AND customer_number = $2 AND status = 'pending'
     ORDER BY created_at DESC LIMIT 1`,
    [businessId, customerNumber]
  );
  return rows[0] || null;
}

async function updateCallbackRequestSelection(id, selectedSlot, status) {
  const { rows } = await query(
    `UPDATE callback_requests
     SET selected_slot = $2, status = $3, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, JSON.stringify(selectedSlot), status]
  );
  return rows[0];
}

// --- review requests ---

async function insertReviewRequest({ businessId, customerName, customerNumber, jobDescription }) {
  const { rows } = await query(
    `INSERT INTO review_requests (business_id, customer_name, customer_number, job_description)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [businessId, customerName || null, customerNumber, jobDescription || null]
  );
  return rows[0];
}

// --- reviews ---

async function insertReview({ businessId, reviewerName, rating, reviewText, source, replyDraft }) {
  const { rows } = await query(
    `INSERT INTO reviews (business_id, reviewer_name, rating, review_text, source, reply_draft)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [businessId, reviewerName || null, rating || null, reviewText, source || 'google', replyDraft || null]
  );
  return rows[0];
}

async function listReviewsForBusiness(businessId) {
  const { rows } = await query(
    `SELECT * FROM reviews WHERE business_id = $1 ORDER BY created_at DESC`,
    [businessId]
  );
  return rows;
}

async function markReviewReplySent(id) {
  const { rows } = await query(
    `UPDATE reviews SET reply_sent = true WHERE id = $1 RETURNING *`,
    [id]
  );
  return rows[0];
}

module.exports = {
  pool,
  query,
  initDb,
  createBusiness,
  getBusinessByTwilioNumber,
  getBusinessById,
  listBusinesses,
  insertCall,
  insertMessage,
  insertCallbackRequest,
  getPendingCallbackRequest,
  updateCallbackRequestSelection,
  insertReviewRequest,
  insertReview,
  listReviewsForBusiness,
  markReviewReplySent,
};
