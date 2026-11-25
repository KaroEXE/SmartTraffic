# Geographic database: PostgreSQL + PostGIS + OpenStreetMap

> **Status (November 2026): verified on PostgreSQL 17 + PostGIS 3.7 with the Iraq extract** (`iraq-261117.osm.pbf`:
> 128k places of interest, 32k streets, 22k settlements, 1.7k administrative areas; about 600 MB of tables). All five
> migrations, the import, the 16 tests of `test/geoDatabase.test.js` and the HTTP endpoints ran against a real database,
> including with `DATABASE_SCHEMA=redoz` next to an older osm2pgsql import whose rows and content stayed unchanged. Not yet measured: the
> Northflank addon itself (see "Production (Northflank)"). Searches took 30-150 ms there.

Search, reverse geocoding, nearby places and (later) routing data come from **our own PostgreSQL/PostGIS database**
filled from an OpenStreetMap extract. No external search or geocoding provider is called. MongoDB is unchanged and
keeps users, authentication, reports, traffic events, devices and favourites.

```
Web / mobile app
      |  GET /api/search   GET /api/geocode/reverse   GET /api/v1/places/*
      v
Node.js API (this backend)  ---- MongoDB (users, reports, traffic ...)
      |  DATABASE_URL
      v
PostgreSQL + PostGIS  <-- osm2pgsql  <-- iraq-261117.osm.pbf  (separate job, never at server start)
```

Routing is the one thing still outside: it uses Geoapify or your own OSRM (`ROUTING_OSRM_URL`). The tables below keep
what a self-hosted router needs (see "Preparing for routing").

## Code layout

| Path | Role |
|---|---|
| `db/postgres.js` | Lazy `pg` pool. The server starts without `DATABASE_URL`; geographic endpoints then answer `503 FEATURE_DISABLED`. |
| `db/migrations/*.sql`, `db/migrate.js` | Migrations (`npm run db:migrate`): checksummed, one transaction each, advisory-locked. |
| `db/osm/redoz.lua` | osm2pgsql *flex* style: which OSM objects become places, roads, addresses, admin areas. |
| `db/osm/post-import.sql` | Builds the derived search tables after an import, in one transaction. |
| `scripts/importOsm.js` | `npm run db:import-osm`: runs osm2pgsql, then `post-import.sql`, records the run. |
| `repositories/geoRepository.js` | **All SQL.** Controllers and services contain none. |
| `services/geo/geoService.js` | `searchPlaces`, `reverseGeocode`, `findNearbyPlaces`, `findNearestRoad`, `findNearbyRoads`, `findPlacesInBBox`, `distanceMeters`. |
| `controllers/geoController.js`, `routes/geoRoutes.js` | `GET /api/search`, `GET /api/geocode/reverse`. |
| `services/navigation/placeService.js` | `/api/v1/places/*` for the existing apps, backed by the same service (response shapes unchanged). |

## Who owns which table

* **osm2pgsql owns** `osm_places`, `osm_roads`, `osm_addresses`, `osm_admin_areas`. Every import (`--create`) drops and
  rebuilds exactly these four. Nothing writes to them.
* **Migrations own** everything else, so an import never destroys it:

| Table | Content |
|---|---|
| `search_entities` | One row per searchable thing: POI, settlement, street (all ways of one street collapsed into one row), administrative area, Redoz place. `place_key` is `osm:n123` / `osm:w123` / `osm:r123` / `osm:s<way>` / `osm:a<relation>` / `redoz:<uuid>` (OSM ids overlap between nodes, ways and relations, so the type is part of the key). |
| `search_names` | One row per name variant (`name`, `name:ar`, `name:ckb`, `name:en`, `alt_name`, `int_name`, `old_name`), folded by `redoz_normalize`. |
| `category_terms` | Words people type for a kind of place ("restaurant", "مستشفى", "نەخۆشخانە") -> category. |
| `admin_area_parts` | Administrative polygons cut to <= 256 vertices (fast point-in-polygon). |
| `redoz_places` | **Redoz-owned places** (name, alternative names, category, point, address, `verified`, `source`, timestamps). A trigger keeps them searchable together with OSM data. |
| `redoz_place_metadata` | What Redoz adds to *any* place (`osm:w123` or `redoz:<uuid>`): verified, rating, parking, traffic, extra. Joined at query time; OSM rows are never edited. |
| `redoz_place_reports` | Reports about a place (closed, moved, wrong name). |
| `osm_import_runs`, `schema_migrations` | What was imported / migrated, when. |

