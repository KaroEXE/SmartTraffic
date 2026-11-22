/**
 * Enumerations of the mobile navigation API (/api/v1). Shared by the
 * models, validation and the OpenAPI document so they cannot drift apart.
 */

// Road features: fixed things on the road (speed cameras, bumps, closures,
// roadworks). Managed by the operator, stored in MongoDB (RoadFeature).
const FEATURE_KINDS = ['speed_camera', 'speed_bump', 'road_closure', 'roadworks'];

// Community reports: temporary conditions reported by drivers (RoadReport).
const REPORT_TYPES = ['accident', 'traffic_jam', 'road_closure', 'construction', 'hazard'];
// Stored status. "expired" is never stored: an active report past its
// expiresAt is shown as expired (no background job needed).
const REPORT_STATUSES = ['active', 'withdrawn', 'removed', 'resolved', 'dismissed'];
const PUBLIC_REPORT_STATUSES = [...REPORT_STATUSES, 'expired'];
const MODERATION_STATUSES = ['active', 'removed', 'resolved'];
const REPORT_VOTES = ['confirm', 'dismiss'];
const MAX_STORED_VOTES = 200;

// verified   entered or confirmed by the operator
// unverified reported by an app user, not checked by the operator
const VERIFICATIONS = ['verified', 'unverified'];

const PLATFORMS = ['android', 'ios', 'other'];

// Nearby place categories -> the `category` values stored in the PostGIS search_entities table
// (db/osm/redoz.lua decides the category of every OpenStreetMap object; Redoz-owned places use the
// same names). The keys are what the apps send as ?category=.
const PLACE_CATEGORIES = {
  fuel: ['fuel'],
  charging_station: ['charging_station'],
  parking: ['parking'],
  hospital: ['hospital'],
  pharmacy: ['pharmacy'],
  police: ['police'],
  restaurant: ['restaurant'],
  cafe: ['cafe'],
  atm: ['atm', 'bank'],
  car_repair: ['car_repair'],
  hotel: ['hotel'],
};

// Hawr's own important places (models/LocalPlace.js), entered by the operator.
const LOCAL_PLACE_CATEGORIES = [
  'hospital', 'pharmacy', 'police', 'fuel', 'parking', 'school', 'university', 'mosque', 'government', 'market', 'park', 'landmark', 'other',
];
// A user's saved places (models/SavedPlace.js).
const SAVED_PLACE_KINDS = ['favorite', 'home', 'work', 'other'];

const LIMITS = {
  nameLength: 120,
  descriptionLength: 500,
  reportDescriptionLength: 280,
  sourceLength: 80,
  searchMinLength: 3,
  searchMaxLength: 200,
  searchMaxResults: 10,
  // GET /api/search (PostGIS): shorter queries are allowed, more results, paging.
  geoSearchMinLength: 2,
  geoSearchDefaultResults: 10,
  geoSearchMaxResults: 20,
  geoSearchMaxOffset: 200,
  nearbyMaxRadiusMeters: 5000,
  nearbyMaxResults: 50,
  // Widest map area (degrees per side) one road-feature or report query may cover.
  maxBBoxSpanDeg: 0.5,
  maxListResults: 500,
  // User accounts (POST /api/v1/auth/signup).
  emailMaxLength: 254,
  userNameMaxLength: 80,
  // Saved places per user, and their text limits.
  maxSavedPlaces: 100,
  savedLabelLength: 80,
  addressLength: 200,
  passwordMinLength: 8,
  // Upper bound keeps hashing cost bounded for hostile input.
  passwordMaxLength: 128,
};

module.exports = {
  FEATURE_KINDS,
  REPORT_TYPES,
  REPORT_STATUSES,
  PUBLIC_REPORT_STATUSES,
  MODERATION_STATUSES,
  REPORT_VOTES,
  MAX_STORED_VOTES,
  VERIFICATIONS,
  PLATFORMS,
  PLACE_CATEGORIES,
  LOCAL_PLACE_CATEGORIES,
  SAVED_PLACE_KINDS,
  LIMITS,
};
