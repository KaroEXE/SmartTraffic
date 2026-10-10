/**
 * Live AI view - "what are the AI cameras seeing right now?"
 *
 * Nothing here generates, simulates or mocks data: every panel starts in an
 * empty "not connected" state and changes only when real data arrives.
 *
 *   Python + YOLO -> Flask -> four annotated MJPEG streams, loaded straight
 *     from the AI service (AI_STREAM_URL, via GET /api/client-config) into
 *     one tile per approach. Images need no CORS. GET <AI_STREAM_URL>/api/cameras
 *     tells each tile whether its stream is live; that one call needs the Node
 *     site's URL in the AI service's ALLOWED_ORIGINS.
 *
 *   Python + YOLO -> Flask -> JSON -> Node/Express -> Socket.IO -> app.js ->
 *     updateFromLiveSnapshot(snapshot, dataState): detection panels, from the
 *     same snapshot the dashboard and the 3D scene draw. Only fresh AI data is
 *     shown as numbers; otherwise the panels say why there are none.
 *
 * The streams are open only while this view is shown and the page is
 * visible, so a dashboard on another tab holds no AI service connections.
 */

const DIRS = ['north', 'south', 'east', 'west'];
// Tile order: the AI service's camera order (its original 2 x 2 grid).
const STREAM_DIRS = ['north', 'south', 'west', 'east'];
const TYPE_LABEL = { ambulance: 'AMBULANCE', police: 'POLICE', fire_truck: 'FIRE TRUCK', emergency: 'EMERGENCY VEHICLE' };
const NO_DATA_NOTE = {
  waiting: 'Waiting for live data',
  stale: 'AI data stopped',
  offline: 'Reconnecting to the backend',
  simulation: 'Live data is not shown in Simulation mode - switch to Live traffic',
};

const TICK_MS = 1000;          // retry check
const STATUS_EVERY_TICKS = 3;  // GET /api/cameras every 3 s
const STATUS_TIMEOUT_MS = 5000;
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 15000;
// Assigning this aborts an MJPEG request; removing the <img> alone may not.
const BLANK_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';

const el = {};
const tiles = {};
const streams = {
  base: null,           // AI service base URL, from /api/client-config
  configLoaded: false,
  active: false,        // view shown and page visible
  timer: null,
  ticks: 0,
  statusWorks: false,   // /api/cameras answered at least once (CORS is set up)
  statusOk: false,      // the latest /api/cameras call answered
  statusFailures: 0,    // consecutive failed /api/cameras calls
  lastStatus: null,     // { at, sequences } for the display frame rate
  fps: null,
};

const $ = (id) => document.getElementById(id);
const up = (s) => (s ? String(s).toUpperCase() : '--');
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const pct = (c) => (isNum(c) ? `${Math.round(c * 100)}%` : '--');

function setValue(node, value, fallback) {
  const real = value !== undefined && value !== null;
  node.textContent = real ? String(value) : fallback;
  node.classList.toggle('lai-idle', !real);
}

function emptyNote(text) {
  const div = document.createElement('div');
  div.className = 'emergency-none';
  div.textContent = text;
  return div;
}

// -------------------------------------------------------------- navigation

