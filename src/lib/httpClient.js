'use strict';
const pLimit = require('p-limit');
const config = require('../config');
const logger = require('../logger');

// Global cap on simultaneous outbound provider requests, so a burst of Stremio requests
// (e.g. a catalog page rendering 40 posters at once) can't hammer TMDB/TVDB/TPDB or exhaust
// this container's own resources. Tune with MAX_CONCURRENT_FETCHES.
const limit = pLimit(config.maxConcurrentFetches);

const UA = 'stremio-art-bridge/1.0 (+self-hosted; https://github.com/)';

/**
 * fetch() with a hard timeout and a shared concurrency gate.
 * Throws on non-2xx by default (set allow404 to treat 404 as a soft "null" instead of throwing).
 */
const RETRYABLE_STATUSES = new Set([429, 503]);

function parseRetryAfter(res) {
  const header = res.headers.get('retry-after');
  if (!header) return null;
  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds)) return asSeconds * 1000;
  const asDate = Date.parse(header);
  return Number.isFinite(asDate) ? Math.max(0, asDate - Date.now()) : null;
}

async function limitedFetch(url, { timeoutMs = 8000, headers = {}, allow404 = false, method = 'GET', body, maxRetries = 3 } = {}) {
  return limit(async () => {
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      try {
        res = await fetch(url, {
          method,
          body,
          headers: { 'User-Agent': UA, ...headers },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.status === 404 && allow404) return null;

      // A 429/503 is the server telling us to slow down, not a permanent failure - retrying
      // with backoff (honoring Retry-After when the server sends one) is the correct response,
      // not an immediate error. Treating this as fatal was the actual cause of ThePosterDB
      // backfills failing in bursts (e.g. right after a restart, when several items need
      // checking around the same time) - the throttle/concurrency limits reduce how often this
      // happens, but can't eliminate it, so it needs to be handled gracefully when it does.
      if (RETRYABLE_STATUSES.has(res.status) && attempt < maxRetries) {
        const waitMs = Math.min(parseRetryAfter(res) || 1000 * 2 ** attempt, 30000);
        logger.warn(`HTTP ${res.status} from ${url} - retrying in ${Math.round(waitMs)}ms (attempt ${attempt + 1}/${maxRetries}).`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} for ${url}: ${text.slice(0, 200)}`);
      }
      return res;
    }
  });
}

async function fetchJson(url, opts) {
  const res = await limitedFetch(url, opts);
  if (!res) return null;
  return res.json();
}

async function fetchText(url, opts) {
  const res = await limitedFetch(url, opts);
  if (!res) return null;
  return res.text();
}

async function fetchBuffer(url, opts) {
  const res = await limitedFetch(url, opts);
  if (!res) return null;
  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  const arrayBuf = await res.arrayBuffer();
  return { buffer: Buffer.from(arrayBuf), contentType };
}

/** Runs an async function against a timeout without aborting the underlying work - used for
 *  "try ThePosterDB but don't block the response if it's slow" while letting it finish in the
 *  background. Resolves { timedOut: true } if the deadline passes first. */
function raceWithBackground(promise, timeoutMs) {
  let settled = false;
  const timeout = new Promise((resolve) => {
    setTimeout(() => {
      if (!settled) resolve({ timedOut: true });
    }, timeoutMs);
  });
  const wrapped = promise.then(
    (value) => {
      settled = true;
      return { timedOut: false, value };
    },
    (err) => {
      settled = true;
      logger.debug('background-raced promise failed:', err.message);
      return { timedOut: false, value: null, error: err };
    }
  );
  return Promise.race([wrapped, timeout]);
}

module.exports = { limitedFetch, fetchJson, fetchText, fetchBuffer, raceWithBackground };
