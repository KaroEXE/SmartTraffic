/**
 * HTTP controls for the simulator (/api/simulation/*). They only change the
 * simulation; nothing here can reach live state.
 */
function createSimulationController(simulation) {
  const ok = (res, status) => res.json({ ok: true, ...status });
  const bad = (res, status, error) => res.status(status).json({ ok: false, error });

  return {
    status: (req, res) => ok(res, simulation.getStatus()),
    start: (req, res) => ok(res, simulation.start()),
    pause: (req, res) => ok(res, simulation.pause()),
    reset: (req, res) => ok(res, simulation.reset()),

    scenario(req, res) {
      const { intersectionId, scenario } = req.body || {};
      if (typeof intersectionId !== 'string' || typeof scenario !== 'string') {
        return bad(res, 400, 'intersectionId and scenario must be strings');
      }
      const result = simulation.setScenario(intersectionId, scenario);
      return result.ok ? ok(res, result.status) : bad(res, result.status, result.error);
    },

    tour(req, res) {
      const { intersectionId, enabled } = req.body || {};
      if (typeof intersectionId !== 'string' || typeof enabled !== 'boolean') {
        return bad(res, 400, 'intersectionId must be a string and enabled a boolean');
      }
      const result = simulation.setTour(intersectionId, enabled);
      return result.ok ? ok(res, result.status) : bad(res, result.status, result.error);
    },
  };
}

module.exports = { createSimulationController };
