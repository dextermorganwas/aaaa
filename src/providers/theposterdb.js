'use strict';
// ThePosterDB has no official API. This scrapes the public site the same way community tools
// (plex-theposterdb, artwork-uploader-plex) do. The set-grid selectors below mirror the working
// Python/BeautifulSoup implementation in artwork-uploader-plex's theposterdb_scraper.py exactly
// (outer card -> .overlay[data-poster-id] -> caption <p>), since that's a currently-maintained
// scraper verified against production TPDB. Every step also has a regex fallback in case TPDB's
// markup shifts; if it does, this is the file to fix.
const cheerio = require('cheerio');
const config = require('../config');
const logger = require('../logger');
const { fetchText, fetchBuffer, limitedFetch } = require('../lib/httpClient');

const BASE = 'https://theposterdb.com';

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
  return fetchText(url, { timeoutMs: config.tpdbTimeoutMs });
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

/** Step 2: list candidate sets (one per uploader) linked from the disambiguation page, in the
 *  site's default ("Logical") order - which is what "choose the first one" refers to. */
async function getCandidateSets(postersPageId, maxCandidates) {
  const html = await get(`/posters/${postersPageId}`);
  if (!html) return [];
  const $ = cheerio.load(html);
  const sets = [];
  const seen = new Set();

  $('a[href*="/set/"]').each((_, el) => {
    if (sets.length >= maxCandidates) return;
    const href = $(el).attr('href') || '';
    const m = href.match(/\/set\/(\d+)/);
    if (!m || seen.has(m[1])) return;
    seen.add(m[1]);
    sets.push(m[1]);
  });

  if (!sets.length) {
    const re = /\/set\/(\d+)/g;
    let m;
    while ((m = re.exec(html)) && sets.length < maxCandidates) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        sets.push(m[1]);
      }
    }
  }

  return sets.slice(0, maxCandidates);
}

function parseShowCaption(caption) {
  // "Show Name (2016)" -> cover; "Show Name (2016) - Season 2" -> season 2; "- Specials" -> season 0
  if (!caption) return 'Cover';
  let season = 'Cover';
  const parts = caption.split(' - ');
  if (parts.length > 1) {
    const tail = parts[parts.length - 1].trim();
    if (/specials/i.test(tail)) season = 0;
    else {
      const m = tail.match(/season\s+(\d+)/i);
      if (m) season = parseInt(m[1], 10);
    }
  }
  return season;
}

/** Step 3: scrape one /set/{id} page for its poster grid. Mirrors the Python scraper's exact
 *  traversal: outer card (.col-6.col-lg-2.p-1) -> .overlay[data-poster-id] -> caption <p>. */
async function getSetPosters(setId) {
  const html = await get(`/set/${setId}`);
  if (!html) return [];
  const $ = cheerio.load(html);
  const posters = [];

  $('div.col-6.col-lg-2.p-1').each((_, el) => {
    const card = $(el);
    const posterId = card.find('div.overlay').attr('data-poster-id');
    if (!posterId) return;
    const mediaTypeLabel = card.find('a[data-toggle="tooltip"][data-placement="top"]').attr('title') || '';
    const captionRaw = card.find('p.p-0.mb-1.text-break').first().text().trim();
    posters.push({ assetId: posterId, mediaTypeLabel: mediaTypeLabel.trim(), caption: captionRaw });
  });

  if (!posters.length) {
    // Regex fallback keyed off the data-poster-id attribute alone - loses caption/type info,
    // but the individual /poster/{id} detail page (fetched next) carries its own caption too,
    // so evaluateCandidateSet() can still make a correct decision even from this bare list.
    const re = /data-poster-id=["'](\d+)["']/g;
    const seen = new Set();
    let m;
    while ((m = re.exec(html))) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      posters.push({ assetId: m[1], mediaTypeLabel: '', caption: '' });
    }
  }

  return posters;
}

/** Step 4: open an individual /poster/{assetId} page to read Language / Type / Variation, and
 *  the poster's own caption (e.g. "Breaking Bad (2008) - Season 2") which is authoritative for
 *  season/cover detection regardless of whether the set-grid caption parsed cleanly. */
