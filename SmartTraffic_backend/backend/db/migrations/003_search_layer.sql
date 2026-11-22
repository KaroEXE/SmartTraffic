-- Derived, query-optimised geographic tables. OpenStreetMap's own tables (osm_places, osm_roads,
-- osm_addresses, osm_admin_areas) are created by osm2pgsql (db/osm/redoz.lua) and are NOT defined here:
-- an import replaces them. Everything below is owned by migrations; db/osm/post-import.sql refills the
-- source = 'osm' rows after every import and never touches source = 'redoz' rows.

-- One row per searchable / nearby-able thing: a point of interest, a settlement (city, town,
-- neighbourhood ...), a street (all OSM ways of one street collapsed to one row) or an administrative
-- area. OSM and Redoz-owned places live in the same table, so one query searches both.
CREATE TABLE IF NOT EXISTS search_entities (
  place_key    text PRIMARY KEY,                       -- osm:n123 | osm:w123 | osm:r123 | osm:s<way> (street) | osm:a<relation> (area) | redoz:<uuid>
  source       text NOT NULL CHECK (source IN ('osm', 'redoz')),
  entity       text NOT NULL CHECK (entity IN ('poi', 'settlement', 'street', 'area')),
  osm_type     char(1),                                -- n | w | r for source = 'osm'
  osm_id       bigint,
  name         text,                                   -- NULL: an unnamed fuel station, parking lot ... (nearby only)
  names        jsonb NOT NULL DEFAULT '{}'::jsonb,     -- {"name": "...", "name:ar": "...", "name:ckb": "...", "alt_name": "..."}
  category     text NOT NULL,                          -- hospital, fuel, restaurant, shopping_mall, street, city ... (PLACE_CATEGORIES)
  type         text,                                   -- the OSM value (amenity=restaurant -> restaurant) or the highway class
  geom         geometry(Point, 4326) NOT NULL,
  bbox         jsonb,                                  -- {"south":..,"west":..,"north":..,"east":..} for streets and areas
  address      jsonb,                                  -- addr:* tags without the prefix
  address_text text,
  city         text,
  state        text,
  importance   real NOT NULL DEFAULT 0.3 CHECK (importance BETWEEN 0 AND 1),
  verified     boolean NOT NULL DEFAULT false,
  details      jsonb NOT NULL DEFAULT '{}'::jsonb,     -- brand, operator, opening_hours, phone, website
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS search_entities_geom_gix ON search_entities USING gist (geom);
CREATE INDEX IF NOT EXISTS search_entities_category_ix ON search_entities (category);
CREATE INDEX IF NOT EXISTS search_entities_source_ix ON search_entities (source);

-- One row per name variant of an entity (name, name:ar, name:ckb, name:en, alt_name ...), folded by
-- redoz_normalize. The trigram GIN index serves fuzzy and partial matches, the text_pattern_ops index
-- prefix matches; neither needs a full-table scan.
CREATE TABLE IF NOT EXISTS search_names (
  id         bigserial PRIMARY KEY,
  place_key  text NOT NULL REFERENCES search_entities (place_key) ON DELETE CASCADE,
  name       text NOT NULL,
  name_norm  text NOT NULL,
  lang       text,                                     -- ar | ckb | ku | en | NULL (local / unknown)
  kind       text NOT NULL CHECK (kind IN ('name', 'alt', 'int', 'old'))
);
CREATE INDEX IF NOT EXISTS search_names_trgm_gix ON search_names USING gin (name_norm gin_trgm_ops);
CREATE INDEX IF NOT EXISTS search_names_prefix_ix ON search_names (name_norm text_pattern_ops);
CREATE INDEX IF NOT EXISTS search_names_place_ix ON search_names (place_key);

-- A word a person types for a kind of place ("hospital", "مستشفى", "نەخۆشخانە") -> its category.
-- A query that matches one also returns the nearest places of that category.
CREATE TABLE IF NOT EXISTS category_terms (
  term_norm text NOT NULL,
  category  text NOT NULL,
  PRIMARY KEY (term_norm, category)
);
CREATE INDEX IF NOT EXISTS category_terms_trgm_gix ON category_terms USING gin (term_norm gin_trgm_ops);

-- Administrative areas cut into small pieces: a point-in-polygon test against a whole province or
-- country outline is slow, against a piece of at most 256 vertices it is not. Filled by post-import.sql.
CREATE TABLE IF NOT EXISTS admin_area_parts (
  osm_id       bigint NOT NULL,                        -- relation id
  admin_level  integer NOT NULL,
  name         text,
  names        jsonb NOT NULL DEFAULT '{}'::jsonb,
  geom         geometry(Polygon, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_area_parts_geom_gix ON admin_area_parts USING gist (geom);
CREATE INDEX IF NOT EXISTS admin_area_parts_level_ix ON admin_area_parts (admin_level);

-- What was imported, when, from which file.
CREATE TABLE IF NOT EXISTS osm_import_runs (
  id            bigserial PRIMARY KEY,
  source_file   text NOT NULL,
  file_bytes    bigint,
  tool_version  text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  counts        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'finished', 'failed'))
);
