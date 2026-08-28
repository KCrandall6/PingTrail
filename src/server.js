'use strict';

const config = require('./config');
const PingTrailDatabase = require('./database');
const MonitorService = require('./monitor');
const createApp = require('./app');
const logger = require('./logger');

const database = new PingTrailDatabase(config.databasePath);
const monitor = new MonitorService({ database, config });
const app = createApp({ monitor, database });
const server = app.listen(config.port, config.host, () => {
  logger.info(`PingTrail is ready at http://${config.host}:${config.port}`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}; shutting down`);
  monitor.shutdown();
  server.close(() => {
    database.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { app, server };
