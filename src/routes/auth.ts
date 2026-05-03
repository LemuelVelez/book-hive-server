/* eslint-disable @typescript-eslint/no-explicit-any */
import express from "express";
import * as bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { query } from "../db";
import { sendMail } from "../email";

const router = express.Router();

type Role =
  | "student"
  | "assistant_librarian"
  | "librarian"
  | "faculty"
  | "admin"
  | "other";

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
  contact_number: string | null;

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

type ApprovalNotificationRecipientRow = {
  email: string | null;
  full_name: string | null;
  account_type: Role | string | null;
  role?: Role | string | null;
};

type PendingApprovalNotificationRow = Pick<
  UserRow,
  | "id"
  | "full_name"
  | "email"
  | "account_type"
  | "student_id"
  | "course"
  | "year_level"
  | "contact_number"
  | "created_at"
> & {
  role?: Role | string | null;
};

/* ------------------------------------------------------------------
   ✅ ROLE RESOLUTION (IMPORTANT)
   We must rely on `role` (authorization) for guarding/redirecting,
   and NEVER let `account_type` (often student/other) override it.
------------------------------------------------------------------- */

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

/**
 * ✅ Effective AUTH role for guards/redirects:
 * - Prefer `user.role` if it is a staff role (admin/librarian/assistant_librarian/faculty)
 * - Otherwise, if account_type is a staff role, use it
 * - Otherwise, if user.role exists (student/other), use it
 * - Otherwise fallback to account_type (or student)
 *
 * This fixes the bug where a staff user might still have account_type="other"
 * and gets routed to the student/guest dashboard.
 */
function getEffectiveRole(user: UserRow): Role {
  const accountType = normalizeRole(user.account_type);

  const legacyRaw = (user as any).role;
  const legacyHasValue =
    legacyRaw !== undefined &&
    legacyRaw !== null &&
    String(legacyRaw).trim().length > 0;

  const legacyRole = normalizeRole(legacyRaw);

  // 1) Prefer legacy/stored `role` if it's a staff role
  if (legacyHasValue && isStaffRole(legacyRole)) return legacyRole;

  // 2) Otherwise if account_type itself is staff, allow it
  if (isStaffRole(accountType)) return accountType;

  // 3) Otherwise, use legacy role if present (student/other)
  if (legacyHasValue) return legacyRole;

  // 4) Fallback
  return accountType || "student";
}

