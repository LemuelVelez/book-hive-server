/* eslint-disable @typescript-eslint/no-explicit-any */
import express from "express";
import * as bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { query } from "../db";
import { sendMail } from "../email";

const router = express.Router();

type Role = "student" | "librarian" | "faculty" | "admin" | "other";

type UserRow = {
  id: string;
  full_name: string;
  email: string;
  password_hash: string;

  // Newer column used by the app for routing/roles
  account_type: Role;

  // Student metadata
  student_id: string | null;
  course: string | null;
  year_level: string | null;

  // ✅ optional avatar URL
  avatar_url: string | null;

  // Email verification
  is_email_verified: boolean;

  // ✅ NEW: librarian approval
  is_approved?: boolean;
  approved_at?: string | null;
  approved_by?: string | null;

  created_at: string;
  updated_at: string;

  // Legacy column from the original schema (may still hold librarian/admin/etc)
  role?: Role;
};

/**
 * Normalize a user's role considering both the new `account_type` column
 * and the legacy `role` column.
 *
 * - Prefer `account_type` if it is non-student (librarian/faculty/admin/other).
 * - If `account_type` is still `student` but the legacy `role` column has a
 *   non-student value (e.g. "librarian"), treat that legacy value as the
 *   effective role.
 * - Otherwise fall back to `account_type` (or student).
 */
function getEffectiveRole(user: UserRow): Role {
  const primary = (user.account_type || "student") as Role;
  const legacy = (user as any).role as Role | undefined;

  // New-style roles (including "other") take priority
  if (primary && primary !== "student") {
    return primary;
  }

  // If the DB row still uses the old `role` column for a non-student,
  // but `account_type` is stuck at the default "student", honor the legacy role.
  if (primary === "student" && legacy && legacy !== "student") {
    return legacy;
  }

  // Default
  return primary || legacy || "student";
}

// --- Helpers ---
function signSessionJWT(
  user: Pick<UserRow, "id" | "email" | "account_type" | "is_email_verified">
) {
  const secret = process.env.JWT_SECRET!;
  const payload = {
    sub: user.id,
    email: user.email,
    role: user.account_type,
    ev: user.is_email_verified ? 1 : 0,
  };
  return jwt.sign(payload, secret, { algorithm: "HS256", expiresIn: "7d" });
}

function setSessionCookie(res: express.Response, token: string) {
  const prod = process.env.NODE_ENV === "production";
  res.cookie("bh_session", token, {
    httpOnly: true,
    secure: prod,
    sameSite: prod ? "none" : "lax",
    // Help with Chrome’s third-party cookie blocking (CHIPS/partitioned cookies)
    // Supported by modern Express/cookie libs; ignored by older browsers.
    partitioned: prod ? true : undefined,
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  } as any);
}

function clearSessionCookie(res: express.Response) {
  const prod = process.env.NODE_ENV === "production";
  res.clearCookie("bh_session", {
    path: "/",
    httpOnly: true,
    secure: prod,
    sameSite: prod ? "none" : "lax",
    partitioned: prod ? true : undefined,
  } as any);
}

