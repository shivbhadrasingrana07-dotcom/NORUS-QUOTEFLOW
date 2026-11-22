import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import {
  AuditLogEntry,
  AwardDecision,
  CostBasis,
  OrganizationSettings,
  Quotation,
  Rfq,
  Supplier,
} from '../types.ts';
import { formatDateShort, formatMoney } from './format.ts';

function getSupplierName(suppliers: Supplier[], id: string): string {
  return suppliers.find((s) => s.id === id)?.name || 'Unknown Supplier';
}

export function exportComparativeStatementPdf(params: {
  rfq: Rfq;
  quotes: Quotation[];
  suppliers: Supplier[];
  settings: OrganizationSettings;
  basis: CostBasis;
  award?: AwardDecision;
}) {
  const { rfq, quotes, suppliers, settings, basis, award } = params;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

  const sortedQuotes = [...quotes].sort((a, b) => a.totalLandedCost - b.totalLandedCost);

  doc.setFontSize(14);
  doc.setTextColor(15, 23, 42);
  doc.text(`COMPARATIVE STATEMENT (CS) — ${rfq.rfqNumber}`, 14, 15);

  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text(
    `${settings.name}  |  ${rfq.title}  |  Basis: ${
      basis === 'landed'
        ? 'Normalized Landed Cost (Ex-Creditable Tax)'
        : basis === 'base'
        ? 'Base Ex-Tax'
        : 'Gross Payable'
    }  |  Generated: ${formatDateShort(new Date().toISOString())}`,
    14,
    21
  );
  doc.text(
    `Incoterms: ${rfq.incoterms}  |  Location: ${rfq.deliveryLocation}  |  Prepared by: ${settings.activeUserName}`,
    14,
    26
  );

  // Vendor Summary Table
  const summaryHead = [
    [
      'Rank',
      'Supplier',
      'Quote Ref',
      'Completeness',
      'Subtotal Ex-Tax',
      'Freight + P&F',
      'Tax',
      'Total Landed Cost',
      'Lead Time',
      'Payment Terms',
      'Status',
    ],
  ];

  const summaryBody = sortedQuotes.map((q, idx) => [
    `L${idx + 1}`,
    getSupplierName(suppliers, q.supplierId),
    q.quoteReference,
    `${Math.round(q.completenessRatio * 100)}%`,
    formatMoney(q.subtotalBase, rfq.currency),
    formatMoney(q.freightCharges + q.packingForwarding + q.otherCharges - q.globalDiscount, rfq.currency),
    formatMoney(q.totalTax, rfq.currency),
    formatMoney(q.totalLandedCost, rfq.currency),
    q.leadTimeDays ? `${q.leadTimeDays} days` : '—',
    q.paymentTerms || '—',
    q.isVerified ? 'Verified' : 'Needs Review',
  ]);

  autoTable(doc, {
    startY: 31,
    head: summaryHead,
    body: summaryBody,
    styles: { fontSize: 7.5, cellPadding: 2 },
    headStyles: { fillColor: [15, 76, 129], textColor: 255 },
  });

  // Line-by-Line Matrix
  const matrixHead = [
    [
      '#',
      'SKU / Description',
      'Qty / UOM',
      'Target / Last',
      ...sortedQuotes.map((q, idx) => `L${idx + 1}: ${getSupplierName(suppliers, q.supplierId).slice(0, 18)}`),
    ],
  ];

  const matrixBody = rfq.items.map((item) => {
    const row: string[] = [
      String(item.lineNo),
      `${item.skuCode ? item.skuCode + ' - ' : ''}${item.description}`,
      `${item.quantity} ${item.uom}`,
      item.targetUnitPrice ? formatMoney(item.targetUnitPrice, rfq.currency) : '—',
    ];

    for (const q of sortedQuotes) {
      const line = q.lines.find((l) => l.rfqItemId === item.id);
      if (!line || line.matchStatus === 'not_quoted') {
        row.push('NOT QUOTED');
      } else {
        const unitVal =
          basis === 'base'
            ? line.normalizedUnitBase
            : basis === 'gross'
            ? line.normalizedUnitGross
            : line.normalizedUnitLanded;
        const note =
          line.uomConversionFactor > 1
            ? ` (${line.uomConversionFactor}x ${line.quotedUom})`
            : line.matchStatus === 'alternate_spec'
            ? ' (Alt Spec)'
            : !line.mathValid
            ? ' [Math Mismatch]'
            : '';
        row.push(`${formatMoney(unitVal, rfq.currency)}${note}`);
      }
    }
    return row;
  });

  const lastY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 75;

  autoTable(doc, {
    startY: lastY + 7,
    head: matrixHead,
    body: matrixBody,
    styles: { fontSize: 7.5, cellPadding: 2 },
    headStyles: { fillColor: [30, 41, 59], textColor: 255 },
  });

  if (award) {
    const afterMatrixY =
      (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 150;
    doc.setFontSize(9);
    doc.setTextColor(15, 23, 42);
    doc.text(
      `Award Status: ${award.approvalStatus.toUpperCase()}  |  Total Awarded Landed: ${formatMoney(
        award.totalAwardedLanded,
        rfq.currency
      )}  |  Recommended by: ${award.recommendedBy}${
        award.approvedBy ? `  |  Approved by: ${award.approvedBy}` : ''
      }`,
      14,
      afterMatrixY + 8
    );
    if (award.nonL1Justification) {
      doc.setFontSize(8);
      doc.setTextColor(71, 85, 105);
      doc.text(`Non-L1 Justification: ${award.nonL1Justification}`, 14, afterMatrixY + 13);
    }
  }

  doc.save(`${rfq.rfqNumber}_Comparative_Statement.pdf`);
}

export function exportComparativeStatementExcel(params: {
  rfq: Rfq;
  quotes: Quotation[];
  suppliers: Supplier[];
  settings: OrganizationSettings;
  auditLogs: AuditLogEntry[];
}) {
  const { rfq, quotes, suppliers, settings, auditLogs } = params;
  const sortedQuotes = [...quotes].sort((a, b) => a.totalLandedCost - b.totalLandedCost);

  const wb = XLSX.utils.book_new();

  // Sheet 1: Summary
  const summaryRows: (string | number | { f: string })[][] = [
    ['NORUS QUOTEFLOW — COMPARATIVE STATEMENT SUMMARY'],
    ['Organization', settings.name, 'RFQ Number', rfq.rfqNumber],
    ['RFQ Title', rfq.title, 'Currency', rfq.currency],
    ['Delivery Location', rfq.deliveryLocation, 'Incoterms', rfq.incoterms],
    [],
    [
      'Rank',
      'Supplier',
      'Quote Ref',
      'Completeness',
      'Subtotal Ex-Tax',
      'Freight Charges',
      'Packing & Forwarding',
      'Global Discount',
      'Tax Total',
      'Total Landed Cost',
      'Lead Time (Days)',
      'Payment Terms',
      'Verification',
    ],
  ];

  sortedQuotes.forEach((q, idx) => {
    const r = idx + 7; // 1-indexed Excel row
    summaryRows.push([
      `L${idx + 1}`,
      getSupplierName(suppliers, q.supplierId),
      q.quoteReference,
      `${Math.round(q.completenessRatio * 100)}%`,
      q.subtotalBase,
      q.freightCharges,
      q.packingForwarding,
      q.globalDiscount,
      q.totalTax,
      { f: `E${r}+F${r}+G${r}-H${r}` },
      q.leadTimeDays ?? 0,
      q.paymentTerms || '',
      q.isVerified ? 'Verified' : 'Needs Review',
    ]);
  });

  if (sortedQuotes.length > 0) {
    const endRow = 6 + sortedQuotes.length;
    summaryRows.push([
      'Lowest Landed (L1)',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      { f: `MIN(J7:J${endRow})` },
      '',
      '',
      '',
    ]);
  }

  const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

  // Sheet 2: Line Matrix
  const matrixHeader = [
    'Line #',
    'SKU',
    'Description',
    'Qty',
    'UOM',
    'Last Paid / Target',
    ...sortedQuotes.map((q, i) => `L${i + 1} ${getSupplierName(suppliers, q.supplierId)} (Landed Unit)`),
    ...sortedQuotes.map((q, i) => `L${i + 1} ${getSupplierName(suppliers, q.supplierId)} (Line Landed)`),
  ];

  const matrixRows: (string | number | { f: string })[][] = [matrixHeader];
  rfq.items.forEach((item, idx) => {
    const rowIdx = idx + 2;
    const unitCols = sortedQuotes.map((q) => {
      const l = q.lines.find((ql) => ql.rfqItemId === item.id);
      if (!l || l.matchStatus === 'not_quoted' || l.normalizedUnitLanded === null) return 'NOT QUOTED';
      return l.normalizedUnitLanded;
    });
    const extCols = sortedQuotes.map((_, qIdx) => {
      const colLetter = XLSX.utils.encode_col(6 + qIdx);
      return { f: `IF(ISNUMBER(${colLetter}${rowIdx}), D${rowIdx}*${colLetter}${rowIdx}, 0)` };
    });
    matrixRows.push([
      item.lineNo,
      item.skuCode,
      item.description,
      item.quantity,
      item.uom,
      item.targetUnitPrice ?? '',
      ...unitCols,
      ...extCols,
    ]);
  });

  const wsMatrix = XLSX.utils.aoa_to_sheet(matrixRows);
  XLSX.utils.book_append_sheet(wb, wsMatrix, 'Line_Matrix');

  // Sheet 3: Exceptions & Audit
  const exceptionRows: string[][] = [
    ['Supplier', 'Line #', 'Issue Type', 'Detail', 'Source Trace'],
  ];
  for (const q of sortedQuotes) {
    const supName = getSupplierName(suppliers, q.supplierId);
    if (q.missingFreightWarning) {
      exceptionRows.push([supName, '-', 'Missing Freight', 'Freight omitted or extra at actuals', q.documentName]);
    }
    for (const l of q.lines) {
      if (!l.mathValid) {
        exceptionRows.push([
          supName,
          String(l.vendorLineNo),
          'Arithmetic Mismatch',
          l.mathErrorDetail || 'Printed total differs from calculated',
          l.sourceTrace.snippet,
        ]);
      }
      if (l.matchStatus === 'not_quoted') {
        exceptionRows.push([supName, String(l.vendorLineNo), 'Not Quoted', l.rawDescription, l.sourceTrace.snippet]);
      }
      if (l.matchStatus === 'alternate_spec') {
        exceptionRows.push([supName, String(l.vendorLineNo), 'Alternate Spec', l.rawDescription, l.sourceTrace.snippet]);
      }
    }
  }
  const wsExceptions = XLSX.utils.aoa_to_sheet(exceptionRows);
  XLSX.utils.book_append_sheet(wb, wsExceptions, 'Exceptions');

  const auditRows = [
    ['Timestamp', 'Actor', 'Role', 'Action', 'Detail'],
    ...auditLogs.slice(0, 40).map((a) => [a.createdAt, a.actorName, a.actorRole, a.action, a.detail]),
  ];
  const wsAudit = XLSX.utils.aoa_to_sheet(auditRows);
  XLSX.utils.book_append_sheet(wb, wsAudit, 'Audit_Log');

  XLSX.writeFile(wb, `${rfq.rfqNumber}_Comparative_Statement.xlsx`);
}
