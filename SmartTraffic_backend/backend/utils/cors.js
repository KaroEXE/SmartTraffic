/**
 * The origin check for the cors package and Socket.IO, from config.cors
 * ({ any, origins, allowLocalhost }). Requests without an Origin header are
 * allowed: they are not cross-site browser requests.
 */
const LOCALHOST = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function corsOrigin({ any, origins, allowLocalhost }) {
  if (any) return '*';
  return (origin, callback) => callback(null, !origin || origins.includes(origin) || (allowLocalhost && LOCALHOST.test(origin)));
}

module.exports = { corsOrigin };
