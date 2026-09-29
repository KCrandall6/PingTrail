'use strict';

const elements = Object.fromEntries([...document.querySelectorAll('[id]')].map((element) => [element.id, element]));
let state = { active: false };
let historicalState = null;
let selectedSessionId = null;
let sessionRequest = 0;
let durationTimer;
const intervalStorageKey = 'pingtrail.monitoringIntervalMs';

function number(value, unit = ' ms', digits = 1) {
  return value == null ? '—' : `${Number(value).toFixed(digits)}${unit}`;
}

function increase(value) {
  return value == null ? '—' : `${value >= 0 ? '+' : ''}${Number(value).toFixed(1)} ms`;
}

function average(values) {
  const present = values.filter((value) => value != null);
  return present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null;
}

function formatDuration(startedAt, endedAt) {
  const seconds = Math.max(0, Math.floor((new Date(endedAt || Date.now()) - new Date(startedAt)) / 1000));
  return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60].map((part) => String(part).padStart(2, '0')).join(':');
}

function formatTime(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
}

async function api(path, options) {
  const response = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Request failed');
  return body;
}

function toast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  setTimeout(() => elements.toast.classList.remove('show'), 2600);
}

function drawChart(samples = [], problems = []) {
  const canvas = elements.latencyChart;
  const context = canvas.getContext('2d');
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  context.scale(ratio, ratio);
  context.clearRect(0, 0, width, height);

  const groups = new Map();
  samples.forEach((sample) => {
    const point = groups.get(sample.recordedAt) || { time: sample.recordedAt, router: [], external: [] };
    if (sample.avgLatency != null) point[sample.targetType].push(sample.avgLatency);
    groups.set(sample.recordedAt, point);
  });
  const points = [...groups.values()].map((point) => ({
    ...point,
    router: average(point.router),
    external: average(point.external)
  }));
  elements.chartEmpty.hidden = points.length > 0;
  if (!points.length) return;

  const padding = { top: 15, right: 12, bottom: 28, left: 42 };
  const values = points.flatMap((point) => [point.router, point.external]).filter((value) => value != null);
  const maximum = Math.max(10, ...values) * 1.15;
  const x = (index) => padding.left + (index / Math.max(1, points.length - 1)) * (width - padding.left - padding.right);
  const y = (value) => height - padding.bottom - (value / maximum) * (height - padding.top - padding.bottom);

  context.font = '11px system-ui';
  context.fillStyle = '#83909d';
  context.strokeStyle = '#e5ebef';
  context.lineWidth = 1;
  for (let index = 0; index <= 4; index += 1) {
    const value = maximum * index / 4;
    const lineY = y(value);
    context.beginPath(); context.moveTo(padding.left, lineY); context.lineTo(width - padding.right, lineY); context.stroke();
    context.fillText(`${Math.round(value)} ms`, 2, lineY + 4);
  }

  if (points.length > 1) {
    const firstTime = new Date(points[0].time).getTime();
    const lastTime = new Date(points.at(-1).time).getTime();
    problems.forEach((problem) => {
      const position = (new Date(problem.recordedAt).getTime() - firstTime) / Math.max(1, lastTime - firstTime);
      if (position >= 0 && position <= 1) {
        const markerX = padding.left + position * (width - padding.left - padding.right);
        context.save();
        context.setLineDash([4, 4]);
        context.strokeStyle = '#d93445';
        context.beginPath();
        context.moveTo(markerX, padding.top);
        context.lineTo(markerX, height - padding.bottom);
        context.stroke();
        context.restore();
      }
    });
  }

  function line(key, color) {
    context.strokeStyle = color;
    context.lineWidth = 2.5;
    context.lineJoin = 'round';
    context.beginPath();
    let drawing = false;
    points.forEach((point, index) => {
      if (point[key] == null) { drawing = false; return; }
      if (!drawing) context.moveTo(x(index), y(point[key])); else context.lineTo(x(index), y(point[key]));
      drawing = true;
    });
    context.stroke();
  }
  line('router', '#ff6814');
  line('external', '#2986cc');
  context.fillStyle = '#83909d';
  const timeOptions = { hour: '2-digit', minute: '2-digit' };
  const startLabel = new Date(points[0].time).toLocaleTimeString([], timeOptions);
  const endLabel = new Date(points.at(-1).time).toLocaleTimeString([], timeOptions);
  context.fillText(startLabel, padding.left, height - 7);
  context.fillText(endLabel, width - padding.right - context.measureText(endLabel).width, height - 7);
}

