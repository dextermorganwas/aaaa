'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mime = require('mime-types');
const config = require('../config');

/**
 * On-disk artwork store. Files are laid out as:
 *   <cacheDir>/<artType>/<mediaId>-<source>-<hash>.<ext>
 * so the admin UI and manual inspection can reason about what's on disk per item.
 */
function extFor(contentType, fallbackUrl) {
  const fromType = mime.extension(contentType || '');
  if (fromType) return `.${fromType === 'jpeg' ? 'jpg' : fromType}`;
  const fromUrl = path.extname(new URL(fallbackUrl).pathname);
  return fromUrl || '.jpg';
}

function relPathFor({ mediaId, artType, source, buffer, contentType, sourceUrl }) {
  const hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 12);
  const ext = extFor(contentType, sourceUrl);
  return path.join(artType, `${mediaId}-${source}-${hash}${ext}`);
}

function absolutePath(relPath) {
  return path.join(config.cacheDir, relPath);
}

function save({ mediaId, artType, source, buffer, contentType, sourceUrl }) {
  const rel = relPathFor({ mediaId, artType, source, buffer, contentType, sourceUrl });
  const abs = absolutePath(rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);
  return rel;
}

function exists(relPath) {
  if (!relPath) return false;
  try {
    return fs.statSync(absolutePath(relPath)).isFile();
  } catch {
    return false;
  }
}

function remove(relPath) {
  if (!relPath) return;
  try {
    fs.unlinkSync(absolutePath(relPath));
  } catch {
    /* ignore */
  }
}

function readStream(relPath) {
  return fs.createReadStream(absolutePath(relPath));
}

function stat(relPath) {
  return fs.statSync(absolutePath(relPath));
}

module.exports = { save, exists, remove, readStream, stat, absolutePath };
