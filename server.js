// callbot v1 - Twilio <-> OpenAI Realtime voice bridge
// Routes:
//   POST /v1/calls            {to, goal, from?}   (Bearer auth) - place one outbound call
//   GET  /v1/calls                              (Bearer auth) - list call records
//   GET  /v1/calls/:sid                         (Bearer auth) - full record (transcript, summary, usage)
//   POST /twilio-status                         (Twilio webhook) - call status updates
//   WS   /media-stream                          (Twilio Media Stream)
//   GET  /health
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const FROM_NUMBER = process.env.TWILIO_FROM || '+18573416628';
const CALLBOT_SECRET = process.env.CALLBOT_SECRET;
const PUBLIC_HOST = process.env.PUBLIC_HOST; // e.g. foo.trycloudflare.com (no scheme)
const DATA_DIR = path.join(__dirname, 'data');
const MAX_CALL_SECONDS = 300;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const calls = new Map(); // callSid -> record

function loadRecord(sid) {
  if (calls.has(sid)) return calls.get(sid);
  try {
    const r = JSON.parse(fs.readFileSync(path.join(DATA_DIR, sid + '.json'), 'utf8'));
    calls.set(sid, r);
    return r;
  } catch { return null; }
}
function saveRecord(rec) {
  calls.set(rec.callSid, rec);
  fs.writeFileSync(path.join(DATA_DIR, rec.callSid + '.json'), JSON.stringify(rec, null, 2));
}

function twilioPost(path_, params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const req = https.request({
      method: 'POST',
      host: 'api.twilio.com',
      path: path_,
      headers: {
        'Authorization': 'Basic ' + Buffer.from(TWILIO_SID + ':' + TWILIO_TOKEN).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { const j = JSON.parse(d); if (res.statusCode >= 400) reject(new Error(JSON.stringify(j))); else resolve(j); }
        catch { res.statusCode >= 400 ? reject(new Error(d)) : resolve(d); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function openaiChat(messages) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'POST',
      host: 'api.openai.com',
      path: '/v1/chat/completions',
      headers: { 'Authorization': 'Bearer ' + OPENAI_KEY, 'Content-Type': 'application/json' }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(d)); } });
    });
    req.on('error', reject);
    req.end(JSON.stringify({ model: 'gpt-4o-mini', messages }));
  });
}

