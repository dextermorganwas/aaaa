'use strict';
// Live, read-only "show me everything available" lookup used by the admin dashboard's per-item
// browser. Nothing here is persisted - it's purely for a human to look at, then choose an
// override from (handled by adminApi.js's /override endpoint).
const config = require('../config');
const logger = require('../logger');
const tmdb = require('../providers/tmdb');
const tvdb = require('../providers/tvdb');
const tpdb = require('../providers/theposterdb');
const metahub = require('../providers/metahub');
const { buildContext } = require('./resolveArt');

/** Evaluates every candidate set on ThePosterDB for this title IN PARALLEL (same helper the live
 *  resolver uses), so the admin can see language/variation for all of them side by side - not
 *  just the first English+Original hit the live resolver would have stopped at. */
async function listTpdbCandidates(ctx, mediaRow) {
  const title = ctx.title || mediaRow.title;
  const year = ctx.year || mediaRow.year;
  if (!title) return [];

  const postersPageId = await tpdb.findPostersPageId({ title, year, mediaType: ctx.type }).catch(() => null);
  if (!postersPageId) return [];

  const setIds = await tpdb.getCandidateSets(postersPageId, Math.max(config.tpdbMaxCandidates, 12)).catch(() => []);

  const evaluations = await Promise.all(
    setIds.map((setId) =>
      tpdb.evaluateCandidateSet(setId, { mediaType: ctx.type }).catch((e) => {
        logger.debug(`TPDB browse candidate set ${setId} failed:`, e.message);
        return null;
      })
    )
  );

  return evaluations
    .filter(Boolean)
    .map((r) => ({
      source: 'theposterdb',
      id: r.assetId,
      setId: r.setId,
      imageUrl: r.imageUrl,
      language: r.language,
      variation: r.variation,
      label: [r.language, r.variation].filter(Boolean).join(' / ') || `set ${r.setId}`,
    }));
}

/** Returns a flat browsing payload: { poster: [...], backdrop: [...], logo: [...] } */
async function browse(mediaRow) {
  const ctx = await buildContext({
    type: mediaRow.type,
    tmdbId: mediaRow.tmdb_id,
    imdbId: mediaRow.imdb_id,
    tvdbId: mediaRow.tvdb_id,
  });

  const [tvdbData, tpdbList] = await Promise.all([
    tvdb.getArtworks({ type: ctx.type, tvdbId: ctx.tvdbId, imdbId: ctx.imdbId, tmdbId: ctx.tmdbId }).catch(() => null),
    listTpdbCandidates(ctx, mediaRow).catch((e) => {
      logger.debug('TPDB browse failed:', e.message);
      return [];
    }),
  ]);

  const posters = [...tpdbList];
  const backdrops = [];
  const logos = [];

  if (ctx.tmdbImages) {
    for (const img of ctx.tmdbImages.posters || []) {
      posters.push({ source: 'tmdb', id: img.file_path, imageUrl: tmdb.fullImageUrl(img.file_path, 'w500'), language: img.iso_639_1, label: img.iso_639_1 || 'textless' });
    }
    for (const img of ctx.tmdbImages.backdrops || []) {
      backdrops.push({ source: 'tmdb', id: img.file_path, imageUrl: tmdb.fullImageUrl(img.file_path, 'w780'), language: img.iso_639_1, label: img.iso_639_1 || 'textless' });
    }
    for (const img of ctx.tmdbImages.logos || []) {
      logos.push({ source: 'tmdb', id: img.file_path, imageUrl: tmdb.fullImageUrl(img.file_path, 'w500'), language: img.iso_639_1, label: img.iso_639_1 || 'textless' });
    }
  }

  if (tvdbData) {
    for (const a of tvdbData.posters) posters.push({ source: 'tvdb', id: a.id, imageUrl: a.image, language: a.language, label: a.language || 'textless' });
    for (const a of tvdbData.backgrounds) backdrops.push({ source: 'tvdb', id: a.id, imageUrl: a.image, language: a.language, label: a.language || 'textless' });
    for (const a of tvdbData.logos) logos.push({ source: 'tvdb', id: a.id, imageUrl: a.image, language: a.language, label: a.language || 'textless' });
  }

  if (ctx.imdbId) {
    posters.push({ source: 'metahub', id: ctx.imdbId, imageUrl: metahub.urlFor('poster', ctx.imdbId), label: 'metahub' });
    backdrops.push({ source: 'metahub', id: ctx.imdbId, imageUrl: metahub.urlFor('backdrop', ctx.imdbId), label: 'metahub' });
    logos.push({ source: 'metahub', id: ctx.imdbId, imageUrl: metahub.urlFor('logo', ctx.imdbId), label: 'metahub' });
  }

  return { poster: posters, backdrop: backdrops, logo: logos, context: { title: ctx.title, year: ctx.year, originalLanguage: ctx.originalLanguage } };
}

module.exports = { browse };