/** Switches between the existing operations view and the Live AI view. */
export function showView(view) {
  const app = document.querySelector('.app');
  const live = view === 'live-ai';
  if (live) app.dataset.view = 'live-ai';
  else delete app.dataset.view;
  el.view.hidden = !live;
  document.querySelectorAll('.view-tab').forEach((tab) => {
    const active = tab.dataset.view === (live ? 'live-ai' : 'operations');
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  syncStreams();
}

// ------------------------------------------------------------------- init

export function initializeLiveAI() {
  el.view = $('live-ai');
  el.status = $('lai-status');
  el.statusLabel = $('lai-status-label');
  el.statusDetail = $('lai-status-detail');
  el.sumVehicles = $('lai-sum-vehicles');
  el.sumPedestrians = $('lai-sum-pedestrians');
  el.sumEmergency = $('lai-sum-emergency');
  el.sumConfidence = $('lai-sum-confidence');
  el.directions = $('lai-directions');
  el.emergency = $('lai-emergency');
  el.pedestrians = $('lai-pedestrians');
  el.frameSource = $('lai-cam-source');
  el.camStatus = $('lai-cam-status');
  el.camSource = $('lai-cam-src');
  el.camFps = $('lai-cam-fps');
  el.camRes = $('lai-cam-res');

  document.querySelectorAll('.lai-tile').forEach((node) => {
    tiles[node.dataset.dir] = {
      dir: node.dataset.dir,
      node,
      placeholder: node.querySelector('.lai-placeholder'),
      text: node.querySelector('.lai-ph-text'),
      stream: node.querySelector('.lai-stream'),
      img: null,
      state: 'idle',       // idle | connecting | live | reconnecting | unavailable
      retryAt: 0,
      retryDelay: RETRY_MIN_MS,
      sequence: null,
    };
  });

  document.querySelectorAll('.view-tab').forEach((tab) => {
    tab.addEventListener('click', () => showView(tab.dataset.view));
  });
  document.addEventListener('visibilitychange', syncStreams);
  // Free the AI service's viewer slots as soon as the page goes away.
  window.addEventListener('pagehide', () => stopStreams());
  window.addEventListener('pageshow', syncStreams);

  // Empty, not-connected state. No values are invented.
  updateLiveAIStatus({ state: 'offline' });
  updateFromLiveSnapshot(null, 'waiting');
  updateCameraInfo({});

  loadStreamConfig();

  // Read-only checks from the browser console, e.g. liveAI.streamStates().
  // Nothing here can put values on the panels: only snapshots from app.js do.
  window.liveAI = { showView, streamStates };
}

// ----------------------------------------------------------------- status

const STATUS_TEXT = {
  offline: ['OFFLINE / NOT CONNECTED', 'AI service not configured - set AI_STREAM_URL on the backend'],
  connecting: ['CONNECTING', 'Contacting AI service...'],
  connected: ['CONNECTED', 'Receiving AI camera streams'],
  error: ['CONNECTION ERROR', 'AI service unreachable - retrying'],
};

/**
 * @param {{ state: 'offline'|'connecting'|'connected'|'error', detail?: string }} status
 */
export function updateLiveAIStatus({ state = 'offline', detail } = {}) {
  const [label, defaultDetail] = STATUS_TEXT[state] || STATUS_TEXT.offline;
  el.status.className = `lai-status ${state}`;
  el.statusLabel.textContent = label;
  el.statusDetail.textContent = detail || defaultDetail;
}

// -------------------------------------------------------------- detections

/**
 * @param {{ vehicles?: number, pedestrians?: number|string, emergencyVehicles?: number|string, confidence?: number }} summary
 *   confidence is 0-1. A missing value shows "--"; a detector that does not
 *   run is passed as a short text ("off").
 */
export function updateDetectionSummary({ vehicles, pedestrians, emergencyVehicles, confidence } = {}) {
  const shown = (v) => (isNum(v) || typeof v === 'string' ? v : null);
  setValue(el.sumVehicles, isNum(vehicles) ? vehicles : null, '--');
  setValue(el.sumPedestrians, shown(pedestrians), '--');
  setValue(el.sumEmergency, shown(emergencyVehicles), '--');
  setValue(el.sumConfidence, isNum(confidence) ? pct(confidence) : null, '--');
}

/**
 * @param {{ north?: {vehicles:number, available?:boolean}|null, south?: ..., east?: ..., west?: ... }} traffic
 *   Same per-direction shape as the snapshot. `noData` explains a missing value.
 */
export function updateDirectionalTraffic(traffic = {}, noData = '') {
  for (const dir of DIRS) {
    const card = el.directions.querySelector(`.ap[data-dir="${dir}"]`);
    const t = traffic[dir];
    const n = t && t.available !== false && isNum(t.vehicles) ? t.vehicles : null;
    setValue(card.querySelector('[data-field="vehicles"]'), n, '--');
    const note = card.querySelector('[data-field="note"]');
    if (note) note.textContent = n !== null ? '' : (noData || (t && t.available === false ? 'Video unavailable' : ''));
  }
}

/**
 * @param {{ detected: boolean, type?: string, direction?: string, confidence?: number } | null} emergency
 * @param {string} [empty] text when nothing is detected (or why nothing can be)
 */
export function updateEmergencyDetection(emergency, empty = 'NO EMERGENCY VEHICLE DETECTED') {
  el.emergency.replaceChildren();
  if (!emergency || !emergency.detected) {
    el.emergency.appendChild(emptyNote(empty));
    return;
  }
  const box = document.createElement('div');
  box.className = 'emergency-active';
  const title = document.createElement('div');
  title.className = 'em-title';
  title.textContent = 'EMERGENCY VEHICLE DETECTED';
  const type = document.createElement('div');
  type.className = 'em-type';
  type.textContent = TYPE_LABEL[emergency.type] || up(emergency.type);
  const row = document.createElement('div');
  row.className = 'em-row';
  row.innerHTML = '<span>Direction <b></b></span><span>Confidence <b></b></span>';
  const [dirB, confB] = row.querySelectorAll('b');
  dirB.textContent = up(emergency.direction);
  confB.textContent = pct(emergency.confidence);
  box.append(title, type, row);
  el.emergency.appendChild(box);
}

/**
 * @param {{ count?: number, directions?: {north?:boolean, south?:boolean, east?:boolean, west?:boolean} } | null} pedestrians
 * @param {string} [empty] text when nobody is detected (or why nobody can be)
 */
export function updatePedestrianDetection(pedestrians, empty = 'NO PEDESTRIANS DETECTED') {
  el.pedestrians.replaceChildren();
  const dirs = pedestrians && pedestrians.directions
    ? DIRS.filter((d) => pedestrians.directions[d])
    : [];
  const count = pedestrians && isNum(pedestrians.count) ? pedestrians.count : null;
  if (!dirs.length && !count) {
    el.pedestrians.appendChild(emptyNote(empty));
    return;
  }
  const row = document.createElement('div');
  row.className = 'lai-ped-row';
  const parts = [];
  if (count !== null) parts.push(`${count} detected`);
  if (dirs.length) parts.push(`waiting: ${dirs.map(up).join(', ')}`);
  row.textContent = parts.join(' · ');
  el.pedestrians.appendChild(row);
}

/**
 * The selected intersection's snapshot (the same object the dashboard and the
 * 3D scene draw) and its data state from app.js. Numbers are shown only for
 * fresh AI data ("live"); otherwise every panel says why there are none.
 * A detector the AI service does not run is shown as off, never as zero.
 */
export function updateFromLiveSnapshot(snapshot, dataState = 'live') {
  if (!snapshot || dataState !== 'live') {
    const why = NO_DATA_NOTE[dataState] || NO_DATA_NOTE.waiting;
    updateDetectionSummary({});
    updateDirectionalTraffic({}, why);
    updateEmergencyDetection(null, why.toUpperCase());
    updatePedestrianDetection(null, why.toUpperCase());
    return;
  }
  const traffic = snapshot.traffic || {};
  const detectors = snapshot.detectors || {};
  const measured = DIRS.filter((d) => traffic[d] && traffic[d].available !== false && isNum(traffic[d].vehicles));
  const confidences = measured.map((d) => traffic[d].confidence).filter(isNum);
  const emergency = snapshot.emergency || null;

  updateDirectionalTraffic(traffic);
  updateEmergencyDetection(emergency, detectors.emergency ? undefined : 'EMERGENCY DETECTION OFF (NO ROBOFLOW KEY)');
  updatePedestrianDetection(
    { directions: snapshot.pedestrians },
    detectors.pedestrians ? undefined : 'PEDESTRIAN DETECTION NOT RUNNING',
  );
  updateDetectionSummary({
    vehicles: measured.length ? measured.reduce((sum, d) => sum + traffic[d].vehicles, 0) : null,
    pedestrians: detectors.pedestrians ? DIRS.filter((d) => snapshot.pedestrians && snapshot.pedestrians[d]).length : 'off',
    emergencyVehicles: detectors.emergency ? (emergency && emergency.detected ? 1 : 0) : 'off',
    confidence: confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null,
  });
}

// ----------------------------------------------------------------- camera

/**
 * @param {{ status?: string, source?: string, fps?: number, resolution?: string }} info
 */
export function updateCameraInfo({ status, source, fps, resolution } = {}) {
  el.camStatus.textContent = status || 'Not connected';
  el.camSource.textContent = source || '--';
  el.camSource.title = source || '';
  el.camFps.textContent = isNum(fps) ? String(fps) : '--';
  el.camRes.textContent = resolution || '--';
  el.frameSource.textContent = source || 'No source configured';
}

// ----------------------------------------------------------- camera streams

/** The AI service URL set in the backend's AI_STREAM_URL (GET /api/client-config). */
async function loadStreamConfig() {
  for (let attempt = 0; !streams.configLoaded; attempt += 1) {
    try {
      const res = await fetch('/api/client-config', { cache: 'no-store' });
      if (res.ok) {
        const { aiStreamUrl } = await res.json();
        streams.configLoaded = true;
        if (aiStreamUrl) connectCameraStreams(aiStreamUrl);
        else renderSummary();
        return;
      }
    } catch {
      // Backend unreachable (cold start): try again shortly.
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(10000, 1000 * (attempt + 1))));
  }
}

/** Sets the AI service base URL and (re)connects the four tiles. */
export function connectCameraStreams(baseUrl) {
  stopStreams();
  streams.base = baseUrl ? String(baseUrl).replace(/\/+$/, '') : null;
  streams.statusWorks = false;
  streams.statusFailures = 0;
  streams.lastStatus = null;
  syncStreams();
}

export function disconnectCameraStreams() {
  streams.base = null;
  stopStreams();
}

/** Snapshot of every tile, for console checks. */
export function streamStates() {
  const out = {};
  for (const dir of STREAM_DIRS) {
    const t = tiles[dir];
    if (t) out[dir] = { state: t.state, hasImage: Boolean(t.img), width: t.img ? t.img.naturalWidth : 0 };
  }
  return out;
}

function shouldStream() {
  return Boolean(streams.base) && !el.view.hidden && document.visibilityState !== 'hidden';
}

function syncStreams() {
  if (shouldStream()) startStreams();
  else stopStreams();
}

function startStreams() {
  if (streams.active) return;
  streams.active = true;
  streams.ticks = 0;
  for (const dir of STREAM_DIRS) {
    const tile = tiles[dir];
    tile.retryAt = 0;
    tile.retryDelay = RETRY_MIN_MS;
    setTileState(tile, 'connecting', 'Connecting to AI camera...');
  }
  streams.timer = setInterval(tick, TICK_MS);
  tick();
}

function stopStreams() {
  if (streams.timer) clearInterval(streams.timer);
  streams.timer = null;
  streams.active = false;
  for (const dir of STREAM_DIRS) {
    const tile = tiles[dir];
    if (!tile) continue;
    unmountStream(tile);
    tile.sequence = null;
    setTileState(tile, 'idle', streams.base ? 'Paused while this view is hidden' : 'Waiting for camera connection...');
  }
  renderSummary();
}

function tick() {
  if (!streams.active) return;
  // Without status (not reachable, or ALLOWED_ORIGINS not set) the tiles rely
  // on image load/error events and retry with backoff.
  if (!streams.statusOk) {
    const now = Date.now();
    for (const dir of STREAM_DIRS) {
      const tile = tiles[dir];
      if (!tile.img && now >= tile.retryAt) mountStream(tile);
    }
  }
  if (streams.ticks % STATUS_EVERY_TICKS === 0) pollStatus();
  streams.ticks += 1;
}

async function pollStatus() {
  const base = streams.base;
  let cameras = null;
  try {
    const res = await fetch(`${base}/api/cameras`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (res.ok) {
      const body = await res.json();
      if (Array.isArray(body.cameras)) cameras = body.cameras;
    }
  } catch {
    // Asleep, restarting, unreachable, or the origin is not allowed.
  }
  if (!streams.active || streams.base !== base) return;

  if (!cameras) {
    streams.statusOk = false;
    streams.statusFailures += 1;
    if (streams.statusWorks && streams.statusFailures >= 2) {
      // Status worked before and failed twice in a row, so the service itself
      // is down: drop the frozen images and let the retry loop reconnect.
      for (const dir of STREAM_DIRS) {
        const tile = tiles[dir];
        if (tile.state !== 'reconnecting') scheduleRetry(tile, 'AI service unreachable - reconnecting...');
      }
    }
    renderSummary();
    return;
  }

  streams.statusOk = true;
  streams.statusWorks = true;
  streams.statusFailures = 0;
  const now = Date.now();
  const byDir = Object.fromEntries(cameras.map((c) => [c.direction, c]));
  for (const dir of STREAM_DIRS) {
    const tile = tiles[dir];
    const cam = byDir[dir];
    const sequence = cam && isNum(cam.frame_sequence) ? cam.frame_sequence : null;
    if (cam && cam.available) {
      // A lower sequence means the AI service restarted: the old connection is gone.
      const restarted = tile.sequence !== null && sequence !== null && sequence < tile.sequence;
      if ((!tile.img && now >= tile.retryAt) || restarted || tile.state === 'unavailable') mountStream(tile);
    } else {
      const failed = cam && (cam.status === 'open_failed' || cam.status === 'read_failed');
      unmountStream(tile);
      setTileState(tile, failed ? 'unavailable' : 'reconnecting',
        failed ? 'Video unavailable - the AI service retries it automatically' : 'Reconnecting...');
    }
    tile.sequence = sequence;
  }
  updateDisplayFps(cameras);
  renderSummary();
}

/** Frames per second the AI service publishes, from frame sequence numbers. */
function updateDisplayFps(cameras) {
  const now = performance.now();
  const sequences = Object.fromEntries(cameras.map((c) => [c.direction, c.frame_sequence]));
  const last = streams.lastStatus;
  if (last) {
    const rates = cameras
      .filter((c) => c.available && isNum(last.sequences[c.direction]) && c.frame_sequence >= last.sequences[c.direction])
      .map((c) => (c.frame_sequence - last.sequences[c.direction]) / ((now - last.at) / 1000));
    streams.fps = rates.length ? Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 10) / 10 : null;
  }
  streams.lastStatus = { at: now, sequences };
}

function setTileState(tile, state, message) {
  tile.state = state;
  tile.node.classList.toggle('reconnecting', state === 'reconnecting');
  tile.node.classList.toggle('unavailable', state === 'unavailable');
  if (message) tile.text.textContent = message;
  tile.placeholder.hidden = state === 'live';
}

function scheduleRetry(tile, message) {
  unmountStream(tile);
  tile.retryAt = Date.now() + tile.retryDelay;
  tile.retryDelay = Math.min(RETRY_MAX_MS, tile.retryDelay * 2);
  setTileState(tile, 'reconnecting', message);
}

function mountStream(tile) {
  unmountStream(tile);
  const img = document.createElement('img');
  img.alt = `${tile.dir.toUpperCase()} camera, AI annotated`;
  img.decoding = 'async';

  const onFirstFrame = () => {
    if (tile.img !== img || tile.state === 'live') return;
    tile.retryDelay = RETRY_MIN_MS;
    setTileState(tile, 'live');
    renderSummary();
  };
  img.addEventListener('load', onFirstFrame);
  img.addEventListener('error', () => {
    if (tile.img !== img) return;
    scheduleRetry(tile, 'Reconnecting...');
    renderSummary();
  });
  // MJPEG <img> streams do not reliably fire 'load'; watch for the first frame.
  tile.firstFramePoll = setInterval(() => {
    if (tile.img !== img) clearInterval(tile.firstFramePoll);
    else if (img.naturalWidth > 0) {
      clearInterval(tile.firstFramePoll);
      onFirstFrame();
    }
  }, 300);

  tile.img = img;
  setTileState(tile, tile.state === 'reconnecting' ? 'reconnecting' : 'connecting');
  // The query string only defeats caching of a previous, finished stream.
  img.src = `${streams.base}/video/${tile.dir}?t=${Date.now()}`;
  tile.stream.appendChild(img);
}

function unmountStream(tile) {
  if (tile.firstFramePoll) clearInterval(tile.firstFramePoll);
  tile.firstFramePoll = null;
  const img = tile.img;
  if (!img) return;
  tile.img = null;
  img.src = BLANK_IMAGE;
  img.remove();
}

function renderSummary() {
  if (!el.view) return;
  if (!streams.base) {
    updateLiveAIStatus({ state: 'offline', detail: streams.configLoaded ? undefined : 'Loading configuration...' });
    updateCameraInfo({});
    return;
  }
  const live = STREAM_DIRS.filter((d) => tiles[d].state === 'live');
  const unavailable = STREAM_DIRS.filter((d) => tiles[d].state === 'unavailable');
  if (!streams.active) {
    updateLiveAIStatus({ state: 'offline', detail: 'Streams pause while the Live AI view is hidden' });
  } else if (live.length === STREAM_DIRS.length) {
    updateLiveAIStatus({ state: 'connected', detail: 'All 4 camera streams live' });
  } else if (live.length) {
    const missing = unavailable.length ? ` - ${unavailable.map(up).join(', ')} video unavailable` : '';
    updateLiveAIStatus({ state: 'connected', detail: `${live.length} of 4 camera streams live${missing}` });
  } else if (streams.statusWorks && !streams.statusOk) {
    updateLiveAIStatus({ state: 'error' });
  } else {
    updateLiveAIStatus({ state: 'connecting' });
  }
  const first = live.length ? tiles[live[0]].img : null;
  updateCameraInfo({
    status: streams.active ? `${live.length}/4 streams live` : 'Paused',
    source: streams.base,
    fps: streams.statusOk ? streams.fps : null,
    resolution: first && first.naturalWidth ? `${first.naturalWidth} x ${first.naturalHeight}` : undefined,
  });
}
