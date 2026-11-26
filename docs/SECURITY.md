# Security Posture, Architecture & Operational Boundaries

## Implemented Security Controls

1. **Dual Real Server-Verified Authentication (`server/security.ts`, `server/firebase-admin.ts`, `server/pgStore.ts`, `src/lib/firebase.ts`):**
   - Passwords hashed with Node `crypto.scrypt` (`N=16384`, `r=8`, `p=1`) and random 16-byte per-user salts, compared via `crypto.timingSafeEqual`.
   - Password complexity enforced server-side (8–128 chars, requires letter + number).
   - Email verification tokens and password-reset tokens use 256-bit random values stored exclusively as `SHA-256` hashes, enforced one-time with expiration checks; password reset revokes all active user sessions.
   - Google Sign-In uses minimal scopes (`openid`, `email`, `profile`), popup/domain error translation (`src/components/AuthView.tsx`), and server-side verification via `firebase-admin` (`verifyIdToken(idToken, FIREBASE_CHECK_REVOKED === 'true')`, validating Google X.509 certificate signature, `exp`, `aud`, and `iss` before exchanging for a revocable PostgreSQL `nf_session`). Linking a Google UID onto an existing password account requires `email_verified === true` (`403` otherwise).
   - `POST /api/demo/switch-persona` is permanently disabled (`410 Gone`), and `PATCH /api/settings` ignores client-supplied role properties.

2. **Session Management & CSRF Protection (`server.ts`, `server/security.ts`, `server/pgStore.ts`):**
   - `nf_session` cookie carries a 256-bit opaque token stored as `SHA-256` in PostgreSQL `sessions` (revocable individually or globally), flagged `HttpOnly`, `SameSite` resolved via `resolveCookieSameSite()` (`COOKIE_SAMESITE=lax|strict|none`, defaulting to `None; Secure` over HTTPS and `Lax` over HTTP), and `Secure` over HTTPS / production.
   - `createSessionTx` bounds active sessions per user to `10` (`MAX_ACTIVE_SESSIONS_PER_USER`), revoking excess oldest sessions automatically.
   - All authenticated `POST`, `PATCH`, and `DELETE` requests enforce timing-safe comparison of `X-CSRF-Token` against the active session's `csrf_token` (`403` if missing or invalid).
   - `getSigningSecret()` fails closed in production if `SESSION_SECRET` is unset or shorter than `32` characters.

3. **Strict Multi-Tenant Isolation, 5-Role RBAC, Historical Snapshots & First-Owner Bootstrap (`server/rbac.ts`, `server/pgStore.ts`, `server/demoWorkspace.ts`, `server/ownerBootstrap.ts`):**
   - Every organization resource (`suppliers`, `catalog_items`, `rfqs`, `quotations`, `stored_documents`, `awards`, `audit_logs`) is keyed by `organization_id`, backed at the SQL layer by composite same-organization foreign keys (`drizzle/0001_tenant_integrity.sql`).
   - Cross-tenant reads, updates, deletes, award decisions, or document downloads return `404` or `403`.
   - Write transactions in `server/pgStore.ts` (`saveExtractedQuotation`, `updateQuotationHeader`, `updateQuotationLine`, `verifyQuotation`, `deleteQuotation`, `submitAward`, `withdrawAward`, `decideAward`) acquire parent `rfqs FOR UPDATE` locks first in strict `rfqs -> quotations -> awards` order to prevent TOCTOU races and circular deadlocks.
   - Quotations referenced by `pending` or `approved` awards reject header/line edits and re-verification (`409`); quotations referenced by `approved`, `pending`, or `rejected` awards reject deletion (`409`) to preserve immutable historical award snapshots.
   - 5 roles enforced on the server: `owner`, `admin`, `buyer`, `approver`, `viewer`, plus last-owner protection (`409` on demotion/removal of the sole owner).
   - Owner-less migrated organizations (`org-kalyani-hydraulics`) require explicit operator/founder bootstrap via `npm run org:bootstrap-owner`, which locks the `organizations` row (`FOR UPDATE`) inside the transaction and blocks reassignment (`409`) if an active owner already exists.

