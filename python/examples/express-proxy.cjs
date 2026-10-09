// Add this router to your EXISTING Express application; do not start another AI.
// const { trafficProxy } = require("./express-proxy.cjs");
// app.use("/ai", trafficProxy);  // Mount before compression/static/catch-all routes.
const http = require("node:http");
const express = require("express");
const trafficProxy = express.Router();
const origin = new URL(process.env.TRAFFIC_AI_ORIGIN || "http://127.0.0.1:5000");
if (origin.protocol !== "http:") throw new Error("Configure the local Flask HTTP origin");

trafficProxy.get(/^\/(api\/(traffic|cameras|health)|video\/(north|south|west|east))$/, (req, res) => {
  const target = new URL(req.path, origin);
  const upstream = http.get(target, (response) => {
    res.status(response.statusCode || 502);
    res.set("Content-Type", response.headers["content-type"] || "application/json");
    res.set("Cache-Control", "no-store");
    res.set("X-Accel-Buffering", "no");
    response.on("error", () => res.destroy());
    response.pipe(res); // Stream MJPEG incrementally. Never collect the body.
  });
  upstream.setTimeout(15000, () => upstream.destroy(new Error("Upstream timeout")));
  upstream.on("error", () => {
    if (!res.headersSent) res.status(502).json({ error: "Traffic AI unavailable" });
    else res.destroy();
  });
  res.on("close", () => upstream.destroy());
});

module.exports = { trafficProxy };
