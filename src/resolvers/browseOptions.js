'use strict';
// Live, read-only "show me everything available" lookup used by the admin dashboard's per-item
// browser. Nothing here is persisted - it's purely for a human to look at, then choose an
// override from (handled by adminApi.js's /override endpoint).
//
// Each art type returns { primary, more }: "primary" is restricted to candidates that would
// actually be reachable by the real resolution chain (English/original-language posters,
// textless backdrops, English/original-language logos, plus TPDB and Metahub which are already
// chain-relevant by construction) - "more" is everything else (other languages, non-textless
// backdrops, etc), shown only if the admin asks to see it, so the two stay honestly in sync with
// what auto-resolution would actually pick from.
const config = require('../config');
const logger = require('../logger');
const tmdb = require('../providers/tmdb');
const tvdb = require('../providers/tvdb');
const tpdb = require('../providers/theposterdb');
const metahub = require('../providers/metahub');
const langMap = require('../lib/langMap');
const { buildContext } = require('./resolveArt');

/** Evaluates every candidate on ThePosterDB's disambiguation page for this title IN PARALLEL
 *  (same approach the live resolver uses), so the admin can see language/variation for all of
 *  them - not just the first English+Original hit the live resolver would stop at. */
async function listTpdbCandidates(ctx, mediaRow) {
  const title = ctx.title || mediaRow.title;
  const year = ctx.year || mediaRow.year;
  if (!title) return [];

  const postersPageId = await tpdb.findPostersPageId({ title, year, mediaType: ctx.type }).catch(() => null);
  if (!postersPageId) return [];

  const { candidates } = await tpdb.getCoverCandidates(postersPageId, config.tpdbMaxCandidates).catch(() => ({ candidates: [] }));

  const evaluations = await Promise.all(
    candidates.map((c) =>
      tpdb.evaluateCandidate(c, { mediaType: ctx.type }).catch((e) => {
        logger.debug(`TPDB browse candidate ${c.assetId} failed:`, e.message);
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
      label: [r.language, r.variation].filter(Boolean).join(' / ') || `set ${r.setId || r.assetId}`,
    }));
}

function splitByLanguage(items, wantLangs) {
  const primary = [];
  const more = [];
  for (const item of items) {
    (wantLangs.includes(item.language) ? primary : more).push(item);
  }
  return { primary, more };
}

/** Returns { poster: {primary, more}, backdrop: {primary, more}, logo: {primary, more}, context } */
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

  const tvdbOriginalLang = langMap.toTvdbLang(ctx.originalLanguage);

  const posters = { primary: [...tpdbList], more: [] };
  const backdrops = { primary: [], more: [] };
  const logos = { primary: [], more: [] };

  if (ctx.tmdbImages) {
    const posterItems = (ctx.tmdbImages.posters || []).map((img) => ({ source: 'tmdb', id: img.file_path, imageUrl: tmdb.fullImageUrl(img.file_path, 'w500'), language: img.iso_639_1, label: img.iso_639_1 || 'textless' }));
    const posterSplit = splitByLanguage(posterItems, ['en', ctx.originalLanguage].filter(Boolean));
    posters.primary.push(...posterSplit.primary);
    posters.more.push(...posterSplit.more);

    const backdropItems = (ctx.tmdbImages.backdrops || []).map((img) => ({ source: 'tmdb', id: img.file_path, imageUrl: tmdb.fullImageUrl(img.file_path, 'w780'), language: img.iso_639_1, label: img.iso_639_1 || 'textless' }));
    const backdropSplit = splitByLanguage(backdropItems, [null]);
    backdrops.primary.push(...backdropSplit.primary);
    backdrops.more.push(...backdropSplit.more);

    const logoItems = (ctx.tmdbImages.logos || []).map((img) => ({ source: 'tmdb', id: img.file_path, imageUrl: tmdb.fullImageUrl(img.file_path, 'w500'), language: img.iso_639_1, label: img.iso_639_1 || 'textless' }));
    const logoSplit = splitByLanguage(logoItems, ['en', ctx.originalLanguage].filter(Boolean));
    logos.primary.push(...logoSplit.primary);
    logos.more.push(...logoSplit.more);
  }

  if (tvdbData) {
    const posterItems = tvdbData.posters.map((a) => ({ source: 'tvdb', id: a.id, imageUrl: a.image, language: a.language, label: a.language || 'textless' }));
    const posterSplit = splitByLanguage(posterItems, ['eng', tvdbOriginalLang].filter(Boolean));
    posters.primary.push(...posterSplit.primary);
    posters.more.push(...posterSplit.more);

    const backgroundItems = tvdbData.backgrounds.map((a) => ({ source: 'tvdb', id: a.id, imageUrl: a.image, language: a.language, label: a.language || 'textless' }));
    const backgroundSplit = splitByLanguage(backgroundItems, [null]);
    backdrops.primary.push(...backgroundSplit.primary);
    backdrops.more.push(...backgroundSplit.more);

    const logoItems = tvdbData.logos.map((a) => ({ source: 'tvdb', id: a.id, imageUrl: a.image, language: a.language, label: a.language || 'textless' }));
    const logoSplit = splitByLanguage(logoItems, ['eng', tvdbOriginalLang].filter(Boolean));
    logos.primary.push(...logoSplit.primary);
    logos.more.push(...logoSplit.more);
  }

  if (ctx.imdbId) {
    posters.primary.push({ source: 'metahub', id: ctx.imdbId, imageUrl: metahub.urlFor('poster', ctx.imdbId), label: 'metahub' });
    backdrops.primary.push({ source: 'metahub', id: ctx.imdbId, imageUrl: metahub.urlFor('backdrop', ctx.imdbId), label: 'metahub' });
    logos.primary.push({ source: 'metahub', id: ctx.imdbId, imageUrl: metahub.urlFor('logo', ctx.imdbId), label: 'metahub' });
  }

  return { poster: posters, backdrop: backdrops, logo: logos, context: { title: ctx.title, year: ctx.year, originalLanguage: ctx.originalLanguage } };
}

module.exports = { browse };
