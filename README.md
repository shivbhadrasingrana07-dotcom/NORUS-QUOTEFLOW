# NORUS QUOTEFLOW

**NORUS QUOTEFLOW** is a multi-tenant B2B Pre-PO supplier quotation extraction, commercial normalization, landed-cost comparison, and historical price-intelligence SaaS platform built for small-to-medium manufacturing and trading teams.

It ingests non-standard vendor quotations across PDF, Excel (`.xlsx` and UTF-8 text-table `.xls`; binary `.xls` returns clear `415` save-as-`.xlsx`/`.csv` guidance), CSV, image scans (PNG/JPG/WEBP), and pasted email or WhatsApp text, pairs AI structured extraction (`@google/genai`) with deterministic server-side arithmetic auditing, and lets authenticated teams compare normalized landed unit costs inside strictly isolated organization workspaces.

> **Temporary Demo Mode Notice (Task 006 / Hardened in Task 007):** In development/test (`NODE_ENV !== "production"`), unless `DEMO_MODE="false"`, the web UI opens directly into an **isolated synthetic demo workspace** (`Meridian Industrial Demo Works (Sample)`) with zero Cloud SQL access, bounded in-memory demo rate limiting, and genuine synthetic PDF/Excel quotation previews. In **production (`NODE_ENV === "production"`)**, `DEMO_MODE` is strictly **OFF (`false`) by default** and the server **fails closed on startup** if `DEMO_MODE=true` is set, restoring full authentication (`Google Sign-In` + `Email/Password`), registration, and multi-tenant PostgreSQL workspaces (`org-kalyani-hydraulics` remains untouched and locked behind authentication).

> **Workspace Boundary:** NORUS QUOTEFLOW is independent of NORUS BILLWISE and does not share runtime state or databases with it.

## Implemented Capabilities

1. **Multi-Organization SaaS Auth & Session Security** — Dual real authentication: Firebase Google Sign-In (`firebase` + `firebase-admin` server-side ID token verification with `openid`/`email`/`profile` scopes, Google X.509 certificate signature + `aud`/`iss` validation, opt-in `FIREBASE_CHECK_REVOKED=true`, real config-checked `googleAuthConfigured` readiness, and verified-email account-linking guard) and app-managed email/password accounts (`scrypt` hashing, email verification, password reset that revokes active sessions, revocable PostgreSQL sessions capped at 10 active sessions/user with `HttpOnly` cookies, and CSRF validation).
2. **Organization Isolation, 5-Role RBAC & Safe First-Owner Bootstrap** — Strictly tenant-scoped PostgreSQL persistence (`organizationId` enforced on every query/mutation plus composite same-org FK/index hardening in `drizzle/0001_tenant_integrity.sql`), `owner`/`admin`/`buyer`/`approver`/`viewer` roles, team invitations, last-owner protection, multi-org switching, and transactional `FOR UPDATE` locked first-owner bootstrap CLI (`npm run org:bootstrap-owner`).
3. **Private Object Storage & Signed Previews** — Uploaded PDFs/images stored outside the public webroot (`S3CompatibleStorageProvider` via AWS SigV4 with `AbortController` timeouts or `LocalPrivateStorageProvider` under `data/private-storage/`) with short-lived HMAC/SigV4 signed download URLs and storage readiness probes.
4. **Operational Monitoring & Scheduled Maintenance** — Correlation IDs (`X-Request-Id`), redacted structured JSON logs, webhook error-tracking hook (`ERROR_WEBHOOK_URL`), split liveness (`GET /api/health`) vs. dependency readiness (`GET /api/health/ready`), trusted-proxy IP rate limiting (`req.ip`), and PostgreSQL advisory-locked bounded-batch cleanup (`npm run ops:maintenance`).
5. **Command Center Dashboard** — Active RFQ queue, pending approvals, verified savings across complete bids, and item price memory alerts.
6. **RFQ Creation & BOM Import** — Sequential `RFQ-YYYY-XXXX` creation per organization, multi-line BOM entry, CSV/clipboard BOM paste, and catalog auto-linking.
7. **Supplier Invitation Copy Generator** — Ready-to-send email/WhatsApp RFQ invitation text for selected suppliers.
8. **Multi-Format Quotation Ingestion** — PDF, Excel, CSV, image uploads (up to 25 MB, magic-byte validated), plus email/WhatsApp text paste.
9. **Gemini Structured Extraction (Isolated From Demo)** — Authenticated organizations use server-side `@google/genai` (`gemini-4-hydrogen`) extraction with strict JSON schema and zero-fabrication rules; non-production demo mode runs exclusively offline (`extractDemoQuotationOffline`) and never invokes `GEMINI_API_KEY`.
10. **Deterministic Arithmetic Audit** — Server-side verification of `qty × rate - discount` (pre-tax and post-tax) within `max(1.5, 0.5%)` tolerance, resetting `isVerified` on header edits and blocking verification if discrepancies remain.
11. **Source-Document Traceability** — Split-screen audit workbench linking extracted values to private signed PDF/image previews, spreadsheet sheet/cell coordinates, or text snippets, with explicit freight/commercial terms confirmation.
12. **Commercial & Tax Normalization** — UOM conversion multipliers, tax-inclusive vs. tax-exclusive unwinding, creditable vs. non-creditable tax (ITC/VAT), pro-rata freight/P&F/discount allocation, and FX conversion.
13. **Side-by-Side Comparison Matrix & Split Award** — Normalized `L1`/`L2`/`L3` ranking strictly across 100%-complete, math-valid, human-verified, freight-confirmed, alternate-reviewed quotes (`src/lib/ranking.ts`), plus per-line split-award simulation.
14. **Procurement Integrity & Approval Exports** — Shared server/client award validation (`src/lib/awardValidation.ts`), mandatory non-L1 justification, explicit commercial-exception & alternate-spec acceptance gates, row-locked atomic approval decisions, append-only audit trail (application-enforced), Item Price Memory updates, and landscape PDF + 4-sheet Excel exports.

