const defaultUser = require('../../models/User');
const { isDatabaseConnected } = require('../../config/database');
const { ApiError, dbUnavailable } = require('../../utils/apiError');
const { hashPassword, verifyPassword, burnPasswordCheck } = require('../../utils/password');

/**
 * User accounts in MongoDB (models/User.js).
 *
 * Methods that sign someone in answer with an account:
 *   { user: { id, email, name, createdAt }, tokenVersion }
 * `user` is what the API returns (the password hash never leaves this
 * file); `tokenVersion` goes into the user token.
 *
 * Login failures are always 401 INVALID_CREDENTIALS, whether the email is
 * unknown or the password wrong, and take about the same time either way.
 */
const iso = (d) => (d ? new Date(d).toISOString() : null);
const versionOf = (doc) => doc.tokenVersion || 0;
// Accounts created before tokenVersion existed have no field: that is 0.
const versionFilter = (tv) => (tv === 0 ? { $in: [0, null] } : tv);

function toAccount(doc) {
  return {
    user: {
      id: String(doc._id), email: doc.email, name: doc.name || null, createdAt: iso(doc.createdAt),
    },
    tokenVersion: versionOf(doc),
  };
}

function createUserAccountService({ User = defaultUser, isConnected = isDatabaseConnected }) {
  const requireDb = () => { if (!isConnected()) throw dbUnavailable(); };
  const emailTaken = () => new ApiError(409, 'EMAIL_TAKEN', 'An account with this email already exists: sign in instead');
  // 403, not 401: the session is fine, only the password given is wrong.
  const wrongPassword = () => new ApiError(403, 'WRONG_PASSWORD', 'The password is not correct');
  const signedOut = () => new ApiError(401, 'USER_TOKEN_INVALID', 'This session has ended: sign in again with POST /api/v1/auth/login');

  async function signup({ email, password, name }) {
    requireDb();
    if (await User.findOne({ email })) throw emailTaken();
    const passwordHash = await hashPassword(password);
    try {
      return toAccount(await User.create({
        email, passwordHash, name, tokenVersion: 0,
      }));
    } catch (err) {
      if (err && err.code === 11000) throw emailTaken(); // concurrent signup, unique index
      throw err;
    }
  }

  async function login({ email, password }) {
    requireDb();
    const user = await User.findOne({ email });
    const valid = user ? await verifyPassword(password, user.passwordHash) : await burnPasswordCheck(password);
    if (!valid) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Wrong email or password');
    return toAccount(user);
  }

  /** The account a user token belongs to; 401 when it was deleted or the token revoked. */
  async function current(id, tokenVersion) {
    requireDb();
    const user = await User.findById(id);
    if (!user || versionOf(user) !== tokenVersion) throw signedOut();
    return toAccount(user);
  }

  /** Revokes every token of the account (all devices). */
  async function logout(id, tokenVersion) {
    requireDb();
    const r = await User.updateOne({ _id: id, tokenVersion: versionFilter(tokenVersion) }, { $inc: { tokenVersion: 1 } });
    if (!r.matchedCount) throw signedOut();
  }

  async function updateProfile(id, tokenVersion, { name }) {
    requireDb();
    const r = await User.updateOne({ _id: id, tokenVersion: versionFilter(tokenVersion) }, { $set: { name } });
    if (!r.matchedCount) throw signedOut();
    return current(id, tokenVersion);
  }

  /** New password; every earlier token is revoked and a new account version returned. */
  async function changePassword(id, tokenVersion, { currentPassword, newPassword }) {
    requireDb();
    const user = await User.findById(id);
    if (!user || versionOf(user) !== tokenVersion) throw signedOut();
    if (!await verifyPassword(currentPassword, user.passwordHash)) throw wrongPassword();
    const passwordHash = await hashPassword(newPassword);
    // Conditional on the version: a concurrent logout or change wins.
    const r = await User.updateOne(
      { _id: id, tokenVersion: versionFilter(tokenVersion) },
      { $set: { passwordHash }, $inc: { tokenVersion: 1 } },
    );
    if (!r.matchedCount) throw signedOut();
    return current(id, tokenVersion + 1);
  }

  /** Deletes the account for good after checking its password. */
  async function deleteAccount(id, tokenVersion, { password }) {
    requireDb();
    const user = await User.findById(id);
    if (!user || versionOf(user) !== tokenVersion) throw signedOut();
    if (!await verifyPassword(password, user.passwordHash)) throw wrongPassword();
    await User.deleteOne({ _id: id });
  }

  return {
    signup, login, current, logout, updateProfile, changePassword, deleteAccount,
  };
}

module.exports = { createUserAccountService };
