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

/** Fetches one page of /search results and extracts {id, text} candidates from it. */
async function searchPage(title, section, page) {
  const params = new URLSearchParams({ term: title, section });
  if (page > 1) params.set('page', String(page));
  const html = await get(`/search?${params.toString()}`);
  if (!html) return [];
  const $ = cheerio.load(html);
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
  return candidates;
}

/**
 * Step 1: find every /posters/{id} "all posters for this title" disambiguation page that
 * plausibly matches, ranked best-first (exact title+year, then exact title, then loose match).
 * Some titles have more than one matching page on ThePosterDB - a duplicate/near-duplicate
 * entry, sometimes an empty one - so this returns all of them rather than just the first, and
 * fetches a second page of search results too in case the real match isn't on page 1.
 */
async function findPostersPageIds({ title, year, mediaType }) {
  const section = mediaType === 'series' ? 'shows' : 'movies';
  const wantTitle = normalizeTitle(title);
  const all = [];
  for (let page = 1; page <= config.tpdbMaxSearchPages; page++) {
    const found = await searchPage(title, section, page);
    if (!found.length) break; // no more results, stop paginating
    all.push(...found);
  }

  const seen = new Set();
  const dedup = all.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));

  const exactYear = dedup.filter((c) => normalizeTitle(c.text.split('(')[0]) === wantTitle && c.text.includes(String(year || '####')));
  const exactTitle = dedup.filter((c) => normalizeTitle(c.text.split('(')[0]) === wantTitle && !exactYear.includes(c));
  const loose = dedup.filter((c) => normalizeTitle(c.text).includes(wantTitle) && !exactYear.includes(c) && !exactTitle.includes(c));

  return [...exactYear, ...exactTitle, ...loose].map((c) => c.id);
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

/** A ThePosterDB pick is only used if there's enough community curation behind it: either
 *  several English/Original candidates to choose from, or the title's been around long enough
 *  that a good one has likely surfaced regardless of upload count. Otherwise the existing/
 *  fallback art is left alone rather than replaced with a single low-effort upload. */
function passesQualityGate(candidateCount, year) {
  if (!config.tpdbQualityGateEnabled) return { pass: true };
  if (candidateCount >= config.tpdbMinCandidates) return { pass: true };
  const age = year ? new Date().getFullYear() - parseInt(year, 10) : null;
  if (age !== null && Number.isFinite(age) && age >= config.tpdbMinAgeYears) return { pass: true };
  const ageDesc = age !== null ? `${age} year(s) old` : 'unknown age';
  return {
    pass: false,
    reason: `ThePosterDB has ${candidateCount} English/Original candidate(s), but this title doesn't meet the quality bar yet (needs ${config.tpdbMinCandidates}+ candidates or ${config.tpdbMinAgeYears}+ years old; this is ${ageDesc}) - kept existing/fallback art instead`,
  };
}

/**
 * The full chain: search (up to a couple of pages) -> every plausibly-matching disambiguation
 * page, tried in order -> each requested PRE-FILTERED to English + Original (+ Show Cover for
 * series), sorted by Downloads -> the first result to pass the quality gate wins. Trying more
 * than one title page matters in practice: some titles have a duplicate/empty entry on
 * ThePosterDB ranked ahead of the real one.
 *
 * Distinguishes "TPDB genuinely has nothing matching" from "we couldn't read TPDB's page at
 * all" - the latter (scraperError: true) only fires when NONE of the checked title pages could
 * be parsed at all, not just when a title legitimately has no posters uploaded yet.
 */
async function findEnglishOriginalPoster({ title, year, mediaType }) {
  const postersPageIds = await findPostersPageIds({ title, year, mediaType });
  if (!postersPageIds.length) return { postersPageId: null, result: null, scraperError: false, reason: 'no matching title page found in search' };

  const pagesToTry = postersPageIds.slice(0, config.tpdbMaxAlternateTitlePages);
  let anyContentFound = false;
  let bestReason = null;

  for (const postersPageId of pagesToTry) {
    const filtered = await getCandidateIds(postersPageId, { mediaType, language: 'en', variation: 'orig' });
    if (filtered.length) {
      anyContentFound = true;
      const gate = passesQualityGate(filtered.length, year);
      if (gate.pass) {
        const assetId = filtered[0];
        return {
          postersPageId,
          result: { assetId, imageUrl: assetImageUrl(assetId), language: 'English', variation: 'Original' },
          scraperError: false,
          reason: null,
        };
      }
      bestReason = gate.reason;
      continue; // didn't clear the quality bar - a different (duplicate) title page might do better
    }
    const unfiltered = await getCandidateIds(postersPageId, { mediaType });
    if (unfiltered.length) {
      anyContentFound = true;
      bestReason = bestReason || `ThePosterDB has ${unfiltered.length} poster(s) for this title, but none in English/Original${mediaType === 'series' ? '/Show Cover' : ''}`;
    }
  }

  if (!anyContentFound) {
    logger.warn(`ThePosterDB: found ${pagesToTry.length} title page(s) for "${title}" but could not parse any poster candidates from any of them - the scraper may need updating.`);
    return { postersPageId: pagesToTry[0], result: null, scraperError: true, reason: `found ${pagesToTry.length} title page(s) but could not parse any candidates at all (scraper may need updating)` };
  }
  return { postersPageId: pagesToTry[0], result: null, scraperError: false, reason: bestReason || 'no qualifying candidates found' };
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
// cooldowns after they're fixed. Last bumped: try multiple matching title pages (not just the
// first) and multiple search-result pages, added the candidate-count/age quality gate.
const TPDB_SCRAPER_VERSION = 7;

module.exports = {
  TPDB_SCRAPER_VERSION,
  findEnglishOriginalPoster,
  downloadPoster,
  assetImageUrl,
  findPostersPageIds,
  getCandidateIds,
  browseCandidates,
};
