/**
 * Local stand-in for the Google Routes API, used only by tests
 * (GOOGLE_ROUTES_ENDPOINT=http://127.0.0.1:PORT/computeRoutes, GOOGLE_MAPS_API_KEY=test).
 * Deterministic distance = straight-line * 1.3 (a mock, not a product rule).
 *   GET  /__calls         -> { calls }
 *   POST /__mode {mode}   -> "ok" | "fail"
 */
import http from "node:http";
import { pathToFileURL } from "node:url";
import { encodePolyline, haversineKm } from "../src/services/routeCodec.js";

export function startMockRoutes(port = 0) {
  const state = { calls: 0, mode: "ok" };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/__calls") return res.end(JSON.stringify({ calls: state.calls }));
      if (req.url === "/__mode") { state.mode = JSON.parse(body).mode; return res.end("{}"); }
      state.calls++;
      if (state.mode === "fail") { res.statusCode = 503; return res.end("{}"); }
      const j = JSON.parse(body);
      const a = { lat: j.origin.location.latLng.latitude, lng: j.origin.location.latLng.longitude };
      const b = { lat: j.destination.location.latLng.latitude, lng: j.destination.location.latLng.longitude };
      const pts = Array.from({ length: 41 }, (_, i) => ({ lat: a.lat + (b.lat - a.lat) * i / 40, lng: a.lng + (b.lng - a.lng) * i / 40 }));
      const meters = Math.round(haversineKm(a, b) * 1.3 * 1000);
      res.end(JSON.stringify({ routes: [{ distanceMeters: meters, duration: `${Math.round(meters / 16)}s`, polyline: { encodedPolyline: encodePolyline(pts) } }] }));
    });
  });
  return new Promise(resolve => server.listen(port, "127.0.0.1", () => resolve({ server, state, port: server.address().port })));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { port } = await startMockRoutes(Number(process.env.MOCK_ROUTES_PORT || 4099));
  console.log(`mock routes on ${port}`);
}
