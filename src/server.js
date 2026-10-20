"use strict";

const config = require("./config");
const PingTrailDatabase = require("./database");
const MonitorService = require("./monitor");
const createApp = require("./app");
const logger = require("./logger");

const database = new PingTrailDatabase(config.databasePath);
const monitor = new MonitorService({ database, config });
const app = createApp({ monitor, database, config });
void monitor.initialize();
const { retentionBatch } = require("./history");
function cleanup() {
  try {
    const result = retentionBatch(database.db, config.retention);
    if (result.minute || result.hourly)
      cleanupTimer = setTimeout(cleanup, 1000);
    else cleanupTimer = setTimeout(cleanup, 86_400_000);
    cleanupTimer.unref();
  } catch {
    logger.error("Retention cleanup failed; retrying in one hour");
    cleanupTimer = setTimeout(cleanup, 3_600_000);
    cleanupTimer.unref();
  }
}
let cleanupTimer = setTimeout(cleanup, 1000);
cleanupTimer.unref();
const server = app.listen(config.port, config.host, () => {
  logger.info(`PingTrail is ready at http://${config.host}:${config.port}`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}; shutting down`);
  clearTimeout(cleanupTimer);
  const drained = monitor.shutdown();
  server.close(async () => {
    await drained;
    database.close();
    process.exit(0);
  });
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 150_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

module.exports = { app, server };
