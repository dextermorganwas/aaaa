'use strict';
const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../logger');
const cache = require('../lib/cache');
const { parseIdSegment } = require('../lib/idParse');
const resolver = require('../resolvers/resolveArt');

const router = express.Router();

const PLACEHOLDERS = {
  poster: config.placeholderPosterUrl,
  backdrop: config.placeholderBackdropUrl,
  logo: config.placeholderLogoUrl,
};

function cacheControlFor(artRow) {
  if (artRow.cache_forever || artRow.is_override) return 'public, max-age=31536000, immutable';
  if (artRow.expires_at) {
    const remainingSec = Math.max(60, Math.floor((new Date(artRow.expires_at).getTime() - Date.now()) / 1000));
    return `public, max-age=${remainingSec}`;
  }
  return 'public, max-age=86400';
}

async function handle(artType, req, res) {
  const raw = req.params[0] || '';
  const parsed = parseIdSegment(raw);

  if (!parsed.type || (!parsed.tmdbId && !parsed.imdbId && !parsed.tvdbId)) {
    logger.warn(`Unparseable/insufficient ${artType} request: ${raw}`);
    return respondFallback(artType, res, 400);
  }

  let artRow;
  try {
    artRow = await resolver.resolve({
      type: parsed.type,
      tmdbId: parsed.tmdbId,
      imdbId: parsed.imdbId,
      tvdbId: parsed.tvdbId,
      artType,
    });
  } catch (e) {
    logger.error(`Resolution error for ${artType} ${raw}:`, e);
  }

  if (!artRow || !cache.exists(artRow.local_path)) {
    return respondFallback(artType, res, 404);
  }

  const stat = cache.stat(artRow.local_path);
  const etag = `"${crypto.createHash('sha1').update(`${artRow.local_path}:${stat.mtimeMs}`).digest('hex')}"`;

  res.set('Cache-Control', cacheControlFor(artRow));
  res.set('ETag', etag);
  res.set('Last-Modified', stat.mtime.toUTCString());
  res.set('X-Art-Source', artRow.source);
  if (artRow.content_type) res.type(artRow.content_type);

  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }

  cache.readStream(artRow.local_path).pipe(res);
}

function respondFallback(artType, res, status) {
  const placeholder = PLACEHOLDERS[artType];
  if (config.servePlaceholderOn404 && placeholder) {
    res.set('Cache-Control', `public, max-age=${config.negativeCacheTtlHours * 3600}`);
    return res.redirect(302, placeholder);
  }
  return res.status(status).json({ error: status === 400 ? 'Could not parse a usable id from the request' : 'No artwork found' });
}

router.get('/poster/*', (req, res) => handle('poster', req, res));
router.get('/backdrop/*', (req, res) => handle('backdrop', req, res));
router.get('/logo/*', (req, res) => handle('logo', req, res));

module.exports = router;
