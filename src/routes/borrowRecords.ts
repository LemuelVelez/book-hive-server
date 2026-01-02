// src/routes/borrowRecords.ts
import express from "express";
import jwt from "jsonwebtoken";
import { pool, query } from "../db";

const router = express.Router();

type Role = "student" | "guest" | "librarian" | "faculty" | "admin" | "other";

// Include legacy "pending" plus new granular states.
type BorrowStatus =
  | "borrowed"
  | "pending"
  | "pending_pickup"
  | "pending_return"
  | "returned";

type SessionPayload = {
  sub: string;
  email: string;
  role: Role;
  ev: number;
};

type UserRoleRow = {
  id: string;
  account_type: any;
  role?: any | null;
};

type BorrowRowJoined = {
  id: string;
  user_id: string;
  book_id: string;
  borrow_date: string; // ISO date (YYYY-MM-DD)
  due_date: string; // ISO date
  return_date: string | null;
  status: BorrowStatus;
  fine: string | null; // NUMERIC from Postgres comes back as string

  // ✅ Extension tracking
  extension_count: number;
  extension_total_days: number;
  last_extension_days: number | null;
  last_extended_at: string | null; // timestamptz from PG -> ISO string
  last_extension_reason: string | null;

  // joined fields
  email: string | null;
  student_id: string | null;
  full_name: string | null;
  title: string | null;
};

/* ---------------- Helpers ---------------- */

function normalizeRole(raw: unknown): Role {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "student") return "student";
  if (v === "guest") return "guest";
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

/**
 * ✅ FIX: normalize role strings coming from DB (account_type / role)
 * so values like "Student" / "Faculty" / "Guest" don't break authorization.
 */
