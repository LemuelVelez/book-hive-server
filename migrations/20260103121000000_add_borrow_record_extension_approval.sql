BEGIN;

-- Track approval workflow for borrow-day extension requests
ALTER TABLE borrow_records
  ADD COLUMN IF NOT EXISTS extension_request_status TEXT,
  ADD COLUMN IF NOT EXISTS extension_requested_days INTEGER,
  ADD COLUMN IF NOT EXISTS extension_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS extension_requested_reason TEXT,
  ADD COLUMN IF NOT EXISTS extension_decided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS extension_decided_by INTEGER,
  ADD COLUMN IF NOT EXISTS extension_decision_note TEXT;

-- Backfill defaults
UPDATE borrow_records
SET extension_request_status = COALESCE(extension_request_status, 'none')
WHERE TRUE;

-- Defaults + not null
ALTER TABLE borrow_records
  ALTER COLUMN extension_request_status SET DEFAULT 'none';

ALTER TABLE borrow_records
  ALTER COLUMN extension_request_status SET NOT NULL;

-- Constraints (drop+add = idempotent)
ALTER TABLE borrow_records
  DROP CONSTRAINT IF EXISTS borrow_records_extension_request_status_check;

ALTER TABLE borrow_records
  ADD CONSTRAINT borrow_records_extension_request_status_check
  CHECK (extension_request_status IN ('none', 'pending', 'approved', 'disapproved'));

ALTER TABLE borrow_records
  DROP CONSTRAINT IF EXISTS borrow_records_extension_requested_days_positive_check;

ALTER TABLE borrow_records
  ADD CONSTRAINT borrow_records_extension_requested_days_positive_check
  CHECK (extension_requested_days IS NULL OR extension_requested_days > 0);

ALTER TABLE borrow_records
  DROP CONSTRAINT IF EXISTS borrow_records_extension_request_pending_requires_days_check;

ALTER TABLE borrow_records
  ADD CONSTRAINT borrow_records_extension_request_pending_requires_days_check
  CHECK (
    extension_request_status <> 'pending'
    OR (extension_requested_days IS NOT NULL AND extension_requested_days > 0)
  );

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_borrow_records_extension_request_status
  ON borrow_records(extension_request_status);

CREATE INDEX IF NOT EXISTS idx_borrow_records_extension_requested_at
  ON borrow_records(extension_requested_at);

COMMIT;
