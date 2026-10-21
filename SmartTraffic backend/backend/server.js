const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');

const config = require('./config');
const intersections = require('./config/intersections');
const simulationIntersections = require('./config/simulationIntersections');
const { connectDatabase, disconnectDatabase, getDatabaseStatus, isDatabaseConnected } = require('./config/database');
const { createTrafficDecisionService } = require('./services/trafficDecisionService');
const { trafficStateService } = require('./services/trafficStateService');
const { createTrafficHistoryService } = require('./services/trafficHistoryService');
const { createSimulationService } = require('./services/simulationService');
const { createStreamRegistryService } = require('./services/streamRegistryService');
const { buildTopology } = require('./services/networkTopology');
const { createNetworkCoordinator } = require('./services/networkCoordinator');
const { createTrafficController } = require('./controllers/trafficController');
const { createSimulationController } = require('./controllers/simulationController');
const { createStreamController } = require('./controllers/streamController');
const { createTrafficRoutes, createSimulationRoutes, createStreamRoutes } = require('./routes/trafficRoutes');
const { createDocsRoutes } = require('./routes/docsRoutes');
const { initTrafficSocket } = require('./socket/trafficSocket');

const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

function packageDir(name) {
  return path.join(__dirname, 'node_modules', name);
}

const app = express();
const server = http.createServer(app);

// LIVE channel: AI observations (POST /api/traffic) -> trafficStateService
// -> decision engine `service` -> Socket.IO room "live". Only real data.
const service = createTrafficDecisionService({ intersections, config });

// LIVE network coordination: network-aware scores for every intersection
// with fresh AI data, and emergency corridors from camera detections
// (route assumed straight ahead - there is no GPS feed). Intersections
// without data keep their own fixed-time plan.
const network = createNetworkCoordinator({
  engine: service,
  topology: buildTopology(intersections, config.network),
  config,
  dataMode: 'live',
  enabled: config.network.ENABLED,
  cameraCorridors: config.network.CORRIDOR_FROM_CAMERA,
});

// SIMULATION channel (the dashboard's Simulation tab): its own generator,
// engine, store and intersection list, idle until started from the
// dashboard. Shares nothing with the live objects above, and nothing it
// produces can reach them.
const simulation = createSimulationService({ intersections: simulationIntersections, config });

// Historical data (MongoDB). Signal control does not depend on it. One
// instance per channel; each stamps its own dataMode on what it writes.
const sampleIntervalMs = config.historySampleSeconds * 1000;
const history = config.mongodbUri
  ? createTrafficHistoryService({
    stateService: trafficStateService, decisionService: service, dataMode: 'live', sampleIntervalMs,
  }).start()
  : null;
const simulationHistory = config.mongodbUri
  ? createTrafficHistoryService({
    stateService: simulation.stateService, decisionService: simulation.engine, dataMode: 'simulation', sampleIntervalMs,
  }).start()
  : null;
if (simulationHistory) simulation.on('reset', () => simulationHistory.resetTracking());
connectDatabase(config.mongodbUri);

// Camera stream registry (MongoDB). Live channel only. Reloaded every 30 s
// while the database is connected, so the dashboard's camera status and
// ingestion's attribution check use the current configuration.
const streams = createStreamRegistryService();
const refreshStreams = () => {
  if (isDatabaseConnected()) streams.refresh().catch(() => {});
};
setInterval(refreshStreams, 30_000).unref();
setTimeout(refreshStreams, 2_000).unref();

const controller = createTrafficController(service, {
  history,
  databaseHealth: () => ({
    status: getDatabaseStatus(),
    ...(history ? history.stats() : {}),
    ...(simulationHistory ? { simulation: simulationHistory.stats() } : {}),
  }),
  ingestToken: config.trafficIngestToken,
  streamRegistry: streams,
  network,
});
const simulationReadController = createTrafficController(simulation.engine, {
  stateService: simulation.stateService, network: simulation.coordinator,
});
if (!config.trafficIngestToken) {
  console.warn('[server] TRAFFIC_INGEST_TOKEN is not set: anyone who can reach POST /api/traffic can post traffic data. Set it (and the same value on the AI service) in production.');
}

app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: '100kb' }));

// Settings the browser needs. Only public values - never secrets.
app.get('/api/client-config', (req, res) => {
  res.json({ ok: true, aiStreamUrl: config.aiStreamUrl || null });
});

app.use('/api', createDocsRoutes());

app.use('/api/streams', createStreamRoutes(
  createStreamController(streams, {
    hasIntersection: (id) => service.has(id),
    secrets: [config.trafficIngestToken, config.streamAdminToken],
  }),
  { ingestToken: config.trafficIngestToken, adminToken: config.streamAdminToken },
));
app.use('/api/simulation', createSimulationRoutes(simulationReadController, createSimulationController(simulation)));
app.use('/api', createTrafficRoutes(controller));
app.use('/api', (req, res) => res.status(404).json({ ok: false, error: `No route ${req.method} ${req.originalUrl}` }));

// Frontend + its two rendering libraries, served locally so the 3D view
// works without a CDN (map tiles still come from openstreetmap.org).
app.use('/vendor/three', express.static(packageDir('three')));
app.use('/vendor/leaflet', express.static(path.join(packageDir('leaflet'), 'dist')));
app.use(express.static(FRONTEND_DIR));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: 'Malformed JSON body' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: 'Payload too large' });
  }
  console.error('[server] unhandled error:', err);
  return res.status(500).json({ ok: false, error: 'Internal server error' });
});

initTrafficSocket(server, service, {
  corsOrigin: config.corsOrigin, simulation, streams, network,
});
service.start(250);
network.start();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] Port ${config.port} is already in use. Set PORT in backend/.env or stop the other process.`);
    process.exit(1);
  }
  throw err;
});

server.listen(config.port, () => {
  console.log('');
  console.log('  Smart Traffic AI - control backend');
  console.log(`  Swagger     http://localhost:${config.port}/api/docs/`);
  console.log(`  Dashboard   http://localhost:${config.port}`);
  console.log(`  API         http://localhost:${config.port}/api/health`);
  console.log(`  Ingest      POST http://localhost:${config.port}/api/traffic`);
  console.log(`  Intersections: ${service.ids().join(', ')}`);
  console.log('');
});

async function shutdown() {
  service.stop();
  network.stop();
  simulation.pause();
  if (history) history.stop();
  if (simulationHistory) simulationHistory.stop();
  server.close();
  setTimeout(() => process.exit(0), 3000).unref();
  // Finish in-flight history writes; open Socket.IO clients do not delay this.
  if (history) await history.flush();
  if (simulationHistory) await simulationHistory.flush();
  await disconnectDatabase().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
