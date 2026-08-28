'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MonitorService = require('../src/monitor');

function fixture() {
  const stored = { samples: [], speeds: [], sessions: [] };
  const database = {
    createSession() { const session = { id: stored.sessions.length + 1, startedAt: new Date().toISOString(), status: 'active' }; stored.sessions.push(session); return session; },
    stopSession() { return new Date().toISOString(); },
    insertSamples(rows) { stored.samples.push(...rows); },
    insertSpeedTest(row) { stored.speeds.push(row); },
    getSession(id) { return stored.sessions.find((session) => session.id === id); },
    getLatestCheck() { return stored.samples; },
    getSessionSummary() { return { sampleCount: stored.samples.length }; },
    getChartData() { return stored.samples; },
    getLatestSpeedTest() { return stored.speeds.at(-1) || null; },
    getProblems() { return []; }
  };
  const successful = { packetsSent: 5, packetsReceived: 5, packetLoss: 0, minLatency: 1, avgLatency: 2, maxLatency: 3, jitter: 1 };
  const networkService = {
    detectDefaultGateway: async () => '192.168.1.1',
    pingTarget: async (target) => target === '8.8.8.8' ? { ...successful, packetsReceived: 0, packetLoss: 100, avgLatency: null } : successful
  };
  const config = { monitoringIntervalMs: 30_000, pingCount: 5, pingTimeoutMs: 5000, externalTargets: ['1.1.1.1', '8.8.8.8'], speedTestIntervalMs: 3_600_000, speedTestDownloadBytes: 1, speedTestUploadBytes: 1, chartPointLimit: 500 };
  const quietLog = { info() {}, warn() {}, error() {} };
  return { monitor: new MonitorService({ database, config, networkService, speedTestService: { runSpeedTest: async () => ({ downloadMbps: 100, uploadMbps: 20, latency: 10 }) }, log: quietLog }), stored };
}

test('creates a session and stores router and external measurements', async () => {
  const { monitor, stored } = fixture();
  const first = await monitor.start();
  clearTimeout(monitor.monitorTimer);
  clearTimeout(monitor.speedTimer);
  assert.equal(first.started, true);
  const duplicate = await monitor.start();
  assert.equal(duplicate.started, false);
  await monitor.runMonitoringJob();
  assert.equal(stored.samples.length, 3);
  const targetTypes = stored.samples.map((row) => row.targetType);
  assert.deepEqual(targetTypes, ['router', 'external', 'external']);
  assert.equal(stored.samples.find((row) => row.target === '8.8.8.8').packetLoss, 100);
  assert.equal(monitor.stop().stopped, true);
  assert.equal(monitor.active, false);
});

test('prevents overlapping monitoring and speed-test jobs', async () => {
  const { monitor, stored } = fixture();
  await monitor.start();
  clearTimeout(monitor.monitorTimer);
  clearTimeout(monitor.speedTimer);
  monitor.monitorJobRunning = true;
  assert.equal(await monitor.runMonitoringJob(), false);
  monitor.monitorJobRunning = false;
  monitor.speedTestRunning = true;
  assert.equal(await monitor.runSpeedTestJob(), false);
  monitor.speedTestRunning = false;
  assert.equal(await monitor.runSpeedTestJob(), true);
  assert.equal(stored.speeds.length, 1);
  monitor.stop();
});

test('stores speed-test failures instead of throwing', async () => {
  const { monitor, stored } = fixture();
  monitor.speedTestService.runSpeedTest = async () => { throw new Error('offline'); };
  await monitor.start();
  clearTimeout(monitor.monitorTimer); clearTimeout(monitor.speedTimer);
  assert.equal(await monitor.runSpeedTestJob(), false);
  assert.equal(stored.speeds[0].error, 'offline');
  monitor.stop();
});