4. **Private Object Storage & Signed Document Access (`server/objectStorage.ts`):**
   - Binary files are stored outside public directories (`data/private-storage/` locally or private S3-compatible bucket), and `S3CompatibleStorageProvider` enforces `AbortController` request/readiness timeouts (`15s` / `5s`).
   - Document keys are path-sanitized (`orgs/<orgId>/docs/<docId>/<safeFilename>`).
   - Download URLs expire after 300 seconds and verify either HMAC-SHA256 tokens (`documentId:organizationId:exp`) or AWS SigV4 presigned URLs.

5. **Upload Magic-Byte & Isolated Spreadsheet Hardening (`server/fileSecurity.ts`, `server/spreadsheetWorker.mjs`, `server/geminiExtractor.ts`, `src/lib/exporters.ts`):**
   - 25 MB Multer limit (`413`), active/executable/macro extension blocklist (`.xlsm`, `.docm`, `.zip`, etc.), magic-byte inspection (`415` on mismatch), and Excel/CSV formula injection escaping (`sanitizeSpreadsheetCell`).
   - **`xlsx@0.18.5` Mitigation & Process Isolation (Hardened Task 009–011):** Comma- and tab-separated uploads (`.csv`, `.tsv`, and plain UTF-8 `.xls` tables) parse through a built-in native RFC-4180 parser (`parseDelimitedTextToRows`) with a `65,536`-character raw cell cap without touching `xlsx`. Binary `.xlsx` uploads are pre-scanned at the ZIP container level (`inspectXlsxZipContainer`) to block path traversal (including Windows backslashes, drive prefixes, and NUL bytes), ZIP64 headers, encrypted entries, unsupported compression methods, Local File Header vs. Central Directory filename/size mismatches, overlapping payload spans, ZIP bombs (`> 120` entries, `> 32 MB` uncompressed, `> 100x` ratio, or `0` compressed bytes for non-empty files -> `422`), and smuggled VBA macros (`vbaProject.bin`, `xl/macrosheets/`, `xl/dialogsheets/`, `xl/activeX/` -> `415`). Binary OLE2 `.xls` uploads are pre-scanned by `inspectOle2Container()` (requiring >= 512 bytes, `0xfffe` byte-order mark, valid sector shift `7..16` -> `422`, and rejecting embedded UTF-16LE `_VBA_PROJECT_CUR` / `_VBA_PROJECT` macro storages -> `415`). Both binary formats are limited to `10 MB` (`413`) and parsed with `cellFormula: false, cellHTML: false, bookVBA: false` inside an ephemeral child process (`server/spreadsheetWorker.mjs`, `--max-old-space-size=128`, `5000ms` SIGKILL timeout, `6 MB` stdout cap, stripped `env: { NODE_OPTIONS: '' }`) using prototype-safe `Object.hasOwn` lookups, pure-JS `decodeCellAddress()` validation, and hard worksheet (`12`), row (`250`), column (`30`), per-sheet (`5,000`), and total cell (`15,000`) ceilings.

6. **PostgreSQL TLS, Rate Limiting, Strict CORS, Headers/CSP & Secret Scrubbing (`src/db/index.ts`, `server/rateLimiter.ts`, `server/monitoring.ts`, `server.ts`):**
   - `buildPgSslConfig()` enforces `rejectUnauthorized: true` by default on TCP PostgreSQL TLS (`SQL_SSL=true`), supports explicit CA bundles (`SQL_SSL_CA`), requires explicit `SQL_SSL_ALLOW_SELF_SIGNED=true` for unverified self-signed certs, and skips TLS only for Cloud SQL Unix sockets (`/app/cloudsql/...`).
   - Atomic `rate_limit_buckets` protection on auth endpoints (`authRateLimiter`), AI extraction (`extractRateLimiter`), and general mutations (`mutationRateLimiter`), deriving client IP via Express `req.ip` (`TRUST_PROXY_HOPS` via `resolveTrustProxySetting()`, default `1`, ignoring raw spoofable `X-Forwarded-For` headers) and returning `429` with `Retry-After` headers.
   - Strict CORS allowlist (`req.headers.host`, `APP_URL`, `ALLOWED_ORIGINS`, plus `localhost`/`127.0.0.1` in non-production); untrusted origins rejected with `403`.
   - Security headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Cross-Origin-Opener-Policy: same-origin-allow-popups`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cross-Origin-Resource-Policy: same-origin`, `Permissions-Policy`, production `Strict-Transport-Security`, and `Content-Security-Policy-Report-Only` / `Content-Security-Policy` built via `buildProductionCspPolicy()` (no `*` wildcards, no `'unsafe-eval'`).
   - `redactSensitiveText` strips configured secret env values plus `Bearer` tokens, `re_live_`/`re_test_`/`AIza*` keys, and `password`/`apiKey`/`secretAccessKey` parameter patterns from logs, errors, and webhook notifications.

