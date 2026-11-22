# API Documentation

All endpoints are served under `/api/*` by `server.ts`.

## Health & Workspace

### `GET /api/health`
Returns server and database readiness without leaking secrets.
- **200 OK:** `{ "status": "ok", "rfqs": number, "quotations": number, "geminiConfigured": boolean }`
- **500 Error:** `{ "status": "error", "error": string }`

### `GET /api/workspace`
Returns the full `WorkspaceState` JSON (`settings`, `suppliers`, `items`, `rfqs`, `quotations`, `awards`, `auditLogs`).

---

## Sandbox Persona & Settings

### `POST /api/demo/switch-persona`
Switches the active demonstration persona in `settings` and records a `DEMO_PERSONA_SWITCHED` audit entry.
- **Body:** `{ "activeUserRole": "admin" | "buyer" | "approver" | "viewer", "activeUserName"?: string, "activeUserTitle"?: string }`
- **Responses:** `200 OK` (updated `OrganizationSettings`), `400 Bad Request` (invalid role).

### `PATCH /api/settings`
Updates organization defaults (`name`, `defaultCurrency`, `taxRegime`, `defaultTaxCreditable`, `activeUserRole`).
- **RBAC:** Blocked (`403`) for `viewer`.
- **Responses:** `200 OK`, `400 Bad Request`, `403 Forbidden`.

---

## RFQs, Suppliers & Catalog

### `POST /api/rfqs`
Creates a new RFQ with sequential `RFQ-YYYY-XXXX` numbering and auto-links matching catalog items.
- **RBAC:** Blocked (`403`) for `viewer`.
- **Body:** `{ title, currency?, incoterms?, deliveryLocation?, deadlineDate?, items: [{ skuCode?, description, quantity, uom?, targetUnitPrice? }], invitedSupplierIds? }`
- **Responses:** `201 Created` (`Rfq`), `400 Bad Request`, `403 Forbidden`.

### `POST /api/rfqs/load-sample`
Appends a fresh multi-format sample manufacturing RFQ and 3 supplier quotations into the workspace.
- **RBAC:** Blocked (`403`) for `viewer`.
- **Responses:** `201 Created`, `403 Forbidden`.

### `POST /api/suppliers`
Creates a supplier profile with case-insensitive duplicate name/Tax ID protection.
- **RBAC:** Blocked (`403`) for `viewer`.
- **Responses:** `201 Created` (`Supplier`), `400 Bad Request`, `403 Forbidden`, `409 Conflict`.

### `POST /api/items`
Adds a catalog item to Item Price Memory.
- **RBAC:** Blocked (`403`) for `viewer`.
- **Responses:** `201 Created` (`CatalogItem`), `400 Bad Request`, `403 Forbidden`.

---

## Quotation Ingestion, Editing & Verification

### `POST /api/rfqs/:rfqId/quotes/extract`
Accepts `multipart/form-data` (`supplierId`, optional `file`, optional `rawEmailText`), validates file magic bytes (`PDF`, `XLSX`, `XLS`, `CSV`, `PNG`, `JPG`, `WEBP`; max 25 MB), extracts structured fields via `geminiExtractor.ts`, computes normalized landed costs, and stores the quotation.
- **RBAC:** Blocked (`403`) for `viewer`.
- **Responses:**
  - `201 Created` (`Quotation`)
  - `400 Bad Request` (missing supplier/input)
  - `403 Forbidden`
  - `404 Not Found` (RFQ missing)
  - `413 Payload Too Large` (> 25 MB)
  - `415 Unsupported Media Type` (blocked extension or spoofed magic bytes)
  - `422 Unprocessable Entity` (empty/corrupt spreadsheet)
  - `429 Too Many Requests` (Gemini rate limit exhausted)
  - `502 Bad Gateway` (invalid AI JSON or auth error)
  - `503 Service Unavailable` (`GEMINI_API_KEY` not configured)
  - `504 Gateway Timeout` (extraction exceeded 45s timeout)

### `PATCH /api/quotations/:quoteId`
Updates header commercial terms (`freightCharges`, `packingForwarding`, `otherCharges`, `globalDiscount`, `taxIncludedInRates`, `missingFreightWarning`, `exchangeRateToRfq`, `leadTimeDays`, `paymentTerms`, `quoteReference`, `validUntil`), clears `isVerified`, and recomputes all line landed costs.
- **RBAC:** Blocked (`403`) for `viewer`.
- **Responses:** `200 OK` (`Quotation`), `400 Bad Request`, `403 Forbidden`, `404 Not Found`.

### `PATCH /api/quotations/:quoteId/lines/:lineId`
Updates a single extracted line (`rfqItemId`, `matchStatus`, `quotedQty`, `quotedUnitRate`, `uomConversionFactor`, `taxRatePct`, `taxCreditable`, `discountAmount`, `lineTotalQuoted`), marks `humanEdited: true`, clears `isVerified`, and recomputes totals.
- **RBAC:** Blocked (`403`) for `viewer`.
- **Responses:** `200 OK` (`Quotation`), `400 Bad Request`, `403 Forbidden`, `404 Not Found`.

### `POST /api/quotations/:quoteId/verify`
Marks a quotation verified (`isVerified: true`, `parseStatus: 'verified'`).
- **RBAC:** Blocked (`403`) for `viewer`.
- **Responses:** `200 OK` (`Quotation`), `403 Forbidden`, `404 Not Found`, `422 Unprocessable Entity` (if any line has `mathValid === false`).

### `DELETE /api/quotations/:quoteId`
Deletes a quotation and cleans up any `pending` award referencing it.
- **RBAC:** Blocked (`403`) for `viewer`.
- **Responses:** `200 OK` (`{ ok: true }`), `403 Forbidden`, `404 Not Found`, `409 Conflict` (referenced by an `approved` award).

---

## Award Recommendation & Approval

### `POST /api/rfqs/:rfqId/award`
Submits a single-package or split-award recommendation. Server validates every referenced line (`mathValid === true`), recomputes `totalAwardedLanded` from authoritative server records, checks against the verified `L1` benchmark, and requires `nonL1Justification` if total exceeds `L1 + 1`.
- **RBAC:** Blocked (`403`) for `viewer`.
- **Responses:** `201 Created` (`AwardDecision`), `400 Bad Request`, `403 Forbidden`, `404 Not Found`, `422 Unprocessable Entity`.

### `POST /api/awards/:awardId/decide`
Approves or rejects a `pending` award (`decision: "approved" | "rejected"`). Approval sets RFQ status to `'awarded'` and updates `CatalogItem.priceHistory` and `lastAwardedUnitPrice`. Rejection returns RFQ status to `'in_review'`.
- **RBAC:** Allowed **only** for `approver` or `admin` (`403` for `buyer` or `viewer`).
- **Responses:** `200 OK` (`{ award, rfq }`), `400 Bad Request`, `403 Forbidden`, `404 Not Found`, `409 Conflict` (already finalized).
