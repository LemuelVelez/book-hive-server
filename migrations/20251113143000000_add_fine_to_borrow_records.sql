BEGIN;

-- Add a fine column to borrow_records to store overdue charges.
-- This is idempotent, so it won't fail if run multiple times.
ALTER TABLE borrow_records
  ADD COLUMN IF NOT EXISTS fine NUMERIC(12,2) NOT NULL DEFAULT 0;

COMMIT;
