/**
 * Live AI view - "what is the AI camera seeing right now?"
 *
 * Frontend structure only. Nothing here generates, simulates or mocks data:
 * every panel starts in an empty "not connected" state and changes only
 * when one of the update functions below is called with real data.
 *
 * Planned integration (not implemented yet):
 *
 *   Python + YOLO -> Flask -> live camera stream -> connectLiveVideo(url)
 *
 *   Python + YOLO -> Flask -> JSON -> Node/Express -> Socket.IO -> updateFromDetection(payload)
 *
 * Do NOT wire this view to the existing `trafficUpdate` socket event while
 * mock/mockClient.js is the data source - that data is simulated.
 */

const DIRS = ['north', 'south', 'east', 'west'];
const TYPE_LABEL = { ambulance: 'AMBULANCE', police: 'POLICE', fire_truck: 'FIRE TRUCK' };

const el = {};
let streamElement = null;

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
  el.placeholder = $('lai-placeholder');
  el.placeholderText = $('lai-ph-text');
  el.stream = $('lai-stream');
  el.camStatus = $('lai-cam-status');
  el.camSource = $('lai-cam-src');
  el.camFps = $('lai-cam-fps');
  el.camRes = $('lai-cam-res');

  document.querySelectorAll('.view-tab').forEach((tab) => {
    tab.addEventListener('click', () => showView(tab.dataset.view));
  });

  // Empty, not-connected state. No values are invented.
  updateLiveAIStatus({ state: 'offline' });
  updateDetectionSummary({});
  updateDirectionalTraffic({});
  updateEmergencyDetection(null);
  updatePedestrianDetection(null);
  updateCameraInfo({});

  // Handle for integration testing from the browser console, e.g.
  //   liveAI.connectLiveVideo('http://<flask-host>:5000/video_feed')
  window.liveAI = {
    showView,
    connectLiveVideo,
    disconnectLiveVideo,
    updateLiveAIStatus,
    updateDetectionSummary,
    updateDirectionalTraffic,
    updateEmergencyDetection,
    updatePedestrianDetection,
    updateCameraInfo,
    updateFromDetection,
  };
}

// ----------------------------------------------------------------- status

