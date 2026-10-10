/**
 * Validation for perception data arriving at POST /api/traffic.
 *
 * Input from the AI side is untrusted: every field is type- and range-checked
 * and the result is a normalised "observation". Nothing here throws on bad
 * input; problems are returned as error strings.
 *
 *   validateObservation(body)   -> { ok, value: Observation, warnings } | { ok: false, errors }
 *   toDecisionInput(observation) -> the shape trafficDecisionService.ingest() expects
 *   validateTrafficPayload(body) -> validateObservation + toDecisionInput (kept for existing callers)
 */

const DIRECTIONS = ['north', 'south', 'east', 'west'];
// "emergency": an emergency vehicle whose service is unknown (the AI service's
// Roboflow workflow detects one class, "emergency-car").
const EMERGENCY_TYPES = ['ambulance', 'police', 'fire_truck', 'emergency'];

const EMERGENCY_TYPE_ALIASES = {
  ambulance: 'ambulance',
  police: 'police',
  police_car: 'police',
  fire_truck: 'fire_truck',
  firetruck: 'fire_truck',
  fire: 'fire_truck',
  fire_engine: 'fire_truck',
  emergency: 'emergency',
  emergency_car: 'emergency',
  emergency_vehicle: 'emergency',
};

// Sanity caps: values above these are almost certainly a bug upstream.
const LIMITS = {
  vehicles: 1000,
  queueLength: 1000,
  waitingTime: 3600,
};

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// Optional per-approach detections by object class, e.g. { car: 5, bus: 1 }.
const CLASS_PATTERN = /^[a-z][a-z ]{0,31}$/;
const MAX_CLASSES = 16;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMissing(value) {
  return value === undefined || value === null;
}

