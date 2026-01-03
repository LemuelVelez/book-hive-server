import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../db";
import multer from "multer";
import crypto from "crypto";
import path from "path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const router = express.Router();

/* ---------------- S3 setup ---------------- */
const S3_REGION = process.env.AWS_REGION || process.env.S3_REGION || "ap-southeast-2";
const S3_BUCKET = process.env.S3_BUCKET_NAME || "";
const S3_PUBLIC_BASE = (process.env.S3_PUBLIC_URL_BASE || "").replace(/\/+$/, "");
const S3_PREFIX = (process.env.S3_PREFIX || "uploads/").replace(/^\/+|\/+$/g, "");

if (!S3_BUCKET) {
  console.warn("[damage-reports] S3 bucket not set (S3_BUCKET_NAME). Image uploads will fail.");
}

const s3 = new S3Client({ region: S3_REGION });

function extFromMime(mime: string, fallback: string = "bin") {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
    "image/tiff": "tif",
    "image/avif": "avif",
  };
  return map[mime.toLowerCase()] || fallback;
}

function makeObjectKey(originalName: string, mime: string) {
  const rand = crypto.randomBytes(6).toString("hex");
  const ts = Date.now();
  const safeBase = path.basename(originalName).replace(/[^a-z0-9_.-]+/gi, "_");
  const ext = extFromMime(mime, path.extname(safeBase).replace(/^\./, "") || "jpg");
  const folder = S3_PREFIX ? `${S3_PREFIX}/damage-reports` : "damage-reports";
  return `${folder}/${ts}_${rand}.${ext}`;
}

function publicUrlForKey(key: string) {
  if (S3_PUBLIC_BASE) return `${S3_PUBLIC_BASE}/${key}`;
  return `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${key}`;
}

async function uploadBufferToS3(buf: Buffer, mime: string, originalName: string): Promise<string> {
  const Key = makeObjectKey(originalName, mime);
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key,
      Body: buf,
      ContentType: mime,
      CacheControl: "public, max-age=31536000, immutable",
    })
  );
  return publicUrlForKey(Key);
}

/* ---------------- Upload (multer) ---------------- */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\//i.test(file.mimetype)) return cb(null, true);
    cb(new Error("Only image uploads are allowed."));
  },
});

/* ---------------- Types ---------------- */

type Role = "student" | "librarian" | "faculty" | "admin" | "other";
type DamageStatus = "pending" | "assessed" | "paid";
type Severity = "minor" | "moderate" | "major";
type FineStatus = "active" | "paid" | "cancelled";

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

type DamageUnionRow = {
  id: string;
  user_id: string;
  liable_user_id: string | null;
  book_id: string;
  damage_type: string;
  severity: Severity;
  fee: string;
  status: DamageStatus;
  notes: string | null;
  reported_at: string;
  photo_url: string | null;

  paid_at: string | null;
  archived: boolean;

  // reported-by joined user
  email: string | null;
  student_id: string | null;
  full_name: string | null;

  // liable joined user
  liable_email: string | null;
  liable_student_id: string | null;
  liable_full_name: string | null;

  // joined book
  title: string | null;

  // sorting helper
  sort_ts: string;
};

/* ---------------- helpers (consistent with other routes) ---------------- */

function normalizeRole(raw: unknown): Role {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "student") return "student";
  if (v === "librarian") return "librarian";
  if (v === "faculty") return "faculty";
  if (v === "admin") return "admin";
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

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const s = readSession(req);
  if (!s) return res.status(401).json({ ok: false, message: "Not authenticated." });
  (req as any).sessionUser = s;
  next();
}

function computeEffectiveRoleFromRow(row: UserRoleRow): Role {
  const primary = normalizeRole(row.account_type);
  const legacy = row.role != null ? normalizeRole(row.role) : undefined;

  if (legacy && legacy !== "student" && (primary === "student" || primary === "other")) {
    return legacy;
  }

  if (primary !== "other") return primary;
  if (legacy) return legacy;
  return "student";
}

