# NORUS QUOTEFLOW

**NORUS QUOTEFLOW** is a multi-tenant B2B Pre-PO supplier quotation extraction, commercial normalization, landed-cost comparison, and historical price-intelligence SaaS platform built for small-to-medium manufacturing and trading teams.

It ingests non-standard vendor quotations across PDF, Excel (`.xlsx`/`.xls`), CSV, image scans (PNG/JPG/WEBP), and pasted email or WhatsApp text, pairs AI structured extraction (`@google/genai`) with deterministic server-side arithmetic auditing, and lets authenticated teams compare normalized landed unit costs inside strictly isolated organization workspaces.

> **Temporary Demo Mode Notice (Task 006):** By default (`DEMO_MODE !== "false"`), the web UI currently opens directly into an **isolated synthetic demo workspace** (`Meridian Industrial Demo Works (Sample)`) without requiring sign-in, for preview/evaluation only. This demo mode is **not** a production-ready public application; all real Cloud SQL customer data (`org-kalyani-hydraulics`) remains untouched and locked behind authentication. To restore full login (`Google Sign-In` + `Email/Password`), registration, and multi-tenant organizations, set `DEMO_MODE="false"` in your environment and restart the server.

> **Workspace Boundary:** NORUS QUOTEFLOW is independent of NORUS BILLWISE and does not share runtime state or databases with it.

## Implemented Capabilities

1. **Multi-Organization SaaS Auth & Session Security** — Dual real authentication: Firebase Google Sign-In (`firebase` + `firebase-admin` server-side ID token verification with `openid`/`email`/`profile` scopes, Google X.509 certificate signature + `aud`/`iss` validation, optional `FIREBASE_CHECK_REVOKED=true`, and verified-email account-linking guard) and app-managed email/password accounts (`scrypt` hashing, email verification, password reset that revokes active sessions, revocable PostgreSQL sessions with `HttpOnly` cookies, and CSRF validation).
2. **Organization Isolation, 5-Role RBAC & Safe First-Owner Bootstrap** — Strictly tenant-scoped PostgreSQL persistence (`organizationId` enforced on every query and mutation) with `owner`, `admin`, `buyer`, `approver`, and `viewer` roles, team invitations, last-owner protection, multi-org switching, and transactional first-owner bootstrap CLI (`npm run org:bootstrap-owner`) for migrated owner-less tenants.
3. **Private Object Storage & Signed Previews** — Uploaded PDFs/images stored outside the public webroot (`S3CompatibleStorageProvider` via AWS SigV4 or `LocalPrivateStorageProvider` under `data/private-storage/`) with short-lived HMAC/SigV4 signed download URLs and storage readiness probes.
4. **Operational Monitoring & Scheduled Maintenance** — Correlation IDs (`X-Request-Id`), redacted structured JSON logs, webhook error-tracking hook (`ERROR_WEBHOOK_URL`), split liveness (`GET /api/health`) vs. dependency readiness (`GET /api/health/ready`), and idempotent bounded-batch cleanup (`npm run ops:maintenance` + optional `MAINTENANCE_INTERVAL_MINUTES` background interval).
5. **Command Center Dashboard** — Active RFQ queue, pending approvals, verified savings across complete bids, and item price memory alerts.
6. **RFQ Creation & BOM Import** — Sequential `RFQ-YYYY-XXXX` creation per organization, multi-line BOM entry, CSV/clipboard BOM paste, and catalog auto-linking.
7. **Supplier Invitation Copy Generator** — Ready-to-send email/WhatsApp RFQ invitation text for selected suppliers.
8. **Multi-Format Quotation Ingestion** — PDF, Excel, CSV, image uploads (up to 25 MB, magic-byte validated), plus email/WhatsApp text paste.
9. **Gemini Structured Extraction** — Server-side extraction using `@google/genai` (`gemini-4-hydrogen`) with strict JSON schema, timeout/retry handling, and zero-fabrication rules.
10. **Deterministic Arithmetic Audit** — Server-side verification of `qty × rate - discount` (pre-tax and post-tax) within `max(1.5, 0.5%)` tolerance, blocking verification if discrepancies remain.
11. **Source-Document Traceability** — Split-screen audit workbench linking extracted values to private signed PDF/image previews, spreadsheet sheet/cell coordinates, or text snippets.
12. **Commercial & Tax Normalization** — UOM conversion multipliers, tax-inclusive vs. tax-exclusive unwinding, creditable vs. non-creditable tax (ITC/VAT), pro-rata freight/P&F/discount allocation, and FX conversion.
13. **Side-by-Side Comparison Matrix & Split Award** — Normalized `L1`/`L2`/`L3` ranking strictly across 100%-complete, math-valid, human-verified quotes (`src/lib/ranking.ts`), plus per-line split-award simulation.
14. **Approval Workflow, Item Price Memory & Exports** — Mandatory non-L1 justification, server-enforced approval RBAC, immutable audit trail, automatic Item Price Memory updates, and landscape PDF + 4-sheet Excel exports.

## Tech Stack

- **Frontend:** React 19, TypeScript, Vite 8, Tailwind CSS v4, Lucide Icons, Firebase Client SDK (`GoogleAuthProvider`), `jspdf`, `jspdf-autotable`, `xlsx`
- **Backend:** Express 4 (`server.ts`), Drizzle ORM + PostgreSQL (`pg`), `firebase-admin`, Multer 2, `@google/genai` (`gemini-4-hydrogen`), `tsx`
- **Database:** Cloud SQL PostgreSQL 18.6 (`asia-southeast1`) with 17 relational tables (`src/db/schema.ts`), Drizzle migrations (`drizzle/`), and atomic PostgreSQL rate-limiting (`rate_limit_buckets`)
- **Object Storage:** AWS SigV4 S3-compatible provider (`Cloudflare R2` / `S3` / `MinIO`) or private local filesystem storage (`server/objectStorage.ts`)
- **Testing:** Node built-in test runner (`node:test` + `node:assert/strict`) executed via `tsx --test`

## Quick Start

1. **Install dependencies:**
   ```bash
   npm install
   ```
2. **Configure environment (see [Configuration Reference](docs/CONFIGURATION.md)):**
   Set PostgreSQL connection variables (`SQL_HOST`, `SQL_USER`, `SQL_PASSWORD`, `SQL_DB_NAME`), `SESSION_SECRET` (>= 32 chars, required in production), and `GEMINI_API_KEY` (required for live AI extraction).
3. **Push Drizzle schema & inspect/bootstrap migrated organization ownership:**
   ```bash
   npx drizzle-kit push
   npm run db:migrate -- --dry-run
   npm run db:migrate -- --apply
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
