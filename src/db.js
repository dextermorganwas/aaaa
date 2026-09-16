'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');
const logger = require('./logger');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
fs.mkdirSync(config.cacheDir, { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('movie','series')),
  tmdb_id TEXT,
  imdb_id TEXT,
  tvdb_id TEXT,
  title TEXT,
  year TEXT,
  original_language TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_media_tmdb ON media(type, tmdb_id) WHERE tmdb_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_imdb ON media(imdb_id) WHERE imdb_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_tvdb ON media(type, tvdb_id) WHERE tvdb_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS art (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  art_type TEXT NOT NULL CHECK(art_type IN ('poster','backdrop','logo')),
  source TEXT NOT NULL,
  source_ref TEXT,
  source_url TEXT,
  local_path TEXT,
  content_type TEXT,
  language TEXT,
  is_override INTEGER DEFAULT 0,
  cache_forever INTEGER DEFAULT 0,
  fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  UNIQUE(media_id, art_type)
);

CREATE TABLE IF NOT EXISTS tpdb_match_cache (
  media_id INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  posters_page_id TEXT,
  not_found INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS request_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id INTEGER REFERENCES media(id) ON DELETE CASCADE,
  art_type TEXT,
  requested_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_request_log_media ON request_log(media_id);
`);

logger.info(`SQLite database ready at ${config.dbPath}`);

// ---------- media ----------

function findMedia({ type, tmdbId, imdbId, tvdbId }) {
  if (tmdbId) {
    const row = db.prepare(`SELECT * FROM media WHERE type = ? AND tmdb_id = ?`).get(type, String(tmdbId));
    if (row) return row;
  }
  if (imdbId) {
    const row = db.prepare(`SELECT * FROM media WHERE imdb_id = ?`).get(String(imdbId));
    if (row) return row;
  }
  if (tvdbId) {
    const row = db.prepare(`SELECT * FROM media WHERE type = ? AND tvdb_id = ?`).get(type, String(tvdbId));
    if (row) return row;
  }
  return null;
}

function findOrCreateMedia({ type, tmdbId, imdbId, tvdbId }) {
  let row = findMedia({ type, tmdbId, imdbId, tvdbId });
  if (!row) {
    const info = db
      .prepare(`INSERT INTO media (type, tmdb_id, imdb_id, tvdb_id) VALUES (?, ?, ?, ?)`)
      .run(type, tmdbId ? String(tmdbId) : null, imdbId ? String(imdbId) : null, tvdbId ? String(tvdbId) : null);
    row = db.prepare(`SELECT * FROM media WHERE id = ?`).get(info.lastInsertRowid);
    return row;
  }
  // Backfill any newly-learned identifiers onto the existing row so future lookups by
  // any of the three IDs converge on the same media row.
  const patch = {};
  if (tmdbId && !row.tmdb_id) patch.tmdb_id = String(tmdbId);
  if (imdbId && !row.imdb_id) patch.imdb_id = String(imdbId);
  if (tvdbId && !row.tvdb_id) patch.tvdb_id = String(tvdbId);
  if (Object.keys(patch).length) {
    const sets = Object.keys(patch).map((k) => `${k} = @${k}`).join(', ');
    try {
      db.prepare(`UPDATE media SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = @id`).run({ ...patch, id: row.id });
      row = db.prepare(`SELECT * FROM media WHERE id = ?`).get(row.id);
    } catch (e) {
      // Another row already owns that id (rare race/conflict) - ignore, keep existing row.
      logger.warn('media id backfill skipped (conflict)', e.message);
    }
  }
  return row;
}

function updateMediaMeta(mediaId, { title, year, originalLanguage }) {
  db.prepare(
    `UPDATE media SET
       title = COALESCE(@title, title),
       year = COALESCE(@year, year),
       original_language = COALESCE(@originalLanguage, original_language),
       updated_at = CURRENT_TIMESTAMP
     WHERE id = @mediaId`
  ).run({ mediaId, title: title || null, year: year || null, originalLanguage: originalLanguage || null });
}

function getMediaById(id) {
  return db.prepare(`SELECT * FROM media WHERE id = ?`).get(id);
}

function searchMedia(query, limit = 50) {
  const like = `%${query}%`;
  return db
    .prepare(
      `SELECT * FROM media WHERE title LIKE ? OR tmdb_id = ? OR imdb_id = ? OR tvdb_id = ?
       ORDER BY updated_at DESC LIMIT ?`
    )
    .all(like, query, query, query, limit);
}

function listMedia({ limit = 100, offset = 0 } = {}) {
  return db
    .prepare(`SELECT * FROM media ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .all(limit, offset);
}

function countMedia() {
  return db.prepare(`SELECT COUNT(*) as c FROM media`).get().c;
}

// ---------- art ----------

function getArt(mediaId, artType) {
  return db.prepare(`SELECT * FROM art WHERE media_id = ? AND art_type = ?`).get(mediaId, artType);
}

function getArtForMedia(mediaId) {
  return db.prepare(`SELECT * FROM art WHERE media_id = ?`).all(mediaId);
}

function upsertArt(mediaId, artType, data) {
  const existing = getArt(mediaId, artType);
  const payload = {
    mediaId,
    artType,
    source: data.source,
    sourceRef: data.sourceRef || null,
    sourceUrl: data.sourceUrl || null,
    localPath: data.localPath || null,
    contentType: data.contentType || null,
    language: data.language || null,
    isOverride: data.isOverride ? 1 : 0,
    cacheForever: data.cacheForever ? 1 : 0,
    expiresAt: data.expiresAt || null,
  };
  if (existing) {
    db.prepare(
      `UPDATE art SET source=@source, source_ref=@sourceRef, source_url=@sourceUrl, local_path=@localPath,
         content_type=@contentType, language=@language, is_override=@isOverride, cache_forever=@cacheForever,
         fetched_at=CURRENT_TIMESTAMP, expires_at=@expiresAt
       WHERE media_id=@mediaId AND art_type=@artType`
    ).run(payload);
  } else {
    db.prepare(
      `INSERT INTO art (media_id, art_type, source, source_ref, source_url, local_path, content_type, language,
         is_override, cache_forever, expires_at)
       VALUES (@mediaId, @artType, @source, @sourceRef, @sourceUrl, @localPath, @contentType, @language,
         @isOverride, @cacheForever, @expiresAt)`
    ).run(payload);
  }
  return getArt(mediaId, artType);
}

function deleteArt(mediaId, artType) {
  db.prepare(`DELETE FROM art WHERE media_id = ? AND art_type = ?`).run(mediaId, artType);
}

// ---------- tpdb match cache (which /posters/{id} page matches this title) ----------

function getTpdbMatch(mediaId) {
  return db.prepare(`SELECT * FROM tpdb_match_cache WHERE media_id = ?`).get(mediaId);
}

function setTpdbMatch(mediaId, postersPageId, notFound = false) {
  db.prepare(
    `INSERT INTO tpdb_match_cache (media_id, posters_page_id, not_found, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(media_id) DO UPDATE SET posters_page_id=excluded.posters_page_id,
       not_found=excluded.not_found, updated_at=CURRENT_TIMESTAMP`
  ).run(mediaId, postersPageId || null, notFound ? 1 : 0);
}

// ---------- request log ----------

function logRequest(mediaId, artType) {
  db.prepare(`INSERT INTO request_log (media_id, art_type) VALUES (?, ?)`).run(mediaId, artType);
}

function recentRequestCounts(limit = 200) {
  return db
    .prepare(
      `SELECT media_id, COUNT(*) as hits, MAX(requested_at) as last_requested
       FROM request_log GROUP BY media_id ORDER BY last_requested DESC LIMIT ?`
    )
    .all(limit);
}

module.exports = {
  raw: db,
  findMedia,
  findOrCreateMedia,
  updateMediaMeta,
  getMediaById,
  searchMedia,
  listMedia,
  countMedia,
  getArt,
  getArtForMedia,
  upsertArt,
  deleteArt,
  getTpdbMatch,
  setTpdbMatch,
  logRequest,
  recentRequestCounts,
};
