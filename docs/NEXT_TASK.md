# Next Task — External Secrets, Domain Setup & Commercial Pilot Rollout

## Completed Through Task 008
- Dual server-verified authentication (Email/Password + hardened Google Sign-In with `openid`/`email`/`profile`, `FIREBASE_CHECK_REVOKED` opt-in, `aud`/`iss` validation, live `isGoogleAuthConfigured()` checks, 10-session cap per user, and verified-email linking guard).
- Composite same-organization transactional SQL integrity migration (`drizzle/0001_tenant_integrity.sql` + preflight + rollback wrapped in `BEGIN;...COMMIT;`), row-locked bootstrap/award concurrency guards (`FOR UPDATE` + atomic `WHERE approval_status = 'pending'`), concurrent RFQ sequence fix (`organizations FOR UPDATE`, no `< 9000` ceiling), and `--confirm` + storage-rollback legacy migration safeguards.
- Procurement integrity & precision: scaled `getQuantityTolerance` / `isLineQuantitySufficient` (`QUANTITY_EPSILON = 1e-4` for `>= 1`, proportional scaling for `< 1` micro-quantities) and matching `awardedQty` validation, cent-accurate `isExceedingL1Total`, immutable `rejected` award history preservation, pending `withdrawAward` endpoints + UI revision/withdraw workflows, pending/approved/rejected quote snapshot locks (`409`), Extraction Review Short/Excess Qty labels, Matrix exclusion-reason indicators, and PDF/Excel `Insufficient Quantity` / `[Short Qty]` exception parity.
- Strict PostgreSQL TLS (`buildPgSslConfig` with `SQL_SSL_CA`), production `Content-Security-Policy-Report-Only` / `CSP_MODE`, configurable `COOKIE_SAMESITE` & `TRUST_PROXY_HOPS`, isolated offline-only demo extraction, S3 `AbortController` timeouts, advisory-locked maintenance, and hardened `getSafeTestDbConfig()` disposable test DB guards.

## Remaining Actions Before Public Launch

0. **Run Full CI PostgreSQL Integration, Migration/Rollback & Browser E2E Verification (Immediate Recommended Next Task):**
   - Execute `.github/workflows/ci.yml` or run `npm test` against a disposable PostgreSQL 15+ instance (`TEST_SQL_*`) to verify all `11` skipped PG integration tests (`apiAndDb.test.ts`, `authAndMultiTenancy.test.ts`, `e2eWorkflow.test.ts`, live PG specs in `opsAndMonitoring.test.ts` and `objectStorageAndRateLimit.test.ts`), live `psql` apply + rollback + re-apply of `drizzle/0001_tenant_integrity*.sql`, and optional `RUN_LIVE_GEMINI_TESTS=true`.
   - Execute manual or headless Playwright/Chromium browser E2E verification (Chromium/Playwright binaries absent in current sandbox) covering Extraction Review quote locking & freight checkbox, Comparison Matrix quantity sufficiency & L1/split gates, Approval `Withdraw Pending Recommendation` & `Revise & Resubmit Recommendation`, and PDF/XLSX downloads.
1. **Exit Demo Mode & Restore Full Authentication:**
   - In `NODE_ENV=production`, demo mode is **OFF by default** (and setting `DEMO_MODE=true` fails closed on boot). For local/staging auth testing in non-production environments, set `DEMO_MODE="false"` in `.env` and restart the server. This disables `/api/demo-workspace*` (`410 Gone`) and activates `AuthView` and `OrganizationView`.
2. **Apply Tenant Integrity Migration to Cloud SQL (Maintenance Window):**
   - Take a Cloud SQL on-demand backup, run `psql -v ON_ERROR_STOP=1 -f drizzle/0001_tenant_integrity_preflight.sql` to verify zero legacy orphan/duplicate anomalies, then apply `drizzle/0001_tenant_integrity.sql` (`BEGIN;...COMMIT;`, PostgreSQL 15+) and keep `0001_tenant_integrity_rollback.sql` on standby.
3. **Link Founder Account to `org-kalyani-hydraulics`:**
   - Run `npm run org:bootstrap-owner -- --org-id=org-kalyani-hydraulics --issue-token --email="<founder-email>"` (or `--claim-direct`) once the authorized founder email is ready to take ownership.
4. **Provision Production Runtime Secrets, Managed Services & Dependency Hygiene:**
   - Configure `SESSION_SECRET` (>= 32 random chars), live `GEMINI_API_KEY`, `RESEND_API_KEY` + verified `EMAIL_FROM` DNS (`SPF`/`DKIM`), `STORAGE_PROVIDER=s3` credentials (Cloudflare R2 or AWS S3 private bucket), `SQL_SSL_CA` (if using TCP TLS), explicit `APP_URL` / `ALLOWED_ORIGINS` (prevents `getAppBaseUrl` `Host` fallback on transactional email links), and switch `CSP_MODE=enforce` after confirming report-only clean telemetry.
   - Add staging & production domains to **Firebase Authentication → Settings → Authorized Domains**.
   - Enable Cloud SQL automated daily backups + 7-day PITR on an Enterprise tier instance before onboarding paying customers.
   - Address `npm audit` findings (`xlsx@0.18.5` high Prototype Pollution / ReDoS with no OSS fix available—evaluate `exceljs` migration or strict worksheet parse worker limits—plus upstream `@grpc/grpc-js` under `firebase` and `esbuild` under `drizzle-kit` / `vite@8.3.x`) before public commercial rollout.
5. **Post-MVP Product Enhancements:**
   - Multi-round revised quotation comparison (`Rev 1` vs. `Rev 2` negotiation deltas).
   - Inbound email/WhatsApp forwarding webhook to route supplier replies directly into an RFQ queue.
   - Organization-configurable dual-approval spend thresholds.
