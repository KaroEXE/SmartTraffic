const { Schema, model } = require('mongoose');
const { LIMITS } = require('./navigationConstants');

/**
 * A user account of the mobile app (POST /api/v1/auth/signup). Written
 * through services/navigation/userAccountService.js.
 *
 * `email` is stored lower-cased and is unique. `passwordHash` is a salted
 * scrypt hash (utils/password.js); it is never returned by the API and
 * never logged.
 *
 * `tokenVersion` is copied into every user token ("tv"); raising it (logout,
 * password change) makes all earlier tokens of this account invalid.
 */
const userSchema = new Schema({
  email: {
    type: String, required: true, trim: true, lowercase: true, maxlength: LIMITS.emailMaxLength,
  },
  passwordHash: { type: String, required: true },
  name: { type: String, trim: true, maxlength: LIMITS.userNameMaxLength, default: null },
  tokenVersion: { type: Number, default: 0, min: 0 },
}, { timestamps: true, versionKey: false });

userSchema.index({ email: 1 }, { unique: true });

module.exports = model('User', userSchema);
