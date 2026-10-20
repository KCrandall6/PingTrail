# Ubuntu, Docker and Sentinel integration

PingTrail remains an independent application. Sentinel communicates over HTTP from its
backend; it does not import PingTrail source or connect directly to SQLite.

## Standalone Ubuntu development

Use Node.js 24 LTS (20+ remains supported where compatible with better-sqlite3), npm,
`iputils-ping` and `iproute2`. A native SQLite build may also need Python 3, make and g++.

```sh
sudo apt-get update
sudo apt-get install -y iputils-ping iproute2 python3 make g++
npm ci
npm test
npm start
```

Default binding remains loopback, monitoring initially waits for Start, and the plain
browser dashboard works without accounts or tokens. Subsequent desired state persists:
a user Start resumes after process restart, while Stop remains paused. Set
`PINGTRAIL_AUTO_START=false` to control the first-run default, not to override an existing
stored user choice. On an existing database with no desired-state row, that setting
chooses the initial behavior. An intentional Start after Stop creates a new session;
routine process/container restarts reuse the previous session. Downtime is an absence
of measurements, never fabricated success/loss samples. Historical APIs explicitly report
missing intervals and internal aggregate gaps. One process must own each database.

For Ubuntu without Docker, use a systemd service running `node src/server.js` with a
dedicated unprivileged user, `WorkingDirectory` set to the checkout, `Restart=on-failure`,
`TimeoutStopSec=160`, and an environment file readable only by that user. Set the server
profile, explicit router, external database path and token-file path as below. Enable the
service with systemd for host restart recovery. Do not bind beyond loopback without an
authenticated backend/private transport. Keep data outside the source checkout.

## Production Docker profile

Install Docker Engine and the Compose plugin from their official Ubuntu instructions.
Create a random token outside the checkout using a password manager or `openssl rand`,
with at least 32 characters, and restrict file access. The container's UID 1000 must be
able to read the mounted secret; arrange a dedicated group and `0440` permissions where
appropriate. Do not commit the token or place its value in Compose, a URL, or shell history.
Set paths and router locally:

```sh
export PINGTRAIL_TOKEN_FILE=/absolute/path/outside/checkout/pingtrail-token
export PINGTRAIL_ROUTER_TARGET=192.0.2.1  # documentation placeholder: replace locally
# Optional; lightweight pings continue independently:
export PINGTRAIL_AUTO_SPEED_TESTS=false
docker compose config --quiet
docker compose up --build -d
docker compose ps
```

The image defaults to `PINGTRAIL_PROFILE=server`, auto-start enabled, `0.0.0.0:3000`
inside its private network, and SQLite at `/data/pingtrail.sqlite`. Server startup fails
closed without an explicit validated IPv4 router and a token. `compose.yaml` publishes
no host port. `restart: unless-stopped` recovers after process/container/host restarts,
except an intentionally stopped container. API pause is durable independently of Docker
restart policy. A named volume survives container replacement; **do not use `down -v`**
when retaining history. Graceful stop detaches jobs, drains in-flight work before closing
SQLite, and allows up to 160 seconds. A forced kill relies on SQLite WAL recovery and
persisted monitoring intent on next startup.

The Compose profile uses a read-only root, no additional Linux capabilities, no privileged
mode, no Docker socket and no host network/mounts. Linux datagram ping sockets use the
configured `ping_group_range`; verify this on your Ubuntu kernel. Do not add privileged
mode to work around ping failures. Named-volume ownership is initialized by the image;
pre-existing volumes may need a one-time ownership adjustment for UID/GID 1000.
Logs rotate at 10 MB × 3 files. Review base-image security updates regularly.

The bridge allows outbound traffic: an `internal: true` network alone would prevent
internet measurements. Membership must be limited to trusted backends. Allow ICMP only
to configured targets and optional HTTPS to `speed.cloudflare.com` in the host firewall
if tighter egress control is needed. No incoming LAN/internet port is needed.

For another Compose project, copy the service configuration, retain the named volume
and secret, and attach both PingTrail and the trusted backend to a shared private network.
Use an external Docker network created explicitly for the two projects, rather than
publishing port 3000. The backend uses `http://pingtrail:3000` through service DNS.

