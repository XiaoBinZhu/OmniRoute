-- 218_call_logs_timestamp_id.sql
-- T5.1：nest 成本回填导出的 since 过滤与时间排序索引。
--
-- 导出游标已改为单调 `rowid`（timestamp 可被调用方指定、id 是 UUID，均不能保证写入顺序），
-- 本索引仍用于 `WHERE timestamp >= since` 的范围过滤与按时段审计查询。
CREATE INDEX IF NOT EXISTS idx_call_logs_timestamp_id ON call_logs(timestamp, id);