/** Escape minimal HTML to safely inject user-provided strings */
function escapeHtml(input: string) {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function createAndSendVerifyEmail(
  userId: string,
  email: string,
  fullName?: string
) {
  // Create token row
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

  await query(
    `INSERT INTO email_verifications (user_id, token, expires_at) VALUES ($1, $2, $3)`,
    [userId, token, expiresAt]
  );

  console.log(`[verify-email] token created for user=${userId} token=${token}`);

  // ✅ Use CLIENT_ORIGIN (frontend) for the link shown to users
  const client = (process.env.CLIENT_ORIGIN || "http://localhost:5173")
    .toString()
    .replace(/\/+$/, "");

  // The React page /auth/verify-email/callback will read ?token= and POST to /api/auth/verify-email/confirm
  const confirmUrl = `${client}/auth/verify-email/callback?token=${encodeURIComponent(
    token
  )}`;

  const safeName =
    fullName && fullName.trim().length > 0
      ? escapeHtml(fullName.trim())
      : "there";

  const html = `
    <p>Hi ${safeName},</p>
    <p>Thanks for registering at <strong>JRMSU-TC Book-Hive</strong>.</p>
    <p>Please verify your email by clicking the link below:</p>
    <p><a href="${confirmUrl}">${confirmUrl}</a></p>
    <hr/>
    <p>If you didn't create an account, please ignore this message.</p>
  `;

  await sendMail({
    to: email,
    subject: "Verify your email • JRMSU-TC Book-Hive",
    html,
  });
}

/** Create a password reset token row and email the user a link */
async function createAndSendPasswordResetEmail(
  userId: string,
  email: string,
  fullName?: string
) {
  await query(
    `UPDATE password_resets SET used_at = NOW()
     WHERE user_id = $1 AND used_at IS NULL AND expires_at < NOW()`,
    [userId]
  );

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 60 minutes

  await query(
    `INSERT INTO password_resets (user_id, token, expires_at)
     VALUES ($1,$2,$3)`,
    [userId, token, expiresAt]
  );

  console.log(
    `[password-reset] token created for user=${userId} token=${token}`
  );

  const client = process.env.CLIENT_ORIGIN || "http://localhost:5173";
  const resetUrl = `${client.replace(
    /\/+$/,
    ""
  )}/auth/reset-password?token=${encodeURIComponent(token)}`;

  const safeName =
    fullName && fullName.trim().length > 0
      ? escapeHtml(fullName.trim())
      : "there";

  const html = `
    <p>Hi ${safeName},</p>
    <p>We received a request to reset your <strong>JRMSU-TC Book-Hive</strong> password.</p>
    <p>You can set a new password by clicking the secure link below (valid for 60 minutes):</p>
    <p><a href="${resetUrl}">${resetUrl}</a></p>
    <p>If you didn’t request this, you can safely ignore this email.</p>
  `;

  await sendMail({
    to: email,
    subject: "Reset your password • JRMSU-TC Book-Hive",
    html,
  });
}

// Parse and verify session cookie; returns { sub, email, role, ev } | null
function readSession(
  req: express.Request
): null | { sub: string; email: string; role: Role; ev: number } {
  const token = (req.cookies as any)?.["bh_session"];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as any;
    return {
      sub: String(payload.sub),
      email: String(payload.email),
      role: String(payload.role) as Role,
      ev: Number(payload.ev) || 0,
    };
  } catch {
    return null;
  }
}

function isExemptFromApproval(role: Role) {
  return role === "librarian" || role === "admin";
}

// --- Routes ---

