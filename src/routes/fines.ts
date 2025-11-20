import express from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import path from "path";
import { query } from "../db";
import { uploadImageToS3 } from "../s3";

const router = express.Router();

type Role = "student" | "librarian" | "faculty" | "admin" | "other";
type BorrowStatus = "borrowed" | "pending" | "returned";
type FineStatus = "active" | "pending_verification" | "paid" | "cancelled";

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

type FineRowJoined = {
  id: string;
  user_id: string;
  borrow_record_id: string | null;
  amount: string;
  status: FineStatus;
  reason: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;

  // joined
  borrow_status: BorrowStatus | null;
  borrow_due_date: string | null;
  borrow_return_date: string | null;
  book_id: string | null;
  book_title: string | null;
  email: string | null;
  student_id: string | null;
  full_name: string | null;
};

type PaymentConfigRow = {
  id: string;
  e_wallet_phone: string | null;
  qr_code_url: string | null;
};

type FineProofRow = {
  id: string;
  fine_id: string;
  image_url: string;
  uploaded_by: string | null;
  kind: string;
  created_at: string;
};

/* ---------------- multer (for image uploads) ---------------- */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8 * 1024 * 1024, // 8MB max per image
  },
});

/* ---------------- helpers ---------------- */

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
          console.warn("[fines] Forbidden", {
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

/* ---------------- mapping ---------------- */

function fineToDTO(row: FineRowJoined) {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    borrowRecordId: row.borrow_record_id
      ? String(row.borrow_record_id)
      : null,
    amount: Number(row.amount || 0),
    status: row.status,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,

    studentEmail: row.email,
    studentId: row.student_id,
    studentName: row.full_name,

    bookId: row.book_id ? String(row.book_id) : null,
    bookTitle: row.book_title,
    borrowStatus: row.borrow_status,
    borrowDueDate: row.borrow_due_date,
    borrowReturnDate: row.borrow_return_date,
  };
}

function proofToDTO(row: FineProofRow) {
  return {
    id: String(row.id),
    fineId: String(row.fine_id),
    imageUrl: row.image_url,
    kind: row.kind,
    uploadedAt: row.created_at,
  };
}

const BASE_SELECT = `
  SELECT
    f.id,
    f.user_id,
    f.borrow_record_id,
    f.amount,
    f.status,
    f.reason,
    f.created_at,
    f.updated_at,
    f.resolved_at,
    br.status AS borrow_status,
    br.due_date AS borrow_due_date,
    br.return_date AS borrow_return_date,
    br.book_id,
    b.title AS book_title,
    u.email,
    u.student_id,
    u.full_name
  FROM fines f
  LEFT JOIN borrow_records br ON br.id = f.borrow_record_id
  LEFT JOIN books b ON b.id = br.book_id
  LEFT JOIN users u ON u.id = f.user_id
`;

/* ---------------- routes ---------------- */

/**
 * GET /api/fines/my
 * List fines for the current authenticated user.
 */
router.get(
  "/my",
  requireAuth,
  async (req, res, next) => {
    try {
      const s = (req as any).sessionUser as SessionPayload;
      const userId = Number(s.sub);

      const result = await query<FineRowJoined>(
        `${BASE_SELECT}
         WHERE f.user_id = $1
         ORDER BY f.status, f.created_at DESC`,
        [userId]
      );

      const fines = result.rows.map(fineToDTO);
      res.json({ ok: true, fines });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/fines
 * List fines (librarian/admin).
 * Optional query params:
 *   - userId: filter by user
 *   - status: active | pending_verification | paid | cancelled
 */
router.get(
  "/",
  requireAuth,
  requireRole(["librarian", "admin"]),
  async (req, res, next) => {
    try {
      const { userId, status } = req.query as {
        userId?: string;
        status?: string;
      };

      const where: string[] = [];
      const values: any[] = [];
      let i = 1;

      if (userId) {
        where.push(`f.user_id = $${i++}`);
        values.push(Number(userId));
      }

      if (status) {
        const st = String(status).toLowerCase();
        const allowed: FineStatus[] = [
          "active",
          "pending_verification",
          "paid",
          "cancelled",
        ];
        if (!allowed.includes(st as FineStatus)) {
          return res.status(400).json({
            ok: false,
            message:
              "Invalid status. Use one of: active, pending_verification, paid, cancelled.",
          });
        }
        where.push(`f.status = $${i++}`);
        values.push(st);
      }

      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      const result = await query<FineRowJoined>(
        `${BASE_SELECT}
         ${whereSql}
         ORDER BY f.status, f.created_at DESC`,
        values
      );

      const fines = result.rows.map(fineToDTO);
      res.json({ ok: true, fines });
    } catch (err) {
      next(err);
    }
  }
);

/* ---------- Global payment config (e-wallet phone + QR) ---------- */

/**
 * GET /api/fines/payment-config
 * Any authenticated user can read the current library payment settings.
 */
router.get(
  "/payment-config",
  requireAuth,
  async (_req, res, next) => {
    try {
      const result = await query<PaymentConfigRow>(
        `SELECT id, e_wallet_phone, qr_code_url
         FROM library_payment_settings
         ORDER BY id ASC
         LIMIT 1`
      );

      const row = result.rows[0];
      const config = row
        ? {
          eWalletPhone: row.e_wallet_phone,
          qrCodeUrl: row.qr_code_url,
        }
        : null;

      res.json({ ok: true, config });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/fines/payment-config
 * Librarian/admin: update global e-wallet number and/or QR code image.
 * Body (multipart/form-data):
 *   - eWalletPhone (string)
 *   - qrCode (file)
 */
router.post(
  "/payment-config",
  requireAuth,
  requireRole(["librarian", "admin"]),
  upload.single("qrCode"),
  async (req, res, next) => {
    try {
      const s = (req as any).sessionUser as SessionPayload;
      const userId = Number(s.sub) || null;

      const rawPhone = typeof req.body?.eWalletPhone === "string"
        ? req.body.eWalletPhone
        : "";
      const phoneNormalized = rawPhone.trim() || null;

      let qrUrl: string | undefined;
      const file = req.file;

      if (file) {
        const ext = path.extname(file.originalname || "").toLowerCase() || undefined;
        qrUrl = await uploadImageToS3({
          buffer: file.buffer,
          contentType: file.mimetype || "image/png",
          folder: "payment-qr",
          extension: ext,
        });
      }

      const existing = await query<PaymentConfigRow>(
        `SELECT id, e_wallet_phone, qr_code_url
         FROM library_payment_settings
         ORDER BY id ASC
         LIMIT 1`
      );

      let row: PaymentConfigRow;

      if (!existing.rowCount) {
        const insert = await query<PaymentConfigRow>(
          `INSERT INTO library_payment_settings (e_wallet_phone, qr_code_url, created_by, updated_by)
           VALUES ($1, $2, $3, $3)
           RETURNING id, e_wallet_phone, qr_code_url`,
          [phoneNormalized, qrUrl ?? null, userId, userId]
        );
        row = insert.rows[0];
      } else {
        const current = existing.rows[0];
        const nextPhone =
          phoneNormalized !== null ? phoneNormalized : current.e_wallet_phone;
        const nextQr =
          qrUrl !== undefined ? qrUrl : current.qr_code_url;

        const update = await query<PaymentConfigRow>(
          `UPDATE library_payment_settings
           SET e_wallet_phone = $1,
               qr_code_url = $2,
               updated_by = $3,
               updated_at = NOW()
           WHERE id = $4
           RETURNING id, e_wallet_phone, qr_code_url`,
          [nextPhone, nextQr, userId, current.id]
        );
        row = update.rows[0];
      }

      const config = {
        eWalletPhone: row.e_wallet_phone,
        qrCodeUrl: row.qr_code_url,
      };

      res.json({ ok: true, config });
    } catch (err) {
      next(err);
    }
  }
);

/* ---------- Fine proofs: student payment screenshots ---------- */

/**
 * GET /api/fines/:id/proofs
 * List proof images for a fine.
 * - Allowed for the fine owner (student) or librarian/admin.
 */
router.get(
  "/:id/proofs",
  requireAuth,
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const fid = Number(id);
      if (!fid) {
        return res.status(400).json({ ok: false, message: "Invalid id." });
      }

      const s = (req as any).sessionUser as SessionPayload;
      const userId = Number(s.sub);

      const fineResult = await query<{ user_id: string }>(
        `SELECT user_id FROM fines WHERE id = $1 LIMIT 1`,
        [fid]
      );

      if (!fineResult.rowCount) {
        return res.status(404).json({ ok: false, message: "Fine not found." });
      }

      const fineOwnerId = Number(fineResult.rows[0].user_id);
      const role = normalizeRole(s.role);

      const isOwner = fineOwnerId === userId;
      const isStaff = role === "librarian" || role === "admin";

      if (!isOwner && !isStaff) {
        return res.status(403).json({ ok: false, message: "Forbidden." });
      }

      const proofsResult = await query<FineProofRow>(
        `SELECT id, fine_id, image_url, uploaded_by, kind, created_at
         FROM fine_proofs
         WHERE fine_id = $1
         ORDER BY created_at ASC`,
        [fid]
      );

      const proofs = proofsResult.rows.map(proofToDTO);
      res.json({ ok: true, proofs });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/fines/:id/proofs
 * Upload a proof image (student payment screenshot).
 * - Allowed for the fine owner (student) or librarian/admin.
 * - Uses Amazon S3 for storage.
 */
router.post(
  "/:id/proofs",
  requireAuth,
  upload.single("image"),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const fid = Number(id);
      if (!fid) {
        return res.status(400).json({ ok: false, message: "Invalid id." });
      }

      const file = req.file;
      if (!file) {
        return res
          .status(400)
          .json({ ok: false, message: "No image file provided." });
      }

      const s = (req as any).sessionUser as SessionPayload;
      const userId = Number(s.sub);

      const fineResult = await query<{ user_id: string }>(
        `SELECT user_id FROM fines WHERE id = $1 LIMIT 1`,
        [fid]
      );

      if (!fineResult.rowCount) {
        return res.status(404).json({ ok: false, message: "Fine not found." });
      }

      const fineOwnerId = Number(fineResult.rows[0].user_id);
      const role = normalizeRole(s.role);

      const isOwner = fineOwnerId === userId;
      const isStaff = role === "librarian" || role === "admin";

      if (!isOwner && !isStaff) {
        return res.status(403).json({ ok: false, message: "Forbidden." });
      }

      const kindRaw =
        typeof req.body?.kind === "string" ? req.body.kind.trim() : "";
      const kind = kindRaw || "student_payment";

      const ext = path.extname(file.originalname || "").toLowerCase() || undefined;
      const imageUrl = await uploadImageToS3({
        buffer: file.buffer,
        contentType: file.mimetype || "image/png",
        folder: "fines/proofs",
        extension: ext,
      });

      const insert = await query<FineProofRow>(
        `INSERT INTO fine_proofs (fine_id, image_url, uploaded_by, kind)
         VALUES ($1, $2, $3, $4)
         RETURNING id, fine_id, image_url, uploaded_by, kind, created_at`,
        [fid, imageUrl, Number.isFinite(userId) ? userId : null, kind]
      );

      const proof = proofToDTO(insert.rows[0]);
      res.json({ ok: true, proof });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/fines/:id/pay
 * Student action: request payment of their own active fine.
 * - Only the fine owner can call this.
 * - Only works when status === 'active'.
 * - Sets status to 'pending_verification'.
 */
router.post(
  "/:id/pay",
  requireAuth,
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const fid = Number(id);
      if (!fid) {
        return res.status(400).json({ ok: false, message: "Invalid id." });
      }

      const s = (req as any).sessionUser as SessionPayload;
      const userId = Number(s.sub);

      // Ensure fine exists and belongs to user
      const existing = await query<FineRowJoined>(
        `${BASE_SELECT}
         WHERE f.id = $1 AND f.user_id = $2
         LIMIT 1`,
        [fid, userId]
      );

      if (!existing.rowCount) {
        return res.status(404).json({ ok: false, message: "Fine not found." });
      }

      const row = existing.rows[0];
      if (row.status !== "active") {
        return res.status(400).json({
          ok: false,
          message: "Only active fines can be paid.",
        });
      }

      // Update status to pending_verification
      await query(
        `UPDATE fines
         SET status = 'pending_verification',
             updated_at = NOW(),
             resolved_at = NULL
         WHERE id = $1 AND user_id = $2`,
        [fid, userId]
      );

      // Hydrate with joins and return DTO
      const joined = await query<FineRowJoined>(
        `${BASE_SELECT}
         WHERE f.id = $1
         LIMIT 1`,
        [fid]
      );

      if (!joined.rowCount) {
        return res.status(404).json({ ok: false, message: "Fine not found." });
      }

      const fine = fineToDTO(joined.rows[0]);
      res.json({ ok: true, fine });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /api/fines/:id
 * Update a fine (librarian/admin).
 * Body: { status?, amount?, reason? }
 * - status: active | pending_verification | paid | cancelled
 * - amount: updated fine amount (>= 0)
 * - reason: optional description / note
 *
 * When status becomes 'paid' or 'cancelled', resolved_at is set to NOW().
 */
router.patch(
  "/:id",
  requireAuth,
  requireRole(["librarian", "admin"]),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const fid = Number(id);
      if (!fid) {
        return res.status(400).json({ ok: false, message: "Invalid id." });
      }

      const { status, amount, reason } = req.body || {};

      const updates: string[] = [];
      const values: any[] = [];
      let i = 1;

      let normalizedStatus: FineStatus | undefined;

      if (amount !== undefined) {
        const num = Number(amount);
        if (!Number.isFinite(num) || num < 0) {
          return res.status(400).json({
            ok: false,
            message: "amount must be a number greater than or equal to 0.",
          });
        }
        updates.push(`amount = $${i++}`);
        values.push(num);
      }

      if (reason !== undefined) {
        updates.push(`reason = $${i++}`);
        values.push(reason ? String(reason).trim() : null);
      }

      if (status !== undefined) {
        const st = String(status).toLowerCase();
        const allowed: FineStatus[] = [
          "active",
          "pending_verification",
          "paid",
          "cancelled",
        ];
        if (!allowed.includes(st as FineStatus)) {
          return res.status(400).json({
            ok: false,
            message:
              "Invalid status. Use one of: active, pending_verification, paid, cancelled.",
          });
        }
        normalizedStatus = st as FineStatus;
        updates.push(`status = $${i++}`);
        values.push(normalizedStatus);

        if (normalizedStatus === "paid" || normalizedStatus === "cancelled") {
          updates.push(`resolved_at = NOW()`);
        } else {
          updates.push(`resolved_at = NULL`);
        }
      }

      if (updates.length === 0) {
        return res
          .status(400)
          .json({ ok: false, message: "No changes provided." });
      }

      updates.push(`updated_at = NOW()`);

      const result = await query<FineRowJoined>(
        `UPDATE fines
         SET ${updates.join(", ")}
         WHERE id = $${i}
         RETURNING id, user_id, borrow_record_id, amount, status, reason, created_at, updated_at, resolved_at,
                   NULL::text AS borrow_status,
                   NULL::date AS borrow_due_date,
                   NULL::date AS borrow_return_date,
                   NULL::bigint AS book_id,
                   NULL::text AS book_title,
                   NULL::text AS email,
                   NULL::text AS student_id,
                   NULL::text AS full_name`,
        [...values, fid]
      );

      if (!result.rowCount) {
        return res.status(404).json({ ok: false, message: "Fine not found." });
      }

      // Hydrate joins for DTO
      const joined = await query<FineRowJoined>(
        `${BASE_SELECT}
         WHERE f.id = $1
         LIMIT 1`,
        [fid]
      );

      if (!joined.rowCount) {
        return res.status(404).json({ ok: false, message: "Fine not found." });
      }

      const fine = fineToDTO(joined.rows[0]);
      res.json({ ok: true, fine });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
