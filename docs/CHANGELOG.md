# Changelog

## Task 004 — Production Operations, Integration Completion & Operational Readiness

### Added
- **First-Owner Bootstrap Tooling (`server/ownerBootstrap.ts`, `scripts/bootstrap-org-owner.ts`):** Added `inspectOrganizationOwnership`, `bootstrapFirstOwnerDirect`, and `issueFirstOwnerClaimToken` with transactional `activeOwnerCount === 0` enforcement (`409` when owner already exists) and audit logging (`OWNER_CLAIM_TOKEN_ISSUED`, `FIRST_OWNER_BOOTSTRAPPED`) to safely link an authorized founder to migrated `org-kalyani-hydraulics`.
- **Scheduled Maintenance Runner (`server/maintenance.ts`, `scripts/run-maintenance.ts`):** Added idempotent, bounded-batch cleanup (`batchSize = 500`) across expired/old-revoked sessions, expired/terminal invitations, expired user verification/reset token hashes (preserving user rows), expired `rate_limit_buckets`, orphaned unreferenced `stored_documents` (>1h grace), and stale `.tmp` local storage files, plus optional background `MAINTENANCE_INTERVAL_MINUTES` scheduling in `server.ts`.
- **Operational Monitoring & Readiness (`server/monitoring.ts`, `server.ts`):** Added `X-Request-Id` correlation middleware, secret-redacted structured JSON request/error logs, `ErrorTrackerHook` / `ERROR_WEBHOOK_URL` webhook dispatch, and split liveness (`GET /api/health`) vs. dependency readiness (`GET /api/health/ready`).
- **Task 004 Automated Suites (`tests/opsAndMonitoring.test.ts`, `tests/e2eWorkflow.test.ts`):** Added automated verification for Resend retries/timeout/redaction, token expiry/reuse, Google existing-user invites & unverified-link rejection, first-owner bootstrap, scheduled maintenance, monitoring/readiness, and a complete 20-step end-to-end multi-tenant procurement workflow + cross-tenant isolation.

### Changed / Fixed
- **Google OAuth Hardening (`src/lib/firebase.ts`, `server/firebase-admin.ts`, `server/pgStore.ts`, `src/components/AuthView.tsx`, `server.ts`):** Enforced minimal scopes (`openid`, `email`, `profile`), `verifyIdToken(idToken, true)` revocation check + explicit `aud`/`iss` validation, `emailVerified === true` guard before linking Google UID onto existing password accounts, invitation acceptance for existing users on Google login, friendly Firebase popup/domain error handling, and `Cross-Origin-Opener-Policy: same-origin-allow-popups`.
- **Email & Storage Hardening (`server/emailService.ts`, `server/objectStorage.ts`):** Added `ResendEmailProvider` 10s `AbortController` timeout, bounded exponential retries on `429`/`5xx`, `isValidSenderAddress()` check, `getStatus()`, and `checkReadiness()` on both `LocalPrivateStorageProvider` and `S3CompatibleStorageProvider`.
- **Expanded Secret Scrubbing (`server/security.ts`):** Hardened `redactSensitiveText` to scrub `Bearer` tokens, `re_live_`/`re_test_`/`AIza*` keys, and `secretAccessKey`/`password`/`apiKey` parameter strings.

---

## Task 003 — Secure Multi-Tenant SaaS Foundation

### Added
- **Database & Schema (`src/db/schema.ts`, `src/db/index.ts`, `src/db/drizzle.config.ts`, `drizzle/`):** Provisioned Cloud SQL PostgreSQL (`asia-southeast1`) with 17 relational tables and atomic PostgreSQL rate-limiting (`rate_limit_buckets`).
- **Server-Verified Authentication (`server/security.ts`, `server/firebase-admin.ts`, `src/lib/firebase.ts`):** Dual Email/Password (`crypto.scrypt`) and Firebase Google Sign-In with revocable PostgreSQL sessions and CSRF validation.
- **Multi-Tenancy, RBAC & Private Object Storage (`server/rbac.ts`, `server/pgStore.ts`, `server/objectStorage.ts`):** Organization-scoped persistence, 5-role RBAC, invitations, `S3CompatibleStorageProvider` / `LocalPrivateStorageProvider`, and idempotent legacy JSON migration (`npm run db:migrate`).

---

## Task 002 — Reliability, Security, Testing & Documentation Pass

### Added
- Shared deterministic ranking (`src/lib/ranking.ts`), upload magic-byte inspection (`server/fileSecurity.ts`), initial test suites, and documentation under `docs/`.
