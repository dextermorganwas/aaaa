'use strict';
const config = require('../config');
const logger = require('../logger');
const { fetchJson, fetchBuffer } = require('../lib/httpClient');

const API_BASE = 'https://api4.thetvdb.com/v4';

let tokenPromise = null;
let tokenExpiresAt = 0;

async function login() {
  const body = JSON.stringify({
    apikey: config.tvdbApiKey,
    pin: config.tvdbSubscriberPin || undefined,
  });
  const data = await fetchJson(`${API_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    timeoutMs: config.tvdbTimeoutMs,
  });
  if (!data || !data.data || !data.data.token) throw new Error('TVDB login did not return a token');
  return data.data.token;
}

async function getToken() {
  if (!config.tvdbApiKey) return null;
  if (tokenPromise && Date.now() < tokenExpiresAt) return tokenPromise;
  tokenPromise = login();
  // TVDB tokens are valid ~1 month; refresh well before that.
  tokenExpiresAt = Date.now() + 25 * 24 * 60 * 60 * 1000;
  tokenPromise.catch(() => {
    tokenPromise = null;
    tokenExpiresAt = 0;
  });
  return tokenPromise;
}

async function authedFetch(path, opts = {}) {
  const token = await getToken();
  if (!token) return null;
  const headers = { Authorization: `Bearer ${token}`, ...(opts.headers || {}) };
  try {
    return await fetchJson(`${API_BASE}${path}`, { ...opts, headers, timeoutMs: opts.timeoutMs || config.tvdbTimeoutMs, allow404: true });
  } catch (e) {
    if (String(e.message).includes('HTTP 401')) {
      // token expired/invalid server-side - force a fresh login once and retry.
      tokenPromise = null;
      tokenExpiresAt = 0;
      const token2 = await getToken();
      if (!token2) return null;
      return fetchJson(`${API_BASE}${path}`, {
        ...opts,
        headers: { Authorization: `Bearer ${token2}`, ...(opts.headers || {}) },
        timeoutMs: opts.timeoutMs || config.tvdbTimeoutMs,
        allow404: true,
      });
    }
    throw e;
  }
}

// --- artwork type dictionary (slug + recordType -> numeric type id) ---
let artworkTypesCache = null;
async function getArtworkTypes() {
  if (artworkTypesCache) return artworkTypesCache;
  const data = await authedFetch('/artwork/types');
  const list = (data && data.data) || [];
  artworkTypesCache = list;
  return list;
}

async function typeIdFor(recordType, slugCandidates) {
  const types = await getArtworkTypes();
  for (const slug of slugCandidates) {
    const found = types.find(
      (t) => (t.recordType === recordType || !t.recordType) && (t.slug === slug || t.name?.toLowerCase() === slug)
    );
    if (found) return found.id;
  }
  return null;
}

function tvdbRecordType(type) {
  return type === 'series' ? 'series' : 'movies';
}

async function resolveTvdbId({ type, tvdbId, imdbId, tmdbId }) {
  if (tvdbId) return tvdbId;
  const remote = imdbId || (tmdbId ? `tmdb-${tmdbId}` : null);
  if (!imdbId) return null; // TVDB's public remoteid search works reliably with imdb ids
  const data = await authedFetch(`/search/remoteid/${encodeURIComponent(imdbId)}`);
  const matches = (data && data.data) || [];
  const wantType = type === 'series' ? 'series' : 'movie';
  const hit = matches.find((m) => m[wantType] || (m.series && wantType === 'series') || (m.movie && wantType === 'movie'));
  const record = hit ? hit[wantType] : null;
  return record ? record.id : null;
}

async function getExtended({ type, tvdbId }) {
  if (!tvdbId) return null;
  const rt = tvdbRecordType(type);
  const data = await authedFetch(`/${rt}/${tvdbId}/extended`);
  return data ? data.data : null;
}

/**
 * Returns { artworks, originalLanguage, title } for the given item, or null.
 * artworks entries: { id, image, language ('eng'|null|...), typeSlug }
 */
async function getArtworks({ type, tvdbId, imdbId, tmdbId }) {
  if (!config.tvdbApiKey) return null;
  try {
    const resolvedId = await resolveTvdbId({ type, tvdbId, imdbId, tmdbId });
    if (!resolvedId) return null;
    const extended = await getExtended({ type, tvdbId: resolvedId });
    if (!extended) return null;
    const recordType = type === 'series' ? 'series' : 'movie';
    const [posterTypeId, backgroundTypeId, logoTypeId] = await Promise.all([
      typeIdFor(recordType, ['poster']),
      typeIdFor(recordType, ['background', 'fanart']),
      typeIdFor(recordType, ['clearlogo', 'logo']),
    ]);
    const artworks = (extended.artworks || []).map((a) => ({
      id: a.id,
      image: a.image,
      language: a.language || null,
      typeId: a.type,
    }));
    return {
      tvdbId: resolvedId,
      originalLanguage: extended.originalLanguage || null,
      title: extended.name || null,
      year: (extended.year || (extended.firstAired || '').slice(0, 4)) || null,
      posters: artworks.filter((a) => a.typeId === posterTypeId),
      backgrounds: artworks.filter((a) => a.typeId === backgroundTypeId),
      logos: artworks.filter((a) => a.typeId === logoTypeId),
      primaryImage: extended.image || null,
    };
  } catch (e) {
    logger.debug('TVDB getArtworks failed:', e.message);
    return null;
  }
}

function pickFirst(list, languageFilter) {
  if (!list || !list.length) return null;
  let match;
  if (languageFilter === undefined) match = list[0];
  else if (languageFilter === null) match = list.find((a) => !a.language);
  else match = list.find((a) => a.language === languageFilter);
  return match || null;
}

async function downloadImage(url) {
  if (!url) return null;
  const result = await fetchBuffer(url, { timeoutMs: config.tvdbTimeoutMs });
  if (!result) return null;
  return { ...result, sourceUrl: url };
}

module.exports = { getArtworks, pickFirst, downloadImage };