function checkNonNegative(errors, path, value, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${path} must be a number`);
    return false;
  }
  if (value < 0 || value > max) {
    errors.push(`${path} must be between 0 and ${max}`);
    return false;
  }
  return true;
}

function unknownKeys(object, allowed) {
  return Object.keys(object).filter((k) => !allowed.includes(k));
}

function validateClasses(errors, path, classes) {
  if (isMissing(classes)) return null;
  const entries = isPlainObject(classes) ? Object.entries(classes) : null;
  if (!entries || entries.length > MAX_CLASSES || !entries.every(([name, count]) => CLASS_PATTERN.test(name)
    && Number.isInteger(count) && count >= 0 && count <= LIMITS.vehicles)) {
    errors.push(`${path} must map up to ${MAX_CLASSES} lowercase class names to vehicle counts`);
    return null;
  }
  return Object.fromEntries(entries);
}

function validateConfidence(errors, path, value) {
  if (isMissing(value)) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    errors.push(`${path} must be a number between 0 and 1 or null`);
    return null;
  }
  return value;
}

/**
 * Each approach is an object, or null when the producer has no source for it
 * (e.g. its camera video is missing). A null approach is kept as null: it is
 * shown as unavailable, never as zero traffic. At least one must be present.
 */
function validateTraffic(errors, traffic) {
  const out = {};
  if (!isPlainObject(traffic)) {
    errors.push('traffic must be an object with north, south, east and west');
    return out;
  }
  for (const key of unknownKeys(traffic, DIRECTIONS)) {
    errors.push(`traffic.${key} is not a valid direction (use ${DIRECTIONS.join(', ')})`);
  }
  if (DIRECTIONS.every((dir) => traffic[dir] === null)) {
    errors.push('traffic must contain at least one available approach');
    return out;
  }
  for (const dir of DIRECTIONS) {
    const entry = traffic[dir];
    if (entry === null) {
      out[dir] = null;
      continue;
    }
    if (!isPlainObject(entry)) {
      errors.push(`traffic.${dir} is required and must be an object (or null when unavailable)`);
      continue;
    }
    // `waitingTime` is the contract name; `waiting` is accepted for older producers.
    const waitingKey = entry.waitingTime !== undefined ? 'waitingTime' : 'waiting';
    const okV = checkNonNegative(errors, `traffic.${dir}.vehicles`, entry.vehicles, LIMITS.vehicles);
    const okQ = checkNonNegative(errors, `traffic.${dir}.queueLength`, entry.queueLength, LIMITS.queueLength);
    const okW = checkNonNegative(errors, `traffic.${dir}.${waitingKey}`, entry[waitingKey], LIMITS.waitingTime);
    const classes = validateClasses(errors, `traffic.${dir}.classes`, entry.classes);
    const confidence = validateConfidence(errors, `traffic.${dir}.confidence`, entry.confidence);
    if (okV && okQ && okW) {
      out[dir] = {
        vehicles: entry.vehicles,
        queueLength: entry.queueLength,
        waitingTime: Math.round(entry[waitingKey] * 10) / 10,
        classes,
        confidence,
      };
    }
  }
  return out;
}

function validatePedestrians(errors, pedestrians) {
  const out = { north: false, south: false, east: false, west: false };
  if (isMissing(pedestrians)) return out;
  if (!isPlainObject(pedestrians)) {
    errors.push('pedestrians must be an object of booleans keyed by direction');
    return out;
  }
  for (const key of unknownKeys(pedestrians, DIRECTIONS)) {
    errors.push(`pedestrians.${key} is not a valid direction (use ${DIRECTIONS.join(', ')})`);
  }
  for (const dir of DIRECTIONS) {
    const value = pedestrians[dir];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') errors.push(`pedestrians.${dir} must be a boolean`);
    else out[dir] = value;
  }
  return out;
}

function validateEmergency(errors, warnings, emergency) {
  const out = { detected: false, type: null, direction: null, confidence: 0 };
  if (isMissing(emergency)) return out;
  if (!isPlainObject(emergency)) {
    errors.push('emergency must be an object');
    return out;
  }
  if (typeof emergency.detected !== 'boolean') {
    errors.push('emergency.detected must be a boolean');
    return out;
  }

  const { detected } = emergency;

  let direction = null;
  if (!isMissing(emergency.direction)) {
    if (DIRECTIONS.includes(emergency.direction)) direction = emergency.direction;
    else errors.push(`emergency.direction must be one of ${DIRECTIONS.join(', ')} or null`);
  }

  let confidence = 0;
  if (!isMissing(emergency.confidence) || detected) {
    const c = emergency.confidence;
    if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 1) {
      errors.push('emergency.confidence must be a number between 0 and 1');
    } else {
      confidence = c;
    }
  }

  if (!detected) return out; // type/direction/confidence of a non-detection are not kept

  const rawType = typeof emergency.type === 'string'
    ? emergency.type.trim().toLowerCase().replace(/[\s-]+/g, '_')
    : null;
  const type = rawType ? EMERGENCY_TYPE_ALIASES[rawType] : undefined;
  if (!type) errors.push(`emergency.type must be one of ${EMERGENCY_TYPES.join(', ')}`);

  if (direction === null && isMissing(emergency.direction)) {
    warnings.push('emergency detected without a direction: stored, but cannot be given signal priority');
  }
  return { detected: true, type: type || null, direction, confidence };
}

/**
 * Validates and normalises one perception payload.
 * Unknown top-level fields are ignored so producers can add metadata.
 */
function validateObservation(body) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(body)) {
    return { ok: false, errors: ['Request body must be a JSON object'] };
  }

  const { intersectionId } = body;
  if (typeof intersectionId !== 'string' || !ID_PATTERN.test(intersectionId)) {
    errors.push('intersectionId must be a string of 1-64 characters [A-Za-z0-9_-]');
  }

  let timestamp = null;
  if (!isMissing(body.timestamp)) {
    const ms = typeof body.timestamp === 'string' ? Date.parse(body.timestamp) : NaN;
    if (Number.isNaN(ms)) {
      errors.push('timestamp must be an ISO-8601 date string (or omitted)');
    } else {
      timestamp = new Date(ms).toISOString();
      if (ms - Date.now() > FUTURE_TOLERANCE_MS) {
        warnings.push('timestamp is more than 5 minutes in the future - check the producer clock');
      }
    }
  }

  let source = null;
  if (!isMissing(body.source)) {
    if (typeof body.source !== 'string' || body.source.length > 32) errors.push('source must be a string of at most 32 characters');
    else source = body.source.trim().toLowerCase();
  }

  const traffic = validateTraffic(errors, body.traffic);
  const pedestrians = validatePedestrians(errors, body.pedestrians);
  const emergency = validateEmergency(errors, warnings, body.emergency);

  if (errors.length) return { ok: false, errors };
  // Which detectors the producer actually ran. An omitted `pedestrians` or
  // `emergency` means "not measured", which the dashboard must not show as
  // "none detected".
  const detectors = { pedestrians: !isMissing(body.pedestrians), emergency: !isMissing(body.emergency) };
  return {
    ok: true,
    warnings,
    value: { intersectionId, timestamp, source, traffic, pedestrians, emergency, detectors },
  };
}

/**
 * Maps a validated observation to the decision engine's input shape.
 * An emergency without a direction cannot be prioritised, so it is passed
 * on as "not detected" (it remains visible in the stored observation).
 */
function toDecisionInput(observation) {
  const traffic = {};
  for (const dir of DIRECTIONS) {
    const t = observation.traffic[dir];
    traffic[dir] = t === null
      ? null
      : { vehicles: t.vehicles, waiting: t.waitingTime, queueLength: t.queueLength, classes: t.classes, confidence: t.confidence };
  }
  const em = observation.emergency;
  const actionable = em.detected && em.direction !== null;
  return {
    intersectionId: observation.intersectionId,
    timestamp: observation.timestamp,
    source: observation.source,
    traffic,
    pedestrians: { ...observation.pedestrians },
    detectors: { ...observation.detectors },
    emergency: actionable
      ? { ...em }
      : { detected: false, type: null, direction: null, confidence: 0 },
  };
}

/** Existing entry point: validate and return the decision-engine shape. */
function validateTrafficPayload(body) {
  const result = validateObservation(body);
  if (!result.ok) return result;
  return { ok: true, warnings: result.warnings, value: toDecisionInput(result.value) };
}

module.exports = {
  DIRECTIONS,
  EMERGENCY_TYPES,
  LIMITS,
  ID_PATTERN,
  validateObservation,
  validateTrafficPayload,
  toDecisionInput,
};
