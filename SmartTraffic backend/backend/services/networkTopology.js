const { DIRECTIONS } = require('../utils/validation');

/**
 * Road network model shared by the network coordinator, the emergency
 * corridor planner, the network traffic simulation and the dashboard.
 *
 * Intersections sit on a street grid (`grid: { col, row }` in
 * config/intersections.js and config/simulationIntersections.js; row 0 is
 * the northern row, col 0 the western column). Two intersections in
 * neighbouring cells are joined by a two-way road; a road from a cell with no
 * managed neighbour leaves the managed network. The 3D scene draws the same
 * grid, so every link drawn there is a road the decision logic uses.
 *
 * This is a CONFIGURED schematic of the road network, not surveyed road
 * data: link lengths and capacities come from settings.
 *
 * Direction conventions (the same as the decision engine):
 *   approach `north` = vehicles arriving FROM the north, travelling south.
 *   A vehicle served on approach `a` at X travels heading OPPOSITE[a] and
 *   reaches the neighbour of X in that heading, entering it on approach `a`.
 *   Only through movements are modelled (no turning movements).
 */

const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };
const STEP = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };

const DEFAULTS = {
  LINK_LENGTH_M: 200, // matches the 3D scene's junction spacing
  LINK_CAPACITY_VEHICLES: 40, // storage of one directed link (2 lanes)
};

function hasGrid(i) {
  return i && i.grid && Number.isInteger(i.grid.col) && Number.isInteger(i.grid.row) && i.grid.col >= 0 && i.grid.row >= 0;
}

/**
 * @param {{ id: string, name?: string, grid?: { col, row } }[]} intersections
 * @param {object} settings  config.network (optional)
 */
function buildTopology(intersections, settings = {}) {
  const linkLengthM = settings.LINK_LENGTH_M || DEFAULTS.LINK_LENGTH_M;
  const capacity = settings.LINK_CAPACITY_VEHICLES || DEFAULTS.LINK_CAPACITY_VEHICLES;

  const nodes = [];
  const byCell = new Map();
  for (const ix of intersections) {
    const node = { id: ix.id, name: ix.name || ix.id, col: null, row: null };
    if (hasGrid(ix)) {
      const key = `${ix.grid.col},${ix.grid.row}`;
      if (byCell.has(key)) throw new Error(`Intersections "${byCell.get(key)}" and "${ix.id}" share grid cell ${key}`);
      byCell.set(key, ix.id);
      node.col = ix.grid.col;
      node.row = ix.grid.row;
    }
    nodes.push(node);
  }

  const neighbors = {};
  const links = [];
  for (const node of nodes) {
    neighbors[node.id] = Object.fromEntries(DIRECTIONS.map((d) => [d, null]));
    if (node.col === null) continue;
    for (const heading of DIRECTIONS) {
      const [dc, dr] = STEP[heading];
      const other = byCell.get(`${node.col + dc},${node.row + dr}`);
      if (!other) continue;
      neighbors[node.id][heading] = other;
      links.push({
        id: `${node.id}>${other}`,
        from: node.id,
        to: other,
        heading, // travel direction
        // Vehicles on this link are served at `from` on approach OPPOSITE[heading]
        // and queue at `to` on approach OPPOSITE[heading] (they arrive from that side).
        approach: OPPOSITE[heading],
        lengthM: linkLengthM,
        capacity,
      });
    }
  }
  const linkById = new Map(links.map((l) => [l.id, l]));

  return {
    nodes,
    neighbors,
    links,
    linkLengthM,
    capacity,
    has(id) { return Object.prototype.hasOwnProperty.call(neighbors, id); },

    /** Where vehicles served on `approach` at `id` go: { to, approach, link } or null (they leave the network). */
    downstreamOf(id, approach) {
      const heading = OPPOSITE[approach];
      const to = neighbors[id] && neighbors[id][heading];
      return to ? { to, approach, link: linkById.get(`${id}>${to}`) } : null;
    },

    /** Where vehicles queued on `approach` at `id` come from: { from, approach, link } or null (from outside). */
    upstreamOf(id, approach) {
      const from = neighbors[id] && neighbors[id][approach];
      return from ? { from, approach, link: linkById.get(`${from}>${id}`) } : null;
    },

    /** Heading from `a` to its neighbour `b`, or null when they are not adjacent. */
    headingBetween(a, b) {
      const n = neighbors[a];
      if (!n) return null;
      return DIRECTIONS.find((d) => n[d] === b) || null;
    },

    /** Public description for the dashboard (ids, grid cells, directed links). */
    toJSON() {
      return {
        nodes: nodes.map((n) => ({ ...n })),
        links: links.map((l) => ({ ...l })),
        linkLengthM,
        capacity,
        schematic: true,
      };
    },
  };
}

module.exports = { buildTopology, OPPOSITE, DEFAULTS };
