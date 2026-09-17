'use strict';
// ThePosterDB has no official API. This scrapes the public site the same way community tools
// (plex-theposterdb, artwork-uploader-plex) do.
//
// Things worth recording here for future-me:
// 1. ThePosterDB sits behind Cloudflare and appears to degrade/block non-browser User-Agents -
//    every request here spoofs a real Chrome UA + client-hint headers, matching what the
//    reference scrapers do. Without this, every request silently comes back empty.
// 2. BIG ONE: the disambiguation page's filter UI (View/Textless/Language/Season/Sort/Variation)
//    actually syncs to the URL as real query parameters (confirmed directly from a user's own
//    browser session), so the exact filtering the site's own UI does can be replicated with a
//    single GET instead of opening every candidate's own detail page to check its language and
//    variation. Confirmed working params:
//      ?textless=All&language=en&season=n&sort=Downloads&variation=orig
//    - textless: All | Non-Textless | Textless (posters always use All here)
//    - language: ISO 639-1 2-letter code (en, fr, ...)
//    - season: only present for series; "n" = Show Cover. Omitted entirely for movies.
//    - sort: Downloads (matches the site's own "popularity" ordering)
//    - variation: orig = Original (abbreviated, not the full word)
//    Requesting the page already filtered this way means the first candidate in the resulting
//    grid IS a qualifying English/Original(/Show Cover) poster - no separate detail-page
//    verification needed for the main chain at all. This is a large simplification over an
//    earlier version of this scraper that opened every candidate's own /poster/{id} page and
//    parsed free text off it, which was slow and repeatedly broke on parsing edge cases.
// 3. cheerio's .text() includes <script>/<style> contents by default - still relevant for the
//    admin "browse" detail lookups below, which strip them before extracting text.
// 4. Requests to ThePosterDB are rate-limited on two axes: a concurrency cap
//    (TPDB_MAX_CONCURRENT) and a minimum spacing between requests (TPDB_MIN_REQUEST_INTERVAL_MS)
//    - concurrency alone doesn't bound total throughput over time, spacing does.
const cheerio = require('cheerio');
const pLimit = require('p-limit');
const config = require('../config');
const logger = require('../logger');
const { fetchText, fetchBuffer } = require('../lib/httpClient');

const BASE = 'https://theposterdb.com';
const tpdbLimit = pLimit(config.tpdbMaxConcurrent);

let lastRequestAt = 0;
function throttle() {
  const wait = Math.max(0, lastRequestAt + config.tpdbMinRequestIntervalMs - Date.now());
  lastRequestAt = Date.now() + wait;
  return wait > 0 ? new Promise((resolve) => setTimeout(resolve, wait)) : Promise.resolve();
}

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  Referer: 'https://theposterdb.com/',
};

function assetImageUrl(assetId) {
  return `${BASE}/api/assets/${assetId}/view`;
}

function normalizeTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function get(path) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  return tpdbLimit(async () => {
    await throttle();
    return fetchText(url, { timeoutMs: config.tpdbTimeoutMs, headers: BROWSER_HEADERS });
  });
}

/** Step 1: find the /posters/{id} "all posters for this title" disambiguation page. */
async function findPostersPageId({ title, year, mediaType }) {
  const section = mediaType === 'series' ? 'shows' : 'movies';
  const html = await get(`/search?${new URLSearchParams({ term: title, section })}`);
  if (!html) return null;
  const $ = cheerio.load(html);
  const wantTitle = normalizeTitle(title);
  const candidates = [];

  $('a[href*="/posters/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/\/posters\/(\d+)/);
    if (!m) return;
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (!text) return;
    candidates.push({ id: m[1], text });
  });

  if (!candidates.length) {
    const re = /<a[^>]+href="((?:https:\/\/theposterdb\.com)?\/posters\/(\d+))"[^>]*>(.*?)<\/a>/gis;
    let m;
    while ((m = re.exec(html))) {
      const text = m[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text) candidates.push({ id: m[2], text });
    }
  }

  const yearMatch = candidates.find((c) => normalizeTitle(c.text.split('(')[0]) === wantTitle && c.text.includes(String(year || '####')));
  if (yearMatch) return yearMatch.id;
  const titleMatch = candidates.find((c) => normalizeTitle(c.text.split('(')[0]) === wantTitle);
  if (titleMatch) return titleMatch.id;
  const loose = candidates.find((c) => normalizeTitle(c.text).includes(wantTitle));
  return loose ? loose.id : null;
}

/** Builds a disambiguation-page URL using the site's own real filter query params. */
function buildFilteredUrl(postersPageId, { mediaType, language, variation } = {}) {
  const params = new URLSearchParams();
  params.set('textless', 'All');
  if (language) params.set('language', language);
  if (mediaType === 'series') params.set('season', 'n'); // "n" = Show Cover
  params.set('sort', 'Downloads');
  if (variation) params.set('variation', variation);
  return `/posters/${postersPageId}?${params.toString()}`;
}

