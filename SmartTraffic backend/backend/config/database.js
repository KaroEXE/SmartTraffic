const mongoose = require('mongoose');

/**
 * The one MongoDB connection used by the backend (mongoose's default
 * connection). The database only stores history; signal control never
 * waits for it. If it is missing or unreachable the backend keeps running,
 * says so in the log and in GET /api/health, and retries in the background.
 *
 *   status: disabled     MONGODB_URI not set - nothing is recorded
 *           invalid      MONGODB_URI cannot be parsed - not retried
 *           connecting   first attempt in progress
 *           connected    records are being written
 *           disconnected unreachable / lost - retrying, records are not saved
 */

// Fail writes immediately while disconnected instead of queueing them in memory.
mongoose.set('bufferCommands', false);
// Collections and indexes are created explicitly once connected (see
// prepareCollections); mongoose's automatic attempt would run before the
// connection exists and fail silently with buffering disabled.
mongoose.set('autoCreate', false);
mongoose.set('autoIndex', false);

const RETRY_MS = 15_000;
const SERVER_SELECTION_TIMEOUT_MS = 5_000;

const state = {
  uri: '',
  status: 'disabled',
  lastError: null,
  retryTimer: null,
  everConnected: false,
};

/** Error text with the connection string and credentials removed. */
function safeMessage(err, uri) {
  let message = String((err && err.message) || err);
  if (uri) {
    message = message.split(uri).join('<MONGODB_URI>');
    const userInfo = /^mongodb(?:\+srv)?:\/\/([^@/]+)@/.exec(uri);
    if (userInfo) {
      for (const part of [userInfo[1], ...userInfo[1].split(':')]) {
        if (part) message = message.split(part).join('***');
      }
    }
  }
  return message.replace(/(mongodb(?:\+srv)?:\/\/)[^@\s/]+@/g, '$1***@');
}

function where() {
  const c = mongoose.connection;
  return `${c.host}:${c.port}/${c.name}`;
}

function attachListeners() {
  const c = mongoose.connection;
  c.on('disconnected', () => {
    if (state.status !== 'connected') return; // initial failure or intentional shutdown
    state.status = 'disconnected';
    console.error('[database] MongoDB connection lost - traffic history is NOT being saved until it reconnects');
  });
  c.on('connected', () => {
    if (state.everConnected && state.status !== 'connected') console.log(`[database] MongoDB reconnected (${where()})`);
    state.status = 'connected';
    state.everConnected = true;
    state.lastError = null;
  });
  c.on('error', (err) => {
    if (state.everConnected) console.error(`[database] MongoDB error: ${safeMessage(err, state.uri)}`);
  });
}

/** Creates every registered model's collection (incl. time-series options) and indexes. Idempotent. */
async function prepareCollections() {
  for (const Model of Object.values(mongoose.models)) {
    try {
      await Model.createCollection();
      await Model.createIndexes();
    } catch (err) {
      console.error(`[database] Could not prepare collection "${Model.collection.collectionName}": ${safeMessage(err, state.uri)}`);
    }
  }
}

async function attempt() {
  state.retryTimer = null;
  try {
    await mongoose.connect(state.uri, { serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS });
    await prepareCollections();
    console.log(`[database] Connected to MongoDB (${where()})`);
    return true;
  } catch (err) {
    const message = safeMessage(err, state.uri);
    if (err && err.name === 'MongoParseError') {
      state.status = 'invalid';
      console.error(`[database] MONGODB_URI is invalid (${message}) - traffic history will NOT be recorded`);
      return false;
    }
    state.status = 'disconnected';
    if (message !== state.lastError) {
      console.error(`[database] MongoDB connection failed: ${message}`);
      console.error(`[database] Traffic history is NOT being recorded - retrying every ${RETRY_MS / 1000}s`);
    }
    state.lastError = message;
    state.retryTimer = setTimeout(attempt, RETRY_MS);
    state.retryTimer.unref();
    return false;
  }
}

/** Connects once at startup. Resolves true when connected, false otherwise (never throws). */
async function connectDatabase(uri) {
  if (state.status !== 'disabled') throw new Error('connectDatabase() was already called');
  if (!uri) {
    console.warn('[database] MONGODB_URI is not set - traffic history will NOT be recorded (set it in backend/.env)');
    return false;
  }
  state.uri = uri;
  state.status = 'connecting';
  attachListeners();
  return attempt();
}

function isDatabaseConnected() {
  return mongoose.connection.readyState === 1;
}

function getDatabaseStatus() {
  return state.status;
}

async function disconnectDatabase() {
  if (state.retryTimer) clearTimeout(state.retryTimer);
  state.retryTimer = null;
  if (state.status === 'connected' || state.status === 'connecting') state.status = 'disconnected';
  await mongoose.disconnect();
}

module.exports = {
  connectDatabase,
  disconnectDatabase,
  isDatabaseConnected,
  getDatabaseStatus,
  safeMessage,
};
