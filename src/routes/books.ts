import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../db";

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

type BookRow = {
  id: string;
  title: string;
  author: string;
  isbn: string | null;
  issn: string | null;

  // Existing field in your API (kept)
  genre: string | null;

  // Newly added fields from the OPAC form
  accession_number: string | null;
  subtitle: string | null;
  statement_of_responsibility: string | null;
  edition: string | null;

  place_of_publication: string | null;
  publisher: string | null;
  copyright_year: number | null;

  pages: number | null;
  physical_details: string | null; // "Other Details" in the form
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

  publication_year: number;
  available: boolean;
  borrow_duration_days: number | null;

  created_at: string;
  updated_at: string;
};

type SessionPayload = {
  sub: string;
  email: string;
  role: Role;
  ev: number;
};

/**
 * Minimal shape from users table for role resolution.
 */
type UserRoleRow = {
  id: string;
  account_type: Role;
  role?: Role | null;
};

/* ---------------- Role normalization helper ---------------- */

function normalizeRole(raw: unknown): Role {
  const v = String(raw ?? "").trim().toLowerCase();

  if (v === "student") return "student";
  if (v === "librarian") return "librarian";
  if (v === "faculty") return "faculty";
  if (v === "admin") return "admin";

  return "other";
}

/* ---------------- Library Area normalization ---------------- */

