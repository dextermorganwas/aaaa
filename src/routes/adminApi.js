'use strict';
const express = require('express');
const db = require('../db');
const cache = require('../lib/cache');
const logger = require('../logger');
const config = require('../config');
const resolver = require('../resolvers/resolveArt');
const browseOptions = require('../resolvers/browseOptions');
const tmdb = require('../providers/tmdb');
const { fetchBuffer } = require('../lib/httpClient');

const router = express.Router();
router.use(express.json());

function serializeMedia(row, { includeDiagnostics = false } = {}) {
  const art = db.getArtForMedia(row.id);
  const tpdbMatch = row.type ? db.getTpdbMatch(row.id) : null;
  const base = {
    id: row.id,
    type: row.type,
    tmdbId: row.tmdb_id,
    imdbId: row.imdb_id,
    tvdbId: row.tvdb_id,
    title: row.title,
    year: row.year,
    originalLanguage: row.original_language,
    updatedAt: row.updated_at,
    tpdbStatus: tpdbMatch
      ? {
          notFound: !!tpdbMatch.not_found,
          hasError: !!tpdbMatch.last_error_at,
          reason: tpdbMatch.last_reason,
          checkedAt: tpdbMatch.updated_at,
        }
      : null,
    art: art.map((a) => ({
      artType: a.art_type,
      source: a.source,
      language: a.language,
      reason: a.reason,
      isOverride: !!a.is_override,
      cacheForever: !!a.cache_forever,
      fetchedAt: a.fetched_at,
      expiresAt: a.expires_at,
      // NOTE: mounted at /api/admin in server.js - keep this in sync with that mount point.
      url: `/api/admin/art-file/${row.id}/${a.art_type}`,
    })),
  };
  if (!includeDiagnostics) return base;

  // Full, unfiltered view of what's actually in the database for this item - added so an issue
  // can be verified directly instead of inferred from the (necessarily simplified) fields above.
  const duplicates = db.findPotentialDuplicates(row);
  return {
    ...base,
    diagnostics: {
      rawMediaRow: row,
      rawTpdbMatch: tpdbMatch || null,
      duplicates: duplicates.map((d) => ({
        id: d.id,
        title: d.title,
        year: d.year,
        tmdbId: d.tmdb_id,
        imdbId: d.imdb_id,
        tvdbId: d.tvdb_id,
        updatedAt: d.updated_at,
      })),
    },
  };
}

router.get('/stats', (req, res) => {
  res.json({
    mediaCount: db.countMedia(),
    backgroundJobsPending: require('../jobs/backgroundQueue').pendingCount(),
  });
});

router.get('/media', (req, res) => {
  const { query, limit, offset } = req.query;
  const rows = query ? db.searchMedia(String(query), Number(limit) || 100) : db.listMedia({ limit: Number(limit) || 100, offset: Number(offset) || 0 });
  res.json({ items: rows.map(serializeMedia) });
});

router.get('/media/:id', (req, res) => {
  const row = db.getMediaById(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(serializeMedia(row, { includeDiagnostics: true }));
});

router.post('/media/:id/merge', (req, res) => {
  const row = db.getMediaById(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { duplicateId } = req.body || {};
  const dup = db.getMediaById(Number(duplicateId));
  if (!dup) return res.status(400).json({ error: 'duplicateId must reference an existing item' });
  try {
    db.mergeMediaRows(row.id, dup.id);
    res.json({ ok: true, media: serializeMedia(db.getMediaById(row.id), { includeDiagnostics: true }) });
  } catch (e) {
    logger.error('merge failed', e);
    res.status(500).json({ error: 'Failed to merge', detail: e.message });
  }
});

router.get('/media/:id/browse', async (req, res) => {
  const row = db.getMediaById(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  try {
    const options = await browseOptions.browse(row);
    res.json(options);
  } catch (e) {
    logger.error('browse failed', e);
    res.status(502).json({ error: 'Failed to browse provider options', detail: e.message });
  }
});

// Serve the actual cached file for the admin UI's <img> tags / preview.
router.get('/art-file/:mediaId/:artType', (req, res) => {
  const artRow = db.getArt(Number(req.params.mediaId), req.params.artType);
  if (!artRow || !cache.exists(artRow.local_path)) return res.status(404).end();
  if (artRow.content_type) res.type(artRow.content_type);
  res.set('Cache-Control', 'no-cache');
  cache.readStream(artRow.local_path).pipe(res);
});

router.post('/media/:id/override', async (req, res) => {
  const row = db.getMediaById(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { artType, source, imageUrl, sourceId } = req.body || {};
  if (!['poster', 'backdrop', 'logo'].includes(artType) || !imageUrl) {
    return res.status(400).json({ error: 'artType and imageUrl are required' });
  }
  try {
    // The browse grid's imageUrl is a small preview size (fine for a thumbnail) - for a TMDB
    // pick, reconstruct the URL at the size actually configured for this art type instead of
    // downloading that preview size as the final art. Other sources don't offer resizable URLs.
    let downloadUrl = imageUrl;
    if (source === 'tmdb' && sourceId) {
      const sizeByType = { poster: config.tmdbPosterSize, backdrop: config.tmdbBackdropSize, logo: config.tmdbLogoSize };
      downloadUrl = tmdb.fullImageUrl(sourceId, sizeByType[artType]) || imageUrl;
    }

    const dl = await fetchBuffer(downloadUrl, { timeoutMs: 15000 });
    if (!dl) return res.status(502).json({ error: 'Could not download that image URL' });

    const previous = db.getArt(row.id, artType);
    const localPath = cache.save({ mediaId: row.id, artType, source: source || 'manual', buffer: dl.buffer, contentType: dl.contentType, sourceUrl: downloadUrl });
    const saved = db.upsertArt(row.id, artType, {
      source: source || 'manual',
      sourceRef: 'manual-override',
      sourceUrl: downloadUrl,
      localPath,
      contentType: dl.contentType,
      language: null,
      reason: 'Manually selected in the admin dashboard',
      isOverride: true,
      cacheForever: true,
      expiresAt: null,
    });
    // Clean up the file the previous pick pointed at, now that it's been fully replaced.
    if (previous && previous.local_path && previous.local_path !== localPath) {
      cache.remove(previous.local_path);
    }
    db.clearNegativeCache(row.id, artType);
    res.json({ ok: true, art: saved });
  } catch (e) {
    logger.error('override failed', e);
    res.status(502).json({ error: 'Failed to apply override', detail: e.message });
  }
});

router.post('/media/:id/reresolve', async (req, res) => {
  const row = db.getMediaById(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { artType } = req.body || {};
  if (!['poster', 'backdrop', 'logo'].includes(artType)) return res.status(400).json({ error: 'artType is required' });
  try {
    // forceRefresh re-runs the chain without discarding the existing row first, so if the fresh
    // attempt fails/finds nothing the item keeps its previous art instead of going blank.
    const result = await resolver.resolve({ type: row.type, tmdbId: row.tmdb_id, imdbId: row.imdb_id, tvdbId: row.tvdb_id, artType, forceRefresh: true });
    res.json({ ok: true, art: result });
  } catch (e) {
    logger.error('reresolve failed', e);
    res.status(502).json({ error: 'Failed to re-resolve', detail: e.message });
  }
});

router.delete('/media/:id/art/:artType', (req, res) => {
  const row = db.getMediaById(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  const existing = db.getArt(row.id, req.params.artType);
  db.deleteArt(row.id, req.params.artType);
  if (existing && existing.local_path) cache.remove(existing.local_path);
  res.json({ ok: true });
});

module.exports = router;
