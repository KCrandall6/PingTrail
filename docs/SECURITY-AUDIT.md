# Phase 4A security review

Review date: 2026-10-20. Baseline: `e1c2337` on `origin/main`.

## Scope and tools

- Reviewed all 25 baseline tracked files, architecture, Express routes, SQLite queries,
  subprocess calls, Cloudflare transfer code, frontend rendering, deployment and documentation.
- Gitleaks 8.24.3 with default rules, redacted output, scanned the working tree and
  `git --all` history. The repository is not shallow: 10 reachable commits including
  merges; Gitleaks scanned the five non-merge changesets. No leaks detected.
- Scanner release archive was verified against its published SHA-256 checksum over HTTPS.
- `npm audit` found four affected dependency nodes initially: critical proxy-addr
  (also reported through Express), moderate qs (also through body-parser).
  Updated compatible lockfile resolutions; final audit has zero advisories.
- Reviewed ignored data, examples, logs and Git paths. No actual credential or personal
  installation detail was identified. No rotation or history rewriting is indicated
  by this review. No secret values appear in this report.

## Findings and remediation

| Finding | Remediation |
| --- | --- |
| Control/read APIs assumed a trusted browser and had no authentication | Server profile requires a supplied 32+ character bearer token; all API routes except minimal health require it. Token can come from a Docker secret file. Non-loopback binding requires a token. |
| Cross-origin mutations and DNS rebinding could reach local controls | Exact same-origin checks, loopback Host enforcement without a token, no CORS allowance, security headers and CSP. |
| Unlimited expensive manual bandwidth tests | Global five-minute cooldown, concurrency guard, bounded process-local API budgets. Fixed counters avoid attacker-controlled limiter maps. |
| Targets were unvalidated subprocess arguments | Strict literal unicast IPv4 validation, rejection of loopback/link-local/multicast/option or shell syntax; execFile still runs without a shell. Targets are operator configuration, never supplied through API requests. |
| Large historical payloads and transfers could consume memory | Bounded history/query parameters, legacy session chart cap, streamed download bodies with size/time limits, bounded latency collection and transfer sizing. |
| Stored internal connection errors could disclose diagnostics | Generic API error messages; request error logs omit exceptions, bodies, headers and credentials. Successful ping checks no longer emit continuous per-check logs. |
| Long-running raw history grew indefinitely | Transactional, incremental retention tiers; markers and tests expire independently. |
| Ignore patterns missed backup/key/WAL variants | Added backup, key, database journal/WAL, secrets directory and local Compose override exclusions; restrictive Docker context exclusions. |
| No hardened server container profile | Non-root, read-only root filesystem, all capabilities dropped, no published port/socket/host mount, bounded Docker logs, named data volume and health check. |

## Trust boundary and residual risk

Sentinel's trusted backend holds the token and proxies only approved operations to the
private PingTrail service. It must authenticate its own users and enforce permissions;
PingTrail's shared token grants read and control access, with no per-user roles.
Never ship the token to frontend JavaScript. Docker membership is not authorization.
The token travels over the private same-host bridge; use TLS or a protected transport
if the trust boundary spans hosts. No server-side user-supplied URLs are fetched.
Only fixed HTTPS Cloudflare bandwidth destinations are used; redirects are rejected.
Operator-configured private IPv4 targets are intentional ICMP destinations, not HTTP SSRF.

Rate limits are shared by all clients of one process, reset after restart, and are not
an upstream abuse firewall. Run one PingTrail writer per database. A trusted token holder
can deliberately pause monitoring or consume the shared budget. ICMP success does not
prove an application is reachable; ICMP loss is not always an ISP fault. Notes and target
addresses are private operational data; protect backups, volume access and Sentinel logs.
The unauthenticated health response exposes only database availability.

## Limitations

Secret scanners cannot prove absence of secrets. Coverage includes fetched reachable
history, not deleted remote refs, forks, GitHub caches or previously force-pushed objects.
Audit results reflect the registry's advisory database at review time, not a source-level
review of every transitive dependency. Re-run dependency and container-image scans as
part of maintenance. Live home-router measurements, Windows/macOS execution, sustained
bandwidth tests and host reboot tests require operator validation. See DEPLOYMENT.md
for validation commands and the final validation record for container build results.
