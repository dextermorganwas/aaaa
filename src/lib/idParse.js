'use strict';
// Parses the AIOMetadata-style path segment this app is configured with in Stremio, e.g.:
//   tmdb:movie:27205&imdb:tt1375666&tvdb:.jpg
//   tmdb:series:1399&imdb:tt0944947&tvdb:121361.jpg
// Any of the three ID segments may be present-but-empty (AIOMetadata blanks the placeholder
// instead of dropping it because we used the trailing "?" in the template). Order and the
// presence of any single segment are not guaranteed, so we parse each piece independently
// rather than assuming a fixed layout.

const TYPE_MAP = { movie: 'movie', series: 'series', show: 'series', tv: 'series' };

function stripExtension(segment) {
  return segment.replace(/\.(jpg|jpeg|png|webp)$/i, '');
}

function parseIdSegment(raw) {
  // raw looks like: tmdb:movie:27205&imdb:tt1375666&tvdb:121361
  const clean = stripExtension(decodeURIComponent(raw || ''));
  const result = { type: null, tmdbId: null, imdbId: null, tvdbId: null };

  const tmdbMatch = clean.match(/tmdb:([a-z]+):([^&]*)/i);
  if (tmdbMatch) {
    result.type = TYPE_MAP[tmdbMatch[1].toLowerCase()] || null;
    result.tmdbId = tmdbMatch[2] ? tmdbMatch[2].trim() : null;
  }
  const imdbMatch = clean.match(/imdb:([^&]*)/i);
  if (imdbMatch) result.imdbId = imdbMatch[1] ? imdbMatch[1].trim() : null;

  const tvdbMatch = clean.match(/tvdb:([^&]*)/i);
  if (tvdbMatch) result.tvdbId = tvdbMatch[1] ? tvdbMatch[1].trim() : null;

  if (!result.tmdbId) result.tmdbId = null;
  if (!result.imdbId) result.imdbId = null;
  if (!result.tvdbId) result.tvdbId = null;

  return result;
}

module.exports = { parseIdSegment };
