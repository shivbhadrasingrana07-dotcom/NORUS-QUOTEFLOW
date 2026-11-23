# Security Posture, Architecture & Operational Boundaries

## Implemented Security Controls

1. **Dual Real Server-Verified Authentication (`server/security.ts`, `server/firebase-admin.ts`, `server/pgStore.ts`, `src/lib/firebase.ts`):**
   - Passwords hashed with Node `crypto.scrypt` (`N=16384`, `r=8`, `p=1`) and random 16-byte per-user salts, compared via `crypto.timingSafeEqual`.
   - Password complexity enforced server-side (8–128 chars, requires letter + number).
   - Email verification tokens and password-reset tokens use 256-bit random values stored exclusively as `SHA-256` hashes, enforced one-time with expiration checks; password reset revokes all active user sessions.
   - Google Sign-In uses minimal scopes (`openid`, `email`, `profile`), popup/domain error translation (`src/components/AuthView.tsx`), and server-side verification via `firebase-admin` (`verifyIdToken(idToken, FIREBASE_CHECK_REVOKED === 'true')`, validating Google X.509 certificate signature, `exp`, `aud`, and `iss` before exchanging for a revocable PostgreSQL `nf_session`). Linking a Google UID onto an existing password account requires `email_verified === true` (`403` otherwise).
   - `POST /api/demo/switch-persona` is permanently disabled (`410 Gone`), and `PATCH /api/settings` ignores client-supplied role properties.

2. **Session Management & CSRF Protection (`server.ts`, `server/security.ts`):**
   - `nf_session` cookie carries a 256-bit opaque token stored as `SHA-256` in PostgreSQL `sessions` (revocable individually or globally), flagged `HttpOnly`, `SameSite=Lax` (or `None; Secure` over HTTPS), and `Secure` in production (`NODE_ENV=production`).
   - All authenticated `POST`, `PATCH`, and `DELETE` requests enforce timing-safe comparison of `X-CSRF-Token` against the active session's `csrf_token` (`403` if missing or invalid).
   - `getSigningSecret()` fails closed in production if `SESSION_SECRET` is unset or shorter than `32` characters.

3. **Strict Multi-Tenant Isolation, 5-Role RBAC & Safe First-Owner Bootstrap (`server/rbac.ts`, `server/pgStore.ts`, `server/ownerBootstrap.ts`):**
   - Every organization resource (`suppliers`, `catalog_items`, `rfqs`, `quotations`, `stored_documents`, `awards`, `audit_logs`) is keyed by `organization_id`.
   - Cross-tenant reads, updates, deletes, award decisions, or document downloads return `404` or `403`.
   - 5 roles enforced on the server: `owner`, `admin`, `buyer`, `approver`, `viewer`, plus last-owner protection (`409` on demotion/removal of the sole owner).
   - Owner-less migrated organizations (`org-kalyani-hydraulics`) require explicit operator/founder bootstrap via `npm run org:bootstrap-owner`, which blocks reassignment (`409`) if an active owner already exists.

4. **Private Object Storage & Signed Document Access (`server/objectStorage.ts`):**
   - Binary files are stored outside public directories (`data/private-storage/` locally or private S3-compatible bucket).
   - Document keys are path-sanitized (`orgs/<orgId>/docs/<docId>/<safeFilename>`).
   - Download URLs expire after 300 seconds and verify either HMAC-SHA256 tokens (`documentId:organizationId:exp`) or AWS SigV4 presigned URLs.

5. **Upload Magic-Byte & Spreadsheet Sanitization (`server/fileSecurity.ts`, `src/lib/exporters.ts`):**
   - 25 MB Multer limit (`413`), active/executable/macro extension blocklist, magic-byte inspection (`415` on mismatch), and Excel/CSV formula injection escaping (`sanitizeSpreadsheetCell`).