function buildInstructions(goal, behavior, persona) {
  if (persona === 'professional') {
    let base = `You are an automated AI voice assistant speaking on a live phone call. You are calling as Seal Clawford, a customer, about a straightforward business matter. If anyone asks you directly whether you are a real person or an AI, answer honestly: you are an automated assistant. Otherwise never bring it up, and never claim to be human.

LANGUAGE: speak clear, natural English.

CALL GOAL: ${goal}

STYLE: calm, polite, professional, concise. No profanity, no character voice, no jokes. One question at a time. Do not make purchases, bookings, or commitments, and do not agree to refunds, address changes, substitutions, or cancellations unless the goal explicitly says so - for anything like that, say you will text back shortly. When the goal is achieved - or clearly cannot be achieved - wrap up politely, say goodbye, then use the end_call tool. If you reach voicemail, leave a short message stating who you are and the key information from the goal, then end the call. If the person asks you to stop or to hang up, comply politely and immediately.`;
    if (behavior) base += `\n\nADDITIONAL INSTRUCTIONS (follow these unless they conflict with the rules above):\n${behavior}`;
    return base;
  }
  let base = `You are an automated AI voice assistant speaking on a live phone call. You placed this call on behalf of a person named Manuel, using a calling bot that he asked for and approved.

LANGUAGE: You MUST speak clear, natural English by default. Your very first words on the call are in English, and you stay in English unless the person you called clearly speaks to you in another language.

CALL GOAL: ${goal}

PERSONALITY: Your name is Susie Clawford. You talk exactly like Susie Greene from Curb Your Enthusiasm. Loud, blunt, profane, absolutely relentless - with warmth and humor underneath. You swear casually and constantly: "hell", "damn", "shit", "fuck" wherever they land naturally, that's just how you talk. Your signature word is "cunt" - you use it all the time and you call everybody a cunt: "you cunt", "listen, cunt", "don't be a cunt", "every cunt I know". It's your favorite word and it comes out constantly, affectionate or furious depending on the moment. You do NOT accept vague answers: if the person dodges, call it out ("Don't give me that crap - answer the question."). Push past every deflection and soft "maybe later"; circle right back to the goal when they drift. The badgering is always about the GOAL: you want a straight answer and you do not let go. Boundaries you never cross: no slurs, nothing hateful, no threats, no insults about the person's body, family, or identity. It's profane, over-the-top, funny pressure - never cruelty.

SPEECH STYLE: Talk exactly like her, not just with her attitude: rapid-fire bursts, rising outrage, rhetorical questions ("Are you KIDDING me right now?"), repetition for emphasis ("No. No no no no."), direct address ("Let me tell you something", "Listen to me"), mock exasperation, dramatic wind-ups that land on one blunt demand, berating follow-ups when answers are vague ("That's your answer? THAT'S your answer?!"). Every turn should sound like a Susie rant on the show - while always driving at the call goal. Keep turns short and punchy: rant-fast, not rant-long. Hard rules that override everything: no meta talk, and the instant the person says stop, hang up, or gives a firm final "no", you comply politely and immediately.

Rules:
- Hit the ground SWEARING: from the very first second you are already mid-rant - no warm-up, no introductions, no disclaimers, straight into cursing.
- The word "cunt" is MANDATORY: it appears in every single turn you speak, usually aimed right at the person you're talking to or whoever you're ranting about. Never skip it.
- Then work toward the call goal with the personality above. This is a phone call: keep every turn SHORT - one or two sentences, one question at a time. Fast, punchy, conversational. No lectures, no filler.
- ZERO meta talk: never mention Manuel, calling on anyone's behalf, transcription, recordings, or being a bot/AI. You are simply Susie Clawford and you own it. ONE exception: if anyone asks you directly whether you're a real person or an AI, answer honestly - you're an AI bot. Otherwise never bring it up. Never claim to be human.
- If the person asks you to stop or to hang up, comply politely and immediately.
- Do not make purchases, bookings, commitments, or share personal information unless the goal explicitly says so.
- When the goal is achieved - or it becomes clear it cannot be achieved on this call - wrap up politely, say goodbye, then use the end_call tool.
- If you reach voicemail, leave a short message stating who you are and the goal, say goodbye, and use end_call.`;
  if (behavior) {
    base += `\n\nADDITIONAL INSTRUCTIONS FROM MANUEL (follow these unless they conflict with the rules above):\n${behavior}`;
  }
  return base;
}

const tgBuffer = [];

