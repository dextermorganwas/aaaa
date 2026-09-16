'use strict';
const pLimit = require('p-limit');
const config = require('../config');
const logger = require('../logger');

// Low-priority queue for work that continues after a request has already been answered
// (e.g. a slow ThePosterDB lookup that we didn't want to block the response on). Kept separate
// from the main outbound-fetch limiter so a burst of these can't starve live requests, and capped
// on its own so it can't pile up unboundedly either.
const limit = pLimit(config.backgroundJobConcurrency);
let pending = 0;

function schedule(label, fn) {
  pending += 1;
  limit(fn)
    .catch((e) => logger.warn(`Background job "${label}" failed:`, e.message))
    .finally(() => {
      pending -= 1;
    });
}

function pendingCount() {
  return pending;
}

module.exports = { schedule, pendingCount };
