import express from "express";
import jwt from "jsonwebtoken";
import { sendMail } from "../email";
import { pool, query } from "../db";

const router = express.Router();

type Role =
  | "student"
  | "guest"
  | "assistant_librarian"
  | "librarian"
  | "faculty"
  | "admin"
  | "other";

type BorrowPolicyRole =
  | "student"
  | "guest"
  | "librarian"
  | "faculty"
  | "admin"
  | "other";

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

type BorrowPolicyDTO = {
  role: BorrowPolicyRole;
  maxActiveBorrows: number;
  defaultBorrowDurationDays: number;
  maxPerAction: number;
};

type BorrowNotificationsSummaryRow = {
  total_records: number;
  pending_pickup_count: number;
  pending_return_count: number;
  pending_extension_count: number;
  action_required_count: number;
};


type BorrowDueCountsRow = {
  due_today_count: number;
  overdue_count: number;
};

type BorrowNotificationEmailRow = {
  id: string;
  user_id: string;
  due_date: string;
  status: BorrowStatus;
  extension_request_status: ExtensionRequestStatus | null;
  return_requested_at: string | null;
  return_requested_by: number | null;
  return_request_note: string | null;
  email: string | null;
  full_name: string | null;
  title: string | null;
  accession_number?: string | null;
  copy_number?: number | null;
};

type UserIdentityRow = UserRoleRow & {
  email: string | null;
  full_name: string | null;
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

  // ✅ Return request workflow
  return_requested_at: string | null;
  return_requested_by: number | null;
  return_request_note: string | null;
  return_requested_by_name: string | null;
  borrow_updated_at: string | null;

  // joined fields
  email: string | null;
  student_id: string | null;
  full_name: string | null;
  course: string | null;
  college?: string | null;
  title: string | null;
  accession_number: string | null;
  copy_number: number | null;
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

type BorrowableCopySelectionRow = {
  id: number;
  title: string;
  author: string;
  call_number: string | null;
  isbn: string | null;
  accession_number: string | null;
  copy_number: number | null;
  parent_book_id: number | null;
  number_of_copies: number | null;
  borrow_duration_days: number | null;
  is_library_use_only: boolean | null;
  created_at: string;
  active_count: number;
};

// Cast untyped imports into typed wrappers (prevents TS2347)
const dbQuery = query as unknown as DBQueryFn;
const dbPool = pool as unknown as DBPool;

/* ---------------- Helpers ---------------- */

const HOUR_MS = 1000 * 60 * 60;
const DAY_MS = HOUR_MS * 24;
const APP_TIME_ZONE = "Asia/Manila";
const BORROW_EMAIL_NOTIFICATION_CACHE = new Map<string, number>();
const BORROW_EMAIL_NOTIFICATION_COOLDOWN_MS = Math.max(
  HOUR_MS,
  Number(process.env.BORROW_NOTIFICATION_EMAIL_COOLDOWN_MS ?? 20 * HOUR_MS)
);
const BORROW_EMAIL_NOTIFICATION_DETAIL_LIMIT = Math.max(
  3,
  Math.min(20, Number(process.env.BORROW_NOTIFICATION_EMAIL_DETAIL_LIMIT ?? 10))
);
const PENDING_PICKUP_EXPIRY_HOURS = Math.max(1, Number(process.env.PENDING_PICKUP_EXPIRY_HOURS ?? 24));
const PENDING_PICKUP_EXPIRY_MS = PENDING_PICKUP_EXPIRY_HOURS * HOUR_MS;

function getPendingPickupBaseDateTime(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const utcMs = dateOnlyToUtcMs(raw);
    if (!Number.isNaN(utcMs)) {
      return new Date(utcMs);
    }
  }

  return null;
}

function getPendingPickupReferenceDateTime(row: {
  borrow_updated_at?: string | null;
  borrow_date?: string | null;
}) {
  return (
    getPendingPickupBaseDateTime(row.borrow_updated_at) ??
    getPendingPickupBaseDateTime(row.borrow_date)
  );
}

function getPendingPickupExpiryDateTime(row: {
  status?: string | null;
  borrow_updated_at?: string | null;
  borrow_date?: string | null;
}) {
  const status = String(row.status ?? "").trim().toLowerCase();
  if (status !== "pending_pickup") return null;

  const referenceDate = getPendingPickupReferenceDateTime(row);
  if (!referenceDate) return null;

  return new Date(referenceDate.getTime() + PENDING_PICKUP_EXPIRY_MS);
}

function isPendingPickupReservationExpired(
  row: { status?: string | null; borrow_updated_at?: string | null; borrow_date?: string | null },
  now = Date.now()
) {
  const expiryDate = getPendingPickupExpiryDateTime(row);
  if (!expiryDate) return false;
  return expiryDate.getTime() <= now;
}

function getPendingPickupActiveSql(alias = "br") {
  return `(${alias}.status = 'pending_pickup' AND COALESCE(${alias}.updated_at, ${alias}.borrow_date::timestamp) > NOW() - (${PENDING_PICKUP_EXPIRY_HOURS} * INTERVAL '1 hour'))`;
}

function getActiveBorrowRecordSql(alias = "br") {
  return `(${alias}.status <> 'returned' AND NOT (${alias}.status = 'pending_pickup' AND COALESCE(${alias}.updated_at, ${alias}.borrow_date::timestamp) <= NOW() - (${PENDING_PICKUP_EXPIRY_HOURS} * INTERVAL '1 hour')))`;
}

const PROGRAM_TO_COLLEGE = new Map<string, string>([
  ["bsba", "College of Business Administration"],
  ["bsam", "College of Business Administration"],
  ["bshm", "College of Business Administration"],
  ["bsed filipino", "College of Teacher Education"],
  ["bsed english", "College of Teacher Education"],
  ["bsed math", "College of Teacher Education"],
  ["bsed social studies", "College of Teacher Education"],
  ["bachelor of physical education", "College of Teacher Education"],
  ["beed", "College of Teacher Education"],
  ["bs information systems", "College of Computing Studies"],
  ["bs computer science", "College of Computing Studies"],
  ["bs agriculture", "College of Agriculture and Forestry"],
  ["bs forestry", "College of Agriculture and Forestry"],
  ["baels", "College of Liberal Arts, Mathematics and Sciences"],
  ["agricultural biosystems engineering", "School of Engineering"],
  ["bs criminology", "School of Criminal Justice Education"],
]);

const COLLEGE_KEYWORDS: Array<{ label: string; terms: string[] }> = [
  {
    label: "College of Business Administration",
    terms: ["college of business administration", "cba", "business", "marketing", "accounting"],
  },
  {
    label: "College of Teacher Education",
    terms: ["college of teacher education", "cted", "education", "teacher", "beed", "bsed"],
  },
  {
    label: "College of Computing Studies",
    terms: ["college of computing studies", "ccs", "information systems", "computer science", "computing"],
  },
  {
    label: "College of Agriculture and Forestry",
    terms: ["college of agriculture and forestry", "caf", "agriculture", "forestry"],
  },
  {
    label: "College of Liberal Arts, Mathematics and Sciences",
    terms: ["college of liberal arts, mathematics and sciences", "clams", "baels", "liberal arts"],
  },
  {
    label: "School of Engineering",
    terms: ["school of engineering", "soe", "engineering"],
  },
  {
    label: "School of Criminal Justice Education",
    terms: ["school of criminal justice education", "scje", "criminology", "criminal justice"],
  },
];

const DEFAULT_BORROW_POLICIES: Record<BorrowPolicyRole, BorrowPolicyDTO> = {
  student: {
    role: "student",
    maxActiveBorrows: 3,
    defaultBorrowDurationDays: 7,
    maxPerAction: 3,
  },
  faculty: {
    role: "faculty",
    maxActiveBorrows: 10,
    defaultBorrowDurationDays: 30,
    maxPerAction: 10,
  },
  librarian: {
    role: "librarian",
    maxActiveBorrows: 10,
    defaultBorrowDurationDays: 30,
    maxPerAction: 10,
  },
  admin: {
    role: "admin",
    maxActiveBorrows: 10,
    defaultBorrowDurationDays: 30,
    maxPerAction: 10,
  },
  guest: {
    role: "guest",
    maxActiveBorrows: 1,
    defaultBorrowDurationDays: 3,
    maxPerAction: 1,
  },
  other: {
    role: "other",
    maxActiveBorrows: 1,
    defaultBorrowDurationDays: 7,
    maxPerAction: 1,
  },
};

function normalizeRole(raw: unknown): Role {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "student") return "student";
  if (v === "guest") return "guest";
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

function normalizeSpace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeLookupValue(value: string) {
  return normalizeSpace(value).toLowerCase();
}

function deriveCollegeFromCourse(course?: string | null): string | null {
  const raw = String(course ?? "").trim();
  if (!raw) return null;

  const normalized = normalizeLookupValue(raw);

  if (PROGRAM_TO_COLLEGE.has(normalized)) {
    return PROGRAM_TO_COLLEGE.get(normalized) ?? null;
  }

  for (const entry of COLLEGE_KEYWORDS) {
    if (entry.terms.some((term) => normalized.includes(term))) {
      return entry.label;
    }
  }

  return null;
}

function toBorrowPolicyRole(role: unknown): BorrowPolicyRole {
  const normalized = normalizeRole(role);
  if (normalized === "assistant_librarian") return "librarian";
  if (normalized === "student") return "student";
  if (normalized === "guest") return "guest";
  if (normalized === "librarian") return "librarian";
  if (normalized === "faculty") return "faculty";
  if (normalized === "admin") return "admin";
  return "other";
}

