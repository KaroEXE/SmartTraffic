/**
 * The anonymous device session of this browser: the Hawr API lets a device (no account)
 * post and vote on road reports. POST /api/v1/auth/device issues a token; it is kept in
 * localStorage so the same browser keeps the same identity, and re-issued when the server
 * rejects it (expired or revoked). Storage may be unavailable (private window): then the
 * session lives only until the page closes.
 */

export class ReportError extends Error {
  constructor(message, code = 'REPORT_FAILED') {
    super(message);
    this.code = code;
  }
}

export function createDeviceSession(storageKey, { fetchFn = (...a) => fetch(...a), now = () => Date.now() } = {}) {
  let session = null;

  const read = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (saved && typeof saved.token === 'string' && Date.parse(saved.expiresAt) > now() + 60000) return saved;
    } catch { /* storage unavailable or corrupt */ }
    return null;
  };
  const write = (value) => {
    try { localStorage.setItem(storageKey, JSON.stringify(value)); } catch { /* storage unavailable */ }
  };
  const forget = () => {
    session = null;
    try { localStorage.removeItem(storageKey); } catch { /* storage unavailable */ }
  };

  async function register() {
    const res = await fetchFn('/api/v1/auth/device', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: 'other' }),
    });
    const json = await res.json().catch(() => null);
    if (res.status === 429) throw new ReportError('Too many attempts. Wait a little and try again.', 'RATE_LIMITED');
    if (!res.ok || !json || !json.token) throw new ReportError('Hawr could not set up your session. Try again later.', 'NO_SESSION');
    session = { token: json.token, expiresAt: json.expiresAt };
    write(session);
    return session;
  }

  async function ensure() {
    if (!session) session = read();
    if (session && Date.parse(session.expiresAt) > now() + 60000) return session;
    return register();
  }

  async function send(body, retried = false) {
    const { token } = await ensure();
    const res = await fetchFn('/api/v1/reports', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    });
    if (res.status === 401 && !retried) { forget(); return send(body, true); }
    const json = await res.json().catch(() => null);
    if (res.ok) return json;
    if (res.status === 429) throw new ReportError('You have sent many reports in a short time. Try again later.', 'RATE_LIMITED');
    if (res.status === 503) throw new ReportError('Reports are unavailable right now: the Hawr database is not connected.', 'UNAVAILABLE');
    throw new ReportError(json && json.error ? json.error : `The report was not accepted (HTTP ${res.status}).`, (json && json.code) || 'REJECTED');
  }

  return {
    /** Posts a report { type, lat, lng, description? }; resolves the backend's answer or throws ReportError. */
    async postReport({ type, lat, lng, description }) {
      const body = { type, lat, lng };
      if (description && description.trim()) body.description = description.trim();
      try {
        return await send(body);
      } catch (err) {
        if (err instanceof ReportError) throw err;
        throw new ReportError('The report could not be sent: the Hawr server cannot be reached.', 'NETWORK');
      }
    },
  };
}
