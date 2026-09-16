'use strict';
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const config = require('./config');
const current = LEVELS[config.logLevel] ?? LEVELS.info;

function ts() {
  return new Date().toISOString();
}

function make(level) {
  return (...args) => {
    if (LEVELS[level] > current) return;
    const line = `[${ts()}] [${level.toUpperCase()}]`;
    if (level === 'error') console.error(line, ...args);
    else if (level === 'warn') console.warn(line, ...args);
    else console.log(line, ...args);
  };
}

module.exports = {
  error: make('error'),
  warn: make('warn'),
  info: make('info'),
  debug: make('debug'),
};
