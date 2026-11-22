# Changelog

## Task 003 — Secure Multi-Tenant SaaS Foundation

### Added
- **Database & Schema (`src/db/schema.ts`, `src/db/index.ts`, `src/db/drizzle.config.ts`, `drizzle/`):** Provisioned Cloud SQL PostgreSQL (`asia-southeast1`) with 17 relational tables (`users`, `organizations`, `organization_memberships`, `invitations`, `sessions`, `suppliers`, `catalog_items`, `price_history`, `rfqs`, `rfq_items`, `stored_documents`, `quotations`, `quotation_lines`, `awards`, `award_allocations`, `audit_logs`, `rate_limit_buckets`), strict `organization_id` foreign keys, and lazy `pg.Pool` initialization.
- **Server-Verified Authentication (`server/security.ts`, `server/firebase-admin.ts`, `src/lib/firebase.ts`):**
  - Dual real authentication: Email/Password (`crypto.scrypt` hashing, email verification tokens, password reset revoking existing sessions) and Firebase Google Sign-In (`firebase-admin` `verifyFirebaseIdToken`).
  - Revocable PostgreSQL sessions (`nf_session` `HttpOnly` cookie) paired with `X-CSRF-Token` timing-safe validation.
- **Multi-Tenancy, RBAC & Invitations (`server/rbac.ts`, `server/pgStore.ts`):**
  - `PgDataStore` transactional store scoping every query/mutation by `organizationId`.
  - 5 roles (`owner`, `admin`, `buyer`, `approver`, `viewer`), team invitations, role assignment hierarchy, and last-owner protection (`409`).
- **Private Object Storage (`server/objectStorage.ts`):** `ObjectStorageProvider` abstraction with `S3CompatibleStorageProvider` (AWS SigV4) and `LocalPrivateStorageProvider` (`data/private-storage/`) + HMAC/SigV4 signed `/api/documents/:docId/signed-url` and `/api/documents/:docId/content`.
- **PostgreSQL Rate Limiting & Email Service (`server/rateLimiter.ts`, `server/emailService.ts`):** Atomic `PostgresRateLimitStore` (`rate_limit_buckets`), `MemoryRateLimitStore`, and `ResendEmailProvider` / `DevOutboxEmailProvider`.
- **Legacy Migration (`server/legacyMigration.ts`, `scripts/migrate-json-to-postgres.ts`):** Idempotent `--dry-run` / `--apply` CLI migrating `data/quoteflow-db.json` into PostgreSQL with timestamped backups and Base64-to-object-storage extraction.
- **Frontend Auth & Org UX (`src/components/AuthView.tsx`, `src/components/OrganizationView.tsx`):** Sign-In/Registration/Reset/Invite flows, multi-org switcher, team & invitation management, active session revocation, and signed private document preview loading in `ExtractionReviewPane.tsx`.
- **Expanded Integration Tests (`tests/authAndMultiTenancy.test.ts`, `tests/objectStorageAndRateLimit.test.ts`, `tests/apiAndDb.test.ts`):** Full coverage for auth, CSRF/CORS, brute-force rate limiting, cross-tenant blocking, RBAC, private object storage, and legacy migration.

### Changed / Fixed
- `server.ts`: Replaced single-tenant JSON persistence and `/api/demo/switch-persona` (`410 Gone`) with PostgreSQL `PgDataStore`, session/CSRF middleware, strict CORS allowlist, rate limiters, and private document routes.
- `server/geminiExtractor.ts`: Added `skipInlineDataUrl` option so uploaded quotation binaries go exclusively to private object storage (`stored_documents`) rather than inline database Base64 strings.
- `src/components/Sidebar.tsx`, `SecondaryViews.tsx`, `App.tsx`: Removed sandbox persona switcher and client role overrides; wired authenticated `/api/auth/me`, `X-CSRF-Token`, and `OrganizationView`.

---

## Task 002 — Reliability, Security, Testing & Documentation Pass

### Added
- `src/lib/ranking.ts`: Shared `rankQuotations` and `computeEvaluatedSavings`.
- `server/fileSecurity.ts`: Upload filename sanitization and magic-byte validation.
- Automated tests in `tests/normalization.test.ts`, `tests/extractionValidation.test.ts`, `tests/apiAndDb.test.ts`, and `tests/exporters.test.ts`.
- Initial project documentation in `README.md` and `docs/*.md`.

### Changed / Fixed
- Hardened `server/normalization.ts`, `server/geminiExtractor.ts`, `src/lib/exporters.ts`, and React input buffering across `ExtractionReviewPane.tsx` and `ComparisonMatrixPane.tsx`.
