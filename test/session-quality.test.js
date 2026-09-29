'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { QUALITY_THRESHOLDS, gradeSession } = require('../src/session-quality');

function quality(overrides = {}) {
  return gradeSession({
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:05:00.000Z',
    summary: { sampleCount: 100, averageInternetLatency: 30, averageJitter: 4,
      packetLossPercent: 0, significantSpikeCount: 0, ...overrides }
  });
}

test('centralizes the documented quality and sufficiency thresholds', () => {
  assert.deepEqual(QUALITY_THRESHOLDS.latencyMs, [50, 100, 150, 250]);
  assert.deepEqual(QUALITY_THRESHOLDS.jitterMs, [10, 20, 30, 60]);
  assert.deepEqual(QUALITY_THRESHOLDS.packetLossPercent, [0, 1, 2.5, 10]);
  assert.equal(QUALITY_THRESHOLDS.minimumSamples, 10);
});

test('grades stable, moderate, unstable, and poor sessions transparently', () => {
  assert.equal(quality().grade, 'A');
  assert.equal(quality({ averageInternetLatency: 85, averageJitter: 14 }).grade, 'B');
  assert.equal(quality({ averageJitter: 25 }).grade, 'C');
  assert.equal(quality({ averageInternetLatency: 180 }).grade, 'D');
});

test('packet loss and repeated major spikes cap an otherwise low-latency grade', () => {
  assert.equal(quality({ packetLossPercent: 4 }).grade, 'D');
  const spikes = quality({ significantSpikeCount: 30 });
  assert.equal(spikes.grade, 'F');
  assert.equal(spikes.breakdown.latency, 'Excellent');
  assert.equal(spikes.breakdown.stability, 'Severe');
});

test('does not grade sessions with too few samples or too little duration', () => {
  assert.equal(quality({ sampleCount: 9 }).grade, null);
  const short = gradeSession({ startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:00:10Z',
    summary: { sampleCount: 100, averageInternetLatency: 20 } });
  assert.equal(short.sufficientData, false);
  assert.match(short.explanation, /Not enough data/);
});