/** Reads candidate poster ids off a (possibly filtered) disambiguation page, in the page's own
 *  order (which, sorted by Downloads, means "most popular first"). */
async function getCandidateIds(postersPageId, opts = {}) {
  const html = await get(buildFilteredUrl(postersPageId, opts));
  if (!html) return [];
  const $ = cheerio.load(html);
  const ids = [];
  const seen = new Set();

  $('div.col-6.col-lg-2.p-1').each((_, el) => {
    const posterId = $(el).find('div.overlay').attr('data-poster-id');
    if (posterId && !seen.has(posterId)) {
      seen.add(posterId);
      ids.push(posterId);
    }
  });

  if (!ids.length) {
    const re = /data-poster-id=["'](\d+)["']/g;
    let m;
    while ((m = re.exec(html))) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        ids.push(m[1]);
      }
    }
  }

  return ids;
}

/**
 * The full chain: search -> disambiguation page requested PRE-FILTERED to
 * English + Original (+ Show Cover for series), sorted by Downloads -> take the first result.
 * This is what the site's own filter UI does when a person sets it up manually.
 *
 * Distinguishes "TPDB genuinely has nothing matching" from "we couldn't read TPDB's page at
 * all" by also checking the unfiltered page when the filtered one comes back empty - if EVEN
 * the unfiltered page yields nothing, that's a scraper problem, not a real negative.
 */
async function findEnglishOriginalPoster({ title, year, mediaType }) {
  const postersPageId = await findPostersPageId({ title, year, mediaType });
  if (!postersPageId) return { postersPageId: null, result: null, scraperError: false, reason: 'no matching title page found in search' };

  const filtered = await getCandidateIds(postersPageId, { mediaType, language: 'en', variation: 'orig' });
  if (filtered.length) {
    const assetId = filtered[0];
    return {
      postersPageId,
      result: { assetId, imageUrl: assetImageUrl(assetId), language: 'English', variation: 'Original' },
      scraperError: false,
      reason: null,
    };
  }

  const unfiltered = await getCandidateIds(postersPageId, { mediaType });
  if (!unfiltered.length) {
    logger.warn(`ThePosterDB: found title page /posters/${postersPageId} but could not parse any poster candidates from it (filtered or unfiltered) - the scraper may need updating.`);
    return { postersPageId, result: null, scraperError: true, reason: 'found title page but could not parse any candidates at all (scraper may need updating)' };
  }
  return {
    postersPageId,
    result: null,
    scraperError: false,
    reason: `ThePosterDB has ${unfiltered.length} poster(s) for this title, but none in English/Original${mediaType === 'series' ? '/Show Cover' : ''}`,
  };
}

async function downloadPoster(assetId) {
  const url = assetImageUrl(assetId);
  const result = await tpdbLimit(async () => {
    await throttle();
    return fetchBuffer(url, { timeoutMs: config.tpdbTimeoutMs * 3, headers: BROWSER_HEADERS });
  });
  if (!result) return null;
  return { ...result, sourceUrl: url };
}

/** Used only by the admin "browse all options" view: a broader, unfiltered candidate list so a
 *  human can see (and override to) posters in other languages/variations too. Each entry is
 *  labeled generically since we no longer open every candidate's own detail page to confirm its
 *  exact language/variation (that was the slow, fragile part) - the primary (English/Original)
 *  bucket is still exact, built the same way the live resolver is. */
async function browseCandidates(postersPageId, { mediaType }) {
  const [primary, everything] = await Promise.all([
    getCandidateIds(postersPageId, { mediaType, language: 'en', variation: 'orig' }),
    getCandidateIds(postersPageId, { mediaType }),
  ]);
  const primarySet = new Set(primary);
  const more = everything.filter((id) => !primarySet.has(id)).slice(0, config.tpdbMaxCandidates);
  return {
    primary: primary.map((assetId) => ({ assetId, language: 'English', variation: 'Original' })),
    more: more.map((assetId) => ({ assetId, language: null, variation: null })),
  };
}

// Bump this whenever a change to the matching/parsing logic above could flip a previous
// verdict (a "not found" that should now be found, or vice versa) - db.js uses it to
// auto-invalidate remembered ThePosterDB verdicts on startup so old bugs don't linger as
// cooldowns after they're fixed. Last bumped: switched from per-candidate detail-page scraping
// to the site's own real filter query parameters (?language=en&season=n&variation=orig&...).
const TPDB_SCRAPER_VERSION = 6;

module.exports = {
  TPDB_SCRAPER_VERSION,
  findEnglishOriginalPoster,
  downloadPoster,
  assetImageUrl,
  findPostersPageId,
  getCandidateIds,
  browseCandidates,
};
