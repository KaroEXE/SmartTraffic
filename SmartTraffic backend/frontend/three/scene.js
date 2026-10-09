import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  DIRS, LAYOUT, approach, pathPoint, buildStaticIntersection, buildCityBlocks,
} from './intersection.js';
import { TrafficLights } from './trafficLights.js';
import { VehicleSystem } from './vehicles.js';
import { PedestrianSystem } from './pedestrians.js';

/**
 * 3D digital twin of the selected intersection.
 *
 *   const scene = new TrafficScene(container, { tagLayer, compass });
 *   scene.loadIntersection(snapshot);   // on selection
 *   scene.applyState(snapshot);         // on every backend update
 *
 * The scene never decides signal state; it renders what the backend sends.
 */

const HOME = {
  position: new THREE.Vector3(58, 112, 104),
  target: new THREE.Vector3(0, 0, 4),
};
const BG = 0x0d1013;
const SIM_STEP = 0.05;     // s, simulation sub-step
const MAX_FRAME_DT = 0.25; // s, longest frame gap simulated in one go

export class TrafficScene {
  constructor(container, { tagLayer = null, compass = null } = {}) {
    this.container = container;
    this.tagLayer = tagLayer;
    this.compass = compass;
    this.time = 0;
    this.tween = null;
    this.snapshot = null;
    this.frozen = false;

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

    this.camera = new THREE.PerspectiveCamera(36, 1, 1, 1200);
    this.camera.position.copy(HOME.position);

    const controls = new OrbitControls(this.camera, renderer.domElement);
    controls.target.copy(HOME.target);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.55;
    controls.zoomSpeed = 0.8;
    controls.panSpeed = 0.6;
    controls.screenSpacePanning = false;
    controls.minDistance = 30;
    controls.maxDistance = 260;
    controls.minPolarAngle = 0.12;
    controls.maxPolarAngle = 1.32;
    controls.addEventListener('change', () => {
      // Keep the pivot on the ground and near the junction.
      const t = controls.target;
      t.y = 0;
      t.x = THREE.MathUtils.clamp(t.x, -70, 70);
      t.z = THREE.MathUtils.clamp(t.z, -70, 70);
    });
    controls.addEventListener('start', () => { this.tween = null; });
    controls.update();
    this.controls = controls;

    // Lighting: soft sky fill + one shadow-casting sun.
    scene.add(new THREE.HemisphereLight(0xdfe7f0, 0x1b1e22, 1.15));
    const sun = new THREE.DirectionalLight(0xffffff, 2.0);
    sun.position.set(-70, 140, 55);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -125;
    sc.right = 125;
    sc.top = 125;
    sc.bottom = -125;
    sc.near = 20;
    sc.far = 360;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    scene.add(sun);

    scene.add(buildStaticIntersection());
    this.city = null;
    this.lights = new TrafficLights(scene);
    this.vehicles = new VehicleSystem(scene);
    this.peds = new PedestrianSystem(scene);

    this._createTags();

    this._resize = this._resize.bind(this);
    new ResizeObserver(this._resize).observe(container);
    this._resize();

    this.clock = new THREE.Clock();
    this._frame = this._frame.bind(this);
    requestAnimationFrame(this._frame);
  }

  // ------------------------------------------------------------ public

  loadIntersection(snapshot) {
    if (this.city) {
      this.scene.remove(this.city);
      this.city.traverse((o) => o.geometry && o.geometry.dispose());
    }
    this.city = buildCityBlocks(snapshot.intersectionId);
    this.scene.add(this.city);

    this.vehicles.reset();
    this.peds.reset();
    this.applyState(snapshot);
    this.vehicles.prefill();
  }

  applyState(snapshot) {
    this.snapshot = snapshot;
    this.lights.setState(snapshot.signals, snapshot.pedestrianSignals);
    this.vehicles.setSignals(snapshot.signals);
    this.vehicles.setDemand(snapshot.traffic);
    this.vehicles.setEmergency(snapshot.emergency);
    this.peds.setState(snapshot.pedestrianSignals, snapshot.pedestrianRequests);
    this._updateTagContent();
  }

