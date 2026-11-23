# Next Task — External Secrets, Domain Setup & Commercial Pilot Rollout

## Completed Through Task 007
- Dual server-verified authentication (Email/Password + hardened Google Sign-In with `openid`/`email`/`profile`, `FIREBASE_CHECK_REVOKED` opt-in, `aud`/`iss` validation, and verified-email linking guard).
- Cloud SQL PostgreSQL 18.6 (`asia-southeast1`) with 17 relational tables, verified constraints/indexes, and migrated `org-kalyani-hydraulics` data (`data/quoteflow-db.json` preserved).
- Safe first-owner bootstrap tooling (`npm run org:bootstrap-owner`), idempotent scheduled maintenance (`npm run ops:maintenance`), operational monitoring (`/api/health`, `/api/health/ready`, `X-Request-Id`, `ERROR_WEBHOOK_URL`), Task 006/007 hardened isolated synthetic demo mode (auto-disabled & fail-closed in production, zero-PG bounded rate limiters, genuine PDF/Excel sample previews), and comprehensive automated tests.

## Remaining External Setup Actions Before Public Launch

0. **Exit Demo Mode & Restore Full Authentication:**
   - In `NODE_ENV=production`, demo mode is **OFF by default** (and setting `DEMO_MODE=true` fails closed on boot). For local/staging auth testing in non-production environments, set `DEMO_MODE="false"` in `.env` and restart the server. This disables `/api/demo-workspace*` (`410 Gone`) and activates `AuthView` (Google Sign-In + Email/Password login, registration, email verification, password reset) and `OrganizationView` (team & org switching).
1. **Link Founder Account to `org-kalyani-hydraulics`:**
   - Run `npm run org:bootstrap-owner -- --org-id=org-kalyani-hydraulics --issue-token --email="<founder-email>"` (or `--claim-direct`) once the authorized founder email is ready to take ownership.
2. **Provision Production Runtime Secrets & Managed Services:**
   - Configure `SESSION_SECRET` (>= 32 random chars), live `GEMINI_API_KEY`, `RESEND_API_KEY` + verified `EMAIL_FROM` DNS (`SPF`/`DKIM`), `STORAGE_PROVIDER=s3` credentials (Cloudflare R2 or AWS S3 private bucket), and `APP_URL` / `ALLOWED_ORIGINS`.
   - Add staging & production domains to **Firebase Authentication → Settings → Authorized Domains**.
   - Enable Cloud SQL automated daily backups + 7-day PITR on an Enterprise tier instance before onboarding paying customers.
   - Re-run `GEMINI_API_KEY="..." npm test` in CI/staging to verify live Gemini extraction alongside the offline suite.
3. **Post-MVP Product Enhancements:**
   - Multi-round revised quotation comparison (`Rev 1` vs. `Rev 2` negotiation deltas).
   - Inbound email/WhatsApp forwarding webhook to route supplier replies directly into an RFQ queue.
   - Organization-configurable dual-approval spend thresholds.
