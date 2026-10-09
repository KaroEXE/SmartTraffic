const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { initTrafficSocket } = require('./trafficSocket');
const { createTrafficDecisionService } = require('../services/trafficDecisionService');
const { createSimulationService } = require('../services/simulationService');
const { toDecisionInput, validateObservation } = require('../utils/validation');

// Real Socket.IO server; the client speaks the Engine.IO v4 / Socket.IO v5
// wire protocol over Node's built-in WebSocket (no extra dependency).
//
// "Did NOT receive" is proven with a barrier: the client re-subscribes and
// waits for the `init` reply. Socket.IO delivers a socket's packets in order,
// so anything emitted to it before the barrier has arrived by then.

const config = {
  weights: { vehicles: 2, waiting: 3, queueLength: 2 },
  timing: {
    MIN_GREEN_TIME: 10, MAX_GREEN_TIME: 45, YELLOW_TIME: 3, ALL_RED_TIME: 1, SECONDS_PER_QUEUED_VEHICLE: 2,
    MAX_RED_TIME: 90, MIN_PEDESTRIAN_CROSSING_TIME: 10, PEDESTRIAN_CLEARANCE_TIME: 3, PEDESTRIAN_MAX_WAIT: 15,
    PEDESTRIAN_COOLDOWN: 20, EMERGENCY_MAX_HOLD_TIME: 90, PERCEPTION_HOLD_TIME: 3, DATA_TIMEOUT: 10, FALLBACK_GREEN_TIME: 20,
  },
  EMERGENCY_CONFIDENCE_THRESHOLD: 0.8,
};
const INTERSECTIONS = [{ id: 'main', name: 'Main', lat: 0, lng: 0 }];

const liveObservation = () => toDecisionInput(validateObservation({
  intersectionId: 'main',
  traffic: {
    north: { vehicles: 3, queueLength: 2, waitingTime: 5 },
    south: { vehicles: 2, queueLength: 1, waitingTime: 4 },
    east: { vehicles: 9, queueLength: 6, waitingTime: 8 },
    west: { vehicles: 1, queueLength: 0, waitingTime: 2 },
  },
}).value);

async function startServer() {
  const live = createTrafficDecisionService({ intersections: INTERSECTIONS, config });
  const simulation = createSimulationService({
    intersections: INTERSECTIONS, config, generatorTickMs: 1e9, engineTickMs: 1e9,
  });
  const server = http.createServer();
  const io = initTrafficSocket(server, live, { simulation });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    live,
    simulation,
    port: server.address().port,
    async close() {
      simulation.reset();
      io.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
    const client = {
      events: [],
      waiters: [],
      emit(name, data) { ws.send(`42${JSON.stringify([name, data])}`); },
      /** Resolves with the first event named `name` at index >= `from`. */
      waitFor(name, from = 0, timeoutMs = 3000) {
        return new Promise((res, rej) => {
          const check = () => {
            const i = client.events.findIndex((e, idx) => idx >= from && e.name === name);
            if (i === -1) return false;
            res({ ...client.events[i], index: i });
            return true;
          };
          if (check()) return;
          const timer = setTimeout(() => rej(new Error(`timed out waiting for "${name}"`)), timeoutMs);
          client.waiters.push(() => { if (check()) { clearTimeout(timer); return true; } return false; });
        });
      },
      /** Switch room (or re-confirm it) and wait for the server's init reply. Returns the events received before it. */
      async subscribe(mode) {
        const mark = client.events.length;
        client.emit('subscribe', { mode });
        const init = await client.waitFor('init', mark);
        return { init, before: client.events.slice(mark, init.index) };
      },
      close() { ws.close(); },
    };
    ws.addEventListener('message', (e) => {
      const msg = String(e.data);
      if (msg.startsWith('0')) ws.send('40'); // open -> connect to "/"
      else if (msg === '2') ws.send('3'); // ping -> pong
      else if (msg.startsWith('40')) resolve(client);
      else if (msg.startsWith('42')) {
        const [name, data] = JSON.parse(msg.slice(2));
        client.events.push({ name, data });
        client.waiters = client.waiters.filter((w) => !w());
      }
    });
    ws.addEventListener('error', () => reject(new Error('websocket error')));
  });
}