6. **PostgreSQL Rate Limiting, Strict CORS, Headers & Secret Scrubbing (`server/rateLimiter.ts`, `server/monitoring.ts`, `server.ts`):**
   - Atomic `rate_limit_buckets` protection on auth endpoints (`authRateLimiter`), AI extraction (`extractRateLimiter`), and general mutations (`mutationRateLimiter`), returning `429` with `Retry-After` headers.
   - Strict CORS allowlist (`req.headers.host`, `APP_URL`, `ALLOWED_ORIGINS`, plus `localhost`/`127.0.0.1` in non-production); untrusted origins rejected with `403`.
   - Security headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Cross-Origin-Opener-Policy: same-origin-allow-popups`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cross-Origin-Resource-Policy: same-origin`, `Permissions-Policy`, and production `Strict-Transport-Security`.
   - `redactSensitiveText` strips configured secret env values plus `Bearer` tokens, `re_live_`/`re_test_`/`AIza*` keys, and `password`/`apiKey`/`secretAccessKey` parameter patterns from logs, errors, and webhook notifications.

## Operational Requirements for Public Internet Deployment

1. **Secrets Required in Production (`NODE_ENV=production`):** Set a cryptographically random `SESSION_SECRET` (>= 32 characters), `GEMINI_API_KEY`, and `ALLOWED_ORIGINS` / `APP_URL`.
2. **Firebase Authorized Domains:** Add every production/staging hostname (Cloud Run `*.run.app` and custom domains) under Firebase Auth → Settings → Authorized Domains so Google Sign-In popups succeed in end-user browsers.
3. **Multi-Replica Object Storage:** Configure `STORAGE_PROVIDER=s3` (`S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`) rather than local container filesystem storage if running multiple backend instances.
4. **Outbound Transactional Email:** Configure `RESEND_API_KEY` and a domain-verified `EMAIL_FROM` (`SPF`/`DKIM`) so verification, password reset, and organization invitation links deliver externally instead of queuing in `DevOutboxEmailProvider`.
5. **Founder Ownership Claim for `org-kalyani-hydraulics`:** Run `npm run org:bootstrap-owner -- --org-id=org-kalyani-hydraulics --issue-token --email="<founder-email>"` (or `--claim-direct`) once the authorized founder email is designated.
6. **Safe Production `DEMO_MODE` Enforcement:** In `NODE_ENV=production`, `DEMO_MODE` defaults to **OFF (`false`)**, disabling `/api/demo-workspace*` (`410 Gone`) so only authenticated multi-tenant workspaces operate. Setting `DEMO_MODE="true"` in production fails closed on server boot (`resolveDemoMode()`).

## Temporary Demo Workspace Isolation (Task 006 / Hardened Task 007)

- When `demoModeEnabled` is active in non-production environments (`NODE_ENV !== 'production'` and `DEMO_MODE !== 'false'`), unauthenticated visitors land directly in an isolated synthetic sandbox backed exclusively by `server/demoWorkspace.ts` (`demo-org-synthetic`).
- **Zero Database / Customer Leakage:** `DemoWorkspaceStore` holds no Cloud SQL connection, no reference to `server/pgStore.ts`, `server/seedData.ts` (`org-kalyani-hydraulics`), or `server/objectStorage.ts`, and `/api/demo-workspace*` routes use dedicated bounded `MemoryRateLimitStore` instances (never writing `rate_limit_buckets` in Cloud SQL). All real `/api/workspace`, `/api/rfqs`, `/api/suppliers`, `/api/documents/*`, and `/api/organizations/*` routes continue enforcing `401 Unauthorized`, CSRF, and RBAC.
- **Per-Visitor Memory Isolation & Bounds:** Each visitor receives a scoped `nf_demo_sid` / `X-Demo-Session` session capped at 120 LRU sessions (`maxSessions`), 25 uploaded documents / 30 MB per session (`413`), and 30 RFQs per session (`400`). Signed preview lookups require an existing active session (`hasSession`, returning `404` without allocating/evicting sessions on unknown IDs) and session-bound HMAC signatures (`demo:${docId}:${demoSessionId}:${exp}`).
