# API Documentation

All API endpoints are served under `/api/*` by `server.ts`.
Authenticated endpoints require the `nf_session` `HttpOnly` cookie, and all authenticated `POST`/`PATCH`/`DELETE` requests require the matching `X-CSRF-Token` header.
Every response echoes or generates an `X-Request-Id` correlation header, and unhandled `500` responses return `{ "error": "Internal server error.", "requestId": "..." }`.

## Liveness, Readiness & Deprecated Sandbox Routes

### `GET /api/health`
Fast process liveness probe (does not block on external database startup checks or expose credentials).
- **200 OK:** `{ "status": "ok", "database": "postgresql", "storageProvider": "local" | "s3", "emailProvider": "dev_outbox" | "resend", "geminiConfigured": boolean, "googleAuthConfigured": true, "timestamp": string, "uptimeSec": number }`

### `GET /api/health/ready`
Dependency readiness probe executing PostgreSQL `SELECT 1`, private object storage readiness (`checkReadiness()`), email sender configuration status, and AI/OAuth readiness flags (never exposes secrets, stack traces, or connection strings).
- **200 OK / 503 Service Unavailable:** `{ "status": "ready" | "degraded", "timestamp": string, "uptimeSec": number, "checks": { "database": { "ok", "latencyMs", "error?" }, "storage": { "ok", "mode", "latencyMs", "error?" }, "email": { "mode", "configured", "senderValid" }, "gemini": { "configured" }, "googleAuth": { "configured" } } }`

### `ALL /api/demo/switch-persona`
Permanently disabled.
- **410 Gone:** `{ "error": "Demo persona switching has been disabled. Sign in with an authenticated organization account." }`

---

## Authentication & Sessions

### `GET /api/auth/me`
Returns `{ authenticated, user, activeOrganization, organizations, csrfToken, googleAuthEnabled, demoMode }`. Always returns `200` (`authenticated: false` when signed out).

---

## Temporary No-Login Demo Workspace Routes (Non-Production Only)

All routes below operate exclusively on an isolated, in-memory synthetic dataset (`server/demoWorkspace.ts`, `demo-org-synthetic`) with dedicated bounded `MemoryRateLimitStore` rate limiters (`demoMutationRateLimiter`, `demoExtractRateLimiter`, `demoDocRateLimiter`), keyed per visitor by `X-Demo-Session` / `nf_demo_sid`. They never read or write Cloud SQL PostgreSQL (including `rate_limit_buckets`) or private tenant object storage. In `NODE_ENV=production` (always) or when `DEMO_MODE="false"`, every route returns `410 Gone` (and `DEMO_MODE="true"` in production fails closed on boot).

- `GET /api/demo-workspace` — Initializes or fetches the caller's isolated synthetic workspace (`demoMode`, `demoSessionId`, `user`, `activeOrganization`, `settings`, `suppliers`, `items`, `rfqs`, `quotations`, `awards`, `auditLogs`).
- `POST /api/demo-workspace/reset` — Restores the caller's demo session to its clean synthetic initial dataset and regenerates sample PDF/Excel preview documents.
- `PATCH /api/demo-workspace/settings` — Updates demo organization defaults (`name`, `defaultCurrency`, `taxRegime`, `defaultTaxCreditable`).
- `POST /api/demo-workspace/rfqs` & `POST /api/demo-workspace/rfqs/load-sample` — Creates a demo RFQ (capped at 30 per session) or loads another synthetic RFQ + 3 sample quotations with genuine synthetic PDF/Excel preview documents.
- `POST /api/demo-workspace/suppliers` — Creates a demo supplier (`409` on duplicate name/Tax ID within the demo session).
- `POST /api/demo-workspace/rfqs/:rfqId/quotes/extract` *(Rate Limited)* — Validates magic bytes (`validateUploadedFile`), enforces per-session quotas (`25` uploads / `30 MB`, `413`), runs Gemini extraction (or deterministic `extractDemoQuotationOffline` when no API key is configured), and stores uploaded demo files strictly in session memory.
- `PATCH /api/demo-workspace/quotations/:quoteId`, `PATCH /api/demo-workspace/quotations/:quoteId/lines/:lineId`, `POST /api/demo-workspace/quotations/:quoteId/verify` (`422` math gate), `DELETE /api/demo-workspace/quotations/:quoteId` (`409` approved-award guard).
- `POST /api/demo-workspace/rfqs/:rfqId/award` & `POST /api/demo-workspace/awards/:awardId/decide` — Simulates split/single award recommendation (`nonL1Justification` enforced) and updates synthetic demo price memory.
- `GET /api/demo-workspace/documents/:docId/signed-url` & `GET /api/demo-workspace/documents/:docId/content` — Requires an existing active session (`hasSession`, returning `404` on unknown/missing session IDs without allocating) and serves genuine synthetic sample PDF/XLSX or uploaded demo files using HMAC-signed URLs scoped to `demo:${docId}:${demoSessionId}:${exp}` (`403` on tampered signature, `404` across demo sessions).

