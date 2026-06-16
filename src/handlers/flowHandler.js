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
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
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
async function fetchAllBase64(urls, limit = 50) {
  const capped = urls.slice(0, limit);
  return Promise.all(capped.map(fetchBase64));
}

// ─── Pagination helpers ───────────────────────────────────────────────────────

const PAGE_SIZE = 50;

/** Builds an array of chip items for page navigation (always >= 2 items).
 *  Each chip carries its own on-select-action so tapping it immediately
 *  sends a data_exchange to the server — no footer button needed.
 */
function makePageChips(total) {
  const n = Math.ceil(total / PAGE_SIZE);
  const chips = Array.from({ length: n }, (_, i) => ({
    id: String(i),
    title: String(i + 1),
    'on-select-action': {
      name: 'data_exchange',
      payload: { selected_page: String(i) },
    },
  }));
  // ChipsSelector requires min 2 items — pad with a disabled placeholder if only 1 page
  if (chips.length < 2) {
    chips.push({ id: '__end__', title: '·', enabled: false });
  }
  return chips;
}

function makeTypeChips() {
  return [
    {
      id: 'albums',
      title: '📀 אלבומים',
      'on-select-action': { name: 'data_exchange', payload: { selected_type: 'albums' } },
    },
    {
      id: 'singles',
      title: '🎵 סינגלים',
      'on-select-action': { name: 'data_exchange', payload: { selected_type: 'singles' } },
    },
  ];
}

/** Returns one page of artist items (Base64 images) — no nav items in the list. */
async function buildArtistPage(allArtists, page) {
  const start     = page * PAGE_SIZE;
  const pageItems = allArtists.slice(start, start + PAGE_SIZE);
  const b64s      = await fetchAllBase64(pageItems.map(a => cdnImg(a.images)), PAGE_SIZE);
  const items     = pageItems.map((a, i) => artistItem(a, b64s[i]));
  const total      = allArtists.length;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const subtitle   = totalPages > 1
    ? `עמוד ${page + 1} מתוך ${totalPages} | ${total} אמנים`
    : `נמצאו ${total} אמנים`;
  return {
    items,
    subtitle,
    page_chips: makePageChips(total),
    show_pager: totalPages >= 2,
  };
}

