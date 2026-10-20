"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const DB = require("../src/database");
const Monitor = require("../src/monitor");
const createApp = require("../src/app");
const { retentionBatch, history, DAY, storage } = require("../src/history");
const { rollingGrade, assess } = require("../src/rolling-grade");
const { validateTarget, detectDefaultGateway } = require("../src/network");
const config = {
  monitoringIntervalMs: 10000,
  diagnosticIntervalMs: 2000,
  externalTargets: ["1.1.1.1"],
  routerTarget: "192.0.2.1",
  speedTestIntervalMs: 3600000,
  automaticSpeedTests: false,
  autoStart: true,
};
const log = { info() {}, warn() {}, error() {} };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pingtrail-phase4-"));
  const filename = path.join(dir, "test.sqlite");
  const db = new DB(filename);
  t.after(async () => {
    if (db.db.open) {
      for (const m of db.testMonitors || []) await m.shutdown();
      db.close();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, filename };
}
function drain(db, now) {
  for (let i = 0; i < 1000; i++) {
    const result = retentionBatch(db, undefined, now);
    if (!result.minute && !result.hourly) return;
  }
  throw new Error("Cleanup backlog did not finish");
}
function row(id, at, extra = {}) {
  return {
    sessionId: id,
    recordedAt: new Date(at).toISOString(),
    checkId: `${at}-${Math.random()}`,
    target: "1.1.1.1",
    targetType: "external",
    packetsSent: 5,
    packetsReceived: 5,
    packetLoss: 0,
    minLatency: 5,
    avgLatency: 10,
    maxLatency: 15,
    jitter: 2,
    ...extra,
  };
}
function monitor(db, extra = {}) {
  const m = new Monitor({
    database: db,
    config: { ...config, ...extra },
    log,
    networkService: {
      detectDefaultGateway: async () => {
        throw Error("must use explicit router");
      },
      pingTarget: async () => ({
        packetsSent: 5,
        packetsReceived: 5,
        packetLoss: 0,
        minLatency: 1,
        avgLatency: 2,
        maxLatency: 3,
        jitter: 1,
      }),
    },
  });
  (db.testMonitors ||= []).push(m);
  return m;
}

test("desired state survives graceful shutdown and crash recovery, while pause remains durable", async (t) => {
  const { db, filename } = fixture(t);
  let m = monitor(db);
  await m.initialize();
  clearTimeout(m.monitorTimer);
  assert.equal(m.active, true);
  const id = m.session.id;
  assert.equal(m.speedTimer, null);
  await m.runMonitoringJob();
  assert.equal(m.gateway, "192.0.2.1");
  assert.equal(db.getLatestCheck(id).length, 2);
  await m.shutdown();
  assert.equal(db.getDesiredState().desired, 1);
  db.close();
  const reopened = new DB(filename);
  t.after(() => reopened.close());
  m = monitor(reopened);
  await m.initialize();
  clearTimeout(m.monitorTimer);
  assert.equal(m.session.id, id);
  // Simulate abrupt loss of timers/process without a stop write.
  clearTimeout(m.monitorTimer);
  reopened.recoverInterruptedSessions();
  const recovered = monitor(reopened);
  await recovered.initialize();
  clearTimeout(recovered.monitorTimer);
  assert.equal(recovered.session.id, id);
  recovered.stop();
  const paused = monitor(reopened);
  await paused.initialize();
  assert.equal(paused.active, false);
  await paused.start();
  clearTimeout(paused.monitorTimer);
  assert.notEqual(paused.session.id, id);
  await paused.shutdown();
});

test("standalone default stays stopped without a persisted preference", async (t) => {
  const { db } = fixture(t);
  const m = monitor(db, { autoStart: false });
  await m.initialize();
  assert.equal(m.active, false);
});

test("retention is transactional, count weighted, tiered, repeatable and preserves markers", (t) => {
  const { db } = fixture(t),
    id = db.createSession().id,
    now = Date.parse("2026-10-20T12:00:00Z");
  const old = now - 8 * DAY;
  db.insertSamples([
    row(id, old, {
      packetsSent: 10,
      packetsReceived: 0,
      packetLoss: 100,
      avgLatency: null,
      minLatency: null,
      maxLatency: null,
      jitter: 0,
    }),
    row(id, old + 10000),
    row(id, now - 31 * DAY),
    row(id, now - 366 * DAY),
    row(id, now - 7 * DAY),
  ]);
  db.insertProblem(id, "retained marker");
  assert.throws(
    () =>
      retentionBatch(db.db, undefined, now, () => {
        throw Error("interrupted");
      }),
    /interrupted/,
  );
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS n FROM network_samples").get().n,
    5,
  );
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS n FROM sample_rollups").get().n,
    0,
  );
  drain(db.db, now);
  const minute = db.db
    .prepare("SELECT * FROM sample_rollups WHERE tier=60000")
    .get();
  assert.equal(minute.samples, 2);
  assert.equal(minute.sent, 15);
  assert.equal(minute.received, 5);
  assert.equal(minute.unreachable, 1);
  assert.equal(minute.latency_sum / minute.latency_weight, 10);
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS n FROM network_samples").get().n,
    1,
  );
  assert.equal(
    db.db
      .prepare("SELECT COUNT(*) AS n FROM sample_rollups WHERE tier=3600000")
      .get().n,
    1,
  );
  const snapshot = db.db
    .prepare("SELECT * FROM sample_rollups ORDER BY tier,bucket")
    .all();
  drain(db.db, now);
  assert.deepEqual(
    db.db.prepare("SELECT * FROM sample_rollups ORDER BY tier,bucket").all(),
    snapshot,
  );
  const data = history(db.db, {
    start: old - 1,
    end: old + 60000,
    resolution: 60000,
  });
  assert.equal(data.points.length, 1);
  assert.ok(Math.abs(data.points[0].packetLoss - 66.6666667) < 0.001);
  assert.equal(db.getProblems(id).length, 1);
  const info = storage(db.db);
  assert.ok(info.databaseBytes > 0);
  assert.equal(JSON.stringify(info).includes("/tmp/"), false);
});

