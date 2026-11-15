import {
  Map as MapLibreMap, Marker, Popup, NavigationControl, AttributionControl, setWorkerUrl,
} from '/vendor/maplibre-gl/maplibre-gl.mjs';
import { toMapBounds, MAP_ICONS } from './mapConfig.js';

/**
 * The one place that creates a MapLibre map for every web page (navigation page,
 * operations dashboard, admin console). OpenFreeMap serves the vector tiles and the
 * style (https://openfreemap.org/quick_start/); MapLibre GL JS draws them, including the
 * Arabic and Kurdish labels, with the style's own attribution.
 *
 * A map is created once per page and kept: data changes go through GeoJSON sources
 * (setData), never through rebuilding the map.
 */

setWorkerUrl('/vendor/maplibre-gl/maplibre-gl-worker.mjs');

export { Marker, Popup };

/** Short message over a map's element (null hides it). */
export function mapNotice(element) {
  let box = null;
  return (message) => {
    if (!message) { if (box) box.hidden = true; return; }
    if (!box) {
      box = document.createElement('div');
      box.className = 'map-notice';
      box.setAttribute('role', 'status');
      Object.assign(box.style, {
        position: 'absolute', zIndex: '5', left: '50%', top: '72px', transform: 'translateX(-50%)', maxWidth: 'min(92%, 440px)',
        padding: '10px 14px', borderRadius: '10px', background: '#1b2026', color: '#e6e9ec', border: '1px solid #3a424b',
        font: '14px/1.4 system-ui, sans-serif', textAlign: 'center', boxShadow: '0 4px 16px rgba(0,0,0,.35)',
      });
      element.appendChild(box);
    }
    box.textContent = message;
    box.hidden = false;
  };
}

/** Draws one 24 px marker icon (at 2x) for map.addImage. */
function drawIcon({ color, glyph }) {
  const size = 48;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  if (glyph === 'camera') {
    ctx.fillRect(12, 17, 17, 14);
    ctx.beginPath(); ctx.moveTo(29, 22); ctx.lineTo(37, 17); ctx.lineTo(37, 31); ctx.lineTo(29, 26); ctx.closePath(); ctx.fill();
  } else if (glyph === 'bump') {
    ctx.beginPath(); ctx.moveTo(11, 31); ctx.lineTo(37, 31); ctx.moveTo(14, 31); ctx.quadraticCurveTo(24, 12, 34, 31); ctx.stroke();
  } else if (glyph === 'dot') {
    ctx.beginPath(); ctx.arc(size / 2, size / 2, 7, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.font = 'bold 30px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(glyph, size / 2, size / 2 + 2);
  }
  return ctx.getImageData(0, 0, size, size);
}

/** Registers the Hawr marker icons on a loaded map: image ids "hawr-<kind>". */
export function addHawrIcons(map) {
  for (const [kind, spec] of Object.entries(MAP_ICONS)) {
    const id = `hawr-${kind}`;
    if (!map.hasImage(id)) map.addImage(id, drawIcon(spec), { pixelRatio: 2 });
  }
}

/**
 * Creates the map. `config` is what loadMapConfig returned. Resolves { map, loaded }:
 * `loaded` resolves when the style is ready for layers and sources. Without a config
 * (the backend is not reachable) a message is shown and no map is created.
 *
 *   options.navigation   zoom buttons (default true)
 *   options.notify       (message | null) => void, defaults to a message over the map
 */
export function createBaseMap(container, config, { navigation = true, notify = mapNotice(container) } = {}) {
  if (!config) {
    notify('The map could not be set up: the Hawr server did not answer. Reload the page.');
    return null;
  }
  const { styleUrl, bounds, minZoom, maxZoom } = config.map;
  const area = toMapBounds(bounds);
  const map = new MapLibreMap({
    container,
    style: styleUrl,
    bounds: area,
    fitBoundsOptions: { padding: 0 },
    maxBounds: area,
    minZoom,
    maxZoom,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    maxPitch: 0,
    renderWorldCopies: false,
  });
  map.touchZoomRotate.disableRotation();
  // The style carries OpenFreeMap's attribution (© OpenMapTiles, data from OpenStreetMap);
  // Geoapify's free plan asks for its name wherever its search or routing is used.
  map.addControl(new AttributionControl({
    customAttribution: 'Search and routes: <a href="https://www.geoapify.com/" target="_blank" rel="noopener">Powered by Geoapify</a>',
  }));
  if (navigation) map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');

  const loaded = new Promise((resolve) => { map.once('load', () => { notify(null); resolve(map); }); });
  let failures = 0;
  map.on('error', (e) => {
    failures += 1;
    // The first errors before the map has loaded are the style itself; later ones are single tiles.
    if (!map.loaded() && failures >= 1 && !map.isStyleLoaded()) notify('The map could not be loaded from OpenFreeMap. Check your connection and reload.');
    else if (failures >= 8) notify('Some map tiles could not be loaded. The map may be incomplete.');
    if (e && e.error && typeof console !== 'undefined') console.warn('[map]', e.error.message || e.error);
  });
  map.on('idle', () => { failures = 0; });
  return { map, loaded };
}
