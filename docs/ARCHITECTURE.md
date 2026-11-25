# Architecture, Operations & Cost Assessment

NORUS QUOTEFLOW is a multi-tenant TypeScript full-stack SaaS web application served by Express on port `3000` (with Vite middleware in development and `dist/` static serving in production).

## System Overview

```text
+------------------------------------------------------------------------+
| React 19 SPA (src/)                                                    |
|  - AuthView (Email/Password, Google Sign-In popup, Reset, Invite URL)  |
|  - OrganizationView (Org Switcher, Team Roles, Invites, Sessions)      |
|  - Command Center, RFQ List, RFQ Workspace, Suppliers, Price Memory    |
|  - ExtractionReviewPane (Signed Private Doc Previews + Buffered Edits) |
|  - ComparisonMatrixPane (shared rankQuotations + split award)          |
|  - Exporters (src/lib/exporters.ts -> jsPDF + SheetJS XLSX)            |
+-----------------------------------+------------------------------------+
                                    | HTTPS Cookies (nf_session) + X-CSRF-Token
                                    v
+------------------------------------------------------------------------+
| Express Server (server.ts -> createApp)                                |
|  - Correlation IDs (X-Request-Id), Redacted JSON Logs, Error Webhook   |
|  - Security Headers, COOP Popup Support, Strict CORS, 25 MB Multer     |
|  - Liveness (GET /api/health) & Readiness (GET /api/health/ready)      |
|  - Session Middleware (SHA-256 cookie token -> PostgreSQL lookup)      |
|  - 5-Role RBAC & CSRF Guards (server/rbac.ts, server/security.ts)      |
|  - PostgreSQL Atomic Rate Limiter (server/rateLimiter.ts)              |
|  - File Magic-Byte Inspection (server/fileSecurity.ts)                 |
|  - Isolated Spreadsheet Worker (server/spreadsheetWorker.mjs, 128 MB)  |
|  - Gemini Extraction (server/geminiExtractor.ts)                        |
|  - Normalization & Arithmetic Audit (server/normalization.ts)          |
|  - Transactional Store (server/pgStore.ts) & Maintenance Job           |
+---------------------+-------------------------------+------------------+
                      |                               |
                      v                               v
+-----------------------------------+   +--------------------------------+
| Cloud SQL PostgreSQL 18.6         |   | Private Object Storage         |
|  - 17 relational tables           |   |  - S3-compatible (AWS SigV4)   |
|  - Strict organization_id scoping |   |  - Local private dir fallback  |
|  - rate_limit_buckets             |   |  - Short-lived signed URLs     |
+-----------------------------------+   +--------------------------------+
```

## Core Architecture Modules

1. **Dual Server-Verified Authentication (`server/security.ts`, `server/firebase-admin.ts`, `src/lib/firebase.ts`):**
   - Passwords hashed with Node `crypto.scrypt` + 16-byte salt; tokens stored exclusively as `SHA-256` hashes; password reset revokes all active user sessions; `createSessionTx` caps active sessions at `10` per user by revoking oldest sessions beyond the cap.
   - Google Sign-In uses minimal OAuth scopes (`openid`, `email`, `profile`) with `prompt: 'select_account'`. `verifyFirebaseIdToken` defaults `checkRevoked` to `false` (opt-in via `FIREBASE_CHECK_REVOKED=true`), validates Google X.509 RS256 signature, `exp`, `aud`, and `iss` against `firebase-applet-config.json`, and checks readiness dynamically via `isGoogleAuthConfigured()`. Linking an existing password account requires `email_verified === true`.
2. **Multi-Tenancy, 5-Role RBAC & First-Owner Bootstrap (`server/pgStore.ts`, `server/rbac.ts`, `server/ownerBootstrap.ts`):**
   - Every procurement domain row is scoped by `organization_id`, reinforced by composite same-organization foreign keys and functional uniqueness indexes in `drizzle/0001_tenant_integrity.sql` (see `docs/DATABASE_SCHEMA.md` for the documented `price_history` exception). `audit_logs` immutability is **application-enforced** (insert-only store helpers).
   - Migrated owner-less organizations (such as `org-kalyani-hydraulics`) require explicit operator/founder bootstrap via `scripts/bootstrap-org-owner.ts`, which acquires a `FOR UPDATE` lock on the `organizations` row inside a transaction before verifying `activeOwnerCount === 0`.
