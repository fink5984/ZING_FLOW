'use strict';

/**
 * Flow Handler – maps incoming WhatsApp Flow actions/screens to
 * API calls and returns the correct next-screen response.
 *
 * Session store:
 *   Key   : flow_token (set by the business when sending the flow)
 *   Value : { phone, artistId, albumId, albumTracks, expiresAt }
 *
 * Tip: when sending the flow from your WhatsApp Business API, set
 *   flow_token = user's WhatsApp phone number (e.g. "972501234567")
 * so the server always knows who to send audio files to.
 */

const axios = require('axios');
const { getAllArtists, getArtistAlbums, getAlbumDetail } = require('../api/zingApi');
const { sendTrackToUser, sendAlbumToUser }               = require('../whatsapp/sendMessage');

// ─── In-memory session store ──────────────────────────────────────────────────

const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;   // 30 min

function cleanExpired() {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (v.expiresAt < now) sessions.delete(k);
  }
}

function getSession(token) {
  return sessions.get(token) || {};
}

function setSession(token, data) {
  cleanExpired();
  sessions.set(token, { ...getSession(token), ...data, expiresAt: Date.now() + SESSION_TTL_MS });
}

// Export so the route can pre-register phone ↔ flow_token mappings
module.exports.setSession = setSession;
module.exports.getSession = getSession;

// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmtDuration(seconds) {
  if (!seconds) return '';
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function isImageUrl(u) {
  return u && /\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(u);
}

/**
 * Returns the best (smallest) raw image URL from an API images object,
 * or null if none is available. No proxy — WhatsApp Flows requires Base64,
 * not a URL, for RadioButtonsGroup items.
 */
function cdnImg(images) {
  if (!images) return null;
  const candidates = [
    images.small, images.cdnSmall,
    images.medium, images.cdnMedium,
    images.large, images.cdnLarge,
  ].filter(isImageUrl);
  const raw = candidates[0] || null;
  if (!raw) return null;
  try {
    return raw.includes('%') ? raw : encodeURI(raw);
  } catch {
    return raw;
  }
}

// ─── Image fetch + Base64 cache ───────────────────────────────────────────────
// WhatsApp Flows RadioButtonsGroup requires `image` to be Base64-encoded image
// data, NOT a URL. We fetch images server-side and cache the Base64 result.

const _imgCache = new Map();
const IMG_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function fetchBase64(url) {
  if (!url) return null;
  const now = Date.now();
  const hit = _imgCache.get(url);
  if (hit && hit.exp > now) return hit.b64;
  try {
    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const b64 = Buffer.from(resp.data).toString('base64');
    _imgCache.set(url, { b64, exp: now + IMG_CACHE_TTL_MS });
    console.log(`[img] cached ${Math.round(resp.data.byteLength / 1024)}KB ← ${url.substring(0, 70)}`);
    return b64;
  } catch (err) {
    console.warn('[img] fetch failed:', err.message, '←', url.substring(0, 70));
    return null;
  }
}

/**
 * Fetch Base64 for an array of URLs in parallel, capped at `limit` items.
 * Returns an array of the same length (null for failures / skipped items).
 */
async function fetchAllBase64(urls, limit = 20) {
  const capped = urls.slice(0, limit);
  return Promise.all(capped.map(fetchBase64));
}

function displayName(obj) {
  return obj?.heName || obj?.enName || '';
}

/** Sort an array of API objects alphabetically by Hebrew then English name. */
function sortByName(items) {
  return [...items].sort((a, b) => {
    const na = (a.heName || a.enName || '').trim();
    const nb = (b.heName || b.enName || '').trim();
    return na.localeCompare(nb, ['he', 'en'], { sensitivity: 'base' });
  });
}

function artistItem(a, b64) {
  const item = {
    id:          String(a.id),
    title:       displayName(a),
    description: (a.enName && a.enName !== a.heName) ? a.enName : undefined,
  };
  if (b64) item.image = b64;
  return item;
}

/** type: 'album' | 'single' */
function albumItem(a, type, b64) {
  const year      = a.releasedAt ? String(new Date(a.releasedAt).getFullYear()) : '';
  const typeLabel = type === 'single' ? 'סינגל' : 'אלבום';
  const item = {
    id:          String(a.id),
    title:       displayName(a),
    description: [typeLabel, year].filter(Boolean).join(' | ') || undefined,
  };
  if (b64) item.image = b64;
  return item;
}

