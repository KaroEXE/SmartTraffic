/**
 * Every SQL statement of the geographic layer (PostgreSQL + PostGIS). Controllers and services never
 * contain SQL; this file returns plain rows (snake_case, as the database gives them).
 *
 * Index use, so no query scans a table:
 *   - names:      search_names.name_norm  btree text_pattern_ops (prefix), GIN gin_trgm_ops (fuzzy,
 *                 partial). The query is folded by the same SQL function (redoz_normalize) that
 *                 folded the stored names, in a first round trip so the planner sees its value.
 *   - distance:   geometry GiST indexes. A candidate area is found with `geom && buffer` (index) and
 *                 only the survivors get an exact geography ST_Distance / ST_DWithin. Casting a
 *                 column to geography inside WHERE would skip the index; it is never done there.
 *   - containing: admin_area_parts (polygons cut to <= 256 vertices) with a GiST index.
 */

const ENTITY_COLUMNS = `
  e.place_key, e.source, e.entity, e.osm_type, e.osm_id, e.name, e.names, e.category, e.type,
  ST_Y(e.geom) AS lat, ST_X(e.geom) AS lng, e.bbox, e.address, e.address_text, e.city, e.state,
  e.details, e.importance, (e.verified OR COALESCE(m.verified, false)) AS verified,
  m.rating, m.rating_count`;

const point = (latParam, lngParam) => `ST_SetSRID(ST_MakePoint(${lngParam}::float8, ${latParam}::float8), 4326)`;

/**
 * The ranking SQL. Text score (exact 1.0, prefix 0.90-0.99, word-in-name 0.72-0.82, else trigram
 * similarity x 0.7; alternative / international names x 0.95-0.97) is weighted 0.70, proximity
 * (1 / (1 + km / 3), only with a position) 0.20, importance 0.10, a verified place +0.05.
 *
 * Candidates (all index-driven), then ranked together:
 *   - the 400 best name matches anywhere (a far exact match must still be found);
 *   - with a position: the 300 best name matches INSIDE a 40 km circle, so a common word searched
 *     near the user is not cut off by the 400 cap before distance is considered;
 *   - when the query is a category word ("restaurant", "مستشفى"): the nearest places of that
 *     category (within 50 km of the user, else the most important ones), text score 0.9. The
 *     categories are resolved in the first round trip (see searchPlaces) and passed in, so a query
 *     that names none never touches this branch.
 */
const NEAR_RADIUS_M = 40_000;
const CATEGORY_RADIUS_M = 50_000;

/**
 * Transaction-local settings of every search. Trigram thresholds looser than the defaults (0.3 / 0.6) so a
 * misspelled name still reaches the ranking. enable_seqscan off: the planner prices pg_trgm's operators as
 * almost free, so for some words ("cafe" near a big city) it picks a sequential pass over all of
 * search_names (measured 1.1 s) instead of the GIN / prefix indexes (81 ms). Every table the search reads
 * has an index that serves it, so the index plan is always available.
 */
const SEARCH_SETTINGS_SQL = "SELECT set_config('pg_trgm.similarity_threshold', '0.25', true), set_config('pg_trgm.word_similarity_threshold', '0.45', true), set_config('enable_seqscan', 'off', true)";

