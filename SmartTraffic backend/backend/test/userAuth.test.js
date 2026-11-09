// User accounts: POST /api/v1/auth/signup, /auth/login, GET /auth/me,
// through the real router, controller, validation, hashing and tokens. The
// User model is an in-memory stand-in with the same unique-email rule.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startApi } = require('./helpers/navigationHarness');
const { hashPassword, verifyPassword } = require('../utils/password');

function fakeUserModel() {
  const users = new Map(); // id -> doc
  const matches = (doc, filter) => Object.entries(filter).every(([k, v]) => {
    const value = k === '_id' ? String(doc._id) : doc[k];
    if (v && typeof v === 'object' && v.$in) return v.$in.includes(value ?? null);
    return value === (k === '_id' ? String(v) : v);
  });
  return {
    users,
    async updateOne(filter, update) {
      const doc = [...users.values()].find((u) => matches(u, filter));
      if (!doc) return { matchedCount: 0 };
      Object.assign(doc, update.$set || {});
      for (const [k, n] of Object.entries(update.$inc || {})) doc[k] = (doc[k] || 0) + n;
      return { matchedCount: 1 };
    },
    async deleteOne({ _id }) { return { deletedCount: users.delete(String(_id)) ? 1 : 0 }; },
    async findOne({ email }) { return [...users.values()].find((u) => u.email === email) || null; },
    async findById(id) { return users.get(String(id)) || null; },
    async create(doc) {
      if ([...users.values()].some((u) => u.email === doc.email)) throw Object.assign(new Error('dup'), { code: 11000 });
      const saved = { ...doc, _id: crypto.randomBytes(12).toString('hex'), createdAt: new Date() };
      users.set(saved._id, saved);
      return saved;
    },
  };
}

const NO_PROVIDERS = 'http://127.0.0.1:9';
const start = (opts = {}) => startApi({
  providers: NO_PROVIDERS, isConnected: () => true, models: { User: opts.User || fakeUserModel() }, ...opts,
});
const account = { email: 'Driver@Example.com ', password: 'Secret123', name: 'Sara' };

test('signup creates an account, signs in, and /me returns it', async () => {
  const User = fakeUserModel();
  const api = await start({ User });
  try {
    const signup = await api.post('/api/v1/auth/signup', account);
    assert.equal(signup.status, 201);
    assert.equal(signup.body.tokenType, 'Bearer');
    assert.equal(signup.body.user.email, 'driver@example.com', 'email is normalised');
    assert.equal(signup.body.user.name, 'Sara');
    assert.ok(!('passwordHash' in signup.body.user), 'hash never returned');
    const stored = [...User.users.values()][0];
    assert.match(stored.passwordHash, /^scrypt\$/);
    assert.ok(!stored.passwordHash.includes('Secret123'));

    const me = await api.get('/api/v1/auth/me', { token: signup.body.token });
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.user, signup.body.user);

    const again = await api.post('/api/v1/auth/signup', { ...account, email: 'DRIVER@example.com' });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'EMAIL_TAKEN');
  } finally { await api.close(); }
});

test('login accepts the right password and refuses wrong ones the same way', async () => {
  const api = await start();
  try {
    await api.post('/api/v1/auth/signup', account);
    const login = await api.post('/api/v1/auth/login', { email: 'driver@example.com', password: 'Secret123' });
    assert.equal(login.status, 200);
    assert.ok(login.body.token);
    assert.equal((await api.get('/api/v1/auth/me', { token: login.body.token })).status, 200);

    const wrong = await api.post('/api/v1/auth/login', { email: 'driver@example.com', password: 'Wrong1234' });
    const unknown = await api.post('/api/v1/auth/login', { email: 'nobody@example.com', password: 'Secret123' });
    for (const r of [wrong, unknown]) {
      assert.equal(r.status, 401);
      assert.equal(r.body.code, 'INVALID_CREDENTIALS');
    }
    assert.equal(wrong.body.error, unknown.body.error, 'no account enumeration through login');
  } finally { await api.close(); }
});

