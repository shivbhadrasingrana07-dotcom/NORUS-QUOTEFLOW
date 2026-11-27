# Configuration & Deployment Reference

## Environment Variables

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `SQL_HOST` | Yes (runtime) | *(unset)* | Cloud SQL Unix socket path (`/app/cloudsql/...`) or PostgreSQL host |
| `SQL_PORT` | No | `5432` | PostgreSQL port |
| `SQL_DB_NAME` | Yes (runtime) | *(unset)* | PostgreSQL database name |
| `SQL_USER` | Yes (runtime) | *(unset)* | PostgreSQL application user |
| `SQL_PASSWORD` | Yes (runtime) | *(unset)* | PostgreSQL application password |
| `SQL_SSL` | No | `false` | Set `'true'` for TCP TLS PostgreSQL connections (`rejectUnauthorized: true` enforced by default; bypassed on Cloud SQL Unix socket `/...`) |
| `SQL_SSL_CA` | No | *(unset)* | Optional PostgreSQL TLS CA certificate (inline PEM content or local `.pem` file path) passed to `pg.Pool` when `SQL_SSL=true` |
| `SQL_SSL_ALLOW_SELF_SIGNED` | No | `false` | Set `'true'` only when connecting to a private non-CA self-signed PostgreSQL endpoint (`rejectUnauthorized: false`) |
| `COOKIE_SAMESITE` | No | `None` over HTTPS; `Lax` over HTTP | Explicit cookie `SameSite` policy (`lax` \| `strict` \| `none`); `'none'` requires `Secure` HTTPS context for cross-site iframe previews |
| `CSP_MODE` | No | `report-only` (in prod) | Controls server CSP emission (`report-only` sets `Content-Security-Policy-Report-Only`; `enforce` sets enforcing `Content-Security-Policy`) |
| `TRUST_PROXY_HOPS` | No | `1` | Express `trust proxy` hop count (`0` disables proxy trusting, integers set hop depth) used by `req.ip` and rate limiters |
| `SESSION_SECRET` | **Yes in prod** | Dev ephemeral key | **>= 32-char** HMAC/token secret (`server/security.ts` fails closed in production if missing or `< 32` chars) |
| `GEMINI_API_KEY` | For live AI extraction | *(unset)* | Server-side API key for `@google/genai` (`gemini-4-hydrogen`). Never prefix with `VITE_` |
| `STORAGE_PROVIDER` | No | `local` | `'local'` (private filesystem `data/private-storage/`) or `'s3'` (AWS SigV4 object storage) |
| `LOCAL_STORAGE_DIR` | No | `data/private-storage` | Private local object storage directory when `STORAGE_PROVIDER=local` |
| `S3_ENDPOINT` | If `STORAGE_PROVIDER=s3` | *(unset)* | S3 / Cloudflare R2 / MinIO endpoint URL |
| `S3_REGION` | No | `auto` | S3 region for SigV4 signing (`us-east-1`, `ap-south-1`, `auto`) |
| `S3_BUCKET` | If `STORAGE_PROVIDER=s3` | *(unset)* | Private bucket name (block all public access) |
| `S3_ACCESS_KEY_ID` | If `STORAGE_PROVIDER=s3` | *(unset)* | S3 access key ID |
| `S3_SECRET_ACCESS_KEY` | If `STORAGE_PROVIDER=s3` | *(unset)* | S3 secret access key |
| `RESEND_API_KEY` | **Yes for live email** | *(unset)* | Enables `ResendEmailProvider` for verification, reset, and invite emails; otherwise uses `DevOutboxEmailProvider` |
| `EMAIL_FROM` | If `RESEND_API_KEY` set | `NORUS QUOTEFLOW <noreply@norus.local>` | Verified sender address (`Name <user@domain>` or `user@domain`); validated on startup |
| `APP_URL` | **Yes in prod** | *(runtime-injected)* | Public HTTPS base URL used for email links and CORS origin allowlist |
| `ALLOWED_ORIGINS` | No | *(unset)* | Comma-separated extra allowed browser origins for `/api/*` |
| `MAINTENANCE_INTERVAL_MINUTES` | No | `360` | Background interval in minutes (`0` disables in-process timer if using external Cloud Scheduler) |
| `ERROR_WEBHOOK_URL` | No | *(unset)* | Optional HTTPS webhook notified asynchronously on unhandled `500` server errors (payloads redacted) |
| `PORT` | No | `3000` | HTTP port listened on by Express (`server.ts`) |
| `NODE_ENV` | No | `development` | Enforces fail-closed `SESSION_SECRET`/`SQL_*` checks, `Secure` cookies, HSTS, production CSP, and static `dist/` serving |
| `QUOTEFLOW_DB_PATH` | No | `data/quoteflow-db.json` | Legacy JSON source file path read by `scripts/migrate-json-to-postgres.ts` |
| `FIREBASE_CHECK_REVOKED` | No | `false` | Set `'true'` only when running with an IAM-authorized Firebase service account to query Identity Toolkit revocation status during `verifyIdToken` |
| `DEMO_MODE` | No (`false` in prod) | `true` in dev/test; **`false` in prod** | Controls the isolated synthetic no-login sandbox (`/api/demo-workspace*`). In `development`/`test`, unset/`true` enables demo mode and `false` restores full login (`AuthView`/`OrganizationView`). In `NODE_ENV=production`, demo mode is strictly **OFF by default**, and setting `DEMO_MODE="true"` **fails closed on boot** |
| `TEST_DATABASE_URL` / `TEST_SQL_*` | For PG integration tests | *(unset)* | Disposable PostgreSQL target (`TEST_SQL_HOST`, `TEST_SQL_PORT`, `TEST_SQL_DB_NAME`, `TEST_SQL_USER`, `TEST_SQL_PASSWORD`, `TEST_SQL_SSL`, `TEST_SQL_SSL_CA`, `TEST_SQL_SSL_ALLOW_SELF_SIGNED`) used by `tests/_helpers.ts`. Rejects Unix socket/`/cloudsql/` hosts, `cloud_sql_development_database`/`prod`/`production`/`staging`/`postgres`, and live `SQL_HOST`+`SQL_DB_NAME` overlap (except `NODE_ENV=test` local CI loopback `127.0.0.1`/`localhost`/`::1`/`postgres` with `*_test`/`*-test` DB names) |
| `RUN_LIVE_GEMINI_TESTS` | No | `'false'` | Set `'true'` alongside a valid `GEMINI_API_KEY` to execute live Gemini API smoke tests in `tests/extractionValidation.test.ts` |
| `DEFAULT_NEW_ORG_PLAN` | No | `'starter'` | Default `plan_tier` assigned to newly registered/created organizations (`starter` \| `professional` \| `business` \| `legacy`). Existing DB rows default `'legacy'` |

