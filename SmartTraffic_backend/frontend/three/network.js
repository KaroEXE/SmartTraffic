/**
 * Road-network layout for the 3D scene (no THREE, unit-tested).
 *
 * The intersections of the active data mode are placed on a regular street
 * grid, one per junction. Nothing about the layout is hard-coded: it is
 * derived from the list the backend serves (id, name, lat, lng), so a new
 * intersection in the backend's list appears in the scene without code
 * changes.
 *
 *   - Order follows geography: intersections with coordinates fill rows
 *     northern row first (-z), west to east within a row (+x), so the 3D
 *     network reads like the 2D map. Any without coordinates follow in
 *     list order.
 *   - The grid is at least 2 x 2 so the selected intersection always sits
 *     in a street network. Junctions without a managed intersection are
 *     drawn as plain, unsignalised crossings: the scene never shows signals
 *     for an intersection the backend does not report.
 *   - `spacing` is the distance between neighbouring junction centres.
 *     With spacing = 2 x leg length the legs of neighbours meet exactly
 *     half-way, so roads, markings and kerbs join without seams.
 */

const MIN_COLS = 2;
const MIN_ROWS = 2;

const hasCoords = (i) => Number.isFinite(i.lat) && Number.isFinite(i.lng);

/**
 * @param {{ id: string, name?: string, lat?: number, lng?: number }[]} intersections
 * @param {{ spacing: number }} options
 * @returns {{
 *   spacing: number, cols: number, rows: number,
 *   slots: { col: number, row: number, x: number, z: number, id: string | null, name: string | null }[],
 *   sites: { id: string, name: string, col: number, row: number, x: number, z: number }[],
 *   bounds: { minX: number, maxX: number, minZ: number, maxZ: number },
 * }}
 */
export function layoutNetwork(intersections, { spacing }) {
  if (!(spacing > 0)) throw new Error('spacing must be a positive number');
  const seen = new Set();
  const list = [];
  for (const i of intersections || []) {
    if (!i || typeof i.id !== 'string' || !i.id || seen.has(i.id)) continue;
    seen.add(i.id);
    list.push(i);
  }

  const n = list.length;

  // Configured street grid (the backend's network topology): every
  // intersection sits on its own cell, exactly as the network coordinator
  // and emergency corridor see it.
  const hasGrid = (i) => i.grid && Number.isInteger(i.grid.col) && Number.isInteger(i.grid.row) && i.grid.col >= 0 && i.grid.row >= 0;
  if (n && list.every(hasGrid) && new Set(list.map((i) => `${i.grid.col},${i.grid.row}`)).size === n) {
    return gridLayout(list, spacing);
  }

  const cols = Math.max(MIN_COLS, Math.ceil(Math.sqrt(n)));
  const rows = Math.max(MIN_ROWS, Math.ceil(n / cols));

  // Rows of `cols` intersections, north to south; each row west to east.
  // Intersections without coordinates follow, in list order.
  const byLat = list.filter(hasCoords).sort((a, b) => b.lat - a.lat || a.lng - b.lng || a.id.localeCompare(b.id));
  const ordered = [];
  for (let r = 0; r < byLat.length; r += cols) {
    ordered.push(...byLat.slice(r, r + cols).sort((a, b) => a.lng - b.lng || a.id.localeCompare(b.id)));
  }
  ordered.push(...list.filter((i) => !hasCoords(i)));

  const x0 = -((cols - 1) * spacing) / 2;
  const z0 = -((rows - 1) * spacing) / 2;
  const slots = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const ix = ordered[row * cols + col] || null;
      slots.push({
        col,
        row,
        x: x0 + col * spacing,
        z: z0 + row * spacing,
        id: ix ? ix.id : null,
        name: ix ? (ix.name || ix.id) : null,
      });
    }
  }

  return finish(slots, cols, rows, spacing, x0, z0);
}

/** Layout from explicit grid cells (config `grid: { col, row }`). */
function gridLayout(list, spacing) {
  const cols = Math.max(MIN_COLS, ...list.map((i) => i.grid.col + 1));
  const rows = Math.max(MIN_ROWS, ...list.map((i) => i.grid.row + 1));
  const byCell = new Map(list.map((i) => [`${i.grid.col},${i.grid.row}`, i]));
  const x0 = -((cols - 1) * spacing) / 2;
  const z0 = -((rows - 1) * spacing) / 2;
  const slots = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const ix = byCell.get(`${col},${row}`) || null;
      slots.push({
        col, row, x: x0 + col * spacing, z: z0 + row * spacing, id: ix ? ix.id : null, name: ix ? (ix.name || ix.id) : null,
      });
    }
  }
  return finish(slots, cols, rows, spacing, x0, z0);
}

function finish(slots, cols, rows, spacing, x0, z0) {
  const sites = slots.filter((s) => s.id).map(({ id, name, col, row, x, z }) => ({ id, name, col, row, x, z }));
  return {
    spacing,
    cols,
    rows,
    slots,
    sites,
    bounds: { minX: x0, maxX: x0 + (cols - 1) * spacing, minZ: z0, maxZ: z0 + (rows - 1) * spacing },
  };
}
