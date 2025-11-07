BEGIN;

-- If some users were already marked verified via the boolean,
-- make sure they also get a timestamp for audit/history consistency.
UPDATE users
SET email_verified_at = NOW()
WHERE is_email_verified = TRUE
  AND email_verified_at IS NULL;

COMMIT;
