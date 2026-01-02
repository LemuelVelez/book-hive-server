BEGIN;

-- Track self-service borrow-day extensions on borrow records
ALTER TABLE borrow_records
  ADD COLUMN IF NOT EXISTS extension_count INTEGER,
  ADD COLUMN IF NOT EXISTS extension_total_days INTEGER,
  ADD COLUMN IF NOT EXISTS last_extension_days INTEGER,
  ADD COLUMN IF NOT EXISTS last_extended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_extension_reason TEXT;

-- Backfill defaults
UPDATE borrow_records
SET extension_count = COALESCE(extension_count, 0),
    extension_total_days = COALESCE(extension_total_days, 0)
WHERE TRUE;

-- Defaults + not null
ALTER TABLE borrow_records
  ALTER COLUMN extension_count SET DEFAULT 0;

ALTER TABLE borrow_records
  ALTER COLUMN extension_count SET NOT NULL;

ALTER TABLE borrow_records
  ALTER COLUMN extension_total_days SET DEFAULT 0;

ALTER TABLE borrow_records
  ALTER COLUMN extension_total_days SET NOT NULL;

-- Constraints (drop+add = idempotent)
ALTER TABLE borrow_records
  DROP CONSTRAINT IF EXISTS borrow_records_extension_count_nonnegative_check;

ALTER TABLE borrow_records
  ADD CONSTRAINT borrow_records_extension_count_nonnegative_check
  CHECK (extension_count >= 0);

ALTER TABLE borrow_records
  DROP CONSTRAINT IF EXISTS borrow_records_extension_total_days_nonnegative_check;

ALTER TABLE borrow_records
  ADD CONSTRAINT borrow_records_extension_total_days_nonnegative_check
  CHECK (extension_total_days >= 0);

ALTER TABLE borrow_records
  DROP CONSTRAINT IF EXISTS borrow_records_last_extension_days_positive_check;

ALTER TABLE borrow_records
  ADD CONSTRAINT borrow_records_last_extension_days_positive_check
  CHECK (last_extension_days IS NULL OR last_extension_days > 0);

-- Helpful index
CREATE INDEX IF NOT EXISTS idx_borrow_records_last_extended_at
  ON borrow_records(last_extended_at);

COMMIT;
