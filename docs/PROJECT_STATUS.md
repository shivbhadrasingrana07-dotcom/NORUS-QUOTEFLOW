# NORUS QUOTEFLOW — Project Status

**Last Verified:** Task 007 Completion (Final MVP Audit, Security Hardening & Workflow Completion)  
**Current Stage:** **MVP Demo Preview Ready (`DEMO_MODE` active in non-production dev/test; strictly OFF & fail-closed in `NODE_ENV=production`)**. Visitors in preview land directly in an isolated, synthetic procurement sandbox (`demo-org-synthetic`) with genuine generated PDF & Excel document previews, while the underlying Task 003–005 PostgreSQL multi-tenant SaaS, Firebase Google Sign-In, Email/Password auth, RBAC, and private object storage infrastructure remain intact behind `DEMO_MODE="false"` (and default-active in `NODE_ENV=production`).  
**Production Readiness:** **MVP Demo Complete (Pre-Commercial Launch)** — Real customer records in Cloud SQL (`org-kalyani-hydraulics`) remain strictly untouched and locked behind authentication. Before public multi-tenant onboarding, deploy with `NODE_ENV=production` (demo mode automatically disabled), provision external runtime secrets (`SESSION_SECRET`, `RESEND_API_KEY`, `STORAGE_PROVIDER=s3`, Firebase Authorized Domains), and link the founder account via `npm run org:bootstrap-owner`. See [Configuration Reference](CONFIGURATION.md) and [Next Task](NEXT_TASK.md).

## Module Status Matrix

| Module | Status | Notes |
| :--- | :--- | :--- |
| Temporary No-Login Demo Workspace | **Hardened (Non-Prod Only)** | Synthetic in-memory per-visitor workspace (`server/demoWorkspace.ts`, `/api/demo-workspace*`); auto-disabled & fail-closed in `NODE_ENV=production`, zero Cloud SQL reads/writes, genuine synthetic PDF (`%PDF-`) & XLSX previews, per-session quotas, and one-click `Reset Demo Data` |
| Authentication & Sessions *(Internal / Restorable)* | **Preserved (`DEMO_MODE=false` / Prod Default)** | Dual Email/Password (`scrypt`) + Firebase Google Sign-In + revocable PostgreSQL `nf_session` cookies + CSRF remain enforced on all real `/api/*` endpoints |
| Multi-Tenancy, RBAC & Bootstrap | **Preserved** | Strict `organizationId` scoping; 5 roles (`owner`, `admin`, `buyer`, `approver`, `viewer`), invitations, last-owner guard (`409`); `org-kalyani-hydraulics` in Cloud SQL remains untouched & locked behind auth |
| Private Object Storage | **Preserved** | Real tenant docs stay in `S3CompatibleStorageProvider` / `LocalPrivateStorageProvider` behind `/api/documents/*` (`401` unauthenticated); demo sample/uploaded previews stay strictly in visitor memory with non-allocating HMAC-signed `/api/demo-workspace/documents/*` URLs |
| Transactional Email Delivery | **Preserved** | `ResendEmailProvider` + `DevOutboxEmailProvider` remain intact for auth restoration |
| Monitoring & Scheduled Maintenance | **Operational** | `X-Request-Id` correlation middleware, secret-redacted structured JSON logs, `/api/health`, `/api/health/ready`, and `server/maintenance.ts` |
| API Rate Limiting & Security Headers | **Hardened** | Dedicated bounded-LRU `MemoryRateLimitStore` for `/api/demo-workspace*` (zero Cloud SQL writes); atomic PostgreSQL `rate_limit_buckets` for authenticated & auth endpoints; strict CORS allowlist & `nosniff`/`SAMEORIGIN`/COOP headers |
| Command Center Dashboard | Operational (Demo & Auth) | Uses `computeEvaluatedSavings` and `rankQuotations` (complete/valid quotes only) |
| RFQ Creation & BOM Import | Operational (Demo & Auth) | Supports synthetic `DEMO-RFQ-2026-XXX` in demo mode and PostgreSQL `RFQ-YYYY-XXXX` when authenticated |
| Supplier Directory | Operational (Demo & Auth) | Duplicate name/Tax ID detection (`409`) |
| File Upload & Security | Hardened (Demo & Auth) | Magic-byte inspection + extension allowlist (`server/fileSecurity.ts`), 25 MB Multer limit (`413`) |
| Gemini Extraction Pipeline | Operational (Demo & Auth) | Uses live Gemini when `GEMINI_API_KEY` is configured or deterministic offline demo parser (`extractDemoQuotationOffline`) otherwise |
| Deterministic Math Audit | Hardened (Demo & Auth) | Server-side verification in `server/normalization.ts`; blocks `/verify` (`422`) when `mathValid === false` |
| Side-by-Side Comparison & Split Award | Hardened (Demo & Auth) | Partial/unverified quotes excluded from `L1` crown (`src/lib/ranking.ts`); non-L1 justification & split validation enforced; stale `draftAward` clears on quote edits |
| Approval Workflow & Price Memory | Operational (Demo & Auth) | Updates synthetic demo catalog/price memory in demo mode and PostgreSQL `price_history` when authenticated |
| PDF & Excel Comparative Exports | Hardened (Demo & Auth) | 4-sheet Excel with live formulas + `sanitizeSpreadsheetCell` + `award` allocation inclusion in Approval tab; landscape PDF with split-award breakdown |

## Verified Checks (Task 007)

- `npm run lint` (`tsc --noEmit`): Passes with zero errors.
- `npm run build` (`vite build`): Passes cleanly.
- `npm test` (`tsx --test tests/*.test.ts`): Covers Tasks 002–007 including `resolveDemoMode` dev/prod fail-closed behavior, zero PG rate-limiter hits from demo routes, `MemoryRateLimitStore` LRU capacity capping, non-allocating unknown-session doc lookups, genuine sample PDF/XLSX binary serving, strict validation, and comparative exports with award data.
- Cloud SQL `org-kalyani-hydraulics` verified untouched (`2` RFQs, `5` quotations, `4` suppliers) with zero `demo-%` records written to PostgreSQL.
