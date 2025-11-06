import express from "express";
import * as bcrypt from "bcryptjs"; // <- namespace import so it works with/without esModuleInterop
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { query } from "../db";
import { sendMail } from "../email";

const router = express.Router();

type UserRow = {
  id: string;
  full_name: string;
  email: string;
  password_hash: string;
  account_type: "student" | "other";
  student_id: string | null;
  course: string | null;
  year_level: string | null;
  is_email_verified: boolean;
  created_at: string;
};

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
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7d
  });
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

  const serverUrl = process.env.SERVER_PUBLIC_URL || "http://localhost:5000";

  // We send people to an API link that verifies then redirects to your UI callback:
  const confirmUrl = `${serverUrl}/api/auth/verify-email/confirm?token=${encodeURIComponent(
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

  // If you prefer a purely client-side confirm flow, you could instead email a link like:
  // `${process.env.CLIENT_ORIGIN || "http://localhost:5173"}/auth/verify-email-callback?token=${encodeURIComponent(token)}`
}

// --- Routes ---

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
    if (accountType !== "student" && accountType !== "other") {
      return res
        .status(400)
        .json({ ok: false, message: "Invalid account type." });
    }

    // Check duplicates (email)
    const emailDupe = await query<UserRow>(
      `SELECT * FROM users WHERE email = $1 LIMIT 1`,
      [email.trim().toLowerCase()]
    );
    if (emailDupe.rowCount) {
      return res
        .status(409)
        .json({ ok: false, message: "Email already in use." });
    }

    // Student-only checks
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

    const ins = await query<UserRow>(
      `INSERT INTO users
       (full_name, email, password_hash, account_type, student_id, course, year_level)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        String(fullName).trim(),
        String(email)
          .trim()
          .toLowerCase(),
        hash,
        accountType,
        studentIdVal,
        courseVal,
        yearLevelVal,
      ]
    );

    const user = ins.rows[0];

    // Send verify email (best-effort)
    try {
      await createAndSendVerifyEmail(user.id, user.email, user.full_name);
    } catch (e) {
      console.warn("Failed sending verification email:", e);
    }

    return res.status(201).json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        accountType: user.account_type,
        isEmailVerified: user.is_email_verified,
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

    const found = await query<UserRow>(
      `SELECT * FROM users WHERE email = $1 LIMIT 1`,
      [
        String(email)
          .trim()
          .toLowerCase(),
      ]
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

    const token = signSessionJWT({
      id: user.id,
      email: user.email,
      account_type: user.account_type,
      is_email_verified: user.is_email_verified,
    });
    setSessionCookie(res, token);

    return res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        accountType: user.account_type,
        isEmailVerified: user.is_email_verified,
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
    await createAndSendVerifyEmail(user.id, user.email, user.full_name);
    res.json({ ok: true, message: "Verification email sent." });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/verify-email/confirm?token=...
router.get("/verify-email/confirm", async (req, res, next) => {
  try {
    const token = String(req.query.token || "");
    if (!token) return res.status(400).send("Missing token.");

    const t = await query<{
      id: string;
      user_id: string;
      token: string;
      expires_at: string;
      used: boolean;
    }>(`SELECT * FROM email_verifications WHERE token = $1 LIMIT 1`, [token]);

    if (!t.rowCount) return res.status(400).send("Invalid token.");
    const row = t.rows[0];

    if (row.used) return res.status(400).send("Token already used.");
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return res.status(400).send("Token expired.");
    }

    await query(`UPDATE users SET is_email_verified = TRUE WHERE id = $1`, [
      row.user_id,
    ]);
    await query(`UPDATE email_verifications SET used = TRUE WHERE id = $1`, [
      row.id,
    ]);

    const client = process.env.CLIENT_ORIGIN || "http://localhost:5173";
    const redirect = `${client}/auth/verify-email-callback?status=success`;
    res.redirect(302, redirect);
  } catch (err) {
    next(err);
  }
});

export default router;
