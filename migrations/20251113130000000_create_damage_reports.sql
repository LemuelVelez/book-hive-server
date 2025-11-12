BEGIN;

CREATE TABLE IF NOT EXISTS damage_reports (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  book_id BIGINT NOT NULL REFERENCES books(id) ON DELETE RESTRICT,
  damage_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('minor','moderate','major')),
  fee NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','assessed','paid')),
  notes TEXT,
  reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_damage_reports_user ON damage_reports (user_id);
CREATE INDEX IF NOT EXISTS idx_damage_reports_book ON damage_reports (book_id);
CREATE INDEX IF NOT EXISTS idx_damage_reports_status ON damage_reports (status);
CREATE INDEX IF NOT EXISTS idx_damage_reports_severity ON damage_reports (severity);
CREATE INDEX IF NOT EXISTS idx_damage_reports_reported_at ON damage_reports (reported_at DESC);

COMMIT;
