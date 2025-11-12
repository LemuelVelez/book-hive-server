import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../db";

const router = express.Router();

type Role = "student" | "librarian" | "faculty" | "admin" | "other";

/** Minimal DB row for users list + role resolution */
type UserRow = {
  id: string;
  email: string;
  full_name: string;
  account_type: Role;
  /** legacy column if still present in your schema */
  role?: Role | null;
  /** optional timestamps, not required for mapping */
  created_at?: string;
};

type SessionPayload = {
  sub: string;
  email: string;
  role: Role;
  ev: number; // email verified flag (0/1)
};

/* ---------------- Role helpers (mirror logic used elsewhere) ---------------- */

function normalizeRole(raw: unknown): Role {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "student") return "student";
  if (v === "librarian") return "librarian";
  if (v === "faculty") return "faculty";
  if (v === "admin") return "admin";
  return "other";
}

/**
 * Compute the effective role:
 * - Prefer account_type if it’s non-student.
 * - If account_type is student but legacy role is non-student, use legacy role.
 * - Otherwise fall back to account_type (or student).
 */
function computeEffectiveRoleFromRow(row: Pick<UserRow, "account_type" | "role">): Role {
  const primary = (row.account_type || "student") as Role;
  const legacy = (row.role as Role | null) || undefined;
  if (primary && primary !== "student") return primary;
  if (primary === "student" && legacy && legacy !== "student") return legacy;
  return primary || legacy || "student";
}

/* ---------------- Session / guards ---------------- */

function readSession(req: express.Request): SessionPayload | null {
  const token = (req.cookies as any)?.["bh_session"];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as any;
    return {
      sub: String(payload.sub),
      email: String(payload.email),
      role: normalizeRole(payload.role),
      ev: Number(payload.ev) || 0,
    };
  } catch {
    return null;
  }
}

function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const s = readSession(req);
  if (!s) {
    return res.status(401).json({ ok: false, message: "Not authenticated." });
  }
  (req as any).sessionUser = s;
  next();
}

/**
 * Re-check the user's current role from the DB each request (don’t fully trust JWT).
 */
function requireRole(roles: Role[]) {
  return async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    const s = (req as any).sessionUser as SessionPayload | undefined;
    if (!s) {
      return res.status(401).json({ ok: false, message: "Not authenticated." });
    }
    try {
      const r = await query<UserRow>(
        `SELECT id, email, full_name, account_type, role
         FROM users
         WHERE id = $1
         LIMIT 1`,
        [s.sub]
      );
      if (!r.rowCount) {
        return res.status(401).json({ ok: false, message: "Not authenticated." });
      }
      const effective = computeEffectiveRoleFromRow(r.rows[0]);
      if (!roles.includes(effective)) {
        return res.status(403).json({ ok: false, message: "Forbidden: insufficient role." });
      }
      // keep effective role in request context
      (req as any).sessionUser = { ...s, role: effective };
      next();
    } catch (err) {
      next(err);
    }
  };
}

/* ---------------- Routes ---------------- */

/**
 * GET /api/users
 * Read-only list of users (librarian/admin).
 * Returns: { ok:true, users: Array<{ id, email, fullName, accountType }> }
 */
router.get(
  "/",
  requireAuth,
  requireRole(["librarian", "admin"]),
  async (_req, res, next) => {
    try {
      const result = await query<UserRow>(
        `SELECT id, email, full_name, account_type, role
         FROM users
         ORDER BY created_at DESC, id DESC`
      );

      const users = result.rows.map((row) => ({
        id: String(row.id),
        email: row.email,
        fullName: row.full_name,
        accountType: computeEffectiveRoleFromRow(row), // normalized role
      }));

      res.json({ ok: true, users });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/users/check-student-id?studentId=...
 * (existing endpoint kept as-is)
 */
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