## Tech Stack

- **Frontend:** React 19, TypeScript, Vite 8, Tailwind CSS v4, Lucide Icons, Firebase Client SDK (`GoogleAuthProvider`), `jspdf`, `jspdf-autotable`, `write-excel-file` (`4.1.1`)
- **Backend:** Express 4 (`server.ts`), Drizzle ORM + PostgreSQL (`pg`), `firebase-admin`, Multer 2, `@google/genai` (`gemini-4-hydrogen`), `tsx`
- **Database:** Cloud SQL PostgreSQL 18.6 (`asia-southeast1`) with 17 relational tables (`src/db/schema.ts`), Drizzle migrations (`drizzle/`), and atomic PostgreSQL rate-limiting (`rate_limit_buckets`)
- **Object Storage:** AWS SigV4 S3-compatible provider (`Cloudflare R2` / `S3` / `MinIO`) or private local filesystem storage (`server/objectStorage.ts`)
- **Testing:** Node built-in test runner (`node:test` + `node:assert/strict`) executed via `tsx --test` + Playwright Chromium E2E (`tests/browserE2E.mjs`)

## Quick Start

1. **Install dependencies (Node.js 22 LTS recommended):**
   ```bash
   npm ci
   ```
   > **Note:** Clean `npm ci` requires no `--legacy-peer-deps` flag (`esbuild` is aligned at `^0.28.2`). On Node `v22.x`, `@firebase/*` subpackages emit non-fatal `EBADENGINE` (`>=24.12.0`) warnings that do not affect runtime execution.
2. **Configure environment (see [Configuration Reference](docs/CONFIGURATION.md)):**
   Set PostgreSQL connection variables (`SQL_HOST`, `SQL_USER`, `SQL_PASSWORD`, `SQL_DB_NAME`), `SESSION_SECRET` (`>= 32` chars, required in production), and `GEMINI_API_KEY` (required for live AI extraction).
3. **Apply SQL migrations (PostgreSQL 15+) & inspect/bootstrap migrated organization ownership:**
   ```bash
   psql ... -v ON_ERROR_STOP=1 -f drizzle/0000_illegal_major_mapleleaf.sql
   psql ... -v ON_ERROR_STOP=1 -f drizzle/0001_tenant_integrity_preflight.sql
   psql ... -v ON_ERROR_STOP=1 -f drizzle/0001_tenant_integrity.sql
   npm run db:migrate -- --dry-run
   npm run db:migrate -- --apply --confirm
   npm run org:bootstrap-owner -- --inspect --org-id=org-kalyani-hydraulics
   ```
4. **Run development server or scheduled maintenance:**
   ```bash
   npm run dev
   npm run ops:maintenance
   ```
   `npm run dev` serves the full-stack Express + Vite application on port `3000`.
5. **Verify types, tests, and production build:**
   ```bash
   npm run lint
   npm test          # Live PG tests require disposable TEST_DATABASE_URL or TEST_SQL_*; live Gemini requires RUN_LIVE_GEMINI_TESTS=true
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
