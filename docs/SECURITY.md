# Security Posture, Architecture & Operational Boundaries

## Implemented Security Controls

1. **Dual Real Server-Verified Authentication (`server/security.ts`, `server/firebase-admin.ts`, `server/pgStore.ts`):**
   - Passwords hashed with Node `crypto.scrypt` (`N=16384`, `r=8`, `p=1`) and random 16-byte per-user salts, compared via `crypto.timingSafeEqual`.
   - Password complexity enforced server-side (8–128 chars, requires letter + number/symbol).
   - Email verification tokens and password-reset tokens use 256-bit random values stored exclusively as `SHA-256` hashes; password reset revokes all active user sessions.
   - Google Sign-In ID tokens are verified server-side via `firebase-admin` (`verifyFirebaseIdToken`) using project configuration from `firebase-applet-config.json`.
   - `POST /api/demo/switch-persona` is permanently disabled (`410 Gone`), and `PATCH /api/settings` ignores client-supplied role properties.

2. **Session Management & CSRF Protection (`server.ts`, `server/security.ts`):**
   - `nf_session` cookie carries a 256-bit opaque token stored as `SHA-256` in PostgreSQL `sessions` (revocable individually or globally), flagged `HttpOnly`, `SameSite=Lax`, and `Secure` in production (`NODE_ENV=production`).
   - All authenticated `POST`, `PATCH`, and `DELETE` requests enforce timing-safe comparison of `X-CSRF-Token` against the active session's `csrf_token` (`403` if missing or invalid).
   - `getSigningSecret()` fails closed in production if `SESSION_SECRET` is unset or shorter than 24 characters.

3. **Strict Multi-Tenant Isolation & 5-Role RBAC (`server/rbac.ts`, `server/pgStore.ts`):**
   - Every organization resource (`suppliers`, `catalog_items`, `rfqs`, `quotations`, `stored_documents`, `awards`, `audit_logs`) is keyed by `organization_id`.
   - Cross-tenant reads, updates, deletes, award decisions, or document downloads return `404` or `403`.
   - 5 roles enforced on the server: `owner`, `admin`, `buyer`, `approver`, `viewer`, plus last-owner protection (`409` on demotion/removal of the sole owner).

4. **Private Object Storage & Signed Document Access (`server/objectStorage.ts`):**
   - Binary files are stored outside public directories (`data/private-storage/` locally or private S3-compatible bucket).
   - Document keys are path-sanitized (`orgs/<orgId>/docs/<docId>/<safeFilename>`).
   - Download URLs expire after 300 seconds and verify either HMAC-SHA256 tokens (`documentId:organizationId:exp`) or AWS SigV4 presigned URLs.

5. **Upload Magic-Byte & Spreadsheet Sanitization (`server/fileSecurity.ts`, `src/lib/exporters.ts`):**
   - 25 MB Multer limit (`413`), active/executable/macro extension blocklist, magic-byte inspection (`415` on mismatch), and Excel/CSV formula injection escaping (`sanitizeSpreadsheetCell`).

6. **PostgreSQL-Backed Rate Limiting, Strict CORS & HTTP Headers (`server/rateLimiter.ts`, `server.ts`):**
   - Atomic `rate_limit_buckets` protection on auth endpoints (`authRateLimiter`), AI extraction (`extractRateLimiter`), and general mutations (`mutationRateLimiter`), returning `429` with `Retry-After` headers.
   - Strict CORS allowlist (`req.headers.host`, `APP_URL`, `ALLOWED_ORIGINS`, plus `localhost`/`127.0.0.1` in non-production); untrusted origins rejected with `403`.
   - Security headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cross-Origin-Resource-Policy: same-origin`, `Permissions-Policy`, and production `Strict-Transport-Security`.
   - Secret & SQL error redaction (`redactSensitiveText`, centralized error handler returning generic `500` responses without stack traces or SQL payloads).

## Operational Requirements for Public Internet Deployment

1. **Secrets Required in Production (`NODE_ENV=production`):** Set a cryptographically random `SESSION_SECRET` (>= 32 bytes), `GEMINI_API_KEY`, and `ALLOWED_ORIGINS` / `APP_URL`.
2. **Multi-Replica Object Storage:** Configure `STORAGE_PROVIDER=s3` (`S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`) rather than local container filesystem storage if running multiple backend instances.
3. **Outbound Transactional Email:** Configure `RESEND_API_KEY` and `EMAIL_FROM` so verification, password reset, and organization invitation links deliver externally instead of queuing in `DevOutboxEmailProvider`.
