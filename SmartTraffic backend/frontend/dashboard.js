/**
 * Dashboard rendering. Pure DOM updates from backend snapshots; no state
 * of its own beyond element references. Every number comes from the
 * snapshot; while there is none (or the approach has no camera data) the
 * dashboard says so instead of showing a number.
 */

const DIRS = ['north', 'south', 'east', 'west'];
const TYPE_LABEL = { ambulance: 'AMBULANCE', police: 'POLICE', fire_truck: 'FIRE TRUCK', emergency: 'EMERGENCY VEHICLE' };
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const MAX_EVENTS = 200;

const $ = (id) => document.getElementById(id);
const up = (s) => (s ? s.toUpperCase() : '-');
const pct = (c) => `${Math.round((c || 0) * 100)}%`;
const typeLabel = (t) => TYPE_LABEL[t] || up(t);

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function formatTime(iso) {
  if (!iso) return '--:--:--';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function setTone(el, base, tone) {
  el.className = tone ? `${base} c-${tone}` : base;
}

// ------------------------------------------------------------- structure

const refs = { approaches: {}, signals: {} };

export function initLayout() {
  const apRoot = $('approaches');
  apRoot.innerHTML = '';
  const sigRoot = $('signal-list');
  sigRoot.innerHTML = '';

  for (const dir of DIRS) {
    const ap = document.createElement('div');
    ap.className = 'ap';
    ap.innerHTML = `
      <div class="ap-head">
        <span class="lamp"></span>
        <span class="ap-name">${up(dir)}</span>
        <span class="ap-state"></span>
        <span class="ap-tags"></span>
      </div>
      <div class="ap-main"><span class="ap-veh">--</span><span class="ap-unit">vehicles</span></div>
      <div class="ap-note"></div>
      <div class="ap-rows">
        <div><span>Waiting</span><b class="w">-</b></div>
        <div><span>Queue</span><b class="q">-</b></div>
        <div><span>Score</span><b class="sc">-</b></div>
      </div>
      <div class="ap-bar"><span></span></div>`;
    apRoot.appendChild(ap);
    refs.approaches[dir] = {
      root: ap,
      lamp: ap.querySelector('.lamp'),
      state: ap.querySelector('.ap-state'),
      tags: ap.querySelector('.ap-tags'),
      veh: ap.querySelector('.ap-veh'),
      note: ap.querySelector('.ap-note'),
      waiting: ap.querySelector('.w'),
      queue: ap.querySelector('.q'),
      score: ap.querySelector('.sc'),
      bar: ap.querySelector('.ap-bar span'),
    };

    const li = document.createElement('li');
    li.innerHTML = `
      <span class="sig-dir">${up(dir)}</span>
      <span class="sig-head"><i class="r"></i><i class="y"></i><i class="g"></i></span>
      <span class="sig-state"></span>
      <span class="sig-ped"></span>`;
    sigRoot.appendChild(li);
    refs.signals[dir] = {
      lamps: li.querySelectorAll('.sig-head i'),
      state: li.querySelector('.sig-state'),
      ped: li.querySelector('.sig-ped'),
    };
  }
}

// ------------------------------------------------------- intersection list

export function renderIntersectionList(list, onSelect) {
  const root = $('ix-list');
  root.innerHTML = '';
  for (const ix of list) {
    const li = document.createElement('li');
    li.className = 'ix-item';
    li.dataset.id = ix.id;
    li.tabIndex = 0;
    li.innerHTML = `<span class="ix-lamp"></span><span class="ix-name">${escapeHtml(ix.name)}</span><span class="ix-meta"></span>`;
    li.addEventListener('click', () => onSelect(ix.id, { pan: true }));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect(ix.id, { pan: true });
      }
    });
    root.appendChild(li);
  }
  setText($('ix-count'), `${list.length} sites`);
}

export function updateListRow(snap) {
  const li = document.querySelector(`.ix-item[data-id="${CSS.escape(snap.intersectionId)}"]`);
  if (!li) return;
  const lamp = li.querySelector('.ix-lamp');
  const aspect = snap.greenDirection ? snap.signals[snap.greenDirection] : 'RED';
  lamp.className = `ix-lamp lamp-${aspect}`;
  const what = snap.mode === 'EMERGENCY'
    ? `${typeLabel(snap.emergency.type)} ${up(snap.emergency.direction)}`
    : snap.greenDirection ? up(snap.greenDirection) : snap.phase.replace('_', ' ');
  li.querySelector('.ix-meta').innerHTML = `<b>${snap.mode}</b> &middot; ${escapeHtml(what)}`;
  li.classList.toggle('mode-emergency', snap.mode === 'EMERGENCY');
  li.classList.toggle('mode-fallback', snap.mode === 'FALLBACK');
}

