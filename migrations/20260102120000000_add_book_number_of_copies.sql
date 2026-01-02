BEGIN;

-- Add number_of_copies to support multiple physical copies per book title
ALTER TABLE books
  ADD COLUMN IF NOT EXISTS number_of_copies INTEGER;

-- Backfill default
UPDATE books
SET number_of_copies = COALESCE(number_of_copies, 1)
WHERE TRUE;

-- Default + not null
ALTER TABLE books
  ALTER COLUMN number_of_copies SET DEFAULT 1;

ALTER TABLE books
  ALTER COLUMN number_of_copies SET NOT NULL;

-- Positive constraint (drop+add = idempotent)
ALTER TABLE books
  DROP CONSTRAINT IF EXISTS books_number_of_copies_positive_check;

ALTER TABLE books
  ADD CONSTRAINT books_number_of_copies_positive_check
  CHECK (number_of_copies > 0);

COMMIT;
