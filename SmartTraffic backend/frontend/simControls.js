/**
 * Simulation controls (footer panel, shown only in Simulation mode).
 * Talks to the backend's /api/simulation endpoints; these can only change
 * the simulation, never live traffic.
 */

const API = '/api/simulation';
const STATE_LABEL = {
  stopped: 'STOPPED',
  running: 'RUNNING',
  paused: 'PAUSED',
  error: 'ERROR',
};

export class SimControls {
  /**
   * @param {() => string} getSelectedId  intersection that scenario buttons apply to
   * @param {(status) => void} onStatus   called with every status the backend returns
   */
  constructor(getSelectedId, onStatus = () => {}) {
    this.getSelectedId = getSelectedId;
    this.onStatus = onStatus;
    this.root = document.getElementById('sim');
    this.grid = document.getElementById('sim-grid');
    this.tour = document.getElementById('sim-tour');
    this.stateEl = document.getElementById('sim-state');
    this.startBtn = document.getElementById('sim-start');
    this.pauseBtn = document.getElementById('sim-pause');
    this.resetBtn = document.getElementById('sim-reset');
    this.status = null;
    this.built = false;

    this.startBtn.addEventListener('click', () => this._post('/start'));
    this.pauseBtn.addEventListener('click', () => this._post('/pause'));
    this.resetBtn.addEventListener('click', () => this._post('/reset'));
    this.tour.addEventListener('change', () => this._post('/tour', { intersectionId: this.getSelectedId(), enabled: this.tour.checked }));

    // Network-wide optimisation and the simulated emergency vehicle.
    this.network = document.getElementById('sim-network');
    this.ambHeading = document.getElementById('sim-amb-heading');
    this.ambGo = document.getElementById('sim-amb-go');
    this.ambCancel = document.getElementById('sim-amb-cancel');
    this.ambState = document.getElementById('sim-amb-state');
    if (this.network) {
      this.network.addEventListener('change', () => this._post('/network', { enabled: this.network.checked }));
      this.ambGo.addEventListener('click', () => this._post('/ambulance', { from: this.getSelectedId(), heading: this.ambHeading.value }));
      this.ambCancel.addEventListener('click', () => {
        const a = this.status && this.status.ambulances && this.status.ambulances[0];
        if (a) this._send('DELETE', `/ambulance/${encodeURIComponent(a.id)}`);
      });
    }
  }

  setActive(active) {
    this.root.hidden = !active;
    if (active) this.load();
  }

  async load() {
    try {
      const res = await fetch(`${API}/status`, { cache: 'no-store' });
      if (res.ok) this.onStatus(await res.json());
    } catch {
      this._showError('Simulation unavailable');
    }
  }

  refresh() {
    if (this.status) this.apply(this.status);
  }

  apply(status) {
    this.status = status;
    if (!this.built && status.scenarios) this._build(status.scenarios);

    const s = status.state;
    this.stateEl.textContent = STATE_LABEL[s] || String(s).toUpperCase();
    this.stateEl.className = `sim-state ${s}`;
    this.stateEl.title = status.error || '';
    this.startBtn.textContent = s === 'paused' ? 'Resume' : 'Start';
    this.startBtn.disabled = s === 'running';
    this.pauseBtn.disabled = s !== 'running';
    this.resetBtn.disabled = s === 'stopped';

    const ix = status.intersections ? status.intersections[this.getSelectedId()] : null;
    this.tour.checked = Boolean(ix && ix.tour);
    this.grid.querySelectorAll('.sim-btn').forEach((btn) => {
      btn.classList.toggle('current', Boolean(ix) && btn.dataset.id === ix.scenario);
    });
    this._applyNetwork(status);
  }

  _applyNetwork(status) {
    if (!this.network) return;
    if (status.network) this.network.checked = Boolean(status.network.enabled);
    const active = status.ambulances || [];
    this.ambCancel.hidden = !active.length;
    if (active.length) {
      const a = active[0];
      const wait = a.waiting ? ` · stopped (${a.waiting})` : '';
      this.ambState.textContent = `SIMULATED ${a.type.toUpperCase()} ${a.id}: ${a.distanceM} m to ${a.towards} · stops ${a.stops}${wait} · route ${a.route.join(' > ')}`;
    } else if (status.lastAmbulance) {
      const l = status.lastAmbulance;
      this.ambState.textContent = `Last ${l.type}: ${l.route.join(' > ')} in ${l.travelSeconds} s - ${l.stops} stop${l.stops === 1 ? '' : 's'}, ${l.delaySeconds} s delay vs free flow`;
    } else {
      this.ambState.textContent = 'Dispatch sends a simulated ambulance from the selected intersection; the corridor prepares the next 3 intersections on its route.';
    }
  }

  _build(scenarios) {
    this.built = true;
    this.grid.innerHTML = '';
    scenarios.forEach((s, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sim-btn';
      btn.dataset.id = s.id;
      const key = document.createElement('span');
      key.className = 'k';
      key.textContent = String(i + 1);
      const label = document.createElement('span');
      label.textContent = s.label;
      btn.append(key, label);
      btn.addEventListener('click', () => this._post('/scenario', { intersectionId: this.getSelectedId(), scenario: s.id }));
      this.grid.appendChild(btn);
    });
  }

  _post(path, body) {
    return this._send('POST', path, body);
  }

  async _send(method, path, body) {
    try {
      const res = await fetch(`${API}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'DELETE' ? undefined : JSON.stringify(body || {}),
      });
      const data = await res.json();
      if (res.ok) this.onStatus(data);
      else this._showError(data.error || `Request failed (${res.status})`);
    } catch {
      this._showError('Simulation unavailable');
    }
  }

  _showError(message) {
    this.stateEl.textContent = 'UNAVAILABLE';
    this.stateEl.className = 'sim-state error';
    this.stateEl.title = message;
  }
}
