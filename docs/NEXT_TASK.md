# Next Task — `xlsx` Removal Decision, Cloud SQL Migration Window & Commercial Pilot Rollout

## Completed Through Task 011
- **CI Verification of Task 010.1 (`NORUS-QUOTEFLOW` Run `#45562869618` on `87a93ae69093e8e775bb59b096f75b31ed5b2351`):** Verified via GitHub REST API that both `verify` (Node 22 `npm ci`, PG `0000`/`0001` preflight/apply/rollback/re-apply, `lint`, `test`, `build`) and `browser-e2e` (Playwright Chromium install + `DEMO_MODE=true` `tests/browserE2E.mjs`) completed with **`conclusion: "success"`**. Raw CI job log zip download remains `HTTP 403` unauthenticated (`BLOCKED` for console line inspection).
- **`xlsx@0.18.5` Security Audit & OLE2 Defense-in-Depth (`server/spreadsheetWorker.mjs`, `tests/extractionValidation.test.ts`, `docs/SECURITY.md`):** Evaluated `read-excel-file@9.3.20` + `write-excel-file@4.1.1` and `exceljs@4.4.0`; confirmed neither supports legacy binary OLE2 `.xls` (BIFF5/BIFF8) workbooks. Kept `xlsx@0.18.5` quarantined inside `spreadsheetWorker.mjs` rather than silently dropping `.xls`, and hardened `spreadsheetWorker.mjs` with `inspectOle2Container()` (CFBF header check + UTF-16LE `_VBA_PROJECT_CUR`/`_VBA_PROJECT` macro rejection `415`), prototype-safe `Object.hasOwn()` lookups, and pure-JS `decodeCellAddress()`.
- **Supply-Chain & Runtime Security Audit (`package-lock.json`, `server.ts`, `server/security.ts`, `server/rbac.ts`, `server/pgStore.ts`):** Verified clean isolated `npm ci` (`exit 0`, `13` non-fatal `@firebase/*` Node 24 `EBADENGINE` warnings on `v22.23.5`), confirmed Firestore/`@grpc/grpc-js` is unused (`src/lib/firebase.ts` imports `firebase/app` + `firebase/auth` only), and confirmed `drizzle-kit`'s nested `esbuild@0.18.20` is CLI-only while root Vite uses `esbuild@0.28.2`.

## Remaining Actions Before Public Launch

0. **Product Decision & Implementation to Remove `xlsx@0.18.5`:**
   - Choose either:
     1. **Deprecate binary OLE2 `.xls` uploads (`415`)** asking suppliers for `.xlsx` or `.csv` (while preserving native UTF-8 text-table `.xls` via `parseDelimitedTextToRows`), OR
     2. **Add an isolated native/WASM `.xls`-to-`.xlsx` converter** prior to OOXML parsing.
   - Then migrate `server/spreadsheetWorker.mjs` `.xlsx` parsing to `read-excel-file@9.3.20` (`read-excel-file/node`), migrate `src/lib/exporters.ts` and `server/demoWorkspace.ts` exports to `write-excel-file@4.1.1` (with `{ type: 'Formula', value }` formulas), and uninstall `xlsx@0.18.5`.
1. **Archive Authenticated CI Logs & Re-Verify Post-Task-011 Commit:**
   - Trigger/inspect authenticated `.github/workflows/ci.yml` logs after pushing Task 011 so exact PG test counts (`12` PG integration/concurrency tests + `47` unit/demo tests) and `browser-e2e` console output are recorded from raw CI logs (`HTTP 403` prevents unauthenticated log download).
   - Optionally run `RUN_LIVE_GEMINI_TESTS=true GEMINI_API_KEY="..." npm test` in staging.
2. **Exit Demo Mode & Restore Full Authentication:**
   - In `NODE_ENV=production`, demo mode is **OFF by default** (and setting `DEMO_MODE=true` fails closed on boot). Set `DEMO_MODE="false"` in non-production environments to disable `/api/demo-workspace*` (`410 Gone`) and activate `AuthView` and `OrganizationView`.
3. **Apply Tenant Integrity Migration to Cloud SQL (Maintenance Window):**
   - Take a Cloud SQL on-demand backup, run `psql -v ON_ERROR_STOP=1 -f drizzle/0001_tenant_integrity_preflight.sql`, apply `drizzle/0001_tenant_integrity.sql` (`BEGIN;...COMMIT;`, PostgreSQL 15+), and keep `0001_tenant_integrity_rollback.sql` ready.
4. **Link Founder Account & Provision Production Runtime Secrets:**
   - Run `npm run org:bootstrap-owner -- --org-id=org-kalyani-hydraulics --issue-token --email="<founder-email>"` (or `--claim-direct`).
   - Configure `SESSION_SECRET` (>= 32 random chars), live `GEMINI_API_KEY`, `RESEND_API_KEY` + verified `EMAIL_FROM` (`SPF`/`DKIM`), `STORAGE_PROVIDER=s3` credentials, `SQL_SSL_CA` (if using TCP TLS), `APP_URL`, `ALLOWED_ORIGINS`, Firebase Authorized Domains, Cloud SQL PITR + Enterprise tier backups, and `CSP_MODE=enforce`.

