const { invalid } = require('../utils/apiError');
const {
  validateSignup, validateLogin, validateProfileUpdate, validatePasswordChange, validateAccountDeletion,
} = require('../utils/navValidation');

/**
 * User accounts of the mobile app, mounted at /api/v1/auth.
 *
 *   POST   /auth/signup           create an account, answer with a session (201)
 *   POST   /auth/login            sign in, answer with a session
 *   POST   /auth/refresh          a fresh session for a still-valid token    user token
 *   POST   /auth/logout           sign out on every device                    user token
 *   GET    /auth/me               the signed-in user                          user token
 *   PATCH  /auth/me               change the name                             user token
 *   POST   /auth/change-password  new password; other devices signed out     user token
 *   DELETE /auth/me               delete the account (password required)     user token
 *
 * Session: { ok, tokenType: "Bearer", token, expiresAt, user }. The app
 * stores the token securely and sends it as "Authorization: Bearer <token>".
 */
function unwrap(parsed) {
  if (parsed.errors) throw invalid(parsed.errors[0], parsed.errors);
  return parsed.value;
}

function createAuthController({ userAccounts, userTokens }) {
  const session = ({ user, tokenVersion }) => {
    const { token, expiresAt } = userTokens.issue(user.id, tokenVersion);
    return {
      ok: true, tokenType: 'Bearer', token, expiresAt, user,
    };
  };

  return {
    async signup(req, res) {
      res.status(201).json(session(await userAccounts.signup(unwrap(validateSignup(req.body)))));
    },

    async login(req, res) {
      res.json(session(await userAccounts.login(unwrap(validateLogin(req.body)))));
    },

    async refresh(req, res) {
      res.json(session(await userAccounts.current(req.userId, req.tokenVersion)));
    },

    async logout(req, res) {
      await userAccounts.logout(req.userId, req.tokenVersion);
      res.json({ ok: true });
    },

    async me(req, res) {
      const { user } = await userAccounts.current(req.userId, req.tokenVersion);
      res.json({ ok: true, user });
    },

    async updateMe(req, res) {
      const { user } = await userAccounts.updateProfile(req.userId, req.tokenVersion, unwrap(validateProfileUpdate(req.body)));
      res.json({ ok: true, user });
    },

    async changePassword(req, res) {
      const input = unwrap(validatePasswordChange(req.body));
      res.json(session(await userAccounts.changePassword(req.userId, req.tokenVersion, input)));
    },

    async deleteMe(req, res) {
      await userAccounts.deleteAccount(req.userId, req.tokenVersion, unwrap(validateAccountDeletion(req.body)));
      res.json({ ok: true, deleted: true });
    },
  };
}

module.exports = { createAuthController };
