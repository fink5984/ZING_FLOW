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

function cdnImg(images) {
  return images?.cdnMedium || images?.cdnSmall || images?.cdnLarge || '';
}

function displayName(obj) {
  return obj?.heName || obj?.enName || '';
}

function artistItem(a) {
  return {
    id:          String(a.id),
    title:       displayName(a),
    description: (a.enName !== a.heName && a.enName) ? a.enName : undefined,
  };
}

function albumItem(a) {
  const year = a.releasedAt ? String(new Date(a.releasedAt).getFullYear()) : '';
  return {
    id:          String(a.id),
    title:       displayName(a),
    description: year || undefined,
  };
}

function trackItem(t, index) {
  const dur = fmtDuration(t.duration);
  return {
    id:          String(t.id),
    title:       `${index + 1}. ${displayName(t)}`,
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
  switch (currentScreen) {

    // ── 1. Search → return artist list ──────────────────────────────────────
    case 'SEARCH': {
      const query   = (payload.artist_search || '').trim();
      const all     = await getAllArtists(query);
      const display = all.slice(0, 50);                // cap for Flow UI

      setSession(flowToken, { artists: display });

      const subtitle = all.length > 50
        ? `מוצגים 50 מתוך ${all.length} אמנים — צמצם את החיפוש לתוצאות נוספות`
        : `נמצאו ${all.length} אמנים`;

      return screen('ARTIST_LIST', {
        artists:  display.map(artistItem),
        subtitle,
      });
    }

    // ── 2. Artist selected → return albums ──────────────────────────────────
    case 'ARTIST_LIST': {
      const artistId = payload.selected_artist;
      if (!artistId) return screen('SEARCH', {});

      const data   = await getArtistAlbums(artistId);
      const artist = data.artist;

      // Combine main albums + featured albums, deduplicate
      const seen   = new Set();
      const albums = [...(artist.featuredAlbums || []), ...(data.albums || [])].filter(a => {
        if (seen.has(a.id)) return false;
        seen.add(a.id);
        return true;
      });

      setSession(flowToken, {
        artistId,
        artistName:  displayName(artist),
        artistImage: cdnImg(artist.images),
        albums,
      });

      return screen('ARTIST_ALBUMS', {
        artist_name:  displayName(artist),
        artist_image: cdnImg(artist.images),
        albums:       albums.map(albumItem),
      });
    }

    // ── 3. Album selected → return tracks ───────────────────────────────────
    case 'ARTIST_ALBUMS': {
      const albumId = payload.selected_album;
      if (!albumId) return screen('SEARCH', {});

      const album = await getAlbumDetail(albumId);

      setSession(flowToken, {
        albumId,
        albumName:  displayName(album),
        albumImage: cdnImg(album.images),
        albumTracks: album.tracks || [],
      });

      // Prepend a "Download all" pseudo-track at the top
      const trackItems = [
        { id: '__download_all__', title: '⬇️ הורד את כל האלבום', description: `${(album.tracks || []).length} שירים` },
        ...(album.tracks || []).map(trackItem),
      ];

      return screen('ALBUM_TRACKS', {
        album_name:  displayName(album),
        album_image: cdnImg(album.images),
        album_id:    String(albumId),
        tracks:      trackItems,
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
