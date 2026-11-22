# NORUS QUOTEFLOW — Project Status

**Last Verified:** Task 006 Completion (Temporary No-Login Demo Mode)  
**Current Stage:** **Temporary No-Login Demo Experience** (`DEMO_MODE !== "false"`) serving an isolated, synthetic procurement sandbox (`demo-org-synthetic`), while retaining the underlying Task 003–005 PostgreSQL multi-tenant SaaS, Firebase Google Sign-In, Email/Password auth, RBAC, and private object storage infrastructure intact behind `DEMO_MODE="false"`.  
**Production Readiness:** **NOT Production-Ready (Temporary Demo Mode Active)** — The live preview currently opens directly into a synthetic no-login demo workspace for evaluation. Real customer records in Cloud SQL (`org-kalyani-hydraulics`) remain strictly inaccessible without authentication. To return to the authenticated multi-tenant application before staging/production launch, set `DEMO_MODE="false"`, configure external runtime secrets (`SESSION_SECRET`, `RESEND_API_KEY`, `STORAGE_PROVIDER=s3`, Firebase Authorized Domains), and link the founder account via `npm run org:bootstrap-owner`. See [Configuration Reference](CONFIGURATION.md) and [Next Task](NEXT_TASK.md).

## Module Status Matrix

| Module | Status | Notes |
| :--- | :--- | :--- |
| Temporary No-Login Demo Workspace | **Active (Demo Only)** | Synthetic in-memory per-visitor workspace (`server/demoWorkspace.ts`, `/api/demo-workspace*`); zero Cloud SQL access, zero customer data exposure, clear `DEMO` UI banners, and one-click `Reset Demo Data` |
| Authentication & Sessions *(Internal / Restorable)* | **Preserved (`DEMO_MODE=false` restores)** | Dual Email/Password (`scrypt`) + Firebase Google Sign-In + revocable PostgreSQL `nf_session` cookies + CSRF remain enforced on all real `/api/*` endpoints; UI login screens temporarily bypassed while `demoMode: true` |
| Multi-Tenancy, RBAC & Bootstrap | **Preserved** | Strict `organizationId` scoping; 5 roles (`owner`, `admin`, `buyer`, `approver`, `viewer`), invitations, last-owner guard (`409`); `org-kalyani-hydraulics` in Cloud SQL remains untouched & locked behind auth |
| Private Object Storage | **Preserved** | Real tenant docs stay in `S3CompatibleStorageProvider` / `LocalPrivateStorageProvider` behind `/api/documents/*` (`401` unauthenticated); demo uploads stay strictly in visitor memory with HMAC-signed `/api/demo-workspace/documents/*` URLs |
| Transactional Email Delivery | **Preserved** | `ResendEmailProvider` + `DevOutboxEmailProvider` remain intact for auth restoration |
| Monitoring & Scheduled Maintenance | **Operational** | `X-Request-Id` correlation middleware, secret-redacted structured JSON logs, `/api/health`, `/api/health/ready`, and `server/maintenance.ts` |
| API Rate Limiting & Security Headers | **Operational** | Atomic `rate_limit_buckets` rate limiters (`extractRateLimiter` / `mutationRateLimiter` also guard `/api/demo-workspace*`), strict CORS allowlist, `nosniff`/`SAMEORIGIN`/COOP headers |
| Command Center Dashboard | Operational (Demo & Auth) | Uses `computeEvaluatedSavings` and `rankQuotations` (complete/valid quotes only) |
| RFQ Creation & BOM Import | Operational (Demo & Auth) | Supports synthetic `DEMO-RFQ-2026-XXX` in demo mode and PostgreSQL `RFQ-YYYY-XXXX` when authenticated |
| Supplier Directory | Operational (Demo & Auth) | Duplicate name/Tax ID detection (`409`) |
| File Upload & Security | Hardened (Demo & Auth) | Magic-byte inspection + extension allowlist (`server/fileSecurity.ts`), 25 MB Multer limit (`413`) |
| Gemini Extraction Pipeline | Operational (Demo & Auth) | Uses live Gemini when `GEMINI_API_KEY` is configured or deterministic offline demo parser (`extractDemoQuotationOffline`) otherwise |
| Deterministic Math Audit | Hardened (Demo & Auth) | Server-side verification in `server/normalization.ts`; blocks `/verify` (`422`) when `mathValid === false` |
| Side-by-Side Comparison & Split Award | Hardened (Demo & Auth) | Partial/unverified quotes excluded from `L1` crown (`src/lib/ranking.ts`); non-L1 justification & split validation enforced |
| Approval Workflow & Price Memory | Operational (Demo & Auth) | Updates synthetic demo catalog/price memory in demo mode and PostgreSQL `price_history` when authenticated |
| PDF & Excel Comparative Exports | Operational (Demo & Auth) | 4-sheet Excel with live formulas + `sanitizeSpreadsheetCell`; landscape PDF with split-award breakdown |

## Verified Checks (Task 006)

- `npm run lint` (`tsc --noEmit`): Passes with zero errors.
- `npm run build` (`vite build`): Passes cleanly.
- `npm test` (`tsx --test tests/*.test.ts`): Covers auth, multi-tenancy, E2E procurement, ops/monitoring, object storage, normalization, extraction, exporters, plus `tests/demoWorkspace.test.ts` (isolated demo workflow, zero real-tenant leakage, `401` on real routes, `410` restoration toggle).
- Cloud SQL `org-kalyani-hydraulics` verified untouched with zero demo records written to PostgreSQL.
