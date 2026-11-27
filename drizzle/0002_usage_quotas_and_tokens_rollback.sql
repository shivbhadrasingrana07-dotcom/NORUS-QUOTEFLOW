-- NORUS QUOTEFLOW Task 017 — Rollback for 0002_usage_quotas_and_tokens.sql

BEGIN;

DROP INDEX IF EXISTS ai_token_usage_org_created_idx;
DROP TABLE IF EXISTS ai_token_usage_logs;

DROP INDEX IF EXISTS ai_reservations_org_idemp_uidx;
DROP INDEX IF EXISTS ai_reservations_org_status_exp_idx;
DROP TABLE IF EXISTS ai_extraction_reservations;

DROP INDEX IF EXISTS org_monthly_usage_org_period_uidx;
DROP TABLE IF EXISTS organization_monthly_usage;

ALTER TABLE organizations DROP COLUMN IF EXISTS storage_limit_bytes_override;
ALTER TABLE organizations DROP COLUMN IF EXISTS monthly_extraction_limit_override;
ALTER TABLE organizations DROP COLUMN IF EXISTS plan_tier;

COMMIT;
