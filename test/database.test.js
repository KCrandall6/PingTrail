'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const sqliteAvailable = fs.existsSync(path.join(__dirname, '..', 'node_modules', 'better-sqlite3', 'package.json'));

test('persists comprehensive manual connection-test fields', { skip: !sqliteAvailable && 'better-sqlite3 is not installed' }, () => {
  const PingTrailDatabase = require('../src/database');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pingtrail-'));
  const database = new PingTrailDatabase(path.join(directory, 'test.sqlite'));
  const session = database.createSession();
  database.insertSpeedTest({ sessionId: session.id, recordedAt: new Date().toISOString(),
    triggerType: 'manual', target: '1.1.1.1', status: 'complete', unloadedLatency: 20,
    unloadedMinLatency: 18, unloadedMaxLatency: 22, unloadedJitter: 2, unloadedPacketLoss: 0,
    downloadMbps: 195, downloadLoadedLatency: 52, downloadLoadedJitter: 4,
    downloadLoadedPacketLoss: 0, downloadLatencyIncrease: 32, uploadMbps: 145,
    uploadLoadedLatency: 81, uploadLoadedJitter: 5, uploadLoadedPacketLoss: 0,
    uploadLatencyIncrease: 61, error: null });
  const stored = database.getLatestSpeedTest(session.id);
  assert.equal(stored.triggerType, 'manual');
  assert.equal(stored.downloadLatencyIncrease, 32);
  assert.equal(stored.uploadLoadedLatency, 81);
  database.close(); fs.rmSync(directory, { recursive: true, force: true });
});

test('returns every historical sample chronologically with summary stability metrics', { skip: !sqliteAvailable && 'better-sqlite3 is not installed' }, () => {
  const PingTrailDatabase = require('../src/database');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pingtrail-history-'));
  const database = new PingTrailDatabase(path.join(directory, 'test.sqlite'));
  const session = database.createSession();
  const base = { sessionId: session.id, target: '1.1.1.1', targetType: 'external', packetsSent: 5,
    packetsReceived: 5, packetLoss: 0, minLatency: 10, avgLatency: 20, maxLatency: 25, jitter: 2 };
  database.insertSamples([
    { ...base, checkId: 'later', recordedAt: '2026-01-01T00:00:20Z', avgLatency: 220, maxLatency: 250 },
    { ...base, checkId: 'earlier', recordedAt: '2026-01-01T00:00:10Z', packetsReceived: 4, packetLoss: 20 }
  ]);
  assert.deepEqual(database.getAllChartData(session.id).map((row) => row.recordedAt),
    ['2026-01-01T00:00:10Z', '2026-01-01T00:00:20Z']);
  const summary = database.getSessionSummary(session.id);
  assert.equal(summary.significantSpikeCount, 1);
  assert.equal(summary.packetLossPercent, 10);
  assert.equal(summary.minimumLatency, 10);
  database.close(); fs.rmSync(directory, { recursive: true, force: true });
});
