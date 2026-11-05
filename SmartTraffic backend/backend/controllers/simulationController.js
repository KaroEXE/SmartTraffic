const { runBenchmarkInWorker } = require('../services/simulationBenchmark');

/**
 * HTTP controls for the simulator (/api/simulation/*). They only change the
 * simulation; nothing here can reach live state.
 *
 *   POST /benchmark  { scenario?, durationSeconds?, warmupSeconds?, seed?, intersectionIds? }
 *                    fixed-time vs adaptive control on identical simulated
 *                    demand (services/simulationBenchmark.js). Independent of
 *                    the running simulation: it uses its own engines, in a
 *                    worker thread. One run at a time (409 while busy).
 *   GET  /benchmark  { benchmark: latest result | null }
 */
function createSimulationController(simulation, { runBenchmark = runBenchmarkInWorker } = {}) {
  let latestBenchmark = null;
  let running = false;
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

    async benchmark(req, res) {
      if (running) return bad(res, 409, 'A benchmark is already running');
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      running = true;
      let run;
      try {
        run = await runBenchmark({
        intersections: simulation.intersections,
        config: simulation.engine.config,
        scenario: body.scenario,
        durationSeconds: body.durationSeconds,
        warmupSeconds: body.warmupSeconds,
        sampleEverySeconds: body.sampleEverySeconds,
        seed: body.seed,
        profile: body.profile,
        ambulance: body.ambulance,
        intersectionIds: body.intersectionIds,
      });
      } catch (err) {
        console.error(`[simulation] benchmark failed: ${err && err.message}`);
        return bad(res, 500, 'Benchmark failed');
      } finally {
        running = false;
      }
      if (!run.ok) return res.status(400).json({ ok: false, error: 'Invalid benchmark request', details: run.errors });
      latestBenchmark = run.result;
      return res.json({ ok: true, benchmark: run.result });
    },

    // null until the first run: "nothing measured yet" is not an error.
    latestBenchmark(req, res) {
      return res.json({ ok: true, benchmark: latestBenchmark });
    },

    network(req, res) {
      const { enabled } = req.body || {};
      if (typeof enabled !== 'boolean') return bad(res, 400, 'enabled must be a boolean');
      return ok(res, simulation.setNetworkOptimization(enabled).status);
    },

    dispatchAmbulance(req, res) {
      const result = simulation.dispatchAmbulance(req.body || {});
      return result.ok ? res.json({ ok: true, vehicleId: result.vehicleId, ...result.status }) : bad(res, result.status, result.error);
    },

    rerouteAmbulance(req, res) {
      const result = simulation.rerouteAmbulance(req.params.id, (req.body || {}).route);
      return result.ok ? ok(res, result.status) : bad(res, result.status, result.error);
    },

    cancelAmbulance(req, res) {
      const result = simulation.cancelAmbulance(req.params.id);
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
