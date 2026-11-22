const {
  parseBBox, parseList, checkObjectId, validateLocalPlaceInput, validateSavedPlaceInput,
} = require('../utils/navValidation');
const { invalid, ApiError } = require('../utils/apiError');
const { LOCAL_PLACE_CATEGORIES, LIMITS } = require('../models/navigationConstants');

/**
 * HTTP layer for Hawr's own places (/api/v1):
 *
 *   GET    /places/local?south&west&north&east[&categories]   public: the map layer
 *   GET    /places/local/:id                                  public
 *   POST   /places/local, PATCH / DELETE /places/local/:id    admin
 *   GET    /saved-places                                      user token: the user's saved places
 *   POST   /saved-places, PATCH / DELETE /saved-places/:id    user token
 *
 * Authentication (admin / user token) is applied by routes/navigationRoutes.js. Saved
 * places check on every call that the token is still valid (a logout revokes it).
 */

function unwrap(parsed) {
  if (parsed.errors) throw invalid(parsed.errors[0], parsed.errors);
  return parsed.value;
}

function requireId(req) {
  if (!checkObjectId(req.params.id)) throw invalid('id must be a 24-character hexadecimal id');
  return req.params.id;
}

function requireJson(req) {
  if (!req.is('application/json')) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
}

function createPlaceDataController({ localPlaces, savedPlaces, userAccounts }) {
  /** The signed-in user's id, after checking that the token has not been revoked by a logout. */
  async function currentUser(req) {
    await userAccounts.current(req.userId, req.tokenVersion);
    return req.userId;
  }

  return {
    async listLocal(req, res) {
      const bbox = unwrap(parseBBox(req.query));
      const categories = unwrap(parseList(req.query.categories, LOCAL_PLACE_CATEGORIES, 'categories'));
      const result = await localPlaces.findInBBox(bbox, { categories });
      const places = result.places.slice(0, LIMITS.maxListResults);
      res.json({
        ok: true, bbox, count: places.length, truncated: result.truncated, places,
      });
    },

    async getLocal(req, res) {
      res.json({ ok: true, place: await localPlaces.get(requireId(req)) });
    },

    async createLocal(req, res) {
      requireJson(req);
      const input = unwrap(validateLocalPlaceInput(req.body));
      res.status(201).json({ ok: true, place: await localPlaces.create(input) });
    },

    async updateLocal(req, res) {
      const id = requireId(req);
      requireJson(req);
      const changes = unwrap(validateLocalPlaceInput(req.body, { partial: true }));
      res.json({ ok: true, place: await localPlaces.update(id, changes) });
    },

    async deleteLocal(req, res) {
      const place = await localPlaces.remove(requireId(req));
      res.json({ ok: true, deleted: place.id, place });
    },

    async listSaved(req, res) {
      const list = await savedPlaces.list(await currentUser(req));
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, count: list.length, savedPlaces: list });
    },

    async createSaved(req, res) {
      requireJson(req);
      const input = unwrap(validateSavedPlaceInput(req.body));
      res.status(201).json({ ok: true, savedPlace: await savedPlaces.create(await currentUser(req), input) });
    },

    async updateSaved(req, res) {
      const id = requireId(req);
      requireJson(req);
      const changes = unwrap(validateSavedPlaceInput(req.body, { partial: true }));
      res.json({ ok: true, savedPlace: await savedPlaces.update(await currentUser(req), id, changes) });
    },

    async deleteSaved(req, res) {
      const place = await savedPlaces.remove(await currentUser(req), requireId(req));
      res.json({ ok: true, deleted: place.id, savedPlace: place });
    },
  };
}

module.exports = { createPlaceDataController };