## Operational Requirements for Public Internet Deployment

1. **Secrets & Canonical URL Required in Production (`NODE_ENV=production`):** Set a cryptographically random `SESSION_SECRET` (>= 32 characters), `GEMINI_API_KEY`, `APP_URL` (ensuring verification/reset/invitation email links never fall back to `req.headers.host`), `ALLOWED_ORIGINS`, and switch `CSP_MODE=enforce` after verifying staging `Content-Security-Policy-Report-Only` logs.
2. **Firebase Authorized Domains:** Add every production/staging hostname (Cloud Run `*.run.app` and custom domains) under Firebase Auth → Settings → Authorized Domains so Google Sign-In popups succeed in end-user browsers.
3. **Multi-Replica Object Storage:** Configure `STORAGE_PROVIDER=s3` (`S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`) rather than local container filesystem storage if running multiple backend instances.
4. **Outbound Transactional Email:** Configure `RESEND_API_KEY` and a domain-verified `EMAIL_FROM` (`SPF`/`DKIM`) so verification, password reset, and organization invitation links deliver externally instead of queuing in `DevOutboxEmailProvider`.
5. **Founder Ownership Claim for `org-kalyani-hydraulics`:** Run `npm run org:bootstrap-owner -- --org-id=org-kalyani-hydraulics --issue-token --email="<founder-email>"` (or `--claim-direct`) once the authorized founder email is designated.
6. **Safe Production `DEMO_MODE` Enforcement:** In `NODE_ENV=production`, `DEMO_MODE` defaults to **OFF (`false`)**, disabling `/api/demo-workspace*` (`410 Gone`) so only authenticated multi-tenant workspaces operate. Setting `DEMO_MODE="true"` in production fails closed on server boot (`resolveDemoMode()`).

## Temporary Demo Workspace Isolation (Task 006 / Hardened Task 007)

- When `demoModeEnabled` is active in non-production environments (`NODE_ENV !== 'production'` and `DEMO_MODE !== 'false'`), unauthenticated visitors land directly in an isolated synthetic sandbox backed exclusively by `server/demoWorkspace.ts` (`demo-org-synthetic`).
- **Zero Database / Customer / Gemini Billing Leakage:** `DemoWorkspaceStore` holds no Cloud SQL connection, no reference to `server/pgStore.ts`, `server/seedData.ts` (`org-kalyani-hydraulics`), or `server/objectStorage.ts`. `/api/demo-workspace*` routes use dedicated bounded `MemoryRateLimitStore` instances (never writing `rate_limit_buckets` in Cloud SQL), and `POST /api/demo-workspace/rfqs/:rfqId/quotes/extract` **always runs deterministic offline extraction (`extractDemoQuotationOffline`)** regardless of `GEMINI_API_KEY` so anonymous demo users cannot consume external Gemini API quota/billing. All real `/api/workspace`, `/api/rfqs`, `/api/suppliers`, `/api/documents/*`, and `/api/organizations/*` routes continue enforcing `401 Unauthorized`, CSRF, and RBAC.
- **Per-Visitor Memory Isolation & Bounds:** Each visitor receives a scoped `nf_demo_sid` / `X-Demo-Session` session capped at 120 LRU sessions (`maxSessions`), 25 uploaded documents / 30 MB per session (`413`), and 30 RFQs per session (`400`). Signed preview lookups require an existing active session (`hasSession`, returning `404` without allocating/evicting sessions on unknown IDs) and session-bound HMAC signatures (`demo:${docId}:${demoSessionId}:${exp}`).

