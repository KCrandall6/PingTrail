"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { validateTarget } = require("./network");
const serverProfile = process.env.PINGTRAIL_PROFILE === "server";
const boolean = (name, fallback) => {
  if (process.env[name] == null) return fallback;
  if (!["true", "false"].includes(process.env[name]))
    throw new RangeError("Boolean configuration must be true or false.");
  return process.env[name] === "true";
};
const apiToken = process.env.PINGTRAIL_API_TOKEN_FILE
  ? fs.readFileSync(process.env.PINGTRAIL_API_TOKEN_FILE, "utf8").trim()
  : process.env.PINGTRAIL_API_TOKEN;
if (
  (serverProfile ||
    apiToken ||
    !["127.0.0.1", "localhost", "::1"].includes(
      process.env.PINGTRAIL_HOST || "127.0.0.1",
    )) &&
  (!apiToken || apiToken.length < 32)
)
  throw new Error(
    "Server profile requires an API token of at least 32 characters.",
  );

function positiveInteger(value, fallback) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > Math.max(fallback * 10, 1000)
  ) {
    throw new RangeError("Numeric configuration exceeds supported bounds.");
  }
  return parsed;
}

const externalTargets = (
  process.env.PINGTRAIL_EXTERNAL_TARGETS || "1.1.1.1,8.8.8.8"
)
  .split(",")
  .map((target) => target.trim())
  .filter(Boolean);
if (!externalTargets.length || externalTargets.length > 4)
  throw new Error("Configure one to four external targets.");
externalTargets.forEach(validateTarget);
const routerTarget = process.env.PINGTRAIL_ROUTER_TARGET
  ? validateTarget(process.env.PINGTRAIL_ROUTER_TARGET)
  : null;
if (serverProfile && !routerTarget)
  throw new Error("Server profile requires an explicit router target.");

const result = {
  apiToken,
  autoStart: boolean("PINGTRAIL_AUTO_START", serverProfile),
  automaticSpeedTests: boolean("PINGTRAIL_AUTO_SPEED_TESTS", true),
  routerTarget,
  retention: {
    rawDays: positiveInteger(process.env.PINGTRAIL_RAW_DAYS, 7),
    minuteDays: positiveInteger(process.env.PINGTRAIL_MINUTE_DAYS, 30),
    hourlyDays: positiveInteger(process.env.PINGTRAIL_HOURLY_DAYS, 365),
    markerDays: positiveInteger(process.env.PINGTRAIL_MARKER_DAYS, 730),
    testDays: positiveInteger(process.env.PINGTRAIL_TEST_DAYS, 365),
  },
  host: process.env.PINGTRAIL_HOST || "127.0.0.1",
  port: positiveInteger(process.env.PORT, 3000),
  databasePath:
    process.env.PINGTRAIL_DB_PATH ||
    path.join(process.cwd(), "data", "pingtrail.sqlite"),
  monitoringIntervalMs: positiveInteger(
    process.env.PINGTRAIL_MONITOR_INTERVAL_MS,
    10_000,
  ),
  diagnosticIntervalMs: 2_000,
  diagnosticDurationMs: 60_000,
  diagnosticLatencyThresholdMs: 100,
  diagnosticJitterThresholdMs: 50,
  pingCount: positiveInteger(process.env.PINGTRAIL_PING_COUNT, 5),
  pingTimeoutMs: positiveInteger(process.env.PINGTRAIL_PING_TIMEOUT_MS, 5_000),
  externalTargets,
  speedTestIntervalMs: positiveInteger(
    process.env.PINGTRAIL_SPEED_INTERVAL_MS,
    3_600_000,
  ),
  speedTestDownloadBytes: positiveInteger(
    process.env.PINGTRAIL_SPEED_DOWNLOAD_BYTES,
    25_000_000,
  ),
  speedTestUploadBytes: positiveInteger(
    process.env.PINGTRAIL_SPEED_UPLOAD_BYTES,
    10_000_000,
  ),
  connectionTestMinimumLoadMs: positiveInteger(
    process.env.PINGTRAIL_CONNECTION_MIN_LOAD_MS,
    8_000,
  ),
  connectionTestBaselinePings: positiveInteger(
    process.env.PINGTRAIL_CONNECTION_BASELINE_PINGS,
    8,
  ),
  chartPointLimit: positiveInteger(
    process.env.PINGTRAIL_CHART_POINT_LIMIT,
    500,
  ),
};
if (
  result.retention.rawDays > result.retention.minuteDays ||
  result.retention.minuteDays > result.retention.hourlyDays
)
  throw new RangeError("Retention tiers must be ordered.");
module.exports = Object.freeze(result);
