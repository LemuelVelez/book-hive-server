import express from "express";
import jwt from "jsonwebtoken";
import { pool, query } from "../db";

const router = express.Router();

type Role = "student" | "librarian" | "faculty" | "admin" | "other";

type LibraryArea =
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

const LIBRARY_AREAS = new Set<LibraryArea>([
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
]);

const LIBRARY_USE_ONLY_AREAS = new Set<LibraryArea>([
  "periodicals",
  "thesis_dissertations",
  "rizaliana",
  "special_collection",
  "fil_gen_reference",
  "general_reference",
]);

type BookRow = {
  id: string;
  title: string;
  author: string;
  isbn: string | null;
  issn: string | null;

  subjects: string | null;
  genre: string | null;

  accession_number: string | null;
  subtitle: string | null;
  statement_of_responsibility: string | null;
  edition: string | null;

  place_of_publication: string | null;
  publisher: string | null;
  copyright_year: number | null;

  pages: number | null;
  physical_details: string | null;
  dimensions: string | null;
  notes: string | null;
  series: string | null;
  category: string | null;
  added_entries: string | null;

  barcode: string | null;
  call_number: string | null;
  copy_number: number | null;
  volume_number: string | null;
  library_area: LibraryArea | null;

  number_of_copies: number;

  publication_year: number;
  available: boolean;
  borrow_duration_days: number | null;
  is_library_use_only: boolean;

  created_at: string;
  updated_at: string;
};

type BookRowWithCounts = BookRow & {
  active_count?: number | null;
  total_borrow_count?: number | null;
  available_copies?: number | null;
  computed_available?: boolean | null;
};

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

const dbQuery = query as unknown as DBQueryFn;
const dbPool = pool as unknown as DBPool;

const ENFORCE_ROLE_GUARDS = false;

function normalizeRole(raw: unknown): Role {
  const v = String(raw ?? "").trim().toLowerCase();

  if (v === "student") return "student";
  if (v === "librarian") return "librarian";
  if (v === "faculty") return "faculty";
  if (v === "admin") return "admin";

  return "other";
}

function normalizeLibraryArea(raw: unknown): LibraryArea | null {
  if (raw === undefined || raw === null) return null;

  const v = String(raw).trim().toLowerCase();
  if (!v) return null;

  if (LIBRARY_AREAS.has(v as LibraryArea)) return v as LibraryArea;

  const compact = v.replace(/\./g, "").replace(/\s+/g, " ").trim();

  if (compact.includes("general circulation")) return "general_circulation";
  if (compact.includes("thesis") || compact.includes("dissertation"))
    return "thesis_dissertations";
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

function isLibraryUseOnlyArea(area: LibraryArea | null | undefined): boolean {
  return !!area && LIBRARY_USE_ONLY_AREAS.has(area);
}

function parseOptionalBoolean(raw: unknown): boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return false;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;

  const v = String(raw).trim().toLowerCase();

  if (!v) return false;
  if (["true", "1", "yes", "y", "on"].includes(v)) return true;
  if (["false", "0", "no", "n", "off"].includes(v)) return false;

  return Boolean(v);
}

function resolveLibraryUseOnlyFlag(
  rawFlag: unknown,
  area: LibraryArea | null,
  fallback = false
): boolean {
  const explicit = parseOptionalBoolean(rawFlag);
  if (explicit !== undefined) return explicit;
  if (isLibraryUseOnlyArea(area)) return true;
  return fallback;
}

function trimToNull(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const value = String(raw).trim();
  return value ? value : null;
}

