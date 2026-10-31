-- 218_call_logs_timestamp_id.sql
-- T5.1：nest 成本回填导出使用 (timestamp, id) 复合游标分页。
--
-- `call_logs.id` 是 UUID，单列 id 排序与时间顺序无关，跨页会漏行；
-- 复合游标需要 (timestamp, id) 索引避免全表扫描。
CREATE INDEX IF NOT EXISTS idx_call_logs_timestamp_id ON call_logs(timestamp, id);
