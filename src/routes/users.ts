import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../db";
import multer from "multer";
import { uploadImageToS3 } from "../s3";

const router = express.Router();

type Role = "student" | "librarian" | "faculty" | "admin" | "other";

/** Minimal DB row for users list + role resolution */
type UserRow = {
  id: string;
  email: string;
  full_name: string;
  account_type: Role;

  // ✅ Avatar
  avatar_url: string | null;

  // ✅ student fields (for /me update + response)
  student_id?: string | null;
  course?: string | null;
  year_level?: string | null;

  // ✅ email verified (for /me response)
  is_email_verified?: boolean;

  /** legacy column if still present in your schema */
  role?: Role | null;

  /** optional timestamps */
  created_at?: string;
  updated_at?: string;
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
function computeEffectiveRoleFromRow(
  row: Pick<UserRow, "account_type" | "role">
): Role {
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
        `SELECT id, email, full_name, account_type, role, avatar_url
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
        return res
          .status(403)
          .json({ ok: false, message: "Forbidden: insufficient role." });
      }
      // keep effective role in request context
      (req as any).sessionUser = { ...s, role: effective };
      next();
    } catch (err) {
      next(err);
    }
  };
}

/* ---------------- helpers ---------------- */

function cleanOptionalText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function toMeDTO(row: UserRow) {
  const accountType = computeEffectiveRoleFromRow(row);
  return {
    id: String(row.id),
    email: row.email,
    fullName: row.full_name,
    accountType,
    isEmailVerified: Boolean(row.is_email_verified),
    studentId: row.student_id ?? null,
    course: row.course ?? null,
    yearLevel: row.year_level ?? null,
    avatarUrl: row.avatar_url ?? null,
  };
}

async function fetchMeRow(userId: string) {
  return await query<UserRow>(
    `SELECT id, email, full_name, account_type, role,
            student_id, course, year_level,
            is_email_verified,
            avatar_url
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [userId]
  );
}

/* ---------------- Avatar upload (multer) ---------------- */

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    if (/^image\//i.test(file.mimetype)) return cb(null, true);
    cb(new Error("Only image uploads are allowed."));
  },
});

/* ---------------- Routes ---------------- */

/**
 * PATCH /api/users/me
 * Update personal info for the current user.
 * Body: { fullName?, course?, yearLevel? }
 *
 * Notes:
 * - Email is not editable here.
 * - studentId is NOT editable here (safer due to uniqueness + audit).
 */
router.patch("/me", requireAuth, async (req, res, next) => {
  try {
    const s = (req as any).sessionUser as SessionPayload;

    const current = await fetchMeRow(s.sub);
    if (!current.rowCount) {
      return res.status(401).json({ ok: false, message: "Not authenticated." });
    }

    const row = current.rows[0];
    const effectiveRole = computeEffectiveRoleFromRow(row);

    const fullNameRaw = req.body?.fullName;
    const courseRaw = req.body?.course;
    const yearLevelRaw = req.body?.yearLevel;

    const updates: string[] = [];
    const values: any[] = [];
    let i = 1;

    if (fullNameRaw !== undefined) {
      const fullName = String(fullNameRaw || "").trim();
      if (!fullName) {
        return res.status(400).json({ ok: false, message: "fullName cannot be empty." });
      }
      updates.push(`full_name = $${i++}`);
      values.push(fullName);
    }

    if (courseRaw !== undefined) {
      const course = cleanOptionalText(courseRaw);
      if (effectiveRole === "student" && !course) {
        return res.status(400).json({ ok: false, message: "course is required for students." });
      }
      updates.push(`course = $${i++}`);
      values.push(course);
    }

    if (yearLevelRaw !== undefined) {
      const yearLevel = cleanOptionalText(yearLevelRaw);
      if (effectiveRole === "student" && !yearLevel) {
        return res
          .status(400)
          .json({ ok: false, message: "yearLevel is required for students." });
      }
      updates.push(`year_level = $${i++}`);
      values.push(yearLevel);
    }

    if (updates.length === 0) {
      return res.status(400).json({ ok: false, message: "No changes provided." });
    }

    updates.push(`updated_at = NOW()`);

    await query(
      `UPDATE users
       SET ${updates.join(", ")}
       WHERE id = $${i}`,
      [...values, Number(s.sub)]
    );

    const refreshed = await fetchMeRow(s.sub);
    const updated = refreshed.rows[0];

    return res.json({ ok: true, user: toMeDTO(updated) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/users/me/avatar
 * Upload a display picture (avatar) for the current user.
 * multipart/form-data field: "avatar"
 */
router.post(
  "/me/avatar",
  requireAuth,
  avatarUpload.single("avatar"),
  async (req, res, next) => {
    try {
      const s = (req as any).sessionUser as SessionPayload;

      if (!req.file) {
        return res.status(400).json({ ok: false, message: "Missing avatar file." });
      }

      // Upload to S3 (folder: avatars)
      const url = await uploadImageToS3({
        buffer: req.file.buffer,
        contentType: req.file.mimetype,
        folder: "avatars",
      });

      await query(
        `UPDATE users
         SET avatar_url = $1, updated_at = NOW()
         WHERE id = $2`,
        [url, Number(s.sub)]
      );

      const refreshed = await fetchMeRow(s.sub);
      if (!refreshed.rowCount) {
        return res.status(401).json({ ok: false, message: "Not authenticated." });
      }

      return res.json({ ok: true, user: toMeDTO(refreshed.rows[0]) });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * DELETE /api/users/me/avatar
 * Remove avatar (set to null)
 */
router.delete("/me/avatar", requireAuth, async (req, res, next) => {
  try {
    const s = (req as any).sessionUser as SessionPayload;

    await query(
      `UPDATE users
       SET avatar_url = NULL, updated_at = NOW()
       WHERE id = $1`,
      [Number(s.sub)]
    );

    const refreshed = await fetchMeRow(s.sub);
    if (!refreshed.rowCount) {
      return res.status(401).json({ ok: false, message: "Not authenticated." });
    }

    return res.json({ ok: true, user: toMeDTO(refreshed.rows[0]) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/users
 * Read-only list of users (librarian/admin).
 * Returns: { ok:true, users: Array<{ id, email, fullName, accountType, avatarUrl }> }
 */
router.get(
  "/",
  requireAuth,
  requireRole(["librarian", "admin"]),
  async (_req, res, next) => {
    try {
      const result = await query<UserRow>(
        `SELECT id, email, full_name, account_type, role, avatar_url
         FROM users
         ORDER BY created_at DESC, id DESC`
      );

      const users = result.rows.map((row) => ({
        id: String(row.id),
        email: row.email,
        fullName: row.full_name,
        accountType: computeEffectiveRoleFromRow(row),
        avatarUrl: row.avatar_url,
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