`redoz_places` are inserted with plain SQL (an admin tool can be added later); `search_entities` and `search_names` follow
automatically.

Existing operator places in MongoDB (`LocalPlace`) are **not migrated**: `/api/v1/places/search` still lists them first.
`/api/search` is PostGIS only.

## Setting up (local)

1. **PostgreSQL 15+ with PostGIS** (on Windows: the EDB installer, then *Application Stack Builder -> Spatial Extensions ->
   PostGIS*). Create the database **UTF8 with a UTF-8 ctype**; with a "C" ctype `pg_trgm` ignores every Arabic or
   Kurdish letter and search silently finds nothing (the first migration refuses such a database and says so):

   ```sql
   CREATE DATABASE redoz ENCODING 'UTF8' LC_COLLATE 'en_US.UTF-8' LC_CTYPE 'en_US.UTF-8' TEMPLATE template0;
   -- Windows locale name: 'en-US' instead of 'en_US.UTF-8'
   ```
2. **osm2pgsql >= 1.8** (<https://osm2pgsql.org/download/>); put it on `PATH` or set `OSM2PGSQL_BIN`.
3. In `backend/.env`: `DATABASE_URL=postgresql://postgres:<password>@127.0.0.1:5432/redoz`.
4. ```bash
   cd backend
   npm run db:migrate          # extensions, tables, indexes, functions, category words
   npm run db:import-osm       # osm2pgsql + post-import (see options below)
   npm start
   ```

`npm run db:import-osm -- --file D:/data/iraq.osm.pbf --cache 2000 --processes 2`. The extract defaults to the only
`*.osm.pbf` in the repository root (or `OSM_PBF_PATH`); `.gitignore` keeps `*.osm.pbf` out of git. `--post-only` rebuilds the
derived tables from the `osm_*` tables already loaded. Re-running an import replaces the OSM data and keeps Redoz data.

The import is a separate process: the Node server never imports and starts normally without the data (search then returns
nothing, or `503 GEO_DATA_NOT_READY` before the first import).

## What is imported

`db/osm/redoz.lua`:

* **Places** (`osm_places`): nodes and the centre of areas tagged `amenity`, `shop`, `healthcare`, `tourism`, `leisure`,
  `office`, `historic`, `aeroway=aerodrome|terminal`, `railway=station`, `public_transport=station`, `place=*` (settlements).
  Street furniture (benches, bins ...) is dropped. Unnamed objects are kept only for fuel, charging, parking, hospital,
  pharmacy, police, restaurant, cafe, ATM, bank, car repair and hotel (the "nearby" feature). All names are kept:
  `name`, `name:*`, `alt_name`, `int_name`, `old_name`, `official_name`, `short_name`, `loc_name`, plus every other tag.
* **Roads** (`osm_roads`): ways with `highway` in motorway ... residential, service, living_street, pedestrian, track, road
  (not footpaths, steps, cycleways), with **all tags** (only `source*`, `created_by`, `note*`, `fixme*`, `attribution`,
  `import*`, `survey*`, `check_date*`, `tiger:*`, `is_in*` are dropped), and `oneway`, `maxspeed`, `lanes`, `surface`,
  `junction`, `access`, `bridge`, `tunnel`, `ref` as columns.
* **Addresses** (`osm_addresses`): anything with `addr:housenumber`, `addr:housename` or `addr:street`.
* **Administrative areas** (`osm_admin_areas`): `boundary=administrative` relations with a name and `admin_level`.

Geometry is SRID 4326 everywhere, with GiST indexes. Names are stored as given (Kurdish/Arabic script untouched).

## Search

`GET /api/search?q=&lat=&lng=&limit=&offset=&lang=` (Swagger UI at `/api/docs/`).

**Matching** (all index-driven; the query is folded by the same SQL function that folded the stored names):

* `redoz_normalize` (immutable, in `002_normalize.sql`): case, Latin accents, Arabic-Indic digits, vowel marks, tatweel,
  zero-width marks, apostrophes, punctuation; Arabic / Sorani Kurdish / Persian letters meet: `ك ک`, `ي ی ى ێ ئ`, `ه ە ة`,
  `أ إ آ`, `پ->ب`, `چ->ج`, `ژ->ز`, `گ->ك`, `ڤ->ف`, `ڕ->ر`, `ڵ->ل`, `ۆ ؤ->و`. (`unaccent` is not used: it is not immutable, so it cannot be indexed, and it knows nothing about Arabic script.)
* exact / prefix: btree `text_pattern_ops` on `search_names.name_norm`; partial and misspelled: `pg_trgm` GIN
  (`%`, `<%`, `LIKE '%x%'`), thresholds 0.25 / 0.45.
* every name variant is a row, so a place is found by its Arabic, Kurdish, English or alternative name.

**Ranking** (`repositories/geoRepository.js`, `searchSql`): `score = 0.70 * text + 0.20 * proximity + 0.10 * importance (+0.05 verified)`.

| Signal | Value |
|---|---|
| exact name | 1.0 |
| prefix | 0.90 - 0.99 (closer length is better) |
| a word of the name starts with the query | 0.72 - 0.82 |
| fuzzy | 0.7 x max(trigram similarity, word similarity) |
| alternative / international / old name | x 0.95 / 0.97 |
| category word ("restaurant", "مستشفى") | the nearest places of that category get 0.9 |
| proximity (only with `lat`/`lng`) | `1 / (1 + km/3)`, from PostGIS `ST_Distance` on the geography |
| importance | city 0.9 ... neighbourhood 0.4, hospital / mall 0.6, road class 0.3 - 0.6, +0.1 with a Wikidata/Wikipedia tag |
| verified Redoz data | +0.05 |

A far exact match still beats a near fuzzy one; a near restaurant beats a far one. Results are one row per place (best
matching name), `limit` 1-20 (default 10), `offset` 0-200, `pagination.hasMore` says whether there is another page.

## Reverse geocoding

`GET /api/geocode/reverse?lat=&lng=` runs these PostGIS lookups in parallel (nothing is loaded into Node): nearest address
point (40 m), nearest named road (120 m), administrative polygons containing the point (`ST_Covers`), nearest city/town/village
(25 km) and suburb/neighbourhood (1.5 km), nearest named place (30 m). The administrative levels are read as:
country `2`, governorate `4`, district `5-6`, city `7-8`, neighbourhood `9-10`; if the data has no city polygon the nearest
`place=city|town|village` is used. A point with no data gives `displayName: null` (HTTP 200), never an invented address.

## Preparing for routing

`osm_roads` keeps, per OSM way: id (`osm_id`), `highway`, name(s), `ref`, `oneway`, `junction`, `maxspeed`, `lanes`,
`surface`, `access`, `bridge`, `tunnel`, the full tag set (`tags`, includes `motor_vehicle`, `vehicle`, `foot`, `toll`,
`maxspeed:*`, `turn:lanes` ...) and the geometry. OSRM or Valhalla read the `.osm.pbf` directly (not this database), so
nothing else is needed to evaluate them; the table is for matching, snapping and analysis. `GET`-style helpers exist as
`findNearestRoad` / `findNearbyRoads`.

## Performance

* No query scans a big table: `EXPLAIN` is part of `test/geoDatabase.test.js` (no sequential scan of `search_names`).
* Distances: geometry GiST finds the candidates (`geom && ST_Buffer(point::geography, r)::geometry`), exact geography
  distance only on those. Casting a column to geography in `WHERE` would skip the index and is never done.
* Statement timeout `DATABASE_STATEMENT_TIMEOUT_MS` (default 5 s) -> `503 GEO_QUERY_TIMEOUT`. Pool `DATABASE_POOL_MAX`.
* Rate limit per IP: `RATE_LIMIT_SEARCH_PER_MINUTE` (default 60), nearby `RATE_LIMIT_PLACES_PER_MINUTE` (30).
* Importing runs outside the server; the server holds no OSM data in memory.

## Production (Northflank)

What Northflank's own documentation says (read from
<https://northflank.com/docs/v1/application/databases-and-persistence/deploy-databases-on-northflank/deploy-postgresql-on-northflank>,
November 2026): the PostgreSQL addon (versions 12-18) offers PostGIS among its extensions and you install one with
`CREATE EXTENSION <name>;` on the addon; `SELECT pg_available_extensions();` lists them all. `pg_trgm` is not named on that
page: the first migration (`001_extensions.sql`) fails with a clear message if the addon refuses it. External access needs
**Deploy with TLS** and **Publicly accessible** switched on in the addon's networking settings (the external connection
strings then appear in its connection details); the alternative is `northflank forward` from the Northflank CLI for local access.

