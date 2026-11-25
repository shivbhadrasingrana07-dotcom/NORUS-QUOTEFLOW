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
import { rankQuotations } from './ranking.ts';

function getSupplierName(suppliers: Supplier[], id: string): string {
  return suppliers.find((s) => s.id === id)?.name || 'Unknown Supplier';
}

/**
 * Neutralizes spreadsheet formula injection (CSV/Excel DDE attacks)
 * on untrusted supplier-supplied strings before writing cells.
 */
export function sanitizeSpreadsheetCell(value: string): string {
  if (!value) return '';
  if (/^[=+\-@\t\r]/.test(value)) {
    return `'${value}`;
  }
  return value;
}

export function buildComparativeStatementPdfDoc(params: {
  rfq: Rfq;
  quotes: Quotation[];
  suppliers: Supplier[];
  settings: OrganizationSettings;
  basis: CostBasis;
  award?: AwardDecision;
}): jsPDF {
  const { rfq, quotes, suppliers, settings, basis, award } = params;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

  const rankedQuotes = rankQuotations(quotes, basis, rfq);

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
      'Freight + P&F - Disc',
      'Tax',
      'Total Landed Cost',
      'Lead Time',
      'Payment Terms',
      'Audit Status',
    ],
  ];

  const summaryBody = rankedQuotes.map((r) => {
    const q = r.quotation;
    return [
      r.rankLabel,
      getSupplierName(suppliers, q.supplierId),
      q.quoteReference,
      `${Math.round(q.completenessRatio * 100)}%`,
      formatMoney(q.subtotalBase, rfq.currency),
      formatMoney(
        (q.freightCharges + q.packingForwarding + q.otherCharges - q.globalDiscount) *
          q.exchangeRateToRfq,
        rfq.currency
      ),
      formatMoney(q.totalTax, rfq.currency),
      formatMoney(q.totalLandedCost, rfq.currency),
      q.leadTimeDays !== null ? `${q.leadTimeDays} days` : '—',
      q.paymentTerms || '—',
      r.eligibleForAwardRank ? 'Verified & Complete' : r.ineligibilityReasons.join(', '),
    ];
  });

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
      ...rankedQuotes.map(
        (r) => `${r.rankLabel}: ${getSupplierName(suppliers, r.quotation.supplierId).slice(0, 18)}`
      ),
    ],
  ];

  const matrixBody = rfq.items.map((item) => {
    const row: string[] = [
      String(item.lineNo),
      `${item.skuCode ? item.skuCode + ' - ' : ''}${item.description}`,
      `${item.quantity} ${item.uom}`,
      item.targetUnitPrice ? formatMoney(item.targetUnitPrice, rfq.currency) : '—',
    ];

    for (const r of rankedQuotes) {
      const q = r.quotation;
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
          line.uomConversionFactor !== 1
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
      `Award Status: ${award.approvalStatus.toUpperCase()} (${
        award.isSplitAward ? 'Split Award' : 'Full Package'
      })  |  Total Awarded Landed: ${formatMoney(
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

    if (award.isSplitAward && award.allocations.length > 0) {
      autoTable(doc, {
        startY: afterMatrixY + (award.nonL1Justification ? 17 : 12),
        head: [['Item', 'Awarded Supplier', 'Qty', 'Landed Unit', 'Line Total']],
        body: award.allocations.map((al) => {
          const item = rfq.items.find((i) => i.id === al.rfqItemId);
          return [
            item?.description || al.rfqItemId,
            getSupplierName(suppliers, al.supplierId),
            `${al.awardedQty} ${item?.uom || ''}`,
            formatMoney(al.awardedUnitLanded, rfq.currency),
            formatMoney(al.awardedQty * al.awardedUnitLanded, rfq.currency),
          ];
        }),
        styles: { fontSize: 7.5, cellPadding: 2 },
        headStyles: { fillColor: [5, 150, 105], textColor: 255 },
      });
    }
  }

  return doc;
}

export function exportComparativeStatementPdf(params: {
  rfq: Rfq;
  quotes: Quotation[];
  suppliers: Supplier[];
  settings: OrganizationSettings;
  basis: CostBasis;
  award?: AwardDecision;
}) {
  const doc = buildComparativeStatementPdfDoc(params);
  doc.save(`${params.rfq.rfqNumber}_Comparative_Statement.pdf`);
}

export function buildComparativeStatementWorkbook(params: {
  rfq: Rfq;
  quotes: Quotation[];
  suppliers: Supplier[];
  settings: OrganizationSettings;
  auditLogs: AuditLogEntry[];
  award?: AwardDecision;
}): XLSX.WorkBook {
  const { rfq, quotes, suppliers, settings, auditLogs, award } = params;
  const rankedQuotes = rankQuotations(quotes, 'landed', rfq);

  const wb = XLSX.utils.book_new();

  // Sheet 1: Summary
  const summaryRows: (string | number | { f: string })[][] = [
    ['NORUS QUOTEFLOW — COMPARATIVE STATEMENT SUMMARY'],
    ['Organization', sanitizeSpreadsheetCell(settings.name), 'RFQ Number', rfq.rfqNumber],
    ['RFQ Title', sanitizeSpreadsheetCell(rfq.title), 'Currency', rfq.currency],
    ['Delivery Location', sanitizeSpreadsheetCell(rfq.deliveryLocation), 'Incoterms', sanitizeSpreadsheetCell(rfq.incoterms)],
    [],
    [
      'Rank',
      'Supplier',
      'Quote Ref',
      'Completeness',
      'Subtotal Ex-Tax (RFQ Curr)',
      'Freight Charges (RFQ Curr)',
      'Packing & Forwarding (RFQ Curr)',
      'Global Discount (RFQ Curr)',
      'Tax Total (RFQ Curr)',
      'Non-Creditable Tax (RFQ Curr)',
      'Total Landed Cost',
      'Lead Time (Days)',
      'Payment Terms',
      'Verification',
    ],
  ];

  rankedQuotes.forEach((rk, idx) => {
    const q = rk.quotation;
    const fx = q.exchangeRateToRfq > 0 ? q.exchangeRateToRfq : 1;
    const r = idx + 7; // 1-indexed Excel row
    const netOverheadRfq =
      (q.freightCharges + q.packingForwarding + q.otherCharges - q.globalDiscount) * fx;
    const nonCreditableTaxRfq = Math.max(
      0,
      Math.round((q.totalLandedCost - (q.subtotalBase + netOverheadRfq)) * 100) / 100
    );
    summaryRows.push([
      rk.rankLabel,
      sanitizeSpreadsheetCell(getSupplierName(suppliers, q.supplierId)),
      sanitizeSpreadsheetCell(q.quoteReference),
      `${Math.round(q.completenessRatio * 100)}%`,
      q.subtotalBase,
      Math.round(q.freightCharges * fx * 100) / 100,
      Math.round((q.packingForwarding + q.otherCharges) * fx * 100) / 100,
      Math.round(q.globalDiscount * fx * 100) / 100,
      q.totalTax,
      nonCreditableTaxRfq,
      { f: `MAX(0,E${r}+F${r}+G${r}-H${r}+J${r})` },
      q.leadTimeDays ?? 0,
      sanitizeSpreadsheetCell(q.paymentTerms || ''),
      rk.eligibleForAwardRank ? 'Verified & Complete' : rk.ineligibilityReasons.join('; '),
    ]);
  });

  const eligibleRowIndices = rankedQuotes
    .map((rk, idx) => (rk.eligibleForAwardRank ? `K${idx + 7}` : null))
    .filter((ref): ref is string => Boolean(ref));

  if (eligibleRowIndices.length > 0) {
    summaryRows.push([
      'Lowest Verified L1',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      { f: `MIN(${eligibleRowIndices.join(',')})` },
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
    ...rankedQuotes.map(
      (rk) => `${rk.rankLabel} ${sanitizeSpreadsheetCell(getSupplierName(suppliers, rk.quotation.supplierId))} (Landed Unit)`
    ),
    ...rankedQuotes.map(
      (rk) => `${rk.rankLabel} ${sanitizeSpreadsheetCell(getSupplierName(suppliers, rk.quotation.supplierId))} (Line Landed)`
    ),
  ];

  const matrixRows: (string | number | { f: string })[][] = [matrixHeader];
  rfq.items.forEach((item, idx) => {
    const rowIdx = idx + 2;
    const unitCols = rankedQuotes.map((rk) => {
      const l = rk.quotation.lines.find((ql) => ql.rfqItemId === item.id);
      if (!l || l.matchStatus === 'not_quoted' || l.normalizedUnitLanded === null) {
        return 'NOT QUOTED';
      }
      return l.normalizedUnitLanded;
    });
    const extCols = rankedQuotes.map((_, qIdx) => {
      const colLetter = XLSX.utils.encode_col(6 + qIdx);
      return { f: `IF(ISNUMBER(${colLetter}${rowIdx}), D${rowIdx}*${colLetter}${rowIdx}, 0)` };
    });
    matrixRows.push([
      item.lineNo,
      sanitizeSpreadsheetCell(item.skuCode),
      sanitizeSpreadsheetCell(item.description),
      item.quantity,
      sanitizeSpreadsheetCell(item.uom),
      item.targetUnitPrice ?? '',
      ...unitCols,
      ...extCols,
    ]);
  });

  if (award && award.allocations.length > 0) {
    matrixRows.push([]);
    matrixRows.push([
      'AWARD ALLOCATION',
      award.approvalStatus.toUpperCase(),
      award.isSplitAward ? 'Split Award' : 'Full Package',
      '',
      '',
      award.totalAwardedLanded,
    ]);
    matrixRows.push(['Line Item', 'Awarded Supplier', 'Awarded Qty', 'Unit Landed', 'Line Total']);
    for (const al of award.allocations) {
      const item = rfq.items.find((i) => i.id === al.rfqItemId);
      matrixRows.push([
        sanitizeSpreadsheetCell(item?.description || al.rfqItemId),
        sanitizeSpreadsheetCell(getSupplierName(suppliers, al.supplierId)),
        al.awardedQty,
        al.awardedUnitLanded,
        Math.round(al.awardedQty * al.awardedUnitLanded * 100) / 100,
      ]);
    }
  }

  const wsMatrix = XLSX.utils.aoa_to_sheet(matrixRows);
  XLSX.utils.book_append_sheet(wb, wsMatrix, 'Line_Matrix');

  // Sheet 3: Exceptions
  const exceptionRows: string[][] = [
    ['Supplier', 'Line #', 'Issue Type', 'Detail', 'Source Trace'],
  ];
  for (const rk of rankedQuotes) {
    const q = rk.quotation;
    const supName = sanitizeSpreadsheetCell(getSupplierName(suppliers, q.supplierId));
    if (q.missingFreightWarning) {
      exceptionRows.push([
        supName,
        '-',
        'Missing Freight',
        'Freight omitted or extra at actuals',
        sanitizeSpreadsheetCell(q.documentName),
      ]);
    }
    for (const l of q.lines) {
      if (!l.mathValid) {
        exceptionRows.push([
          supName,
          String(l.vendorLineNo),
          'Arithmetic Mismatch',
          sanitizeSpreadsheetCell(l.mathErrorDetail || 'Printed total differs from calculated'),
          sanitizeSpreadsheetCell(l.sourceTrace.snippet),
        ]);
      }
      if (l.matchStatus === 'not_quoted') {
        exceptionRows.push([
          supName,
          String(l.vendorLineNo),
          'Not Quoted',
          sanitizeSpreadsheetCell(l.rawDescription),
          sanitizeSpreadsheetCell(l.sourceTrace.snippet),
        ]);
      }
      if (l.matchStatus === 'alternate_spec') {
        exceptionRows.push([
          supName,
          String(l.vendorLineNo),
          'Alternate Spec',
          sanitizeSpreadsheetCell(l.rawDescription),
          sanitizeSpreadsheetCell(l.sourceTrace.snippet),
        ]);
      }
    }
  }
  const wsExceptions = XLSX.utils.aoa_to_sheet(exceptionRows);
  XLSX.utils.book_append_sheet(wb, wsExceptions, 'Exceptions');

  const auditRows = [
    ['Timestamp', 'Actor', 'Role', 'Action', 'Detail'],
    ...auditLogs.slice(0, 40).map((a) => [
      a.createdAt,
      sanitizeSpreadsheetCell(a.actorName),
      a.actorRole,
      a.action,
      sanitizeSpreadsheetCell(a.detail),
    ]),
  ];
  const wsAudit = XLSX.utils.aoa_to_sheet(auditRows);
  XLSX.utils.book_append_sheet(wb, wsAudit, 'Audit_Log');

  return wb;
}

export function exportComparativeStatementExcel(params: {
  rfq: Rfq;
  quotes: Quotation[];
  suppliers: Supplier[];
  settings: OrganizationSettings;
  auditLogs: AuditLogEntry[];
  award?: AwardDecision;
}) {
  const wb = buildComparativeStatementWorkbook(params);
  XLSX.writeFile(wb, `${params.rfq.rfqNumber}_Comparative_Statement.xlsx`);
}