test("retention boundaries preserve whole recent buckets and migration preserves old schema data", (t) => {
  const { db, filename } = fixture(t),
    id = db.createSession().id,
    now = Date.parse("2026-10-20T12:00:00Z");
  db.insertSamples([
    row(id, now - 7 * DAY),
    row(id, now - 7 * DAY - 1),
    row(id, now - 30 * DAY),
    row(id, now - 365 * DAY),
  ]);
  drain(db.db, now);
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS n FROM network_samples").get().n,
    1,
  );
  assert.equal(
    db.db.prepare("SELECT SUM(samples) AS n FROM measurement_history").get().n,
    4,
  );
  db.close();
  const reopened = new DB(filename);
  assert.equal(
    reopened.db
      .prepare("SELECT SUM(samples) AS n FROM measurement_history")
      .get().n,
    4,
  );
  reopened.close();
});

test("history reports inter-sample gaps and internal rollup gaps without making samples", (t) => {
  const { db } = fixture(t),
    id = db.createSession().id,
    now = Date.now(),
    old = now - 32 * DAY;
  db.insertSamples([
    row(id, old),
    row(id, old + 300000),
    row(id, now - 300000),
    row(id, now - 1000),
  ]);
  drain(db.db, now);
  const h = history(db.db, {
    start: old - 1000,
    end: now,
    resolution: 3600000,
  });
  assert.ok(h.gaps.length >= 2);
  assert.equal(
    h.points.reduce((n, r) => n + r.sampleCount, 0),
    4,
  );
  assert.ok(h.points.some((p) => p.maxGapMs > 90000));
});

test("rolling grades require coverage, freshness and every configured target", (t) => {
  const { db } = fixture(t),
    id = db.createSession().id,
    now = Date.now();
  assert.equal(rollingGrade(db.db, { now }).grade, null);
  db.insertSamples(
    Array.from({ length: 30 }, (_, i) => row(id, now - i * 60000)),
  );
  assert.equal(rollingGrade(db.db, { now }).grade, "A");
  assert.equal(
    rollingGrade(db.db, { now, active: false }).status,
    "unavailable",
  );
  assert.equal(rollingGrade(db.db, { now: now + 120000 }).grade, null);
  assert.equal(
    rollingGrade(db.db, {
      now,
      targets: [{ target: "192.0.2.1", targetType: "router" }],
    }).grade,
    null,
  );
  assert.equal(
    assess({
      sent: 10,
      received: 0,
      samples: 2,
      jitter: 0,
      weight: 0,
      latency: 0,
    }).grade,
    "F",
  );
  assert.equal(
    assess({
      sent: 100,
      received: 100,
      samples: 1,
      jitter: 80,
      weight: 100,
      latency: 1000,
    }).grade,
    "F",
  );
});

test("IPv4 validation rejects injection, metadata, loopback and multicast; Linux gateway parsing works", async () => {
  for (const value of [
    "example.com",
    "127.0.0.1",
    "169.254.169.254",
    "224.0.0.1",
    "-c 100",
    "1.1.1.1;id",
    "::1",
    "0.1.2.3",
  ])
    assert.throws(() => validateTarget(value));
  assert.equal(validateTarget("192.0.2.1"), "192.0.2.1");
  assert.equal(
    await detectDefaultGateway({
      platform: "linux",
      execFile: async (cmd, args) => {
        assert.equal(cmd, "ip");
        assert.deepEqual(args, ["-4", "route", "show", "default"]);
        return { stdout: "default via 192.0.2.1 dev eth0 proto dhcp\n" };
      },
    }),
    "192.0.2.1",
  );
});

