# PingTrail

<img src="public/assets/pingtrail-logo.png" alt="PingTrail logo" width="240">

**Track your internet connection. Find the problem.**

PingTrail is a small, open-source, local-first network monitor for diagnosing intermittent home network and internet problems. It samples your router and two independent internet targets, keeps the results in SQLite on your computer, and presents the current session in a friendly browser dashboard.

## What PingTrail includes

- Backend monitoring that continues when the browser is closed
- A fresh retained session each time monitoring starts
- Automatic IPv4 default-gateway detection
- Five pings each to the router, `1.1.1.1`, and `8.8.8.8` every 30 seconds
- SQLite persistence of success, packet loss, and unreachable targets
- Start/stop control, latest check, live duration, summaries, recent sessions, and a latency chart
- Optional timestamped “Mark Problem” notes, shown as red dashed lines on the chart
- A manual or hourly comprehensive connection test for throughput and latency under load
- Local-only HTTP binding and no accounts, telemetry, or cloud database

## Windows quick start

### Prerequisites

1. Install the current [Node.js 20 LTS or newer](https://nodejs.org/). The normal Windows installer includes npm.
2. Git is optional if you download a ZIP. If using Git, clone this repository.
3. Windows' built-in `ping.exe` and `route.exe` must be available. This is true on normal Windows installations and does not generally require Administrator privileges.

### Install and run

Open **PowerShell** or **Command Prompt** in the PingTrail folder:

```powershell
npm install
npm start
```

Then open <http://localhost:3000>. Press **Ctrl+C** in the terminal to stop PingTrail. Closing only the dashboard tab does not stop backend monitoring.

For development with automatic server restarts:

```powershell
npm run dev
```

Run the automated tests with:

```powershell
npm test
```

`better-sqlite3` normally installs a prebuilt Windows binary. If npm has to compile it instead, install the Visual Studio Build Tools with the “Desktop development with C++” workload and retry `npm install`.

## What PingTrail measures

Every monitoring check shares one timestamp and contains one sample per target. Each sample stores:

| Measurement | Meaning |
| --- | --- |
| Target / type | The detected router (`router`) or an internet endpoint (`external`) |
| Packets sent / received | How many ICMP echo requests were attempted and answered |
| Packet loss | `(sent - received) / sent × 100`; any value above 0% is a loss event |
| Minimum / average / maximum latency | Round-trip time (RTT) of successful replies in milliseconds |
| Jitter | Mean absolute difference between consecutive successful RTTs |

**Latency** is the round-trip travel time for a small request and reply. **Router latency** covers
the local path to the default gateway, while **internet latency** covers external targets. Comparing
them can help distinguish a possible Wi-Fi/LAN/router change from one farther upstream. **Packet
loss** is the percentage of requests that receive no reply, and **jitter** describes inconsistent
latency that may be noticeable in games, voice, or video calls.

The comprehensive test also records **unloaded latency** while the connection is relatively idle,
then **loaded latency** while download and upload transfers are actually active. Download/upload
latency increase is loaded latency minus the unloaded baseline. **Download and upload throughput**
describe how many megabits are transferred per second in each direction.


For example, successful RTTs of 10, 14, 11, and 17 ms have jitter `(4 + 3 + 6) / 3 = 4.33 ms`. This simple variation measure is understandable, useful for short ping groups, and does not disguise sudden changes. A group with fewer than two successful replies records jitter as 0 because variation cannot be estimated. A fully unreachable target records 100% loss and null latency values rather than crashing the app.

### Interpreting the trail

- **Router latency/loss rises while external measurements rise:** the likely trouble is the local Wi-Fi, LAN, or router path.
- **Router stays healthy while both external targets degrade:** the likely trouble is upstream, such as the modem, ISP, or broader internet path.
- **Only one external target degrades:** that target or route may be the issue; compare both external lines before concluding the whole connection is unhealthy.
- **Jitter rises:** round-trip timing is becoming less consistent, which can affect games, calls, and streaming even when average latency looks acceptable.

These are diagnostic clues, not definitive fault attribution. Some routers and networks deprioritize or block ICMP ping traffic.

## Comprehensive connection testing

The test uses Cloudflare's public speed-test endpoints over HTTPS and requires no account. It:

1. sends multiple native pings to establish an idle baseline;
2. repeatedly downloads test data while separate native pings run concurrently;
3. repeatedly uploads test data while separate native pings run concurrently; and
4. compares each loaded average with the baseline.

Each load phase lasts at least eight seconds by default so the latency samples are taken while the
transfer is stressing the connection, rather than substituting a server-reported ping. Loaded
latency increases can reveal responsiveness problems under load, including possible queueing,
bufferbloat, or congestion behavior, but one result is a clue rather than a diagnosis. The figures
are practical local estimates, not a reproduction of a commercial benchmark.

The first automatic test is scheduled about one hour after monitoring starts and repeats hourly;
startup remains lightweight. The dashboard can run the identical test manually at any time while
monitoring is active. An in-process guard prevents manual and automatic tests from overlapping.

Connection-test and ping jobs use independent in-process guards. Monitoring schedules the next
30-second delay only after the current lightweight job finishes. Connection-test failures or partial
download/upload results are saved and never terminate monitoring.

## Local data and privacy

The Express server binds to `127.0.0.1` by default, so other devices on the LAN cannot open the dashboard. Monitoring data is not uploaded by PingTrail. The speed test necessarily exchanges test bytes with `speed.cloudflare.com`; ping checks send ICMP requests to the configured targets.

The SQLite database is created at:

```text
data/pingtrail.sqlite
```

SQLite write-ahead-log companion files may appear beside it while the app is running. The entire `data/` directory is ignored by Git. To reset local history, stop PingTrail and delete that directory. To back it up, stop PingTrail first and copy the SQLite file.

If the Node process ends unexpectedly, an active database session is marked `interrupted` at the next startup. PingTrail does not automatically resume monitoring after a process restart. Reopening only the browser preserves and displays the backend's current state.

## Configuration

Defaults work without configuration. Advanced users can set these environment variables before `npm start`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Local dashboard port |
| `PINGTRAIL_HOST` | `127.0.0.1` | Listen address; changing this may expose private data on the LAN |
| `PINGTRAIL_DB_PATH` | `data/pingtrail.sqlite` | SQLite file path |
| `PINGTRAIL_MONITOR_INTERVAL_MS` | `30000` | Delay between completed monitoring jobs |
| `PINGTRAIL_PING_COUNT` | `5` | Pings per target per check |
| `PINGTRAIL_PING_TIMEOUT_MS` | `5000` | Per-ping timeout |
| `PINGTRAIL_EXTERNAL_TARGETS` | `1.1.1.1,8.8.8.8` | Comma-separated IPv4 targets |
| `PINGTRAIL_SPEED_INTERVAL_MS` | `3600000` | Speed-test interval |
| `PINGTRAIL_SPEED_DOWNLOAD_BYTES` | `25000000` | Download test size |
| `PINGTRAIL_SPEED_UPLOAD_BYTES` | `10000000` | Upload test size |
| `PINGTRAIL_CONNECTION_MIN_LOAD_MS` | `8000` | Minimum duration of each loaded phase |
| `PINGTRAIL_CONNECTION_BASELINE_PINGS` | `8` | Pings used for the unloaded baseline |
| `PINGTRAIL_CHART_POINT_LIMIT` | `500` | Maximum raw samples returned for the chart |

PowerShell example:

```powershell
$env:PORT = "3100"
$env:PINGTRAIL_PING_COUNT = "4"
npm start
```

## Technical choices and limitations

- **Ping:** Node spawns the operating system's native ping command without a shell. Windows uses `ping -n <count> -w <milliseconds>`. Individual `time=` replies are parsed so calculations do not depend on localized summary labels. Windows reports sub-millisecond replies as `time<1ms`; PingTrail estimates these as 0.5 ms.
- **Gateway:** Windows' numeric IPv4 route table (`route print -4 0.0.0.0`) is read and the active default route is used. Linux uses `ip -4 route show default`; macOS uses `route -n get default`.
- **SQLite:** `better-sqlite3` provides simple transactions and prepared statements. WAL mode improves read/write coexistence. Indexed timestamps, session IDs, check IDs, and target fields support later historical analysis.
- **Permissions/firewalls:** PingTrail does not need Administrator rights in typical Windows setups. A firewall, VPN, security product, or network policy may block ICMP or route commands; those conditions appear as unavailable gateway or loss. HTTPS access to `speed.cloudflare.com` is needed only for speed tests.
- **Sleep:** The MVP monitors only while the computer is awake. A future optional Windows adapter can call `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` while monitoring, which keeps the system awake without requesting `ES_DISPLAY_REQUIRED`, and clear it on stop/exit. This is intentionally not implemented until its lifecycle can be validated on Windows.
- **Connection-test estimates:** One server and finite transfers cannot characterize every connection. VPNs, proxies, Wi-Fi contention, ICMP prioritization, and very fast links can influence the numbers. Test manually on Windows to confirm local firewall and Cloudflare endpoint access.

## Project layout

```text
src/app.js          Express API and static dashboard
src/database.js     SQLite schema and queries
src/monitor.js      Session scheduler and overlap guards
src/network.js      Gateway detection, native ping, parsing, jitter
src/speed-test.js   Account-free HTTPS throughput test
src/server.js       Local server lifecycle and clean shutdown
public/             Plain HTML, CSS, JavaScript, and derived logo asset
test/               Node test-runner unit and service tests
```

## Roadmap

PingTrail is still evolving. Some features planned for future releases include:

- **Expanded historical charts** — Toggle between latency, jitter, packet loss, and other metrics with selectable time ranges such as 15 minutes, 1 hour, 6 hours, 24 hours, or the full monitoring session.
- **Local mobile dashboard** — View and control PingTrail from another device on the same network. Leave PingTrail running on a computer and use a phone to check connection health or mark a problem the moment lag occurs.
- **Automatic problem detection** — Identify latency spikes, packet loss, high jitter, local-network instability, and loaded-latency events automatically.
- **Diagnostic event timeline** — Combine detected network events, connection tests, and manually marked problems into a single timeline to make intermittent issues easier to investigate.
- **Session diagnosis** — Summarize each monitoring session and provide diagnostic clues about whether problems appear to originate on the local network, beyond the router, or primarily while the connection is under load.
- **Historical connection tests** — Track throughput and loaded-latency results over time to reveal recurring congestion or responsiveness problems.
- **Diagnostic report export** — Export monitoring results, problem events, connection tests, and summaries for troubleshooting or sharing with an ISP.
- **Improved mobile experience** — A responsive interface designed for quickly checking PingTrail while troubleshooting another device, gaming, or moving around the network.
- **View historical sessions** — Select any previous monitoring session from Recent Sessions to reload its charts, statistics, connection tests, and problem markers for later review.

The long-term goal is for PingTrail to go beyond showing network statistics and help answer a more useful question: **when something went wrong, where did the problem most likely begin?**

## Contributing

Issues and focused pull requests are welcome. Please keep PingTrail local-first, dependency-light, and friendly to non-technical home users. Do not commit databases, logs, `node_modules`, machine-specific configuration, or temporary speed-test data.

## License

PingTrail is available under the [MIT License](LICENSE).