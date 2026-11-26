import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import writeXlsxFile, {
  type Cell,
  type Row,
  type Sheet,
  type SheetData,
} from 'write-excel-file/universal';
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
import { isLineQuantitySufficient, rankQuotations } from './ranking.ts';

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
      const line = q.lines.find((l) => l.rfqItemId === item.id && l.matchStatus !== 'unmapped');
      if (!line || line.matchStatus === 'not_quoted') {
        row.push('NOT QUOTED');
      } else {
        const unitVal =
          basis === 'base'
            ? line.normalizedUnitBase
            : basis === 'gross'
            ? line.normalizedUnitGross
            : line.normalizedUnitLanded;
        const notes: string[] = [];
        if (line.uomConversionFactor !== 1) {
          notes.push(`(${line.uomConversionFactor}x ${line.quotedUom})`);
        }
        if (line.matchStatus === 'alternate_spec') {
          notes.push('(Alt Spec)');
        }
        if (!line.mathValid) {
          notes.push('[Math Mismatch]');
        }
        if (!isLineQuantitySufficient(line, item).ok) {
          notes.push('[Short Qty]');
        }
        const noteSuffix = notes.length > 0 ? ` ${notes.join(' ')}` : '';
        row.push(`${formatMoney(unitVal, rfq.currency)}${noteSuffix}`);
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

function encodeColLetter(index: number): string {
  let letter = '';
  let n = index;
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

function formulaCell(formula: string): Cell {
  return { type: 'Formula', value: formula };
}

export type ExporterSheetName = 'Summary' | 'Line_Matrix' | 'Exceptions' | 'Audit_Log';

export interface ComparativeStatementWorkbook {
  sheetNames: ExporterSheetName[];
  sheets: Sheet<Blob>[];
  toBlob: () => Promise<Blob>;
  toUint8Array: () => Promise<Uint8Array>;
}

export function buildComparativeStatementWorkbook(params: {
  rfq: Rfq;
  quotes: Quotation[];
  suppliers: Supplier[];
  settings: OrganizationSettings;
  auditLogs: AuditLogEntry[];
  award?: AwardDecision;
}): ComparativeStatementWorkbook {
  const { rfq, quotes, suppliers, settings, auditLogs, award } = params;
  const rankedQuotes = rankQuotations(quotes, 'landed', rfq);

  // Sheet 1: Summary
  const summaryRows: Row[] = [
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
      formulaCell(`MAX(0,E${r}+F${r}+G${r}-H${r}+J${r})`),
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
      formulaCell(`MIN(${eligibleRowIndices.join(',')})`),
      '',
      '',
      '',
    ]);
  }

  // Sheet 2: Line Matrix
  const matrixHeader: Row = [
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

  const matrixRows: Row[] = [matrixHeader];
  rfq.items.forEach((item, idx) => {
    const rowIdx = idx + 2;
    const unitCols: Cell[] = rankedQuotes.map((rk) => {
      const l = rk.quotation.lines.find(
        (ql) => ql.rfqItemId === item.id && ql.matchStatus !== 'unmapped'
      );
      if (!l || l.matchStatus === 'not_quoted' || l.normalizedUnitLanded === null) {
        return 'NOT QUOTED';
      }
      return l.normalizedUnitLanded;
    });
    const extCols: Cell[] = rankedQuotes.map((_, qIdx) => {
      const colLetter = encodeColLetter(6 + qIdx);
      return formulaCell(`IF(ISNUMBER(${colLetter}${rowIdx}), D${rowIdx}*${colLetter}${rowIdx}, 0)`);
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

  // Sheet 3: Exceptions
  const exceptionRows: SheetData = [
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
      if (l.rfqItemId && l.matchStatus !== 'not_quoted' && l.matchStatus !== 'unmapped') {
        const mappedItem = rfq.items.find((it) => it.id === l.rfqItemId);
        if (mappedItem) {
          const qtyCheck = isLineQuantitySufficient(l, mappedItem);
          if (!qtyCheck.ok) {
            exceptionRows.push([
              supName,
              String(l.vendorLineNo),
              'Insufficient Quantity',
              sanitizeSpreadsheetCell(
                `Converted qty ${qtyCheck.convertedQty ?? 'missing'} < RFQ required ${mappedItem.quantity} ${mappedItem.uom}`
              ),
              sanitizeSpreadsheetCell(l.sourceTrace.snippet),
            ]);
          }
        }
      }
    }
  }

  const auditRows: SheetData = [
    ['Timestamp', 'Actor', 'Role', 'Action', 'Detail'],
    ...auditLogs.slice(0, 40).map((a) => [
      a.createdAt,
      sanitizeSpreadsheetCell(a.actorName),
      a.actorRole,
      a.action,
      sanitizeSpreadsheetCell(a.detail),
    ]),
  ];

  const sheets: Sheet<Blob>[] = [
    { sheet: 'Summary', data: summaryRows },
    { sheet: 'Line_Matrix', data: matrixRows },
    { sheet: 'Exceptions', data: exceptionRows },
    { sheet: 'Audit_Log', data: auditRows },
  ];

  const toBlob = () => writeXlsxFile(sheets).toBlob();

  return {
    sheetNames: ['Summary', 'Line_Matrix', 'Exceptions', 'Audit_Log'],
    sheets,
    toBlob,
    toUint8Array: async () => {
      const blob = await toBlob();
      return new Uint8Array(await blob.arrayBuffer());
    },
  };
}

export async function exportComparativeStatementExcel(params: {
  rfq: Rfq;
  quotes: Quotation[];
  suppliers: Supplier[];
  settings: OrganizationSettings;
  auditLogs: AuditLogEntry[];
  award?: AwardDecision;
}): Promise<void> {
  const wb = buildComparativeStatementWorkbook(params);
  const blob = await wb.toBlob();
  const filename = `${params.rfq.rfqNumber}_Comparative_Statement.xlsx`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