function requireRole(roles: Role[]) {
  const required = roles.map(normalizeRole);

  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const s = (req as any).sessionUser as SessionPayload | undefined;
    if (!s) return res.status(401).json({ ok: false, message: "Not authenticated." });

    query<UserRoleRow>(
      `SELECT id, account_type, role
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [s.sub]
    )
      .then((result) => {
        if (!result.rowCount) {
          return res.status(401).json({ ok: false, message: "Not authenticated." });
        }
        const u = result.rows[0];
        const effectiveRole = computeEffectiveRoleFromRow(u);
        if (!required.includes(effectiveRole)) {
          console.warn("[damage-reports] Forbidden", {
            userId: s.sub,
            tokenRole: s.role,
            effectiveRole,
            required,
          });
          return res.status(403).json({ ok: false, message: "Forbidden: insufficient role." });
        }
        (req as any).sessionUser = { ...s, role: effectiveRole };
        next();
      })
      .catch((err) => next(err));
  };
}

/* ---------------- mapping ---------------- */

function parsePhotoUrls(photo_url: string | null): string[] {
  let photoUrls: string[] = [];
  if (!photo_url) return photoUrls;

  try {
    const parsed = JSON.parse(photo_url);
    if (Array.isArray(parsed)) {
      photoUrls = parsed
        .map((v) => (typeof v === "string" ? v : null))
        .filter((v): v is string => !!v);
    } else if (typeof parsed === "string") {
      photoUrls = [parsed];
    } else {
      photoUrls = [String(photo_url)];
    }
  } catch {
    photoUrls = [photo_url];
  }

  return photoUrls;
}

function toDTO(row: DamageUnionRow) {
  return {
    id: String(row.id),

    userId: String(row.user_id),
    studentEmail: row.email,
    studentId: row.student_id,
    studentName: row.full_name,

    liableUserId: row.liable_user_id ? String(row.liable_user_id) : null,
    liableStudentEmail: row.liable_email,
    liableStudentId: row.liable_student_id,
    liableStudentName: row.liable_full_name,

    bookId: String(row.book_id),
    bookTitle: row.title,

    damageType: row.damage_type,
    severity: row.severity,
    fee: Number(row.fee || 0),
    status: row.status,

    archived: Boolean(row.archived),
    paidAt: row.paid_at,

    reportedAt: row.reported_at,
    notes: row.notes,
    photoUrls: parsePhotoUrls(row.photo_url),
  };
}

/* ---------------- shared UNION query builder ---------------- */

function buildUnionQuery(whereSql: string | null) {
  const whereActive = whereSql ? `WHERE ${whereSql.replace(/\bdrp\./g, "dr.")}` : "";
  const wherePaid = whereSql ? `WHERE ${whereSql}` : "";

  return `
    SELECT *
    FROM (
      SELECT
        dr.id, dr.user_id, dr.liable_user_id, dr.book_id, dr.damage_type, dr.severity, dr.fee, dr.status, dr.notes, dr.reported_at, dr.photo_url,
        NULL::timestamptz AS paid_at,
        false AS archived,

        u.email, u.student_id, u.full_name,

        lu.email AS liable_email,
        lu.student_id AS liable_student_id,
        lu.full_name AS liable_full_name,

        b.title,

        COALESCE(NULL::timestamptz, dr.reported_at) AS sort_ts
      FROM damage_reports dr
      LEFT JOIN users u ON u.id = dr.user_id
      LEFT JOIN users lu ON lu.id = dr.liable_user_id
      LEFT JOIN books b ON b.id = dr.book_id
      ${whereActive}

      UNION ALL

      SELECT
        drp.id, drp.user_id, drp.liable_user_id, drp.book_id, drp.damage_type, drp.severity, drp.fee, drp.status, drp.notes, drp.reported_at, drp.photo_url,
        drp.paid_at AS paid_at,
        true AS archived,

        u.email, u.student_id, u.full_name,

        lu.email AS liable_email,
        lu.student_id AS liable_student_id,
        lu.full_name AS liable_full_name,

        b.title,

        COALESCE(drp.paid_at, drp.reported_at) AS sort_ts
      FROM damage_reports_paid drp
      LEFT JOIN users u ON u.id = drp.user_id
      LEFT JOIN users lu ON lu.id = drp.liable_user_id
      LEFT JOIN books b ON b.id = drp.book_id
      ${wherePaid}
    ) t
    ORDER BY t.sort_ts DESC, t.id DESC
  `;
}

async function fetchOneById(id: number): Promise<DamageUnionRow | null> {
  const sql = `
    SELECT *
    FROM (${buildUnionQuery("t.id = $1".replace("t.", "drp."))}) q
    WHERE q.id = $1
    LIMIT 1
  `;
  // NOTE: the buildUnionQuery expects whereSql expressed in terms of drp.* (paid alias),
  // and it auto-maps to dr.* for active. We pass drp.id = $1 (via replacement above).
  const res = await query<DamageUnionRow>(sql, [id]);
  if (!res.rowCount) return null;
  return res.rows[0];
}

/* ---------------- fine sync helper ---------------- */

async function syncFineForDamageReport(row: DamageUnionRow): Promise<void> {
  const damageIdNum = Number(row.id);

  const liableIdNum =
    row.liable_user_id != null && String(row.liable_user_id).trim() !== ""
      ? Number(row.liable_user_id)
      : Number(row.user_id);

  const feeNum = Number(row.fee || 0);
  const hasPositiveFee = Number.isFinite(feeNum) && feeNum > 0;
  const status = row.status;

  const prefix = `Damage report #${damageIdNum}:`;

  // If no fine should exist, remove any existing fine tied to this damage report
  if (!hasPositiveFee || status === "pending") {
    await query(`DELETE FROM fines WHERE damage_report_id = $1`, [damageIdNum]);
    return;
  }

  let fineStatus: FineStatus = "active";
  if (status === "paid") fineStatus = "paid";

  const details: string[] = [];
  if (row.damage_type) details.push(row.damage_type);
  if (row.notes) details.push(row.notes);
  if (row.liable_user_id) details.push(`liable_user_id=${row.liable_user_id}`);
  const detailStr = details.join(" – ");
  const reason = detailStr.length > 0 ? `${prefix} ${detailStr}` : `${prefix}`;

  const resolvedAt = fineStatus === "paid" ? new Date() : null;

  const existing = await query<{ id: string }>(
    `SELECT id
     FROM fines
     WHERE damage_report_id = $1
     ORDER BY created_at ASC
     LIMIT 1`,
    [damageIdNum]
  );

  if (!existing.rowCount) {
    await query(
      `INSERT INTO fines (user_id, borrow_record_id, damage_report_id, amount, status, reason, resolved_at)
       VALUES ($1, NULL, $2, $3, $4, $5, $6)`,
      [liableIdNum, damageIdNum, feeNum, fineStatus, reason, resolvedAt]
    );
  } else {
    const fid = Number(existing.rows[0].id);
    await query(
      `UPDATE fines
       SET user_id = $1,
           amount = $2,
           status = $3,
           reason = $4,
           resolved_at = $5,
           updated_at = NOW()
       WHERE id = $6`,
      [liableIdNum, feeNum, fineStatus, reason, resolvedAt, fid]
    );
  }
}

/* ---------------- routes ---------------- */

/**
 * GET /api/damage-reports
 * List all damage reports (librarian/admin).
 * Includes active + archived/paid (separate record) via UNION.
 */
router.get("/", requireAuth, requireRole(["librarian", "admin"]), async (_req, res, next) => {
  try {
    const sql = buildUnionQuery(null);
    const result = await query<DamageUnionRow>(sql);
    const reports = result.rows.map(toDTO);
    res.json({ ok: true, reports });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/damage-reports/my
 * List damage reports relevant to current authenticated user:
 * - reports they submitted (user_id)
 * - reports they are liable for (liable_user_id)
 * Includes active + archived via UNION.
 */
router.get("/my", requireAuth, async (req, res, next) => {
  try {
    const s = (req as any).sessionUser as SessionPayload;
    const userId = Number(s.sub);

    const sql = buildUnionQuery("drp.user_id = $1 OR drp.liable_user_id = $1");
    const result = await query<DamageUnionRow>(sql, [userId]);

    const reports = result.rows.map(toDTO);
    res.json({ ok: true, reports });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/damage-reports
 * Create a damage report – students (and staff) can submit.
 */
router.post(
  "/",
  requireAuth,
  requireRole(["student", "faculty", "librarian", "admin"]),
  upload.array("photos", 3),
  async (req, res, next) => {
    try {
      if (!S3_BUCKET) {
        return res.status(500).json({ ok: false, message: "S3 bucket not configured." });
      }

      const s = (req as any).sessionUser as SessionPayload;
      const { bookId, damageType, severity, fee, notes } = req.body || {};

      const bid = Number(bookId);
      if (!bid || !Number.isFinite(bid)) {
        return res.status(400).json({ ok: false, message: "bookId is required." });
      }

      const dt = String(damageType || "").trim();
      if (!dt) {
        return res.status(400).json({ ok: false, message: "damageType is required." });
      }

      const sev = String(severity || "").toLowerCase();
      if (!["minor", "moderate", "major"].includes(sev)) {
        return res
          .status(400)
          .json({ ok: false, message: "severity must be 'minor' | 'moderate' | 'major'." });
      }

      const feeNum = fee === undefined || fee === null ? 0 : Number(fee);
      if (!Number.isFinite(feeNum) || feeNum < 0) {
        return res.status(400).json({ ok: false, message: "fee must be a non-negative number." });
      }

      const files = (req.files as Express.Multer.File[]) || [];
      const uploadedUrls: string[] = [];

      for (const file of files) {
        const url = await uploadBufferToS3(file.buffer, file.mimetype, file.originalname);
        uploadedUrls.push(url);
      }

      const photoUrlJson = uploadedUrls.length ? JSON.stringify(uploadedUrls) : null;

      const book = await query(`SELECT id FROM books WHERE id = $1 LIMIT 1`, [bid]);
      if (!book.rowCount) {
        return res.status(404).json({ ok: false, message: "Book not found." });
      }

      const ins = await query<{ id: string }>(
        `INSERT INTO damage_reports (user_id, liable_user_id, book_id, damage_type, severity, fee, status, notes, photo_url)
         VALUES ($1, NULL, $2, $3, $4, $5, 'pending', $6, $7)
         RETURNING id`,
        [Number(s.sub), bid, dt, sev, feeNum, notes ? String(notes).trim() : null, photoUrlJson]
      );

      const rid = Number(ins.rows[0].id);
      const row = await fetchOneById(rid);
      if (!row) {
        return res.status(500).json({ ok: false, message: "Failed to load created report." });
      }

      res.status(201).json({ ok: true, report: toDTO(row) });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /api/damage-reports/:id
 * Update fields – librarian/admin only.
 * If status becomes "paid", the report is moved into damage_reports_paid and removed from damage_reports.
 */
router.patch(
  "/:id",
  requireAuth,
  requireRole(["librarian", "admin"]),
  upload.single("photo"),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const rid = Number(id);
      if (!rid) {
        return res.status(400).json({ ok: false, message: "Invalid id." });
      }

      // If it’s already archived, block edits
      const alreadyArchived = await query(`SELECT id FROM damage_reports_paid WHERE id = $1 LIMIT 1`, [rid]);
      if (alreadyArchived.rowCount) {
        return res.status(409).json({
          ok: false,
          message: "This damage report is already archived (paid) and can no longer be edited.",
        });
      }

      const { status, severity, fee, notes, damageType } = req.body || {};

      // Support both liableUserId and liable_user_id from clients
      const rawLiable =
        (req.body && (req.body.liableUserId ?? req.body.liable_user_id)) ?? undefined;

      let newPhotoUrl: string | undefined = undefined;
      if (req.file) {
        if (!S3_BUCKET) {
          return res.status(500).json({ ok: false, message: "S3 bucket not configured." });
        }
        newPhotoUrl = await uploadBufferToS3(req.file.buffer, req.file.mimetype, req.file.originalname);
      }

      const updates: string[] = [];
      const values: any[] = [];
      let i = 1;

      if (status !== undefined) {
        const st = String(status).toLowerCase();
        if (!["pending", "assessed", "paid"].includes(st)) {
          return res.status(400).json({ ok: false, message: "Invalid status." });
        }
        updates.push(`status = $${i++}`);
        values.push(st);
      }

      if (severity !== undefined) {
        const sv = String(severity).toLowerCase();
        if (!["minor", "moderate", "major"].includes(sv)) {
          return res.status(400).json({ ok: false, message: "Invalid severity." });
        }
        updates.push(`severity = $${i++}`);
        values.push(sv);
      }

      if (fee !== undefined) {
        const f = Number(fee);
        if (!Number.isFinite(f) || f < 0) {
          return res.status(400).json({ ok: false, message: "fee must be a non-negative number." });
        }
        updates.push(`fee = $${i++}`);
        values.push(f);
      }

      if (notes !== undefined) {
        updates.push(`notes = $${i++}`);
        values.push(notes ? String(notes).trim() : null);
      }

      if (damageType !== undefined) {
        const dt = String(damageType || "").trim();
        if (!dt) {
          return res.status(400).json({ ok: false, message: "damageType cannot be empty." });
        }
        updates.push(`damage_type = $${i++}`);
        values.push(dt);
      }

      if (rawLiable !== undefined) {
        // allow null/empty => clear liable user
        const rawStr = rawLiable === null ? "" : String(rawLiable).trim();

        if (rawLiable === null || rawStr === "") {
          updates.push(`liable_user_id = NULL`);
        } else {
          const uid = Number(rawStr);
          if (!uid || !Number.isFinite(uid)) {
            return res.status(400).json({ ok: false, message: "liableUserId must be a valid user id or null." });
          }
          const u = await query(`SELECT id FROM users WHERE id = $1 LIMIT 1`, [uid]);
          if (!u.rowCount) {
            return res.status(404).json({ ok: false, message: "Liable user not found." });
          }
          updates.push(`liable_user_id = $${i++}`);
          values.push(uid);
        }
      }

      if (newPhotoUrl !== undefined) {
        const json = JSON.stringify([newPhotoUrl]);
        updates.push(`photo_url = $${i++}`);
        values.push(json);
      }

      if (updates.length === 0) {
        return res.status(400).json({ ok: false, message: "No changes provided." });
      }

      updates.push(`updated_at = NOW()`);

      const upd = await query(
        `UPDATE damage_reports
         SET ${updates.join(", ")}
         WHERE id = $${i}
         RETURNING id`,
        [...values, rid]
      );

      if (!upd.rowCount) {
        return res.status(404).json({ ok: false, message: "Damage report not found." });
      }

      // Load the updated row (still active at this point)
      const activeRowRes = await query<DamageUnionRow>(
        `
        SELECT
          dr.id, dr.user_id, dr.liable_user_id, dr.book_id, dr.damage_type, dr.severity, dr.fee, dr.status, dr.notes, dr.reported_at, dr.photo_url,
          NULL::timestamptz AS paid_at,
          false AS archived,

          u.email, u.student_id, u.full_name,

          lu.email AS liable_email,
          lu.student_id AS liable_student_id,
          lu.full_name AS liable_full_name,

          b.title,

          COALESCE(NULL::timestamptz, dr.reported_at) AS sort_ts
        FROM damage_reports dr
        LEFT JOIN users u ON u.id = dr.user_id
        LEFT JOIN users lu ON lu.id = dr.liable_user_id
        LEFT JOIN books b ON b.id = dr.book_id
        WHERE dr.id = $1
        LIMIT 1
        `,
        [rid]
      );

      if (!activeRowRes.rowCount) {
        return res.status(404).json({ ok: false, message: "Damage report not found." });
      }

      const joinedRow = activeRowRes.rows[0];

      // Keep fines in sync with the LIABLE user
      try {
        await syncFineForDamageReport(joinedRow);
      } catch (syncErr) {
        console.error("[damage-reports] Failed to sync fine:", syncErr);
      }

      // If paid => move to archive table and remove from active
      if (joinedRow.status === "paid") {
        // Atomic move using DELETE..RETURNING inside CTE
        await query(
          `
          WITH moved AS (
            DELETE FROM damage_reports
            WHERE id = $1
            RETURNING *
          )
          INSERT INTO damage_reports_paid
          SELECT moved.*, NOW()
          FROM moved
          ON CONFLICT (id) DO NOTHING
          `,
          [rid]
        );

        const archivedRow = await fetchOneById(rid);
        if (!archivedRow) {
          return res.status(500).json({ ok: false, message: "Archived record not found after moving." });
        }

        return res.json({ ok: true, report: toDTO(archivedRow) });
      }

      res.json({ ok: true, report: toDTO(joinedRow) });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * DELETE /api/damage-reports/:id
 * Remove a report – librarian/admin only.
 * Works for both active and archived.
 */
router.delete("/:id", requireAuth, requireRole(["librarian", "admin"]), async (req, res, next) => {
  try {
    const { id } = req.params;
    const rid = Number(id);
    if (!rid) {
      return res.status(400).json({ ok: false, message: "Invalid id." });
    }

    // Remove fine by direct link (preferred)
    await query(`DELETE FROM fines WHERE damage_report_id = $1`, [rid]);

    // Try delete active first
    const delActive = await query(`DELETE FROM damage_reports WHERE id = $1`, [rid]);
    if (delActive.rowCount) {
      return res.json({ ok: true, message: "Damage report deleted." });
    }

    // If not in active, try delete archived
    const delPaid = await query(`DELETE FROM damage_reports_paid WHERE id = $1`, [rid]);
    if (!delPaid.rowCount) {
      return res.status(404).json({ ok: false, message: "Damage report not found." });
    }

    res.json({ ok: true, message: "Archived damage report deleted." });
  } catch (err) {
    next(err);
  }
});

export default router;