3. **Operational Monitoring, Storage Timeouts, Security Headers & Scheduled Maintenance (`server/monitoring.ts`, `server/objectStorage.ts`, `server/maintenance.ts`, `server.ts`):**
   - Requests receive a validated or generated `X-Request-Id` header propagated in structured JSON logs and error responses. Express configures `trust proxy` via `resolveTrustProxySetting()` (`TRUST_PROXY_HOPS`, defaulting to `1` hop; `false` when `0`) so rate limiters derive client IP safely via `req.ip` rather than raw `X-Forwarded-For`.
   - `server.ts` emits a strict `Content-Security-Policy` / `Content-Security-Policy-Report-Only` header built via `buildProductionCspPolicy()` (no `*` wildcards, no `'unsafe-eval'`, Firebase/Google auth popup origins scoped explicitly; defaults to `report-only` in `NODE_ENV=production` or `CSP_MODE=report-only`, and enforces when `CSP_MODE=enforce`) alongside configurable `COOKIE_SAMESITE` (`resolveCookieSameSite()`).
   - `S3CompatibleStorageProvider` enforces `AbortController` timeouts (`15s` object ops / `5s` readiness probe).
   - Unhandled `500` errors emit redacted `unhandled_server_error` events and trigger `ErrorTrackerHook` / `ERROR_WEBHOOK_URL` while returning `{ error: 'Internal server error.', requestId }` to clients.
   - `runScheduledMaintenance` uses a dedicated-connection PostgreSQL advisory lock (`pg_try_advisory_lock`) to prevent concurrent overlap, runs bounded batches (`500` rows/run), and deletes unreferenced `stored_documents` DB rows **only after** `storageProvider.deleteObject` succeeds (retaining DB rows on storage error for retry).
4. **Isolated Spreadsheet Ingestion (`server/spreadsheetWorker.mjs`, `server/geminiExtractor.ts`):**
   - CSV/TSV uploads bypass `xlsx` completely via a native RFC-4180 parser; `.xlsx`/`.xls` files undergo ZIP container inspection (ZIP bomb, path traversal, and `vbaProject.bin` rejection) and bounded extraction inside an ephemeral child process (`--max-old-space-size=128`, `5s` timeout, secret-stripped `env`) invoked by both authenticated Gemini extraction and offline demo parsing.
5. **Award Revision, Split-Item Precision & Lock Ordering (`src/lib/ranking.ts`, `src/lib/awardValidation.ts`, `server/pgStore.ts`, `server/demoWorkspace.ts`):**
   - `getAllocationTolerance(targetQty)` enforces `1e-6` allocation precision (using Kahan summation via `sumExactQuantities`) and supports multi-supplier splits on a single RFQ item while preserving historical `rejected` award rows, providing explicit `withdrawAward`, and serializing award vs. quotation mutations in PostgreSQL using strict `rfqs -> quotations -> awards` `FOR UPDATE` hierarchy.

## Private Object Storage Strategy & Cost Comparison

| Provider Option | Multi-Replica Safe | Free / Low-Cost Tier Characteristics | Estimated Cost (10 GB docs / 50k downloads) | Operational Trade-Off |
| :--- | :--- | :--- | :--- | :--- |
| `LocalPrivateStorageProvider` (`STORAGE_PROVIDER=local`) | No (single container filesystem) | Free on local disk | $0/mo (bound to instance disk) | Suitable for single-node dev/pilot only; files lost on stateless container redeploy without persistent volume |
| **Cloudflare R2** (`STORAGE_PROVIDER=s3`) | **Yes** | Generous free tier (up to 10 GB/mo storage, zero egress fees) | **~$0–$1/mo** for early SME pilot | Best SME unit economics (zero egress fees when buyers preview PDFs repeatedly); native AWS SigV4 compatible |
| **AWS S3 / GCS (S3 Interop)** (`STORAGE_PROVIDER=s3`) | **Yes** | Pay-per-GB storage + request + internet egress charges | **~$1.50–$5/mo** for 10 GB + egress | Standard enterprise option; incurs per-GB internet egress charges for frequent document downloads |

