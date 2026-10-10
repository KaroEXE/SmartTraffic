/* global L */

/**
 * Geographic layer: OpenStreetMap tiles via Leaflet with one traffic-light
 * marker per intersection. Clicking a marker selects that intersection.
 * Marker shows the lit aspect and the direction currently served.
 */

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

function markerHtml(info, selected) {
  const aspect = info.greenDirection ? (info.signals ? info.signals[info.greenDirection] : 'GREEN') : 'RED';
  const lit = { RED: 'r', YELLOW: 'y', GREEN: 'g' }[aspect] || 'r';
  const dirLetter = info.greenDirection ? info.greenDirection[0].toUpperCase() : '-';
  const classes = ['tl-marker'];
  if (selected) classes.push('selected');
  if (info.dataMode === 'simulation') classes.push('sim');
  if (info.mode === 'EMERGENCY') classes.push('emergency');
  else if (info.mode === 'FALLBACK') classes.push('fallback');
  return `<div class="${classes.join(' ')}">
    <span class="tl-housing"><i class="r ${lit === 'r' ? 'on' : ''}"></i><i class="y ${lit === 'y' ? 'on' : ''}"></i><i class="g ${lit === 'g' ? 'on' : ''}"></i></span>
    <span class="tl-dir">${dirLetter}</span>
  </div>`;
}

export class NetworkMap {
  constructor(element, intersections, onSelect) {
    this.onSelect = onSelect;
    this.markers = new Map();
    this.info = new Map();
    this.keys = new Map();
    this.selectedId = null;

    this.map = L.map(element, {
      zoomControl: true,
      attributionControl: true,
      zoomSnap: 0.5,
    });
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(this.map);

    this.setIntersections(intersections);

    // Leaflet needs a nudge when its container is resized by CSS grid.
    new ResizeObserver(() => this.map.invalidateSize()).observe(element);
  }

  /**
   * Replaces the markers with one data mode's intersections (live and
   * simulation each have their own list) and fits the view to them.
   */
  setIntersections(intersections) {
    for (const marker of this.markers.values()) marker.remove();
    this.markers.clear();
    this.info.clear();
    this.keys.clear();
    for (const ix of intersections) {
      this.info.set(ix.id, { ...ix });
      const marker = L.marker([ix.lat, ix.lng], {
        icon: this._icon(ix.id),
        title: ix.name,
        keyboard: true,
        riseOnHover: true,
      });
      marker.bindTooltip(ix.name, { direction: 'top', offset: [0, -14] });
      marker.on('click', () => this.onSelect(ix.id));
      marker.addTo(this.map);
      this.markers.set(ix.id, marker);
    }

    const bounds = L.latLngBounds(intersections.map((i) => [i.lat, i.lng]));
    this.map.fitBounds(bounds, { padding: [36, 36], maxZoom: 16 });
  }

  _icon(id) {
    const info = this.info.get(id);
    return L.divIcon({
      className: 'tl-marker-wrap',
      html: markerHtml(info, id === this.selectedId),
      iconSize: [0, 0],
    });
  }

  _refresh(id) {
    const info = this.info.get(id);
    const key = [info.dataMode, info.mode, info.greenDirection, info.signals && info.greenDirection ? info.signals[info.greenDirection] : '', id === this.selectedId].join('|');
    if (this.keys.get(id) === key) return;
    this.keys.set(id, key);
    const marker = this.markers.get(id);
    marker.setIcon(this._icon(id));
    marker.setZIndexOffset(id === this.selectedId ? 1000 : 0);
  }

  update(snapshot) {
    const id = snapshot.intersectionId;
    if (!this.info.has(id)) return;
    Object.assign(this.info.get(id), {
      dataMode: snapshot.dataMode,
      mode: snapshot.mode,
      greenDirection: snapshot.greenDirection,
      signals: snapshot.signals,
    });
    this._refresh(id);
  }

  /** Redraws every marker from one data mode's snapshots (used when switching modes). */
  setSnapshots(snapshots) {
    for (const [id, info] of this.info) {
      Object.assign(info, { dataMode: null, mode: null, greenDirection: null, signals: null });
      this._refresh(id);
    }
    snapshots.forEach((snap) => this.update(snap));
  }

  select(id, { pan = false } = {}) {
    const prev = this.selectedId;
    this.selectedId = id;
    if (prev && this.info.has(prev)) this._refresh(prev);
    if (this.info.has(id)) {
      this._refresh(id);
      if (pan) {
        const { lat, lng } = this.info.get(id);
        if (!this.map.getBounds().pad(-0.15).contains([lat, lng])) this.map.panTo([lat, lng]);
      }
    }
  }
}
