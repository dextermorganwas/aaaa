'use strict';
const config = require('../config');

// Optional HTTP Basic Auth in front of the admin UI/API. If ADMIN_USER/ADMIN_PASSWORD are not
// set in the .env, the dashboard is left open - fine for a box that's only reachable on a home
// LAN, but you should set these if you expose this container to the internet.
module.exports = function basicAuth(req, res, next) {
  if (!config.adminUser || !config.adminPassword) return next();

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [user, pass] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
    if (user === config.adminUser && pass === config.adminPassword) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Art Bridge Admin"');
  return res.status(401).send('Authentication required');
};
