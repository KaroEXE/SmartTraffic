import * as THREE from 'three';
import { TrafficLights } from './trafficLights.js';
import { VehicleSystem } from './vehicles.js';
import { PedestrianSystem } from './pedestrians.js';

/**
 * One managed intersection in the 3D network: its own signals, vehicles and
 * pedestrians in a group placed at its junction. Every site keeps its own
 * snapshot and data state and owns its own objects, so an update for one
 * intersection id can never change another intersection.
 *
 * Data states (the same meaning as TrafficScene.setDataState):
 *   live        fresh AI data: vehicles follow the detected counts
 *   simulation  the Simulation tab's data: drawn like live data
 *   waiting     no AI data yet: no vehicles
 *   stale       AI data stopped: the last picture stays, frozen
 *   offline     backend unreachable: as stale
 * The traffic lights always show the signals the backend last sent for
 * this intersection, and stay dark until it has sent any.
 */

export const DRAWS_TRAFFIC = new Set(['live', 'simulation']);
const FROZEN_STATES = new Set(['stale', 'offline']);

export class IntersectionSite {
  /**
   * @param {THREE.Object3D} parent
   * @param {{ id: string, name: string, x: number, z: number }} slot  from layoutNetwork().sites
   */
  constructor(parent, slot) {
    this.id = slot.id;
    this.name = slot.name;
    this.origin = new THREE.Vector3(slot.x, 0, slot.z);
    this.parent = parent;
    this.group = new THREE.Group();
    this.group.name = `intersection:${slot.id}`;
    this.group.position.copy(this.origin);
    parent.add(this.group);

    this.lights = new TrafficLights(this.group);
    this.vehicles = new VehicleSystem(this.group);
    this.peds = new PedestrianSystem(this.group);
    this.snapshot = null;
    this.dataState = null;
  }

  get drawsTraffic() {
    return DRAWS_TRAFFIC.has(this.dataState);
  }

  /** Motion stops for stale / offline data, or when the scene is paused. */
  isFrozen(paused) {
    return Boolean(paused) || FROZEN_STATES.has(this.dataState);
  }

  /**
   * Draws one backend snapshot of THIS intersection. Snapshots for another
   * id are refused (returns false), so a mis-routed update cannot leak.
   */
  apply(snapshot, dataState) {
    if (!snapshot || snapshot.intersectionId !== this.id) return false;
    const prev = this.dataState;
    const wasDrawing = DRAWS_TRAFFIC.has(prev);
    this.snapshot = snapshot;
    this.dataState = dataState;
    const draws = this.drawsTraffic;
    const simulation = dataState === 'simulation';

    if (dataState === 'waiting' && prev !== 'waiting') this.clearTraffic();

    this.lights.setState(snapshot.signals || {}, snapshot.pedestrianSignals);
    this.vehicles.setSignals(snapshot.signals || {});
    // Only live (or simulation) data adds or removes vehicles; stale data
    // leaves the frozen picture alone.
    if (draws) this.vehicles.setDemand(snapshot.traffic, { varied: simulation });
    else if (dataState === 'waiting') this.vehicles.setDemand(null);
    this.vehicles.setEmergency(draws ? snapshot.emergency : null);
    this.peds.setMode(simulation ? 'simulation' : 'live');
    this.peds.setState(snapshot.pedestrianSignals, draws ? snapshot.pedestrianRequests : {});
    // Data that draws traffic arrived: show the reported vehicles at once.
    if (draws && !wasDrawing) this.vehicles.prefill();
    return true;
  }

  /** Re-applies the last snapshot under a new data state (e.g. the connection dropped). */
  setDataState(dataState) {
    if (this.snapshot && dataState !== this.dataState) this.apply(this.snapshot, dataState);
  }

  /** Forgets vehicles and pedestrians; the next apply() starts from a clean picture. */
  reload() {
    this.clearTraffic();
    this.dataState = null;
  }

  clearTraffic() {
    this.vehicles.reset();
    this.peds.reset();
  }

  update(step, time) {
    this.vehicles.update(step, time, (dir) => this.peds.isCrosswalkBusy(dir));
    this.peds.update(step, time);
  }

  dispose() {
    this.clearTraffic();
    this.lights.dispose();
    this.parent.remove(this.group);
  }
}