### `POST /api/auth/register` *(Rate Limited)*
Creates a password user account, creates a personal organization (or accepts an `inviteToken`), queues a verification email, and sets `nf_session`.
- **Body:** `{ email, password, fullName, title?, organizationName?, inviteToken? }`
- **Responses:** `201 Created`, `400 Bad Request` (invalid email or weak password), `403 Forbidden` (invite email mismatch), `409 Conflict` (email exists).

### `POST /api/auth/login` *(Rate Limited)*
Verifies email + `scrypt` password hash and sets `nf_session`.
- **Responses:** `200 OK`, `400 Bad Request`, `401 Unauthorized`, `429 Too Many Requests`.

### `POST /api/auth/google` *(Rate Limited)*
Verifies Firebase Google `idToken` via `firebase-admin` (`verifyIdToken` validating RS256 signature against Google X.509 certificates, `exp`, `aud`, and `iss`; revocation lookup opt-in via `FIREBASE_CHECK_REVOKED=true`), enforces `email_verified === true` before linking to an existing password account, optionally accepts `inviteToken` for both new and existing users, and sets `nf_session`.
- **Body:** `{ idToken, inviteToken? }`
- **Responses:** `200 OK`, `400 Bad Request`, `401 Unauthorized`, `403 Forbidden` (unverified email link attempt or invite email mismatch).

### `POST /api/auth/logout` *(Auth + CSRF)*
Revokes the active PostgreSQL session row and clears `nf_session`.

### `POST /api/auth/verify-email` *(Rate Limited)*
Validates `{ token }` (`SHA-256` lookup, rejects expired or reused tokens) and marks `emailVerified = true`.

### `POST /api/auth/resend-verification` *(Auth + CSRF + Rate Limited)*
Re-issues a 24-hour verification link via `EmailProvider`.

### `POST /api/auth/forgot-password` & `POST /api/auth/reset-password` *(Rate Limited)*
Issues a 1-hour reset token (generic `200` response prevents email enumeration) and resets password while revoking all existing sessions for that user.

### `GET /api/auth/sessions` *(Auth)* & `DELETE /api/auth/sessions/:sessionId` *(Auth + CSRF)*
Lists active non-revoked sessions and lets the user revoke specific sessions.

---

## Organizations, Memberships & Invitations

### `POST /api/organizations` *(Auth + CSRF + Rate Limited)*
Creates a new organization with the caller as `owner` and switches the active session to it (`201 Created`).

### `POST /api/organizations/switch` *(Auth + CSRF)*
Switches the active organization for the current session (`403` if the caller is not an active member).

### `GET /api/organizations/current/members` *(Auth + `workspace:read`)*
Lists active members in the active organization.

### `PATCH /api/organizations/current/members/:userId` & `DELETE /api/organizations/current/members/:userId` *(Auth + CSRF + `org:members:manage`)*
Updates role or removes member. Enforces `canAssignRole` hierarchy (`admin` cannot promote to or modify `owner`) and rejects demoting/removing the last remaining `owner` (`409 Conflict`).