/** Clears every row, so nothing from the previous data mode stays on screen. */
export function resetListRows() {
  document.querySelectorAll('.ix-item').forEach((li) => {
    li.querySelector('.ix-lamp').className = 'ix-lamp';
    li.querySelector('.ix-meta').textContent = '-';
    li.classList.remove('mode-emergency', 'mode-fallback');
  });
}

// Active data mode ('live' | 'simulation'); decides how status is labelled.
let dataMode = 'live';

/** Labels the whole view for the active data mode. Simulated data is always marked as such. */
export function setDataMode(mode) {
  dataMode = mode;
  $('mode-badge').hidden = mode !== 'simulation';
  setText(document.querySelector('#vp-emergency .alert-title'),
    mode === 'simulation' ? 'SIMULATED EMERGENCY' : 'EMERGENCY PRIORITY');
  setText($('ev-scope'), scopeLabel($('tb-name').textContent));
  setFeeds([]);
}

function scopeLabel(name) {
  return dataMode === 'simulation' ? `${name} · simulation` : name;
}

/** Seconds since the snapshot's last AI update, from the server's clock. */
function dataAgeSeconds(snap) {
  if (!snap || !snap.lastUpdate || !snap.serverTime) return null;
  const atServer = (Date.parse(snap.serverTime) - Date.parse(snap.lastUpdate)) / 1000;
  return Math.max(0, atServer + (performance.now() - (snap._receivedAt || performance.now())) / 1000);
}

