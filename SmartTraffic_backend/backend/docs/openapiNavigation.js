/**
 * OpenAPI paths and schemas of the mobile navigation API (/api/v1),
 * merged into docs/openapi.js. Enumerations come from
 * models/navigationConstants.js so the document cannot drift from the code;
 * test/navigationApi.test.js checks that every route is documented.
 */
const {
  FEATURE_KINDS, REPORT_TYPES, PUBLIC_REPORT_STATUSES, MODERATION_STATUSES, REPORT_VOTES, PLATFORMS, PLACE_CATEGORIES, LOCAL_PLACE_CATEGORIES, SAVED_PLACE_KINDS, LIMITS,
} = require('../models/navigationConstants');
const { DIRECTIONS } = require('../utils/validation');

module.exports = function navigationSpec({
  ref, object, array, str, num, bool, date, nullableDate,
}) {
  const nullable = (schema) => ({ ...schema, nullable: true });
  const int = { type: 'integer' };
  const enumOf = (values, extra = {}) => ({ type: 'string', enum: values, ...extra });
  const json = (schema, examples) => ({ 'application/json': { schema, ...(examples ? { examples } : {}) } });
  const response = (description, schema, examples) => ({ description, content: json(schema, examples) });
  const ok = (properties, required = []) => object({ ok: { type: 'boolean', enum: [true] }, ...properties }, ['ok', ...required]);
  const error = (description) => response(description, ref('NavError'));
  const lat = { type: 'number', minimum: -90, maximum: 90, example: 35.5617 };
  const lng = { type: 'number', minimum: -180, maximum: 180, example: 45.4329 };
  const objectId = { type: 'string', pattern: '^[a-f0-9]{24}$', example: '671f3a2b9c4e5d6f7a8b9c0d' };
  const query = (name, schema, description, required = false) => ({
    name, in: 'query', required, schema, ...(description ? { description } : {}),
  });
  const bboxParams = (required = true) => ['south', 'west', 'north', 'east'].map((n) => query(n, { type: 'number' },
    `Map area edge in degrees. ${required ? 'Required. ' : 'Optional (all four or none). '}At most ${LIMITS.maxBBoxSpanDeg} degrees per side${required ? '' : ' (5 for /traffic)'}; boxes across the antimeridian are not supported.`, required));
  const idParam = { name: 'id', in: 'path', required: true, schema: objectId };
  const rateLimited = error('Rate limit exceeded (RATE_LIMITED); see Retry-After');
  const device = [{ deviceToken: [] }];
  const admin = [{ navAdminToken: [] }];

  const schemas = {
    NavError: object({
      ok: { type: 'boolean', enum: [false] },
      code: {
        type: 'string',
        description: 'Stable machine-readable error code. Switch on this, not on `error`.',
        enum: ['INVALID_REQUEST', 'MALFORMED_JSON', 'UNSUPPORTED_MEDIA_TYPE', 'PAYLOAD_TOO_LARGE', 'NOT_FOUND',
          'DEVICE_TOKEN_REQUIRED', 'DEVICE_TOKEN_INVALID', 'DEVICE_TOKEN_EXPIRED', 'ADMIN_TOKEN_INVALID',
          'EMAIL_TAKEN', 'INVALID_CREDENTIALS', 'WRONG_PASSWORD','USER_TOKEN_REQUIRED', 'USER_TOKEN_INVALID', 'USER_TOKEN_EXPIRED',
          'CANNOT_VOTE_OWN_REPORT', 'NOT_REPORT_OWNER', 'ALREADY_VOTED', 'REPORT_NOT_ACTIVE', 'DUPLICATE_REPORT',
          'REPORT_LIMIT_REACHED', 'RATE_LIMITED', 'NO_ROUTE', 'POINT_NOT_ROUTABLE',
          'PROVIDER_ERROR', 'PROVIDER_UNREACHABLE', 'PROVIDER_TIMEOUT', 'PROVIDER_BUSY',
          'PROVIDER_QUOTA_EXCEEDED', 'PROVIDER_AUTH_FAILED', 'SAVED_PLACE_LIMIT',
          'DATABASE_UNAVAILABLE', 'GEO_DATABASE_UNAVAILABLE', 'GEO_QUERY_TIMEOUT', 'GEO_DATA_NOT_READY', 'METHOD_NOT_ALLOWED',
          'FEATURE_DISABLED', 'SERVICE_UNAVAILABLE', 'INTERNAL_ERROR'],
      },
      error: { type: 'string', description: 'English description for logs and developers; may change.' },
      details: array(str),
      retryAfterSeconds: int,
      reportId: { type: 'string', description: 'DUPLICATE_REPORT only: the existing report.' },
    }, ['ok', 'code', 'error']),
    LatLng: object({ lat, lng }, ['lat', 'lng']),
    BBox: object({
      south: num, west: num, north: num, east: num,
    }, ['south', 'west', 'north', 'east']),
    Attribution: object({
      text: { type: 'string', example: '© OpenStreetMap contributors', description: 'Show this text wherever search results or places are shown (OpenStreetMap data, ODbL). Routes also need "Powered by Geoapify" (see GET /api/v1/config attribution[].requiredFor).' },
      url: str,
      provider: { type: 'string', enum: ['OpenFreeMap', 'OpenStreetMap', 'Geoapify'] },
      providerUrl: { type: 'string', description: 'Link for the provider name (Geoapify).' },
    }),
    LineString: object({
      type: enumOf(['LineString']),
      coordinates: { type: 'array', items: { type: 'array', items: num, minItems: 2, maxItems: 2 }, description: 'GeoJSON positions [lng, lat] (longitude first).' },
    }, ['type', 'coordinates']),

    DeviceToken: ok({
      renewed: { type: 'boolean', description: 'true: a fresh token for the device in the Authorization header.' },
      tokenType: enumOf(['Bearer']),
      token: { type: 'string', description: 'Absent when the current token is still valid for more than 7 days (renewed=false): keep using it.' },
      deviceId: { type: 'string', format: 'uuid' },
      issuedAt: date,
      expiresAt: date,
    }, ['deviceId', 'expiresAt']),
    User: object({
      id: objectId,
      email: { type: 'string', format: 'email', example: 'driver@example.com' },
      name: nullable({ type: 'string', maxLength: LIMITS.userNameMaxLength, example: 'Sara' }),
      createdAt: date,
    }, ['id', 'email', 'name', 'createdAt']),
    UserSession: ok({
      tokenType: enumOf(['Bearer']),
      token: { type: 'string', description: 'User token (JWT). Store it securely and send it as "Authorization: Bearer <token>".' },
      expiresAt: date,
      user: ref('User'),
    }, ['tokenType', 'token', 'expiresAt', 'user']),

    Place: object({
      id: { type: 'string', example: 'osm:w123456', description: '"osm:<n|w|r|s|a><id>" for an OpenStreetMap result, "redoz:<uuid>" for a Redoz-owned place, "hawr:<id>" for one of the operator\'s local places (MongoDB). Opaque: never parse it.' },
      name: str,
      address: nullable(str),
      lat,
      lng,
      category: nullable({ type: 'string', description: 'Redoz category (hospital, shopping_mall, fuel, street, city, ...) or, for a local place, its category.' }),
      type: nullable({ type: 'string', description: 'Kind of result: amenity, street, area, a settlement type (city, town, village, suburb ...), building or locality (reverse), or "local" for a local place.' }),
      source: { type: 'string', enum: ['osm', 'redoz', 'hawr'] },
      boundingBox: nullable(object({ south: num, west: num, north: num, east: num }, ['south', 'west', 'north', 'east'])),
      addressDetails: nullable(object({
        road: nullable(str), houseNumber: nullable(str), suburb: nullable(str), city: nullable(str),
        state: nullable(str), postcode: nullable(str), country: nullable(str), countryCode: nullable(str),
      })),
    }, ['id', 'name', 'lat', 'lng']),
    GeoPlace: object({
      id: { type: 'string', example: 'osm:w123456', description: '"osm:<n|w|r|s|a><id>" (OpenStreetMap node, way, relation, street, administrative area) or "redoz:<uuid>" (Redoz-owned place). Opaque: never parse it.' },
      name: nullable({ type: 'string', description: 'In the requested language when OpenStreetMap has it, else the local name.' }),
      type: { type: 'string', example: 'shopping_mall', description: 'Redoz category: hospital, school, restaurant, fuel, shopping_mall, street, city, area, ...' },
      category: { type: 'string', example: 'shopping_mall', description: 'Same as type.' },
      latitude: lat,
      longitude: lng,
      address: nullable(str),
      source: { type: 'string', enum: ['osm', 'redoz'] },
      entity: { type: 'string', enum: ['poi', 'settlement', 'street', 'area'] },
      verified: { type: 'boolean', description: 'Confirmed by Redoz (true only for Redoz data).' },
      distanceMeters: nullable({ type: 'integer', description: 'From lat/lng; null when no position was given.' }),
      names: object({
        default: nullable(str), ar: nullable(str), ckb: nullable(str), en: nullable(str),
      }),
      addressDetails: nullable(object({
        road: nullable(str), houseNumber: nullable(str), suburb: nullable(str), city: nullable(str), state: nullable(str), postcode: nullable(str), country: nullable(str),
      })),
      boundingBox: nullable(ref('BBox')),
    }, ['id', 'name', 'type', 'category', 'latitude', 'longitude', 'address', 'source', 'entity', 'verified', 'distanceMeters', 'names']),
    GeoRoad: object({
      id: { type: 'string', example: 'osm:w98765' },
      osmWayId: int,
      name: nullable(str),
      type: { type: 'string', example: 'residential', description: 'OpenStreetMap highway class.' },
      ref: nullable(str), oneway: nullable(str), maxspeed: nullable(str), lanes: nullable(str), surface: nullable(str),
      access: nullable(str), junction: nullable(str), bridge: nullable(str), tunnel: nullable(str),
      distanceMeters: int,
    }, ['id', 'osmWayId', 'type', 'distanceMeters']),
    NearbyPlace: object({
      id: str, name: nullable(str), category: enumOf(Object.keys(PLACE_CATEGORIES)),
      providerCategory: nullable({ type: 'string', description: "What OpenStreetMap calls it (the tag value), e.g. fuel or fast_food." }),
      lat, lng,
      distanceMeters: int,
      rating: nullable({ type: 'number', description: 'Average rating; null when there are no reviews.' }),
      reviewCount: int,
      openingHours: nullable({ type: 'string', example: 'Mo-Fr 08:00-17:00', description: 'OpenStreetMap opening_hours syntax, as mapped. null: no hours on record.' }),
      address: { type: 'string', nullable: true, description: 'Address text when OpenStreetMap or the administrative areas give one; null otherwise.' },
      details: object({
        brand: nullable(str), operator: nullable(str), openingHours: nullable(str), phone: nullable(str), website: nullable(str),
      }),
      url: { type: 'string', nullable: true, description: 'Always null: kept so apps written for the earlier answer do not break.' },
    }),

    Maneuver: object({
      type: nullable({ type: 'string', description: 'Maneuver type (OSRM-style): depart, turn, new name, continue, merge, on ramp, off ramp, fork, end of road, roundabout, rotary, exit roundabout, notification, arrive.' }),
      modifier: nullable({ type: 'string', description: 'uturn, sharp right, right, slight right, straight, slight left, left, sharp left.' }),
      location: { type: 'array', items: num, description: '[lng, lat] of the maneuver.' },
      bearingBefore: nullable(num), bearingAfter: nullable(num),
      exit: nullable({ type: 'integer', description: 'Roundabout exit number.' }),
    }),
    RouteStep: object({
      distance: { type: 'number', description: 'Metres until the next step.' },
      duration: { type: 'number', description: 'Seconds until the next step.' },
      name: nullable(str), ref: nullable(str), mode: nullable(str),
      instruction: { type: 'string', description: 'Short English text (convenience). Build localized text from `maneuver`.' },
      maneuver: ref('Maneuver'),
    }),
    RouteIntersection: object({
      id: str, name: str, positionSource: nullable(enumOf(['surveyed', 'unknown'])),
      status: enumOf(['live', 'stale', 'no-data']),
      alongMeters: { type: 'integer', description: 'Distance from the route start.' },
      approach: nullable(enumOf(DIRECTIONS, { description: 'Approach the route enters by (where vehicles come from).' })),
      delaySeconds: num,
      included: { type: 'boolean', description: 'true = this live delay is part of the estimate.' },
      reason: nullable(enumOf(['stale', 'no-data', 'video-unavailable'])),
    }),
    TrafficAlert: object({
      type: enumOf(['long_queue', 'emergency_vehicle']),
      intersectionId: str, direction: nullable(enumOf(DIRECTIONS)), vehicles: int, alongMeters: int, message: str,
    }),
    RoadAlert: object({
      type: enumOf(['report', 'road_feature']),
      id: str,
      kind: { type: 'string', description: `Report type (${REPORT_TYPES.join(', ')}) or feature kind (road_closure, roadworks).` },
      lat, lng, verification: enumOf(['verified', 'unverified']),
      alongMeters: int, distanceFromRouteMeters: int, message: str,
      confirmations: int, expiresAt: date, validUntil: nullableDate,
    }),
    Route: object({
      id: { type: 'string', example: 'rt_3f9a1c0b2d4e', description: 'Derived from the road path: the same path keeps its id across requests.' },
      rank: { type: 'integer', description: '1 = best (lowest traffic.adjustedDuration).' },
      geometry: ref('LineString'),
      distance: { type: 'number', description: 'Metres.' },
      duration: { type: 'number', description: 'Seconds, routing provider estimate without live traffic.' },
      summary: { type: 'string', description: 'Main road names.' },
      traffic: object({
        basis: enumOf(['live-ai', 'none'], { description: 'live-ai: live AI observations are in this estimate. none: no live data on this route (adjustedDuration = duration).' }),
        adjustedDuration: { type: 'number', description: 'duration + delay (seconds). Routes are ranked by this.' },
        delay: { type: 'number', description: 'Live delay at monitored intersections on the route (seconds).' },
        updatedAt: nullableDate,
        intersections: array(ref('RouteIntersection')),
        alerts: array(ref('TrafficAlert')),
      }),
      roadAlerts: array(ref('RoadAlert')),
      steps: { ...array(ref('RouteStep')), description: 'Only when the request had steps=true.' },
    }),
    RoutePlan: ok({
      generatedAt: date,
      cached: { type: 'boolean', description: 'The routes came from the cache; traffic and alerts are always fresh.' },
      trafficStatus: enumOf(['included', 'unavailable', 'not-on-route'], { description: 'included: at least one route has live AI traffic. unavailable: a route passes a monitored intersection without live data. not-on-route: no route passes one.' }),
      roadAlertsStatus: enumOf(['ok', 'partial', 'unavailable'], { description: 'unavailable: the database is not connected, roadAlerts are empty.' }),
      snapWarnings: array(str),
      routes: array(ref('Route')),
      attribution: ref('Attribution'),
    }),

    TrafficApproach: object({
      available: { type: 'boolean', description: 'false = no camera data for this approach; counts are null (never zero).' },
      vehicles: nullable(num), queueLength: nullable(num),
      waitingTime: nullable({ type: 'number', description: 'Mean wait of the stopped vehicles (s).' }),
      estimatedDelaySeconds: nullable({ type: 'number', description: 'waitingTime + vehicles x NAV_SECONDS_PER_VEHICLE.' }),
      level: nullable(enumOf(['light', 'moderate', 'heavy'], { description: 'Only while live.' })),
    }),
    TrafficIntersection: object({
      id: str, name: str, lat, lng,
      positionSource: nullable(enumOf(['surveyed', 'unknown'], { description: 'unknown = no surveyed position (lat and lng are null): never matched to a route.' })),
      status: enumOf(['live', 'stale', 'no-data']),
      lastUpdate: nullableDate, ageSeconds: nullable(num),
      level: nullable(enumOf(['light', 'moderate', 'heavy'])),
      longestQueue: nullable(object({ direction: enumOf(DIRECTIONS), vehicles: num })),
      approaches: nullable(object(Object.fromEntries(DIRECTIONS.map((d) => [d, ref('TrafficApproach')])))),
      emergency: nullable(object({ type: nullable(str), direction: nullable(enumOf(DIRECTIONS)), since: nullableDate })),
    }),

    RoadFeature: object({
      id: { type: 'string', description: '24-hex id.' },
      kind: enumOf(FEATURE_KINDS),
      lat, lng, name: nullable(str), description: nullable(str),
      direction: nullable({ type: 'number', description: 'Compass bearing (degrees) it applies to; null = both ways / unknown.' }),
      speedLimitKmh: nullable(int),
      source: str,
      provider: enumOf(['smarttraffic']),
      verification: enumOf(['verified']),
      active: bool, validFrom: nullableDate, validUntil: nullableDate, url: nullable(str), updatedAt: nullableDate,
    }),
    RoadFeatureInput: object({
      kind: enumOf(FEATURE_KINDS), lat, lng,
      name: nullable({ type: 'string', maxLength: LIMITS.nameLength }),
      description: nullable({ type: 'string', maxLength: LIMITS.descriptionLength }),
      direction: nullable({ type: 'number', minimum: 0, maximum: 359.9 }),
      speedLimitKmh: nullable({ type: 'integer', minimum: 5, maximum: 200 }),
      source: nullable({ type: 'string', maxLength: LIMITS.sourceLength }),
      active: { type: 'boolean', default: true },
      validFrom: nullableDate, validUntil: nullableDate,
    }),
    AdminUser: object({
      id: objectId, email: str, name: nullable(str), createdAt: date,
    }, ['id', 'email', 'createdAt']),
    AdminOverview: object({
      generatedAt: date,
      system: { type: 'object', description: 'Routing provider (Geoapify: circuit, daily credit budget), the optional own OSRM, routing, places (PostGIS) and database status.' },
      traffic: object({
        monitoredIntersections: int, live: int, stale: int, noData: int,
      }),
      users: object({ available: bool, total: int, last7Days: int }, ['available']),
      reports: object({
        available: bool,
        byStatus: { type: 'object', additionalProperties: int, description: 'Reports by the status they show (active, expired, resolved, ...).' },
        activeByType: { type: 'object', additionalProperties: int },
      }, ['available']),
      roadFeatures: object({
        available: bool, total: int, active: int, byKind: { type: 'object', additionalProperties: int },
      }, ['available']),
      localPlaces: object({
        available: bool, total: int, active: int, byCategory: { type: 'object', additionalProperties: int },
      }, ['available']),
    }, ['generatedAt', 'system', 'traffic', 'users', 'reports', 'roadFeatures', 'localPlaces']),
    LocalPlace: object({
      id: objectId, name: str, nameAr: nullable(str), nameKu: nullable(str),
      category: enumOf(LOCAL_PLACE_CATEGORIES), lat, lng, description: nullable(str), active: bool, updatedAt: nullableDate,
    }, ['id', 'name', 'category', 'lat', 'lng']),
    LocalPlaceInput: object({
      name: { type: 'string', maxLength: LIMITS.nameLength },
      nameAr: nullable({ type: 'string', maxLength: LIMITS.nameLength }),
      nameKu: nullable({ type: 'string', maxLength: LIMITS.nameLength, description: 'Sorani Kurdish' }),
      category: enumOf(LOCAL_PLACE_CATEGORIES), lat, lng,
      description: nullable({ type: 'string', maxLength: LIMITS.descriptionLength }),
      active: { type: 'boolean', default: true },
    }),
    SavedPlace: object({
      id: objectId, label: str, kind: enumOf(SAVED_PLACE_KINDS), address: nullable(str), lat, lng, createdAt: date, updatedAt: date,
    }, ['id', 'label', 'kind', 'lat', 'lng']),
    SavedPlaceInput: object({
      label: { type: 'string', maxLength: LIMITS.savedLabelLength },
      kind: { ...enumOf(SAVED_PLACE_KINDS), default: 'favorite' },
      address: nullable({ type: 'string', maxLength: LIMITS.addressLength }),
      lat, lng,
    }),
    RoadReport: object({
      id: objectId, type: enumOf(REPORT_TYPES), label: str, lat, lng,
      heading: nullable(num), description: nullable(str),
      status: enumOf(PUBLIC_REPORT_STATUSES),
      verification: enumOf(['verified', 'unverified']),
      confirmations: int, dismissals: int,
      createdAt: date, updatedAt: date, expiresAt: date,
      mine: { type: 'boolean', description: 'Only with a device token: this device sent the report.' },
      myVote: nullable(enumOf(REPORT_VOTES, { description: 'Only with a device token.' })),
    }),
  };

  const paths = {};
  const op = (path, method, spec) => {
    paths[path] ||= {};
    paths[path][method] = spec;
  };
  const tags = {
    app: 'Mobile: app', account: 'Mobile: account', places: 'Mobile: places', geo: 'Geographic search', routes: 'Mobile: routes', traffic: 'Mobile: traffic',
    features: 'Mobile: road features', reports: 'Mobile: community reports', admin: 'Admin console', local: 'Hawr places', saved: 'Saved places',
  };

  op('/api/v1/config', 'get', {
    tags: [tags.app], operationId: 'getAppConfig', summary: 'What this server offers, its limits and required attribution',
    description: 'Call at app start. `features.*.available` tells which parts are configured; `limits` and `rateLimits` are the values this server enforces.',
    responses: { 200: response('App configuration', ok({ apiVersion: str, serverTime: date, features: { type: 'object' }, limits: { type: 'object' }, attribution: array(ref('Attribution')) })), 429: rateLimited },
  });

  op('/api/v1/auth/device', 'post', {
    tags: [tags.app], operationId: 'registerDevice', summary: 'Get an anonymous device token',
    description: 'Once per app install. Store the token securely (Keychain / Keystore) and send it as "Authorization: Bearer <token>" on report and vote requests. Calling again with a valid token renews it when it expires within 7 days (same deviceId). Rate limited per IP.',
    security: [{}, { deviceToken: [] }],
    requestBody: {
      required: false,
      content: json(object({ platform: enumOf(PLATFORMS), appVersion: { type: 'string', pattern: '^[0-9A-Za-z.+-]{1,32}$', example: '1.0.0' } }), {
        android: { value: { platform: 'android', appVersion: '1.0.0' } },
      }),
    },
    responses: {
      201: response('New device token', ref('DeviceToken')), 200: response('Renewed (or still valid) token', ref('DeviceToken')),
      400: error('Invalid body'), 401: error('A token was sent but is invalid or expired: call again without it'), 429: rateLimited,
    },
  });

  const credentialsRules = `Email is trimmed and compared case-insensitively. Password: ${LIMITS.passwordMinLength}-${LIMITS.passwordMaxLength} characters with at least one letter and one digit.`;
  op('/api/v1/auth/signup', 'post', {
    tags: [tags.account], operationId: 'signup', summary: 'Create a user account (and sign in)',
    description: `Creates the account and answers with a session, so the app is signed in right away. ${credentialsRules} Passwords are stored as salted scrypt hashes. Rate limited per IP. Needs MongoDB (503 DATABASE_UNAVAILABLE without it).`,
    security: [],
    requestBody: {
      required: true,
      content: json(object({
        email: { type: 'string', format: 'email', maxLength: LIMITS.emailMaxLength },
        password: {
          type: 'string', format: 'password', minLength: LIMITS.passwordMinLength, maxLength: LIMITS.passwordMaxLength,
        },
        name: nullable({ type: 'string', maxLength: LIMITS.userNameMaxLength }),
      }, ['email', 'password']), {
        signup: { value: { email: 'driver@example.com', password: 'Secret123', name: 'Sara' } },
      }),
    },
    responses: {
      201: response('Account created; signed in', ref('UserSession')),
      400: error('Invalid body (INVALID_REQUEST, e.g. weak password)'), 409: error('EMAIL_TAKEN: sign in instead'),
      429: rateLimited, 503: error('Database not connected'),
    },
  });

  op('/api/v1/auth/login', 'post', {
    tags: [tags.account], operationId: 'login', summary: 'Sign in with email and password',
    description: 'Answers with a new session. A wrong password and an unknown email give the same 401 INVALID_CREDENTIALS. Rate limited per IP and per account. Then click Authorize > userToken in Swagger and paste `token` to try GET /api/v1/auth/me.',
    security: [],
    requestBody: {
      required: true,
      content: json(object({
        email: { type: 'string', format: 'email', maxLength: LIMITS.emailMaxLength },
        password: { type: 'string', format: 'password', maxLength: LIMITS.passwordMaxLength },
      }, ['email', 'password']), {
        login: { value: { email: 'driver@example.com', password: 'Secret123' } },
      }),
    },
    responses: {
      200: response('Signed in', ref('UserSession')),
      400: error('Invalid body'), 401: error('INVALID_CREDENTIALS'), 429: rateLimited, 503: error('Database not connected'),
    },
  });

  const user = [{ userToken: [] }];
  const signedOut = error('USER_TOKEN_REQUIRED, USER_TOKEN_INVALID (signed out, revoked or account deleted) or USER_TOKEN_EXPIRED: sign in again');
  const userResponses = { 401: signedOut, 429: rateLimited, 503: error('Database not connected') };
  const userBody = ok({ user: ref('User') }, ['user']);
  const passwordField = { type: 'string', format: 'password', maxLength: LIMITS.passwordMaxLength };

  op('/api/v1/auth/refresh', 'post', {
    tags: [tags.account], operationId: 'refreshSession', summary: 'Exchange a still-valid user token for a fresh one',
    description: 'Call when the app opens (or when `expiresAt` is near) to stay signed in. An expired token cannot be refreshed: sign in again. No body.',
    security: user,
    responses: { 200: response('New session', ref('UserSession')), ...userResponses },
  });

  op('/api/v1/auth/logout', 'post', {
    tags: [tags.account], operationId: 'logout', summary: 'Sign out on every device',
    description: 'Revokes every token of this account. Delete the stored token in the app too. No body.',
    security: user,
    responses: { 200: response('Signed out', ok({})), ...userResponses },
  });

  op('/api/v1/auth/change-password', 'post', {
    tags: [tags.account], operationId: 'changePassword', summary: 'Change the password',
    description: `Answers with a new session; replace the stored token with it. Every other device is signed out. ${credentialsRules} Rate limited per account.`,
    security: user,
    requestBody: {
      required: true,
      content: json(object({
        currentPassword: passwordField,
        newPassword: { ...passwordField, minLength: LIMITS.passwordMinLength },
      }, ['currentPassword', 'newPassword']), {
        change: { value: { currentPassword: 'Secret123', newPassword: 'NewSecret456' } },
      }),
    },
    responses: {
      200: response('Password changed; new session', ref('UserSession')),
      400: error('Invalid body (INVALID_REQUEST, e.g. weak or unchanged password)'), 403: error('WRONG_PASSWORD: currentPassword is not correct'),
      ...userResponses,
    },
  });

  op('/api/v1/auth/me', 'get', {
    tags: [tags.account], operationId: 'getMe', summary: 'The signed-in user',
    description: 'Needs the user token from /auth/signup or /auth/login (not a device token).',
    security: user,
    responses: { 200: response('The user', userBody), ...userResponses },
  });

  op('/api/v1/auth/me', 'patch', {
    tags: [tags.account], operationId: 'updateMe', summary: 'Change the profile name',
    description: '`name: null` clears it. The email cannot be changed.',
    security: user,
    requestBody: {
      required: true,
      content: json(object({ name: nullable({ type: 'string', maxLength: LIMITS.userNameMaxLength }) }, ['name']), {
        rename: { value: { name: 'Sara A.' } },
      }),
    },
    responses: { 200: response('Updated user', userBody), 400: error('Invalid body'), ...userResponses },
  });

  op('/api/v1/auth/me', 'delete', {
    tags: [tags.account], operationId: 'deleteMe', summary: 'Delete the account',
    description: 'Permanently deletes the account after checking its password; every token stops working. Rate limited per account.',
    security: user,
    requestBody: {
      required: true,
      content: json(object({ password: passwordField }, ['password']), {
        confirm: { value: { password: 'Secret123' } },
      }),
    },
    responses: {
      200: response('Deleted', ok({ deleted: { type: 'boolean', enum: [true] } }, ['deleted'])),
      400: error('Invalid body'), 403: error('WRONG_PASSWORD'),
      ...userResponses,
    },
  });

  op('/api/v1/places/search', 'get', {
    tags: [tags.places], operationId: 'searchPlaces', summary: 'Search places and addresses',
    description: 'Answered by Redoz\'s own PostgreSQL/PostGIS database (OpenStreetMap data), no external provider: exact, prefix, partial and misspelled matches in Arabic, Kurdish and English, ranked near lat/lng when given (scope "local") or without a point ("global"). The operator\'s own local places (MongoDB) come first. Names come in the reader\'s language (ar, ku, en) when OpenStreetMap has one, else the local name. Limited per client IP. Same search with paging and distances: GET /api/search. Show the attribution.',
    parameters: [
      query('q', { type: 'string', minLength: LIMITS.searchMinLength, maxLength: LIMITS.searchMaxLength }, 'Search text', true),
      query('lat', { type: 'number' }, 'Bias towards this point (with lng), e.g. the user position'),
      query('lng', { type: 'number' }),
      query('limit', { type: 'integer', minimum: 1, maximum: LIMITS.searchMaxResults, default: 5 }),
      query('lang', { type: 'string', example: 'en' }, 'Result language (default: Accept-Language header)'),
    ],
    responses: {
      200: response('Places, best match first', ok({
        query: str, scope: enumOf(['local', 'global']), count: int, places: array(ref('Place')), cached: bool, attribution: ref('Attribution'),
      })),
      400: error('Invalid query'), 429: rateLimited, 503: error('Geographic database disabled, not reachable or not imported yet'),
    },
  });

  op('/api/v1/places/reverse', 'get', {
    tags: [tags.places], operationId: 'reverseGeocode', summary: 'Address at a point',
    description: 'From the address points, roads and administrative areas in Redoz\'s PostGIS database. Same lookup with more fields: GET /api/geocode/reverse.',
    parameters: [query('lat', { type: 'number' }, null, true), query('lng', { type: 'number' }, null, true), query('lang', { type: 'string' })],
    responses: {
      200: response('The nearest address; place is null where there is none', ok({ place: nullable(ref('Place')), cached: bool, attribution: ref('Attribution') })),
      400: error('Invalid coordinates'), 429: rateLimited, 503: error('Geographic database disabled, not reachable or not imported yet'),
    },
  });

  const geoErrors = {
    400: error('Invalid query (INVALID_REQUEST)'),
    429: rateLimited,
    503: error('FEATURE_DISABLED (no DATABASE_URL), GEO_DATABASE_UNAVAILABLE, GEO_QUERY_TIMEOUT or GEO_DATA_NOT_READY (migrations / OSM import not run)'),
  };

  op('/api/search', 'get', {
    tags: [tags.geo], operationId: 'search', summary: 'Search places, streets and areas',
    description: 'Redoz\'s own search over PostgreSQL/PostGIS (OpenStreetMap + Redoz-owned places): no external provider. Matches exact names, prefixes, parts of a name and misspellings, in Arabic, Kurdish (Sorani) and English, over every known name of a place. A query that is a kind of place ("restaurant", "مستشفى", "نەخۆشخانە") also returns the nearest places of that kind. Ranking: exact name, prefix, word in name, fuzzy similarity, alternative names, category, importance (and verified Redoz data), and - when lat and lng are given - distance. Limited per client IP. Show the attribution.',
    parameters: [
      query('q', { type: 'string', minLength: LIMITS.geoSearchMinLength, maxLength: LIMITS.searchMaxLength, example: 'Family Mall' }, 'Search text', true),
      query('lat', { type: 'number' }, 'The user position (with lng): nearby results rank first and get distanceMeters'),
      query('lng', { type: 'number' }),
      query('limit', { type: 'integer', minimum: 1, maximum: LIMITS.geoSearchMaxResults, default: LIMITS.geoSearchDefaultResults }),
      query('offset', { type: 'integer', minimum: 0, maximum: LIMITS.geoSearchMaxOffset, default: 0 }, 'Results to skip (paging)'),
      query('lang', { type: 'string', example: 'en' }, 'Name language: ar, ku (Sorani), en. Default: Accept-Language header, else the local name.'),
    ],
    responses: {
      200: response('Places, best match first', ok({
        query: str,
        count: int,
        results: array(ref('GeoPlace')),
        pagination: object({
          limit: int, offset: int, count: int, hasMore: bool,
        }, ['limit', 'offset', 'count', 'hasMore']),
        attribution: ref('Attribution'),
      }, ['query', 'results', 'pagination']), {
        example: {
          summary: 'Shape of an answer (values are illustrative)',
          value: {
            ok: true,
            query: 'Family Mall',
            count: 1,
            results: [{
              id: 'osm:w123456', name: 'Family Mall', type: 'shopping_mall', category: 'shopping_mall', latitude: 35.56, longitude: 45.43, address: 'Example Street, Example City', source: 'osm', entity: 'poi', verified: false, distanceMeters: 480, names: { default: 'Family Mall', ar: null, ckb: null, en: 'Family Mall' }, addressDetails: null, boundingBox: null,
            }],
            pagination: {
              limit: 10, offset: 0, count: 1, hasMore: false,
            },
            attribution: { text: '© OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright', provider: 'OpenStreetMap' },
          },
        },
      }),
      ...geoErrors,
    },
  });

  op('/api/geocode/reverse', 'get', {
    tags: [tags.geo], operationId: 'reverseGeocodeDetailed', summary: 'What is at a point: street, area, city, country',
    description: 'Redoz\'s own reverse geocoding over PostgreSQL/PostGIS: nearest address point, nearest named road, the administrative areas that contain the point (polygon tests, not guesses), nearby settlements and the named place right there. Fields with no data are null; a point outside the imported data gives displayName null (still 200). Show the attribution.',
    parameters: [
      query('lat', { type: 'number', example: 35.5617 }, null, true),
      query('lng', { type: 'number', example: 45.4329 }, null, true),
      query('lang', { type: 'string', example: 'en' }, 'Name language: ar, ku (Sorani), en.'),
    ],
    responses: {
      200: response('The place at the point', ok({
        latitude: lat,
        longitude: lng,
        displayName: nullable(str),
        street: nullable(str),
        houseNumber: nullable(str),
        neighbourhood: nullable(str),
        district: nullable(str),
        city: nullable(str),
        state: nullable(str),
        country: nullable(str),
        nearestRoad: nullable(ref('GeoRoad')),
        place: nullable(object({
          id: str, name: nullable(str), type: str, distanceMeters: int,
        })),
        attribution: ref('Attribution'),
      }, ['latitude', 'longitude', 'displayName']), {
        example: {
          summary: 'Shape of an answer (values are illustrative)',
          value: {
            ok: true,
            latitude: 35.56,
            longitude: 45.43,
            displayName: 'Example Street, Example City, Example Governorate, Example Country',
            street: 'Example Street',
            houseNumber: null,
            neighbourhood: null,
            district: null,
            city: 'Example City',
            state: 'Example Governorate',
            country: 'Example Country',
            nearestRoad: null,
            place: null,
            attribution: { text: '© OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright', provider: 'OpenStreetMap' },
          },
        },
      }),
      ...geoErrors,
    },
  });

  op('/api/v1/places/nearby', 'get', {
    tags: [tags.places], operationId: 'nearbyPlaces', summary: 'Places of one category around a point (PostGIS)',
    description: 'Nearest first, within radius metres, from Redoz\'s PostGIS database (OpenStreetMap and Redoz places). Unnamed fuel stations, parking lots and the like are included: their name is null.',
    parameters: [
      query('lat', { type: 'number' }, null, true), query('lng', { type: 'number' }, null, true),
      query('category', enumOf(Object.keys(PLACE_CATEGORIES)), null, true),
      query('radius', { type: 'integer', minimum: 100, maximum: LIMITS.nearbyMaxRadiusMeters, default: 2000 }, 'Metres'),
      query('limit', { type: 'integer', minimum: 1, maximum: LIMITS.nearbyMaxResults, default: 20 }),
    ],
    responses: {
      200: response('Nearest first', ok({
        category: str, center: ref('LatLng'), radius: int, count: int, places: array(ref('NearbyPlace')), cached: bool, attribution: ref('Attribution'),
      })),
      400: error('Invalid query'), 429: rateLimited, 503: error('Geographic database disabled, not reachable or not imported yet'),
    },
  });

  op('/api/v1/routes', 'post', {
    tags: [tags.routes], operationId: 'planRoutes', summary: 'Road routes ranked by live-traffic-adjusted travel time',
    description: 'Routes from Geoapify (free-flow times: no provider traffic) or from your own OSRM when one is configured, each with the live AI delay at monitored intersections on it and nearby community reports and closures, ranked by traffic.adjustedDuration. Geoapify has no alternatives parameter: up to three real, different routes come from its route types (balanced, short, fewer turns), and a route that copies another is dropped, so 1 to 3 routes are returned (one provider request each). Geoapify gives no street names: summary is empty. Re-send the same request (every 30-60 s while choosing or driving) for fresh ETAs: provider routes are cached for ROUTING_CACHE_TTL_SECONDS, traffic is always current. Geometry is GeoJSON ([lng, lat]).',
    requestBody: {
      required: true,
      content: json(object({
        start: ref('LatLng'),
        destination: ref('LatLng'),
        maxRoutes: { type: 'integer', minimum: 1, maximum: 4, default: 3, description: 'Up to this many routes (fewer when the road network offers fewer distinct ones).' },
        steps: { type: 'boolean', default: false, description: 'Include turn-by-turn steps.' },
      }, ['start', 'destination']), {
        basic: { value: { start: { lat: 35.5617, lng: 45.4329 }, destination: { lat: 35.5702, lng: 45.4418 }, maxRoutes: 3, steps: true } },
      }),
    },
    responses: {
      200: response('Routes, best first', ref('RoutePlan')),
      400: error('Invalid request'), 415: error('Not JSON'), 422: error('NO_ROUTE or POINT_NOT_ROUTABLE'), 429: rateLimited,
      502: error('Provider error'), 503: error('Provider busy or disabled'), 504: error('Provider timeout'),
    },
  });

  op('/api/v1/traffic', 'get', {
    tags: [tags.traffic], operationId: 'getLiveTraffic', summary: 'Live AI traffic at monitored intersections',
    description: 'Real camera observations only (never simulated). Poll about every 15 s while the map is visible. An intersection without data is "no-data" with null counts.',
    parameters: bboxParams(false),
    responses: {
      200: response('Monitored intersections', ok({
        serverTime: date, staleAfterSeconds: num, count: int, intersections: array(ref('TrafficIntersection')),
      })),
      400: error('Invalid box'), 429: rateLimited,
    },
  });

  op('/api/v1/road-features', 'get', {
    tags: [tags.features], operationId: 'listRoadFeatures', summary: 'Speed cameras, speed bumps, closures and roadworks in a map area',
    description: 'Features entered by the operator in the admin console (verified, from the database). `sources` is always { operator: "ok" }, kept for apps written for the earlier multi-source answer. Features change rarely: cache them per area for several minutes.',
    parameters: [
      ...bboxParams(true),
      query('kinds', { type: 'string', example: 'speed_camera,road_closure' }, `Comma-separated: ${FEATURE_KINDS.join(', ')}`),
    ],
    responses: {
      200: response('Features', ok({
        bbox: ref('BBox'), count: int, truncated: bool, sources: object({ operator: str }), features: array(ref('RoadFeature')),
      })),
      400: error('Invalid query'), 429: rateLimited, 503: error('Database not connected (DATABASE_UNAVAILABLE)'),
    },
  });
  op('/api/v1/road-features', 'post', {
    tags: [tags.features], operationId: 'createRoadFeature', summary: 'Add an operator road feature (admin)',
    security: admin,
    requestBody: {
      required: true,
      content: json({ allOf: [ref('RoadFeatureInput'), { required: ['kind', 'lat', 'lng'] }] }, {
        camera: { value: { kind: 'speed_camera', lat: 35.5617, lng: 45.4329, speedLimitKmh: 60, direction: 90, source: 'City traffic department' } },
        closure: { value: { kind: 'road_closure', lat: 35.5655, lng: 45.4232, name: 'Hospital Road', validUntil: '2026-12-01T00:00:00Z' } },
      }),
    },
    responses: {
      201: response('Created', ok({ feature: ref('RoadFeature') })), 400: error('Invalid feature'), 401: error('Missing or invalid admin token'),
      415: error('Not JSON'), 503: error('Admin disabled (NAV_ADMIN_TOKEN not set) or database not connected'),
    },
  });
  op('/api/v1/road-features/{id}', 'get', {
    tags: [tags.features], operationId: 'getRoadFeature', summary: 'One operator road feature',
    parameters: [idParam],
    responses: { 200: response('Feature', ok({ feature: ref('RoadFeature') })), 400: error('Invalid id'), 404: error('Not found'), 503: error('Database not connected') },
  });
  op('/api/v1/road-features/{id}', 'patch', {
    tags: [tags.features], operationId: 'updateRoadFeature', summary: 'Change an operator road feature (admin)',
    security: admin, parameters: [idParam],
    requestBody: { required: true, content: json(ref('RoadFeatureInput'), { deactivate: { value: { active: false } } }) },
    responses: {
      200: response('Updated', ok({ feature: ref('RoadFeature') })), 400: error('Invalid change'), 401: error('Missing or invalid admin token'),
      404: error('Not found'), 415: error('Not JSON'), 503: error('Admin disabled or database not connected'),
    },
  });
  op('/api/v1/road-features/{id}', 'delete', {
    tags: [tags.features], operationId: 'deleteRoadFeature', summary: 'Delete an operator road feature (admin)',
    security: admin, parameters: [idParam],
    responses: {
      200: response('Deleted', ok({ deleted: str, feature: ref('RoadFeature') })), 401: error('Missing or invalid admin token'),
      404: error('Not found'), 503: error('Admin disabled or database not connected'),
    },
  });

  op('/api/v1/reports', 'get', {
    tags: [tags.reports], operationId: 'listReports', summary: 'Active community reports in a map area',
    description: 'Newest first. With a device token, each report also has `mine` and `myVote`. Refresh about every 60 s while the map is visible.',
    security: [{}, { deviceToken: [] }],
    parameters: [
      ...bboxParams(true),
      query('types', { type: 'string', example: 'accident,road_closure' }, `Comma-separated: ${REPORT_TYPES.join(', ')}`),
      query('limit', { type: 'integer', minimum: 1, maximum: LIMITS.maxListResults, default: 200 }),
    ],
    responses: {
      200: response('Reports', ok({ bbox: ref('BBox'), count: int, truncated: bool, reports: array(ref('RoadReport')) })),
      400: error('Invalid query'), 401: error('Invalid device token'), 429: rateLimited, 503: error('Database not connected'),
    },
  });
  op('/api/v1/reports', 'post', {
    tags: [tags.reports], operationId: 'createReport', summary: 'Report a road condition (device)',
    description: `If an active report of the same type exists within REPORT_MERGE_RADIUS_METERS, it is confirmed instead (200, merged=true). Each device may have at most REPORT_MAX_ACTIVE_PER_DEVICE active reports. Visible for REPORT_TTL_*_MINUTES unless confirmed.`,
    security: device,
    requestBody: {
      required: true,
      content: json(object({
        type: enumOf(REPORT_TYPES), lat, lng,
        heading: nullable({ type: 'number', minimum: 0, maximum: 359.9, description: 'Reporter direction of travel (degrees).' }),
        description: nullable({ type: 'string', maxLength: LIMITS.reportDescriptionLength }),
      }, ['type', 'lat', 'lng']), {
        accident: { value: { type: 'accident', lat: 35.5617, lng: 45.4329, heading: 90, description: 'Two cars, right lane blocked' } },
      }),
    },
    responses: {
      201: response('Created', ok({ merged: { type: 'boolean', enum: [false] }, report: ref('RoadReport') })),
      200: response('Merged into an existing nearby report (confirmed it)', ok({ merged: { type: 'boolean', enum: [true] }, report: ref('RoadReport') })),
      400: error('Invalid report'), 401: error('Device token missing, invalid or expired'), 409: error('DUPLICATE_REPORT'),
      415: error('Not JSON'), 429: error('RATE_LIMITED or REPORT_LIMIT_REACHED'), 503: error('Database not connected'),
    },
  });
  op('/api/v1/reports/{id}', 'get', {
    tags: [tags.reports], operationId: 'getReport', summary: 'One report (any status)',
    security: [{}, { deviceToken: [] }], parameters: [idParam],
    responses: { 200: response('Report', ok({ report: ref('RoadReport') })), 400: error('Invalid id'), 404: error('Not found'), 503: error('Database not connected') },
  });
  op('/api/v1/reports/{id}', 'delete', {
    tags: [tags.reports], operationId: 'withdrawReport', summary: 'Withdraw this device\'s own report (device)',
    security: device, parameters: [idParam],
    responses: {
      200: response('Withdrawn', ok({ report: ref('RoadReport') })), 401: error('Device token missing, invalid or expired'),
      403: error('NOT_REPORT_OWNER'), 404: error('Not found'), 409: error('REPORT_NOT_ACTIVE'), 503: error('Database not connected'),
    },
  });
  op('/api/v1/reports/{id}', 'patch', {
    tags: [tags.reports], operationId: 'moderateReport', summary: 'Moderate a report (admin)',
    security: admin, parameters: [idParam],
    requestBody: {
      required: true,
      content: json(object({ status: enumOf(MODERATION_STATUSES), verification: enumOf(['verified', 'unverified']) }), {
        verify: { value: { verification: 'verified' } }, remove: { value: { status: 'removed' } },
      }),
    },
    responses: {
      200: response('Updated', ok({ report: ref('RoadReport') })), 400: error('Invalid change'), 401: error('Missing or invalid admin token'),
      404: error('Not found'), 415: error('Not JSON'), 503: error('Admin disabled or database not connected'),
    },
  });
  op('/api/v1/reports/{id}/votes', 'post', {
    tags: [tags.reports], operationId: 'voteReport', summary: 'Confirm or dismiss someone else\'s report (device)',
    description: 'One vote per device per report. confirm extends the report\'s life; enough dismissals hide it (status "dismissed").',
    security: device, parameters: [idParam],
    requestBody: { required: true, content: json(object({ vote: enumOf(REPORT_VOTES) }, ['vote']), { confirm: { value: { vote: 'confirm' } } }) },
    responses: {
      200: response('Vote recorded', ok({ report: ref('RoadReport') })), 400: error('Invalid vote'), 401: error('Device token missing, invalid or expired'),
      403: error('CANNOT_VOTE_OWN_REPORT'), 404: error('Not found'), 409: error('ALREADY_VOTED or REPORT_NOT_ACTIVE'),
      415: error('Not JSON'), 429: rateLimited, 503: error('Database not connected'),
    },
  });

  op('/api/v1/places/local', 'get', {
    tags: [tags.local], operationId: 'listLocalPlaces', summary: "Hawr's own important places in a map area",
    description: 'Places the operator entered (hospitals, mosques, landmarks ...): a map layer from the database, nothing from a provider. They are also found by GET /places/search. An empty list is a real answer.',
    parameters: [...bboxParams(true), query('categories', { type: 'string', example: 'hospital,police' }, `Comma-separated: ${LOCAL_PLACE_CATEGORIES.join(', ')}`)],
    responses: {
      200: response('Places', ok({ bbox: ref('BBox'), count: int, truncated: bool, places: array(ref('LocalPlace')) })),
      400: error('Invalid query'), 429: rateLimited, 503: error('Database not connected'),
    },
  });
  op('/api/v1/places/local', 'post', {
    tags: [tags.local], operationId: 'createLocalPlace', summary: 'Add a Hawr local place (admin)', security: admin,
    requestBody: { required: true, content: json({ allOf: [ref('LocalPlaceInput'), { required: ['name', 'category', 'lat', 'lng'] }] }, { hospital: { value: { name: 'City Hospital', nameAr: 'مستشفى المدينة', category: 'hospital', lat: 35.5617, lng: 45.4329 } } }) },
    responses: { 201: response('Created', ok({ place: ref('LocalPlace') })), 400: error('Invalid place'), 401: error('Missing or invalid admin token'), 415: error('Not JSON'), 503: error('Admin disabled or database not connected') },
  });
  op('/api/v1/places/local/{id}', 'get', {
    tags: [tags.local], operationId: 'getLocalPlace', summary: 'One Hawr local place', parameters: [idParam],
    responses: { 200: response('Place', ok({ place: ref('LocalPlace') })), 400: error('Invalid id'), 404: error('Not found'), 503: error('Database not connected') },
  });
  op('/api/v1/places/local/{id}', 'patch', {
    tags: [tags.local], operationId: 'updateLocalPlace', summary: 'Change a Hawr local place (admin)', security: admin, parameters: [idParam],
    requestBody: { required: true, content: json(ref('LocalPlaceInput'), { hide: { value: { active: false } } }) },
    responses: { 200: response('Updated', ok({ place: ref('LocalPlace') })), 400: error('Invalid change'), 401: error('Missing or invalid admin token'), 404: error('Not found'), 415: error('Not JSON'), 503: error('Admin disabled or database not connected') },
  });
  op('/api/v1/places/local/{id}', 'delete', {
    tags: [tags.local], operationId: 'deleteLocalPlace', summary: 'Delete a Hawr local place (admin)', security: admin, parameters: [idParam],
    responses: { 200: response('Deleted', ok({ deleted: str, place: ref('LocalPlace') })), 400: error('Invalid id'), 401: error('Missing or invalid admin token'), 404: error('Not found'), 503: error('Admin disabled or database not connected') },
  });
  op('/api/v1/saved-places', 'get', {
    tags: [tags.saved], operationId: 'listSavedPlaces', summary: "The signed-in user's saved places", security: user,
    responses: { 200: response('Saved places, newest first', ok({ count: int, savedPlaces: array(ref('SavedPlace')) })), 401: error('Missing, invalid or expired user token'), 503: error('Database not connected') },
  });
  op('/api/v1/saved-places', 'post', {
    tags: [tags.saved], operationId: 'createSavedPlace', summary: 'Save a place (home, work, a favourite)', security: user,
    description: `At most ${LIMITS.maxSavedPlaces} per user (409 SAVED_PLACE_LIMIT). The owner is always the user of the token.`,
    requestBody: { required: true, content: json({ allOf: [ref('SavedPlaceInput'), { required: ['label', 'lat', 'lng'] }] }, { home: { value: { label: 'Home', kind: 'home', lat: 36.1911, lng: 44.0092, address: 'Erbil' } } }) },
    responses: { 201: response('Saved', ok({ savedPlace: ref('SavedPlace') })), 400: error('Invalid place'), 401: error('Missing, invalid or expired user token'), 409: error('Saved place limit reached'), 415: error('Not JSON'), 503: error('Database not connected') },
  });
  op('/api/v1/saved-places/{id}', 'patch', {
    tags: [tags.saved], operationId: 'updateSavedPlace', summary: 'Change one of your saved places', security: user, parameters: [idParam],
    requestBody: { required: true, content: json(ref('SavedPlaceInput'), { rename: { value: { label: 'Work' } } }) },
    responses: { 200: response('Updated', ok({ savedPlace: ref('SavedPlace') })), 400: error('Invalid change'), 401: error('Missing, invalid or expired user token'), 404: error('Not found (or not yours)'), 415: error('Not JSON'), 503: error('Database not connected') },
  });
  op('/api/v1/saved-places/{id}', 'delete', {
    tags: [tags.saved], operationId: 'deleteSavedPlace', summary: 'Delete one of your saved places', security: user, parameters: [idParam],
    responses: { 200: response('Deleted', ok({ deleted: str, savedPlace: ref('SavedPlace') })), 400: error('Invalid id'), 401: error('Missing, invalid or expired user token'), 404: error('Not found (or not yours)'), 503: error('Database not connected') },
  });

  const pageParams = [
    query('page', { type: 'integer', minimum: 1, default: 1 }),
    query('limit', { type: 'integer', minimum: 1, maximum: 100, default: 25 }),
  ];
  const adminErrors = {
    400: error('Invalid query'), 401: error('Missing or invalid admin token'), 503: error('Admin disabled (NAV_ADMIN_TOKEN not set) or database not connected'),
  };
  op('/api/v1/admin/overview', 'get', {
    tags: [tags.admin], operationId: 'adminOverview', summary: 'System health, live traffic feed and statistics (admin)',
    description: 'One call for the admin console start page. A section whose data is in the database answers { available: false } while the database is down; nothing is invented.',
    security: admin,
    responses: { 200: response('Overview', ok({ generatedAt: date, system: { type: 'object' }, traffic: { type: 'object' }, users: { type: 'object' }, reports: { type: 'object' }, roadFeatures: { type: 'object' } })), ...adminErrors },
  });
  op('/api/v1/admin/users', 'get', {
    tags: [tags.admin], operationId: 'adminListUsers', summary: 'Accounts, newest first (admin)',
    description: 'Email, name and creation time only: password data is never returned.',
    security: admin,
    parameters: [query('q', { type: 'string', maxLength: 80 }, 'Start of an email address'), ...pageParams],
    responses: { 200: response('Users', ok({ users: array(ref('AdminUser')), total: int, page: int, limit: int })), ...adminErrors },
  });
  op('/api/v1/admin/reports', 'get', {
    tags: [tags.admin], operationId: 'adminListReports', summary: 'Driver reports in any status, newest first (admin)',
    description: 'Moderate with PATCH /api/v1/reports/{id}.',
    security: admin,
    parameters: [
      query('status', enumOf(PUBLIC_REPORT_STATUSES), 'One status'),
      query('type', enumOf(REPORT_TYPES), 'One type'),
      ...pageParams,
    ],
    responses: { 200: response('Reports', ok({ reports: array(ref('RoadReport')), total: int, page: int, limit: int })), ...adminErrors },
  });
  op('/api/v1/admin/places', 'get', {
    tags: [tags.admin], operationId: 'adminListPlaces', summary: 'Hawr local places, active or not, newest first (admin)',
    description: 'Change them with POST, PATCH and DELETE on /api/v1/places/local.', security: admin,
    parameters: [query('category', enumOf(LOCAL_PLACE_CATEGORIES), 'One category'), query('active', { type: 'boolean' }, 'Only active or only inactive'), ...pageParams],
    responses: { 200: response('Places', ok({ places: array(ref('LocalPlace')), total: int, page: int, limit: int })), ...adminErrors },
  });
  op('/api/v1/admin/road-features', 'get', {
    tags: [tags.admin], operationId: 'adminListRoadFeatures', summary: 'Operator road features, active or not, newest first (admin)',
    description: 'Change them with POST, PATCH and DELETE on /api/v1/road-features.',
    security: admin,
    parameters: [
      query('kind', enumOf(FEATURE_KINDS), 'One kind'),
      query('active', { type: 'boolean' }, 'Only active or only inactive features'),
      ...pageParams,
    ],
    responses: { 200: response('Features', ok({ features: array(ref('RoadFeature')), total: int, page: int, limit: int })), ...adminErrors },
  });

  return {
    paths,
    schemas,
    tags: Object.values(tags).map((name) => ({
      name,
      description: name === tags.geo
        ? 'Redoz\'s own search and reverse geocoding (PostgreSQL/PostGIS + OpenStreetMap). See docs/GEO_DATABASE.md.'
        : 'Navigation API (/api/v1) used by the web app, the mobile app and the admin console. See docs/MOBILE_INTEGRATION_GUIDE.md.',
    })),
    securitySchemes: {
      deviceToken: {
        type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Anonymous device token from POST /api/v1/auth/device.',
      },
      userToken: {
        type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'User token (`token`) from POST /api/v1/auth/signup or /api/v1/auth/login.',
      },
      navAdminToken: {
        type: 'http', scheme: 'bearer', description: 'NAV_ADMIN_TOKEN (operator tools only - never in the mobile app).',
      },
    },
  };
};