function render(nextState, liveState = nextState) {
  const historical = nextState !== liveState;
  const active = liveState.active;
  elements.statusDot.classList.toggle('active', active);
  elements.statusText.textContent = active ? 'Monitoring active' : 'Monitoring is off';
  elements.heroTitle.textContent = active ? 'Watching your connection.' : 'Ready when you are.';
  elements.heroCopy.textContent = active
    ? `Session #${liveState.session.id} • Gateway ${liveState.gateway || 'being detected'}`
    : 'Start a session to leave a trail of router and internet health measurements.';
  elements.monitorButton.textContent = active ? 'Stop monitoring' : 'Start monitoring';
  elements.problemButton.disabled = !active;
  elements.connectionTestButton.disabled = !active || liveState.speedTestRunning;
  elements.connectionTestButton.textContent = liveState.speedTestRunning ? 'Connection Test Running…' : 'Run Connection Test';
  if (liveState.monitoring) {
    elements.monitoringInterval.value = String(liveState.monitoring.selectedIntervalMs);
    elements.diagnosticStatus.hidden = !liveState.monitoring.diagnosticSamplingActive;
  }

  const checks = nextState.latestCheck || [];
  const router = checks.find((sample) => sample.targetType === 'router');
  const external = checks.filter((sample) => sample.targetType === 'external');
  elements.routerLatency.textContent = number(router?.avgLatency);
  elements.routerTarget.textContent = router?.target || 'Default gateway';
  elements.internetLatency.textContent = number(average(external.map((sample) => sample.avgLatency)));
  elements.packetLoss.textContent = number(checks.length ? Math.max(...checks.map((sample) => sample.packetLoss)) : null, '%');
  elements.jitter.textContent = number(average(checks.map((sample) => sample.jitter)));
  elements.lastUpdated.textContent = checks[0] ? `Measured ${formatTime(checks[0].recordedAt)}` : 'Waiting for a measurement';

  const summary = nextState.summary || {};
  elements.avgRouter.textContent = number(summary.averageRouterLatency);
  elements.avgInternet.textContent = number(summary.averageInternetLatency);
  elements.minLatency.textContent = number(summary.minimumLatency);
  elements.maxLatency.textContent = number(summary.maximumLatency);
  elements.avgJitter.textContent = number(summary.averageJitter);
  elements.overallLoss.textContent = number(summary.packetLossPercent, '%');
  elements.spikeCount.textContent = summary.significantSpikeCount || 0;
  elements.lossEvents.textContent = summary.packetLossEvents || 0;
  elements.worstLoss.textContent = number(summary.worstPacketLoss, '%');
  elements.sampleCount.textContent = summary.sampleCount || 0;
  elements.problemCount.textContent = (nextState.problems || []).length;
  elements.duration.textContent = nextState.session ? formatDuration(nextState.session.startedAt, nextState.session.endedAt) : '00:00:00';

  const quality = nextState.quality;
  elements.qualityGrade.textContent = quality?.grade || '—';
  elements.qualityGrade.className = quality?.grade ? `grade grade-${quality.grade.toLowerCase()}` : 'grade grade-na';
  elements.qualityExplanation.textContent = quality?.explanation || 'Not enough data to grade.';
  elements.qualityBreakdown.textContent = quality?.breakdown
    ? `Latency ${quality.breakdown.latency} • Jitter ${quality.breakdown.jitter} • Loss ${quality.breakdown.packetLoss} • Stability ${quality.breakdown.stability}` : '';
  elements.historyNotice.hidden = !historical;
  elements.trailContext.textContent = historical ? `Historical session #${nextState.session.id}` : 'Current session';
  elements.historySessionTime.textContent = historical ? formatTime(nextState.session.startedAt) : '';

  const speed = nextState.latestSpeedTest;
  elements.speedHeadline.textContent = !historical && liveState.speedTestRunning
    ? 'Test in progress…'
    : speed?.status === 'failed' ? 'Test unavailable' : speed?.status === 'partial' ? 'Partial result' : speed ? 'Connection results' : 'Not tested yet';
  const phaseLabels = { baseline: 'Measuring baseline…', download: 'Testing download…', upload: 'Testing upload…' };
  elements.testPhase.textContent = !historical && liveState.speedTestRunning ? phaseLabels[liveState.connectionTestPhase] || 'Running connection test…' : '';
  elements.baselineLatency.textContent = number(speed?.unloadedLatency);
  elements.baselineDetails.textContent = `Jitter ${number(speed?.unloadedJitter)} • Loss ${number(speed?.unloadedPacketLoss, '%')}`;
  elements.downloadSpeed.textContent = number(speed?.downloadMbps, ' Mbps');
  elements.uploadSpeed.textContent = number(speed?.uploadMbps, ' Mbps');
  elements.downloadLoaded.textContent = number(speed?.downloadLoadedLatency);
  elements.downloadIncrease.textContent = increase(speed?.downloadLatencyIncrease);
  elements.uploadLoaded.textContent = number(speed?.uploadLoadedLatency);
  elements.uploadIncrease.textContent = increase(speed?.uploadLatencyIncrease);
  elements.speedTime.textContent = speed
    ? `${formatTime(speed.recordedAt)} • ${speed.triggerType === 'manual' ? 'Manual' : 'Automatic'}${speed.error ? ` • ${speed.error}` : ''}`
    : 'Run one manually, or wait for the hourly automatic test.';
  drawChart(nextState.chart, nextState.problems);
}

