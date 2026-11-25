import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { createInitialWorkspaceState } from '../server/seedData.ts';
import {
  buildComparativeStatementPdfDoc,
  buildComparativeStatementWorkbook,
  sanitizeSpreadsheetCell,
} from '../src/lib/exporters.ts';
import { AwardDecision } from '../src/types.ts';

test('sanitizeSpreadsheetCell neutralizes CSV/Excel formula injection payloads', () => {
  assert.equal(sanitizeSpreadsheetCell('=CMD|"/C calc"!A0'), "'=CMD|\"/C calc\"!A0");
  assert.equal(sanitizeSpreadsheetCell('+1+1'), "'+1+1");
  assert.equal(sanitizeSpreadsheetCell('-2+3'), "'-2+3");
  assert.equal(sanitizeSpreadsheetCell('@SUM(A1:A2)'), "'@SUM(A1:A2)");
  assert.equal(sanitizeSpreadsheetCell('Normal Vendor Pvt Ltd'), 'Normal Vendor Pvt Ltd');
});

test('buildComparativeStatementWorkbook creates 4 sheets, live formulas, sanitized cells, verified L1 rank, and split-award table', () => {
  const ws = createInitialWorkspaceState();
  const rfq = ws.rfqs[0];
  const quotes = ws.quotations.filter((q) => q.rfqId === rfq.id);
  const suppliers = ws.suppliers.map((s, idx) =>
    idx === 0 ? { ...s, name: '=HYPERLINK("http://evil.example","Evil")' } : s
  );

  const award: AwardDecision = {
    id: 'award-exp-1',
    rfqId: rfq.id,
    isSplitAward: true,
    recommendedBy: 'Priya Sharma',
    approvedBy: 'Vikram Patel',
    approvalStatus: 'approved',
    nonL1Justification: 'Split for fastest lead time',
    approverNotes: 'OK',
    totalAwardedLanded: 220000,
    allocations: [
      {
        rfqItemId: rfq.items[0].id,
        quotationId: quotes[0].id,
        quotationLineId: quotes[0].lines[0].id,
        supplierId: quotes[0].supplierId,
        awardedQty: rfq.items[0].quantity,
        awardedUnitLanded: quotes[0].lines[0].normalizedUnitLanded ?? 2400,
      },
    ],
    decidedAt: '2026-11-21T00:00:00.000Z',
    createdAt: '2026-11-21T00:00:00.000Z',
  };

  const wb = buildComparativeStatementWorkbook({
    rfq,
    quotes,
    suppliers,
    settings: ws.settings,
    auditLogs: ws.auditLogs,
    award,
  });

  assert.deepEqual(wb.SheetNames, ['Summary', 'Line_Matrix', 'Exceptions', 'Audit_Log']);

  const summary = wb.Sheets['Summary'];
  // Row 7 should be the verified complete L1 quote (Shree Ganesh), not incomplete Bharat Fasteners
  assert.equal(summary['A7']?.v, 'L1');
  assert.ok(String(summary['B7']?.v).startsWith("'=")); // Formula injection neutralized!
  assert.match(String(summary['K7']?.f), /^MAX\(0,E7\+F7\+G7-H7\+J7\)$/);

  const matrix = wb.Sheets['Line_Matrix'];
  const matrixAoA = XLSX.utils.sheet_to_json<string[]>(matrix, { header: 1 });
  assert.ok(matrixAoA.some((row) => row[0] === 'AWARD ALLOCATION'));

  const outBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  assert.ok(outBuf.byteLength > 2000);
});

test('buildComparativeStatementPdfDoc produces valid landscape PDF bytes including split-award table', () => {
  const ws = createInitialWorkspaceState();
  const rfq = ws.rfqs[0];
  const quotes = ws.quotations.filter((q) => q.rfqId === rfq.id);
  const award: AwardDecision = {
    id: 'award-pdf-1',
    rfqId: rfq.id,
    isSplitAward: true,
    recommendedBy: 'Priya Sharma',
    approvedBy: null,
    approvalStatus: 'pending',
    nonL1Justification: 'Dual sourcing required',
    approverNotes: null,
    totalAwardedLanded: 215000,
    allocations: [
      {
        rfqItemId: rfq.items[0].id,
        quotationId: quotes[0].id,
        quotationLineId: quotes[0].lines[0].id,
        supplierId: quotes[0].supplierId,
        awardedQty: rfq.items[0].quantity,
        awardedUnitLanded: quotes[0].lines[0].normalizedUnitLanded ?? 2400,
      },
    ],
    decidedAt: null,
    createdAt: '2026-11-21T00:00:00.000Z',
  };

  const doc = buildComparativeStatementPdfDoc({
    rfq,
    quotes,
    suppliers: ws.suppliers,
    settings: ws.settings,
    basis: 'landed',
    award,
  });

  const arrayBuffer = doc.output('arraybuffer');
  const buf = Buffer.from(arrayBuffer);
  assert.equal(buf.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.ok(buf.byteLength > 1500);
});

test('Task 008: Excel Exceptions logs Insufficient Quantity and PDF includes [Short Qty] alongside UOM conversion', () => {
  const ws = createInitialWorkspaceState();
  const rfq = ws.rfqs[0];
  const baseQuotes = ws.quotations.filter((q) => q.rfqId === rfq.id);
  const shortQuote = {
    ...baseQuotes[0],
    lines: baseQuotes[0].lines.map((l, idx) =>
      idx === 0
        ? {
            ...l,
            quotedQty: 1,
            uomConversionFactor: 2,
            quotedUom: 'pack',
            mathValid: false,
            matchStatus: 'alternate_spec' as const,
          }
        : l
    ),
  };

  const wb = buildComparativeStatementWorkbook({
    rfq,
    quotes: [shortQuote, ...baseQuotes.slice(1)],
    suppliers: ws.suppliers,
    settings: ws.settings,
    auditLogs: ws.auditLogs,
  });
  const exceptionsAoA = XLSX.utils.sheet_to_json<string[]>(wb.Sheets['Exceptions'], { header: 1 });
  assert.ok(
    exceptionsAoA.some((row) => row[2] === 'Insufficient Quantity' && /Converted qty 2 < RFQ required/.test(row[3])),
    'Expected Insufficient Quantity row in Excel Exceptions sheet'
  );

  const doc = buildComparativeStatementPdfDoc({
    rfq,
    quotes: [shortQuote, ...baseQuotes.slice(1)],
    suppliers: ws.suppliers,
    settings: ws.settings,
    basis: 'landed',
  });
  const pdfBuf = Buffer.from(doc.output('arraybuffer'));
  assert.equal(pdfBuf.subarray(0, 5).toString('ascii'), '%PDF-');
  const pagesText = (doc as unknown as { internal: { pages: string[][] } }).internal.pages
    .map((p) =>
      Array.isArray(p)
        ? p
            .join('\n')
            .replace(/\u0000/g, '')
            .replace(/\\([()])/g, '$1')
        : ''
    )
    .join('\n');
  assert.ok(pagesText.includes('[Short Qty]'));
  assert.ok(pagesText.includes('[Math Mismatch]'));
  assert.ok(pagesText.includes('(Alt Spec)'));
  assert.ok(pagesText.includes('(2x pack)'));
});