* **A database that already holds other data: use `DATABASE_SCHEMA=redoz`.** Every table of this layer (the four `osm_*`
  tables, osm2pgsql's own `osm2pgsql_properties` and slim helper tables, `search_*`, `redoz_*`, `schema_migrations`) is then
  created in the `redoz` schema, and the backend's connections use `search_path = redoz, public` (PostGIS and `pg_trgm` stay
  where they are). Nothing outside that schema is created, changed or dropped; without the setting everything goes to
  `public` and `db:import-osm` would replace same-named tables there (osm2pgsql's default `planet_osm_*` prefix included).
  Set the same value for `db:migrate`, `db:import-osm` and the running service; use it as `GEO_TEST_DATABASE_SCHEMA` for the tests.
* The Node service needs **`DATABASE_URL`** (and `DATABASE_SCHEMA` / `DATABASE_SSL` as above) as environment variables / secrets on Northflank (use the addon's
  private/internal connection string from the backend service). **Set `DATABASE_SSL=no-verify`**: the addon refuses unencrypted
  connections even from inside Northflank's network (`pg_hba.conf rejects connection ... no encryption`), and its certificate
  is not issued for the private host name. `DATABASE_SSL` is the only TLS setting: a `?sslmode=` in the connection string is ignored. The `.osm.pbf` is **never** in git or in the image.
* The database must be created UTF8 with a UTF-8 ctype (the addon's default database usually is; migration 001 checks it
  and refuses otherwise).
* Populate it from a machine that has the file and osm2pgsql, using the addon's **external** connection string (TLS on,
  `DATABASE_SSL=true` or `no-verify`): `npm run db:migrate && npm run db:import-osm`. The import writes
  `osm_places`, `osm_roads`, `osm_addresses`, `osm_admin_areas` (dropped and recreated), then the derived search tables. It
  needs temporary disk for the slim tables before `--drop` removes them: check the addon's storage before importing
  (`SELECT pg_size_pretty(pg_database_size(current_database()))` afterwards; the plan's storage limit is in the addon's
  settings). Alternatively import into a local PostGIS and move it with `pg_dump -Fc` / `pg_restore --no-owner`.
