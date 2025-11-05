import express from "express";
import { query } from "../db";

const router = express.Router();

// GET /api/users/check-student-id?studentId=...
router.get("/check-student-id", async (req, res, next) => {
  try {
    const studentId = String(req.query.studentId || "").trim();
    if (!studentId) return res.status(400).json({ available: false });

    const found = await query(
      `SELECT 1 FROM users WHERE student_id = $1 LIMIT 1`,
      [studentId]
    );
    res.json({ available: found.rowCount === 0 });
  } catch (err) {
    next(err);
  }
});

export default router;
