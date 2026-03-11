BEGIN;

ALTER TABLE fines
  ADD COLUMN IF NOT EXISTS official_receipt_number TEXT;

UPDATE fines
SET official_receipt_number = NULL
WHERE official_receipt_number IS NOT NULL
  AND BTRIM(official_receipt_number) = '';

CREATE UNIQUE INDEX IF NOT EXISTS uq_fines_official_receipt_number
  ON fines (LOWER(BTRIM(official_receipt_number)))
  WHERE official_receipt_number IS NOT NULL
    AND BTRIM(official_receipt_number) <> '';

COMMIT;