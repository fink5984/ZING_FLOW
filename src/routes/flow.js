'use strict';

const express = require('express');
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
      responseData = { version: '3.0', screen: 'SEARCH', data: {} };
    }

    // Meta expects the response body to be the raw Base64 string (not JSON).
    const encrypted = encryptResponse(responseData, aesKey, initialVector);
    res.set('Content-Type', 'text/plain');
    return res.send(encrypted);

  } catch (err) {
    console.error('[/flow/endpoint]', err.message);
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

// ─── POST /flow/send  (send flow message to a WhatsApp user) ─────────────────
//
// Body: { to: "972501234567", flow_id: "123456789", flow_token: "unique-id" }
// The server pre-registers the session so audio delivery works later.

router.post('/send', async (req, res) => {
  const { to, flow_id, flow_token, cta_text } = req.body;
  if (!to || !flow_id) {
    return res.status(400).json({ error: 'to and flow_id are required' });
  }

  const token = flow_token || to;   // default: use phone as token
  setSession(token, { phone: to });

  try {
    const axios = require('axios');
    const { data } = await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'flow',
          body:   { text: 'ברוך הבא ל-Zing Music 🎵 חפש את האמן האהוב עליך' },
          action: {
            name: 'flow',
            parameters: {
              flow_message_version: '3',
              flow_token:           token,
              flow_id,
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
    res.json({ ok: true, message_id: data.messages?.[0]?.id });
  } catch (err) {
    console.error('[/flow/send]', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

module.exports = router;
