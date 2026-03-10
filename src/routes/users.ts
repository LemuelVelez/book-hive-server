import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../db";
import multer from "multer";
import { uploadImageToS3 } from "../s3";
import * as bcrypt from "bcryptjs";
import crypto from "crypto";
import { sendMail } from "../email";
import { buildLoginCredentialsEmail } from "../lib/email-templates/login-credentials";

const router = express.Router();

type Role =
  | "student"
  | "assistant_librarian"
  | "librarian"
  | "faculty"
  | "admin"
  | "other";

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

  // ✅ approval
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

  is_approved?: boolean;
  approved_at?: string | null;
  approved_by?: string | null;
};

type SessionPayload = {
  sub: string;
  email: string;
  role: Role;
  ev: number;
};

/* ---------------- Role helpers ---------------- */

function normalizeRole(raw: unknown): Role {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "student") return "student";
  if (
    v === "assistant_librarian" ||
    v === "assistant librarian" ||
    v === "assistant-librarian"
  ) {
    return "assistant_librarian";
  }
  if (v === "librarian") return "librarian";
  if (v === "faculty") return "faculty";
  if (v === "admin") return "admin";
  return "other";
}

function isStaffRole(role: Role) {
  return (
    role === "admin" ||
    role === "librarian" ||
    role === "assistant_librarian" ||
    role === "faculty"
  );
}

const ALLOWED_ROLES: Role[] = [
  "student",
  "assistant_librarian",
  "librarian",
  "faculty",
  "admin",
  "other",
];

const ARCHIVED_USER_EMAIL_DOMAIN = "bookhive.local";
const ARCHIVED_USER_EMAIL_REGEX_SQL = "^deleted\\+.*@bookhive\\.local$";

/**
 * ✅ Effective AUTH role for guards/authorization:
 * - Prefer legacy `role` if it's a staff role
 * - Else if account_type is staff role use it
 * - Else if legacy role exists use it (student/other)
 * - Else fallback to account_type
 */
function computeEffectiveRoleFromRow(
  row: Pick<UserRow, "account_type" | "role">
): Role {
  const accountType = normalizeRole(row.account_type);

  const legacyRaw = row.role;
  const legacyHasValue =
    legacyRaw !== undefined &&
    legacyRaw !== null &&
    String(legacyRaw).trim().length > 0;

  const legacyRole = normalizeRole(legacyRaw);

  if (legacyHasValue && isStaffRole(legacyRole)) return legacyRole;
  if (isStaffRole(accountType)) return accountType;
  if (legacyHasValue) return legacyRole;

  return accountType || "student";
}

function isExemptFromApproval(role: Role) {
  return (
    role === "assistant_librarian" || role === "librarian" || role === "admin"
  );
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
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
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

function getClientBaseUrl() {
  return (process.env.CLIENT_ORIGIN || "http://localhost:5173")
    .toString()
    .replace(/\/+$/, "");
}

function getLoginUrl() {
  const full = String(process.env.CLIENT_LOGIN_URL ?? "").trim();
  if (full) return full.replace(/\/+$/, "");

  const base = getClientBaseUrl();

  let p = String(process.env.CLIENT_LOGIN_PATH || "/auth").trim();
  if (!p) p = "/auth";
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/+$/, "");
  if (!p) p = "/auth";

  return `${base}${p}`;
}

function readIdParam(raw: unknown): string | null {
  const id = String(raw ?? "").trim();
  if (!id) return null;
  if (id.length > 128) return null;
  if (/\s/.test(id)) return null;
  return id;
}

function safeAccountType(
  raw: unknown
): "student" | "assistant_librarian" | "other" {
  const r = normalizeRole(raw);
  if (r === "student") return "student";
  if (r === "assistant_librarian") return "assistant_librarian";
  return "other";
}

function generateTemporaryPassword(len = 12) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(Math.max(16, len));
  let out = "";
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return `${out}A1!`;
}

function isArchivedUserEmail(email: string | null | undefined) {
  const value = String(email ?? "").trim().toLowerCase();
  return /^deleted\+.*@bookhive\.local$/.test(value);
}

function buildArchivedUserEmail(userId: string) {
  const safeId = String(userId).replace(/[^a-z0-9_-]/gi, "");
  return `deleted+${safeId}.${Date.now()}@${ARCHIVED_USER_EMAIL_DOMAIN}`;
}

async function invalidateEmailVerificationTokens(userId: string) {
  await query(
    `UPDATE email_verifications
     SET used = TRUE
     WHERE user_id = $1 AND used = FALSE`,
    [userId]
  );
}

