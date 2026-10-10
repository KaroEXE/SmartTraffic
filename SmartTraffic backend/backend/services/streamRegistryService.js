const EventEmitter = require('events');
const defaultTrafficStream = require('../models/TrafficStream');
const { isDatabaseConnected } = require('../config/database');
const { sanitizeError } = require('../utils/streamValidation');

/**
 * Stream Registry - the camera streams the AI service may read, stored in
 * MongoDB (TrafficStream), plus the latest health the AI service reported.
 *
 *   list / create / update / remove   configuration (needs the database)
 *   reportHealth(report)              AI health report -> cache + database
 *   verifyAttribution(id, streams)    does an observation's `streams` map
 *                                     belong to this intersection? (sync)
 *   publicList()                      status for the dashboard (no URLs)
 *
 * An in-memory cache mirrors the collection. It is reloaded on every list()
 * (the AI service polls about every 30 s) and kept current by every write,
 * so verifyAttribution() never waits for the database. Live signal control
 * does not depend on this service: with no database the registry is simply
 * unavailable and ingestion carries on without stream attribution.
 *
 * Emits 'change' (publicList()) whenever configuration or health changes.
 */

const STALE_AFTER_MS = 60_000; // 4 missed health reports at the AI service's 15 s interval

const dbUnavailable = () => Object.assign(new Error('Database not connected'), { code: 'DB_UNAVAILABLE' });
const notFound = (id) => Object.assign(new Error(`Unknown stream "${id}"`), { code: 'NOT_FOUND' });
const iso = (d) => (d ? new Date(d).toISOString() : null);

function urlHost(record) {
  if (record.sourceType === 'file' || record.sourceType === 'camera') return null;
  try { return new URL(record.url).hostname.toLowerCase() || null; } catch { return null; }
}

function sortKey(a, b) {
  return a.intersectionId.localeCompare(b.intersectionId)
    || String(a.direction).localeCompare(String(b.direction))
    || a.priority - b.priority
    || a._id.localeCompare(b._id);
}

class StreamRegistryService extends EventEmitter {
  constructor({
    TrafficStream = defaultTrafficStream,
    isConnected = isDatabaseConnected,
    now = Date.now,
    log = console,
    staleAfterMs = STALE_AFTER_MS,
  } = {}) {
    super();
    this.Model = TrafficStream;
    this.isConnected = isConnected;
    this.now = now;
    this.log = log;
    this.staleAfterMs = staleAfterMs;
    this.cache = new Map(); // id -> plain record (TrafficStream shape)
    this.loaded = false;
    this.refreshing = null;
  }

  // ------------------------------------------------------------ configuration

  /** Reloads the cache from the database. */
  async refresh() {
    if (!this.isConnected()) throw dbUnavailable();
    if (!this.refreshing) {
      this.refreshing = (async () => {
        try {
          const docs = await this.Model.find({}).lean();
          this.cache = new Map(docs.map((d) => [d._id, d]));
          this.loaded = true;
        } finally {
          this.refreshing = null;
        }
      })();
    }
    return this.refreshing;
  }

  /** Full records (with URL), filtered and ordered by intersection, direction, priority. */
  async list({ enabled, intersectionId } = {}) {
    await this.refresh();
    return [...this.cache.values()]
      .filter((r) => enabled === undefined || r.enabled === enabled)
      .filter((r) => intersectionId === undefined || r.intersectionId === intersectionId)
      .sort(sortKey)
      .map((r) => this.toFull(r));
  }

  async get(id) {
    await this.refresh();
    const record = this.cache.get(id);
    if (!record) throw notFound(id);
    return this.toFull(record);
  }

  /** Writes need the whole collection cached, or the cache would look complete while it is not. */
  async _ready() {
    if (!this.isConnected()) throw dbUnavailable();
    if (!this.loaded) await this.refresh();
  }

  async create(input) {
    await this._ready();
    const { id, ...fields } = input;
    const doc = await this.Model.create({ _id: id, ...fields }).catch(rethrowDuplicate);
    const record = typeof doc.toObject === 'function' ? doc.toObject() : doc;
    this.cache.set(record._id, record);
    this._changed();
    return this.toFull(record);
  }

  async update(id, patch) {
    await this._ready();
    const record = await this.Model.findOneAndUpdate(
      { _id: id },
      { $set: patch },
      { new: true, runValidators: true },
    ).lean().catch(rethrowDuplicate);
    if (!record) throw notFound(id);
    this.cache.set(id, record);
    this._changed();
    return this.toFull(record);
  }

  async remove(id) {
    await this._ready();
    const result = await this.Model.deleteOne({ _id: id });
    if (!result || !result.deletedCount) throw notFound(id);
    this.cache.delete(id);
    this._changed();
  }

  // ------------------------------------------------------------------- health

