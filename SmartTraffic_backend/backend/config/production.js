/**
 * What a production start (NODE_ENV=production) must have. Returns a list of
 * problems; server.js refuses to start when the list is not empty. Locally
 * (NODE_ENV not "production") none of this is enforced: the backend only warns.
 *
 *   - POST /api/traffic needs TRAFFIC_INGEST_TOKEN, otherwise anyone can feed
 *     the signal engine.
 *   - Device and user tokens need their own secrets of 32+ characters, otherwise
 *     they are signed with a key that is lost at every restart or is guessable.
 *   - Accounts, reports and road features live in MongoDB.
 */
const MIN_SECRET = 32;

function productionProblems(config) {
  const nav = config.navigation;
  const problems = [];
  if (!config.trafficIngestToken) problems.push('TRAFFIC_INGEST_TOKEN is not set: anyone could post traffic data to the signal engine.');
  if (nav.deviceTokenSecret.length < MIN_SECRET) problems.push(`DEVICE_TOKEN_SECRET must be set and at least ${MIN_SECRET} characters.`);
  if (nav.userTokenSecret.length < MIN_SECRET) problems.push(`USER_TOKEN_SECRET must be set and at least ${MIN_SECRET} characters.`);
  if (nav.userTokenSecret && nav.userTokenSecret === nav.deviceTokenSecret) problems.push('USER_TOKEN_SECRET must differ from DEVICE_TOKEN_SECRET.');
  if (!config.mongodbUri) problems.push('MONGODB_URI is not set: accounts, reports and road features need the database.');
  return problems;
}

module.exports = { productionProblems, MIN_SECRET };
