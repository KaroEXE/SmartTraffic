/**
 * Intersections of the Simulation tab (services/simulationService.js).
 *
 * Simulated only: none of these receive live data. The live channel uses
 * config/intersections.js. This is the list the dashboard simulator has
 * always used.
 */
module.exports = [
  { id: 'main',            name: 'Main Street',        lat: 35.5617, lng: 45.4329 },
  { id: 'university-road', name: 'University Road',    lat: 35.5702, lng: 45.4418 },
  { id: 'market-square',   name: 'Market Square',      lat: 35.5560, lng: 45.4385 },
  { id: 'hospital-junction', name: 'Hospital Junction', lat: 35.5655, lng: 45.4232 },
  { id: 'ring-road-north', name: 'Ring Road North',    lat: 35.5768, lng: 45.4305 },
];