/** The SQL and its parameters for one search; the text differs by whether a position / categories exist. */
function buildSearch({
  q, cats, near, limit, offset,
}) {
  const params = [q];
  const next = (value) => { params.push(value); return `$${params.length}`; };
  const hasCats = Array.isArray(cats) && cats.length > 0;
  const catsParam = hasCats ? next(cats) : null;
  let pt = null;
  if (near) {
    const lat = next(near.lat);
    const lng = next(near.lng);
    pt = point(lat, lng);
  }
  const limitParam = next(limit);
  const offsetParam = next(offset);

  const catBranch = hasCats ? `,
cat_hits AS (
  SELECT e.place_key, e.name AS matched_name, 0.9::float8 AS text_score
  FROM search_entities e
  WHERE e.name IS NOT NULL AND e.category = ANY (${catsParam}::text[])
    ${near ? `AND e.geom && ST_Buffer(${pt}::geography, ${CATEGORY_RADIUS_M})::geometry` : ''}
  ORDER BY ${near ? `e.geom <-> ${pt}` : 'e.importance DESC'}
  LIMIT 150
)` : '';
  const nearBranch = near ? `,
near_top AS (
  SELECT b.place_key, b.matched_name, b.text_score
  FROM best b
  JOIN search_entities e ON e.place_key = b.place_key
  WHERE e.geom && ST_Buffer(${pt}::geography, ${NEAR_RADIUS_M})::geometry
  ORDER BY b.text_score DESC
  LIMIT 300
)` : '';
  const union = ['SELECT * FROM top'];
  if (near) union.push('SELECT * FROM near_top');
  if (hasCats) union.push('SELECT * FROM cat_hits');

  const sql = `
WITH name_hits AS (
  SELECT n.place_key, n.name AS matched_name,
         (CASE
            WHEN n.name_norm = $1 THEN 1.0
            WHEN n.name_norm LIKE $1 || '%' THEN 0.90 + 0.09 * (length($1)::float8 / length(n.name_norm))
            WHEN n.name_norm LIKE '% ' || $1 || '%' THEN 0.72 + 0.10 * (length($1)::float8 / length(n.name_norm))
            ELSE 0.7 * greatest(similarity(n.name_norm, $1), word_similarity($1, n.name_norm))
          END * CASE n.kind WHEN 'name' THEN 1.0 WHEN 'int' THEN 0.97 ELSE 0.95 END) AS text_score
  FROM search_names n
  WHERE n.name_norm LIKE $1 || '%'
     OR n.name_norm LIKE '% ' || $1 || '%'
     OR $1 <% n.name_norm
     OR n.name_norm % $1
),
best AS (
  SELECT DISTINCT ON (place_key) place_key, matched_name, text_score
  FROM name_hits ORDER BY place_key, text_score DESC
),
top AS (SELECT * FROM best ORDER BY text_score DESC LIMIT 400)${nearBranch}${catBranch},
cands AS (
  SELECT DISTINCT ON (place_key) place_key, matched_name, text_score
  FROM (${union.join(' UNION ALL ')}) u
  ORDER BY place_key, text_score DESC
)
SELECT ${ENTITY_COLUMNS}, c.matched_name, c.text_score,
       ${near ? `ST_Distance(e.geom::geography, ${pt}::geography)` : 'NULL::float8'} AS distance_m,
       (0.70 * c.text_score
        + 0.20 * ${near ? `(1.0 / (1.0 + ST_Distance(e.geom::geography, ${pt}::geography) / 3000.0))` : '0.0'}
        + 0.10 * e.importance
        + CASE WHEN (e.verified OR COALESCE(m.verified, false)) THEN 0.05 ELSE 0 END) AS score
FROM cands c
JOIN search_entities e ON e.place_key = c.place_key
LEFT JOIN redoz_place_metadata m ON m.place_key = e.place_key
ORDER BY score DESC, e.name
LIMIT ${limitParam} OFFSET ${offsetParam}`;
  return { sql, params };
}