// --- Helpers ---
function signSessionJWT(user: {
  id: string;
  email: string;
  role: Role;
  is_email_verified: boolean;
}) {
  const secret = process.env.JWT_SECRET!;
  const payload = {
    sub: user.id,
    email: user.email,
    role: user.role, // ✅ store effective auth role
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

function cleanOptionalText(value: unknown) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

function isValidContactNumber(value: string) {
  const s = String(value || "").trim();
  if (!s) return true;
  return /^[0-9()+\-.\s]{7,20}$/.test(s);
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

async function invalidateEmailVerificationTokens(userId: string) {
  await query(
    `UPDATE email_verifications
       SET used = TRUE
     WHERE user_id = $1
       AND used = FALSE`,
    [userId]
  );
}

async function createAndSendVerifyEmail(
  userId: string,
  email: string,
  fullName?: string
) {
  await invalidateEmailVerificationTokens(userId);

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

async function invalidatePasswordResetTokens(userId: string) {
  await query(
    `UPDATE password_resets
       SET used_at = COALESCE(used_at, NOW())
     WHERE user_id = $1
       AND used_at IS NULL`,
    [userId]
  );
}

/** Create a password reset token row and email the user a link */
async function createAndSendPasswordResetEmail(
  userId: string,
  email: string,
  fullName?: string
) {
  await invalidatePasswordResetTokens(userId);

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

  const client = (process.env.CLIENT_ORIGIN || "http://localhost:5173")
    .toString()
    .replace(/\/+$/, "");
  const resetUrl = `${client}/auth/reset-password?token=${encodeURIComponent(
    token
  )}`;

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
      role: normalizeRole(payload.role),
      ev: Number(payload.ev) || 0,
    };
  } catch {
    return null;
  }
}

function isExemptFromApproval(role: Role) {
  return role === "admin";
}

function roleLabel(role: Role | string | null | undefined) {
  const normalized = normalizeRole(role);
  return normalized === "assistant_librarian"
    ? "assistant librarian"
    : normalized;
}

function parseEmailList(value: string | undefined) {
  return String(value || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.includes("@"));
}

function uniqueEmails(values: Array<string | null | undefined>) {
  return Array.from(
    new Set(
      values
        .map((email) => String(email || "").trim().toLowerCase())
        .filter((email) => email.includes("@"))
    )
  );
}

function clientUrl(pathname = "/dashboard/librarian/users") {
  const base = (process.env.CLIENT_ORIGIN || "http://localhost:5173")
    .toString()
    .replace(/\/+$/, "");
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${base}${path}`;
}

async function getApprovalNotificationRecipients() {
  const envRecipients = uniqueEmails([
    ...parseEmailList(process.env.APPROVAL_NOTIFICATION_EMAILS),
    ...parseEmailList(process.env.ADMIN_NOTIFICATION_EMAILS),
    ...parseEmailList(process.env.LIBRARIAN_NOTIFICATION_EMAILS),
  ]);

  if (envRecipients.length > 0) return envRecipients;

  const result = await query<ApprovalNotificationRecipientRow>(
    `SELECT email, full_name, account_type, role
       FROM users
      WHERE email IS NOT NULL
        AND COALESCE(is_approved, TRUE) = TRUE
        AND (
          account_type IN ('admin', 'librarian', 'assistant_librarian')
          OR role IN ('admin', 'librarian', 'assistant_librarian')
        )
      ORDER BY
        CASE
          WHEN role = 'admin' OR account_type = 'admin' THEN 0
          WHEN role = 'librarian' OR account_type = 'librarian' THEN 1
          ELSE 2
        END,
        created_at ASC`
  );

  return uniqueEmails(result.rows.map((row) => row.email));
}

function buildPendingApprovalItemHtml(user: PendingApprovalNotificationRow) {
  const safeName = escapeHtml(user.full_name || "Unnamed user");
  const safeEmail = escapeHtml(user.email || "No email");
  const safeRole = escapeHtml(roleLabel(user.role ?? user.account_type));
  const safeStudentId = user.student_id ? escapeHtml(user.student_id) : "—";
  const safeCourse = user.course ? escapeHtml(user.course) : "—";
  const safeYear = user.year_level ? escapeHtml(user.year_level) : "—";
  const safeContact = user.contact_number ? escapeHtml(user.contact_number) : "—";
  const safeCreated = user.created_at ? escapeHtml(new Date(user.created_at).toLocaleString()) : "—";

  return `
    <tr>
      <td style="padding:10px;border-bottom:1px solid #e5e7eb;vertical-align:top;">
        <div style="font-weight:700;color:#111827;">${safeName}</div>
        <div style="font-size:12px;color:#4b5563;word-break:break-all;">${safeEmail}</div>
      </td>
      <td style="padding:10px;border-bottom:1px solid #e5e7eb;vertical-align:top;text-transform:capitalize;">${safeRole}</td>
      <td style="padding:10px;border-bottom:1px solid #e5e7eb;vertical-align:top;">
        <div>Student ID: ${safeStudentId}</div>
        <div>Course: ${safeCourse}</div>
        <div>Year: ${safeYear}</div>
        <div>Contact: ${safeContact}</div>
      </td>
      <td style="padding:10px;border-bottom:1px solid #e5e7eb;vertical-align:top;">${safeCreated}</td>
    </tr>
  `;
}

async function sendPendingApprovalNotificationEmail(
  users: PendingApprovalNotificationRow[]
) {
  if (users.length === 0) {
    return { sent: false, recipientCount: 0 };
  }

  const recipients = await getApprovalNotificationRecipients();
  if (recipients.length === 0) {
    console.warn(
      "[approval-notification] No recipients found. Set APPROVAL_NOTIFICATION_EMAILS, ADMIN_NOTIFICATION_EMAILS, or LIBRARIAN_NOTIFICATION_EMAILS."
    );
    return { sent: false, recipientCount: 0 };
  }

  const manageUrl = clientUrl("/dashboard/librarian/users");
  const safeManageUrl = escapeHtml(manageUrl);
  const count = users.length;
  const subject =
    count === 1
      ? "Account approval needed • JRMSU-TC Book-Hive"
      : `${count} account approvals needed • JRMSU-TC Book-Hive`;

  const rows = users.map(buildPendingApprovalItemHtml).join("");
  const html = `
    <div style="background:#ffffff;color:#111827;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.5;padding:24px;">
      <div style="max-width:760px;margin:0 auto;">
        <div style="font-size:18px;font-weight:800;margin-bottom:12px;">JRMSU-TC Book-Hive</div>
        <p style="margin:0 0 10px;">There ${count === 1 ? "is" : "are"} ${count} account${count === 1 ? "" : "s"} waiting for approval.</p>
        <p style="margin:0 0 16px;color:#4b5563;">Please review the pending account${count === 1 ? "" : "s"} in the librarian user management page.</p>
        <p style="margin:0 0 18px;">
          <a href="${safeManageUrl}" style="display:inline-block;padding:10px 12px;border-radius:10px;background:#111827;color:#ffffff;text-decoration:none;font-weight:700;">
            Open user approvals
          </a>
        </p>
        <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;font-size:14px;">
          <thead>
            <tr style="background:#f9fafb;">
              <th align="left" style="padding:10px;border-bottom:1px solid #e5e7eb;">User</th>
              <th align="left" style="padding:10px;border-bottom:1px solid #e5e7eb;">Role</th>
              <th align="left" style="padding:10px;border-bottom:1px solid #e5e7eb;">Details</th>
              <th align="left" style="padding:10px;border-bottom:1px solid #e5e7eb;">Registered</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="margin:18px 0 0;font-size:12px;color:#6b7280;word-break:break-all;">${safeManageUrl}</p>
      </div>
    </div>
  `.trim();

  const text = [
    `JRMSU-TC Book-Hive`,
    ``,
    `There ${count === 1 ? "is" : "are"} ${count} account${count === 1 ? "" : "s"} waiting for approval.`,
    `Open user approvals: ${manageUrl}`,
    ``,
    ...users.map(
      (user, index) =>
        `${index + 1}. ${user.full_name || "Unnamed user"} <${user.email}> - ${roleLabel(user.role ?? user.account_type)}`
    ),
  ].join("\n");

  await sendMail({
    to: recipients.join(", "),
    subject,
    html,
    text,
  });

  return { sent: true, recipientCount: recipients.length };
}

function canSendApprovalNotifications(role: Role) {
  return role === "admin" || role === "librarian" || role === "assistant_librarian";
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

    // ✅ role is authoritative for routing/guarding
    const role = getEffectiveRole(user);

    // keep whatever your DB says for account_type
    const accountType = normalizeRole(user.account_type);

    const approved = Boolean(user.is_approved);
    if (!isExemptFromApproval(role) && !approved) {
      clearSessionCookie(res);
      return res.status(403).json({
        ok: false,
        message:
          role === "librarian" || role === "assistant_librarian"
            ? "Your librarian account is pending admin approval. Please wait for an admin to approve your account before logging in."
            : "Your account is pending approval. Please wait for approval to log in.",
      });
    }

    return res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,

        accountType,
        role, // ✅ client must use this for redirects/guards

        isEmailVerified: user.is_email_verified,

        // ✅ approval status
        isApproved: Boolean(user.is_approved),
        approvedAt: user.approved_at ?? null,

        // ✅ include registration/profile info (helps settings page)
        studentId: user.student_id,
        course: user.course,
        yearLevel: user.year_level,
        contactNumber: user.contact_number,

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
      contactNumber,
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
      "assistant_librarian",
      "librarian",
      "faculty",
      "admin",
      "other",
    ];
    const normalizedAccountType = normalizeRole(accountType);
    if (!allowed.includes(normalizedAccountType)) {
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
    const contactNumberVal = cleanOptionalText(contactNumber);

    if (contactNumberVal && !isValidContactNumber(contactNumberVal)) {
      return res.status(400).json({
        ok: false,
        message: "Please enter a valid contact number.",
      });
    }

    if (normalizedAccountType === "student") {
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

    // ✅ approval logic
    const roleForApproval = normalizedAccountType;
    const approved = isExemptFromApproval(roleForApproval);

    const ins = await query<UserRow>(
      `INSERT INTO users
       (full_name, email, password_hash, account_type, student_id, course, year_level, contact_number, avatar_url, is_approved, approved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        String(fullName).trim(),
        String(email)
          .trim()
          .toLowerCase(),
        hash,
        normalizedAccountType,
        studentIdVal,
        courseVal,
        yearLevelVal,
        contactNumberVal,
        avatarUrlVal,
        approved,
        approved ? new Date() : null,
      ]
    );

    const user = ins.rows[0];

    const role = getEffectiveRole(user);
    const accountTypeNormalized = normalizeRole(user.account_type);

    // 💡 Fire-and-forget: don't block the HTTP response on SMTP latency
    createAndSendVerifyEmail(user.id, user.email, user.full_name).catch((e) => {
      console.warn("Failed creating/sending verification email:", e);
    });

    if (!approved) {
      sendPendingApprovalNotificationEmail([user]).catch((e) => {
        console.warn("Failed sending pending approval notification email:", e);
      });
    }

    return res.status(201).json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,

        accountType: accountTypeNormalized,
        role,

        isEmailVerified: user.is_email_verified,

        isApproved: Boolean(user.is_approved),
        approvedAt: user.approved_at ?? null,

        studentId: user.student_id,
        course: user.course,
        yearLevel: user.year_level,
        contactNumber: user.contact_number,

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
      return res.status(400).json({
        ok: false,
        message: "Email and password are required.",
      });
    }

    const found = await query<UserRow>(
      `SELECT * FROM users WHERE email = $1 LIMIT 1`,
      [String(email).trim().toLowerCase()]
    );

    if (!found.rowCount) {
      return res
        .status(401)
        .json({ ok: false, message: "Invalid email or password." });
    }

    const user = found.rows[0];
    const ok = await bcrypt.compare(String(password), user.password_hash);
    if (!ok) {
      return res
        .status(401)
        .json({ ok: false, message: "Invalid email or password." });
    }

    if (!user.is_email_verified) {
      return res
        .status(403)
        .json({ ok: false, message: "Please verify your email to continue." });
    }

    const role = getEffectiveRole(user);
    const accountType = normalizeRole(user.account_type);

    const approved = Boolean((user as any).is_approved);
    if (!isExemptFromApproval(role) && !approved) {
      return res.status(403).json({
        ok: false,
        message:
          role === "librarian" || role === "assistant_librarian"
            ? "Your librarian account is pending admin approval. Please wait for an admin to approve your account before logging in."
            : "Your account is pending approval. Please wait for approval to log in.",
      });
    }

    const token = signSessionJWT({
      id: user.id,
      email: user.email,
      role,
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
        role,

        isEmailVerified: user.is_email_verified,

        isApproved: Boolean((user as any).is_approved),
        approvedAt: (user as any).approved_at ?? null,

        studentId: user.student_id,
        course: user.course,
        yearLevel: user.year_level,
        contactNumber: user.contact_number,

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
    const emailRaw = String(req.body?.email ?? "").trim();
    const email = emailRaw.toLowerCase();

    if (!email || !email.includes("@")) {
      return res.status(400).json({ ok: false, message: "Please enter a valid email address." });
    }

    const found = await query<UserRow>(
      `SELECT * FROM users WHERE email = $1 LIMIT 1`,
      [email]
    );

    if (!found.rowCount) {
      return res.status(404).json({
        ok: false,
        message: "The current email is not registered. Please check the email or register first.",
      });
    }

    const user = found.rows[0];

    if (user.is_email_verified) {
      return res.status(409).json({
        ok: false,
        message: "This email is already verified. You can log in now.",
      });
    }

    await createAndSendVerifyEmail(user.id, user.email, user.full_name);

    return res.json({
      ok: true,
      message: "Verification email sent. Please check your inbox and spam folder.",
    });
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
      return res.status(400).json({ ok: false, message: "Token already used." });
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

// POST /api/auth/notify-pending-approvals
router.post("/notify-pending-approvals", async (req, res, next) => {
  try {
    const session = readSession(req);
    if (!session) {
      return res.status(401).json({ ok: false, message: "Not authenticated." });
    }

    const actorResult = await query<UserRow>(
      `SELECT * FROM users WHERE id = $1 LIMIT 1`,
      [session.sub]
    );

    if (!actorResult.rowCount) {
      return res.status(401).json({ ok: false, message: "Not authenticated." });
    }

    const actorRole = getEffectiveRole(actorResult.rows[0]);
    if (!canSendApprovalNotifications(actorRole)) {
      return res.status(403).json({ ok: false, message: "Forbidden: insufficient role." });
    }

    const pending = await query<PendingApprovalNotificationRow>(
      `SELECT id, full_name, email, account_type, role, student_id, course, year_level, contact_number, created_at
         FROM users
        WHERE COALESCE(is_approved, FALSE) = FALSE
        ORDER BY created_at DESC
        LIMIT 50`
    );

    if (!pending.rowCount) {
      return res.json({
        ok: true,
        notified: false,
        pendingCount: 0,
        recipientCount: 0,
        message: "There are no pending accounts to notify.",
      });
    }

    const result = await sendPendingApprovalNotificationEmail(pending.rows);

    return res.json({
      ok: true,
      notified: result.sent,
      pendingCount: pending.rowCount,
      recipientCount: result.recipientCount,
      message: result.sent
        ? `Pending approval notification sent to ${result.recipientCount} recipient${result.recipientCount === 1 ? "" : "s"}.`
        : "No approval notification recipients were found. Set APPROVAL_NOTIFICATION_EMAILS, ADMIN_NOTIFICATION_EMAILS, or LIBRARIAN_NOTIFICATION_EMAILS.",
    });
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
      return res.status(404).json({
        ok: false,
        message:
          "The current email is not registered. Please check the email or register first.",
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

    const usedTokenResult = await query<{
      id: string;
      user_id: string;
      token: string;
      created_at: string;
      expires_at: string;
      used_at: string | null;
    }>(
      `UPDATE password_resets
          SET used_at = NOW()
        WHERE id = (
          SELECT id
          FROM password_resets
          WHERE token = $1
            AND used_at IS NULL
            AND expires_at >= NOW()
          LIMIT 1
        )
        RETURNING id, user_id, token, created_at, expires_at, used_at`,
      [token]
    );

    if (!usedTokenResult.rowCount) {
      const tokenLookup = await query<{
        id: string;
        user_id: string;
        token: string;
        created_at: string;
        expires_at: string;
        used_at: string | null;
      }>(`SELECT * FROM password_resets WHERE token = $1 LIMIT 1`, [token]);

      if (!tokenLookup.rowCount) {
        return res.status(400).json({ ok: false, message: "Invalid token." });
      }

      const existing = tokenLookup.rows[0];
      if (existing.used_at) {
        return res
          .status(400)
          .json({ ok: false, message: "Token already used." });
      }

      return res.status(400).json({ ok: false, message: "Token expired." });
    }

    const row = usedTokenResult.rows[0];
    const hash = await bcrypt.hash(password, 10);

    await query(
      `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [hash, row.user_id]
    );

    await invalidatePasswordResetTokens(row.user_id);

    clearSessionCookie(res);

    return res.json({ ok: true, message: "Password updated." });
  } catch (err) {
    next(err);
  }
});

export default router;