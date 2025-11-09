BEGIN;

CREATE TABLE IF NOT EXISTS books (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  isbn TEXT,
  genre TEXT,
  publication_year INTEGER NOT NULL,
  available BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enforce unique ISBN when present (multiple NULLs allowed)
CREATE UNIQUE INDEX IF NOT EXISTS books_isbn_unique
ON books (isbn)
WHERE isbn IS NOT NULL;

COMMIT;