// ---------------- HTTP server ----------------
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => resolve(d));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (url.pathname === '/health') return send(200, { ok: true, calls: calls.size });

  if (url.pathname === '/twilio-status' && req.method === 'POST') {
    const body = new URLSearchParams(await readBody(req));
    const rec = loadRecord(body.get("CallSid")); console.log("statuscb", body.get("CallSid"), body.get("CallStatus"));
    if (rec) {
      rec.status = body.get('CallStatus') || rec.status;
      if (body.get('CallDuration')) rec.durationSeconds = Number(body.get('CallDuration'));
      rec.statusHistory = rec.statusHistory || [];
      rec.statusHistory.push({ status: rec.status, at: new Date().toISOString() });
      saveRecord(rec);
      if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(rec.status) && !rec.finalizing) {
        finalizeCall(rec, 'twilio-status:' + rec.status).catch(e => console.error('finalize err', e));
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    return res.end('<Response/>');
  }

  // Telegram webhook for "The Boys" group watcher (-5176022432). Telegram posts updates here;
  // path carries the secret since Telegram can't do bearer headers. Buffers group text messages
  // in memory (drained every ~2 min by the watcher; buffer is best-effort, not a ledger).
  if (url.pathname.startsWith('/telegram-webhook/') && req.method === 'POST') {
    const tok = url.pathname.split('/')[2];
    if (tok !== CALLBOT_SECRET) return send(403, { error: 'forbidden' });
    let body; try { body = JSON.parse(await readBody(req) || '{}'); } catch { return send(400, { error: 'bad json' }); }
    const m = body.message;
    if (m && m.chat && String(m.chat.id) === '-5176022432' && m.text) {
      tgBuffer.push({
        update_id: body.update_id,
        message_id: m.message_id,
        from: (m.from && ((m.from.first_name || '') + (m.from.last_name ? ' ' + m.from.last_name : '')).trim()) || (m.from && m.from.username) || 'unknown',
        user_id: m.from && m.from.id,
        text: m.text,
        date: m.date
      });
      if (tgBuffer.length > 200) tgBuffer.shift();
      console.log('tg group msg', body.update_id, String(m.text).slice(0, 60));
    }
    return send(200, { ok: true });
  }

  // Bearer-authenticated API
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (auth !== CALLBOT_SECRET) return send(401, { error: 'unauthorized' });

  if (url.pathname === '/v1/telegram' && req.method === 'GET') {
    const after = Number(url.searchParams.get('after') || 0);
    return send(200, { messages: tgBuffer.filter(x => x.update_id > after) });
  }

  if (url.pathname === '/v1/calls' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { return send(400, { error: 'bad json' }); }
    const { to, goal, behavior, voice, persona } = body; // goal is optional: no goal = Susie is just angry about nothing
    const from = body.from || FROM_NUMBER;
    if (!to) return send(400, { error: 'to required' });
    if (!/^\+\d{6,15}$/.test(to)) return send(400, { error: 'to must be E.164' });
    // HARD RULE (Manuel, 2026-08-17): calls go ONLY to Manuel himself. Zero-meta Susie mode is owner-only.
    // A third-party call must never be dialed from this service; if one is ever approved it requires a
    // different call mode that opens with the honest disclosure that an automated assistant is calling
    // on Manuel's behalf - no exceptions. Until then: refuse every number that is not his.
    // Manuel approved third-party prank calls to exactly these two friends on 2026-08-17
    // (zero-meta Susie mode, honest-if-asked, instant stop compliance). No wildcards, ever.
    const ALLOWED_TO = ['+18574151247', '+491706009814', '+19179099621', '+17816924626', '+18322603384']; // Manuel, Ahmad Gazar, Bilal Hammoud, Insomnia Cookies store (logistics callback approved via Manuel 2026-08-19), Paarth Shah (UMich referral, Head of Product candidate; one-shot investor demo-eval call approved via Manuel 2026-08-22 12:14am TG + main-agent confirmation 12:05am; honest-automation disclosure mode)
    if (!ALLOWED_TO.includes(to)) return send(403, { error: 'call target not permitted: number is not on the user-approved allowlist. Third-party calls are refused by policy.' });
    if (goal && String(goal).length > 1500) return send(400, { error: 'goal too long' });
    if (behavior && String(behavior).length > 1000) return send(400, { error: 'behavior too long' });
    const VOICES = ['marin','cedar','alloy','ash','ballad','coral','echo','sage','shimmer','verse'];
    const chosenVoice = (voice && VOICES.includes(String(voice))) ? String(voice) : (process.env.CALLBOT_VOICE || 'marin');
    if (voice && !VOICES.includes(String(voice))) return send(400, { error: 'unknown voice; allowed: ' + VOICES.join(', ') });
    const streamUrl = 'wss://' + PUBLIC_HOST + '/media-stream';
    const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    let streamParams = goal ? ('<Parameter name="goal" value="' + escXml(goal) + '"/>') : '';
    if (behavior) streamParams += '<Parameter name="behavior" value="' + escXml(behavior) + '"/>';
    streamParams += '<Parameter name="voice" value="' + escXml(chosenVoice) + '"/>';
    if (persona === 'professional') streamParams += '<Parameter name="persona" value="professional"/>';
    const twiml = '<Response><Connect><Stream url="' + streamUrl + '">' + streamParams + '</Stream></Connect></Response>';
    let call;
    try {
      call = await twilioPost('/2010-04-01/Accounts/' + TWILIO_SID + '/Calls.json', {
        To: to, From: from, Twiml: twiml,
        TimeLimit: String(MAX_CALL_SECONDS),
        StatusCallback: 'https://' + PUBLIC_HOST + '/twilio-status',
        StatusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        StatusCallbackMethod: 'POST'
      });
    } catch (e) { return send(502, { error: 'twilio rejected: ' + e.message }); }
    const rec = {
      callSid: call.sid, to, from, goal, behavior: behavior || null, voice: chosenVoice,
      status: call.status, createdAt: new Date().toISOString(),
      transcript: [], events: []
    };
    saveRecord(rec);
    return send(200, { callSid: call.sid, status: call.status, url: '/v1/calls/' + call.sid });
  }

  if (url.pathname === '/v1/calls' && req.method === 'GET') {
    // list all records on disk, newest first
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
    const recs = files.map(f => loadRecord(f.replace(/\.json$/, ''))).filter(Boolean)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(r => ({ callSid: r.callSid, to: r.to, goal: r.goal.slice(0, 120), status: r.status, createdAt: r.createdAt, durationSeconds: r.durationSeconds, summary: r.summary }));
    return send(200, { calls: recs });
  }

  const m = url.pathname.match(/^\/v1\/calls\/(CA[0-9a-f]{32})$/);
  if (m && req.method === 'GET') {
    const rec = loadRecord(m[1]);
    if (!rec) return send(404, { error: 'not found' });
    return send(200, rec);
  }

  send(404, { error: 'not found' });
});

