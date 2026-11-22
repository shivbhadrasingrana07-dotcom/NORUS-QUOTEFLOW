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
|  - Gemini Extraction & XLSX Parser (server/geminiExtractor.ts)         |
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
   - Passwords hashed with Node `crypto.scrypt` + 16-byte salt; tokens stored exclusively as `SHA-256` hashes; password reset revokes all active user sessions.
   - Google Sign-In uses minimal OAuth scopes (`openid`, `email`, `profile`) with `prompt: 'select_account'`. `verifyFirebaseIdToken` calls `adminAuth.verifyIdToken(idToken, true)` (`checkRevoked=true`) and validates `aud` and `iss` against `firebase-applet-config.json`. Linking an existing password account requires `email_verified === true`.
2. **Multi-Tenancy, 5-Role RBAC & First-Owner Bootstrap (`server/pgStore.ts`, `server/rbac.ts`, `server/ownerBootstrap.ts`):**
   - Every procurement domain row is scoped by `organization_id`.
   - Migrated owner-less organizations (such as `org-kalyani-hydraulics`) require explicit operator/founder bootstrap via `scripts/bootstrap-org-owner.ts`, which transactionally verifies `activeOwnerCount === 0` before either issuing an email-locked one-time claim token or promoting a verified registered user.
3. **Operational Monitoring & Scheduled Maintenance (`server/monitoring.ts`, `server/maintenance.ts`):**
   - Requests receive a validated or generated `X-Request-Id` header propagated in structured JSON logs and error responses.
   - Unhandled `500` errors emit redacted `unhandled_server_error` events and trigger `ErrorTrackerHook` / `ERROR_WEBHOOK_URL` while returning `{ error: 'Internal server error.', requestId }` to clients.
   - `runScheduledMaintenance` runs bounded batches (`500` rows/run) to clean expired/old-revoked sessions, expired/old-terminal invitations, expired verification/reset token hashes (preserving user rows), expired `rate_limit_buckets`, orphaned unreferenced `stored_documents` (>1h grace window), and stale `.tmp` local storage artifacts.

## Private Object Storage Strategy & Cost Comparison

| Provider Option | Multi-Replica Safe | Free / Low-Cost Tier Characteristics | Estimated Cost (10 GB docs / 50k downloads) | Operational Trade-Off |
| :--- | :--- | :--- | :--- | :--- |
| `LocalPrivateStorageProvider` (`STORAGE_PROVIDER=local`) | No (single container filesystem) | Free on local disk | $0/mo (bound to instance disk) | Suitable for single-node dev/pilot only; files lost on stateless container redeploy without persistent volume |
| **Cloudflare R2** (`STORAGE_PROVIDER=s3`) | **Yes** | Generous free tier (up to 10 GB/mo storage, zero egress fees) | **~$0–$1/mo** for early SME pilot | Best SME unit economics (zero egress fees when buyers preview PDFs repeatedly); native AWS SigV4 compatible |
| **AWS S3 / GCS (S3 Interop)** (`STORAGE_PROVIDER=s3`) | **Yes** | Pay-per-GB storage + request + internet egress charges | **~$1.50–$5/mo** for 10 GB + egress | Standard enterprise option; incurs per-GB internet egress charges for frequent document downloads |

## Cloud SQL Database Operations, Backup/Recovery & Monthly Cost Estimates (`asia-southeast1`)

### Pool, Schema & Integrity Posture (Verified on Live PostgreSQL 18.6)
- **Connection Pooling (`src/db/index.ts`):** Lazy singleton `pg.Pool` (`max: 10`, `connectionTimeoutMillis: 15000`) connecting via Cloud SQL Unix socket (`/app/cloudsql/...`) in managed runtime or TCP/SSL (`SQL_SSL=true`).
- **Constraints & Indexes:** All 17 tables enforce primary keys, `organization_id` foreign keys, unique constraints (`users.email`, `organizations.slug`, `rfqs(organization_id, rfq_number)`, `organization_memberships(organization_id, user_id)`), and `ON DELETE RESTRICT` guards on `award_allocations` referencing approved quotations.

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
   - Schema changes are additive via Drizzle migrations (`drizzle/`). Before applying breaking schema changes, take a Cloud SQL on-demand backup; rollback by restoring a clone instance from backup or PITR timestamp rather than running destructive `DROP` scripts in place.

### Estimated Monthly Cloud SQL Cost (`asia-southeast1` Planning Estimates)
*Note: Indicative GCP Cloud SQL PostgreSQL planning ranges for `asia-southeast1` (not live billing invoices); verify exact SKU pricing in GCP Pricing Calculator before provisioning.*

| Stage | Recommended Tier & Sizing | Est. Monthly Cost (`asia-southeast1`) | Operational Notes |
| :--- | :--- | :--- | :--- |
| **Development / Sandbox** | `db-f1-micro` (shared vCPU, 0.6 GB RAM) or Developer Sandbox, 10 GB SSD, single zone | **~$10–$20 / mo** *(if dedicated)* | Sandbox/dev tiers may expire or scale down; no production HA SLA |
| **Small Pilot (5–25 SMEs)** | Enterprise `db-g1-small` or `db-custom-1-3840` (1 vCPU, 3.75 GB RAM), 20 GB SSD + PITR backups, single zone | **~$55–$90 / mo** | Enables reliable PITR (7-day WAL), automated daily snapshots, and concurrent AI extraction pooling |
| **Early Commercial (50–250 SMEs)** | Enterprise `db-custom-2-7680` (2 vCPU, 7.68 GB RAM), Regional HA, 50–100 GB SSD + PITR + backup storage | **~$190–$320 / mo** | Regional high-availability standby failover, dedicated IOPS, and zero-downtime maintenance windows |