## Cloud SQL Database Operations, Backup/Recovery & Monthly Cost Estimates (`asia-southeast1`)

### Pool, Schema & Integrity Posture (Verified on Live PostgreSQL 18.6)
- **Connection Pooling (`src/db/index.ts`):** Lazy singleton `pg.Pool` (`max: 10`, `connectionTimeoutMillis: 15000`) configured via `buildPgSslConfig()`, connecting over Cloud SQL Unix socket (`/app/cloudsql/...`) in managed runtime or TCP TLS (`SQL_SSL=true`) enforcing `rejectUnauthorized: true` by default with optional `SQL_SSL_CA` (inline PEM or file path) and explicit `SQL_SSL_ALLOW_SELF_SIGNED=true` override.
- **Constraints & Indexes:** All 17 tables enforce primary keys, `organization_id` foreign keys, unique constraints (`users.email`, `organizations.slug`, `rfqs(organization_id, rfq_number)`, `organization_memberships(organization_id, user_id)`), and `ON DELETE RESTRICT` guards on `award_allocations` referencing historical `approved`, `pending`, and `rejected` award quotations.

### Backup, PITR & Rollback Runbook
1. **Managed Automated Backups & PITR (Production Requirement):**
   - Enable Cloud SQL automated daily backups (retain 7–14 days) and **Point-in-Time Recovery (WAL archiving, 7-day retention)** before onboarding paying tenants.
   - Cloud SQL Developer / Sandbox editions must **not** be treated as permanently free or production SLA-backed; upgrade to a dedicated Enterprise tier before production launch.
2. **Isolated Logical Backup & Restore Verification Procedure:**
   ```bash
   # Logical compressed dump of database schema & data without modifying production rows
   pg_dump --format=custom --no-owner --no-acl -h "$SQL_HOST" -U "$SQL_USER" -d "$SQL_DB_NAME" -f quoteflow_backup.dump

   # Verify restore into an isolated temporary schema or scratch database (never overwrite production!)
   pg_restore --list quoteflow_backup.dump
   pg_restore --dbname="$SCRATCH_DB_NAME" --no-owner --no-acl quoteflow_backup.dump
   ```
   - Never restore into the live database without taking a fresh pre-restore snapshot and verifying row counts (`organizations`, `rfqs`, `quotations`, `awards`) against `org-kalyani-hydraulics` and active tenant records.
3. **Migration Rollback Strategy:**
   - Schema changes use explicit SQL migrations under `drizzle/` (`0000_illegal_major_mapleleaf.sql`, `0001_tenant_integrity_preflight.sql`, `0001_tenant_integrity.sql`, and `0001_tenant_integrity_rollback.sql`). Before applying schema changes to Cloud SQL, run the preflight diagnostic query, take a Cloud SQL on-demand backup, and keep the corresponding rollback script ready alongside backup/PITR recovery.

### Estimated Monthly Cloud SQL Cost (`asia-southeast1` Planning Estimates)
*Note: Indicative GCP Cloud SQL PostgreSQL planning ranges for `asia-southeast1` (not live billing invoices); verify exact SKU pricing in GCP Pricing Calculator before provisioning.*

| Stage | Recommended Tier & Sizing | Est. Monthly Cost (`asia-southeast1`) | Operational Notes |
| :--- | :--- | :--- | :--- |
| **Development / Sandbox** | `db-f1-micro` (shared vCPU, 0.6 GB RAM) or Developer Sandbox, 10 GB SSD, single zone | **~$10–$20 / mo** *(if dedicated)* | Sandbox/dev tiers may expire or scale down; no production HA SLA |
| **Small Pilot (5–25 SMEs)** | Enterprise `db-g1-small` or `db-custom-1-3840` (1 vCPU, 3.75 GB RAM), 20 GB SSD + PITR backups, single zone | **~$55–$90 / mo** | Enables reliable PITR (7-day WAL), automated daily snapshots, and concurrent AI extraction pooling |
| **Early Commercial (50–250 SMEs)** | Enterprise `db-custom-2-7680` (2 vCPU, 7.68 GB RAM), Regional HA, 50–100 GB SSD + PITR + backup storage | **~$190–$320 / mo** | Regional high-availability standby failover, dedicated IOPS, and zero-downtime maintenance windows |
