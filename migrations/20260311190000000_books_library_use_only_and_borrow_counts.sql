BEGIN;

ALTER TABLE books
  ADD COLUMN IF NOT EXISTS is_library_use_only BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE books
SET is_library_use_only = TRUE
WHERE COALESCE(is_library_use_only, FALSE) = FALSE
  AND library_area IN (
    'fil_gen_reference',
    'general_reference',
    'special_collection',
    'periodicals',
    'thesis_dissertations',
    'rizaliana'
  );

COMMIT;