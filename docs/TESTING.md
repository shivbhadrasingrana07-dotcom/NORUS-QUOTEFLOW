# Testing Guide

NORUS QUOTEFLOW uses Node.js's built-in test runner (`node:test` + `node:assert/strict`) executed via `tsx --test`, plus headless Chromium browser automation in `tests/browserE2E.mjs`.

## Running Tests & Operational Verification

### Full Verification Suite
```bash
npm ci
npm run lint
npm test
npm run build
```
**Disposable Test Database Guard (`tests/_helpers.ts`):** All PostgreSQL integration tests refuse Unix socket/`/cloudsql/` hosts, managed Cloud SQL (`cloud_sql_development_database`), production/staging names (`prod`, `production`, `staging`, `postgres`), and live `SQL_HOST`+`SQL_DB_NAME` overlap (except `NODE_ENV=test` local CI loopback hosts `127.0.0.1`/`localhost`/`::1`/`postgres` targeting `*_test`/`*-test` databases). Live database tests run **only** when `TEST_DATABASE_URL` or `TEST_SQL_*` (`TEST_SQL_HOST`, `TEST_SQL_USER`, `TEST_SQL_PASSWORD`, `TEST_SQL_DB_NAME`, `TEST_SQL_SSL`, `TEST_SQL_SSL_CA`, `TEST_SQL_SSL_ALLOW_SELF_SIGNED`) points to a disposable PostgreSQL test database; when unset, PG-dependent tests skip explicitly while unit and demo isolation tests execute normally. In CI (`.github/workflows/ci.yml`), a temporary PostgreSQL 16 service (`quoteflow_test`) runs `drizzle/0000_illegal_major_mapleleaf.sql`, `drizzle/0001_tenant_integrity_preflight.sql`, `drizzle/0001_tenant_integrity.sql`, `drizzle/0001_tenant_integrity_rollback.sql`, re-applies `drizzle/0001_tenant_integrity.sql`, and runs `drizzle/0002_usage_quotas_and_tokens.sql` -> `drizzle/0002_usage_quotas_and_tokens_rollback.sql` -> re-applies `drizzle/0002_usage_quotas_and_tokens.sql` before running `npm test`.

### Headless Browser E2E (`tests/browserE2E.mjs`)
Executed automatically in CI's isolated `browser-e2e` job (`DEMO_MODE=true`, `DISABLE_HMR=true`, zero database credentials):
```bash
npm install --no-save playwright && npx playwright install --with-deps chromium
DEMO_MODE=true NODE_ENV=development DISABLE_HMR=true npx tsx server.ts &
node tests/browserE2E.mjs
```

### Operational CLI Checks
```bash
npm run org:bootstrap-owner -- --inspect --org-id=org-kalyani-hydraulics
npm run ops:maintenance
```

### Live Gemini API Smoke Check (Optional)
One test in `tests/extractionValidation.test.ts` (`Live Gemini API extraction smoke test (requires RUN_LIVE_GEMINI_TESTS=true and GEMINI_API_KEY)`) is skipped unless **both** `RUN_LIVE_GEMINI_TESTS=true` and a non-placeholder `GEMINI_API_KEY` are set:
```bash
RUN_LIVE_GEMINI_TESTS=true GEMINI_API_KEY="your-key" npm test
```

## Latest Verification Scope (Task 017 — Usage Quotas, Storage Limits & AI Token Telemetry)
- **VERIFIED (Local Sandbox Execution — Task 017):**
  - `npm run lint` (`tsc --noEmit`): Passed with `0` errors.
  - `npm test`: `68` total (`54` passing, `0` failing, `14` skipped: `13` disposable PostgreSQL tests + `1` live Gemini smoke test; `49.85s`), including Task 017 unit/coordinator/telemetry/demo-isolation tests in `tests/usageQuotas.test.ts` and Task 014 onboarding SSR tests in `tests/stabilizationUnit.test.ts`.
  - `npm run build` (`vite build`): Succeeded (`1967` modules transformed in `1.74s`, `dist/` built cleanly).
- **PRIOR REMOTE CI BASELINE (Pre-Task 017 — Commit `97755076` / Run `#12` `45954730291`, plus Runs `#9`–`#10`):**
  - Prior `main` baseline `97755076de5e574788731d025565d30cde88e37f` passed GitHub Actions **Run `#12`** (`verify` PG16 + `browser-e2e` Chromium, both `conclusion: "success"`). Raw `/logs` archive requests return `HTTP 403` unauthenticated. Task 017 `0002_usage_quotas_and_tokens.sql` CI PG16 execution awaits CI run on updated code.
