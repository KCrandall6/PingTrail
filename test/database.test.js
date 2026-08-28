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
