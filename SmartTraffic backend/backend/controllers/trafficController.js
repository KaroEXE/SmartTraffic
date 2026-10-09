const { validateObservation, toDecisionInput, ID_PATTERN } = require('../utils/validation');
const { trafficStateService } = require('../services/trafficStateService');
const { DATA_MODES, SIMULATED_SOURCES } = require('../models/constants');

/** Validates ?mode&intersectionId&from&to&limit for the history endpoints. */
function parseHistoryQuery(query) {
  const mode = query.mode === undefined ? 'live' : query.mode;
  if (!DATA_MODES.includes(mode)) return { error: `mode must be one of ${DATA_MODES.join(', ')}` };

  const options = { mode };
  const { intersectionId, from, to, limit } = query;
  if (intersectionId !== undefined) {
    if (typeof intersectionId !== 'string' || !ID_PATTERN.test(intersectionId)) return { error: 'intersectionId is not valid' };
    options.intersectionId = intersectionId;
  }
  for (const [name, value] of [['from', from], ['to', to]]) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return { error: `${name} must be an ISO-8601 date` };
    options[name] = new Date(value).toISOString();
  }
  if (limit !== undefined) {
    const n = Number(limit);
    if (typeof limit !== 'string' || !Number.isInteger(n) || n < 1) return { error: 'limit must be a positive integer' };
    options.limit = n;
  }
  return { options };
}

/**
 * HTTP layer for traffic data.
 *
 *   POST /api/traffic  request -> validate -> store latest observation
 *                      (trafficStateService) -> hand to decision engine
 *
 * `service` is the decision engine (only its public API is used);
 * `stateService` holds the latest validated observation per intersection.
 *
 * This controller serves LIVE traffic. Simulated data never enters through
 * POST /api/traffic: the reserved sources "mock" and "simulation" are
 * rejected, and the simulator feeds its own engine directly.
 */
function createTrafficController(service, {
  startedAt = Date.now(),
  stateService = trafficStateService,
  databaseHealth = null, // () => { status, ... } - historical data store, if configured
  history = null, // trafficHistoryService, if configured (read side only)
} = {}) {
  function unknownIntersection(res, id) {
    return res.status(404).json({
      ok: false,
      error: `Unknown intersectionId "${id}"`,
      knownIntersections: service.ids(),
    });
  }

  return {
    health(req, res) {
      const intersections = service.listIntersections();
      const connected = intersections.filter((i) => i.aiStatus === 'CONNECTED').length;
      res.json({
        ok: true,
        status: 'online',
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        serverTime: new Date().toISOString(),
        intersections: intersections.length,
        aiFeeds: { connected, total: intersections.length },
        ingestion: {
          intersectionsWithData: stateService.getAllTrafficStates().length,
        },
        ...(databaseHealth ? { database: databaseHealth() } : {}),
      });
    },

    postTraffic(req, res) {
      if (!req.is('application/json')) {
        return res.status(415).json({ ok: false, error: 'Content-Type must be application/json' });
      }

      const result = validateObservation(req.body);
      if (!result.ok) {
        return res.status(400).json({ ok: false, error: 'Invalid traffic payload', details: result.errors });
      }
      const observation = result.value;
      if (SIMULATED_SOURCES.includes(observation.source)) {
        return res.status(422).json({
          ok: false,
          error: `source "${observation.source}" is reserved for simulated data and is not accepted on live ingestion`,
          hint: 'Use the dashboard Simulation mode; live ingestion only accepts real perception data',
        });
      }
      if (!service.has(observation.intersectionId)) {
        return unknownIntersection(res, observation.intersectionId);
      }

      const stored = stateService.setTrafficState(observation);
      if (!stored.stored) {
        if (stored.reason === 'live-feed-active') {
          return res.status(202).json({
            ok: true,
            ignored: true,
            intersectionId: observation.intersectionId,
            reason: 'A live perception feed is active for this intersection; mock data is ignored',
          });
        }
        if (stored.reason === 'stale') {
          return res.status(409).json({
            ok: false,
            error: 'Stale update: timestamp is older than the latest stored observation',
            intersectionId: observation.intersectionId,
            storedTimestamp: stored.state.timestamp,
          });
        }
        return res.status(503).json({ ok: false, error: 'Traffic state store is full' });
      }

      // Hand the validated observation to the decision engine.
      const snap = service.ingest(toDecisionInput(observation));

      const body = {
        ok: true,
        intersectionId: observation.intersectionId,
        stored: {
          sequence: stored.state.sequence,
          receivedAt: stored.state.receivedAt,
          timestamp: stored.state.timestamp,
        },
      };
      if (result.warnings.length) body.warnings = result.warnings;
      if (snap && snap.ignored) {
        return res.status(202).json({ ...body, ignored: true, reason: 'Decision engine ignored mock data (live feed active)' });
      }
      if (snap) {
        body.decision = {
          mode: snap.mode,
          phase: snap.phase,
          greenDirection: snap.greenDirection,
          signals: snap.signals,
          remaining: snap.remaining,
          reason: snap.reason,
        };
        body.scores = snap.scores;
      }
      return res.json(body);
    },

    // Decision-engine snapshots (signals, phase, events). Used by the
    // dashboard and the mock client.
    getAllStates(req, res) {
      res.json({ ok: true, intersections: service.getAllSnapshots() });
    },

    getState(req, res) {
      const { intersectionId } = req.params;
      const snap = service.getSnapshot(intersectionId, { includeEvents: true });
      if (!snap) return unknownIntersection(res, intersectionId);
      return res.json({ ok: true, state: snap });
    },

    // Latest stored perception observations (exactly what the AI reported).
    getAllObservations(req, res) {
      res.json({ ok: true, observations: stateService.getAllTrafficStates() });
    },

    getObservation(req, res) {
      const { intersectionId } = req.params;
      if (!service.has(intersectionId)) return unknownIntersection(res, intersectionId);
      const observation = stateService.getTrafficState(intersectionId);
      if (!observation) {
        return res.status(404).json({
          ok: false,
          intersectionId,
          received: false,
          error: `No traffic data received yet for "${intersectionId}"`,
        });
      }
      return res.json({ ok: true, observation, ageSeconds: stateService.getAgeSeconds(intersectionId) });
    },

    getIntersections(req, res) {
      res.json({ ok: true, intersections: service.listIntersections() });
    },

    // Historical data. Always one mode at a time (default "live").
    getHistoryTraffic: historyHandler('findTrafficRecords'),
    getHistorySignals: historyHandler('findSignalEvents'),
  };

  function historyHandler(method) {
    return async (req, res) => {
      if (!history) {
        return res.status(503).json({ ok: false, error: 'Historical data store is not configured (MONGODB_URI is not set)' });
      }
      const parsed = parseHistoryQuery(req.query);
      if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });
      try {
        const records = await history[method](parsed.options);
        return res.json({ ok: true, mode: parsed.options.mode, count: records.length, records });
      } catch (err) {
        if (err && err.code === 'DB_UNAVAILABLE') {
          return res.status(503).json({ ok: false, error: 'Database is not connected' });
        }
        console.error(`[history] query failed: ${err && err.message}`);
        return res.status(500).json({ ok: false, error: 'History query failed' });
      }
    };
  }
}

module.exports = { createTrafficController };
