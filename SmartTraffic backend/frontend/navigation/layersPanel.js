import { ICON_HTML } from './navMap.js';

/**
 * Map layer toggles + legend. Each layer reports its own data state, so an
 * empty or unavailable source is shown as such instead of as "no hazards".
 */

const LAYERS = [
  { id: 'traffic', label: 'AI-monitored intersections', icon: ICON_HTML.intersection('nv-ix-live'), defaultOn: true },
  { id: 'speed_camera', label: 'Speed cameras', icon: ICON_HTML.speed_camera, defaultOn: true },
  { id: 'speed_bump', label: 'Speed bumps', icon: ICON_HTML.speed_bump, defaultOn: true },
  { id: 'road_closure', label: 'Road closures', icon: ICON_HTML.road_closure, defaultOn: true },
];

const LEGEND = [
  [ICON_HTML.routeSelected, 'Selected route'],
  [ICON_HTML.routeAlternative, 'Alternative route (tap to select)'],
  [ICON_HTML.start, 'Start'],
  [ICON_HTML.destination, 'Destination'],
  [ICON_HTML.user, 'Your location'],
  [ICON_HTML.intersection('nv-ix-live', '<b class="nv-ix-badge">4</b>'), 'Monitored intersection, live data (badge = longest queue)'],
  [ICON_HTML.intersection('nv-ix-live nv-ix-queue', '<b class="nv-ix-badge">12</b>'), 'Long queue observed'],
  [ICON_HTML.intersection('nv-ix-live nv-ix-emergency'), 'Emergency vehicle priority'],
  [ICON_HTML.intersection('nv-ix-stale'), 'Monitored, no recent data'],
];

export class LayersPanel {
  /**
   * @param root      panel element
   * @param button    toggle button (aria-controls = root)
   * @param supported layer ids that have a data source
   * @param onToggle  (layerId, visible) => void
   */
  constructor({ root, button, supported, onToggle }) {
    this.root = root;
    this.button = button;
    this.onToggle = onToggle;
    this.state = {};
    this.statusEls = {};

    const rows = LAYERS.map((layer) => {
      const available = supported.includes(layer.id);
      const on = available && layer.defaultOn;
      this.state[layer.id] = on;
      return `<li class="nv-layer${available ? '' : ' nv-layer-off'}">
        <label class="nv-layer-row">
          <input type="checkbox" data-layer="${layer.id}" ${on ? 'checked' : ''} ${available ? '' : 'disabled'}>
          <span class="nv-layer-icon" aria-hidden="true">${layer.icon}</span>
          <span class="nv-layer-text"><span class="nv-layer-name">${layer.label}</span>
          <span class="nv-layer-status" data-status="${layer.id}">${available ? '' : 'No data source connected'}</span></span>
        </label></li>`;
    }).join('');
    const legend = LEGEND.map(([icon, text]) => `<li><span class="nv-legend-icon" aria-hidden="true">${icon}</span>${text}</li>`).join('');

    root.innerHTML = `<div class="nv-panel-head"><h2 id="nv-layers-title">Map layers</h2>
        <button type="button" class="nv-icon-btn nv-close" aria-label="Close map layers">&times;</button></div>
      <ul class="nv-layer-list" aria-labelledby="nv-layers-title">${rows}</ul>
      <h2 class="nv-legend-title">Legend</h2>
      <ul class="nv-legend">${legend}</ul>`;

    root.querySelectorAll('[data-status]').forEach((el) => { this.statusEls[el.dataset.status] = el; });
    root.addEventListener('change', (e) => {
      const input = e.target.closest('input[data-layer]');
      if (!input) return;
      this.state[input.dataset.layer] = input.checked;
      this.onToggle(input.dataset.layer, input.checked);
    });
    root.querySelector('.nv-close').addEventListener('click', () => this.setOpen(false, true));
    button.addEventListener('click', () => this.setOpen(root.hidden));
    root.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.setOpen(false, true); });
  }

  isOn(id) {
    return Boolean(this.state[id]);
  }

  setStatus(id, text) {
    const el = this.statusEls[id];
    if (el && el.textContent !== text) el.textContent = text;
  }

  setOpen(open, returnFocus = false) {
    this.root.hidden = !open;
    this.button.setAttribute('aria-expanded', String(open));
    if (open) {
      const first = this.root.querySelector('input:not([disabled])');
      if (first) first.focus();
    } else if (returnFocus) {
      this.button.focus();
    }
  }
}