/** Returns one page of album items (Base64 images) — no nav items in the list. */
async function buildAlbumPage(allAlbums, page) {
  const start     = page * PAGE_SIZE;
  const pageItems = allAlbums.slice(start, start + PAGE_SIZE);
  const b64s      = await fetchAllBase64(pageItems.map(a => cdnImg(a.images)), PAGE_SIZE);
  const items     = pageItems.map((a, i) =>
    albumItem(a, a.albumType === 'SINGLE' ? 'single' : 'album', b64s[i])
  );
  const totalPages = Math.ceil(allAlbums.length / PAGE_SIZE);
  return {
    items,
    page_chips: makePageChips(allAlbums.length),
    show_pager: totalPages >= 2,
  };
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

function trackItem(t, b64) {
  const dur = fmtDuration(t.duration);
  const item = {
    id:          String(t.id),
    title:       displayName(t),
    description: dur || undefined,
  };
  if (b64) item.image = b64;
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

      const sorted = sortByName(all);
      setSession(flowToken, { allArtists: sorted, artistPage: 0 });

      const { items: artistItems, subtitle, page_chips, show_pager } = await buildArtistPage(sorted, 0);
      return screen('ARTIST_LIST', { artists: artistItems, subtitle, page_chips, show_pager });
    }

    // ── 2. Artist list navigation OR artist selected ────────────────────────
    case 'ARTIST_LIST': {
      const artistId = payload.selected_artist;
      console.log(`[handler] ARTIST_LIST → artistId=${artistId}`);

      // Pagination navigation (chip selected, no artist)
      if (!artistId || artistId === '__no_results__') {
        const chipRaw  = payload.selected_page;
        const chipArr  = Array.isArray(chipRaw) ? chipRaw : (chipRaw ? [chipRaw] : []);
        const chipPage = chipArr.filter(c => c !== '__end__').pop() ?? null;
        if (chipPage !== null) {
          const sess       = getSession(flowToken);
          const allArtists = sess.allArtists || [];
          const newPage    = Math.max(0, Math.min(Number(chipPage), Math.ceil(allArtists.length / PAGE_SIZE) - 1));
          setSession(flowToken, { artistPage: newPage });
          const { items: artistItems, subtitle, page_chips, show_pager } = await buildArtistPage(allArtists, newPage);
          return screen('ARTIST_LIST', { artists: artistItems, subtitle, page_chips, show_pager });
        }
        return screen('SEARCH', {});
      }

      const data   = await getArtistAlbums(artistId);
      const artist = data.artist;
      console.log(`[handler] artist="${displayName(artist)}" albums=${data.albums?.length}`);

      // Combine main albums + featured albums, deduplicate
      const seen = new Set();
      const deduped = [...(artist.featuredAlbums || []), ...(data.albums || [])].filter(a => {
        if (seen.has(a.id)) return false;
        seen.add(a.id);
        return true;
      });

      const sortedAlb = sortByName(deduped.filter(a => a.albumType !== 'SINGLE'));
      const sortedSng = sortByName(deduped.filter(a => a.albumType === 'SINGLE'));
      console.log(`[handler] albums=${sortedAlb.length} singles=${sortedSng.length}`);

      // Default: show albums if available, otherwise singles
      const defaultType = sortedAlb.length > 0 ? 'albums' : 'singles';
      const defaultList = defaultType === 'albums' ? sortedAlb : sortedSng;

      setSession(flowToken, {
        artistId,
        artistName:  displayName(artist),
        allAlbums:   sortedAlb,
        allSingles:  sortedSng,
        contentType: defaultType,
        albumPage:   0,
      });

      const { items: albumItems, page_chips, show_pager } = await buildAlbumPage(defaultList, 0);
      const show_type_selector = sortedAlb.length > 0 && sortedSng.length > 0;
      return screen('ARTIST_ALBUMS', {
        artist_name:       displayName(artist),
        albums:            albumItems,
        page_chips,
        show_pager,
        type_chips:        makeTypeChips(),
        show_type_selector,
        content_subtitle:  `${defaultList.length} ${defaultType === 'albums' ? 'אלבומים' : 'סינגלים'}`,
      });
    }

    // ── 3. Album list navigation OR album selected → return tracks ────────────
    case 'ARTIST_ALBUMS': {
      const albumId = payload.selected_album;
      console.log(`[handler] ARTIST_ALBUMS → albumId=${albumId}`);

      // No album selected — type switch or page navigation
      if (!albumId) {
        const sess = getSession(flowToken);

        // Type selection (albums ↔ singles)
        const typeRaw = payload.selected_type;
        const typeArr = Array.isArray(typeRaw) ? typeRaw : (typeRaw ? [typeRaw] : []);
        const selType = typeArr.pop() ?? null;
        if (selType === 'albums' || selType === 'singles') {
          const list = selType === 'albums' ? (sess.allAlbums || []) : (sess.allSingles || []);
          setSession(flowToken, { contentType: selType, albumPage: 0 });
          const { items: albumItems, page_chips, show_pager } = await buildAlbumPage(list, 0);
          const show_type_selector = (sess.allAlbums || []).length > 0 && (sess.allSingles || []).length > 0;
          return screen('ARTIST_ALBUMS', {
            artist_name:       sess.artistName || '',
            albums:            albumItems,
            page_chips,
            show_pager,
            type_chips:        makeTypeChips(),
            show_type_selector,
            content_subtitle:  `${list.length} ${selType === 'albums' ? 'אלבומים' : 'סינגלים'}`,
          });
        }

        // Page navigation
        const chipRaw  = payload.selected_page;
        const chipArr  = Array.isArray(chipRaw) ? chipRaw : (chipRaw ? [chipRaw] : []);
        const chipPage = chipArr.filter(c => c !== '__end__').pop() ?? null;
        if (chipPage !== null) {
          const contentType = sess.contentType || 'albums';
          const allList = contentType === 'singles' ? (sess.allSingles || []) : (sess.allAlbums || []);
          const newPage = Math.max(0, Math.min(Number(chipPage), Math.ceil(allList.length / PAGE_SIZE) - 1));
          setSession(flowToken, { albumPage: newPage });
          const { items: albumItems, page_chips, show_pager } = await buildAlbumPage(allList, newPage);
          const show_type_selector = (sess.allAlbums || []).length > 0 && (sess.allSingles || []).length > 0;
          return screen('ARTIST_ALBUMS', {
            artist_name:       sess.artistName || '',
            albums:            albumItems,
            page_chips,
            show_pager,
            type_chips:        makeTypeChips(),
            show_type_selector,
            content_subtitle:  `${allList.length} ${contentType === 'albums' ? 'אלבומים' : 'סינגלים'}`,
          });
        }
        return screen('SEARCH', {});
      }

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

      const trackItems = [dlItem, ...sortedTracks.map(t => trackItem(t, albumImgB64))];

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
