'use strict';

/**
 * Zing / JewishMusic API client
 *
 * Handles:
 *  - Firebase token refresh (access tokens expire every ~1 h)
 *  - Artist search with full pagination (500/call)
 *  - Artist albums
 *  - Album detail + tracks
 *  - Audio file download (streaming)
 */

const axios = require('axios');

const GRAPHQL_URL  = 'https://jewishmusic.fm:8443/graphql';
const AUDIO_URL    = 'https://jewishmusic.fm:8443/api/audio-file';
const TOKEN_URL    = 'https://securetoken.googleapis.com/v1/token';
const APP_VERSION  = process.env.ZING_APP_VERSION || '3.6.5';

// ─── Token cache ─────────────────────────────────────────────────────────────

const tokenCache = { accessToken: null, expiresAt: 0 };

async function getAccessToken() {
  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.accessToken;
  }

  console.log('[zingApi] refreshing access token...');
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: process.env.ZING_REFRESH_TOKEN,
  });

  const { data } = await axios.post(
    `${TOKEN_URL}?key=${process.env.FIREBASE_API_KEY}`,
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );

  tokenCache.accessToken = data.access_token;
  tokenCache.expiresAt   = Date.now() + Number(data.expires_in) * 1000;
  console.log('[zingApi] token refreshed, expires in', data.expires_in, 's');
  return tokenCache.accessToken;
}

// ─── Shared request headers ───────────────────────────────────────────────────

function buildHeaders(accessToken) {
  return {
    'accept':              '*/*',
    'accept-language':     'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
    'authorization':       `Bearer ${accessToken}`,
    'origin':              'https://zingmusic.app',
    'x-app-version':       APP_VERSION,
    'x-timezone-offset':   '180',
    'user-agent':          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  };
}

// ─── Artists ─────────────────────────────────────────────────────────────────

const ARTISTS_QUERY = `
  query GetArtists(
    $skip: Int!, $count: Int!,
    $orderBy: [ArtistOrderByWithRelationInput!],
    $where: ArtistWhereInput!
  ) {
    __typename
    artists(take: $count, skip: $skip, orderBy: $orderBy, where: $where) {
      __typename
      id enName heName
      images { __typename cdnSmall cdnMedium cdnLarge }
      enDesc heDesc
    }
  }
`;

async function fetchArtistsPage(query, accessToken, skip, count = 500) {
  const { data } = await axios.post(
    GRAPHQL_URL,
    {
      operationName: null,
      variables: {
        skip,
        count,
        orderBy: [{ enName: 'asc' }, { id: 'asc' }],
        where: {
          OR: [
            { enName: { contains: query, mode: 'insensitive' } },
            { heName: { contains: query, mode: 'insensitive' } },
          ],
        },
      },
      query: ARTISTS_QUERY,
    },
    { headers: buildHeaders(accessToken) },
  );
  return data.data.artists;
}

/**
 * Fetch ALL artists matching the search query (handles pagination).
 * Returns at most 2 000 results to stay practical for display.
 */
async function getAllArtists(searchQuery = '') {
  console.log(`[zingApi] getAllArtists query="${searchQuery}"`);
  const accessToken = await getAccessToken();
  const all = [];
  const PAGE = 500;
  let skip = 0;

  while (all.length < 2000) {
    const page = await fetchArtistsPage(searchQuery, accessToken, skip, PAGE);
    all.push(...page);
    console.log(`[zingApi] fetched page skip=${skip}, got ${page.length} artists (total ${all.length})`);
    if (page.length < PAGE) break;
    skip += PAGE;
  }

  return all;
}

// ─── Artist albums ────────────────────────────────────────────────────────────

