const { validateObservation, toDecisionInput, ID_PATTERN } = require('../utils/validation');
const { trafficStateService } = require('../services/trafficStateService');
const { DATA_MODES, SIMULATED_SOURCES } = require('../models/constants');
const { requireToken } = require('../utils/auth');

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
 * This controller serves LIVE traffic. Only real perception data enters,
 * through POST /api/traffic: when `ingestToken` is set the request must carry
 * it as a Bearer token, and the reserved producer tags "mock" and
 * "simulation" are always rejected (the simulator feeds its own engine
 * directly). The same read handlers also serve /api/simulation.
 *
 * Stream attribution (optional `streams` in the payload): every id must be a
 * registered stream of this intersection and approach (streamRegistry), or
 * the whole observation is rejected with 422 before anything is stored. If
 * the registry is unavailable (no database) the observation is accepted and
 * the unverified attribution is dropped, with a warning.
 */
function createTrafficController(service, {
  startedAt = Date.now(),
  stateService = trafficStateService,
  databaseHealth = null, // () => { status, ... } - historical data store, if configured
  history = null, // trafficHistoryService, if configured (read side only)
  ingestToken = '', // TRAFFIC_INGEST_TOKEN; empty = open (local development)
  streamRegistry = null, // streamRegistryService, if configured
  network = null, // networkCoordinator of this channel, if configured
} = {}) {
  function unknownIntersection(res, id) {
    return res.status(404).json({
      ok: false,
      error: `Unknown intersectionId "${id}"`,
      knownIntersections: service.ids(),
    });
  }

  const controller = {
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
          tokenRequired: Boolean(ingestToken),
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
          error: `source "${observation.source}" is reserved for simulated data and is not accepted`,
          hint: 'Use the dashboard Simulation mode; live ingestion only accepts real perception data',
        });
      }
      if (!service.has(observation.intersectionId)) {
        return unknownIntersection(res, observation.intersectionId);
      }

      const warnings = [...result.warnings];
      if (observation.streams) {
        const check = streamRegistry
          ? streamRegistry.verifyAttribution(observation.intersectionId, observation.streams)
          : { ok: true, verified: false, errors: [], warnings: ['no stream registry - stream attribution was not verified and is not recorded'] };
        if (!check.ok) {
          return res.status(422).json({ ok: false, error: 'Stream attribution rejected', details: check.errors });
        }
        warnings.push(...check.warnings);
        // Unverified attribution is never stored.
        if (!check.verified) observation.streams = null;
      }

      const stored = stateService.setTrafficState(observation);
      if (!stored.stored) {
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
      if (warnings.length) body.warnings = warnings;
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

    // Decision-engine snapshots (signals, phase, events). Used by the dashboard.
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

    // Latest observation: from memory, or after a restart the newest stored
    // record (never replayed into the decision engine).
    async getObservation(req, res) {
      const { intersectionId } = req.params;
      if (!service.has(intersectionId)) return unknownIntersection(res, intersectionId);
      const observation = stateService.getTrafficState(intersectionId);
      if (observation) {
        return res.json({
          ok: true, from: 'memory', observation, ageSeconds: stateService.getAgeSeconds(intersectionId),
        });
      }
      const record = history ? await history.findLatestTrafficRecord(intersectionId) : null;
      if (record) {
        const at = new Date(record.timestamp).getTime();
        return res.json({
          ok: true,
          from: 'database',
          observation: {
            intersectionId: record.intersectionId,
            timestamp: new Date(record.timestamp).toISOString(),
            receivedAt: record.receivedAt ? new Date(record.receivedAt).toISOString() : null,
            source: record.source || null,
            traffic: record.traffic,
            pedestrians: record.pedestrians,
            emergency: record.emergency,
            streams: record.streams || null,
          },
          ageSeconds: Math.max(0, Math.round((Date.now() - at) / 100) / 10),
        });
      }
      return res.status(404).json({
        ok: false,
        intersectionId,
        received: false,
        error: `No traffic data received yet for "${intersectionId}"`,
      });
    },

    getIntersections(req, res) {
      res.json({ ok: true, intersections: service.listIntersections() });
    },

    // Road network topology and the latest network decision cycle.
    getNetwork(req, res) {
      if (!network) return res.status(503).json({ ok: false, error: 'Network coordination is not configured' });
      return res.json({
        ok: true,
        enabled: network.enabled,
        topology: network.topology.toJSON(),
        decision: network.latest,
        recent: network.history,
      });
    },

    // Historical data. Always one mode at a time (default "live").
    getHistoryTraffic: historyHandler('findTrafficRecords'),
    getHistorySignals: historyHandler('findSignalEvents'),
  };
  // Token check first, so an unauthorized body is never validated or stored.
  controller.postTrafficHandlers = [requireToken(ingestToken, { openWhenUnset: true }), controller.postTraffic];
  return controller;

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
