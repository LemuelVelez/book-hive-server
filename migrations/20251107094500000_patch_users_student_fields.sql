BEGIN;

-- Add the columns your code expects (idempotent).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS full_name TEXT,
  ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'student',
  ADD COLUMN IF NOT EXISTS student_id TEXT,
  ADD COLUMN IF NOT EXISTS course TEXT,
  ADD COLUMN IF NOT EXISTS year_level TEXT,
  ADD COLUMN IF NOT EXISTS is_email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- If you previously used email_verified_at, backfill the boolean.
UPDATE users
SET is_email_verified = TRUE
WHERE is_email_verified = FALSE
  AND email_verified_at IS NOT NULL;

-- Make student_id unique when present (multiple NULLs allowed).
CREATE UNIQUE INDEX IF NOT EXISTS users_student_id_unique
ON users (student_id)
WHERE student_id IS NOT NULL;

-- Email verification tokens: add the 'used' flag your code reads.
ALTER TABLE email_verifications
  ADD COLUMN IF NOT EXISTS used BOOLEAN NOT NULL DEFAULT FALSE;

-- Helpful index for verify lookups.
CREATE INDEX IF NOT EXISTS idx_email_verifications_used
ON email_verifications (user_id, used);

COMMIT;