const STATUS_TEXT = {
  offline: ['OFFLINE / NOT CONNECTED', 'Waiting for AI connection - placeholder until the Flask service is connected'],
  connecting: ['CONNECTING', 'Contacting AI service...'],
  connected: ['CONNECTED', 'Receiving AI detection data'],
  error: ['CONNECTION ERROR', 'AI service unreachable'],
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
 * @param {{ vehicles?: number, pedestrians?: number, emergencyVehicles?: number, confidence?: number }} summary
 *   confidence is 0-1. Missing values stay in their placeholder state.
 */
export function updateDetectionSummary({ vehicles, pedestrians, emergencyVehicles, confidence } = {}) {
  setValue(el.sumVehicles, isNum(vehicles) ? vehicles : null, '0');
  setValue(el.sumPedestrians, isNum(pedestrians) ? pedestrians : null, '0');
  setValue(el.sumEmergency, isNum(emergencyVehicles) ? emergencyVehicles : null, '0');
  setValue(el.sumConfidence, isNum(confidence) ? pct(confidence) : null, '--');
}

/**
 * @param {{ north?: {vehicles:number}, south?: ..., east?: ..., west?: ... }} traffic
 *   Same per-direction shape as the POST /api/traffic contract.
 */
export function updateDirectionalTraffic(traffic = {}) {
  for (const dir of DIRS) {
    const node = el.directions.querySelector(`.ap[data-dir="${dir}"] [data-field="vehicles"]`);
    const n = traffic[dir] && isNum(traffic[dir].vehicles) ? traffic[dir].vehicles : null;
    setValue(node, n, '0');
  }
}

/**
 * @param {{ detected: boolean, type?: string, direction?: string, confidence?: number } | null} emergency
 */
export function updateEmergencyDetection(emergency) {
  el.emergency.replaceChildren();
  if (!emergency || !emergency.detected) {
    el.emergency.appendChild(emptyNote('NO EMERGENCY VEHICLE DETECTED'));
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
 */
export function updatePedestrianDetection(pedestrians) {
  el.pedestrians.replaceChildren();
  const dirs = pedestrians && pedestrians.directions
    ? DIRS.filter((d) => pedestrians.directions[d])
    : [];
  const count = pedestrians && isNum(pedestrians.count) ? pedestrians.count : null;
  if (!dirs.length && !count) {
    el.pedestrians.appendChild(emptyNote('NO PEDESTRIANS DETECTED'));
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
 * Convenience mapper for a payload in the POST /api/traffic shape
 * (traffic / pedestrians / emergency), optionally with
 * `pedestrianCount` and `confidence` fields if the AI provides them.
 */
export function updateFromDetection(payload) {
  if (!payload) return;
  const traffic = payload.traffic || {};
  const vehicles = DIRS.reduce((sum, d) => sum + (traffic[d] && isNum(traffic[d].vehicles) ? traffic[d].vehicles : 0), 0);
  const emergency = payload.emergency || null;
  updateDirectionalTraffic(traffic);
  updateEmergencyDetection(emergency);
  updatePedestrianDetection({ count: payload.pedestrianCount, directions: payload.pedestrians });
  updateDetectionSummary({
    vehicles,
    pedestrians: payload.pedestrianCount,
    emergencyVehicles: emergency && emergency.detected ? 1 : 0,
    confidence: payload.confidence,
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

/**
 * Mounts a live stream in the camera frame. Not called anywhere yet - the
 * Flask endpoint will be supplied when the AI service exists.
 *
 * @param {string} url  Stream URL, e.g. a Flask MJPEG route.
 * @param {{ type?: 'mjpeg'|'video' }} options
 *   'mjpeg' (default) - multipart/x-mixed-replace stream, rendered with <img>
 *   'video'           - a source the <video> element can play directly
 */
export function connectLiveVideo(url, { type = 'mjpeg' } = {}) {
  if (!url) return;
  disconnectLiveVideo();

  const media = document.createElement(type === 'video' ? 'video' : 'img');
  media.alt = 'Live AI camera feed';
  if (type === 'video') Object.assign(media, { autoplay: true, muted: true, playsInline: true });

  const onReady = () => {
    if (streamElement !== media) return;
    el.placeholder.hidden = true;
    const w = media.naturalWidth || media.videoWidth;
    const h = media.naturalHeight || media.videoHeight;
    updateCameraInfo({ status: 'Connected', source: url, resolution: w && h ? `${w} x ${h}` : undefined });
  };
  const onError = () => {
    if (streamElement !== media) return;
    disconnectLiveVideo();
    el.placeholderText.textContent = 'Camera stream unavailable - waiting for camera connection...';
    updateCameraInfo({ status: 'Error', source: url });
  };
  media.addEventListener(type === 'video' ? 'loadeddata' : 'load', onReady);
  media.addEventListener('error', onError);
  if (type !== 'video') {
    // MJPEG <img> streams do not reliably fire 'load'; watch for the first frame.
    const poll = setInterval(() => {
      if (streamElement !== media) clearInterval(poll);
      else if (media.naturalWidth > 0) {
        clearInterval(poll);
        onReady();
      }
    }, 300);
  }

  streamElement = media;
  updateCameraInfo({ status: 'Connecting', source: url });
  media.src = url;
  el.stream.appendChild(media);
}

export function disconnectLiveVideo() {
  if (streamElement) {
    streamElement.removeAttribute('src');
    if (streamElement.load) streamElement.load();
    streamElement.remove();
    streamElement = null;
  }
  el.placeholder.hidden = false;
  el.placeholderText.textContent = 'Waiting for camera connection...';
  updateCameraInfo({});
}
