# Next Task — Safe Staging Cutover, Cloud SQL Migration Window & Controlled Production Launch

## Completed Through Task 013.2
- **GitHub `main`, CI Runs `#9`–`#10` & Lockfile Reconciliation (`8f2f977a` -> `e9d1ec2c`, Runs `45776297361` & `45869793457`):** Confirmed Task 013 remediation code, `package.json`, `package-lock.json`, tests, and Task 013.1 docs are committed on `main` (`82 / 83` files match prior to Task 013.2 doc edits); both CI `verify` and `browser-e2e` jobs completed with `conclusion: "success"` on Runs `#9` and `#10` *(raw CI logs remain `HTTP 403` unauthenticated)*. Locally reconciled `bun.lock` (`06ba920b`) via `bun v1.4.4` (`bun install --frozen-lockfile` passing cleanly, `0` `"xlsx"` / SheetJS entries, `0` direct dependency drift vs. `package-lock.json`) — ready for one clean push to sync remote `bun.lock` (`c29d02c2`).
- **Task 012 Production Readiness & Cutover Planning Complete:** Completed full 10-area security assessment, 12-item production infrastructure specification, operational checklists, and documentation reconciliation.
- **Task 013 `xlsx@0.18.5` Remediation & Compatibility Complete:** Uninstalled `xlsx@0.18.5` (and all 21 SheetJS transitive entries) completely from npm dependencies, migrated OOXML `.xlsx` reads (`server/spreadsheetWorker.mjs`) to `read-excel-file@9.3.20` (`read-excel-file/node` w/ XXE-immune `saxen`), migrated Comparative Statement & demo `.xlsx` exports (`src/lib/exporters.ts`, `server/demoWorkspace.ts`) to `write-excel-file@4.1.1` (preserving ECMA-376 `<f>` formulas), kept native UTF-8 text-table `.xls` support, and enforced explicit `415` save-as-`.xlsx`/`.csv` guidance for binary OLE2 `.xls` uploads (`0` remaining direct `xlsx` advisories).

## Ordered Safe Cutover Sequence (Staging -> Controlled Pilot -> Public GA)

1. **Push Reconciled `bun.lock`, Inspect Authenticated CI Logs & Run Staging Smoke Suite:**
   - Commit and push local `bun.lock` (`06ba920b`) + Task 013.2 documentation sync to `main`, confirm remote CI Run `#11` passes, and download authenticated Run `#9` (`45776297361`) / Run `#11` logs from GitHub Actions UI to verify exact `59` executed / `1` Gemini-skipped test output and `BROWSER_E2E_PASSED` stdout.
   - Provision staging environment (`NODE_ENV=production`, `DEMO_MODE` unset/`false`, `CSP_MODE=report-only`, disposable/staging PostgreSQL 15+, private R2/S3 bucket, Resend sandbox/domain) and execute `RUN_LIVE_GEMINI_TESTS=true` smoke extraction.
2. **Execute Cloud SQL Backup, Preflight & `0001_tenant_integrity.sql` Window:**
   - Upgrade pilot DB tier as needed, enable daily backups + 7-day PITR, capture an on-demand Cloud SQL backup, run `drizzle/0001_tenant_integrity_preflight.sql` (confirming `0` blocking mismatches), and apply `drizzle/0001_tenant_integrity.sql` (`BEGIN;...COMMIT;`).
3. **Provision Production Secrets, External Services & Domains:**
   - Configure Secret Manager values: `SESSION_SECRET` (`>= 32` random chars), `GEMINI_API_KEY`, `RESEND_API_KEY`, `EMAIL_FROM` (`SPF`/`DKIM`/`DMARC`), `STORAGE_PROVIDER=s3` + `S3_*`, `SQL_*` (Cloud SQL socket or `SQL_SSL=true` + `SQL_SSL_CA`), `APP_URL`, `ALLOWED_ORIGINS`, `TRUST_PROXY_HOPS`, and `ERROR_WEBHOOK_URL`.
   - Register staging/production hostnames in Firebase Console → Authentication → Settings → Authorized Domains; set `CSP_MODE=enforce` after confirming zero `report-only` violations.
4. **Link Founder Ownership (`org-kalyani-hydraulics`) & Run Readiness Probes:**
   - Run `npm run org:bootstrap-owner -- --org-id=org-kalyani-hydraulics --issue-token --email="<founder-email>"` (or `--claim-direct`).
   - Verify `GET /api/health` (`200`), `GET /api/health/ready` (`200`, `database.ok: true`, `storage.ok: true`, `email.mode: "resend"`), and `GET /api/demo-workspace` (`410 Gone`).
5. **Optional Auth Hardening Sprint (Recommended Before Broad Public Self-Serve GA):**
   - Enforce email verification before high-cost actions (AI extraction, team invites) and add per-email login throttling alongside IP rate limits.