const isSimulated = (e) => (e.data && e.data.dataMode === 'simulation')
  || e.name === 'simulationStatus' || e.name === 'simulationReset';
const isLive = (e) => e.data && e.data.dataMode === 'live' && e.name !== 'init';

test('clients start in the live room and never receive simulated data', async () => {
  const env = await startServer();
  const client = await connect(env.port);
  try {
    const init = await client.waitFor('init');
    assert.equal(init.data.dataMode, 'live');
    assert.equal(init.data.simulation, undefined);

    env.live.ingest(liveObservation());
    const update = await client.waitFor('trafficUpdate');
    assert.equal(update.data.dataMode, 'live');

    env.simulation.start(); // emits simulated trafficUpdate / signalUpdate / systemEvent / simulationStatus
    env.simulation.setScenario('main', 'ambulance-north');
    env.simulation.tick();
    assert.ok(env.simulation.engine.getSnapshot('main').updatesReceived >= 2, 'simulation really produced data');

    await client.subscribe('live'); // barrier
    assert.deepEqual(client.events.filter(isSimulated), [], 'no simulated event reached the live room');
  } finally {
    client.close();
    await env.close();
  }
});

test('a client in the simulation room receives only simulated data', async () => {
  const env = await startServer();
  const client = await connect(env.port);
  try {
    await client.waitFor('init');
    const { init } = await client.subscribe('simulation');
    assert.equal(init.data.dataMode, 'simulation');
    assert.equal(init.data.simulation.state, 'stopped');
    assert.ok(init.data.intersections.every((s) => s.dataMode === 'simulation'));
    const joinedAt = client.events.length;

    env.simulation.start();
    const status = await client.waitFor('simulationStatus', joinedAt);
    assert.equal(status.data.state, 'running');
    const update = await client.waitFor('trafficUpdate', joinedAt);
    assert.equal(update.data.dataMode, 'simulation');

    env.live.ingest(liveObservation());
    const { before } = await client.subscribe('simulation'); // barrier
    const received = client.events.slice(joinedAt);
    assert.deepEqual(received.filter(isLive), [], 'no live event reached the simulation room');
    assert.ok(before.every((e) => e.data.dataMode === 'simulation' || e.name === 'simulationStatus'));
  } finally {
    client.close();
    await env.close();
  }
});

test('switching modes (tabs) moves the client between rooms', async () => {
  const env = await startServer();
  const client = await connect(env.port);
  try {
    await client.waitFor('init');
    await client.subscribe('simulation');
    env.simulation.start();
    await client.waitFor('trafficUpdate');

    // Back to live: simulation keeps running but its events stop arriving.
    const { init } = await client.subscribe('live');
    assert.equal(init.data.dataMode, 'live');
    const backAt = client.events.length;
    env.simulation.tick();
    env.live.ingest(liveObservation());
    await client.subscribe('live'); // barrier
    const after = client.events.slice(backAt);
    assert.deepEqual(after.filter(isSimulated), []);
    assert.ok(after.some((e) => e.name === 'trafficUpdate' && e.data.dataMode === 'live'), 'live data arrives again');
  } finally {
    client.close();
    await env.close();
  }
});

test('simulation reset reaches only the simulation room; bad subscriptions are refused', async () => {
  const env = await startServer();
  const liveClient = await connect(env.port);
  const simClient = await connect(env.port);
  try {
    await liveClient.waitFor('init');
    await simClient.waitFor('init');
    await simClient.subscribe('simulation');
    env.simulation.start();
    env.simulation.reset();

    const reset = await simClient.waitFor('simulationReset');
    assert.equal(reset.data.dataMode, 'simulation');
    assert.ok(reset.data.intersections.every((s) => s.updatesReceived === 0));

    await liveClient.subscribe('live'); // barrier
    assert.deepEqual(liveClient.events.filter(isSimulated), []);

    const mark = liveClient.events.length;
    liveClient.emit('subscribe', { mode: 'everything' });
    const refused = await liveClient.waitFor('subscribeError', mark);
    assert.match(refused.data.error, /live, simulation/);
    // Still in the live room.
    env.live.ingest(liveObservation());
    const update = await liveClient.waitFor('trafficUpdate', mark);
    assert.equal(update.data.dataMode, 'live');
  } finally {
    liveClient.close();
    simClient.close();
    await env.close();
  }
});
