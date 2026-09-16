'use strict';
const config = require('../config');
const logger = require('../logger');
const db = require('../db');
const cache = require('../lib/cache');
const singleflight = require('../lib/singleflight');
const background = require('../jobs/backgroundQueue');
const { raceWithBackground } = require('../lib/httpClient');
const langMap = require('../lib/langMap');

const tmdb = require('../providers/tmdb');
const tvdb = require('../providers/tvdb');
const tpdb = require('../providers/theposterdb');
const metahub = require('../providers/metahub');

const DAY_MS = 24 * 60 * 60 * 1000;

function ttlForSource(source) {
  if (source === 'theposterdb') return null; // cache forever
  if (source === 'tmdb') return config.cacheTtlDaysTmdb * DAY_MS;
  if (source === 'tvdb') return config.cacheTtlDaysTvdb * DAY_MS;
  if (source === 'metahub') return config.cacheTtlDaysMetahub * DAY_MS;
  return config.cacheTtlDaysTmdb * DAY_MS;
}

function isExpired(artRow) {
  if (!artRow) return true;
  if (artRow.is_override) return false;
  if (artRow.cache_forever) return false;
  if (!artRow.expires_at) return false; // no expiry recorded -> treat as fresh (legacy/manual rows)
  return Date.now() > new Date(artRow.expires_at).getTime();
}

async function persistArt({ mediaId, artType, source, sourceRef, sourceUrl, buffer, contentType, language }) {
  const localPath = cache.save({ mediaId, artType, source, buffer, contentType, sourceUrl });
  const ttl = ttlForSource(source);
  return db.upsertArt(mediaId, artType, {
    source,
    sourceRef,
    sourceUrl,
    localPath,
    contentType,
    language,
    isOverride: false,
    cacheForever: source === 'theposterdb',
    expiresAt: ttl ? new Date(Date.now() + ttl).toISOString() : null,
  });
}

/** Gathers just enough cross-provider context (ids, original language, primary TMDB payload)
 *  to drive the fallback chain without re-fetching it at every step. */
async function buildContext({ type, tmdbId, imdbId, tvdbId }) {
  const ctx = { type, tmdbId, imdbId, tvdbId, originalLanguage: null, title: null, year: null };

  if (!tmdbId && imdbId && (config.tmdbApiKey || config.tmdbBearerToken)) {
    const found = await tmdb.findByImdb(imdbId).catch(() => null);
    if (found) {
      const hit = type === 'series' ? found.tv_results?.[0] : found.movie_results?.[0];
      if (hit) ctx.tmdbId = String(hit.id);
    }
  }

  if (ctx.tmdbId) {
    const [details, images] = await Promise.all([
      tmdb.getDetails({ type, tmdbId: ctx.tmdbId }).catch(() => null),
      tmdb.getImages({ type, tmdbId: ctx.tmdbId }).catch(() => null),
    ]);
    ctx.tmdbDetails = details;
    ctx.tmdbImages = images;
    if (details) {
      ctx.originalLanguage = details.original_language || null;
      ctx.title = details.title || details.name || null;
      ctx.year = (details.release_date || details.first_air_date || '').slice(0, 4) || null;
    }
  }

  return ctx;
}

async function tmdbOriginalLanguageImages(ctx) {
  if (!ctx.tmdbId || !ctx.originalLanguage || ctx.originalLanguage === 'en') return ctx.tmdbImages;
  return tmdb.getImagesForLanguage({ type: ctx.type, tmdbId: ctx.tmdbId, language: ctx.originalLanguage }).catch(() => null);
}

async function getTvdbData(ctx) {
  if (ctx._tvdb !== undefined) return ctx._tvdb;
  ctx._tvdb = await tvdb.getArtworks({ type: ctx.type, tvdbId: ctx.tvdbId, imdbId: ctx.imdbId, tmdbId: ctx.tmdbId }).catch(() => null);
  return ctx._tvdb;
}

// ---------------- POSTER ----------------

async function resolvePosterViaTpdb(mediaRow, ctx) {
  const title = ctx.title || mediaRow.title;
  const year = ctx.year || mediaRow.year;
  if (!title) return null;

  const cachedMatch = db.getTpdbMatch(mediaRow.id);
  if (cachedMatch && cachedMatch.not_found) return null;

  const { postersPageId, result } = await tpdb.findEnglishOriginalPoster({ title, year, mediaType: ctx.type });
  db.setTpdbMatch(mediaRow.id, postersPageId, !result);
  if (!result) return null;

  const dl = await tpdb.downloadPoster(result.assetId);
  if (!dl) return null;
  return {
    source: 'theposterdb',
    sourceRef: result.assetId,
    sourceUrl: dl.sourceUrl,
    buffer: dl.buffer,
    contentType: dl.contentType,
    language: result.language,
  };
}

