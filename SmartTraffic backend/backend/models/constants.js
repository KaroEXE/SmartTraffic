const { DIRECTIONS, EMERGENCY_TYPES, LIMITS } = require('../utils/validation');

// Values produced by services/trafficDecisionService.js.
const MODES = ['NORMAL', 'EMERGENCY', 'PEDESTRIAN', 'FALLBACK'];
const PHASES = ['GREEN', 'YELLOW', 'ALL_RED', 'PED_WALK', 'PED_CLEAR'];
const VEHICLE_SIGNALS = ['RED', 'YELLOW', 'GREEN'];
const PEDESTRIAN_SIGNALS = ['DONT_WALK', 'WALK', 'CLEARANCE'];

// Where a record came from. `simulation` is never real traffic.
const DATA_MODES = ['live', 'simulation'];
// Producer tags that mean "simulated" regardless of dataMode (rows written
// before dataMode existed carry source "mock").
const SIMULATED_SOURCES = ['mock', 'simulation'];

/**
 * The only sanctioned way to select history by mode. Live is everything that
 * is not simulated (rows without dataMode count as live unless their source
 * says otherwise); simulation is the complement.
 */
function modeFilter(mode) {
  if (mode === 'simulation') {
    return { $or: [{ dataMode: 'simulation' }, { source: { $in: SIMULATED_SOURCES } }] };
  }
  if (mode === 'live') {
    return { dataMode: { $ne: 'simulation' }, source: { $nin: SIMULATED_SOURCES } };
  }
  throw new Error(`Unknown data mode "${mode}"`);
}

/** Schema definition with one required field per approach (north/south/east/west). */
function perDirection(makeField) {
  return Object.fromEntries(DIRECTIONS.map((d) => [d, makeField()]));
}

module.exports = {
  DIRECTIONS,
  EMERGENCY_TYPES,
  LIMITS,
  MODES,
  PHASES,
  VEHICLE_SIGNALS,
  PEDESTRIAN_SIGNALS,
  DATA_MODES,
  SIMULATED_SOURCES,
  modeFilter,
  perDirection,
};