  /** Stops (true) or resumes (false) vehicle and pedestrian motion without touching state. */
  setFrozen(frozen) {
    this.frozen = Boolean(frozen);
  }

  resetView() {
    this.tween = {
      t: 0,
      fromPos: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
    };
  }

  // ------------------------------------------------------------ internals

  _createTags() {
    this.tags = {};
    if (!this.tagLayer) return;
    const { stopS } = approach('north');
    for (const dir of DIRS) {
      const el = document.createElement('div');
      el.className = 'tag';
      el.innerHTML = `<span class="tag-dir">${dir.toUpperCase()}</span><span class="tag-count"></span><span class="tag-prio" hidden>PRIORITY</span>`;
      this.tagLayer.appendChild(el);
      const p = pathPoint(dir, stopS - 20, LAYOUT.roadHalf / 2);
      this.tags[dir] = {
        el,
        count: el.querySelector('.tag-count'),
        prio: el.querySelector('.tag-prio'),
        anchor: new THREE.Vector3(p.x, 4.5, p.z),
      };
    }
  }

  _updateTagContent() {
    const s = this.snapshot;
    if (!s) return;
    for (const dir of DIRS) {
      const tag = this.tags[dir];
      if (!tag) continue;
      const state = s.signals[dir];
      const priority = s.emergency && s.emergency.active && s.emergency.direction === dir;
      tag.el.className = `tag s-${state}${priority ? ' priority' : ''}`;
      tag.count.textContent = `${s.traffic[dir].vehicles} veh`;
      tag.prio.hidden = !priority;
    }
  }

  _updateTagPositions() {
    if (!this.tagLayer) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const v = new THREE.Vector3();
    for (const dir of DIRS) {
      const tag = this.tags[dir];
      v.copy(tag.anchor).project(this.camera);
      const visible = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
      tag.el.style.visibility = visible ? 'visible' : 'hidden';
      if (visible) {
        const x = (v.x + 1) / 2 * w;
        const y = (1 - v.y) / 2 * h;
        tag.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
      }
    }
  }

  _resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Pull back a little on narrow viewports so all four approaches fit.
    this.camera.fov = w / h < 1.2 ? 46 : 36;
    this.camera.updateProjectionMatrix();
  }

  // The single animation loop. Started once in the constructor; backend
  // updates only change state that this loop reads.
  _frame() {
    requestAnimationFrame(this._frame);
    // Clamp long pauses (hidden tab), then advance the simulation in fixed
    // sub-steps so traffic stays in real time even at low frame rates.
    const dt = Math.min(this.clock.getDelta(), MAX_FRAME_DT);
    // While frozen (paused / stopped simulation) traffic stands still; the
    // scene keeps rendering so the camera stays usable.
    for (let left = this.frozen ? 0 : dt; left > 1e-6; left -= SIM_STEP) {
      const step = Math.min(SIM_STEP, left);
      this.time += step;
      this.vehicles.update(step, this.time, (dir) => this.peds.isCrosswalkBusy(dir));
      this.peds.update(step, this.time);
    }

    if (this.tween) {
      this.tween.t = Math.min(1, this.tween.t + dt / 0.9);
      const k = 1 - (1 - this.tween.t) ** 3;
      this.camera.position.lerpVectors(this.tween.fromPos, HOME.position, k);
      this.controls.target.lerpVectors(this.tween.fromTarget, HOME.target, k);
      if (this.tween.t >= 1) this.tween = null;
    }
    this.controls.update();
    this.lights.update(this.time);

    this.renderer.render(this.scene, this.camera);
    this._updateTagPositions();

    if (this.compass) {
      this.compass.style.transform = `rotate(${this.controls.getAzimuthalAngle()}rad)`;
    }
  }
}
