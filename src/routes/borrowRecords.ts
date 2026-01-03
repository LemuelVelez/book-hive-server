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

type ExtensionRequestStatus = "none" | "pending" | "approved" | "disapproved";

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

  // ✅ Extension tracking (approved extensions)
  extension_count: number;
  extension_total_days: number;
  last_extension_days: number | null;
  last_extended_at: string | null; // timestamptz from PG -> ISO string
  last_extension_reason: string | null;

  // ✅ Extension approval workflow (requested extensions)
  extension_request_status: ExtensionRequestStatus;
  extension_requested_days: number | null;
  extension_requested_at: string | null;
  extension_requested_reason: string | null;
  extension_decided_at: string | null;
  extension_decided_by: number | null;
  extension_decision_note: string | null;

  // joined fields
  email: string | null;
  student_id: string | null;
  full_name: string | null;
  title: string | null;
};

/* ---------------- ✅ FIX TS2347: Typed DB wrappers ---------------- */

type DBQueryResult<T> = { rowCount: number; rows: T[] };
type DBQueryFn = <T = any>(
  text: string,
  params?: any[]
) => Promise<DBQueryResult<T>>;

type DBClient = {
  query: DBQueryFn;
  release: () => void;
};

type DBPool = {
  connect: () => Promise<DBClient>;
};