test('signup and login validate their input', async () => {
  const api = await start();
  try {
    for (const body of [
      {}, { email: 'not-an-email', password: 'Secret123' }, { email: 'a@b.co', password: 'short1' },
      { email: 'a@b.co', password: 'onlyletters' }, { email: 'a@b.co', password: 'x'.repeat(200) + '1' },
      { email: 'a@b.co', password: 'Secret123', role: 'admin' }, { email: { $gt: '' }, password: 'Secret123' },
    ]) {
      const r = await api.post('/api/v1/auth/signup', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.code, 'INVALID_REQUEST');
    }
    const r = await api.post('/api/v1/auth/login', { email: { $ne: null }, password: { $ne: null } });
    assert.equal(r.status, 400, 'operator objects are refused');
  } finally { await api.close(); }
});

test('/me refuses missing, forged, device and expired tokens', async () => {
  let clock = Date.now();
  const User = fakeUserModel();
  const api = await start({ User, now: () => clock });
  try {
    const { token } = (await api.post('/api/v1/auth/signup', account)).body;
    assert.equal((await api.get('/api/v1/auth/me')).body.code, 'USER_TOKEN_REQUIRED');
    const [h, p] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), sub: 'a'.repeat(24) })).toString('base64url');
    assert.equal((await api.get('/api/v1/auth/me', { token: `${h}.${forged}.${token.split('.')[2]}` })).body.code, 'USER_TOKEN_INVALID');
    const device = await api.deviceToken();
    assert.equal((await api.get('/api/v1/auth/me', { token: device })).body.code, 'USER_TOKEN_INVALID', 'device token is not a user token');

    User.users.clear();
    assert.equal((await api.get('/api/v1/auth/me', { token })).status, 401, 'deleted account');

    clock += 8 * 86400_000;
    assert.equal((await api.get('/api/v1/auth/me', { token })).body.code, 'USER_TOKEN_EXPIRED');
  } finally { await api.close(); }
});

test('login is rate limited per account, and 503 without a database', async () => {
  const limits = {
    perMinute: 10_000, searchPerMinute: 10_000, routesPerMinute: 10_000, placesPerMinute: 10_000, deviceRegistrationsPerHour: 10_000,
    reportsPerHour: 10_000, votesPerHour: 10_000, signupsPerHour: 10_000, loginsPerHour: 10_000, loginsPerAccountPerHour: 3,
  };
  const api = await start({ overrides: { rateLimits: limits } });
  try {
    const attempt = (email) => api.post('/api/v1/auth/login', { email, password: 'Wrong1234' });
    for (let i = 0; i < 3; i += 1) assert.equal((await attempt('victim@example.com')).status, 401);
    assert.equal((await attempt('VICTIM@example.com')).status, 429);
    assert.equal((await attempt('other@example.com')).status, 401, 'other accounts are not affected');
  } finally { await api.close(); }

  const offline = await startApi({ providers: NO_PROVIDERS, isConnected: () => false, models: { User: fakeUserModel() } });
  try {
    const r = await offline.post('/api/v1/auth/signup', account);
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'DATABASE_UNAVAILABLE');
  } finally { await offline.close(); }
});

test('refresh issues a working token; logout revokes every token', async () => {
  let clock = Date.now();
  const api = await start({ now: () => clock });
  try {
    const first = (await api.post('/api/v1/auth/signup', account)).body.token;
    const second = (await api.post('/api/v1/auth/login', { email: account.email, password: 'Secret123' })).body.token;
    clock += 1000; // a new iat, so the refreshed token differs
    const refreshed = await api.post('/api/v1/auth/refresh', undefined, { token: first });
    assert.equal(refreshed.status, 200);
    assert.notEqual(refreshed.body.token, first);
    assert.equal((await api.get('/api/v1/auth/me', { token: refreshed.body.token })).status, 200);

    assert.equal((await api.post('/api/v1/auth/logout', undefined, { token: second })).status, 200);
    for (const token of [first, second, refreshed.body.token]) {
      const r = await api.get('/api/v1/auth/me', { token });
      assert.equal(r.status, 401, 'signed out on every device');
      assert.equal(r.body.code, 'USER_TOKEN_INVALID');
    }
    assert.equal((await api.post('/api/v1/auth/refresh', undefined, { token: first })).status, 401, 'revoked token cannot be refreshed');
    const back = await api.post('/api/v1/auth/login', { email: account.email, password: 'Secret123' });
    assert.equal((await api.get('/api/v1/auth/me', { token: back.body.token })).status, 200, 'signing in again works');
  } finally { await api.close(); }
});

