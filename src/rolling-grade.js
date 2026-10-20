"use strict";
const WINDOW_MS = 30 * 60_000;
const thresholds = Object.freeze({
  A: [50, 10, 0.5],
  B: [80, 20, 1],
  C: [120, 35, 3],
  D: [200, 60, 8],
});
function assess(metrics) {
  if (!metrics || !metrics.sent) return null;
  const latency = metrics.weight ? metrics.latency / metrics.weight : null;
  const jitter = metrics.jitter / metrics.samples;
  const loss = (100 * (metrics.sent - metrics.received)) / metrics.sent;
  const grade =
    latency == null
      ? "F"
      : Object.entries(thresholds).find(
          ([, t]) => latency <= t[0] && jitter <= t[1] && loss <= t[2],
        )?.[0] || "F";
  return { grade, latency, jitter, packetLoss: loss };
}
function rollingGrade(
  db,
  { now = Date.now(), active = true, targets = [] } = {},
) {
  const start = new Date(now - WINDOW_MS).toISOString();
  const rows = db
    .prepare(
      `SELECT target,target_type AS type,recorded_at AS at,packets_sent AS sent,
    packets_received AS received,avg_latency AS latency,jitter FROM network_samples WHERE recorded_at>=? AND recorded_at<=?
    ORDER BY recorded_at`,
    )
    .all(start, new Date(now).toISOString());
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.type}:${r.target}`;
    if (!groups.has(key))
      groups.set(key, {
        target: r.target,
        type: r.type,
        sent: 0,
        received: 0,
        latency: 0,
        weight: 0,
        jitter: 0,
        samples: 0,
        minutes: new Set(),
      });
    const g = groups.get(key);
    g.sent += r.sent;
    g.received += r.received;
    g.samples++;
    g.jitter += r.jitter;
    if (r.latency != null) {
      g.latency += r.latency * r.received;
      g.weight += r.received;
    }
    g.minutes.add(Math.floor(Date.parse(r.at) / 60_000));
    g.last = r.at;
  }
  const expected = targets.length
    ? targets
    : [...groups.values()].map((g) => ({
        target: g.target,
        targetType: g.type,
      }));
  const results = expected.map((t) => {
    const g = groups.get(`${t.targetType}:${t.target}`);
    return {
      target: t.target,
      targetType: t.targetType,
      ...assess(g),
      coverage: g ? Math.min(1, g.minutes.size / 30) : 0,
      stale: !g || now - Date.parse(g.last) > 90_000,
    };
  });
  const coverage = results.length
    ? Math.min(...results.map((r) => r.coverage))
    : 0;
  const stale = !active || !results.length || results.some((r) => r.stale);
  const sufficient = coverage >= 0.5;
  const grades = "ABCDF";
  const worst = results.reduce(
    (a, r) => (grades.indexOf(r.grade) > grades.indexOf(a) ? r.grade : a),
    "A",
  );
  return {
    windowMinutes: 30,
    grade: stale || !sufficient ? null : worst,
    status: stale
      ? "unavailable"
      : !sufficient
        ? "insufficient-data"
        : "measured",
    coverage,
    confidence: stale
      ? "none"
      : coverage >= 0.9
        ? "high"
        : sufficient
          ? "medium"
          : "low",
    targets: results,
    explanation: stale
      ? "Monitoring is paused, missing a target, or older than 90 seconds."
      : !sufficient
        ? "At least 15 distinct sampled minutes per target are required."
        : "Worst target grade from measured latency, jitter and count-weighted packet loss; compare router and external targets.",
  };
}
module.exports = { rollingGrade, assess, thresholds, WINDOW_MS };