function parseBorrowPolicyRoleParam(raw: unknown): BorrowPolicyRole | null {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "student") return "student";
  if (v === "guest") return "guest";
  if (v === "faculty") return "faculty";
  if (v === "librarian") return "librarian";
  if (v === "admin") return "admin";
  if (v === "other") return "other";
  if (
    v === "assistant_librarian" ||
    v === "assistant librarian" ||
    v === "assistant-librarian"
  ) {
    return "librarian";
  }
  return null;
}

function getBorrowPolicy(role: unknown): BorrowPolicyDTO {
  return DEFAULT_BORROW_POLICIES[toBorrowPolicyRole(role)];
}

function listBorrowPolicies(): BorrowPolicyDTO[] {
  return [
    DEFAULT_BORROW_POLICIES.student,
    DEFAULT_BORROW_POLICIES.faculty,
    DEFAULT_BORROW_POLICIES.librarian,
    DEFAULT_BORROW_POLICIES.admin,
    DEFAULT_BORROW_POLICIES.guest,
    DEFAULT_BORROW_POLICIES.other,
  ];
}

function formatBorrowPolicyRoleLabel(role: BorrowPolicyRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
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
 * so values like "Student" / "Faculty" / "Guest" / "Assistant Librarian" don't break authorization.
 */
function computeEffectiveRoleFromRow(row: UserRoleRow): Role {
  const primary = normalizeRole(row.account_type ?? "student");
  const legacy = row.role != null ? normalizeRole(row.role) : undefined;

  if (primary !== "student" && primary !== "other") return primary;

  if (
    primary === "student" &&
    legacy &&
    legacy !== "student" &&
    legacy !== "other"
  ) {
    return legacy;
  }

  if (primary === "other" && legacy && legacy !== "other") {
    return legacy;
  }

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

function getBorrowFinePerHour(): number {
  const raw = Number(process.env.BORROW_FINE_PER_HOUR ?? 10);
  if (!Number.isFinite(raw) || raw < 0) return 10;
  return raw;
}


function escapeHtml(input: string) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getDateOnlyInTimeZone(date = new Date(), timeZone = APP_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";

  return `${year}-${month}-${day}`;
}

function dateOnlyToUtcMs(value: string) {
  const [year, month, day] = String(value)
    .split("-")
    .map((part) => Number(part));

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return Number.NaN;
  }

  return Date.UTC(year, month - 1, day);
}

function compareDateOnly(left: string, right: string) {
  return dateOnlyToUtcMs(left) - dateOnlyToUtcMs(right);
}

function getDueNotificationKind(
  dueDate: string | null | undefined,
  todayDateOnly: string
): "due_today" | "overdue" | null {
  if (!dueDate) return null;

  const diff = compareDateOnly(dueDate, todayDateOnly);
  if (Number.isNaN(diff)) return null;
  if (diff < 0) return "overdue";
  if (diff === 0) return "due_today";
  return null;
}

function formatFriendlyBorrowDate(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw) return "—";

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const utcMs = dateOnlyToUtcMs(raw);
    if (!Number.isNaN(utcMs)) {
      return new Intl.DateTimeFormat("en-PH", {
        timeZone: "UTC",
        year: "numeric",
        month: "short",
        day: "numeric",
      }).format(new Date(utcMs));
    }
  }

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;

  return new Intl.DateTimeFormat("en-PH", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

function formatFriendlyBorrowDateTime(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw) return "—";

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return formatFriendlyBorrowDate(raw);
  }

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;

  return new Intl.DateTimeFormat("en-PH", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function getOverdueDays(dueDate: string | null | undefined, todayDateOnly: string) {
  if (!dueDate) return 0;

  const diff = compareDateOnly(todayDateOnly, dueDate);
  if (Number.isNaN(diff) || diff <= 0) return 0;
  return Math.max(0, Math.round(diff / DAY_MS));
}

function getStaffNotificationPriority(
  row: BorrowNotificationEmailRow,
  todayDateOnly: string,
  canManageExtensions: boolean
) {
  if (getDueNotificationKind(row.due_date, todayDateOnly) === "overdue") return 0;
  if (row.status === "pending_pickup") return 1;
  if (
    row.status === "pending_return" ||
    row.status === "pending" ||
    Boolean(row.return_requested_at)
  ) {
    return 2;
  }
  if (
    canManageExtensions &&
    String(row.extension_request_status ?? "").toLowerCase().trim() === "pending"
  ) {
    return 3;
  }
  if (getDueNotificationKind(row.due_date, todayDateOnly) === "due_today") return 4;
  return 5;
}

function getStaffNotificationLabel(
  row: BorrowNotificationEmailRow,
  todayDateOnly: string,
  canManageExtensions: boolean
) {
  const dueKind = getDueNotificationKind(row.due_date, todayDateOnly);
  if (dueKind === "overdue") {
    const overdueDays = getOverdueDays(row.due_date, todayDateOnly);
    return overdueDays > 0
      ? `Overdue (${overdueDays} day${overdueDays === 1 ? "" : "s"})`
      : "Overdue";
  }
  if (row.status === "pending_pickup") return "Reserved Pending Pickup";
  if (row.status === "pending_return" || row.status === "pending") {
    return "Pending Return";
  }
  if (Boolean(row.return_requested_at)) return "Return Requested";
  if (
    canManageExtensions &&
    String(row.extension_request_status ?? "").toLowerCase().trim() === "pending"
  ) {
    return "Extension Pending";
  }
  if (dueKind === "due_today") return "Due Today";
  return "Borrowed";
}

function formatStaffNotificationEmailLine(
  row: BorrowNotificationEmailRow,
  todayDateOnly: string,
  canManageExtensions: boolean
) {
  const borrowerName = trimText(row.full_name, 80) || `Borrower #${row.user_id}`;
  const title = getBorrowRecordTitle(row);
  const label = getStaffNotificationLabel(row, todayDateOnly, canManageExtensions);
  const due = row.due_date ? ` • Due ${formatFriendlyBorrowDate(row.due_date)}` : "";
  const note = row.return_request_note
    ? ` • Note: ${trimText(row.return_request_note, 90)}`
    : "";

  return `• ${borrowerName} — ${title} (Borrow ID ${row.id} • ${label}${due}${note})`;
}

function formatBorrowRecordCopyLabel(row: {
  copy_number?: number | null;
  accession_number?: string | null;
}) {
  const parts: string[] = [];

  if (typeof row.copy_number === "number" && Number.isFinite(row.copy_number)) {
    parts.push(`Copy ${row.copy_number}`);
  }

  const accessionNumber = String(row.accession_number ?? "").trim();
  if (accessionNumber) {
    parts.push(`Accession ${accessionNumber}`);
  }

  return parts.join(" • ");
}

function getBorrowRecordTitle(row: {
  title?: string | null;
  id?: string | number | null;
  copy_number?: number | null;
  accession_number?: string | null;
}) {
  const title = String(row.title ?? "").trim();
  const copyLabel = formatBorrowRecordCopyLabel(row);

  if (title) {
    return copyLabel ? `${title} (${copyLabel})` : title;
  }

  return `Borrow record #${row.id ?? "—"}`;
}

function trimText(value: string | null | undefined, max = 160) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function pruneBorrowNotificationEmailCache(now = Date.now()) {
  for (const [key, timestamp] of BORROW_EMAIL_NOTIFICATION_CACHE.entries()) {
    if (now - timestamp >= BORROW_EMAIL_NOTIFICATION_COOLDOWN_MS) {
      BORROW_EMAIL_NOTIFICATION_CACHE.delete(key);
    }
  }
}

function claimBorrowNotificationEmailSlot(key: string) {
  const now = Date.now();
  pruneBorrowNotificationEmailCache(now);

  const lastSentAt = BORROW_EMAIL_NOTIFICATION_CACHE.get(key);
  if (
    typeof lastSentAt === "number" &&
    Number.isFinite(lastSentAt) &&
    now - lastSentAt < BORROW_EMAIL_NOTIFICATION_COOLDOWN_MS
  ) {
    return false;
  }

  BORROW_EMAIL_NOTIFICATION_CACHE.set(key, now);
  return true;
}

function formatBorrowEmailLine(
  row: BorrowNotificationEmailRow,
  kind: "due_today" | "overdue" | "return_requested"
) {
  const title = getBorrowRecordTitle(row);
  const due = row.due_date
    ? `Due ${formatFriendlyBorrowDate(row.due_date)}`
    : "No due date";
  const borrower = row.full_name ? ` • Borrower: ${row.full_name}` : "";
  const requestedAt =
    kind === "return_requested" && row.return_requested_at
      ? ` • Requested: ${formatFriendlyBorrowDateTime(row.return_requested_at)}`
      : "";
  const note =
    kind === "return_requested" && row.return_request_note
      ? ` • Note: ${trimText(row.return_request_note, 90)}`
      : "";
  return `• ${title} (Borrow ID ${row.id} • ${due}${borrower}${requestedAt}${note})`;
}

function buildBorrowerDashboardEmail(opts: {
  fullName?: string | null;
  todayDateOnly: string;
  dueTodayRows: BorrowNotificationEmailRow[];
  overdueRows: BorrowNotificationEmailRow[];
  returnRequestRows: BorrowNotificationEmailRow[];
}) {
  const dueTodayCount = opts.dueTodayRows.length;
  const overdueCount = opts.overdueRows.length;
  const returnRequestCount = opts.returnRequestRows.length;

  const subjectParts: string[] = [];
  if (overdueCount > 0) {
    subjectParts.push(`${overdueCount} overdue book${overdueCount === 1 ? "" : "s"}`);
  }
  if (dueTodayCount > 0) {
    subjectParts.push(`${dueTodayCount} due today`);
  }
  if (returnRequestCount > 0) {
    subjectParts.push(`${returnRequestCount} return request${returnRequestCount === 1 ? "" : "s"}`);
  }

  const subject = `Book-Hive reminder: ${subjectParts.join(" • ")}`;
  const greetingName = trimText(opts.fullName, 80) || "Borrower";

  const textSections = [
    dueTodayCount > 0
      ? [`Books due today (${dueTodayCount})`, ...opts.dueTodayRows.map((row) => formatBorrowEmailLine(row, "due_today"))].join("\n")
      : "",
    overdueCount > 0
      ? [`Overdue books (${overdueCount})`, ...opts.overdueRows.map((row) => formatBorrowEmailLine(row, "overdue"))].join("\n")
      : "",
    returnRequestCount > 0
      ? [
          `Librarian return requests (${returnRequestCount})`,
          ...opts.returnRequestRows.map((row) => formatBorrowEmailLine(row, "return_requested")),
        ].join("\n")
      : "",
  ].filter(Boolean);

  const text = [
    `Hello ${greetingName},`,
    "",
    `These borrow notifications currently match what is showing in your Book-Hive dashboard as of ${formatFriendlyBorrowDate(opts.todayDateOnly)}.`,
    "",
    ...textSections.flatMap((section) => [section, ""]),
    "Please open your Book-Hive circulation dashboard to review the full details.",
  ].join("\n");

  const renderList = (
    title: string,
    rows: BorrowNotificationEmailRow[],
    kind: "due_today" | "overdue" | "return_requested"
  ) => {
    if (!rows.length) return "";
    return `
      <div style="margin-top:16px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:8px;">${escapeHtml(title)}</div>
        <ul style="margin:0;padding-left:18px;color:#111827;">
          ${rows
            .map((row) => `<li style="margin-bottom:6px;">${escapeHtml(formatBorrowEmailLine(row, kind).replace(/^•\s*/, ""))}</li>`)
            .join("")}
        </ul>
      </div>
    `;
  };

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;background:#f8fafc;padding:24px;color:#111827;">
      <div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:24px;">
        <div style="font-size:20px;font-weight:700;margin-bottom:8px;">Book-Hive borrow reminder</div>
        <div style="font-size:14px;line-height:1.6;color:#334155;">
          Hello ${escapeHtml(greetingName)},<br /><br />
          These borrow notifications currently match what is showing in your Book-Hive dashboard as of
          <strong>${escapeHtml(formatFriendlyBorrowDate(opts.todayDateOnly))}</strong>.
        </div>
        ${renderList("Books due today", opts.dueTodayRows, "due_today")}
        ${renderList("Overdue books", opts.overdueRows, "overdue")}
        ${renderList(
          "Librarian return requests",
          opts.returnRequestRows,
          "return_requested"
        )}
        <div style="margin-top:18px;font-size:13px;color:#475569;line-height:1.6;">
          Please open your Book-Hive circulation dashboard to review the full details.
        </div>
      </div>
    </div>
  `;

  return { subject, text, html };
}

function buildStaffDashboardEmail(opts: {
  fullName?: string | null;
  todayDateOnly: string;
  pendingPickupCount: number;
  pendingReturnCount: number;
  pendingExtensionCount: number;
  dueTodayCount: number;
  overdueCount: number;
  canManageExtensions: boolean;
  notificationRows: BorrowNotificationEmailRow[];
}) {
  const totalNotifications = opts.notificationRows.length;
  const subject = `Book-Hive librarian alert: ${totalNotifications} notification${totalNotifications === 1 ? "" : "s"} need attention`;
  const greetingName = trimText(opts.fullName, 80) || "Library staff";
  const friendlyToday = formatFriendlyBorrowDate(opts.todayDateOnly);

  const dashboardCounts = [
    `Reserved pending pickup: ${opts.pendingPickupCount}`,
    `Pending return: ${opts.pendingReturnCount}`,
    `Pending extension: ${opts.pendingExtensionCount}`,
    `Due today: ${opts.dueTodayCount}`,
    `Overdue: ${opts.overdueCount}`,
  ];

  const notificationLines = opts.notificationRows.map((row) =>
    formatStaffNotificationEmailLine(row, opts.todayDateOnly, opts.canManageExtensions)
  );

  const text = [
    `Hello ${greetingName},`,
    "",
    `Here is your Book-Hive borrow records digest for ${friendlyToday}.`,
    "",
    "Dashboard counts:",
    ...dashboardCounts.map((line) => `• ${line}`),
    "",
    "Included borrower records in Automatic email updates",
    "These are the borrower records currently included in the automatic email update snapshot.",
    ...(notificationLines.length
      ? ["", ...notificationLines]
      : ["", "• No borrower records are currently included in the automatic email update snapshot."]),
    "",
    "Please open the Borrow Records dashboard to review and process these items.",
  ].join("\n");

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;background:#f8fafc;padding:24px;color:#111827;">
      <div style="max-width:720px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:24px;">
        <div style="font-size:20px;font-weight:700;margin-bottom:8px;">Book-Hive borrow records alert</div>
        <div style="font-size:14px;line-height:1.6;color:#334155;">
          Hello ${escapeHtml(greetingName)},<br /><br />
          Here is your borrow records digest for <strong>${escapeHtml(friendlyToday)}</strong>.
        </div>
        <div style="margin-top:16px;padding:16px;border:1px solid #e2e8f0;border-radius:12px;background:#f8fafc;">
          <div style="font-size:14px;font-weight:700;margin-bottom:8px;">Dashboard counts</div>
          <ul style="margin:0;padding-left:18px;color:#111827;">
            ${dashboardCounts.map((line) => `<li style="margin-bottom:6px;">${escapeHtml(line)}</li>`).join("")}
          </ul>
        </div>
        <div style="margin-top:16px;padding:16px;border:1px solid #dbeafe;border-radius:12px;background:#eff6ff;">
          <div style="font-size:14px;font-weight:700;margin-bottom:8px;">Included borrower records in Automatic email updates</div>
          <div style="font-size:12px;line-height:1.6;color:#475569;">
            These are the borrower records currently included in the automatic email update snapshot.
          </div>
          ${notificationLines.length
            ? `
              <ul style="margin:12px 0 0;padding-left:18px;color:#111827;">
                ${notificationLines
                  .map((line) => `<li style="margin-bottom:6px;">${escapeHtml(line.replace(/^•\s*/, ""))}</li>`)
                  .join("")}
              </ul>
            `
            : `
              <div style="margin-top:12px;font-size:13px;color:#475569;line-height:1.6;">
                No borrower records are currently included in the automatic email update snapshot.
              </div>
            `}
        </div>
        <div style="margin-top:18px;font-size:13px;color:#475569;line-height:1.6;">
          Please open the Borrow Records dashboard to review and process these items.
        </div>
      </div>
    </div>
  `;

  return { subject, text, html, totalNotifications };
}

async function sendBorrowNotificationEmail(args: {
  to: string | null | undefined;
  subject: string;
  text: string;
  html: string;
}) {
  const recipient = String(args.to ?? "").trim();
  if (!recipient) return false;

  try {
    await sendMail({
      to: recipient,
      subject: args.subject,
      text: args.text,
      html: args.html,
    });
    return true;
  } catch (error) {
    console.error("[borrow-records] notification email failed", {
      to: recipient,
      error,
    });
    return false;
  }
}

async function sendBorrowWorkflowEmail(args: {
  joinedRow: BorrowRowJoined;
  event:
    | "return_requested_by_staff"
    | "extension_approved"
    | "extension_disapproved"
    | "due_date_updated"
    | "return_confirmed";
}) {
  const recipient = String(args.joinedRow.email ?? "").trim();
  if (!recipient) return false;

  const borrowerName = trimText(args.joinedRow.full_name, 80) || "Borrower";
  const bookTitle = getBorrowRecordTitle(args.joinedRow);
  const dueDate = formatFriendlyBorrowDate(args.joinedRow.due_date);
  const returnDate = formatFriendlyBorrowDate(args.joinedRow.return_date);
  const note = trimText(args.joinedRow.extension_decision_note ?? args.joinedRow.return_request_note ?? "", 180);

  let title = "Book-Hive notification";
  let intro = "There is an update on your borrow record.";
  let details: string[] = [];

  if (args.event === "return_requested_by_staff") {
    title = `Book-Hive: return requested for "${bookTitle}"`;
    intro = "A librarian requested that you return this book.";
    details = [
      `Borrow ID: ${args.joinedRow.id}`,
      `Book: ${bookTitle}`,
      `Current due date: ${dueDate}`,
      note ? `Staff note: ${note}` : "",
    ].filter(Boolean);
  } else if (args.event === "extension_approved") {
    title = `Book-Hive: extension approved for "${bookTitle}"`;
    intro = "Your borrow extension request was approved.";
    details = [
      `Borrow ID: ${args.joinedRow.id}`,
      `Book: ${bookTitle}`,
      `New due date: ${dueDate}`,
      note ? `Decision note: ${note}` : "",
    ].filter(Boolean);
  } else if (args.event === "extension_disapproved") {
    title = `Book-Hive: extension not approved for "${bookTitle}"`;
    intro = "Your borrow extension request was not approved.";
    details = [
      `Borrow ID: ${args.joinedRow.id}`,
      `Book: ${bookTitle}`,
      `Current due date: ${dueDate}`,
      note ? `Decision note: ${note}` : "",
    ].filter(Boolean);
  } else if (args.event === "due_date_updated") {
    title = `Book-Hive: due date updated for "${bookTitle}"`;
    intro = "A librarian updated the due date of your borrow record.";
    details = [
      `Borrow ID: ${args.joinedRow.id}`,
      `Book: ${bookTitle}`,
      `Updated due date: ${dueDate}`,
    ];
  } else if (args.event === "return_confirmed") {
    title = `Book-Hive: return confirmed for "${bookTitle}"`;
    intro = "Your book return has been recorded.";
    details = [
      `Borrow ID: ${args.joinedRow.id}`,
      `Book: ${bookTitle}`,
      `Return date: ${returnDate}`,
      `Fine: ₱${Number(args.joinedRow.fine ?? 0).toFixed(2)}`,
    ];
  }

  const text = [
    `Hello ${borrowerName},`,
    "",
    intro,
    "",
    ...details.map((line) => `• ${line}`),
    "",
    "Please open your Book-Hive circulation dashboard to review the full details.",
  ].join("\n");

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;background:#f8fafc;padding:24px;color:#111827;">
      <div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:24px;">
        <div style="font-size:20px;font-weight:700;margin-bottom:8px;">${escapeHtml(title)}</div>
        <div style="font-size:14px;line-height:1.6;color:#334155;">
          Hello ${escapeHtml(borrowerName)},<br /><br />
          ${escapeHtml(intro)}
        </div>
        <ul style="margin:16px 0 0;padding-left:18px;color:#111827;">
          ${details.map((line) => `<li style="margin-bottom:6px;">${escapeHtml(line)}</li>`).join("")}
        </ul>
        <div style="margin-top:18px;font-size:13px;color:#475569;line-height:1.6;">
          Please open your Book-Hive circulation dashboard to review the full details.
        </div>
      </div>
    </div>
  `;

  return sendBorrowNotificationEmail({
    to: recipient,
    subject: title,
    text,
    html,
  });
}

function endOfUtcDay(dateStr: string): Date {
  return new Date(`${dateStr}T23:59:59.999Z`);
}

function computeBorrowFineMetrics(
  dueDate: string,
  returnDate: string | null,
  finePerHour: number
) {
  const dueCutoff = endOfUtcDay(dueDate);

  const end = returnDate ? endOfUtcDay(returnDate) : new Date();
  const overdueMs = Math.max(0, end.getTime() - dueCutoff.getTime());
  const overdueHours = overdueMs > 0 ? Math.ceil(overdueMs / HOUR_MS) : 0;
  const overdueDays = overdueHours > 0 ? Math.ceil(overdueHours / 24) : 0;
  const computedFine = overdueHours * finePerHour;

  return {
    overdueMs,
    overdueHours,
    overdueDays,
    computedFine,
  };
}

function parsePositiveInteger(raw: unknown): number | null {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function resolveBorrowDurationDays(
  role: unknown,
  bookBorrowDurationDays: unknown
): number {
  const fromBook = parsePositiveInteger(bookBorrowDurationDays);
  if (fromBook) return fromBook;

  const policy = getBorrowPolicy(role);
  const fromPolicy = parsePositiveInteger(policy.defaultBorrowDurationDays);
  if (fromPolicy) return fromPolicy;

  const fromEnv = parsePositiveInteger(process.env.BORROW_DAYS);
  if (fromEnv) return fromEnv;

  return 7;
}

async function countActiveBorrowRecordsForUser(
  client: DBClient,
  userId: number
): Promise<number> {
  const result = await client.query<{ active_count: number }>(
    `SELECT COUNT(*)::int AS active_count
       FROM borrow_records br
      WHERE br.user_id = $1
        AND ${getActiveBorrowRecordSql('br')}`,
    [userId]
  );

  const count = result.rows[0]?.active_count;
  return typeof count === "number" && Number.isFinite(count) ? count : 0;
}

function getQuantityPolicyError(
  quantity: number,
  policy: BorrowPolicyDTO
): string | null {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return "Quantity must be a positive whole number.";
  }

  if (quantity > policy.maxPerAction) {
    return `${formatBorrowPolicyRoleLabel(policy.role)} can only borrow up to ${
      policy.maxPerAction
    } book${policy.maxPerAction === 1 ? "" : "s"} per request.`;
  }

  return null;
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

            br.return_requested_at,
            br.return_requested_by,
            br.return_request_note,
            rq.full_name AS return_requested_by_name,
            br.updated_at AS borrow_updated_at,

            u.email,
            u.student_id,
            u.full_name,
            u.course,
            b.title,
            b.accession_number,
            b.copy_number

     FROM borrow_records br
     LEFT JOIN users u ON u.id = br.user_id
     LEFT JOIN users rq ON rq.id = br.return_requested_by
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

            br.return_requested_at,
            br.return_requested_by,
            br.return_request_note,
            rq.full_name AS return_requested_by_name,
            br.updated_at AS borrow_updated_at,

            u.email,
            u.student_id,
            u.full_name,
            u.course,
            b.title,
            b.accession_number,
            b.copy_number

     FROM borrow_records br
     LEFT JOIN users u ON u.id = br.user_id
     LEFT JOIN users rq ON rq.id = br.return_requested_by
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
 * activeBorrowCount = borrow_records where active reservations still block availability
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
       FROM borrow_records br
       WHERE br.book_id = $1
         AND ${getActiveBorrowRecordSql('br')}`,
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
 * Each borrow request still creates 1 borrow_record per assigned physical copy.
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

  const cap = Math.floor(
    Number(process.env.BORROW_MAX_COPIES_PER_ACTION ?? 10)
  );
  const maxAllowed = Number.isFinite(cap) && cap > 0 ? cap : 10;

  return Math.min(q, maxAllowed);
}

function getBorrowableCopyGroupRootId(
  row: Pick<BorrowableCopySelectionRow, "id" | "parent_book_id">
) {
  if (
    typeof row.parent_book_id === "number" &&
    Number.isFinite(row.parent_book_id) &&
    row.parent_book_id > 0
  ) {
    return Math.floor(row.parent_book_id);
  }

  return Math.floor(row.id);
}

function isOriginalBorrowableCopyRow(
  row: Pick<BorrowableCopySelectionRow, "id" | "parent_book_id">
) {
  return getBorrowableCopyGroupRootId(row) === Math.floor(row.id);
}

function compareBorrowableCopySelectionRows(
  a: BorrowableCopySelectionRow,
  b: BorrowableCopySelectionRow
) {
  const aIsOriginal = isOriginalBorrowableCopyRow(a);
  const bIsOriginal = isOriginalBorrowableCopyRow(b);

  if (aIsOriginal !== bIsOriginal) {
    return aIsOriginal ? -1 : 1;
  }

  const aCopyNumber =
    typeof a.copy_number === "number" && Number.isFinite(a.copy_number)
      ? a.copy_number
      : Number.MAX_SAFE_INTEGER;
  const bCopyNumber =
    typeof b.copy_number === "number" && Number.isFinite(b.copy_number)
      ? b.copy_number
      : Number.MAX_SAFE_INTEGER;
  if (aCopyNumber !== bCopyNumber) {
    return aCopyNumber - bCopyNumber;
  }

  const createdAtDiff =
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  if (Number.isFinite(createdAtDiff) && createdAtDiff !== 0) {
    return createdAtDiff;
  }

  return a.id - b.id;
}

function getRemainingUnitsForBorrowableCopyRow(
  row: BorrowableCopySelectionRow,
  options?: { forceSingleCopyUnit?: boolean }
): number {
  const totalUnits = options?.forceSingleCopyUnit
    ? 1
    : typeof row.number_of_copies === "number" &&
        Number.isFinite(row.number_of_copies) &&
        row.number_of_copies > 0
      ? Math.floor(row.number_of_copies)
      : 1;
  const rawActiveCount =
    typeof row.active_count === "number" && Number.isFinite(row.active_count)
      ? row.active_count
      : 0;
  const activeCount = options?.forceSingleCopyUnit
    ? Math.min(rawActiveCount, totalUnits)
    : rawActiveCount;

  return Math.max(0, totalUnits - activeCount);
}

async function resolveBorrowableCopySelection(
  client: DBClient,
  bookId: number
): Promise<{
  source: BorrowableCopySelectionRow;
  rows: BorrowableCopySelectionRow[];
} | null> {
  const sourceResult = await client.query<BorrowableCopySelectionRow>(
    `SELECT id,
            title,
            author,
            call_number,
            isbn,
            accession_number,
            copy_number,
            parent_book_id,
            number_of_copies,
            borrow_duration_days,
            is_library_use_only,
            created_at,
            0::int AS active_count
       FROM books
       WHERE id = $1
       FOR UPDATE`,
    [bookId]
  );

  if (!sourceResult.rowCount) {
    return null;
  }

  const source = sourceResult.rows[0];
  const groupRootId = getBorrowableCopyGroupRootId(source);

  const groupedRowsResult = await client.query<BorrowableCopySelectionRow>(
    `SELECT b.id,
            b.title,
            b.author,
            b.call_number,
            b.isbn,
            b.accession_number,
            b.copy_number,
            b.parent_book_id,
            b.number_of_copies,
            b.borrow_duration_days,
            b.is_library_use_only,
            b.created_at,
            COALESCE(stats.active_count, 0)::int AS active_count
       FROM books b
       LEFT JOIN (
         SELECT br.book_id,
                COUNT(*) FILTER (WHERE ${getActiveBorrowRecordSql('br')})::int AS active_count
           FROM borrow_records br
          GROUP BY br.book_id
       ) stats ON stats.book_id = b.id
      WHERE b.id = $1 OR b.parent_book_id = $1
      FOR UPDATE OF b`,
    [groupRootId]
  );

  const rows = groupedRowsResult.rows.length
    ? groupedRowsResult.rows.slice().sort(compareBorrowableCopySelectionRows)
    : [source];

  return { source, rows };
}

function selectBorrowableBookIdsInCycle(
  rows: BorrowableCopySelectionRow[],
  quantity: number
): number[] {
  const target = Math.max(0, Math.floor(Number(quantity) || 0));
  if (target <= 0 || rows.length === 0) return [];

  const forceSingleCopyUnit = rows.length > 1;
  const orderedRows = rows
    .slice()
    .sort(compareBorrowableCopySelectionRows)
    .map((row) => ({
      bookId: row.id,
      remaining: getRemainingUnitsForBorrowableCopyRow(row, {
        forceSingleCopyUnit,
      }),
    }))
    .filter((row) => row.remaining > 0);

  const selected: number[] = [];

  for (const row of orderedRows) {
    while (row.remaining > 0 && selected.length < target) {
      selected.push(row.bookId);
      row.remaining -= 1;
    }

    if (selected.length >= target) {
      break;
    }
  }

  return selected;
}

async function recomputeAndUpdateBookAvailabilityForBookIds(
  client: DBClient,
  bookIds: number[]
): Promise<void> {
  const uniqueBookIds = Array.from(
    new Set(
      bookIds.filter((value) => Number.isFinite(value) && value > 0)
    )
  );

  for (const bookId of uniqueBookIds) {
    await recomputeAndUpdateBookAvailability(client, bookId);
  }
}

async function releaseExpiredPendingPickupReservations(
  client: DBClient
): Promise<number[]> {
  const expired = await client.query<{ book_id: number }>(
    `DELETE FROM borrow_records br
      WHERE br.status = 'pending_pickup'
        AND COALESCE(br.updated_at, br.borrow_date::timestamp) <= NOW() - (${PENDING_PICKUP_EXPIRY_HOURS} * INTERVAL '1 hour')
      RETURNING book_id`
  );

  const bookIds = Array.from(
    new Set(
      expired.rows
        .map((row) => Number(row.book_id))
        .filter((value) => Number.isFinite(value) && value > 0)
    )
  );

  await recomputeAndUpdateBookAvailabilityForBookIds(client, bookIds);

  return bookIds;
}

async function releaseExpiredPendingPickupReservationsNow(): Promise<void> {
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    await releaseExpiredPendingPickupReservations(client);
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Convert a DB row into the DTO the client expects.
 */
function toDTO(row: BorrowRowJoined, finePerHour: number) {
  const metrics = computeBorrowFineMetrics(
    row.due_date,
    row.return_date,
    finePerHour
  );

  let fine: number;
  if (row.status === "returned" && row.fine != null) {
    const stored = Number(row.fine);
    fine = Number.isNaN(stored) ? metrics.computedFine : stored;
  } else {
    fine = metrics.computedFine;
  }

  const safeReqStatus = ((): ExtensionRequestStatus => {
    const v = String(row.extension_request_status ?? "none").toLowerCase();
    if (v === "pending") return "pending";
    if (v === "approved") return "approved";
    if (v === "disapproved") return "disapproved";
    return "none";
  })();

  const college = row.college ?? deriveCollegeFromCourse(row.course);

  return {
    id: String(row.id),
    userId: String(row.user_id),
    studentEmail: row.email,
    studentId: row.student_id,
    studentName: row.full_name,
    course: row.course ?? null,
    college,
    bookId: String(row.book_id),
    bookTitle: row.title,
    accessionNumber: row.accession_number,
    copyNumber:
      typeof row.copy_number === "number" && Number.isFinite(row.copy_number)
        ? row.copy_number
        : null,
    borrowDate: row.borrow_date,
    dueDate: row.due_date,
    returnDate: row.return_date,
    status: row.status,
    fine,
    finePerHour,
    overdueHours: metrics.overdueHours,
    overdueDays: metrics.overdueDays,

    extensionCount:
      typeof row.extension_count === "number" &&
      Number.isFinite(row.extension_count)
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

    returnRequestedAt: row.return_requested_at ?? null,
    returnRequestedBy:
      typeof row.return_requested_by === "number" &&
      Number.isFinite(row.return_requested_by)
        ? row.return_requested_by
        : null,
    returnRequestedByName: row.return_requested_by_name ?? null,
    returnRequestNote: row.return_request_note ?? null,

    reservationWindowHours: PENDING_PICKUP_EXPIRY_HOURS,
    reservationExpiresAt: getPendingPickupExpiryDateTime(row)?.toISOString() ?? null,
    reservationExpired: isPendingPickupReservationExpired(row),
  };
}

/* ---------------- Routes ---------------- */

/**
 * GET /api/borrow-records
 * List all borrow records (assistant_librarian/librarian/admin).
 */
router.get(
  "/",
  requireAuth,
  requireRole(["assistant_librarian", "librarian", "admin"]),
  async (_req, res, next) => {
    try {
      await releaseExpiredPendingPickupReservationsNow();

      const finePerHour = getBorrowFinePerHour();

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

                br.return_requested_at,
                br.return_requested_by,
                br.return_request_note,
                rq.full_name AS return_requested_by_name,
                br.updated_at AS borrow_updated_at,

                u.email,
                u.student_id,
                u.full_name,
                u.course,
                b.title,
                b.accession_number,
                b.copy_number

         FROM borrow_records br
         LEFT JOIN users u ON u.id = br.user_id
         LEFT JOIN users rq ON rq.id = br.return_requested_by
         LEFT JOIN books b ON b.id = br.book_id
         ORDER BY br.borrow_date DESC, br.id DESC`
      );

      const records = result.rows.map((r) => toDTO(r, finePerHour));
      res.json({ ok: true, records });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/borrow-records/summary
 * Notification/read-unread style counts for the borrow records workflow.
 *
 * unreadCount = records that still need staff action
 * readCount = records that are already handled / not waiting on staff
 *
 * assistant_librarian:
 * - sees pending pickup + pending return counts
 *
 * librarian/admin:
 * - also sees pending extension requests
 */
router.get(
  "/summary",
  requireAuth,
  requireRole(["assistant_librarian", "librarian", "admin"]),
  async (req, res, next) => {
    try {
      await releaseExpiredPendingPickupReservationsNow();

      const session = (req as any).sessionUser as SessionPayload;
      const effectiveRole = await getEffectiveRole(session.sub, session.role);
      const canManageExtensions =
        effectiveRole === "librarian" || effectiveRole === "admin";

      const result = await dbQuery<BorrowNotificationsSummaryRow>(
        `SELECT COUNT(*)::int AS total_records,

                COUNT(*) FILTER (
                  WHERE br.return_date IS NULL
                    AND ${getActiveBorrowRecordSql('br')}
                    AND ${getPendingPickupActiveSql('br')}
                )::int AS pending_pickup_count,

                COUNT(*) FILTER (
                  WHERE br.return_date IS NULL
                    AND ${getActiveBorrowRecordSql('br')}
                    AND br.status IN ('pending_return', 'pending')
                )::int AS pending_return_count,

                COUNT(*) FILTER (
                  WHERE br.return_date IS NULL
                    AND ${getActiveBorrowRecordSql('br')}
                    AND br.extension_request_status = 'pending'
                )::int AS pending_extension_count,

                COUNT(*) FILTER (
                  WHERE br.return_date IS NULL
                    AND ${getActiveBorrowRecordSql('br')}
                    AND (
                      ${getPendingPickupActiveSql('br')}
                      OR br.status IN ('pending_return', 'pending')
                      OR ($1::boolean AND br.extension_request_status = 'pending')
                    )
                )::int AS action_required_count
         FROM borrow_records br`,
        [canManageExtensions]
      );

      const row = result.rows[0] ?? {
        total_records: 0,
        pending_pickup_count: 0,
        pending_return_count: 0,
        pending_extension_count: 0,
        action_required_count: 0,
      };

      const unreadCount =
        typeof row.action_required_count === "number" &&
        Number.isFinite(row.action_required_count)
          ? row.action_required_count
          : 0;

      const totalRecords =
        typeof row.total_records === "number" && Number.isFinite(row.total_records)
          ? row.total_records
          : 0;

      const handledCount = Math.max(0, totalRecords - unreadCount);

      return res.json({
        ok: true,
        summary: {
          role: effectiveRole,
          canManageExtensions,
          totalRecords,
          actionRequiredCount: unreadCount,
          unreadCount,
          handledCount,
          readCount: handledCount,
          pendingPickupCount:
            typeof row.pending_pickup_count === "number" &&
            Number.isFinite(row.pending_pickup_count)
              ? row.pending_pickup_count
              : 0,
          pendingReturnCount:
            typeof row.pending_return_count === "number" &&
            Number.isFinite(row.pending_return_count)
              ? row.pending_return_count
              : 0,
          pendingExtensionCount:
            canManageExtensions &&
            typeof row.pending_extension_count === "number" &&
            Number.isFinite(row.pending_extension_count)
              ? row.pending_extension_count
              : 0,
        },
      });
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
    await releaseExpiredPendingPickupReservationsNow();

    const s = (req as any).sessionUser as SessionPayload;
    const userId = Number(s.sub);
    const finePerHour = getBorrowFinePerHour();

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

              br.return_requested_at,
              br.return_requested_by,
              br.return_request_note,
              rq.full_name AS return_requested_by_name,
              br.updated_at AS borrow_updated_at,

              u.email,
              u.student_id,
              u.full_name,
              u.course,
              b.title,
              b.accession_number,
              b.copy_number

       FROM borrow_records br
       LEFT JOIN users u ON u.id = br.user_id
       LEFT JOIN users rq ON rq.id = br.return_requested_by
       LEFT JOIN books b ON b.id = br.book_id
       WHERE br.user_id = $1
       ORDER BY br.borrow_date DESC, br.id DESC`,
      [userId]
    );

    const records = result.rows.map((r) => toDTO(r, finePerHour));
    res.json({ ok: true, records });
  } catch (err) {
    next(err);
  }
});


router.post("/notifications/email-sync", requireAuth, async (req, res, next) => {
  try {
    const session = (req as any).sessionUser as SessionPayload;
    const effectiveRole = await getEffectiveRole(session.sub, session.role);
    const todayDateOnly = getDateOnlyInTimeZone();

    const identityResult = await dbQuery<UserIdentityRow>(
      `SELECT id, account_type, role, email, full_name
         FROM users
         WHERE id = $1
         LIMIT 1`,
      [session.sub]
    );

    const identity = identityResult.rows[0] ?? null;
    const recipient = String(identity?.email ?? session.email ?? "").trim() || null;
    const fullName = identity?.full_name ?? null;

    const basePayload = {
      recipient,
      emailSent: false,
      suppressed: false,
      dueTodayCount: 0,
      overdueCount: 0,
      pendingPickupCount: 0,
      pendingReturnCount: 0,
      pendingExtensionCount: 0,
    };

    const isStaffRole =
      effectiveRole === "assistant_librarian" ||
      effectiveRole === "librarian" ||
      effectiveRole === "admin";

    if (!recipient) {
      return res.json({
        ok: true,
        sync: {
          role: isStaffRole ? "staff" : "borrower",
          ...basePayload,
          totalNotifications: 0,
          message: "No email address is available for the signed-in account.",
        },
      });
    }

    if (isStaffRole) {
      const canManageExtensions =
        effectiveRole === "librarian" || effectiveRole === "admin";

      const summaryResult = await dbQuery<BorrowNotificationsSummaryRow>(
        `SELECT COUNT(*)::int AS total_records,

                COUNT(*) FILTER (
                  WHERE br.return_date IS NULL
                    AND ${getActiveBorrowRecordSql('br')}
                    AND ${getPendingPickupActiveSql('br')}
                )::int AS pending_pickup_count,

                COUNT(*) FILTER (
                  WHERE br.return_date IS NULL
                    AND ${getActiveBorrowRecordSql('br')}
                    AND br.status IN ('pending_return', 'pending')
                )::int AS pending_return_count,

                COUNT(*) FILTER (
                  WHERE br.return_date IS NULL
                    AND ${getActiveBorrowRecordSql('br')}
                    AND br.extension_request_status = 'pending'
                )::int AS pending_extension_count,

                COUNT(*) FILTER (
                  WHERE br.return_date IS NULL
                    AND ${getActiveBorrowRecordSql('br')}
                    AND (
                      ${getPendingPickupActiveSql('br')}
                      OR br.status IN ('pending_return', 'pending')
                      OR ($1::boolean AND br.extension_request_status = 'pending')
                    )
                )::int AS action_required_count
         FROM borrow_records br`,
        [canManageExtensions]
      );

      const summaryRow = summaryResult.rows[0] ?? {
        total_records: 0,
        pending_pickup_count: 0,
        pending_return_count: 0,
        pending_extension_count: 0,
        action_required_count: 0,
      };

      const dueCountsResult = await dbQuery<BorrowDueCountsRow>(
        `SELECT COUNT(*) FILTER (WHERE br.due_date = $1::date)::int AS due_today_count,
                COUNT(*) FILTER (WHERE br.due_date < $1::date)::int AS overdue_count
           FROM borrow_records br
           WHERE br.return_date IS NULL
             AND ${getActiveBorrowRecordSql('br')}
             AND br.due_date <= $1::date`,
        [todayDateOnly]
      );

      const dueCountRow = dueCountsResult.rows[0] ?? {
        due_today_count: 0,
        overdue_count: 0,
      };

      const notificationRowsResult = await dbQuery<BorrowNotificationEmailRow>(
        `SELECT br.id,
                br.user_id,
                br.due_date,
                br.status,
                br.extension_request_status,
                br.return_requested_at,
                br.return_requested_by,
                br.return_request_note,
                u.email,
                u.full_name,
                b.title
           FROM borrow_records br
           LEFT JOIN users u ON u.id = br.user_id
           LEFT JOIN books b ON b.id = br.book_id
           WHERE br.return_date IS NULL
             AND ${getActiveBorrowRecordSql('br')}
             AND (
               ${getPendingPickupActiveSql('br')}
               OR br.status IN ('pending_return', 'pending')
               OR br.return_requested_at IS NOT NULL
               OR br.due_date <= $1::date
               OR ($2::boolean AND br.extension_request_status = 'pending')
             )
           ORDER BY CASE
                      WHEN br.due_date < $1::date THEN 0
                      WHEN ${getPendingPickupActiveSql('br')} THEN 1
                      WHEN br.status IN ('pending_return', 'pending') OR br.return_requested_at IS NOT NULL THEN 2
                      WHEN $2::boolean AND br.extension_request_status = 'pending' THEN 3
                      WHEN br.due_date = $1::date THEN 4
                      ELSE 5
                    END,
                    br.due_date ASC NULLS LAST,
                    br.borrow_date DESC,
                    br.id DESC
           LIMIT $3`,
        [todayDateOnly, canManageExtensions, BORROW_EMAIL_NOTIFICATION_DETAIL_LIMIT]
      );

      const pendingPickupCount = Number(summaryRow.pending_pickup_count) || 0;
      const pendingReturnCount = Number(summaryRow.pending_return_count) || 0;
      const pendingExtensionCount = canManageExtensions
        ? Number(summaryRow.pending_extension_count) || 0
        : 0;
      const dueTodayCount = Number(dueCountRow.due_today_count) || 0;
      const overdueCount = Number(dueCountRow.overdue_count) || 0;
      const notificationRows = notificationRowsResult.rows.sort(
        (left, right) =>
          getStaffNotificationPriority(left, todayDateOnly, canManageExtensions) -
            getStaffNotificationPriority(right, todayDateOnly, canManageExtensions) ||
          String(left.due_date ?? '9999-12-31').localeCompare(
            String(right.due_date ?? '9999-12-31')
          ) ||
          String(right.id).localeCompare(String(left.id))
      );

      const emailContent = buildStaffDashboardEmail({
        fullName,
        todayDateOnly,
        pendingPickupCount,
        pendingReturnCount,
        pendingExtensionCount,
        dueTodayCount,
        overdueCount,
        canManageExtensions,
        notificationRows,
      });

      const totalNotifications = emailContent.totalNotifications;
      if (totalNotifications <= 0) {
        return res.json({
          ok: true,
          sync: {
            role: "staff",
            ...basePayload,
            pendingPickupCount,
            pendingReturnCount,
            pendingExtensionCount,
            dueTodayCount,
            overdueCount,
            totalNotifications: 0,
            message: "No borrow dashboard notifications currently need an email.",
          },
        });
      }

      const signature = JSON.stringify({
        pendingPickupCount,
        pendingReturnCount,
        pendingExtensionCount,
        dueTodayCount,
        overdueCount,
        rows: notificationRows.map(
          (row) =>
            `${row.id}:${row.status}:${row.due_date ?? ''}:${row.return_requested_at ?? ''}:${row.extension_request_status ?? ''}`
        ),
      });
      const cacheKey = `staff:${session.sub}:${todayDateOnly}:${signature}`;
      const suppressed = !claimBorrowNotificationEmailSlot(cacheKey);
      const emailSent = suppressed
        ? false
        : await sendBorrowNotificationEmail({
            to: recipient,
            subject: emailContent.subject,
            text: emailContent.text,
            html: emailContent.html,
          });

      return res.json({
        ok: true,
        sync: {
          role: "staff",
          recipient,
          emailSent,
          suppressed,
          totalNotifications,
          dueTodayCount,
          overdueCount,
          pendingPickupCount,
          pendingReturnCount,
          pendingExtensionCount,
          message: suppressed
            ? "Borrow dashboard email was already synced recently."
            : emailSent
              ? "Borrow dashboard email notification synced successfully."
              : "Borrow dashboard email could not be sent.",
        },
      });
    }

    const borrowerRowsResult = await dbQuery<BorrowNotificationEmailRow>(
      `SELECT br.id,
              br.user_id,
              br.due_date,
              br.status,
              br.return_requested_at,
              br.return_requested_by,
              br.return_request_note,
              u.email,
              u.full_name,
              b.title
         FROM borrow_records br
         LEFT JOIN users u ON u.id = br.user_id
         LEFT JOIN books b ON b.id = br.book_id
         WHERE br.user_id = $1
           AND br.return_date IS NULL
           AND ${getActiveBorrowRecordSql('br')}
           AND (
             br.due_date <= $2::date
             OR br.return_requested_at IS NOT NULL
           )
         ORDER BY br.due_date ASC, br.id DESC`,
      [session.sub, todayDateOnly]
    );

    const dueTodayRows = borrowerRowsResult.rows.filter(
      (row) => getDueNotificationKind(row.due_date, todayDateOnly) === "due_today"
    );
    const overdueRows = borrowerRowsResult.rows.filter(
      (row) => getDueNotificationKind(row.due_date, todayDateOnly) === "overdue"
    );
    const returnRequestRows = borrowerRowsResult.rows.filter(
      (row) =>
        Boolean(row.return_requested_at) &&
        Number(row.return_requested_by) !== Number(session.sub)
    );

    const totalNotifications =
      dueTodayRows.length + overdueRows.length + returnRequestRows.length;

    if (totalNotifications <= 0) {
      return res.json({
        ok: true,
        sync: {
          role: "borrower",
          ...basePayload,
          totalNotifications: 0,
          message: "No circulation dashboard notifications currently need an email.",
        },
      });
    }

    const emailContent = buildBorrowerDashboardEmail({
      fullName,
      todayDateOnly,
      dueTodayRows: dueTodayRows.slice(0, BORROW_EMAIL_NOTIFICATION_DETAIL_LIMIT),
      overdueRows: overdueRows.slice(0, BORROW_EMAIL_NOTIFICATION_DETAIL_LIMIT),
      returnRequestRows: returnRequestRows.slice(
        0,
        BORROW_EMAIL_NOTIFICATION_DETAIL_LIMIT
      ),
    });

    const signature = JSON.stringify({
      dueToday: dueTodayRows.map((row) => `${row.id}:${row.due_date}`),
      overdue: overdueRows.map((row) => `${row.id}:${row.due_date}`),
      returnRequests: returnRequestRows.map((row) => `${row.id}:${row.return_requested_at}`),
    });
    const cacheKey = `borrower:${session.sub}:${todayDateOnly}:${signature}`;
    const suppressed = !claimBorrowNotificationEmailSlot(cacheKey);
    const emailSent = suppressed
      ? false
      : await sendBorrowNotificationEmail({
          to: recipient,
          subject: emailContent.subject,
          text: emailContent.text,
          html: emailContent.html,
        });

    return res.json({
      ok: true,
      sync: {
        role: "borrower",
        recipient,
        emailSent,
        suppressed,
        totalNotifications,
        dueTodayCount: dueTodayRows.length,
        overdueCount: overdueRows.length,
        pendingPickupCount: 0,
        pendingReturnCount: returnRequestRows.length,
        pendingExtensionCount: 0,
        message: suppressed
          ? "Circulation email was already synced recently."
          : emailSent
            ? "Circulation email notification synced successfully."
            : "Circulation email could not be sent.",
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/borrow-records/policies
 * Return role-based borrowing rules expected by the frontend.
 */
router.get("/policies", requireAuth, async (_req, res) => {
  return res.json({
    ok: true,
    policies: listBorrowPolicies(),
  });
});

/**
 * GET /api/borrow-records/policies/:role
 * Return a single role policy.
 * assistant_librarian is normalized to librarian policy.
 */
router.get("/policies/:role", requireAuth, async (req, res) => {
  const role = parseBorrowPolicyRoleParam(req.params.role);
  if (!role) {
    return res
      .status(404)
      .json({ ok: false, message: "Borrow policy not found for this role." });
  }

  return res.json({
    ok: true,
    policy: getBorrowPolicy(role),
  });
});

/**
 * POST /api/borrow-records/:id/extend
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

      const reqStatus = String(
        current.extension_request_status ?? "none"
      ).toLowerCase();
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

      const finePerHour = getBorrowFinePerHour();
      const joinedRow = await fetchBorrowRecordJoined(rid);
      if (!joinedRow) {
        return res.status(404).json({ ok: false, message: "Record not found." });
      }
      const record = toDTO(joinedRow, finePerHour);
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

    const finePerHour = getBorrowFinePerHour();
    const joinedRow = await fetchBorrowRecordJoined(rid);
    if (!joinedRow) {
      return res.status(404).json({ ok: false, message: "Record not found." });
    }
    const record = toDTO(joinedRow, finePerHour);

    void sendBorrowWorkflowEmail({
      joinedRow,
      event: "extension_approved",
    });

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

      const reqStatus = String(
        current.extension_request_status ?? "none"
      ).toLowerCase();
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

      const finePerHour = getBorrowFinePerHour();
      const joinedRow = await fetchBorrowRecordJoined(rid);
      if (!joinedRow) {
        return res.status(404).json({ ok: false, message: "Record not found." });
      }
      const record = toDTO(joinedRow, finePerHour);

      void sendBorrowWorkflowEmail({
        joinedRow,
        event: "extension_approved",
      });

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

      const reqStatus = String(
        current.extension_request_status ?? "none"
      ).toLowerCase();
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

      const finePerHour = getBorrowFinePerHour();
      const joinedRow = await fetchBorrowRecordJoined(rid);
      if (!joinedRow) {
        return res.status(404).json({ ok: false, message: "Record not found." });
      }
      const record = toDTO(joinedRow, finePerHour);

      void sendBorrowWorkflowEmail({
        joinedRow,
        event: "extension_disapproved",
      });

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
 * POST /api/borrow-records/:id/request-return
 * assistant_librarian/librarian/admin can request the borrower to return the book.
 * This uses status = 'pending_return' and records request metadata.
 */
router.post(
  "/:id/request-return",
  requireAuth,
  requireRole(["assistant_librarian", "librarian", "admin"]),
  async (req, res, next) => {
    const client = await dbPool.connect();
    try {
      const session = (req as any).sessionUser as SessionPayload;
      const actorIdNum = Number(session.sub);
      const actorId = Number.isFinite(actorIdNum) ? actorIdNum : null;

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
      }>(
        `SELECT id, status, return_date
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
          message: "This borrow record is already returned.",
        });
      }

      if (current.status === "pending_return") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          message: "A return request is already pending for this borrow record.",
        });
      }

      if (current.status !== "borrowed") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          message:
            "Only records with status 'borrowed' can be marked as requested for return.",
        });
      }

      await client.query(
        `UPDATE borrow_records
           SET status = 'pending_return',
               return_requested_at = NOW(),
               return_requested_by = $1,
               return_request_note = $2,
               updated_at = NOW()
         WHERE id = $3`,
        [actorId, note, rid]
      );

      await client.query("COMMIT");

      const finePerHour = getBorrowFinePerHour();
      const joinedRow = await fetchBorrowRecordJoined(rid);
      if (!joinedRow) {
        return res.status(404).json({ ok: false, message: "Record not found." });
      }

      const record = toDTO(joinedRow, finePerHour);

      void sendBorrowWorkflowEmail({
        joinedRow,
        event: "return_requested_by_staff",
      });

      return res.json({
        ok: true,
        record,
        message: "Return request has been sent.",
      });
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
 * ✅ Enforces role-based max active borrows and per-request limits.
 */
router.post(
  "/",
  requireAuth,
  requireRole(["assistant_librarian", "librarian", "admin"]),
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
      await releaseExpiredPendingPickupReservations(client);

      const u = await client.query<UserRoleRow>(
        `SELECT id, account_type, role
           FROM users
          WHERE id = $1
          LIMIT 1`,
        [uid]
      );

      if (!u.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ ok: false, message: "User not found." });
      }

      const targetPolicy = getBorrowPolicy(
        computeEffectiveRoleFromRow(u.rows[0])
      );
      const quantityError = getQuantityPolicyError(qty, targetPolicy);

      if (quantityError) {
        await client.query("ROLLBACK");
        return res.status(400).json({ ok: false, message: quantityError });
      }

      const activeForUser = await countActiveBorrowRecordsForUser(client, uid);
      const remainingSlots = Math.max(
        0,
        targetPolicy.maxActiveBorrows - activeForUser
      );

      if (qty > remainingSlots) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          message: `${formatBorrowPolicyRoleLabel(
            targetPolicy.role
          )} can only have up to ${
            targetPolicy.maxActiveBorrows
          } active borrow record${
            targetPolicy.maxActiveBorrows === 1 ? "" : "s"
          }. Remaining allowed: ${remainingSlots}.`,
        });
      }

      const borrowableSelection = await resolveBorrowableCopySelection(
        client,
        bid
      );

      if (!borrowableSelection) {
        await client.query("ROLLBACK");
        return res.status(404).json({ ok: false, message: "Book not found." });
      }

      if (Boolean(borrowableSelection.source.is_library_use_only)) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          message:
            "This book is marked as Library Use Only and cannot be borrowed.",
        });
      }

      const selectedBookIds = selectBorrowableBookIdsInCycle(
        borrowableSelection.rows,
        qty
      );
      const remaining = borrowableSelection.rows.reduce(
        (sum, row) =>
          sum +
          getRemainingUnitsForBorrowableCopyRow(row, {
            forceSingleCopyUnit: borrowableSelection.rows.length > 1,
          }),
        0
      );

      if (selectedBookIds.length < qty) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          message: `Book is not available (only ${remaining} copy/copies left).`,
        });
      }

      const ins = await client.query<{ id: string }>(
        `INSERT INTO borrow_records (user_id, book_id, borrow_date, due_date, status)
         SELECT $1,
                selected_book_id,
                COALESCE($2::date, CURRENT_DATE),
                $3::date,
                'borrowed'
           FROM unnest($4::int[]) AS selection(selected_book_id)
         RETURNING id`,
        [uid, borrowDate || null, dueDate, selectedBookIds]
      );

      await recomputeAndUpdateBookAvailabilityForBookIds(
        client,
        selectedBookIds
      );

      await client.query("COMMIT");

      const ids = ins.rows.map((r) => Number(r.id));
      const finePerHour = getBorrowFinePerHour();
      const joinedRows = await fetchBorrowRecordsJoined(ids);
      const records = joinedRows.map((r) => toDTO(r, finePerHour));

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
 * ✅ Computes due date from per-book duration first, then role policy fallback.
 * ✅ Enforces role-based max active borrows and per-request limits.
 */
router.post("/self", requireAuth, async (req, res, next) => {
  const s = (req as any).sessionUser as SessionPayload;
  const userId = Number(s.sub);
  const { bookId } = req.body || {};
  const bid = Number(bookId);
  const qty = parseBorrowQuantity(req.body || {});

  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(401).json({
      ok: false,
      message: "Unauthorized: invalid session user.",
    });
  }

  if (!bid) {
    return res.status(400).json({ ok: false, message: "bookId is required." });
  }

  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    await releaseExpiredPendingPickupReservations(client);

    const u = await client.query<UserRoleRow>(
      `SELECT id, account_type, role
         FROM users
         WHERE id = $1
         LIMIT 1`,
      [userId]
    );

    if (!u.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, message: "User not found." });
    }

    const effectiveRole = computeEffectiveRoleFromRow(u.rows[0]);
    const targetPolicy = getBorrowPolicy(effectiveRole);
    const quantityError = getQuantityPolicyError(qty, targetPolicy);

    if (quantityError) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, message: quantityError });
    }

    const activeForUser = await countActiveBorrowRecordsForUser(client, userId);
    const remainingSlots = Math.max(
      0,
      targetPolicy.maxActiveBorrows - activeForUser
    );

    if (qty > remainingSlots) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        message: `${formatBorrowPolicyRoleLabel(
          targetPolicy.role
        )} can only have up to ${
          targetPolicy.maxActiveBorrows
        } active borrow record${
          targetPolicy.maxActiveBorrows === 1 ? "" : "s"
        }. Remaining allowed: ${remainingSlots}.`,
      });
    }

    const borrowableSelection = await resolveBorrowableCopySelection(
      client,
      bid
    );

    if (!borrowableSelection) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, message: "Book not found." });
    }

    if (Boolean(borrowableSelection.source.is_library_use_only)) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        message:
          "This book is marked as Library Use Only and cannot be borrowed.",
      });
    }

    const selectedBookIds = selectBorrowableBookIdsInCycle(
      borrowableSelection.rows,
      qty
    );
    const remaining = borrowableSelection.rows.reduce(
      (sum, row) =>
        sum +
        getRemainingUnitsForBorrowableCopyRow(row, {
          forceSingleCopyUnit: borrowableSelection.rows.length > 1,
        }),
      0
    );

    if (selectedBookIds.length < qty) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        message: `Book is not available (only ${remaining} copy/copies left).`,
      });
    }

    const borrowDays = Math.max(
      1,
      resolveBorrowDurationDays(
        effectiveRole,
        borrowableSelection.source.borrow_duration_days
      )
    );
    const borrowDateStr = getDateOnlyInTimeZone();
    const borrowDateUtcMs = dateOnlyToUtcMs(borrowDateStr);
    const dueDateStr = Number.isNaN(borrowDateUtcMs)
      ? getDateOnlyInTimeZone(new Date(Date.now() + borrowDays * DAY_MS))
      : getDateOnlyInTimeZone(
          new Date(borrowDateUtcMs + borrowDays * DAY_MS),
          "UTC"
        );

    const ins = await client.query<{ id: string }>(
      `INSERT INTO borrow_records (user_id, book_id, borrow_date, due_date, status, updated_at)
         SELECT $1,
                selected_book_id,
                $2::date,
                $3::date,
                'pending_pickup',
                NOW()
           FROM unnest($4::int[]) AS selection(selected_book_id)
         RETURNING id`,
      [userId, borrowDateStr, dueDateStr, selectedBookIds]
    );

    await recomputeAndUpdateBookAvailabilityForBookIds(
      client,
      selectedBookIds
    );

    await client.query("COMMIT");

    const ids = ins.rows.map((r) => Number(r.id));
    const finePerHour = getBorrowFinePerHour();
    const joinedRows = await fetchBorrowRecordsJoined(ids);
    const records = joinedRows.map((r) => toDTO(r, finePerHour));

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
 * Availability is recomputed when status changes.
 *
 * assistant_librarian:
 * - can manage borrow/return workflow
 * - can confirm returns and set the final fine during return confirmation
 * - cannot approve/disapprove extensions
 * - cannot change due date
 * - cannot change the fine outside of return confirmation
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
    const actorIdNum = Number(session.sub);
    const actorId = Number.isFinite(actorIdNum) ? actorIdNum : null;

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
    const isPrivilegedStaff =
      effectiveRole === "librarian" || effectiveRole === "admin";
    const isAssistantLibrarian = effectiveRole === "assistant_librarian";
    const canManageBorrowAndReturn = isPrivilegedStaff || isAssistantLibrarian;

    if (!isOwner && !canManageBorrowAndReturn) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        ok: false,
        message: "Forbidden: cannot modify this borrow record.",
      });
    }

    const desiredStatus =
      status !== undefined ? String(status).toLowerCase() : undefined;
    const isAssistantReturnConfirmation =
      isAssistantLibrarian && desiredStatus === "returned";

    if (isAssistantLibrarian) {
      const allowedAssistantStatuses: BorrowStatus[] = [
        "borrowed",
        "pending_pickup",
        "pending_return",
        "returned",
      ];

      if (
        desiredStatus &&
        !allowedAssistantStatuses.includes(desiredStatus as BorrowStatus)
      ) {
        await client.query("ROLLBACK");
        return res.status(403).json({
          ok: false,
          message:
            "Assistant librarian can only manage borrow and return statuses.",
        });
      }

      if (dueDate !== undefined) {
        await client.query("ROLLBACK");
        return res.status(403).json({
          ok: false,
          message: "Assistant librarian cannot change the due date.",
        });
      }

      if (fine !== undefined && !isAssistantReturnConfirmation) {
        await client.query("ROLLBACK");
        return res.status(403).json({
          ok: false,
          message:
            "Assistant librarian can only set the fine when confirming a return.",
        });
      }
    }

    if (!isPrivilegedStaff && !isAssistantLibrarian) {
      if (dueDate !== undefined || fine !== undefined) {
        await client.query("ROLLBACK");
        return res.status(403).json({
          ok: false,
          message: "Forbidden: only librarian or admin can change due date or fine.",
        });
      }

      if (
        desiredStatus !== undefined &&
        desiredStatus !== "pending_return" &&
        desiredStatus !== "returned"
      ) {
        await client.query("ROLLBACK");
        return res.status(403).json({
          ok: false,
          message: "Forbidden: you can only request or confirm returns for your own record.",
        });
      }
    }

    const updates: string[] = [];
    const values: any[] = [];
    let i = 1;
    let newStatus = current.status;
    const shouldEmailDueDateUpdate = isPrivilegedStaff && dueDate !== undefined;
    let shouldEmailReturnConfirmation = false;

    if (status !== undefined) {
      const sVal = String(status).toLowerCase();
      const allowedStatuses: BorrowStatus[] = [
        "borrowed",
        "pending",
        "pending_pickup",
        "pending_return",
        "returned",
      ];

      if (!allowedStatuses.includes(sVal as BorrowStatus)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ ok: false, message: "Invalid status." });
      }

      newStatus = sVal as BorrowStatus;
      shouldEmailReturnConfirmation = newStatus === "returned";

      updates.push(`status = $${i++}`);
      values.push(sVal);

      if (sVal === "returned" && returnDate === undefined) {
        updates.push(`return_date = COALESCE(return_date, CURRENT_DATE)`);
      }

      if (sVal === "pending_return") {
        const returnRequestNoteRaw =
          (req.body || {}).returnRequestNote ?? (req.body || {}).note;

        updates.push(`return_requested_at = NOW()`);
        updates.push(`return_requested_by = $${i++}`);
        values.push(actorId);

        if (returnRequestNoteRaw !== undefined) {
          const note =
            returnRequestNoteRaw !== null &&
            String(returnRequestNoteRaw).trim().length > 0
              ? String(returnRequestNoteRaw).trim()
              : null;
          updates.push(`return_request_note = $${i++}`);
          values.push(note);
        }
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

                   return_requested_at,
                   return_requested_by,
                   return_request_note,
                   NULL::text AS return_requested_by_name,
                   updated_at AS borrow_updated_at,

                   NULL::text AS email,
                   NULL::text AS student_id,
                   NULL::text AS full_name,
                   NULL::text AS course,
                   NULL::text AS college,
                   NULL::text AS title,
                   NULL::text AS accession_number,
                   NULL::int AS copy_number`,
      [...values, rid]
    );

    const updatedRow = upd.rows[0];

    if (newStatus === "returned") {
      const finePerHour = getBorrowFinePerHour();
      const metrics = computeBorrowFineMetrics(
        updatedRow.due_date,
        updatedRow.return_date,
        finePerHour
      );

      let finalFine = metrics.computedFine;

      if (fine !== undefined) {
        const parsedFine = Number(fine);
        if (!Number.isFinite(parsedFine) || parsedFine < 0) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            ok: false,
            message: "fine must be a non-negative number.",
          });
        }
        finalFine = parsedFine;
      }

      await client.query(
        `UPDATE borrow_records
             SET fine = $1, updated_at = NOW()
           WHERE id = $2`,
        [finalFine, rid]
      );

      if (finalFine > 0) {
        await client.query(
          `INSERT INTO fines (
             user_id,
             borrow_record_id,
             amount,
             status,
             reason,
             resolved_at,
             official_receipt_number
           )
           VALUES ($1, $2, $3, 'active', $4, NULL, NULL)
           ON CONFLICT (borrow_record_id) WHERE borrow_record_id IS NOT NULL DO UPDATE
             SET amount = EXCLUDED.amount,
                 status = 'active',
                 reason = EXCLUDED.reason,
                 resolved_at = NULL,
                 official_receipt_number = NULL,
                 updated_at = NOW()`,
          [
            current.user_id,
            rid,
            finalFine,
            `Overdue fine for borrow record #${rid} (${metrics.overdueHours} hour(s), ${metrics.overdueDays} day(s))`,
          ]
        );
      } else {
        await client.query(
          `UPDATE fines
             SET amount = 0,
                 status = 'cancelled',
                 resolved_at = NOW(),
                 official_receipt_number = NULL,
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

    const finePerHour = getBorrowFinePerHour();
    const joinedRow = await fetchBorrowRecordJoined(rid);
    if (!joinedRow) {
      return res.status(404).json({ ok: false, message: "Record not found." });
    }
    const record = toDTO(joinedRow, finePerHour);

    if (shouldEmailDueDateUpdate) {
      void sendBorrowWorkflowEmail({
        joinedRow,
        event: "due_date_updated",
      });
    }

    if (shouldEmailReturnConfirmation) {
      void sendBorrowWorkflowEmail({
        joinedRow,
        event: "return_confirmed",
      });
    }

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