* **Small disk (e.g. a 6 GB addon with 3 GB used): do not import directly.** The import needs about +1.4 GB at its peak
  (osm2pgsql's slim tables) plus write-ahead log; the finished layer is only about 450 MB. Import into a temporary local
  PostGIS (same `DATABASE_SCHEMA`, `npm run db:migrate && npm run db:import-osm`), then copy the finished schema:
  `pg_dump -Fc -n redoz --no-owner --no-privileges -f redoz.dump`, and on the addon (through `northflank forward`, `PGSSLMODE=require`)
  `pg_restore --single-transaction --clean --if-exists --no-owner --no-privileges -d <db> redoz.dump`, then `ANALYZE` every
  `redoz` table (a dump carries no planner statistics). One transaction: a dropped tunnel rolls back to the previous state.
  Done once for Iraq (restore took 2 min; the database grew by about 450 MB). The restored tables are owned by the connecting
  user and carry no grants: a service that connects as another role needs `GRANT USAGE ON SCHEMA redoz` and `SELECT` on its tables.
* Run `npm run db:migrate` on every deploy (it is idempotent, e.g. as a release command); never `db:import-osm`.
* Check: `GET /api/search?q=...` answers; before the data exists it answers `503 GEO_DATA_NOT_READY`.

## Tests

`npm test` runs everything that needs no database (the HTTP layer with a stand-in repository, validation, Swagger coverage,
a guard that the geographic code contains no external provider). `test/geoDatabase.test.js` runs against a **real** imported
database and is skipped unless `GEO_TEST_DATABASE_URL` is set:

```bash
GEO_TEST_DATABASE_URL=postgresql://postgres:<password>@127.0.0.1:5432/redoz node --test test/geoDatabase.test.js
# with DATABASE_SCHEMA=redoz, also: GEO_TEST_DATABASE_SCHEMA=redoz (and GEO_TEST_DATABASE_SSL=no-verify for a TLS host)
```

## Limitations

* The first import's category / admin-level mapping reflects what Iraq's OSM data contains; check
  `SELECT admin_level, count(*) FROM osm_admin_areas GROUP BY 1` after importing another country.
* Kurdish category words in `005_category_terms.sql` should be reviewed by a Kurdish speaker.
* House numbers are only as good as OSM's `addr:*` coverage, which is thin in Iraq.
* No incremental updates: a new extract is imported whole (minutes, not hours, for a country).
* Redoz places have no admin screen yet: insert into `redoz_places` (SQL) and they are searchable at once.
