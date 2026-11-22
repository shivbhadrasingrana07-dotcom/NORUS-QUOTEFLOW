# Architecture

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
|  - Security Headers, Strict CORS Allowlist, Multer 25 MB Limit         |
|  - Session Middleware (SHA-256 cookie token -> PostgreSQL lookup)      |
|  - 5-Role RBAC & CSRF Guards (server/rbac.ts, server/security.ts)      |
|  - PostgreSQL Atomic Rate Limiter (server/rateLimiter.ts)              |
|  - File Magic-Byte Inspection (server/fileSecurity.ts)                 |
|  - Gemini Extraction & XLSX Parser (server/geminiExtractor.ts)         |
|  - Normalization & Arithmetic Audit (server/normalization.ts)          |
|  - Transactional Multi-Tenant Store (server/pgStore.ts -> Drizzle)     |
+---------------------+-------------------------------+------------------+
                      |                               |
                      v                               v
+-----------------------------------+   +--------------------------------+
| Cloud SQL PostgreSQL (drizzle)    |   | Private Object Storage         |
|  - 17 relational tables           |   |  - S3-compatible (AWS SigV4)   |
|  - Strict organization_id scoping |   |  - Local private dir fallback  |
|  - rate_limit_buckets             |   |  - Short-lived signed URLs     |
+-----------------------------------+   +--------------------------------+
```

## Key Architecture & Cost Decisions

### 1. Dual Server-Verified Authentication (`server/security.ts`, `server/firebase-admin.ts`, `server/pgStore.ts`)
- **Email/Password:** Passwords hashed using Node `crypto.scrypt` with random 16-byte salt and timing-safe comparison (`crypto.timingSafeEqual`). Verification & password-reset tokens are opaque 256-bit random tokens stored solely as `SHA-256` hashes. Resetting a password revokes all active user sessions.
- **Google Sign-In:** Client signs in with `firebase/auth` `GoogleAuthProvider` (`src/lib/firebase.ts`) and submits the short-lived Firebase ID token to `POST /api/auth/google`, where `firebase-admin` (`verifyFirebaseIdToken`) verifies signature, audience, and issuer before issuing an `HttpOnly`, `SameSite=Lax` (`Secure` in production) `nf_session` cookie.
- **CSRF Protection:** State-changing authenticated endpoints (`POST`/`PATCH`/`DELETE`) verify the `X-CSRF-Token` request header against the active PostgreSQL session's `csrf_token` via `crypto.timingSafeEqual`.
- **Disabled Sandbox Switcher:** `POST /api/demo/switch-persona` returns `410 Gone`.

### 2. Multi-Tenancy & 5-Role RBAC (`server/rbac.ts`, `server/pgStore.ts`)
Every domain table carries a non-null `organization_id` foreign key. All reads, mutations, verification actions, award decisions, and document downloads filter strictly by `req.auth.activeOrganization.id`, enforced in `PgDataStore`.
- **Roles:** `owner`, `admin`, `buyer`, `approver`, `viewer`.
- **Last-Owner Guard:** Demoting or removing the last active `owner` of an organization is rejected with `409 Conflict`.

### 3. Private Object Storage (`server/objectStorage.ts`)
- Uploaded quotation PDFs and images are never stored in `public/` or returned inline as Base64 data URLs (`skipInlineDataUrl: true`).
- Storage keys follow `orgs/<orgId>/docs/<docId>/<safeFilename>` after path-traversal sanitization.
- **Providers:** `S3CompatibleStorageProvider` (dependency-free AWS SigV4 implementation compatible with Cloudflare R2 free tier, AWS S3, or MinIO) or `LocalPrivateStorageProvider` under `data/private-storage/` (outside static webroot).
- Preview requests call `GET /api/documents/:docId/signed-url` (tenant-verified) to obtain a short-lived (300s) HMAC-signed or S3 presigned download URL.

### 4. PostgreSQL-Backed Persistence & Rate Limiting (`src/db/index.ts`, `server/rateLimiter.ts`)
- **Cloud SQL PostgreSQL (`asia-southeast1`):** Managed via Drizzle ORM (`drizzle-orm/node-postgres`) with `pg.Pool` (`SQL_HOST`, `SQL_USER`, `SQL_PASSWORD`, `SQL_DB_NAME`) and lazy connection initialization.
- **PostgreSQL Rate Limiting:** `PostgresRateLimitStore` uses a single atomic `INSERT ... ON CONFLICT (bucket_key) DO UPDATE` statement in `rate_limit_buckets`, eliminating the need for a separate Redis cluster while working reliably across multiple Node instances.

### 5. Deterministic Normalization, Shared Ranking & Gemini Pipeline
- `server/normalization.ts` performs deterministic UOM conversion, GST/VAT inclusive unwinding, ITC credit exclusion, FX conversion, and pro-rata overhead allocation.
- `src/lib/ranking.ts` restricts `L1`/`L2`/`L3` ranks to 100%-complete, math-valid, human-verified quotes.
- `server/geminiExtractor.ts` runs `@google/genai` (`gemini-4-hydrogen`) with a 45s timeout, bounded `429`/`503` retries, and secret redaction.
