BEGIN;

CREATE TABLE IF NOT EXISTS borrow_records (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  book_id BIGINT NOT NULL REFERENCES books(id) ON DELETE RESTRICT,
  borrow_date DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE NOT NULL,
  return_date DATE,
  status TEXT NOT NULL DEFAULT 'borrowed' CHECK (status IN ('borrowed','returned')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_borrow_records_user ON borrow_records (user_id);
CREATE INDEX IF NOT EXISTS idx_borrow_records_book ON borrow_records (book_id);
CREATE INDEX IF NOT EXISTS idx_borrow_records_status ON borrow_records (status);
CREATE INDEX IF NOT EXISTS idx_borrow_records_borrow_date ON borrow_records (borrow_date);
CREATE INDEX IF NOT EXISTS idx_borrow_records_due_date ON borrow_records (due_date);

COMMIT;
