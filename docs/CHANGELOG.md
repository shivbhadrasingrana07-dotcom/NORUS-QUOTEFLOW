# Changelog

## Task 002 — Reliability, Security, Testing & Documentation Pass

### Added
- `src/lib/ranking.ts`: Shared `rankQuotations` and `computeEvaluatedSavings` ensuring only 100%-complete, math-valid, human-verified quotations can receive `L1`/`L2`/`L3` ranks.
- `server/fileSecurity.ts`: Upload filename sanitization (`sanitizeFilename`, cross-platform `\` normalization) and magic-byte validation (`validateUploadedFile`).
- `GET /api/health` and `POST /api/demo/switch-persona` endpoints in `server.ts`.
- Automated test suite in `tests/normalization.test.ts`, `tests/extractionValidation.test.ts`, `tests/apiAndDb.test.ts`, and `tests/exporters.test.ts`, plus `"test"` script in `package.json`.
- Project documentation in `README.md` and `docs/*.md`.

### Changed / Fixed
- `server/db.ts`: Added `QUOTEFLOW_DB_PATH` support, async write mutex (`withWorkspaceLock` / `mutateWorkspace`), unique `.tmp` names, `ensureWorkspaceSchema`, and non-destructive `.corrupt.<ts>.bak` recovery.
- `server/normalization.ts`: Added strict numeric validation (rejecting negative/NaN/Infinity/tax > 100%/invalid UOM factor), equal overhead split for 0-base FOC lines, `0`-clamped totals, and calculation JSDoc conventions.
- `server/geminiExtractor.ts`: Added `ExtractionServiceError` HTTP status mapping (`503`, `429`, `504`, `502`, `422`), `sanitizeErrorMessage` key redaction, `45s` timeout with `finally { clearTimeout(timer) }`, transient retry backoff, duplicate RFQ item match demotion, multi-currency `estimateExchangeRate`, and `generateContentOverride` test seam.
- `server.ts`: Exported `createApp` for isolated testing; added security response headers, Multer `413` limit handler, server-enforced RBAC `403` guards, sequential `nextSequentialRfqNumber`, approved-award deletion `409` protection, and server-side award total/L1 recomputation.
- `src/lib/exporters.ts`: Synchronized `rankQuotations` parity, added `sanitizeSpreadsheetCell` formula-injection protection, added `Non-Creditable Tax` column & `MAX(0, ...)` Excel formula parity, and included split-award allocations in both PDF and Excel exports.
- `src/components/ExtractionReviewPane.tsx`: Fixed multi-letter column header conversion (>26 columns), buffered line/header draft inputs committing on `onBlur` (fixing per-keystroke race conditions), and added FX rate & `taxCreditable` controls plus quantity variance warnings.
- `src/components/ComparisonMatrixPane.tsx`, `DashboardView.tsx`, `RfqWorkspace.tsx`, `Sidebar.tsx`, `SecondaryViews.tsx`, `App.tsx`: Updated to shared `rankQuotations`/`computeEvaluatedSavings`, explicit sandbox persona labeling, `rfq.id` draft state reset, and double-submit button guards.
