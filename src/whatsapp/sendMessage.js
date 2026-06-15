'use strict';

/**
 * WhatsApp Cloud API – send messages to users.
 *
 * Used after a track/album is selected in the flow to deliver audio files.
 */

const axios    = require('axios');
const FormData = require('form-data');
const { downloadAudioStream } = require('../api/zingApi');

const GRAPH_BASE = 'https://graph.facebook.com/v19.0';

function authHeader() {
  return { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` };
}

// ─── Media upload ──────────────────────────────────────────────────────────────

/**
 * Upload a readable stream to WhatsApp Media API.
 * Returns the media_id.
 *
 * @param {import('stream').Readable} stream
 * @param {string} filename
 * @param {string} contentType  e.g. 'audio/mpeg'
 */
async function uploadMedia(stream, filename, contentType) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', stream, { filename, contentType });

  const { data } = await axios.post(
    `${GRAPH_BASE}/${process.env.PHONE_NUMBER_ID}/media`,
    form,
    {
      headers: {
        ...form.getHeaders(),
        ...authHeader(),
      },
      maxBodyLength: Infinity,
    },
  );

  return data.id;
}

// ─── Send helpers ──────────────────────────────────────────────────────────────

async function sendAudioMessage(to, mediaId) {
  await axios.post(
    `${GRAPH_BASE}/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type:  'audio',
      audio: { id: mediaId },
    },
    { headers: { ...authHeader(), 'Content-Type': 'application/json' } },
  );
}

async function sendTextMessage(to, text) {
  await axios.post(
    `${GRAPH_BASE}/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    },
    { headers: { ...authHeader(), 'Content-Type': 'application/json' } },
  );
}

// ─── High-level helpers ────────────────────────────────────────────────────────

/**
 * Download a track from Zing and forward it as a WhatsApp audio message.
 * Returns true on success, false on failure.
 */
async function sendTrackToUser(to, trackId, trackName) {
  try {
    const audioResp = await downloadAudioStream(trackId);
    const contentType = audioResp.headers['content-type'] || 'audio/mpeg';
    const safeFilename = `${trackName.replace(/[^\w\u0590-\u05fe -]/g, '_')}.mp3`;

    const mediaId = await uploadMedia(audioResp.data, safeFilename, contentType);
    await sendAudioMessage(to, mediaId);
    return true;
  } catch (err) {
    console.error(`[sendTrack] trackId=${trackId} error:`, err.message);
    return false;
  }
}

/**
 * Download every track of an album and send them one-by-one.
 * Sends a status text message when done.
 */
async function sendAlbumToUser(to, tracks, albumName) {
  await sendTextMessage(to, `⏬ מוריד את האלבום "${albumName}" (${tracks.length} שירים)...`);

  let sent = 0;
  for (const track of tracks) {
    const name = track.heName || track.enName || `Track ${track.id}`;
    const ok = await sendTrackToUser(to, track.id, name);
    if (ok) sent++;
  }

  await sendTextMessage(to, `✅ נשלחו ${sent} / ${tracks.length} שירים מהאלבום "${albumName}"`);
}

module.exports = { sendTrackToUser, sendAlbumToUser, sendTextMessage };
