-- 216_nest_billing_outbox_backoff.sql
-- T2.1：outbox 回放的退避与分类重试。
--
-- - next_attempt_at：指数退避的下次重试时间；worker 每 30s 只捞到期的行
-- - last_status：最近一次 nest 的 HTTP 状态码
--   （401 → 暂停 worker；400·402 → dead；409·5xx → 退避重试）
--
-- 编号注意：上游合并可能占用更大的号；本次取 216（215 是 nest_billing 本体）。
-- SQLite 不支持 `ADD COLUMN IF NOT EXISTS`，幂等性由 migration runner 的
-- "已应用即跳过" 保证（见 migrationRunner 的 applied 记录）。

ALTER TABLE nest_billing_outbox ADD COLUMN next_attempt_at TEXT DEFAULT NULL;
ALTER TABLE nest_billing_outbox ADD COLUMN last_status INTEGER DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_nest_billing_outbox_next_attempt
  ON nest_billing_outbox(status, next_attempt_at);
