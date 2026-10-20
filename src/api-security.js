"use strict";
const { timingSafeEqual, createHash } = require("node:crypto");
const digest = (s) => createHash("sha256").update(s).digest();
function security(app, config) {
  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    res.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    next();
  });
  let windowStart = Date.now(),
    requests = 0,
    mutations = 0,
    lastTest = 0;
  app.use("/api", (req, res, next) => {
    if (req.path === "/health" && req.method === "GET") return next();
    const host = req.headers.host;
    const origin = req.headers.origin;
    if (origin) {
      let parsed;
      try {
        parsed = new URL(origin);
      } catch {
        return res.status(403).json({ error: "Origin denied." });
      }
      if (
        parsed.host !== host ||
        !["http:", "https:"].includes(parsed.protocol)
      )
        return res.status(403).json({ error: "Origin denied." });
    }
    if (config.apiToken) {
      const authorization = req.headers.authorization || "";
      if (
        !timingSafeEqual(
          digest(authorization),
          digest(`Bearer ${config.apiToken}`),
        )
      )
        return res.status(401).json({ error: "Authentication required." });
    } else if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host || "")) {
      return res
        .status(403)
        .json({ error: "Local access requires a loopback Host header." });
    }
    if (Date.now() - windowStart >= 60_000) {
      windowStart = Date.now();
      requests = 0;
      mutations = 0;
    }
    const mutate = !["GET", "HEAD"].includes(req.method);
    if (++requests > 240 || (mutate && ++mutations > 30))
      return res
        .status(429)
        .set("Retry-After", "60")
        .json({ error: "Rate limit exceeded." });
    if (req.path === "/connection-test" && req.method === "POST") {
      if (Date.now() - lastTest < 300_000)
        return res
          .status(429)
          .set("Retry-After", "300")
          .json({ error: "Wait five minutes between manual tests." });
      // Reserve only accepted starts; unavailable/running requests should remain 409.
      const original = res.json.bind(res);
      res.json = (body) => {
        if (res.statusCode === 202) lastTest = Date.now();
        return original(body);
      };
    }
    next();
  });
}
module.exports = security;