function normalizeLibraryArea(raw: unknown): LibraryArea | null {
  if (raw === undefined || raw === null) return null;

  const v = String(raw).trim().toLowerCase();
  if (!v) return null;

  // Accept canonical values directly
  if (LIBRARY_AREAS.has(v as LibraryArea)) return v as LibraryArea;

  // Accept human labels from the screenshot UI
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

/* ---------------- Session helpers (cookie-based JWT) ---------------- */

function readSession(req: express.Request): SessionPayload | null {
  const token = (req.cookies as any)?.["bh_session"];
  if (!token) return null;

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as any;

    return {
      sub: String(payload.sub),
      email: String(payload.email),
      // Normalize so "Librarian", " librarian ", etc. all become "librarian"
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
 * Compute the effective role using the same logic as auth.ts
 */
function computeEffectiveRoleFromRow(row: UserRoleRow): Role {
  const primary = (row.account_type || "student") as Role;
  const legacy = (row.role as Role | null) || undefined;

  if (primary && primary !== "student") {
    return primary;
  }

  if (primary === "student" && legacy && legacy !== "student") {
    return legacy;
  }

  return primary || legacy || "student";
}

/**
 * Role guard that always checks the DB for the current effective role.
 */
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
          console.warn("[books] Forbidden: insufficient role", {
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
      .catch((err) => {
        next(err);
      });
  };
}

/* ---------------- Mapping helper ---------------- */

function toDTO(row: BookRow) {
  return {
    id: String(row.id),

    // Primary
    accessionNumber: row.accession_number ?? "",
    title: row.title,
    subtitle: row.subtitle ?? "",
    author: row.author,
    statementOfResponsibility: row.statement_of_responsibility ?? "",
    edition: row.edition ?? "",
    isbn: row.isbn ?? "",
    issn: row.issn ?? "",

    // Publication
    placeOfPublication: row.place_of_publication ?? "",
    publisher: row.publisher ?? "",
    publicationYear: row.publication_year,
    copyrightYear: row.copyright_year ?? null,

    // Physical Description
    pages: typeof row.pages === "number" ? row.pages : null,
    otherDetails: row.physical_details ?? "",
    dimensions: row.dimensions ?? "",
    notes: row.notes ?? "",
    series: row.series ?? "",
    category: row.category ?? "",
    addedEntries: row.added_entries ?? "",

    // Existing (kept)
    genre: row.genre ?? "",
    available: row.available,
    borrowDurationDays:
      typeof row.borrow_duration_days === "number"
        ? row.borrow_duration_days
        : null,

    // Copy Details
    barcode: row.barcode ?? "",
    callNumber: row.call_number ?? "",
    copyNumber: typeof row.copy_number === "number" ? row.copy_number : null,
    volumeNumber: row.volume_number ?? "",
    libraryArea: row.library_area ?? null,
  };
}

/* ---------------- Routes ---------------- */

/**
 * GET /api/books
 * Public read endpoint (no auth required).
 */
router.get("/", async (_req, res, next) => {
  try {
    const result = await query<BookRow>(
      `SELECT id,
              title,
              subtitle,
              author,
              statement_of_responsibility,
              edition,
              isbn,
              issn,
              accession_number,
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
              available,
              borrow_duration_days,
              created_at,
              updated_at
       FROM books
       ORDER BY created_at DESC, id DESC`
    );

    const books = result.rows.map(toDTO);
    res.json({ ok: true, books });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/books
 * Create a book – librarian/admin only.
 */
router.post(
  "/",
  requireAuth,
  requireRole(["librarian", "admin"]),
  async (req, res, next) => {
    try {
      const {
        // Existing inputs
        title,
        author,
        isbn,
        genre,
        publicationYear,
        available,
        borrowDurationDays,

        // New inputs based on OPAC form
        accessionNumber,
        subtitle,
        statementOfResponsibility,
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
      } = req.body || {};

      // Map OPAC-like inputs to required legacy fields where helpful:
      const resolvedTitle = title ? String(title).trim() : "";
      const resolvedAuthorRaw =
        author !== undefined && author !== null && String(author).trim()
          ? String(author).trim()
          : statementOfResponsibility !== undefined &&
            statementOfResponsibility !== null &&
            String(statementOfResponsibility).trim()
            ? String(statementOfResponsibility).trim()
            : "";

      const rawYear = publicationYear ?? copyrightYear;

      if (!resolvedTitle || !resolvedAuthorRaw || rawYear === undefined) {
        return res.status(400).json({
          ok: false,
          message:
            "Title, author (or statementOfResponsibility), and publicationYear (or copyrightYear) are required.",
        });
      }

      const yearNum = Number(rawYear);
      if (!Number.isFinite(yearNum) || yearNum < 1000 || yearNum > 9999) {
        return res.status(400).json({
          ok: false,
          message: "publicationYear/copyrightYear must be a valid 4-digit year.",
        });
      }

      const copyrightNum =
        copyrightYear !== undefined && copyrightYear !== null && copyrightYear !== ""
          ? Number(copyrightYear)
          : yearNum;

      if (
        copyrightNum !== null &&
        (!Number.isFinite(copyrightNum) ||
          copyrightNum < 1000 ||
          copyrightNum > 9999)
      ) {
        return res.status(400).json({
          ok: false,
          message: "copyrightYear must be a valid 4-digit year.",
        });
      }

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

      const availableVal = typeof available === "boolean" ? available : true;

      // Keep backward compatibility: if only one of genre/category is provided, mirror into the other.
      const genreVal =
        genre !== undefined && genre !== null && String(genre).trim()
          ? String(genre).trim()
          : category !== undefined && category !== null && String(category).trim()
            ? String(category).trim()
            : null;

      const categoryVal =
        category !== undefined && category !== null && String(category).trim()
          ? String(category).trim()
          : genre !== undefined && genre !== null && String(genre).trim()
            ? String(genre).trim()
            : null;

      const libArea = normalizeLibraryArea(libraryArea);

      try {
        const ins = await query<BookRow>(
          `INSERT INTO books (
             title,
             subtitle,
             author,
             statement_of_responsibility,
             edition,
             isbn,
             issn,
             accession_number,
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
             available,
             borrow_duration_days
           )
           VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
             $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
             $21,$22,$23,$24,$25,$26,$27
           )
           RETURNING id,
                     title,
                     subtitle,
                     author,
                     statement_of_responsibility,
                     edition,
                     isbn,
                     issn,
                     accession_number,
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
                     available,
                     borrow_duration_days,
                     created_at,
                     updated_at`,
          [
            resolvedTitle,
            subtitle ? String(subtitle).trim() : null,
            resolvedAuthorRaw,
            statementOfResponsibility
              ? String(statementOfResponsibility).trim()
              : resolvedAuthorRaw,
            edition ? String(edition).trim() : null,
            isbn ? String(isbn).trim() : null,
            issn ? String(issn).trim() : null,
            accessionNumber ? String(accessionNumber).trim() : null,
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
            availableVal,
            borrowDurationVal,
          ]
        );

        const book = toDTO(ins.rows[0]);
        res.status(201).json({ ok: true, book });
      } catch (err: any) {
        if (err && err.code === "23505") {
          return res.status(409).json({
            ok: false,
            message:
              "A book with the same ISBN/ISSN/Accession Number/Barcode already exists.",
          });
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /api/books/:id
 * Partial update – librarian/admin only.
 */
router.patch(
  "/:id",
  requireAuth,
  requireRole(["librarian", "admin"]),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      const {
        // Existing
        title,
        author,
        isbn,
        genre,
        publicationYear,
        available,
        borrowDurationDays,

        // New
        accessionNumber,
        subtitle,
        statementOfResponsibility,
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
      } = req.body || {};

      const updates: string[] = [];
      const values: any[] = [];
      let idx = 1;

      if (title !== undefined) {
        updates.push(`title = $${idx++}`);
        values.push(String(title).trim());
      }

      if (subtitle !== undefined) {
        updates.push(`subtitle = $${idx++}`);
        values.push(subtitle ? String(subtitle).trim() : null);
      }

      // If statementOfResponsibility is updated and author is not explicitly provided,
      // keep author in sync for backward compatibility.
      if (statementOfResponsibility !== undefined) {
        const sor = statementOfResponsibility
          ? String(statementOfResponsibility).trim()
          : null;

        updates.push(`statement_of_responsibility = $${idx++}`);
        values.push(sor);

        if (author === undefined) {
          updates.push(`author = $${idx++}`);
          values.push(sor ? sor : "");
        }
      }

      if (author !== undefined) {
        updates.push(`author = $${idx++}`);
        values.push(String(author).trim());
      }

      if (edition !== undefined) {
        updates.push(`edition = $${idx++}`);
        values.push(edition ? String(edition).trim() : null);
      }

      if (accessionNumber !== undefined) {
        updates.push(`accession_number = $${idx++}`);
        values.push(accessionNumber ? String(accessionNumber).trim() : null);
      }

      if (isbn !== undefined) {
        updates.push(`isbn = $${idx++}`);
        values.push(isbn ? String(isbn).trim() : null);
      }

      if (issn !== undefined) {
        updates.push(`issn = $${idx++}`);
        values.push(issn ? String(issn).trim() : null);
      }

      // Genre/Category: if only one is provided, mirror into the other for compatibility.
      if (category !== undefined) {
        const cat = category ? String(category).trim() : null;
        updates.push(`category = $${idx++}`);
        values.push(cat);

        if (genre === undefined) {
          updates.push(`genre = $${idx++}`);
          values.push(cat);
        }
      }

      if (genre !== undefined) {
        const g = genre ? String(genre).trim() : null;
        updates.push(`genre = $${idx++}`);
        values.push(g);

        if (category === undefined) {
          updates.push(`category = $${idx++}`);
          values.push(g);
        }
      }

      if (placeOfPublication !== undefined) {
        updates.push(`place_of_publication = $${idx++}`);
        values.push(placeOfPublication ? String(placeOfPublication).trim() : null);
      }

      if (publisher !== undefined) {
        updates.push(`publisher = $${idx++}`);
        values.push(publisher ? String(publisher).trim() : null);
      }

      // publicationYear is required in DB; accept copyrightYear too (OPAC-like UI).
      if (publicationYear !== undefined) {
        const yearNum = Number(publicationYear);
        if (!Number.isFinite(yearNum) || yearNum < 1000 || yearNum > 9999) {
          return res.status(400).json({
            ok: false,
            message: "publicationYear must be a valid 4-digit year.",
          });
        }
        updates.push(`publication_year = $${idx++}`);
        values.push(yearNum);
      }

      if (copyrightYear !== undefined) {
        const yearNum = copyrightYear ? Number(copyrightYear) : null;
        if (
          yearNum !== null &&
          (!Number.isFinite(yearNum) || yearNum < 1000 || yearNum > 9999)
        ) {
          return res.status(400).json({
            ok: false,
            message: "copyrightYear must be a valid 4-digit year.",
          });
        }

        updates.push(`copyright_year = $${idx++}`);
        values.push(yearNum);

        // If caller only uses copyrightYear (OPAC UI), also keep publication_year aligned.
        if (publicationYear === undefined && yearNum !== null) {
          updates.push(`publication_year = $${idx++}`);
          values.push(yearNum);
        }
      }

      if (pages !== undefined) {
        const pagesNum = pages ? Math.floor(Number(pages)) : null;
        if (pagesNum !== null && (!Number.isFinite(pagesNum) || pagesNum <= 0)) {
          return res.status(400).json({
            ok: false,
            message: "pages must be a positive number.",
          });
        }
        updates.push(`pages = $${idx++}`);
        values.push(pagesNum);
      }

      if (otherDetails !== undefined) {
        updates.push(`physical_details = $${idx++}`);
        values.push(otherDetails ? String(otherDetails).trim() : null);
      }

      if (dimensions !== undefined) {
        updates.push(`dimensions = $${idx++}`);
        values.push(dimensions ? String(dimensions).trim() : null);
      }

      if (notes !== undefined) {
        updates.push(`notes = $${idx++}`);
        values.push(notes ? String(notes).trim() : null);
      }

      if (series !== undefined) {
        updates.push(`series = $${idx++}`);
        values.push(series ? String(series).trim() : null);
      }

      if (addedEntries !== undefined) {
        updates.push(`added_entries = $${idx++}`);
        values.push(addedEntries ? String(addedEntries).trim() : null);
      }

      if (barcode !== undefined) {
        updates.push(`barcode = $${idx++}`);
        values.push(barcode ? String(barcode).trim() : null);
      }

      if (callNumber !== undefined) {
        updates.push(`call_number = $${idx++}`);
        values.push(callNumber ? String(callNumber).trim() : null);
      }

      if (copyNumber !== undefined) {
        const copyNum = copyNumber ? Math.floor(Number(copyNumber)) : null;
        if (copyNum !== null && (!Number.isFinite(copyNum) || copyNum <= 0)) {
          return res.status(400).json({
            ok: false,
            message: "copyNumber must be a positive number.",
          });
        }
        updates.push(`copy_number = $${idx++}`);
        values.push(copyNum);
      }

      if (volumeNumber !== undefined) {
        updates.push(`volume_number = $${idx++}`);
        values.push(volumeNumber ? String(volumeNumber).trim() : null);
      }

      if (libraryArea !== undefined) {
        const libArea = normalizeLibraryArea(libraryArea);
        updates.push(`library_area = $${idx++}`);
        values.push(libArea);
      }

      if (available !== undefined) {
        updates.push(`available = $${idx++}`);
        values.push(Boolean(available));
      }

      if (borrowDurationDays !== undefined) {
        const parsed = Number(borrowDurationDays);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return res.status(400).json({
            ok: false,
            message: "borrowDurationDays must be a positive number of days.",
          });
        }
        updates.push(`borrow_duration_days = $${idx++}`);
        values.push(Math.floor(parsed));
      }

      if (updates.length === 0) {
        return res.status(400).json({
          ok: false,
          message: "No updatable fields provided.",
        });
      }

      updates.push(`updated_at = NOW()`);

      const sql = `
        UPDATE books
        SET ${updates.join(", ")}
        WHERE id = $${idx}
        RETURNING id,
                  title,
                  subtitle,
                  author,
                  statement_of_responsibility,
                  edition,
                  isbn,
                  issn,
                  accession_number,
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
                  available,
                  borrow_duration_days,
                  created_at,
                  updated_at
      `;
      values.push(Number(id));

      try {
        const result = await query<BookRow>(sql, values);
        if (!result.rowCount) {
          return res
            .status(404)
            .json({ ok: false, message: "Book not found." });
        }

        const book = toDTO(result.rows[0]);
        res.json({ ok: true, book });
      } catch (err: any) {
        if (err && err.code === "23505") {
          return res.status(409).json({
            ok: false,
            message:
              "A book with the same ISBN/ISSN/Accession Number/Barcode already exists.",
          });
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  }
);

/**
 * DELETE /api/books/:id
 * Remove a book – librarian/admin only.
 */
router.delete(
  "/:id",
  requireAuth,
  requireRole(["librarian", "admin"]),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      const result = await query(`DELETE FROM books WHERE id = $1`, [
        Number(id),
      ]);

      if (!result.rowCount) {
        return res
          .status(404)
          .json({ ok: false, message: "Book not found." });
      }

      res.json({ ok: true, message: "Book deleted." });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
