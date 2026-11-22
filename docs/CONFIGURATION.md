# Configuration Reference

## Environment Variables

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `SQL_HOST` | Yes (runtime) | *(unset)* | Cloud SQL / PostgreSQL host IP or Unix socket path |
| `SQL_PORT` | No | `5432` | PostgreSQL port |
| `SQL_DB_NAME` | Yes (runtime) | *(unset)* | PostgreSQL database name |
| `SQL_USER` | Yes (runtime) | *(unset)* | PostgreSQL application user |
| `SQL_PASSWORD` | Yes (runtime) | *(unset)* | PostgreSQL application password |
| `SQL_SSL` | No | `false` | Set `'true'` for TLS PostgreSQL connections |
| `SESSION_SECRET` | **Yes in prod** | Dev ephemeral key | >= 24-char HMAC/token secret (`server/security.ts` fails closed in production if unset) |
| `GEMINI_API_KEY` | For live AI extraction | *(unset)* | Server-side API key for `@google/genai` (`gemini-4-hydrogen`). Never prefix with `VITE_` |
| `STORAGE_PROVIDER` | No | `local` | `'local'` (private filesystem `data/private-storage/`) or `'s3'` (AWS SigV4 object storage) |
| `LOCAL_STORAGE_DIR` | No | `data/private-storage` | Private local object storage directory when `STORAGE_PROVIDER=local` |
| `S3_ENDPOINT` | If `STORAGE_PROVIDER=s3` | *(unset)* | S3 / Cloudflare R2 / MinIO endpoint URL |
| `S3_REGION` | No | `auto` | S3 region for SigV4 signing (`us-east-1`, `ap-south-1`, `auto`) |
| `S3_BUCKET` | If `STORAGE_PROVIDER=s3` | *(unset)* | Private bucket name (non-public ACL) |
| `S3_ACCESS_KEY_ID` | If `STORAGE_PROVIDER=s3` | *(unset)* | S3 access key ID |
| `S3_SECRET_ACCESS_KEY` | If `STORAGE_PROVIDER=s3` | *(unset)* | S3 secret access key |
| `RESEND_API_KEY` | No | *(unset)* | If set, sends transactional auth/invite emails via Resend; otherwise uses `DevOutboxEmailProvider` |
| `EMAIL_FROM` | No | `NORUS QUOTEFLOW <noreply@norus.local>` | Sender address for outbound transactional emails |
| `APP_URL` | No | *(runtime-injected)* | Public base URL used for verification/reset/invite links and CORS origin allowlist |
| `ALLOWED_ORIGINS` | No | *(unset)* | Comma-separated extra allowed browser origins for `/api/*` |
| `PORT` | No | `3000` | HTTP port listened on by Express (`server.ts`) |
| `NODE_ENV` | No | `development` | Enforces fail-closed `SESSION_SECRET`/`SQL_*` checks, `Secure` cookies, HSTS, and static `dist/` serving |
| `QUOTEFLOW_DB_PATH` | No | `data/quoteflow-db.json` | Legacy JSON source file path read by `scripts/migrate-json-to-postgres.ts` |

## Key NPM Scripts (`package.json`)

| Script | Command | Purpose |
| :--- | :--- | :--- |
| `npm run dev` | `tsx server.ts` | Starts Express + Vite dev server on port `3000` |
| `npm run start` | `NODE_ENV=production tsx server.ts` | Starts Express serving built `dist/` assets |
| `npm run build` | `vite build` | Compiles production frontend bundle into `dist/` |
| `npm run lint` | `tsc --noEmit` | Runs strict TypeScript typechecking across client, server, and tests |
| `npm test` | `tsx --test tests/*.test.ts` | Runs the automated Node test suite |
| `npm run db:migrate` | `tsx scripts/migrate-json-to-postgres.ts` | Legacy JSON -> PostgreSQL migration CLI (`--dry-run`, `--apply`, `--owner-email=...`) |

## Extraction & Upload Constants

- **Gemini Model:** `GEMINI_EXTRACTION_MODEL = 'gemini-4-hydrogen'` (`server/geminiExtractor.ts`)
- **Extraction Timeout:** `45000` ms (`45s`)
- **Upload Size Cap:** `25 * 1024 * 1024` bytes (`25 MB`) in `server.ts`
- **Spreadsheet Parse Limits:** Up to `4` sheets, `120` rows/sheet, `30` columns/row
- **Session TTL / Signed URL TTL:** Sessions valid `7 days`; private signed download URLs valid `300s`
