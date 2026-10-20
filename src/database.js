"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

class PingTrailDatabase {
  constructor(filename) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.transaction(() => {
      this.migrate();
      require("./history").migrate(this.db);
    })();
    this.recoverInterruptedSessions();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL CHECK(status IN ('active', 'stopped', 'interrupted'))
      );
      CREATE TABLE IF NOT EXISTS network_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        check_id TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        target TEXT NOT NULL,
        target_type TEXT NOT NULL CHECK(target_type IN ('router', 'external')),
        packets_sent INTEGER NOT NULL,
        packets_received INTEGER NOT NULL,
        packet_loss REAL NOT NULL,
        min_latency REAL,
        avg_latency REAL,
        max_latency REAL,
        jitter REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_samples_session_time ON network_samples(session_id, recorded_at);
      CREATE INDEX IF NOT EXISTS idx_samples_check ON network_samples(check_id);
      CREATE TABLE IF NOT EXISTS speed_tests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        recorded_at TEXT NOT NULL,
        download_mbps REAL,
        upload_mbps REAL,
        latency REAL,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_speed_session_time ON speed_tests(session_id, recorded_at);
      CREATE TABLE IF NOT EXISTS problem_markers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        recorded_at TEXT NOT NULL,
        note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_problems_session_time ON problem_markers(session_id, recorded_at);
    `);
    const speedColumns = new Set(
      this.db
        .prepare("PRAGMA table_info(speed_tests)")
        .all()
        .map((column) => column.name),
    );
    const additions = {
      trigger_type:
        "TEXT NOT NULL DEFAULT 'automatic' CHECK(trigger_type IN ('manual', 'automatic'))",
      target: "TEXT",
      status: "TEXT NOT NULL DEFAULT 'complete'",
      unloaded_latency: "REAL",
      unloaded_min_latency: "REAL",
      unloaded_max_latency: "REAL",
      unloaded_jitter: "REAL",
      unloaded_packet_loss: "REAL",
      download_loaded_latency: "REAL",
      download_loaded_jitter: "REAL",
      download_loaded_packet_loss: "REAL",
      download_latency_increase: "REAL",
      upload_loaded_latency: "REAL",
      upload_loaded_jitter: "REAL",
      upload_loaded_packet_loss: "REAL",
      upload_latency_increase: "REAL",
    };
    for (const [name, definition] of Object.entries(additions)) {
      if (!speedColumns.has(name))
        this.db.exec(
          `ALTER TABLE speed_tests ADD COLUMN ${name} ${definition}`,
        );
    }
  }

  recoverInterruptedSessions() {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE sessions SET status = 'interrupted', ended_at = ? WHERE status = 'active'",
      )
      .run(now);
  }

  getDesiredState() {
    return (
      this.db
        .prepare(
          "SELECT desired, session_id AS sessionId FROM monitor_preferences WHERE id=1",
        )
        .get() || null
    );
  }

  setDesiredState(desired, sessionId) {
    this.db
      .prepare(
        "INSERT INTO monitor_preferences VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET desired=excluded.desired,session_id=excluded.session_id",
      )
      .run(desired ? 1 : 0, sessionId);
  }

  resumeSession(id) {
    this.db
      .prepare("UPDATE sessions SET status='active',ended_at=NULL WHERE id=?")
      .run(id);
    return this.getSession(id);
  }

  createSession() {
    const startedAt = new Date().toISOString();
    const result = this.db
      .prepare("INSERT INTO sessions (started_at, status) VALUES (?, 'active')")
      .run(startedAt);
    return {
      id: Number(result.lastInsertRowid),
      startedAt,
      endedAt: null,
      status: "active",
    };
  }

  stopSession(id, status = "stopped") {
    const endedAt = new Date().toISOString();
    const statement = this.db.prepare(
      "UPDATE sessions SET ended_at = ?, status = ? WHERE id = ? AND status = 'active'",
    );
    statement.run(endedAt, status, id);
    return endedAt;
  }

  insertSamples(samples) {
    const insert = this.db.prepare(`INSERT INTO network_samples
      (session_id, check_id, recorded_at, target, target_type, packets_sent, packets_received,
       packet_loss, min_latency, avg_latency, max_latency, jitter)
      VALUES (@sessionId, @checkId, @recordedAt, @target, @targetType, @packetsSent,
       @packetsReceived, @packetLoss, @minLatency, @avgLatency, @maxLatency, @jitter)`);
    const insertMany = this.db.transaction((rows) => {
      for (const row of rows) insert.run(row);
    });
    insertMany(samples);
  }

  insertSpeedTest(result) {
    const query = `INSERT INTO speed_tests
      (session_id, recorded_at, trigger_type, target, status, unloaded_latency, unloaded_min_latency,
       unloaded_max_latency, unloaded_jitter, unloaded_packet_loss, download_mbps,
       download_loaded_latency, download_loaded_jitter, download_loaded_packet_loss,
       download_latency_increase, upload_mbps, upload_loaded_latency, upload_loaded_jitter,
       upload_loaded_packet_loss, upload_latency_increase, latency, error)
      VALUES (@sessionId, @recordedAt, @triggerType, @target, @status, @unloadedLatency,
       @unloadedMinLatency, @unloadedMaxLatency, @unloadedJitter, @unloadedPacketLoss,
       @downloadMbps, @downloadLoadedLatency, @downloadLoadedJitter, @downloadLoadedPacketLoss,
       @downloadLatencyIncrease, @uploadMbps, @uploadLoadedLatency, @uploadLoadedJitter,
       @uploadLoadedPacketLoss, @uploadLatencyIncrease, @unloadedLatency, @error)`;
    this.db.prepare(query).run(result);
  }

  insertProblem(sessionId, note) {
    const recordedAt = new Date().toISOString();
    const statement = this.db.prepare(
      "INSERT INTO problem_markers (session_id, recorded_at, note) VALUES (?, ?, ?)",
    );
    const result = statement.run(sessionId, recordedAt, note || null);
    return {
      id: Number(result.lastInsertRowid),
      sessionId,
      recordedAt,
      note: note || null,
    };
  }

  getSession(id) {
    const query =
      "SELECT id, started_at AS startedAt, ended_at AS endedAt, status FROM sessions WHERE id = ?";
    return this.db.prepare(query).get(id) || null;
  }

  getLatestCheck(sessionId) {
    const query = `SELECT recorded_at AS recordedAt, target, target_type AS targetType,
      packets_sent AS packetsSent, packets_received AS packetsReceived, packet_loss AS packetLoss,
      min_latency AS minLatency, avg_latency AS avgLatency, max_latency AS maxLatency, jitter
      FROM network_samples WHERE check_id = (
        SELECT check_id FROM network_samples WHERE session_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 1
      ) ORDER BY target_type DESC, target`;
    return this.db.prepare(query).all(sessionId);
  }

  getSessionSummary(sessionId) {
    const query = `SELECT SUM(samples) AS sampleCount, MIN(minimum) AS minimumLatency,
      SUM(CASE WHEN target_type='router' THEN latency_sum END) / NULLIF(SUM(CASE WHEN target_type='router' THEN latency_weight END),0) AS averageRouterLatency,
      SUM(CASE WHEN target_type='external' THEN latency_sum END) / NULLIF(SUM(CASE WHEN target_type='external' THEN latency_weight END),0) AS averageInternetLatency,
      MAX(maximum) AS maximumLatency, SUM(jitter_sum)/NULLIF(SUM(samples),0) AS averageJitter,
      SUM(loss_events) AS packetLossEvents,
      MAX(worst_loss) AS worstPacketLoss,
      100.0*SUM(sent-received)/NULLIF(SUM(sent),0) AS packetLossPercent,
      SUM(spikes) AS significantSpikeCount FROM measurement_history WHERE session_id=?`;
    return this.db.prepare(query).get(sessionId);
  }

  getChartData(sessionId, limit) {
    const query = `SELECT recorded_at AS recordedAt, target_type AS targetType, target,
      avg_latency AS avgLatency, packet_loss AS packetLoss
      FROM network_samples WHERE session_id = ?
      ORDER BY recorded_at DESC, id DESC LIMIT ?`;
    return this.db.prepare(query).all(sessionId, limit).reverse();
  }

  getAllChartData(sessionId) {
    const query = `SELECT first_at AS recordedAt,target_type AS targetType,target,
      latency_sum/NULLIF(latency_weight,0) AS avgLatency,100.0*(sent-received)/NULLIF(sent,0) AS packetLoss,
      jitter_sum/samples AS jitter,minimum AS minLatency,maximum AS maxLatency,tier AS resolutionMs,
      max_gap_ms AS maxGapMs FROM measurement_history WHERE session_id=? ORDER BY bucket DESC LIMIT 5000`;
    return this.db.prepare(query).all(sessionId).reverse();
  }

  getLatestSpeedTest(sessionId) {
    const query = `SELECT recorded_at AS recordedAt, trigger_type AS triggerType, target, status,
      unloaded_latency AS unloadedLatency, unloaded_min_latency AS unloadedMinLatency,
      unloaded_max_latency AS unloadedMaxLatency, unloaded_jitter AS unloadedJitter,
      unloaded_packet_loss AS unloadedPacketLoss, download_mbps AS downloadMbps,
      download_loaded_latency AS downloadLoadedLatency, download_latency_increase AS downloadLatencyIncrease,
      upload_mbps AS uploadMbps, upload_loaded_latency AS uploadLoadedLatency,
      upload_latency_increase AS uploadLatencyIncrease, CASE WHEN error IS NOT NULL THEN 'Connection test could not complete; check connectivity.' END AS error FROM speed_tests
      WHERE session_id = ? ORDER BY recorded_at DESC LIMIT 1`;
    return this.db.prepare(query).get(sessionId) || null;
  }

  getProblems(sessionId) {
    const query = `SELECT id, recorded_at AS recordedAt, note FROM problem_markers
      WHERE session_id = ? ORDER BY recorded_at DESC LIMIT 500`;
    return this.db.prepare(query).all(sessionId);
  }

  getRecentSessions(limit = 10) {
    const query = `SELECT s.id, s.started_at AS startedAt, s.ended_at AS endedAt,
      s.status, COALESCE(SUM(n.samples),0) AS sampleCount
      FROM sessions s LEFT JOIN measurement_history n ON n.session_id = s.id
      GROUP BY s.id ORDER BY s.id DESC LIMIT ?`;
    return this.db.prepare(query).all(limit);
  }

  close() {
    this.db.close();
  }
}

module.exports = PingTrailDatabase;