## Dependency Security & `xlsx@0.18.5` Remediation Analysis (Task 011)

### `xlsx@0.18.5` Usage Inventory & Library Comparison
Direct imports of `xlsx` exist in only three runtime modules (plus test fixtures in `tests/extractionValidation.test.ts` and `tests/exporters.test.ts`):
- `server/spreadsheetWorker.mjs`: Binary `.xlsx` / `.xls` workbook read inside the isolated `128 MB / 5s` child process (`XLSX.read`).
- `src/lib/exporters.ts`: Internal Comparative Statement 4-sheet `.xlsx` generation (`Summary`, `Line_Matrix` with live `MAX`/`MIN`/`IF(ISNUMBER(...))` Excel formulas, `Exceptions`, `Audit_Log`) using `XLSX.utils.book_new`, `aoa_to_sheet`, `encode_col`, `book_append_sheet`, and `XLSX.writeFile`.
- `server/demoWorkspace.ts`: Cached synthetic sample `.xlsx` preview buffer generation (`XLSX.utils.book_new`, `aoa_to_sheet`, `book_append_sheet`, `XLSX.write`).

| Candidate | `.xlsx` Read | `.xlsx` Write w/ Formulas | Legacy Binary `.xls` (BIFF5/8) Read | Known `npm audit` Issues | Compatibility & Risk Assessment |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`xlsx@0.18.5` (current)** | Yes | Yes | Yes | 2 High (`<0.19.3` prototype pollution, `<0.20.2` ReDoS; `fixAvailable: false` on npm) | Newer releases (`0.20.x`) are published only outside public npm; npm package remains unpatched. Quarantined in subprocess on server read. |
| **`read-excel-file@9.3.20` + `write-excel-file@4.1.1`** | Yes (`read-excel-file/node`) | Yes (`{ type: 'Formula', value }`) | **No** | 0 known | MIT, lightweight (`saxen`, `fflate`, `unzipper-esm`, `worker-f`), clean browser + Node `>=18` support. Cannot parse binary OLE2 `.xls`. |
| **`exceljs@4.4.0`** | Yes | Yes | **No** | Pulls `tmp@^0.2.0` (`tmp <0.2.7` advisory) & heavy ZIP/stream tree (`unzipper`, `archiver`, `jszip`) | MIT, larger browser bundle impact (`exporters.ts`), last published Dec 2024. Cannot parse binary OLE2 `.xls`. |

**Migration Decision (Task 011):** A complete replacement of `xlsx@0.18.5` was **not performed** in Task 011 because no zero-advisory npm candidate parses legacy binary OLE2 `.xls` files, and silently dropping `.xls` upload support or pulling un-audited off-registry SheetJS tarballs is unsafe. Instead, `server/spreadsheetWorker.mjs` was hardened further with `inspectOle2Container()`, pure-JS `decodeCellAddress()`, and `Object.hasOwn()` checks.

**Safest Migration Roadmap (Once Product Approves `.xls` Strategy):**
1. Decide between (a) deprecating legacy binary OLE2 `.xls` uploads (`415` prompting suppliers for `.xlsx`/`.csv`, while retaining native UTF-8 text-table `.xls` support via `parseDelimitedTextToRows`) or (b) normalizing binary OLE2 `.xls` in an isolated headless converter before OOXML parsing.
2. Migrate `server/spreadsheetWorker.mjs` `.xlsx` parsing to `read-excel-file@9.3.20` (`read-excel-file/node`), keeping `inspectXlsxZipContainer()` and the `128 MB / 5s` env-stripped subprocess intact.
3. Migrate `src/lib/exporters.ts` and `server/demoWorkspace.ts` to `write-excel-file@4.1.1` (preserving `{ type: 'Formula', value }` cell formulas, `sanitizeSpreadsheetCell()`, and 4-sheet workbook parity).
4. Uninstall `xlsx@0.18.5` and confirm `npm audit` reports zero direct high-severity dependencies.

