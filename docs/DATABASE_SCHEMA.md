# Database Schema (Cloud SQL PostgreSQL + Drizzle ORM)

NORUS QUOTEFLOW persists all identity, multi-tenant access control, procurement records, private document metadata, audit trails, and rate-limit buckets in PostgreSQL (`src/db/schema.ts`, initial migration `drizzle/0000_illegal_major_mapleleaf.sql`, and tenant-integrity hardening migration `drizzle/0001_tenant_integrity.sql` with preflight `drizzle/0001_tenant_integrity_preflight.sql` and rollback `drizzle/0001_tenant_integrity_rollback.sql`).

> **Deployment Note:** `drizzle/0001_tenant_integrity.sql` and `drizzle/0001_tenant_integrity_rollback.sql` wrap all DDL statements in `BEGIN; ... COMMIT;` and target **PostgreSQL 15+** (using column-list `ON DELETE SET NULL (<col>)`). They are executed explicitly via `psql` / CI outside Drizzle `_journal.json`. Apply to Cloud SQL only during a scheduled maintenance window after running `0001_tenant_integrity_preflight.sql` and taking an instance backup.

## Relational Tables (17 Tables)

### Authentication, Organizations & Access Control
| Table | Key Columns | Purpose |
| :--- | :--- | :--- |
| `users` | `id` (PK), `firebase_uid` (UQ), `email` (UQ), `password_hash`, `full_name`, `title`, `email_verified`, token hashes & expiry, `last_active_org_id` | Authenticated user accounts (email/password and/or linked Google UID) |
| `organizations` | `id` (PK), `slug` (UQ), `name`, `country_code`, `default_currency`, `tax_regime`, `default_tax_creditable`, `uom_aliases` (jsonb), `created_by_user_id` | Tenant workspaces and commercial/tax defaults |
| `organization_memberships` | `id` (PK), `organization_id` (FK), `user_id` (FK), `role` (`owner`/`admin`/`buyer`/`approver`/`viewer`), `status` | Unique `(organization_id, user_id)` role assignments |
| `invitations` | `id` (PK), `organization_id` (FK), `email`, `role`, `token_hash` (UQ), `invited_by_user_id`, `status`, `expires_at`, `accepted_at` | Email-bound pending/accepted/revoked organization invitations |
| `sessions` | `id` (PK), `user_id` (FK), `active_organization_id` (FK), `token_hash` (UQ), `csrf_token`, `auth_method`, `ip_address`, `user_agent`, `expires_at`, `revoked_at` | Server-revocable sessions backing `nf_session` cookies |

### Tenant-Scoped Procurement Tables
Every table below enforces a non-null `organization_id` FK (`ON DELETE CASCADE`) and organization-prefixed indexes:

| Table | Key Columns | Purpose |
| :--- | :--- | :--- |
| `suppliers` | `id`, `organization_id`, `name`, `tax_id`, `city`, `contact_name`, `email`, `phone_whatsapp`, `default_payment_terms`, `categories` (jsonb) | Organization supplier directory |
| `catalog_items` | `id`, `organization_id`, `sku_code`, `name`, `normalized_name`, `default_uom`, `hsn_sac_code`, `last_awarded_unit_price`, `last_awarded_currency`, `last_awarded_at`, `last_supplier_id` | Item Price Memory master records |
| `price_history` | `id`, `organization_id`, `catalog_item_id` (FK), `rfq_id`, `rfq_number`, `supplier_id`, `supplier_name`, `unit_landed_price`, `currency`, `awarded_at` | Historical awarded landed unit prices per item |
| `rfqs` | `id`, `organization_id`, `rfq_number` (UQ per org), `title`, `status`, `currency`, `incoterms`, `delivery_location`, `deadline_date`, `created_by`, `created_by_user_id`, `invited_supplier_ids` | Request for Quotations (`RFQ-YYYY-XXXX` unique per organization) |
| `rfq_items` | `id`, `organization_id`, `rfq_id` (FK), `item_id` (FK), `line_no`, `sku_code`, `description`, `quantity`, `uom`, `target_unit_price` | BOM line items within an RFQ |
| `stored_documents` | `id`, `organization_id`, `uploaded_by_user_id`, `storage_provider` (`s3`/`local`), `storage_key` (UQ), `original_filename`, `mime_type`, `byte_size`, `sha256` | Metadata for uploaded documents stored in private object storage |
| `quotations` | `id`, `organization_id`, `rfq_id` (FK), `supplier_id` (FK restrict), `document_id` (FK set null), commercial headers, normalized totals, `completeness_ratio`, `is_verified`, `header_traces` | Extracted and normalized supplier quotations |
| `quotation_lines` | `id`, `organization_id`, `quotation_id` (FK cascade), `rfq_item_id` (FK set null), normalized rates, `line_total_quoted`, `expected_line_total`, `math_valid`, `match_status`, `source_trace` | Line-level extracted rates, math checks, and document trace coordinates |
| `awards` | `id`, `organization_id`, `rfq_id` (FK), `is_split_award`, `recommended_by`, `approved_by`, `approval_status`, `non_l1_justification`, `approver_notes`, `total_awarded_landed`, `decided_at` | Single and split-award recommendations and decisions |
| `award_allocations` | `id`, `organization_id`, `award_id` (FK cascade), `rfq_item_id` (FK cascade), `quotation_id` (FK restrict), `quotation_line_id` (FK restrict), `supplier_id` (FK restrict), `awarded_qty`, `awarded_unit_landed` | Per-item award split allocations |
| `audit_logs` | `id`, `organization_id`, `actor_user_id`, `actor_name`, `actor_role`, `entity_type`, `entity_id`, `action`, `detail`, `created_at` | Immutable organization-scoped procurement & access audit log |
| `rate_limit_buckets` | `bucket_key` (PK), `hits`, `reset_at` | Atomic PostgreSQL-backed sliding/fixed window rate-limit counters |

