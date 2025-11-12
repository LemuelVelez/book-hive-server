BEGIN;

-- Add a photo URL to link the uploaded picture proof.
ALTER TABLE damage_reports
  ADD COLUMN IF NOT EXISTS photo_url TEXT;

-- Optional helpful index if you plan to filter for reports that have photos.
-- CREATE INDEX IF NOT EXISTS idx_damage_reports_has_photo ON damage_reports ((photo_url IS NOT NULL));

COMMIT;