### Remaining `npm audit` Findings & Node Compatibility Review (Task 011)
`npm audit --json` reports `9` total advisories (`5` high, `4` moderate, `0` critical) on `package-lock.json`:
1. **`xlsx@0.18.5` (`high`, direct):** Contained server-side via ZIP/OLE2 pre-scans, native CSV/TSV isolation, and ephemeral `128 MB / 5s` `spreadsheetWorker.mjs` subprocess; client exports handle internal arrays only.
2. **`firebase@13.4.0` -> `@firebase/firestore@4.20.0` / `@firebase/firestore-compat` -> `@grpc/grpc-js@1.9.16` (`high`, transitive):** Two `@grpc/grpc-js` advisories (`<=1.13.5`). Reachability check confirmed `src/lib/firebase.ts` imports **only** `firebase/app` and `firebase/auth` — Firestore and `@grpc/grpc-js` are never imported, bundled, or executed. `npm audit fix` suggests a breaking downgrade to `firebase@9.14.0`, which must **not** be applied.
3. **`drizzle-kit@0.31.11` -> `@esbuild-kit/esm-loader` / `@esbuild-kit/core-utils` -> nested `esbuild@0.18.20` (`moderate`, transitive):** Dev-server CORS advisory affecting `esbuild <=0.24.2`. Reachability check confirmed the app's root Vite/runtime bundler uses patched `esbuild@0.28.2`, while `drizzle-kit` is an offline schema/migration CLI tool never imported by `server.ts` or `src/`. `npm audit fix` suggests a breaking downgrade to `drizzle-kit@0.18.1`, which must **not** be applied.
4. **Node `v22.23.5` Compatibility (`EBADENGINE`):** Clean `npm ci` exits `0` with `0` peer dependency overrides, emitting `13` non-fatal `EBADENGINE` warnings from `@firebase/*` subpackages declaring `node >=24.12.0` and `2` deprecation warnings from `@esbuild-kit/*` (`drizzle-kit`). Runtime verification confirmed `firebase/app`, `firebase/auth`, Vite, Express, and `tsx` operate cleanly on Node 22.

## Security Summary & Directly Verified Safeguards (Task 011)
- **Reviewed Enforcement Files:** `server.ts`, `server/security.ts`, `server/rbac.ts`, `server/firebase-admin.ts`, `server/fileSecurity.ts`, `server/spreadsheetWorker.mjs`, `server/pgStore.ts`, `src/db/index.ts`, `src/lib/firebase.ts`, `src/lib/exporters.ts`, and `server/demoWorkspace.ts`.
- **Verified Safeguards:** Fail-closed `SESSION_SECRET` (>= 32 chars) and `DEMO_MODE` (`false` default, startup crash if `true`) in production; `crypto.scrypt` (`N=16384`) + `crypto.timingSafeEqual` + CSRF token validation on authenticated mutations; 5-role server RBAC (`owner`, `admin`, `buyer`, `approver`, `viewer`) + last-owner guard; strict `organizationId` scoping on workspace/document reads (`getStoredDocumentForOrg`) and `rfqs -> quotations -> awards` `FOR UPDATE` locks; `300s` HMAC-signed private document URLs; `rejectUnauthorized: true` TCP PostgreSQL TLS; and `128 MB / 5s` secret-stripped `spreadsheetWorker.mjs` isolation with ZIP bomb and OOXML/OLE2 macro rejection.
- **Unverified / Blocked Runtime Boundaries:** Managed Cloud SQL (`org-kalyani-hydraulics`) was intentionally never touched; PostgreSQL integration tests and headless Chromium Playwright runs were verified by GitHub Actions Run #6 at job/step level (`conclusion: success`), while raw CI log inspection remains `HTTP 403` unauthenticated and local container lacks `psql`, Docker, and Playwright Chromium.

