# HVAC/Plumbing Missed-Call & Review App

A Node.js backend for home service companies (HVAC, plumbing, etc.) that:

1. **Missed-call text-back** — watches Twilio call status callbacks, and when a call to the
   business goes unanswered, uses the Anthropic API to write a short apology text, sends it
   via Twilio, and offers the customer a few callback time slots to pick from by replying
   with a number.
2. **Google review requests** — texts a customer after a completed job asking for a Google
   review.
3. **Review reply drafts** — given an incoming review (rating + text), uses the Anthropic API
   to draft a public reply for a human to approve before posting to Google.

It's a multi-tenant-lite design: each HVAC/plumbing company is a "business" row identified by
its Twilio phone number.

## Project layout

```
hvac-app/
├── package.json
├── .env.example
├── src/
│   ├── index.js              # boots the DB + HTTP server
│   ├── app.js                # Express app (routes wired up), exported for tests
│   ├── config.js             # loads/validates env vars
│   ├── routes/
│   │   ├── callStatus.js     # POST /webhooks/twilio/call-status
│   │   ├── sms.js            # POST /webhooks/twilio/sms
│   │   ├── reviews.js        # POST /api/reviews/request, /reply-draft, GET /api/reviews
│   │   └── businesses.js     # POST/GET /api/businesses
│   ├── services/
│   │   ├── anthropic.js      # Claude prompts: apology text, review request, review reply
│   │   ├── twilio.js         # send SMS, missed-call detection, webhook signature check
│   │   └── scheduling.js     # callback time-slot generation + Google Calendar link
│   └── db/db.js               # Postgres pool, schema init, all queries
└── test/callStatus.test.js
```

## 1. Local setup

```bash
cd hvac-app
npm install
cp .env.example .env
```

Fill in `.env`:

- `DATABASE_URL` — a local or hosted Postgres connection string.
- `ANTHROPIC_API_KEY` — from the [Anthropic Console](https://console.anthropic.com/).
- `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` — from the Twilio Console.
- `PUBLIC_BASE_URL` — the externally-reachable URL for this server (see below). Required for
  Twilio webhook signature validation.

Start it:

```bash
npm start        # node src/index.js
npm run dev       # same, with --watch for local development
```

On boot it connects to Postgres and creates all tables if they don't exist yet (see
`src/db/db.js` — no separate migration step needed for this MVP).

Run tests (pure unit/integration tests against the Express app, no real Twilio/Anthropic/DB
calls — those services are stubbed):

```bash
npm test
```

### Exposing your local server to Twilio

