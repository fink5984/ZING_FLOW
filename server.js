'use strict';

require('dotenv').config();

const express    = require('express');
const flowRoutes = require('./src/routes/flow');

const app = express();
app.use(express.json());

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/flow', flowRoutes);

app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅  Zing WhatsApp Flow server running on port ${PORT}`);
  console.log(`   POST /flow/endpoint  – WhatsApp Flow encrypted endpoint`);
  console.log(`   POST /flow/session   – Register phone ↔ flow_token`);
  console.log(`   POST /flow/send      – Send flow message to a user`);
  console.log(`   GET  /health         – Health check`);
});
