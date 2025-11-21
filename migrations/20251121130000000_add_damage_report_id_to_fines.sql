BEGIN;

-- Add a nullable foreign key to damage_reports.
ALTER TABLE fines
  ADD COLUMN IF NOT EXISTS damage_report_id BIGINT REFERENCES damage_reports(id) ON DELETE SET NULL;

-- Backfill: infer damage_report_id from the "Damage report #<id>: ..." prefix in `reason` when possible.
-- This matches the prefix used in src/routes/damageReports.ts (syncFineForDamageReport).
UPDATE fines f
SET damage_report_id = dr.id
FROM damage_reports dr
WHERE f.borrow_record_id IS NULL
  AND f.damage_report_id IS NULL
  AND f.reason LIKE 'Damage report #%'
  AND dr.id = CAST(substring(f.reason FROM 'Damage report #([0-9]+):') AS BIGINT);

-- Optional index to speed lookups by damage_report_id.
CREATE INDEX IF NOT EXISTS idx_fines_damage_report
  ON fines (damage_report_id);

COMMIT;
