'use strict';
const express = require('express');
const db = require('../db');
const cache = require('../lib/cache');
const logger = require('../logger');
const config = require('../config');
const resolver = require('../resolvers/resolveArt');
const browseOptions = require('../resolvers/browseOptions');
const { fetchBuffer } = require('../lib/httpClient');

const router = express.Router();
router.use(express.json());

function serializeMedia(row) {
  const art = db.getArtForMedia(row.id);
  return {
    id: row.id,
    type: row.type,
    tmdbId: row.tmdb_id,
    imdbId: row.imdb_id,
    tvdbId: row.tvdb_id,
    title: row.title,
    year: row.year,
    originalLanguage: row.original_language,
    updatedAt: row.updated_at,
    art: art.map((a) => ({
      artType: a.art_type,
      source: a.source,
      language: a.language,
      isOverride: !!a.is_override,
      cacheForever: !!a.cache_forever,
      fetchedAt: a.fetched_at,
      expiresAt: a.expires_at,
      url: `/admin/art-file/${row.id}/${a.art_type}`,
    })),
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
  res.json(serializeMedia(row));
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
  const { artType, source, imageUrl } = req.body || {};
  if (!['poster', 'backdrop', 'logo'].includes(artType) || !imageUrl) {
    return res.status(400).json({ error: 'artType and imageUrl are required' });
  }
  try {
    const dl = await fetchBuffer(imageUrl, { timeoutMs: 15000 });
    if (!dl) return res.status(502).json({ error: 'Could not download that image URL' });
    const localPath = cache.save({ mediaId: row.id, artType, source: source || 'manual', buffer: dl.buffer, contentType: dl.contentType, sourceUrl: imageUrl });
    const saved = db.upsertArt(row.id, artType, {
      source: source || 'manual',
      sourceRef: 'manual-override',
      sourceUrl: imageUrl,
      localPath,
      contentType: dl.contentType,
      language: null,
      isOverride: true,
      cacheForever: true,
      expiresAt: null,
    });
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
  db.deleteArt(row.id, artType);
  try {
    const result = await resolver.resolve({ type: row.type, tmdbId: row.tmdb_id, imdbId: row.imdb_id, tvdbId: row.tvdb_id, artType });
    res.json({ ok: true, art: result });
  } catch (e) {
    logger.error('reresolve failed', e);
    res.status(502).json({ error: 'Failed to re-resolve', detail: e.message });
  }
});

router.delete('/media/:id/art/:artType', (req, res) => {
  const row = db.getMediaById(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.deleteArt(row.id, req.params.artType);
  res.json({ ok: true });
});

module.exports = router;