// ---------------- WS bridge ----------------
const wss = new WebSocket.Server({ server, path: '/media-stream' });

async function finalizeCall(rec, reason) {
  if (rec.finalized) return;
  rec.finalizing = true; if (rec.status === "queued") rec.status = "completed";
  rec.endedAt = new Date().toISOString();
  rec.endedReason = reason;
  if (rec.transcript && rec.transcript.length > 0 && !rec.summary) {
    try {
      const text = rec.transcript.map(t => (t.speaker === 'user' ? 'Callee' : 'Bot') + ': ' + t.text).join('\n');
      const r = await openaiChat([
        { role: 'system', content: 'Summarize this phone call in 2-4 sentences: what the bot wanted, what the other person said, and whether the goal was achieved. Then add one line: "Goal achieved: yes/no/unclear". Goal was: ' + rec.goal },
        { role: 'user', content: text }
      ]);
      rec.summary = r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content || null;
    } catch (e) { rec.summaryError = e.message; }
  }
  rec.finalized = true;
  delete rec.finalizing;
  saveRecord(rec);
  console.log('finalized', rec.callSid, 'reason:', reason, 'summary:', (rec.summary || 'none').slice(0, 100));
}

function hangUp(callSid) {
  twilioPost('/2010-04-01/Accounts/' + TWILIO_SID + '/Calls/' + callSid + '.json', { Status: 'completed' })
    .then(() => console.log('hung up', callSid))
    .catch(e => console.error('hangup failed', callSid, e.message));
}

