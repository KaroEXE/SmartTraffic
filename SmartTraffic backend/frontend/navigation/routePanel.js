import {
  directionLabel, escapeHtml, formatAge, formatClock, formatDelay, formatDistance, formatDuration,
} from './format.js';

/**
 * Bottom sheet (mobile) / side panel (desktop): live-feed status, route
 * options, per-route traffic information and rerouting suggestions.
 *
 * Wording rule: a time is called live-traffic based only when the backend
 * supplied a valid adjustment (route.traffic). Otherwise it is the routing
 * provider's base estimate and says so.
 */

const TYPE_LABEL = { ambulance: 'ambulance', police: 'police vehicle', fire_truck: 'fire truck' };

const ROUTING_NOTE = {
  'not-configured': 'Live traffic data unavailable for route times. Showing ordinary routing estimates (OpenStreetMap / OSRM).',
  unavailable: 'Live traffic data unavailable: SmartTraffic could not adjust route times. Showing ordinary routing estimates.',
  partial: 'Live traffic adjustments are available for some routes only, so routes are ranked by base estimate.',
  backend: 'Times include live AI traffic adjustments from SmartTraffic.',
};

const STATUS_WORD = { live: 'live', stale: 'no recent data', 'no-data': 'no data yet', offline: 'last known' };