For a corporate build proxy, the Dockerfile accepts an optional BuildKit secret named
`build_ca` containing the trusted CA bundle; pass it with `--secret id=build_ca,src=...`
and use the standard proxy build arguments. The CA secret is never copied into the
image. TLS, package signatures and npm integrity checks must remain enabled.

## Router identity and measurement origin

Docker's detected default gateway is usually its virtual bridge, **not the home router**.
Set `PINGTRAIL_ROUTER_TARGET` to the actual router IPv4 address locally. The server
profile requires this; standalone use retains automatic Windows/Linux/macOS detection.
Only literal unicast IPv4 targets are allowed; DNS names, loopback, link-local/metadata,
multicast, broadcast-like `.255` addresses and command syntax are rejected. Up to four
external targets may be configured. Changing targets requires a process restart.

All measurements originate from the Dell server's network interface and routing path.
They do not measure the Xbox's or phone's Wi-Fi connection or application performance.
ICMP filtering, VPNs and container NAT can affect results; compare router and both
external paths before attributing a fault. `routerSource` identifies explicit configuration
versus automatic detection. Docker cannot reliably infer the physical router automatically.

## Sentinel API contract

All `/api/*` endpoints except `GET /api/health` require
`Authorization: Bearer <token>` when a token is configured. Existing standalone endpoints
retain their methods and response fields. Cross-origin access is not enabled. Never put
the token into browser JavaScript; Sentinel authenticates its users, then calls PingTrail
from its backend. The built-in dashboard is for loopback standalone use; a token-enabled
server requires a trusted authenticated backend proxy injecting the header. Do not
expose that proxy publicly without user authentication and authorization. Poll summary
about every 15–30 seconds, and fetch history only when needed.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Minimal SQLite liveness; HTTP 503 if unavailable, no host paths |
| `GET /api/summary` | Active/stale state, last sample and last successful sample, recent router/external metrics, rolling grade/coverage/confidence, 30-minute marker count, latest connection test and diagnostic sampling |
| `GET /api/history?range=30m` | `30m`, `1h`, `6h`, `24h`, `7d`; latency/min/max, jitter/max, count-weighted loss, sent/received counts, spikes/unreachable counts, notes and gaps |
| `GET /api/connection-tests?limit=10` | Up to 50 recent tests; status, throughput, baseline/loaded latency, latency increases and stored explanations |
| `POST /api/connection-test` | Start manual test; HTTP 202; 409 if paused/running; 429 during cooldown |
| `POST /api/problems` | Optional JSON `{"note":"Brief lag observation"}`; server timestamp and current session; 409 when paused |
| `POST /api/monitor/start` | Start/resume desired monitoring; repeated requests are safe |
| `POST /api/monitor/stop` | Intentional durable pause |
| `PUT /api/settings/monitoring-interval` | Numeric JSON `intervalMs`: 2000, 10000, 30000 or 60000 |
| `GET /api/storage` | Database page bytes, free pages, oldest measurement, retention policy; no filesystem paths |
| `GET /api/state` | Existing standalone dashboard state and session grade |
| `GET /api/sessions`, `GET /api/sessions/:id` | Existing recent sessions/details, session grade and bounded chart |

All timestamps are UTC. Summary `recent` contains minute-level recent latency, jitter and
loss per target. Do not display those historical values as current when `stale` is true.
History returns at most 2,000 points and 500 markers, with `truncated` set when capped.
Thirty-minute/hour ranges use one-minute response bins, six-/24-hour ranges five-minute
bins, and seven-day ranges hourly bins. `sourceResolutionsMs` identifies raw (0), minute
or hourly sources; bins overlapping range edges may include the enclosing retained
period. Multiple session IDs may appear in a bin. Break lines at `gaps`, null latency
and internal `maxGapMs` warnings; never interpolate through missing measurements.
Legacy session charts are now capped at 5,000 recent chronological points and expose
`chartPointLimit`; archived points include `resolutionMs` and `maxGapMs`.