function resolveClassificationPayload(input: {
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

function shouldCreatePhysicalCopy(body: any): boolean {
  if (!body || typeof body !== "object") return false;

  return (
    body.accessionNumber !== undefined ||
    body.barcode !== undefined ||
    body.copyNumber !== undefined ||
    body.callNumber !== undefined ||
    body.volumeNumber !== undefined ||
    body.libraryArea !== undefined ||
    body.borrowDurationDays !== undefined ||
    body.isLibraryUseOnly !== undefined ||
    body.available !== undefined
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
  const primary = normalizeRole(row.account_type || "student");
  const legacy = row.role ? normalizeRole(row.role) : undefined;

  if (primary && primary !== "student" && primary !== "other") {
    return primary;
  }

  if (
    primary === "student" &&
    legacy &&
    legacy !== "student" &&
    legacy !== "other"
  ) {
    return legacy;
  }

  return primary !== "other"
    ? primary
    : legacy !== "other"
      ? legacy || "student"
      : "student";
}

function requireRole(_roles: Role[]) {
  return (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    const s = (req as any).sessionUser as SessionPayload | undefined;
    if (!s) {
      return res.status(401).json({ ok: false, message: "Not authenticated." });
    }

    if (!ENFORCE_ROLE_GUARDS) {
      return next();
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

        if (!_roles.includes(effectiveRole)) {
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

async function computeCopyStateForBook(
  client: DBClient,
  bookId: number,
  copiesTotal?: number
): Promise<{
  totalCopies: number;
  activeCount: number;
  totalBorrowCount: number;
  remainingCopies: number;
  available: boolean;
}> {
  const copies =
    typeof copiesTotal === "number" &&
    Number.isFinite(copiesTotal) &&
    copiesTotal > 0
      ? Math.floor(copiesTotal)
      : 1;

  const statsRes = await client.query<{
    active_count: number;
    total_borrow_count: number;
  }>(
    `SELECT COUNT(*) FILTER (WHERE status <> 'returned')::int AS active_count,
            COUNT(*)::int AS total_borrow_count
       FROM borrow_records
       WHERE book_id = $1`,
    [bookId]
  );

  const active =
    typeof statsRes.rows[0]?.active_count === "number" &&
    Number.isFinite(statsRes.rows[0].active_count)
      ? statsRes.rows[0].active_count
      : 0;

  const totalBorrowCount =
    typeof statsRes.rows[0]?.total_borrow_count === "number" &&
    Number.isFinite(statsRes.rows[0].total_borrow_count)
      ? statsRes.rows[0].total_borrow_count
      : 0;

  const remaining = Math.max(0, copies - active);

  return {
    totalCopies: copies,
    activeCount: active,
    totalBorrowCount,
    remainingCopies: remaining,
    available: remaining > 0,
  };
}

function toDTO(row: BookRow | BookRowWithCounts) {
  const totalCopies =
    typeof row.number_of_copies === "number" && Number.isFinite(row.number_of_copies)
      ? Math.max(1, Math.floor(row.number_of_copies))
      : 1;

  const activeCountRaw = (row as BookRowWithCounts).active_count;
  const totalBorrowCountRaw = (row as BookRowWithCounts).total_borrow_count;
  const availableCopiesRaw = (row as BookRowWithCounts).available_copies;
  const computedAvailableRaw = (row as BookRowWithCounts).computed_available;

  const activeCount =
    typeof activeCountRaw === "number" && Number.isFinite(activeCountRaw)
      ? activeCountRaw
      : 0;

  const totalBorrowCount =
    typeof totalBorrowCountRaw === "number" && Number.isFinite(totalBorrowCountRaw)
      ? totalBorrowCountRaw
      : 0;

  const remainingCopies =
    typeof availableCopiesRaw === "number" && Number.isFinite(availableCopiesRaw)
      ? availableCopiesRaw
      : Math.max(0, totalCopies - activeCount);

  const available =
    typeof computedAvailableRaw === "boolean"
      ? computedAvailableRaw
      : remainingCopies > 0;

  const isLibraryUseOnly = Boolean(row.is_library_use_only);
  const canBorrow = !isLibraryUseOnly;

  return {
    id: String(row.id),

    accessionNumber: row.accession_number ?? "",
    title: row.title,
    subtitle: row.subtitle ?? "",
    author: row.author,
    edition: row.edition ?? "",
    isbn: row.isbn ?? "",
    issn: row.issn ?? "",

    subjects: row.subjects ?? row.genre ?? row.category ?? "",
    genre: row.genre ?? row.subjects ?? row.category ?? "",

    placeOfPublication: row.place_of_publication ?? "",
    publisher: row.publisher ?? "",
    publicationYear: row.publication_year,
    copyrightYear: row.copyright_year ?? null,

    pages: typeof row.pages === "number" ? row.pages : null,
    otherDetails: row.physical_details ?? "",
    dimensions: row.dimensions ?? "",
    notes: row.notes ?? "",
    series: row.series ?? "",
    category: row.category ?? "",
    addedEntries: row.added_entries ?? "",

    available,

    borrowDurationDays:
      typeof row.borrow_duration_days === "number"
        ? row.borrow_duration_days
        : null,

    barcode: row.barcode ?? "",
    callNumber: row.call_number ?? "",
    copyNumber: typeof row.copy_number === "number" ? row.copy_number : null,
    volumeNumber: row.volume_number ?? "",
    libraryArea: row.library_area ?? null,

    numberOfCopies: remainingCopies,
    totalCopies,
    borrowedCopies: activeCount,

    isLibraryUseOnly,
    canBorrow,
    activeBorrowCount: activeCount,
    totalBorrowCount,
  };
}

const BOOK_RETURNING = `
  id,
  title,
  subtitle,
  author,
  statement_of_responsibility,
  edition,
  isbn,
  issn,
  accession_number,
  subjects,
  genre,
  category,
  place_of_publication,
  publisher,
  publication_year,
  copyright_year,
  pages,
  physical_details,
  dimensions,
  notes,
  series,
  added_entries,
  barcode,
  call_number,
  copy_number,
  volume_number,
  library_area,
  number_of_copies,
  available,
  borrow_duration_days,
  is_library_use_only,
  created_at,
  updated_at
`;

const BOOK_RETURNING_B = `
  b.id,
  b.title,
  b.subtitle,
  b.author,
  b.statement_of_responsibility,
  b.edition,
  b.isbn,
  b.issn,
  b.accession_number,
  b.subjects,
  b.genre,
  b.category,
  b.place_of_publication,
  b.publisher,
  b.publication_year,
  b.copyright_year,
  b.pages,
  b.physical_details,
  b.dimensions,
  b.notes,
  b.series,
  b.added_entries,
  b.barcode,
  b.call_number,
  b.copy_number,
  b.volume_number,
  b.library_area,
  b.number_of_copies,
  b.available,
  b.borrow_duration_days,
  b.is_library_use_only,
  b.created_at,
  b.updated_at
`;


function normalizeBookGroupValue(raw: unknown) {
  return String(raw ?? "").trim().toLowerCase();
}

function buildBookGroupKey(input: {
  title?: unknown;
  author?: unknown;
  callNumber?: unknown;
  isbn?: unknown;
}) {
  return [
    normalizeBookGroupValue(input.title),
    normalizeBookGroupValue(input.author),
    normalizeBookGroupValue(input.callNumber),
    normalizeBookGroupValue(input.isbn),
  ].join("|");
}

function buildBookGroupKeyFromRow(
  row: Pick<BookRow, "title" | "author" | "call_number" | "isbn">
) {
  return buildBookGroupKey({
    title: row.title,
    author: row.author,
    callNumber: row.call_number,
    isbn: row.isbn,
  });
}

function compareBookGroupOrder(a: BookRow, b: BookRow) {
  const createdAtDiff =
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime();

  if (Number.isFinite(createdAtDiff) && createdAtDiff !== 0) {
    return createdAtDiff;
  }

  const aId = Number(a.id);
  const bId = Number(b.id);

  if (Number.isFinite(aId) && Number.isFinite(bId) && aId !== bId) {
    return aId - bId;
  }

  return String(a.id).localeCompare(String(b.id), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function chooseBookGroupRepresentative(rows: BookRowWithCounts[]) {
  return [...rows].sort(compareBookGroupOrder)[0];
}

function aggregateBookGroupRows(rows: BookRowWithCounts[]) {
  const representative = chooseBookGroupRepresentative(rows);
  const aggregate = {
    ...representative,
  } as BookRowWithCounts;

  let totalCopies = 0;
  let activeCount = 0;
  let totalBorrowCount = 0;

  for (const row of rows) {
    const rowTotalCopies =
      typeof row.number_of_copies === "number" && Number.isFinite(row.number_of_copies)
        ? Math.max(1, Math.floor(row.number_of_copies))
        : 1;

    const rowActiveCount =
      typeof row.active_count === "number" && Number.isFinite(row.active_count)
        ? row.active_count
        : 0;

    const rowTotalBorrowCount =
      typeof row.total_borrow_count === "number" &&
      Number.isFinite(row.total_borrow_count)
        ? row.total_borrow_count
        : 0;

    totalCopies += rowTotalCopies;
    activeCount += rowActiveCount;
    totalBorrowCount += rowTotalBorrowCount;
  }

  aggregate.number_of_copies = Math.max(1, totalCopies);
  aggregate.active_count = activeCount;
  aggregate.total_borrow_count = totalBorrowCount;
  aggregate.available_copies = Math.max(0, totalCopies - activeCount);
  aggregate.computed_available = aggregate.available_copies > 0;
  aggregate.available = Boolean(aggregate.computed_available);

  return aggregate;
}

function groupBookRows(rows: BookRowWithCounts[]) {
  const grouped = new Map<string, BookRowWithCounts[]>();

  for (const row of rows) {
    const key = buildBookGroupKeyFromRow(row);
    const items = grouped.get(key) ?? [];
    items.push(row);
    grouped.set(key, items);
  }

  return Array.from(grouped.values())
    .map(aggregateBookGroupRows)
    .sort((a, b) => {
      const updatedAtDiff =
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();

      if (Number.isFinite(updatedAtDiff) && updatedAtDiff !== 0) {
        return updatedAtDiff;
      }

      return compareBookGroupOrder(a, b);
    });
}

async function findGroupedBookRows(
  client: DBClient,
  row: Pick<BookRow, "title" | "author" | "call_number" | "isbn">
) {
  const result = await client.query<
    Pick<BookRow, "id" | "title" | "author" | "call_number" | "isbn">
  >(
    `SELECT id, title, author, call_number, isbn
       FROM books`
  );

  const sourceKey = buildBookGroupKeyFromRow(row);

  return result.rows.filter(
    (candidate) => buildBookGroupKeyFromRow(candidate as BookRow) === sourceKey
  );
}

router.get("/", async (_req, res, next) => {
  try {
    const result = await dbQuery<BookRowWithCounts>(
      `
      SELECT
        ${BOOK_RETURNING_B},
        COALESCE(stats.active_count, 0)::int AS active_count,
        COALESCE(stats.total_borrow_count, 0)::int AS total_borrow_count,
        GREATEST(b.number_of_copies - COALESCE(stats.active_count, 0), 0)::int AS available_copies,
        (COALESCE(stats.active_count, 0) < b.number_of_copies) AS computed_available
      FROM books b
      LEFT JOIN (
        SELECT
          book_id,
          COUNT(*) FILTER (WHERE status <> 'returned')::int AS active_count,
          COUNT(*)::int AS total_borrow_count
        FROM borrow_records
        GROUP BY book_id
      ) stats ON stats.book_id = b.id
      ORDER BY b.created_at DESC, b.id DESC
      `
    );

    const books = groupBookRows(result.rows).map(toDTO);
    res.json({ ok: true, books });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/",
  requireAuth,
  requireRole(["librarian", "admin"]),
  async (req, res, next) => {
    try {
      const {
        title,
        author,
        subjects,
        isbn,
        genre,
        publicationYear,
        borrowDurationDays,

        accessionNumber,
        subtitle,
        edition,
        issn,
        placeOfPublication,
        publisher,
        pages,
        otherDetails,
        dimensions,
        notes,
        series,
        category,
        addedEntries,
        barcode,
        callNumber,
        copyNumber,
        volumeNumber,
        libraryArea,

        numberOfCopies,
        isLibraryUseOnly,
      } = req.body || {};

      const resolvedTitle = title ? String(title).trim() : "";
      const resolvedAuthorRaw =
        author !== undefined && author !== null && String(author).trim()
          ? String(author).trim()
          : "";

      const rawYear = publicationYear;

      if (!resolvedTitle || !resolvedAuthorRaw || rawYear === undefined) {
        return res.status(400).json({
          ok: false,
          message: "Title, author, and publicationYear are required.",
        });
      }

      const yearNum = Number(rawYear);
      if (!Number.isFinite(yearNum) || yearNum < 1000 || yearNum > 9999) {
        return res.status(400).json({
          ok: false,
          message: "publicationYear must be a valid 4-digit year.",
        });
      }

      const copyrightNum = yearNum;

      const pagesNum =
        pages !== undefined && pages !== null && pages !== ""
          ? Math.floor(Number(pages))
          : null;

      if (pagesNum !== null && (!Number.isFinite(pagesNum) || pagesNum <= 0)) {
        return res.status(400).json({
          ok: false,
          message: "pages must be a positive number.",
        });
      }

      const copyNum =
        copyNumber !== undefined && copyNumber !== null && copyNumber !== ""
          ? Math.floor(Number(copyNumber))
          : null;

      if (copyNum !== null && (!Number.isFinite(copyNum) || copyNum <= 0)) {
        return res.status(400).json({
          ok: false,
          message: "copyNumber must be a positive number.",
        });
      }

      const copiesTotal =
        numberOfCopies !== undefined && numberOfCopies !== null && numberOfCopies !== ""
          ? Math.floor(Number(numberOfCopies))
          : 1;

      if (!Number.isFinite(copiesTotal) || copiesTotal <= 0) {
        return res.status(400).json({
          ok: false,
          message: "numberOfCopies must be a positive number.",
        });
      }

      const defaultBorrowDays = Number(process.env.BORROW_DAYS || 7);
      let borrowDurationVal: number;
      if (borrowDurationDays === undefined || borrowDurationDays === null) {
        borrowDurationVal =
          Number.isFinite(defaultBorrowDays) && defaultBorrowDays > 0
            ? Math.floor(defaultBorrowDays)
            : 7;
      } else {
        const parsed = Number(borrowDurationDays);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return res.status(400).json({
            ok: false,
            message: "borrowDurationDays must be a positive number of days.",
          });
        }
        borrowDurationVal = Math.floor(parsed);
      }

      const classification = resolveClassificationPayload({
        subjects,
        genre,
        category,
      });

      const subjectsVal = classification?.subjects ?? null;
      const genreVal = classification?.genre ?? null;
      const categoryVal = classification?.category ?? null;

      const libArea = normalizeLibraryArea(libraryArea);
      const libraryUseOnlyVal = resolveLibraryUseOnlyFlag(
        isLibraryUseOnly,
        libArea,
        false
      );

      const availableVal = true;

      try {
        const ins = await dbQuery<BookRow>(
          `INSERT INTO books (
             title,
             subtitle,
             author,
             statement_of_responsibility,
             edition,
             isbn,
             issn,
             accession_number,
             subjects,
             genre,
             category,
             place_of_publication,
             publisher,
             publication_year,
             copyright_year,
             pages,
             physical_details,
             dimensions,
             notes,
             series,
             added_entries,
             barcode,
             call_number,
             copy_number,
             volume_number,
             library_area,
             number_of_copies,
             available,
             borrow_duration_days,
             is_library_use_only
           )
           VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
             $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
             $21,$22,$23,$24,$25,$26,$27,$28,$29,$30
           )
           RETURNING ${BOOK_RETURNING}`,
          [
            resolvedTitle,
            subtitle ? String(subtitle).trim() : null,
            resolvedAuthorRaw,
            null,
            edition ? String(edition).trim() : null,
            isbn ? String(isbn).trim() : null,
            issn ? String(issn).trim() : null,
            accessionNumber ? String(accessionNumber).trim() : null,
            subjectsVal,
            genreVal,
            categoryVal,
            placeOfPublication ? String(placeOfPublication).trim() : null,
            publisher ? String(publisher).trim() : null,
            yearNum,
            Number.isFinite(copyrightNum) ? copyrightNum : null,
            pagesNum,
            otherDetails ? String(otherDetails).trim() : null,
            dimensions ? String(dimensions).trim() : null,
            notes ? String(notes).trim() : null,
            series ? String(series).trim() : null,
            addedEntries ? String(addedEntries).trim() : null,
            barcode ? String(barcode).trim() : null,
            callNumber ? String(callNumber).trim() : null,
            copyNum,
            volumeNumber ? String(volumeNumber).trim() : null,
            libArea,
            copiesTotal,
            availableVal,
            borrowDurationVal,
            libraryUseOnlyVal,
          ]
        );

        const row = ins.rows[0] as BookRowWithCounts;
        row.active_count = 0;
        row.total_borrow_count = 0;
        row.available_copies = copiesTotal;
        row.computed_available = true;

        const book = toDTO(row);
        res.status(201).json({ ok: true, book });
      } catch (err: any) {
        if (err && err.code === "23505") {
          return res.status(409).json({
            ok: false,
            message:
              "A book with the same accession number, barcode, or another unique identifier already exists.",
          });
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/:id/copies",
  requireAuth,
  requireRole(["librarian", "admin"]),
  async (req, res, next) => {
    const client = await dbPool.connect();
    try {
      const { id } = req.params;
      const bookId = Number(id);

      if (!bookId) {
        return res.status(400).json({ ok: false, message: "Invalid id." });
      }

      await client.query("BEGIN");

      const sourceBookResult = await client.query<BookRow>(
        `SELECT ${BOOK_RETURNING}
           FROM books
           WHERE id = $1
           LIMIT 1`,
        [bookId]
      );

      if (!sourceBookResult.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ ok: false, message: "Book not found." });
      }

      const source = sourceBookResult.rows[0];
      const groupedRows = await findGroupedBookRows(client, source);
      const groupedBookIds = groupedRows
        .map((row) => Number(row.id))
        .filter((value) => Number.isFinite(value) && value > 0);

      const representativeId = groupedBookIds.slice().sort((a, b) => a - b)[0] ?? bookId;
      const { count, copiesToAdd, numberOfCopies } = req.body || {};
      const rawCount = count ?? copiesToAdd ?? numberOfCopies ?? 1;
      const increment = Math.floor(Number(rawCount));

      if (!Number.isFinite(increment) || increment <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          ok: false,
          message: "count must be a positive number.",
        });
      }

      const updatedCopies = await client.query<BookRow>(
        `UPDATE books
           SET number_of_copies = number_of_copies + $1,
               updated_at = NOW()
         WHERE id = $2
         RETURNING ${BOOK_RETURNING}`,
        [increment, representativeId]
      );

      if (!updatedCopies.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ ok: false, message: "Book not found." });
      }

      const state = await computeCopyStateForBook(client, representativeId);

      await client.query(
        `UPDATE books
            SET available = $1,
                updated_at = NOW()
          WHERE id = $2`,
        [state.available, representativeId]
      );

      const rowsForGroup = await client.query<BookRowWithCounts>(
        `
        SELECT
          ${BOOK_RETURNING_B},
          COALESCE(stats.active_count, 0)::int AS active_count,
          COALESCE(stats.total_borrow_count, 0)::int AS total_borrow_count,
          GREATEST(b.number_of_copies - COALESCE(stats.active_count, 0), 0)::int AS available_copies,
          (COALESCE(stats.active_count, 0) < b.number_of_copies) AS computed_available
        FROM books b
        LEFT JOIN (
          SELECT
            book_id,
            COUNT(*) FILTER (WHERE status <> 'returned')::int AS active_count,
            COUNT(*)::int AS total_borrow_count
          FROM borrow_records
          GROUP BY book_id
        ) stats ON stats.book_id = b.id
        WHERE b.id = ANY($1::int[])
        `,
        [groupedBookIds]
      );

      await client.query("COMMIT");

      const groupedBook = aggregateBookGroupRows(rowsForGroup.rows);
      return res.json({ ok: true, book: toDTO(groupedBook) });
    } catch (err: any) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore
      }
      next(err);
    } finally {
      client.release();
    }
  }
);

router.patch(
  "/:id",
  requireAuth,
  requireRole(["librarian", "admin"]),
  async (req, res, next) => {
    const client = await dbPool.connect();
    try {
      const { id } = req.params;
      const bookId = Number(id);

      if (!bookId) {
        return res.status(400).json({ ok: false, message: "Invalid id." });
      }

      const {
        title,
        author,
        subjects,
        isbn,
        genre,
        publicationYear,
        borrowDurationDays,

        accessionNumber,
        subtitle,
        edition,
        issn,
        placeOfPublication,
        publisher,
        copyrightYear,
        pages,
        otherDetails,
        dimensions,
        notes,
        series,
        category,
        addedEntries,
        barcode,
        callNumber,
        copyNumber,
        volumeNumber,
        libraryArea,

        numberOfCopies,
        copiesToAdd,
        isLibraryUseOnly,
      } = req.body || {};

      if (numberOfCopies !== undefined && copiesToAdd !== undefined) {
        return res.status(400).json({
          ok: false,
          message: "Provide either numberOfCopies OR copiesToAdd, not both.",
        });
      }

      await client.query("BEGIN");

      const currentBookResult = await client.query<BookRow>(
        `SELECT ${BOOK_RETURNING}
           FROM books
           WHERE id = $1
           FOR UPDATE`,
        [bookId]
      );

      if (!currentBookResult.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ ok: false, message: "Book not found." });
      }

      const currentBook = currentBookResult.rows[0];
      const groupedRows = await findGroupedBookRows(client, currentBook);
      const groupedBookIds = groupedRows
        .map((row) => Number(row.id))
        .filter((value) => Number.isFinite(value) && value > 0);

      const directUpdates: string[] = [];
      const directValues: any[] = [];
      let directIdx = 1;
      let shouldRefreshAvailability = false;

      const sharedUpdates: string[] = [];
      const sharedValues: any[] = [];
      let sharedIdx = 1;

      if (title !== undefined) {
        sharedUpdates.push(`title = $${sharedIdx++}`);
        sharedValues.push(String(title).trim());
      }

      if (subtitle !== undefined) {
        sharedUpdates.push(`subtitle = $${sharedIdx++}`);
        sharedValues.push(subtitle ? String(subtitle).trim() : null);
      }

      if (author !== undefined) {
        sharedUpdates.push(`author = $${sharedIdx++}`);
        sharedValues.push(String(author).trim());
      }

      if (edition !== undefined) {
        sharedUpdates.push(`edition = $${sharedIdx++}`);
        sharedValues.push(edition ? String(edition).trim() : null);
      }

      if (accessionNumber !== undefined) {
        directUpdates.push(`accession_number = $${directIdx++}`);
        directValues.push(accessionNumber ? String(accessionNumber).trim() : null);
      }

      if (isbn !== undefined) {
        sharedUpdates.push(`isbn = $${sharedIdx++}`);
        sharedValues.push(isbn ? String(isbn).trim() : null);
      }

      if (issn !== undefined) {
        sharedUpdates.push(`issn = $${sharedIdx++}`);
        sharedValues.push(issn ? String(issn).trim() : null);
      }

      const classification = resolveClassificationPayload({
        subjects,
        genre,
        category,
      });

      if (classification) {
        sharedUpdates.push(`subjects = $${sharedIdx++}`);
        sharedValues.push(classification.subjects);

        sharedUpdates.push(`genre = $${sharedIdx++}`);
        sharedValues.push(classification.genre);

        sharedUpdates.push(`category = $${sharedIdx++}`);
        sharedValues.push(classification.category);
      }

      if (placeOfPublication !== undefined) {
        sharedUpdates.push(`place_of_publication = $${sharedIdx++}`);
        sharedValues.push(placeOfPublication ? String(placeOfPublication).trim() : null);
      }

      if (publisher !== undefined) {
        sharedUpdates.push(`publisher = $${sharedIdx++}`);
        sharedValues.push(publisher ? String(publisher).trim() : null);
      }

      if (publicationYear !== undefined) {
        const yearNum = Number(publicationYear);
        if (!Number.isFinite(yearNum) || yearNum < 1000 || yearNum > 9999) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            ok: false,
            message: "publicationYear must be a valid 4-digit year.",
          });
        }

        sharedUpdates.push(`publication_year = $${sharedIdx++}`);
        sharedValues.push(yearNum);

        if (copyrightYear === undefined) {
          sharedUpdates.push(`copyright_year = $${sharedIdx++}`);
          sharedValues.push(yearNum);
        }
      }

      if (copyrightYear !== undefined) {
        const yearNum = copyrightYear ? Number(copyrightYear) : null;
        if (
          yearNum !== null &&
          (!Number.isFinite(yearNum) || yearNum < 1000 || yearNum > 9999)
        ) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            ok: false,
            message: "copyrightYear must be a valid 4-digit year.",
          });
        }

        sharedUpdates.push(`copyright_year = $${sharedIdx++}`);
        sharedValues.push(yearNum);

        if (publicationYear === undefined && yearNum !== null) {
          sharedUpdates.push(`publication_year = $${sharedIdx++}`);
          sharedValues.push(yearNum);
        }
      }

      if (pages !== undefined) {
        const pagesNum = pages ? Math.floor(Number(pages)) : null;
        if (pagesNum !== null && (!Number.isFinite(pagesNum) || pagesNum <= 0)) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            ok: false,
            message: "pages must be a positive number.",
          });
        }

        sharedUpdates.push(`pages = $${sharedIdx++}`);
        sharedValues.push(pagesNum);
      }

      if (otherDetails !== undefined) {
        sharedUpdates.push(`physical_details = $${sharedIdx++}`);
        sharedValues.push(otherDetails ? String(otherDetails).trim() : null);
      }

      if (dimensions !== undefined) {
        sharedUpdates.push(`dimensions = $${sharedIdx++}`);
        sharedValues.push(dimensions ? String(dimensions).trim() : null);
      }

      if (notes !== undefined) {
        sharedUpdates.push(`notes = $${sharedIdx++}`);
        sharedValues.push(notes ? String(notes).trim() : null);
      }

      if (series !== undefined) {
        sharedUpdates.push(`series = $${sharedIdx++}`);
        sharedValues.push(series ? String(series).trim() : null);
      }

      if (addedEntries !== undefined) {
        sharedUpdates.push(`added_entries = $${sharedIdx++}`);
        sharedValues.push(addedEntries ? String(addedEntries).trim() : null);
      }

      if (barcode !== undefined) {
        directUpdates.push(`barcode = $${directIdx++}`);
        directValues.push(barcode ? String(barcode).trim() : null);
      }

      if (callNumber !== undefined) {
        sharedUpdates.push(`call_number = $${sharedIdx++}`);
        sharedValues.push(callNumber ? String(callNumber).trim() : null);
      }

      if (copyNumber !== undefined) {
        const copyNum = copyNumber ? Math.floor(Number(copyNumber)) : null;
        if (copyNum !== null && (!Number.isFinite(copyNum) || copyNum <= 0)) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            ok: false,
            message: "copyNumber must be a positive number.",
          });
        }

        directUpdates.push(`copy_number = $${directIdx++}`);
        directValues.push(copyNum);
      }

      if (volumeNumber !== undefined) {
        sharedUpdates.push(`volume_number = $${sharedIdx++}`);
        sharedValues.push(volumeNumber ? String(volumeNumber).trim() : null);
      }

      if (libraryArea !== undefined || isLibraryUseOnly !== undefined) {
        const resolvedLibraryArea =
          libraryArea !== undefined
            ? normalizeLibraryArea(libraryArea)
            : currentBook.library_area ?? null;

        if (libraryArea !== undefined) {
          sharedUpdates.push(`library_area = $${sharedIdx++}`);
          sharedValues.push(resolvedLibraryArea);
        }

        const resolvedLibraryUseOnly = resolveLibraryUseOnlyFlag(
          isLibraryUseOnly,
          resolvedLibraryArea,
          Boolean(currentBook.is_library_use_only)
        );

        sharedUpdates.push(`is_library_use_only = $${sharedIdx++}`);
        sharedValues.push(resolvedLibraryUseOnly);
      }

      if (numberOfCopies !== undefined) {
        const copiesTotal = Math.floor(Number(numberOfCopies));
        if (!Number.isFinite(copiesTotal) || copiesTotal <= 0) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            ok: false,
            message: "numberOfCopies must be a positive number.",
          });
        }

        directUpdates.push(`number_of_copies = $${directIdx++}`);
        directValues.push(copiesTotal);
        shouldRefreshAvailability = true;
      }

      if (copiesToAdd !== undefined) {
        const inc = Math.floor(Number(copiesToAdd));
        if (!Number.isFinite(inc) || inc <= 0) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            ok: false,
            message: "copiesToAdd must be a positive number.",
          });
        }

        directUpdates.push(`number_of_copies = number_of_copies + $${directIdx++}`);
        directValues.push(inc);
        shouldRefreshAvailability = true;
      }

      if (borrowDurationDays !== undefined) {
        const parsed = Number(borrowDurationDays);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            ok: false,
            message: "borrowDurationDays must be a positive number of days.",
          });
        }

        sharedUpdates.push(`borrow_duration_days = $${sharedIdx++}`);
        sharedValues.push(Math.floor(parsed));
      }

      if (directUpdates.length === 0 && sharedUpdates.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          ok: false,
          message: "No updatable fields provided.",
        });
      }

      try {
        if (sharedUpdates.length > 0) {
          const sharedSql = `
            UPDATE books
            SET ${sharedUpdates.join(", ")},
                updated_at = NOW()
            WHERE id = ANY($${sharedIdx}::int[])
          `;
          sharedValues.push(groupedBookIds);
          await client.query(sharedSql, sharedValues);
        }

        if (directUpdates.length > 0) {
          const directSql = `
            UPDATE books
            SET ${directUpdates.join(", ")},
                updated_at = NOW()
            WHERE id = $${directIdx}
          `;
          directValues.push(bookId);
          await client.query(directSql, directValues);
        }
      } catch (err: any) {
        if (err && err.code === "23505") {
          await client.query("ROLLBACK");
          return res.status(409).json({
            ok: false,
            message:
              "A book with the same accession number, barcode, or another unique identifier already exists.",
          });
        }
        throw err;
      }

      if (shouldRefreshAvailability) {
        const state = await computeCopyStateForBook(client, bookId);

        await client.query(
          `UPDATE books
              SET available = $1,
                  updated_at = NOW()
            WHERE id = $2`,
          [state.available, bookId]
        );
      }

      const rowsForGroup = await client.query<BookRowWithCounts>(
        `
        SELECT
          ${BOOK_RETURNING_B},
          COALESCE(stats.active_count, 0)::int AS active_count,
          COALESCE(stats.total_borrow_count, 0)::int AS total_borrow_count,
          GREATEST(b.number_of_copies - COALESCE(stats.active_count, 0), 0)::int AS available_copies,
          (COALESCE(stats.active_count, 0) < b.number_of_copies) AS computed_available
        FROM books b
        LEFT JOIN (
          SELECT
            book_id,
            COUNT(*) FILTER (WHERE status <> 'returned')::int AS active_count,
            COUNT(*)::int AS total_borrow_count
          FROM borrow_records
          GROUP BY book_id
        ) stats ON stats.book_id = b.id
        WHERE b.id = ANY($1::int[])
        `,
        [groupedBookIds]
      );

      await client.query("COMMIT");

      const groupedBook = aggregateBookGroupRows(rowsForGroup.rows);
      res.json({ ok: true, book: toDTO(groupedBook) });
    } catch (err: any) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore
      }
      next(err);
    } finally {
      client.release();
    }
  }
);

router.delete(
  "/:id",
  requireAuth,
  requireRole(["librarian", "admin"]),
  async (req, res, next) => {
    const client = await dbPool.connect();
    try {
      const { id } = req.params;
      const bookId = Number(id);

      if (!bookId) {
        return res.status(400).json({ ok: false, message: "Invalid id." });
      }

      await client.query("BEGIN");

      const currentBookResult = await client.query<BookRow>(
        `SELECT ${BOOK_RETURNING}
           FROM books
           WHERE id = $1
           LIMIT 1`,
        [bookId]
      );

      if (!currentBookResult.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ ok: false, message: "Book not found." });
      }

      const groupedRows = await findGroupedBookRows(client, currentBookResult.rows[0]);
      const groupedBookIds = groupedRows
        .map((row) => Number(row.id))
        .filter((value) => Number.isFinite(value) && value > 0);

      const result = await client.query(
        `DELETE FROM books
          WHERE id = ANY($1::int[])`,
        [groupedBookIds]
      );

      if (!result.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ ok: false, message: "Book not found." });
      }

      await client.query("COMMIT");
      res.json({ ok: true, message: "Book deleted." });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore
      }
      next(err);
    } finally {
      client.release();
    }
  }
);

export default router;