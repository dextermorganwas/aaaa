'use strict';
// ThePosterDB has no official API. This scrapes the public site the same way community tools
// (plex-theposterdb, artwork-uploader-plex) do.
//
// Two things worth recording here for future-me:
// 1. ThePosterDB sits behind Cloudflare and appears to degrade/block non-browser User-Agents -
//    every request here spoofs a real Chrome UA + client-hint headers, matching what the
//    reference scrapers do. Without this, every request silently comes back empty.
// 2. The disambiguation page (/posters/{id}) with NO query params already shows exactly one
//    row per uploader/set, and that row is always the "Show Cover" (for series) - verified by
//    fetching it directly and finding zero season-suffixed captions in the default view. That
//    means candidate poster ids can be read straight off THIS page, without needing to open
//    each /set/{id} separately at all.
const cheerio = require('cheerio');
const config = require('../config');
const logger = require('../logger');
const { fetchText, fetchBuffer } = require('../lib/httpClient');

const BASE = 'https://theposterdb.com';

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
  return fetchText(url, { timeoutMs: config.tpdbTimeoutMs, headers: BROWSER_HEADERS });
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

/**
 * Step 2: read candidate poster ids directly off the disambiguation page's default (Cover-only)
 * grid, in the site's own "Logical" order - this IS "the first one that comes up". Each row also
 * carries which /set/{id} it belongs to and a Movie/Show badge, for extra validation.
 */
async function getCoverCandidates(postersPageId, maxCandidates) {
  const html = await get(`/posters/${postersPageId}`);
  if (!html) return { candidates: [], parsedRows: 0 };
  const $ = cheerio.load(html);
  const candidates = [];

  $('div.col-6.col-lg-2.p-1').each((_, el) => {
    if (candidates.length >= maxCandidates) return;
    const card = $(el);
    const posterId = card.find('div.overlay').attr('data-poster-id');
    if (!posterId) return;
    const setHref = card.find('a[href*="/set/"]').first().attr('href') || '';
    const setMatch = setHref.match(/\/set\/(\d+)/);
    const mediaTypeLabel = card.find('a[data-toggle="tooltip"][data-placement="top"]').attr('title') || '';
    candidates.push({ assetId: posterId, setId: setMatch ? setMatch[1] : null, mediaTypeLabel: mediaTypeLabel.trim() });
  });

  const parsedRows = candidates.length;

  if (!candidates.length) {
    // Regex fallback keyed off the data-poster-id attribute alone - loses the set id/media type
    // badge, but the individual /poster/{id} detail page (fetched next) has its own Type field.
    const re = /data-poster-id=["'](\d+)["']/g;
    const seen = new Set();
    let m;
    while ((m = re.exec(html)) && candidates.length < maxCandidates) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      candidates.push({ assetId: m[1], setId: null, mediaTypeLabel: '' });
    }
  }

  return { candidates, parsedRows };
}

/** Step 3: open an individual /poster/{assetId} page to read Language / Type / Variation, plus
 *  the poster's own caption. Verified against real fetched pages: the three fields render as
 *  separate "**Label:** Value" lines (NOT one line joined by separators, which an earlier
 *  version of this scraper wrongly assumed), and the caption is reliably available in the
 *  page's own <title> tag as "{Caption} Poster | TPDb". */
function sliceField(text, label, stopMarkers) {
  const re = new RegExp(`${label}:\\s*`, 'i');
  const m = re.exec(text);
  if (!m) return null;
  let value = text.slice(m.index + m[0].length, m.index + m[0].length + 60);
  for (const marker of stopMarkers) {
    const idx = value.search(new RegExp(marker, 'i'));
    if (idx !== -1) value = value.slice(0, idx);
  }
  value = value.trim();
  return value || null;
}

