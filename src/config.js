'use strict';
require('dotenv').config();
const path = require('path');

function bool(val, def) {
  if (val === undefined || val === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(val).toLowerCase());
}

function int(val, def) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : def;
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

module.exports = {
  // --- Server ---
  port: int(process.env.PORT, 8990),
  baseUrl: process.env.BASE_URL || '',
  dataDir: DATA_DIR,
  cacheDir: process.env.CACHE_DIR || path.join(DATA_DIR, 'cache'),
  dbPath: process.env.DB_PATH || path.join(DATA_DIR, 'db', 'artbridge.sqlite'),
  adminUser: process.env.ADMIN_USER || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  trustProxy: bool(process.env.TRUST_PROXY, true),
  logLevel: process.env.LOG_LEVEL || 'info',

  // --- Provider API keys ---
  tmdbApiKey: process.env.TMDB_API_KEY || '',
  // TMDB v3 "API Key" (legacy) OR a v4 Read Access Token - we support either.
  tmdbBearerToken: process.env.TMDB_BEARER_TOKEN || '',
  tvdbApiKey: process.env.TVDB_API_KEY || '',
  tvdbSubscriberPin: process.env.TVDB_SUBSCRIBER_PIN || '',

  // --- Image sizes ---
  tmdbPosterSize: process.env.TMDB_POSTER_SIZE || 'w780',
  tmdbBackdropSize: process.env.TMDB_BACKDROP_SIZE || 'original',
  tmdbLogoSize: process.env.TMDB_LOGO_SIZE || 'original',

  // --- Cache / TTL (days). ThePosterDB results are always cached forever regardless. ---
  cacheTtlDaysTmdb: int(process.env.CACHE_TTL_DAYS_TMDB, 30),
  cacheTtlDaysTvdb: int(process.env.CACHE_TTL_DAYS_TVDB, 30),
  cacheTtlDaysMetahub: int(process.env.CACHE_TTL_DAYS_METAHUB, 14),
  // How long a confirmed "nothing found anywhere" result is remembered before trying again -
  // avoids re-querying every provider on every single request for a bad/unmatched id.
  negativeCacheTtlHours: int(process.env.NEGATIVE_CACHE_TTL_HOURS, 12),
  // How long a confirmed "ThePosterDB has no qualifying English+Original poster for this title"
  // result is remembered before trying again. Longer than the general negative cache above,
  // since TPDB's catalog grows slowly - no need to re-crawl it every few hours.
  tpdbNegativeCacheDays: int(process.env.TPDB_NEGATIVE_CACHE_DAYS, 3),
  // How long to back off ThePosterDB after it errors/times out (distinct from a clean "not
  // found" - this is "something went wrong", so retried sooner).
  tpdbErrorBackoffMinutes: int(process.env.TPDB_ERROR_BACKOFF_MINUTES, 20),

  // --- Concurrency / resource usage ---
  // Global cap on simultaneous outbound provider fetches (across all requests).
  maxConcurrentFetches: int(process.env.MAX_CONCURRENT_FETCHES, 8),
  // Concurrency for the low-priority background jobs (slow TPDB catch-up, etc).
  backgroundJobConcurrency: int(process.env.BACKGROUND_JOB_CONCURRENCY, 2),

  // --- Per-provider timeouts (ms) ---
  tpdbTimeoutMs: int(process.env.TPDB_TIMEOUT_MS, 4000),
  tmdbTimeoutMs: int(process.env.TMDB_TIMEOUT_MS, 6000),
  tvdbTimeoutMs: int(process.env.TVDB_TIMEOUT_MS, 6000),
  metahubTimeoutMs: int(process.env.METAHUB_TIMEOUT_MS, 5000),

  // If false (the default), a request never waits on ThePosterDB at all - it's kicked off in the
  // background immediately and the response falls straight through to TMDB/TVDB/Metahub. Set to
  // true to have the *first* request for an item wait up to TPDB_TIMEOUT_MS for ThePosterDB
  // before falling through (useful if you'd rather eat the latency once than serve a TMDB poster
  // temporarily), with the same background-backfill behaviour either way once that wait expires.
  tpdbInlineEnabled: bool(process.env.TPDB_INLINE_ENABLED, false),

  // How many candidate ThePosterDB sets to actually open (each costs one request) before
  // giving up on a title. Keep this modest - it directly controls TPDB load & latency.
  tpdbMaxCandidates: int(process.env.TPDB_MAX_CANDIDATES, 10),

  // --- Placeholder behaviour ---
  // If true, a request that resolves to "no art anywhere" gets a 302 to placeholderUrl
  // instead of a 404, so Stremio/AIOMetadata never shows a broken image icon.
  servePlaceholderOn404: bool(process.env.SERVE_PLACEHOLDER_ON_404, true),
  placeholderPosterUrl: process.env.PLACEHOLDER_POSTER_URL || '',
  placeholderBackdropUrl: process.env.PLACEHOLDER_BACKDROP_URL || '',
  placeholderLogoUrl: process.env.PLACEHOLDER_LOGO_URL || '',
};
