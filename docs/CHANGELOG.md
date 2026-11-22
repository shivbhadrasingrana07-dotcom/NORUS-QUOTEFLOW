# Changelog

## Task 006 — Temporary No-Login Demo Experience (Non-Production)

### Added
- **Isolated Synthetic Demo Store (`server/demoWorkspace.ts`):** Created `DemoWorkspaceStore` serving a 100% synthetic sample procurement workspace (`demo-org-synthetic`, `Meridian Industrial Demo Works (Sample)`, `DEMO-RFQ-2026-101`, 4 `(Demo)` suppliers, 4 sample catalog items, PDF/Excel/email quotes with math-audit & missing-freight teaching scenarios, plus a historical approved award) scoped per visitor session in memory (`maxSessions = 120`) with zero Cloud SQL or `storageProvider` access.
- **Isolated Demo API Endpoints (`server.ts`):** Added `/api/demo-workspace*` routes (`GET`, `/reset`, `/settings`, `/rfqs`, `/rfqs/load-sample`, `/suppliers`, `/rfqs/:rfqId/quotes/extract`, `/quotations/*`, `/awards/*`, `/documents/:docId/signed-url`, `/documents/:docId/content`) gated by `DEMO_MODE !== "false"` (`410 Gone` when disabled). Added `demoMode` flag to `GET /api/auth/me` and `X-Demo-Session` to CORS allowed headers.
- **Demo Workspace UI & Banners (`src/App.tsx`, `src/components/Sidebar.tsx`, `src/components/SecondaryViews.tsx`, `src/components/RfqWorkspace.tsx`, `src/components/ExtractionReviewPane.tsx`):** Bypassed login/register/verification/reset screens when `demoMode === true`, landing visitors directly on the Command Center Dashboard with a prominent `DEMO ENVIRONMENT` top bar, `Reset Demo Data` action, and `DEMO WORKSPACE` sidebar indicator while hiding team/org switcher and sign-out controls.
- **Task 006 Automated Test Suite (`tests/demoWorkspace.test.ts`):** Verifies zero real-tenant leakage, `401` preservation on real endpoints, `410` on `/api/demo/switch-persona`, full isolated demo workflow, signed demo preview isolation, and `DEMO_MODE=false` restoration.

---

## Task 005 — Google Sign-In Failure Investigation & Resolution

### Fixed
- **Server-Side Firebase ID Token Verification (`server/firebase-admin.ts`):** Switched `adminAuth.verifyIdToken` from hardcoded `checkRevoked = true` to `process.env.FIREBASE_CHECK_REVOKED === 'true'` (default `false`). In AI Studio runtime containers, `checkRevoked = true` triggered an Identity Toolkit Admin API call using host-project ADC (`344782474303`) instead of the app's Firebase project (`favorable-emblem-zxq1s`), causing `identitytoolkit.googleapis.com is not enabled for Google Cloud project 344782474303`. Default certificate-based verification preserves full Google X.509 RS256 signature, `exp`, `aud`, and `iss` validation while exchanging tokens for revocable PostgreSQL `nf_session` records. Also updated `DecodedIdToken` to a type-only ESM import.
- **Client Auth Error Messaging (`src/components/AuthView.tsx`):** Added explicit friendly handling for `auth/operation-not-allowed`.
- **Regression Coverage (`tests/opsAndMonitoring.test.ts`):** Added test verifying default `checkRevoked=false`, optional `FIREBASE_CHECK_REVOKED=true`, `aud`/`iss` mismatch rejection, and `/api/auth/google` `401` behavior without Identity Toolkit host-project lookup errors.

---

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
