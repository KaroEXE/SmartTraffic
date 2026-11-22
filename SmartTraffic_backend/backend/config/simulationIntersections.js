/**
 * Intersections of the Simulation tab (services/simulationService.js).
 *
 * Simulated only: none of these receive live data. The live channel uses
 * config/intersections.js. The same five junctions as the live network on
 * the same street grid, plus Stadium Road, which completes the 3 x 2 grid so
 * the simulated network has two straight three-junction corridors (rows).
 * Positions are simulated.
 */
module.exports = [
  { id: 'main',            name: 'Main Street',        lat: 35.5617, lng: 45.4329, grid: { col: 0, row: 1 } },
  { id: 'university-road', name: 'University Road',    lat: 35.5702, lng: 45.4418, grid: { col: 2, row: 0 } },
  { id: 'market-square',   name: 'Market Square',      lat: 35.5560, lng: 45.4385, grid: { col: 1, row: 1 } },
  { id: 'hospital-junction', name: 'Hospital Junction', lat: 35.5655, lng: 45.4232, grid: { col: 0, row: 0 } },
  { id: 'ring-road-north', name: 'Ring Road North',    lat: 35.5768, lng: 45.4305, grid: { col: 1, row: 0 } },
  { id: 'stadium-road',    name: 'Stadium Road',       lat: 35.5598, lng: 45.4466, grid: { col: 2, row: 1 } },
];
