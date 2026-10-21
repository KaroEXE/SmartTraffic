const express = require('express');
const { requireToken } = require('../utils/auth');

/**
 * mode "live" (default): the full live API, mounted at /api.
 * mode "simulation": read-only view of simulated state, mounted at
 *   /api/simulation. It deliberately has no POST /traffic - simulated
 *   observations are produced inside the simulator, never ingested over HTTP.
 */
function createTrafficRoutes(controller, { mode = 'live' } = {}) {
  const router = express.Router();

  if (mode === 'live') {
    router.get('/health', controller.health);
    router.post('/traffic', ...controller.postTrafficHandlers);
    router.get('/traffic/observations', controller.getAllObservations);
    router.get('/traffic/observations/:intersectionId', controller.getObservation);
    router.get('/history/traffic', controller.getHistoryTraffic);
    router.get('/history/signals', controller.getHistorySignals);
  }
  router.get('/traffic/state', controller.getAllStates);
  router.get('/traffic/state/:intersectionId', controller.getState);
  router.get('/intersections', controller.getIntersections);
  router.get('/network', controller.getNetwork);

  return router;
}

/** /api/simulation: read-only simulated state (same handlers, simulation engine) + start/pause/reset/scenario/tour. */
function createSimulationRoutes(readController, simulationController) {
  const router = createTrafficRoutes(readController, { mode: 'simulation' });
  router.get('/status', simulationController.status);
  router.post('/start', simulationController.start);
  router.post('/pause', simulationController.pause);
  router.post('/reset', simulationController.reset);
  router.post('/scenario', simulationController.scenario);
  router.post('/tour', simulationController.tour);
  router.post('/network', simulationController.network);
  router.post('/ambulance', simulationController.dispatchAmbulance);
  router.patch('/ambulance/:id', simulationController.rerouteAmbulance);
  router.delete('/ambulance/:id', simulationController.cancelAmbulance);
  router.get('/benchmark', simulationController.latestBenchmark);
  router.post('/benchmark', simulationController.benchmark);
  return router;
}

/**
 * /api/streams: camera stream registry (controllers/streamController.js).
 *
 *   reads + health  ingest or admin token; open when TRAFFIC_INGEST_TOKEN is
 *                   not set (the same development rule as POST /api/traffic)
 *   management      admin token only; disabled (503) without STREAM_ADMIN_TOKEN
 *   /status         public, never contains URLs or tokens
 */
function createStreamRoutes(controller, { ingestToken = '', adminToken = '' } = {}) {
  const router = express.Router();
  const read = ingestToken
    ? requireToken([ingestToken, adminToken], { openWhenUnset: true })
    : (req, res, next) => next();
  const admin = requireToken(adminToken, {
    openWhenUnset: false,
    disabledMessage: 'Stream management is disabled: set STREAM_ADMIN_TOKEN on the backend',
  });

  router.get('/status', controller.status);
  router.post('/health', read, controller.health);
  router.get('/', read, controller.list);
  router.get('/:id', read, controller.get);
  router.post('/', admin, controller.create);
  router.patch('/:id', admin, controller.update);
  router.delete('/:id', admin, controller.remove);
  return router;
}

module.exports = { createTrafficRoutes, createSimulationRoutes, createStreamRoutes };
