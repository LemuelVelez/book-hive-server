import express from "express";
import jwt from "jsonwebtoken";
import { pool, query } from "../db";

const router = express.Router();

type Role = "student" | "librarian" | "faculty" | "admin" | "other";
type BorrowStatus = "borrowed" | "pending" | "returned";

type SessionPayload = {
    sub: string;
    email: string;
    role: Role;
    ev: number;
};

type UserRoleRow = {
    id: string;
    account_type: Role;
    role?: Role | null;
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

function computeEffectiveRoleFromRow(row: UserRoleRow): Role {
    const primary = (row.account_type || "student") as Role;
    const legacy = (row.role as Role | null) || undefined;

    if (primary && primary !== "student") return primary;
    if (primary === "student" && legacy && legacy !== "student") return legacy;

    return primary || legacy || "student";
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
router.get(
    "/my",
    requireAuth,
    async (req, res, next) => {
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
    }
);

/**
 * POST /api/borrow-records
 * Create a borrow record and set book unavailable (transaction).
 * Body: { userId, bookId, borrowDate?, dueDate }
 * (librarian/admin only)
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
            const u = await client.query(
                `SELECT id FROM users WHERE id=$1 LIMIT 1`,
                [uid]
            );
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

            // ✅ Set book unavailable
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
                await pool.query("ROLLBACK");
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
 * Current user (typically student) borrows a book.
 * Body: { bookId }
 * - userId is taken from the session.
 * - borrow_date = today
 * - due_date = today + BORROW_DAYS (default 7)
 * - ✅ marks the book as unavailable (available = FALSE)
 */
router.post(
    "/self",
    requireAuth,
    async (req, res, next) => {
        const s = (req as any).sessionUser as SessionPayload;
        const userId = Number(s.sub);
        const { bookId } = req.body || {};
        const bid = Number(bookId);

        if (!bid) {
            return res
                .status(400)
                .json({ ok: false, message: "bookId is required." });
        }

        const client = await pool.connect();
        try {
            const borrowDays = Number(process.env.BORROW_DAYS || 7);
            const today = new Date();
            const due = new Date(today);
            due.setDate(due.getDate() + borrowDays);

            const borrowDateStr = today.toISOString().slice(0, 10);
            const dueDateStr = due.toISOString().slice(0, 10);

            await client.query("BEGIN");

            // Validate user exists
            const u = await client.query(
                `SELECT id FROM users WHERE id=$1 LIMIT 1`,
                [userId]
            );
            if (!u.rowCount) {
                await client.query("ROLLBACK");
                return res
                    .status(404)
                    .json({ ok: false, message: "User not found." });
            }

            // Validate book availability
            const b = await client.query<{ id: number; available: boolean }>(
                `SELECT id, available FROM books WHERE id=$1 LIMIT 1`,
                [bid]
            );
            if (!b.rowCount) {
                await client.query("ROLLBACK");
                return res
                    .status(404)
                    .json({ ok: false, message: "Book not found." });
            }
            if (b.rows[0].available === false) {
                await client.query("ROLLBACK");
                return res
                    .status(409)
                    .json({ ok: false, message: "Book is not available." });
            }

            const ins = await client.query<{ id: string }>(
                `INSERT INTO borrow_records (user_id, book_id, borrow_date, due_date, status)
         VALUES ($1,$2,$3::date,$4::date,'borrowed')
         RETURNING id`,
                [userId, bid, borrowDateStr, dueDateStr]
            );

            // ✅ Set book unavailable for student self-borrow as well
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
 * PATCH /api/borrow-records/:id
 * Update status/return date.
 * Body: { status?, returnDate? }
 * - Librarian/Admin can set status to "borrowed" | "pending" | "returned"
 *   and set the return date.
 * - The student who owns the record can only move their own record
 *   from "borrowed" to "pending" (online return request).
 * - When a record is set to "returned", we compute and persist the fine.
 */
router.patch(
    "/:id",
    requireAuth,
    async (req, res, next) => {
        const client = await pool.connect();
        try {
            const { id } = req.params;
            const rid = Number(id);
            const { status, returnDate } = req.body || {};

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
           WHERE id=$1
           FOR UPDATE`,
                [rid]
            );

            if (!cur.rowCount) {
                await client.query("ROLLBACK");
                return res.status(404).json({ ok: false, message: "Record not found." });
            }

            const current = cur.rows[0];

            // Determine effective role from DB (same logic as other routes)
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
                // If this fails, we just fall back to token role
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

            // Extra safety: students cannot finalize returns or set return_date
            if (!isAdminLike) {
                const desiredStatus =
                    status !== undefined ? String(status).toLowerCase() : undefined;

                if (desiredStatus === "returned") {
                    await client.query("ROLLBACK");
                    return res.status(403).json({
                        ok: false,
                        message:
                            "Only librarians can mark a book as returned. Your online action should create a pending return request.",
                    });
                }

                if (returnDate !== undefined) {
                    await client.query("ROLLBACK");
                    return res.status(403).json({
                        ok: false,
                        message: "Only librarians can set the return date.",
                    });
                }
            }

            const updates: string[] = [];
            const values: any[] = [];
            let i = 1;

            if (status !== undefined) {
                const sVal = String(status).toLowerCase();
                if (sVal !== "borrowed" && sVal !== "pending" && sVal !== "returned") {
                    await client.query("ROLLBACK");
                    return res
                        .status(400)
                        .json({ ok: false, message: "Invalid status." });
                }
                updates.push(`status = $${i++}`);
                values.push(sVal);
            }

            if (returnDate !== undefined) {
                updates.push(`return_date = $${i++}::date`);
                values.push(returnDate ? String(returnDate) : null);
            }

            if (updates.length === 0) {
                await client.query("ROLLBACK");
                return res
                    .status(400)
                    .json({ ok: false, message: "No changes provided." });
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
                   NULL::text AS email,
                   NULL::text AS student_id,
                   NULL::text AS full_name,
                   NULL::text AS title`,
                [...values, rid]
            );

            const updatedRow = upd.rows[0];

            // Decide final status
            const newStatus: BorrowStatus =
                status !== undefined
                    ? (String(status).toLowerCase() as BorrowStatus)
                    : current.status;

            // If now returned -> free the book AND compute & persist fine
            if (newStatus === "returned") {
                // Mark the book as available
                await client.query(
                    `UPDATE books SET available = TRUE, updated_at = NOW() WHERE id = $1`,
                    [updatedRow.book_id]
                );

                // Compute and store the fine at the time of return
                const finePerDay = Number(process.env.BORROW_FINE_PER_DAY || 5);

                const due = new Date(updatedRow.due_date + "T00:00:00Z");
                const end = new Date(
                    (updatedRow.return_date || new Date().toISOString().slice(0, 10)) +
                    "T00:00:00Z"
                );
                const ms = Math.max(0, end.getTime() - due.getTime());
                const days = Math.floor(ms / (1000 * 60 * 60 * 24));
                const fineValue = days * finePerDay;

                await client.query(
                    `UPDATE borrow_records
             SET fine = $1, updated_at = NOW()
           WHERE id = $2`,
                    [fineValue, rid]
                );
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
                await pool.query("ROLLBACK");
            } catch {
                /* ignore */
            }
            next(err);
        } finally {
            client.release();
        }
    }
);

export default router;
