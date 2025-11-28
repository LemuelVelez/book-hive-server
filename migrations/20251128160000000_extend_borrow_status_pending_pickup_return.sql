BEGIN;

-- Extend borrow_records.status to support more granular pending states.
-- Existing rows with status 'borrowed', 'pending', or 'returned' remain valid.

ALTER TABLE borrow_records
  DROP CONSTRAINT IF EXISTS borrow_records_status_check;

ALTER TABLE borrow_records
  ADD CONSTRAINT borrow_records_status_check
  CHECK (
    status IN (
      'borrowed',
      'pending',          -- legacy generic pending
      'pending_pickup',   -- student has reserved online but not yet picked up
      'pending_return',   -- student has requested return; awaiting librarian
      'returned'
    )
  );

COMMIT;
