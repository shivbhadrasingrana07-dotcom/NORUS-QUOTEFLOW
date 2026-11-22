# Configuration & Deployment Reference

## Environment Variables

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `SQL_HOST` | Yes (runtime) | *(unset)* | Cloud SQL Unix socket path (`/app/cloudsql/...`) or PostgreSQL host |
| `SQL_PORT` | No | `5432` | PostgreSQL port |
| `SQL_DB_NAME` | Yes (runtime) | *(unset)* | PostgreSQL database name |
| `SQL_USER` | Yes (runtime) | *(unset)* | PostgreSQL application user |
| `SQL_PASSWORD` | Yes (runtime) | *(unset)* | PostgreSQL application password |
| `SQL_SSL` | No | `false` | Set `'true'` for TLS PostgreSQL connections |
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
| `NODE_ENV` | No | `development` | Enforces fail-closed `SESSION_SECRET`/`SQL_*` checks, `Secure` cookies, HSTS, and static `dist/` serving |
| `QUOTEFLOW_DB_PATH` | No | `data/quoteflow-db.json` | Legacy JSON source file path read by `scripts/migrate-json-to-postgres.ts` |

## Key NPM Scripts (`package.json`)

| Script | Command | Purpose |
| :--- | :--- | :--- |
| `npm run dev` | `tsx server.ts` | Starts Express + Vite dev server on port `3000` |
| `npm run start` | `NODE_ENV=production tsx server.ts` | Starts Express serving built `dist/` assets |
| `npm run build` | `vite build` | Compiles production frontend bundle into `dist/` |
| `npm run lint` | `tsc --noEmit` | Runs strict TypeScript typechecking across client, server, and tests |
| `npm test` | `tsx --test tests/*.test.ts` | Runs the automated Node test suite |
| `npm run db:migrate` | `tsx scripts/migrate-json-to-postgres.ts` | Legacy JSON -> PostgreSQL migration CLI (`--dry-run`, `--apply`) |
| `npm run org:bootstrap-owner` | `tsx scripts/bootstrap-org-owner.ts` | Inspect (`--inspect`) or safely bootstrap the first owner (`--issue-token` / `--claim-direct`) for an owner-less org |
| `npm run ops:maintenance` | `tsx scripts/run-maintenance.ts` | Executes bounded-batch cleanup of expired sessions, tokens, invitations, rate buckets, orphan docs, and `.tmp` files |

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

## Staging & Production Deployment Checklist (Cloud Run + Cloud SQL)

1. **Secrets & Fail-Closed Guard:** Provision `SESSION_SECRET` (random >= 32 bytes), `SQL_*` (via Cloud SQL Auth Proxy Unix socket `/app/cloudsql/<connection_name>`), `GEMINI_API_KEY`, `RESEND_API_KEY`, `EMAIL_FROM`, and `S3_*` credentials in Secret Manager. `createApp()` fails closed on boot in `NODE_ENV=production` if `SESSION_SECRET` or `SQL_*` are missing.
2. **Firebase Google Auth Authorized Domains:** Add every staging and production hostname (e.g., `*.run.app` Cloud Run URLs and custom domain `app.norusquoteflow.com`) in **Firebase Console → Authentication → Settings → Authorized Domains**.
3. **Resend Sender Verification:** Verify the sending domain in Resend (`SPF`, `DKIM`, `DMARC` DNS records) matching `EMAIL_FROM`.
4. **Private Object Storage Bucket:** Provision a private Cloudflare R2 or AWS S3 bucket with public access blocked, set `STORAGE_PROVIDER=s3`, and verify `GET /api/health/ready` returns `storage.ok: true`.
5. **Cloud SQL Backups & Readiness Probe:** Enable automated daily backups + 7-day PITR; point Cloud Run startup/readiness probe to `GET /api/health` (liveness) and post-deploy smoke test to `GET /api/health/ready`.
6. **Scheduled Maintenance:** Either keep `MAINTENANCE_INTERVAL_MINUTES="360"` enabled on single-service deployments or trigger `npm run ops:maintenance` via Cloud Run Job / Cloud Scheduler every 6 hours.
7. **Rollback Procedure:** Retain previous Cloud Run revision traffic split (`0%` standby) and take a Cloud SQL snapshot before schema migrations so traffic can shift back immediately on regression.
