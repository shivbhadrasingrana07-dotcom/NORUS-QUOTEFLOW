-- NORUS QUOTEFLOW Task 007 — Tenant Data Integrity Preflight Checks (READ-ONLY)
-- Run all queries before applying 0001_tenant_integrity.sql to confirm zero blocking rows.

-- 1. Duplicate suppliers by normalized name within the same organization (expect 0 rows)
SELECT organization_id, lower(btrim(name)) AS normalized_name, COUNT(*) AS cnt
FROM suppliers
GROUP BY organization_id, lower(btrim(name))
HAVING COUNT(*) > 1;

-- 2. Duplicate suppliers by non-empty normalized Tax ID / GSTIN within the same organization (expect 0 rows)
SELECT organization_id, lower(btrim(tax_id)) AS normalized_tax_id, COUNT(*) AS cnt
FROM suppliers
WHERE btrim(tax_id) <> ''
GROUP BY organization_id, lower(btrim(tax_id))
HAVING COUNT(*) > 1;

-- 3. Cross-organization parent/child mismatches across transactional tables (expect 0 for all)
SELECT
  (SELECT COUNT(*) FROM catalog_items c
   JOIN suppliers s ON s.id = c.last_supplier_id
   WHERE c.last_supplier_id IS NOT NULL AND c.organization_id <> s.organization_id) AS bad_catalog_supplier,

  (SELECT COUNT(*) FROM rfq_items ri
   JOIN rfqs r ON r.id = ri.rfq_id
   WHERE ri.organization_id <> r.organization_id) AS bad_rfq_item_rfq,

  (SELECT COUNT(*) FROM rfq_items ri
   JOIN catalog_items c ON c.id = ri.item_id
   WHERE ri.item_id IS NOT NULL AND ri.organization_id <> c.organization_id) AS bad_rfq_item_catalog,

  (SELECT COUNT(*) FROM quotations q
   JOIN rfqs r ON r.id = q.rfq_id
   WHERE q.organization_id <> r.organization_id) AS bad_quote_rfq,

  (SELECT COUNT(*) FROM quotations q
   JOIN suppliers s ON s.id = q.supplier_id
   WHERE q.organization_id <> s.organization_id) AS bad_quote_supplier,

  (SELECT COUNT(*) FROM quotations q
   JOIN stored_documents d ON d.id = q.document_id
   WHERE q.document_id IS NOT NULL AND q.organization_id <> d.organization_id) AS bad_quote_doc,

  (SELECT COUNT(*) FROM quotation_lines ql
   JOIN quotations q ON q.id = ql.quotation_id
   WHERE ql.organization_id <> q.organization_id) AS bad_qline_quote,

  (SELECT COUNT(*) FROM quotation_lines ql
   JOIN rfq_items ri ON ri.id = ql.rfq_item_id
   WHERE ql.rfq_item_id IS NOT NULL AND ql.organization_id <> ri.organization_id) AS bad_qline_rfq_item,

  (SELECT COUNT(*) FROM awards a
   JOIN rfqs r ON r.id = a.rfq_id
   WHERE a.organization_id <> r.organization_id) AS bad_award_rfq,

  (SELECT COUNT(*) FROM award_allocations al
   JOIN awards a ON a.id = al.award_id
   WHERE al.organization_id <> a.organization_id) AS bad_alloc_award,

  (SELECT COUNT(*) FROM award_allocations al
   JOIN rfq_items ri ON ri.id = al.rfq_item_id
   WHERE al.organization_id <> ri.organization_id) AS bad_alloc_rfq_item,

  (SELECT COUNT(*) FROM award_allocations al
   JOIN quotations q ON q.id = al.quotation_id
   WHERE al.organization_id <> q.organization_id) AS bad_alloc_quote,

  (SELECT COUNT(*) FROM award_allocations al
   JOIN quotation_lines ql ON ql.id = al.quotation_line_id
   WHERE al.organization_id <> ql.organization_id) AS bad_alloc_qline,

  (SELECT COUNT(*) FROM award_allocations al
   JOIN suppliers s ON s.id = al.supplier_id
   WHERE al.organization_id <> s.organization_id) AS bad_alloc_supplier,

  (SELECT COUNT(*) FROM price_history ph
   JOIN catalog_items c ON c.id = ph.catalog_item_id
   WHERE ph.organization_id <> c.organization_id) AS bad_price_history_catalog;

-- 4. Informational check: historical price_history references outside active rfqs/suppliers
-- (Expected non-zero for legacy seed/customer history; composite FKs to rfqs/suppliers are omitted by design)
SELECT COUNT(*) AS historical_unlinked_price_history_rows
FROM price_history ph
WHERE NOT EXISTS (
  SELECT 1 FROM rfqs r WHERE r.id = ph.rfq_id AND r.organization_id = ph.organization_id
)
OR NOT EXISTS (
  SELECT 1 FROM suppliers s WHERE s.id = ph.supplier_id AND s.organization_id = ph.organization_id
);
