import express from "express";
import cors from "cors";
import "dotenv/config";
import cookieParser from "cookie-parser";

import authRouter from "./routes/auth";
import usersRouter from "./routes/users";
import supportRouter from "./routes/support";

const app = express();

// CORS (allow credentials for cookie-based session)
const origin = process.env.CLIENT_ORIGIN || "http://localhost:5173";
app.use(
  cors({
    origin,
    credentials: true,
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
      .json({ ok: false, message: err.message || "Server error" });
  }
);

const PORT = Number(process.env.PORT || 5000);
app.listen(PORT, () => {
  console.log(`✅ API running at http://localhost:${PORT}`);
});
