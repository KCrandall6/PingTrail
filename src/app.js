"use strict";

const path = require("node:path");
const express = require("express");
const { history, storage } = require("./history");
const { rollingGrade } = require("./rolling-grade");
const security = require("./api-security");
const { gradeSession } = require("./session-quality");

function sessionPayload(database, session, allChartData = false) {
  const summary = database.getSessionSummary(session.id);
  return {
    session,
    latestCheck: database.getLatestCheck(session.id),
    summary,
    quality: gradeSession({ ...session, summary }),
    chart: allChartData ? database.getAllChartData(session.id) : undefined,
    chartPointLimit: allChartData ? 5000 : undefined,
    latestSpeedTest: database.getLatestSpeedTest(session.id),
    problems: database.getProblems(session.id),
  };
}

function createApp({
  monitor,
  database,
  config = {},
  publicDirectory = path.join(__dirname, "..", "public"),
}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("query parser", "simple");
  security(app, config);
  app.get("/api/health", (req, res) => {
    try {
      database.db.prepare("SELECT 1").get();
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });
  app.use(express.json({ limit: "16kb" }));
  app.use("/api", (req, res, next) => {
    const allowed = {
      "/monitor/start": [],
      "/monitor/stop": [],
      "/connection-test": [],
      "/problems": ["note"],
      "/settings/monitoring-interval": ["intervalMs"],
    };
    if (
      !["GET", "HEAD"].includes(req.method) &&
      Object.hasOwn(allowed, req.path) &&
      req.body != null
    ) {
      if (
        typeof req.body !== "object" ||
        Array.isArray(req.body) ||
        Object.keys(req.body).some((k) => !allowed[req.path].includes(k))
      )
        return res.status(400).json({ error: "Unexpected request fields." });
    }
    next();
  });
  app.use(express.static(publicDirectory, { extensions: ["html"] }));

  app.get("/api/state", (request, response, next) => {
    try {
      response.json(monitor.getState());
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/monitor/start", async (request, response, next) => {
    try {
      const result = await monitor.start();
      response.status(result.started ? 201 : 200).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/monitor/stop", (request, response, next) => {
    try {
      response.json(monitor.stop());
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/settings/monitoring-interval", (request, response, next) => {
    try {
      if (typeof request.body?.intervalMs !== "number")
        return response
          .status(400)
          .json({ error: "intervalMs must be a number." });
      response.json(monitor.setMonitoringInterval(request.body.intervalMs));
    } catch (error) {
      if (error instanceof RangeError)
        return response.status(400).json({ error: error.message });
      return next(error);
    }
  });

  app.post("/api/connection-test", async (request, response, next) => {
    try {
      if (!monitor.active)
        return response.status(409).json({
          error: "Start monitoring before running a connection test.",
        });
      if (monitor.speedTestRunning)
        return response
          .status(409)
          .json({ error: "A connection test is already running." });
      void monitor.runConnectionTest("manual");
      return response.status(202).json({ started: true });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/problems", (request, response, next) => {
    try {
      if (!monitor.active) {
        return response
          .status(409)
          .json({ error: "Monitoring must be active to mark a problem." });
      }
      const suppliedNote = request.body?.note;
      if (
        suppliedNote != null &&
        (typeof suppliedNote !== "string" ||
          suppliedNote.length > 500 ||
          /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(suppliedNote))
      ) {
        return response
          .status(400)
          .json({ error: "Note must be text of at most 500 characters." });
      }
      const note = suppliedNote?.trim() || "";
      const marker = database.insertProblem(monitor.session.id, note);
      return response.status(201).json(marker);
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/sessions", (request, response, next) => {
    try {
      const sessions = database.getRecentSessions(10).map((session) => {
        const summary = database.getSessionSummary(session.id);
        return {
          ...session,
          summary,
          quality: gradeSession({ ...session, summary }),
        };
      });
      response.json(sessions);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/sessions/:sessionId", (request, response, next) => {
    try {
      if (
        !/^\d+$/.test(request.params.sessionId) ||
        Number(request.params.sessionId) < 1
      ) {
        return response
          .status(400)
          .json({ error: "Session ID must be a positive integer." });
      }
      if (!Number.isSafeInteger(Number(request.params.sessionId)))
        return response.status(400).json({ error: "Invalid session ID." });
      const session = database.getSession(Number(request.params.sessionId));
      if (!session)
        return response.status(404).json({ error: "Session not found." });
      return response.json(sessionPayload(database, session, true));
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/summary", (req, res, next) => {
    try {
      const latest = database.db
        .prepare("SELECT MAX(recorded_at) AS at FROM network_samples")
        .get().at;
      const successful = database.db
        .prepare(
          "SELECT MAX(recorded_at) AS at FROM network_samples WHERE packets_received>0",
        )
        .get().at;
      const targets = [
        {
          target:
            config.routerTarget || monitor.gateway || "unavailable-router",
          targetType: "router",
        },
        ...(config.externalTargets || []).map((target) => ({
          target,
          targetType: "external",
        })),
      ];
      const quality = rollingGrade(database.db, {
        active: monitor.active,
        targets,
      });
      const recent = history(database.db, {
        start: Date.now() - 120_000,
        end: Date.now(),
        resolution: 60_000,
        limit: 30,
      }).points;
      const latestTest =
        database.db
          .prepare(
            "SELECT * FROM speed_tests ORDER BY recorded_at DESC LIMIT 1",
          )
          .get() || null;
      if (latestTest?.error)
        latestTest.error =
          "Connection test could not complete; check connectivity.";
      res.json({
        active: monitor.active,
        lastSampleAt: latest,
        lastSuccessfulSampleAt: successful,
        stale:
          !monitor.active ||
          !latest ||
          Date.now() - Date.parse(latest) > 90_000,
        recent,
        rollingGrade: quality,
        recentLagEventCount: database.db
          .prepare(
            "SELECT COUNT(*) AS n FROM problem_markers WHERE recorded_at>=?",
          )
          .get(new Date(Date.now() - 1800000).toISOString()).n,
        connectionTestStatus: monitor.speedTestRunning
          ? "running"
          : latestTest
            ? latestTest.status === "complete"
              ? "completed"
              : latestTest.status
            : "idle",
        latestConnectionTest: latestTest,
        diagnostic: {
          ...monitor.getMonitoringSettings(),
          measurementError: monitor.lastMeasurementError,
        },
        routerSource: config.routerTarget ? "configured" : "automatic",
        routerWarning: !monitor.gateway ? "Router unavailable" : null,
      });
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/history", (req, res, next) => {
    try {
      const ranges = {
        "30m": 1800000,
        "1h": 3600000,
        "6h": 21600000,
        "24h": 86400000,
        "7d": 604800000,
      };
      const range = req.query.range || "30m";
      if (
        typeof range !== "string" ||
        !Object.hasOwn(ranges, range) ||
        Object.keys(req.query).some((k) => k !== "range")
      )
        return res
          .status(400)
          .json({ error: "Range must be 30m, 1h, 6h, 24h, or 7d." });
      const end = Date.now(),
        duration = ranges[range];
      res.json(
        history(database.db, {
          start: end - duration,
          end,
          resolution:
            duration > 86400000 ? 3600000 : duration > 3600000 ? 300000 : 60000,
        }),
      );
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/connection-tests", (req, res, next) => {
    try {
      if (
        Object.keys(req.query).some((k) => k !== "limit") ||
        (req.query.limit != null && !/^[1-9]\d?$/.test(req.query.limit))
      )
        return res
          .status(400)
          .json({ error: "Limit must be an integer from 1 to 50." });
      const limit = Number(req.query.limit || 10);
      if (limit > 50)
        return res
          .status(400)
          .json({ error: "Limit must be an integer from 1 to 50." });
      const results = database.db
        .prepare("SELECT * FROM speed_tests ORDER BY recorded_at DESC LIMIT ?")
        .all(limit);
      for (const r of results)
        if (r.error)
          r.error = "Connection test could not complete; check connectivity.";
      res.json({
        status: monitor.speedTestRunning
          ? "running"
          : results.length
            ? results[0].status === "complete"
              ? "completed"
              : results[0].status
            : "idle",
        results,
      });
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/storage", (req, res, next) => {
    try {
      res.json(storage(database.db, config.retention));
    } catch (e) {
      next(e);
    }
  });

  app.use("/api", (request, response) => {
    response.status(404).json({ error: "Not found" });
  });

  app.use((error, request, response, next) => {
    void request;
    void next;
    const status =
      error.type === "entity.too.large"
        ? 413
        : error instanceof SyntaxError && error.status === 400
          ? 400
          : 500;
    console.error(
      `${new Date().toISOString()} ERROR Request failed (${status})`,
    );
    response
      .status(status)
      .json({ error: "PingTrail could not complete that request." });
  });
  return app;
}

module.exports = createApp;
