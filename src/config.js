'use strict';

const path = require('node:path');

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const externalTargets = (process.env.PINGTRAIL_EXTERNAL_TARGETS || '1.1.1.1,8.8.8.8')
  .split(',')
  .map((target) => target.trim())
  .filter(Boolean);

module.exports = Object.freeze({
  host: process.env.PINGTRAIL_HOST || '127.0.0.1',
  port: positiveInteger(process.env.PORT, 3000),
  databasePath: process.env.PINGTRAIL_DB_PATH || path.join(process.cwd(), 'data', 'pingtrail.sqlite'),
  monitoringIntervalMs: positiveInteger(process.env.PINGTRAIL_MONITOR_INTERVAL_MS, 30_000),
  pingCount: positiveInteger(process.env.PINGTRAIL_PING_COUNT, 5),
  pingTimeoutMs: positiveInteger(process.env.PINGTRAIL_PING_TIMEOUT_MS, 5_000),
  externalTargets,
  speedTestIntervalMs: positiveInteger(process.env.PINGTRAIL_SPEED_INTERVAL_MS, 3_600_000),
  speedTestDownloadBytes: positiveInteger(process.env.PINGTRAIL_SPEED_DOWNLOAD_BYTES, 25_000_000),
  speedTestUploadBytes: positiveInteger(process.env.PINGTRAIL_SPEED_UPLOAD_BYTES, 10_000_000),
  chartPointLimit: positiveInteger(process.env.PINGTRAIL_CHART_POINT_LIMIT, 500)
});
