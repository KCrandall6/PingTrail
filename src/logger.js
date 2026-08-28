'use strict';

function write(level, message, details) {
  const suffix = details ? ` ${details instanceof Error ? details.stack : JSON.stringify(details)}` : '';
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${suffix}`;
  (level === 'error' ? console.error : console.log)(line);
}

module.exports = {
  info: (message, details) => write('info', message, details),
  warn: (message, details) => write('warn', message, details),
  error: (message, details) => write('error', message, details)
};
