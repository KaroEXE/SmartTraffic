# syntax=docker/dockerfile:1
#
# Your own routing server (OSRM) for POST /api/v1/routes, so routes no longer need Geoapify.
# Build context: this folder (backend/routing). It is a SEPARATE Northflank service from the backend:
# the backend then gets ROUTING_OSRM_URL=http://<this service's internal host>:5000 and stops calling Geoapify.
# Guide: docs/DEPLOYMENT.md ("Own routing server").
#
# Commands and image come from OSRM's own README (Quick Start, MLD pipeline): osrm-extract with the car
# profile (/opt/car.lua in the image), osrm-partition, osrm-customize, then osrm-routed --algorithm mld.
# The road data is downloaded while the image is built and baked in, so the running service needs no disk
# and no download. To refresh the roads, rebuild the image.
ARG OSRM_TAG=v26.11.0-debian

FROM ghcr.io/project-osrm/osrm-backend:${OSRM_TAG} AS build
# Geofabrik's Iraq extract (OpenStreetMap, ODbL). Pass --build-arg OSM_URL=... to use another file.
ARG OSM_URL=https://download.geofabrik.de/asia/iraq-latest.osm.pbf
ADD ${OSM_URL} /data/iraq.osm.pbf
RUN osrm-extract -p /opt/car.lua /data/iraq.osm.pbf \
 && osrm-partition /data/iraq.osrm \
 && osrm-customize /data/iraq.osrm \
 && rm /data/iraq.osm.pbf

FROM ghcr.io/project-osrm/osrm-backend:${OSRM_TAG}
COPY --from=build /data /data
EXPOSE 5000
CMD ["osrm-routed", "--algorithm", "mld", "--ip", "0.0.0.0", "--port", "5000", "/data/iraq.osrm"]
