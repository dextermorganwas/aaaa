'use strict';
// Coalesces concurrent callers asking for the same key into a single in-flight promise, so
// N simultaneous Stremio requests for the same movie's poster only trigger one resolution chain.
const inFlight = new Map();

function run(key, fn) {
  if (inFlight.has(key)) return inFlight.get(key);
  const p = Promise.resolve()
    .then(fn)
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

module.exports = { run };
