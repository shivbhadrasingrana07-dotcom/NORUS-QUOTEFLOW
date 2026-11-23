# Testing Guide

NORUS QUOTEFLOW uses Node.js's built-in test runner (`node:test` + `node:assert/strict`) executed via `tsx --test`.

## Running Tests & Operational Verification

### Full Verification Suite
```bash
npm run lint
npm test
npm run build
```
**Disposable Test Database Guard (`tests/_helpers.ts`):** All PostgreSQL integration tests refuse to target managed Cloud SQL (`cloud_sql_development_database`) or production/staging names (`prod`, `production`, `staging`, `postgres`). Live database tests run **only** when `TEST_DATABASE_URL` or `TEST_SQL_*` (`TEST_SQL_HOST`, `TEST_SQL_USER`, `TEST_SQL_PASSWORD`, `TEST_SQL_DB_NAME`) points to a disposable PostgreSQL test database; when unset, PG-dependent tests skip explicitly while unit and demo isolation tests execute normally. In CI (`.github/workflows/ci.yml`), a temporary PostgreSQL 16 service (`quoteflow_test`) applies `drizzle/0000_illegal_major_mapleleaf.sql` and `drizzle/0001_tenant_integrity.sql` before running `npm test`.

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

## Latest Verification Scope (Task 007 Stabilization)
- `npm run lint` (`tsc --noEmit`) & `npm run build` (`vite build`): Compiled and typechecked locally.
- `npm test` (`tsx --test tests/*.test.ts`): Unit, extraction, normalization, export, demo workspace (including offline Gemini isolation), and stabilization unit suites pass offline; live PG integration suites and live Gemini smoke tests skip explicitly unless `TEST_DATABASE_URL`/`TEST_SQL_*` and `RUN_LIVE_GEMINI_TESTS=true` are provided.

## Test Coverage Breakdown

| Test File | Scope Covered |
| :--- | :--- |
| `tests/stabilizationUnit.test.ts` | Task 007 stabilization unit suite: `validateAwardSubmission` & `rankQuotations` rules (verification, math, BOM completeness, unconfirmed freight commercial-exception gate, `alternate_spec` acceptance & justification, non-L1 check, duplicate/approved `409`), `DemoWorkspaceStore` header-edit `isVerified` reset, legacy migration `--confirm` guard + mocked cross-org conflict abort & storage rollback, `getClientIp` trusted proxy behavior, `S3CompatibleStorageProvider` `AbortController` timeout, `isGoogleAuthConfigured()`, and `runScheduledMaintenance` advisory lock skip & orphan DB-row preservation on storage delete failure |
| `tests/demoWorkspace.test.ts` | Temporary no-login demo mode & Task 007 hardening: `GET /api/auth/me` (`demoMode: true`, `authenticated: false`), `GET /api/demo-workspace` synthetic data + zero leakage of `org-kalyani-hydraulics`/real suppliers, real protected routes still returning `401`, `POST /api/demo/switch-persona` `410`, per-visitor session isolation, supplier duplicate `409`, spoofed upload `415`, signed demo doc URL + cross-session `404` + non-allocating missing/unknown session `404` + tampered `403`, genuine `%PDF-` & parseable `.xlsx` previews on preloaded & `load-sample` RFQs, math gate `422`->`200`, strict numeric validation `400`, UOM conversion checks, split/non-L1 award + price memory update + approved deletion `409`, Excel/PDF export verification with `award`, `POST /api/demo-workspace/reset`, `DEMO_MODE=false` restoration (`410`), `resolveDemoMode` matrix, fail-closed boot when `DEMO_MODE=true` in `NODE_ENV=production`, zero calls to PG `RateLimitStore`, and demo extraction ignoring `GEMINI_API_KEY` |
| `tests/authAndMultiTenancy.test.ts` | *(Requires disposable `TEST_SQL_*`/`TEST_DATABASE_URL`)* Auth lifecycle, CSRF `403`, CORS `403`, security headers, brute-force `429` rate limit, org creation/switching, last-owner protection `409`, cross-tenant isolation (`404`/`403`), and unapproved quote + private object deletion cleanup |
| `tests/e2eWorkflow.test.ts` | *(Requires disposable `TEST_SQL_*`/`TEST_DATABASE_URL`)* Complete 20-step End-to-End Business Workflow + cross-tenant isolation across owner/buyer/approver/viewer roles, 3-quote extraction, math gate, L1 ranking, split award, price memory, Excel/PDF exports, and session revocation on password reset |
| `tests/opsAndMonitoring.test.ts` | Unit: `ResendEmailProvider` (retries/timeout/key redaction) & Task 005 `verifyFirebaseIdToken` (`checkRevoked=false` default, `FIREBASE_CHECK_REVOKED=true`, `aud`/`iss`); Disposable PG: expired/reused token checks, `ownerBootstrap.ts`, `runScheduledMaintenance`, `/api/health/ready`, `X-Request-Id`, COOP header, and `ErrorTrackerHook` |
| `tests/apiAndDb.test.ts` | *(Requires disposable `TEST_SQL_*`/`TEST_DATABASE_URL`)* PostgreSQL workflow verification plus idempotent `migrateLegacyJsonToPostgres` validation (`confirmed: true`, backup creation, source JSON preservation, Base64 attachment extraction) |
| `tests/objectStorageAndRateLimit.test.ts` | Unit: `LocalPrivateStorageProvider`, `S3CompatibleStorageProvider`, and bounded LRU `MemoryRateLimitStore`; Disposable PG: `PostgresRateLimitStore` atomic `rate_limit_buckets` upsert |
| `tests/normalization.test.ts` | Qty × rate, line discounts, tax-inclusive vs. tax-exclusive unwinding, creditable vs. non-creditable tax, FX conversion, pro-rata overhead & 0-base FOC equal split, global discount clamping, printed line total audit tolerance, invalid/negative number rejection, `rankQuotations` L1 eligibility rules, and `computeEvaluatedSavings` |
| `tests/extractionValidation.test.ts` | `colIndexToLetter`, `sanitizeFilename`, `validateUploadedFile` magic-byte checks, `parseSpreadsheetBuffer`, `parseAndValidateAiJson`, `buildQuotationFromExtraction`, and `extractQuotationWithGemini` offline (`generateContentOverride`) + `429`/`504` handling & key redaction |
| `tests/exporters.test.ts` | `sanitizeSpreadsheetCell` formula-injection escaping, 4-sheet Excel comparative statement workbook with live formulas, verified L1 parity, split-award rows, and landscape A4 PDF generation |
