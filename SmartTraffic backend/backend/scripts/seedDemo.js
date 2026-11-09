#!/usr/bin/env node
/**
 * Demo data for trying the mobile navigation API (/api/v1) in a mobile app.
 *
 *   node scripts/seedDemo.js          (or: npm run seed:demo)
 *
 * Writes to the MongoDB in backend/.env (MONGODB_URI):
 *   - community reports (accidents, jams, closures, ...) around Sulaymaniyah,
 *     two of them owned by the demo device, so the app shows "mine: true"
 *   - operator road features (speed cameras, a speed bump, roadworks)
 * and prints a device token for the demo device.
 *
 * Re-running replaces the previous demo data (and nothing else): demo
 * reports are recognised by their reporter ids, demo features by their
 * source. Demo reports stay visible for DEMO_DAYS instead of the normal
 * per-type lifetime; run the script again to refresh them.
 *
 * Needs DEVICE_TOKEN_SECRET in .env: without it the server signs tokens with
 * a per-process key and the printed demo token would not be accepted.
 */
const mongoose = require('mongoose');
const config = require('../config');
const RoadReport = require('../models/RoadReport');
const RoadFeature = require('../models/RoadFeature');
const { createDeviceTokens } = require('../utils/deviceToken');

const DEMO_DAYS = 7;
const DEMO_SOURCE = 'Demo data (scripts/seedDemo.js)';
// Fixed ids so re-running finds and replaces the same demo data.
const DEMO_DEVICE_ID = 'de300000-0000-4000-8000-000000000001';
const OTHER_DEVICE_IDS = [
  'de300000-0000-4000-8000-000000000002',
  'de300000-0000-4000-8000-000000000003',
];
const DEMO_REPORTERS = [DEMO_DEVICE_ID, ...OTHER_DEVICE_IDS];

// [lat, lng]. The first three lie on the route between the smoke-test
// points 35.5617,45.4329 -> 35.5702,45.4418, so POST /routes shows them as road alerts.
const REPORTS = [
  { type: 'accident', at: [35.560066, 45.433975], description: 'Two cars collided, right lane blocked', reporter: 0, confirmations: 3 },
  { type: 'traffic_jam', at: [35.563626, 45.437823], description: 'Slow traffic towards Salim Street', reporter: 1, confirmations: 5 },
  { type: 'hazard', at: [35.564182, 45.444186], description: 'Pothole in the middle lane', reporter: 2, confirmations: 1 },
  { type: 'road_closure', at: [35.5551, 45.4262], description: 'Road closed for an event', reporter: 0, confirmations: 2, verification: 'verified' },
  { type: 'construction', at: [35.5742, 45.4305], description: 'Lane narrowed by road works', reporter: 1, confirmations: 0 },
  { type: 'hazard', at: [35.5489, 45.4421], description: 'Broken-down truck on the shoulder', reporter: 2, confirmations: 0 },
];

const FEATURES = [
  { kind: 'speed_camera', at: [35.5662, 45.4362], name: 'Speed camera', speedLimitKmh: 60, direction: 45 },
  { kind: 'speed_camera', at: [35.5526, 45.4082], name: 'Speed camera', speedLimitKmh: 80, direction: null },
  { kind: 'speed_bump', at: [35.5689, 45.4398], name: 'Speed bump near the school', speedLimitKmh: null, direction: null },
  { kind: 'roadworks', at: [35.5603, 45.4489], name: 'Water main repair', speedLimitKmh: 30, direction: null, days: 14 },
];

async function main() {
  if (!config.mongodbUri) throw new Error('MONGODB_URI is not set in backend/.env');
  const nav = config.navigation;
  if (!nav.deviceTokenSecret) {
    throw new Error('DEVICE_TOKEN_SECRET is not set in backend/.env - set it first (see .env.example), then restart the server');
  }

  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  const now = Date.now();
  const point = ([lat, lng]) => ({ type: 'Point', coordinates: [lng, lat] });

  const removedReports = await RoadReport.deleteMany({ reporterId: { $in: DEMO_REPORTERS } });
  const removedFeatures = await RoadFeature.deleteMany({ source: DEMO_SOURCE });

  const expiresAt = new Date(now + DEMO_DAYS * 86_400_000);
  const purgeAt = nav.reports.retentionDays > 0 ? new Date(expiresAt.getTime() + nav.reports.retentionDays * 86_400_000) : null;
  const reports = await RoadReport.insertMany(REPORTS.map((r, i) => {
    const reporterId = DEMO_REPORTERS[r.reporter];
    // Confirmations come from the other demo devices (never the reporter), as real votes would.
    const voters = DEMO_REPORTERS.filter((id) => id !== reporterId);
    const votes = Array.from({ length: Math.min(r.confirmations, voters.length) }, (_, k) => ({
      deviceId: voters[k], vote: 'confirm', at: new Date(now - k * 60_000),
    }));
    return {
      type: r.type,
      location: point(r.at),
      description: r.description,
      reporterId,
      platform: 'android',
      status: 'active',
      verification: r.verification || 'unverified',
      confirmations: r.confirmations,
      votes,
      expiresAt,
      purgeAt,
      createdAt: new Date(now - (i + 1) * 10 * 60_000),
    };
  }));

  const features = await RoadFeature.insertMany(FEATURES.map((f) => ({
    kind: f.kind,
    location: point(f.at),
    name: f.name,
    direction: f.direction,
    speedLimitKmh: f.speedLimitKmh,
    source: DEMO_SOURCE,
    active: true,
    validFrom: null,
    validUntil: f.days ? new Date(now + f.days * 86_400_000) : null,
  })));

  const tokens = createDeviceTokens({ secret: nav.deviceTokenSecret, ttlSeconds: nav.deviceTokenTtlSeconds, log: { warn() {} } });
  const demo = tokens.issue({ deviceId: DEMO_DEVICE_ID, platform: 'android' });

  console.log(`Replaced ${removedReports.deletedCount} demo reports and ${removedFeatures.deletedCount} demo features.`);
  console.log(`Inserted ${reports.length} reports (visible until ${expiresAt.toISOString()}) and ${features.length} road features.`);
  console.log('');
  console.log(`Demo device id: ${demo.deviceId}  (owns ${REPORTS.filter((r) => r.reporter === 0).length} of the reports)`);
  console.log(`Demo device token (valid until ${demo.expiresAt}):`);
  console.log(demo.token);
  console.log('');
  console.log('Use it as  Authorization: Bearer <token>  - or let the app get its own with POST /api/v1/auth/device.');
  console.log('Map area with the demo data: GET /api/v1/reports?south=35.54&west=45.40&north=35.58&east=45.46');
}

main()
  .catch((err) => {
    console.error(`[seed:demo] ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
