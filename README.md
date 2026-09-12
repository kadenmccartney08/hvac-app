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

Each Twilio number maps to one business. `forwardToNumber` is the real phone that should ring
when a customer calls that Twilio number (the business's cell, office line, etc.) — set it and
the app generates the call-forwarding TwiML itself, so there's no TwiML Bin to hand-create per
client. Create a business via the API:

```bash
curl -X POST http://localhost:3000/api/businesses \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Acme HVAC",
    "twilioPhoneNumber": "+15555550123",
    "forwardToNumber": "+15555559999",
    "googleReviewLink": "https://g.page/r/xxxxxxxxxxxx/review",
    "timezone": "America/Chicago"
  }'
```

`twilioPhoneNumber` must exactly match (E.164 format) the Twilio number you configure the
webhooks on below. `forwardToNumber` and `googleReviewLink` are optional — update either later
with:

```bash
curl -X PATCH http://localhost:3000/api/businesses/1 \
  -H "Content-Type: application/json" \
  -d '{"forwardToNumber": "+15555559999"}'
```

## 3. Configure Twilio

### Voice — forwarding calls and detecting a missed call

Point the number straight at this app — no TwiML Bin needed:

1. Twilio Console → your phone number → **Voice configuration**
2. **"A call comes in"** / primary method → **Use Webhooks**, URL:
   `https://YOUR_PUBLIC_BASE_URL/webhooks/twilio/voice`, method `POST`
3. **Call status changes** (same page) →
   `https://YOUR_PUBLIC_BASE_URL/webhooks/twilio/call-status`, method `POST`

`/webhooks/twilio/voice` looks up the business by the number that was called, and returns a
`<Dial timeout="12">` TwiML pointed at that business's `forwardToNumber`, with its `action`
callback pointed at `/webhooks/twilio/call-status` — which is what actually detects the missed
call. It's set up this way (rather than just checking the parent call's own status) because
once *anything* answers the inbound leg — which happens automatically the instant Twilio runs
any TwiML — the parent call's own status becomes `completed` regardless of whether the
forwarded leg was ever picked up. The real answered/missed outcome instead comes through as
`DialCallStatus` on the `<Dial>`'s `action` callback, which `/webhooks/twilio/call-status`
checks first, falling back to plain `CallStatus` when `DialCallStatus` is absent (e.g. if a
business has no `forwardToNumber` set, `/webhooks/twilio/voice` returns `<Reject/>` instead of
dialing anywhere, and the call's own status becomes the missed-call signal instead).

The `timeout="12"` matters more than it looks: carrier voicemail can pick up a call before a
longer Dial timeout gives up, which makes Twilio see the call as answered (by voicemail) rather
than missed. 12 seconds is short enough to reliably beat voicemail on most carriers while still
giving a real person a few rings to answer — adjust in `src/routes/voice.js` if needed.

If a business has no `forwardToNumber` configured, every call to their number is treated as
missed (nothing to actually answer it), which is a fine way to test end-to-end before you have
a real forwarding number to use.

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

### Onboarding a new client — the full checklist

What you need from them: their business name, a real phone number to forward calls to, and
(optionally, for review-request texts) their Google review link.

1. Buy them a Twilio phone number (Voice + SMS capable).
2. Register them: `POST /api/businesses` with `name`, `twilioPhoneNumber`, `forwardToNumber`,
   and `googleReviewLink` if you have it (step 2 above).
3. On that number's Voice configuration: "A call comes in" → `/webhooks/twilio/voice`,
   "Call status changes" → `/webhooks/twilio/call-status` (step 3 above — no TwiML Bin needed).
4. Add the number to a Messaging Service with its inbound webhook set to
   `/webhooks/twilio/sms` (or set it directly on the number if it's not in a service — see
   above).
5. Test: call their number from another phone, let it ring out unanswered, confirm a text
   comes back.

That's it — no manual TwiML Bin per client, no code changes needed for a new customer.

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