  /**
   * Applies a validated health report (utils/streamValidation.js). Unknown
   * ids, and streams registered to another intersection than the report's,
   * are ignored and listed - they are never created or moved.
   */
  async reportHealth({ intersectionId, entries }, { secrets = [] } = {}) {
    if (!this.loaded && this.isConnected()) await this.refresh().catch(() => {});
    const checkedAt = new Date(this.now());
    const updated = [];
    const ignored = [];
    const writes = [];

    for (const entry of entries) {
      const record = this.cache.get(entry.id);
      if (!record) {
        ignored.push({ id: entry.id, reason: 'unknown stream' });
        continue;
      }
      if (intersectionId && record.intersectionId !== intersectionId) {
        ignored.push({ id: entry.id, reason: `registered to intersection "${record.intersectionId}"` });
        continue;
      }
      const health = {
        status: entry.status,
        active: entry.active,
        lastHealthCheckAt: checkedAt,
        // Last *successful* frame / inference: a report without one keeps the previous time.
        lastFrameAt: entry.lastFrameAt || record.lastFrameAt || null,
        lastInferenceAt: entry.lastInferenceAt || record.lastInferenceAt || null,
        consecutiveFailures: entry.consecutiveFailures,
        lastError: sanitizeError(entry.error, [record.url, ...secrets]),
      };
      Object.assign(record, health);
      updated.push(entry.id);
      writes.push({ updateOne: { filter: { _id: entry.id }, update: { $set: health } } });
    }

    let persisted = false;
    if (writes.length && this.isConnected()) {
      try {
        await this.Model.bulkWrite(writes, { ordered: false });
        persisted = true;
      } catch (err) {
        this.log.warn(`[streams] health report not saved: ${sanitizeError(err && err.message)}`);
      }
    }
    if (updated.length) this._changed();
    return { updated, ignored, persisted };
  }

  // ----------------------------------------------------------- attribution

  /**
   * Checks an observation's `streams` map ({ north: 'main-north-1', ... })
   * against the registry. Errors = the observation must be rejected;
   * verified = false means the registry could not be consulted, so the
   * attribution must not be recorded.
   */
  verifyAttribution(intersectionId, streams) {
    if (!this.loaded) {
      // First use after startup / reconnect: load in the background.
      if (this.isConnected()) this.refresh().catch(() => {});
      return { ok: true, verified: false, errors: [], warnings: ['stream registry unavailable - stream attribution was not verified and is not recorded'] };
    }
    const errors = [];
    const warnings = [];
    for (const [direction, id] of Object.entries(streams)) {
      const record = this.cache.get(id);
      if (!record) errors.push(`streams.${direction}: unknown stream "${id}"`);
      else if (record.intersectionId !== intersectionId) {
        errors.push(`streams.${direction}: stream "${id}" belongs to intersection "${record.intersectionId}", not "${intersectionId}"`);
      } else if (record.direction !== null && record.direction !== direction) {
        errors.push(`streams.${direction}: stream "${id}" covers the ${record.direction} approach, not ${direction}`);
      } else if (!record.enabled) {
        warnings.push(`streams.${direction}: stream "${id}" is disabled`);
      }
    }
    return { ok: errors.length === 0, verified: true, errors, warnings };
  }

  // ---------------------------------------------------------------- output

  toFull(r) {
    return {
      id: r._id,
      name: r.name,
      url: r.url,
      sourceType: r.sourceType,
      intersectionId: r.intersectionId,
      direction: r.direction === undefined ? null : r.direction,
      enabled: r.enabled,
      priority: r.priority,
      ...this._health(r),
      createdAt: iso(r.createdAt),
      updatedAt: iso(r.updatedAt),
    };
  }

  /** Dashboard view: no URL (it may carry private tokens), only its host. */
  toPublic(r) {
    const { url, ...rest } = this.toFull(r);
    return { ...rest, host: urlHost(r) };
  }

  /** Status of every cached stream, for the dashboard and Socket.IO. */
  publicList() {
    return {
      available: this.loaded,
      serverTime: new Date(this.now()).toISOString(),
      staleAfterSeconds: this.staleAfterMs / 1000,
      streams: [...this.cache.values()].sort(sortKey).map((r) => this.toPublic(r)),
    };
  }

  _health(r) {
    const checked = r.lastHealthCheckAt ? new Date(r.lastHealthCheckAt).getTime() : null;
    return {
      status: r.status || 'unknown',
      active: Boolean(r.active),
      // No health report within staleAfterSeconds: the reported status is out of date.
      stale: checked === null ? false : this.now() - checked > this.staleAfterMs,
      lastHealthCheckAt: iso(r.lastHealthCheckAt),
      lastFrameAt: iso(r.lastFrameAt),
      lastInferenceAt: iso(r.lastInferenceAt),
      consecutiveFailures: r.consecutiveFailures || 0,
      lastError: r.lastError || null,
    };
  }

  _changed() {
    this.emit('change', this.publicList());
  }
}

function rethrowDuplicate(err) {
  if (err && err.code === 11000) {
    throw Object.assign(new Error('A stream with this id, or this URL for the same intersection and direction, already exists'), { code: 'DUPLICATE' });
  }
  throw err;
}

function createStreamRegistryService(options) {
  return new StreamRegistryService(options);
}

module.exports = { StreamRegistryService, createStreamRegistryService, STALE_AFTER_MS };
