-- 217_call_logs_nest_cost.sql
-- T5.1：把边缘结算的“上游成本（USD）”持久化到 call_logs，供 nest 成本回填读取。
--
-- 背景：cost 目前只在响应时计算并放在响应头/SSE 注释里，call_logs 只有 tokens；
-- Phase 5 需要按 correlationId 回填 ai_gateway_log.cost_amount，必须先落库。
--
-- SQLite 不支持 `ADD COLUMN IF NOT EXISTS`；幂等由 migration runner 的 applied 记录保证。

ALTER TABLE call_logs ADD COLUMN nest_cost_usd REAL DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_call_logs_correlation_id ON call_logs(correlation_id);