function ageText(seconds) {
  if (seconds === null) return '';
  if (seconds < 90) return `${Math.round(seconds)} s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

/**
 * Badge on the 3D view (live traffic mode only; Simulation mode shows the
 * SIMULATED DATA badge instead): is everything on screen live AI data now?
 *   live / waiting (nothing received yet) / stale (AI data stopped; the last
 *   values stay, marked with their time) / offline (backend unreachable).
 */
export function setDataState(dataState, snap) {
  const badge = $('data-badge');
  badge.hidden = dataState === 'simulation';
  badge.className = `data-badge ${dataState}`;
  badge.dataset.state = dataState;
  tickDataAge(dataState, snap);
}

export function tickDataAge(dataState, snap) {
  const badge = $('data-badge');
  if (badge.dataset.state !== dataState || dataState === 'simulation') return;
  let text;
  if (dataState === 'live') text = 'LIVE AI DATA';
  else if (dataState === 'waiting') text = 'WAITING FOR LIVE DATA';
  else if (dataState === 'offline') text = 'BACKEND OFFLINE - RECONNECTING';
  else {
    const last = snap && snap.lastUpdate ? formatTime(snap.lastUpdate) : '--:--:--';
    text = `STALE - LAST AI DATA ${last} (${ageText(dataAgeSeconds(snap))})`;
  }
  setText(badge, text);
}

export function setSelected(id, name, snap) {
  document.querySelectorAll('.ix-item').forEach((li) => li.classList.toggle('selected', li.dataset.id === id));
  setText($('tb-name'), name || id);
  setText($('tb-id'), id);
  setText($('vp-title'), name || id);
  if (snap) setText($('vp-sub'), `${id}  ·  ${snap.lat.toFixed(4)}, ${snap.lng.toFixed(4)}`);
  setText($('ev-scope'), scopeLabel(name || id));
}

// ---------------------------------------------------------------- render

export function render(snap, dataState = 'live') {
  renderDecision(snap);
  renderApproaches(snap, dataState);
  renderSignals(snap);
  renderEmergency(snap);
  renderAlerts(snap);
  renderSystemData(snap);
}

const MODE_INFO = {
  NORMAL: { tone: null, sub: 'Adaptive control' },
  EMERGENCY: { tone: 'emergency', sub: 'Priority override' },
  PEDESTRIAN: { tone: 'walk', sub: 'Exclusive crossing phase' },
  FALLBACK: { tone: 'amber', sub: 'Fixed-time plan - no AI data' },
};

function renderDecision(s) {
  const mode = MODE_INFO[s.mode] || MODE_INFO.NORMAL;
  const modeEl = $('dec-mode');
  setText(modeEl, s.mode);
  setTone(modeEl, 'big', mode.tone);
  setText($('dec-mode-sub'), mode.sub);

  const em = s.emergency && s.emergency.active ? s.emergency : null;
  const activeEl = $('dec-active');
  let label = 'Active signal';
  let value;
  let tone;
  let sub = '';

  if (em) {
    label = 'Priority';
    value = up(em.direction);
    tone = 'emergency';
    sub = `${typeLabel(em.type)} · ${pct(em.confidence)}`;
    if (s.greenDirection !== em.direction) sub += ' · clearing';
  } else if (s.phase === 'GREEN') {
    value = up(s.greenDirection);
    tone = 'green';
    sub = 'Green';
  } else if (s.phase === 'YELLOW') {
    value = up(s.greenDirection);
    tone = 'yellow';
    sub = s.nextDirection ? `Yellow · next ${up(s.nextDirection)}` : s.nextPhase === 'PED' ? 'Yellow · next pedestrian phase' : 'Yellow';
  } else if (s.phase === 'ALL_RED') {
    value = 'ALL RED';
    tone = 'red';
    sub = s.nextDirection ? `Clearance · next ${up(s.nextDirection)}` : 'Clearance';
  } else if (s.phase === 'PED_WALK') {
    value = 'ALL RED';
    tone = 'red';
    sub = 'Pedestrians crossing';
  } else {
    value = 'ALL RED';
    tone = 'red';
    sub = 'Pedestrian clearance';
  }
  setText($('dec-active-label'), label);
  setText(activeEl, value);
  setTone(activeEl, 'big', tone);
  setText($('dec-active-sub'), sub);

  setText($('dec-reason'), s.reason || '-');
  setText($('dec-phase'), s.phase.replace('_', ' '));
}

/**
 * `frozen`: a stopped/paused simulation, or the backend is unreachable -
 * show the remaining time as received, without counting down.
 */
export function tickCountdown(s, frozen = false) {
  if (!s) return;
  const remEl = $('dec-remaining');
  const progress = $('dec-progress');
  const bar = progress.parentElement;
  const sinceReceipt = frozen ? 0 : (performance.now() - s._receivedAt) / 1000;

  if (s.holding === 'EMERGENCY' || s.remaining === null) {
    setText(remEl, 'HOLD');
    setTone(remEl, 'big mono', 'emergency');
    progress.style.width = '100%';
    bar.className = 'progress c-emergency';
    return;
  }
  const remaining = Math.max(0, s.remaining - sinceReceipt);
  const total = Math.max(0.1, s.phaseDuration);
  setText(remEl, `${Math.ceil(remaining)}s`);
  setTone(remEl, 'big mono', null);
  progress.style.width = `${Math.min(100, (1 - remaining / total) * 100).toFixed(1)}%`;
  bar.className = `progress ${s.phase === 'GREEN' ? 'c-green' : s.phase === 'YELLOW' ? 'c-yellow' : ''}`;
}

/**
 * Text for one approach: its counts, or why there are none.
 *   waiting       nothing received from the AI service yet
 *   unavailable   the AI service has no video for this approach
 *   stale         last received values (the badge shows their time)
 *   simulation    simulated values (Simulation mode, labelled as such)
 */
export function approachView(t, dataState) {
  if (dataState === 'waiting' || !t) return { vehicles: null, note: 'Waiting for live data', state: 'nodata' };
  if (dataState === 'simulation') {
    if (t.available === false || !isNum(t.vehicles)) return { vehicles: null, note: 'Simulation not started', state: 'nodata' };
    return { vehicles: t.vehicles, queueLength: t.queueLength, waiting: isNum(t.waiting) ? t.waiting : t.waitingTime, note: '', state: 'simulation' };
  }
  if (t.available === false || !isNum(t.vehicles)) {
    return { vehicles: null, note: 'Video unavailable', state: 'unavailable' };
  }
  const stale = dataState === 'stale' || dataState === 'offline';
  return {
    vehicles: t.vehicles,
    queueLength: t.queueLength,
    waiting: isNum(t.waiting) ? t.waiting : t.waitingTime,
    note: stale ? 'Stale - last AI data' : '',
    state: stale ? 'stale' : 'live',
  };
}

function renderApproaches(s, dataState) {
  const views = Object.fromEntries(DIRS.map((d) => [d, approachView(s.traffic[d], dataState)]));
  const score = (d) => (views[d].vehicles === null ? 0 : s.scores[d]);
  const maxScore = Math.max(1, ...DIRS.map(score));
  const top = DIRS.reduce((a, b) => (score(b) > score(a) ? b : a), DIRS[0]);
  const em = s.emergency && s.emergency.active ? s.emergency : null;

  for (const dir of DIRS) {
    const r = refs.approaches[dir];
    const sig = s.signals[dir];
    const view = views[dir];
    const priority = em && em.direction === dir;

    r.root.classList.toggle('active', sig === 'GREEN');
    r.root.classList.toggle('yellow', sig === 'YELLOW');
    r.root.classList.toggle('priority', !!priority);
    r.root.classList.toggle('top-score', dir === top && score(dir) > 0);
    r.root.classList.toggle('no-data', view.vehicles === null);
    r.root.classList.toggle('stale', view.state === 'stale');
    r.lamp.className = `lamp lamp-${sig}`;
    setText(r.state, sig === 'RED' && s.redSeconds[dir] ? `RED ${s.redSeconds[dir]}s` : sig);

    if (view.vehicles === null) {
      setText(r.veh, '--');
      setText(r.waiting, '-');
      setText(r.queue, '-');
      setText(r.score, '-');
      r.bar.style.width = '0%';
    } else {
      setText(r.veh, String(view.vehicles));
      setText(r.waiting, `${Math.round(view.waiting)}s`);
      setText(r.queue, String(view.queueLength));
      setText(r.score, String(s.scores[dir]));
      r.bar.style.width = `${(s.scores[dir] / maxScore) * 100}%`;
    }
    setText(r.note, view.note);
    r.note.className = `ap-note ${view.state}`;

    const chips = [];
    if (priority) chips.push('<span class="chip chip-prio">PRIORITY</span>');
    if (s.pedestrianSignals[dir] !== 'DONT_WALK' || s.pedestrianRequests[dir]) chips.push('<span class="chip chip-ped">PED</span>');
    if (s.nextDirection === dir) chips.push('<span class="chip chip-next">NEXT</span>');
    const html = chips.join('');
    if (r.tags.innerHTML !== html) r.tags.innerHTML = html;
  }
}

function renderSignals(s) {
  for (const dir of DIRS) {
    const r = refs.signals[dir];
    const sig = s.signals[dir];
    r.lamps[0].classList.toggle('on', sig === 'RED');
    r.lamps[1].classList.toggle('on', sig === 'YELLOW');
    r.lamps[2].classList.toggle('on', sig === 'GREEN');
    setText(r.state, sig);

    const ped = s.pedestrianSignals[dir];
    let text = "DON'T WALK";
    let cls = 'sig-ped';
    if (ped === 'WALK') { text = 'WALK'; cls += ' walk'; }
    else if (ped === 'CLEARANCE') { text = 'CLEARANCE'; cls += ' clear'; }
    else if (s.pedestrianRequests[dir]) { text = 'REQUESTED'; cls += ' req'; }
    setText(r.ped, text);
    r.ped.className = cls;
  }
}

function renderEmergency(s) {
  const root = $('emergency');
  const em = s.emergency || {};
  let html;
  if (em.active) {
    const title = s.dataMode === 'simulation' ? 'SIMULATED EMERGENCY' : 'EMERGENCY PRIORITY';
    html = `<div class="emergency-active">
      <div class="em-title">${title}</div>
      <div class="em-type">${typeLabel(em.type)}</div>
      <div class="em-row"><span>Approach <b>${up(em.direction)}</b></span><span>Confidence <b>${pct(em.confidence)}</b></span></div>
      <div class="em-since">Active since ${formatTime(em.since)}</div>
    </div>`;
  } else if (!s.detectors || !s.detectors.emergency) {
    // The AI service runs no emergency detector (no Roboflow key): "none" would be a guess.
    html = '<div class="emergency-none">EMERGENCY DETECTION OFF</div>';
  } else {
    html = '<div class="emergency-none">NO ACTIVE EMERGENCY</div>';
    if (em.candidate) {
      html += `<div class="emergency-candidate">Unconfirmed: ${typeLabel(em.candidate.type)} ${up(em.candidate.direction)} ${pct(em.candidate.confidence)} (threshold ${pct(em.threshold)})</div>`;
    }
  }
  if (root.innerHTML !== html) root.innerHTML = html;
}

function renderAlerts(s) {
  const em = s.emergency || {};
  $('vp-emergency').hidden = !em.active;
  if (em.active) setText($('vp-emergency-body'), `${typeLabel(em.type)} · ${up(em.direction)} · ${pct(em.confidence)}`);

  const walking = DIRS.filter((d) => s.pedestrianSignals[d] !== 'DONT_WALK');
  const requested = DIRS.filter((d) => s.pedestrianRequests[d]);
  let body = '';
  if (walking.length) {
    const state = walking.some((d) => s.pedestrianSignals[d] === 'WALK') ? 'WALK' : 'CLEARANCE';
    body = `${walking.map(up).join(', ')} · ${state}`;
  } else if (requested.length) {
    body = `${requested.map(up).join(', ')} · REQUESTED`;
  }
  $('vp-ped').hidden = !body;
  if (body) setText($('vp-ped-body'), body);
}

function renderSystemData(s) {
  const ai = $('sys-ai');
  if (s.dataMode === 'simulation') {
    // Generated by the simulator: never presented as an AI / perception feed.
    setText(ai, 'SIMULATED');
    ai.className = 'warn';
  } else {
    setText(ai, s.aiStatus);
    ai.className = s.aiStatus === 'CONNECTED' ? 'ok' : s.aiStatus === 'STALE' ? 'bad' : 'warn';
  }
  setText($('sys-last'), s.lastUpdate ? formatTime(s.lastUpdate) : 'never');
  setText($('sys-count'), String(s.updatesReceived));
}

// ------------------------------------------------------------- system bar

export function setConnection(status, transport) {
  const pill = $('tb-system');
  const label = { connected: 'SYSTEM ONLINE', connecting: 'CONNECTING', disconnected: 'BACKEND OFFLINE' }[status];
  pill.className = `status-pill ${status === 'connected' ? 'ok' : status === 'connecting' ? 'warn' : 'bad'}`;
  setText(pill.querySelector('.txt'), label);

  const sys = $('sys-system');
  setText(sys, status === 'connected' ? 'ONLINE' : status === 'connecting' ? 'CONNECTING' : 'OFFLINE');
  sys.className = status === 'connected' ? 'ok' : status === 'connecting' ? 'warn' : 'bad';
  pill.title = status === 'connected' ? `Socket.IO link: ${transport || 'websocket'}` : '';
}

export function setFeeds(snaps) {
  const pill = $('tb-feeds');
  if (dataMode === 'simulation') {
    pill.className = 'status-pill sim';
    setText(pill.querySelector('.txt'), 'SIMULATED');
    return;
  }
  const total = snaps.length;
  const connected = snaps.filter((s) => s.aiStatus === 'CONNECTED').length;
  pill.className = `status-pill ${connected === total && total ? 'ok' : connected ? 'warn' : 'warn'}`;
  setText(pill.querySelector('.txt'), connected ? `AI FEEDS ${connected}/${total}` : 'AI DATA WAITING');
}

export function tickClock() {
  setText($('clock'), new Date().toLocaleTimeString([], { hour12: false }));
}

// ----------------------------------------------------------------- events

function eventRow(evt, fresh) {
  const row = document.createElement('div');
  row.className = `ev cat-${evt.category.replace(/\s+/g, '_')} level-${evt.level}${fresh ? ' fresh' : ''}`;
  row.innerHTML = `<span class="ev-time">${formatTime(evt.time)}</span><span class="ev-cat">${escapeHtml(evt.category)}</span><span class="ev-msg" title="${escapeHtml(evt.message)}">${escapeHtml(evt.message)}</span>`;
  return row;
}

export function renderEvents(events) {
  const root = $('event-list');
  root.innerHTML = '';
  if (!events || !events.length) {
    root.innerHTML = '<div class="ev-empty">No events yet.</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const evt of events.slice(-MAX_EVENTS).reverse()) frag.appendChild(eventRow(evt, false));
  root.appendChild(frag);
}

export function appendEvent(evt) {
  const root = $('event-list');
  const empty = root.querySelector('.ev-empty');
  if (empty) empty.remove();
  root.prepend(eventRow(evt, true));
  while (root.children.length > MAX_EVENTS) root.lastChild.remove();
}
