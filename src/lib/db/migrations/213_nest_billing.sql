-- 213_nest_billing.sql
-- Durable postflight replay queue (blueprint D2/F5). Nest remains the only
-- ledger; this table only holds settle payloads that could not be delivered.

CREATE TABLE IF NOT EXISTS nest_billing_outbox (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  ticket TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_nest_billing_outbox_status
  ON nest_billing_outbox(status, created_at);
