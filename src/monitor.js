'use strict';

const crypto = require('node:crypto');
const logger = require('./logger');
const network = require('./network');
const speedTest = require('./speed-test');

class MonitorService {
  constructor({ database, config, networkService = network, speedTestService = speedTest, log = logger }) {
    this.database = database;
    this.config = config;
    this.network = networkService;
    this.speedTestService = speedTestService;
    this.log = log;
    this.session = null;
    this.monitorTimer = null;
    this.speedTimer = null;
    this.monitorJobRunning = false;
    this.speedTestRunning = false;
    this.connectionTestPhase = null;
    this.gateway = null;
  }

  get active() {
    return Boolean(this.session);
  }

  async start() {
    if (this.active) return { started: false, session: this.session };
    this.session = this.database.createSession();
    this.log.info('Monitoring started', { sessionId: this.session.id });
    this.scheduleMonitor(0);
    this.scheduleSpeedTest(this.config.speedTestIntervalMs);
    return { started: true, session: this.session };
  }

  stop() {
    if (!this.active) return { stopped: false, session: null };
    clearTimeout(this.monitorTimer);
    clearTimeout(this.speedTimer);
    const endedAt = this.database.stopSession(this.session.id);
    const session = { ...this.session, endedAt, status: 'stopped' };
    this.log.info('Monitoring stopped', { sessionId: session.id });
    this.session = null;
    return { stopped: true, session };
  }

  scheduleMonitor(delay) {
    clearTimeout(this.monitorTimer);
    if (!this.active) return;
    this.monitorTimer = setTimeout(async () => {
      await this.runMonitoringJob();
      this.scheduleMonitor(this.config.monitoringIntervalMs);
    }, delay);
    this.monitorTimer.unref?.();
  }

  async runMonitoringJob() {
    if (!this.active || this.monitorJobRunning) return false;
    this.monitorJobRunning = true;
    const sessionId = this.session.id;
    try {
      try {
        this.gateway = await this.network.detectDefaultGateway();
      } catch (error) {
        this.log.warn('Could not detect the default gateway', { message: error.message });
      }

      const targets = [];
      if (this.gateway) targets.push({ target: this.gateway, targetType: 'router' });
      for (const target of this.config.externalTargets) {
        targets.push({ target, targetType: 'external' });
      }

      const recordedAt = new Date().toISOString();
      const checkId = crypto.randomUUID();
      const results = await Promise.all(targets.map(async ({ target, targetType }) => {
        try {
          const measurement = await this.network.pingTarget(target, {
            count: this.config.pingCount,
            timeoutMs: this.config.pingTimeoutMs
          });
          return { sessionId, checkId, recordedAt, target, targetType, ...measurement };
        } catch (error) {
          this.log.warn('Ping measurement failed', { target, message: error.message });
          return {
            sessionId,
            checkId,
            recordedAt,
            target,
            targetType,
            packetsSent: this.config.pingCount,
            packetsReceived: 0,
            packetLoss: 100,
            minLatency: null,
            avgLatency: null,
            maxLatency: null,
            jitter: 0
          };
        }
      }));

      if (results.length && this.session?.id === sessionId) {
        this.database.insertSamples(results);
        this.log.info('Network check stored', { sessionId, samples: results.length });
      }
      return true;
    } catch (error) {
      this.log.error('Monitoring job failed safely', error);
      return false;
    } finally {
      this.monitorJobRunning = false;
    }
  }

  scheduleSpeedTest(delay) {
    clearTimeout(this.speedTimer);
    if (!this.active) return;
    this.speedTimer = setTimeout(async () => {
      await this.runConnectionTest('automatic');
      this.scheduleSpeedTest(this.config.speedTestIntervalMs);
    }, delay);
    this.speedTimer.unref?.();
  }

  async runConnectionTest(triggerType = 'manual') {
    if (!this.active || this.speedTestRunning) return false;
    this.speedTestRunning = true;
    const sessionId = this.session.id;
    const recordedAt = new Date().toISOString();
    try {
      const runner = this.speedTestService.runConnectionTest || this.speedTestService.runSpeedTest;
      const result = await runner({
        downloadBytes: this.config.speedTestDownloadBytes,
        uploadBytes: this.config.speedTestUploadBytes,
        minimumLoadDurationMs: this.config.connectionTestMinimumLoadMs,
        baselinePingCount: this.config.connectionTestBaselinePings,
        pingTimeoutMs: this.config.pingTimeoutMs,
        target: this.config.externalTargets[0],
        onPhase: (phase) => { this.connectionTestPhase = phase; }
      });
      if (this.session?.id === sessionId) {
        this.database.insertSpeedTest({ sessionId, recordedAt, triggerType, ...result });
        this.log.info('Connection test stored', { sessionId, triggerType });
      }
      return true;
    } catch (error) {
      this.log.warn('Connection test failed safely', { message: error.message });
      if (this.session?.id === sessionId) {
        this.database.insertSpeedTest({
          sessionId, recordedAt, triggerType, target: this.config.externalTargets[0], status: 'failed',
          unloadedLatency: null, unloadedMinLatency: null, unloadedMaxLatency: null,
          unloadedJitter: null, unloadedPacketLoss: null, downloadMbps: null,
          downloadLoadedLatency: null, downloadLoadedJitter: null, downloadLoadedPacketLoss: null,
          downloadLatencyIncrease: null, uploadMbps: null, uploadLoadedLatency: null,
          uploadLoadedJitter: null, uploadLoadedPacketLoss: null, uploadLatencyIncrease: null,
          error: error.message.slice(0, 500)
        });
      }
      return false;
    } finally {
      this.speedTestRunning = false;
      this.connectionTestPhase = null;
    }
  }

  runSpeedTestJob() {
    return this.runConnectionTest('automatic');
  }

  getState() {
    const state = {
      active: this.active,
      gateway: this.gateway,
      jobRunning: this.monitorJobRunning,
      speedTestRunning: this.speedTestRunning,
      connectionTestPhase: this.connectionTestPhase,
      session: null
    };
    if (!this.session) return state;
    state.session = this.database.getSession(this.session.id);
    state.latestCheck = this.database.getLatestCheck(this.session.id);
    state.summary = this.database.getSessionSummary(this.session.id);
    state.chart = this.database.getChartData(this.session.id, this.config.chartPointLimit);
    state.latestSpeedTest = this.database.getLatestSpeedTest(this.session.id);
    state.problems = this.database.getProblems(this.session.id);
    return state;
  }

  shutdown() {
    if (this.active) this.stop();
  }
}

module.exports = MonitorService;