## Key NPM Scripts (`package.json`)

> `esbuild` devDependency is aligned with Vite 8 (`^0.28.2`), so clean lockfile installs via `npm ci` succeed without `--legacy-peer-deps`.

| Script | Command | Purpose |
| :--- | :--- | :--- |
| `npm run dev` | `tsx server.ts` | Starts Express + Vite dev server on port `3000` |
| `npm run start` | `NODE_ENV=production tsx server.ts` | Starts Express serving built `dist/` assets |
| `npm run build` | `vite build` | Compiles production frontend bundle into `dist/` |
| `npm run lint` | `tsc --noEmit` | Runs strict TypeScript typechecking across client, server, and tests |
| `npm test` | `tsx --test tests/*.test.ts` | Runs the unit, demo, and disposable-PG test suite |
| `npm run db:migrate` | `tsx scripts/migrate-json-to-postgres.ts` | Legacy JSON -> PostgreSQL migration CLI (`--dry-run`, `--apply --confirm`) |
| `npm run org:bootstrap-owner` | `tsx scripts/bootstrap-org-owner.ts` | Inspect (`--inspect`) or safely bootstrap the first owner (`--issue-token` / `--claim-direct`) for an owner-less org |
| `npm run ops:maintenance` | `tsx scripts/run-maintenance.ts` | Executes advisory-locked bounded-batch cleanup of expired sessions, tokens, invitations, rate buckets, orphan docs, and `.tmp` files |

## First-Owner Bootstrap Runbook (`org-kalyani-hydraulics`)

`org-kalyani-hydraulics` (`Kalyani Fluid Systems Pvt. Ltd.`) was migrated from legacy JSON with `0` user memberships so no arbitrary or fake user account holds ownership.

1. Inspect live status:
   ```bash
   npm run org:bootstrap-owner -- --inspect --org-id=org-kalyani-hydraulics
   ```
2. **Option A — Issue a one-time founder claim token (recommended before registration):**
   ```bash
   npm run org:bootstrap-owner -- --org-id=org-kalyani-hydraulics --issue-token --email="founder@kalyani-hydraulics.in" --ttl-hours=72
   ```
   Deliver `/?invite=<rawClaimToken>` securely to the authorized founder; only an account authenticating with that exact email (via password registration or verified Google Sign-In) can claim ownership.
