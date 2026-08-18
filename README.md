# callbot — Twilio + OpenAI Realtime voice calling bot (Manuel's)

Takes a goal in plain English, places one outbound call from +18573416628,
holds a two-way spoken conversation toward the goal, then stores a transcript
plus a short summary.

## Run

    TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... OPENAI_API_KEY=... \
    CALLBOT_SECRET=... PUBLIC_HOST=<public-hostname> node server.js

PUBLIC_HOST must reach this server over HTTP+WS. On Render, set it to the
service's onrender.com host after first deploy, then restart.

## API

    POST /v1/calls            Authorization: Bearer <CALLBOT_SECRET>
      {"to":"+1XXXXXXXXXX","goal":"plain english goal",
       "behavior":"optional extra behavior instructions from Manuel",
       "voice":"marin" (optional: marin|cedar|alloy|ash|ballad|coral|echo|sage|shimmer|verse),
       "from":"+18573416628" (optional)}
      -> {"callSid":"CA...","status":"queued"}

    GET  /v1/calls            -> list of all calls (with summaries)
    GET  /v1/calls/CA...      -> full record: status, transcript[], summary, usage
    GET  /health              -> {"ok":true}

Records persist as data/<callSid>.json.

## Behavior contract
- Always opens in clear English with a scripted greeting identifying itself as
  Manuel's automated AI assistant; notes the call is being transcribed.
- voicemail: leaves a short message, hangs up.
- person asks to stop: wraps up and hangs up.
- hard cap 5 minutes per call (Twilio TimeLimit=300).
- no purchases/commitments unless the goal explicitly says so.

## Known limitations
- No Twilio request-signature validation on webhooks yet.
- Render free tier sleeps when idle; first request after idle has a cold start.