- **BLOCKED in Current Container (Requires External PostgreSQL 15+ / Chromium / API Key / GitHub Auth):**
  - Local disposable PostgreSQL 15+ (`13` skipped PG tests across `authAndMultiTenancy`, `e2eWorkflow`, `opsAndMonitoring`, `apiAndDb`, `objectStorageAndRateLimit`, and `usageQuotas`), local Playwright/Chromium (`tests/browserE2E.mjs`), and live Gemini API smoke test (`1` skipped test in `tests/extractionValidation.test.ts`). Managed Cloud SQL was intentionally never connected or mutated.

### `xlsx@0.18.5` Replacement Regression Gate (Verified in Task 013)
All four regression gates passed after uninstalling `xlsx@0.18.5`:
1. **Excel Export Formula & Layout Parity (`tests/exporters.test.ts`):** `Summary` (`MAX`/`MIN`), `Line_Matrix` (`IF(ISNUMBER(...))` + split award rows) verified directly in unzipped OOXML `<f>` elements via `fflate`, `Exceptions` (`Insufficient Quantity`, `Arithmetic Mismatch`, `Not Quoted`, `Alternate Spec`, `Missing Freight`), `Audit_Log`, and `sanitizeSpreadsheetCell` formula-injection escaping pass cleanly alongside `read-excel-file/node` round-trip validation.
2. **OOXML `.xlsx` Ingestion Parity (`tests/extractionValidation.test.ts`):** Multi-sheet `.xlsx` cell coordinate extraction (`sheetName`, `A2:D2`), empty-sheet omission, all-empty workbook handling, date/boolean/blank formatting, prototype-key sheet safety (`toString`), XXE/external-entity immunity (`saxen`), malformed XML rejection (`422`), ZIP container pre-scan (`inspectXlsxZipContainer`), and `128 MB / 5s` worker resource & timeout bounds verified.
3. **Delimited `.csv` / `.tsv` / UTF-8 Text `.xls` Parity (`tests/extractionValidation.test.ts`, `tests/demoWorkspace.test.ts`):** `parseDelimitedTextToRows` handles CSV, TSV, and UTF-8 text-table `.xls` uploads (`201 Created`) without binary parsers.
4. **Legacy Binary OLE2 `.xls` Policy Coverage (`tests/extractionValidation.test.ts`, `tests/demoWorkspace.test.ts`):** `inspectOle2Container()` rejects malformed OLE2 (`422`) and embedded VBA macros (`415`), and clean binary OLE2 `.xls` returns structured `415` guidance over both isolated parser and HTTP `/quotes/extract` routes.

## Test Coverage Breakdown