3. **Option B — Promote an already-registered founder account directly:**
   ```bash
   npm run org:bootstrap-owner -- --org-id=org-kalyani-hydraulics --claim-direct --email="founder@kalyani-hydraulics.in"
   ```
   Both modes refuse execution (`409`) as soon as at least one active `owner` exists.

## Production Infrastructure Cutover Plan (Task 012 — 12 Requirements)

| # | Area | Exact Requirement & Configuration | Safety / Verification Note |
| :--- | :--- | :--- | :--- |
| 1 | **Cloud SQL Backup & Recovery** | Enable automated daily backups + **7-day Point-in-Time Recovery (PITR)**; capture an on-demand pre-migration Cloud SQL snapshot (`gcloud sql backups create`) before executing any DDL | Never modify production/staging Cloud SQL directly without a verified recent snapshot |
| 2 | **`0001` & `0002` Schema Migrations** | Against backed-up PostgreSQL 15+ Cloud SQL: (a) run `drizzle/0001_tenant_integrity_preflight.sql` (must return `0` cross-org rows); (b) execute `drizzle/0001_tenant_integrity.sql` (`BEGIN;...COMMIT;`); (c) execute `drizzle/0002_usage_quotas_and_tokens.sql` (`BEGIN;...COMMIT;`); (d) keep both `_rollback.sql` scripts ready | `0001` passed CI Run `#12`; `0002` wired into CI `.github/workflows/ci.yml`; neither executed on Cloud SQL |
| 3 | **Founder Account Bootstrap** | Claim `org-kalyani-hydraulics` (`0` owners) via `npm run org:bootstrap-owner -- --org-id=org-kalyani-hydraulics --issue-token --email="<founder-email>" --ttl-hours=72` (or `--claim-direct`) | Protected by `organizations FOR UPDATE` lock; rejects duplicate owners (`409`) |
| 4 | **`SESSION_SECRET`** | Generate cryptographically random `>= 32`-character secret (`openssl rand -base64 48`) stored in Secret Manager | `getSigningSecret()` fails closed on boot in `NODE_ENV=production` if unset or `< 32` chars |
| 5 | **Canonical URL, CORS & Cookies** | Set `APP_URL="https://<prod-domain>"`, `ALLOWED_ORIGINS="https://<prod-domain>"`, `COOKIE_SAMESITE="lax"` (for dedicated custom domain; leave unset/`none` only if embedded in HTTPS iframe), and `TRUST_PROXY_HOPS` matching exact proxy hop depth (`1` Cloud Run LB, `2` CDN+LB) | Prevents `Host`-header link construction fallback in `getAppBaseUrl(req)` and ensures accurate `req.ip` rate limiting |
| 6 | **Gemini API Configuration** | Store `GEMINI_API_KEY` in Secret Manager (`server/geminiExtractor.ts` only; never `VITE_` prefixed) | Run `RUN_LIVE_GEMINI_TESTS=true` staging smoke check once before opening customer traffic |
| 7 | **Resend Outbound Email** | Provision `RESEND_API_KEY` and domain-verified `EMAIL_FROM` (`SPF`, `DKIM`, `DMARC` DNS records) | Mandatory: without `RESEND_API_KEY`, `createEmailProvider()` silently falls back to `DevOutboxEmailProvider` (`GET /api/health/ready` shows `email.mode: "dev_outbox"`) |
| 8 | **Private S3-Compatible Storage** | Provision Cloudflare R2 or AWS S3 private bucket (all public access blocked) with `STORAGE_PROVIDER="s3"`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (+ bucket CORS `GET` rule if browsers fetch signed URLs directly) | Mandatory for stateless/multi-replica Cloud Run; default `'local'` filesystem loses uploads across container restarts/replicas |
| 9 | **PostgreSQL TLS / Proxy Socket** | Prefer Cloud SQL Auth Proxy Unix socket (`SQL_HOST="/app/cloudsql/<connection_name>"`) **OR** enforce verified TCP TLS (`SQL_SSL="true"` + `SQL_SSL_CA` PEM/path; avoid `SQL_SSL_ALLOW_SELF_SIGNED=true`) | `buildPgSslConfig()` enforces `rejectUnauthorized: true` by default on TCP TLS |
| 10 | **Firebase Authorized Domains** | Add staging and production hostnames (`*.run.app` and custom domain) to **Firebase Console → Authentication → Settings → Authorized Domains**; optionally set `FIREBASE_CHECK_REVOKED="true"` when deploying with a Cloud IAM service account authorized on project `favorable-emblem-zxq1s` | Unlisted domains trigger `auth/unauthorized-domain` in browser Google popups |
| 11 | **CSP Enforcement** | Roll out to staging first with `CSP_MODE="report-only"` (prod default), inspect browser console / logs across Google Sign-In, PDF/XLSX download, and AI upload flows, then switch `CSP_MODE="enforce"` before production cutover | `buildProductionCspPolicy()` omits `*` wildcards and `'unsafe-eval'` |
| 12 | **Monitoring & Maintenance** | Set `ERROR_WEBHOOK_URL` (HTTPS Slack/PagerDuty/alert receiver), attach Cloud Monitoring uptime alerts to `GET /api/health/ready` (`503` alert threshold), and run either `MAINTENANCE_INTERVAL_MINUTES="360"` (single-service) or Cloud Scheduler -> `npm run ops:maintenance` every 6h (`MAINTENANCE_INTERVAL_MINUTES="0"`) | `pg_try_advisory_lock` prevents overlapping cleanup batches across replicas |

