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
type BorrowStatus =
  | "borrowed"
  | "pending"
  | "pending_pickup"
  | "pending_return"
  | "returned";

/**
 * Over-the-counter only:
 * - Removed: e-wallet payment config, QR uploads, and proof uploads
 * - Removed: student "pay" request flow (pending_verification)
 * - Staff (assistant_librarian/librarian/admin) marks fines as paid via PATCH /api/fines/:id
 */
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

type FineRowJoined = {
  id: string;
  user_id: string;
  borrow_record_id: string | null;
  damage_report_id: string | null;
  amount: string;
  status: FineStatus;
  reason: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  official_receipt_number: string | null;

  // joined
  borrow_status: BorrowStatus | null;
  borrow_due_date: string | null;
  borrow_return_date: string | null;
  borrow_created_at: string | null;
  book_id: string | null;
  book_title: string | null;
  email: string | null;
  student_id: string | null;
  full_name: string | null;
};

type FineNotificationRecipientRow = {
  email: string | null;
  full_name: string | null;
  account_type: Role | string | null;
  role?: Role | string | null;
};

type FineNotificationSessionRow = UserRoleRow & {
  email: string | null;
  full_name: string | null;
};

/* ---------------- helpers ---------------- */

const HOUR_MS = 1000 * 60 * 60;
const MANILA_UTC_OFFSET_HOURS = 8;

type BorrowOverdueMetrics = {
  fineStartsAt: string | null;
  overdueHours: number | null;
  overdueDays: number | null;
};

