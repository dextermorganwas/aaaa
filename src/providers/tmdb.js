'use strict';
const config = require('../config');
const logger = require('../logger');
const { fetchJson, fetchBuffer } = require('../lib/httpClient');

const API_BASE = 'https://api.themoviedb.org/3';
const IMG_BASE = 'https://image.tmdb.org/t/p';

function authHeaders() {
  if (config.tmdbBearerToken) return { Authorization: `Bearer ${config.tmdbBearerToken}` };
  return {};
}

function withKey(url) {
  if (config.tmdbBearerToken) return url; // bearer auth, no query key needed
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}api_key=${encodeURIComponent(config.tmdbApiKey)}`;
}

function tmdbType(type) {
  return type === 'series' ? 'tv' : 'movie';
}

const imagesCache = new Map(); // in-memory per-process cache of raw /images responses, keyed by type:id
const IMAGES_CACHE_TTL_MS = 10 * 60 * 1000;

/** Fetches (and briefly caches in-process) the full /images payload for an item. */
async function getImages({ type, tmdbId }) {
  if (!tmdbId || (!config.tmdbApiKey && !config.tmdbBearerToken)) return null;
  const cacheKey = `${type}:${tmdbId}`;
  const cached = imagesCache.get(cacheKey);
  if (cached && Date.now() - cached.at < IMAGES_CACHE_TTL_MS) return cached.data;

  const url = withKey(`${API_BASE}/${tmdbType(type)}/${tmdbId}/images?include_image_language=en,null`);
  try {
    const data = await fetchJson(url, { timeoutMs: config.tmdbTimeoutMs, headers: authHeaders(), allow404: true });
    if (data) imagesCache.set(cacheKey, { at: Date.now(), data });
    return data;
  } catch (e) {
    logger.debug('TMDB images fetch failed:', e.message);
    return null;
  }
}

/** Broader fetch used only when we need a specific original-language pass beyond en/null. */
async function getImagesForLanguage({ type, tmdbId, language }) {
  if (!tmdbId || !language) return null;
  const url = withKey(
    `${API_BASE}/${tmdbType(type)}/${tmdbId}/images?include_image_language=${encodeURIComponent(language)},null`
  );
  try {
    return await fetchJson(url, { timeoutMs: config.tmdbTimeoutMs, headers: authHeaders(), allow404: true });
  } catch (e) {
    logger.debug('TMDB images (lang) fetch failed:', e.message);
    return null;
  }
}

/** Item details, primarily to learn original_language / title / primary poster+backdrop. */
async function getDetails({ type, tmdbId }) {
  if (!tmdbId || (!config.tmdbApiKey && !config.tmdbBearerToken)) return null;
  const url = withKey(`${API_BASE}/${tmdbType(type)}/${tmdbId}`);
  try {
    return await fetchJson(url, { timeoutMs: config.tmdbTimeoutMs, headers: authHeaders(), allow404: true });
  } catch (e) {
    logger.debug('TMDB details fetch failed:', e.message);
    return null;
  }
}

/** Resolve a tmdb/imdb id pair via the /find endpoint (useful when we only have an imdb id). */
async function findByImdb(imdbId) {
  if (!imdbId || (!config.tmdbApiKey && !config.tmdbBearerToken)) return null;
  const url = withKey(`${API_BASE}/find/${imdbId}?external_source=imdb_id`);
  try {
    return await fetchJson(url, { timeoutMs: config.tmdbTimeoutMs, headers: authHeaders(), allow404: true });
  } catch (e) {
    logger.debug('TMDB find-by-imdb failed:', e.message);
    return null;
  }
}

/** Cross-references a tmdb id to its imdb/tvdb ids. Used to unify a request that only carries a
 *  subset of ids (e.g. a catalog view with just a tmdb id) with an existing media row that was
 *  first created from a different subset (e.g. a detail view with only an imdb id) - without
 *  this, those could otherwise end up as two separate, never-converging database rows for the
 *  same actual item. */
async function getExternalIds({ type, tmdbId }) {
  if (!tmdbId || (!config.tmdbApiKey && !config.tmdbBearerToken)) return null;
  const url = withKey(`${API_BASE}/${tmdbType(type)}/${tmdbId}/external_ids`);
  try {
    return await fetchJson(url, { timeoutMs: config.tmdbTimeoutMs, headers: authHeaders(), allow404: true });
  } catch (e) {
    logger.debug('TMDB external_ids fetch failed:', e.message);
    return null;
  }
}

function fullImageUrl(filePath, size) {
  if (!filePath) return null;
  return `${IMG_BASE}/${size}/${filePath}`;
}

/**
 * Picks the first image (in API-given order) matching a language predicate.
 * kind: 'posters' | 'backdrops' | 'logos'
 * languageFilter: 'en' | originalLanguageCode | null(=textless, iso_639_1 === null)
 */
function pickFirst(images, kind, languageFilter) {
  if (!images || !Array.isArray(images[kind])) return null;
  const list = images[kind];
  let match;
  if (languageFilter === undefined) {
    match = list[0];
  } else if (languageFilter === null) {
    match = list.find((img) => img.iso_639_1 === null || img.iso_639_1 === '');
  } else {
    match = list.find((img) => img.iso_639_1 === languageFilter);
  }
  return match || null;
}

async function downloadImage(filePath, size) {
  const url = fullImageUrl(filePath, size);
  if (!url) return null;
  const result = await fetchBuffer(url, { timeoutMs: config.tmdbTimeoutMs });
  if (!result) return null;
  return { ...result, sourceUrl: url };
}

module.exports = {
  tmdbType,
  getImages,
  getImagesForLanguage,
  getDetails,
  findByImdb,
  getExternalIds,
  fullImageUrl,
  pickFirst,
  downloadImage,
};
