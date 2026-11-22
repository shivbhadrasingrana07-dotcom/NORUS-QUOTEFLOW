# Next Task — Production Authentication, Multi-Tenancy & PostgreSQL Persistence

## Objective
Upgrade NORUS QUOTEFLOW from a single-workspace sandbox demo to a multi-tenant, authenticated production platform without regressing existing extraction, normalization, or comparative export capabilities.

## Scope & Concrete Deliverables
1. **Real Authentication & Session Verification:**
   - Replace the sandbox `POST /api/demo/switch-persona` switcher with real user authentication (e.g., Firebase Auth or signed HTTP-only session/JWT tokens) and server-side user lookup per request.
   - Remove client-modifiable `activeUserRole` from `PATCH /api/settings`; manage workspace memberships and roles via dedicated admin-only endpoints.
2. **PostgreSQL + Object Storage Migration:**
   - Migrate `server/db.ts` from single-file JSON (`data/quoteflow-db.json`) to transactional PostgreSQL (tenant-scoped schema with foreign keys on `organization_id`, `rfqs`, `quotations`, `quotation_lines`, `awards`, `audit_logs`).
   - Move uploaded quotation PDFs/images out of inline `fileDataUrl` strings into authenticated private object storage (S3/GCS) with signed short-lived preview URLs.
3. **API Rate Limiting & Live Gemini Calibration:**
   - Add per-user/IP rate limiting on `/api/rfqs/:rfqId/quotes/extract` and `/api/rfqs/*` mutations.
   - Run the gated live Gemini extraction test suite against real vendor PDF/Excel/image/WhatsApp samples using a provisioned `GEMINI_API_KEY`.
