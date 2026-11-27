# Next Task — Controlled Staging Cutover, Live Gemini Validation & First Pilot Onboarding

## Completed Through Task 017
- **Task 017 Production-Safe Monthly Usage Quotas & AI Token Usage Tracking:** Implemented `server/usagePolicy.ts` (unvalidated `starter`/`professional`/`business` limits + non-blocking `legacy` existing-org fallback), additive `0002_usage_quotas_and_tokens.sql` + rollback + CI lifecycle, two-phase transactional `ai_extraction_reservations` (`FOR UPDATE` + `Idempotency-Key` + `maintenance.ts` expiry sweep), immediate storage reclaim on quotation/document deletion, Gemini `usageMetadata` telemetry (`ai_token_usage_logs` recording `usageAvailable: false` when absent), `GET /api/organization/usage`, and `tests/usageQuotas.test.ts` (`54` offline tests pass, `0` fail, `14` skipped; `DEMO_MODE` isolated).
- **Task 014 Customer & Commercial Readiness Assessment + Onboarding UX:** Audited buyer fit, pricing hypotheses (Starter `₹2,999/mo`, Professional `₹7,999/mo`, Business `₹18,999/mo`), sales/demo script, and non-mutating staging readiness across all 10 prerequisites. Implemented onboarding empty states across `DashboardView`, `RfqsListView`, `SuppliersView`, `ItemsView`, `ReportsView`, and `RfqCreateModal`, plus a 5-minute synthetic Demo Walkthrough strip (`DashboardView`) and SSR regression tests (`tests/stabilizationUnit.test.ts`).
- **Task 013.3A/B Runtime & Remote CI Sync (`97755076de5e574788731d025565d30cde88e37f`, Run `#12` `45954730291`):** Verified `83 / 83` workspace parity including `bun.lock` (`06ba920b`, zero `xlsx`) and passing `verify` + `browser-e2e` CI jobs (`conclusion: "success"`).

## Highest-Priority Next Sequence (Staging Cutover -> First Pilot Customer)

1. **Provision Staging Backing Services & Validate Live Runtime (`RUN_LIVE_GEMINI_TESTS=true` + `/api/health/ready`):**
   - Provision private S3/R2 bucket (`STORAGE_PROVIDER=s3`, `S3_*`), verified Resend domain (`RESEND_API_KEY`, `EMAIL_FROM`), `SESSION_SECRET`, `APP_URL`, `ALLOWED_ORIGINS`, `ERROR_WEBHOOK_URL`, and Firebase Authorized Domains on staging (`NODE_ENV=production`, `DEMO_MODE` unset, `CSP_MODE=report-only`).
   - Run `RUN_LIVE_GEMINI_TESTS=true` against staging `GEMINI_API_KEY`, observe real Gemini `usageMetadata` tokens in `ai_token_usage_logs` (before estimating any per-quote token cost), verify `GET /api/health/ready` returns `200` (`database.ok: true`, `storage.ok: true`, `email.mode: "resend"`), and verify `GET /api/organization/usage`, then switch `CSP_MODE=enforce`.
2. **Execute Cloud SQL Backup, Preflight & `0001` + `0002` Migration Window:**
   - Enable daily backups + 7-day PITR, take on-demand Cloud SQL snapshot (`gcloud sql backups create`), run `drizzle/0001_tenant_integrity_preflight.sql` (confirming `0` cross-org rows), apply `drizzle/0001_tenant_integrity.sql` (`BEGIN;...COMMIT;`), and apply `drizzle/0002_usage_quotas_and_tokens.sql` (`BEGIN;...COMMIT;`, keeping existing organizations on non-blocking `'legacy'`).
   - Run `npm run org:bootstrap-owner -- --org-id=org-kalyani-hydraulics --issue-token --email="<founder-email>" --ttl-hours=72` if claiming the migrated organization.
3. **Onboard First 1–3 Design-Partner Manufacturing Pilots (Assisted 14-Day Trial):**
   - Walk pilot Purchase Manager + MD/Approver through 1 live RFQ (3–5 supplier PDF/XLSX quotes), validate Gemini extraction accuracy + landed-cost reconciliation, and validate/adjust Starter/Pro/Business pricing and quota caps before adding self-serve billing.
4. **Optional Auth Hardening Sprint (Recommended Before Broad Public Self-Serve GA):**
   - Gate high-cost AI extraction and org invitations on `emailVerified === true` and add per-account login backoff alongside IP rate limits.
