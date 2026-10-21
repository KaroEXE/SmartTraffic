import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  DIRS, LAYOUT, approach, pathPoint, buildRoadNetwork, buildCity, disposeStatic,
} from './intersection.js';
import { MAX_PER_APPROACH } from './vehicles.js';
import { layoutNetwork } from './network.js';
import { IntersectionSite, DRAWS_TRAFFIC } from './site.js';
import { trafficSummary } from '../metrics.js';
import { NetworkOverlay } from './networkOverlay.js';

/**
 * 3D digital twin of the street network around the selected intersection.
 *
 *   const scene = new TrafficScene(container, { tagLayer, compass, statusLayer, onSelect });
 *   scene.setNetwork(intersections);    // the active mode's list (on boot / mode switch)
 *   scene.setDataState('live' | 'waiting' | 'stale' | 'offline' | 'simulation', snapshot);
 *   scene.focusIntersection(id);        // on selection: camera + approach tags
 *   scene.loadIntersection(snapshot);   // on selection: reload that intersection
 *   scene.applyState(snapshot);         // on every backend update, for ANY intersection
 *   scene.setNetworkTopology(topology); // backend road network (links between intersections)
 *   scene.applyNetworkDecision(decision); // each network decision cycle (networkDecision)
 *
 * Every intersection of the active mode is a junction of one street grid
 * (three/network.js), with its own signals, vehicles and pedestrians
 * (three/site.js). A snapshot is routed by its `intersectionId` to that
 * intersection only. The scene never decides signal state or invents
 * traffic: lights show the backend's signals (dark until it has sent any),
 * vehicles follow each intersection's detected counts, junctions the
 * backend does not manage have no signals at all, and without live data the
 * status layer says so.
 *
 * `setDataState` describes the SELECTED intersection (app.js decides it).
 * Other intersections derive theirs from their own snapshot's aiStatus the
 * same way app.js does, so a stale intersection freezes on its own.
 */

const SPACING = 2 * LAYOUT.roadLength; // neighbouring legs meet half-way
const HOME_OFFSET = new THREE.Vector3(58, 112, 100);
const HOME_TARGET_OFFSET = new THREE.Vector3(0, 0, 4);
const OVERVIEW_DIR = new THREE.Vector3(0.3, 1, 0.62).normalize();
const BG = 0x0d1013;
const SIM_STEP = 0.05;     // s, simulation sub-step
const MAX_FRAME_DT = 0.25; // s, longest frame gap simulated in one go
// Camera distance over which the signal beacons and labels fade in.
const BEACON_FADE = [170, 300];
// The selected intersection's label hides close up, where its approach tags show.
const FOCUS_LABEL_DISTANCE = 230;
const SHADOW_MIN = 125;
const SHADOW_MAX = 520;
// Camera clearance: low over roads, above the tallest building (34 m + roof
// plant) over city blocks, so the camera never ends up inside a building.
const MIN_HEIGHT_ROAD = 6;
const MIN_HEIGHT_BLOCK = 40;
// Keyboard steps (viewport focused): share of the view distance / degrees.
const KEY_PAN_SHARE = 0.06;
const KEY_ROTATE = THREE.MathUtils.degToRad(10);
const KEY_ZOOM = 0.85;

