import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../db";

const router = express.Router();

type Role = "student" | "librarian" | "faculty" | "admin" | "other";

type BookRow = {
  id: string;
  title: string;
  author: string;
  isbn: string | null;
  genre: string | null;
  publication_year: number;
  available: boolean;
  created_at: string;
  updated_at: string;
};

type SessionPayload = {
  sub: string;
  email: string;
  role: Role;
  ev: number;
};

/* ---------------- Session helpers (cookie-based JWT, same as auth.ts) ---------------- */

function readSession(
  req: express.Request
): SessionPayload | null {
  const token = (req.cookies as any)?.["bh_session"];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as any;
    return {
      sub: String(payload.sub),
      email: String(payload.email),
      role: String(payload.role) as Role,
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
    return res
      .status(401)
      .json({ ok: false, message: "Not authenticated." });
  }
  (req as any).sessionUser = s;
  next();
}

function requireRole(roles: Role[]) {
  return (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    const s = (req as any).sessionUser as SessionPayload | undefined;
    if (!s) {
      return res
        .status(401)
        .json({ ok: false, message: "Not authenticated." });
    }
    if (!roles.includes(s.role)) {
      return res
        .status(403)
        .json({ ok: false, message: "Forbidden: insufficient role." });
    }
    next();
  };
}

/* ---------------- Mapping helper ---------------- */

function toDTO(row: BookRow) {
  return {
    id: String(row.id),
    title: row.title,
    author: row.author,
    isbn: row.isbn ?? "",
    genre: row.genre ?? "",
    publicationYear: row.publication_year,
    available: row.available,
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
      `SELECT id, title, author, isbn, genre, publication_year, available, created_at, updated_at
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
        title,
        author,
        isbn,
        genre,
        publicationYear,
        available,
      } = req.body || {};

      if (!title || !author || publicationYear === undefined) {
        return res.status(400).json({
          ok: false,
          message: "Title, author, and publicationYear are required.",
        });
      }

      const yearNum = Number(publicationYear);
      if (!Number.isFinite(yearNum) || yearNum < 1000 || yearNum > 9999) {
        return res.status(400).json({
          ok: false,
          message: "publicationYear must be a valid 4-digit year.",
        });
      }

      const availableVal =
        typeof available === "boolean" ? available : true;

      try {
        const ins = await query<BookRow>(
          `INSERT INTO books (title, author, isbn, genre, publication_year, available)
           VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING id, title, author, isbn, genre, publication_year, available, created_at, updated_at`,
          [
            String(title).trim(),
            String(author).trim(),
            isbn ? String(isbn).trim() : null,
            genre ? String(genre).trim() : null,
            yearNum,
            availableVal,
          ]
        );

        const book = toDTO(ins.rows[0]);
        res.status(201).json({ ok: true, book });
      } catch (err: any) {
        if (err && err.code === "23505") {
          // Unique violation (likely ISBN)
          return res.status(409).json({
            ok: false,
            message:
              "A book with that ISBN already exists in the catalog.",
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
        title,
        author,
        isbn,
        genre,
        publicationYear,
        available,
      } = req.body || {};

      const updates: string[] = [];
      const values: any[] = [];
      let idx = 1;

      if (title !== undefined) {
        updates.push(`title = $${idx++}`);
        values.push(String(title).trim());
      }
      if (author !== undefined) {
        updates.push(`author = $${idx++}`);
        values.push(String(author).trim());
      }
      if (isbn !== undefined) {
        updates.push(`isbn = $${idx++}`);
        values.push(isbn ? String(isbn).trim() : null);
      }
      if (genre !== undefined) {
        updates.push(`genre = $${idx++}`);
        values.push(genre ? String(genre).trim() : null);
      }
      if (publicationYear !== undefined) {
        const yearNum = Number(publicationYear);
        if (
          !Number.isFinite(yearNum) ||
          yearNum < 1000 ||
          yearNum > 9999
        ) {
          return res.status(400).json({
            ok: false,
            message: "publicationYear must be a valid 4-digit year.",
          });
        }
        updates.push(`publication_year = $${idx++}`);
        values.push(yearNum);
      }
      if (available !== undefined) {
        updates.push(`available = $${idx++}`);
        values.push(Boolean(available));
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
        RETURNING id, title, author, isbn, genre, publication_year, available, created_at, updated_at
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
              "A book with that ISBN already exists in the catalog.",
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

      const result = await query(
        `DELETE FROM books WHERE id = $1`,
        [Number(id)]
      );

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
