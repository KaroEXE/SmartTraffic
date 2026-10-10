const intersections = require('../config/intersections');
const { DIRECTIONS, LIMITS, ID_PATTERN } = require('../utils/validation');
const { MODES, PHASES, VEHICLE_SIGNALS, PEDESTRIAN_SIGNALS } = require('../models/constants');
const { SCENARIOS } = require('../services/simulationService');

const ref = (name) => ({ $ref: '#/components/schemas/' + name });
const object = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const array = (items) => ({ type: 'array', items });
const str = { type: 'string' };
const num = { type: 'number' };
const bool = { type: 'boolean' };
const date = { type: 'string', format: 'date-time' };
const nullableDate = { ...date, nullable: true };
const direction = { type: 'string', enum: DIRECTIONS, nullable: true };
const perDirection = (schema) => object(Object.fromEntries(DIRECTIONS.map((d) => [d, schema])), DIRECTIONS);
const id = { type: 'string', pattern: ID_PATTERN.source, example: intersections[0].id };
const response = (description, schema) => ({ description, content: { 'application/json': { schema } } });
const error = (description) => response(description, ref('Error'));
const ok = (properties) => object({ ok: { type: 'boolean', enum: [true] }, ...properties }, ['ok']);
const pathId = { name: 'intersectionId', in: 'path', required: true, description: 'Configured intersection ID. See GET /api/intersections.', schema: id };
const body = (schema, examples) => ({ required: true, content: { 'application/json': { schema, ...(examples ? { examples } : {}) } } });

const approachProperties = {
  vehicles: { type: 'number', minimum: 0, maximum: LIMITS.vehicles, description: 'Vehicles visible on the approach.' },
  queueLength: { type: 'number', minimum: 0, maximum: LIMITS.queueLength, description: 'Vehicles stopped in the queue.' },
  waitingTime: { type: 'number', minimum: 0, maximum: LIMITS.waitingTime, description: 'Average wait in seconds; normalized to one decimal place.' },
  classes: {
    type: 'object', nullable: true, additionalProperties: { type: 'integer', minimum: 0, maximum: LIMITS.vehicles },
    description: 'Optional. Vehicles per detected object class, e.g. {"car": 5, "bus": 1}. Lowercase names, at most 16.',
  },
  confidence: { type: 'number', minimum: 0, maximum: 1, nullable: true, description: 'Optional mean detection confidence.' },
};
const trafficExample = {
  intersectionId: intersections[0].id,
  source: 'camera-north',
  traffic: {
    north: { vehicles: 12, queueLength: 8, waitingTime: 15 },
    south: { vehicles: 4, queueLength: 3, waitingTime: 7 },
    east: { vehicles: 20, queueLength: 15, waitingTime: 22 },
    west: { vehicles: 5, queueLength: 4, waitingTime: 10 },
  },
  pedestrians: { north: false, south: true, east: false, west: false },
  emergency: { detected: false, type: null, direction: null, confidence: 0 },
};