// Cast untyped imports into typed wrappers (prevents TS2347)
const dbQuery = query as unknown as DBQueryFn;
const dbPool = pool as unknown as DBPool;

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

    dbQuery<UserRoleRow>(
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
    const roleResult = await dbQuery<UserRoleRow>(
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

async function fetchBorrowRecordJoined(
  recordId: number
): Promise<BorrowRowJoined | null> {
  const joined = await dbQuery<BorrowRowJoined>(
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

            br.extension_request_status,
            br.extension_requested_days,
            br.extension_requested_at,
            br.extension_requested_reason,
            br.extension_decided_at,
            br.extension_decided_by,
            br.extension_decision_note,

            u.email,
            u.student_id,
            u.full_name,
            b.title
     FROM borrow_records br
     LEFT JOIN users u ON u.id = br.user_id
     LEFT JOIN books b ON b.id = br.book_id
     WHERE br.id = $1
     LIMIT 1`,
    [recordId]
  );

  return joined.rowCount ? joined.rows[0] : null;
}

async function fetchBorrowRecordsJoined(
  recordIds: number[]
): Promise<BorrowRowJoined[]> {
  if (!recordIds.length) return [];
  const joined = await dbQuery<BorrowRowJoined>(
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

            br.extension_request_status,
            br.extension_requested_days,
            br.extension_requested_at,
            br.extension_requested_reason,
            br.extension_decided_at,
            br.extension_decided_by,
            br.extension_decision_note,

            u.email,
            u.student_id,
            u.full_name,
            b.title
     FROM borrow_records br
     LEFT JOIN users u ON u.id = br.user_id
     LEFT JOIN books b ON b.id = br.book_id
     WHERE br.id = ANY($1::int[])
     ORDER BY br.id ASC`,
    [recordIds]
  );
  return joined.rows;
}

/**
 * ✅ Recompute book availability based on:
 * available = (activeBorrowCount < number_of_copies)
 * activeBorrowCount = borrow_records where status <> 'returned'
 */
async function recomputeAndUpdateBookAvailability(
  client: DBClient,
  bookId: number
): Promise<void> {
  const b = await client.query<{
    id: number;
    number_of_copies: number | null;
  }>(
    `SELECT id, number_of_copies
       FROM books
       WHERE id = $1
       FOR UPDATE`,
    [bookId]
  );

  if (!b.rowCount) return;

  const copies =
    typeof b.rows[0].number_of_copies === "number" &&
      Number.isFinite(b.rows[0].number_of_copies) &&
      b.rows[0].number_of_copies! > 0
      ? Math.floor(b.rows[0].number_of_copies!)
      : 1;

  const activeRes = await client.query<{ active_count: number }>(
    `SELECT COUNT(*)::int AS active_count
       FROM borrow_records
       WHERE book_id = $1
         AND status <> 'returned'`,
    [bookId]
  );

  const active =
    typeof activeRes.rows[0]?.active_count === "number" &&
      Number.isFinite(activeRes.rows[0].active_count)
      ? activeRes.rows[0].active_count
      : 0;

  const available = active < copies;

  await client.query(
    `UPDATE books
        SET available = $1,
            updated_at = NOW()
      WHERE id = $2`,
    [available, bookId]
  );
}

/**
 * ✅ Parse how many copies user wants to borrow in a single action.
 * We keep DB schema unchanged by creating 1 borrow_record per copy.
 */
function parseBorrowQuantity(body: any): number {
  const raw =
    body?.quantity ??
    body?.qty ??
    body?.copies ??
    body?.count ??
    body?.copiesToBorrow;

  if (raw === undefined || raw === null || raw === "") return 1;

  const q = Math.floor(Number(raw));
  if (!Number.isFinite(q) || q <= 0) return 1;

  // Safety cap (optional)
  const cap = Math.floor(Number(process.env.BORROW_MAX_COPIES_PER_ACTION ?? 10));
  const maxAllowed = Number.isFinite(cap) && cap > 0 ? cap : 10;

  return Math.min(q, maxAllowed);
}

/**
 * Convert a DB row into the DTO the client expects.
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

  const safeReqStatus = ((): ExtensionRequestStatus => {
    const v = String(row.extension_request_status ?? "none").toLowerCase();
    if (v === "pending") return "pending";
    if (v === "approved") return "approved";
    if (v === "disapproved") return "disapproved";
    return "none";
  })();

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

    extensionRequestStatus: safeReqStatus,
    extensionRequestedDays:
      typeof row.extension_requested_days === "number" &&
        Number.isFinite(row.extension_requested_days)
        ? row.extension_requested_days
        : null,
    extensionRequestedAt: row.extension_requested_at ?? null,
    extensionRequestedReason: row.extension_requested_reason ?? null,
    extensionDecidedAt: row.extension_decided_at ?? null,
    extensionDecidedBy:
      typeof row.extension_decided_by === "number" &&
        Number.isFinite(row.extension_decided_by)
        ? row.extension_decided_by
        : null,
    extensionDecisionNote: row.extension_decision_note ?? null,
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

      const result = await dbQuery<BorrowRowJoined>(
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

                br.extension_request_status,
                br.extension_requested_days,
                br.extension_requested_at,
                br.extension_requested_reason,
                br.extension_decided_at,
                br.extension_decided_by,
                br.extension_decision_note,

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

    const result = await dbQuery<BorrowRowJoined>(
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

              br.extension_request_status,
              br.extension_requested_days,
              br.extension_requested_at,
              br.extension_requested_reason,
              br.extension_decided_at,
              br.extension_decided_by,
              br.extension_decision_note,

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
 * (unchanged)
 */
router.post("/:id/extend", requireAuth, async (req, res, next) => {
  const client = await dbPool.connect();
  try {
    const session = (req as any).sessionUser as SessionPayload;
    const effectiveRole = await getEffectiveRole(session.sub, session.role);
    const isAdminLike = effectiveRole === "librarian" || effectiveRole === "admin";

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
      extension_request_status: ExtensionRequestStatus | null;
    }>(
      `SELECT id,
              user_id,
              status,
              return_date,
              extension_total_days,
              extension_request_status
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

    const isOwner = Number(current.user_id) === Number(session.sub);

    if (!isAdminLike) {
      const allowedSelfRoles: Role[] = ["student", "guest", "faculty"];
      if (!allowedSelfRoles.includes(effectiveRole)) {
        await client.query("ROLLBACK");
        return res.status(403).json({
          ok: false,
          message: "Forbidden: your role cannot request a due date extension.",
        });
      }

      if (!isOwner) {
        await client.query("ROLLBACK");
        return res.status(403).json({
          ok: false,
          message: "Forbidden: cannot extend a record you do not own.",
        });
      }

      const reqStatus = String(current.extension_request_status ?? "none").toLowerCase();
      if (reqStatus === "pending") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          message: "An extension request is already pending for this record.",
        });
      }

      await client.query(
        `UPDATE borrow_records
           SET extension_request_status = 'pending',
               extension_requested_days = ($1::int),
               extension_requested_at = NOW(),
               extension_requested_reason = $2,
               extension_decided_at = NULL,
               extension_decided_by = NULL,
               extension_decision_note = NULL,
               updated_at = NOW()
         WHERE id = $3`,
        [daysToExtend, reason, rid]
      );

      await client.query("COMMIT");

      const finePerDay = Number(process.env.BORROW_FINE_PER_DAY || 5);
      const joinedRow = await fetchBorrowRecordJoined(rid);
      if (!joinedRow) {
        return res.status(404).json({ ok: false, message: "Record not found." });
      }
      const record = toDTO(joinedRow, finePerDay);
      return res.json({
        ok: true,
        record,
        message: "Extension request submitted for approval.",
      });
    }

    const decidedByNum = Number(session.sub);
    const decidedBy = Number.isFinite(decidedByNum) ? decidedByNum : null;

    await client.query(
      `UPDATE borrow_records
         SET due_date = due_date + ($1::int),
             extension_count = extension_count + 1,
             extension_total_days = extension_total_days + ($1::int),
             last_extension_days = ($1::int),
             last_extended_at = NOW(),
             last_extension_reason = $2,

             extension_request_status = 'approved',
             extension_requested_days = ($1::int),
             extension_requested_at = NOW(),
             extension_requested_reason = $2,
             extension_decided_at = NOW(),
             extension_decided_by = $4,
             extension_decision_note = $5,

             updated_at = NOW()
       WHERE id = $3`,
      [daysToExtend, reason, rid, decidedBy, "Approved (direct extension)"]
    );

    await client.query("COMMIT");

    const finePerDay = Number(process.env.BORROW_FINE_PER_DAY || 5);
    const joinedRow = await fetchBorrowRecordJoined(rid);
    if (!joinedRow) {
      return res.status(404).json({ ok: false, message: "Record not found." });
    }
    const record = toDTO(joinedRow, finePerDay);
    return res.json({ ok: true, record });
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
 * POST /api/borrow-records/:id/extend/approve
 * (unchanged)
 */
router.post(
  "/:id/extend/approve",
  requireAuth,
  requireRole(["librarian", "admin"]),
  async (req, res, next) => {
    const client = await dbPool.connect();
    try {
      const session = (req as any).sessionUser as SessionPayload;

      const { id } = req.params;
      const rid = Number(id);
      if (!rid) {
        return res.status(400).json({ ok: false, message: "Invalid id." });
      }

      const note =
        (req.body || {}).note !== undefined && (req.body || {}).note !== null
          ? String((req.body || {}).note).trim()
          : null;

      const maxPerRequest = Math.floor(
        Number(process.env.BORROW_EXTENSION_MAX_DAYS_PER_REQUEST ?? 30)
      );
      const maxTotal = Math.floor(
        Number(process.env.BORROW_EXTENSION_MAX_TOTAL_DAYS ?? 30)
      );

      await client.query("BEGIN");

      const cur = await client.query<{
        id: number;
        user_id: number;
        status: BorrowStatus;
        return_date: string | null;
        extension_total_days: number;
        extension_request_status: ExtensionRequestStatus | null;
        extension_requested_days: number | null;
      }>(
        `SELECT id,
                user_id,
                status,
                return_date,
                extension_total_days,
                extension_request_status,
                extension_requested_days
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

      if (current.return_date || current.status === "returned") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          message: "Cannot approve an extension for a returned record.",
        });
      }

      if (current.status === "pending_return") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          message: "Cannot approve an extension for a record pending return.",
        });
      }

      if (current.status !== "borrowed") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          message: "Only records with status 'borrowed' can be extended.",
        });
      }

      const reqStatus = String(current.extension_request_status ?? "none").toLowerCase();
      if (reqStatus !== "pending") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          message: "No pending extension request to approve for this record.",
        });
      }

      const requestedDays = Number(current.extension_requested_days);
      if (!Number.isFinite(requestedDays) || requestedDays <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          ok: false,
          message: "Invalid requested extension days on this record.",
        });
      }

      if (
        Number.isFinite(maxPerRequest) &&
        maxPerRequest > 0 &&
        requestedDays > maxPerRequest
      ) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          ok: false,
          message: `Requested days cannot exceed ${maxPerRequest} per request.`,
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
        prevTotal + requestedDays > maxTotal
      ) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          ok: false,
          message: `Total extensions cannot exceed ${maxTotal} days.`,
        });
      }

      const decidedByNum = Number(session.sub);
      const decidedBy = Number.isFinite(decidedByNum) ? decidedByNum : null;

      await client.query(
        `UPDATE borrow_records
           SET due_date = due_date + ($1::int),
               extension_count = extension_count + 1,
               extension_total_days = extension_total_days + ($1::int),
               last_extension_days = ($1::int),
               last_extended_at = NOW(),
               last_extension_reason = extension_requested_reason,

               extension_request_status = 'approved',
               extension_decided_at = NOW(),
               extension_decided_by = $2,
               extension_decision_note = $3,

               updated_at = NOW()
         WHERE id = $4`,
        [requestedDays, decidedBy, note, rid]
      );

      await client.query("COMMIT");

      const finePerDay = Number(process.env.BORROW_FINE_PER_DAY || 5);
      const joinedRow = await fetchBorrowRecordJoined(rid);
      if (!joinedRow) {
        return res.status(404).json({ ok: false, message: "Record not found." });
      }
      const record = toDTO(joinedRow, finePerDay);
      return res.json({ ok: true, record });
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
 * POST /api/borrow-records/:id/extend/disapprove
 * (unchanged)
 */
