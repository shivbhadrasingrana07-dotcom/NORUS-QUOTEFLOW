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
  parseSpreadsheetBufferIsolated,
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
  'Live Gemini API extraction smoke test (requires RUN_LIVE_GEMINI_TESTS=true and GEMINI_API_KEY)',
  {
    skip:
      process.env.RUN_LIVE_GEMINI_TESTS !== 'true' ||
      !process.env.GEMINI_API_KEY ||
      process.env.GEMINI_API_KEY === 'MY_GEMINI_API_KEY',
  },
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

function buildSyntheticZip(
  entries: Array<{
    name: string;
    compressedSize: number;
    uncompressedSize: number;
    content?: Buffer;
    flags?: number;
    lfhFlags?: number;
    method?: number;
    lfhMethod?: number;
    lfhCompressedSize?: number;
    lfhUncompressedSize?: number;
    overrideLocalOffset?: number;
  }>
): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const dataBuf = e.content ?? Buffer.alloc(0);
    const localHeader = Buffer.alloc(30 + nameBuf.length + dataBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(e.lfhFlags ?? e.flags ?? 0, 6);
    localHeader.writeUInt16LE(e.lfhMethod ?? e.method ?? 0, 8);
    localHeader.writeUInt32LE(e.lfhCompressedSize ?? e.compressedSize, 18);
    localHeader.writeUInt32LE(e.lfhUncompressedSize ?? e.uncompressedSize, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(localHeader, 30);
    dataBuf.copy(localHeader, 30 + nameBuf.length);
    localChunks.push(localHeader);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.flags ?? 0, 8);
    central.writeUInt16LE(e.method ?? 0, 10);
    central.writeUInt32LE(e.compressedSize, 20);
    central.writeUInt32LE(e.uncompressedSize, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(e.overrideLocalOffset ?? offset, 42);
    nameBuf.copy(central, 46);
    centralChunks.push(central);

    offset += localHeader.length;
  }

  const centralBuf = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localChunks, centralBuf, eocd]);
}

test('Task 009: parses RFC-4180 CSV natively without evaluating formulas or invoking xlsx binary parser', async () => {
  const csv = Buffer.from(
    'Item,Qty,Rate,Note\r\n"Manifold, SS316",60,2400,"=CMD|""calc""!A0"\r\n"=1+1",10,50,"Quoted ""Pack"""\r\n',
    'utf8'
  );
  const parsed = await parseSpreadsheetBufferIsolated(csv, {
    documentName: 'vendor.csv',
    mimeType: 'text/csv',
  });
  assert.equal(parsed.sheetPreview[0].sheetName, 'CSV_Quote');
  assert.equal(parsed.sheetPreview[0].rows[1][0], 'Manifold, SS316');
  assert.equal(parsed.sheetPreview[0].rows[1][3], '=CMD|"calc"!A0');
  assert.equal(parsed.sheetPreview[0].rows[2][0], '=1+1');
  assert.equal(parsed.sheetPreview[0].rows[2][3], 'Quoted "Pack"');
});

