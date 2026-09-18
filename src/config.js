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

  // Caps how many extra ("other language/variation") ThePosterDB candidates the admin "browse
  // all options" view shows beyond the primary English/Original set - purely a display limit
  // now, not a request-count knob, since the whole candidate list comes from one page fetch.
  tpdbMaxCandidates: int(process.env.TPDB_MAX_CANDIDATES, 24),
  // ThePosterDB has no official API and no rate-limit contract, so its own concurrency cap is
  // intentionally lower and separate from MAX_CONCURRENT_FETCHES (which also serves TMDB/TVDB,
  // both fine with more parallel load). This is the main lever for how fast this app hits TPDB.
  tpdbMaxConcurrent: int(process.env.TPDB_MAX_CONCURRENT, 3),
  // Minimum spacing (ms) between consecutive ThePosterDB requests, on top of the concurrency
  // cap above - concurrency alone doesn't bound total throughput over time, this does. With the
  // current scraper (2-3 requests per title resolution), the default keeps steady-state
  // throughput to roughly 3-4 requests/second even under a large catalog-scan burst.
  tpdbMinRequestIntervalMs: int(process.env.TPDB_MIN_REQUEST_INTERVAL_MS, 300),

  // --- ThePosterDB "quality gate" ---
  // A ThePosterDB poster is only used if the title has at least this many English/Original
  // candidates to choose from (more candidates tends to mean more community curation and a
  // better pick)...
  tpdbMinCandidates: int(process.env.TPDB_MIN_CANDIDATES, 3),
  // ...OR the title is at least this many years old (newer titles with few uploads tend to have
  // lower-quality posters; that risk goes away once a title's had time to accumulate real
  // community attention). Either condition passing is enough.
  tpdbMinAgeYears: int(process.env.TPDB_MIN_AGE_YEARS, 3),
  tpdbQualityGateEnabled: bool(process.env.TPDB_QUALITY_GATE_ENABLED, true),

  // --- ThePosterDB search breadth ---
  // Some titles have more than one matching disambiguation page on ThePosterDB (duplicate/near-
  // duplicate entries, or a genuinely distinct one that's empty) - this many are tried in order
  // before giving up, so a dead first match doesn't block a working second one.
  tpdbMaxAlternateTitlePages: int(process.env.TPDB_MAX_ALTERNATE_TITLE_PAGES, 3),
  // How many pages of /search results to fetch before giving up on finding a matching title page.
  tpdbMaxSearchPages: int(process.env.TPDB_MAX_SEARCH_PAGES, 2),

  // --- Placeholder behaviour ---
  // If true, a request that resolves to "no art anywhere" gets a 302 to placeholderUrl
  // instead of a 404, so Stremio/AIOMetadata never shows a broken image icon.
  servePlaceholderOn404: bool(process.env.SERVE_PLACEHOLDER_ON_404, true),
  placeholderPosterUrl: process.env.PLACEHOLDER_POSTER_URL || '',
  placeholderBackdropUrl: process.env.PLACEHOLDER_BACKDROP_URL || '',
  placeholderLogoUrl: process.env.PLACEHOLDER_LOGO_URL || '',
};
