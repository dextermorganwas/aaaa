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
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

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

/** Saves the new file, upserts the DB row, and - critically - deletes whatever file the
 *  PREVIOUS art row for this media+type pointed at (if any, and if different), so replacing a
 *  poster (auto re-resolution, an admin override, or a background TPDB upgrade) doesn't leave
 *  the old image orphaned on disk forever. */
async function persistArt({ mediaId, artType, source, sourceRef, sourceUrl, buffer, contentType, language, reason }) {
  const previous = db.getArt(mediaId, artType);
  const localPath = cache.save({ mediaId, artType, source, buffer, contentType, sourceUrl });
  const ttl = ttlForSource(source);
  const saved = db.upsertArt(mediaId, artType, {
    source,
    sourceRef,
    sourceUrl,
    localPath,
    contentType,
    language,
    reason,
    isOverride: false,
    cacheForever: source === 'theposterdb',
    expiresAt: ttl ? new Date(Date.now() + ttl).toISOString() : null,
  });
  if (previous && previous.local_path && previous.local_path !== localPath) {
    cache.remove(previous.local_path);
  }
  db.clearNegativeCache(mediaId, artType);
  return saved;
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

function tpdbIsOnCooldown(mediaId) {
  const cached = db.getTpdbMatch(mediaId);
  if (!cached) return false;
  if (cached.not_found && cached.updated_at) {
    const age = Date.now() - new Date(cached.updated_at).getTime();
    if (age < config.tpdbNegativeCacheDays * DAY_MS) return true;
  }
  if (cached.last_error_at) {
    const age = Date.now() - new Date(cached.last_error_at).getTime();
    if (age < config.tpdbErrorBackoffMinutes * MINUTE_MS) return true;
  }
  return false;
}

async function resolvePosterViaTpdb(mediaRow, ctx) {
  const title = ctx.title || mediaRow.title;
  const year = ctx.year || mediaRow.year;
  if (!title) {
    // Shouldn't normally happen (buildContext runs before this), but record it rather than
    // silently vanishing - an untracked null here was one source of "dashboard shows nothing
    // but the logs mention TPDB" confusion.
    db.setTpdbError(mediaRow.id, 'no title available yet for a ThePosterDB search');
    return null;
  }

  let outcome;
  try {
    outcome = await tpdb.findEnglishOriginalPoster({ title, year, mediaType: ctx.type });
  } catch (e) {
    db.setTpdbError(mediaRow.id, e.message);
    throw e;
  }
  const { postersPageId, result, scraperError, reason } = outcome;
  if (scraperError) {
    // Something about the page couldn't be parsed - back off briefly like any other error,
    // but don't record a confirmed "not found" (which would stick around for days).
    db.setTpdbError(mediaRow.id, reason);
    return null;
  }
  if (!result) {
    db.setTpdbMatch(mediaRow.id, postersPageId, true, reason);
    return null;
  }

  // findEnglishOriginalPoster already downloaded the winning candidate as part of checking it
  // against the low-effort-template style filter (see theposterdb.js) - no need to fetch it
  // again here. A missing buffer at this point would be an internal bug, not a normal failure.
  if (!result.buffer) {
    db.setTpdbError(mediaRow.id, 'internal error: matched a poster but no image data was attached to the result');
    return null;
  }
  // A genuine match was found and downloaded - record it as such (not "not found").
  db.setTpdbMatch(mediaRow.id, postersPageId, false, reason);
  return {
    source: 'theposterdb',
    sourceRef: result.assetId,
    sourceUrl: result.sourceUrl,
    buffer: result.buffer,
    contentType: result.contentType,
    language: result.language,
    reason: `ThePosterDB: English, Original variation${ctx.type === 'series' ? ', Show Cover' : ''}, top result by Downloads`,
  };
}

/** Runs resolvePosterViaTpdb and either upgrades the current poster or logs why not, using
 *  whatever actually ended up recorded in tpdb_match_cache as the source of truth for the log
 *  message (never guessed from the return value alone - those can diverge, e.g. a match was
 *  found but the image download failed, which is an error, not a "nothing qualifying" verdict).
 *  Shared by the first-ever resolution path and the opportunistic re-check below. */
async function applyTpdbResultOrLog(mediaRow, ctx, tpdbPromise, { label }) {
  const result = await tpdbPromise;
  if (!result) {
    const match = db.getTpdbMatch(mediaRow.id);
    // Full raw state, always logged - if this ever again shows a mismatch with what the
    // dashboard displays for "the same" item, it's proof of a media-row identity issue (see the
    // duplicate-row detector in the admin dashboard) rather than a write that silently failed.
    logger.info(`ThePosterDB ${label} raw state for media #${mediaRow.id} (title="${ctx.title || mediaRow.title}", tmdb:${mediaRow.tmdb_id} imdb:${mediaRow.imdb_id} tvdb:${mediaRow.tvdb_id}): ${JSON.stringify(match || null)}`);
    if (match && match.last_error_at) {
      logger.warn(`ThePosterDB ${label} for media #${mediaRow.id}: error - ${match.last_reason || 'unknown error'} (will retry automatically).`);
    } else {
      logger.info(`ThePosterDB ${label} for media #${mediaRow.id}: ${match?.last_reason || `no qualifying (English/Original${ctx.type === 'series' ? '/Show Cover' : ''}) poster found`}.`);
    }
    return;
  }
  const current = db.getArt(mediaRow.id, 'poster');
  if (current && (current.is_override || current.source === 'theposterdb')) return;
  await persistArt({ mediaId: mediaRow.id, artType: 'poster', ...result });
  logger.info(`ThePosterDB ${label} complete for media #${mediaRow.id} - future requests will use it.`);
}

/** Fresh art cached from a previous resolution can be up to CACHE_TTL_DAYS_TMDB days old before
 *  resolve() ever calls resolvePoster() again - which means, without this, ThePosterDB only
 *  ever gets ONE shot at a title: whatever happened on its very first-ever resolution. If that
 *  attempt lost to a transient error, an expired cooldown from an old scraper bug, or simply
 *  hadn't been fixed yet, the item would stay on a worse poster for up to a month with nothing
 *  ever prompting a retry short of someone manually clicking "Re-run chain". This runs
 *  opportunistically alongside a fast cache-hit response instead: it doesn't block or slow that
 *  response down, but gives ThePosterDB another chance in the background, gated by the same
 *  cooldown as everywhere else so it only actually does work when there's something new to try. */
const opportunisticTpdbInFlight = new Set();
/** Wraps resolvePosterViaTpdb so an exception can never disappear silently: logs the full error
 *  (not just its message) at error level, and writes a fallback error record so the dashboard
 *  always has something to show even if the failure happened before resolvePosterViaTpdb's own
 *  internal writes. This used to log at debug (invisible by default) with just e.message, which
 *  almost certainly hid the real cause behind "logs show a generic miss, nothing written to the
 *  DB at all" reports - if something throws before reaching an internal write, this is the only
 *  place that would ever see it. */
async function safeResolvePosterViaTpdb(mediaRow, ctx) {
  try {
    return await resolvePosterViaTpdb(mediaRow, ctx);
  } catch (e) {
    logger.error(`ThePosterDB resolution threw for media #${mediaRow.id} (title="${ctx.title || mediaRow.title}"):`, e);
    try {
      db.setTpdbError(mediaRow.id, `unhandled exception: ${e.message}`);
    } catch (writeErr) {
      logger.error(`ThePosterDB: even the fallback error-write failed for media #${mediaRow.id}:`, writeErr);
    }
    return null;
  }
}

function scheduleOpportunisticTpdbCheck(mediaRow) {
  if (tpdbIsOnCooldown(mediaRow.id)) return;
  // A burst of near-simultaneous requests for the same popular item would otherwise each
  // schedule their own redundant check before the first one finishes and records a cooldown
  // (the DB-persisted cooldown only updates on completion) - this in-memory guard prevents that.
  if (opportunisticTpdbInFlight.has(mediaRow.id)) return;
  opportunisticTpdbInFlight.add(mediaRow.id);
  background.schedule(`tpdb-recheck-${mediaRow.id}`, async () => {
    try {
      const ctx = { type: mediaRow.type, title: mediaRow.title, year: mediaRow.year, tmdbId: mediaRow.tmdb_id, imdbId: mediaRow.imdb_id, tvdbId: mediaRow.tvdb_id };
      const tpdbPromise = safeResolvePosterViaTpdb(mediaRow, ctx);
      await applyTpdbResultOrLog(mediaRow, ctx, tpdbPromise, { label: 're-check' });
    } finally {
      opportunisticTpdbInFlight.delete(mediaRow.id);
    }
  });
}

async function resolvePosterRestOfChain(mediaRow, ctx) {
  if (ctx.tmdbImages) {
    const img = tmdb.pickFirst(ctx.tmdbImages, 'posters', 'en');
    if (img) {
      const dl = await tmdb.downloadImage(img.file_path, config.tmdbPosterSize);
      if (dl) return { source: 'tmdb', sourceRef: img.file_path, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: 'en', reason: 'TMDB: first English poster' };
    }
  }
  const tvdbData = await getTvdbData(ctx);
  if (tvdbData) {
    const art = tvdb.pickFirst(tvdbData.posters, 'eng');
    if (art) {
      const dl = await tvdb.downloadImage(art.image);
      if (dl) return { source: 'tvdb', sourceRef: art.id, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: 'eng', reason: 'TVDB: first English poster' };
    }
  }
  if (ctx.originalLanguage && ctx.originalLanguage !== 'en') {
    const langImages = await tmdbOriginalLanguageImages(ctx);
    const img = tmdb.pickFirst(langImages, 'posters', ctx.originalLanguage);
    if (img) {
      const dl = await tmdb.downloadImage(img.file_path, config.tmdbPosterSize);
      if (dl) return { source: 'tmdb', sourceRef: img.file_path, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: ctx.originalLanguage, reason: `TMDB: first poster in original language (${ctx.originalLanguage})` };
    }
    if (tvdbData) {
      const tvdbLang = langMap.toTvdbLang(ctx.originalLanguage);
      const art = tvdb.pickFirst(tvdbData.posters, tvdbLang);
      if (art) {
        const dl = await tvdb.downloadImage(art.image);
        if (dl) return { source: 'tvdb', sourceRef: art.id, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: tvdbLang, reason: `TVDB: first poster in original language (${tvdbLang})` };
      }
    }
  }
  if (ctx.imdbId) {
    const dl = await metahub.download('poster', ctx.imdbId);
    if (dl) return { source: 'metahub', sourceRef: ctx.imdbId, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: null, reason: 'Metahub fallback (last resort before primary)' };
  }
  if (ctx.tmdbDetails?.poster_path) {
    const dl = await tmdb.downloadImage(ctx.tmdbDetails.poster_path, config.tmdbPosterSize);
    if (dl) return { source: 'tmdb', sourceRef: ctx.tmdbDetails.poster_path, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: null, reason: "TMDB: primary poster (nothing else matched)" };
  }
  if (tvdbData?.primaryImage) {
    const dl = await tvdb.downloadImage(tvdbData.primaryImage);
    if (dl) return { source: 'tvdb', sourceRef: 'primary', sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: null, reason: "TVDB: primary image (nothing else matched)" };
  }
  return null;
}

async function resolvePoster(mediaRow, ctx) {
  if (tpdbIsOnCooldown(mediaRow.id)) {
    // A previous attempt already recorded a confirmed "not found" or an error, and it hasn't
    // expired yet - skip entirely rather than logging a misleading "no qualifying poster found"
    // for what's actually just an unexpired cooldown (that message is reserved for a check that
    // genuinely just ran and found nothing).
    logger.debug(`ThePosterDB on cooldown for media #${mediaRow.id}, skipping this cycle.`);
    return resolvePosterRestOfChain(mediaRow, ctx);
  }

  const tpdbPromise = safeResolvePosterViaTpdb(mediaRow, ctx);

  function scheduleBackfill() {
    background.schedule(`tpdb-backfill-${mediaRow.id}`, () => applyTpdbResultOrLog(mediaRow, ctx, tpdbPromise, { label: 'backfill' }));
  }

  if (!config.tpdbInlineEnabled) {
    // Never block the response on TPDB at all - fire it off and move straight to the rest of
    // the chain. This is the default, since ThePosterDB's per-candidate detail-page checks make
    // it inherently the slowest provider by a wide margin.
    scheduleBackfill();
    return resolvePosterRestOfChain(mediaRow, ctx);
  }

  const raced = await raceWithBackground(tpdbPromise, config.tpdbTimeoutMs);
  if (!raced.timedOut && raced.value) return raced.value;
  if (raced.timedOut) {
    logger.info(`ThePosterDB is taking a while for media #${mediaRow.id} - continuing without it, will backfill in background.`);
    scheduleBackfill();
  }
  return resolvePosterRestOfChain(mediaRow, ctx);
}

// ---------------- BACKDROP ----------------

async function resolveBackdrop(mediaRow, ctx) {
  if (ctx.tmdbImages) {
    const img = tmdb.pickFirst(ctx.tmdbImages, 'backdrops', null);
    if (img) {
      const dl = await tmdb.downloadImage(img.file_path, config.tmdbBackdropSize);
      if (dl) return { source: 'tmdb', sourceRef: img.file_path, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: null, reason: 'TMDB: first textless backdrop' };
    }
  }
  const tvdbData = await getTvdbData(ctx);
  if (tvdbData) {
    const art = tvdb.pickFirst(tvdbData.backgrounds, null);
    if (art) {
      const dl = await tvdb.downloadImage(art.image);
      if (dl) return { source: 'tvdb', sourceRef: art.id, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: null, reason: 'TVDB: first textless background' };
    }
  }
  if (ctx.imdbId) {
    const dl = await metahub.download('backdrop', ctx.imdbId);
    if (dl) return { source: 'metahub', sourceRef: ctx.imdbId, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: null, reason: 'Metahub fallback (last resort before primary)' };
  }
  if (ctx.tmdbDetails?.backdrop_path) {
    const dl = await tmdb.downloadImage(ctx.tmdbDetails.backdrop_path, config.tmdbBackdropSize);
    if (dl) return { source: 'tmdb', sourceRef: ctx.tmdbDetails.backdrop_path, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: null, reason: 'TMDB: primary backdrop (nothing textless matched)' };
  }
  if (tvdbData?.backgrounds?.[0]) {
    const dl = await tvdb.downloadImage(tvdbData.backgrounds[0].image);
    if (dl) return { source: 'tvdb', sourceRef: tvdbData.backgrounds[0].id, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: null, reason: 'TVDB: first available background (nothing textless matched)' };
  }
  return null;
}

// ---------------- LOGO ----------------

async function resolveLogo(mediaRow, ctx) {
  if (ctx.tmdbImages) {
    const img = tmdb.pickFirst(ctx.tmdbImages, 'logos', 'en');
    if (img) {
      const dl = await tmdb.downloadImage(img.file_path, config.tmdbLogoSize);
      if (dl) return { source: 'tmdb', sourceRef: img.file_path, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: 'en', reason: 'TMDB: first English logo' };
    }
  }
  const tvdbData = await getTvdbData(ctx);
  if (tvdbData) {
    const art = tvdb.pickFirst(tvdbData.logos, 'eng');
    if (art) {
      const dl = await tvdb.downloadImage(art.image);
      if (dl) return { source: 'tvdb', sourceRef: art.id, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: 'eng', reason: 'TVDB: first English logo' };
    }
  }
  if (ctx.originalLanguage && ctx.originalLanguage !== 'en') {
    const langImages = await tmdbOriginalLanguageImages(ctx);
    const img = tmdb.pickFirst(langImages, 'logos', ctx.originalLanguage);
    if (img) {
      const dl = await tmdb.downloadImage(img.file_path, config.tmdbLogoSize);
      if (dl) return { source: 'tmdb', sourceRef: img.file_path, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: ctx.originalLanguage, reason: `TMDB: first logo in original language (${ctx.originalLanguage})` };
    }
    if (tvdbData) {
      const tvdbLang = langMap.toTvdbLang(ctx.originalLanguage);
      const art = tvdb.pickFirst(tvdbData.logos, tvdbLang);
      if (art) {
        const dl = await tvdb.downloadImage(art.image);
        if (dl) return { source: 'tvdb', sourceRef: art.id, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: tvdbLang, reason: `TVDB: first logo in original language (${tvdbLang})` };
      }
    }
  }
  if (ctx.imdbId) {
    const dl = await metahub.download('logo', ctx.imdbId);
    if (dl) return { source: 'metahub', sourceRef: ctx.imdbId, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: null, reason: 'Metahub fallback (last resort before primary)' };
  }
  if (ctx.tmdbImages?.logos?.[0]) {
    const img = ctx.tmdbImages.logos[0];
    const dl = await tmdb.downloadImage(img.file_path, config.tmdbLogoSize);
    if (dl) return { source: 'tmdb', sourceRef: img.file_path, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: null, reason: 'TMDB: first available logo, any language (nothing else matched)' };
  }
  if (tvdbData?.logos?.[0]) {
    const dl = await tvdb.downloadImage(tvdbData.logos[0].image);
    if (dl) return { source: 'tvdb', sourceRef: tvdbData.logos[0].id, sourceUrl: dl.sourceUrl, buffer: dl.buffer, contentType: dl.contentType, language: null, reason: 'TVDB: first available logo, any language (nothing else matched)' };
  }
  return null;
}

const CHAINS = { poster: resolvePoster, backdrop: resolveBackdrop, logo: resolveLogo };

/**
 * Main entry point. Returns a raw `art` db row ready to stream, or null if nothing could be
 * found anywhere (caller decides whether to serve a placeholder).
 *
 * forceRefresh: bypasses the "already have fresh cached art" short-circuit (used by the admin
 * "re-run chain" button) WITHOUT discarding the existing row up front - if the fresh attempt
 * comes back empty, the old art keeps serving rather than the item going blank.
 */
/** Cross-references ids via TMDB before creating a brand-new media row, so a request carrying
 *  only a subset of ids (e.g. a catalog view with just a tmdb id) still converges on the same
 *  row as a fuller request for the same item (e.g. a detail view with only an imdb id) - without
 *  this, those could silently end up as two separate rows that never converge: one accumulates
 *  real progress (like a ThePosterDB match) while the other - the one actually being served -
 *  never does, with no error or trace anywhere to explain why. Only runs when a direct lookup
 *  with the given ids finds nothing, so it costs an extra TMDB request only for genuinely new
 *  id combinations, not on every request.
 */
async function resolveCanonicalIds({ type, tmdbId, imdbId, tvdbId }) {
  const ids = { tmdbId, imdbId, tvdbId };
  if (!tmdbId && imdbId && (config.tmdbApiKey || config.tmdbBearerToken)) {
    const found = await tmdb.findByImdb(imdbId).catch(() => null);
    const hit = found && (type === 'series' ? found.tv_results?.[0] : found.movie_results?.[0]);
    if (hit) ids.tmdbId = String(hit.id);
  }
  if (ids.tmdbId && (!ids.imdbId || !ids.tvdbId)) {
    const ext = await tmdb.getExternalIds({ type, tmdbId: ids.tmdbId }).catch(() => null);
    if (ext) {
      if (!ids.imdbId && ext.imdb_id) ids.imdbId = ext.imdb_id;
      if (!ids.tvdbId && ext.tvdb_id) ids.tvdbId = String(ext.tvdb_id);
    }
  }
  return ids;
}

async function resolve({ type, tmdbId, imdbId, tvdbId, artType, forceRefresh = false }) {
  let ids = { tmdbId, imdbId, tvdbId };
  if (!db.findMedia({ type, ...ids })) {
    // Nothing matches the ids we were given directly - before creating a new row, see if TMDB
    // can fill in the ones we're missing, in case an existing row for this same item is only
    // findable via one of those.
    ids = await resolveCanonicalIds({ type, ...ids }).catch(() => ids);
  }
  const mediaRow = db.findOrCreateMedia({ type, ...ids });
  db.logRequest(mediaRow.id, artType);

  const key = `${mediaRow.id}:${artType}`;
  return singleflight.run(key, async () => {
    const existing = db.getArt(mediaRow.id, artType);
    if (!forceRefresh && existing && !isExpired(existing) && cache.exists(existing.local_path)) {
      // Serving from cache is fast on purpose, but for posters it shouldn't mean ThePosterDB
      // never gets another chance: without this, once any non-TPDB poster is cached (up to
      // CACHE_TTL_DAYS_TMDB days), nothing would prompt a retry until that cache expires or
      // someone manually clicks "Re-run chain" - see scheduleOpportunisticTpdbCheck for why.
      if (artType === 'poster' && existing.source !== 'theposterdb' && !existing.is_override) {
        scheduleOpportunisticTpdbCheck(mediaRow);
      }
      return existing;
    }

    if (!forceRefresh) {
      const negative = db.getNegativeCache(mediaRow.id, artType);
      if (negative) {
        const age = Date.now() - new Date(negative.checked_at).getTime();
        if (age < config.negativeCacheTtlHours * HOUR_MS) {
          // Confirmed recently that nothing is available anywhere - don't hit every provider
          // again on every request; serve stale art if we happen to have any, else nothing.
          return existing && cache.exists(existing.local_path) ? existing : null;
        }
      }
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
      db.setNegativeCache(mediaRow.id, artType);
      if (existing && cache.exists(existing.local_path)) return existing; // keep serving stale art
      return null;
    }

    return persistArt({ mediaId: mediaRow.id, artType, ...result });
  });
}

module.exports = { resolve, buildContext, isExpired };