async function resolvePosterRestOfChain(mediaRow, ctx) {
  // TMDB English
  if (ctx.tmdbImages) {
    const img = tmdb.pickFirst(ctx.tmdbImages, 'posters', 'en');
    if (img) {
      const dl = await tmdb.downloadImage(img.file_path, config.tmdbPosterSize);
      if (dl) return { source: 'tmdb', sourceRef: img.file_path, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: 'en' };
    }
  }
  // TVDB English
  const tvdbData = await getTvdbData(ctx);
  if (tvdbData) {
    const art = tvdb.pickFirst(tvdbData.posters, 'eng');
    if (art) {
      const dl = await tvdb.downloadImage(art.image);
      if (dl) return { source: 'tvdb', sourceRef: art.id, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: 'eng' };
    }
  }
  // TMDB original language
  if (ctx.originalLanguage && ctx.originalLanguage !== 'en') {
    const langImages = await tmdbOriginalLanguageImages(ctx);
    const img = tmdb.pickFirst(langImages, 'posters', ctx.originalLanguage);
    if (img) {
      const dl = await tmdb.downloadImage(img.file_path, config.tmdbPosterSize);
      if (dl) return { source: 'tmdb', sourceRef: img.file_path, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: ctx.originalLanguage };
    }
    // TVDB in that same original language
    if (tvdbData) {
      const tvdbLang = langMap.toTvdbLang(ctx.originalLanguage);
      const art = tvdb.pickFirst(tvdbData.posters, tvdbLang);
      if (art) {
        const dl = await tvdb.downloadImage(art.image);
        if (dl) return { source: 'tvdb', sourceRef: art.id, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: tvdbLang };
      }
    }
  }
  // Metahub
  if (ctx.imdbId) {
    const dl = await metahub.download('poster', ctx.imdbId);
    if (dl) return { source: 'metahub', sourceRef: ctx.imdbId, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: null };
  }
  // TMDB primary poster (whatever TMDB considers the main one)
  if (ctx.tmdbDetails?.poster_path) {
    const dl = await tmdb.downloadImage(ctx.tmdbDetails.poster_path, config.tmdbPosterSize);
    if (dl) return { source: 'tmdb', sourceRef: ctx.tmdbDetails.poster_path, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: null };
  }
  // TVDB primary image
  if (tvdbData?.primaryImage) {
    const dl = await tvdb.downloadImage(tvdbData.primaryImage);
    if (dl) return { source: 'tvdb', sourceRef: 'primary', sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: null };
  }
  return null;
}

async function resolvePoster(mediaRow, ctx) {
  const tpdbPromise = resolvePosterViaTpdb(mediaRow, ctx).catch((e) => {
    logger.debug('TPDB poster resolution errored:', e.message);
    return null;
  });
  const raced = await raceWithBackground(tpdbPromise, config.tpdbTimeoutMs);

  if (!raced.timedOut && raced.value) return raced.value;

  if (raced.timedOut) {
    logger.info(`ThePosterDB is taking a while for media #${mediaRow.id} - continuing without it, will backfill in background`);
    background.schedule(`tpdb-backfill-${mediaRow.id}`, async () => {
      const result = await tpdbPromise;
      if (!result) return;
      const current = db.getArt(mediaRow.id, 'poster');
      // Don't clobber a manual override, and don't bother if we already have a TPDB result
      // (e.g. two overlapping requests both triggered a backfill).
      if (current && (current.is_override || current.source === 'theposterdb')) return;
      await persistArt({ mediaId: mediaRow.id, artType: 'poster', ...result });
      logger.info(`ThePosterDB backfill complete for media #${mediaRow.id} - future requests will use it`);
    });
  }

  return resolvePosterRestOfChain(mediaRow, ctx);
}

// ---------------- BACKDROP ----------------

async function resolveBackdrop(mediaRow, ctx) {
  if (ctx.tmdbImages) {
    const img = tmdb.pickFirst(ctx.tmdbImages, 'backdrops', null);
    if (img) {
      const dl = await tmdb.downloadImage(img.file_path, config.tmdbBackdropSize);
      if (dl) return { source: 'tmdb', sourceRef: img.file_path, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: null };
    }
  }
  const tvdbData = await getTvdbData(ctx);
  if (tvdbData) {
    const art = tvdb.pickFirst(tvdbData.backgrounds, null);
    if (art) {
      const dl = await tvdb.downloadImage(art.image);
      if (dl) return { source: 'tvdb', sourceRef: art.id, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: null };
    }
  }
  if (ctx.imdbId) {
    const dl = await metahub.download('backdrop', ctx.imdbId);
    if (dl) return { source: 'metahub', sourceRef: ctx.imdbId, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: null };
  }
  if (ctx.tmdbDetails?.backdrop_path) {
    const dl = await tmdb.downloadImage(ctx.tmdbDetails.backdrop_path, config.tmdbBackdropSize);
    if (dl) return { source: 'tmdb', sourceRef: ctx.tmdbDetails.backdrop_path, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: null };
  }
  if (tvdbData?.backgrounds?.[0]) {
    const dl = await tvdb.downloadImage(tvdbData.backgrounds[0].image);
    if (dl) return { source: 'tvdb', sourceRef: tvdbData.backgrounds[0].id, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: null };
  }
  return null;
}

