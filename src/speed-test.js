'use strict';

const { performance } = require('node:perf_hooks');
const network = require('./network');

function summarizeLatency(measurements) {
  const times = measurements.flatMap((measurement) => measurement.times || []);
  const packetsSent = measurements.reduce((sum, item) => sum + item.packetsSent, 0);
  const packetsReceived = times.length;
  return {
    packetsSent,
    packetsReceived,
    packetLoss: packetsSent ? ((packetsSent - packetsReceived) / packetsSent) * 100 : null,
    minLatency: times.length ? Math.min(...times) : null,
    avgLatency: times.length ? times.reduce((sum, value) => sum + value, 0) / times.length : null,
    maxLatency: times.length ? Math.max(...times) : null,
    jitter: network.calculateJitter(times),
    times
  };
}

function latencyIncrease(loaded, baseline) {
  return loaded == null || baseline == null ? null : loaded - baseline;
}

async function transfer(url, options, fetchImpl) {
  const started = performance.now();
  const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Connection-test server returned HTTP ${response.status}`);
  await response.arrayBuffer();
  return (performance.now() - started) / 1_000;
}

async function measureLatency(target, count, pingOptions, pingImpl) {
  return pingImpl(target, { count, ...pingOptions });
}

async function runLoadedPhase({ direction, target, bytes, minimumDurationMs, fetchImpl, pingImpl, pingOptions }) {
  let loading = true;
  const measurements = [];
  let transferred = 0;
  let transferSeconds = 0;

  const latencyTask = (async () => {
    while (loading || measurements.length === 0) {
      measurements.push(await measureLatency(target, 1, pingOptions, pingImpl));
    }
  })();

  let transferError = null;
  try {
    const phaseStarted = performance.now();
    do {
      const isDownload = direction === 'download';
      const seconds = await transfer(
        isDownload ? `https://speed.cloudflare.com/__down?bytes=${bytes}` : 'https://speed.cloudflare.com/__up',
        isDownload ? {} : {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: Buffer.alloc(bytes)
        },
        fetchImpl
      );
      transferred += bytes;
      transferSeconds += seconds;
    } while (performance.now() - phaseStarted < minimumDurationMs);
  } catch (error) {
    transferError = error;
  } finally {
    loading = false;
    await latencyTask;
  }

  const latency = summarizeLatency(measurements);
  return {
    mbps: transferError || !transferSeconds ? null : (transferred * 8) / transferSeconds / 1_000_000,
    latency,
    error: transferError?.message || null
  };
}

async function runConnectionTest(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const pingImpl = options.pingImpl || network.pingTarget;
  const target = options.target || '1.1.1.1';
  const pingOptions = { timeoutMs: options.pingTimeoutMs || 2_000 };
  const onPhase = options.onPhase || (() => {});

  onPhase('baseline');
  const baseline = await measureLatency(target, options.baselinePingCount || 8, pingOptions, pingImpl);

  onPhase('download');
  const download = await runLoadedPhase({
    direction: 'download', target, bytes: options.downloadBytes || 25_000_000,
    minimumDurationMs: options.minimumLoadDurationMs || 8_000, fetchImpl, pingImpl, pingOptions
  });

  onPhase('upload');
  const upload = await runLoadedPhase({
    direction: 'upload', target, bytes: options.uploadBytes || 10_000_000,
    minimumDurationMs: options.minimumLoadDurationMs || 8_000, fetchImpl, pingImpl, pingOptions
  });

  const errors = [download.error && `Download: ${download.error}`, upload.error && `Upload: ${upload.error}`].filter(Boolean);
  return {
    target,
    unloadedLatency: baseline.avgLatency,
    unloadedMinLatency: baseline.minLatency,
    unloadedMaxLatency: baseline.maxLatency,
    unloadedJitter: baseline.jitter,
    unloadedPacketLoss: baseline.packetLoss,
    downloadMbps: download.mbps,
    downloadLoadedLatency: download.latency.avgLatency,
    downloadLoadedJitter: download.latency.jitter,
    downloadLoadedPacketLoss: download.latency.packetLoss,
    downloadLatencyIncrease: latencyIncrease(download.latency.avgLatency, baseline.avgLatency),
    uploadMbps: upload.mbps,
    uploadLoadedLatency: upload.latency.avgLatency,
    uploadLoadedJitter: upload.latency.jitter,
    uploadLoadedPacketLoss: upload.latency.packetLoss,
    uploadLatencyIncrease: latencyIncrease(upload.latency.avgLatency, baseline.avgLatency),
    status: errors.length ? 'partial' : 'complete',
    error: errors.join('; ') || null
  };
}

module.exports = { latencyIncrease, runConnectionTest, runLoadedPhase, summarizeLatency, transfer };