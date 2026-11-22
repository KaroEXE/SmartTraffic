-- Runs after every osm2pgsql import (scripts/importOsm.js, inside ONE transaction, so search keeps
-- answering from the old index until this one is complete). Rebuilds everything derived from the
-- osm_* tables. Rows with source = 'redoz' (Redoz-owned places) are never touched.

-- 1. Forget the previous import's derived rows (search_names goes with them: ON DELETE CASCADE).
DELETE FROM search_entities WHERE source = 'osm';
TRUNCATE admin_area_parts;

-- 2. Points of interest and settlements.
INSERT INTO search_entities (place_key, source, entity, osm_type, osm_id, name, names, category, type, geom, address, importance, details)
SELECT 'osm:' || lower(p.osm_type) || p.osm_id, 'osm',
       CASE WHEN p.class = 'place' THEN 'settlement' ELSE 'poi' END,
       lower(p.osm_type), p.osm_id, p.name, COALESCE(p.names, '{}'::jsonb), p.category, p.type, p.geom,
       p.address, COALESCE(p.importance, 0.3), COALESCE(p.details, '{}'::jsonb)
FROM osm_places p;

-- 3. Streets: the ways of one street (same name, within ~1 km of each other) become ONE search row,
--    otherwise "شارع 60" would be hundreds of results. Representative point = a point on the street
--    near its middle.
CREATE TEMP TABLE _street_ways ON COMMIT DROP AS
SELECT r.osm_id, r.name, r.names, r.highway, r.geom,
       ST_ClusterDBSCAN(r.geom, eps := 0.01, minpoints := 1) OVER (PARTITION BY r.name) AS cluster_id