function createGeoRepository({ pg }) {
  return {
    /** The folded form of a text, exactly as stored in search_names.name_norm. */
    async normalize(text) {
      return (await pg.query('SELECT redoz_normalize($1) AS q', [text])).rows[0].q;
    },

    /**
     * Ranked search over OSM and Redoz places, streets and areas.
     * @param {{query: string, near?: {lat:number,lng:number}|null, limit: number, offset: number}} p
     * @returns {Promise<{normalized: string, rows: object[]}>}
     */
    searchPlaces({
      query, near = null, limit, offset,
    }) {
      return pg.transaction(async (client) => {
        // First round trip: fold the text (the planner needs its value to use the prefix index) and
        // look up which categories it names, so the main query only has a category branch when it should.
        const { rows: [{ q, cats }] } = await client.query(`
          SELECT n.q, COALESCE((SELECT array_agg(DISTINCT ct.category) FROM category_terms ct
                                WHERE n.q <> '' AND (ct.term_norm = n.q OR similarity(ct.term_norm, n.q) >= 0.7)), '{}'::text[]) AS cats
          FROM (SELECT redoz_normalize($1) AS q) n`, [query]);
        if (!q) return { normalized: '', rows: [] };
        await client.query(SEARCH_SETTINGS_SQL);
        const { sql, params } = buildSearch({
          q, cats, near, limit, offset,
        });
        const { rows } = await client.query(sql, params);
        return { normalized: q, rows };
      });
    },

    /** Named / unnamed places of the given categories within `radius` metres, nearest first. */
    async findNearbyPlaces({
      lat, lng, radius, categories, limit,
    }) {
      const { rows } = await pg.query(`
        WITH me AS (SELECT ${point('$1', '$2')} AS g)
        SELECT ${ENTITY_COLUMNS}, ST_Distance(e.geom::geography, me.g::geography) AS distance_m
        FROM me
        JOIN search_entities e ON e.geom && ST_Buffer(me.g::geography, $3::float8)::geometry
        LEFT JOIN redoz_place_metadata m ON m.place_key = e.place_key
        WHERE e.entity = 'poi' AND e.category = ANY ($4::text[])
          AND ST_DWithin(e.geom::geography, me.g::geography, $3::float8)
        ORDER BY distance_m
        LIMIT $5`, [lat, lng, radius, categories, limit]);
      return rows;
    },

    /** Places inside a bounding box (south, west, north, east), most important first. */
    async findPlacesInBBox({
      south, west, north, east, categories = null, limit,
    }) {
      const { rows } = await pg.query(`
        SELECT ${ENTITY_COLUMNS}
        FROM search_entities e
        LEFT JOIN redoz_place_metadata m ON m.place_key = e.place_key
        WHERE e.geom && ST_MakeEnvelope($1::float8, $2::float8, $3::float8, $4::float8, 4326)
          AND e.entity IN ('poi', 'settlement')
          AND ($5::text[] IS NULL OR e.category = ANY ($5::text[]))
        ORDER BY e.importance DESC, e.name
        LIMIT $6`, [west, south, east, north, categories, limit]);
      return rows;
    },

    /** Roads within `radius` metres, nearest first, with the tags a router needs. */
    async findNearbyRoads({
      lat, lng, radius, limit, namedOnly = false,
    }) {
      const { rows } = await pg.query(`
        WITH me AS (SELECT ${point('$1', '$2')} AS g)
        SELECT r.osm_id, r.name, r.names, r.highway, r.ref, r.oneway, r.maxspeed, r.lanes, r.surface,
               r.junction, r.access, r.bridge, r.tunnel,
               ST_Distance(r.geom::geography, me.g::geography) AS distance_m
        FROM me
        JOIN osm_roads r ON r.geom && ST_Buffer(me.g::geography, $3::float8)::geometry
        WHERE ST_DWithin(r.geom::geography, me.g::geography, $3::float8)
          AND (NOT $5::boolean OR r.name IS NOT NULL)
        ORDER BY distance_m
        LIMIT $4`, [lat, lng, radius, limit, namedOnly]);
      return rows;
    },

    /** The nearest road, or null. */
    async findNearestRoad({
      lat, lng, radius, namedOnly = false,
    }) {
      const [road] = await this.findNearbyRoads({
        lat, lng, radius, limit: 1, namedOnly,
      });
      return road || null;
    },

    /** Great-circle (spheroid) distance in metres, computed by PostGIS. */
    async distanceMeters(a, b) {
      const { rows } = await pg.query(`SELECT ST_Distance(${point('$1', '$2')}::geography, ${point('$3', '$4')}::geography) AS d`, [a.lat, a.lng, b.lat, b.lng]);
      return Number(rows[0].d);
    },

    /** The nearest address point within `radius` metres, or null. */
    async findNearestAddress({ lat, lng, radius }) {
      const { rows } = await pg.query(`
        WITH me AS (SELECT ${point('$1', '$2')} AS g)
        SELECT a.osm_type, a.osm_id, a.housenumber, a.housename, a.street, a.suburb, a.city, a.postcode, a.address,
               ST_Distance(a.geom::geography, me.g::geography) AS distance_m
        FROM me
        JOIN osm_addresses a ON a.geom && ST_Buffer(me.g::geography, $3::float8)::geometry
        WHERE ST_DWithin(a.geom::geography, me.g::geography, $3::float8)
        ORDER BY distance_m
        LIMIT 1`, [lat, lng, radius]);
      return rows[0] || null;
    },

    /** Every administrative area containing the point, most specific first. */
    async findAdminAreasAt({ lat, lng }) {
      const { rows } = await pg.query(`
        WITH me AS (SELECT ${point('$1', '$2')} AS g)
        SELECT DISTINCT ON (p.osm_id) p.osm_id, p.admin_level, p.name, p.names
        FROM me JOIN admin_area_parts p ON ST_Covers(p.geom, me.g)
        ORDER BY p.osm_id`, [lat, lng]);
      return rows.sort((a, b) => b.admin_level - a.admin_level);
    },

    /** Nearest settlements (city, town, village, suburb, neighbourhood ...) of the given kinds. */
    async findNearestSettlements({
      lat, lng, types, radius, limit,
    }) {
      const { rows } = await pg.query(`
        WITH me AS (SELECT ${point('$1', '$2')} AS g)
        SELECT e.place_key, e.name, e.names, e.type, ST_Distance(e.geom::geography, me.g::geography) AS distance_m
        FROM me
        JOIN search_entities e ON e.geom && ST_Buffer(me.g::geography, $4::float8)::geometry
        WHERE e.entity = 'settlement' AND e.type = ANY ($3::text[])
          AND ST_DWithin(e.geom::geography, me.g::geography, $4::float8)
        ORDER BY distance_m
        LIMIT $5`, [lat, lng, types, radius, limit]);
      return rows;
    },

    /** The nearest named place of interest within `radius` metres, or null. */
    async findNearestPoi({ lat, lng, radius }) {
      const { rows } = await pg.query(`
        WITH me AS (SELECT ${point('$1', '$2')} AS g)
        SELECT ${ENTITY_COLUMNS}, ST_Distance(e.geom::geography, me.g::geography) AS distance_m
        FROM me
        JOIN search_entities e ON e.geom && ST_Buffer(me.g::geography, $3::float8)::geometry
        LEFT JOIN redoz_place_metadata m ON m.place_key = e.place_key
        WHERE e.entity = 'poi' AND e.name IS NOT NULL
          AND ST_DWithin(e.geom::geography, me.g::geography, $3::float8)
        ORDER BY distance_m
        LIMIT 1`, [lat, lng, radius]);
      return rows[0] || null;
    },
  };
}

module.exports = { createGeoRepository, buildSearch, SEARCH_SETTINGS_SQL };
