BEGIN;

-- Add approval columns (idempotent)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_approved BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by BIGINT REFERENCES users(id) ON DELETE SET NULL;

-- Backfill: existing users are considered approved (restriction is for NEW registrations)
UPDATE users
SET
  is_approved = TRUE,
  approved_at = COALESCE(approved_at, created_at)
WHERE is_approved = FALSE;

-- Helpful index for filtering pending accounts
CREATE INDEX IF NOT EXISTS idx_users_is_approved_created_at
ON users (is_approved, created_at DESC);

COMMIT;
