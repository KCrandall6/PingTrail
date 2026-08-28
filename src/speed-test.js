'use strict';

const { performance } = require('node:perf_hooks');

async function timedRequest(url, options = {}, fetchImpl = fetch) {
  const started = performance.now();
  const response = await fetchImpl(url, {
    ...options,
    signal: AbortSignal.timeout(120_000)
  });
  if (!response.ok) throw new Error(`Speed-test server returned HTTP ${response.status}`);
  await response.arrayBuffer();
  return (performance.now() - started) / 1_000;
}

async function runSpeedTest(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const downloadBytes = options.downloadBytes || 25_000_000;
  const uploadBytes = options.uploadBytes || 10_000_000;
  const latencyRuns = options.latencyRuns || 5;
  const latencies = [];

  for (let index = 0; index < latencyRuns; index += 1) {
    const seconds = await timedRequest('https://speed.cloudflare.com/__down?bytes=0', {}, fetchImpl);
    latencies.push(seconds * 1_000);
  }

  const downloadUrl = `https://speed.cloudflare.com/__down?bytes=${downloadBytes}`;
  const downloadSeconds = await timedRequest(downloadUrl, {}, fetchImpl);
  const uploadSeconds = await timedRequest('https://speed.cloudflare.com/__up', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.alloc(uploadBytes)
  }, fetchImpl);

  return {
    downloadMbps: (downloadBytes * 8) / downloadSeconds / 1_000_000,
    uploadMbps: (uploadBytes * 8) / uploadSeconds / 1_000_000,
    latency: latencies.reduce((sum, value) => sum + value, 0) / latencies.length
  };
}

module.exports = { runSpeedTest, timedRequest };
