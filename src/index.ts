import express from "express";
import cors from "cors";
import "dotenv/config";

const app = express();

// Allow your Vite dev origin
app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "book-hive-server",
    time: new Date().toISOString(),
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ API running at http://localhost:${PORT}`);
});
