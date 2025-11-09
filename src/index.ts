import express from "express";
import cors from "cors";
import "dotenv/config";
import cookieParser from "cookie-parser";

import authRouter from "./routes/auth";
import usersRouter from "./routes/users";
import supportRouter from "./routes/support";
import booksRouter from "./routes/books";

const app = express();

const dev = process.env.NODE_ENV !== "production";

/** Normalize an origin for reliable comparisons (trim + drop trailing slashes) */
function normalizeOrigin(o?: string | null) {
  return (o ?? "").trim().replace(/\/+$/, "");
}

/**
 * Build the allow list.
 * - CLIENT_ORIGIN: single origin (optional, may include a trailing "/")
 * - CLIENT_ORIGINS: comma-separated list of origins (optional)
 * Always normalize everything so "https://x.com" === "https://x.com/".
 */
const primaryEnvOrigin = normalizeOrigin(process.env.CLIENT_ORIGIN);
const csvEnvOrigins = (process.env.CLIENT_ORIGINS || "")
  .split(",")
  .map((s) => normalizeOrigin(s))
  .filter(Boolean);

// Always include the common local dev origins
const allowList = new Set<string>(
  [
    ...csvEnvOrigins,
    primaryEnvOrigin,
    normalizeOrigin("http://localhost:5173"),
    normalizeOrigin("http://127.0.0.1:5173"),
  ].filter(Boolean)
);

app.use(
  cors({
    origin: (origin, cb) => {
      // Allow same-origin requests without an Origin header (e.g. curl)
      if (!origin) return cb(null, true);

      const incoming = normalizeOrigin(origin);

      // Exact allow-list match
      if (allowList.has(incoming)) return cb(null, true);

      // During local dev, allow any localhost:<port>
      if (dev && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(incoming)) {
        return cb(null, true);
      }

      return cb(new Error(`CORS blocked for origin ${incoming}`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());
app.use(cookieParser());

// Basic health
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "book-hive-server",
    time: new Date().toISOString(),
  });
});

// Routes
app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);
app.use("/api/support", supportRouter);
app.use("/api/books", booksRouter);

// 404
app.use((_req, res) => {
  res.status(404).json({ ok: false, message: "Not found" });
});

// Global error handler
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use(
  (
    err: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error("Unhandled error:", err);
    res
      .status(err.status || 500)
      .json({ ok: false, message: err?.message || "Server error" });
  }
);

const PORT = Number(process.env.PORT || 5000);
app.listen(PORT, () => {
  const origin = dev ? `http://localhost:${PORT}` : `:${PORT}`;
  console.log(`✅ API running at ${origin}`);
  console.log(`   CORS allowlist ->`, Array.from(allowList));
});
