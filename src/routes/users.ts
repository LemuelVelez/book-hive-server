import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../db";
import multer from "multer";
import { uploadImageToS3 } from "../s3";
import * as bcrypt from "bcryptjs";
import crypto from "crypto";
import { sendMail } from "../email";

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

  // ✅ NEW: approval
  is_approved?: boolean;
  approved_at?: string | null;
  approved_by?: string | null;

  /** legacy column if still present in your schema */
  role?: Role | null;

  /** optional timestamps */
  created_at?: string;
  updated_at?: string;
};

type UserAuthRow = {
  id: string;
  email: string;
  full_name: string;
  password_hash: string;
  account_type: Role;
  role?: Role | null;
  student_id?: string | null;
  course?: string | null;
  year_level?: string | null;
  is_email_verified?: boolean;
  avatar_url?: string | null;

  // ✅ NEW: approval
  is_approved?: boolean;
  approved_at?: string | null;
  approved_by?: string | null;
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

function isExemptFromApproval(role: Role) {
  return role === "librarian" || role === "admin";
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
        return res
          .status(401)
          .json({ ok: false, message: "Not authenticated." });
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

function isValidEmail(email: string) {
  const s = String(email || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function escapeHtml(input: string) {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function invalidateEmailVerificationTokens(userId: string) {
  // Mark all unused tokens used so only the newest can be used.
  await query(
    `UPDATE email_verifications
     SET used = TRUE
     WHERE user_id = $1 AND used = FALSE`,
    [userId]
  );
}

async function createAndSendVerifyEmail(
  userId: string,
  email: string,
  fullName?: string
) {
  // Invalidate existing unused tokens first
  await invalidateEmailVerificationTokens(userId);

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

  await query(
    `INSERT INTO email_verifications (user_id, token, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, token, expiresAt]
  );

  const client = (process.env.CLIENT_ORIGIN || "http://localhost:5173")
    .toString()
    .replace(/\/+$/, "");

  const confirmUrl = `${client}/auth/verify-email/callback?token=${encodeURIComponent(
    token
  )}`;

  const safeName =
    fullName && fullName.trim().length > 0
      ? escapeHtml(fullName.trim())
      : "there";

  const html = `
    <p>Hi ${safeName},</p>
    <p>Please verify your email for <strong>JRMSU-TC Book-Hive</strong> by clicking the link below:</p>
    <p><a href="${confirmUrl}">${confirmUrl}</a></p>
    <hr/>
    <p>If you didn’t request this, please ignore this message.</p>
  `;

  await sendMail({
    to: email,
    subject: "Verify your email • JRMSU-TC Book-Hive",
    html,
  });
}

function toMeDTO(row: UserRow) {
  const accountType = computeEffectiveRoleFromRow(row);
  return {
    id: String(row.id),
    email: row.email,
    fullName: row.full_name,
    accountType,
    isEmailVerified: Boolean(row.is_email_verified),

    // ✅ NEW
    isApproved: Boolean(row.is_approved),
    approvedAt: row.approved_at ?? null,

    studentId: row.student_id ?? null,
    course: row.course ?? null,
    yearLevel: row.year_level ?? null,
    avatarUrl: row.avatar_url ?? null,
  };
}

function toUserListDTO(row: UserRow) {
  const accountType = computeEffectiveRoleFromRow(row);
  return {
    id: String(row.id),
    email: row.email,
    fullName: row.full_name,
    accountType,
    avatarUrl: row.avatar_url ?? null,

    // ✅ NEW
    isApproved: Boolean(row.is_approved),
    approvedAt: row.approved_at ?? null,
    createdAt: row.created_at ?? null,
  };
}

async function fetchMeRow(userId: string) {
  return await query<UserRow>(
    `SELECT id, email, full_name, account_type, role,
            student_id, course, year_level,
            is_email_verified,
            avatar_url,
            is_approved, approved_at, approved_by
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [userId]
  );
}

async function fetchMeAuthRow(userId: string) {
  return await query<UserAuthRow>(
    `SELECT id, email, full_name, password_hash, account_type, role,
            student_id, course, year_level,
            is_email_verified,
            avatar_url,
            is_approved, approved_at, approved_by
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
 * Body: { fullName?, email?, course?, yearLevel? }
 *
 * IMPORTANT CHANGE:
 * ✅ We NO LONGER auto-send verification email here (prevents duplicates).
 * ✅ We only mark email unverified + invalidate old tokens.
 * Verification email is now MANUAL via POST /api/users/me/verify-email.
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
    const emailRaw = req.body?.email;
    const courseRaw = req.body?.course;
    const yearLevelRaw = req.body?.yearLevel;

    const updates: string[] = [];
    const values: any[] = [];
    let i = 1;

    let emailChanged = false;

    if (fullNameRaw !== undefined) {
      const fullName = String(fullNameRaw || "").trim();
      if (!fullName) {
        return res
          .status(400)
          .json({ ok: false, message: "fullName cannot be empty." });
      }
      updates.push(`full_name = $${i++}`);
      values.push(fullName);
    }

    if (emailRaw !== undefined) {
      const nextEmailRaw = String(emailRaw || "").trim();
      if (!nextEmailRaw) {
        return res
          .status(400)
          .json({ ok: false, message: "email cannot be empty." });
      }
      if (!isValidEmail(nextEmailRaw)) {
        return res
          .status(400)
          .json({ ok: false, message: "Invalid email address." });
      }

      const nextEmail = nextEmailRaw.toLowerCase();
      const currentEmail = String(row.email || "").trim().toLowerCase();

      if (nextEmail !== currentEmail) {
        const dupe = await query(
          `SELECT 1 FROM users WHERE email = $1 AND id <> $2 LIMIT 1`,
          [nextEmail, s.sub]
        );
        if (dupe.rowCount) {
          return res
            .status(409)
            .json({ ok: false, message: "Email already in use." });
        }

        emailChanged = true;
        updates.push(`email = $${i++}`);
        values.push(nextEmail);

        // mark unverified + clear verified timestamp
        updates.push(`is_email_verified = FALSE`);
        updates.push(`email_verified_at = NULL`);
      }
    }

    if (courseRaw !== undefined) {
      const course = cleanOptionalText(courseRaw);
      if (effectiveRole === "student" && !course) {
        return res
          .status(400)
          .json({ ok: false, message: "course is required for students." });
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
      return res
        .status(400)
        .json({ ok: false, message: "No changes provided." });
    }

    updates.push(`updated_at = NOW()`);

    await query(
      `UPDATE users
       SET ${updates.join(", ")}
       WHERE id = $${i}`,
      [...values, s.sub]
    );

    // If email changed: invalidate all old tokens (so only future sends are valid)
    if (emailChanged) {
      await invalidateEmailVerificationTokens(s.sub);
    }

    const refreshed = await fetchMeRow(s.sub);
    const updated = refreshed.rows[0];

    return res.json({ ok: true, user: toMeDTO(updated) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/users/me/verify-email
 * Manually send a verification email for the currently logged-in user.
 * (This prevents duplicate sends and avoids sending to arbitrary emails.)
 */
router.post("/me/verify-email", requireAuth, async (req, res, next) => {
  try {
    const s = (req as any).sessionUser as SessionPayload;

    const meRow = await fetchMeRow(s.sub);
    if (!meRow.rowCount) {
      return res.status(401).json({ ok: false, message: "Not authenticated." });
    }
    const user = meRow.rows[0];

    if (user.is_email_verified) {
      return res.json({ ok: true, message: "Email is already verified." });
    }

    await createAndSendVerifyEmail(user.id, user.email, user.full_name);

    return res.json({ ok: true, message: "Verification email sent." });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/users/me/password
 * Change password for the current user.
 * Body: { currentPassword, newPassword }
 */
router.patch("/me/password", requireAuth, async (req, res, next) => {
  try {
    const s = (req as any).sessionUser as SessionPayload;

    const currentPassword = String(req.body?.currentPassword ?? "");
    const newPassword = String(req.body?.newPassword ?? "");

    if (!currentPassword.trim()) {
      return res
        .status(400)
        .json({ ok: false, message: "Current password is required." });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({
        ok: false,
        message: "New password must be at least 8 characters.",
      });
    }

    const meRow = await fetchMeAuthRow(s.sub);
    if (!meRow.rowCount) {
      return res.status(401).json({ ok: false, message: "Not authenticated." });
    }

    const user = meRow.rows[0];
    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) {
      return res
        .status(401)
        .json({ ok: false, message: "Current password is incorrect." });
    }

    const hash = await bcrypt.hash(newPassword, 10);

    await query(
      `UPDATE users
       SET password_hash = $1, updated_at = NOW()
       WHERE id = $2`,
      [hash, s.sub]
    );

    return res.json({ ok: true, message: "Password updated." });
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
        return res
          .status(400)
          .json({ ok: false, message: "Missing avatar file." });
      }

      const url = await uploadImageToS3({
        buffer: req.file.buffer,
        contentType: req.file.mimetype,
        folder: "avatars",
      });

      await query(
        `UPDATE users
         SET avatar_url = $1, updated_at = NOW()
         WHERE id = $2`,
        [url, s.sub]
      );

      const refreshed = await fetchMeRow(s.sub);
      if (!refreshed.rowCount) {
        return res
          .status(401)
          .json({ ok: false, message: "Not authenticated." });
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
      [s.sub]
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
 * ✅ Includes approval info to manage pending accounts.
 */
router.get(
  "/",
  requireAuth,
  requireRole(["librarian", "admin"]),
  async (_req, res, next) => {
    try {
      const result = await query<UserRow>(
        `SELECT id, email, full_name, account_type, role, avatar_url,
                is_approved, approved_at, approved_by,
                created_at
         FROM users
         ORDER BY created_at DESC, id DESC`
      );

      const users = result.rows.map(toUserListDTO);

      res.json({ ok: true, users });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/users/pending
 * List users awaiting approval (librarian/admin).
 */
router.get(
  "/pending",
  requireAuth,
  requireRole(["librarian", "admin"]),
  async (_req, res, next) => {
    try {
      const result = await query<UserRow>(
        `SELECT id, email, full_name, account_type, role, avatar_url,
                is_approved, approved_at, approved_by,
                created_at
         FROM users
         WHERE is_approved = FALSE
         ORDER BY created_at DESC, id DESC`
      );

      const pending = result.rows
        .map((r) => {
          const eff = computeEffectiveRoleFromRow(r);
          // Don’t show exempt roles as "pending" even if data is weird
          if (isExemptFromApproval(eff)) return null;
          return toUserListDTO(r);
        })
        .filter(Boolean);

      res.json({ ok: true, users: pending });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /api/users/:id/approve
 * Approve a user so they can log in (librarian/admin).
 */
router.patch(
  "/:id/approve",
  requireAuth,
  requireRole(["librarian", "admin"]),
  async (req, res, next) => {
    try {
      const s = (req as any).sessionUser as SessionPayload;
      const targetId = String(req.params.id || "").trim();

      if (!/^\d+$/.test(targetId)) {
        return res.status(400).json({ ok: false, message: "Invalid user id." });
      }

      const found = await query<UserRow>(
        `SELECT id, email, full_name, account_type, role, is_approved
         FROM users
         WHERE id = $1
         LIMIT 1`,
        [targetId]
      );

      if (!found.rowCount) {
        return res.status(404).json({ ok: false, message: "User not found." });
      }

      const row = found.rows[0];
      const effRole = computeEffectiveRoleFromRow(row);

      if (isExemptFromApproval(effRole)) {
        return res.status(400).json({
          ok: false,
          message: "This user role is exempt from approval.",
        });
      }

      if (row.is_approved) {
        return res.json({ ok: true, message: "User is already approved." });
      }

      await query(
        `UPDATE users
         SET is_approved = TRUE,
             approved_at = NOW(),
             approved_by = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [s.sub, targetId]
      );

      return res.json({ ok: true, message: "User approved." });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /api/users/:id/disapprove
 * Disapprove a user (set to pending) so they cannot log in (librarian/admin).
 */
router.patch(
  "/:id/disapprove",
  requireAuth,
  requireRole(["librarian", "admin"]),
  async (req, res, next) => {
    try {
      const targetId = String(req.params.id || "").trim();

      if (!/^\d+$/.test(targetId)) {
        return res.status(400).json({ ok: false, message: "Invalid user id." });
      }

      const found = await query<UserRow>(
        `SELECT id, email, full_name, account_type, role, is_approved
         FROM users
         WHERE id = $1
         LIMIT 1`,
        [targetId]
      );

      if (!found.rowCount) {
        return res.status(404).json({ ok: false, message: "User not found." });
      }

      const row = found.rows[0];
      const effRole = computeEffectiveRoleFromRow(row);

      if (isExemptFromApproval(effRole)) {
        return res.status(400).json({
          ok: false,
          message: "This user role is exempt from approval.",
        });
      }

      if (!row.is_approved) {
        return res.json({ ok: true, message: "User is already pending." });
      }

      await query(
        `UPDATE users
         SET is_approved = FALSE,
             approved_at = NULL,
             approved_by = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [targetId]
      );

      return res.json({ ok: true, message: "User disapproved." });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * DELETE /api/users/:id
 * Librarian: can delete ONLY newly registered users (not approved yet) and not librarian/admin.
 * Admin: can delete any user except self (and still cannot delete self).
 */
router.delete(
  "/:id",
  requireAuth,
  requireRole(["librarian", "admin"]),
  async (req, res, next) => {
    try {
      const s = (req as any).sessionUser as SessionPayload;
      const targetId = String(req.params.id || "").trim();

      if (!/^\d+$/.test(targetId)) {
        return res.status(400).json({ ok: false, message: "Invalid user id." });
      }

      if (String(s.sub) === targetId) {
        return res
          .status(400)
          .json({ ok: false, message: "You cannot delete your own account." });
      }

      const found = await query<UserRow>(
        `SELECT id, email, full_name, account_type, role, is_approved
         FROM users
         WHERE id = $1
         LIMIT 1`,
        [targetId]
      );

      if (!found.rowCount) {
        return res.status(404).json({ ok: false, message: "User not found." });
      }

      const row = found.rows[0];
      const effRole = computeEffectiveRoleFromRow(row);

      // Librarian restriction: only delete NOT approved + NOT exempt
      if (s.role === "librarian") {
        if (row.is_approved) {
          return res.status(403).json({
            ok: false,
            message:
              "Librarian can only delete newly registered (not approved) users.",
          });
        }
        if (isExemptFromApproval(effRole)) {
          return res.status(403).json({
            ok: false,
            message: "Cannot delete librarian/admin accounts.",
          });
        }
      }

      await query(`DELETE FROM users WHERE id = $1`, [targetId]);

      return res.json({ ok: true, message: "User deleted." });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/users/check-student-id?studentId=...
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
