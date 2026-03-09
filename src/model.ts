export type Role =
  | "student"
  | "guest"
  | "librarian"
  | "faculty"
  | "admin"
  | "other";

export type StaffRole = "librarian" | "faculty" | "admin";

export const ROLE_VALUES: readonly Role[] = [
  "student",
  "guest",
  "librarian",
  "faculty",
  "admin",
  "other",
] as const;

export const STAFF_ROLE_VALUES: readonly StaffRole[] = [
  "librarian",
  "faculty",
  "admin",
] as const;

export type SessionPayload = {
  sub: string;
  email: string;
  role: Role;
  ev: number;
};

export type UserRoleRow = {
  id: string;
  account_type: Role | string | null;
  role?: Role | string | null;
};

export type UserRow = UserRoleRow & {
  full_name: string;
  email: string;
  password_hash?: string;
  student_id?: string | null;
  course?: string | null;
  year_level?: string | null;
  avatar_url?: string | null;
  is_email_verified?: boolean;
  is_approved?: boolean;
  approved_at?: string | null;
  approved_by?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type LibraryArea =
  | "filipiniana"
  | "general_circulation"
  | "maritime"
  | "periodicals"
  | "thesis_dissertations"
  | "rizaliana"
  | "special_collection"
  | "fil_gen_reference"
  | "general_reference"
  | "fiction";

export const LIBRARY_AREA_VALUES: readonly LibraryArea[] = [
  "filipiniana",
  "general_circulation",
  "maritime",
  "periodicals",
  "thesis_dissertations",
  "rizaliana",
  "special_collection",
  "fil_gen_reference",
  "general_reference",
  "fiction",
] as const;

export const LIBRARY_AREAS = new Set<LibraryArea>(LIBRARY_AREA_VALUES);

export type BorrowStatus =
  | "borrowed"
  | "pending"
  | "pending_pickup"
  | "pending_return"
  | "returned";

export type ExtensionRequestStatus =
  | "none"
  | "pending"
  | "approved"
  | "disapproved";

export type FineStatus = "active" | "paid" | "cancelled";

export type DamageStatus = "pending" | "assessed" | "paid";

export type Severity = "minor" | "moderate" | "major";

export type DBQueryResult<T> = {
  rowCount: number;
  rows: T[];
};

export type DBQueryFn = <T = any>(
  text: string,
  params?: any[]
) => Promise<DBQueryResult<T>>;

export type DBClient = {
  query: DBQueryFn;
  release: () => void;
};

export type DBPool = {
  connect: () => Promise<DBClient>;
};

export function normalizeRole(raw: unknown): Role {
  const value = String(raw ?? "").trim().toLowerCase();

  if (value === "student") return "student";
  if (value === "guest") return "guest";
  if (value === "librarian") return "librarian";
  if (value === "faculty") return "faculty";
  if (value === "admin") return "admin";

  // common legacy / synonym mappings used across routes
  if (value === "administrator") return "admin";
  if (value === "staff") return "librarian";
  if (
    value === "teacher" ||
    value === "professor" ||
    value === "lecturer"
  ) {
    return "faculty";
  }

  return "other";
}

export function isStaffRole(role: Role): role is StaffRole {
  return role === "admin" || role === "librarian" || role === "faculty";
}

export function isExemptFromApproval(role: Role) {
  return role === "librarian" || role === "admin";
}

/**
 * Effective auth role for guards and redirects.
 *
 * Priority:
 * 1) Prefer legacy/stored `role` if it is a staff role
 * 2) Otherwise if `account_type` is staff, use it
 * 3) Otherwise if legacy `role` exists, use it
 * 4) Fallback to `account_type`
 */
export function computeEffectiveRoleFromRow(
  row: Pick<UserRoleRow, "account_type" | "role">
): Role {
  const accountType = normalizeRole(row.account_type);

  const legacyRaw = row.role;
  const legacyHasValue =
    legacyRaw !== undefined &&
    legacyRaw !== null &&
    String(legacyRaw).trim().length > 0;

  const legacyRole = normalizeRole(legacyRaw);

  if (legacyHasValue && isStaffRole(legacyRole)) return legacyRole;
  if (isStaffRole(accountType)) return accountType;
  if (legacyHasValue) return legacyRole;

  return accountType || "student";
}

export function safeAccountType(raw: unknown): "student" | "other" {
  const role = normalizeRole(raw);
  return role === "student" ? "student" : "other";
}

export function cleanOptionalText(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const value = String(raw).trim();
  return value.length > 0 ? value : null;
}

export function trimToNull(raw: unknown): string | null {
  return cleanOptionalText(raw);
}

export function normalizeLibraryArea(raw: unknown): LibraryArea | null {
  if (raw === undefined || raw === null) return null;

  const value = String(raw).trim().toLowerCase();
  if (!value) return null;

  if (LIBRARY_AREAS.has(value as LibraryArea)) {
    return value as LibraryArea;
  }

  const compact = value.replace(/\./g, "").replace(/\s+/g, " ").trim();

  if (compact.includes("general circulation")) return "general_circulation";
  if (compact.includes("thesis") || compact.includes("dissertation")) {
    return "thesis_dissertations";
  }
  if (compact.includes("special collection")) return "special_collection";
  if (compact.includes("filipiniana")) return "filipiniana";
  if (compact.includes("maritime")) return "maritime";
  if (compact.includes("periodicals")) return "periodicals";
  if (compact.includes("rizaliana")) return "rizaliana";

  if (
    compact.includes("fil gen reference") ||
    compact.includes("fil. gen. reference") ||
    compact.includes("fil gen") ||
    compact.includes("filipino general reference")
  ) {
    return "fil_gen_reference";
  }

  if (compact.includes("general reference")) return "general_reference";
  if (compact.includes("fiction")) return "fiction";

  return null;
}

export function resolveClassificationPayload(input: {
  subjects?: unknown;
  genre?: unknown;
  category?: unknown;
}): {
  subjects: string | null;
  genre: string | null;
  category: string | null;
} | null {
  const hasSubjects = input.subjects !== undefined;
  const hasGenre = input.genre !== undefined;
  const hasCategory = input.category !== undefined;

  if (!hasSubjects && !hasGenre && !hasCategory) {
    return null;
  }

  const explicitSubjects = hasSubjects ? trimToNull(input.subjects) : undefined;
  const explicitGenre = hasGenre ? trimToNull(input.genre) : undefined;
  const explicitCategory = hasCategory ? trimToNull(input.category) : undefined;

  const fallback = explicitSubjects ?? explicitGenre ?? explicitCategory ?? null;

  return {
    subjects: explicitSubjects !== undefined ? explicitSubjects : fallback,
    genre: explicitGenre !== undefined ? explicitGenre : fallback,
    category: explicitCategory !== undefined ? explicitCategory : fallback,
  };
}