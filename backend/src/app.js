import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth.js";
import tripRoutes from "./routes/trips.js";
import loadRoutes from "./routes/loads.js";
import bookingRoutes from "./routes/bookings.js";
import fleetRoutes from "./routes/fleet.js";

export const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api/trips", tripRoutes);
app.use("/api/loads", loadRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api", fleetRoutes); // GET /api/trucks, GET /api/drivers

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error." });
});