export class TrafficScene {
  constructor(container, {
    tagLayer = null, compass = null, statusLayer = null, onSelect = null,
  } = {}) {
    this.container = container;
    this.tagLayer = tagLayer;
    this.compass = compass;
    // Only the dial turns, so the compass button itself stays put.
    this.compassNeedle = compass ? (compass.querySelector('.compass-dial') || compass) : null;
    this.statusLayer = statusLayer;
    this.onSelect = onSelect;
    this.time = 0;
    this.tween = null;
    this.snapshot = null;
    this.frozen = false;
    this.dataState = 'waiting';
    this.focusId = null;
    this.sites = new Map();
    this.layout = null;
    this.network = null; // static roads + city of the current layout
    this.networkList = [];
    this.labels = new Map();
    this.tags = {};

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    container.prepend(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BG);
    scene.fog = new THREE.Fog(BG, 150, 330);
    this.scene = scene;

    this.camera = new THREE.PerspectiveCamera(36, 1, 1, 4000);
    this.camera.position.copy(HOME_OFFSET);

    const controls = new OrbitControls(this.camera, renderer.domElement);
    controls.target.copy(HOME_TARGET_OFFSET);
    // Mouse: left-drag rotate, right-drag (or Ctrl/Shift + left-drag) pan
    // across the ground, wheel zoom toward the cursor. Touch: one finger
    // rotates, two fingers zoom and pan.
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.rotateSpeed = 0.6;
    controls.zoomSpeed = 1.0;
    controls.panSpeed = 0.8;
    controls.zoomToCursor = true;
    controls.screenSpacePanning = false;
    controls.minDistance = 20;
    controls.maxDistance = 260;
    controls.minPolarAngle = 0.05;
    controls.maxPolarAngle = 1.35; // never below the horizon
    controls.addEventListener('change', () => {
      // Keep the pivot on the ground and over the street network.
      const t = controls.target;
      const b = this._panBounds();
      t.y = 0;
      t.x = THREE.MathUtils.clamp(t.x, b.minX, b.maxX);
      t.z = THREE.MathUtils.clamp(t.z, b.minZ, b.maxZ);
      this._keepAboveScenery();
    });
    controls.addEventListener('start', () => { this.tween = null; });
    controls.update();
    this.controls = controls;
    this._bindNavigation();

    // Lighting: soft sky fill + one shadow-casting sun that follows the view.
    scene.add(new THREE.HemisphereLight(0xdfe7f0, 0x1b1e22, 1.15));
    const sun = new THREE.DirectionalLight(0xffffff, 2.0);
    this.sunDir = new THREE.Vector3(-70, 140, 55).normalize();
    this.sunDistance = 167;
    sun.position.copy(this.sunDir).multiplyScalar(this.sunDistance);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    scene.add(sun, sun.target);
    this.sun = sun;
    this.shadowExtent = 0;
    this._fitShadow(SHADOW_MIN);

    this.sitesGroup = new THREE.Group();
    this.sitesGroup.name = 'intersections';
    scene.add(this.sitesGroup);
    // Road connections, decision highlights and emergency corridors (three/networkOverlay.js).
    this.topology = null;
    this.overlay = new NetworkOverlay(scene, { tagLayer });
    this.setNetwork([]);

    this._createTags();

    this._resize = this._resize.bind(this);
    new ResizeObserver(this._resize).observe(container);
    this._resize();

    this.clock = new THREE.Clock();
    this._frame = this._frame.bind(this);
    requestAnimationFrame(this._frame);
  }

  // ------------------------------------------------------------ public

  /**
   * Builds the street network for the active mode's intersections
   * ({ id, name, lat, lng }, as served by the backend). Called on boot and
   * on every mode switch: all intersections start from a clean picture, so
   * nothing carries over from the other mode.
   */
  setNetwork(intersections) {
    for (const site of this.sites.values()) site.dispose();
    this.sites.clear();
    if (this.network) {
      this.scene.remove(this.network);
      disposeStatic(this.network);
    }

    this.networkList = [...(intersections || [])];
    this.layout = layoutNetwork(this.networkList, { spacing: SPACING });
    this.network = new THREE.Group();
    this.network.name = 'network-static';
    this.network.add(buildRoadNetwork(this.layout), buildCity(this.layout));
    this.scene.add(this.network);

    for (const slot of this.layout.sites) this.sites.set(slot.id, new IntersectionSite(this.sitesGroup, slot));
    this.overlay.setLayout(this.layout, this.topology);
    this._createLabels();
    this._updateZoomLimits();
    // Keep the selection when it is still part of the network; a new network
    // opens on its overview.
    const focus = this.sites.has(this.focusId) ? this.focusId : null;
    this.focusId = null;
    this.focusedOnce = false;
    if (focus) this.focusIntersection(focus, { animate: false });
  }

  /** The backend's road network: which intersections are joined by which roads. */
  setNetworkTopology(topology) {
    this.topology = topology || null;
    if (this.layout) this.overlay.setLayout(this.layout, this.topology);
  }

  /** One network decision cycle: road states, highlights, emergency corridors. */
  applyNetworkDecision(decision) {
    this.overlay.applyDecision(decision || null);
  }

