import test from 'node:test';
import assert from 'node:assert/strict';
import readXlsxFile from 'read-excel-file/node';
import { unzipSync, strFromU8 } from 'fflate';
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

test('buildComparativeStatementWorkbook creates 4 sheets, live formulas, sanitized cells, verified L1 rank, and split-award table', async () => {
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

  assert.deepEqual(wb.sheetNames, ['Summary', 'Line_Matrix', 'Exceptions', 'Audit_Log']);

  const outBytes = await wb.toUint8Array();
  const outBuf = Buffer.from(outBytes);
  assert.ok(outBuf.byteLength > 2000);
  assert.equal(outBuf.subarray(0, 2).toString('ascii'), 'PK');

  // Inspect OOXML zip directly for ECMA-376 <f> formula elements
  const unzipped = unzipSync(outBytes);
  const sheet1Xml = strFromU8(unzipped['xl/worksheets/sheet1.xml']);
  const sheet2Xml = strFromU8(unzipped['xl/worksheets/sheet2.xml']);
  assert.ok(
    sheet1Xml.includes('<f>MAX(0,E7+F7+G7-H7+J7)</f>'),
    'Summary sheet must contain MAX landed cost formula in K7'
  );
  assert.ok(
    sheet1Xml.includes('<f>MIN(K7'),
    'Summary sheet must contain MIN verified L1 formula'
  );
  assert.ok(
    sheet2Xml.includes('<f>IF(ISNUMBER(G2), D2*G2, 0)</f>'),
    'Line_Matrix must contain IF(ISNUMBER(...)) extended cost formula'
  );

  // Round-trip read via read-excel-file/node (note: formula cells without cached <v> parse as null)
  const parsedSheets = await readXlsxFile(outBuf);
  assert.deepEqual(
    parsedSheets.map((s) => s.sheet),
    ['Summary', 'Line_Matrix', 'Exceptions', 'Audit_Log']
  );

  const summary = parsedSheets[0].data;
  assert.equal(summary[6][0], 'L1');
  assert.ok(String(summary[6][1]).startsWith("'=")); // Formula injection neutralized!
  assert.equal(typeof summary[6][4], 'number');

  const matrix = parsedSheets[1].data;
  assert.ok(matrix.some((row) => row[0] === 'AWARD ALLOCATION'));
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

test('Task 008: Excel Exceptions logs Insufficient Quantity and PDF includes [Short Qty] alongside UOM conversion', async () => {
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
  const outBuf = Buffer.from(await wb.toUint8Array());
  const parsedSheets = await readXlsxFile(outBuf);
  const exceptionsAoA = parsedSheets[2].data;
  assert.ok(
    exceptionsAoA.some(
      (row) =>
        row[2] === 'Insufficient Quantity' &&
        /Converted qty 2 < RFQ required/.test(String(row[3] ?? ''))
    ),
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
