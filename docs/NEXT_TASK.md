# Next Task — Production Secrets, Live Gemini Calibration & Post-MVP Enhancements

## Completed in Task 003
- Cloud SQL PostgreSQL (`asia-southeast1`) schema pushed and legacy workspace migrated (`npm run db:migrate -- --apply`).
- Dual real authentication (Email/Password + Firebase Google Sign-In), PostgreSQL revocable sessions, CSRF, CORS, and rate limiting implemented and verified.
- Multi-organization isolation, 5-role RBAC, team invitations, and private object storage (`S3CompatibleStorageProvider` + `LocalPrivateStorageProvider`) verified.

## Recommended Next Priorities

1. **Provision Production Runtime Secrets & External Providers:**
   - Set a strong random `SESSION_SECRET`, live `GEMINI_API_KEY`, `RESEND_API_KEY` + verified `EMAIL_FROM` domain, and `STORAGE_PROVIDER=s3` credentials (Cloudflare R2 or AWS S3 private bucket) before public launch.
   - Verify `npm test` with `GEMINI_API_KEY` configured so the live Gemini extraction smoke test executes alongside offline tests.
2. **Operational Hardening & Cleanup Jobs:**
   - Add a scheduled cleanup task for expired `sessions`, expired/accepted `invitations`, and stale `rate_limit_buckets`.
   - Enable automated Cloud SQL point-in-time recovery (PITR) and S3 lifecycle retention policies on the production bucket.
3. **Pre-PO Domain Expansion (Customer Pilot Feedback):**
   - Multi-round revised quotation comparison (`Rev 1` vs. `Rev 2` negotiation deltas) linked to the same supplier/RFQ.
   - Email/WhatsApp inbound forwarding webhook to route supplier replies directly into an RFQ's pending extraction queue.
   - Organization-customizable approval thresholds (e.g., dual approval required above configurable spend limits).
