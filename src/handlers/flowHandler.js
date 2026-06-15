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

function cdnImg(images) {
  const candidates = [
    images?.small, images?.medium, images?.large,
    images?.cdnSmall, images?.cdnMedium, images?.cdnLarge,
  ].filter(Boolean);

  // Prefer URLs with a known image extension
  const raw = candidates.find(isImageUrl) || candidates[0] || null;
  if (!raw) return '';

  // If URL already contains percent-encoded chars, don't re-encode.
  // Otherwise encode non-ASCII (e.g. raw Hebrew) with encodeURI.
  let safeUrl;
  try {
    safeUrl = raw.includes('%') ? raw : encodeURI(raw);
  } catch {
    safeUrl = raw;
  }

  // Proxy through our server so WhatsApp can always fetch the image.
  const base = (process.env.BASE_URL || '').replace(/\/$/, '');
  if (base) {
    return `${base}/flow/img?u=${encodeURIComponent(safeUrl)}`;
  }
  return safeUrl;
}

function logImg(context, url) {
  // Log full URL (no truncation) so we can diagnose
  console.log(`[handler] img(${context}):`, url || 'null');
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

function artistItem(a, idx) {
  const img = cdnImg(a.images);
  logImg(`artist:${a.id}`, img);

  // TEST: The FIRST artist always gets our own /flow/t.png so we can verify
  // whether WhatsApp's WebView can load any image from our Railway domain at all.
  // If a red dot appears next to the first artist but not the others → domain works,
  // the problem is the proxy URL format. Remove this once images are confirmed working.
  const base = (process.env.BASE_URL || '').replace(/\/$/, '');
  const testImg = idx === 0 && base ? `${base}/flow/t.png` : img;

  const item = {
    id:          String(a.id),
    title:       displayName(a),
    description: (a.enName && a.enName !== a.heName) ? a.enName : undefined,
  };
  if (testImg) item.image = testImg;
  return item;
}

/** type: 'album' | 'single' */
function albumItem(a, type) {
  const year      = a.releasedAt ? String(new Date(a.releasedAt).getFullYear()) : '';
  const img       = cdnImg(a.images);
  const typeLabel = type === 'single' ? 'סינגל' : 'אלבום';
  logImg(`album:${a.id}`, img);
  const item = {
    id:          String(a.id),
    title:       displayName(a),
    description: [typeLabel, year].filter(Boolean).join(' | ') || undefined,
  };
  if (img) item.image = img;
  return item;
}

function trackItem(t) {
  const dur = fmtDuration(t.duration);
  const img = cdnImg(t.album?.images) || cdnImg(t.images);
  const item = {
    id:          String(t.id),
    title:       displayName(t),
    description: dur || undefined,
  };
  if (img) item.image = img;
  return item;
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
      const display = sorted.slice(0, 50);

      setSession(flowToken, { artists: display });

      const subtitle = all.length > 50
        ? `מוצגים 50 מתוך ${all.length} אמנים — צמצם את החיפוש`
        : `נמצאו ${all.length} אמנים`;

      return screen('ARTIST_LIST', {
        artists:  display.map((a, i) => artistItem(a, i)),
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

      const displayAlbums = [
        ...sortedAlb.map(a => albumItem(a, 'album')),
        ...sortedSng.map(a => albumItem(a, 'single')),
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
      const albumImg   = cdnImg(album.images);
      const dlItem = {
        id:          '__download_all__',
        title:       '⬇️ הורד את כל האלבום',
        description: `${sortedTracks.length} שירים`,
      };
      if (albumImg) dlItem.image = albumImg;

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
