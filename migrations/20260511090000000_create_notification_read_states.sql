BEGIN;

CREATE TABLE IF NOT EXISTS notification_read_states (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_key VARCHAR(100) NOT NULL,
  read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, notification_key)
);

CREATE INDEX IF NOT EXISTS notification_read_states_user_id_idx
  ON notification_read_states(user_id);

CREATE INDEX IF NOT EXISTS notification_read_states_notification_key_idx
  ON notification_read_states(notification_key);

CREATE OR REPLACE FUNCTION set_notification_read_states_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notification_read_states_set_updated_at
  ON notification_read_states;

CREATE TRIGGER notification_read_states_set_updated_at
BEFORE UPDATE ON notification_read_states
FOR EACH ROW
EXECUTE FUNCTION set_notification_read_states_updated_at();

COMMIT;