-- PostGIS (geometry, spatial indexes, distance) and pg_trgm (fuzzy / partial name matching).
-- A host that does not allow CREATE EXTENSION must enable both for this database first.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Search is useless if this database cannot store or index Arabic / Kurdish names. Refuse early,
-- with the fix, instead of silently returning nothing for every non-Latin query:
--   * the database must be UTF8, and
--   * its ctype must be a UTF-8 locale: pg_trgm ignores every non-ASCII letter under the "C" ctype.
-- Create it like:  CREATE DATABASE redoz ENCODING 'UTF8' LC_COLLATE 'en_US.UTF-8' LC_CTYPE 'en_US.UTF-8' TEMPLATE template0;
-- (Windows locale names: 'en-US'.)
DO $$
BEGIN
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'database encoding is %, it must be UTF8 (Arabic and Kurdish names)', current_setting('server_encoding');
  END IF;
  IF cardinality(show_trgm('مستشفى السليمانية')) < 8 THEN
    RAISE EXCEPTION 'pg_trgm produces no trigrams for Arabic text: the database ctype is not a UTF-8 locale (it is "%"). Re-create the database with LC_CTYPE set to a UTF-8 locale such as en_US.UTF-8 (or C.UTF-8)',
      (SELECT datctype FROM pg_database WHERE datname = current_database());
  END IF;
END
$$;