const schemas = {
  Error: object({
    ok: { type: 'boolean', enum: [false] }, error: str, details: array(str),
    knownIntersections: array(str), hint: str, intersectionId: id,
    storedTimestamp: nullableDate, received: bool,
  }, ['ok', 'error']),
  ApproachInput: {
    ...object({
      ...approachProperties,
      waiting: { ...approachProperties.waitingTime, description: 'Legacy alias for waitingTime. waitingTime takes precedence when both are sent.' },
    }, ['vehicles', 'queueLength']),
    anyOf: [{ required: ['waitingTime'] }, { required: ['waiting'] }],
  },
  ApproachObservation: object(approachProperties, ['vehicles', 'queueLength', 'waitingTime']),
  TrafficInput: {
    ...perDirection({ allOf: [ref('ApproachInput')], nullable: true }),
    additionalProperties: false,
    description: 'All four approaches. null = the producer has no source for that approach (e.g. its camera video is missing); at least one must be present.',
  },
  TrafficObservation: perDirection({ allOf: [ref('ApproachObservation')], nullable: true }),
  PedestriansInput: {
    ...object(Object.fromEntries(DIRECTIONS.map((d) => [d, { type: 'boolean', default: false }]))),
    additionalProperties: false, nullable: true,
  },
  EmergencyInput: {
    ...object({
      detected: bool,
      type: { type: 'string', nullable: true, description: 'Required when detected=true: ambulance, police, fire_truck, or emergency (service unknown). Aliases police_car, firetruck, fire, fire_engine, emergency_vehicle accepted; case, spaces and hyphens normalized.' },
      direction: { ...direction, description: 'Approach the vehicle is coming from. Omitted/null direction is stored with a warning and gets no signal priority.' },
      confidence: { type: 'number', minimum: 0, maximum: 1, nullable: true },
    }, ['detected']),
    nullable: true,
    description: 'Optional. If detected=true, type and confidence are required. Below-threshold detections are stored but do not trigger preemption. If false, type is ignored and the detection is cleared.',
    oneOf: [
      { properties: { detected: { enum: [false] } } },
      { required: ['type', 'confidence'], properties: { detected: { enum: [true] }, type: { type: 'string', nullable: false }, confidence: { type: 'number', minimum: 0, maximum: 1, nullable: false } } },
    ],
  },
  TrafficPayload: object({
    intersectionId: id,
    timestamp: { ...nullableDate, description: 'Optional capture time. Older updates may return 409; >5 minutes in the future adds a warning. Omit for server receive time.' },
    source: { type: 'string', maxLength: 32, nullable: true, description: 'Producer tag; trimmed and lowercased. mock and simulation are reserved and rejected with 422.' },
    traffic: ref('TrafficInput'), pedestrians: ref('PedestriansInput'), emergency: ref('EmergencyInput'),
  }, ['intersectionId', 'traffic']),
  Observation: object({
    intersectionId: id, timestamp: nullableDate, receivedAt: date, sequence: { type: 'integer' },
    source: { type: 'string', nullable: true }, traffic: ref('TrafficObservation'),
    pedestrians: perDirection(bool), emergency: ref('EmergencyInput'),
    detectors: object({ pedestrians: bool, emergency: bool }),
  }),
  Decision: object({
    mode: { type: 'string', enum: MODES }, phase: { type: 'string', enum: PHASES },
    greenDirection: direction, signals: perDirection({ type: 'string', enum: VEHICLE_SIGNALS }),
    remaining: { type: 'number', nullable: true, description: 'Seconds remaining; null while held for an emergency.' }, reason: str,
  }),
  Snapshot: {
    allOf: [ref('Decision'), object({
      dataMode: { type: 'string', enum: ['live', 'simulation'] }, intersectionId: id, name: str,
      lat: num, lng: num, nextDirection: direction, nextPhase: { type: 'string', nullable: true },
      pedestrianSignals: perDirection({ type: 'string', enum: PEDESTRIAN_SIGNALS }),
      phaseDuration: num, elapsed: num, holding: { type: 'string', nullable: true },
      signal: { type: 'object', description: 'Compact decision summary including remainingTime, greenTime and holding.' },
      traffic: perDirection(object({
        vehicles: { type: 'number', nullable: true }, queueLength: { type: 'number', nullable: true },
        waiting: { type: 'number', nullable: true },
        available: { type: 'boolean', description: 'false = no data for this approach (not received yet, or its camera is unavailable); counts are then null.' },
        classes: { type: 'object', nullable: true }, confidence: { type: 'number', nullable: true },
      })),
      pedestrians: perDirection(bool), pedestrianRequests: perDirection(bool),
      detectors: object({ pedestrians: bool, emergency: bool }, []),
      scores: perDirection(num), redSeconds: perDirection(num),
      emergency: { type: 'object', description: 'Active emergency, observed detection, and candidate details.' },
      aiStatus: { type: 'string', enum: ['WAITING', 'CONNECTED', 'STALE'] },
      lastUpdate: nullableDate, events: array({ type: 'object' }),
    })],
  },
  Intersection: object({
    dataMode: { type: 'string', enum: ['live', 'simulation'] }, id, name: str, lat: num, lng: num,
    mode: { type: 'string', enum: MODES }, phase: { type: 'string', enum: PHASES },
    greenDirection: direction, aiStatus: { type: 'string', enum: ['WAITING', 'CONNECTED', 'STALE'] },
    emergency: { type: 'object', nullable: true },
  }),
  IngestionResponse: ok({
    intersectionId: id, stored: object({ sequence: { type: 'integer' }, receivedAt: date, timestamp: nullableDate }),
    warnings: array(str), decision: ref('Decision'), scores: perDirection(num),
  }),
  SimulationStatus: ok({
    dataMode: { type: 'string', enum: ['simulation'] }, state: { type: 'string', enum: ['stopped', 'running', 'paused', 'error'] },
    error: { type: 'string', nullable: true }, scenarios: array(object({ id: str, label: str })),
    intersections: { type: 'object', additionalProperties: object({
      scenario: str, tour: bool, emergency: { type: 'object', nullable: true }, pedestrians: perDirection(bool),
    }) },
  }),
  TrafficRecord: object({
    _id: str, intersectionId: id, dataMode: { type: 'string', enum: ['live', 'simulation'] },
    timestamp: date, receivedAt: date, source: { type: 'string', nullable: true },
    traffic: ref('TrafficObservation'), pedestrians: perDirection(bool), emergency: ref('EmergencyInput'),
    signal: object({
      mode: { type: 'string', enum: MODES }, phase: { type: 'string', enum: PHASES },
      signals: perDirection({ type: 'string', enum: VEHICLE_SIGNALS }),
      pedestrianSignals: perDirection({ type: 'string', enum: PEDESTRIAN_SIGNALS }),
    }),
  }),
  SignalEvent: object({
    _id: str, intersectionId: id, dataMode: { type: 'string', enum: ['live', 'simulation'] },
    timestamp: date, mode: { type: 'string', enum: MODES }, phase: { type: 'string', enum: PHASES },
    previousPhase: { type: 'string', enum: PHASES }, signals: perDirection({ type: 'string', enum: VEHICLE_SIGNALS }),
    pedestrianSignals: perDirection({ type: 'string', enum: PEDESTRIAN_SIGNALS }),
    changes: array(object({ direction: { type: 'string', enum: DIRECTIONS }, kind: { type: 'string', enum: ['vehicle', 'pedestrian'] }, from: str, to: str })),
    reason: str, plannedDuration: num, previousPhaseDuration: num,
  }),
};

