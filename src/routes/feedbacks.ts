import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../db";

const router = express.Router();

type Role = "student" | "librarian" | "faculty" | "admin" | "other";

type SessionPayload = {
  sub: string;
  email: string;
  role: Role;
  ev: number;
};

type UserRoleRow = {
  id: string;
  account_type: Role | string | null;
  role?: Role | string | null;
};

type FeedbackRowJoined = {
  id: string;
  user_id: string;
  book_id: string;
  rating: number;
  comment: string | null;
  created_at: string;

  // joined
  email: string | null;
  student_id: string | null;
  full_name: string | null;
  title: string | null;
};

/* ---------------- helpers (kept consistent with other routes) ---------------- */

function normalizeRole(raw: unknown): Role {
  const v = String(raw ?? "").trim().toLowerCase();

  // Common/expected
  if (v === "student") return "student";
  if (v === "librarian") return "librarian";
  if (v === "faculty") return "faculty";
  if (v === "admin") return "admin";

  // Common synonyms / legacy values
  if (v === "administrator") return "admin";
  if (v === "staff") return "librarian";
  if (v === "teacher" || v === "professor" || v === "lecturer") return "faculty";

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
  const primary = normalizeRole(row.account_type);
  const legacy = row.role != null ? normalizeRole(row.role) : undefined;

  // If primary is student/other but legacy has an elevated role, honor legacy.
  if (legacy && legacy !== "student" && (primary === "student" || primary === "other")) {
    return legacy;
  }

  // Prefer primary if it’s a recognized role (student/librarian/faculty/admin)
  if (primary !== "other") return primary;

  // Fall back to legacy if it’s known
  if (legacy) return legacy;

  // Default to student (matches your previous behavior when account_type was missing)
  return "student";
}

function requireRole(roles: Role[]) {
  // Normalize required roles too (defensive, avoids case issues if ever passed in)
  const required = roles.map(normalizeRole);

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

        if (!required.includes(effectiveRole)) {
          console.warn("[feedbacks] Forbidden", {
            userId: s.sub,
            tokenRole: s.role,
            effectiveRole,
            required,
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

function toDTO(row: FeedbackRowJoined) {
  return {
    id: String(row.id),
    userId: String(row.user_id),

    // keep existing fields
    studentEmail: row.email,
    studentId: row.student_id,

    // ✅ ADD THIS: so the UI can show full name instead of email
    studentName: row.full_name,

    bookId: String(row.book_id),
    bookTitle: row.title,
    rating: Number(row.rating),
    comment: row.comment,
    createdAt: row.created_at,
  };
}

/* ---------------- routes ---------------- */

/**
 * GET /api/feedbacks
 * List all feedbacks (librarian/admin).
 */
router.get(
  "/",
  requireAuth,
  requireRole(["librarian", "admin"]),
  async (_req, res, next) => {
    try {
      const result = await query<FeedbackRowJoined>(
        `SELECT f.id, f.user_id, f.book_id, f.rating, f.comment, f.created_at,
                u.email, u.student_id, u.full_name,
                b.title
         FROM feedbacks f
         LEFT JOIN users u ON u.id = f.user_id
         LEFT JOIN books b ON b.id = f.book_id
         ORDER BY f.created_at DESC, f.id DESC`
      );

      const feedbacks = result.rows.map(toDTO);
      res.json({ ok: true, feedbacks });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/feedbacks/my
 * List feedbacks submitted by the current authenticated user (any role).
 */
router.get(
  "/my",
  requireAuth,
  async (req, res, next) => {
    try {
      const s = (req as any).sessionUser as SessionPayload;
      const userId = Number(s.sub);

      const result = await query<FeedbackRowJoined>(
        `SELECT f.id, f.user_id, f.book_id, f.rating, f.comment, f.created_at,
                u.email, u.student_id, u.full_name,
                b.title
         FROM feedbacks f
         LEFT JOIN users u ON u.id = f.user_id
         LEFT JOIN books b ON b.id = f.book_id
         WHERE f.user_id = $1
         ORDER BY f.created_at DESC, f.id DESC`,
        [userId]
      );

      const feedbacks = result.rows.map(toDTO);
      res.json({ ok: true, feedbacks });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/feedbacks
 * Create a feedback – students (and staff) can submit.
 * Body: { bookId, rating (1..5), comment? }
 */
router.post(
  "/",
  requireAuth,
  requireRole(["student", "faculty", "librarian", "admin"]),
  async (req, res, next) => {
    try {
      const s = (req as any).sessionUser as SessionPayload;
      const { bookId, rating, comment } = req.body || {};

      const bid = Number(bookId);
      const r = Number(rating);

      if (!bid || !Number.isFinite(bid)) {
        return res.status(400).json({ ok: false, message: "bookId is required." });
      }
      if (!Number.isFinite(r) || r < 1 || r > 5) {
        return res.status(400).json({ ok: false, message: "rating must be 1..5." });
      }

      // Ensure the book exists (simple check)
      const book = await query(`SELECT id FROM books WHERE id = $1 LIMIT 1`, [bid]);
      if (!book.rowCount) {
        return res.status(404).json({ ok: false, message: "Book not found." });
      }

      const ins = await query<FeedbackRowJoined>(
        `INSERT INTO feedbacks (user_id, book_id, rating, comment)
         VALUES ($1, $2, $3, $4)
         RETURNING id, user_id, book_id, rating, comment, created_at,
                   NULL::text AS email, NULL::text AS student_id, NULL::text AS full_name,
                   NULL::text AS title`,
        [Number(s.sub), bid, r, comment ? String(comment).trim() : null]
      );

      // Hydrate joins for DTO
      const joined = await query<FeedbackRowJoined>(
        `SELECT f.id, f.user_id, f.book_id, f.rating, f.comment, f.created_at,
                u.email, u.student_id, u.full_name,
                b.title
         FROM feedbacks f
         LEFT JOIN users u ON u.id = f.user_id
         LEFT JOIN books b ON b.id = f.book_id
         WHERE f.id = $1
         LIMIT 1`,
        [ins.rows[0].id]
      );

      const feedback = toDTO(joined.rows[0]);
      res.status(201).json({ ok: true, feedback });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * DELETE /api/feedbacks/:id
 * Remove a feedback – librarian/admin only (moderation).
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

      const del = await query(`DELETE FROM feedbacks WHERE id = $1`, [rid]);
      if (!del.rowCount) {
        return res.status(404).json({ ok: false, message: "Feedback not found." });
      }

      res.json({ ok: true, message: "Feedback deleted." });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
