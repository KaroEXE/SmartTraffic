-- osm2pgsql "flex" style for Redoz. Needs osm2pgsql >= 1.8 and --slim (the relations need their ways).
--
--   osm_places        points of interest and settlements (nodes, and the centre of areas)
--   osm_roads         every drivable / pedestrian-street way, with all routing tags kept (oneway,
--                     maxspeed, access, lanes, surface, junction, bridge, tunnel, ref ...)
--   osm_addresses     objects that carry an addr:* address (houses, buildings, entrances)
--   osm_admin_areas   administrative boundaries (country, governorate, district ...) as polygons
--
-- These four tables belong to osm2pgsql: every import (--create) drops and rebuilds them. Everything
-- derived from them (search_entities, search_names, admin_area_parts) is refilled by post-import.sql.
-- Run through `npm run db:import-osm`. Nothing here edits OpenStreetMap data.

local SRID = 4326

local places = osm2pgsql.define_table({
  name = 'osm_places',
  ids = { type = 'any', type_column = 'osm_type', id_column = 'osm_id' },
  columns = {
    { column = 'name', type = 'text' },
    { column = 'names', type = 'jsonb' },
    { column = 'class', type = 'text', not_null = true },    -- the OSM key: amenity, shop, place ...
    { column = 'type', type = 'text', not_null = true },     -- the OSM value: restaurant, mall, city ...
    { column = 'category', type = 'text', not_null = true }, -- Redoz category: hospital, shopping_mall, fuel ...
    { column = 'importance', type = 'real' },
    { column = 'address', type = 'jsonb' },
    { column = 'details', type = 'jsonb' },
    { column = 'tags', type = 'jsonb' },
    { column = 'geom', type = 'point', projection = SRID, not_null = true },
  },
  indexes = { { column = 'geom', method = 'gist' } },
})

local roads = osm2pgsql.define_table({
  name = 'osm_roads',
  ids = { type = 'way', id_column = 'osm_id' },
  columns = {
    { column = 'name', type = 'text' },
    { column = 'names', type = 'jsonb' },
    { column = 'highway', type = 'text', not_null = true },
    { column = 'ref', type = 'text' },
    { column = 'oneway', type = 'text' },
    { column = 'maxspeed', type = 'text' },
    { column = 'lanes', type = 'text' },
    { column = 'surface', type = 'text' },
    { column = 'junction', type = 'text' },
    { column = 'access', type = 'text' },
    { column = 'bridge', type = 'text' },
    { column = 'tunnel', type = 'text' },
    { column = 'tags', type = 'jsonb' },
    { column = 'geom', type = 'linestring', projection = SRID, not_null = true },
  },
  indexes = { { column = 'geom', method = 'gist' } },
})

local addresses = osm2pgsql.define_table({
  name = 'osm_addresses',
  ids = { type = 'any', type_column = 'osm_type', id_column = 'osm_id' },
  columns = {
    { column = 'housenumber', type = 'text' },
    { column = 'housename', type = 'text' },
    { column = 'street', type = 'text' },
    { column = 'suburb', type = 'text' },
    { column = 'city', type = 'text' },
    { column = 'postcode', type = 'text' },
    { column = 'address', type = 'jsonb' },
    { column = 'geom', type = 'point', projection = SRID, not_null = true },
  },
  indexes = { { column = 'geom', method = 'gist' } },
})

local admin_areas = osm2pgsql.define_table({
  name = 'osm_admin_areas',
  ids = { type = 'relation', id_column = 'osm_id' },
  columns = {
    { column = 'name', type = 'text' },
    { column = 'names', type = 'jsonb' },
    { column = 'admin_level', type = 'int', not_null = true },
    { column = 'tags', type = 'jsonb' },
    { column = 'geom', type = 'multipolygon', projection = SRID, not_null = true },
  },
  indexes = { { column = 'geom', method = 'gist' } },
})

-- ------------------------------------------------------------------ helpers