function trackItem(t) {
  const dur = fmtDuration(t.duration);
  // Track lists can be 30+ items; omitting images keeps the response small.
  return {
    id:          String(t.id),
    title:       displayName(t),
    description: dur || undefined,
  };
}

// ─── Screen response builders ─────────────────────────────────────────────────

const FLOW_VERSION = '3.0';

function screen(id, data) {
  return { version: FLOW_VERSION, screen: id, data };
}

// ─── Action handlers ──────────────────────────────────────────────────────────

async function handleInit(flowToken) {
  return screen('SEARCH', {});
}

async function handlePing() {
  return { data: { status: 'active' } };
}

async function handleDataExchange(flowToken, currentScreen, payload) {
  console.log(`[handler] screen=${currentScreen} | payload=${JSON.stringify(payload).substring(0, 150)}`);

  switch (currentScreen) {

    // ── 1. Search → return artist list ──────────────────────────────────────
    case 'SEARCH': {
      const query = (payload.artist_search || '').trim();
      console.log(`[handler] SEARCH query="${query}"`);
      let all = await getAllArtists(query);
      console.log(`[handler] SEARCH → found ${all.length} artists (server)`);

      // Fuzzy fallback: if server returns 0 and query has multiple words,
      // fetch everything and filter locally by each word separately.
      if (all.length === 0 && query.length > 0) {
        const words = query.split(/\s+/).filter(w => w.length >= 2);
        if (words.length > 0) {
          console.log(`[handler] SEARCH fuzzy fallback, words=${JSON.stringify(words)}`);
          const everything = await getAllArtists('');
          all = everything.filter(a => {
            const name = ((a.heName || '') + ' ' + (a.enName || '')).toLowerCase();
            return words.some(w => name.includes(w.toLowerCase()));
          });
          console.log(`[handler] SEARCH fuzzy → ${all.length} artists`);
        }
      }

      // No results at all → show friendly message item
      if (all.length === 0) {
        return screen('ARTIST_LIST', {
          artists: [{ id: '__no_results__', title: '🔍 לא נמצאו תוצאות', description: `נסה שם אחר (חיפשת: "${query}")` }],
          subtitle: 'לא נמצאו אמנים',
        });
      }

      const sorted  = sortByName(all);
      const MAX_ARTISTS = 20; // RadioButtonsGroup cap
      const display = sorted.slice(0, MAX_ARTISTS);

      setSession(flowToken, { artists: display });

      const subtitle = all.length > MAX_ARTISTS
        ? `מוצגים ${MAX_ARTISTS} מתוך ${all.length} אמנים — צמצם את החיפוש`
        : `נמצאו ${all.length} אמנים`;

      // Fetch images as Base64 in parallel (WhatsApp requires Base64, not URLs)
      const imgUrls = display.map(a => cdnImg(a.images));
      const b64s    = await fetchAllBase64(imgUrls, MAX_ARTISTS);

      return screen('ARTIST_LIST', {
        artists:  display.map((a, i) => artistItem(a, b64s[i])),
        subtitle,
      });
    }

    // ── 2. Artist selected → return albums ──────────────────────────────────
    case 'ARTIST_LIST': {
      const artistId = payload.selected_artist;
      console.log(`[handler] ARTIST_LIST → artistId=${artistId}`);
      // User clicked the "no results" pseudo-item → go back to SEARCH
      if (!artistId || artistId === '__no_results__') return screen('SEARCH', {});

      const data   = await getArtistAlbums(artistId);
      const artist = data.artist;
      console.log(`[handler] artist="${displayName(artist)}" albums=${data.albums?.length}`);

      // Combine main albums + featured albums, deduplicate
      const seen   = new Set();
      const allAlbums = [...(artist.featuredAlbums || []), ...(data.albums || [])].filter(a => {
        if (seen.has(a.id)) return false;
        seen.add(a.id);
        return true;
      });

      // Separate albums vs singles by albumType
      const regularAlbums = allAlbums.filter(a => a.albumType !== 'SINGLE');
      const singles       = allAlbums.filter(a => a.albumType === 'SINGLE');
      console.log(`[handler] albums=${regularAlbums.length} singles=${singles.length}`);

      // Sort each group alphabetically, cap combined at 50 to keep payload small
      const sortedAlb = sortByName(regularAlbums);
      const sortedSng = sortByName(singles);
      const MAX_ALBUMS = 50;
      const combined = [...sortedAlb, ...sortedSng].slice(0, MAX_ALBUMS);

      setSession(flowToken, {
        artistId,
        artistName: displayName(artist),
        albums:     combined,
      });

      const MAX_IMG = 20; // max images to fetch (RadioButtonsGroup cap)
      const combined20 = combined.slice(0, MAX_IMG);
      const imgUrls20  = combined20.map(a => cdnImg(a.images));
      const b64s20     = await fetchAllBase64(imgUrls20, MAX_IMG);

      const displayAlbums = [
        ...sortedAlb.map(a => {
          const idx = combined20.indexOf(a);
          return albumItem(a, 'album', idx >= 0 ? b64s20[idx] : null);
        }),
        ...sortedSng.map(a => {
          const idx = combined20.indexOf(a);
          return albumItem(a, 'single', idx >= 0 ? b64s20[idx] : null);
        }),
      ].slice(0, MAX_ALBUMS);

      return screen('ARTIST_ALBUMS', {
        artist_name: displayName(artist),
        albums:      displayAlbums,
      });
    }

    // ── 3. Album selected → return tracks ───────────────────────────────────
    case 'ARTIST_ALBUMS': {
      const albumId = payload.selected_album;
      console.log(`[handler] ARTIST_ALBUMS → albumId=${albumId}`);
      if (!albumId) return screen('SEARCH', {});

      const album = await getAlbumDetail(albumId);
      console.log(`[handler] album="${displayName(album)}" tracks=${album.tracks?.length}`);

      const sortedTracks = sortByName(album.tracks || []);

      setSession(flowToken, {
        albumId,
        albumName:   displayName(album),
        albumTracks: sortedTracks,
      });

      // Prepend a "Download all" pseudo-track at the top
      const albumImgUrl = cdnImg(album.images);
      const albumImgB64 = await fetchBase64(albumImgUrl);
      const dlItem = {
        id:          '__download_all__',
        title:       '⬇️ הורד את כל האלבום',
        description: `${sortedTracks.length} שירים`,
      };
      if (albumImgB64) dlItem.image = albumImgB64;

      const trackItems = [dlItem, ...sortedTracks.map(trackItem)];

      return screen('ALBUM_TRACKS', {
        album_name: displayName(album),
        album_id:   String(albumId),
        tracks:     trackItems,
      });
    }

    // ── 4. Track / download-all selected ────────────────────────────────────
    case 'ALBUM_TRACKS': {
      const { selected_track } = payload;
      const sess = getSession(flowToken);

      // Resolve phone: prefer session value, fallback to flow_token itself
      const userPhone = sess.phone || flowToken;

      if (!userPhone) {
        return screen('SUCCESS', { message: 'שגיאה: לא נמצא מספר טלפון.' });
      }

      if (selected_track === '__download_all__') {
        // Fire-and-forget: don't block the Flow response
        const tracks    = sess.albumTracks || [];
        const albumName = sess.albumName   || 'האלבום';
        sendAlbumToUser(userPhone, tracks, albumName).catch(console.error);

        return screen('SUCCESS', {
          message: `מתחיל להוריד את האלבום "${albumName}"...\nהשירים יגיעו כהודעות נפרדות בצ'אט 🎵`,
        });
      }

      if (selected_track) {
        const track     = (sess.albumTracks || []).find(t => String(t.id) === String(selected_track));
        const trackName = track ? displayName(track) : 'שיר';

        sendTrackToUser(userPhone, Number(selected_track), trackName).catch(console.error);

        return screen('SUCCESS', {
          message: `🎵 "${trackName}" ישלח אליך עוד רגע...`,
        });
      }

      return screen('SUCCESS', { message: 'לא נבחר שיר.' });
    }

    default:
      return screen('SEARCH', {});
  }
}

module.exports.handleInit         = handleInit;
module.exports.handlePing         = handlePing;
module.exports.handleDataExchange = handleDataExchange;