  /** Points the camera and the approach tags at one intersection. */
  focusIntersection(id, { animate = true } = {}) {
    const site = this.sites.get(id);
    if (!site || id === this.focusId) return;
    const first = this.focusId === null;
    const previous = this.sites.get(this.focusId);
    const overviewFirst = first && this.sites.size > 1 && !this.focusedOnce;
    this.focusId = id;
    this.snapshot = site.snapshot;
    // The selected intersection follows app.js's data state; the previous
    // one goes back to deriving its own from its snapshot.
    for (const s of [previous, site]) if (s) s.setDataState(this._siteDataState(s));
    this._placeTags(site);
    this._updateTagContent();
    this._updateLabelContent();
    // The first view of a network shows all of it (every junction and its
    // signals); later selections fly to the chosen intersection.
    if (overviewFirst) {
      this.focusedOnce = true;
      this._jumpTo(this._overviewView());
    } else if (first || !animate) this._jumpTo(this._homeView());
    else this._tweenTo(this._homeView());
  }

  /** Reloads one intersection (on selection or mode change) and focuses it. */
  loadIntersection(snapshot) {
    const site = this._siteFor(snapshot);
    this.focusIntersection(site.id);
    site.reload();
    this.applyState(snapshot);
  }

  /**
   * How the selected intersection's snapshots are drawn:
   *   'live'     fresh AI data: vehicles per approach follow the detected
   *              counts and classes; tags show the counts.
   *   'waiting'  nothing received yet: no vehicles, tags show "--", and the
   *              status layer says "Waiting for live data".
   *   'stale'    AI data stopped: the last picture stays, frozen, with the
   *              tags marked stale; nothing new is added.
   *   'offline'  backend unreachable: as stale, shown as reconnecting (for
   *              every intersection).
   *   'simulation'  the Simulation tab's own snapshots: drawn like live data
   *              (the dashboard labels it SIMULATED); motion stops while the
   *              simulation is stopped or paused (setFrozen).
   * app.js reloads the network (setNetwork) whenever the data mode changes,
   * so vehicles from one mode never carry over into the other.
   */
  setDataState(dataState, snapshot = this.snapshot) {
    const changed = dataState !== this.dataState;
    this.dataState = dataState;
    this._updateStatusLayer(snapshot);
    if (!changed) return;
    for (const site of this.sites.values()) site.setDataState(this._siteDataState(site));
    this._updateTagContent();
    this._updateLabelContent();
  }

  /** Stops (true) or resumes (false) vehicle and pedestrian motion without touching state. */
  setFrozen(frozen) {
    this.frozen = Boolean(frozen);
  }

  /** Draws a snapshot on its own intersection (any intersection of the active mode). */
  applyState(snapshot) {
    if (!snapshot) return;
    const site = this._siteFor(snapshot);
    site.snapshot = snapshot;
    site.apply(snapshot, this._siteDataState(site));
    if (site.id === this.focusId) {
      this.snapshot = snapshot;
      this._updateTagContent();
      this._updateStatusLayer(snapshot);
    }
    this._updateLabel(site);
  }

  /**
   * Draws every snapshot of the active mode (socket `init`, mode switch).
   * `reload`: that mode's state was replaced, so each intersection starts
   * from a clean picture.
   */
  applyAll(snapshots, { reload = false } = {}) {
    for (const snap of snapshots || []) {
      if (reload) this._siteFor(snap).reload();
      this.applyState(snap);
    }
  }

  /** Counters that must stay flat over time (console: trafficScene.stats()). */
  stats() {
    let objects = 0;
    this.scene.traverse(() => { objects += 1; });
    const { geometries, textures } = this.renderer.info.memory;
    const focus = this.sites.get(this.focusId);
    const intersections = {};
    for (const site of this.sites.values()) {
      intersections[site.id] = {
        dataState: site.dataState,
        signals: { ...site.lights.signals },
        vehicles: site.vehicles.count(),
      };
    }
    return {
      dataState: this.dataState,
      focus: this.focusId,
      grid: this.layout && `${this.layout.cols}x${this.layout.rows}`,
      intersections,
      vehicles: focus ? focus.vehicles.count() : 0,
      vehiclesPerApproach: focus
        ? Object.fromEntries(DIRS.map((d) => [d, focus.vehicles.countOnApproach(d)]))
        : {},
      pooledVehicles: [...this.sites.values()].reduce((n, s) => n + s.vehicles.pooledCount(), 0),
      network: {
        links: this.overlay.links.map((l) => `${l.id}:${l.state}${l.releasing ? ':releasing' : ''}`),
        rings: Object.fromEntries([...this.overlay.rings].map(([id, r]) => [id, r.state])),
        corridorSegments: this.overlay.ribbons.length,
        emergencyVehicles: this.overlay.vehicles.size,
        etaChips: this.overlay.chips.map((c) => c.el.textContent),
        decisionCycle: this.overlay.decision ? this.overlay.decision.cycle : null,
      },
      sceneObjects: objects,
      drawCalls: this.renderer.info.render.calls,
      geometries,
      textures,
    };
  }