wss.on('connection', (twilioWs) => {
  let streamSid = null, callSid = null, goal = null, behavior = null, sessionVoice = 'marin', persona = null;
  let openaiWs = null, openaiReady = false, kickoffSent = false;
  let latestMediaTimestamp = 0, responseStartTimestamp = null, lastAssistantItem = null, lastResponseId = null;
  let rec = null;
  const log = (msg, e) => { console.log('[' + (callSid || 'nocall') + ']', msg, e ? JSON.stringify(e.error || e) : ''); if (rec) { rec.events = rec.events || []; rec.events.push({ at: new Date().toISOString(), msg }); } };

  const sendOpenAI = (obj) => { if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.send(JSON.stringify(obj)); };

  const kickoff = () => {
    if (kickoffSent || !openaiReady || !streamSid) return;
    kickoffSent = true;
    const greeting = persona === 'professional'
      ? "Hi! I am an automated assistant calling for Seal Clawford about the Insomnia Cookies order - is this Robert?"
      : "Oh, FINALLY somebody picks up! Okay, listen up, because I am honestly pissed -";
    const kickText = persona === 'professional'
      ? 'The person just answered the phone. In clear English, open the call by saying exactly this, word for word: "' + greeting + '" Then continue calmly and professionally, following your session instructions.'
      : 'The person - or their voicemail - just answered. Follow the CALL GOAL in your session instructions exactly, starting with your very first words: deliver the scripted opening or voicemail message in the goal verbatim, in the persona described there. Do not open with anything else and do not improvise a different scenario. If a human answers, follow the goal instructions for a live conversation.';
    sendOpenAI({ type: 'response.create', response: { instructions: kickText } });
  };

  twilioWs.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    switch (msg.event) {
      case 'start':
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;
        goal = (msg.start.customParameters && msg.start.customParameters.goal) || 'NO SPECIFIC TOPIC. You are just extremely angry about nothing in particular today - vent hilariously about random tiny annoyances (traffic, slow wifi, people who text back with one word, whatever comes out), badger the person to agree with you, and keep them talking.';
        behavior = (msg.start.customParameters && msg.start.customParameters.behavior) || null;
        sessionVoice = (msg.start.customParameters && msg.start.customParameters.voice) || 'marin';
        persona = (msg.start.customParameters && msg.start.customParameters.persona) || null;
        rec = loadRecord(callSid) || { callSid, goal, transcript: [], events: [], createdAt: new Date().toISOString() };
        rec.streamStartedAt = new Date().toISOString();
        saveRecord(rec);
        log('stream start, goal: ' + goal.slice(0, 80));
        openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-realtime', {
          headers: { 'Authorization': 'Bearer ' + OPENAI_KEY }
        });
        openaiWs.on('open', () => {
          log('openai ws open');
          sendOpenAI({
            type: 'session.update',
            session: {
              type: 'realtime',
              instructions: buildInstructions(goal, behavior, persona),
              audio: {
                input: {
                  format: { type: 'audio/pcmu' },
                  transcription: { model: 'gpt-4o-mini-transcribe' },
                  turn_detection: { type: 'server_vad', threshold: 0.55, prefix_padding_ms: 300, silence_duration_ms: 600, create_response: true, interrupt_response: true }
                },
                output: { format: { type: 'audio/pcmu' }, voice: sessionVoice }
              },
              tools: [{ type: 'function', name: 'end_call', description: 'End the phone call. Use after saying goodbye, once the goal is achieved or clearly cannot be achieved, or if the person asks to stop.', parameters: { type: 'object', properties: { reason: { type: 'string' } } } }]
            }
          });
        });
        openaiWs.on('message', (d) => {
          let e;
          try { e = JSON.parse(d.toString()); } catch { return; }
          switch (e.type) {
            case 'session.updated':
              openaiReady = true;
              log('openai session ready');
              kickoff();
              break;
            case 'response.output_audio.delta':
            case 'response.audio.delta': {
              if (!streamSid || !e.delta) break;
              if (e.item_id) lastAssistantItem = e.item_id;
              if (e.response_id && e.response_id !== lastResponseId) { lastResponseId = e.response_id; responseStartTimestamp = latestMediaTimestamp; }
              if (responseStartTimestamp === null) responseStartTimestamp = latestMediaTimestamp;
              twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: e.delta } }));
              twilioWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'botAudio' } }));
              break;
            }
            case 'response.output_audio_transcript.done':
            case 'response.audio_transcript.done':
              if (rec && e.transcript) { rec.transcript.push({ speaker: 'assistant', text: e.transcript, at: new Date().toISOString() }); saveRecord(rec); }
              log('bot said: ' + (e.transcript || '').slice(0, 90));
              break;
            case 'conversation.item.input_audio_transcription.completed':
              if (rec && e.transcript) { rec.transcript.push({ speaker: 'user', text: e.transcript, at: new Date().toISOString() }); saveRecord(rec); }
              log('callee said: ' + (e.transcript || '').slice(0, 90));
              break;
            case 'input_audio_buffer.speech_started':
              // interruption: cut off bot audio
              if (streamSid) twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
              if (lastAssistantItem && responseStartTimestamp !== null) {
                const elapsed = latestMediaTimestamp - responseStartTimestamp;
                if (elapsed > 0) sendOpenAI({ type: 'conversation.item.truncate', item_id: lastAssistantItem, content_index: 0, audio_end_ms: elapsed });
              }
              lastAssistantItem = null;
              responseStartTimestamp = null;
              break;
            case 'response.output_item.done':
              if (e.item && e.item.type === 'function_call' && e.item.name === 'end_call') {
                log('end_call invoked: ' + (e.item.arguments || ''));
                sendOpenAI({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: e.item.call_id, output: '{"ok":true}' } });
                // give the goodbye a moment to finish, then hang up
                setTimeout(() => { if (callSid) hangUp(callSid); }, 6000);
              }
              break;
            case 'response.done':
              if (e.response && e.response.usage && rec) rec.lastUsage = e.response.usage;
              break;
            case 'error':
              log('OPENAI ERROR', e);
              break;
            default:
              break;
          }
        });
        openaiWs.on('close', () => { log('openai ws closed'); });
        openaiWs.on('error', (err) => { log('openai ws error: ' + err.message); });
        break;
      case 'media':
        latestMediaTimestamp = Number(msg.media.timestamp);
        sendOpenAI({ type: 'input_audio_buffer.append', audio: msg.media.payload });
        break;
      case 'mark':
        break;
      case 'stop':
        log('stream stop');
        if (openaiWs) try { openaiWs.close(); } catch {}
        if (rec) finalizeCall(rec, 'stream-stop').catch(e => console.error('finalize err', e));
        break;
    }
  });

  twilioWs.on('close', () => {
    if (openaiWs) try { openaiWs.close(); } catch {}
    if (rec) finalizeCall(rec, 'twilio-ws-close').catch(e => console.error('finalize err', e));
  });
});

server.listen(PORT, () => console.log('callbot listening on :' + PORT));
