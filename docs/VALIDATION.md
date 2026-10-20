# Phase 4A validation record

Validated in the Codex Linux environment on 2026-10-20 using Node.js 24.19.0,
npm 11.9.0 and Docker Engine 28.4.0.

- Fresh `npm ci` completed with lockfile integrity verification enabled.
- `npm test`: 41 tests passed, zero failed/skipped/cancelled. Includes all 26 original
  tests plus 15 integration-preparation tests. The portable runner enumerates actual
  `.test.js` files, avoiding Node 24's changed directory handling and accidental
  discovery of `src/speed-test.js` as an empty test file.
- `npm audit --omit=dev`: zero known vulnerabilities after compatible dependency updates.
- Gitleaks 8.24.3: no detections in fetched reachable history or final working tree;
  full coverage qualifications are in SECURITY-AUDIT.md.
- Production Docker image built successfully with verified Debian packages, npm
  integrity checks and TLS verification. The cloud build needed existing proxy DNS
  mapping and its trusted CA mounted as a temporary BuildKit secret. No verification
  was disabled. Initial DNS/CA permission failures were diagnosed and corrected.
- `docker compose config --quiet` passed using generic placeholder configuration.
- `python3 scripts/docker-smoke.py` passed against the production image: UID 1000,
  read-only root, dropped capabilities, no-new-privileges, datagram ICMP to loopback,
  actual Docker health check, rejected unauthenticated API access, no published port,
  session continuity and marker persistence across restart, and pause surviving restart.
  The test creates and removes its own container and named volume, uses a disposable
  token, and intentionally has no network connectivity. It does not send bandwidth traffic.
- Standalone `npm start` responded successfully to local health and summary requests;
  a paused instance returned no healthy rolling grade.
- `git diff --check` passed.

## Remaining operator verification

The cloud host itself prohibits native ICMP sockets and lacks a system ping installation;
this is distinct from the container's verified datagram ICMP permission. The optional local
helper binary does not bypass that restriction. Missing utilities/permissions produce a
diagnostic gap rather than invented target loss. Actual Ubuntu home-router/external
reachability, sustained bandwidth measurements, Windows/macOS runtime behavior,
long-term disk growth and a physical host reboot were not exercised here. Run the
operator checks in DEPLOYMENT.md before relying on deployment measurements.

GitHub API requests are blocked by the cloud network policy (CONNECT HTTP 403).
The required `api.github.com` domain addition was saved to the environment draft;
saving does not apply/publish it. Native Git read/push permissions are separate from
GitHub API access. A blocked PR creation should be completed after network access is
applied, or through GitHub's compare/PR UI. No deployment or merge is authorized by
these validation results.