function computeEffectiveRoleFromRow(row: UserRoleRow): Role {
  const primary = normalizeRole(row.account_type ?? "student");
  const legacy = row.role != null ? normalizeRole(row.role) : undefined;

  // Prefer a non-student, non-other primary role (e.g. faculty/guest/librarian/admin)
  if (primary !== "student" && primary !== "other") return primary;

  // If primary is student, allow legacy to elevate (e.g. legacy faculty/guest)
  if (
    primary === "student" &&
    legacy &&
    legacy !== "student" &&
    legacy !== "other"
  ) {
    return legacy;
  }

  // If primary is "other" but legacy is valid, prefer legacy (safety for messy DB values)
  if (primary === "other" && legacy && legacy !== "other") {
    return legacy;
  }

  // Default
  return primary !== "other" ? primary : "student";
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
          console.warn("[borrow-records] Forbidden", {
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

async function getEffectiveRole(userId: string, fallback: Role): Promise<Role> {
  try {
    const roleResult = await query<UserRoleRow>(
      `SELECT id, account_type, role
         FROM users
         WHERE id = $1
         LIMIT 1`,
      [userId]
    );
    if (roleResult.rowCount) {
      return computeEffectiveRoleFromRow(roleResult.rows[0]);
    }
  } catch {
    // ignore
  }
  return fallback;
}

/**
 * Convert a DB row into the DTO the client expects.
 * - For borrowed/pending records: fine is computed dynamically from due_date and today.
 * - For returned records: we prefer the stored br.fine value (what was assessed at return time).
 */
function toDTO(row: BorrowRowJoined, finePerDay: number) {
  const due = new Date(row.due_date + "T00:00:00Z");
  const end = new Date(
    (row.return_date || new Date().toISOString().slice(0, 10)) + "T00:00:00Z"
  );
  const ms = Math.max(0, end.getTime() - due.getTime());
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  const computedFine = days * finePerDay;

  let fine: number;
  if (row.status === "returned" && row.fine != null) {
    const stored = Number(row.fine);
    fine = Number.isNaN(stored) ? computedFine : stored;
  } else {
    fine = computedFine;
  }

  return {
    id: String(row.id),
    userId: String(row.user_id),
    studentEmail: row.email,
    studentId: row.student_id,
    studentName: row.full_name,
    bookId: String(row.book_id),
    bookTitle: row.title,
    borrowDate: row.borrow_date,
    dueDate: row.due_date,
    returnDate: row.return_date,
    status: row.status,
    fine,

    // ✅ Extension info
    extensionCount:
      typeof row.extension_count === "number" && Number.isFinite(row.extension_count)
        ? row.extension_count
        : 0,
    extensionTotalDays:
      typeof row.extension_total_days === "number" &&
        Number.isFinite(row.extension_total_days)
        ? row.extension_total_days
        : 0,
    lastExtensionDays:
      typeof row.last_extension_days === "number" &&
        Number.isFinite(row.last_extension_days)
        ? row.last_extension_days
        : null,
    lastExtendedAt: row.last_extended_at ?? null,
    lastExtensionReason: row.last_extension_reason ?? null,
  };
}

/* ---------------- Routes ---------------- */

/**
 * GET /api/borrow-records
 * List all borrow records (librarian/admin).
 */
router.get(
  "/",
  requireAuth,
  requireRole(["librarian", "admin"]),
  async (_req, res, next) => {
    try {
      const finePerDay = Number(process.env.BORROW_FINE_PER_DAY || 5);

      const result = await query<BorrowRowJoined>(
        `SELECT br.id,
                br.user_id,
                br.book_id,
                br.borrow_date,
                br.due_date,
                br.return_date,
                br.status,
                br.fine,
                br.extension_count,
                br.extension_total_days,
                br.last_extension_days,
                br.last_extended_at,
                br.last_extension_reason,
                u.email,
                u.student_id,
                u.full_name,
                b.title
         FROM borrow_records br
         LEFT JOIN users u ON u.id = br.user_id
         LEFT JOIN books b ON b.id = br.book_id
         ORDER BY br.borrow_date DESC, br.id DESC`
      );

      const records = result.rows.map((r) => toDTO(r, finePerDay));
      res.json({ ok: true, records });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/borrow-records/my
 * List borrow records for the current authenticated user (any role).
 */
router.get("/my", requireAuth, async (req, res, next) => {
  try {
    const s = (req as any).sessionUser as SessionPayload;
    const userId = Number(s.sub);
    const finePerDay = Number(process.env.BORROW_FINE_PER_DAY || 5);

    const result = await query<BorrowRowJoined>(
      `SELECT br.id,
              br.user_id,
              br.book_id,
              br.borrow_date,
              br.due_date,
              br.return_date,
              br.status,
              br.fine,
              br.extension_count,
              br.extension_total_days,
              br.last_extension_days,
              br.last_extended_at,
              br.last_extension_reason,
              u.email,
              u.student_id,
              u.full_name,
              b.title
       FROM borrow_records br
       LEFT JOIN users u ON u.id = br.user_id
       LEFT JOIN books b ON b.id = br.book_id
       WHERE br.user_id = $1
       ORDER BY br.borrow_date DESC, br.id DESC`,
      [userId]
    );

    const records = result.rows.map((r) => toDTO(r, finePerDay));
    res.json({ ok: true, records });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/borrow-records/:id/extend
 * Student/Guest/Faculty can request an extension (self-service) that immediately
 * extends the due date by N days.
 *
 * Body: { days: number, reason?: string }
 * Also accepts: { extendDays } / { additionalDays }
 *
 * Rules:
 * - Must be the owner of the borrow record (unless librarian/admin).
 * - Only allowed when status is "borrowed".
 * - Cannot extend returned / pending_return records.
 * - Optional caps:
 *   - BORROW_EXTENSION_MAX_DAYS_PER_REQUEST (default 30)
 *   - BORROW_EXTENSION_MAX_TOTAL_DAYS (default 30)
 */
router.post("/:id/extend", requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const session = (req as any).sessionUser as SessionPayload;
    const effectiveRole = await getEffectiveRole(session.sub, session.role);

    const { id } = req.params;
    const rid = Number(id);
    if (!rid) {
      return res.status(400).json({ ok: false, message: "Invalid id." });
    }

    const rawDays =
      (req.body || {}).days ??
      (req.body || {}).extendDays ??
      (req.body || {}).additionalDays;

    const daysToExtend = Math.floor(Number(rawDays));

    if (!Number.isFinite(daysToExtend) || daysToExtend <= 0) {
      return res.status(400).json({
        ok: false,
        message: "days must be a positive number.",
      });
    }

    const reason =
      (req.body || {}).reason !== undefined && (req.body || {}).reason !== null
        ? String((req.body || {}).reason).trim()
        : null;

    const maxPerRequest = Math.floor(
      Number(process.env.BORROW_EXTENSION_MAX_DAYS_PER_REQUEST ?? 30)
    );
    const maxTotal = Math.floor(
      Number(process.env.BORROW_EXTENSION_MAX_TOTAL_DAYS ?? 30)
    );

    if (
      Number.isFinite(maxPerRequest) &&
      maxPerRequest > 0 &&
      daysToExtend > maxPerRequest
    ) {
      return res.status(400).json({
        ok: false,
        message: `days cannot exceed ${maxPerRequest} per request.`,
      });
    }

    await client.query("BEGIN");

    const cur = await client.query<{
      id: number;
      user_id: number;
      status: BorrowStatus;
      return_date: string | null;
      extension_total_days: number;
    }>(
      `SELECT id, user_id, status, return_date, extension_total_days
         FROM borrow_records
         WHERE id = $1
         FOR UPDATE`,
      [rid]
    );

    if (!cur.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, message: "Record not found." });
    }

    const current = cur.rows[0];

    const isOwner = Number(current.user_id) === Number(session.sub);
    const isAdminLike = effectiveRole === "librarian" || effectiveRole === "admin";

    // Only student/guest/faculty can self-request (adminlike can do anything)
    const allowedSelfRoles: Role[] = ["student", "guest", "faculty"];
    if (!isAdminLike && !allowedSelfRoles.includes(effectiveRole)) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        ok: false,
        message: "Forbidden: your role cannot request a due date extension.",
      });
    }

    if (!isAdminLike && !isOwner) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        ok: false,
        message: "Forbidden: cannot extend a record you do not own.",
      });
    }

    // ✅ Check "returned/pending_return" BEFORE narrowing to "borrowed"
    if (current.return_date || current.status === "returned") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        message: "Cannot extend a record that is already returned.",
      });
    }

    if (current.status === "pending_return") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        message: "Cannot extend a record that is pending return.",
      });
    }

    // Only borrowed can be extended
    if (current.status !== "borrowed") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        message: "Only records with status 'borrowed' can be extended.",
      });
    }

    const prevTotal =
      typeof current.extension_total_days === "number" &&
        Number.isFinite(current.extension_total_days)
        ? current.extension_total_days
        : 0;

    if (
      Number.isFinite(maxTotal) &&
      maxTotal > 0 &&
      prevTotal + daysToExtend > maxTotal
    ) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        message: `Total extensions cannot exceed ${maxTotal} days.`,
      });
    }

    /**
     * ✅ FIX (YOUR 500 ERROR):
     * Postgres can treat $1 as "unknown", and for `date + unknown` there are multiple
     * candidate operators (date+int, date+interval) -> "operator is not unique".
     * We force the parameter type using ::int.
     */
    await client.query(
      `UPDATE borrow_records
         SET due_date = due_date + ($1::int),
             extension_count = extension_count + 1,
             extension_total_days = extension_total_days + ($1::int),
             last_extension_days = ($1::int),
             last_extended_at = NOW(),
             last_extension_reason = $2,
             updated_at = NOW()
       WHERE id = $3`,
      [daysToExtend, reason, rid]
    );

    await client.query("COMMIT");

    const finePerDay = Number(process.env.BORROW_FINE_PER_DAY || 5);
    const joined = await query<BorrowRowJoined>(
      `SELECT br.id,
              br.user_id,
              br.book_id,
              br.borrow_date,
              br.due_date,
              br.return_date,
              br.status,
              br.fine,
              br.extension_count,
              br.extension_total_days,
              br.last_extension_days,
              br.last_extended_at,
              br.last_extension_reason,
              u.email,
              u.student_id,
              u.full_name,
              b.title
       FROM borrow_records br
       LEFT JOIN users u ON u.id = br.user_id
       LEFT JOIN books b ON b.id = br.book_id
       WHERE br.id = $1
       LIMIT 1`,
      [rid]
    );

    const record = toDTO(joined.rows[0], finePerDay);
    res.json({ ok: true, record });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    next(err);
  } finally {
    client.release();
  }
});