Notes must be text of at most 500 characters without control characters. Unknown mutation
fields and malformed JSON are rejected. History accepts only documented ranges, session
IDs must be positive safe integers, and test history limits must be 1–50. JSON bodies are
limited to 16 KB. HTTP 400/401/403/409/413/429 distinguish invalid input, authentication,
origin, unavailable operation, size and rate limits. Expensive manual tests have a shared
five-minute cooldown; APIs also have shared budgets of 240 requests/30 mutations per
minute per process. Clients should respect Retry-After. Health is exempt.

Generic backend example (token remains in the backend secret store):

```js
const result = await fetch('http://pingtrail:3000/api/summary', {
  headers: { Authorization: `Bearer ${process.env.PINGTRAIL_API_TOKEN}` },
  signal: AbortSignal.timeout(5000)
});
if (!result.ok) throw new Error(`PingTrail HTTP ${result.status}`);
const summary = await result.json();
```

## Rolling grade and session grade

Rolling grades use the most recent 30 minutes, independently per configured target.
At least 15 distinct sampled minute buckets per target are required (coverage ≥ 50%).
Coverage is the minimum target minute coverage, capped at 100%; this is sampled-minute
coverage, **not a claim of uninterrupted second-level uptime**. Confidence is high at
90%, medium at 50%, otherwise low. Paused monitoring, missing targets, or a target's last
sample older than 90 seconds yields unavailable/no grade, even if old data was healthy.
An unreachable but freshly attempted target is measured failure, not stale success.

Latency is weighted by received packets; loss is total lost packets / total sent packets,
not averaged percentages. Jitter is the mean of measured per-sample jitter. The grade
is the worst target grade; inspect router versus external results for diagnostic context.
Each row must meet **all three** thresholds; anything worse is F:

| Grade | Mean latency (ms) | Jitter (ms) | Loss (%) |
| --- | ---: | ---: | ---: |
| A | 50 | 10 | 0.5 |
| B | 80 | 20 | 1 |
| C | 120 | 35 | 3 |
| D | 200 | 60 | 8 |

No replies gives F with null latency. Thresholds live in `src/rolling-grade.js` with tests.
This is a transparent heuristic, not a bandwidth grade or definitive root-cause diagnosis.
The existing whole-session grade remains under `quality`, distinct from `rollingGrade`.
It operates on retained session summary statistics, which eventually expire under retention.

## Bandwidth testing

Automatic hourly testing remains enabled by default. Set
`PINGTRAIL_AUTO_SPEED_TESTS=false` to disable only the automatic loaded tests, while
lightweight ping monitoring and manual tests remain available. An automatic restart
uses the previous result/session time to calculate when the next test is due. Tests never
overlap within a process. Status is idle, running, completed, partial or failed; legacy
stored `complete` remains compatible and integration status maps it to `completed`.
Download/upload latency increase is loaded latency minus unloaded baseline; null means
unavailable, and partial results remain useful.

**Bandwidth tests actively generate traffic and can temporarily affect other users.**
The test contacts fixed Cloudflare HTTPS endpoints, streams bounded downloads, and
runs concurrent ICMP sampling. It may transfer multiple configured blocks in each loaded
phase. Timeouts and phase duration bounds limit failures; disable automatic tests on
metered links. Do not run sustained tests merely to check deployment liveness.

## Retention and storage

| Setting | Default | Policy |
| --- | ---: | --- |
| `PINGTRAIL_RAW_DAYS` | 7 | Full-resolution samples |
| `PINGTRAIL_MINUTE_DAYS` | 30 | One-minute summaries after the raw horizon |
| `PINGTRAIL_HOURLY_DAYS` | 365 | Hourly summaries after the minute horizon; expire older data |
| `PINGTRAIL_MARKER_DAYS` | 730 | Notes/markers retained independently of raw samples |
| `PINGTRAIL_TEST_DAYS` | 365 | Comprehensive test retention |

Horizons must be positive and ordered raw ≤ minute ≤ hourly. Increase marker/test horizons
for explicit exceptions; indefinite retention is deliberately unsupported. Numeric settings
are bounded and malformed settings fail startup. Aggregation uses complete UTC periods,
so a boundary bucket may remain in its finer tier until the next cleanup.

