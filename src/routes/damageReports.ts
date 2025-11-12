import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../db";
import multer from "multer";
import fs from "fs";
import path from "path";

const router = express.Router();

/* ---------------- Upload setup ---------------- */
const uploadRoot = path.join(process.cwd(), "uploads");
const damageDir = path.join(uploadRoot, "damage-reports");
fs.mkdirSync(damageDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, damageDir),
  filename: (_req, file, cb) => {
    const ts = Date.now();
    const safe = file.originalname.replace(/[^a-z0-9_.-]+/gi, "_");
    cb(null, `${ts}_${safe}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (_req, file, cb) => {
    if (/^image\//i.test(file.mimetype)) return cb(null, true);
    cb(new Error("Only image uploads are allowed."));
  },
});

/* ---------------- Types ---------------- */

type Role = "student" | "librarian" | "faculty" | "admin" | "other";
type DamageStatus = "pending" | "assessed" | "paid";
type Severity = "minor" | "moderate" | "major";

type SessionPayload = {
  sub: string;
  email: string;
  role: Role;
  ev: number;
};

type UserRoleRow = {
  id: string;
  account_type: Role;
  role?: Role | null;
};

type DamageRowJoined = {
  id: string;
  user_id: string;
  book_id: string;
  damage_type: string;
  severity: Severity;
  fee: string; // NUMERIC comes back as string in node-postgres
  status: DamageStatus;
  notes: string | null;
  reported_at: string;
  photo_url: string | null;

  // joined
  email: string | null;
  student_id: string | null;
  full_name: string | null;
  title: string | null;
};

/* ---------------- helpers (consistent with other routes) ---------------- */

function normalizeRole(raw: unknown): Role {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "student") return "student";
  if (v === "librarian") return "librarian";
  if (v === "faculty") return "faculty";
  if (v === "admin") return "admin";
  return "other";
}

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

function computeEffectiveRoleFromRow(row: UserRoleRow): Role {
  const primary = (row.account_type || "student") as Role;
  const legacy = (row.role as Role | null) || undefined;
  if (primary && primary !== "student") return primary;
  if (primary === "student" && legacy && legacy !== "student") return legacy;
  return primary || legacy || "student";
}

function requireRole(roles: Role[]) {
  return (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    const s = (req as any).sessionUser as SessionPayload | undefined;
    if (!s) {
      return res.status(401).json({ ok: false, message: "Not authenticated." });
    }
    query<UserRoleRow>(
      `SELECT id, account_type, role
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [s.sub]
    )
      .then((result) => {
        if (!result.rowCount) {
          return res
            .status(401)
            .json({ ok: false, message: "Not authenticated." });
        }
        const u = result.rows[0];
        const effectiveRole = computeEffectiveRoleFromRow(u);
        if (!roles.includes(effectiveRole)) {
          console.warn("[damage-reports] Forbidden", {
            userId: s.sub,
            tokenRole: s.role,
            effectiveRole,
            required: roles,
          });
          return res
            .status(403)
            .json({ ok: false, message: "Forbidden: insufficient role." });
        }
        (req as any).sessionUser = { ...s, role: effectiveRole };
        next();
      })
      .catch((err) => next(err));
  };
}

/* ---------------- mapping ---------------- */

function toDTO(row: DamageRowJoined) {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    studentEmail: row.email,
    studentId: row.student_id,
    studentName: row.full_name,
    bookId: String(row.book_id),
    bookTitle: row.title,
    damageType: row.damage_type,
    severity: row.severity,
    fee: Number(row.fee || 0),
    status: row.status,
    reportedAt: row.reported_at,
    notes: row.notes,
    photoUrl: row.photo_url, // relative like /uploads/damage-reports/xxxxx.jpg
  };
}

/* ---------------- routes ---------------- */

/**
 * GET /api/damage-reports
 * List all damage reports (librarian/admin).
 */