/**
 * POST /api/borrow-records
 * Create a borrow record and set book unavailable (transaction).
 * Body: { userId, bookId, borrowDate?, dueDate }
 * (librarian/admin only)
 *
 * These are typically in-person transactions, so we mark them as "borrowed".
 */
router.post(
  "/",
  requireAuth,
  requireRole(["librarian", "admin"]),
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const { userId, bookId, borrowDate, dueDate } = req.body || {};
      const uid = Number(userId);
      const bid = Number(bookId);

      if (!uid || !bid || !dueDate) {
        return res.status(400).json({
          ok: false,
          message: "userId, bookId and dueDate are required.",
        });
      }

      await client.query("BEGIN");

      // Validate user
      const u = await client.query(`SELECT id FROM users WHERE id=$1 LIMIT 1`, [
        uid,
      ]);
      if (!u.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ ok: false, message: "User not found." });
      }

      // Validate book availability
      const b = await client.query(
        `SELECT id, available FROM books WHERE id=$1 LIMIT 1`,
        [bid]
      );
      if (!b.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ ok: false, message: "Book not found." });
      }
      if (b.rows[0].available === false) {
        await client.query("ROLLBACK");
        return res
          .status(409)
          .json({ ok: false, message: "Book is not available." });
      }

      const ins = await client.query<{ id: string }>(
        `INSERT INTO borrow_records (user_id, book_id, borrow_date, due_date, status)
         VALUES ($1,$2, COALESCE($3::date, CURRENT_DATE), $4::date, 'borrowed')
         RETURNING id`,
        [uid, bid, borrowDate || null, dueDate]
      );

      // Set book unavailable
      await client.query(
        `UPDATE books SET available = FALSE, updated_at = NOW() WHERE id = $1`,
        [bid]
      );

      await client.query("COMMIT");

      // Hydrate joins for DTO
      const finePerDay = Number(process.env.BORROW_FINE_PER_DAY || 5);
      const joined = await query<BorrowRowJoined>(
        `SELECT br.id,
                br.user_id,
                br.book_id,
                br.borrow_date,
                br.due_date,
                br.return_date,
                br.status,
                br.fine,
                br.extension_count,
                br.extension_total_days,
                br.last_extension_days,
                br.last_extended_at,
                br.last_extension_reason,
                u.email,
                u.student_id,
                u.full_name,
                b.title
         FROM borrow_records br
         LEFT JOIN users u ON u.id = br.user_id
         LEFT JOIN books b ON b.id = br.book_id
         WHERE br.id = $1
         LIMIT 1`,
        [ins.rows[0].id]
      );

      const record = toDTO(joined.rows[0], finePerDay);
      res.status(201).json({ ok: true, record });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      next(err);
    } finally {
      client.release();
    }
  }
);