function normalizeRole(raw: unknown): Role {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
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

function normalizeOfficialReceiptNumber(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const value = String(raw).trim();
  return value.length > 0 ? value : null;
}

function getBorrowFinePerHour(): number {
  const raw = Number(process.env.BORROW_FINE_PER_HOUR ?? 10);
  if (!Number.isFinite(raw) || raw < 0) return 10;
  return raw;
}

function isDateOnlyValue(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function parseDateValue(value: string | null | undefined): Date | null {
  if (!value) return null;

  const raw = String(value).trim();
  if (!raw) return null;

  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getManilaTimeParts(date: Date) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value || 0);

  return {
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
    millisecond: date.getMilliseconds(),
  };
}

function dateOnlyAtManilaTime(
  dateOnly: string,
  timeSource?: Date | null,
): Date {
  const [year, month, day] = dateOnly.split("-").map(Number);
  const time = timeSource
    ? getManilaTimeParts(timeSource)
    : { hour: 0, minute: 0, second: 0, millisecond: 0 };

  return new Date(
    Date.UTC(
      year,
      month - 1,
      day,
      time.hour - MANILA_UTC_OFFSET_HOURS,
      time.minute,
      time.second,
      time.millisecond,
    ),
  );
}

function getBorrowFineStartDate(
  dueDate: string | null,
  borrowCreatedAt: string | null,
): Date | null {
  if (!dueDate) return null;

  const rawDueDate = String(dueDate).trim();
  const borrowStart = parseDateValue(borrowCreatedAt);

  if (isDateOnlyValue(rawDueDate)) {
    return dateOnlyAtManilaTime(rawDueDate, borrowStart);
  }

  return parseDateValue(rawDueDate);
}

function getBorrowFineEndDate(
  returnDate: string | null,
  borrowCreatedAt: string | null,
): Date {
  if (!returnDate) return new Date();

  const rawReturnDate = String(returnDate).trim();
  const borrowStart = parseDateValue(borrowCreatedAt);

  if (isDateOnlyValue(rawReturnDate)) {
    return dateOnlyAtManilaTime(rawReturnDate, borrowStart);
  }

  return parseDateValue(rawReturnDate) ?? new Date();
}

function computeBorrowOverdueMetrics(
  dueDate: string | null,
  returnDate: string | null,
  borrowCreatedAt: string | null,
): BorrowOverdueMetrics {
  const fineStartsAt = getBorrowFineStartDate(dueDate, borrowCreatedAt);

  if (!fineStartsAt) {
    return { fineStartsAt: null, overdueHours: null, overdueDays: null };
  }

  const end = getBorrowFineEndDate(returnDate, borrowCreatedAt);
  const overdueMs = Math.max(0, end.getTime() - fineStartsAt.getTime());
  const overdueHours = overdueMs > 0 ? Math.ceil(overdueMs / HOUR_MS) : 0;
  const overdueDays = overdueHours > 0 ? Math.ceil(overdueHours / 24) : 0;

  return {
    fineStartsAt: fineStartsAt.toISOString(),
    overdueHours,
    overdueDays,
  };
}

function computeActiveBorrowFineAmount(
  row: Pick<
    FineRowJoined,
    | "amount"
    | "borrow_record_id"
    | "borrow_due_date"
    | "borrow_return_date"
    | "borrow_created_at"
    | "status"
  >,
): number {
  const storedAmount = Number(row.amount || 0);

  if (!row.borrow_record_id || row.status !== "active") {
    return Number.isFinite(storedAmount) ? storedAmount : 0;
  }

  const metrics = computeBorrowOverdueMetrics(
    row.borrow_due_date,
    row.borrow_return_date,
    row.borrow_created_at,
  );
  const overdueHours = metrics.overdueHours ?? 0;

  return overdueHours * getBorrowFinePerHour();
}

function isStaffRole(role: Role) {
  return (
    role === "admin" ||
    role === "assistant_librarian" ||
    role === "librarian" ||
    role === "faculty"
  );
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
  next: express.NextFunction,
) {
  const s = readSession(req);
  if (!s) {
    return res.status(401).json({ ok: false, message: "Not authenticated." });
  }
  (req as any).sessionUser = s;
  next();
}

/**
 * ✅ FIXED: Effective AUTH role for guards/authorization
 * - Prefer legacy `role` if it's a staff role (admin/assistant_librarian/librarian/faculty)
 * - Else if account_type is staff role, use it
 * - Else if legacy role exists (student/other), use it
 * - Else fallback to account_type (or student)
 *
 * This fixes the bug where staff users still have account_type="other/student"
 * but role="admin/librarian/faculty", causing 403 Forbidden.
 */
function computeEffectiveRoleFromRow(row: UserRoleRow): Role {
  const accountType = normalizeRole(row.account_type);

  const legacyRaw = row.role;
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

function requireRole(roles: Role[]) {
  return (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
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
      [s.sub],
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
  const metrics = computeBorrowOverdueMetrics(
    row.borrow_due_date,
    row.borrow_return_date,
    row.borrow_created_at,
  );

  return {
    id: String(row.id),
    userId: String(row.user_id),
    borrowRecordId: row.borrow_record_id ? String(row.borrow_record_id) : null,
    damageReportId: row.damage_report_id ? String(row.damage_report_id) : null,
    amount: computeActiveBorrowFineAmount(row),
    status: row.status,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    officialReceiptNumber: row.official_receipt_number,

    studentEmail: row.email,
    studentId: row.student_id,
    studentName: row.full_name,

    bookId: row.book_id ? String(row.book_id) : null,
    bookTitle: row.book_title,
    borrowStatus: row.borrow_status,
    borrowDueDate: row.borrow_due_date,
    borrowReturnDate: row.borrow_return_date,
    borrowStartedAt: row.borrow_created_at,
    borrowFineStartsAt: metrics.fineStartsAt,

    finePerHour: row.borrow_record_id ? getBorrowFinePerHour() : null,
    overdueHours: metrics.overdueHours,
    overdueDays: metrics.overdueDays,
  };
}

const BASE_SELECT = `
  SELECT
    f.id,
    f.user_id,
    f.borrow_record_id,
    f.damage_report_id,
    f.amount,
    f.status,
    f.reason,
    f.created_at,
    f.updated_at,
    f.resolved_at,
    f.official_receipt_number,
    br.status AS borrow_status,
    br.due_date AS borrow_due_date,
    br.return_date AS borrow_return_date,
    br.created_at AS borrow_created_at,
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

/* ---------------- email notifications ---------------- */

function escapeHtml(input: unknown) {
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
        .map((email) =>
          String(email || "")
            .trim()
            .toLowerCase(),
        )
        .filter((email) => email.includes("@")),
    ),
  );
}

function clientUrl(pathname = "/dashboard/librarian/fines") {
  const base = (process.env.CLIENT_ORIGIN || "http://localhost:5173")
    .toString()
    .replace(/\/+$/, "");
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${base}${path}`;
}

function isLibraryStaffRole(role: Role) {
  return (
    role === "admin" || role === "assistant_librarian" || role === "librarian"
  );
}

function formatPeso(amount: unknown) {
  const value = Number(amount || 0);
  try {
    return new Intl.NumberFormat("en-PH", {
      style: "currency",
      currency: "PHP",
      maximumFractionDigits: 2,
    }).format(Number.isFinite(value) ? value : 0);
  } catch {
    return `₱${(Number.isFinite(value) ? value : 0).toFixed(2)}`;
  }
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function fineBorrowerName(fine: ReturnType<typeof fineToDTO>) {
  return (
    fine.studentName ||
    fine.studentEmail ||
    fine.studentId ||
    `User #${fine.userId}`
  );
}

function fineLabel(fine: ReturnType<typeof fineToDTO>) {
  return fine.bookTitle || fine.reason || `Fine #${fine.id}`;
}

async function getFineNotificationRecipients() {
  const envRecipients = uniqueEmails([
    ...parseEmailList(process.env.FINES_NOTIFICATION_EMAILS),
    ...parseEmailList(process.env.LIBRARIAN_NOTIFICATION_EMAILS),
    ...parseEmailList(process.env.ADMIN_NOTIFICATION_EMAILS),
  ]);

  if (envRecipients.length > 0) return envRecipients;

  const result = await query<FineNotificationRecipientRow>(
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
        created_at ASC`,
  );

  return uniqueEmails(result.rows.map((row) => row.email));
}

function buildFineRowsHtml(fines: Array<ReturnType<typeof fineToDTO>>) {
  return fines
    .map((fine) => {
      const safeBorrower = escapeHtml(fineBorrowerName(fine));
      const safeTitle = escapeHtml(fineLabel(fine));
      const safeAmount = escapeHtml(formatPeso(fine.amount));
      const safeStatus = escapeHtml(fine.status);
      const safeCreated = escapeHtml(formatDateTime(fine.createdAt));
      const safeReason = escapeHtml(fine.reason || "—");

      return `
        <tr>
          <td style="padding:10px;border-bottom:1px solid #e5e7eb;vertical-align:top;">${safeBorrower}</td>
          <td style="padding:10px;border-bottom:1px solid #e5e7eb;vertical-align:top;">${safeTitle}</td>
          <td style="padding:10px;border-bottom:1px solid #e5e7eb;vertical-align:top;white-space:nowrap;">${safeAmount}</td>
          <td style="padding:10px;border-bottom:1px solid #e5e7eb;vertical-align:top;text-transform:capitalize;">${safeStatus}</td>
          <td style="padding:10px;border-bottom:1px solid #e5e7eb;vertical-align:top;">${safeReason}</td>
          <td style="padding:10px;border-bottom:1px solid #e5e7eb;vertical-align:top;white-space:nowrap;">${safeCreated}</td>
        </tr>
      `;
    })
    .join("");
}

async function sendFineDashboardNotificationEmail(args: {
  role: "staff" | "borrower";
  recipient: string;
  fines: Array<ReturnType<typeof fineToDTO>>;
  dashboardPath?: string;
}) {
  const { role, recipient, fines } = args;
  if (!recipient || fines.length === 0) {
    return { sent: false, recipientCount: 0 };
  }

  const totalAmount = fines.reduce(
    (sum, fine) => sum + Number(fine.amount || 0),
    0,
  );
  const count = fines.length;
  const pageUrl = clientUrl(
    args.dashboardPath ||
      (role === "staff"
        ? "/dashboard/librarian/fines"
        : "/dashboard/student/fines"),
  );
  const safePageUrl = escapeHtml(pageUrl);
  const subject =
    role === "staff"
      ? `Book-Hive fines alert: ${count} active fine${count === 1 ? "" : "s"}`
      : `Book-Hive fine reminder: ${count} active fine${count === 1 ? "" : "s"}`;

  const html = `
    <div style="background:#ffffff;color:#111827;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.5;padding:24px;">
      <div style="max-width:900px;margin:0 auto;">
        <div style="font-size:18px;font-weight:800;margin-bottom:12px;">JRMSU-TC Book-Hive</div>
        <p style="margin:0 0 10px;">${role === "staff" ? "There are" : "You have"} ${count} active fine${count === 1 ? "" : "s"} with a total amount of <strong>${escapeHtml(formatPeso(totalAmount))}</strong>.</p>
        <p style="margin:0 0 16px;color:#4b5563;">${role === "staff" ? "Open the librarian fines page to review and update payment status." : "Please settle active fines over the counter at the library."}</p>
        <p style="margin:0 0 18px;">
          <a href="${safePageUrl}" style="display:inline-block;padding:10px 12px;border-radius:10px;background:#111827;color:#ffffff;text-decoration:none;font-weight:700;">
            Open fines
          </a>
        </p>
        <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;font-size:14px;">
          <thead>
            <tr style="background:#f9fafb;">
              <th align="left" style="padding:10px;border-bottom:1px solid #e5e7eb;">Borrower</th>
              <th align="left" style="padding:10px;border-bottom:1px solid #e5e7eb;">Reference</th>
              <th align="left" style="padding:10px;border-bottom:1px solid #e5e7eb;">Amount</th>
              <th align="left" style="padding:10px;border-bottom:1px solid #e5e7eb;">Status</th>
              <th align="left" style="padding:10px;border-bottom:1px solid #e5e7eb;">Reason</th>
              <th align="left" style="padding:10px;border-bottom:1px solid #e5e7eb;">Created</th>
            </tr>
          </thead>
          <tbody>${buildFineRowsHtml(fines)}</tbody>
        </table>
        <p style="margin:18px 0 0;font-size:12px;color:#6b7280;word-break:break-all;">${safePageUrl}</p>
      </div>
    </div>
  `.trim();

  const text = [
    "JRMSU-TC Book-Hive",
    "",
    `${role === "staff" ? "There are" : "You have"} ${count} active fine${count === 1 ? "" : "s"} totaling ${formatPeso(totalAmount)}.`,
    `Open fines: ${pageUrl}`,
    "",
    ...fines.map(
      (fine, index) =>
        `${index + 1}. ${fineBorrowerName(fine)} - ${fineLabel(fine)} - ${formatPeso(fine.amount)} - ${fine.status}`,
    ),
  ].join("\n");

  await sendMail({
    to: recipient,
    subject,
    html,
    text,
  });

  return {
    sent: true,
    recipientCount: uniqueEmails(recipient.split(",")).length,
  };
}

async function sendFineStatusNotificationEmail(
  fine: ReturnType<typeof fineToDTO>,
) {
  const recipient = fine.studentEmail?.trim();
  if (!recipient || !recipient.includes("@")) {
    return { sent: false, recipientCount: 0 };
  }

  const finesUrl = clientUrl("/dashboard/student/fines");
  const safeFinesUrl = escapeHtml(finesUrl);
  const subject = `Book-Hive fine ${fine.status}: ${fineLabel(fine)}`;
  const html = `
    <div style="background:#ffffff;color:#111827;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.5;padding:24px;">
      <div style="max-width:720px;margin:0 auto;">
        <div style="font-size:18px;font-weight:800;margin-bottom:12px;">JRMSU-TC Book-Hive</div>
        <p style="margin:0 0 10px;">Your fine status has been updated to <strong>${escapeHtml(fine.status.toUpperCase())}</strong>.</p>
        <p style="margin:0 0 10px;color:#4b5563;">Reference: ${escapeHtml(fineLabel(fine))}</p>
        <p style="margin:0 0 10px;color:#4b5563;">Amount: ${escapeHtml(formatPeso(fine.amount))}</p>
        ${fine.officialReceiptNumber ? `<p style="margin:0 0 10px;color:#4b5563;">Official Receipt: ${escapeHtml(fine.officialReceiptNumber)}</p>` : ""}
        <p style="margin:16px 0 0;"><a href="${safeFinesUrl}" style="display:inline-block;padding:10px 12px;border-radius:10px;background:#111827;color:#ffffff;text-decoration:none;font-weight:700;">Open my fines</a></p>
      </div>
    </div>
  `.trim();
  const text = [
    "JRMSU-TC Book-Hive",
    "",
    `Your fine status has been updated to ${fine.status.toUpperCase()}.`,
    `Reference: ${fineLabel(fine)}`,
    `Amount: ${formatPeso(fine.amount)}`,
    fine.officialReceiptNumber
      ? `Official Receipt: ${fine.officialReceiptNumber}`
      : "",
    `Open my fines: ${finesUrl}`,
  ]
    .filter(Boolean)
    .join("\n");

  await sendMail({ to: recipient, subject, html, text });
  return { sent: true, recipientCount: 1 };
}

/* ---------------- routes ---------------- */

/**
 * GET /api/fines/my
 * List fines for the current authenticated user.
 */
router.get("/my", requireAuth, async (req, res, next) => {
  try {
    const s = (req as any).sessionUser as SessionPayload;
    const userId = Number(s.sub);

    const result = await query<FineRowJoined>(
      `${BASE_SELECT}
       WHERE f.user_id = $1
       ORDER BY f.status, f.created_at DESC`,
      [userId],
    );

    const fines = result.rows.map(fineToDTO);
    res.json({ ok: true, fines });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/fines
 * List fines (assistant_librarian/librarian/admin).
 * Optional query params:
 *   - userId: filter by user
 *   - status: active | paid | cancelled
 */
router.get(
  "/",
  requireAuth,
  requireRole(["assistant_librarian", "librarian", "admin"]),
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
        const allowed: FineStatus[] = ["active", "paid", "cancelled"];
        if (!allowed.includes(st as FineStatus)) {
          return res.status(400).json({
            ok: false,
            message: "Invalid status. Use one of: active, paid, cancelled.",
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
        values,
      );

      const fines = result.rows.map(fineToDTO);
      res.json({ ok: true, fines });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/fines/notifications/email-sync
 * Email active fine notifications for the current fines dashboard.
 * - Librarian/admin/assistant_librarian: emails active fine summary to library notification recipients.
 * - Student/faculty/other: emails the authenticated borrower about their active fines.
 */
router.post(
  "/notifications/email-sync",
  requireAuth,
  async (req, res, next) => {
    try {
      const session = (req as any).sessionUser as SessionPayload;

      const userResult = await query<FineNotificationSessionRow>(
        `SELECT id, email, full_name, account_type, role
         FROM users
        WHERE id = $1
        LIMIT 1`,
        [session.sub],
      );

      if (!userResult.rowCount) {
        return res
          .status(401)
          .json({ ok: false, message: "Not authenticated." });
      }

      const user = userResult.rows[0];
      const effectiveRole = computeEffectiveRoleFromRow(user);
      const isLibraryStaff = isLibraryStaffRole(effectiveRole);

      if (isLibraryStaff) {
        const result = await query<FineRowJoined>(
          `${BASE_SELECT}
         WHERE f.status = 'active'
         ORDER BY f.created_at DESC
         LIMIT 50`,
        );

        const fines = result.rows.map(fineToDTO);
        if (fines.length === 0) {
          return res.json({
            ok: true,
            sync: {
              role: "staff",
              emailSent: false,
              suppressed: false,
              totalNotifications: 0,
              activeFineCount: 0,
              message: "No active fines currently need an email notification.",
            },
          });
        }

        const recipients = await getFineNotificationRecipients();
        if (recipients.length === 0) {
          return res.json({
            ok: true,
            sync: {
              role: "staff",
              emailSent: false,
              suppressed: false,
              recipientCount: 0,
              totalNotifications: fines.length,
              activeFineCount: fines.length,
              message:
                "No fine notification recipients were found. Set FINES_NOTIFICATION_EMAILS, LIBRARIAN_NOTIFICATION_EMAILS, or ADMIN_NOTIFICATION_EMAILS.",
            },
          });
        }

        const sendResult = await sendFineDashboardNotificationEmail({
          role: "staff",
          recipient: recipients.join(", "),
          fines,
        });

        return res.json({
          ok: true,
          sync: {
            role: "staff",
            emailSent: sendResult.sent,
            suppressed: false,
            recipientCount: sendResult.recipientCount,
            totalNotifications: fines.length,
            activeFineCount: fines.length,
            message: sendResult.sent
              ? `Fine notification sent to ${sendResult.recipientCount} recipient${sendResult.recipientCount === 1 ? "" : "s"}.`
              : "Fine notification email could not be sent.",
          },
        });
      }

      const borrowerRecipient = uniqueEmails([user.email, session.email])[0];
      if (!borrowerRecipient) {
        return res.json({
          ok: true,
          sync: {
            role: "borrower",
            emailSent: false,
            suppressed: false,
            recipientCount: 0,
            totalNotifications: 0,
            activeFineCount: 0,
            message:
              "No borrower email address is available for fine notifications.",
          },
        });
      }

      const result = await query<FineRowJoined>(
        `${BASE_SELECT}
       WHERE f.user_id = $1
         AND f.status = 'active'
       ORDER BY f.created_at DESC
       LIMIT 50`,
        [Number(session.sub)],
      );

      const fines = result.rows.map(fineToDTO);
      if (fines.length === 0) {
        return res.json({
          ok: true,
          sync: {
            role: "borrower",
            recipient: borrowerRecipient,
            emailSent: false,
            suppressed: false,
            totalNotifications: 0,
            activeFineCount: 0,
            message: "No active fines currently need an email notification.",
          },
        });
      }

      const sendResult = await sendFineDashboardNotificationEmail({
        role: "borrower",
        recipient: borrowerRecipient,
        fines,
        dashboardPath:
          effectiveRole === "faculty"
            ? "/dashboard/faculty/fines"
            : "/dashboard/student/fines",
      });

      return res.json({
        ok: true,
        sync: {
          role: "borrower",
          recipient: borrowerRecipient,
          emailSent: sendResult.sent,
          suppressed: false,
          recipientCount: sendResult.recipientCount,
          totalNotifications: fines.length,
          activeFineCount: fines.length,
          message: sendResult.sent
            ? "Fine email notification synced successfully."
            : "Fine email notification could not be sent.",
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * PATCH /api/fines/:id
 * Update a fine (assistant_librarian/librarian/admin).
 * Body: { status?, amount?, reason?, officialReceiptNumber? }
 * - status: active | paid | cancelled
 * - amount: updated fine amount (>= 0)
 * - reason: optional description / note
 * - officialReceiptNumber/orNumber/receiptNumber: cashier OR number
 *
 * When status becomes 'paid' or 'cancelled', resolved_at is set to NOW().
 * When status becomes 'paid', official receipt number is required.
 */
router.patch(
  "/:id",
  requireAuth,
  requireRole(["assistant_librarian", "librarian", "admin"]),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const fid = Number(id);
      if (!fid) {
        return res.status(400).json({ ok: false, message: "Invalid id." });
      }

      const currentFineResult = await query<FineRowJoined>(
        `${BASE_SELECT}
         WHERE f.id = $1
         LIMIT 1`,
        [fid],
      );

      if (!currentFineResult.rowCount) {
        return res.status(404).json({ ok: false, message: "Fine not found." });
      }

      const currentFine = currentFineResult.rows[0];
      const { status, amount, reason } = req.body || {};

      const requestedOfficialReceiptNumberRaw =
        (req.body || {}).officialReceiptNumber ??
        (req.body || {}).orNumber ??
        (req.body || {}).receiptNumber;

      const requestedOfficialReceiptNumber =
        requestedOfficialReceiptNumberRaw === undefined
          ? undefined
          : normalizeOfficialReceiptNumber(requestedOfficialReceiptNumberRaw);

      const updates: string[] = [];
      const values: any[] = [];
      let i = 1;

      let normalizedStatus: FineStatus | undefined;
      let nextStatus: FineStatus = currentFine.status;

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
        const allowed: FineStatus[] = ["active", "paid", "cancelled"];
        if (!allowed.includes(st as FineStatus)) {
          return res.status(400).json({
            ok: false,
            message: "Invalid status. Use one of: active, paid, cancelled.",
          });
        }
        normalizedStatus = st as FineStatus;
        nextStatus = normalizedStatus;
        updates.push(`status = $${i++}`);
        values.push(normalizedStatus);

        if (normalizedStatus === "paid" || normalizedStatus === "cancelled") {
          updates.push(`resolved_at = NOW()`);
        } else {
          updates.push(`resolved_at = NULL`);
        }
      }

      if (
        amount === undefined &&
        (nextStatus === "paid" || nextStatus === "cancelled") &&
        currentFine.borrow_record_id
      ) {
        updates.push(`amount = $${i++}`);
        values.push(computeActiveBorrowFineAmount(currentFine));
      }

      const finalOfficialReceiptNumber =
        nextStatus === "paid"
          ? requestedOfficialReceiptNumber !== undefined
            ? requestedOfficialReceiptNumber
            : currentFine.official_receipt_number
          : null;

      if (nextStatus === "paid" && !finalOfficialReceiptNumber) {
        return res.status(400).json({
          ok: false,
          message:
            "Official receipt number is required when marking a fine as paid.",
        });
      }

      if (nextStatus !== "paid" && requestedOfficialReceiptNumber) {
        return res.status(400).json({
          ok: false,
          message:
            "Official receipt number can only be set when the fine status is paid.",
        });
      }

      if (finalOfficialReceiptNumber) {
        const duplicate = await query<{ id: string }>(
          `SELECT id
           FROM fines
           WHERE LOWER(BTRIM(official_receipt_number)) = LOWER(BTRIM($1))
             AND id <> $2
           LIMIT 1`,
          [finalOfficialReceiptNumber, fid],
        );

        if (duplicate.rowCount) {
          return res.status(409).json({
            ok: false,
            message: "Official receipt number already exists on another fine.",
          });
        }
      }

      if (nextStatus === "paid") {
        if (
          requestedOfficialReceiptNumber !== undefined ||
          normalizedStatus === "paid"
        ) {
          updates.push(`official_receipt_number = $${i++}`);
          values.push(finalOfficialReceiptNumber);
        }
      } else if (
        normalizedStatus !== undefined ||
        requestedOfficialReceiptNumber !== undefined
      ) {
        updates.push(`official_receipt_number = NULL`);
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
         RETURNING id,
                   user_id,
                   borrow_record_id,
                   damage_report_id,
                   amount,
                   status,
                   reason,
                   created_at,
                   updated_at,
                   resolved_at,
                   official_receipt_number,
                   NULL::text AS borrow_status,
                   NULL::date AS borrow_due_date,
                   NULL::date AS borrow_return_date,
                   NULL::timestamptz AS borrow_created_at,
                   NULL::bigint AS book_id,
                   NULL::text AS book_title,
                   NULL::text AS email,
                   NULL::text AS student_id,
                   NULL::text AS full_name`,
        [...values, fid],
      );

      if (!result.rowCount) {
        return res.status(404).json({ ok: false, message: "Fine not found." });
      }

      // Hydrate joins for DTO
      const joined = await query<FineRowJoined>(
        `${BASE_SELECT}
         WHERE f.id = $1
         LIMIT 1`,
        [fid],
      );

      if (!joined.rowCount) {
        return res.status(404).json({ ok: false, message: "Fine not found." });
      }

      const fine = fineToDTO(joined.rows[0]);

      if (normalizedStatus !== undefined) {
        sendFineStatusNotificationEmail(fine).catch((e) => {
          console.warn("Failed sending fine status notification email:", e);
        });
      }

      res.json({ ok: true, fine });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
