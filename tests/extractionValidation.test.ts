import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { validateUploadedFile, sanitizeFilename } from '../server/fileSecurity.ts';
import {
  buildQuotationFromExtraction,
  colIndexToLetter,
  ExtractionServiceError,
  extractQuotationWithGemini,
  parseAndValidateAiJson,
  parseSpreadsheetBuffer,
} from '../server/geminiExtractor.ts';
import { createInitialWorkspaceState } from '../server/seedData.ts';

test('colIndexToLetter handles single and multi-letter Excel columns accurately', () => {
  assert.equal(colIndexToLetter(0), 'A');
  assert.equal(colIndexToLetter(25), 'Z');
  assert.equal(colIndexToLetter(26), 'AA');
  assert.equal(colIndexToLetter(27), 'AB');
  assert.equal(colIndexToLetter(51), 'AZ');
});

test('sanitizeFilename strips traversal and illegal characters', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('..\\..\\evil?.pdf'), 'evil_.pdf');
  assert.equal(sanitizeFilename('...hidden.xlsx'), 'hidden.xlsx');
});

test('validateUploadedFile enforces magic-byte verification and blocks dangerous uploads', () => {
  // Valid PDF
  const pdfOk = validateUploadedFile(Buffer.from('%PDF-1.7\n1 0 obj\n'), 'vendor.pdf', 'application/pdf');
  assert.equal(pdfOk.ok, true);

  // Spoofed HTML disguised as PDF
  const pdfFake = validateUploadedFile(Buffer.from('<html><script>alert(1)</script></html>'), 'bad.pdf', 'application/pdf');
  assert.equal(pdfFake.ok, false);
  if (!pdfFake.ok) assert.equal(pdfFake.status, 415);

  // Blocked SVG / EXE / XLSM
  for (const name of ['payload.svg', 'macro.xlsm', 'run.exe', 'index.html']) {
    const res = validateUploadedFile(Buffer.from('<svg></svg>'), name, 'application/octet-stream');
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.status, 415);
  }

  // Valid PNG, JPEG, WEBP
  const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  assert.equal(validateUploadedFile(pngBuf, 'scan.png', 'image/png').ok, true);

  const jpgBuf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
  assert.equal(validateUploadedFile(jpgBuf, 'photo.jpg', 'image/jpeg').ok, true);

  const webpBuf = Buffer.from('RIFF\x00\x00\x00\x00WEBP', 'ascii');
  assert.equal(validateUploadedFile(webpBuf, 'wa.webp', 'image/webp').ok, true);

  // Valid CSV vs binary disguised as CSV
  assert.equal(validateUploadedFile(Buffer.from('Item,Qty,Rate\nBolt,100,45\n'), 'q.csv', 'text/csv').ok, true);
  assert.equal(validateUploadedFile(Buffer.from([0x00, 0x01, 0x02, 0x03]), 'bin.csv', 'text/csv').ok, false);

  // Empty buffer -> 400
  const empty = validateUploadedFile(Buffer.alloc(0), 'empty.pdf', 'application/pdf');
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.status, 400);
});

test('parseSpreadsheetBuffer extracts cell coordinates from XLSX and CSV', () => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['Item', 'Qty', 'UOM', 'Rate', 'Total'],
    ['Hydraulic Manifold', 60, 'pcs', 2400, 144000],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'QuoteSheet');
  const xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  // Validate magic bytes on generated XLSX
  const valid = validateUploadedFile(xlsxBuf, 'vendor.xlsx', 'application/octet-stream');
  assert.equal(valid.ok, true);

  const parsed = parseSpreadsheetBuffer(xlsxBuf);
  assert.equal(parsed.sheetPreview.length, 1);
  assert.equal(parsed.sheetPreview[0].sheetName, 'QuoteSheet');
  assert.ok(parsed.structuredText.includes('A2: Hydraulic Manifold'));
  assert.ok(parsed.structuredText.includes('D2: 2400'));
});

test('parseAndValidateAiJson handles markdown fences and rejects malformed or incomplete JSON', () => {
  const fenced = '```json\n{"taxIncludedInRates":false,"missingFreightWarning":true,"lines":[]}\n```';
  const ok = parseAndValidateAiJson(fenced);
  assert.equal(ok.missingFreightWarning, true);
  assert.deepEqual(ok.lines, []);

  assert.throws(() => parseAndValidateAiJson(''), ExtractionServiceError);
  assert.throws(() => parseAndValidateAiJson('not-json'), ExtractionServiceError);
  assert.throws(() => parseAndValidateAiJson('{"taxIncludedInRates":false}'), ExtractionServiceError);
});