/**
 * POST /api/borrow-records/self
 * Current user (typically student) borrows a book online.
 * Body: { bookId }
 * - userId is taken from the session.
 * - borrow_date = today
 * - due_date = today + per-book borrow_duration_days (fallback BORROW_DAYS, default 7)
 * - Marks the book as unavailable.
 * - Status starts as "pending_pickup" so a librarian can confirm pickup.
 */
router.post("/self", requireAuth, async (req, res, next) => {
  const s = (req as any).sessionUser as SessionPayload;
  const userId = Number(s.sub);
  const { bookId } = req.body || {};
  const bid = Number(bookId);

  if (!bid) {
    return res.status(400).json({ ok: false, message: "bookId is required." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Validate user exists
    const u = await client.query(`SELECT id FROM users WHERE id=$1 LIMIT 1`, [
      userId,
    ]);
    if (!u.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, message: "User not found." });
    }

    // Validate book availability + get per-book duration
    const b = await client.query<{
      id: number;
      available: boolean;
      borrow_duration_days: number | null;
    }>(
      `SELECT id, available, borrow_duration_days
         FROM books
         WHERE id = $1
         LIMIT 1`,
      [bid]
    );
    if (!b.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, message: "Book not found." });
    }
    if (b.rows[0].available === false) {
      await client.query("ROLLBACK");
      return res
        .status(409)
        .json({ ok: false, message: "Book is not available." });
    }

    const today = new Date();

    let borrowDays = Number(
      b.rows[0].borrow_duration_days ?? process.env.BORROW_DAYS ?? 7
    );
    if (!Number.isFinite(borrowDays) || borrowDays <= 0) {
      borrowDays = 7;
    } else {
      borrowDays = Math.floor(borrowDays);
    }

    const due = new Date(today);
    due.setDate(due.getDate() + borrowDays);

    const borrowDateStr = today.toISOString().slice(0, 10);
    const dueDateStr = due.toISOString().slice(0, 10);

    const ins = await client.query<{ id: string }>(
      `INSERT INTO borrow_records (user_id, book_id, borrow_date, due_date, status)
         VALUES ($1,$2,$3::date,$4::date,'pending_pickup')
         RETURNING id`,
      [userId, bid, borrowDateStr, dueDateStr]
    );

    // Set book unavailable for student self-borrow as well
    await client.query(
      `UPDATE books SET available = FALSE, updated_at = NOW() WHERE id = $1`,
      [bid]
    );

    await client.query("COMMIT");

    // Hydrate joins for DTO
    const finePerDay = Number(process.env.BORROW_FINE_PER_DAY || 5);
    const joined = await query<BorrowRowJoined>(
      `SELECT br.id,
              br.user_id,
              br.book_id,
              br.borrow_date,
              br.due_date,
              br.return_date,
              br.status,
              br.fine,
              br.extension_count,
              br.extension_total_days,
              br.last_extension_days,
              br.last_extended_at,
              br.last_extension_reason,
              u.email,
              u.student_id,
              u.full_name,
              b.title
       FROM borrow_records br
       LEFT JOIN users u ON u.id = br.user_id
       LEFT JOIN books b ON b.id = br.book_id
       WHERE br.id = $1
       LIMIT 1`,
      [ins.rows[0].id]
    );

    const record = toDTO(joined.rows[0], finePerDay);
    res.status(201).json({ ok: true, record });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    next(err);
  } finally {
    client.release();
  }
});