## Operational Readiness Checklists (Task 012 — 6 Runbooks)

### 1. Deployment Checklist
- [ ] Latest commit built and passed CI (`verify` + `browser-e2e`) with `NODE_ENV=production` and `DEMO_MODE` unset (verified `demoMode: false` on `/api/auth/me`).
- [ ] All Secret Manager entries (`SESSION_SECRET`, `SQL_*`, `GEMINI_API_KEY`, `RESEND_API_KEY`, `S3_*`) mounted and verified non-placeholder.
- [ ] `APP_URL`, `ALLOWED_ORIGINS`, `EMAIL_FROM`, `COOKIE_SAMESITE`, `TRUST_PROXY_HOPS`, and `CSP_MODE=enforce` verified in Cloud Run env.
- [ ] Cloud SQL backup + `0001_tenant_integrity_preflight.sql` + `0001_tenant_integrity.sql` + `0002_usage_quotas_and_tokens.sql` completed cleanly.
- [ ] Deploy new revision at `0%` traffic (`--no-traffic`), run `curl -sf https://<staging-tag>/api/health/ready` (`database.ok: true`, `storage.ok: true`, `email.mode: "resend"`), smoke-test login + Google popup + PDF upload + comparison export, then shift traffic to `100%`.

### 2. Backup & Rollback Checklist
- [ ] Record current working Cloud Run revision name and on-demand Cloud SQL backup ID prior to change.
- [ ] **Application-only regression:** Route `100%` Cloud Run traffic back to prior revision (`gcloud run services update-traffic ... --to-revisions=<PREV>=100`); verify `/api/health/ready`.
- [ ] **Schema rollback (if `0002` / `0001` triggered post-apply issues):** Pause writes/scale to maintenance if needed, run `drizzle/0002_usage_quotas_and_tokens_rollback.sql` (and `drizzle/0001_tenant_integrity_rollback.sql` if reverting `0001`), then roll traffic back; restore PITR/snapshot only if corrupted data must be rewound.

### 3. Incident Response Checklist
- [ ] Inspect structured JSON logs using `X-Request-Id` from failing API responses or `ERROR_WEBHOOK_URL` alerts (`GET /api/health/ready` identifies DB vs. S3 vs. config failure).
- [ ] **Suspected credential / session compromise:** Rotate `SESSION_SECRET` (invalidates HMAC signed URLs immediately), revoke compromised DB `sessions` rows (`DELETE` / `revokedAt`), or rotate `GEMINI_API_KEY` / `RESEND_API_KEY` / `S3_*` keys in Secret Manager + deploy fresh revision.
- [ ] **Malicious upload / extraction incident:** Confirm container quarantine (`415`/`422`/`413` responses), check `stored_documents` by `organization_id` and audit logs (`DOCUMENT_*`/`QUOTATION_*`), and isolate offending organization membership if compromised.

### 4. First-Owner Bootstrap Checklist (`org-kalyani-hydraulics`)
- [ ] Confirm `npm run org:bootstrap-owner -- --inspect --org-id=org-kalyani-hydraulics` reports `activeOwners: 0`.
- [ ] Issue single-use founder claim token (`--issue-token --email="<verified-founder-email>" --ttl-hours=72`) and send claim URL over a verified out-of-band channel.
- [ ] Confirm founder completed sign-up/Google Sign-In with exact email and inspect `activeOwners: 1` + `FIRST_OWNER_BOOTSTRAPPED` audit entry; verify subsequent bootstrap attempts fail with `409`.

