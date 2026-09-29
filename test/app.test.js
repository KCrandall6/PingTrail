'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createApp = require('../src/app');

function fixture() {
  const session = { id: 7, startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:05:00Z', status: 'stopped' };
  const chart = [
    { recordedAt: '2026-01-01T00:00:10Z', avgLatency: 20, targetType: 'external' },
    { recordedAt: '2026-01-01T00:00:20Z', avgLatency: 25, targetType: 'external' }
  ];
  const summary = { sampleCount: 20, averageInternetLatency: 22.5, averageJitter: 2,
    packetLossPercent: 0, significantSpikeCount: 0 };
  const database = {
    getSession: (id) => id === 7 ? session : null,
    getSessionSummary: () => summary,
    getLatestCheck: () => [chart[1]],
    getAllChartData: () => chart,
    getLatestSpeedTest: () => null,
    getProblems: () => [{ id: 1, recordedAt: chart[0].recordedAt, note: 'lag' }],
    getRecentSessions: () => [{ ...session, sampleCount: 20 }]
  };
  const monitor = { active: false, getState: () => ({ active: false }), setMonitoringInterval() {}, start() {}, stop() {} };
  return { app: createApp({ monitor, database }), chart };
}

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try { await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('retrieves a complete historical session with chronological samples and markers', async () => {
  const { app, chart } = fixture();
  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/sessions/7`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.session.id, 7);
    assert.deepEqual(body.chart, chart);
    assert.equal(body.summary.averageInternetLatency, 22.5);
    assert.equal(body.quality.grade, 'A');
    assert.equal(body.problems[0].note, 'lag');
  });
});

test('rejects malformed IDs and returns 404 for missing sessions', async () => {
  const { app } = fixture();
  await withServer(app, async (origin) => {
    assert.equal((await fetch(`${origin}/api/sessions/not-a-number`)).status, 400);
    assert.equal((await fetch(`${origin}/api/sessions/999`)).status, 404);
  });
});
