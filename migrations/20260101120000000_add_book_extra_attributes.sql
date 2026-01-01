BEGIN;

-- Add missing book attributes based on the OPAC "Add Book Titles" form
ALTER TABLE books
  ADD COLUMN IF NOT EXISTS accession_number TEXT,
  ADD COLUMN IF NOT EXISTS subtitle TEXT,
  ADD COLUMN IF NOT EXISTS statement_of_responsibility TEXT,
  ADD COLUMN IF NOT EXISTS edition TEXT,
  ADD COLUMN IF NOT EXISTS issn TEXT,
  ADD COLUMN IF NOT EXISTS place_of_publication TEXT,
  ADD COLUMN IF NOT EXISTS publisher TEXT,
  ADD COLUMN IF NOT EXISTS copyright_year INTEGER,
  ADD COLUMN IF NOT EXISTS pages INTEGER,
  ADD COLUMN IF NOT EXISTS physical_details TEXT,
  ADD COLUMN IF NOT EXISTS dimensions TEXT,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS series TEXT,
  ADD COLUMN IF NOT EXISTS category TEXT,
  ADD COLUMN IF NOT EXISTS added_entries TEXT,
  ADD COLUMN IF NOT EXISTS barcode TEXT,
  ADD COLUMN IF NOT EXISTS call_number TEXT,
  ADD COLUMN IF NOT EXISTS copy_number INTEGER,
  ADD COLUMN IF NOT EXISTS volume_number TEXT,
  ADD COLUMN IF NOT EXISTS library_area TEXT,
  ADD COLUMN IF NOT EXISTS borrow_duration_days INTEGER;

-- Backfill helpful defaults
UPDATE books
SET
  borrow_duration_days = COALESCE(borrow_duration_days, 7),
  category = COALESCE(category, genre),
  copyright_year = COALESCE(copyright_year, publication_year)
WHERE TRUE;

-- Unique identifiers (partial unique indexes so multiple NULLs are allowed)
CREATE UNIQUE INDEX IF NOT EXISTS books_accession_number_unique
ON books (accession_number)
WHERE accession_number IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS books_barcode_unique
ON books (barcode)
WHERE barcode IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS books_issn_unique
ON books (issn)
WHERE issn IS NOT NULL;

-- Constraints (drop+add = idempotent)
ALTER TABLE books
  DROP CONSTRAINT IF EXISTS books_library_area_check;

ALTER TABLE books
  ADD CONSTRAINT books_library_area_check
  CHECK (
    library_area IS NULL OR library_area IN (
      'filipiniana',
      'general_circulation',
      'maritime',
      'periodicals',
      'thesis_dissertations',
      'rizaliana',
      'special_collection',
      'fil_gen_reference',
      'general_reference',
      'fiction'
    )
  );

ALTER TABLE books
  DROP CONSTRAINT IF EXISTS books_pages_positive_check;

ALTER TABLE books
  ADD CONSTRAINT books_pages_positive_check
  CHECK (pages IS NULL OR pages > 0);

ALTER TABLE books
  DROP CONSTRAINT IF EXISTS books_borrow_duration_days_positive_check;

ALTER TABLE books
  ADD CONSTRAINT books_borrow_duration_days_positive_check
  CHECK (borrow_duration_days IS NULL OR borrow_duration_days > 0);

ALTER TABLE books
  DROP CONSTRAINT IF EXISTS books_copyright_year_check;

ALTER TABLE books
  ADD CONSTRAINT books_copyright_year_check
  CHECK (copyright_year IS NULL OR (copyright_year >= 1000 AND copyright_year <= 9999));

ALTER TABLE books
  DROP CONSTRAINT IF EXISTS books_copy_number_check;

ALTER TABLE books
  ADD CONSTRAINT books_copy_number_check
  CHECK (copy_number IS NULL OR copy_number > 0);

COMMIT;
