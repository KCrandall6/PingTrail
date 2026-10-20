"use strict";

const DAY = 86_400_000;
const defaults = Object.freeze({
  rawDays: 7,
  minuteDays: 30,
  hourlyDays: 365,
  markerDays: 730,
  testDays: 365,
});

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS monitor_preferences (id INTEGER PRIMARY KEY CHECK(id=1), desired INTEGER NOT NULL, session_id INTEGER);
    CREATE INDEX IF NOT EXISTS idx_samples_time ON network_samples(recorded_at);
    CREATE INDEX IF NOT EXISTS idx_tests_time ON speed_tests(recorded_at);
    CREATE INDEX IF NOT EXISTS idx_markers_time ON problem_markers(recorded_at);
    CREATE TABLE IF NOT EXISTS sample_rollups (
      tier INTEGER NOT NULL, bucket INTEGER NOT NULL, session_id INTEGER NOT NULL REFERENCES sessions(id),
      target TEXT NOT NULL, target_type TEXT NOT NULL, samples INTEGER NOT NULL,
      sent INTEGER NOT NULL, received INTEGER NOT NULL, latency_sum REAL NOT NULL,
      latency_weight INTEGER NOT NULL, minimum REAL, maximum REAL, jitter_sum REAL NOT NULL,
      jitter_max REAL NOT NULL, unreachable INTEGER NOT NULL, spikes INTEGER NOT NULL,
      first_at TEXT NOT NULL, last_at TEXT NOT NULL, max_gap_ms INTEGER NOT NULL,
      loss_events INTEGER NOT NULL, worst_loss REAL NOT NULL,
      PRIMARY KEY(tier,bucket,session_id,target,target_type)
    );
    CREATE INDEX IF NOT EXISTS idx_rollups_time ON sample_rollups(bucket);
    CREATE INDEX IF NOT EXISTS idx_rollups_last ON sample_rollups(last_at);
    CREATE INDEX IF NOT EXISTS idx_rollups_session ON sample_rollups(session_id,bucket);
  `);
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(sample_rollups)")
      .all()
      .map((c) => c.name),
  );
  if (!columns.has("loss_events"))
    db.exec(
      "ALTER TABLE sample_rollups ADD COLUMN loss_events INTEGER NOT NULL DEFAULT 0",
    );
  if (!columns.has("worst_loss"))
    db.exec(
      "ALTER TABLE sample_rollups ADD COLUMN worst_loss REAL NOT NULL DEFAULT 0",
    );
  db.exec(`
    DROP VIEW IF EXISTS measurement_history;
    CREATE VIEW measurement_history AS
      SELECT 0 AS tier, CAST(strftime('%s',recorded_at) AS INTEGER)*1000 AS bucket,
      session_id, target, target_type, 1 AS samples, packets_sent AS sent, packets_received AS received,
      COALESCE(avg_latency * packets_received,0) AS latency_sum,
      CASE WHEN avg_latency IS NULL THEN 0 ELSE packets_received END AS latency_weight,
      min_latency AS minimum, max_latency AS maximum, jitter AS jitter_sum, jitter AS jitter_max,
      CASE WHEN packets_received=0 THEN 1 ELSE 0 END AS unreachable,
      CASE WHEN avg_latency>=150 OR max_latency>=200 THEN 1 ELSE 0 END AS spikes,
      recorded_at AS first_at, recorded_at AS last_at, 0 AS max_gap_ms,
      CASE WHEN packets_received<packets_sent THEN 1 ELSE 0 END AS loss_events, packet_loss AS worst_loss FROM network_samples
      UNION ALL SELECT * FROM sample_rollups;
  `);
}

const metrics = `SUM(samples) AS samples, SUM(sent) AS sent, SUM(received) AS received,
 SUM(latency_sum) AS latency_sum, SUM(latency_weight) AS latency_weight,
 MIN(minimum) AS minimum, MAX(maximum) AS maximum, SUM(jitter_sum) AS jitter_sum,
 MAX(jitter_max) AS jitter_max, SUM(unreachable) AS unreachable, SUM(spikes) AS spikes,
 MIN(first_at) AS first_at, MAX(last_at) AS last_at, MAX(gap) AS max_gap_ms, SUM(loss_events) AS loss_events, MAX(worst_loss) AS worst_loss`;

function aggregateSQL(source, where, period) {
  return `WITH ordered AS (SELECT *, MAX(max_gap_ms, COALESCE(
    CAST((julianday(first_at)-julianday(LAG(last_at) OVER
    (PARTITION BY session_id,target,target_type ORDER BY bucket)))*86400000 AS INTEGER),0)) AS gap
    FROM ${source} WHERE ${where}) SELECT CAST(bucket/${period} AS INTEGER)*${period} AS bucket,
    session_id,target,target_type,${metrics} FROM ordered GROUP BY 1,session_id,target,target_type`;
}

function retentionBatch(
  db,
  policy = defaults,
  now = Date.now(),
  beforeDelete = () => {},
) {
  const p = { ...defaults, ...policy };
  if (
    !(p.rawDays <= p.minuteDays && p.minuteDays <= p.hourlyDays) ||
    Object.values(p).some((v) => !Number.isInteger(v) || v < 1)
  )
    throw new RangeError("Invalid retention policy");
  // At most 120 complete source buckets per transaction; never delete a partially processed bucket.
  const roll = (sourceTier, destinationTier, days, source, sourceWhere) => {
    const cutoff =
      Math.floor((now - days * DAY) / destinationTier) * destinationTier;
    const oldest =
      sourceTier === 0
        ? db
            .prepare(
              "SELECT MIN(recorded_at) AS at FROM network_samples WHERE recorded_at<?",
            )
            .get(new Date(cutoff).toISOString()).at
        : db
            .prepare(
              "SELECT MIN(bucket) AS at FROM sample_rollups WHERE tier=? AND bucket<?",
            )
            .get(sourceTier, cutoff).at;
    if (oldest == null) return 0;
    const oldestMs = sourceTier === 0 ? Date.parse(oldest) : oldest;
    const end = Math.min(
      cutoff,
      (Math.floor(oldestMs / destinationTier) + 120) * destinationTier,
    );
    const boundary = sourceTier === 0 ? new Date(end).toISOString() : end;
    return db.transaction(() => {
      const rows = db
        .prepare(
          aggregateSQL(
            source,
            `${sourceWhere} AND ${sourceTier === 0 ? "first_at" : "bucket"} < ?`,
            destinationTier,
          ),
        )
        .all(boundary);
      const insert = db.prepare(`INSERT INTO sample_rollups VALUES
        (@tier,@bucket,@session_id,@target,@target_type,@samples,@sent,@received,@latency_sum,
         @latency_weight,@minimum,@maximum,@jitter_sum,@jitter_max,@unreachable,@spikes,@first_at,@last_at,@max_gap_ms,@loss_events,@worst_loss)
        ON CONFLICT(tier,bucket,session_id,target,target_type) DO UPDATE SET
        samples=samples+excluded.samples,sent=sent+excluded.sent,received=received+excluded.received,
        latency_sum=latency_sum+excluded.latency_sum,latency_weight=latency_weight+excluded.latency_weight,
        minimum=CASE WHEN minimum IS NULL THEN excluded.minimum WHEN excluded.minimum IS NULL THEN minimum ELSE MIN(minimum,excluded.minimum) END,
        maximum=CASE WHEN maximum IS NULL THEN excluded.maximum WHEN excluded.maximum IS NULL THEN maximum ELSE MAX(maximum,excluded.maximum) END,
        jitter_sum=jitter_sum+excluded.jitter_sum,jitter_max=MAX(jitter_max,excluded.jitter_max),
        unreachable=unreachable+excluded.unreachable,spikes=spikes+excluded.spikes,
        first_at=MIN(first_at,excluded.first_at),last_at=MAX(last_at,excluded.last_at),
        max_gap_ms=MAX(max_gap_ms,excluded.max_gap_ms,
          MAX(0,CAST((julianday(excluded.first_at)-julianday(last_at))*86400000 AS INTEGER)),
          MAX(0,CAST((julianday(first_at)-julianday(excluded.last_at))*86400000 AS INTEGER))),
        loss_events=loss_events+excluded.loss_events,worst_loss=MAX(worst_loss,excluded.worst_loss)`);
      for (const row of rows) insert.run({ ...row, tier: destinationTier });
      beforeDelete();
      if (sourceTier === 0)
        db.prepare("DELETE FROM network_samples WHERE recorded_at < ?").run(
          new Date(end).toISOString(),
        );
      else
        db.prepare(
          "DELETE FROM sample_rollups WHERE tier=? AND bucket < ?",
        ).run(sourceTier, end);
      return rows.length;
    })();
  };
  const minute = roll(0, 60_000, p.rawDays, "measurement_history", "tier=0");
  const hourly = roll(
    60_000,
    3_600_000,
    p.minuteDays,
    "sample_rollups",
    "tier=60000",
  );
  db.transaction(() => {
    db.prepare(
      "DELETE FROM sample_rollups WHERE rowid IN (SELECT rowid FROM sample_rollups WHERE tier=3600000 AND bucket < ? LIMIT 1000)",
    ).run(Math.floor((now - p.hourlyDays * DAY) / 3_600_000) * 3_600_000);
    db.prepare(
      "DELETE FROM problem_markers WHERE id IN (SELECT id FROM problem_markers WHERE recorded_at < ? LIMIT 1000)",
    ).run(new Date(now - p.markerDays * DAY).toISOString());
    db.prepare(
      "DELETE FROM speed_tests WHERE id IN (SELECT id FROM speed_tests WHERE recorded_at < ? LIMIT 1000)",
    ).run(new Date(now - p.testDays * DAY).toISOString());
  })();
  return { minute, hourly };
}

function history(db, { start, end, resolution = 60_000, limit = 2000 }) {
  const rows = db
    .prepare(
      aggregateSQL(
        "measurement_history",
        "last_at >= ? AND first_at < ?",
        resolution,
      ) + " ORDER BY bucket,target LIMIT ?",
    )
    .all(new Date(start).toISOString(), new Date(end).toISOString(), limit + 1);
  const truncated = rows.length > limit;
  const points = rows.slice(0, limit).map((r) => ({
    recordedAt: new Date(r.bucket).toISOString(),
    sessionId: r.session_id,
    target: r.target,
    targetType: r.target_type,
    sampleCount: r.samples,
    packetsSent: r.sent,
    packetsReceived: r.received,
    packetLoss: r.sent ? (100 * (r.sent - r.received)) / r.sent : null,
    avgLatency: r.latency_weight ? r.latency_sum / r.latency_weight : null,
    minLatency: r.minimum,
    maxLatency: r.maximum,
    jitter: r.jitter_sum / r.samples,
    maxJitter: r.jitter_max,
    unreachableCount: r.unreachable,
    spikeCount: r.spikes,
    firstSampleAt: r.first_at,
    lastSampleAt: r.last_at,
    maxGapMs: r.max_gap_ms,
  }));
  const gaps = [];
  const previous = new Map();
  for (const p of points) {
    const key = `${p.targetType}:${p.target}`;
    const prev = previous.get(key);
    if (
      prev &&
      Date.parse(p.firstSampleAt) - Date.parse(prev.lastSampleAt) > 90_000
    )
      gaps.push({
        target: p.target,
        start: prev.lastSampleAt,
        end: p.firstSampleAt,
      });
    else if (!prev && Date.parse(p.firstSampleAt) - start > 90_000)
      gaps.push({
        target: p.target,
        start: new Date(start).toISOString(),
        end: p.firstSampleAt,
      });
    if (p.maxGapMs > 90_000)
      gaps.push({
        target: p.target,
        period: p.recordedAt,
        maxGapMs: p.maxGapMs,
        internal: true,
      });
    previous.set(key, p);
  }
  for (const p of previous.values())
    if (end - Date.parse(p.lastSampleAt) > 90_000)
      gaps.push({
        target: p.target,
        start: p.lastSampleAt,
        end: new Date(end).toISOString(),
      });
  if (!points.length)
    gaps.push({
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
    });
  const markers = db
    .prepare(
      `SELECT id,session_id AS sessionId,recorded_at AS recordedAt,note FROM problem_markers
    WHERE recorded_at>=? AND recorded_at<? ORDER BY recorded_at LIMIT 501`,
    )
    .all(new Date(start).toISOString(), new Date(end).toISOString());
  const tiers = db
    .prepare(
      "SELECT DISTINCT tier FROM measurement_history WHERE last_at>=? AND first_at<?",
    )
    .all(new Date(start).toISOString(), new Date(end).toISOString())
    .map((r) => r.tier);
  return {
    resolutionMs: resolution,
    sourceResolutionsMs: tiers,
    points,
    gaps,
    markers: markers.slice(0, 500),
    truncated: truncated || markers.length > 500,
  };
}

function storage(db, policy = defaults) {
  const oldest = db
    .prepare("SELECT MIN(first_at) AS oldest FROM measurement_history")
    .get().oldest;
  return {
    retention: { ...defaults, ...policy },
    oldestMeasurementAt: oldest,
    databaseBytes:
      db.pragma("page_count", { simple: true }) *
      db.pragma("page_size", { simple: true }),
    freePages: db.pragma("freelist_count", { simple: true }),
    journalMode: db.pragma("journal_mode", { simple: true }),
  };
}
module.exports = { migrate, retentionBatch, history, storage, defaults, DAY };
