'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

class PingTrailDatabase {
  constructor(filename) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
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
  }

  recoverInterruptedSessions() {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE sessions SET status = 'interrupted', ended_at = ? WHERE status = 'active'").run(now);
  }

  createSession() {
    const startedAt = new Date().toISOString();
    const result = this.db.prepare("INSERT INTO sessions (started_at, status) VALUES (?, 'active')").run(startedAt);
    return { id: Number(result.lastInsertRowid), startedAt, endedAt: null, status: 'active' };
  }

  stopSession(id, status = 'stopped') {
    const endedAt = new Date().toISOString();
    const statement = this.db.prepare("UPDATE sessions SET ended_at = ?, status = ? WHERE id = ? AND status = 'active'");
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
      (session_id, recorded_at, download_mbps, upload_mbps, latency, error)
      VALUES (@sessionId, @recordedAt, @downloadMbps, @uploadMbps, @latency, @error)`;
    this.db.prepare(query).run(result);
  }

  insertProblem(sessionId, note) {
    const recordedAt = new Date().toISOString();
    const statement = this.db.prepare('INSERT INTO problem_markers (session_id, recorded_at, note) VALUES (?, ?, ?)');
    const result = statement.run(sessionId, recordedAt, note || null);
    return { id: Number(result.lastInsertRowid), sessionId, recordedAt, note: note || null };
  }

  getSession(id) {
    const query = 'SELECT id, started_at AS startedAt, ended_at AS endedAt, status FROM sessions WHERE id = ?';
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
    const query = `SELECT COUNT(*) AS sampleCount,
      AVG(CASE WHEN target_type = 'router' THEN avg_latency END) AS averageRouterLatency,
      AVG(CASE WHEN target_type = 'external' THEN avg_latency END) AS averageInternetLatency,
      MAX(max_latency) AS maximumLatency,
      AVG(jitter) AS averageJitter,
      SUM(CASE WHEN packet_loss > 0 THEN 1 ELSE 0 END) AS packetLossEvents,
      MAX(packet_loss) AS worstPacketLoss
      FROM network_samples WHERE session_id = ?`;
    return this.db.prepare(query).get(sessionId);
  }

  getChartData(sessionId, limit) {
    const query = `SELECT recorded_at AS recordedAt, target_type AS targetType, target,
      avg_latency AS avgLatency, packet_loss AS packetLoss
      FROM network_samples WHERE session_id = ?
      ORDER BY recorded_at DESC, id DESC LIMIT ?`;
    return this.db.prepare(query).all(sessionId, limit).reverse();
  }

  getLatestSpeedTest(sessionId) {
    const query = `SELECT recorded_at AS recordedAt, download_mbps AS downloadMbps,
      upload_mbps AS uploadMbps, latency, error FROM speed_tests
      WHERE session_id = ? ORDER BY recorded_at DESC LIMIT 1`;
    return this.db.prepare(query).get(sessionId) || null;
  }

  getProblems(sessionId) {
    const query = `SELECT id, recorded_at AS recordedAt, note FROM problem_markers
      WHERE session_id = ? ORDER BY recorded_at`;
    return this.db.prepare(query).all(sessionId);
  }

  getRecentSessions(limit = 10) {
    const query = `SELECT s.id, s.started_at AS startedAt, s.ended_at AS endedAt,
      s.status, COUNT(n.id) AS sampleCount
      FROM sessions s LEFT JOIN network_samples n ON n.session_id = s.id
      GROUP BY s.id ORDER BY s.id DESC LIMIT ?`;
    return this.db.prepare(query).all(limit);
  }

  close() {
    this.db.close();
  }
}

module.exports = PingTrailDatabase;