const paths = {};
function operation(path, method, tag, operationId, summary, schema, extras = {}) {
  paths[path] ||= {};
  paths[path][method] = {
    tags: [tag], operationId, summary,
    ...extras,
    responses: { 200: response('Success', schema), ...(extras.responses || {}) },
  };
}
operation('/api/health', 'get', 'System', 'getHealth', 'Backend and database health', ok({
  status: str, uptimeSeconds: num, serverTime: date, intersections: { type: 'integer' },
  aiFeeds: object({ connected: { type: 'integer' }, total: { type: 'integer' } }),
  ingestion: object({ intersectionsWithData: { type: 'integer' }, tokenRequired: bool }), database: { type: 'object' },
}));
operation('/api/client-config', 'get', 'System', 'getClientConfig', 'Public browser configuration', ok({ aiStreamUrl: { type: 'string', nullable: true } }));
operation('/api/traffic', 'post', 'Live traffic', 'postTraffic', 'Send a perception observation to the live decision engine', ref('IngestionResponse'), {
  description: 'Post about once per second per intersection, using one producer per intersection. All four traffic approaches are required (null for an approach without a source). Directions indicate where vehicles come from. Body limit: 100 KB. When the backend sets TRAFFIC_INGEST_TOKEN, send it as "Authorization: Bearer <token>". Data tagged as simulated is rejected.',
  requestBody: body(ref('TrafficPayload'), {
    normal: { summary: 'Traffic with a pedestrian request', value: trafficExample },
    ambulance: { summary: 'Confirmed ambulance approaching from north', value: { ...trafficExample, emergency: { detected: true, type: 'ambulance', direction: 'north', confidence: 0.94 } } },
  }),
  responses: {
    400: error('Invalid payload or malformed JSON'), 401: error('Missing or invalid ingest token'), 404: error('Unknown intersection'),
    409: error('Capture timestamp older than latest stored observation'), 413: error('Body exceeds 100 KB'),
    415: error('Content-Type must be application/json'), 422: error('Reserved simulated source'),
    503: error('Traffic state store is full'),
  },
});
for (const [prefix, tag, suffix] of [['/api', 'Live traffic', 'Live'], ['/api/simulation', 'Simulation', 'Simulation']]) {
  operation(prefix + '/intersections', 'get', tag, 'get' + suffix + 'Intersections', 'List intersections and summary state', ok({ intersections: array(ref('Intersection')) }));
  operation(prefix + '/traffic/state', 'get', tag, 'get' + suffix + 'States', 'Read all decision snapshots', ok({ intersections: array(ref('Snapshot')) }));
  operation(prefix + '/traffic/state/{intersectionId}', 'get', tag, 'get' + suffix + 'State', 'Read one snapshot and recent events', ok({ state: ref('Snapshot') }), {
    parameters: [pathId], responses: { 404: error('Unknown intersection') },
  });
}
operation('/api/traffic/observations', 'get', 'Live traffic', 'getObservations', 'Read all latest normalized perception observations', ok({ observations: array(ref('Observation')) }));
operation('/api/traffic/observations/{intersectionId}', 'get', 'Live traffic', 'getObservation', 'Read latest observation for one intersection', ok({ observation: ref('Observation'), ageSeconds: num }), {
  parameters: [pathId], responses: { 404: error('Unknown intersection or no observation received yet') },
});
const historyParameters = [
  { name: 'mode', in: 'query', schema: { type: 'string', enum: ['live', 'simulation'], default: 'live' } },
  { name: 'intersectionId', in: 'query', schema: id },
  ...['from', 'to'].map((name) => ({ name, in: 'query', description: 'Inclusive capture timestamp bound.', schema: date })),
  { name: 'limit', in: 'query', description: 'Positive integer; backend caps results at 1000.', schema: { type: 'integer', minimum: 1, default: 100 } },
];
for (const [kind, schema] of [['traffic', 'TrafficRecord'], ['signals', 'SignalEvent']]) {
  operation('/api/history/' + kind, 'get', 'History', 'getHistory' + schema, 'Query stored ' + kind + ' history', ok({
    mode: { type: 'string', enum: ['live', 'simulation'] }, count: { type: 'integer' }, records: array(ref(schema)),
  }), {
    description: 'Newest first; live and simulation records are filtered separately. Requires a configured, connected MongoDB database.',
    parameters: historyParameters, responses: { 400: error('Invalid query'), 503: error('Database not configured or disconnected'), 500: error('History query failed') },
  });
}
for (const [method, action, summary] of [
  ['get', 'status', 'Read simulator status and available scenarios'],
  ['post', 'start', 'Start or resume the simulator'],
  ['post', 'pause', 'Pause the simulator and its clock'],
  ['post', 'reset', 'Discard simulated state and stop the simulator'],
]) {
  operation('/api/simulation/' + action, method, 'Simulation', action + 'Simulation', summary, ref('SimulationStatus'), {
    description: 'Uses an isolated simulation channel; live traffic is unaffected.',
  });
}
operation('/api/simulation/scenario', 'post', 'Simulation', 'setSimulationScenario', 'Apply a scenario to a simulated intersection', ref('SimulationStatus'), {
  requestBody: body(object({ intersectionId: id, scenario: { type: 'string', enum: SCENARIOS.map((s) => s.id) } }, ['intersectionId', 'scenario']), {
    heavyEast: { value: { intersectionId: intersections[0].id, scenario: 'heavy-east' } },
  }),
  responses: { 400: error('Invalid body or scenario'), 404: error('Unknown intersection') },
});
operation('/api/simulation/tour', 'post', 'Simulation', 'setSimulationTour', 'Enable or disable the automatic scenario tour', ref('SimulationStatus'), {
  requestBody: body(object({ intersectionId: id, enabled: bool }, ['intersectionId', 'enabled']), {
    enable: { value: { intersectionId: intersections[0].id, enabled: true } },
  }),
  responses: { 400: error('Invalid body'), 404: error('Unknown intersection') },
});

module.exports = {
  openapi: '3.0.3',
  info: {
    title: 'Smart Traffic AI API', version: require('../package.json').version,
    description: 'REST API for the Python/YOLO perception integration, live dashboard, historical records and isolated simulator. POST /api/traffic requires the ingest token when TRAFFIC_INGEST_TOKEN is set. Try it out sends requests to this backend. Socket.IO events are documented separately in the project README.',
  },
  servers: [{ url: '/', description: 'Current backend host' }],
  tags: [
    { name: 'Live traffic', description: 'Real perception ingestion, observations and signal decisions.' },
    { name: 'System', description: 'Health and public configuration.' },
    { name: 'History', description: 'MongoDB observations and signal changes, filtered by data mode.' },
    { name: 'Simulation', description: 'Isolated simulated traffic and scenario controls.' },
  ],
  paths, components: { schemas },
};