/**
 * PATCH /api/borrow-records/:id
 * Update status/return date/due date/fine.
 */
router.patch("/:id", requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const rid = Number(id);
    const { status, returnDate, dueDate, fine } = req.body || {};

    if (!rid) {
      return res.status(400).json({ ok: false, message: "Invalid id." });
    }

    const session = (req as any).sessionUser as SessionPayload;

    await client.query("BEGIN");

    const cur = await client.query<{
      book_id: number;
      status: BorrowStatus;
      user_id: number;
    }>(
      `SELECT book_id, status, user_id
           FROM borrow_records
           WHERE id = $1
           FOR UPDATE`,
      [rid]
    );

    if (!cur.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, message: "Record not found." });
    }

    const current = cur.rows[0];

    // Determine effective role from DB
    let effectiveRole: Role = session.role;
    try {
      const roleResult = await query<UserRoleRow>(
        `SELECT id, account_type, role
             FROM users
             WHERE id = $1
             LIMIT 1`,
        [session.sub]
      );
      if (roleResult.rowCount) {
        effectiveRole = computeEffectiveRoleFromRow(roleResult.rows[0]);
      }
    } catch {
      // ignore
    }

    const isOwner = Number(current.user_id) === Number(session.sub);
    const isAdminLike = effectiveRole === "librarian" || effectiveRole === "admin";

    if (!isOwner && !isAdminLike) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        ok: false,
        message: "Forbidden: cannot modify this borrow record.",
      });
    }

    // Extra safety: students cannot finalize returns or set return/due date or fine
    if (!isAdminLike) {
      const desiredStatus =
        status !== undefined ? String(status).toLowerCase() : undefined;

      if (
        desiredStatus &&
        desiredStatus !== "pending" &&
        desiredStatus !== "pending_return"
      ) {
        await client.query("ROLLBACK");
        return res.status(403).json({
          ok: false,
          message:
            "Only librarians can change the borrow status. Your online action should create a pending return request.",
        });
      }

      if (returnDate !== undefined) {
        await client.query("ROLLBACK");
        return res.status(403).json({
          ok: false,
          message: "Only librarians can set the return date.",
        });
      }

      if (dueDate !== undefined || fine !== undefined) {
        await client.query("ROLLBACK");
        return res.status(403).json({
          ok: false,
          message:
            "Only librarians can change the due date or finalize the fine amount.",
        });
      }
    }

    const updates: string[] = [];
    const values: any[] = [];
    let i = 1;

    if (status !== undefined) {
      const sVal = String(status).toLowerCase() as BorrowStatus;

      const allowedStatuses: BorrowStatus[] = [
        "borrowed",
        "pending",
        "pending_pickup",
        "pending_return",
        "returned",
      ];

      if (!allowedStatuses.includes(sVal)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ ok: false, message: "Invalid status." });
      }

      updates.push(`status = $${i++}`);
      values.push(sVal);
    }

    if (returnDate !== undefined) {
      updates.push(`return_date = $${i++}::date`);
      values.push(returnDate ? String(returnDate) : null);
    }

    if (dueDate !== undefined) {
      if (!dueDate) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ ok: false, message: "dueDate cannot be empty." });
      }
      updates.push(`due_date = $${i++}::date`);
      values.push(String(dueDate));
    }

    if (updates.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, message: "No changes provided." });
    }

    updates.push(`updated_at = NOW()`);

    const upd = await client.query<BorrowRowJoined>(
      `UPDATE borrow_records
         SET ${updates.join(", ")}
         WHERE id = $${i}
         RETURNING id,
                   user_id,
                   book_id,
                   borrow_date,
                   due_date,
                   return_date,
                   status,
                   fine,
                   extension_count,
                   extension_total_days,
                   last_extension_days,
                   last_extended_at,
                   last_extension_reason,
                   NULL::text AS email,
                   NULL::text AS student_id,
                   NULL::text AS full_name,
                   NULL::text AS title`,
      [...values, rid]
    );

    const updatedRow = upd.rows[0];

    const newStatus: BorrowStatus =
      status !== undefined
        ? (String(status).toLowerCase() as BorrowStatus)
        : current.status;

    if (newStatus === "returned") {
      await client.query(
        `UPDATE books SET available = TRUE, updated_at = NOW() WHERE id = $1`,
        [updatedRow.book_id]
      );

      const finePerDay = Number(process.env.BORROW_FINE_PER_DAY || 5);

      const due = new Date(updatedRow.due_date + "T00:00:00Z");
      const end = new Date(
        (updatedRow.return_date || new Date().toISOString().slice(0, 10)) +
        "T00:00:00Z"
      );
      const ms = Math.max(0, end.getTime() - due.getTime());
      const days = Math.floor(ms / (1000 * 60 * 60 * 24));
      const computedFine = days * finePerDay;

      let finalFine = computedFine;
      if (fine !== undefined) {
        const parsedFine = Number(fine);
        if (!Number.isNaN(parsedFine) && parsedFine >= 0) {
          finalFine = parsedFine;
        }
      }

      await client.query(
        `UPDATE borrow_records
             SET fine = $1, updated_at = NOW()
           WHERE id = $2`,
        [finalFine, rid]
      );

      if (finalFine > 0) {
        await client.query(
          `INSERT INTO fines (user_id, borrow_record_id, amount, status, reason)
             VALUES ($1, $2, $3, 'active', $4)
             ON CONFLICT (borrow_record_id) WHERE borrow_record_id IS NOT NULL DO UPDATE
               SET amount = EXCLUDED.amount,
                   status = 'active',
                   reason = EXCLUDED.reason,
                   resolved_at = NULL,
                   updated_at = NOW()`,
          [
            current.user_id,
            rid,
            finalFine,
            `Overdue fine for borrow record #${rid}`,
          ]
        );
      } else {
        await client.query(
          `UPDATE fines
             SET amount = 0,
                 status = 'cancelled',
                 resolved_at = NOW(),
                 updated_at = NOW()
           WHERE borrow_record_id = $1`,
          [rid]
        );
      }
    }

    await client.query("COMMIT");

    const finePerDay = Number(process.env.BORROW_FINE_PER_DAY || 5);
    const joined = await query<BorrowRowJoined>(
      `SELECT br.id,
              br.user_id,
              br.book_id,
              br.borrow_date,
              br.due_date,
              br.return_date,
              br.status,
              br.fine,
              br.extension_count,
              br.extension_total_days,
              br.last_extension_days,
              br.last_extended_at,
              br.last_extension_reason,
              u.email,
              u.student_id,
              u.full_name,
              b.title
       FROM borrow_records br
       LEFT JOIN users u ON u.id = br.user_id
       LEFT JOIN books b ON b.id = br.book_id
       WHERE br.id = $1
       LIMIT 1`,
      [rid]
    );

    const record = toDTO(joined.rows[0], finePerDay);
    res.json({ ok: true, record });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    next(err);
  } finally {
    client.release();
  }
});

export default router;