test('buildQuotationFromExtraction avoids fabricating missing values, demotes duplicate RFQ item matches, and backfills omitted lines', () => {
  const ws = createInitialWorkspaceState();
  const rfq = ws.rfqs[0];

  const quote = buildQuotationFromExtraction({
    rfq,
    supplierId: ws.suppliers[0].id,
    settings: ws.settings,
    documentName: 'test.xlsx',
    documentKind: 'excel',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    parsed: {
      quoteReference: 'VND-100',
      currency: 'INR',
      taxIncludedInRates: false,
      missingFreightWarning: true,
      lines: [
        {
          vendorLineNo: 1,
          rawDescription: 'Manifold Block',
          matchedRfqItemId: rfq.items[0].id,
          matchStatus: 'matched',
          quotedQty: 60,
          quotedUom: 'pcs',
          uomConversionFactor: 1,
          quotedUnitRate: null, // intentionally missing from document
          discountAmount: 0,
          taxRatePct: 18,
          lineTotalQuoted: null,
          confidenceScore: 0.95,
          sheetName: 'Sheet1',
          cellRef: 'A2:E2',
          snippet: 'Manifold Block | 60 pcs | Price TBA',
        },
        {
          vendorLineNo: 2,
          rawDescription: 'Duplicate Manifold Mapping',
          matchedRfqItemId: rfq.items[0].id, // duplicate mapping should be demoted!
          matchStatus: 'matched',
          quotedQty: 60,
          quotedUom: 'pcs',
          uomConversionFactor: 1,
          quotedUnitRate: 2200,
          discountAmount: 0,
          taxRatePct: 18,
          lineTotalQuoted: 132000,
          confidenceScore: 0.9,
          snippet: 'Alt offer',
        },
      ],
    },
  });

  // First line keeps null rate and receives lowered confidence
  assert.equal(quote.lines[0].quotedUnitRate, null);
  assert.ok(quote.lines[0].confidenceScore <= 0.55);

  // Second line demoted to unmapped
  assert.equal(quote.lines[1].rfqItemId, null);
  assert.equal(quote.lines[1].matchStatus, 'unmapped');

  // Remaining 4 RFQ items backfilled as not_quoted
  const notQuotedCount = quote.lines.filter((l) => l.matchStatus === 'not_quoted').length;
  assert.equal(notQuotedCount, rfq.items.length - 1);
  assert.equal(quote.missingFreightWarning, true);
});

test('extractQuotationWithGemini works offline with generateContentOverride and catches math mismatches, 429s, and timeouts', async () => {
  const ws = createInitialWorkspaceState();
  const rfq = ws.rfqs[0];

  const wb = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Item', 'Qty', 'Rate', 'Total'],
    [rfq.items[0].description, 60, 2300, 149000], // Deliberate vendor math mismatch: 60*2300 = 138000 vs printed 149000
  ]);
  XLSX.utils.book_append_sheet(wb, sheet, 'Commercial');
  const xlsxBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  let capturedModel = '';
  const extracted = await extractQuotationWithGemini({
    rfq,
    supplierId: ws.suppliers[0].id,
    settings: ws.settings,
    documentName: 'Commercial_Offer.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    fileBuffer: xlsxBuffer,
    generateContentOverride: async (params) => {
      capturedModel = params.model;
      return {
        text: JSON.stringify({
          quoteReference: 'OFFER-777',
          currency: 'INR',
          leadTimeDays: 9,
          paymentTerms: 'Net 30',
          freightCharges: 2000,
          packingForwarding: 0,
          otherCharges: 0,
          globalDiscount: 0,
          taxIncludedInRates: false,
          missingFreightWarning: false,
          lines: [
            {
              vendorLineNo: 1,
              rawDescription: rfq.items[0].description,
              matchedRfqItemId: rfq.items[0].id,
              matchStatus: 'matched',
              quotedQty: 60,
              quotedUom: 'pcs',
              uomConversionFactor: 1,
              quotedUnitRate: 2300,
              discountAmount: 0,
              taxRatePct: 18,
              lineTotalQuoted: 149000,
              confidenceScore: 0.96,
              sheetName: 'Commercial',
              cellRef: 'A2:D2',
              snippet: 'Row 2 | A2: Manifold | B2: 60 | C2: 2300 | D2: 149000',
            },
          ],
        }),
      };
    },
  });

  assert.equal(capturedModel, 'gemini-4-hydrogen');
  assert.equal(extracted.documentKind, 'excel');
  assert.equal(extracted.sheetPreview?.[0].sheetName, 'Commercial');
  assert.equal(extracted.lines[0].mathValid, false);
  assert.equal(extracted.parseStatus, 'needs_review');

  // 429 error maps cleanly to statusCode 429 without exposing raw API key
  await assert.rejects(
    () =>
      extractQuotationWithGemini({
        rfq,
        supplierId: ws.suppliers[0].id,
        settings: ws.settings,
        documentName: 'wa.txt',
        mimeType: 'text/plain',
        rawEmailText: 'Bolt Rs 40/pc',
        generateContentOverride: async () => {
          throw new Error('429 RESOURCE_EXHAUSTED for AIzaSyDummySecretKey12345678901234');
        },
      }),
    (err: unknown) => {
      assert.ok(err instanceof ExtractionServiceError);
      assert.equal(err.statusCode, 429);
      assert.ok(!err.message.includes('AIzaSy'));
      return true;
    }
  );

  // Timeout maps to 504
  await assert.rejects(
    () =>
      extractQuotationWithGemini({
        rfq,
        supplierId: ws.suppliers[0].id,
        settings: ws.settings,
        documentName: 'wa.txt',
        mimeType: 'text/plain',
        rawEmailText: 'Bolt Rs 40/pc',
        timeoutMs: 25,
        generateContentOverride: () => new Promise(() => undefined),
      }),
    (err: unknown) => {
      assert.ok(err instanceof ExtractionServiceError);
      assert.equal(err.statusCode, 504);
      return true;
    }
  );
});

test(
  'Live Gemini API extraction smoke test (requires GEMINI_API_KEY)',
  { skip: !process.env.GEMINI_API_KEY },
  async () => {
    const ws = createInitialWorkspaceState();
    const rfq = ws.rfqs[0];
    const extracted = await extractQuotationWithGemini({
      rfq,
      supplierId: ws.suppliers[0].id,
      settings: ws.settings,
      documentName: 'WhatsApp_Live_Check.txt',
      mimeType: 'text/plain',
      rawEmailText: `Ref: LIVE-101\n1) ${rfq.items[0].description}: 60 pcs @ INR 2400/pc = 144000 + 18% GST. Freight extra.`,
    });
    assert.ok(extracted.lines.length >= 1);
  }
);
