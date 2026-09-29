'use strict';

const QUALITY_THRESHOLDS = Object.freeze({
  minimumSamples: 10,
  minimumDurationSeconds: 30,
  latencyMs: [50, 100, 150, 250],
  jitterMs: [10, 20, 30, 60],
  packetLossPercent: [0, 1, 2.5, 10],
  spikePercent: [0, 2, 10, 25]
});

const LABELS = ['Excellent', 'Good', 'Concerning', 'Poor', 'Severe'];
const GRADES = ['A', 'B', 'C', 'D', 'F'];

function level(value, thresholds, zeroIsExcellent = false) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const numeric = Number(value);
  if (zeroIsExcellent && numeric === 0) return 0;
  if (numeric < thresholds[0]) return 0;
  if (numeric <= thresholds[1]) return 1;
  if (numeric <= thresholds[2]) return 2;
  if (numeric <= thresholds[3]) return 3;
  return 4;
}

function gradeSession({ summary = {}, startedAt, endedAt, now = Date.now() }) {
  const durationSeconds = Math.max(0, (new Date(endedAt || now) - new Date(startedAt)) / 1000);
  const sampleCount = Number(summary.sampleCount) || 0;
  if (sampleCount < QUALITY_THRESHOLDS.minimumSamples || durationSeconds < QUALITY_THRESHOLDS.minimumDurationSeconds) {
    return {
      grade: null,
      sufficientData: false,
      explanation: `Not enough data to grade (requires ${QUALITY_THRESHOLDS.minimumSamples} samples and ${QUALITY_THRESHOLDS.minimumDurationSeconds} seconds).`,
      breakdown: null
    };
  }

  const spikePercent = sampleCount ? (Number(summary.significantSpikeCount) || 0) / sampleCount * 100 : 0;
  const dimensions = {
    latency: level(summary.averageInternetLatency ?? summary.averageRouterLatency, QUALITY_THRESHOLDS.latencyMs),
    jitter: level(summary.averageJitter, QUALITY_THRESHOLDS.jitterMs),
    packetLoss: level(summary.packetLossPercent, QUALITY_THRESHOLDS.packetLossPercent, true),
    stability: level(spikePercent, QUALITY_THRESHOLDS.spikePercent, true)
  };
  const available = Object.values(dimensions).filter((value) => value != null);
  if (!available.length) {
    return { grade: null, sufficientData: false, explanation: 'Not enough successful measurements to grade.', breakdown: null };
  }
  // The weakest measured dimension determines the grade so a good average cannot conceal loss or spikes.
  const worst = Math.max(...available);
  const explanation = worst === 0 ? 'Consistently responsive with no measured stability concerns.'
    : worst === 1 ? 'Generally stable, with only minor variation during the session.'
      : worst === 2 ? 'Usable overall, but one or more stability indicators need attention.'
        : worst === 3 ? 'Poor stability was measured; review loss, jitter, and latency spikes.'
          : 'Severe instability was measured during this session.';
  return {
    grade: GRADES[worst],
    sufficientData: true,
    explanation,
    breakdown: Object.fromEntries(Object.entries(dimensions).map(([key, value]) => [key, value == null ? 'Unavailable' : LABELS[value]])),
    spikePercent
  };
}

module.exports = { QUALITY_THRESHOLDS, gradeSession };