async function getPosterMeta(assetId) {
  const html = await get(`/poster/${assetId}`);
  if (!html) return null;
  const $ = cheerio.load(html);

  const titleTag = $('title').text().trim();
  const caption = titleTag ? titleTag.replace(/\s*Poster\s*\|\s*TPDb\s*$/i, '').trim() : null;

  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const stopMarkers = ['Type:', 'Variation:', 'Notes\\b', 'RELATED:', 'Language:'];
  const language = sliceField(bodyText, 'Language', stopMarkers);
  const type = sliceField(bodyText, 'Type', stopMarkers);
  const variation = sliceField(bodyText, 'Variation', stopMarkers);

  if (!language && !type && !variation) return null;
  return { language, type, variation, caption };
}

function isCoverCaption(caption) {
  if (!caption) return true; // unknown caption - don't reject on this basis alone
  return !/\s-\s*(season\s+\d+|specials)\s*$/i.test(caption);
}

/** Fetches and validates one candidate's detail page. Returns the fully-evaluated candidate
 *  (regardless of whether it qualifies) or null if it couldn't be fetched/parsed at all. */
async function evaluateCandidate(candidate, { mediaType }) {
  const meta = await getPosterMeta(candidate.assetId);
  if (!meta) return null;
  const expectedType = mediaType === 'series' ? 'show' : 'movie';
  const typeOk = new RegExp(expectedType, 'i').test(meta.type);
  const coverOk = mediaType !== 'series' || isCoverCaption(meta.caption);
  return {
    setId: candidate.setId,
    assetId: candidate.assetId,
    imageUrl: assetImageUrl(candidate.assetId),
    qualifiesType: typeOk && coverOk,
    ...meta,
  };
}

/**
 * The full chain: search -> disambiguation page (candidates read directly, Cover-only by
 * default) -> evaluate every candidate's detail page IN PARALLEL -> return the first, in the
 * site's own order, that is English + Original (+ a real Show Cover, for series).
 *
 * Distinguishes "TPDB genuinely has nothing" (result: null, scraperError: false) from
 * "we couldn't read TPDB's page at all" (scraperError: true) so the caller doesn't cache a
 * scraping failure as a confirmed negative for days.
 */
async function findEnglishOriginalPoster({ title, year, mediaType }) {
  const postersPageId = await findPostersPageId({ title, year, mediaType });
  if (!postersPageId) return { postersPageId: null, result: null, scraperError: false };

  const { candidates, parsedRows } = await getCoverCandidates(postersPageId, config.tpdbMaxCandidates);
  if (!candidates.length) {
    // The disambiguation page resolved, but we couldn't extract a single poster id from it -
    // that's suspicious (TPDB markup likely changed), not a genuine "no posters" situation.
    logger.warn(`ThePosterDB: found title page /posters/${postersPageId} but could not parse any poster candidates from it - the scraper may need updating.`);
    return { postersPageId, result: null, scraperError: true };
  }

  const evaluations = await Promise.all(
    candidates.map((c) =>
      evaluateCandidate(c, { mediaType }).catch((e) => {
        logger.debug(`TPDB candidate ${c.assetId} evaluation failed:`, e.message);
        return null;
      })
    )
  );

  const parsedCount = evaluations.filter(Boolean).length;
  if (parsedCount === 0 && parsedRows > 0) {
    logger.warn(`ThePosterDB: found ${candidates.length} candidate(s) for /posters/${postersPageId} but none of their detail pages could be read - the scraper may need updating.`);
    return { postersPageId, result: null, scraperError: true };
  }

  for (const evalResult of evaluations) {
    if (evalResult && evalResult.qualifiesType && /^english$/i.test(evalResult.language) && /^original$/i.test(evalResult.variation)) {
      return { postersPageId, result: evalResult, scraperError: false };
    }
  }
  return { postersPageId, result: null, scraperError: false };
}

async function downloadPoster(assetId) {
  const url = assetImageUrl(assetId);
  const result = await fetchBuffer(url, { timeoutMs: config.tpdbTimeoutMs * 3, headers: BROWSER_HEADERS });
  if (!result) return null;
  return { ...result, sourceUrl: url };
}

module.exports = {
  findEnglishOriginalPoster,
  downloadPoster,
  assetImageUrl,
  findPostersPageId,
  getCoverCandidates,
  getPosterMeta,
  evaluateCandidate,
};
