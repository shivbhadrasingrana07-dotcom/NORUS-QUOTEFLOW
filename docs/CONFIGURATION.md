# Configuration Reference

## Environment Variables

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `GEMINI_API_KEY` | For live AI extraction | *(unset)* | Server-side API key for `@google/genai` (model `gemini-4-hydrogen`). Must never be prefixed with `VITE_` or exposed to the client bundle. |
| `PORT` | No | `3000` | HTTP port listened on by Express (`server.ts`). |
| `NODE_ENV` | No | `development` | When `production`, `server.ts` serves static files from `dist/` instead of mounting Vite dev middlewares. |
| `APP_URL` | No | *(runtime-injected)* | Hosting URL injected by AI Studio runtime. |
| `QUOTEFLOW_DB_PATH` | No | `data/quoteflow-db.json` | Overrides the workspace JSON database file location. Used by automated tests for isolated `os.tmpdir()` runs. |

## Key NPM Scripts (`package.json`)

| Script | Command | Purpose |
| :--- | :--- | :--- |
| `npm run dev` | `tsx server.ts` | Starts Express + Vite dev server on port `3000`. |
| `npm run start` | `NODE_ENV=production tsx server.ts` | Starts Express serving built `dist/` assets. |
| `npm run build` | `vite build` | Compiles production frontend bundle into `dist/`. |
| `npm run lint` | `tsc --noEmit` | Runs strict TypeScript typechecking across client, server, and tests. |
| `npm test` | `tsx --test tests/*.test.ts` | Runs the automated Node test suite. |

## Extraction & Upload Constants

- **Gemini Model:** `GEMINI_EXTRACTION_MODEL = 'gemini-4-hydrogen'` (`server/geminiExtractor.ts`)
- **Extraction Timeout:** `45000` ms (`45s`), configurable per call in `extractQuotationWithGemini`
- **Upload Size Cap:** `25 * 1024 * 1024` bytes (`25 MB`) in `server.ts`
- **Spreadsheet Parse Limits:** Up to `4` sheets, `120` rows/sheet, `30` columns/row (`server/geminiExtractor.ts`)