const ARTIST_ALBUMS_QUERY = `
  query GetArtistAlbums(
    $skip: Int!, $count: Int!, $artistId: Int!,
    $countWhere: AlbumWhereInput!,
    $where: AlbumWhereInput!,
    $featuredWhere: AlbumWhereInput!,
    $orderBy: [AlbumOrderByWithRelationInput!]
  ) {
    __typename
    albumsCount(where: $countWhere)
    artist(where: { id: $artistId }) {
      __typename id enName heName
      images { __typename cdnSmall cdnMedium cdnLarge }
      enDesc heDesc
      featuredAlbums(where: $featuredWhere) {
        __typename id enName heName releasedAt
        images { __typename cdnSmall cdnMedium cdnLarge }
        artists { __typename enName heName }
        premium albumType
      }
    }
    albums(take: $count, skip: $skip, orderBy: $orderBy, where: $where) {
      __typename id enName heName releasedAt
      images { __typename cdnSmall cdnMedium cdnLarge }
      artists { __typename enName heName }
      premium albumType
    }
  }
`;

async function getArtistAlbums(artistId) {
  console.log(`[zingApi] getArtistAlbums id=${artistId}`);
  const accessToken = await getAccessToken();
  const id = Number(artistId);

  const { data } = await axios.post(
    GRAPHQL_URL,
    {
      operationName: null,
      variables: {
        skip:  0,
        count: 500,
        artistId: id,
        orderBy:      [{ releasedAt: 'desc' }, { id: 'desc' }],
        countWhere:   { artists: { some: { id: { equals: id } } } },
        featuredWhere:{ featuredArtists: { some: { id: { equals: id } } } },
        where: {
          artists:   { some: { id: { equals: id } } },
          albumType: { not: { equals: 'RSS' } },
        },
      },
      query: ARTIST_ALBUMS_QUERY,
    },
    { headers: buildHeaders(accessToken) },
  );

  return data.data;   // { artist, albums, albumsCount }
}

// ─── Album detail + tracks ────────────────────────────────────────────────────

const ALBUM_DETAIL_QUERY = `
  query GetAlbumDetail(
    $id: Int!, $sortOrder: SortOrder!,
    $featuredWhere: ArtistWhereInput,
    $count: Int, $skip: Int
  ) {
    __typename
    album(where: { id: $id }) {
      __typename id enName heName releasedAt
      images { __typename cdnSmall cdnMedium cdnLarge }
      albumType rssUrl premium
      artists { __typename id enName heName images { __typename cdnSmall cdnMedium } }
      featuredArtists(where: $featuredWhere) {
        __typename id enName heName images { __typename cdnSmall cdnMedium }
      }
      tracks(orderBy: { trackNumber: $sortOrder }, take: $count, skip: $skip) {
        __typename id enName heName fileName duration
        album {
          __typename id enName heName
          images { __typename cdnSmall cdnMedium }
          premium albumType
        }
      }
    }
  }
`;

async function getAlbumDetail(albumId) {
  console.log(`[zingApi] getAlbumDetail id=${albumId}`);
  const accessToken = await getAccessToken();

  const { data } = await axios.post(
    GRAPHQL_URL,
    {
      operationName: null,
      variables: {
        id:            Number(albumId),
        sortOrder:     'asc',
        featuredWhere: {},
        count:         100,
        skip:          0,
      },
      query: ALBUM_DETAIL_QUERY,
    },
    { headers: buildHeaders(accessToken) },
  );

  return data.data.album;
}

// ─── Audio file ───────────────────────────────────────────────────────────────

/**
 * Returns an authenticated axios response stream for a given track.
 */
async function downloadAudioStream(trackId) {
  const accessToken = await getAccessToken();

  const response = await axios.get(AUDIO_URL, {
    params: {
      trackId,
      token:      accessToken,
      appVersion: APP_VERSION,
    },
    headers: {
      ...buildHeaders(accessToken),
      range:              'bytes=0-',
      'sec-fetch-dest':   'audio',
      'sec-fetch-mode':   'no-cors',
      'sec-fetch-site':   'cross-site',
    },
    responseType: 'stream',
    maxRedirects: 5,
  });

  return response;
}

module.exports = {
  getAllArtists,
  getArtistAlbums,
  getAlbumDetail,
  downloadAudioStream,
};