// ---------------- LOGO ----------------

async function resolveLogo(mediaRow, ctx) {
  if (ctx.tmdbImages) {
    const img = tmdb.pickFirst(ctx.tmdbImages, 'logos', 'en');
    if (img) {
      const dl = await tmdb.downloadImage(img.file_path, config.tmdbLogoSize);
      if (dl) return { source: 'tmdb', sourceRef: img.file_path, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: 'en' };
    }
  }
  const tvdbData = await getTvdbData(ctx);
  if (tvdbData) {
    const art = tvdb.pickFirst(tvdbData.logos, 'eng');
    if (art) {
      const dl = await tvdb.downloadImage(art.image);
      if (dl) return { source: 'tvdb', sourceRef: art.id, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: 'eng' };
    }
  }
  if (ctx.originalLanguage && ctx.originalLanguage !== 'en') {
    const langImages = await tmdbOriginalLanguageImages(ctx);
    const img = tmdb.pickFirst(langImages, 'logos', ctx.originalLanguage);
    if (img) {
      const dl = await tmdb.downloadImage(img.file_path, config.tmdbLogoSize);
      if (dl) return { source: 'tmdb', sourceRef: img.file_path, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: ctx.originalLanguage };
    }
    if (tvdbData) {
      const tvdbLang = langMap.toTvdbLang(ctx.originalLanguage);
      const art = tvdb.pickFirst(tvdbData.logos, tvdbLang);
      if (art) {
        const dl = await tvdb.downloadImage(art.image);
        if (dl) return { source: 'tvdb', sourceRef: art.id, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: tvdbLang };
      }
    }
  }
  if (ctx.imdbId) {
    const dl = await metahub.download('logo', ctx.imdbId);
    if (dl) return { source: 'metahub', sourceRef: ctx.imdbId, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: null };
  }
  if (ctx.tmdbImages?.logos?.[0]) {
    const img = ctx.tmdbImages.logos[0];
    const dl = await tmdb.downloadImage(img.file_path, config.tmdbLogoSize);
    if (dl) return { source: 'tmdb', sourceRef: img.file_path, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: null };
  }
  if (tvdbData?.logos?.[0]) {
    const dl = await tvdb.downloadImage(tvdbData.logos[0].image);
    if (dl) return { source: 'tvdb', sourceRef: tvdbData.logos[0].id, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: null };
  }
  return null;
}

const CHAINS = { poster: resolvePoster, backdrop: resolveBackdrop, logo: resolveLogo };

/**
 * Main entry point. Returns { localPath, contentType, source } ready to stream, or null if
 * absolutely nothing could be found anywhere (caller decides whether to serve a placeholder).
 */
async function resolve({ type, tmdbId, imdbId, tvdbId, artType }) {
  const mediaRow = db.findOrCreateMedia({ type, tmdbId, imdbId, tvdbId });
  db.logRequest(mediaRow.id, artType);

  const key = `${mediaRow.id}:${artType}`;
  return singleflight.run(key, async () => {
    const existing = db.getArt(mediaRow.id, artType);
    if (existing && !isExpired(existing) && cache.exists(existing.local_path)) {
      return existing;
    }

    const ctx = await buildContext({ type, tmdbId: mediaRow.tmdb_id, imdbId: mediaRow.imdb_id, tvdbId: mediaRow.tvdb_id });
    if (ctx.title) db.updateMediaMeta(mediaRow.id, { title: ctx.title, year: ctx.year, originalLanguage: ctx.originalLanguage });

    const chainFn = CHAINS[artType];
    let result = null;
    try {
      result = await chainFn(mediaRow, ctx);
    } catch (e) {
      logger.error(`Resolution chain for ${artType} on media #${mediaRow.id} threw:`, e);
    }

    if (!result) {
      // Serve a stale cached copy rather than nothing, if one still exists on disk.
      if (existing && cache.exists(existing.local_path)) return existing;
      return null;
    }

    return persistArt({ mediaId: mediaRow.id, artType, ...result });
  });
}

module.exports = { resolve, buildContext, isExpired };
