# Security Posture & Known Limitations

## Implemented Controls

1. **Upload File Validation (`server/fileSecurity.ts`):**
   - 25 MB upload size limit enforced by Multer (`413 Payload Too Large`).
   - Strict extension allowlist (`.pdf`, `.xlsx`, `.xls`, `.csv`, `.png`, `.jpg`, `.jpeg`, `.webp`).
   - Explicit denylist for active/executable/macro types (`.exe`, `.dll`, `.sh`, `.bat`, `.cmd`, `.js`, `.mjs`, `.html`, `.htm`, `.svg`, `.xlsm`, `.docm`, `.zip`).
   - Magic-byte signature inspection (PDF `%PDF-`, PNG, JPEG, WEBP `RIFF...WEBP`, XLSX OpenXML `PK\x03\x04`, XLS OLE2 or UTF-8 text, CSV UTF-8 text without NUL/control bytes).
   - Cross-platform path-traversal and control-character stripping via `sanitizeFilename`.
2. **Gemini API Key Isolation (`server/geminiExtractor.ts`):**
   - `GEMINI_API_KEY` is read strictly on the server and never sent to the frontend, `/api/health`, or exported statements.
   - Error messages run through `sanitizeErrorMessage` to redact `GEMINI_API_KEY` values and `AIza...` patterns.
3. **Spreadsheet Formula Injection Sanitization (`src/lib/exporters.ts`):**
   - `sanitizeSpreadsheetCell` prefixes untrusted vendor strings starting with `=`, `+`, `-`, `@`, `\t`, or `\r` with a leading apostrophe (`'`) before writing Excel cells.
4. **HTTP Response Headers (`server.ts`):**
   - Disables `X-Powered-By` and sets `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`, and `Cross-Origin-Resource-Policy: same-origin`.
5. **Server-Side Validation & RBAC Guards (`server.ts`):**
   - Mutating routes reject `viewer` role with `403`.
   - Award approval/rejection (`POST /api/awards/:awardId/decide`) enforces `approver` or `admin` role (`403` otherwise).
   - Award totals and non-L1 justification checks are recomputed server-side from verified line items rather than trusting client-submitted totals.

## Critical Known Limitations (Not Production-Ready for Auth / Multi-Tenancy)

1. **Sandbox Demo Role Switcher — Not Real Authentication:**
   - The workspace includes `POST /api/demo/switch-persona` and `settings.activeUserRole` to demonstrate buyer vs. approver vs. viewer RBAC workflows inside a single sandbox workspace.
   - There are **no user passwords, OAuth/SSO login, signed JWT/session cookies, or per-request user identity verification**. Anyone with network access to `/api/*` can call `/api/demo/switch-persona` to assume `approver` or `admin`.
2. **Single-Tenant Shared State:**
   - All API calls read/write the shared `WorkspaceState` in `data/quoteflow-db.json` with no organization/tenant isolation.
3. **No Per-Endpoint Rate Limiting:**
   - Upload/extraction endpoints rely on upstream Gemini quotas and local timeouts; no Express IP/user rate limiter is currently installed.

**Deployment Guidance:** Do not expose NORUS QUOTEFLOW on the public internet or use it across multiple customer organizations until real authentication, session management, tenant isolation, and encrypted storage are implemented (see [Next Task](NEXT_TASK.md)).
