'use strict';

const path = require('node:path');
const express = require('express');

function createApp({ monitor, database, publicDirectory = path.join(__dirname, '..', 'public') }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use(express.static(publicDirectory, { extensions: ['html'] }));

  app.get('/api/state', (request, response, next) => {
    try {
      response.json(monitor.getState());
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/monitor/start', async (request, response, next) => {
    try {
      const result = await monitor.start();
      response.status(result.started ? 201 : 200).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/monitor/stop', (request, response, next) => {
    try {
      response.json(monitor.stop());
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/settings/monitoring-interval', (request, response, next) => {
    try {
      response.json(monitor.setMonitoringInterval(request.body?.intervalMs));
    } catch (error) {
      if (error instanceof RangeError) return response.status(400).json({ error: error.message });
      return next(error);
    }
  });

  app.post('/api/connection-test', async (request, response, next) => {
    try {
      if (!monitor.active) return response.status(409).json({ error: 'Start monitoring before running a connection test.' });
      if (monitor.speedTestRunning) return response.status(409).json({ error: 'A connection test is already running.' });
      void monitor.runConnectionTest('manual');
      return response.status(202).json({ started: true });
    } catch (error) {
      return next(error);
    }
  });


  app.post('/api/problems', (request, response, next) => {
    try {
      if (!monitor.active) {
        return response.status(409).json({ error: 'Monitoring must be active to mark a problem.' });
      }
      const suppliedNote = request.body?.note;
      const note = typeof suppliedNote === 'string' ? suppliedNote.trim().slice(0, 500) : '';
      const marker = database.insertProblem(monitor.session.id, note);
      return response.status(201).json(marker);
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/sessions', (request, response, next) => {
    try {
      response.json(database.getRecentSessions(10));
    } catch (error) {
      next(error);
    }
  });

  app.use('/api', (request, response) => {
    response.status(404).json({ error: 'Not found' });
  });

  app.use((error, request, response, next) => {
    void request;
    void next;
    console.error(`${new Date().toISOString()} ERROR Request failed`, error);
    response.status(500).json({ error: 'PingTrail could not complete that request.' });
  });
  return app;
}

module.exports = createApp;
