-- NORUS QUOTEFLOW Task 017 — Additive Usage Quotas, Extraction Reservations & AI Token Telemetry
-- Safe & backward-compatible for existing organizations (plan_tier defaults to 'legacy').
-- Applied explicitly via psql / CI workflow (outside drizzle-kit's automatic _journal.json).

BEGIN;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS plan_tier text NOT NULL DEFAULT 'legacy';

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS monthly_extraction_limit_override integer;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS storage_limit_bytes_override bigint;

CREATE TABLE IF NOT EXISTS organization_monthly_usage (
  id text PRIMARY KEY NOT NULL,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_month text NOT NULL,
  committed_extractions integer NOT NULL DEFAULT 0,
  total_prompt_tokens bigint NOT NULL DEFAULT 0,
  total_candidates_tokens bigint NOT NULL DEFAULT 0,
  total_tokens bigint NOT NULL DEFAULT 0,
  unavailable_events_count integer NOT NULL DEFAULT 0,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS org_monthly_usage_org_period_uidx
  ON organization_monthly_usage (organization_id, period_month);

CREATE TABLE IF NOT EXISTS ai_extraction_reservations (
  id text PRIMARY KEY NOT NULL,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_month text NOT NULL,
  rfq_id text NOT NULL,
  supplier_id text NOT NULL,
  idempotency_key text,
  reserved_bytes bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'reserved',
  quotation_id text,
  document_id text,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  finalized_at timestamp with time zone
);

CREATE INDEX IF NOT EXISTS ai_reservations_org_status_exp_idx
  ON ai_extraction_reservations (organization_id, status, expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS ai_reservations_org_idemp_uidx
  ON ai_extraction_reservations (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND status IN ('reserved', 'committed');

CREATE TABLE IF NOT EXISTS ai_token_usage_logs (
  id text PRIMARY KEY NOT NULL,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id text,
  quotation_id text,
  reservation_id text,
  model text NOT NULL,
  outcome text NOT NULL,
  usage_available boolean NOT NULL DEFAULT false,
  prompt_token_count integer,
  candidates_token_count integer,
  total_token_count integer,
  thoughts_token_count integer,
  created_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS ai_token_usage_org_created_idx
  ON ai_token_usage_logs (organization_id, created_at);

COMMIT;
