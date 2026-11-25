# Next Task — CI Execution, Cloud SQL Migration Window & Commercial Pilot Rollout

## Completed Through Task 010
- **Independent Audit & Supply-Chain/Spreadsheet Closure (`server/spreadsheetWorker.mjs`, `tests/extractionValidation.test.ts`):** Closed ZIP container pre-scan edge cases (encrypted bit flag `0x0001`, unsupported compression methods, LFH-vs-CD filename/size mismatches, overlapping payload byte spans, `0`-compressed-byte deflate spoof, and Windows backslash/NUL/drive-prefix traversal); added delimiter detection (`\t` for `.tsv`/text `.xls`) and a `65,536`-character raw cell cap to the native RFC-4180 delimited parser. Verified `npm ci --dry-run` cleanly without `--legacy-peer-deps` and documented `npm audit --json` reachability in [Project Status](PROJECT_STATUS.md#remaining-risk-register).
- **Monetary Split-Award Precision & Parent-First Extraction Lock (`src/lib/awardValidation.ts`, `src/components/ComparisonMatrixPane.tsx`, `server/pgStore.ts`):** Applied Kahan `sumExactQuantities` to split-award monetary landed totals (`validateAwardSubmission` & `ComparisonMatrixPane.tsx`) and added `.for('update')` parent `rfqs` locking to `saveExtractedQuotation` in `server/pgStore.ts` so extraction serializes cleanly under the strict `rfqs -> quotations -> awards` lock hierarchy.
- **CI Workflow Hardening (`.github/workflows/ci.yml`):** Added top-level `permissions: contents: read` and fail-fast server PID + `--max-time 5` readiness checks in the `browser-e2e` job.

## Remaining Actions Before Public Launch

0. **Run CI / Local PostgreSQL 15+ & Headless Chromium E2E Verification (Immediate Next Step):**
   - Trigger `.github/workflows/ci.yml` (or run locally with PostgreSQL 15+ and Playwright Chromium) to execute:
     1. Full `psql` migration lifecycle (`0000_illegal_major_mapleleaf.sql`, `0001_tenant_integrity_preflight.sql`, `0001_tenant_integrity.sql`, `0001_tenant_integrity_rollback.sql`, and re-apply `0001_tenant_integrity.sql`).
     2. All `12` PostgreSQL integration & Task 009 concurrency tests (`npm test` with `TEST_SQL_*` / `TEST_DATABASE_URL`), plus optional `RUN_LIVE_GEMINI_TESTS=true`.
     3. Isolated `node tests/browserE2E.mjs` Playwright headless Chromium E2E pass under `DEMO_MODE=true`.
1. **Schedule `xlsx@0.18.5` Replacement & Track Upstream Advisories (`npm audit`):**
   - Replace `xlsx@0.18.5` with a maintained spreadsheet parser/writer (e.g., `exceljs`) when scheduling the dependency upgrade milestone; track non-breaking `firebase` / `drizzle-kit` updates and Node 24 alignment.
2. **Exit Demo Mode & Restore Full Authentication:**
   - In `NODE_ENV=production`, demo mode is **OFF by default** (and setting `DEMO_MODE=true` fails closed on boot). Set `DEMO_MODE="false"` in non-production environments to disable `/api/demo-workspace*` (`410 Gone`) and activate `AuthView` and `OrganizationView`.
3. **Apply Tenant Integrity Migration to Cloud SQL (Maintenance Window):**
   - Take a Cloud SQL on-demand backup, run `psql -v ON_ERROR_STOP=1 -f drizzle/0001_tenant_integrity_preflight.sql`, apply `drizzle/0001_tenant_integrity.sql` (`BEGIN;...COMMIT;`, PostgreSQL 15+), and keep `0001_tenant_integrity_rollback.sql` ready.
4. **Link Founder Account & Provision Production Runtime Secrets:**
   - Run `npm run org:bootstrap-owner -- --org-id=org-kalyani-hydraulics --issue-token --email="<founder-email>"` (or `--claim-direct`).
   - Configure `SESSION_SECRET` (>= 32 random chars), live `GEMINI_API_KEY`, `RESEND_API_KEY` + verified `EMAIL_FROM` (`SPF`/`DKIM`), `STORAGE_PROVIDER=s3` credentials, `SQL_SSL_CA` (if using TCP TLS), `APP_URL`, `ALLOWED_ORIGINS`, Firebase Authorized Domains, Cloud SQL PITR + Enterprise tier backups, and `CSP_MODE=enforce`.
