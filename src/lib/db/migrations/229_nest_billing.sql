-- 229_nest_billing.sql
-- Durable postflight replay queue (blueprint D2/F5). Nest remains the only
-- ledger; this table only holds settle payloads that could not be delivered.
--
-- Renumbered 213 → 214 → 215 → 229: upstream claimed 213/214, then v3.8.54
-- claimed 215 (team_cost_centers) through 228. Local nest migrations now live
-- at 229-232. DBs that applied an older nest_billing already have the table:
-- isSchemaAlreadyApplied() short-circuits this migration, and
-- RENAMED_MIGRATION_COMPATIBILITY rewrites old ledger rows to the new slots.

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