Twilio needs a public HTTPS URL to call. Use a tunnel like [ngrok](https://ngrok.com/):

```bash
ngrok http 3000
```

Set `PUBLIC_BASE_URL` in `.env` to the `https://xxxx.ngrok-free.app` URL ngrok gives you, and
restart the server (signature validation checks the *exact* URL Twilio signed against).

## 2. Register a business

Each Twilio number maps to one business. Create one via the API:

```bash
curl -X POST http://localhost:3000/api/businesses \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Acme HVAC",
    "twilioPhoneNumber": "+15555550123",
    "googleReviewLink": "https://g.page/r/xxxxxxxxxxxx/review",
    "timezone": "America/Chicago"
  }'
```

`twilioPhoneNumber` must exactly match (E.164 format) the Twilio number you configure the
webhooks on below.

## 3. Configure Twilio

### Voice — forwarding calls and detecting a missed call

If nothing answers the inbound call at all (no TwiML, no forwarding configured), Twilio's own
call status becomes `no-answer` on its own, and the plain **Call status changes** webhook
(below) is all you need. In practice you almost always want the call to actually ring the
business's real phone first — for that, use a TwiML Bin with `<Dial>`, because once *anything*
answers the inbound leg (which happens automatically the instant Twilio runs TwiML), the
parent call's own status becomes `completed` regardless of whether the forwarded leg was
picked up. The real answered/missed outcome instead comes through as `DialCallStatus` on the
`<Dial>`'s `action` callback — this app checks `DialCallStatus` first and falls back to
`CallStatus` when it's absent, so pointing both at the same URL works correctly either way.

**To forward calls and detect missed ones:**

1. Twilio Console → **Voice → TwiML Bins → Create new TwiML Bin**. Body:
   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <Response>
     <Dial timeout="20" action="https://YOUR_PUBLIC_BASE_URL/webhooks/twilio/call-status" method="POST">
       +1XXXXXXXXXX
     </Dial>
   </Response>
   ```
   Replace `+1XXXXXXXXXX` with the real phone that should ring (the business's cell, etc.).
2. Copy the TwiML Bin's own hosted URL (something like
   `https://handler.twilio.com/twiml/EHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`).
3. On your phone number's **Voice configuration**, set **"A call comes in"** /
   **primary method's webhook URL** to that Bin URL (`Use Webhooks`, method `POST`).
4. Also set **Call status changes** on the same page to
   `https://YOUR_PUBLIC_BASE_URL/webhooks/twilio/call-status`, method `POST` — this covers the
   case where the call never gets forwarded at all.

If you'd rather not forward calls anywhere yet, leave "A call comes in" unconfigured and just
set **Call status changes** — every call will show as missed, which is fine for testing.

### Messaging — inbound SMS

If your number is part of a Messaging Service (Twilio adds this automatically for A2P 10DLC
compliance in the US), the number's own messaging webhook is overridden by the service's
settings. Configure it there instead:

- **Messaging → Services → (your service) → Settings** tab → under **Inbound messages**,
  select **"Send a webhook"** and set the Request URL to
  `https://YOUR_PUBLIC_BASE_URL/webhooks/twilio/sms`, method `POST`.

If the number isn't in a Messaging Service, set the webhook directly on the number instead:
**Numbers & senders → your number → Messaging configuration → "A message comes in"** →
same URL, method `POST`.

This is how the flow works end to end:

1. Call comes in, isn't answered → Twilio posts to `/webhooks/twilio/call-status` with
   `CallStatus=no-answer` (or `busy`/`failed`/`canceled`).
2. The server looks up the business by the `To` number, asks Claude for an apology text with
   a few callback time slots, and texts it to the caller via Twilio.
3. Customer replies with a number (e.g. `2`) → Twilio posts to `/webhooks/twilio/sms`.
4. The server matches the reply to a slot, confirms it, and texts back a confirmation with a
   "Add to Google Calendar" link (no calendar auth needed — it's a prefilled Calendar URL).

## 4. Review requests & reply drafts

**Send a review request** (call this after a job is marked complete, from your job/scheduling
software's webhook, a Zapier/Make step, or manually):

```bash
curl -X POST http://localhost:3000/api/reviews/request \
  -H "Content-Type: application/json" \
  -d '{
    "businessId": 1,
    "customerName": "Jordan",
    "customerNumber": "+15551234567",
    "jobDescription": "AC tune-up"
  }'
```

**Generate a reply draft for an incoming review** — there's no public "new review" webhook
without the Google Business Profile API + OAuth, so feed this endpoint from whatever you use
to watch your listing (a Zapier/Make automation, or paste it in manually):

```bash
curl -X POST http://localhost:3000/api/reviews/reply-draft \
  -H "Content-Type: application/json" \
  -d '{
    "businessId": 1,
    "reviewerName": "Jordan",
    "rating": 5,
    "reviewText": "Fast, friendly, fixed our AC same day!"
  }'
```

This stores the review + draft and returns the draft text for a human to review, edit, and
post to Google (or extend this endpoint to post automatically via the Business Profile API
once you have OAuth set up for that).

List stored reviews/drafts for a business: `GET /api/reviews?businessId=1`
Mark a draft as posted: `POST /api/reviews/:id/mark-sent`

## 5. Deploying

### Railway

1. Push this repo to GitHub, then in Railway: **New Project → Deploy from GitHub repo**.
2. **Add a Postgres plugin** to the project — Railway injects `DATABASE_URL` automatically.
3. In the service's **Variables** tab, set `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`,
   `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VALIDATE_SIGNATURE=true`, and
   `PUBLIC_BASE_URL` to the Railway-generated public domain (Settings → Networking → Generate
   Domain), e.g. `https://hvac-app-production.up.railway.app`.
4. Start command: `npm start` (Railway auto-detects this from `package.json`).
5. Point your Twilio webhooks (step 3 above) at that Railway domain.

### Render

1. **New → Web Service**, connect the GitHub repo.
2. Build command: `npm install`. Start command: `npm start`.
3. **New → PostgreSQL** to create a managed database, then copy its **Internal Database URL**
   into the web service's `DATABASE_URL` env var (same-region internal URLs are free and
   faster).
4. Add the same env vars as above (`ANTHROPIC_API_KEY`, `TWILIO_ACCOUNT_SID`,
   `TWILIO_AUTH_TOKEN`, etc.), and set `PUBLIC_BASE_URL` to the `.onrender.com` URL Render
   assigns the service.
5. Point your Twilio webhooks at that Render URL.

Both platforms terminate TLS for you, so `PUBLIC_BASE_URL` should always be `https://...`.

## Notes & next steps

- **Signature validation**: `TWILIO_VALIDATE_SIGNATURE=true` rejects any webhook request that
  isn't actually from Twilio. It requires `PUBLIC_BASE_URL` to exactly match what's configured
  in the Twilio console (including path). Turn it off only for local testing with synthetic
  requests.
- **Multi-number businesses**: the schema assumes one Twilio number per business. If a company
  uses multiple lines, add more rows or extend `businesses` to a one-to-many number mapping.
- **Callback slots**: `src/services/scheduling.js` generates slots from
  `BUSINESS_HOURS_START`/`BUSINESS_HOURS_END` over the next 3 business days. Swap this out for
  a real calendar/dispatch API (Housecall Pro, ServiceTitan, Google Calendar freebusy, etc.)
  when you're ready to check real technician availability instead of fixed windows.
- **Posting review replies automatically**: this app only *drafts* replies for human approval.
  Posting them programmatically requires Google Business Profile API access (OAuth per
  business) — a reasonable next step once you have Google API access approved for real
  business accounts.
