# Testing Guide

NORUS QUOTEFLOW uses Node.js's built-in test runner (`node:test` + `node:assert/strict`) executed via `tsx --test`.

## Running Tests

### Full Verification Suite
```bash
npm run lint
npm test
npm run build
```
Integration tests run against the configured PostgreSQL database using uniquely prefixed `test-*` organizations and users that are cleaned up in `after()` hooks (`tests/_helpers.ts`). **Migrated legacy production/sample data (`org-kalyani-hydraulics`) and `data/quoteflow-db.json` are never modified or deleted by the test suite.**

### Live Gemini API Smoke Check (Optional)
One test in `tests/extractionValidation.test.ts` (`Live Gemini API extraction smoke test (requires GEMINI_API_KEY)`) is skipped automatically when `GEMINI_API_KEY` is unset. To run it against the real Gemini API (`gemini-4-hydrogen`), set `GEMINI_API_KEY` in the environment and run:
```bash
GEMINI_API_KEY="your-key" npm test
```

## Test Coverage Breakdown

| Test File | Scope Covered |
| :--- | :--- |
| `tests/authAndMultiTenancy.test.ts` | Auth lifecycle (register, weak password `400`, email verification token capture, duplicate email `409`, password reset revoking active sessions, login/logout, session listing/revocation, Firebase Google Sign-In verifier mock), CSRF `403`, CORS `403`, security headers, brute-force `429` rate limit, org creation/switching, last-owner protection `409`, cross-tenant isolation (`404`/`403` across RFQs, quotations, settings, signed URLs, and `/api/documents/:docId/content`), and unapproved quote + private object deletion cleanup |
| `tests/apiAndDb.test.ts` | End-to-end Cloud SQL procurement workflow (`GET /api/health`, `/api/demo/switch-persona` `410`, RFQ creation, duplicate GSTIN `409`, spoofed PDF `415`, real PNG upload to private object storage + signed download + tampered sig `403`, math gate `422` -> `200`, invited `viewer`/`buyer`/`approver` server RBAC, award approval -> `price_history` update & `409` deletion guard), plus idempotent `migrateLegacyJsonToPostgres` validation (backup creation, source JSON preservation, Base64 attachment extraction) |
| `tests/objectStorageAndRateLimit.test.ts` | `LocalPrivateStorageProvider` (traversal blocking, put/get/delete, HMAC token verification & expiry/org tampering), `S3CompatibleStorageProvider` (AWS SigV4 auth headers & presigned URL signing), `MemoryRateLimitStore`, and live `PostgresRateLimitStore` atomic `rate_limit_buckets` upsert |
| `tests/normalization.test.ts` | Qty × rate, line discounts, tax-inclusive vs. tax-exclusive unwinding, creditable vs. non-creditable tax, FX conversion, pro-rata overhead & 0-base FOC equal split, global discount clamping, printed line total audit tolerance, invalid/negative number rejection, `rankQuotations` L1 eligibility rules, and `computeEvaluatedSavings` |
| `tests/extractionValidation.test.ts` | `colIndexToLetter` (`A`–`AZ`), `sanitizeFilename`, `validateUploadedFile` magic-byte checks, `parseSpreadsheetBuffer`, `parseAndValidateAiJson`, `buildQuotationFromExtraction`, `extractQuotationWithGemini` offline (`generateContentOverride`) + `429`/`504` handling & key redaction |
| `tests/exporters.test.ts` | `sanitizeSpreadsheetCell` formula-injection escaping (`=`, `+`, `-`, `@`, `\t`, `\r`), 4-sheet Excel comparative statement workbook with live formulas, verified L1 parity, split-award rows, and landscape A4 PDF generation (`%PDF-`) |