async function refresh() {
  try {
    state = await api('/api/state');
    render(historicalState || state, state);
  } catch (error) {
    toast(error.message);
  }
}

async function refreshSessions() {
  try {
    const sessions = await api('/api/sessions');
    const rows = sessions.map((session) => `<button class="session-row${selectedSessionId === session.id ? ' selected' : ''}" data-session-id="${session.id}" aria-pressed="${selectedSessionId === session.id}"><span><strong>${formatTime(session.startedAt)}</strong><small>Session #${session.id} • ${formatDuration(session.startedAt, session.endedAt)}</small></span><span class="session-meta"><b class="mini-grade">${session.quality?.grade || '—'}</b><small>${session.sampleCount} samples</small></span></button>`);
    elements.sessions.innerHTML = rows.length ? rows.join('') : '<p class="empty">No sessions yet.</p>';
  } catch (error) {
    elements.sessions.innerHTML = '<p class="empty">History unavailable.</p>';
  }
}

elements.monitorButton.addEventListener('click', async () => {
  elements.monitorButton.disabled = true;
  try {
    const endpoint = state.active ? '/api/monitor/stop' : '/api/monitor/start';
    await api(endpoint, { method: 'POST' });
    await Promise.all([refresh(), refreshSessions()]);
  } catch (error) { toast(error.message); }
  finally { elements.monitorButton.disabled = false; }
});
elements.sessions.addEventListener('click', async (event) => {
  const row = event.target.closest('[data-session-id]');
  if (!row) return;
  const sessionId = Number(row.dataset.sessionId);
  if (state.active && state.session?.id === sessionId) {
    historicalState = null;
    selectedSessionId = null;
    render(state, state);
    await refreshSessions();
    return;
  }
  const request = ++sessionRequest;
  row.disabled = true;
  try {
    const loaded = await api(`/api/sessions/${sessionId}`);
    if (request !== sessionRequest) return;
    selectedSessionId = sessionId;
    historicalState = loaded;
    render(historicalState, state);
    await refreshSessions();
  } catch (error) { toast(error.message); }
  finally { row.disabled = false; }
});
elements.returnLiveButton.addEventListener('click', async () => {
  sessionRequest += 1;
  historicalState = null;
  selectedSessionId = null;
  render(state, state);
  await refreshSessions();
});
elements.monitoringInterval.addEventListener('change', async () => {
  const intervalMs = Number(elements.monitoringInterval.value);
  elements.monitoringInterval.disabled = true;
  try {
    localStorage.setItem(intervalStorageKey, String(intervalMs));
    await api('/api/settings/monitoring-interval', {
      method: 'PUT',
      body: JSON.stringify({ intervalMs })
    });
    await refresh();
  } catch (error) {
    toast(error.message);
    if (state.monitoring) elements.monitoringInterval.value = String(state.monitoring.selectedIntervalMs);
  } finally {
    elements.monitoringInterval.disabled = false;
  }
});
elements.problemButton.addEventListener('click', () => elements.problemDialog.showModal());
elements.connectionTestButton.addEventListener('click', async () => {
  elements.connectionTestButton.disabled = true;
  try {
    await api('/api/connection-test', { method: 'POST' });
    await refresh();
  } catch (error) { toast(error.message); }
});
elements.problemForm.addEventListener('submit', async (event) => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  try {
    await api('/api/problems', {
      method: 'POST',
      body: JSON.stringify({ note: elements.problemNote.value })
    });
    elements.problemDialog.close();
    elements.problemForm.reset();
    toast('Problem marked on the trail');
    await refresh();
  } catch (error) { toast(error.message); }
});
window.addEventListener('resize', () => drawChart((historicalState || state).chart, (historicalState || state).problems));
setInterval(refresh, 5_000);
durationTimer = setInterval(() => {
  if (!historicalState && state.active) elements.duration.textContent = formatDuration(state.session.startedAt);
}, 1_000);
async function initialize() {
  const savedInterval = Number(localStorage.getItem(intervalStorageKey));
  if ([2_000, 10_000, 30_000, 60_000].includes(savedInterval)) {
    try {
      await api('/api/settings/monitoring-interval', {
        method: 'PUT',
        body: JSON.stringify({ intervalMs: savedInterval })
      });
    } catch (error) {
      toast(error.message);
    }
  }
  await Promise.all([refresh(), refreshSessions()]);
}
initialize();
