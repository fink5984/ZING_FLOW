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
  try {
    const { body: flowBody, aesKey, initialVector } = decryptRequest(req.body, PRIVATE_KEY);
    const { action, flow_token, screen, data } = flowBody;

    let responseData;

    if (action === 'ping') {
      responseData = await handlePing();

    } else if (action === 'INIT') {
      responseData = await handleInit(flow_token);

    } else if (action === 'data_exchange') {
      // If the client embeds phone in payload (optional), store it
      if (data?.phone) {
        setSession(flow_token, { phone: data.phone });
      }
      responseData = await handleDataExchange(flow_token, screen, data || {});

    } else {
      responseData = { version: '3.0', screen: 'SEARCH', data: {} };
    }

    const encrypted = encryptResponse(responseData, aesKey, initialVector);
    return res.json({ encrypted_response: encrypted });

  } catch (err) {
    console.error('[/flow/endpoint]', err.message);
    // Must still respond 200 with an error screen so Meta doesn't retry forever
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
