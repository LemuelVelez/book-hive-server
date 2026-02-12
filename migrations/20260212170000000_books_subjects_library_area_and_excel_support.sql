BEGIN;

-- Ensure new Subjects attribute exists
ALTER TABLE books
  ADD COLUMN IF NOT EXISTS subjects TEXT;

-- Backfill subjects from legacy fields if empty
UPDATE books
SET subjects = COALESCE(
  NULLIF(BTRIM(subjects), ''),
  NULLIF(BTRIM(genre), ''),
  NULLIF(BTRIM(category), '')
)
WHERE subjects IS NULL OR BTRIM(subjects) = '';

-- Keep legacy fields in sync for backward compatibility
UPDATE books
SET
  genre = COALESCE(NULLIF(BTRIM(genre), ''), subjects),
  category = COALESCE(NULLIF(BTRIM(category), ''), subjects)
WHERE subjects IS NOT NULL AND BTRIM(subjects) <> '';

-- Remove maritime from active library-area workflow by remapping existing records
-- (so UI options and existing rows stay consistent)
UPDATE books
SET library_area = 'general_circulation'
WHERE library_area = 'maritime';

-- Keep copyright populated for Excel export if missing
UPDATE books
SET copyright_year = publication_year
WHERE copyright_year IS NULL
  AND publication_year BETWEEN 1000 AND 9999;

COMMIT;
