BEGIN;

-- 1) Add liable_user_id to active damage reports
ALTER TABLE damage_reports
  ADD COLUMN IF NOT EXISTS liable_user_id INTEGER NULL;

-- Add FK for liable_user_id (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'damage_reports_liable_user_id_fkey'
  ) THEN
    ALTER TABLE damage_reports
      ADD CONSTRAINT damage_reports_liable_user_id_fkey
      FOREIGN KEY (liable_user_id)
      REFERENCES users(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- 2) Create paid/archive table as a separate record store
--    Copy structure of damage_reports to keep compatibility with dr.* inserts
CREATE TABLE IF NOT EXISTS damage_reports_paid
  (LIKE damage_reports INCLUDING ALL);

-- Ensure liable_user_id exists in archive table too (if it pre-existed before this migration)
ALTER TABLE damage_reports_paid
  ADD COLUMN IF NOT EXISTS liable_user_id INTEGER NULL;

-- Add paid_at marker
ALTER TABLE damage_reports_paid
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Add FK for archive table (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'damage_reports_paid_liable_user_id_fkey'
  ) THEN
    ALTER TABLE damage_reports_paid
      ADD CONSTRAINT damage_reports_paid_liable_user_id_fkey
      FOREIGN KEY (liable_user_id)
      REFERENCES users(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- 3) SAFETY: If fines.damage_report_id has an FK to damage_reports, moving rows would break it.
--    Drop any FK constraints on fines that reference damage_reports via damage_report_id.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'fines'
      AND c.contype = 'f'
      AND pg_get_constraintdef(c.oid) ILIKE '%damage_report_id%'
      AND pg_get_constraintdef(c.oid) ILIKE '%REFERENCES damage_reports%'
  LOOP
    EXECUTE format('ALTER TABLE fines DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;
END $$;

COMMIT;
