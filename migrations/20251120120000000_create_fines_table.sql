BEGIN;

CREATE TABLE IF NOT EXISTS fines (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  borrow_record_id BIGINT REFERENCES borrow_records(id) ON DELETE SET NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'pending_verification', 'paid', 'cancelled')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

-- Each borrow record can have at most one fine row (any status).
CREATE UNIQUE INDEX IF NOT EXISTS fines_borrow_record_unique
  ON fines (borrow_record_id)
  WHERE borrow_record_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fines_user
  ON fines (user_id);

CREATE INDEX IF NOT EXISTS idx_fines_status
  ON fines (status);

CREATE INDEX IF NOT EXISTS idx_fines_created_at
  ON fines (created_at DESC);

COMMIT;