// GET /api/auth/me
router.get("/me", async (req, res, next) => {
  try {
    const s = readSession(req);
    if (!s)
      return res.status(401).json({ ok: false, message: "Not authenticated" });

    const found = await query<UserRow>(
      `SELECT * FROM users WHERE id = $1 LIMIT 1`,
      [s.sub]
    );
    if (!found.rowCount) {
      clearSessionCookie(res);
      return res.status(401).json({ ok: false, message: "Not authenticated" });
    }

    const user = found.rows[0];
    const accountType = getEffectiveRole(user);

    return res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        accountType,
        isEmailVerified: user.is_email_verified,

        // ✅ NEW: approval status
        isApproved: Boolean(user.is_approved),
        approvedAt: user.approved_at ?? null,

        // ✅ include registration/profile info (helps settings page)
        studentId: user.student_id,
        course: user.course,
        yearLevel: user.year_level,

        // ✅ avatar url
        avatarUrl: user.avatar_url,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout
router.post("/logout", async (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true, message: "Logged out" });
});

// POST /api/auth/register
router.post("/register", async (req, res, next) => {
  try {
    const {
      fullName,
      email,
      password,
      accountType,
      studentId,
      course,
      yearLevel,
      avatarUrl, // ✅ optional
    } = req.body || {};

    if (!fullName || !email || !password || !accountType) {
      return res
        .status(400)
        .json({ ok: false, message: "Missing required fields." });
    }
    if (typeof email !== "string" || !email.includes("@")) {
      return res.status(400).json({ ok: false, message: "Invalid email." });
    }
    if (String(password).length < 8) {
      return res.status(400).json({
        ok: false,
        message: "Password must be at least 8 characters.",
      });
    }

    const allowed: Role[] = [
      "student",
      "librarian",
      "faculty",
      "admin",
      "other",
    ];
    if (!allowed.includes(accountType as Role)) {
      return res
        .status(400)
        .json({ ok: false, message: "Invalid account type." });
    }

    // Validate avatarUrl if provided
    let avatarUrlVal: string | null = null;
    if (avatarUrl !== undefined && avatarUrl !== null) {
      if (typeof avatarUrl !== "string") {
        return res
          .status(400)
          .json({ ok: false, message: "avatarUrl must be a string." });
      }
      const trimmed = avatarUrl.trim();
      avatarUrlVal = trimmed.length ? trimmed : null;
    }

    const emailDupe = await query<UserRow>(
      `SELECT * FROM users WHERE email = $1 LIMIT 1`,
      [
        String(email)
          .trim()
          .toLowerCase(),
      ]
    );
    if (emailDupe.rowCount) {
      return res
        .status(409)
        .json({ ok: false, message: "Email already in use." });
    }

    let studentIdVal: string | null = null;
    let courseVal: string | null = null;
    let yearLevelVal: string | null = null;

    if (accountType === "student") {
      if (!studentId || !course || !yearLevel) {
        return res
          .status(400)
          .json({ ok: false, message: "Student fields are required." });
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
      studentIdVal = String(studentId);
      courseVal = String(course);
      yearLevelVal = String(yearLevel);
    }

    const hash = await bcrypt.hash(String(password), 10);

    // ✅ NEW: approval logic
    const roleForApproval = accountType as Role;
    const approved = isExemptFromApproval(roleForApproval);

    const ins = await query<UserRow>(
      `INSERT INTO users
       (full_name, email, password_hash, account_type, student_id, course, year_level, avatar_url, is_approved, approved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        String(fullName).trim(),
        String(email)
          .trim()
          .toLowerCase(),
        hash,
        accountType as Role,
        studentIdVal,
        courseVal,
        yearLevelVal,
        avatarUrlVal,
        approved,
        approved ? new Date() : null,
      ]
    );

    const user = ins.rows[0];
    const accountTypeNormalized = getEffectiveRole(user);

    // 💡 Fire-and-forget: don't block the HTTP response on SMTP latency
    createAndSendVerifyEmail(user.id, user.email, user.full_name).catch((e) => {
      console.warn("Failed creating/sending verification email:", e);
    });

    return res.status(201).json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        accountType: accountTypeNormalized,
        isEmailVerified: user.is_email_verified,

        // ✅ NEW
        isApproved: Boolean(user.is_approved),
        approvedAt: user.approved_at ?? null,

        // ✅ include registration/profile info
        studentId: user.student_id,
        course: user.course,
        yearLevel: user.year_level,

        // ✅ NEW
        avatarUrl: user.avatar_url,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login
router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res
        .status(400)
        .json({ ok: false, message: "Email and password are required." });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    const found = await query<UserRow>(
      `SELECT * FROM users WHERE email = $1 LIMIT 1`,
      [normalizedEmail]
    );

    if (!found.rowCount) {
      // ✅ Explicit "user not found" for login
      return res.status(404).json({
        ok: false,
        message:
          "We couldn't find an account with that email. Please check for typos or register first.",
      });
    }

    const user = found.rows[0];
    const ok = await bcrypt.compare(String(password), user.password_hash);
    if (!ok) {
      return res
        .status(401)
        .json({ ok: false, message: "Invalid email or password." });
    }

    // Block login until email is verified
    if (!user.is_email_verified) {
      return res
        .status(403)
        .json({ ok: false, message: "Please verify your email to continue." });
    }

    const accountType = getEffectiveRole(user);

    // ✅ NEW: Block login until librarian approves (EXCEPT librarian/admin)
    const approved = Boolean((user as any).is_approved);
    if (!isExemptFromApproval(accountType) && !approved) {
      return res.status(403).json({
        ok: false,
        message:
          "Your account is pending librarian approval. Please wait for approval to log in.",
      });
    }

    const token = signSessionJWT({
      id: user.id,
      email: user.email,
      account_type: accountType,
      is_email_verified: user.is_email_verified,
    });
    setSessionCookie(res, token);

    return res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        accountType,
        isEmailVerified: user.is_email_verified,

        // ✅ NEW
        isApproved: Boolean((user as any).is_approved),
        approvedAt: (user as any).approved_at ?? null,

        // ✅ include registration/profile info
        studentId: user.student_id,
        course: user.course,
        yearLevel: user.year_level,

        // ✅ NEW
        avatarUrl: user.avatar_url,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/verify-email  (re-send)
router.post("/verify-email", async (req, res, next) => {
  try {
    const { email } = req.body || {};
    if (!email || typeof email !== "string") {
      return res.status(400).json({ ok: false, message: "Email is required." });
    }
    const found = await query<UserRow>(
      `SELECT * FROM users WHERE email = $1 LIMIT 1`,
      [email.trim().toLowerCase()]
    );
    if (!found.rowCount) {
      return res.status(404).json({ ok: false, message: "Account not found." });
    }
    const user = found.rows[0];

    await query(
      `UPDATE email_verifications SET used = TRUE WHERE user_id = $1 AND used = FALSE`,
      [user.id]
    );

    await createAndSendVerifyEmail(user.id, user.email, user.full_name);
    res.json({ ok: true, message: "Verification email sent." });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/verify-email/confirm (JSON)
router.post("/verify-email/confirm", async (req, res, next) => {
  try {
    const token = String(req.body?.token ?? "").trim();
    if (!token) {
      return res.status(400).json({ ok: false, message: "Missing token." });
    }

    const t = await query<{
      id: string;
      user_id: string;
      token: string;
      expires_at: string;
      used: boolean;
    }>(`SELECT * FROM email_verifications WHERE token = $1 LIMIT 1`, [token]);

    if (!t.rowCount) {
      return res.status(400).json({ ok: false, message: "Invalid token." });
    }
    const row = t.rows[0];

    if (row.used) {
      return res
        .status(400)
        .json({ ok: false, message: "Token already used." });
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ ok: false, message: "Token expired." });
    }

    await query(
      `UPDATE users
         SET is_email_verified = TRUE,
             email_verified_at = COALESCE(email_verified_at, NOW()),
             updated_at = NOW()
       WHERE id = $1`,
      [row.user_id]
    );
    await query(`UPDATE email_verifications SET used = TRUE WHERE id = $1`, [
      row.id,
    ]);

    return res.json({ ok: true, message: "Email verified." });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/verify-email/confirm?token=...
// (kept for compatibility, but new emails will no longer point here directly)
router.get("/verify-email/confirm", async (req, res, next) => {
  try {
    const client = process.env.CLIENT_ORIGIN || "http://localhost:5173";
    const base = client.replace(/\/+$/, "");
    const to = (q: string) => `${base}/auth/verify-email/callback${q}`;

    const token = String(req.query.token || "");
    if (!token) return res.redirect(302, to(`?status=error&reason=missing`));

    const t = await query<{
      id: string;
      user_id: string;
      token: string;
      expires_at: string;
      used: boolean;
    }>(`SELECT * FROM email_verifications WHERE token = $1 LIMIT 1`, [token]);

    if (!t.rowCount)
      return res.redirect(302, to(`?status=error&reason=invalid`));
    const row = t.rows[0];

    if (row.used) return res.redirect(302, to(`?status=error&reason=used`));
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return res.redirect(302, to(`?status=error&reason=expired`));
    }

    await query(
      `UPDATE users
         SET is_email_verified = TRUE,
             email_verified_at = COALESCE(email_verified_at, NOW()),
             updated_at = NOW()
       WHERE id = $1`,
      [row.user_id]
    );
    await query(`UPDATE email_verifications SET used = TRUE WHERE id = $1`, [
      row.id,
    ]);

    return res.redirect(302, to(`?status=success`));
  } catch (err) {
    next(err);
  }
});

/* --------------------------- PASSWORD RESET --------------------------- */

// POST /api/auth/forgot-password
router.post("/forgot-password", async (req, res, next) => {
  try {
    const emailRaw = String(req.body?.email ?? "").trim();
    const email = emailRaw.toLowerCase();

    if (!email || !email.includes("@")) {
      return res.status(400).json({
        ok: false,
        message: "Please enter a valid email address.",
      });
    }

    const found = await query<UserRow>(
      `SELECT * FROM users WHERE email = $1 LIMIT 1`,
      [email]
    );

    if (!found.rowCount) {
      // ✅ Explicit "user not found" for forgot-password flow
      return res.status(404).json({
        ok: false,
        message:
          "We couldn't find an account with that email. Please double-check or register first.",
      });
    }

    const user = found.rows[0];

    try {
      await createAndSendPasswordResetEmail(
        user.id,
        user.email,
        user.full_name
      );
    } catch (e) {
      console.warn("Failed sending reset email:", e);
    }

    return res.json({
      ok: true,
      message:
        "We emailed you a password reset link. Please check your inbox and spam folder.",
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/reset-password
router.post("/reset-password", async (req, res, next) => {
  try {
    const token = String(req.body?.token ?? "").trim();
    const password = String(req.body?.password ?? "");

    if (!token) {
      return res.status(400).json({ ok: false, message: "Missing token." });
    }
    if (password.length < 8) {
      return res.status(400).json({
        ok: false,
        message: "Password must be at least 8 characters.",
      });
    }

    const t = await query<{
      id: string;
      user_id: string;
      token: string;
      created_at: string;
      expires_at: string;
      used_at: string | null;
    }>(`SELECT * FROM password_resets WHERE token = $1 LIMIT 1`, [token]);

    if (!t.rowCount) {
      return res.status(400).json({ ok: false, message: "Invalid token." });
    }
    const row = t.rows[0];

    if (row.used_at) {
      return res
        .status(400)
        .json({ ok: false, message: "Token already used." });
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ ok: false, message: "Token expired." });
    }

    const hash = await bcrypt.hash(password, 10);

    await query(
      `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [hash, row.user_id]
    );

    await query(`UPDATE password_resets SET used_at = NOW() WHERE id = $1`, [
      row.id,
    ]);

    // Force re-login after password reset
    clearSessionCookie(res);

    return res.json({ ok: true, message: "Password updated." });
  } catch (err) {
    next(err);
  }
});

export default router;
