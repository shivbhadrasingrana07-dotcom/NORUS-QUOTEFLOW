-- NORUS QUOTEFLOW Task 007 / 007.2 — Additive Tenant Data Integrity Migration
-- Requires PostgreSQL 15+ (uses column-list ON DELETE SET NULL (<col>) on composite nullable FKs).
-- Applied explicitly via psql / CI workflow (outside drizzle-kit's automatic _journal.json).
-- Run 0001_tenant_integrity_preflight.sql first.
--
-- Documented Exceptions & Snapshot Rules:
--   1. `price_history` composite FKs referencing `(rfqs)` and `(suppliers)` are intentionally OMITTED
--      because historical customer price_history entries retain archived rfq_id/supplier_id references
--      that may not exist in current `rfqs` / `suppliers` rows. Only `(organization_id, catalog_item_id)` is FK-enforced.
--   2. `award_allocations` enforces `ON DELETE RESTRICT` on `(organization_id, quotation_id)`,
--      `(organization_id, quotation_line_id)`, and `(organization_id, supplier_id)` so historical
--      approved/rejected award snapshots remain intact; pending awards must be explicitly withdrawn first.

BEGIN;

-- 1. Parent composite unique constraints on (organization_id, id)
ALTER TABLE suppliers
  ADD CONSTRAINT suppliers_org_id_uniq UNIQUE (organization_id, id);
ALTER TABLE catalog_items
  ADD CONSTRAINT catalog_items_org_id_uniq UNIQUE (organization_id, id);
ALTER TABLE rfqs
  ADD CONSTRAINT rfqs_org_id_uniq UNIQUE (organization_id, id);
ALTER TABLE rfq_items
  ADD CONSTRAINT rfq_items_org_id_uniq UNIQUE (organization_id, id);
ALTER TABLE stored_documents
  ADD CONSTRAINT stored_documents_org_id_uniq UNIQUE (organization_id, id);
ALTER TABLE quotations
  ADD CONSTRAINT quotations_org_id_uniq UNIQUE (organization_id, id);
ALTER TABLE quotation_lines
  ADD CONSTRAINT quotation_lines_org_id_uniq UNIQUE (organization_id, id);
ALTER TABLE awards
  ADD CONSTRAINT awards_org_id_uniq UNIQUE (organization_id, id);

-- 2. Same-organization composite foreign keys across transactional child tables
ALTER TABLE catalog_items
  ADD CONSTRAINT catalog_items_org_last_supplier_fk
  FOREIGN KEY (organization_id, last_supplier_id)
  REFERENCES suppliers (organization_id, id)
  ON DELETE SET NULL (last_supplier_id);

ALTER TABLE rfq_items
  ADD CONSTRAINT rfq_items_org_rfq_fk
  FOREIGN KEY (organization_id, rfq_id)
  REFERENCES rfqs (organization_id, id)
  ON DELETE CASCADE;

ALTER TABLE rfq_items
  ADD CONSTRAINT rfq_items_org_catalog_fk
  FOREIGN KEY (organization_id, item_id)
  REFERENCES catalog_items (organization_id, id)
  ON DELETE SET NULL (item_id);

ALTER TABLE quotations
  ADD CONSTRAINT quotations_org_rfq_fk
  FOREIGN KEY (organization_id, rfq_id)
  REFERENCES rfqs (organization_id, id)
  ON DELETE CASCADE;

ALTER TABLE quotations
  ADD CONSTRAINT quotations_org_supplier_fk
  FOREIGN KEY (organization_id, supplier_id)
  REFERENCES suppliers (organization_id, id)
  ON DELETE RESTRICT;

ALTER TABLE quotations
  ADD CONSTRAINT quotations_org_document_fk
  FOREIGN KEY (organization_id, document_id)
  REFERENCES stored_documents (organization_id, id)
  ON DELETE SET NULL (document_id);

ALTER TABLE quotation_lines
  ADD CONSTRAINT quotation_lines_org_quote_fk
  FOREIGN KEY (organization_id, quotation_id)
  REFERENCES quotations (organization_id, id)
  ON DELETE CASCADE;

ALTER TABLE quotation_lines
  ADD CONSTRAINT quotation_lines_org_rfq_item_fk
  FOREIGN KEY (organization_id, rfq_item_id)
  REFERENCES rfq_items (organization_id, id)
  ON DELETE SET NULL (rfq_item_id);

ALTER TABLE awards
  ADD CONSTRAINT awards_org_rfq_fk
  FOREIGN KEY (organization_id, rfq_id)
  REFERENCES rfqs (organization_id, id)
  ON DELETE CASCADE;

ALTER TABLE award_allocations
  ADD CONSTRAINT award_allocations_org_award_fk
  FOREIGN KEY (organization_id, award_id)
  REFERENCES awards (organization_id, id)
  ON DELETE CASCADE;

ALTER TABLE award_allocations
  ADD CONSTRAINT award_allocations_org_rfq_item_fk
  FOREIGN KEY (organization_id, rfq_item_id)
  REFERENCES rfq_items (organization_id, id)
  ON DELETE CASCADE;

ALTER TABLE award_allocations
  ADD CONSTRAINT award_allocations_org_quote_fk
  FOREIGN KEY (organization_id, quotation_id)
  REFERENCES quotations (organization_id, id)
  ON DELETE RESTRICT;

ALTER TABLE award_allocations
  ADD CONSTRAINT award_allocations_org_qline_fk
  FOREIGN KEY (organization_id, quotation_line_id)
  REFERENCES quotation_lines (organization_id, id)
  ON DELETE RESTRICT;

ALTER TABLE award_allocations
  ADD CONSTRAINT award_allocations_org_supplier_fk
  FOREIGN KEY (organization_id, supplier_id)
  REFERENCES suppliers (organization_id, id)
  ON DELETE RESTRICT;

ALTER TABLE price_history
  ADD CONSTRAINT price_history_org_catalog_fk
  FOREIGN KEY (organization_id, catalog_item_id)
  REFERENCES catalog_items (organization_id, id)
  ON DELETE CASCADE;

-- 3. Case-insensitive, trimmed unique supplier identity constraints per organization
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_org_norm_name_uidx
  ON suppliers (organization_id, lower(btrim(name)));

CREATE UNIQUE INDEX IF NOT EXISTS suppliers_org_norm_tax_id_uidx
  ON suppliers (organization_id, lower(btrim(tax_id)))
  WHERE btrim(tax_id) <> '';

COMMIT;