## Referential Integrity, Tenant Boundaries & Exceptions

1. **Composite Same-Organization Constraints (`drizzle/0001_tenant_integrity.sql`):**
   - Adds `(organization_id, id)` unique keys on parent tables and composite same-organization foreign keys across procurement child tables (`catalog_items`, `price_history`, `rfq_items`, `quotations`, `quotation_lines`, `awards`, `award_allocations`) so a child row cannot reference a parent record from a different organization even by raw ID. Uses PostgreSQL 15+ column-list `ON DELETE SET NULL (<column>)` where optional parent links nullable-cascade without clearing `organization_id`.
   - Functional partial unique indexes enforce case-insensitive per-organization supplier uniqueness on `lower(trim(name))` and non-empty `lower(trim(tax_id))`.
2. **Documented `price_history` Exception:**
   - `price_history.rfq_id` and `price_history.supplier_id` are intentionally stored as historical snapshot references without foreign keys to `rfqs` or `suppliers`, preserving historical awarded landed-price memory (`price_history.catalog_item_id` remains scoped via `(organization_id, catalog_item_id)`).
3. **Audit Logs (`audit_logs`):**
   - Immutability (append-only behavior) is **application-enforced**: `PgDataStore`, `ownerBootstrap.ts`, and `legacyMigration.ts` perform `INSERT`-only writes with no update/delete endpoints or queries (no PostgreSQL trigger/rule is installed at the DB layer).
4. **Historical Award Snapshot Preservation, Hierarchical Locking & Concurrent RFQ Numbering:**
   - `award_allocations.quotation_id` and `award_allocations.quotation_line_id` use `ON DELETE RESTRICT` by design, and server handlers reject quotation deletion (`409 Conflict`) whenever a quotation is referenced by an `approved`, `pending`, or `rejected` award so historical award snapshots remain intact.
   - `award_allocations` supports multi-supplier item splits sharing a single `rfq_item_id` when `awards.is_split_award = true`, storing explicit caller `awarded_qty` shares summing to `rfq_items.quantity` within `1e-6` scaled tolerance.
   - Header/line mutations and verification are blocked (`409 Conflict`) when a quotation is referenced by a `pending` or `approved` award.
   - **Deadlock-Free Hierarchical Locking (`server/pgStore.ts`):** `updateQuotationHeader`, `updateQuotationLine`, `verifyQuotation`, `deleteQuotation`, `submitAward`, `withdrawAward`, and `decideAward` acquire `FOR UPDATE` row locks strictly in parent-to-child order: parent `rfqs` row (`FOR UPDATE`) -> referenced `quotations` rows (ordered deterministically `ORDER BY id ASC`, `FOR UPDATE`) -> `awards` rows (`FOR UPDATE`), eliminating TOCTOU races and circular lock deadlocks. `submitAward` preserves historical `rejected` award rows instead of deleting them and rejects duplicate `pending`/`approved` awards (`409`).
   - `createRfq` acquires a `FOR UPDATE` row lock on the parent `organizations` row and scans existing yearly `RFQ-YYYY-XXXX` numbers without any `< 9000` upper cutoff.
5. **Cross-Tenant & Supplier Protection:** Every query filters by `organization_id = req.auth.activeOrganization.id`; duplicate supplier name/Tax ID returns `409 Conflict`.

## Legacy JSON Migration (`server/legacyMigration.ts`)

Legacy JSON data (`data/quoteflow-db.json`) is migrated via `npm run db:migrate -- --dry-run` or `npm run db:migrate -- --apply --confirm`:
- Requires explicit `--confirm` CLI flag / `confirmed: true` when `dryRun: false` to prevent accidental writes.
- Creates a timestamped pre-migration backup in `data/backups/` while leaving `data/quoteflow-db.json` untouched.
- Extracts inline Base64 `fileDataUrl` attachments into private object storage (`stored_documents` + `document_id`), and automatically rolls back newly uploaded storage keys (`rolledBackStorageKeys`) if the PostgreSQL transaction aborts.
- Runs pre-insert cross-organization ID collision detection (`MigrationConflictError`) and per-ID + attribute post-write reconciliation (`reconciliation`, `integrityVerified`).
