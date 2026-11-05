const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HAZARD_KINDS, HAZARD_REPORT_STATUSES } = require('../models/constants');

/**
 * Road information reported by drivers (speed cameras, speed bumps, road
 * closures). Every report starts as `pending` and is only published - i.e.
 * returned by listApproved() - after an administrator approves it.
 *
 * Stored in one JSON file so reporting works without MongoDB. Writes go to a
 * temporary file that replaces the real one, one write at a time, so a crash
 * never leaves a half-written file. A file that cannot be parsed is moved
 * aside (never overwritten) and the store starts empty.
 *
 * Report: { id, kind, lat, lng, note, status, createdAt, reviewedAt }
 */

const NOTE_MAX = 280;
const LABEL = { speed_camera: 'Speed camera', speed_bump: 'Speed bump', road_closure: 'Road closure' };

class HazardReportError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // invalid | not-found | full
  }
}

/** Validates a driver's report body. Returns { kind, lat, lng, note } or throws HazardReportError('invalid'). */
function validateReport(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HazardReportError('invalid', 'Body must be a JSON object');
  const { kind, lat, lng } = body;
  if (!HAZARD_KINDS.includes(kind)) throw new HazardReportError('invalid', `kind must be one of: ${HAZARD_KINDS.join(', ')}`);
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) throw new HazardReportError('invalid', 'lat must be a number between -90 and 90');
  if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) throw new HazardReportError('invalid', 'lng must be a number between -180 and 180');
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') throw new HazardReportError('invalid', 'note must be text');
  // Control characters are dropped; the text is always rendered as text, never HTML.
  const note = String(body.note || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (note.length > NOTE_MAX) throw new HazardReportError('invalid', `note must be at most ${NOTE_MAX} characters`);
  return { kind, lat, lng, note };
}

function createHazardReportService({ file, maxPending = 500, now = () => new Date() }) {
  let reports = load();
  let writing = Promise.resolve();

  function load() {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    try {
      const data = JSON.parse(text);
      if (!Array.isArray(data.reports)) throw new Error('missing "reports" list');
      return data.reports.filter((r) => r && typeof r.id === 'string' && HAZARD_REPORT_STATUSES.includes(r.status));
    } catch (err) {
      const aside = `${file}.corrupt-${Date.now()}`;
      fs.renameSync(file, aside);
      console.error(`[hazard-reports] ${file} could not be read (${err.message}); moved to ${aside}, starting empty`);
      return [];
    }
  }

  function save() {
    const snapshot = JSON.stringify({ reports }, null, 2);
    writing = writing.catch(() => {}).then(async () => {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, snapshot, 'utf8');
      await fs.promises.rename(tmp, file);
    });
    return writing;
  }

  function find(id) {
    const report = reports.find((r) => r.id === id);
    if (!report) throw new HazardReportError('not-found', 'No report with that id');
    return report;
  }

  /** Applies a change in memory, then saves it; the change is undone if saving fails. */
  async function commit(next) {
    const previous = reports;
    reports = next;
    try {
      await save();
    } catch (err) {
      reports = previous;
      throw err;
    }
  }

  async function review(id, status) {
    const reviewed = { ...find(id), status, reviewedAt: now().toISOString() };
    await commit(reports.map((r) => (r.id === id ? reviewed : r)));
    return { ...reviewed };
  }

  return {
    /** Stores a new pending report. Throws HazardReportError('invalid' | 'full'). */
    async create(body) {
      const fields = validateReport(body);
      if (reports.filter((r) => r.status === 'pending').length >= maxPending) {
        throw new HazardReportError('full', 'Too many reports are waiting for review. Please try again later.');
      }
      const report = { id: crypto.randomUUID(), ...fields, status: 'pending', createdAt: now().toISOString(), reviewedAt: null };
      await commit([...reports, report]);
      return { ...report };
    },

    /** For administrators. status: one of HAZARD_REPORT_STATUSES or 'all'. Newest first. */
    list(status = 'pending') {
      return reports
        .filter((r) => status === 'all' || r.status === status)
        .map((r) => ({ ...r }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    approve: (id) => review(id, 'approved'),
    reject: (id) => review(id, 'rejected'),

    async remove(id) {
      find(id);
      await commit(reports.filter((r) => r.id !== id));
    },

    /** Published hazards inside bbox, in the shape frontend/navigation/hazardService.js expects. */
    listApproved({ south, west, north, east }, limit = 1000) {
      return reports
        .filter((r) => r.status === 'approved' && r.lat >= south && r.lat <= north && r.lng >= west && r.lng <= east)
        .slice(0, limit)
        .map((r) => ({
          id: r.id,
          kind: r.kind,
          lat: r.lat,
          lng: r.lng,
          label: LABEL[r.kind],
          note: r.note || null,
          source: 'Driver report',
          verification: 'verified',
          reportedAt: r.createdAt,
        }));
    },

    /** Resolves once every write so far is on disk. */
    flush: () => writing.catch(() => {}),
  };
}

module.exports = { createHazardReportService, validateReport, HazardReportError, NOTE_MAX };
