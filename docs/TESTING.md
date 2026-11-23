# Testing Guide

NORUS QUOTEFLOW uses Node.js's built-in test runner (`node:test` + `node:assert/strict`) executed via `tsx --test`.

## Running Tests & Operational Verification

### Full Verification Suite
```bash
npm run lint
npm test
npm run build
```
Integration tests run against the configured Cloud SQL PostgreSQL database using uniquely prefixed `test-*` organizations and users that are cleaned up in `after()` hooks (`tests/_helpers.ts`). **Migrated legacy organization data (`org-kalyani-hydraulics`) and `data/quoteflow-db.json` are never modified or deleted by the test suite.**

### Operational CLI Checks
```bash
npm run org:bootstrap-owner -- --inspect --org-id=org-kalyani-hydraulics
npm run ops:maintenance
```

### Live Gemini API Smoke Check (Optional)
One test in `tests/extractionValidation.test.ts` (`Live Gemini API extraction smoke test (requires GEMINI_API_KEY)`) is skipped automatically when `GEMINI_API_KEY` is unset in the shell environment. To execute it against live Gemini (`gemini-4-hydrogen`), run:
```bash
GEMINI_API_KEY="your-key" npm test
```

## Latest Verified Summary (Task 007)
- `npm test`: Covers Tasks 002–007 (including bounded `MemoryRateLimitStore`, `resolveDemoMode` dev/prod fail-closed guards, zero-PG demo rate limiting, non-allocating demo document lookups, genuine sample PDF/XLSX previews, validation, and comparative exports; 1 live Gemini smoke test skipped when `GEMINI_API_KEY` is unset in shell).
- `npm run lint` (`tsc --noEmit`): Passed (`0` errors).
- `npm run build` (`vite build`): Passed.

## Test Coverage Breakdown

| Test File | Scope Covered |
| :--- | :--- |
| `tests/demoWorkspace.test.ts` | Temporary no-login demo mode & Task 007 hardening: `GET /api/auth/me` (`demoMode: true`, `authenticated: false`), `GET /api/demo-workspace` synthetic data + zero leakage of `org-kalyani-hydraulics`/real suppliers, real protected routes still returning `401`, `POST /api/demo/switch-persona` `410`, per-visitor session isolation, supplier duplicate `409`, spoofed upload `415`, signed demo doc URL + cross-session `404` + non-allocating missing/unknown session `404` + tampered `403`, genuine `%PDF-` & parseable `.xlsx` previews on preloaded & `load-sample` RFQs, math gate `422`->`200`, strict numeric validation `400`, UOM conversion checks, split/non-L1 award + price memory update + approved deletion `409`, Excel/PDF export verification with `award`, `POST /api/demo-workspace/reset`, `DEMO_MODE=false` restoration (`410`), `resolveDemoMode` matrix, fail-closed boot when `DEMO_MODE=true` in `NODE_ENV=production`, and zero calls to PG `RateLimitStore` |
| `tests/authAndMultiTenancy.test.ts` | Auth lifecycle (register, weak password `400`, email verification, duplicate email `409`, password reset revoking active sessions, login/logout, session listing/revocation, Firebase Google Sign-In verifier mock), CSRF `403`, CORS `403`, security headers, brute-force `429` rate limit, org creation/switching, last-owner protection `409`, cross-tenant isolation (`404`/`403`), and unapproved quote + private object deletion cleanup |
| `tests/e2eWorkflow.test.ts` | Complete **20-step End-to-End Business Workflow** + cross-tenant isolation: unauthenticated `401`/`410`, owner register + email verify, invite `buyer`/`approver` (Google verified)/`viewer`, catalog + 3 suppliers + duplicate GSTIN `409`, multi-line RFQ, spoofed upload `415`, 3-quote extraction (L1 good, L2 bad math, L3 partial), signed URL & tampered sig `403`, math gate `422` -> `200`, L1/L2/incomplete ranking & savings, viewer blocked `403`, buyer split-award submit + self-approve blocked `403`, approver decision -> price memory update + approved deletion guard `409`, 4-sheet Excel & PDF comparative export verification, second org isolation & org switch, password reset session revocation & token reuse rejection |
| `tests/opsAndMonitoring.test.ts` | `ResendEmailProvider` (sender validation, `503`/`429` bounded retries, `401` fast-fail, `AbortController` timeout, API key redaction), expired/reused verification & reset token rejection, Google unverified-link `403` + existing-user invite acceptance, Task 005 `verifyFirebaseIdToken` (`checkRevoked=false` default, `FIREBASE_CHECK_REVOKED=true` opt-in, `aud`/`iss` validation, `/api/auth/google` `401` without Identity Toolkit host-project lookup errors), `ownerBootstrap.ts` claim-token & direct bootstrap (`403`/`404`/`409` + last-owner guard), `runScheduledMaintenance` bounded-batch idempotent cleanup across sessions/invitations/user tokens/rate buckets/orphaned docs/`.tmp` files, `/api/health`, `/api/health/ready` (`200` ready + `503` degraded without secret leakage), `X-Request-Id`, COOP header, and `ErrorTrackerHook` |
| `tests/apiAndDb.test.ts` | PostgreSQL workflow verification plus idempotent `migrateLegacyJsonToPostgres` validation (backup creation, source JSON preservation, Base64 attachment extraction) |
| `tests/objectStorageAndRateLimit.test.ts` | `LocalPrivateStorageProvider` (traversal blocking, put/get/delete, HMAC token verification & expiry/org tampering), `S3CompatibleStorageProvider` (AWS SigV4 auth headers & presigned URL signing), `MemoryRateLimitStore` (expiry & bounded LRU bucket eviction), and live `PostgresRateLimitStore` atomic `rate_limit_buckets` upsert |
| `tests/normalization.test.ts` | Qty × rate, line discounts, tax-inclusive vs. tax-exclusive unwinding, creditable vs. non-creditable tax, FX conversion, pro-rata overhead & 0-base FOC equal split, global discount clamping, printed line total audit tolerance, invalid/negative number rejection, `rankQuotations` L1 eligibility rules, and `computeEvaluatedSavings` |
| `tests/extractionValidation.test.ts` | `colIndexToLetter`, `sanitizeFilename`, `validateUploadedFile` magic-byte checks, `parseSpreadsheetBuffer`, `parseAndValidateAiJson`, `buildQuotationFromExtraction`, and `extractQuotationWithGemini` offline (`generateContentOverride`) + `429`/`504` handling & key redaction |
| `tests/exporters.test.ts` | `sanitizeSpreadsheetCell` formula-injection escaping, 4-sheet Excel comparative statement workbook with live formulas, verified L1 parity, split-award rows, and landscape A4 PDF generation |
