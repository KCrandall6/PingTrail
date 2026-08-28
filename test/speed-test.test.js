'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { latencyIncrease, runConnectionTest, summarizeLatency } = require('../src/speed-test');

test('summarizes loaded latency, loss, and jitter from concurrent samples', () => {
  const result = summarizeLatency([
    { packetsSent: 1, times: [10] }, { packetsSent: 1, times: [14] }, { packetsSent: 1, times: [] }
  ]);
  assert.equal(result.avgLatency, 12);
  assert.equal(result.jitter, 4);
  assert.ok(Math.abs(result.packetLoss - (100 / 3)) < 1e-10);
});

test('latency increase requires both defensible measurements', () => {
  assert.equal(latencyIncrease(52, 20), 32);
  assert.equal(latencyIncrease(null, 20), null);
});

test('connection test pings while each transfer phase is active', async () => {
  const phases = [];
  let pingValue = 10;
  const pingImpl = async (target, { count }) => ({
    packetsSent: count, packetsReceived: count, packetLoss: 0, minLatency: pingValue,
    avgLatency: pingValue, maxLatency: pingValue, jitter: 0, times: Array(count).fill(pingValue++)
  });
  const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) });
  const result = await runConnectionTest({ pingImpl, fetchImpl, baselinePingCount: 3,
    minimumLoadDurationMs: -1, downloadBytes: 100, uploadBytes: 100,
    onPhase: (phase) => phases.push(phase) });
  assert.deepEqual(phases, ['baseline', 'download', 'upload']);
  assert.equal(result.status, 'complete');
  assert.ok(result.downloadLoadedLatency > result.unloadedLatency);
  assert.ok(result.uploadLatencyIncrease > result.downloadLatencyIncrease);
});