test("server profile fails closed without token/router; malformed config is rejected", () => {
  for (const extra of [
    { PINGTRAIL_PROFILE: "server" },
    { PINGTRAIL_EXTERNAL_TARGETS: "127.0.0.1" },
    { PINGTRAIL_PING_COUNT: "99999999" },
    { PINGTRAIL_RAW_DAYS: "40" },
  ]) {
    const r = spawnSync(process.execPath, ["-e", "require('./src/config')"], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, ...extra },
      encoding: "utf8",
    });
    assert.notEqual(r.status, 0);
  }
});
async function serve(t, app) {
  const s = app.listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  t.after(() => new Promise((r) => s.close(r)));
  return `http://127.0.0.1:${s.address().port}`;
}

test("authenticated APIs bound history, validate mutations, hide paths and throttle bandwidth tests", async (t) => {
  const { db } = fixture(t),
    m = monitor(db);
  await m.initialize();
  clearTimeout(m.monitorTimer);
  await m.runMonitoringJob();
  m.runConnectionTest = async () => true;
  const token = "test-only-placeholder-32-characters";
  const base = await serve(
    t,
    createApp({
      database: db,
      monitor: m,
      config: { ...config, apiToken: token },
    }),
  );
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  assert.equal((await fetch(base + "/api/state")).status, 401);
  assert.equal((await fetch(base + "/api/health")).status, 200);
  assert.equal(
    (
      await fetch(base + "/api/monitor/start", {
        method: "POST",
        headers: { ...headers, origin: "https://untrusted.example" },
      })
    ).status,
    403,
  );
  for (const query of [
    "range=forever",
    "range=7d&extra=1",
    "range=7d&range=1h",
  ])
    assert.equal(
      (await fetch(base + "/api/history?" + query, { headers })).status,
      400,
    );
  const h = await (
    await fetch(base + "/api/history?range=7d", { headers })
  ).json();
  assert.ok(h.points.length <= 2000);
  assert.equal(
    (await fetch(base + "/api/connection-tests?limit=99", { headers })).status,
    400,
  );
  const invalid = await fetch(base + "/api/problems", {
    method: "POST",
    headers,
    body: JSON.stringify({ note: 5 }),
  });
  assert.equal(invalid.status, 400);
  const marker = await (
    await fetch(base + "/api/problems", {
      method: "POST",
      headers,
      body: JSON.stringify({ note: "lag" }),
    })
  ).json();
  assert.equal(marker.note, "lag");
  assert.ok(marker.recordedAt);
  assert.equal(
    (
      await fetch(base + "/api/problems", {
        method: "POST",
        headers,
        body: "{",
      })
    ).status,
    400,
  );
  assert.equal(
    (await fetch(base + "/api/connection-test", { method: "POST", headers }))
      .status,
    202,
  );
  assert.equal(
    (await fetch(base + "/api/connection-test", { method: "POST", headers }))
      .status,
    429,
  );
  const summary = await (
    await fetch(base + "/api/summary", { headers })
  ).json();
  assert.ok(summary.rollingGrade);
  assert.equal(summary.recentLagEventCount, 1);
  assert.equal(
    JSON.stringify(
      await (await fetch(base + "/api/storage", { headers })).json(),
    ).includes("/tmp/"),
    false,
  );
});

