'use strict';
const config = require('../config');
const logger = require('../logger');
const { fetchBuffer } = require('../lib/httpClient');

const BASE = 'https://images.metahub.space';

// Metahub is keyed purely by IMDb id and only makes sense as a last-resort backup, per Cinemeta.
function urlFor(kind, imdbId) {
  if (!imdbId) return null;
  const path = { poster: 'poster/medium', backdrop: 'background/medium', logo: 'logo/medium' }[kind];
  if (!path) return null;
  return `${BASE}/${path}/${imdbId}/img`;
}

async function download(kind, imdbId) {
  const url = urlFor(kind, imdbId);
  if (!url) return null;
  try {
    const result = await fetchBuffer(url, { timeoutMs: config.metahubTimeoutMs, allow404: true });
    if (!result) return null;
    return { ...result, sourceUrl: url };
  } catch (e) {
    logger.debug(`Metahub ${kind} fetch failed:`, e.message);
    return null;
  }
}

module.exports = { urlFor, download };
