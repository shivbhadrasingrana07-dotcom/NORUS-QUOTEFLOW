# Next Task — CI Execution, Cloud SQL Migration Window & Commercial Pilot Rollout

## Completed Through Task 009
- **Supply-Chain & Isolated Spreadsheet Hardening:** Replaced `xlsx` CSV/TSV parsing with native RFC-4180 `parseDelimitedTextToRows`; added ZIP container pre-scan (ZIP64, ZIP bomb `422`, path traversal, `vbaProject.bin` `415`); isolated `.xlsx`/`.xls` parsing inside ephemeral `128 MB` / `5s` secret-stripped `server/spreadsheetWorker.mjs` subprocesses with strict sheet/row/col/cell ceilings; upgraded `esbuild` to `^0.28.2` and regenerated `package-lock.json` (`npm ci` clean without `--legacy-peer-deps`).
- **Precision & Multi-Supplier Split Allocations:** Tightened award allocation tolerance to `1e-6` (`getAllocationTolerance`) with Kahan `sumExactQuantities`, `1e-9` quantity normalization preserving sub-`1e-6` precision, and full validation/UI support for multi-supplier split allocations on one RFQ line item.
- **PostgreSQL Deadlock-Free Hierarchical Locking:** Enforced strict `rfqs -> quotations -> awards` `FOR UPDATE` locking across `submitAward`, `withdrawAward`, `decideAward`, quotation edits, verification, and deletion (`server/pgStore.ts`), plus concurrent PG test coverage in `tests/apiAndDb.test.ts`.
- **CI Pipeline & Browser E2E Script:** Updated `.github/workflows/ci.yml` to run strict `npm ci`, full `0000` -> `0001` preflight/apply/rollback/re-apply SQL verification against PostgreSQL 16, and an isolated `browser-e2e` headless Chromium job executing `tests/browserE2E.mjs` against `DEMO_MODE=true`.

## Remaining Actions Before Public Launch

0. **Run CI / Local PostgreSQL 15+ & Headless Chromium E2E Verification (Immediate Next Step):**
   - Trigger `.github/workflows/ci.yml` (or run locally with PostgreSQL 15+ and Playwright Chromium) to execute:
     1. Full `psql` migration lifecycle (`0000_illegal_major_mapleleaf.sql`, `0001_tenant_integrity_preflight.sql`, `0001_tenant_integrity.sql`, `0001_tenant_integrity_rollback.sql`, and re-apply `0001_tenant_integrity.sql`).
     2. All `12` PostgreSQL integration & Task 009 concurrency tests (`npm test` with `TEST_SQL_*` / `TEST_DATABASE_URL`), plus optional `RUN_LIVE_GEMINI_TESTS=true`.
     3. Isolated `node tests/browserE2E.mjs` Playwright headless Chromium E2E pass under `DEMO_MODE=true`.
1. **Monitor Upstream Dependency Advisories (`npm audit`):**
   - Upstream `xlsx@0.18.5` (no upstream fix published — contained on server by worker isolation, evaluate `exceljs` replacement when scheduling client exporter replacement), `@grpc/grpc-js` (`firebase` SDK chain), and `drizzle-kit` nested `esbuild@0.25.12` remain in `npm audit`.
2. **Exit Demo Mode & Restore Full Authentication:**
   - In `NODE_ENV=production`, demo mode is **OFF by default** (and setting `DEMO_MODE=true` fails closed on boot). Set `DEMO_MODE="false"` in non-production environments to disable `/api/demo-workspace*` (`410 Gone`) and activate `AuthView` and `OrganizationView`.
3. **Apply Tenant Integrity Migration to Cloud SQL (Maintenance Window):**
   - Take a Cloud SQL on-demand backup, run `psql -v ON_ERROR_STOP=1 -f drizzle/0001_tenant_integrity_preflight.sql`, apply `drizzle/0001_tenant_integrity.sql` (`BEGIN;...COMMIT;`, PostgreSQL 15+), and keep `0001_tenant_integrity_rollback.sql` ready.
4. **Link Founder Account & Provision Production Runtime Secrets:**
   - Run `npm run org:bootstrap-owner -- --org-id=org-kalyani-hydraulics --issue-token --email="<founder-email>"` (or `--claim-direct`).
   - Configure `SESSION_SECRET` (>= 32 random chars), live `GEMINI_API_KEY`, `RESEND_API_KEY` + verified `EMAIL_FROM` (`SPF`/`DKIM`), `STORAGE_PROVIDER=s3` credentials, `SQL_SSL_CA` (if using TCP TLS), `APP_URL`, `ALLOWED_ORIGINS`, Firebase Authorized Domains, Cloud SQL PITR + Enterprise tier backups, and `CSP_MODE=enforce`.
