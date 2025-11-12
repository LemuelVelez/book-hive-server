BEGIN;

CREATE TABLE IF NOT EXISTS feedbacks (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  book_id BIGINT NOT NULL REFERENCES books(id) ON DELETE RESTRICT,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedbacks_user ON feedbacks (user_id);
CREATE INDEX IF NOT EXISTS idx_feedbacks_book ON feedbacks (book_id);
CREATE INDEX IF NOT EXISTS idx_feedbacks_rating ON feedbacks (rating);
CREATE INDEX IF NOT EXISTS idx_feedbacks_created_at ON feedbacks (created_at DESC);

COMMIT;
