# Database Schema (Cloud SQL PostgreSQL + Drizzle ORM)

NORUS QUOTEFLOW persists all identity, multi-tenant access control, procurement records, private document metadata, audit trails, and rate-limit buckets in PostgreSQL (`src/db/schema.ts`, initial migration `drizzle/0000_illegal_major_mapleleaf.sql`).

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

## Referential Integrity & Business Rules

1. **Approved Quote Deletion Guard:** Deleting a quotation referenced by an `approved` award is blocked with `409 Conflict` (`award_allocations.quotation_id` uses `ON DELETE RESTRICT` + explicit server check). Deleting an unapproved quote deletes stale `pending` awards, deletes the `stored_documents` row, and removes the object from private object storage.
2. **Duplicate Supplier Protection:** Case-insensitive duplicate `name` or `tax_id` within the same organization returns `409 Conflict`.
3. **Cross-Tenant Enforcement:** Every query filters by `organization_id = req.auth.activeOrganization.id`.

## Legacy JSON Migration (`server/legacyMigration.ts`)

Legacy JSON data (`data/quoteflow-db.json`) is migrated via `npm run db:migrate -- --dry-run` / `--apply`:
- Creates a timestamped pre-migration backup in `data/backups/` while leaving `data/quoteflow-db.json` untouched.
- Extracts any inline Base64 `fileDataUrl` attachments into private object storage (`stored_documents` + `document_id`).
- Runs inside a single idempotent PostgreSQL transaction (`onConflictDoNothing`) and verifies post-migration row counts match `sourceCounts`.