local NOISE_PREFIXES = { 'source', 'created_by', 'note', 'fixme', 'attribution', 'import', 'survey', 'check_date', 'tiger:', 'is_in' }
local function is_noise(key)
  for _, prefix in ipairs(NOISE_PREFIXES) do
    if key:sub(1, #prefix) == prefix then return true end
  end
  return false
end

local function clean_tags(tags)
  local out, any = {}, false
  for k, v in pairs(tags) do
    if not is_noise(k) then out[k] = v; any = true end
  end
  if any then return out end
  return nil
end

local NAME_BASES = { name = true, alt_name = true, int_name = true, old_name = true, official_name = true, short_name = true, loc_name = true }
local NAME_SKIP = { etymology = true, pronunciation = true, left = true, right = true, prefix = true, suffix = true, signed = true, source = true, script = true }

-- name, name:ar, name:ckb, alt_name, alt_name:en ... -> { key = value }, or nil when there is none
local function collect_names(tags)
  local names, any = {}, false
  for k, v in pairs(tags) do
    local base, lang = k:match('^([a-z_]+):([%w_%-]+)$')
    if k:find(':', 1, true) == nil then base, lang = k, nil end
    if base and NAME_BASES[base] and not (lang and NAME_SKIP[lang]) and v ~= '' then
      names[k] = v
      any = true
    end
  end
  if any then return names end
  return nil
end

local function primary_name(tags)
  return tags.name or tags['name:ckb'] or tags['name:ar'] or tags['name:ku'] or tags['name:en'] or tags.int_name
end

-- addr:* tags without the prefix, or nil
local function collect_address(tags)
  local out, any = {}, false
  for k, v in pairs(tags) do
    local key = k:match('^addr:(.+)$')
    if key and v ~= '' then out[key] = v; any = true end
  end
  if any then return out end
  return nil
end

local function collect_details(tags)
  local d = {
    brand = tags.brand,
    operator = tags.operator,
    opening_hours = tags.opening_hours,
    phone = tags.phone or tags['contact:phone'],
    website = tags.website or tags['contact:website'],
  }
  if d.brand or d.operator or d.opening_hours or d.phone or d.website then return d end
  return nil
end

-- ------------------------------------------------------- what is a place, and which category

-- amenity / shop / ... values that are street furniture or noise, never searched for
local IGNORED = {
  amenity = {
    bench = true, waste_basket = true, waste_disposal = true, bicycle_parking = true, motorcycle_parking = true,
    parking_space = true, parking_entrance = true, shelter = true, vending_machine = true, post_box = true,
    recycling = true, drinking_water = true, clock = true, bbq = true, telephone = true, give_box = true,
    lounger = true, loading_dock = true, grit_bin = true, hunting_stand = true, bicycle_repair_station = true,
    photo_booth = true, ticket_validator = true, parcel_locker = true, table = true, watering_place = true,
  },
  tourism = { information = true, picnic_site = true, camp_pitch = true },
  leisure = { pitch = true, picnic_table = true, slipway = true, fitness_station = true, track = true, firepit = true, bleachers = true },
  historic = { memorial = true, wayside_cross = true, wayside_shrine = true, boundary_stone = true },
  office = {},
  shop = { vacant = true, yes = true },
  healthcare = { yes = true },
  railway = {},
  aeroway = {},
  public_transport = {},
}

local KEY_ORDER = { 'amenity', 'shop', 'healthcare', 'tourism', 'leisure', 'office', 'historic', 'aeroway', 'railway', 'public_transport', 'place' }

local AMENITY_CATEGORY = {
  fast_food = 'restaurant', food_court = 'restaurant', kindergarten = 'school', college = 'university',
  townhall = 'government', courthouse = 'government', public_building = 'government',
  doctors = 'clinic', dentist = 'clinic', marketplace = 'market', bus_station = 'bus_station',
}
local SHOP_CATEGORY = {
  mall = 'shopping_mall', supermarket = 'market', convenience = 'market', department_store = 'shopping_mall',
  car_repair = 'car_repair', tyres = 'car_repair', car = 'car_dealer',
}
local TOURISM_CATEGORY = { hotel = 'hotel', motel = 'hotel', guest_house = 'hotel', hostel = 'hotel', apartment = 'hotel', resort = 'hotel' }
local LEISURE_CATEGORY = { park = 'park', garden = 'park', playground = 'playground' }
local HEALTHCARE_CATEGORY = { hospital = 'hospital', clinic = 'clinic', doctor = 'clinic', dentist = 'clinic', pharmacy = 'pharmacy' }
local PLACE_VALUES = {
  country = true, state = true, region = true, province = true, county = true, city = true, town = true,
  village = true, hamlet = true, suburb = true, quarter = true, neighbourhood = true, locality = true, island = true,
}

-- Unnamed objects are kept only for these categories (fuel stations and parking lots are searched
-- for by kind, not by name: the "nearby" feature).
local KEEP_UNNAMED = {
  fuel = true, charging_station = true, parking = true, hospital = true, pharmacy = true, police = true,
  restaurant = true, cafe = true, atm = true, bank = true, car_repair = true, hotel = true,
}

local function categorize(tags)
  for _, key in ipairs(KEY_ORDER) do
    local value = tags[key]
    if value and value ~= 'no' then
      if key == 'place' then
        if PLACE_VALUES[value] then return key, value, value end
      elseif not (IGNORED[key] and IGNORED[key][value]) then
        local category = value
        if key == 'amenity' then
          category = AMENITY_CATEGORY[value] or value
          if value == 'place_of_worship' then
            if tags.religion == 'muslim' then category = 'mosque'
            elseif tags.religion == 'christian' then category = 'church'
            else category = 'place_of_worship' end
          end
        elseif key == 'shop' then category = SHOP_CATEGORY[value] or value
        elseif key == 'tourism' then category = TOURISM_CATEGORY[value] or value
        elseif key == 'leisure' then category = LEISURE_CATEGORY[value] or value
        elseif key == 'healthcare' then category = HEALTHCARE_CATEGORY[value] or value
        elseif key == 'office' then category = (value == 'government') and 'government' or ('office_' .. value)
        elseif key == 'aeroway' then
          if value ~= 'aerodrome' and value ~= 'terminal' then category = nil
          else category = (value == 'aerodrome') and 'airport' or 'airport_terminal' end
        elseif key == 'railway' then
          if value ~= 'station' then category = nil else category = 'train_station' end
        elseif key == 'public_transport' then
          if value ~= 'station' then category = nil else category = 'transit_station' end
        end
        if category then return key, value, category end
      end
    end
  end
  return nil
end

local PLACE_IMPORTANCE = {
  country = 1.0, state = 0.9, region = 0.85, province = 0.85, county = 0.7, city = 0.9, town = 0.7, village = 0.5,
  suburb = 0.45, quarter = 0.4, neighbourhood = 0.4, hamlet = 0.3, locality = 0.2, island = 0.3,
}
local CATEGORY_IMPORTANCE = {
  airport = 0.8, hospital = 0.6, university = 0.55, shopping_mall = 0.6, government = 0.5, stadium = 0.5, mosque = 0.4,
  attraction = 0.5, museum = 0.5, park = 0.4, hotel = 0.4, train_station = 0.5, bus_station = 0.4,
}

local function importance_of(class, value, category, tags)
  local base
  if class == 'place' then base = PLACE_IMPORTANCE[value] or 0.3 else base = CATEGORY_IMPORTANCE[category] or 0.3 end
  if tags.wikidata or tags.wikipedia then base = base + 0.1 end
  if base > 1 then base = 1 end
  return base
end

-- Adds the object to osm_places when it is a place; `geom` is a function that makes its point.
local function add_place(object, geom_of)
  local tags = object.tags
  local class, value, category = categorize(tags)
  if not class then return end
  local name = primary_name(tags)
  if not name and not KEEP_UNNAMED[category] then return end
  local geom = geom_of()
  if not geom or geom:is_null() then return end
  places:insert({
    name = name,
    names = collect_names(tags),
    class = class,
    type = value,
    category = category,
    importance = importance_of(class, value, category, tags),
    address = collect_address(tags),
    details = collect_details(tags),
    tags = clean_tags(tags),
    geom = geom,
  })
end

local function add_address(object, geom_of)
  local tags = object.tags
  if not (tags['addr:housenumber'] or tags['addr:housename'] or tags['addr:street']) then return end
  local geom = geom_of()
  if not geom or geom:is_null() then return end
  addresses:insert({
    housenumber = tags['addr:housenumber'],
    housename = tags['addr:housename'],
    street = tags['addr:street'],
    suburb = tags['addr:suburb'] or tags['addr:district'],
    city = tags['addr:city'],
    postcode = tags['addr:postcode'],
    address = collect_address(tags),
    geom = geom,
  })
end

-- Roads: car, service and pedestrian streets plus tracks. Footpaths, steps, cycleways and the like
-- are left out (they are most of the ways in a country file and no part of a driving route).
local ROAD_CLASSES = {
  motorway = true, motorway_link = true, trunk = true, trunk_link = true, primary = true, primary_link = true,
  secondary = true, secondary_link = true, tertiary = true, tertiary_link = true, unclassified = true,
  residential = true, living_street = true, service = true, pedestrian = true, track = true, road = true,
  busway = true, escape = true,
}

local function add_road(object)
  local tags = object.tags
  local highway = tags.highway
  if not highway or not ROAD_CLASSES[highway] then return end
  if object.is_closed and tags.area == 'yes' then return end
  roads:insert({
    name = primary_name(tags),
    names = collect_names(tags),
    highway = highway,
    ref = tags.ref,
    oneway = tags.oneway,
    maxspeed = tags.maxspeed,
    lanes = tags.lanes,
    surface = tags.surface,
    junction = tags.junction,
    access = tags.access,
    bridge = tags.bridge,
    tunnel = tags.tunnel,
    tags = clean_tags(tags),
    geom = object:as_linestring(),
  })
end

-- ------------------------------------------------------------------ callbacks

function osm2pgsql.process_node(object)
  add_place(object, function() return object:as_point() end)
  add_address(object, function() return object:as_point() end)
end

function osm2pgsql.process_way(object)
  add_road(object)
  if object.is_closed then
    add_place(object, function() return object:as_polygon():centroid() end)
    add_address(object, function() return object:as_polygon():centroid() end)
  end
end

function osm2pgsql.process_relation(object)
  local tags = object.tags
  if tags.type == 'multipolygon' then
    add_place(object, function() return object:as_multipolygon():centroid() end)
    add_address(object, function() return object:as_multipolygon():centroid() end)
  end
  if tags.boundary == 'administrative' and tags.admin_level and (tags.type == 'boundary' or tags.type == 'multipolygon') then
    local level = tonumber(tags.admin_level)
    local name = primary_name(tags)
    if level and name then
      local geom = object:as_multipolygon()
      if not geom:is_null() then
        admin_areas:insert({
          name = name,
          names = collect_names(tags),
          admin_level = level,
          tags = clean_tags(tags),
          geom = geom,
        })
      end
    end
  end
end
