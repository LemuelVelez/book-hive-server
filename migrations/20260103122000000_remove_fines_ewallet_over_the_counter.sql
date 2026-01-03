BEGIN;

-- Over-the-counter only:
-- 1) Remove e-wallet related tables
-- 2) Remove proof uploads table
-- 3) Remove 'pending_verification' fine status usage by normalizing existing data
-- 4) Tighten fines.status constraint to: active | paid | cancelled

-- Normalize existing rows so constraint updates won't fail
UPDATE fines
SET status = 'active',
    updated_at = NOW()
WHERE status = 'pending_verification';

-- Drop tables used for e-wallet config and screenshot proofs
DROP TABLE IF EXISTS fine_proofs CASCADE;
DROP TABLE IF EXISTS library_payment_settings CASCADE;

-- Drop any existing CHECK constraints that mention "status" on fines
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'fines'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE fines DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;
END $$;

-- Add the new allowed set for fines.status
ALTER TABLE fines
  ADD CONSTRAINT fines_status_check
  CHECK (status IN ('active', 'paid', 'cancelled'));

COMMIT;
