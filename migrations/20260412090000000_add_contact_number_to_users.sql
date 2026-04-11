BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS contact_number VARCHAR(32);

UPDATE users
SET contact_number = NULL
WHERE contact_number IS NOT NULL
  AND btrim(contact_number) = '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_contact_number_format_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_contact_number_format_check
      CHECK (
        contact_number IS NULL
        OR contact_number ~ '^[0-9()+\-.[:space:]]{7,20}$'
      );
  END IF;
END $$;

COMMIT;