async function getPosterMeta(assetId) {
  const html = await get(`/poster/${assetId}`);
  if (!html) return null;
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&middot;|·/g, '|').replace(/\s+/g, ' ');

  const metaMatch = text.match(
    /Language:\s*([A-Za-z\- ]+?)\s*\|\s*Type:\s*([A-Za-z\- ]+?)\s*\|\s*Variation:\s*([A-Za-z' \-]+?)\s*(?:\||Notes|$)/i
  );
  if (!metaMatch) return null;

  // Caption sits immediately before "by <uploader> ... Uploaded:" - bounded lookback keeps this
  // from accidentally matching something in the page's nav/header text further back.
  const captionMatch = text.match(/([^|]{1,100}?)\s+by\s+[^|]{1,60}?\|\s*Uploaded:/i);

  return {
    language: metaMatch[1].trim(),
    type: metaMatch[2].trim(),
    variation: metaMatch[3].trim(),
    caption: captionMatch ? captionMatch[1].trim() : null,
  };
}

/** Picks which poster within a set to evaluate, then fetches its detail page and validates it
 *  against the required criteria using the DETAIL PAGE's own caption as the final word on
 *  season/cover status (not just the grid's, which may be blank if selectors ever miss). */
async function evaluateCandidateSet(setId, { mediaType }) {
  const setPosters = await getSetPosters(setId);
  if (!setPosters.length) return null;

  const wantLabel = mediaType === 'series' ? /show/i : /movie/i;
  const target =
    setPosters.find((p) => wantLabel.test(p.mediaTypeLabel) && (mediaType !== 'series' || parseShowCaption(p.caption) === 'Cover')) ||
    setPosters.find((p) => wantLabel.test(p.mediaTypeLabel)) ||
    setPosters[0];
  if (!target) return null;

  const meta = await getPosterMeta(target.assetId);
  if (!meta) return null;

  const expectedType = mediaType === 'series' ? 'show' : 'movie';
  if (!new RegExp(expectedType, 'i').test(meta.type)) return null;
  if (mediaType === 'series' && parseShowCaption(meta.caption) !== 'Cover') return null;

  return { setId, assetId: target.assetId, imageUrl: assetImageUrl(target.assetId), ...meta };
}

/**
 * The full chain: search -> disambiguation page -> evaluate every candidate set IN PARALLEL
 * (each set still needs its own two sequential requests, but different sets no longer wait on
 * each other) -> return the first, in the site's original order, that is English + Original
 * (+ Show Cover for series). Returns { postersPageId, result } where result is null if nothing
 * qualified.
 */
async function findEnglishOriginalPoster({ title, year, mediaType }) {
  const postersPageId = await findPostersPageId({ title, year, mediaType });
  if (!postersPageId) return { postersPageId: null, result: null };

  const setIds = await getCandidateSets(postersPageId, config.tpdbMaxCandidates);
  const evaluations = await Promise.all(
    setIds.map((setId) =>
      evaluateCandidateSet(setId, { mediaType }).catch((e) => {
        logger.debug(`TPDB candidate set ${setId} evaluation failed:`, e.message);
        return null;
      })
    )
  );

  for (const evalResult of evaluations) {
    if (evalResult && /^english$/i.test(evalResult.language) && /^original$/i.test(evalResult.variation)) {
      return { postersPageId, result: evalResult };
    }
  }
  return { postersPageId, result: null };
}

async function downloadPoster(assetId) {
  const url = assetImageUrl(assetId);
  const result = await fetchBuffer(url, { timeoutMs: config.tpdbTimeoutMs * 3 });
  if (!result) return null;
  return { ...result, sourceUrl: url };
}

module.exports = {
  findEnglishOriginalPoster,
  downloadPoster,
  assetImageUrl,
  findPostersPageId,
  getCandidateSets,
  getSetPosters,
  getPosterMeta,
  evaluateCandidateSet,
  parseShowCaption,
};
