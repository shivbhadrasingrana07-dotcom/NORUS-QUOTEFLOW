-- NORUS QUOTEFLOW Task 007 / 007.2 — Rollback for 0001_tenant_integrity.sql

BEGIN;

DROP INDEX IF EXISTS suppliers_org_norm_tax_id_uidx;
DROP INDEX IF EXISTS suppliers_org_norm_name_uidx;

ALTER TABLE price_history DROP CONSTRAINT IF EXISTS price_history_org_catalog_fk;

ALTER TABLE award_allocations DROP CONSTRAINT IF EXISTS award_allocations_org_supplier_fk;
ALTER TABLE award_allocations DROP CONSTRAINT IF EXISTS award_allocations_org_qline_fk;
ALTER TABLE award_allocations DROP CONSTRAINT IF EXISTS award_allocations_org_quote_fk;
ALTER TABLE award_allocations DROP CONSTRAINT IF EXISTS award_allocations_org_rfq_item_fk;
ALTER TABLE award_allocations DROP CONSTRAINT IF EXISTS award_allocations_org_award_fk;

ALTER TABLE awards DROP CONSTRAINT IF EXISTS awards_org_rfq_fk;

ALTER TABLE quotation_lines DROP CONSTRAINT IF EXISTS quotation_lines_org_rfq_item_fk;
ALTER TABLE quotation_lines DROP CONSTRAINT IF EXISTS quotation_lines_org_quote_fk;

ALTER TABLE quotations DROP CONSTRAINT IF EXISTS quotations_org_document_fk;
ALTER TABLE quotations DROP CONSTRAINT IF EXISTS quotations_org_supplier_fk;
ALTER TABLE quotations DROP CONSTRAINT IF EXISTS quotations_org_rfq_fk;

ALTER TABLE rfq_items DROP CONSTRAINT IF EXISTS rfq_items_org_catalog_fk;
ALTER TABLE rfq_items DROP CONSTRAINT IF EXISTS rfq_items_org_rfq_fk;

ALTER TABLE catalog_items DROP CONSTRAINT IF EXISTS catalog_items_org_last_supplier_fk;

ALTER TABLE awards DROP CONSTRAINT IF EXISTS awards_org_id_uniq;
ALTER TABLE quotation_lines DROP CONSTRAINT IF EXISTS quotation_lines_org_id_uniq;
ALTER TABLE quotations DROP CONSTRAINT IF EXISTS quotations_org_id_uniq;
ALTER TABLE stored_documents DROP CONSTRAINT IF EXISTS stored_documents_org_id_uniq;
ALTER TABLE rfq_items DROP CONSTRAINT IF EXISTS rfq_items_org_id_uniq;
ALTER TABLE rfqs DROP CONSTRAINT IF EXISTS rfqs_org_id_uniq;
ALTER TABLE catalog_items DROP CONSTRAINT IF EXISTS catalog_items_org_id_uniq;
ALTER TABLE suppliers DROP CONSTRAINT IF EXISTS suppliers_org_id_uniq;

COMMIT;
