import express from "express";
import jwt from "jsonwebtoken";
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

type NotificationRecipientRow = {
  email: string | null;
  full_name: string | null;
  account_type: Role | string | null;
  role?: Role | string | null;
};

/* ---------------- helpers (kept consistent with other routes) ---------------- */

function normalizeRole(raw: unknown): Role {
  const v = String(raw ?? "").trim().toLowerCase();

  // Common/expected
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

function escapeHtml(input: string) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

function clientUrl(pathname = "/dashboard/librarian/feedbacks") {
  const base = (process.env.CLIENT_ORIGIN || "http://localhost:5173")
    .toString()
    .replace(/\/+$/, "");
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${base}${path}`;
}

function feedbackAuthorName(feedback: ReturnType<typeof toDTO>) {
  return (
    feedback.studentName ||
    feedback.studentEmail ||
    feedback.studentId ||
    `User #${feedback.userId}`
  );
}

async function getFeedbackNotificationRecipients() {
  const envRecipients = uniqueEmails([
    ...parseEmailList(process.env.FEEDBACK_NOTIFICATION_EMAILS),
    ...parseEmailList(process.env.LIBRARIAN_NOTIFICATION_EMAILS),
    ...parseEmailList(process.env.ADMIN_NOTIFICATION_EMAILS),
  ]);

  if (envRecipients.length > 0) return envRecipients;

  const result = await query<NotificationRecipientRow>(
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

function buildFeedbackRowHtml(feedback: ReturnType<typeof toDTO>) {
  const safeUser = escapeHtml(feedbackAuthorName(feedback));
  const safeBook = escapeHtml(feedback.bookTitle || `Book #${feedback.bookId}`);
  const safeRating = escapeHtml(`${feedback.rating}/5`);
  const safeComment = escapeHtml(feedback.comment || "—");
  const safeCreated = feedback.createdAt
    ? escapeHtml(new Date(feedback.createdAt).toLocaleString())
    : "—";

  return `
    <tr>
      <td style="padding:10px;border-bottom:1px solid #e5e7eb;vertical-align:top;">${safeUser}</td>
      <td style="padding:10px;border-bottom:1px solid #e5e7eb;vertical-align:top;">${safeBook}</td>
      <td style="padding:10px;border-bottom:1px solid #e5e7eb;vertical-align:top;white-space:nowrap;">${safeRating}</td>
      <td style="padding:10px;border-bottom:1px solid #e5e7eb;vertical-align:top;">${safeComment}</td>
      <td style="padding:10px;border-bottom:1px solid #e5e7eb;vertical-align:top;white-space:nowrap;">${safeCreated}</td>
    </tr>
  `;
}

async function sendFeedbackNotificationEmail(
  feedbacks: Array<ReturnType<typeof toDTO>>
) {
  if (feedbacks.length === 0) {
    return { sent: false, recipientCount: 0 };
  }

  const recipients = await getFeedbackNotificationRecipients();
  if (recipients.length === 0) {
    console.warn(
      "[feedback-notification] No recipients found. Set FEEDBACK_NOTIFICATION_EMAILS, LIBRARIAN_NOTIFICATION_EMAILS, or ADMIN_NOTIFICATION_EMAILS."
    );
    return { sent: false, recipientCount: 0 };
  }

  const feedbacksUrl = clientUrl("/dashboard/librarian/feedbacks");
  const safeFeedbacksUrl = escapeHtml(feedbacksUrl);
  const count = feedbacks.length;
  const subject =
    count === 1
      ? "New book feedback submitted • JRMSU-TC Book-Hive"
      : `${count} recent book feedbacks • JRMSU-TC Book-Hive`;

  const rows = feedbacks.map(buildFeedbackRowHtml).join("");
  const html = `
    <div style="background:#ffffff;color:#111827;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.5;padding:24px;">
      <div style="max-width:820px;margin:0 auto;">
        <div style="font-size:18px;font-weight:800;margin-bottom:12px;">JRMSU-TC Book-Hive</div>
        <p style="margin:0 0 10px;">There ${count === 1 ? "is" : "are"} ${count} book feedback${count === 1 ? "" : "s"} needing review.</p>
        <p style="margin:0 0 16px;color:#4b5563;">Open the librarian feedback page to review user comments and ratings.</p>
        <p style="margin:0 0 18px;">
          <a href="${safeFeedbacksUrl}" style="display:inline-block;padding:10px 12px;border-radius:10px;background:#111827;color:#ffffff;text-decoration:none;font-weight:700;">
            Open feedbacks
          </a>
        </p>
        <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;font-size:14px;">
          <thead>
            <tr style="background:#f9fafb;">
              <th align="left" style="padding:10px;border-bottom:1px solid #e5e7eb;">User</th>
              <th align="left" style="padding:10px;border-bottom:1px solid #e5e7eb;">Book</th>
              <th align="left" style="padding:10px;border-bottom:1px solid #e5e7eb;">Rating</th>
              <th align="left" style="padding:10px;border-bottom:1px solid #e5e7eb;">Comment</th>
              <th align="left" style="padding:10px;border-bottom:1px solid #e5e7eb;">Submitted</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="margin:18px 0 0;font-size:12px;color:#6b7280;word-break:break-all;">${safeFeedbacksUrl}</p>
      </div>
    </div>
  `.trim();

  const text = [
    `JRMSU-TC Book-Hive`,
    ``,
    `There ${count === 1 ? "is" : "are"} ${count} book feedback${count === 1 ? "" : "s"} needing review.`,
    `Open feedbacks: ${feedbacksUrl}`,
    ``,
    ...feedbacks.map(
      (feedback, index) =>
        `${index + 1}. ${feedbackAuthorName(feedback)} - ${feedback.bookTitle || `Book #${feedback.bookId}`} - ${feedback.rating}/5 - ${feedback.comment || "No comment"}`
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

      sendFeedbackNotificationEmail([feedback]).catch((e) => {
        console.warn("Failed sending feedback notification email:", e);
      });

      res.status(201).json({ ok: true, feedback });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/feedbacks/notify-librarians
 * Send a recent feedback email notification – librarian/admin only.
 */
router.post(
  "/notify-librarians",
  requireAuth,
  requireRole(["librarian", "admin"]),
  async (req, res, next) => {
    try {
      const requestedLimit = Number(req.body?.limit ?? 20);
      const limit = Number.isFinite(requestedLimit)
        ? Math.min(Math.max(Math.round(requestedLimit), 1), 50)
        : 20;

      const result = await query<FeedbackRowJoined>(
        `SELECT f.id, f.user_id, f.book_id, f.rating, f.comment, f.created_at,
                u.email, u.student_id, u.full_name,
                b.title
         FROM feedbacks f
         LEFT JOIN users u ON u.id = f.user_id
         LEFT JOIN books b ON b.id = f.book_id
         ORDER BY f.created_at DESC, f.id DESC
         LIMIT $1`,
        [limit]
      );

      if (!result.rowCount) {
        return res.json({
          ok: true,
          notified: false,
          feedbackCount: 0,
          recipientCount: 0,
          message: "There are no feedbacks to notify.",
        });
      }

      const feedbacks = result.rows.map(toDTO);
      const sendResult = await sendFeedbackNotificationEmail(feedbacks);

      return res.json({
        ok: true,
        notified: sendResult.sent,
        feedbackCount: feedbacks.length,
        recipientCount: sendResult.recipientCount,
        message: sendResult.sent
          ? `Feedback notification sent to ${sendResult.recipientCount} recipient${sendResult.recipientCount === 1 ? "" : "s"}.`
          : "No feedback notification recipients were found. Set FEEDBACK_NOTIFICATION_EMAILS, LIBRARIAN_NOTIFICATION_EMAILS, or ADMIN_NOTIFICATION_EMAILS.",
      });
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