test('profile name can be changed and cleared', async () => {
  const api = await start();
  try {
    const { token } = (await api.post('/api/v1/auth/signup', account)).body;
    const renamed = await api.patch('/api/v1/auth/me', { name: '  Sara   A. ' }, { token });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.user.name, 'Sara A.');
    assert.equal((await api.patch('/api/v1/auth/me', { name: null }, { token })).body.user.name, null);
    assert.equal((await api.patch('/api/v1/auth/me', { email: 'x@y.co' }, { token })).status, 400, 'email cannot be changed');
    assert.equal((await api.patch('/api/v1/auth/me', { name: 'x' })).status, 401);
  } finally { await api.close(); }
});

test('change password needs the current one, signs other devices out, and the new one works', async () => {
  const api = await start();
  try {
    const { token } = (await api.post('/api/v1/auth/signup', account)).body;
    const wrong = await api.post('/api/v1/auth/change-password', { currentPassword: 'Wrong1234', newPassword: 'NewSecret456' }, { token });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.code, 'WRONG_PASSWORD');
    assert.equal((await api.post('/api/v1/auth/change-password', { currentPassword: 'Secret123', newPassword: 'weak' }, { token })).status, 400);
    assert.equal((await api.post('/api/v1/auth/change-password', { currentPassword: 'Secret123', newPassword: 'Secret123' }, { token })).status, 400, 'must differ');

    const changed = await api.post('/api/v1/auth/change-password', { currentPassword: 'Secret123', newPassword: 'NewSecret456' }, { token });
    assert.equal(changed.status, 200);
    assert.equal((await api.get('/api/v1/auth/me', { token })).status, 401, 'old token revoked');
    assert.equal((await api.get('/api/v1/auth/me', { token: changed.body.token })).status, 200, 'new session works');
    assert.equal((await api.post('/api/v1/auth/login', { email: account.email, password: 'Secret123' })).status, 401);
    assert.equal((await api.post('/api/v1/auth/login', { email: account.email, password: 'NewSecret456' })).status, 200);
  } finally { await api.close(); }
});

test('delete account needs the password and removes it for good', async () => {
  const User = fakeUserModel();
  const api = await start({ User });
  try {
    const { token } = (await api.post('/api/v1/auth/signup', account)).body;
    assert.equal((await api.call('DELETE', '/api/v1/auth/me', { body: { password: 'Wrong1234' }, token })).body.code, 'WRONG_PASSWORD');
    assert.equal((await api.call('DELETE', '/api/v1/auth/me', { token })).status, 400, 'password required');
    assert.equal(User.users.size, 1);

    const deleted = await api.call('DELETE', '/api/v1/auth/me', { body: { password: 'Secret123' }, token });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deleted, true);
    assert.equal(User.users.size, 0);
    assert.equal((await api.get('/api/v1/auth/me', { token })).status, 401);
    assert.equal((await api.post('/api/v1/auth/login', { email: account.email, password: 'Secret123' })).status, 401);
    assert.equal((await api.post('/api/v1/auth/signup', account)).status, 201, 'the email can be used again');
  } finally { await api.close(); }
});

test('password checks of a signed-in user are rate limited per account', async () => {
  const limits = {
    perMinute: 10_000, searchPerMinute: 10_000, routesPerMinute: 10_000, placesPerMinute: 10_000, deviceRegistrationsPerHour: 10_000,
    reportsPerHour: 10_000, votesPerHour: 10_000, signupsPerHour: 10_000, loginsPerHour: 10_000, loginsPerAccountPerHour: 2,
  };
  const api = await start({ overrides: { rateLimits: limits } });
  try {
    const { token } = (await api.post('/api/v1/auth/signup', account)).body;
    const guess = () => api.call('DELETE', '/api/v1/auth/me', { body: { password: 'Guess1234' }, token });
    assert.equal((await guess()).status, 403);
    assert.equal((await guess()).status, 403);
    assert.equal((await guess()).status, 429);
  } finally { await api.close(); }
});

test('password hashes are salted and verify only the right password', async () => {
  const a = await hashPassword('Secret123');
  const b = await hashPassword('Secret123');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('Secret123', a), true);
  assert.equal(await verifyPassword('Secret124', a), false);
  assert.equal(await verifyPassword('Secret123', 'garbage'), false);
});
