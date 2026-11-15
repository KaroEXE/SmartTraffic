import { createBaseMap, Popup } from './mapCore.js';
import { loadMapConfig, featureCollection } from './mapConfig.js';

/**
 * Admin console (admin.html). Signs in with NAV_ADMIN_TOKEN, shows system
 * health, driver reports, road features, users and a map, and changes data
 * through the backend's admin endpoints (/api/v1/admin/*, PATCH /reports/:id,
 * /road-features). The token lives only in this tab (sessionStorage) and is
 * sent only in the Authorization header. Everything from the server is put on
 * the page as text (never as HTML).
 */

const TOKEN_KEY = 'smartTraffic.adminToken';
const PAGE_SIZE = 25;
const $ = (id) => document.getElementById(id);

const KIND_LABEL = { speed_camera: 'Speed camera', speed_bump: 'Speed bump', road_closure: 'Road closure', roadworks: 'Roadworks' };
const PLACE_CATEGORIES = ['hospital', 'pharmacy', 'police', 'fuel', 'parking', 'school', 'university', 'mosque', 'government', 'market', 'park', 'landmark', 'other'];
const PLACE_LABEL = Object.fromEntries(PLACE_CATEGORIES.map((c) => [c, c[0].toUpperCase() + c.slice(1)]));
const TYPE_LABEL = { accident: 'Accident', traffic_jam: 'Traffic jam', road_closure: 'Road closure', construction: 'Construction', hazard: 'Hazard' };
const STATUS_LABEL = {
  active: 'Active', expired: 'Expired', resolved: 'Resolved', dismissed: 'Dismissed by drivers', withdrawn: 'Withdrawn', removed: 'Removed',
};

let token = '';
try { token = sessionStorage.getItem(TOKEN_KEY) || ''; } catch { /* the token is not remembered */ }

// ------------------------------------------------------------------ helpers

/** Element builder: h('td', { className: 'num' }, 'text', otherNode). Text only, never HTML. */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'className' || key === 'textContent' || key === 'type' || key === 'disabled' || key === 'hidden' || key === 'colSpan' || key === 'href') node[key] = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

