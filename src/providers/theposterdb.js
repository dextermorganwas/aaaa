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
/**
 * Detects the common "low-effort template" poster style you asked about: a plain image framed
 * by a thin uniform (usually white) border.
 *
 * NOTE: this is a heuristic tuned by reasoning about the examples you shared, not validated
 * against a large real-world sample (no way to fetch/test against live ThePosterDB images from
 * here). Expect to tune TPDB_STYLE_BORDER_THRESHOLD if it's too eager or too lax once you see
 * it running against your actual catalog - see the reason string on skipped candidates for the
 * measured values that drove each decision.
 */
async function looksLikeTemplateStyle(buffer) {
  if (!config.tpdbStyleCheckEnabled) return { isTemplate: false };
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    logger.warn('ThePosterDB style check is enabled but the "sharp" package is not installed - skipping the check.');
    return { isTemplate: false };
  }

  try {
    const image = sharp(buffer);
    const { width, height } = await image.metadata();
    if (!width || !height) return { isTemplate: false };

    // Sample thin strips along all four edges for near-white pixels.
    const borderPx = Math.max(2, Math.round(Math.min(width, height) * 0.015));
    const edges = [
      { left: 0, top: 0, width, height: borderPx },
      { left: 0, top: height - borderPx, width, height: borderPx },
      { left: 0, top: 0, width: borderPx, height },
      { left: width - borderPx, top: 0, width: borderPx, height },
    ];
    let whiteEdgeCount = 0;
    for (const edge of edges) {
      const { data, info } = await image.clone().extract(edge).raw().toBuffer({ resolveWithObject: true });
      const channels = info.channels;
      let whitePixels = 0;
      const totalPixels = data.length / channels;
      for (let i = 0; i < data.length; i += channels) {
        // channels===1 (grayscale) has no G/B to check - just use the single value.
        const isWhite = channels === 1 ? data[i] > 235 : data[i] > 235 && data[i + 1] > 235 && data[i + 2] > 235;
        if (isWhite) whitePixels++;
      }
      if (whitePixels / totalPixels > config.tpdbStyleBorderThreshold) whiteEdgeCount++;
    }
    const hasBorder = whiteEdgeCount >= 3; // tolerate one edge being imprecise/occluded

    return { isTemplate: hasBorder, measurements: { whiteEdgeCount } };
  } catch (e) {
    // Fail open: a broken analysis should never block an otherwise-fine poster.
    logger.debug('ThePosterDB style check errored, treating as not-template:', e.message);
    return { isTemplate: false };
  }
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
  let anyStyleRejection = false; // a genuine content-based verdict, not a transient hiccup
  let bestReason = null;

  for (const postersPageId of pagesToTry) {
    const filtered = await getCandidateIds(postersPageId, { mediaType, language: 'en', variation: 'orig' });
    if (filtered.length) {
      anyContentFound = true;
      const candidates = filtered.slice(0, config.tpdbStyleCheckMaxCandidates);
      let skippedForStyle = 0;
      let downloadFailures = 0;

      for (const assetId of candidates) {
        const dl = await downloadPoster(assetId);
        if (!dl) {
          downloadFailures++;
          continue; // download hiccup on this one - try the next candidate rather than failing outright
        }

        const styleCheck = await looksLikeTemplateStyle(dl.buffer);
        if (styleCheck.isTemplate) {
          skippedForStyle++;
          logger.info(
            `ThePosterDB: skipping candidate ${assetId} for "${title}" - looks like the low-effort template style` +
              (styleCheck.measurements ? ` (white edges: ${styleCheck.measurements.whiteEdgeCount}/4).` : '.')
          );
          continue;
        }

        return {
          postersPageId,
          result: { assetId, imageUrl: assetImageUrl(assetId), language: 'English', variation: 'Original', ...dl },
          scraperError: false,
          reason: null,
        };
      }

      if (skippedForStyle > 0) {
        anyStyleRejection = true;
        bestReason = `ThePosterDB has ${filtered.length} English/Original candidate(s) for this title, but the ${skippedForStyle} checked had a plain white border (low-effort template style)${downloadFailures ? ` (${downloadFailures} other candidate(s) failed to download)` : ''}`;
      } else if (downloadFailures === candidates.length && candidates.length > 0) {
        // Every candidate on this page failed to download - a transient/network issue, not a
        // real "nothing here" verdict. Don't let this masquerade as a content-based miss.
        bestReason = `ThePosterDB has ${filtered.length} English/Original candidate(s) for this title, but all ${downloadFailures} checked failed to download (transient - will retry sooner)`;
      }
      continue; // a different (duplicate) title page might do better
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
  if (!anyStyleRejection && bestReason && /failed to download/.test(bestReason)) {
    // Genuinely found qualifying candidates and never got a real look at any of them - treat as
    // a transient error (short backoff), not a confirmed multi-day "not found".
    return { postersPageId: pagesToTry[0], result: null, scraperError: true, reason: bestReason };
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

// Bump this whenever a change to the matching/parsing logic above, OR to how/when a verdict
// gets recorded, could flip a previous verdict or leave a stale cooldown blocking a check that
// should now happen - db.js uses it to auto-invalidate remembered ThePosterDB verdicts on
// startup so old bugs don't linger as cooldowns after they're fixed. Last bumped: simplified the
// low-effort-template style check to border-detection only, dropping the bottom-text-bar signal.
const TPDB_SCRAPER_VERSION = 10;

module.exports = {
  TPDB_SCRAPER_VERSION,
  findEnglishOriginalPoster,
  downloadPoster,
  assetImageUrl,
  findPostersPageIds,
  getCandidateIds,
  browseCandidates,
};
