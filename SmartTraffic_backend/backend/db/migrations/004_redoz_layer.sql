-- Redoz's own geographic layer. OpenStreetMap rows are never edited: what Redoz knows about a place
-- (verified, rating, parking, ...) lives here and is joined to the OSM row by place_key at query time.

-- Places Redoz adds itself. Searchable together with OSM places (a trigger keeps search_entities and
-- search_names in step, so there is nothing to remember to call).
CREATE TABLE IF NOT EXISTS redoz_places (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL CHECK (btrim(name) <> ''),
  names            jsonb NOT NULL DEFAULT '{}'::jsonb,        -- {"ar": "...", "ckb": "...", "en": "..."}
  alt_names        text[] NOT NULL DEFAULT '{}',
  category         text NOT NULL,                             -- same vocabulary as search_entities.category
  geom             geometry(Point, 4326) NOT NULL,
  address          text,
  address_details  jsonb,                                     -- {"road": "...", "city": "..."}
  verified         boolean NOT NULL DEFAULT false,
  source           text NOT NULL DEFAULT 'redoz',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS redoz_places_geom_gix ON redoz_places USING gist (geom);
CREATE INDEX IF NOT EXISTS redoz_places_category_ix ON redoz_places (category);

-- What Redoz adds to ANY place: an OSM one ('osm:w123') or a Redoz one ('redoz:<uuid>').
CREATE TABLE IF NOT EXISTS redoz_place_metadata (
  place_key       text PRIMARY KEY,
  verified        boolean NOT NULL DEFAULT false,
  redoz_category   text,
  rating          numeric(2, 1) CHECK (rating BETWEEN 0 AND 5),
  rating_count    integer NOT NULL DEFAULT 0 CHECK (rating_count >= 0),
  parking_info    jsonb,
  traffic_info    jsonb,
  extra           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Reports about a place (closed, moved, wrong name ...), kept apart from the place itself.
CREATE TABLE IF NOT EXISTS redoz_place_reports (
  id           bigserial PRIMARY KEY,
  place_key    text NOT NULL,
  report_type  text NOT NULL,
  description  text,
  device_id    text,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS redoz_place_reports_place_ix ON redoz_place_reports (place_key);

CREATE OR REPLACE FUNCTION redoz_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS redoz_places_touch ON redoz_places;
CREATE TRIGGER redoz_places_touch BEFORE UPDATE ON redoz_places
  FOR EACH ROW EXECUTE FUNCTION redoz_touch_updated_at();
DROP TRIGGER IF EXISTS redoz_place_metadata_touch ON redoz_place_metadata;
CREATE TRIGGER redoz_place_metadata_touch BEFORE UPDATE ON redoz_place_metadata
  FOR EACH ROW EXECUTE FUNCTION redoz_touch_updated_at();

-- redoz_places -> search_entities / search_names.
CREATE OR REPLACE FUNCTION redoz_places_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  key text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM search_entities WHERE place_key = 'redoz:' || OLD.id::text;
    RETURN OLD;
  END IF;

  key := 'redoz:' || NEW.id::text;

  INSERT INTO search_entities (place_key, source, entity, name, names, category, type, geom, address, address_text, importance, verified, updated_at)
  VALUES (
    key, 'redoz', 'poi', NEW.name,
    jsonb_build_object('name', NEW.name)
      || COALESCE((SELECT jsonb_object_agg('name:' || n.key, n.value) FROM jsonb_each_text(NEW.names) AS n), '{}'::jsonb),
    NEW.category, NEW.category, NEW.geom, NEW.address_details, NEW.address,
    CASE WHEN NEW.verified THEN 0.7 ELSE 0.45 END, NEW.verified, now()
  )
  ON CONFLICT (place_key) DO UPDATE SET
    name = EXCLUDED.name, names = EXCLUDED.names, category = EXCLUDED.category, type = EXCLUDED.type,
    geom = EXCLUDED.geom, address = EXCLUDED.address, address_text = EXCLUDED.address_text,
    importance = EXCLUDED.importance, verified = EXCLUDED.verified, updated_at = now();

  DELETE FROM search_names WHERE place_key = key;
  INSERT INTO search_names (place_key, name, name_norm, lang, kind)
  SELECT key, v.name, redoz_normalize(v.name), v.lang, v.kind
  FROM (
    SELECT NEW.name AS name, NULL::text AS lang, 'name' AS kind
    UNION ALL SELECT n.value, n.key, 'name' FROM jsonb_each_text(NEW.names) AS n
    UNION ALL SELECT a, NULL, 'alt' FROM unnest(NEW.alt_names) AS a
  ) AS v
  WHERE redoz_normalize(v.name) <> '';

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS redoz_places_sync_trg ON redoz_places;
CREATE TRIGGER redoz_places_sync_trg AFTER INSERT OR UPDATE OR DELETE ON redoz_places
  FOR EACH ROW EXECUTE FUNCTION redoz_places_sync();