test("local standalone API rejects hostile Host and cross-origin requests; mutation budget is bounded", async (t) => {
  const { db } = fixture(t),
    m = monitor(db, { autoStart: false });
  const base = await serve(t, createApp({ monitor: m, database: db }));
  const status = await new Promise((resolve, reject) => {
    require("node:http")
      .get(
        base + "/api/state",
        { headers: { Host: "untrusted.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      )
      .on("error", reject);
  });
  assert.equal(status, 403);
  assert.equal((await fetch(base + "/api/state")).status, 200);
  for (let i = 0; i < 30; i++)
    assert.equal(
      (await fetch(base + "/api/monitor/stop", { method: "POST" })).status,
      200,
    );
  assert.equal(
    (await fetch(base + "/api/monitor/stop", { method: "POST" })).status,
    429,
  );
});

test("cleanup can resume a backlog and merge late sources without duplication", (t) => {
  const { db } = fixture(t),
    id = db.createSession().id,
    now = Date.parse("2026-10-20T12:00:00Z"),
    old = now - 10 * DAY;
  db.insertSamples(
    Array.from({ length: 130 }, (_, i) => row(id, old + i * 60000)),
  );
  retentionBatch(db.db, undefined, now);
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS n FROM network_samples").get().n,
    10,
  );
  retentionBatch(db.db, undefined, now);
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS n FROM network_samples").get().n,
    0,
  );
  db.insertSamples([
    row(id, old + 1000, {
      packetsSent: 10,
      packetsReceived: 5,
      packetLoss: 50,
    }),
  ]);
  retentionBatch(db.db, undefined, now);
  retentionBatch(db.db, undefined, now);
  assert.equal(
    db.db.prepare("SELECT SUM(samples) AS n FROM measurement_history").get().n,
    131,
  );
  const summary = db.getSessionSummary(id);
  assert.equal(summary.packetLossEvents, 1);
  assert.equal(summary.worstPacketLoss, 50);
});

test("shutdown drains an in-flight measurement and discards detached results", async (t) => {
  const { db } = fixture(t),
    m = monitor(db);
  await m.start();
  clearTimeout(m.monitorTimer);
  let release;
  const pending = new Promise((resolve) => (release = resolve));
  m.network.pingTarget = () => pending;
  const job = m.runMonitoringJob();
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = m.shutdown();
  let finished = false;
  stopping.then(() => (finished = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  release({
    packetsSent: 1,
    packetsReceived: 1,
    packetLoss: 0,
    minLatency: 1,
    avgLatency: 1,
    maxLatency: 1,
    jitter: 0,
  });
  await job;
  await stopping;
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS n FROM network_samples").get().n,
    0,
  );
});

test("resumed hourly scheduling uses persisted result time and can be disabled independently", async (t) => {
  const { db } = fixture(t),
    m = monitor(db, { automaticSpeedTests: true });
  await m.start();
  clearTimeout(m.monitorTimer);
  clearTimeout(m.speedTimer);
  const id = m.session.id;
  db.db
    .prepare("UPDATE sessions SET started_at=? WHERE id=?")
    .run(new Date(Date.now() - 7200000).toISOString(), id);
  await m.shutdown();
  const resumed = monitor(db, { automaticSpeedTests: true });
  let due;
  resumed.scheduleSpeedTest = (delay) => {
    due = delay;
  };
  await resumed.initialize();
  clearTimeout(resumed.monitorTimer);
  assert.equal(due, 0);
  await resumed.shutdown();
  const disabled = monitor(db);
  await disabled.initialize();
  clearTimeout(disabled.monitorTimer);
  assert.equal(disabled.speedTimer, null);
  await disabled.shutdown();
});

test("legacy baseline database migrates without discarding samples or old speed results", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pingtrail-legacy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, "legacy.sqlite");
  const sql = new (require("better-sqlite3"))(filename);
  sql.exec(`CREATE TABLE sessions(id INTEGER PRIMARY KEY AUTOINCREMENT,started_at TEXT NOT NULL,ended_at TEXT,status TEXT NOT NULL);
 CREATE TABLE network_samples(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id INTEGER NOT NULL REFERENCES sessions(id),check_id TEXT NOT NULL,recorded_at TEXT NOT NULL,target TEXT NOT NULL,target_type TEXT NOT NULL,packets_sent INTEGER NOT NULL,packets_received INTEGER NOT NULL,packet_loss REAL NOT NULL,min_latency REAL,avg_latency REAL,max_latency REAL,jitter REAL NOT NULL);
 CREATE TABLE speed_tests(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id INTEGER NOT NULL REFERENCES sessions(id),recorded_at TEXT NOT NULL,download_mbps REAL,upload_mbps REAL,latency REAL,error TEXT);
 INSERT INTO sessions VALUES(1,'2025-01-01T00:00:00.000Z',NULL,'active');
 INSERT INTO network_samples VALUES(1,1,'legacy','2025-01-01T00:00:00.000Z','1.1.1.1','external',5,4,20,1,2,3,1);
 INSERT INTO speed_tests VALUES(1,1,'2025-01-01T00:00:00.000Z',100,20,10,NULL);`);
  sql.close();
  const db = new DB(filename);
  try {
    assert.equal(db.getSessionSummary(1).sampleCount, 1);
    assert.equal(db.getLatestSpeedTest(1).downloadMbps, 100);
    assert.equal(db.getSession(1).status, "interrupted");
    assert.equal(db.getDesiredState(), null);
  } finally {
    db.close();
  }
});

test("missing ping permissions produce a diagnostic gap rather than invented packet loss", async (t) => {
  const { db } = fixture(t),
    m = monitor(db);
  await m.start();
  clearTimeout(m.monitorTimer);
  m.network.pingTarget = async () => {
    throw Error("ping unavailable");
  };
  await m.runMonitoringJob();
  assert.equal(db.getSessionSummary(m.session.id).sampleCount, null);
  assert.ok(m.lastMeasurementError);
  await assert.rejects(
    require("../src/network").pingTarget("1.1.1.1", {
      execFile: async () => {
        const e = Error("not installed");
        e.code = "ENOENT";
        throw e;
      },
    }),
    /unavailable/,
  );
  await m.shutdown();
});