router.post(
  "/:id/extend/disapprove",
  requireAuth,
  requireRole(["librarian", "admin"]),
  async (req, res, next) => {
    const client = await dbPool.connect();
    try {
      const session = (req as any).sessionUser as SessionPayload;

      const { id } = req.params;
      const rid = Number(id);
      if (!rid) {
        return res.status(400).json({ ok: false, message: "Invalid id." });
      }

      const note =
        (req.body || {}).note !== undefined && (req.body || {}).note !== null
          ? String((req.body || {}).note).trim()
          : null;

      await client.query("BEGIN");

      const cur = await client.query<{
        id: number;
        status: BorrowStatus;
        return_date: string | null;
        extension_request_status: ExtensionRequestStatus | null;
      }>(
        `SELECT id,
                status,
                return_date,
                extension_request_status
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

      if (current.return_date || current.status === "returned") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          message: "Cannot disapprove an extension for a returned record.",
        });
      }

      const reqStatus = String(current.extension_request_status ?? "none").toLowerCase();
      if (reqStatus !== "pending") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          message: "No pending extension request to disapprove for this record.",
        });
      }

      const decidedByNum = Number(session.sub);
      const decidedBy = Number.isFinite(decidedByNum) ? decidedByNum : null;

      await client.query(
        `UPDATE borrow_records
           SET extension_request_status = 'disapproved',
               extension_decided_at = NOW(),
               extension_decided_by = $1,
               extension_decision_note = $2,
               updated_at = NOW()
         WHERE id = $3`,
        [decidedBy, note, rid]
      );

      await client.query("COMMIT");

      const finePerDay = Number(process.env.BORROW_FINE_PER_DAY || 5);
      const joinedRow = await fetchBorrowRecordJoined(rid);
      if (!joinedRow) {
        return res.status(404).json({ ok: false, message: "Record not found." });
      }
      const record = toDTO(joinedRow, finePerDay);
      return res.json({ ok: true, record });
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
 * POST /api/borrow-records
 * Create borrow record(s) (transaction).
 * ✅ Now supports borrowing multiple copies in one request.
 */
router.post(
  "/",
  requireAuth,
  requireRole(["librarian", "admin"]),
  async (req, res, next) => {
    const client = await dbPool.connect();
    try {
      const { userId, bookId, borrowDate, dueDate } = req.body || {};
      const uid = Number(userId);
      const bid = Number(bookId);
      const qty = parseBorrowQuantity(req.body || {});

      if (!uid || !bid || !dueDate) {
        return res.status(400).json({
          ok: false,
          message: "userId, bookId and dueDate are required.",
        });
      }

      await client.query("BEGIN");

      const u = await client.query(`SELECT id FROM users WHERE id=$1 LIMIT 1`, [
        uid,
      ]);
      if (!u.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ ok: false, message: "User not found." });
      }

      const b = await client.query<{
        id: number;
        number_of_copies: number | null;
      }>(
        `SELECT id, number_of_copies
           FROM books
           WHERE id=$1
           FOR UPDATE`,
        [bid]
      );

      if (!b.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ ok: false, message: "Book not found." });
      }

      const copies =
        typeof b.rows[0].number_of_copies === "number" &&
          Number.isFinite(b.rows[0].number_of_copies) &&
          b.rows[0].number_of_copies! > 0
          ? Math.floor(b.rows[0].number_of_copies!)
          : 1;

      const activeRes = await client.query<{ active_count: number }>(
        `SELECT COUNT(*)::int AS active_count
           FROM borrow_records
           WHERE book_id = $1
             AND status <> 'returned'`,
        [bid]
      );

      const active =
        typeof activeRes.rows[0]?.active_count === "number" &&
          Number.isFinite(activeRes.rows[0].active_count)
          ? activeRes.rows[0].active_count
          : 0;

      const remaining = Math.max(0, copies - active);

      if (qty > remaining) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          message: `Book is not available (only ${remaining} copy/copies left).`,
        });
      }

      // ✅ Insert 1 record per copy
      const ins = await client.query<{ id: string }>(
        `INSERT INTO borrow_records (user_id, book_id, borrow_date, due_date, status)
         SELECT $1, $2, COALESCE($3::date, CURRENT_DATE), $4::date, 'borrowed'
         FROM generate_series(1, $5::int)
         RETURNING id`,
        [uid, bid, borrowDate || null, dueDate, qty]
      );

      await recomputeAndUpdateBookAvailability(client, bid);

      await client.query("COMMIT");

      const ids = ins.rows.map((r) => Number(r.id));
      const finePerDay = Number(process.env.BORROW_FINE_PER_DAY || 5);
      const joinedRows = await fetchBorrowRecordsJoined(ids);
      const records = joinedRows.map((r) => toDTO(r, finePerDay));

      res.status(201).json({
        ok: true,
        record: records[0],
        records,
        createdCount: records.length,
      });
    } catch (err) {
      try {
        await (client as any).query("ROLLBACK");
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
 * ✅ Now supports borrowing multiple copies in one request.
 */
router.post("/self", requireAuth, async (req, res, next) => {
  const s = (req as any).sessionUser as SessionPayload;
  const userId = Number(s.sub);
  const { bookId } = req.body || {};
  const bid = Number(bookId);
  const qty = parseBorrowQuantity(req.body || {});

  if (!bid) {
    return res.status(400).json({ ok: false, message: "bookId is required." });
  }

  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");

    const u = await client.query(`SELECT id FROM users WHERE id=$1 LIMIT 1`, [
      userId,
    ]);
    if (!u.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, message: "User not found." });
    }

    const b = await client.query<{
      id: number;
      borrow_duration_days: number | null;
      number_of_copies: number | null;
    }>(
      `SELECT id, borrow_duration_days, number_of_copies
         FROM books
         WHERE id = $1
         FOR UPDATE`,
      [bid]
    );

    if (!b.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, message: "Book not found." });
    }

    const copies =
      typeof b.rows[0].number_of_copies === "number" &&
        Number.isFinite(b.rows[0].number_of_copies) &&
        b.rows[0].number_of_copies! > 0
        ? Math.floor(b.rows[0].number_of_copies!)
        : 1;

    const activeRes = await client.query<{ active_count: number }>(
      `SELECT COUNT(*)::int AS active_count
         FROM borrow_records
         WHERE book_id = $1
           AND status <> 'returned'`,
      [bid]
    );

    const active =
      typeof activeRes.rows[0]?.active_count === "number" &&
        Number.isFinite(activeRes.rows[0].active_count)
        ? activeRes.rows[0].active_count
        : 0;

    const remaining = Math.max(0, copies - active);

    if (qty > remaining) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        message: `Book is not available (only ${remaining} copy/copies left).`,
      });
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
         SELECT $1, $2, $3::date, $4::date, 'pending_pickup'
         FROM generate_series(1, $5::int)
         RETURNING id`,
      [userId, bid, borrowDateStr, dueDateStr, qty]
    );

    await recomputeAndUpdateBookAvailability(client, bid);

    await client.query("COMMIT");

    const ids = ins.rows.map((r) => Number(r.id));
    const finePerDay = Number(process.env.BORROW_FINE_PER_DAY || 5);
    const joinedRows = await fetchBorrowRecordsJoined(ids);
    const records = joinedRows.map((r) => toDTO(r, finePerDay));

    res.status(201).json({
      ok: true,
      record: records[0],
      records,
      createdCount: records.length,
    });
  } catch (err) {
    try {
      await (client as any).query("ROLLBACK");
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
 * (unchanged logic; availability is recomputed when status changes)
 */
router.patch("/:id", requireAuth, async (req, res, next) => {
  const client = await dbPool.connect();
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

    let effectiveRole: Role = session.role;
    try {
      const roleResult = await dbQuery<UserRoleRow>(
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

    let newStatus: BorrowStatus = current.status;

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

      newStatus = sVal;

      updates.push(`status = $${i++}`);
      values.push(sVal);

      if (sVal === "returned" && returnDate === undefined) {
        updates.push(`return_date = COALESCE(return_date, CURRENT_DATE)`);
      }
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

                   extension_request_status,
                   extension_requested_days,
                   extension_requested_at,
                   extension_requested_reason,
                   extension_decided_at,
                   extension_decided_by,
                   extension_decision_note,

                   NULL::text AS email,
                   NULL::text AS student_id,
                   NULL::text AS full_name,
                   NULL::text AS title`,
      [...values, rid]
    );

    const updatedRow = upd.rows[0];

    if (newStatus === "returned") {
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

    if (status !== undefined) {
      await recomputeAndUpdateBookAvailability(client, Number(updatedRow.book_id));
    }

    await client.query("COMMIT");

    const finePerDay = Number(process.env.BORROW_FINE_PER_DAY || 5);
    const joinedRow = await fetchBorrowRecordJoined(rid);
    if (!joinedRow) {
      return res.status(404).json({ ok: false, message: "Record not found." });
    }
    const record = toDTO(joinedRow, finePerDay);
    res.json({ ok: true, record });
  } catch (err) {
    try {
      await (client as any).query("ROLLBACK");
    } catch {
      /* ignore */
    }
    next(err);
  } finally {
    client.release();
  }
});

export default router;