### 5. Pilot Customer Onboarding Checklist
- [ ] Pilot customer creates workspace via `/api/auth/register` or verified Google Sign-In (`owner` role assigned automatically) and confirms email verification link arrives from verified `EMAIL_FROM` domain.
- [ ] Owner sets `Settings` (company currency, freight/payment defaults, UOM aliases) and invites internal `buyer`, `approver`, and `viewer` teammates via `Team & Invitations`.
- [ ] Smoke-test pilot RFQ lifecycle end-to-end: upload 2+ supplier quotes (PDF + XLSX/CSV), verify math audit & alternate spec review, submit award (`buyer`), approve (`approver`), and export 4-sheet Excel + landscape PDF comparative statements.

### 6. Post-Launch Monitoring Checklist
- [ ] Track `GET /api/health/ready` (`503` alerts < 1 min detection) and `5xx` error rate / `ERROR_WEBHOOK_URL` volume during first 72 hours.
- [ ] Verify rate-limit `429` spikes vs. auth failures (`authRateLimiter`), Gemini API quota usage/latency, and S3 bucket storage growth.
- [ ] Confirm `ops:maintenance` (in-process or Cloud Scheduler) completes without `advisory lock` contention and purges expired `sessions` / `rate_limit_buckets` / orphaned `stored_documents` on schedule.

## Current Staging Readiness Snapshot (Task 014 Non-Mutating Audit)

| Prerequisite | Status | Observed Evidence |
| :--- | :--- | :--- |
| Cloud SQL backup & recovery procedure | `NOT CONFIGURED` / `UNKNOWN / CANNOT VERIFY` | Runbook documented above; live GCP PITR/snapshots not inspectable from sandbox |
| `0001` & `0002` migration status | `NOT CONFIGURED` *(0001 CI PG16 Verified; 0002 Added to CI)* | `0001` passed CI Run `#12`; `0002` authored in Task 017; neither applied to live Cloud SQL |
| Organization owner bootstrap | `NOT CONFIGURED` | `scripts/bootstrap-org-owner.ts` present; `org-kalyani-hydraulics` awaits founder claim |
| Private S3/R2 storage | `NOT CONFIGURED` | `/api/health` shows `storageProvider: "local"`; `STORAGE_PROVIDER` / `S3_*` unset |
| Resend verified email domain | `NOT CONFIGURED` | `/api/health` shows `emailProvider: "dev_outbox"`; `RESEND_API_KEY` / `EMAIL_FROM` unset |
| Firebase Authorized Domains | `UNKNOWN / CANNOT VERIFY` | `googleAuthConfigured: true` locally; Firebase Console domain list requires console inspection |
| `CSP_MODE=enforce` | `NOT CONFIGURED` | `CSP_MODE` unset (defaults to `report-only` in `NODE_ENV=production`) |
| `ERROR_WEBHOOK_URL` & monitoring | `NOT CONFIGURED` | `ERROR_WEBHOOK_URL` unset; external Cloud Monitoring uptime alerts unverified |
| Staging Gemini schema validation | `BLOCKED` / `NOT CONFIGURED` | Shell `GEMINI_API_KEY` & `RUN_LIVE_GEMINI_TESTS` unset (`1` live test skipped locally) |
| `/api/health/ready` verification | `UNKNOWN / CANNOT VERIFY` | Route implemented (`server.ts:517`); intentionally not probed against live Cloud SQL in read-only audit |

## Organization Usage Quota Policy (`server/usagePolicy.ts` — Task 017)

> All plan caps below (`starter`, `professional`, `business`) are **unvalidated commercial hypotheses** (`isUnvalidatedHypothesis: true`); `legacy` preserves unrestricted access for migrated/pre-Task-017 organizations. Storage usage is computed from `SUM(stored_documents.byte_size)` + active `ai_extraction_reservations`, reclaiming immediately when quotations/documents are deleted. Quotas reset on the 1st of each UTC calendar month.

| `plan_tier` | Monthly AI Extraction Limit | Storage Limit | Notes |
| :--- | :---: | :---: | :--- |
| `legacy` | Unlimited (`null`) | Unlimited (`null`) | Default for existing DB rows (`0002` DDL); non-blocking |
| `starter` | `60` docs / UTC month | `5 GiB` (`5,368,709,120` B) | Default for new organizations (`DEFAULT_NEW_ORG_PLAN=starter`) |
| `professional` | `250` docs / UTC month | `25 GiB` (`26,843,545,600` B) | Unvalidated mid-tier hypothesis |
| `business` | `800` docs / UTC month | `100 GiB` (`107,374,182,400` B) | Unvalidated multi-plant hypothesis |


