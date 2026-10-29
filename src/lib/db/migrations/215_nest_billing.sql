-- 215_nest_billing.sql
-- Durable postflight replay queue (blueprint D2/F5). Nest remains the only
-- ledger; this table only holds settle payloads that could not be delivered.
--
-- Renumbered 213 → 214 → 215: upstream claimed 213 (api_key_preferred_connections),
-- then 214 (call_logs_client_session_id). DBs that applied an older nest_billing
-- already have the table: isSchemaAlreadyApplied() short-circuits this migration.

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
