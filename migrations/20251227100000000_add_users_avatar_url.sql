BEGIN;

-- Add optional user avatar URL (S3/CloudFront/public URL or any valid URL).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_url TEXT;

COMMIT;
