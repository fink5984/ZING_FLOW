'use strict';

const express = require('express');
const axios   = require('axios');
const { decryptRequest, encryptResponse }        = require('../crypto/flowCrypto');
const { handleInit, handlePing, handleDataExchange, setSession } = require('../handlers/flowHandler');
const { sendTextMessage }                        = require('../whatsapp/sendMessage');

const router = express.Router();

// Normalise PEM: env stores \n as literal backslash-n
const PRIVATE_KEY = (process.env.FLOW_PRIVATE_KEY || '').replace(/\\n/g, '\n');

// ─── POST /flow/endpoint  (WhatsApp Flow encrypted endpoint) ─────────────────

router.post('/endpoint', async (req, res) => {
  const body = req.body;

  // ── Unencrypted health-check ping (Meta Flow Builder endpoint checker) ──────
  // Meta sends a plain-text JSON ping when validating the endpoint URI.
  // Must respond with plain JSON – NOT encrypted.
  if (!body.encrypted_aes_key) {
    if (body.action === 'ping') {
      return res.json({ data: { status: 'active' } });
    }
    return res.status(400).json({ error: 'Missing encrypted fields' });
  }

  // ── Encrypted request ────────────────────────────────────────────────────────
  try {
    const { body: flowBody, aesKey, initialVector } = decryptRequest(body, PRIVATE_KEY);
    const { action, flow_token, screen, data } = flowBody;

    console.log(`[endpoint] action=${action} | screen=${screen || '-'} | token=${String(flow_token).substring(0, 20)}`);

    let responseData;

    if (action === 'ping') {
      responseData = await handlePing();

    } else if (action === 'INIT') {
      responseData = await handleInit(flow_token);

    } else if (action === 'data_exchange') {
      if (data?.phone) {
        setSession(flow_token, { phone: data.phone });
      }
      responseData = await handleDataExchange(flow_token, screen, data || {});

    } else {
      console.warn(`[endpoint] unknown action: ${action}`);
      responseData = { version: '3.0', screen: 'SEARCH', data: {} };
    }

    console.log(`[endpoint] responding → screen=${responseData?.screen || '?'}`);

    // Meta endpoint checker expects plain Base64 text body.
    // The WhatsApp Flow client (production) also accepts this format.
    const encrypted = encryptResponse(responseData, aesKey, initialVector);
    res.set('Content-Type', 'text/plain');
    return res.send(encrypted);

  } catch (err) {
    console.error('[endpoint] ERROR:', err.stack || err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ─── POST /flow/session  (register phone ↔ flow_token before sending the flow)

router.post('/session', (req, res) => {
  const { flow_token, phone } = req.body;
  if (!flow_token || !phone) {
    return res.status(400).json({ error: 'flow_token and phone are required' });
  }
  setSession(flow_token, { phone });
  res.json({ ok: true });
});

// ─── POST /flow/start  ──────────────────────────────────────────────────────
// Simplest way to send the flow to a user.
// Body: { "phone": "972501234567" }
// flow_id is read from FLOW_ID env variable.
//
// Optional fields:
//   flow_token : custom token (defaults to the phone number)
//   cta_text   : button label (default: "פתח")
//   body_text  : message body text

async function sendFlowToPhone({ phone, flow_token, cta_text, body_text }) {
  const flowId = process.env.FLOW_ID;
  if (!flowId) throw new Error('FLOW_ID is not set in environment variables');

  const token = flow_token || phone;

  // Pre-register the session so audio delivery works later
  setSession(token, { phone });

  const axios = require('axios');
  const { data } = await axios.post(
    `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'interactive',
      interactive: {
        type: 'flow',
        body:   { text: body_text || 'ברוך הבא ל-Zing Music 🎵 חפש את האמן האהוב עליך' },
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            flow_token:           token,
            flow_id:              flowId,
            flow_cta:             cta_text || 'פתח',
            flow_action:          'navigate',
            flow_action_payload:  { screen: 'SEARCH' },
          },
        },
      },
    },
    {
      headers: {
        Authorization:  `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
    },
  );

  return { ok: true, message_id: data.messages?.[0]?.id, flow_token: token };
}

router.post('/start', async (req, res) => {
  const phone = req.body.phone || req.body.to;
  if (!phone) {
    return res.status(400).json({ error: '"phone" is required' });
  }
  try {
    const result = await sendFlowToPhone({
      phone,
      flow_token: req.body.flow_token,
      cta_text:   req.body.cta_text,
      body_text:  req.body.body_text,
    });
    res.json(result);
  } catch (err) {
    console.error('[/flow/start]', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ─── POST /flow/send  (backward-compatible alias) ────────────────────────────

router.post('/send', async (req, res) => {
  const phone = req.body.to || req.body.phone;
  if (!phone) {
    return res.status(400).json({ error: '"to" or "phone" is required' });
  }
  try {
    const result = await sendFlowToPhone({
      phone,
      flow_token: req.body.flow_token,
      cta_text:   req.body.cta_text,
      body_text:  req.body.body_text,
    });
    res.json(result);
  } catch (err) {
    console.error('[/flow/send]', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ─── GET /flow/img  (image proxy so WhatsApp can load jewishmusic.fm images) ─
// WhatsApp's servers may be blocked by jewishmusic.fm.
// We proxy the image through our Railway server which is publicly accessible.
//
// Security: only proxies images from the two allowed domains.

const PROXY_ALLOW = ['jewishmusic.fm', 'd3t3ozftmdmh3i.cloudfront.net'];

router.get('/img', async (req, res) => {
  const rawUrl = req.query.u;
  if (!rawUrl) return res.status(400).end();

  let targetUrl;
  try { targetUrl = decodeURIComponent(rawUrl); } catch { return res.status(400).end(); }

  // Security: only allow the two permitted hosts
  let host;
  try { host = new URL(targetUrl).hostname; } catch { return res.status(400).end(); }
  if (!PROXY_ALLOW.some(h => host === h || host.endsWith('.' + h))) {
    return res.status(403).end();
  }

  try {
    const upstream = await axios.get(targetUrl, {
      responseType: 'stream',
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    res.set('Content-Type',  upstream.headers['content-type']  || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');  // cache 24 h
    upstream.data.pipe(res);
  } catch (err) {
    console.error('[img proxy] error:', err.message);
    res.status(502).end();
  }
});

// ─── GET /flow/img  (image proxy so WhatsApp can load jewishmusic.fm images) ─
// WhatsApp's servers may be blocked by jewishmusic.fm.
// We proxy the image through our Railway server which is publicly accessible.
//
// Security: only proxies images from the two allowed domains.

const PROXY_ALLOW = ['jewishmusic.fm', 'd3t3ozftmdmh3i.cloudfront.net'];

router.get('/img', async (req, res) => {
  const rawUrl = req.query.u;
  if (!rawUrl) return res.status(400).end();

  let targetUrl;
  try { targetUrl = decodeURIComponent(rawUrl); } catch { return res.status(400).end(); }

  // Security: only allow the two permitted hosts
  let host;
  try { host = new URL(targetUrl).hostname; } catch { return res.status(400).end(); }
  if (!PROXY_ALLOW.some(h => host === h || host.endsWith('.' + h))) {
    return res.status(403).end();
  }

  try {
    const upstream = await axios.get(targetUrl, {
      responseType: 'stream',
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    res.set('Content-Type',  upstream.headers['content-type']  || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');  // cache 24 h
    upstream.data.pipe(res);
  } catch (err) {
    console.error('[img proxy] error:', err.message);
    res.status(502).end();
  }
});

module.exports = router;