const when = (iso) => (iso ? new Date(iso).toLocaleString() : '-');
const coords = (lat, lng) => `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

let messageTimer = null;
function say(text, tone = '') {
  const box = $('msg');
  clearTimeout(messageTimer);
  box.textContent = text || '';
  box.hidden = !text;
  box.className = `msg ${tone}`.trim();
  box.setAttribute('role', tone === 'err' ? 'alert' : 'status');
  if (text && tone === 'ok') messageTimer = setTimeout(() => say(''), 6000);
}

class Unauthorized extends Error {}

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch {
    throw new Error('The backend could not be reached. Check that it is running, then try again.');
  }
  const json = await res.json().catch(() => null);
  if (res.status === 401) throw new Unauthorized(json && json.error);
  if (!res.ok) {
    if (json && json.code === 'DATABASE_UNAVAILABLE') throw new Error('The database is not connected, so this section has no data. Check MONGODB_URI and the database.');
    throw new Error((json && json.error) || `Request failed (HTTP ${res.status}).`);
  }
  return json;
}

/** Runs an action; an expired or wrong token signs out, any other failure is shown. */
async function guarded(action, onError) {
  try {
    return await action();
  } catch (err) {
    if (err instanceof Unauthorized) { signOut('The admin token was not accepted. Sign in again.'); return undefined; }
    if (onError) onError(err); else say(err.message, 'err');
    return undefined;
  }
}

function skeleton(container, text = 'Loading...') {
  container.replaceChildren(h('p', { className: 'skeleton', role: 'status' }, text));
}
function empty(container, title, text) {
  container.replaceChildren(h('div', { className: 'empty' }, h('strong', {}, title), text));
}
function failure(container, err) {
  container.replaceChildren(h('div', { className: 'empty', role: 'alert' }, h('strong', {}, 'Could not load this section'), err.message));
}

function pager(container, { page, total }, go) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  container.replaceChildren(
    h('span', {}, total ? `Page ${page} of ${pages} - ${total} in total` : 'Nothing to page'),
    h(
      'div',
      { className: 'actions' },
      h('button', {
        type: 'button', className: 'btn btn-sm', disabled: page <= 1, 'aria-label': 'Previous page', onClick: () => go(page - 1),
      }, 'Previous'),
      h('button', {
        type: 'button', className: 'btn btn-sm', disabled: page >= pages, 'aria-label': 'Next page', onClick: () => go(page + 1),
      }, 'Next'),
    ),
  );
}

function table(caption, headers, rows) {
  return h(
    'table',
    {},
    h('caption', {}, caption),
    h('thead', {}, h('tr', {}, headers.map((t) => h('th', { scope: 'col' }, t)))),
    h('tbody', {}, rows),
  );
}

// ------------------------------------------------------------------ sign in

function signOut(reason = '') {
  token = '';
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* nothing stored */ }
  $('app').hidden = true;
  $('signout').hidden = true;
  $('login').hidden = false;
  $('token').value = '';
  const box = $('login-msg');
  box.textContent = reason;
  box.hidden = !reason;
  box.className = 'msg err';
  $('token').focus();
}

async function signIn(candidate) {
  const box = $('login-msg');
  box.hidden = true;
  token = candidate;
  try {
    await api('/api/v1/admin/overview');
  } catch (err) {
    token = '';
    let text = err.message;
    if (err instanceof Unauthorized) text = 'That token was not accepted.';
    else if (/disabled/i.test(text)) text = 'Administration is turned off on the server: set NAV_ADMIN_TOKEN in backend/.env and restart.';
    box.textContent = text;
    box.className = 'msg err';
    box.hidden = false;
    return;
  }
  try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* the token is not remembered */ }
  $('login').hidden = true;
  $('app').hidden = false;
  $('signout').hidden = false;
  activate('overview');
}

// --------------------------------------------------------------------- tabs

const TABS = ['overview', 'reports', 'features', 'places', 'users', 'map'];
const loaders = {};

function activate(name, { focus = false } = {}) {
  for (const id of TABS) {
    const selected = id === name;
    const tab = $(`tab-${id}`);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(`panel-${id}`).hidden = !selected;
    if (selected && focus) tab.focus();
  }
  say('');
  if (loaders[name]) loaders[name]();
}

function wireTabs() {
  const tabs = TABS.map((id) => $(`tab-${id}`));
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => activate(TABS[i]));
    tab.addEventListener('keydown', (e) => {
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      activate(TABS[(next + tabs.length) % tabs.length], { focus: true });
    });
  });
}

// ----------------------------------------------------------------- overview

function statusCard(title, level, label, detail, extra = null) {
  return h(
    'div',
    { className: 'stat' },
    h('h3', {}, title, h('span', { className: `pill pill-${level}` }, label)),
    h('div', { className: 'detail' }, detail),
    extra,
  );
}

function numberCard(title, value, detail) {
  return h('div', { className: 'stat' }, h('h3', {}, title), h('div', { className: 'big' }, String(value)), h('div', { className: 'detail' }, detail));
}

const unavailable = (title) => statusCard(title, 'off', 'No data', 'The database is not connected.');

function renderOverview(o) {
  const sys = o.system || {};
  const g = sys.geoapify || {};
  const osrm = sys.osrm || {};
  const routing = sys.routing || {};
  const db = sys.database === 'connected';
  const cards = [];

  cards.push(statusCard('API server', 'ok', 'Running', `Data as of ${when(o.generatedAt)}.`));
  cards.push(db
    ? statusCard('Database', 'ok', 'Connected', 'Accounts, reports, road features and places are stored.')
    : statusCard('Database', 'bad', 'Not connected', 'Set MONGODB_URI in backend/.env and restart. Accounts, reports, road features and places need it.'));

  cards.push(statusCard('Map (OpenFreeMap)', 'ok', 'No key needed', 'Vector tiles from OpenFreeMap, drawn in the browser. The map is fixed to the Kurdistan Region.'));

  if (!g.enabled) {
    cards.push(statusCard('Search and routes (Geoapify)', osrm.enabled ? 'warn' : 'bad', 'Not configured', 'Set GEOAPIFY_API_KEY in backend/.env. Search and nearby places stay off until then.'));
  } else {
    const open = g.circuit === 'open';
    const budget = g.dailyBudget || {};
    const meter = budget.limit
      ? h('meter', {
        min: 0, max: budget.limit, value: budget.usedToday, low: budget.limit * 0.7, high: budget.limit * 0.9, optimum: 0, 'aria-label': 'Daily provider credits used',
      })
      : null;
    const detail = [
      budget.limit ? `This server used ${budget.usedToday} of its ${budget.limit} daily credits (resets 00:00 UTC).` : `This server used ${budget.usedToday || 0} credits today, no daily limit.`,
      g.lastError ? `Last error: ${g.lastError}.` : '',
    ].filter(Boolean).join(' ');
    cards.push(statusCard('Search and routes (Geoapify)', open ? 'bad' : (g.lastError ? 'warn' : 'ok'), open ? 'Paused after errors' : 'Working', detail, meter));
  }

  if (!routing.enabled) {
    cards.push(statusCard('Routing', 'bad', 'Off', 'Set GEOAPIFY_API_KEY, or ROUTING_OSRM_URL for your own routing server.'));
  } else {
    const own = routing.provider === 'osrm';
    cards.push(statusCard('Routing', 'ok', own ? 'Own OSRM server' : 'Geoapify', own ? 'Routes come from the OSRM server set in ROUTING_OSRM_URL.' : 'Up to three different routes per request. Times are free-flow: no provider traffic.'));
  }

  const tr = o.traffic || {};
  if (!tr.monitoredIntersections) cards.push(statusCard('Live camera feed', 'off', 'None set up', 'No intersections are configured.'));
  else if (tr.live === 0) cards.push(statusCard('Live camera feed', 'warn', 'No live data', `${tr.monitoredIntersections} intersections, none sending data now.`));
  else cards.push(statusCard('Live camera feed', tr.live === tr.monitoredIntersections ? 'ok' : 'warn', `${tr.live} of ${tr.monitoredIntersections} live`, `${tr.stale} stale, ${tr.noData} without data.`));

  if (sys.deviceTokens === 'ephemeral-secret') {
    cards.push(statusCard('Sign-in secrets', 'warn', 'Temporary', 'DEVICE_TOKEN_SECRET or USER_TOKEN_SECRET is not set: everyone is signed out at each restart.'));
  } else {
    cards.push(statusCard('Sign-in secrets', 'ok', 'Configured', 'Device and user tokens survive restarts.'));
  }
  $('status-cards').replaceChildren(...cards);

  const stats = [];
  const u = o.users;
  stats.push(u.available ? numberCard('Users', u.total, `${u.last7Days} new in the last 7 days`) : unavailable('Users'));
  const r = o.reports;
  if (r.available) {
    const by = r.activeByType || {};
    const types = Object.keys(by).map((k) => `${by[k]} ${(TYPE_LABEL[k] || k).toLowerCase()}`).join(', ');
    stats.push(numberCard('Active driver reports', (r.byStatus || {}).active || 0, types || 'No active reports right now.'));
  } else stats.push(unavailable('Driver reports'));
  const f = o.roadFeatures;
  if (f.available) {
    const kinds = Object.keys(f.byKind || {}).map((k) => `${f.byKind[k]} ${(KIND_LABEL[k] || k).toLowerCase()}`).join(', ');
    stats.push(numberCard('Road features shown', f.active, `${f.total} in total${kinds ? `: ${kinds}` : ''}`));
  } else stats.push(unavailable('Road features'));
  const lp = o.localPlaces;
  if (lp && lp.available) {
    const cats = Object.keys(lp.byCategory || {}).map((k) => `${lp.byCategory[k]} ${(PLACE_LABEL[k] || k).toLowerCase()}`).join(', ');
    stats.push(numberCard('Places shown', lp.active, `${lp.total} in total${cats ? `: ${cats}` : ''}`));
  } else stats.push(unavailable('Places'));
  $('stat-cards').replaceChildren(...stats);
  $('overview-time').textContent = `Updated ${when(o.generatedAt)}.`;
}

loaders.overview = async () => {
  $('status-cards').replaceChildren(h('p', { className: 'skeleton' }, 'Loading...'));
  const data = await guarded(() => api('/api/v1/admin/overview'), (err) => {
    $('status-cards').replaceChildren(h('div', { className: 'empty', role: 'alert' }, h('strong', {}, 'Could not load the overview'), err.message));
    $('stat-cards').replaceChildren();
  });
  if (data) renderOverview(data);
};

// ------------------------------------------------------------------ reports

const reportsState = { page: 1 };

async function moderate(report, change, done) {
  await guarded(async () => {
    await api(`/api/v1/reports/${encodeURIComponent(report.id)}`, { method: 'PATCH', body: change });
    say(`${TYPE_LABEL[report.type] || 'Report'}: ${done}.`, 'ok');
    await loaders.reports();
  });
}

function reportRow(r) {
  const button = (text, label, onClick, cls = '') => h('button', {
    type: 'button', className: `btn btn-sm ${cls}`.trim(), 'aria-label': `${label}: ${TYPE_LABEL[r.type] || r.type} at ${coords(r.lat, r.lng)}`, onClick,
  }, text);
  const actions = [];
  if (r.verification !== 'verified') actions.push(button('Verify', 'Mark as verified', () => moderate(r, { verification: 'verified' }, 'marked as verified')));
  if (r.status === 'active') {
    actions.push(button('Resolve', 'Mark as resolved', () => moderate(r, { status: 'resolved' }, 'marked as resolved')));
    actions.push(button('Remove', 'Remove', () => moderate(r, { status: 'removed' }, 'removed from the map'), 'btn-danger'));
  } else if (r.status !== 'withdrawn') {
    actions.push(button('Reactivate', 'Show again', () => moderate(r, { status: 'active' }, 'shown again')));
  }
  return h(
    'tr',
    {},
    h('td', {}, h('strong', {}, TYPE_LABEL[r.type] || r.type), h('div', { className: 'sub' }, r.description || 'No description')),
    h('td', { className: 'num' }, coords(r.lat, r.lng)),
    h('td', {}, STATUS_LABEL[r.status] || r.status),
    h('td', {}, r.verification === 'verified' ? 'Verified' : 'Not verified'),
    h('td', { className: 'num' }, `${r.confirmations} confirm, ${r.dismissals} dismiss`),
    h('td', {}, when(r.createdAt), h('div', { className: 'sub' }, `Expires ${when(r.expiresAt)}`)),
    h('td', {}, h('div', { className: 'row-actions' }, actions)),
  );
}

loaders.reports = async () => {
  const box = $('reports-table');
  skeleton(box);
  const params = new URLSearchParams({ page: reportsState.page, limit: PAGE_SIZE });
  if ($('reports-status').value) params.set('status', $('reports-status').value);
  if ($('reports-type').value) params.set('type', $('reports-type').value);
  const data = await guarded(() => api(`/api/v1/admin/reports?${params}`), (err) => { failure(box, err); $('reports-pager').replaceChildren(); });
  if (!data) return;
  if (!data.reports.length) {
    empty(box, 'No reports match', $('reports-status').value || $('reports-type').value ? 'Try another status or type.' : 'Drivers have not sent any reports yet.');
  } else {
    box.replaceChildren(table(`${data.total} driver reports, newest first`, ['Report', 'Where', 'Status', 'Check', 'Driver votes', 'When', 'Actions'], data.reports.map(reportRow)));
  }
  pager($('reports-pager'), data, (p) => { reportsState.page = p; loaders.reports(); });
};

// ----------------------------------------------------------- road features

const featuresState = { page: 1 };
let editing = null; // the feature being edited, or null for a new one

async function featureAction(feature, request, done) {
  await guarded(async () => {
    await api(`/api/v1/road-features/${encodeURIComponent(feature.id)}`, request);
    say(`${KIND_LABEL[feature.kind] || 'Feature'}: ${done}.`, 'ok');
    await loaders.features();
  });
}

function featureRow(f) {
  const label = (what) => `${what}: ${KIND_LABEL[f.kind] || f.kind} at ${coords(f.lat, f.lng)}`;
  const buttons = [
    h('button', { type: 'button', className: 'btn btn-sm', 'aria-label': label('Edit'), onClick: () => openFeatureDialog(f) }, 'Edit'),
    h('button', {
      type: 'button',
      className: 'btn btn-sm',
      'aria-label': label(f.active ? 'Hide from drivers' : 'Show to drivers'),
      onClick: () => featureAction(f, { method: 'PATCH', body: { active: !f.active } }, f.active ? 'hidden from drivers' : 'shown to drivers'),
    }, f.active ? 'Hide' : 'Show'),
    h('button', {
      type: 'button',
      className: 'btn btn-sm btn-danger',
      'aria-label': label('Delete'),
      onClick: () => { if (window.confirm(`Delete this ${(KIND_LABEL[f.kind] || 'feature').toLowerCase()} permanently?`)) featureAction(f, { method: 'DELETE' }, 'deleted'); },
    }, 'Delete'),
  ];
  const details = [f.speedLimitKmh ? `${f.speedLimitKmh} km/h` : null, f.direction !== null && f.direction !== undefined ? `direction ${f.direction} degrees` : null, f.validUntil ? `until ${when(f.validUntil)}` : null]
    .filter(Boolean).join(' - ');
  return h(
    'tr',
    {},
    h('td', {}, h('strong', {}, f.name || KIND_LABEL[f.kind] || f.kind), h('div', { className: 'sub' }, KIND_LABEL[f.kind] || f.kind)),
    h('td', { className: 'num' }, coords(f.lat, f.lng)),
    h('td', {}, details || '-', f.description ? h('div', { className: 'sub' }, f.description) : null),
    h('td', {}, h('span', { className: `pill ${f.active ? 'pill-ok' : 'pill-off'}` }, f.active ? 'Shown' : 'Hidden')),
    h('td', {}, when(f.updatedAt)),
    h('td', {}, h('div', { className: 'row-actions' }, buttons)),
  );
}

loaders.features = async () => {
  const box = $('features-table');
  skeleton(box);
  const params = new URLSearchParams({ page: featuresState.page, limit: PAGE_SIZE });
  if ($('features-kind').value) params.set('kind', $('features-kind').value);
  if ($('features-active').value) params.set('active', $('features-active').value);
  const data = await guarded(() => api(`/api/v1/admin/road-features?${params}`), (err) => { failure(box, err); $('features-pager').replaceChildren(); });
  if (!data) return;
  if (!data.features.length) {
    empty(box, 'No road features', $('features-kind').value || $('features-active').value ? 'Try other filters.' : 'Add the first speed camera, bump or closure with "Add road feature".');
  } else {
    box.replaceChildren(table(`${data.total} road features, newest first`, ['Feature', 'Where', 'Details', 'Visibility', 'Updated', 'Actions'], data.features.map(featureRow)));
  }
  pager($('features-pager'), data, (p) => { featuresState.page = p; loaders.features(); });
};

function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openFeatureDialog(feature = null, point = null) {
  editing = feature;
  $('feature-dialog-title').textContent = feature ? 'Edit road feature' : 'Add road feature';
  $('f-kind').value = feature ? feature.kind : 'speed_camera';
  $('f-name').value = feature && feature.name ? feature.name : '';
  $('f-lat').value = feature ? feature.lat : (point ? point.lat.toFixed(6) : '');
  $('f-lng').value = feature ? feature.lng : (point ? point.lng.toFixed(6) : '');
  $('f-speed').value = feature && feature.speedLimitKmh ? feature.speedLimitKmh : '';
  $('f-direction').value = feature && feature.direction !== null && feature.direction !== undefined ? feature.direction : '';
  $('f-description').value = feature && feature.description ? feature.description : '';
  $('f-until').value = feature ? toLocalInput(feature.validUntil) : '';
  $('f-active').checked = feature ? feature.active : true;
  const box = $('feature-msg');
  box.hidden = true;
  $('feature-dialog').showModal();
  $('f-kind').focus();
}

/** The form as the API wants it; null and a message when a value is not usable. */
function featureFromForm() {
  const number = (id) => (($(id).value || '').trim() === '' ? null : Number($(id).value));
  const lat = number('f-lat');
  const lng = number('f-lng');
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return { error: 'Latitude must be a number between -90 and 90.' };
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return { error: 'Longitude must be a number between -180 and 180.' };
  const speed = number('f-speed');
  if (speed !== null && (!Number.isInteger(speed) || speed < 5 || speed > 200)) return { error: 'Speed limit must be a whole number from 5 to 200.' };
  const direction = number('f-direction');
  if (direction !== null && (!Number.isFinite(direction) || direction < 0 || direction > 359.9)) return { error: 'Direction must be between 0 and 359.9 degrees.' };
  const until = $('f-until').value ? new Date($('f-until').value) : null;
  if (until && Number.isNaN(until.getTime())) return { error: 'The end date is not valid.' };
  const value = {
    kind: $('f-kind').value,
    lat,
    lng,
    name: $('f-name').value.trim() || null,
    description: $('f-description').value.trim() || null,
    speedLimitKmh: speed,
    direction,
    validUntil: until ? until.toISOString() : null,
    active: $('f-active').checked,
  };
  return { value };
}

async function saveFeature(event) {
  event.preventDefault();
  const box = $('feature-msg');
  const { value, error } = featureFromForm();
  if (error) { box.textContent = error; box.hidden = false; box.className = 'msg err'; return; }
  const save = $('feature-save');
  save.disabled = true;
  await guarded(async () => {
    await api(editing ? `/api/v1/road-features/${encodeURIComponent(editing.id)}` : '/api/v1/road-features', { method: editing ? 'PATCH' : 'POST', body: value });
    $('feature-dialog').close();
    say(`${KIND_LABEL[value.kind]} ${editing ? 'saved' : 'added'}.`, 'ok');
    await Promise.all([loaders.features(), mapState.map ? loaders.map() : null]);
  }, (err) => { box.textContent = err.message; box.hidden = false; box.className = 'msg err'; });
  save.disabled = false;
}

// ------------------------------------------------------------------- places

const placesState = { page: 1 };
let editingPlace = null; // the place being edited, or null for a new one

async function placeAction(place, request, done) {
  await guarded(async () => {
    await api(`/api/v1/places/local/${encodeURIComponent(place.id)}`, request);
    say(`${place.name}: ${done}.`, 'ok');
    await loaders.places();
  });
}

function placeRow(p) {
  const label = (what) => `${what}: ${p.name}`;
  const others = [p.nameAr, p.nameKu].filter(Boolean);
  return h(
    'tr',
    {},
    h('td', {}, h('strong', {}, p.name), others.length ? h('div', { className: 'sub', dir: 'auto' }, others.join(' / ')) : null),
    h('td', {}, PLACE_LABEL[p.category] || p.category),
    h('td', { className: 'num' }, coords(p.lat, p.lng)),
    h('td', {}, p.description || '-'),
    h('td', {}, h('span', { className: `pill ${p.active ? 'pill-ok' : 'pill-off'}` }, p.active ? 'Shown' : 'Hidden')),
    h('td', {}, when(p.updatedAt)),
    h('td', {}, h('div', { className: 'row-actions' }, [
      h('button', { type: 'button', className: 'btn btn-sm', 'aria-label': label('Edit'), onClick: () => openPlaceDialog(p) }, 'Edit'),
      h('button', {
        type: 'button',
        className: 'btn btn-sm',
        'aria-label': label(p.active ? 'Hide from drivers' : 'Show to drivers'),
        onClick: () => placeAction(p, { method: 'PATCH', body: { active: !p.active } }, p.active ? 'hidden from drivers' : 'shown to drivers'),
      }, p.active ? 'Hide' : 'Show'),
      h('button', {
        type: 'button',
        className: 'btn btn-sm btn-danger',
        'aria-label': label('Delete'),
        onClick: () => { if (window.confirm(`Delete "${p.name}" permanently?`)) placeAction(p, { method: 'DELETE' }, 'deleted'); },
      }, 'Delete'),
    ])),
  );
}

loaders.places = async () => {
  const box = $('places-table');
  skeleton(box);
  const params = new URLSearchParams({ page: placesState.page, limit: PAGE_SIZE });
  if ($('places-category').value) params.set('category', $('places-category').value);
  if ($('places-active').value) params.set('active', $('places-active').value);
  const data = await guarded(() => api(`/api/v1/admin/places?${params}`), (err) => { failure(box, err); $('places-pager').replaceChildren(); });
  if (!data) return;
  if (!data.places.length) {
    empty(box, 'No places', $('places-category').value || $('places-active').value ? 'Try other filters.' : 'Add the first hospital, mosque or landmark with "Add place".');
  } else {
    box.replaceChildren(table(`${data.total} places, newest first`, ['Place', 'Category', 'Where', 'Description', 'Visibility', 'Updated', 'Actions'], data.places.map(placeRow)));
  }
  pager($('places-pager'), data, (p) => { placesState.page = p; loaders.places(); });
};

function openPlaceDialog(place = null, point = null) {
  editingPlace = place;
  $('place-dialog-title').textContent = place ? 'Edit place' : 'Add place';
  $('p-name').value = place ? place.name : '';
  $('p-name-ar').value = place && place.nameAr ? place.nameAr : '';
  $('p-name-ku').value = place && place.nameKu ? place.nameKu : '';
  $('p-category').value = place ? place.category : 'landmark';
  $('p-lat').value = place ? place.lat : (point ? point.lat.toFixed(6) : '');
  $('p-lng').value = place ? place.lng : (point ? point.lng.toFixed(6) : '');
  $('p-description').value = place && place.description ? place.description : '';
  $('p-active').checked = place ? place.active : true;
  $('place-msg').hidden = true;
  $('place-dialog').showModal();
  $('p-name').focus();
}

/** The form as the API wants it; an error message when a value is not usable. */
function placeFromForm() {
  const lat = Number($('p-lat').value);
  const lng = Number($('p-lng').value);
  const name = $('p-name').value.trim();
  if (!name) return { error: 'Give the place a name.' };
  if ($('p-lat').value.trim() === '' || !Number.isFinite(lat) || lat < -90 || lat > 90) return { error: 'Latitude must be a number between -90 and 90.' };
  if ($('p-lng').value.trim() === '' || !Number.isFinite(lng) || lng < -180 || lng > 180) return { error: 'Longitude must be a number between -180 and 180.' };
  return {
    value: {
      name,
      nameAr: $('p-name-ar').value.trim() || null,
      nameKu: $('p-name-ku').value.trim() || null,
      category: $('p-category').value,
      lat,
      lng,
      description: $('p-description').value.trim() || null,
      active: $('p-active').checked,
    },
  };
}

async function savePlace(event) {
  event.preventDefault();
  const box = $('place-msg');
  const { value, error } = placeFromForm();
  if (error) { box.textContent = error; box.hidden = false; box.className = 'msg err'; return; }
  const save = $('place-save');
  save.disabled = true;
  await guarded(async () => {
    await api(editingPlace ? `/api/v1/places/local/${encodeURIComponent(editingPlace.id)}` : '/api/v1/places/local', { method: editingPlace ? 'PATCH' : 'POST', body: value });
    $('place-dialog').close();
    say(`${value.name} ${editingPlace ? 'saved' : 'added'}.`, 'ok');
    await Promise.all([loaders.places(), mapState.map ? loaders.map() : null]);
  }, (err) => { box.textContent = err.message; box.hidden = false; box.className = 'msg err'; });
  save.disabled = false;
}

// -------------------------------------------------------------------- users

const usersState = { page: 1, q: '' };

loaders.users = async () => {
  const box = $('users-table');
  skeleton(box);
  const params = new URLSearchParams({ page: usersState.page, limit: PAGE_SIZE });
  if (usersState.q) params.set('q', usersState.q);
  const data = await guarded(() => api(`/api/v1/admin/users?${params}`), (err) => { failure(box, err); $('users-pager').replaceChildren(); });
  if (!data) return;
  if (!data.users.length) {
    empty(box, usersState.q ? 'No user starts with that' : 'No users yet', usersState.q ? 'Check the spelling, or clear the search.' : 'Accounts appear here when people sign up in the app.');
  } else {
    box.replaceChildren(table(`${data.total} users, newest first`, ['Email', 'Name', 'Joined'], data.users.map((u) => h('tr', {}, h('td', {}, u.email), h('td', {}, u.name || '-'), h('td', {}, when(u.createdAt))))));
  }
  pager($('users-pager'), data, (p) => { usersState.page = p; loaders.users(); });
};

// ---------------------------------------------------------------------- map

// One GeoJSON source and one circle layer per kind of point; they are updated, never rebuilt.
const MAP_POINTS = { feature: '#1f6feb', report: '#f08c2e', place: '#2ea043' };
const mapState = { map: null, ready: null };

function ensureMap() {
  if (mapState.ready) return mapState.ready;
  mapState.ready = (async () => {
    const base = createBaseMap($('admin-map'), await loadMapConfig(), { navigation: true });
    if (!base) return null;
    const map = await base.loaded;
    for (const [id, color] of Object.entries(MAP_POINTS)) {
      map.addSource(id, { type: 'geojson', data: featureCollection([]) });
      map.addLayer({
        id: `pts-${id}`,
        type: 'circle',
        source: id,
        paint: {
          'circle-radius': 9, 'circle-color': color, 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff',
        },
      });
      map.on('click', `pts-${id}`, (e) => {
        const f = e.features[0];
        const p = f.properties;
        new Popup({ offset: 12 }).setLngLat(f.geometry.coordinates).setDOMContent(
          h('div', {}, h('strong', {}, p.title), h('div', { className: 'sub' }, p.line1 || ''), p.line2 ? h('div', { className: 'sub' }, p.line2) : null),
        ).addTo(map);
      });
      map.on('mouseenter', `pts-${id}`, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', `pts-${id}`, () => { map.getCanvas().style.cursor = ''; });
    }
    map.on('click', (e) => {
      if (map.queryRenderedFeatures(e.point, { layers: Object.keys(MAP_POINTS).map((k) => `pts-${k}`) }).length) return;
      const point = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      const popup = new Popup({ offset: 6 });
      const add = (text, open) => h('button', { type: 'button', className: 'btn btn-sm btn-primary', onClick: () => { popup.remove(); open(point); } }, text);
      popup.setLngLat([point.lng, point.lat]).setDOMContent(h(
        'div',
        { className: 'map-add' },
        h('div', { className: 'sub' }, coords(point.lat, point.lng)),
        add('Add road feature here', (p) => openFeatureDialog(null, p)),
        add('Add place here', (p) => openPlaceDialog(null, p)),
      )).addTo(map);
    });
    mapState.map = map;
    return map;
  })();
  return mapState.ready;
}

const pointFeature = (lng, lat, properties) => ({
  type: 'Feature', properties, geometry: { type: 'Point', coordinates: [lng, lat] },
});

loaders.map = async () => {
  const map = await ensureMap();
  if (!map) return;
  map.resize();
  const [features, reports, places] = await Promise.all([
    guarded(() => api('/api/v1/admin/road-features?active=true&limit=100')),
    guarded(() => api('/api/v1/admin/reports?status=active&limit=100')),
    guarded(() => api('/api/v1/admin/places?active=true&limit=100')),
  ]);
  const sets = {
    feature: ((features && features.features) || []).map((f) => pointFeature(f.lng, f.lat, {
      title: f.name || KIND_LABEL[f.kind] || f.kind, line1: `${KIND_LABEL[f.kind] || f.kind}${f.speedLimitKmh ? `, ${f.speedLimitKmh} km/h` : ''}`,
    })),
    report: ((reports && reports.reports) || []).map((r) => pointFeature(r.lng, r.lat, {
      title: TYPE_LABEL[r.type] || r.type, line1: r.description || 'No description', line2: `Reported ${when(r.createdAt)}`,
    })),
    place: ((places && places.places) || []).map((p) => pointFeature(p.lng, p.lat, {
      title: p.name, line1: PLACE_LABEL[p.category] || p.category, line2: p.description || '',
    })),
  };
  for (const [id, list] of Object.entries(sets)) map.getSource(id).setData(featureCollection(list));
  const all = Object.values(sets).flat().map((f) => f.geometry.coordinates);
  if (all.length) {
    const lngs = all.map((c) => c[0]);
    const lats = all.map((c) => c[1]);
    map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: 40, maxZoom: 15, duration: 0 });
  }
};

// --------------------------------------------------------------------- boot

function boot() {
  wireTabs();
  $('login-form').addEventListener('submit', (e) => { e.preventDefault(); signIn($('token').value.trim()); });
  $('signout').addEventListener('click', () => signOut(''));
  $('overview-refresh').addEventListener('click', () => loaders.overview());
  $('reports-refresh').addEventListener('click', () => loaders.reports());
  $('features-refresh').addEventListener('click', () => loaders.features());
  $('places-refresh').addEventListener('click', () => loaders.places());
  $('users-refresh').addEventListener('click', () => loaders.users());
  for (const id of ['places-category', 'p-category']) {
    const select = $(id);
    for (const c of PLACE_CATEGORIES) select.append(h('option', { value: c }, PLACE_LABEL[c]));
  }
  $('places-filters').addEventListener('change', () => { placesState.page = 1; loaders.places(); });
  $('place-add').addEventListener('click', () => openPlaceDialog());
  $('place-form').addEventListener('submit', savePlace);
  $('place-cancel').addEventListener('click', () => $('place-dialog').close());
  $('map-refresh').addEventListener('click', () => loaders.map());
  $('reports-filters').addEventListener('change', () => { reportsState.page = 1; loaders.reports(); });
  $('features-filters').addEventListener('change', () => { featuresState.page = 1; loaders.features(); });
  $('users-filters').addEventListener('submit', (e) => { e.preventDefault(); usersState.q = $('users-q').value.trim(); usersState.page = 1; loaders.users(); });
  $('feature-add').addEventListener('click', () => openFeatureDialog());
  $('feature-form').addEventListener('submit', saveFeature);
  $('feature-cancel').addEventListener('click', () => $('feature-dialog').close());
  if (token) signIn(token); else $('token').focus();
}

boot();
