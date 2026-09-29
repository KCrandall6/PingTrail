'use strict';

const crypto = require('node:crypto');
const logger = require('./logger');
const network = require('./network');
const speedTest = require('./speed-test');

const ALLOWED_MONITORING_INTERVALS = Object.freeze([2_000, 10_000, 30_000, 60_000]);

class MonitorService {
  constructor({ database, config, networkService = network, speedTestService = speedTest, log = logger }) {
    this.database = database;
    this.config = config;
    this.network = networkService;
    this.speedTestService = speedTestService;
    this.log = log;
    this.session = null;
    this.monitorTimer = null;
    this.monitorScheduleGeneration = 0;
    this.speedTimer = null;
    this.monitorJobRunning = false;
    this.speedTestRunning = false;
    this.connectionTestPhase = null;
    this.gateway = null;
    this.selectedMonitoringIntervalMs = ALLOWED_MONITORING_INTERVALS.includes(config.monitoringIntervalMs)
      ? config.monitoringIntervalMs
      : 10_000;
    this.diagnosticUntil = null;
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
    this.monitorTimer = null;
    this.monitorScheduleGeneration += 1;
    clearTimeout(this.speedTimer);
    this.speedTimer = null;
    this.diagnosticUntil = null;
    const endedAt = this.database.stopSession(this.session.id);
    const session = { ...this.session, endedAt, status: 'stopped' };
    this.log.info('Monitoring stopped', { sessionId: session.id });
    this.session = null;
    return { stopped: true, session };
  }

  scheduleMonitor(delay) {
    clearTimeout(this.monitorTimer);
    if (!this.active) return;
    const generation = ++this.monitorScheduleGeneration;
    this.monitorTimer = setTimeout(async () => {
      await this.runMonitoringJob();
      if (generation === this.monitorScheduleGeneration) {
        this.scheduleMonitor(this.getEffectiveMonitoringIntervalMs());
      }
    }, delay);
    this.monitorTimer.unref?.();
  }

  get diagnosticSamplingActive() {
    return this.selectedMonitoringIntervalMs !== this.config.diagnosticIntervalMs
      && this.diagnosticUntil != null
      && this.diagnosticUntil > Date.now();
  }

  getEffectiveMonitoringIntervalMs() {
    return this.diagnosticSamplingActive
      ? this.config.diagnosticIntervalMs
      : this.selectedMonitoringIntervalMs;
  }

  setMonitoringInterval(intervalMs) {
    const parsed = Number(intervalMs);
    if (!ALLOWED_MONITORING_INTERVALS.includes(parsed)) {
      throw new RangeError('Monitoring interval must be 2, 10, 30, or 60 seconds.');
    }
    this.selectedMonitoringIntervalMs = parsed;
    this.diagnosticUntil = null;
    if (this.active) this.scheduleMonitor(parsed);
    return this.getMonitoringSettings();
  }

  getMonitoringSettings() {
    return {
      selectedIntervalMs: this.selectedMonitoringIntervalMs,
      effectiveIntervalMs: this.getEffectiveMonitoringIntervalMs(),
      diagnosticSamplingActive: this.diagnosticSamplingActive,
      diagnosticUntil: this.diagnosticSamplingActive ? new Date(this.diagnosticUntil).toISOString() : null,
      allowedIntervalsMs: ALLOWED_MONITORING_INTERVALS
    };
  }

  shouldUseDiagnosticSampling(results) {
    return results.some((sample) => sample.packetLoss > 0
      || sample.avgLatency >= this.config.diagnosticLatencyThresholdMs
      || sample.jitter >= this.config.diagnosticJitterThresholdMs);
  }

  activateDiagnosticSampling(results) {
    if (this.selectedMonitoringIntervalMs === this.config.diagnosticIntervalMs) return;
    if (this.shouldUseDiagnosticSampling(results)) {
      this.diagnosticUntil = Date.now() + this.config.diagnosticDurationMs;
    }
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
        this.activateDiagnosticSampling(results);
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
      monitoring: this.getMonitoringSettings(),
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
