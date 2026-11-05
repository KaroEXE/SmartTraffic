/* global L */
/**
 * Road report review (admin.html). Lists driver reports and approves or
 * rejects them through /api/admin/hazard-reports. The token is kept only for
 * this browser tab (sessionStorage). All report text is inserted as text,
 * never as HTML.
 */
(function adminPage() {
  const TOKEN_KEY = 'smartTraffic.adminToken';
  const LABEL = { speed_camera: 'Speed camera', speed_bump: 'Speed bump', road_closure: 'Road closure' };
  const STATUS = { pending: 'Waiting for review', approved: 'Approved - shown on the map', rejected: 'Rejected' };
  const $ = (id) => document.getElementById(id);

  let token = '';
  try { token = sessionStorage.getItem(TOKEN_KEY) || ''; } catch { /* not remembered */ }
  $('ad-token').value = token;

  const map = L.map('ad-map').setView([36.0, 44.3], 7); // whole Kurdistan Region
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  const markers = L.layerGroup().addTo(map);

  function message(text, isError = false) {
    const el = $('ad-msg');
    el.textContent = text;
    el.hidden = !text;
    el.classList.toggle('ad-err', isError);
  }

  async function api(path, method = 'GET') {
    const res = await fetch(`/api/admin/hazard-reports${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `Request failed (HTTP ${res.status})`);
    return json;
  }

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const c of children) node.append(c);
    return node;
  }

  function render(reports) {
    const list = $('ad-list');
    list.replaceChildren();
    markers.clearLayers();
    if (!reports.length) {
      list.append(el('li', { className: 'ad-meta', textContent: 'No reports in this list.' }));
      return;
    }
    const points = [];
    for (const r of reports) {
      const item = el('li', { className: 'ad-item' });
      const actions = el('div', { className: 'ad-actions' });
      const button = (text, cls, action) => {
        const b = el('button', { type: 'button', className: cls, textContent: text });
        b.addEventListener('click', () => act(r.id, action, actions));
        actions.append(b);
      };
      if (r.status !== 'approved') button('Approve and publish', 'ad-ok', 'approve');
      if (r.status !== 'rejected') button(r.status === 'approved' ? 'Unpublish (reject)' : 'Reject', 'ad-no', 'reject');
      button('Delete', '', 'delete');
      const zoom = el('button', { type: 'button', textContent: 'Show on map' });
      zoom.addEventListener('click', () => { map.setView([r.lat, r.lng], 17); marker.openPopup(); });
      actions.prepend(zoom);

      item.append(
        el('h2', { textContent: LABEL[r.kind] || r.kind }),
        el('div', { className: 'ad-meta', textContent: `${STATUS[r.status]} · reported ${new Date(r.createdAt).toLocaleString()} · ${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}` }),
        el('div', { className: 'ad-note', textContent: r.note || '(no details given)' }),
        actions,
      );
      list.append(item);

      const marker = L.marker([r.lat, r.lng], { title: LABEL[r.kind] || r.kind })
        .bindPopup(el('div', { textContent: `${LABEL[r.kind] || r.kind}: ${r.note || 'no details'}` }))
        .addTo(markers);
      marker.on('click', () => {
        list.querySelectorAll('.ad-active').forEach((n) => n.classList.remove('ad-active'));
        item.classList.add('ad-active');
        item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
      points.push([r.lat, r.lng]);
    }
    map.fitBounds(L.latLngBounds(points), { padding: [30, 30], maxZoom: 15 });
  }

  async function load() {
    if (!token) { message('Enter the admin token to load reports.'); return; }
    message('Loading...');
    try {
      const { reports } = await api(`?status=${encodeURIComponent($('ad-status').value)}`);
      message('');
      render(reports);
      return true;
    } catch (err) {
      message(err.message, true);
      render([]);
      return false;
    }
  }

  async function act(id, action, actions) {
    if (action === 'delete' && !window.confirm('Delete this report permanently? This cannot be undone.')) return;
    actions.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      if (action === 'delete') await api(`/${encodeURIComponent(id)}`, 'DELETE');
      else await api(`/${encodeURIComponent(id)}/${action}`, 'POST');
      if (await load()) message(action === 'approve' ? 'Approved - the report is now shown on the navigation map.' : 'Done.');
    } catch (err) {
      message(err.message, true);
      actions.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    }
  }

  $('ad-login').addEventListener('submit', (e) => {
    e.preventDefault();
    token = $('ad-token').value.trim();
    try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* not remembered */ }
    load();
  });
  $('ad-status').addEventListener('change', load);
  $('ad-refresh').addEventListener('click', load);
  load();
}());