export class RoutePanel {
  constructor({ root, toggle, feed, body, onSelect, onRetry, onSwitch, onDismiss }) {
    this.root = root;
    this.toggle = toggle;
    this.feedEl = feed;
    this.onSelect = onSelect;
    this.onRetry = onRetry;
    this.onSwitch = onSwitch;
    this.onDismiss = onDismiss;
    this.routes = [];
    this.selectedId = null;
    this.trafficEls = new Map();

    body.innerHTML = `<div class="nv-suggest" id="nv-suggest" role="alert" hidden></div>
      <div class="nv-msg" id="nv-msg"></div>
      <p class="nv-note" id="nv-route-note" hidden></p>
      <ul class="nv-warnings" id="nv-warnings" hidden></ul>
      <ol class="nv-routes" id="nv-routes" aria-label="Route options"></ol>`;
    this.suggestEl = body.querySelector('#nv-suggest');
    this.msgEl = body.querySelector('#nv-msg');
    this.noteEl = body.querySelector('#nv-route-note');
    this.warnEl = body.querySelector('#nv-warnings');
    this.listEl = body.querySelector('#nv-routes');

    toggle.addEventListener('click', () => this.setExpanded(this.root.hasAttribute('data-collapsed')));
    this.listEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-route]');
      if (btn) this.onSelect(btn.dataset.route);
    });
    this.msgEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="retry"]')) this.onRetry();
    });
    this.suggestEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const key = this.suggestEl.dataset.key;
      if (btn.dataset.action === 'switch') this.onSwitch(btn.dataset.route, key);
      this.onDismiss(key);
      this.clearSuggestion();
    });
  }

  setExpanded(expanded) {
    this.root.toggleAttribute('data-collapsed', !expanded);
    this.toggle.setAttribute('aria-expanded', String(expanded));
  }

  // ----------------------------------------------------------- feed status

  setFeed({ connection, total, live }) {
    let tone = 'off';
    let text;
    if (connection === 'unavailable') text = 'Live AI feed unavailable on this page. Route planning still works.';
    else if (connection === 'connecting') text = 'Connecting to the SmartTraffic live feed...';
    else if (connection !== 'connected') { tone = 'bad'; text = 'Live AI feed disconnected. Route planning still works; traffic markers show last known data.'; }
    else if (total === 0) text = 'Live AI feed connected. No monitored intersections are configured.';
    else if (live === 0) { tone = 'warn'; text = `Live AI feed connected. None of the ${total} monitored intersections is reporting right now.`; }
    else { tone = 'ok'; text = `Live AI: ${live} of ${total} monitored intersections reporting.`; }
    const html = `<span class="nv-dot nv-dot-${tone}" aria-hidden="true"></span><span>${escapeHtml(text)}
      <span class="nv-coverage">Live data covers monitored intersections only, not the whole city.</span></span>`;
    if (this.feedEl.innerHTML !== html) this.feedEl.innerHTML = html;
  }

  // -------------------------------------------------------------- messages

  showMessage(text, { tone = 'info', retry = false, busy = false } = {}) {
    this.routes = [];
    this.trafficEls.clear();
    this.listEl.innerHTML = '';
    this.noteEl.hidden = true;
    this.warnEl.hidden = true;
    this.clearSuggestion();
    this.msgEl.className = `nv-msg nv-msg-${tone}`;
    this.msgEl.innerHTML = `${busy ? '<span class="nv-spinner" aria-hidden="true"></span>' : ''}<span>${escapeHtml(text)}</span>${retry ? '<button type="button" class="nv-btn" data-action="retry">Try again</button>' : ''}`;
    this.msgEl.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    this.msgEl.hidden = false;
  }

  // ---------------------------------------------------------------- routes

  showRoutes({ routes, selectedId, fastestId, rankBasis, trafficRouting, snapWarnings }) {
    this.routes = routes;
    this.msgEl.hidden = true;
    this.clearSuggestion();

    const adjustedCount = routes.filter((r) => r.traffic).length;
    const noteKey = trafficRouting === 'backend'
      ? (adjustedCount === routes.length ? 'backend' : adjustedCount ? 'partial' : 'unavailable')
      : trafficRouting;
    this.noteEl.textContent = ROUTING_NOTE[noteKey] || ROUTING_NOTE['not-configured'];
    this.noteEl.className = `nv-note${noteKey === 'backend' ? ' nv-note-live' : ''}`;
    this.noteEl.hidden = false;

    this.warnEl.innerHTML = (snapWarnings || []).map((w) => `<li>${escapeHtml(w)}</li>`).join('');
    this.warnEl.hidden = !snapWarnings || !snapWarnings.length;

    const fastestLabel = rankBasis === 'live-ai' ? 'Fastest with live traffic' : 'Fastest by base estimate';
    this.trafficEls.clear();
    this.listEl.innerHTML = routes.map((r) => {
      const time = r.traffic ? r.traffic.adjustedDuration : r.duration;
      const timeKind = r.traffic ? 'live AI-adjusted ETA' : 'base estimate';
      const via = r.summary ? ` &middot; via ${escapeHtml(r.summary)}` : '';
      return `<li class="nv-route-item" data-id="${r.id}">
        <button type="button" class="nv-route" data-route="${r.id}" aria-pressed="false">
          <span class="nv-route-top">
            <span class="nv-route-name">Route ${r.index + 1}</span>
            <span class="nv-route-time">${formatDuration(time)}</span>
            ${r.id === fastestId && routes.length > 1 ? `<span class="nv-badge">${fastestLabel}</span>` : ''}
          </span>
          <span class="nv-route-meta">${formatDistance(r.distance)} &middot; ${timeKind}${via}</span>
        </button>
        <div class="nv-route-traffic"></div>
      </li>`;
    }).join('');
    this.listEl.querySelectorAll('.nv-route-item').forEach((li) => {
      this.trafficEls.set(li.dataset.id, li.querySelector('.nv-route-traffic'));
    });
    this.select(selectedId);
  }

  select(id) {
    this.selectedId = id;
    this.listEl.querySelectorAll('.nv-route-item').forEach((li) => {
      const on = li.dataset.id === id;
      li.classList.toggle('nv-selected', on);
      li.querySelector('.nv-route').setAttribute('aria-pressed', String(on));
    });
  }

  /** Per-route traffic details; only these nodes are rewritten on updates. */
  updateTraffic(matches) {
    for (const route of this.routes) {
      const el = this.trafficEls.get(route.id);
      if (!el) continue;
      const html = this._trafficHtml(route, matches.get(route.id) || { monitored: [], alerts: [] });
      if (el.innerHTML !== html) el.innerHTML = html;
    }
  }

  _trafficHtml(route, match) {
    const lines = [];
    if (route.traffic) {
      const t = route.traffic;
      lines.push(`<p class="nv-t-live">Base ${formatDuration(route.duration)} &middot; traffic delay ${formatDelay(t.delay)} &middot; based on live AI observations, updated ${formatClock(t.updatedAt)}</p>`);
      for (const a of t.alerts) lines.push(`<p class="nv-t-alert">${escapeHtml(a.message)}</p>`);
    }
    if (!match.monitored.length) {
      lines.push('<p class="nv-t-none">No AI-monitored intersection on this route.</p>');
    } else {
      const names = match.monitored.map(({ intersection: ix }) => {
        const age = ix.status === 'live' || ix.status === 'offline' ? `, ${formatAge(ix.ageSeconds)}` : '';
        return `${escapeHtml(ix.name)} <span class="nv-st nv-st-${ix.status}">(${STATUS_WORD[ix.status]}${age})</span>`;
      });
      lines.push(`<p>AI-monitored on this route: ${names.join(', ')}</p>`);
    }
    for (const a of match.alerts) {
      if (a.kind === 'long-queue') {
        lines.push(`<p class="nv-t-alert">Long queue at ${escapeHtml(a.name)}: ${a.vehicles} vehicles on the ${directionLabel(a.direction)} approach &middot; ${formatAge(a.ageSeconds)}</p>`);
      } else if (a.kind === 'emergency') {
        const who = TYPE_LABEL[a.emergency.type] || 'emergency vehicle';
        lines.push(`<p class="nv-t-alert nv-t-emergency">Emergency vehicle priority at ${escapeHtml(a.name)} (${escapeHtml(who)}, ${directionLabel(a.emergency.direction)} approach). Expect signal changes.</p>`);
      }
    }
    return lines.join('');
  }

  // ----------------------------------------------------------- suggestions

  showSuggestion(suggestion) {
    const target = suggestion.routeId ? this.routes.find((r) => r.id === suggestion.routeId) : null;
    let text;
    if (suggestion.kind === 'faster') {
      text = `Route ${target.index + 1} is now ${formatDuration(suggestion.savingSeconds)} faster based on live AI traffic.`;
    } else {
      const a = suggestion.alert;
      const what = a.kind === 'emergency'
        ? `emergency vehicle priority at ${a.name}`
        : `long queue at ${a.name} (${a.vehicles} vehicles, ${directionLabel(a.direction)} approach)`;
      text = `New AI observation on your route: ${what}.${target ? ` Route ${target.index + 1} does not pass this intersection.` : ''}`;
    }
    this.suggestEl.dataset.key = suggestion.key;
    this.suggestEl.innerHTML = `<span>${escapeHtml(text)}</span><span class="nv-suggest-actions">
      ${target ? `<button type="button" class="nv-btn nv-btn-primary" data-action="switch" data-route="${target.id}">Show route ${target.index + 1}</button>` : ''}
      <button type="button" class="nv-btn" data-action="dismiss">Dismiss</button></span>`;
    this.suggestEl.hidden = false;
  }

  clearSuggestion() {
    this.suggestEl.hidden = true;
    this.suggestEl.innerHTML = '';
    delete this.suggestEl.dataset.key;
  }
}