### `GET /api/organizations/current/invitations`, `POST /api/organizations/current/invitations`, `DELETE /api/organizations/current/invitations/:invitationId` *(Auth + CSRF + `org:members:invite`)*
Creates 7-day email-bound invitations (`409` if already an active member), lists invitations, or revokes pending invitations.

### `POST /api/invitations/accept` *(Auth + CSRF)*
Accepts an invitation `{ token }` for an already signed-in user whose account email matches the invitation email (`403` on mismatch).

---

## Tenant-Scoped Procurement Routes

All endpoints below require an authenticated session (`401`), valid `X-CSRF-Token` on mutations (`403`), active organization membership (`403`), and the indicated RBAC permission (`403`). Every read/write is strictly scoped to `activeOrganization.id`.

### `GET /api/workspace` *(`workspace:read`)*
Returns the active organization's `WorkspaceState` (`settings`, `suppliers`, `items`, `rfqs`, `quotations`, `awards`, `auditLogs`).

### `PATCH /api/settings` *(`org:settings:write` — `owner`, `admin`)*
Updates organization commercial defaults (`name`, `defaultCurrency`, `taxRegime`, `defaultTaxCreditable`). Does **not** accept client-side role overrides.

### `POST /api/rfqs` & `POST /api/rfqs/load-sample` *(`rfq:write` — `owner`, `admin`, `buyer`)*
Creates sequential `RFQ-YYYY-XXXX` RFQs (scoped per org) or loads a sample manufacturing RFQ + 3 vendor quotes into the active organization.

### `POST /api/suppliers` *(`supplier:write` — `owner`, `admin`, `buyer`)*
Creates a supplier profile with per-organization duplicate name/Tax ID protection (`409`).

### `POST /api/items` *(`item:write` — `owner`, `admin`, `buyer`)*
Adds a catalog item to the organization's Item Price Memory.

### `POST /api/rfqs/:rfqId/quotes/extract` *(`quotation:extract` + `extractRateLimiter`)*
Accepts `multipart/form-data` (`supplierId`, optional `file`, optional `rawEmailText`), validates file magic bytes (`PDF`, `XLSX`, `XLS`, `CSV`, `PNG`, `JPG`, `WEBP`; max 25 MB), extracts fields via `geminiExtractor.ts`, uploads any binary file to private object storage (`stored_documents` + `documentId`), computes normalized landed costs, and returns `201 Created`.

### `PATCH /api/quotations/:quoteId`, `PATCH /api/quotations/:quoteId/lines/:lineId`, `POST /api/quotations/:quoteId/verify`, `DELETE /api/quotations/:quoteId`
- Edit requires `quotation:edit`; verify requires `quotation:verify` (blocked with `422` if any line has `mathValid === false`); delete requires `quotation:delete` (blocked with `409` if referenced by an `approved` award, and deletes the private object storage file if unapproved).

### `POST /api/rfqs/:rfqId/award` *(`award:recommend` — `owner`, `admin`, `buyer`)*
Submits single or split-award recommendation after validating all allocations belong to the organization & RFQ and checking `nonL1Justification` against verified `L1`.

### `POST /api/awards/:awardId/decide` *(`award:decide` — `owner`, `admin`, `approver`)*
Approves or rejects a `pending` award (`403` for `buyer` or `viewer`). Approval updates RFQ status to `'awarded'` and records `price_history` + `catalog_items.last_awarded_unit_price`.

---

## Private Document Access

### `GET /api/documents/:docId/signed-url` *(Auth + `document:download`)*
Verifies document belongs to `activeOrganization.id` (`404` otherwise) and returns `{ url, expiresAt, mimeType, originalFilename }` (300s TTL).

### `GET /api/documents/:docId/content`
Serves the private document binary (`Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`) using either a valid unexpired HMAC-signed token (`?org=...&exp=...&sig=...`) OR an authenticated org session with `document:download` (`403`/`404` on invalid signature or cross-tenant access).