  /** Centres the selected intersection (its close-up view). */
  resetView() {
    this._tweenTo(this._homeView());
  }

  focusSelected() {
    this.resetView();
  }

  /** The default overview of the whole network (the initial camera). */
  overview() {
    this._tweenTo(this._overviewView());
  }

  resetCamera() {
    this.overview();
  }

  /** Frames every intersection, keeping the current viewing direction. */
  fitNetwork() {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const sph = new THREE.Spherical().setFromVector3(offset);
    // A very flat view would need a huge distance: fit from at least ~35 deg above the horizon.
    sph.phi = Math.min(sph.phi, 0.95);
    sph.radius = 1;
    this._tweenTo(this._overviewView(new THREE.Vector3().setFromSpherical(sph)));
  }

  /** factor < 1 zooms in, > 1 zooms out (within the zoom limits). */
  zoomBy(factor, { animate = true } = {}) {
    const t = this.controls.target;
    const offset = this.camera.position.clone().sub(t);
    const d = THREE.MathUtils.clamp(offset.length() * factor, this.controls.minDistance, this.controls.maxDistance);
    const view = { position: t.clone().add(offset.setLength(d)), target: t.clone() };
    if (animate) this._tweenTo(view, 0.35);
    else this._jumpTo(view);
  }

  /** Rotates around the pivot (radians, positive = counter-clockwise seen from above). */
  rotateBy(angle, { animate = true } = {}) {
    const t = this.controls.target;
    const offset = this.camera.position.clone().sub(t).applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
    const view = { position: t.clone().add(offset), target: t.clone() };
    if (animate) this._tweenTo(view, 0.35);
    else this._jumpTo(view);
  }