Cleanup starts shortly after startup and repeats daily; backlogs run incremental batches
with a one-second yield. Each transaction aggregates up to 120 complete source periods
before removing source rows. Crash/exception rollback leaves the source intact. Upserts
support disjoint late arrivals; source deletion and aggregation commit together, so reruns
do not double-count. Raw, minute and hourly rows are disjoint. Aggregates preserve
session/target identity, sample and packet counts, weighted latency sums, min/max latency,
jitter sum/max, loss-event/worst-loss statistics, unreachable/spike counts, first/last sample
and maximum internal gap. Exact interior gap timestamps cannot be recovered from an
hourly record; its explicit gap indicator must not be hidden. Session metadata is retained;
measurements, markers and test records have independent finite horizons.

Existing databases migrate additively in one transaction; historical rows are not discarded
by migration. Cleanup subsequently applies configured horizons. **Back up first** if older
raw records must be archived indefinitely. There is no automatic history rewrite or schema
downgrade. Stop the app and restore a pre-upgrade backup to return to an older version.

WAL enables concurrent readers; busy timeout is five seconds. Avoid prolonged external
read transactions that prevent WAL checkpointing. Deleting records frees reusable SQLite
pages but does not immediately shrink the file. `/api/storage` reports allocated page bytes
and free pages (not total WAL/disk usage); inspect volume usage locally for WAL/disk alerts.
For occasional compaction, stop the service, create a verified backup, ensure free disk
space for a full rewrite, then run `sqlite3 <database-file> 'VACUUM; PRAGMA integrity_check;'`
locally as the database owner. Never remove a live `-wal`/`-shm` file. No automatic blocking
VACUUM runs on the monitoring hot path. Incremental vacuum requires opting into SQLite's
incremental auto-vacuum mode with an offline migration; it is not enabled by this version.

### Backup and recovery

For a simple consistent backup, stop PingTrail cleanly and copy the entire data directory
including any WAL/SHM companions, preserving ownership and keeping the backup outside
the public checkout. Restart after the copy. Alternatively, use SQLite's online backup API
or CLI `.backup` against the mounted database as its owner; copying only the live main
file is unsafe. Restrict and encrypt backups because notes/targets are private data.

To recover, stop PingTrail, preserve the current volume for diagnosis, restore the backup
data to the named volume as UID/GID 1000, and run `PRAGMA integrity_check` before restart.
Verify health, recent history and the stored desired pause/running state. Start explicitly
only if needed. Never run two writers against the same database. Retention resumes on
startup, so review retention settings before restoring an old archive.

## Operator verification

```sh
npm ci
npm test
npm audit --omit=dev
docker compose config --quiet
docker compose build
docker compose up -d
# Health without any published host port:
docker compose exec pingtrail node -e "fetch('http://127.0.0.1:3000/api/health').then(async r=>{console.log(await r.json());process.exit(r.ok?0:1)})"
docker compose exec pingtrail id
docker compose exec pingtrail ping -n -c 1 1.1.1.1
```

From the authenticated backend, verify summary samples for the configured actual router
and both external targets, markers, history and stale/no-grade behavior while paused.
Record the session ID; restart the container and verify continuity, an explicit history
gap and no synthetic samples. Pause, restart, and verify it remains paused. Recreate the
container without deleting the volume and confirm history survives. Check the container
health status after its start period and confirm no host port is published. Perform a
planned host reboot and verify restart policy locally. Run one deliberate manual loaded
test when other users consent, check full/partial metrics, verify cooldown, and observe
a later automatic run if enabled. Check Ubuntu's datagram ICMP permissions if pings fail.
Windows/macOS native commands and actual home-router identity still need platform tests.

For a disposable automated container check after building `pingtrail:phase4a`, run
`python3 scripts/docker-smoke.py`. It removes only its own temporary container/volume,
uses no published port, and does not perform bandwidth tests. See
[the validation record](VALIDATION.md) for checks actually executed and limitations.
