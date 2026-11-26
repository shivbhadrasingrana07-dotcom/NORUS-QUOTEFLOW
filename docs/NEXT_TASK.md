# Next Task — Safe Staging Cutover, Cloud SQL Migration Window & Controlled Production Launch

## Completed Through Task 012
- **GitHub `main` & CI Run `#7` Verified (`66b9367ee2eb0a29788cd3efd5473e9bd9954250`, Run `#45767730514`):** Confirmed Task 011 code and docs were pushed to `main` and match the local workspace SHA-1 hashes identically; both CI `verify` and `browser-e2e` jobs finished with `conclusion: "success"` *(raw CI logs remain `HTTP 403` unauthenticated)*.
- **Task 012 Production Readiness & Cutover Planning Complete:** Completed full 10-area security assessment, 12-item production infrastructure specification, two-stage `xlsx@0.18.5` / legacy `.xls` migration strategy, 6 operational readiness checklists, and documentation reconciliation (`README.md`, `PROJECT_STATUS.md`, `SECURITY.md`, `CONFIGURATION.md`, `TESTING.md`).

## Ordered Safe Cutover Sequence (Staging -> Controlled Pilot -> Public GA)

1. **Archive Authenticated CI Logs & Run Staging Smoke Suite:**
   - Download authenticated Run `#7` logs from GitHub Actions UI to verify exact `12` PG integration test passes (zero unexpected skips) and `browser-e2e` stdout.
   - Provision staging environment (`NODE_ENV=production`, `DEMO_MODE` unset/`false`, `CSP_MODE=report-only`, disposable/staging PostgreSQL 15+, private R2/S3 bucket, Resend sandbox/domain) and execute `RUN_LIVE_GEMINI_TESTS=true` smoke extraction.
2. **Execute Cloud SQL Backup, Preflight & `0001_tenant_integrity.sql` Window:**
   - Upgrade pilot DB tier as needed, enable daily backups + 7-day PITR, capture an on-demand Cloud SQL backup, run `drizzle/0001_tenant_integrity_preflight.sql` (confirming `0` blocking mismatches), and apply `drizzle/0001_tenant_integrity.sql` (`BEGIN;...COMMIT;`).
3. **Provision Production Secrets, External Services & Domains:**
   - Configure Secret Manager values: `SESSION_SECRET` (`>= 32` random chars), `GEMINI_API_KEY`, `RESEND_API_KEY`, `EMAIL_FROM` (`SPF`/`DKIM`/`DMARC`), `STORAGE_PROVIDER=s3` + `S3_*`, `SQL_*` (Cloud SQL socket or `SQL_SSL=true` + `SQL_SSL_CA`), `APP_URL`, `ALLOWED_ORIGINS`, `TRUST_PROXY_HOPS`, and `ERROR_WEBHOOK_URL`.
   - Register staging/production hostnames in Firebase Console → Authentication → Settings → Authorized Domains; set `CSP_MODE=enforce` after confirming zero `report-only` violations.
4. **Link Founder Ownership (`org-kalyani-hydraulics`) & Run Readiness Probes:**
   - Run `npm run org:bootstrap-owner -- --org-id=org-kalyani-hydraulics --issue-token --email="<founder-email>"` (or `--claim-direct`).
   - Verify `GET /api/health` (`200`), `GET /api/health/ready` (`200`, `database.ok: true`, `storage.ok: true`, `email.mode: "resend"`), and `GET /api/demo-workspace` (`410 Gone`).
5. **Execute Phased `xlsx@0.18.5` Replacement (Stage 1 -> Stage 2):**
   - **Stage 1:** Migrate `.xlsx` exports (`src/lib/exporters.ts`, `server/demoWorkspace.ts`) to `write-excel-file@4.1.1` and `.xlsx` reads (`server/spreadsheetWorker.mjs`) to `read-excel-file@9.3.20` (`read-excel-file/node`), eliminating `xlsx` from the client bundle.
   - **Stage 2:** Deprecate legacy binary OLE2 `.xls` (`415` guidance while preserving plain UTF-8 text-table `.xls` via `parseDelimitedTextToRows`) OR deploy an isolated `.xls -> .xlsx` converter, then `npm uninstall xlsx`.
6. **Optional Auth Hardening Sprint (Recommended Before Broad Public Self-Serve GA):**
   - Enforce email verification before high-cost actions (AI extraction, team invites) and add per-email login throttling alongside IP rate limits.


