BEGIN;

ALTER TABLE books
  ADD COLUMN IF NOT EXISTS parent_book_id INTEGER NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'books_parent_book_id_fkey'
  ) THEN
    ALTER TABLE books
      ADD CONSTRAINT books_parent_book_id_fkey
      FOREIGN KEY (parent_book_id)
      REFERENCES books(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS books_parent_book_id_idx
  ON books(parent_book_id);

WITH ranked_books AS (
  SELECT
    b.id,
    ROW_NUMBER() OVER (
      PARTITION BY CASE
        WHEN COALESCE(btrim(b.title), '') = ''
         AND COALESCE(btrim(b.author), '') = ''
         AND COALESCE(btrim(b.call_number), '') = ''
         AND COALESCE(btrim(b.isbn), '') = ''
          THEN '__single__|' || b.id::text
        ELSE concat_ws(
          '|',
          lower(btrim(COALESCE(b.title, ''))),
          lower(btrim(COALESCE(b.author, ''))),
          lower(btrim(COALESCE(b.call_number, ''))),
          lower(btrim(COALESCE(b.isbn, '')))
        )
      END
      ORDER BY b.created_at ASC NULLS LAST,
               b.copy_number ASC NULLS LAST,
               b.id ASC
    ) AS row_rank,
    FIRST_VALUE(b.id) OVER (
      PARTITION BY CASE
        WHEN COALESCE(btrim(b.title), '') = ''
         AND COALESCE(btrim(b.author), '') = ''
         AND COALESCE(btrim(b.call_number), '') = ''
         AND COALESCE(btrim(b.isbn), '') = ''
          THEN '__single__|' || b.id::text
        ELSE concat_ws(
          '|',
          lower(btrim(COALESCE(b.title, ''))),
          lower(btrim(COALESCE(b.author, ''))),
          lower(btrim(COALESCE(b.call_number, ''))),
          lower(btrim(COALESCE(b.isbn, '')))
        )
      END
      ORDER BY b.created_at ASC NULLS LAST,
               b.copy_number ASC NULLS LAST,
               b.id ASC
    ) AS root_book_id
  FROM books b
)
UPDATE books AS b
SET parent_book_id = CASE
  WHEN ranked_books.row_rank = 1 THEN NULL
  ELSE ranked_books.root_book_id
END
FROM ranked_books
WHERE b.id = ranked_books.id
  AND b.parent_book_id IS DISTINCT FROM CASE
    WHEN ranked_books.row_rank = 1 THEN NULL
    ELSE ranked_books.root_book_id
  END;

UPDATE books
SET parent_book_id = NULL
WHERE parent_book_id = id;

COMMIT;