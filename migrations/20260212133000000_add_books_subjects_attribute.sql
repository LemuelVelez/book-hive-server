BEGIN;

-- Add new Subjects attribute for books
ALTER TABLE books
  ADD COLUMN IF NOT EXISTS subjects TEXT;

-- Backfill subjects from existing data (prefer category, then genre)
UPDATE books
SET subjects = COALESCE(NULLIF(TRIM(subjects), ''), NULLIF(TRIM(category), ''), NULLIF(TRIM(genre), ''))
WHERE subjects IS NULL OR TRIM(subjects) = '';

-- Keep legacy fields in sync where missing
UPDATE books
SET
  category = COALESCE(NULLIF(TRIM(category), ''), subjects),
  genre = COALESCE(NULLIF(TRIM(genre), ''), subjects)
WHERE subjects IS NOT NULL AND TRIM(subjects) <> '';

COMMIT;
