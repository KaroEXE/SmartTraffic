const { Server } = require('socket.io');

/**
 * Bridges the decision engines to browsers. The socket layer only forwards
 * state; it never decides signals and never asks clients to rebuild their
 * scenes. Every payload carries `intersectionId` (clients decide which
 * intersection to render) and `dataMode`.
 *
 * Live and simulated data travel in separate rooms:
 *
 *   room "live"        live engine events. Every client starts here, so
 *                      clients that know nothing about simulation keep
 *                      working unchanged.
 *   room "simulation"  simulation engine events. A client only joins it by
 *                      sending `subscribe` with { mode: "simulation" }, and
 *                      leaves "live" at the same time.
 *
 * Client -> server
 *   subscribe  { mode: 'live' | 'simulation' }   switch rooms; answered with a fresh `init`
 *
 * Server -> client (same names in both rooms; `dataMode` says which)
 *   init           { dataMode, intersections: Snapshot[], serverTime, simulation? }
 *   trafficUpdate  Snapshot            new observation processed
 *   signalUpdate   Snapshot            phase / plan / mode changed
 *   systemEvent    { id, dataMode, intersectionId, time, category, message, level }
 *   subscribeError { error }
 *
 * Both rooms (each channel has its own network coordinator)
 *   networkDecision  { dataMode, cycle, at, evaluated, intersections, links, corridors }
 *                    one network decision cycle (services/networkCoordinator.js)
 *   init also carries `network: { topology, decision }`
 *
 * Live room only
 *   streamStatus  { available, serverTime, staleAfterSeconds, streams }   camera stream
 *                 configuration / health changed (no URLs; same as GET /api/streams/status)
 *
 * Simulation room only
 *   simulationStatus  { state, scenarios, intersections, ... }   control state changed
 *   simulationReset   { dataMode, intersections: Snapshot[] }    all simulated state was discarded
 */
const MODES = ['live', 'simulation'];
const ENGINE_EVENTS = ['trafficUpdate', 'signalUpdate', 'systemEvent'];

function bindTrafficEvents(io, service, {
  simulation = null, streams = null, network = null,
} = {}) {
  const engines = { live: service, simulation: simulation ? simulation.engine : null };
  const coordinators = { live: network, simulation: simulation ? simulation.coordinator : null };

  const initPayload = (mode) => ({
    dataMode: mode,
    intersections: engines[mode].getAllSnapshots(),
    serverTime: new Date().toISOString(),
    ...(coordinators[mode] ? {
      network: { topology: coordinators[mode].topology.toJSON(), decision: coordinators[mode].latest },
    } : {}),
    ...(mode === 'simulation' ? { simulation: simulation.getStatus() } : {}),
  });

  io.on('connection', (socket) => {
    socket.join('live');
    socket.emit('init', initPayload('live'));

    socket.on('subscribe', (request) => {
      const mode = request && request.mode;
      if (!MODES.includes(mode) || !engines[mode]) {
        socket.emit('subscribeError', { error: `mode must be one of ${MODES.filter((m) => engines[m]).join(', ')}` });
        return;
      }
      for (const room of MODES) if (room !== mode) socket.leave(room);
      socket.join(mode);
      socket.emit('init', initPayload(mode));
    });
  });

  const forward = (engine, room) => {
    for (const event of ENGINE_EVENTS) engine.on(event, (payload) => io.to(room).emit(event, payload));
  };
  forward(service, 'live');
  if (network) network.on('decision', (decision) => io.to('live').emit('networkDecision', decision));
  // Camera health is live infrastructure: never sent to the simulation room.
  if (streams) streams.on('change', (status) => io.to('live').emit('streamStatus', status));

  if (simulation) {
    forward(simulation.engine, 'simulation');
    if (simulation.coordinator) {
      simulation.coordinator.on('decision', (decision) => io.to('simulation').emit('networkDecision', decision));
    }
    simulation.on('status', (status) => io.to('simulation').emit('simulationStatus', status));
    simulation.on('reset', (snapshots) => {
      io.to('simulation').emit('simulationReset', { dataMode: 'simulation', intersections: snapshots });
    });
  }

  return io;
}

function initTrafficSocket(httpServer, service, {
  corsOrigin = '*', simulation = null, streams = null, network = null,
} = {}) {
  const io = new Server(httpServer, { cors: { origin: corsOrigin } });
  return bindTrafficEvents(io, service, { simulation, streams, network });
}

module.exports = { initTrafficSocket, bindTrafficEvents };