test('Task 009: enforces worksheet, row, column limits, ZIP bomb compression ratio, macro rejection, and subprocess isolation', async () => {
  // 1. Excessive worksheets (> 12) -> 422
  const manySheetsWb = XLSX.utils.book_new();
  for (let i = 0; i < 13; i += 1) {
    XLSX.utils.book_append_sheet(manySheetsWb, XLSX.utils.aoa_to_sheet([['A', i]]), `S${i + 1}`);
  }
  const manySheetsBuf = XLSX.write(manySheetsWb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  assert.throws(
    () => parseSpreadsheetBuffer(manySheetsBuf),
    (err: unknown) => err instanceof ExtractionServiceError && err.statusCode === 422
  );

  // 2. Excessive rows (> 250) -> 422
  const tooManyRowsData = Array.from({ length: 260 }, (_, idx) => [`Row ${idx + 1}`, idx + 1]);
  const tooManyRowsWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(tooManyRowsWb, XLSX.utils.aoa_to_sheet(tooManyRowsData), 'Sheet1');
  const tooManyRowsBuf = XLSX.write(tooManyRowsWb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  assert.throws(
    () => parseSpreadsheetBuffer(tooManyRowsBuf),
    (err: unknown) => err instanceof ExtractionServiceError && err.statusCode === 422
  );

  // 3. Excessive columns (> 30) -> 422
  const wideRow = Array.from({ length: 32 }, (_, idx) => `C${idx}`);
  const wideWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wideWb, XLSX.utils.aoa_to_sheet([wideRow]), 'Sheet1');
  const wideBuf = XLSX.write(wideWb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  assert.throws(
    () => parseSpreadsheetBuffer(wideBuf),
    (err: unknown) => err instanceof ExtractionServiceError && err.statusCode === 422
  );

  // 4. ZIP bomb (100x+ ratio declaring 20 MB uncompressed in 512 bytes) -> 422 pre-parse rejection
  const zipBombBuf = buildSyntheticZip([
    { name: 'xl/worksheets/sheet1.xml', compressedSize: 512, uncompressedSize: 20 * 1024 * 1024 },
  ]);
  assert.throws(
    () => parseSpreadsheetBuffer(zipBombBuf, { documentName: 'bomb.xlsx' }),
    (err: unknown) => err instanceof ExtractionServiceError && err.statusCode === 422
  );

  // 5. Embedded VBA macro binary inside OOXML -> 415 rejection
  const macroZipBuf = buildSyntheticZip([
    { name: 'xl/vbaProject.bin', compressedSize: 128, uncompressedSize: 256 },
  ]);
  assert.throws(
    () => parseSpreadsheetBuffer(macroZipBuf, { documentName: 'macro.xlsx' }),
    (err: unknown) => err instanceof ExtractionServiceError && err.statusCode === 415
  );

  // 6. Isolated worker parses valid XLSX cleanly without inheriting parent prototype mutation or secrets
  const validWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    validWb,
    XLSX.utils.aoa_to_sheet([
      ['Description', 'Qty', 'Rate'],
      ['Hydraulic Valve', 10, 450],
    ]),
    'Quote'
  );
  const validBuf = XLSX.write(validWb, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer;
  const isoRes = await parseSpreadsheetBufferIsolated(validBuf, { documentName: 'ok.xlsx' });
  assert.equal(isoRes.sheetPreview[0].sheetName, 'Quote');
  assert.ok(isoRes.structuredText.includes('B2: 10'));

  // 7. Isolated worker rejects malformed/excessive sheets cleanly
  await assert.rejects(
    () => parseSpreadsheetBufferIsolated(zipBombBuf, { documentName: 'bomb.xlsx' }),
    (err: unknown) => err instanceof ExtractionServiceError && err.statusCode === 422
  );
  assert.equal(({} as Record<string, unknown>).pollutedTest, undefined);
});

test('Task 010: hardens ZIP container LFH/CD parity, encrypted entry rejection, backslash traversal, TSV parsing, and oversized delimited fields', async () => {
  const samplePayload = Buffer.from('<xml/>', 'utf8');

  // Encrypted ZIP bit flag -> 422
  const encryptedZip = buildSyntheticZip([
    {
      name: 'xl/worksheets/sheet1.xml',
      compressedSize: samplePayload.length,
      uncompressedSize: samplePayload.length,
      content: samplePayload,
      flags: 0x0001,
    },
  ]);
  assert.throws(
    () => parseSpreadsheetBuffer(encryptedZip, { documentName: 'enc.xlsx' }),
    (err: unknown) => err instanceof ExtractionServiceError && err.statusCode === 422
  );

  // Windows backslash smuggling -> 422
  const backslashZip = buildSyntheticZip([
    {
      name: 'xl\\vbaProject.bin',
      compressedSize: samplePayload.length,
      uncompressedSize: samplePayload.length,
      content: samplePayload,
    },
  ]);
  assert.throws(
    () => parseSpreadsheetBuffer(backslashZip, { documentName: 'winpath.xlsx' }),
    (err: unknown) => err instanceof ExtractionServiceError && err.statusCode === 422
  );

  // Mismatched LFH vs CD sizes -> 422
  const mismatchSizeZip = buildSyntheticZip([
    {
      name: 'xl/worksheets/sheet1.xml',
      compressedSize: samplePayload.length,
      uncompressedSize: samplePayload.length,
      lfhUncompressedSize: 999999,
      content: samplePayload,
    },
  ]);
  assert.throws(
    () => parseSpreadsheetBuffer(mismatchSizeZip, { documentName: 'mismatch.xlsx' }),
    (err: unknown) => err instanceof ExtractionServiceError && err.statusCode === 422
  );

  // Overlapping LFH offsets -> 422
  const overlapZip = buildSyntheticZip([
    {
      name: 'xl/a.xml',
      compressedSize: samplePayload.length,
      uncompressedSize: samplePayload.length,
      content: samplePayload,
    },
    {
      name: 'xl/b.xml',
      compressedSize: samplePayload.length,
      uncompressedSize: samplePayload.length,
      content: samplePayload,
      overrideLocalOffset: 0,
    },
  ]);
  assert.throws(
    () => parseSpreadsheetBuffer(overlapZip, { documentName: 'overlap.xlsx' }),
    (err: unknown) => err instanceof ExtractionServiceError && err.statusCode === 422
  );

  // Native TSV parsing via tab delimiter detection without touching xlsx
  const tsvBuf = Buffer.from('Item\tQty\tRate\nSS316 Valve\t25\t1800\n', 'utf8');
  const parsedTsv = await parseSpreadsheetBufferIsolated(tsvBuf, {
    documentName: 'quote.xls',
    mimeType: 'application/vnd.ms-excel',
  });
  assert.equal(parsedTsv.sheetPreview[0].rows[1][0], 'SS316 Valve');
  assert.equal(parsedTsv.sheetPreview[0].rows[1][1], '25');
  assert.equal(parsedTsv.sheetPreview[0].rows[1][2], '1800');

  // Oversized single delimited cell (> 65536 chars) -> 422
  const hugeCsv = Buffer.from(`Item,Qty\n"${'A'.repeat(70000)}",1\n`, 'utf8');
  await assert.rejects(
    () => parseSpreadsheetBufferIsolated(hugeCsv, { documentName: 'huge.csv', mimeType: 'text/csv' }),
    (err: unknown) => err instanceof ExtractionServiceError && err.statusCode === 422
  );
});
