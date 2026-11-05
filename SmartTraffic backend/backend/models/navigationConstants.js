/**
 * Enumerations of the mobile navigation API (/api/v1). Shared by the
 * models, validation and the OpenAPI document so they cannot drift apart.
 */

// Road features: fixed things on the road. Operator-managed ones live in
// MongoDB (RoadFeature); speed cameras and speed bumps also come from
// OpenStreetMap (services/navigation/overpassService.js).
const FEATURE_KINDS = ['speed_camera', 'speed_bump', 'road_closure', 'roadworks'];
const OSM_FEATURE_KINDS = ['speed_camera', 'speed_bump'];

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
// community  mapped by OpenStreetMap contributors, not checked by the operator
// unverified reported by an app user, not checked by the operator
const VERIFICATIONS = ['verified', 'community', 'unverified'];

const PLATFORMS = ['android', 'ios', 'other'];

// Nearby place categories -> OpenStreetMap tag (key=value).
const PLACE_CATEGORIES = {
  fuel: ['amenity', 'fuel'],
  charging_station: ['amenity', 'charging_station'],
  parking: ['amenity', 'parking'],
  hospital: ['amenity', 'hospital'],
  pharmacy: ['amenity', 'pharmacy'],
  police: ['amenity', 'police'],
  restaurant: ['amenity', 'restaurant'],
  cafe: ['amenity', 'cafe'],
  atm: ['amenity', 'atm'],
  car_repair: ['shop', 'car_repair'],
  hotel: ['tourism', 'hotel'],
};

const LIMITS = {
  nameLength: 120,
  descriptionLength: 500,
  reportDescriptionLength: 280,
  sourceLength: 80,
  searchMinLength: 3,
  searchMaxLength: 200,
  searchMaxResults: 10,
  nearbyMaxRadiusMeters: 5000,
  nearbyMaxResults: 50,
  // Widest map area (degrees per side) one road-feature or report query may cover.
  maxBBoxSpanDeg: 0.5,
  maxListResults: 500,
};

module.exports = {
  FEATURE_KINDS,
  OSM_FEATURE_KINDS,
  REPORT_TYPES,
  REPORT_STATUSES,
  PUBLIC_REPORT_STATUSES,
  MODERATION_STATUSES,
  REPORT_VOTES,
  MAX_STORED_VOTES,
  VERIFICATIONS,
  PLATFORMS,
  PLACE_CATEGORIES,
  LIMITS,
};
