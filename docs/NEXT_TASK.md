# Next Task — External Secrets, Domain Setup & Commercial Pilot Rollout

## Completed Through Task 007 Stabilization
- Dual server-verified authentication (Email/Password + hardened Google Sign-In with `openid`/`email`/`profile`, `FIREBASE_CHECK_REVOKED` opt-in, `aud`/`iss` validation, real `isGoogleAuthConfigured()` check, 10-session cap per user, and verified-email linking guard).
- Composite same-organization SQL integrity migration authored & CI-wired (`drizzle/0001_tenant_integrity.sql` + preflight + rollback), row-locked bootstrap/award concurrency guards (`FOR UPDATE` + atomic `WHERE approval_status = 'pending'`), and `--confirm` + storage-rollback legacy migration safeguards.
- Shared server/client award validation (`src/lib/awardValidation.ts`) enforcing freight-terms & `alternate_spec` acceptance gates, isolated offline-only demo quotation extraction, trusted-proxy IP rate limiting (`req.ip`), S3 `AbortController` timeouts, and advisory-locked maintenance.
- Disposable test DB guard (`TEST_DATABASE_URL` / `TEST_SQL_*`), `RUN_LIVE_GEMINI_TESTS=true` gating, unit stabilization tests, and `.github/workflows/ci.yml`.

## Remaining Actions Before Public Launch

0. **Exit Demo Mode & Restore Full Authentication:**
   - In `NODE_ENV=production`, demo mode is **OFF by default** (and setting `DEMO_MODE=true` fails closed on boot). For local/staging auth testing in non-production environments, set `DEMO_MODE="false"` in `.env` and restart the server. This disables `/api/demo-workspace*` (`410 Gone`) and activates `AuthView` and `OrganizationView`.
1. **Apply Tenant Integrity Migration to Cloud SQL (Maintenance Window):**
   - Take a Cloud SQL on-demand backup, run `psql -v ON_ERROR_STOP=1 -f drizzle/0001_tenant_integrity_preflight.sql` to verify zero legacy orphan/duplicate anomalies, then apply `drizzle/0001_tenant_integrity.sql` (keep `0001_tenant_integrity_rollback.sql` on standby).
2. **Execute Live Disposable PostgreSQL, Live Gemini & Browser UI Verification:**
   - Run the CI workflow (`.github/workflows/ci.yml`) or run `TEST_SQL_*` + `RUN_LIVE_GEMINI_TESTS=true GEMINI_API_KEY="..." npm test` against a disposable PostgreSQL 15+ instance.
   - Perform manual/Playwright browser smoke testing across Extraction Review freight checkbox, Comparison Matrix award blocks, Approval commercial-exception / alternate-spec checkboxes, and PDF/XLSX downloads.
3. **Link Founder Account to `org-kalyani-hydraulics`:**
   - Run `npm run org:bootstrap-owner -- --org-id=org-kalyani-hydraulics --issue-token --email="<founder-email>"` (or `--claim-direct`) once the authorized founder email is ready to take ownership.
4. **Provision Production Runtime Secrets, Managed Services & Dependency Hygiene:**
   - Configure `SESSION_SECRET` (>= 32 random chars), live `GEMINI_API_KEY`, `RESEND_API_KEY` + verified `EMAIL_FROM` DNS (`SPF`/`DKIM`), `STORAGE_PROVIDER=s3` credentials (Cloudflare R2 or AWS S3 private bucket), and `APP_URL` / `ALLOWED_ORIGINS`.
   - Add staging & production domains to **Firebase Authentication → Settings → Authorized Domains**.
   - Enable Cloud SQL automated daily backups + 7-day PITR on an Enterprise tier instance before onboarding paying customers.
   - Optionally align `esbuild` version range (`^0.27.0`/`^0.28.0`) with `vite@8.3.x` when regenerating `package-lock.json` so `npm ci` runs without `--legacy-peer-deps`.
5. **Post-MVP Product Enhancements:**
   - Multi-round revised quotation comparison (`Rev 1` vs. `Rev 2` negotiation deltas).
   - Inbound email/WhatsApp forwarding webhook to route supplier replies directly into an RFQ queue.
   - Organization-configurable dual-approval spend thresholds.
