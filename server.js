'use strict';
const path = require('path');
const express = require('express');
const config = require('./src/config');
const logger = require('./src/logger');
require('./src/db'); // initializes schema on require

const artRoutes = require('./src/routes/artRoutes');
const adminApi = require('./src/routes/adminApi');
const basicAuth = require('./src/routes/basicAuth');

const app = express();
if (config.trustProxy) app.set('trust proxy', true);

app.disable('x-powered-by');

// Lightweight request log for the art endpoints only (avoid noisy admin polling in the log).
app.use((req, res, next) => {
  if (req.path.startsWith('/poster/') || req.path.startsWith('/backdrop/') || req.path.startsWith('/logo/')) {
    logger.debug(`${req.method} ${req.path}`);
  }
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

// Artwork endpoints consumed by AIOMetadata - intentionally unauthenticated, since Stremio
// itself has no way to send credentials for a poster/backdrop/logo URL.
app.use('/', artRoutes);

// Admin dashboard (static assets + JSON API), optionally behind HTTP Basic Auth.
app.use('/admin', basicAuth, express.static(path.join(__dirname, 'public', 'admin')));
app.use('/api/admin', basicAuth, adminApi);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal error' });
});

const server = app.listen(config.port, () => {
  logger.info(`stremio-art-bridge listening on :${config.port}`);
  logger.info(`Admin dashboard: http://localhost:${config.port}/admin`);
});

// --- Graceful shutdown ---
// Stop accepting new connections, let in-flight requests (including a slow ThePosterDB fetch
// mid-flight) finish, then exit. Force-exit after a grace period in case something is stuck.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}, shutting down gracefully...`);
  server.close((err) => {
    if (err) {
      logger.error('Error during server close:', err);
      process.exit(1);
    }
    logger.info('All connections closed. Bye.');
    process.exit(0);
  });
  setTimeout(() => {
    logger.warn('Graceful shutdown timed out after 15s, forcing exit.');
    process.exit(1);
  }, 15000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error('Unhandled promise rejection:', reason));
