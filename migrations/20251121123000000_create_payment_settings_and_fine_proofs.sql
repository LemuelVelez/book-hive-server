BEGIN;

-- Global library payment settings (single-row usage, but no hard constraint).
CREATE TABLE IF NOT EXISTS library_payment_settings (
  id BIGSERIAL PRIMARY KEY,
  e_wallet_phone TEXT,
  qr_code_url TEXT,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Optional helper index if you ever add more rows.
CREATE INDEX IF NOT EXISTS idx_library_payment_settings_created_at
  ON library_payment_settings (created_at DESC);

-- Proof images for fines (student payment screenshots, etc.).
CREATE TABLE IF NOT EXISTS fine_proofs (
  id BIGSERIAL PRIMARY KEY,
  fine_id BIGINT NOT NULL REFERENCES fines(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  uploaded_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'student_payment',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fine_proofs_fine
  ON fine_proofs (fine_id);

COMMIT;