  /** Turns the view so that north is up, keeping distance and tilt. */
  northUp() {
    const t = this.controls.target;
    const sph = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(t));
    sph.theta = 0; // camera south of the pivot, looking north
    this._tweenTo({ position: t.clone().add(new THREE.Vector3().setFromSpherical(sph)), target: t.clone() });
  }

  /** Moves across the ground relative to the view: right / forward in units of the view distance. */
  panBy(right, forward) {
    const t = this.controls.target;
    const offset = this.camera.position.clone().sub(t);
    const fwd = new THREE.Vector3(-offset.x, 0, -offset.z);
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const rgt = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const step = offset.length();
    const move = rgt.multiplyScalar(right * step).add(fwd.multiplyScalar(forward * step));
    this.tween = null;
    t.add(move);
    this.camera.position.add(move);
    this.controls.dispatchEvent({ type: 'change' }); // clamp to the network
    this.controls.update();
  }

  /** Flies the pivot to a ground point, keeping the viewing angle and distance. */
  flyTo(point) {
    const b = this._panBounds();
    const to = new THREE.Vector3(
      THREE.MathUtils.clamp(point.x, b.minX, b.maxX), 0, THREE.MathUtils.clamp(point.z, b.minZ, b.maxZ),
    );
    const offset = this.camera.position.clone().sub(this.controls.target);
    this._tweenTo({ position: to.clone().add(offset), target: to });
  }

  // ------------------------------------------------------------ internals

  /**
   * The site for a snapshot. An intersection the list did not contain (the
   * backend reported a new one) is added to the network rather than dropped.
   */
  _siteFor(snapshot) {
    const id = snapshot.intersectionId;
    if (!this.sites.has(id)) {
      const previous = [...this.sites.values()].map((s) => s.snapshot).filter(Boolean);
      this.setNetwork([...this.networkList, { id, name: snapshot.name || id }]);
      for (const snap of previous) {
        const site = this.sites.get(snap.intersectionId);
        site.snapshot = snap;
        site.apply(snap, this._siteDataState(site));
        this._updateLabel(site);
      }
    }
    return this.sites.get(id);
  }

  /** Same mapping as app.js dataStateOf(), from this intersection's own snapshot. */
  _siteDataState(site) {
    if (site.id === this.focusId) return this.dataState;
    if (this.dataState === 'offline' || this.dataState === 'simulation') return this.dataState;
    const ai = site.snapshot && site.snapshot.aiStatus;
    if (ai === 'CONNECTED') return 'live';
    if (ai === 'STALE') return 'stale';
    return 'waiting';
  }

  _homeView() {
    const site = this.sites.get(this.focusId);
    const origin = site ? site.origin : new THREE.Vector3();
    return {
      position: origin.clone().add(HOME_OFFSET),
      target: origin.clone().add(HOME_TARGET_OFFSET),
    };
  }

  /**
   * A view of the whole network: the closest distance at which every
   * junction and its legs fit, seen from `dir` (default: the overview angle).
   */
  _overviewView(dir = OVERVIEW_DIR) {
    const b = this.layout.bounds;
    const margin = LAYOUT.roadLength * 0.55;
    const target = new THREE.Vector3((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
    const corners = [];
    for (const x of [b.minX - margin, b.maxX + margin]) {
      for (const z of [b.minZ - margin, b.maxZ + margin]) {
        corners.push(new THREE.Vector3(x, 0, z), new THREE.Vector3(x, 12, z));
      }
    }
    const cam = this.camera.clone();
    const v = new THREE.Vector3();
    const fits = (dist) => {
      cam.position.copy(target).addScaledVector(dir, dist);
      cam.lookAt(target);
      cam.updateMatrixWorld();
      return corners.every((c) => {
        v.copy(c).project(cam);
        return v.z < 1 && Math.abs(v.x) <= 0.94 && Math.abs(v.y) <= 0.9;
      });
    };
    let lo = 60;
    let hi = 3000;
    for (let i = 0; i < 24; i += 1) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    return { position: target.clone().addScaledVector(dir, hi), target, distance: hi };
  }

  _updateZoomLimits() {
    const { distance } = this._overviewView();
    this.controls.maxDistance = Math.max(260, distance * 1.35);
  }

  _panBounds() {
    const b = this.layout ? this.layout.bounds : { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
    const m = LAYOUT.roadLength * 0.8;
    return { minX: b.minX - m, maxX: b.maxX + m, minZ: b.minZ - m, maxZ: b.maxZ + m };
  }

  _jumpTo(view) {
    this.tween = null;
    this.camera.position.copy(view.position);
    this.controls.target.copy(view.target);
    this.controls.update();
  }

  /** Smooth camera move; the duration grows with the distance travelled. */
  _tweenTo(view, duration = null) {
    const travel = this.camera.position.distanceTo(view.position) + this.controls.target.distanceTo(view.target);
    this.tween = {
      t: 0,
      duration: duration || THREE.MathUtils.clamp(0.45 + travel / 900, 0.5, 1.4),
      fromPos: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toPos: view.position,
      toTarget: view.target,
    };
  }

  /** Over a city block the camera stays above the rooftops; over roads it may go low. */
  _keepAboveScenery() {
    const p = this.camera.position;
    const minHeight = this._overBuildings(p.x, p.z) ? MIN_HEIGHT_BLOCK : MIN_HEIGHT_ROAD;
    if (p.y < minHeight) p.y = minHeight;
  }

  _overBuildings(x, z) {
    if (!this.layout) return false;
    const { bounds, spacing } = this.layout;
    const reach = LAYOUT.roadLength;
    if (x < bounds.minX - reach || x > bounds.maxX + reach || z < bounds.minZ - reach || z > bounds.maxZ + reach) return false;
    const band = LAYOUT.roadHalf + LAYOUT.sidewalk;
    const nearLine = (v, origin) => {
      const d = (((v - origin) % spacing) + spacing) % spacing;
      return Math.min(d, spacing - d) <= band;
    };
    return !nearLine(x, bounds.minX) && !nearLine(z, bounds.minZ);
  }

  /** Keyboard (while the 3D view has focus) and double-click navigation. */
  _bindNavigation() {
    const el = this.container;
    const canvas = this.renderer.domElement;
    // Clicking the map gives it keyboard focus (without scrolling the page).
    canvas.addEventListener('pointerdown', () => {
      if (document.activeElement !== el) el.focus({ preventScroll: true });
    });
    canvas.addEventListener('dblclick', (e) => {
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.camera);
      const hit = new THREE.Vector3();
      if (ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) this.flyTo(hit);
    });
    el.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const actions = {
        ArrowUp: () => this.panBy(0, KEY_PAN_SHARE),
        w: () => this.panBy(0, KEY_PAN_SHARE),
        ArrowDown: () => this.panBy(0, -KEY_PAN_SHARE),
        s: () => this.panBy(0, -KEY_PAN_SHARE),
        ArrowLeft: () => this.panBy(-KEY_PAN_SHARE, 0),
        a: () => this.panBy(-KEY_PAN_SHARE, 0),
        ArrowRight: () => this.panBy(KEY_PAN_SHARE, 0),
        d: () => this.panBy(KEY_PAN_SHARE, 0),
        q: () => this.rotateBy(KEY_ROTATE, { animate: false }),
        e: () => this.rotateBy(-KEY_ROTATE, { animate: false }),
        '+': () => this.zoomBy(KEY_ZOOM, { animate: false }),
        '=': () => this.zoomBy(KEY_ZOOM, { animate: false }),
        '-': () => this.zoomBy(1 / KEY_ZOOM, { animate: false }),
        _: () => this.zoomBy(1 / KEY_ZOOM, { animate: false }),
        f: () => this.fitNetwork(),
        c: () => this.focusSelected(),
        r: () => this.resetCamera(),
        Home: () => this.resetCamera(),
        n: () => this.northUp(),
      };
      // Buttons keep Enter / Space; everything else here belongs to the map.
      if (tag === 'BUTTON' && (k === 'Enter' || k === ' ')) return;
      const action = actions[k];
      if (!action) return;
      e.preventDefault();
      action();
    });
  }

  // -------------------------------------------------- approach tags

  _createTags() {
    this.tags = {};
    if (!this.tagLayer) return;
    for (const dir of DIRS) {
      const el = document.createElement('div');
      el.className = 'tag';
      el.innerHTML = `<span class="tag-dir">${dir.toUpperCase()}</span><span class="tag-count"></span><span class="tag-prio" hidden>PRIORITY</span>`;
      this.tagLayer.appendChild(el);
      this.tags[dir] = {
        el,
        count: el.querySelector('.tag-count'),
        prio: el.querySelector('.tag-prio'),
        anchor: new THREE.Vector3(),
      };
    }
    const site = this.sites.get(this.focusId);
    if (site) this._placeTags(site);
  }

  /** Approach tags belong to the selected intersection. */
  _placeTags(site) {
    const { stopS } = approach('north');
    for (const dir of DIRS) {
      const tag = this.tags[dir];
      if (!tag) continue;
      const p = pathPoint(dir, stopS - 20, LAYOUT.roadHalf / 2);
      tag.anchor.set(site.origin.x + p.x, 4.5, site.origin.z + p.z);
    }
  }

  _drawsTraffic() {
    return DRAWS_TRAFFIC.has(this.dataState);
  }

  /** Tag text for one approach; the same numbers as the dashboard's approach cards. */
  _tagText(t) {
    if (this.dataState === 'waiting' || !t) return '-- veh';
    if (t.available === false || !Number.isFinite(t.vehicles)) {
      return this.dataState === 'simulation' ? '-- veh' : 'video unavailable';
    }
    const shown = t.vehicles > MAX_PER_APPROACH ? ` (${MAX_PER_APPROACH} shown)` : '';
    const queued = Number.isFinite(t.queueLength) ? ` · ${t.queueLength} queued` : '';
    const stale = this._drawsTraffic() ? '' : ' · stale';
    return `${t.vehicles} veh${queued}${shown}${stale}`;
  }

  _updateTagContent() {
    const s = this.snapshot;
    if (!s) return;
    for (const dir of DIRS) {
      const tag = this.tags[dir];
      if (!tag) continue;
      const state = s.signals && s.signals[dir];
      const priority = this._drawsTraffic() && s.emergency && s.emergency.active && s.emergency.direction === dir;
      tag.el.className = `tag s-${state}${priority ? ' priority' : ''}${this._drawsTraffic() ? '' : ' no-live'}`;
      tag.count.textContent = this._tagText(s.traffic && s.traffic[dir]);
      tag.prio.hidden = !priority;
    }
  }

  // ------------------------------------------- intersection labels

  /**
   * One label per managed intersection: its name and its four signals, so
   * every junction's state is readable from the overview. Clicking a label
   * selects that intersection (onSelect -> app.js selectIntersection).
   */
  _createLabels() {
    for (const label of this.labels.values()) label.el.remove();
    this.labels.clear();
    if (!this.tagLayer) return;
    for (const site of this.sites.values()) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'site-tag';
      el.title = `Select ${site.name}`;
      const name = document.createElement('span');
      name.className = 'site-name';
      name.textContent = site.name;
      const sig = document.createElement('span');
      sig.className = 'site-sig';
      const dots = {};
      for (const dir of DIRS) {
        const dot = document.createElement('i');
        dot.textContent = dir[0].toUpperCase();
        dot.title = dir;
        sig.appendChild(dot);
        dots[dir] = dot;
      }
      const queue = document.createElement('span');
      queue.className = 'site-q';
      el.append(name, sig, queue);
      el.addEventListener('click', () => {
        if (this.onSelect) this.onSelect(site.id);
      });
      this.tagLayer.appendChild(el);
      this.labels.set(site.id, {
        el, dots, queue, anchor: site.origin.clone().setY(16), key: '',
      });
    }
    this._updateLabelContent();
  }

  _updateLabelContent() {
    for (const site of this.sites.values()) this._updateLabel(site);
  }

  _updateLabel(site) {
    const label = this.labels.get(site.id);
    if (!label) return;
    const signals = site.lights.signals;
    const state = site.dataState || 'waiting';
    // Queue and congestion only from data that draws traffic (live or simulated).
    const summary = DRAWS_TRAFFIC.has(state) ? trafficSummary(site.snapshot) : null;
    const queueText = summary && summary.queued !== null ? `${summary.queued} queued` : 'no data';
    const level = summary ? summary.level : 'nodata';
    const key = `${site.id === this.focusId}|${state}|${DIRS.map((d) => signals[d]).join(',')}|${queueText}|${level}`;
    if (key === label.key) return;
    label.key = key;
    label.el.className = `site-tag d-${state} cg-${level}${site.id === this.focusId ? ' selected' : ''}`;
    label.el.title = `Select ${site.name}${summary ? ` - congestion: ${summary.label}` : ''}`;
    label.queue.textContent = queueText;
    for (const dir of DIRS) label.dots[dir].className = signals[dir] ? `s-${signals[dir]}` : 's-none';
  }

  _updateStatusLayer(snapshot) {
    const layer = this.statusLayer;
    if (!layer) return;
    const title = layer.querySelector('.vp-data-state-title');
    const text = layer.querySelector('.vp-data-state-text');
    const last = snapshot && snapshot.lastUpdate
      ? new Date(snapshot.lastUpdate).toLocaleTimeString([], { hour12: false })
      : null;
    const messages = {
      waiting: ['Waiting for live data', 'No detections from the AI cameras yet. Signals show the controller\'s fixed-time plan.'],
      stale: ['Live data stale', `Last AI data at ${last || '--:--:--'}. Vehicles are frozen at that moment; signals run the fixed-time plan.`],
      offline: ['Reconnecting', 'The connection to the backend was lost. Reconnecting automatically...'],
    };
    const message = messages[this.dataState];
    layer.hidden = !message;
    layer.dataset.state = this.dataState;
    if (!message) return;
    if (title.textContent !== message[0]) title.textContent = message[0];
    if (text.textContent !== message[1]) text.textContent = message[1];
  }

  /** Places an overlay element at a 3D anchor; returns false when it is off screen. */
  _project(el, anchor, w, h, v) {
    v.copy(anchor).project(this.camera);
    const visible = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
    el.style.visibility = visible ? 'visible' : 'hidden';
    if (visible) {
      const x = (v.x + 1) / 2 * w;
      const y = (1 - v.y) / 2 * h;
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    }
    return visible;
  }

  _updateOverlays(distance) {
    if (!this.tagLayer) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const v = new THREE.Vector3();
    const focus = this.sites.get(this.focusId);
    // Approach tags only while the selected intersection is the subject of the view.
    const focusDistance = focus ? this.camera.position.distanceTo(focus.origin) : Infinity;
    const tagsShown = focusDistance < FOCUS_LABEL_DISTANCE * 1.4;
    for (const dir of DIRS) {
      const tag = this.tags[dir];
      if (!tag) continue;
      if (tagsShown) this._project(tag.el, tag.anchor, w, h, v);
      else tag.el.style.visibility = 'hidden';
    }
    for (const [id, label] of this.labels) {
      const hide = id === this.focusId && focusDistance < FOCUS_LABEL_DISTANCE && distance < BEACON_FADE[1];
      if (hide) label.el.style.visibility = 'hidden';
      else this._project(label.el, label.anchor, w, h, v);
    }
    for (const chip of this.overlay.chips) this._project(chip.el, chip.anchor, w, h, v);
  }

  // ----------------------------------------------- view-dependent

  /** Fog, shadow coverage and beacons follow the camera so any zoom level reads well. */
  _updateViewDependent(distance) {
    const fog = this.scene.fog;
    fog.near = Math.max(150, distance * 0.95);
    fog.far = Math.max(330, distance * 2.1);

    // Shadow frustum: centred on the view, wider when zoomed out (snapped to avoid shimmer).
    const t = this.controls.target;
    const snap = 8;
    const extent = THREE.MathUtils.clamp(Math.ceil((distance * 0.9) / 50) * 50, SHADOW_MIN, SHADOW_MAX);
    if (extent !== this.shadowExtent) this._fitShadow(extent);
    this.sun.target.position.set(Math.round(t.x / snap) * snap, 0, Math.round(t.z / snap) * snap);
    this.sun.position.copy(this.sun.target.position).addScaledVector(this.sunDir, this.sunDistance);

    const k = THREE.MathUtils.smoothstep(distance, BEACON_FADE[0], BEACON_FADE[1]);
    for (const site of this.sites.values()) site.lights.setBeaconOpacity(k);
  }

  /**
   * Square shadow frustum of half-size `extent` around the view. The sun
   * backs off as the frustum grows so the far corners (which lie closer to
   * the slanted light) stay inside its depth range.
   */
  _fitShadow(extent) {
    this.shadowExtent = extent;
    this.sunDistance = extent + 150;
    const sc = this.sun.shadow.camera;
    sc.left = -extent;
    sc.right = extent;
    sc.top = extent;
    sc.bottom = -extent;
    sc.near = 10;
    sc.far = 1.8 * extent + 220;
    sc.updateProjectionMatrix();
  }

  _resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Pull back a little on narrow viewports so all four approaches fit.
    this.camera.fov = w / h < 1.2 ? 46 : 36;
    this.camera.updateProjectionMatrix();
    if (this.layout) this._updateZoomLimits();
  }

  // The single animation loop. Started once in the constructor; backend
  // updates only change state that this loop reads.
  _frame() {
    requestAnimationFrame(this._frame);
    // Clamp long pauses (hidden tab), then advance the simulation in fixed
    // sub-steps so traffic stays in real time even at low frame rates.
    const dt = Math.min(this.clock.getDelta(), MAX_FRAME_DT);
    // Each intersection stands still while its data is stale or the backend
    // is offline; all of them while the simulation is stopped or paused. The
    // scene keeps rendering so the camera stays usable.
    for (let left = dt; left > 1e-6; left -= SIM_STEP) {
      const step = Math.min(SIM_STEP, left);
      this.time += step;
      for (const site of this.sites.values()) {
        if (!site.isFrozen(this.frozen)) site.update(step, this.time);
      }
    }

    if (this.tween) {
      this.tween.t = Math.min(1, this.tween.t + dt / this.tween.duration);
      const x = this.tween.t;
      const k = x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2; // ease in-out
      this.camera.position.lerpVectors(this.tween.fromPos, this.tween.toPos, k);
      this.controls.target.lerpVectors(this.tween.fromTarget, this.tween.toTarget, k);
      if (this.tween.t >= 1) this.tween = null;
    }
    this.controls.update();
    for (const site of this.sites.values()) site.lights.update(this.time);

    const distance = this.camera.position.distanceTo(this.controls.target);
    this.overlay.update(dt, this.clock.elapsedTime, distance);
    this._updateViewDependent(distance);
    this.renderer.render(this.scene, this.camera);
    this._updateOverlays(distance);

    if (this.compassNeedle) {
      this.compassNeedle.style.transform = `rotate(${this.controls.getAzimuthalAngle()}rad)`;
    }
  }
}
