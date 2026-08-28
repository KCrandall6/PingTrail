'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateJitter,
  parseDefaultGateway,
  parsePingOutput,
  pingArguments
} = require('../src/network');

test('parses Windows ping replies and calculates packet loss and jitter', () => {
  const output = `
Reply from 192.168.1.1: bytes=32 time<1ms TTL=64
Reply from 192.168.1.1: bytes=32 time=2ms TTL=64
Request timed out.
Reply from 192.168.1.1: bytes=32 time=5ms TTL=64
`;
  const result = parsePingOutput(output, 5);
  assert.equal(result.packetsReceived, 3);
  assert.equal(result.packetLoss, 40);
  assert.equal(result.minLatency, 0.5);
  assert.equal(result.maxLatency, 5);
  assert.equal(result.avgLatency, 2.5);
  assert.equal(result.jitter, 2.25);
});

test('represents an unreachable target without throwing', () => {
  assert.deepEqual(parsePingOutput('Request timed out.', 5), {
    packetsSent: 5,
    packetsReceived: 0,
    packetLoss: 100,
    minLatency: null,
    avgLatency: null,
    maxLatency: null,
    jitter: 0,
    times: []
  });
});

test('jitter is mean absolute difference between consecutive successful RTTs', () => {
  assert.equal(calculateJitter([10, 14, 11, 17]), 13 / 3);
  assert.equal(calculateJitter([10]), 0);
});

test('parses default gateways on Windows, Linux, and macOS', () => {
  const windows = '0.0.0.0  0.0.0.0  192.168.0.1  192.168.0.50  25';
  const linux = 'default via 10.0.2.2 dev eth0';
  const mac = '   gateway: 192.168.1.1';
  assert.equal(parseDefaultGateway(windows, 'win32'), '192.168.0.1');
  assert.equal(parseDefaultGateway(linux, 'linux'), '10.0.2.2');
  assert.equal(parseDefaultGateway(mac, 'darwin'), '192.168.1.1');
});

test('uses native Windows ping flags', () => {
  assert.deepEqual(pingArguments('1.1.1.1', 5, 5000, 'win32'), ['-n', '5', '-w', '5000', '1.1.1.1']);
});
