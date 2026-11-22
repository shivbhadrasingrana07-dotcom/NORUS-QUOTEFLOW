# Database Schema

## Current Active Persistence (`server/db.ts`)

In its current release, NORUS QUOTEFLOW persists state as an atomic JSON document (`data/quoteflow-db.json`, or the path specified in `QUOTEFLOW_DB_PATH`). All mutations run inside an async mutex (`mutateWorkspace`) that writes to a unique temporary file (`<db>.<pid>.<ts>.<rand>.tmp`) before atomically renaming over the target file. Corrupt JSON files trigger an automatic backup (`*.corrupt.<ts>.bak`) and surface an explicit error rather than silently wiping data.

### Root `WorkspaceState` Structure (`src/types.ts`)

| Collection / Key | Type | Description |
| :--- | :--- | :--- |
| `settings` | `OrganizationSettings` | Workspace name, default currency (`INR`/`USD`/`GBP`/`EUR`), tax regime (`INDIA_GST`/`UK_VAT`/`US_TAX`/`NONE`), ITC reclaim default, UOM aliases, and sandbox demo persona (`activeUserName`, `activeUserRole`) |
| `suppliers` | `Supplier[]` | Vendor profiles (`id`, `name`, `taxId`, `city`, `contactName`, `email`, `phoneWhatsapp`, `defaultPaymentTerms`, `categories`, `createdAt`) |
| `items` | `CatalogItem[]` | Item price memory (`id`, `skuCode`, `name`, `normalizedName`, `defaultUom`, `hsnSacCode`, `lastAwardedUnitPrice`, `lastAwardedCurrency`, `lastAwardedAt`, `lastSupplierId`, `priceHistory[]`) |
| `rfqs` | `Rfq[]` | Request for Quotations (`id`, `rfqNumber`, `title`, `status`, `currency`, `incoterms`, `deliveryLocation`, `deadlineDate`, `invitedSupplierIds[]`, `items: RfqItem[]`) |
| `quotations` | `Quotation[]` | Uploaded/extracted vendor quotes (`id`, `rfqId`, `supplierId`, `documentName`, `documentKind`, `fileDataUrl?`, `rawEmailText?`, `sheetPreview?`, commercial headers, normalized totals, `completenessRatio`, `isVerified`, `headerTraces`, `lines: QuotationLine[]`) |
| `awards` | `AwardDecision[]` | Recommended and decided single/split awards (`id`, `rfqId`, `isSplitAward`, `recommendedBy`, `approvedBy`, `approvalStatus`, `nonL1Justification`, `approverNotes`, `totalAwardedLanded`, `allocations: AwardAllocation[]`) |
| `auditLogs` | `AuditLogEntry[]` | Rolling audit log capped at the most recent 300 entries (`actorName`, `actorRole`, `entityType`, `entityId`, `action`, `detail`, `createdAt`) |

### Referential Integrity Rules Enforced in `server.ts`

1. Deleting a quotation (`DELETE /api/quotations/:quoteId`) is blocked (`409`) if referenced by an `approved` award decision.
2. Deleting a quotation referenced by a `pending` award removes that stale pending award and transitions the parent RFQ back to `in_review`.
3. Submitting an award (`POST /api/rfqs/:rfqId/award`) validates that every allocation references an existing `rfqItemId`, `quotationId`, and `quotationLineId` belonging to that RFQ with `mathValid === true`.
4. Creating a supplier rejects duplicate `name` or `taxId` values (`409`).

## Future Relational Target

When migrating to multi-tenant production PostgreSQL (planned in [Next Task](NEXT_TASK.md)), each top-level array maps cleanly to tenant-scoped tables (`organizations`, `users`, `suppliers`, `catalog_items`, `item_price_history`, `rfqs`, `rfq_items`, `quotations`, `quotation_lines`, `awards`, `award_allocations`, `audit_logs`) with foreign-key constraints and binary object storage (S3/GCS) replacing inline `fileDataUrl` strings.
