# NORUS QUOTEFLOW — Project Status

**Last Verified:** Task 003 Completion  
**Current Stage:** Secure Multi-Tenant SaaS Foundation on PostgreSQL (Cloud SQL), Dual Real Authentication (Email/Password + Firebase Google Sign-In), Server-Enforced 5-Role RBAC, Private Object Storage, and PostgreSQL-Backed Rate Limiting.  
**Production Readiness:** **Core Multi-Tenant SaaS Platform Complete** — Production deployment requires provisioning external runtime secrets (`SESSION_SECRET`, `GEMINI_API_KEY`, `S3_*` credentials for multi-replica cloud object storage, and `RESEND_API_KEY` for outbound email delivery). See [Configuration Reference](CONFIGURATION.md) and [Next Task](NEXT_TASK.md).

## Module Status Matrix

| Module | Status | Notes |
| :--- | :--- | :--- |
| Authentication & Sessions | **Production-Ready** | Dual Email/Password (`scrypt` + email verification + password reset) & Firebase Google Sign-In (`firebase-admin`); revocable PostgreSQL sessions (`nf_session` `HttpOnly` cookie) + CSRF token (`X-CSRF-Token`) |
| Multi-Tenancy & Team RBAC | **Production-Ready** | Strict `organizationId` scoping on every query/mutation; 5 roles (`owner`, `admin`, `buyer`, `approver`, `viewer`), invitations, last-owner guard, multi-org switching; `/api/demo/switch-persona` returns `410` |
| Persistence Engine (Cloud SQL PostgreSQL) | **Production-Ready** | 17 relational tables via Drizzle ORM (`src/db/schema.ts`); transactions & FK constraints; idempotent legacy JSON migration verified (`npm run db:migrate`) |
| Private Object Storage | **Production-Ready** | `S3CompatibleStorageProvider` (AWS SigV4 for R2/S3) + `LocalPrivateStorageProvider` outside webroot; signed short-lived `/api/documents/:docId/content` URLs with org ownership verification |
| API Rate Limiting & Security Headers | **Production-Ready** | Atomic PostgreSQL `rate_limit_buckets` (`PostgresRateLimitStore`), strict CORS origin allowlist, `nosniff`/`SAMEORIGIN`/`HSTS` headers, secret redaction |
| Command Center Dashboard | Operational | Uses `computeEvaluatedSavings` and `rankQuotations` (complete/valid quotes only) |
| RFQ Creation & BOM Import | Operational | Per-org sequential `RFQ-YYYY-XXXX` numbering, catalog auto-matching |
| Supplier Directory | Operational | Tenant-scoped duplicate GSTIN/name detection (`409`), double-submit guard |
| File Upload & Security | Hardened | Magic-byte inspection + extension allowlist (`server/fileSecurity.ts`), 25 MB Multer limit (`413`) |
| Gemini Extraction Pipeline | Hardened | Model `gemini-4-hydrogen`; 45s timeout (`504`), bounded retries (`429`), key redaction, JSON validation; stores binary files in object storage (`skipInlineDataUrl: true`) |
| Deterministic Math Audit | Hardened | Server-side verification in `server/normalization.ts`; blocks `/verify` (`422`) when `mathValid === false` |
| Side-by-Side Comparison & Split Award | Hardened | Partial/unverified quotes excluded from `L1` crown (`src/lib/ranking.ts`); split validation enforced |
| Approval Workflow & Price Memory | Hardened | Server-enforced RBAC (`403` for `viewer`, `approver`/`admin`/`owner` required for `/decide`); updates `price_history` & `catalog_items` |
| PDF & Excel Comparative Exports | Hardened | 4-sheet Excel with live formulas + `sanitizeSpreadsheetCell`; landscape PDF with split-award breakdown |

## Verified Checks

- `npm run lint` (`tsc --noEmit`): Passes with zero errors.
- `npm run build` (`vite build`): Builds production client bundle cleanly.
- `npm test` (`tsx --test tests/*.test.ts`): 24 automated tests pass (0 failed; 1 live Gemini API smoke test skipped when `GEMINI_API_KEY` is unset).
- `npm run db:migrate -- --apply`: Verified legacy JSON (`data/quoteflow-db.json`) migrated to live Cloud SQL PostgreSQL with exact row-count parity and pre-migration backup preserved.