| Test File | Scope Covered |
| :--- | :--- |
| `tests/stabilizationUnit.test.ts` | Task 007–010 unit suite: `validateAwardSubmission` (`1e-6` scaled `getAllocationTolerance`, Kahan `sumExactQuantities` for quantities and split totals, `getConvertedQuotedQuantity` `1e-9` normalization preserving sub-`1e-6`, multi-supplier single-item splits), `getQuantityTolerance`/`isLineQuantitySufficient`, cent precision `isExceedingL1Total`, `rankQuotations`, `DemoWorkspaceStore` validation/locking/`withdrawAward`, PostgreSQL TLS/CSP/SameSite/trust-proxy/`getSafeTestDbConfig`, legacy migration rollback, `getClientIp`, S3 timeout, `isGoogleAuthConfigured()`, and maintenance advisory lock |
| `tests/demoWorkspace.test.ts` | Demo & HTTP suite: `/api/auth/me`, `/api/demo-workspace` isolation & zero real-tenant leakage, protected routes `401`, `/api/demo/switch-persona` `410`, duplicate supplier `409`, spoofed upload & smuggled VBA macro `.xlsx` `415`, signed demo doc URLs, math gate `422`->`200`, quantity sufficiency `422`, locked pending/approved quote `409`, `withdrawAward`, `0.1%` precision rejection `400`, repeating-decimal multi-supplier split `201`, offline Gemini isolation, and `DEMO_MODE` prod fail-closed guard |
| `tests/browserE2E.mjs` | Headless Chromium Playwright E2E in `DEMO_MODE`: Command Center landing without login screens, Comparison Matrix cost basis toggles & exclusion badges, math mismatch fix + verification, L1 award submission -> quote lock verification -> `withdrawAward` -> `Return for Revision` -> `Revise & Resubmit` -> `Approve`, downloaded `%PDF-`/`PK` binary validation, and zero browser console/page errors |
| `tests/authAndMultiTenancy.test.ts` | *(Requires disposable `TEST_SQL_*`/`TEST_DATABASE_URL`)* Auth lifecycle, CSRF `403`, CORS `403`, security headers, brute-force `429` rate limit, org creation/switching, last-owner protection `409`, cross-tenant isolation (`404`/`403`), and unapproved quote + private object deletion cleanup |
| `tests/e2eWorkflow.test.ts` | *(Requires disposable `TEST_SQL_*`/`TEST_DATABASE_URL`)* Complete 20-step End-to-End Business Workflow + cross-tenant isolation across owner/buyer/approver/viewer roles, 3-quote extraction, math gate, L1 ranking, split award, price memory, Excel/PDF exports, and session revocation on password reset |
| `tests/opsAndMonitoring.test.ts` | Unit: `ResendEmailProvider` & `verifyFirebaseIdToken`; Disposable PG: expired/reused tokens, `ownerBootstrap.ts`, `runScheduledMaintenance`, `/api/health/ready`, `X-Request-Id`, COOP header, and `ErrorTrackerHook` |
| `tests/apiAndDb.test.ts` | *(Requires disposable `TEST_SQL_*`/`TEST_DATABASE_URL`)* PostgreSQL workflow, Task 007.2 snapshot immutability & `withdrawAward`, `RFQ-YYYY-XXXX` >= 9000 sequence, idempotent `migrateLegacyJsonToPostgres`, and **Task 009 concurrent `submitAward` vs `updateQuotationHeader`/`verifyQuotation`/`deleteQuotation`/`withdrawAward` serialization test** |
| `tests/objectStorageAndRateLimit.test.ts` | Unit: `LocalPrivateStorageProvider`, `S3CompatibleStorageProvider`, and bounded LRU `MemoryRateLimitStore`; Disposable PG: `PostgresRateLimitStore` atomic `rate_limit_buckets` upsert |
| `tests/normalization.test.ts` | Qty × rate, line discounts, tax-inclusive vs. tax-exclusive unwinding, creditable vs. non-creditable tax, FX conversion, pro-rata overhead & 0-base FOC equal split, global discount clamping, printed line total audit tolerance, invalid/negative number rejection, `rankQuotations`, and `computeEvaluatedSavings` |
| `tests/extractionValidation.test.ts` | `colIndexToLetter`, `sanitizeFilename`, magic-byte checks, native RFC-4180 CSV parser (zero `xlsx`), ZIP bomb (`422`), VBA macro (`415`), >12 sheets / >250 rows / >30 cols bounds (`422`), isolated worker process execution with secret-stripped `env`, `parseAndValidateAiJson`, `buildQuotationFromExtraction`, and `extractQuotationWithGemini` |
| `tests/exporters.test.ts` | `sanitizeSpreadsheetCell` formula-injection escaping, 4-sheet Excel comparative statement workbook with live formulas & `Insufficient Quantity` exceptions, verified L1 parity, split-award rows, and landscape A4 PDF generation |
| `tests/usageQuotas.test.ts` | Unit + Concurrency: `PLAN_POLICIES` (`starter`/`professional`/`business` unvalidated caps vs. non-blocking `legacy`), `InMemoryUsageQuotaCoordinator` (`N` vs. `N+1`, parallel concurrency race protection, `Idempotency-Key` retries, failed reservation release, delete storage reclaim, UTC month rollover), `extractQuotationWithTelemetry` (`usageMetadata` vs. absent metadata `usageAvailable: false`), `DEMO_MODE` isolation; Disposable PG *(skipped when PG unset)*: `GET /api/organization/usage`, `PATCH /api/settings` tier lock, `Idempotency-Key` HTTP retries, parallel HTTP `Promise.all` reservation race guard, `DELETE` storage reclaim, `'legacy'` safety, and `ai_token_usage_logs` persistence |
