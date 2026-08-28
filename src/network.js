'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function calculateJitter(times) {
  if (times.length < 2) return 0;
  const differences = times.slice(1).map((time, index) => Math.abs(time - times[index]));
  return average(differences);
}

function parsePingOutput(output, packetsSent) {
  const times = [];
  const pattern = /time\s*([=<])\s*(\d+(?:[.,]\d+)?)\s*ms/gi;
  for (const match of output.matchAll(pattern)) {
    const value = Number.parseFloat(match[2].replace(',', '.'));
    times.push(match[1] === '<' ? value / 2 : value);
  }

  const packetsReceived = Math.min(times.length, packetsSent);
  return {
    packetsSent,
    packetsReceived,
    packetLoss: ((packetsSent - packetsReceived) / packetsSent) * 100,
    minLatency: times.length ? Math.min(...times) : null,
    avgLatency: average(times),
    maxLatency: times.length ? Math.max(...times) : null,
    jitter: calculateJitter(times),
    times
  };
}

function pingArguments(target, count, timeoutMs, platform = process.platform) {
  if (platform === 'win32') return ['-n', String(count), '-w', String(timeoutMs), target];
  if (platform === 'darwin') return ['-n', '-c', String(count), '-W', String(timeoutMs), target];
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
  return ['-n', '-c', String(count), '-W', String(seconds), target];
}

async function pingTarget(target, options = {}) {
  const count = options.count || 5;
  const timeoutMs = options.timeoutMs || 5_000;
  let output = '';
  try {
    const runner = options.execFile || execFileAsync;
    const result = await runner('ping', pingArguments(target, count, timeoutMs, options.platform), {
      timeout: count * timeoutMs + 2_000,
      windowsHide: true
    });
    output = `${result.stdout || ''}\n${result.stderr || ''}`;
  } catch (error) {
    output = `${error.stdout || ''}\n${error.stderr || ''}`;
  }
  return parsePingOutput(output, count);
}

function parseDefaultGateway(output, platform = process.platform) {
  if (platform === 'win32') {
    const routes = output.split(/\r?\n/).map((line) => line.trim().split(/\s+/));
    const route = routes.find((columns) => columns[0] === '0.0.0.0' && columns[1] === '0.0.0.0');
    return route?.[2] || null;
  }
  if (platform === 'darwin') return output.match(/^\s*gateway:\s*(\S+)/m)?.[1] || null;
  return output.match(/^default\s+via\s+(\S+)/m)?.[1] || null;
}

async function detectDefaultGateway(options = {}) {
  const platform = options.platform || process.platform;
  const command = platform === 'win32' ? 'route' : platform === 'darwin' ? 'route' : 'ip';
  let args;
  if (platform === 'win32') args = ['print', '-4', '0.0.0.0'];
  else if (platform === 'darwin') args = ['-n', 'get', 'default'];
  else args = ['-4', 'route', 'show', 'default'];

  const runner = options.execFile || execFileAsync;
  const result = await runner(command, args, { timeout: 5_000, windowsHide: true });
  const gateway = parseDefaultGateway(result.stdout || '', platform);
  if (!gateway) throw new Error('No IPv4 default gateway was found');
  return gateway;
}

module.exports = {
  calculateJitter,
  detectDefaultGateway,
  parseDefaultGateway,
  parsePingOutput,
  pingArguments,
  pingTarget
};
