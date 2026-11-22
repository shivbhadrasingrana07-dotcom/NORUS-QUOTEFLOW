# NORUS QUOTEFLOW

**NORUS QUOTEFLOW** is a B2B Pre-PO supplier quotation extraction, commercial normalization, landed-cost comparison, and price-memory workspace built for small-to-medium manufacturing and trading teams.

It ingests non-standard vendor quotations across PDF, Excel (`.xlsx`/`.xls`), CSV, image scans (PNG/JPG/WEBP), and pasted email or WhatsApp text, pairs AI structured extraction (`@google/genai`) with deterministic server-side arithmetic auditing, and lets buyers compare normalized landed unit costs before recommending single-vendor or split awards.

> **Workspace Boundary:** NORUS QUOTEFLOW is independent of NORUS BILLWISE and does not share runtime state or databases with it.

## Implemented Capabilities

1. **Command Center Dashboard** — Active RFQ queue, pending approvals, verified savings across complete bids, and item price memory alerts.
2. **RFQ Creation & BOM Import** — Sequential `RFQ-YYYY-XXXX` creation, multi-line BOM entry, CSV/clipboard BOM paste, and catalog auto-linking.
3. **Supplier Invitation Copy Generator** — Ready-to-send email/WhatsApp RFQ invitation text for selected suppliers.
4. **Multi-Format Quotation Ingestion** — PDF, Excel, CSV, image uploads (up to 25 MB, magic-byte validated), plus email/WhatsApp text paste.
5. **Gemini Structured Extraction** — Server-side extraction using `@google/genai` (`gemini-4-hydrogen`) with strict JSON schema, timeout/retry handling, and zero-fabrication rules.
6. **Deterministic Arithmetic Audit** — Server-side verification of `qty × rate - discount` (pre-tax and post-tax) within `max(1.5, 0.5%)` tolerance, blocking verification if discrepancies remain.
7. **Source-Document Traceability** — Split-screen audit workbench linking extracted values to PDF/image bounding boxes, spreadsheet sheet/cell coordinates, or text snippets.
8. **Commercial & Tax Normalization** — UOM conversion multipliers (`uomConversionFactor`), tax-inclusive vs. tax-exclusive unwinding, creditable vs. non-creditable tax (ITC/VAT), pro-rata freight/P&F/discount allocation, and FX conversion (`exchangeRateToRfq`).
9. **Side-by-Side Comparison Matrix** — Normalized `L1`/`L2`/`L3` ranking strictly across 100%-complete, math-valid, human-verified quotes (`src/lib/ranking.ts`).
10. **Split-Award Simulation** — Per-line vendor selection across suppliers with real-time total landed cost computation.
11. **Approval Workflow & Audit Trail** — Mandatory non-L1 justification, server-enforced buyer/approver/admin/viewer RBAC checks, and immutable audit logs.
12. **Item Price Memory** — Automatic update of catalog last-awarded landed unit prices and historical price timeline upon award approval.
13. **PDF & Excel Comparative Statement Exports** — Landscape A4 PDF comparative statements and 4-sheet Excel workbooks with live formulas and CSV/DDE formula-injection sanitization.

## Tech Stack

- **Frontend:** React 19, TypeScript, Vite 8, Tailwind CSS v4, Lucide Icons, `jspdf`, `jspdf-autotable`, `xlsx`
- **Backend:** Express 4 (`server.ts`), Multer 2, `@google/genai` (`gemini-4-hydrogen`), `tsx`
- **Persistence:** Atomic file-backed JSON workspace database (`server/db.ts` -> `data/quoteflow-db.json`, configurable via `QUOTEFLOW_DB_PATH`)
- **Testing:** Node built-in test runner (`node:test` + `node:assert/strict`) executed via `tsx --test`

## Quick Start

1. **Install dependencies:**
   ```bash
   npm install
   ```
2. **Configure environment:**
   Copy `.env.example` or set runtime secrets in the environment:
   - `GEMINI_API_KEY` — Required for live AI quotation extraction (`POST /api/rfqs/:rfqId/quotes/extract`).
   - `PORT` — Defaults to `3000`.
3. **Run development server:**
   ```bash
   npm run dev
   ```
   Opens the full-stack Express + Vite application on port `3000`.
4. **Verify types, tests, and production build:**
   ```bash
   npm run lint
   npm test
   npm run build
   ```

## Documentation Index

- [Project Status](docs/PROJECT_STATUS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Database Schema](docs/DATABASE_SCHEMA.md)
- [API Documentation](docs/API_DOCUMENTATION.md)
- [Testing Guide](docs/TESTING.md)
- [Security Posture & Limitations](docs/SECURITY.md)
- [Configuration Reference](docs/CONFIGURATION.md)
- [Changelog](docs/CHANGELOG.md)
- [Next Task](docs/NEXT_TASK.md)
