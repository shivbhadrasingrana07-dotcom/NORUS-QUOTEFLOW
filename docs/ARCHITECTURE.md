# Architecture

NORUS QUOTEFLOW is a unified TypeScript full-stack web application served by Express on port `3000` (with Vite middleware in development and `dist/` static serving in production).

## System Overview

```text
+-------------------------------------------------------------------+
| React 19 SPA (src/)                                               |
|  - Command Center, RFQ List, RFQ Workspace, Suppliers, Price Mem  |
|  - ExtractionReviewPane (buffered draft edits onBlur + PDF/Excel) |
|  - ComparisonMatrixPane (shared rankQuotations + split award)     |
|  - Exporters (src/lib/exporters.ts -> jsPDF + SheetJS XLSX)       |
+----------------------------------+--------------------------------+
                                   | HTTP / JSON / Multipart FormData
                                   v
+-------------------------------------------------------------------+
| Express Server (server.ts -> createApp)                           |
|  - Security headers, Multer 25 MB limit, RBAC role guards         |
|  - File magic-byte check (server/fileSecurity.ts)                 |
|  - Gemini extraction & XLSX parser (server/geminiExtractor.ts)    |
|  - Normalization & arithmetic audit (server/normalization.ts)     |
|  - Atomic mutex-locked JSON store (server/db.ts)                  |
+-------------------------------------------------------------------+
```

## Key Design Decisions & Module Boundaries

### 1. Deterministic Server-Side Normalization (`server/normalization.ts`)
AI extraction (`geminiExtractor.ts`) only extracts raw printed quantities, rates, discounts, tax rates, UOMs, and source snippets. All financial math is calculated deterministically on the server via `recomputeQuotation(quote, rfq)`:

1. **UOM Normalization:** `effectiveQty = quotedQty * uomConversionFactor` (e.g., `50 boxes * 10 pcs/box = 500 pcs`).
2. **Tax Unwinding:**
   - `taxIncludedInRates === true`: `lineGross = max(0, qty * rate - discount)`, `lineBase = lineGross / (1 + taxRatePct / 100)`, `lineTax = lineGross - lineBase`.
   - `taxIncludedInRates === false`: `lineBase = max(0, qty * rate - discount)`, `lineTax = lineBase * (taxRatePct / 100)`, `lineGross = lineBase + lineTax`.
3. **Currency & Overhead Allocation:**
   - `netOverhead = (freightCharges + packingForwarding + otherCharges - globalDiscount) * exchangeRateToRfq`.
   - Allocated pro-rata across active lines by `lineBase / subtotalBase` (or split equally if `subtotalBase === 0`, such as 100% FOC quotes).
4. **Unit Cost Outputs (in RFQ currency):**
   - `normalizedUnitBase = lineBase / effectiveQty`
   - `normalizedUnitLanded = (lineBase + allocatedOverhead + (taxCreditable ? 0 : lineTax)) / effectiveQty`
   - `normalizedUnitGross = (lineGross + allocatedOverhead) / effectiveQty`
5. **Arithmetic Audit:**
   - Compares printed `lineTotalQuoted` against expected pre-tax or post-tax total within `max(1.5, 0.5%)` tolerance.
   - Invalid numeric values (negative rate/qty/discount, `taxRatePct > 100`, `uomConversionFactor <= 0`, `NaN`/`Infinity`) flag `mathValid = false` and force `isVerified = false`.

### 2. Shared Ranking & Honest Savings (`src/lib/ranking.ts`)
Imported by both the frontend (`ComparisonMatrixPane`, `DashboardView`, `RfqsListView`, `exporters.ts`) and backend (`POST /api/rfqs/:rfqId/award`):
- Only **100% complete (`completenessRatio >= 1`), math-valid, human-verified (`isVerified`)** quotations are eligible for `L1` / `L2` / `L3` ranking.
- Partial or unverified quotations sort below eligible bids and receive explicit labels (`Incomplete`, `Pending Audit`, `Flagged`).
- `computeEvaluatedSavings` compares only complete, math-valid bids so partial quotes never inflate savings KPIs.

### 3. Gemini Extraction Pipeline (`server/geminiExtractor.ts`)
- Spreadsheets (`.xlsx`, `.xls`, `.csv`) are parsed deterministically with SheetJS (`parseSpreadsheetBuffer`, capped at 4 sheets × 120 rows × 30 cols) into cell-coordinate text (`A1`, `AA1`) and preview tables before invoking Gemini.
- PDFs and images are passed inline (`base64`) to `@google/genai` model `gemini-4-hydrogen` with a strict JSON response schema (`Type.OBJECT`).
- `callWithTimeoutAndRetry` enforces a 45-second timeout (`clearTimeout` in `finally`), bounded retries for transient `429`/`503` errors, and key redaction (`[REDACTED]`).
- `buildQuotationFromExtraction` rejects unknown `rfqItemId` references, demotes duplicate `matchedRfqItemId` assignments to `unmapped`, penalizes confidence when price/qty is absent, and backfills unquoted RFQ items as `not_quoted`.
