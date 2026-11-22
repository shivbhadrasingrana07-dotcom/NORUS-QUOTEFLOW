# Testing Guide

NORUS QUOTEFLOW uses Node.js's built-in test runner (`node:test` + `node:assert/strict`) executed via `tsx --test`.

## Running Tests

### Standard Offline Verification Suite
```bash
npm run lint
npm test
```
Runs all deterministic offline unit, validation, database, HTTP integration, and export tests against temporary isolated databases (`os.tmpdir()` via `QUOTEFLOW_DB_PATH`). **`data/quoteflow-db.json` is never modified or deleted by the test suite.**

### Live Gemini API Smoke Check (Optional)
One test in `tests/extractionValidation.test.ts` (`Live Gemini API extraction smoke test (requires GEMINI_API_KEY)`) is skipped automatically when `GEMINI_API_KEY` is unset. To run it against the real Gemini API (`gemini-4-hydrogen`), set `GEMINI_API_KEY` in the environment and run:
```bash
GEMINI_API_KEY="your-key" npm test
```

## Test Coverage Breakdown

| Test File | Scope Covered |
| :--- | :--- |
| `tests/normalization.test.ts` | Qty × rate, line discounts, tax-inclusive vs. tax-exclusive unwinding, creditable vs. non-creditable tax, FX conversion, pro-rata overhead & 0-base FOC equal split, global discount clamping, printed line total audit tolerance, invalid/negative number rejection, `rankQuotations` L1 eligibility rules, and `computeEvaluatedSavings` |
| `tests/extractionValidation.test.ts` | `colIndexToLetter` (`A`–`AZ`), `sanitizeFilename` cross-platform path-traversal stripping, `validateUploadedFile` magic-byte checks (PDF, PNG, JPEG, WEBP, XLSX, CSV vs. blocked `.exe`/`.svg`/`.html`/`.xlsm` & spoofed content), `parseSpreadsheetBuffer`, `parseAndValidateAiJson`, `buildQuotationFromExtraction` (null preservation, duplicate-match demotion, missing-item backfill), `extractQuotationWithGemini` offline (`generateContentOverride`) for model verification, math mismatch detection, `429` retry exhaustion + key redaction, `504` timeout, and gated live Gemini smoke test |
| `tests/apiAndDb.test.ts` | `loadWorkspace` initialization, `mutateWorkspace` concurrent write serialization (6 parallel mutations, zero lost updates), corrupt JSON backup preservation (`*.corrupt.*.bak`), HTTP end-to-end tests against `createApp({ enableVite: false })`: `/api/health`, `/api/rfqs`, `/api/suppliers` duplicate `409`, spoofed upload `415`, offline extract `201`, math-gate verification (`422` -> `200`), viewer RBAC `403`, buyer decision `403`, approver decision `200` -> `CatalogItem.priceHistory` update, and approved-quote deletion guard `409` |
| `tests/exporters.test.ts` | `sanitizeSpreadsheetCell` formula-injection escaping (`=`, `+`, `-`, `@`, `\t`, `\r`), 4-sheet Excel comparative statement workbook structure, live Excel `MAX`/`MIN` formulas, verified L1 ranking parity, split-award export rows, and landscape A4 PDF generation (`%PDF-`) |
