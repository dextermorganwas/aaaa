'use strict';
// ThePosterDB has no official API. This scrapes the public site the same way community tools
// (plex-theposterdb, artwork-uploader-plex) do. Because TPDB's markup can change without notice,
// every parsing step here is defensive: if a selector finds nothing, we fall back to a regex pass
// over the raw HTML before giving up. If TPDB visibly changes its layout, this is the file to fix.
const cheerio = require('cheerio');
const config = require('../config');
const logger = require('../logger');
const { fetchText, fetchBuffer } = require('../lib/httpClient');

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
    // Regex fallback in case the search results markup doesn't use plain <a> the way we expect.
    const re = /<a[^>]+href="((?:https:\/\/theposterdb\.com)?\/posters\/(\d+))"[^>]*>(.*?)<\/a>/gis;
    let m;
    while ((m = re.exec(html))) {
      const text = m[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text) candidates.push({ id: m[2], text });
    }
  }

  // Prefer an exact title+year match; else exact title match; else first candidate containing the title.
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
    if (!m) return;
    if (seen.has(m[1])) return;
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

/** Step 3: scrape one /set/{id} page for its poster grid (mirrors ThePosterDBScraper.get_posters). */
async function getSetPosters(setId) {
  const html = await get(`/set/${setId}`);
  if (!html) return [];
  const $ = cheerio.load(html);
  const posters = [];

  $('div.overlay[data-poster-id]').each((_, el) => {
    const $el = $(el);
    const posterId = $el.attr('data-poster-id');
    const card = $el.closest('.col-6, [class*="col-lg-2"]').length ? $el.closest('.col-6, [class*="col-lg-2"]') : $el.parent().parent();
    const mediaTypeLabel = card.find('a[data-toggle="tooltip"]').attr('title') || card.find('a.text-white').attr('title') || '';
    const captionRaw = card.find('p.p-0.mb-1.text-break, p.text-break').first().text().trim();
    if (!posterId) return;
    posters.push({ assetId: posterId, mediaTypeLabel: mediaTypeLabel.trim(), caption: captionRaw });
  });

  if (!posters.length) {
    // Regex fallback keyed off the data-poster-id attribute alone.
    const re = /data-poster-id=["'](\d+)["']/g;
    let m;
    while ((m = re.exec(html))) posters.push({ assetId: m[1], mediaTypeLabel: '', caption: '' });
  }

  return posters;
}

/** Step 4: open an individual /poster/{assetId} page to read Language / Type / Variation. */
async function getPosterMeta(assetId) {
  const html = await get(`/poster/${assetId}`);
  if (!html) return null;
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&middot;|·/g, '|').replace(/\s+/g, ' ');
  const m = text.match(/Language:\s*([A-Za-z\- ]+?)\s*\|\s*Type:\s*([A-Za-z\- ]+?)\s*\|\s*Variation:\s*([A-Za-z' \-]+?)\s*(?:\||Notes|$)/i);
  if (!m) return null;
  return { language: m[1].trim(), type: m[2].trim(), variation: m[3].trim() };
}

/**
 * The full chain: search -> disambiguation page -> walk candidate sets in order -> for each,
 * find the relevant poster within the set (movie poster, or show-cover for series) -> open its
 * detail page and accept the first one that is English + Original (+ Show Cover for series).
 * Returns { assetId, imageUrl, language, variation } or null.
 */
async function findEnglishOriginalPoster({ title, year, mediaType }) {
  const postersPageId = await findPostersPageId({ title, year, mediaType });
  if (!postersPageId) return { postersPageId: null, result: null };

  const setIds = await getCandidateSets(postersPageId, config.tpdbMaxCandidates);
  for (const setId of setIds) {
    let setPosters;
    try {
      setPosters = await getSetPosters(setId);
    } catch (e) {
      logger.debug(`TPDB set ${setId} fetch failed:`, e.message);
      continue;
    }
    // Within a set, find the specific poster we care about.
    const target =
      mediaType === 'series'
        ? setPosters.find((p) => /show/i.test(p.mediaTypeLabel) && parseShowCaption(p.caption) === 'Cover') ||
          setPosters.find((p) => /show/i.test(p.mediaTypeLabel))
        : setPosters.find((p) => /movie/i.test(p.mediaTypeLabel)) || setPosters[0];
    if (!target) continue;

    let meta;
    try {
      meta = await getPosterMeta(target.assetId);
    } catch (e) {
      logger.debug(`TPDB poster ${target.assetId} meta fetch failed:`, e.message);
      continue;
    }
    if (!meta) continue;
    if (/^english$/i.test(meta.language) && /^original$/i.test(meta.variation)) {
      return {
        postersPageId,
        result: { assetId: target.assetId, imageUrl: assetImageUrl(target.assetId), ...meta },
      };
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
  // Exported for the admin "browse everything" view, which needs to walk every candidate
  // rather than stopping at the first English+Original match.
  findPostersPageId,
  getCandidateSets,
  getSetPosters,
  getPosterMeta,
  parseShowCaption,
};