FROM osm_roads r
WHERE r.name IS NOT NULL
  AND r.highway IN ('motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'pedestrian');

CREATE TEMP TABLE _street_names ON COMMIT DROP AS
SELECT w.name, w.cluster_id, jsonb_object_agg(n.key, n.value) AS names
FROM _street_ways w
CROSS JOIN LATERAL jsonb_each_text(COALESCE(w.names, jsonb_build_object('name', w.name))) AS n
GROUP BY w.name, w.cluster_id;

INSERT INTO search_entities (place_key, source, entity, osm_type, osm_id, name, names, category, type, geom, bbox, importance)
SELECT 'osm:s' || s.first_way, 'osm', 'street', 'w', s.first_way, s.name, sn.names, 'street', s.highway,
       ST_ClosestPoint(s.line, ST_Centroid(s.line)),
       jsonb_build_object('south', ST_YMin(s.line), 'west', ST_XMin(s.line), 'north', ST_YMax(s.line), 'east', ST_XMax(s.line)),
       s.importance
FROM (
  SELECT w.name, w.cluster_id, min(w.osm_id) AS first_way,
         (array_agg(w.highway ORDER BY CASE w.highway WHEN 'motorway' THEN 1 WHEN 'trunk' THEN 2 WHEN 'primary' THEN 3 WHEN 'secondary' THEN 4 WHEN 'tertiary' THEN 5 WHEN 'unclassified' THEN 6 WHEN 'residential' THEN 7 ELSE 8 END))[1] AS highway,
         ST_Collect(w.geom) AS line,
         (CASE (array_agg(w.highway ORDER BY CASE w.highway WHEN 'motorway' THEN 1 WHEN 'trunk' THEN 2 WHEN 'primary' THEN 3 WHEN 'secondary' THEN 4 WHEN 'tertiary' THEN 5 WHEN 'unclassified' THEN 6 WHEN 'residential' THEN 7 ELSE 8 END))[1]
            WHEN 'motorway' THEN 0.6 WHEN 'trunk' THEN 0.6 WHEN 'primary' THEN 0.55 WHEN 'secondary' THEN 0.5
            WHEN 'tertiary' THEN 0.45 WHEN 'residential' THEN 0.35 ELSE 0.3 END)::real AS importance
  FROM _street_ways w
  WHERE w.cluster_id IS NOT NULL
  GROUP BY w.name, w.cluster_id
) s
JOIN _street_names sn ON sn.name = s.name AND sn.cluster_id = s.cluster_id;

-- 4. Administrative areas: cut into small pieces for fast "which area contains this point", and
--    searchable by name (governorate, district ...).
INSERT INTO admin_area_parts (osm_id, admin_level, name, names, geom)
SELECT a.osm_id, a.admin_level, a.name, COALESCE(a.names, '{}'::jsonb), d.geom
FROM osm_admin_areas a
CROSS JOIN LATERAL ST_Subdivide(ST_CollectionExtract(ST_MakeValid(a.geom), 3), 256) AS s(geom)
CROSS JOIN LATERAL ST_Dump(s.geom) AS d;

INSERT INTO search_entities (place_key, source, entity, osm_type, osm_id, name, names, category, type, geom, bbox, importance)
SELECT 'osm:a' || a.osm_id, 'osm', 'area', 'r', a.osm_id, a.name, COALESCE(a.names, '{}'::jsonb), 'area', 'admin_level_' || a.admin_level,
       ST_PointOnSurface(a.geom),
       jsonb_build_object('south', ST_YMin(a.geom), 'west', ST_XMin(a.geom), 'north', ST_YMax(a.geom), 'east', ST_XMax(a.geom)),
       (CASE WHEN a.admin_level <= 2 THEN 1.0 WHEN a.admin_level <= 4 THEN 0.85 WHEN a.admin_level <= 6 THEN 0.65 WHEN a.admin_level <= 8 THEN 0.5 ELSE 0.4 END)::real
FROM osm_admin_areas a;

-- 5. Which district / governorate a place is in (shown as part of its address). English name when OSM
--    has one, else the local name. Only the most specific area up to level 8 and the governorate level.
UPDATE search_entities e SET
  city = (SELECT COALESCE(p.names ->> 'name:en', p.name) FROM admin_area_parts p
          WHERE p.admin_level BETWEEN 5 AND 8 AND ST_Covers(p.geom, e.geom)
          ORDER BY p.admin_level DESC LIMIT 1),
  state = (SELECT COALESCE(p.names ->> 'name:en', p.name) FROM admin_area_parts p
           WHERE p.admin_level = 4 AND ST_Covers(p.geom, e.geom) LIMIT 1)
WHERE e.source = 'osm' AND e.entity IN ('poi', 'settlement', 'street');

UPDATE search_entities e SET
  address_text = NULLIF(concat_ws(', ',
    NULLIF(concat_ws(' ', e.address ->> 'street', e.address ->> 'housenumber'), ''),
    NULLIF(NULLIF(e.address ->> 'city', e.name), ''),
    NULLIF(NULLIF(e.city, e.name), ''),
    NULLIF(e.state, e.name)), '')
WHERE e.source = 'osm' AND e.entity IN ('poi', 'settlement', 'street');

-- 6. One row per name variant, folded for matching. name / name:xx -> kind 'name', alt_name ->
--    'alt', int_name -> 'int', old_name -> 'old'; "a;b" lists are split; one row per distinct folded name.
INSERT INTO search_names (place_key, name, name_norm, lang, kind)
SELECT DISTINCT ON (v.place_key, v.name_norm) v.place_key, v.name, v.name_norm, v.lang, v.kind
FROM (
  SELECT e.place_key, btrim(part.val) AS name, redoz_normalize(btrim(part.val)) AS name_norm,
         NULLIF(split_part(n.key, ':', 2), '') AS lang,
         CASE split_part(n.key, ':', 1)
           WHEN 'name' THEN 'name' WHEN 'int_name' THEN 'int' WHEN 'old_name' THEN 'old' ELSE 'alt'
         END AS kind
  FROM search_entities e
  CROSS JOIN LATERAL jsonb_each_text(e.names) AS n
  CROSS JOIN LATERAL unnest(string_to_array(n.value, ';')) AS part(val)
  WHERE e.source = 'osm'
) v
WHERE v.name_norm <> ''
ORDER BY v.place_key, v.name_norm, (v.kind = 'name') DESC, (v.lang IS NULL) DESC;

ANALYZE search_entities;
ANALYZE search_names;
ANALYZE admin_area_parts;