router.get(
  "/",
  requireAuth,
  requireRole(["librarian", "admin"]),
  async (_req, res, next) => {
    try {
      const result = await query<DamageRowJoined>(
        `SELECT dr.id, dr.user_id, dr.book_id, dr.damage_type, dr.severity, dr.fee, dr.status, dr.notes, dr.reported_at, dr.photo_url,
                u.email, u.student_id, u.full_name,
                b.title
         FROM damage_reports dr
         LEFT JOIN users u ON u.id = dr.user_id
         LEFT JOIN books b ON b.id = dr.book_id
         ORDER BY dr.reported_at DESC, dr.id DESC`
      );

      const reports = result.rows.map(toDTO);
      res.json({ ok: true, reports });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/damage-reports
 * Create a damage report – students (and staff) can submit.
 * Accepts multipart/form-data with optional "photo" file.
 * Fields: { bookId, damageType, severity ('minor'|'moderate'|'major'), fee?, notes? }
 * - status defaults to 'pending'
 */
router.post(
  "/",
  requireAuth,
  requireRole(["student", "librarian", "admin"]),
  upload.single("photo"),
  async (req, res, next) => {
    try {
      const s = (req as any).sessionUser as SessionPayload;
      const { bookId, damageType, severity, fee, notes } = req.body || {};

      const bid = Number(bookId);
      if (!bid || !Number.isFinite(bid)) {
        return res.status(400).json({ ok: false, message: "bookId is required." });
      }
      const dt = String(damageType || "").trim();
      if (!dt) {
        return res.status(400).json({ ok: false, message: "damageType is required." });
      }
      const sev = String(severity || "").toLowerCase();
      if (!["minor", "moderate", "major"].includes(sev)) {
        return res.status(400).json({ ok: false, message: "severity must be 'minor' | 'moderate' | 'major'." });
      }
      const feeNum = fee === undefined || fee === null ? 0 : Number(fee);
      if (!Number.isFinite(feeNum) || feeNum < 0) {
        return res.status(400).json({ ok: false, message: "fee must be a non-negative number." });
      }

      const fileRel =
        req.file ? `/uploads/damage-reports/${req.file.filename}` : null;

      // Ensure book exists
      const book = await query(`SELECT id FROM books WHERE id = $1 LIMIT 1`, [bid]);
      if (!book.rowCount) {
        return res.status(404).json({ ok: false, message: "Book not found." });
      }

      const ins = await query<DamageRowJoined>(
        `INSERT INTO damage_reports (user_id, book_id, damage_type, severity, fee, status, notes, photo_url)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
         RETURNING id, user_id, book_id, damage_type, severity, fee, status, notes, reported_at, photo_url,
                   NULL::text AS email, NULL::text AS student_id, NULL::text AS full_name, NULL::text AS title`,
        [Number(s.sub), bid, dt, sev, feeNum, notes ? String(notes).trim() : null, fileRel]
      );

      // Hydrate joins for DTO
      const joined = await query<DamageRowJoined>(
        `SELECT dr.id, dr.user_id, dr.book_id, dr.damage_type, dr.severity, dr.fee, dr.status, dr.notes, dr.reported_at, dr.photo_url,
                u.email, u.student_id, u.full_name,
                b.title
         FROM damage_reports dr
         LEFT JOIN users u ON u.id = dr.user_id
         LEFT JOIN books b ON b.id = dr.book_id
         WHERE dr.id = $1
         LIMIT 1`,
        [ins.rows[0].id]
      );

      const report = toDTO(joined.rows[0]);
      res.status(201).json({ ok: true, report });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /api/damage-reports/:id
 * Update fields – librarian/admin only.
 * Accepts JSON OR multipart/form-data (if replacing photo with "photo" file).
 * Body/Fields: { status?, severity?, fee?, notes?, damageType?, (photo?) }
 */
router.patch(
  "/:id",
  requireAuth,
  requireRole(["librarian", "admin"]),
  upload.single("photo"),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const rid = Number(id);
      if (!rid) {
        return res.status(400).json({ ok: false, message: "Invalid id." });
      }

      const { status, severity, fee, notes, damageType } = req.body || {};
      const newPhotoRel =
        req.file ? `/uploads/damage-reports/${req.file.filename}` : undefined;

      const updates: string[] = [];
      const values: any[] = [];
      let i = 1;

      if (status !== undefined) {
        const st = String(status).toLowerCase();
        if (!["pending", "assessed", "paid"].includes(st)) {
          return res.status(400).json({ ok: false, message: "Invalid status." });
        }
        updates.push(`status = $${i++}`);
        values.push(st);
      }

      if (severity !== undefined) {
        const sv = String(severity).toLowerCase();
        if (!["minor", "moderate", "major"].includes(sv)) {
          return res.status(400).json({ ok: false, message: "Invalid severity." });
        }
        updates.push(`severity = $${i++}`);
        values.push(sv);
      }

      if (fee !== undefined) {
        const f = Number(fee);
        if (!Number.isFinite(f) || f < 0) {
          return res.status(400).json({ ok: false, message: "fee must be a non-negative number." });
        }
        updates.push(`fee = $${i++}`);
        values.push(f);
      }

      if (notes !== undefined) {
        updates.push(`notes = $${i++}`);
        values.push(notes ? String(notes).trim() : null);
      }

      if (damageType !== undefined) {
        const dt = String(damageType || "").trim();
        if (!dt) {
          return res.status(400).json({ ok: false, message: "damageType cannot be empty." });
        }
        updates.push(`damage_type = $${i++}`);
        values.push(dt);
      }

      if (newPhotoRel !== undefined) {
        updates.push(`photo_url = $${i++}`);
        values.push(newPhotoRel);
      }

      if (updates.length === 0) {
        return res.status(400).json({ ok: false, message: "No changes provided." });
      }

      updates.push(`updated_at = NOW()`);

      const upd = await query<DamageRowJoined>(
        `UPDATE damage_reports
         SET ${updates.join(", ")}
         WHERE id = $${i}
         RETURNING id, user_id, book_id, damage_type, severity, fee, status, notes, reported_at, photo_url,
                   NULL::text AS email, NULL::text AS student_id, NULL::text AS full_name, NULL::text AS title`,
        [...values, rid]
      );

      if (!upd.rowCount) {
        return res.status(404).json({ ok: false, message: "Damage report not found." });
      }

      // Hydrate joins
      const joined = await query<DamageRowJoined>(
        `SELECT dr.id, dr.user_id, dr.book_id, dr.damage_type, dr.severity, dr.fee, dr.status, dr.notes, dr.reported_at, dr.photo_url,
                u.email, u.student_id, u.full_name,
                b.title
         FROM damage_reports dr
         LEFT JOIN users u ON u.id = dr.user_id
         LEFT JOIN books b ON b.id = dr.book_id
         WHERE dr.id = $1
         LIMIT 1`,
        [rid]
      );

      const report = toDTO(joined.rows[0]);
      res.json({ ok: true, report });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * DELETE /api/damage-reports/:id
 * Remove a report – librarian/admin only.
 */
router.delete(
  "/:id",
  requireAuth,
  requireRole(["librarian", "admin"]),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const rid = Number(id);
      if (!rid) {
        return res.status(400).json({ ok: false, message: "Invalid id." });
      }

      const del = await query(`DELETE FROM damage_reports WHERE id = $1`, [rid]);
      if (!del.rowCount) {
        return res.status(404).json({ ok: false, message: "Damage report not found." });
      }

      res.json({ ok: true, message: "Damage report deleted." });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
