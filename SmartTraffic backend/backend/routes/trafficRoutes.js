const express = require('express');

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
  return router;
}

module.exports = { createTrafficRoutes, createSimulationRoutes };
