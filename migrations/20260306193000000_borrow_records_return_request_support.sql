BEGIN;

ALTER TABLE borrow_records
  ADD COLUMN IF NOT EXISTS return_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS return_requested_by INTEGER,
  ADD COLUMN IF NOT EXISTS return_request_note TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'borrow_records_return_requested_by_fkey'
      AND conrelid = 'borrow_records'::regclass
  ) THEN
    ALTER TABLE borrow_records
      ADD CONSTRAINT borrow_records_return_requested_by_fkey
      FOREIGN KEY (return_requested_by)
      REFERENCES users(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_borrow_records_status_return_requested_at
  ON borrow_records (status, return_requested_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_borrow_records_return_requested_by
  ON borrow_records (return_requested_by);

UPDATE borrow_records
SET
  return_requested_at = COALESCE(return_requested_at, updated_at, NOW()),
  return_request_note = COALESCE(
    NULLIF(BTRIM(return_request_note), ''),
    'Return requested before return-request metadata support was added.'
  )
WHERE status = 'pending_return';

COMMIT;