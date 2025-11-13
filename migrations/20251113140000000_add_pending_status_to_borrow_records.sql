BEGIN;

-- Extend borrow_records.status to allow "pending" in addition to "borrowed" and "returned".
-- The original CHECK was unnamed, but Postgres usually names it "borrow_records_status_check".
-- We drop it (if it exists) and re-create it with the new allowed values.

ALTER TABLE borrow_records
  DROP CONSTRAINT IF EXISTS borrow_records_status_check;

ALTER TABLE borrow_records
  ADD CONSTRAINT borrow_records_status_check
  CHECK (status IN ('borrowed', 'pending', 'returned'));

COMMIT;