async function createEmailVerificationToken(userId: string) {
  await invalidateEmailVerificationTokens(userId);

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await query(
    `INSERT INTO email_verifications (user_id, token, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, token, expiresAt]
  );

  const confirmUrl = `${getClientBaseUrl()}/auth/verify-email/callback?token=${encodeURIComponent(
    token
  )}`;

  return { token, expiresAt, confirmUrl };
}

async function createAndSendVerifyEmail(
  userId: string,
  email: string,
  fullName?: string
) {
  const { confirmUrl } = await createEmailVerificationToken(userId);

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

async function hasBorrowOrReturnHistory(userId: string) {
  const result = await query<{ ref_count: string }>(
    `SELECT (
        COALESCE((SELECT COUNT(*) FROM borrow_records WHERE user_id::text = $1), 0) +
        COALESCE((SELECT COUNT(*) FROM borrow_records WHERE return_requested_by::text = $1), 0) +
        COALESCE((SELECT COUNT(*) FROM borrow_records WHERE extension_decided_by::text = $1), 0)
      )::text AS ref_count`,
    [userId]
  );

  const count = Number(result.rows[0]?.ref_count ?? 0);
  return Number.isFinite(count) && count > 0;
}

async function archiveUserToPreserveRecords(userId: string) {
  const archivedEmail = buildArchivedUserEmail(userId);
  const archivedPasswordHash = await bcrypt.hash(generateTemporaryPassword(24), 10);

  await invalidateEmailVerificationTokens(userId);

  await query(
    `UPDATE users
       SET email = $1,
           password_hash = $2,
           account_type = 'other',
           role = 'other',
           student_id = NULL,
           course = NULL,
           year_level = NULL,
           avatar_url = NULL,
           is_email_verified = FALSE,
           email_verified_at = NULL,
           is_approved = FALSE,
           approved_at = NULL,
           approved_by = NULL,
           updated_at = NOW()
     WHERE id = $3`,
    [archivedEmail, archivedPasswordHash, userId]
  );
}

/**
 * ✅ IMPORTANT:
 * Return BOTH:
 * - accountType: based on DB `account_type`
 * - role: effective auth role
 */
function toMeDTO(row: UserRow) {
  const role = computeEffectiveRoleFromRow(row);
  const accountType = normalizeRole(row.account_type);

  return {
    id: String(row.id),
    email: row.email,
    fullName: row.full_name,

    accountType,
    role,

    isEmailVerified: Boolean(row.is_email_verified),

    isApproved: Boolean(row.is_approved),
    approvedAt: row.approved_at ?? null,

    studentId: row.student_id ?? null,
    course: row.course ?? null,
    yearLevel: row.year_level ?? null,
    avatarUrl: row.avatar_url ?? null,
  };
}

function toUserListDTO(row: UserRow) {
  const role = computeEffectiveRoleFromRow(row);
  const accountType = normalizeRole(row.account_type);

  return {
    id: String(row.id),
    email: row.email,
    fullName: row.full_name,

    accountType,
    role,

    avatarUrl: row.avatar_url ?? null,

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
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\//i.test(file.mimetype)) return cb(null, true);
    cb(new Error("Only image uploads are allowed."));
  },
});

/* ---------------- Routes ---------------- */

/**
 * PATCH /api/users/me
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
    const yearLevelRaw = req.body?.yearLevel ?? req.body?.year_level;
    const studentIdRaw = req.body?.studentId ?? req.body?.student_id;

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

    if (studentIdRaw !== undefined) {
      const nextStudentId = cleanOptionalText(studentIdRaw);
      if (effectiveRole === "student" && !nextStudentId) {
        return res
          .status(400)
          .json({ ok: false, message: "studentId is required for students." });
      }

      const currentStudentId = cleanOptionalText((row as any).student_id);

      if (nextStudentId !== currentStudentId) {
        if (nextStudentId) {
          const sidDupe = await query(
            `SELECT 1 FROM users WHERE student_id = $1 AND id <> $2 LIMIT 1`,
            [nextStudentId, s.sub]
          );
          if (sidDupe.rowCount) {
            return res
              .status(409)
              .json({ ok: false, message: "Student ID already in use." });
          }
        }

        updates.push(`student_id = $${i++}`);
        values.push(nextStudentId);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ ok: false, message: "No changes provided." });
    }

    updates.push(`updated_at = NOW()`);

    await query(
      `UPDATE users
       SET ${updates.join(", ")}
       WHERE id = $${i}`,
      [...values, s.sub]
    );

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

/* =======================================================================
   ✅ ADMIN: Create user + Change role + Send/Resend Credentials
   ======================================================================= */

/**
 * POST /api/users
 * Admin-only: create a new user (add new user).
 */
router.post("/", requireAuth, requireRole(["admin"]), async (req, res, next) => {
  try {
    const s = (req as any).sessionUser as SessionPayload;

    const fullName = String(req.body?.fullName ?? "").trim();
    const emailRaw = String(req.body?.email ?? "").trim();

    const roleRaw =
      req.body?.role ?? req.body?.userRole ?? req.body?.accountType ?? "student";
    const role = normalizeRole(roleRaw);

    const accountTypeRaw = req.body?.accountType ?? req.body?.account_type;
    const accountType =
      accountTypeRaw !== undefined
        ? safeAccountType(accountTypeRaw)
        : role === "student"
          ? "student"
          : role === "assistant_librarian"
            ? "assistant_librarian"
            : "other";

    const isApprovedRaw = req.body?.isApproved;

    const needsStudentFields = role === "student" || accountType === "student";
    const studentId = cleanOptionalText(
      req.body?.studentId ?? req.body?.student_id
    );
    const course = cleanOptionalText(req.body?.course);
    const yearLevel = cleanOptionalText(
      req.body?.yearLevel ?? req.body?.year_level
    );

    const sendLoginCredentials = req.body?.sendLoginCredentials !== false;
    const autoGeneratePassword = req.body?.autoGeneratePassword === true;

    if (!fullName) {
      return res
        .status(400)
        .json({ ok: false, message: "Full name is required." });
    }
    if (!emailRaw || !isValidEmail(emailRaw)) {
      return res
        .status(400)
        .json({ ok: false, message: "Valid email is required." });
    }
    if (!ALLOWED_ROLES.includes(role)) {
      return res.status(400).json({ ok: false, message: "Invalid role." });
    }

    if (needsStudentFields) {
      if (!studentId || !course || !yearLevel) {
        return res.status(400).json({
          ok: false,
          message: "Student fields are required (studentId, course, yearLevel).",
        });
      }
      const sidDupe = await query(
        `SELECT 1 FROM users WHERE student_id = $1 LIMIT 1`,
        [studentId]
      );
      if (sidDupe.rowCount) {
        return res
          .status(409)
          .json({ ok: false, message: "Student ID already in use." });
      }
    }

    const email = emailRaw.toLowerCase();

    const emailDupe = await query(`SELECT 1 FROM users WHERE email = $1 LIMIT 1`, [
      email,
    ]);
    if (emailDupe.rowCount) {
      return res.status(409).json({ ok: false, message: "Email already in use." });
    }

    const providedPasswordRaw = String(req.body?.password ?? "");
    const providedPassword = providedPasswordRaw.trim();
    let effectivePassword = providedPassword;
    let passwordGenerated = false;

    if (!effectivePassword) {
      if (autoGeneratePassword || sendLoginCredentials) {
        effectivePassword = generateTemporaryPassword();
        passwordGenerated = true;
      } else {
        return res.status(400).json({
          ok: false,
          message:
            "Password is required when not sending login credentials (or enable auto-generate).",
        });
      }
    } else if (effectivePassword.length < 8) {
      return res.status(400).json({
        ok: false,
        message: "Password must be at least 8 characters.",
      });
    }

    const approved = isExemptFromApproval(role)
      ? true
      : Boolean(isApprovedRaw === true);

    const approvedAt = approved ? new Date() : null;
    const approvedBy = approved ? s.sub : null;

    const hash = await bcrypt.hash(effectivePassword, 10);

    const ins = await query<UserRow>(
      `INSERT INTO users
       (full_name, email, password_hash,
        account_type, role,
        student_id, course, year_level,
        is_email_verified,
        is_approved, approved_at, approved_by,
        updated_at)
       VALUES
       ($1,$2,$3,
        $4,$5,
        $6,$7,$8,
        FALSE,
        $9,$10,$11,
        NOW())
       RETURNING
        id, email, full_name, account_type, role,
        student_id, course, year_level,
        is_email_verified,
        avatar_url,
        is_approved, approved_at, approved_by`,
      [
        fullName,
        email,
        hash,
        accountType,
        role,
        needsStudentFields ? studentId : null,
        needsStudentFields ? course : null,
        needsStudentFields ? yearLevel : null,
        approved,
        approvedAt,
        approvedBy,
      ]
    );

    const user = ins.rows[0];

    let credentialsSent = false;
    let credentialsError: string | null = null;

    if (sendLoginCredentials) {
      try {
        const loginUrl = getLoginUrl();
        const { confirmUrl } = await createEmailVerificationToken(user.id);

        const tpl = buildLoginCredentialsEmail({
          appName: "JRMSU-TC Book-Hive",
          fullName: user.full_name,
          email: user.email,
          temporaryPassword: effectivePassword,
          loginUrl,
          verifyEmailUrl: confirmUrl,
        });

        await sendMail({
          to: user.email,
          subject: tpl.subject,
          html: tpl.html,
          text: tpl.text,
        });

        credentialsSent = true;
      } catch (e: any) {
        credentialsError = e?.message
          ? String(e.message)
          : "Failed to send login credentials email.";
        console.warn("Failed sending login credentials email (admin create):", e);

        try {
          await createAndSendVerifyEmail(user.id, user.email, user.full_name);
        } catch (err) {
          console.warn("Failed sending verification email fallback:", err);
        }
      }
    } else {
      try {
        await createAndSendVerifyEmail(user.id, user.email, user.full_name);
      } catch (e) {
        console.warn("Failed sending verification email (admin create):", e);
      }
    }

    return res.status(201).json({
      ok: true,
      user: toMeDTO(user),
      credentials: {
        requested: sendLoginCredentials,
        sent: credentialsSent,
        error: credentialsError,
        passwordGenerated,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/users/:id/send-login-credentials
 * Admin-only: send (or re-send) login credentials.
 */
router.post(
  "/:id/send-login-credentials",
  requireAuth,
  requireRole(["admin"]),
  async (req, res, next) => {
    try {
      const targetId = readIdParam(req.params.id);
      if (!targetId) {
        return res.status(400).json({ ok: false, message: "Invalid user id." });
      }

      const found = await query<{
        id: string;
        email: string;
        full_name: string;
        is_email_verified: boolean;
      }>(
        `SELECT id, email, full_name, is_email_verified
         FROM users
         WHERE id = $1
         LIMIT 1`,
        [targetId]
      );

      if (!found.rowCount) {
        return res.status(404).json({ ok: false, message: "User not found." });
      }

      const user = found.rows[0];

      const providedRaw = req.body?.password;
      const provided = typeof providedRaw === "string" ? providedRaw.trim() : "";

      let nextPassword = provided;
      let passwordGenerated = false;

      if (!nextPassword) {
        nextPassword = generateTemporaryPassword();
        passwordGenerated = true;
      } else if (nextPassword.length < 8) {
        return res.status(400).json({
          ok: false,
          message: "Password must be at least 8 characters.",
        });
      }

      const hash = await bcrypt.hash(nextPassword, 10);

      await query(
        `UPDATE users
         SET password_hash = $1, updated_at = NOW()
         WHERE id = $2`,
        [hash, targetId]
      );

      const loginUrl = getLoginUrl();

      let verifyUrl: string | null = null;
      if (!user.is_email_verified) {
        const { confirmUrl } = await createEmailVerificationToken(user.id);
        verifyUrl = confirmUrl;
      }

      const tpl = buildLoginCredentialsEmail({
        appName: "JRMSU-TC Book-Hive",
        fullName: user.full_name,
        email: user.email,
        temporaryPassword: nextPassword,
        loginUrl,
        verifyEmailUrl: verifyUrl,
      });

      await sendMail({
        to: user.email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
      });

      return res.json({
        ok: true,
        message: "Login credentials sent.",
        passwordGenerated,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /api/users/:id/role
 * Admin-only: change a user's role.
 * Body: { role }
 */
router.patch("/:id/role", requireAuth, requireRole(["admin"]), async (req, res, next) => {
  try {
    const s = (req as any).sessionUser as SessionPayload;
    const targetId = readIdParam(req.params.id);

    if (!targetId) {
      return res.status(400).json({ ok: false, message: "Invalid user id." });
    }

    if (String(s.sub) === targetId) {
      return res.status(400).json({
        ok: false,
        message: "You cannot change your own role.",
      });
    }

    const nextRole = normalizeRole(req.body?.role);
    if (!ALLOWED_ROLES.includes(nextRole)) {
      return res.status(400).json({ ok: false, message: "Invalid role." });
    }

    const found = await query<UserRow>(
      `SELECT id, email, full_name, account_type, role,
              student_id, course, year_level,
              is_email_verified,
              avatar_url,
              is_approved, approved_at, approved_by
         FROM users
         WHERE id = $1
         LIMIT 1`,
      [targetId]
    );

    if (!found.rowCount) {
      return res.status(404).json({ ok: false, message: "User not found." });
    }

    const forceApprove = isExemptFromApproval(nextRole);

    await query(
      `UPDATE users
         SET role = $1,
             is_approved = CASE WHEN $2 THEN TRUE ELSE is_approved END,
             approved_at = CASE
               WHEN $2 AND approved_at IS NULL THEN NOW()
               ELSE approved_at
             END,
             approved_by = CASE
               WHEN $2 AND approved_by IS NULL THEN $3
               ELSE approved_by
             END,
             updated_at = NOW()
         WHERE id = $4`,
      [nextRole, forceApprove, s.sub, targetId]
    );

    const refreshed = await fetchMeRow(targetId);
    return res.json({ ok: true, user: toMeDTO(refreshed.rows[0]) });
  } catch (err) {
    next(err);
  }
});

/* =======================================================================
   Existing user management (list/pending/approve/disapprove/delete)
   ======================================================================= */

router.get("/", requireAuth, requireRole(["librarian", "admin"]), async (_req, res, next) => {
  try {
    const result = await query<UserRow>(
      `SELECT id, email, full_name, account_type, role, avatar_url,
              is_approved, approved_at, approved_by,
              created_at
         FROM users
         WHERE email !~ $1
         ORDER BY created_at DESC, id DESC`,
      [ARCHIVED_USER_EMAIL_REGEX_SQL]
    );

    const users = result.rows.map(toUserListDTO);

    res.json({ ok: true, users });
  } catch (err) {
    next(err);
  }
});

router.get("/pending", requireAuth, requireRole(["librarian", "admin"]), async (_req, res, next) => {
  try {
    const result = await query<UserRow>(
      `SELECT id, email, full_name, account_type, role, avatar_url,
              is_approved, approved_at, approved_by,
              created_at
         FROM users
         WHERE is_approved = FALSE
           AND email !~ $1
         ORDER BY created_at DESC, id DESC`,
      [ARCHIVED_USER_EMAIL_REGEX_SQL]
    );

    const pending = result.rows
      .map((r) => {
        const eff = computeEffectiveRoleFromRow(r);
        if (isExemptFromApproval(eff)) return null;
        return toUserListDTO(r);
      })
      .filter(Boolean);

    res.json({ ok: true, users: pending });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id/approve", requireAuth, requireRole(["librarian", "admin"]), async (req, res, next) => {
  try {
    const s = (req as any).sessionUser as SessionPayload;
    const targetId = readIdParam(req.params.id);

    if (!targetId) {
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
});

router.patch("/:id/disapprove", requireAuth, requireRole(["librarian", "admin"]), async (req, res, next) => {
  try {
    const targetId = readIdParam(req.params.id);

    if (!targetId) {
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
});

router.delete("/:id", requireAuth, requireRole(["librarian", "admin"]), async (req, res, next) => {
  try {
    const s = (req as any).sessionUser as SessionPayload;
    const targetId = readIdParam(req.params.id);

    if (!targetId) {
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

    if (s.role === "librarian") {
      if (row.is_approved) {
        return res.status(403).json({
          ok: false,
          message: "Librarian can only delete newly registered (not approved) users.",
        });
      }
      if (isExemptFromApproval(effRole)) {
        return res.status(403).json({
          ok: false,
          message: "Cannot delete assistant librarian/librarian/admin accounts.",
        });
      }
    }

    if (isArchivedUserEmail(row.email)) {
      return res.json({
        ok: true,
        message: "User is already deleted and archived.",
      });
    }

    const mustPreserveRecords =
      effRole === "assistant_librarian" || (await hasBorrowOrReturnHistory(targetId));

    if (mustPreserveRecords) {
      await archiveUserToPreserveRecords(targetId);
      return res.json({
        ok: true,
        message: "User deleted. Account was archived to preserve borrow/return records.",
      });
    }

    await query(`DELETE FROM users WHERE id = $1`, [targetId]);

    return res.json({ ok: true, message: "User deleted." });
  } catch (err) {
    next(err);
  }
});

router.get("/check-student-id", async (req, res, next) => {
  try {
    const studentId = String(req.query.studentId || "").trim();
    if (!studentId) return res.status(400).json({ available: false });

    const found = await query(`SELECT 1 FROM users WHERE student_id = $1 LIMIT 1`, [
      studentId,
    ]);
    res.json({ available: found.rowCount === 0 });
  } catch (err) {
    next(err);
  }
});

export default router;