import test from 'node:test';
import assert from 'node:assert/strict';
import writeXlsxFile, { type SheetData } from 'write-excel-file/node';
import { zipSync, strToU8 } from 'fflate';
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

async function makeXlsxBuffer(
  sheets: Array<{ sheet: string; data: SheetData; dateFormat?: string }>
): Promise<Buffer> {
  return writeXlsxFile(sheets).toBuffer();
}

test('parseSpreadsheetBuffer extracts cell coordinates from XLSX and CSV', async () => {
  const xlsxBuf = await makeXlsxBuffer([
    {
      sheet: 'QuoteSheet',
      data: [
        ['Item', 'Qty', 'UOM', 'Rate', 'Total'],
        ['Hydraulic Manifold', 60, 'pcs', 2400, 144000],
      ],
    },
  ]);

  // Validate magic bytes on generated XLSX
  const valid = validateUploadedFile(xlsxBuf, 'vendor.xlsx', 'application/octet-stream');
  assert.equal(valid.ok, true);

  const parsed = await parseSpreadsheetBuffer(xlsxBuf);
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

  const xlsxBuffer = await makeXlsxBuffer([
    {
      sheet: 'Commercial',
      data: [
        ['Item', 'Qty', 'Rate', 'Total'],
        [rfq.items[0].description, 60, 2300, 149000], // Deliberate vendor math mismatch: 60*2300 = 138000 vs printed 149000
      ],
    },
  ]);

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
  const manySheetsBuf = await makeXlsxBuffer(
    Array.from({ length: 13 }, (_, i) => ({
      sheet: `S${i + 1}`,
      data: [['A', i]],
    }))
  );
  await assert.rejects(
    () => parseSpreadsheetBuffer(manySheetsBuf),
    (err: unknown) => err instanceof ExtractionServiceError && err.statusCode === 422
  );

  // 2. Excessive rows (> 250) -> 422
  const tooManyRowsData: SheetData = Array.from({ length: 260 }, (_, idx) => [
    `Row ${idx + 1}`,
    idx + 1,
  ]);
  const tooManyRowsBuf = await makeXlsxBuffer([{ sheet: 'Sheet1', data: tooManyRowsData }]);
  await assert.rejects(
    () => parseSpreadsheetBuffer(tooManyRowsBuf),
    (err: unknown) => err instanceof ExtractionServiceError && err.statusCode === 422
  );

  // 3. Excessive columns (> 30) -> 422
  const wideRow = Array.from({ length: 32 }, (_, idx) => `C${idx}`);
  const wideBuf = await makeXlsxBuffer([{ sheet: 'Sheet1', data: [wideRow] }]);
  await assert.rejects(
    () => parseSpreadsheetBuffer(wideBuf),
    (err: unknown) => err instanceof ExtractionServiceError && err.statusCode === 422
  );

  // 4. ZIP bomb (100x+ ratio declaring 20 MB uncompressed in 512 bytes) -> 422 pre-parse rejection
  const zipBombBuf = buildSyntheticZip([
    { name: 'xl/worksheets/sheet1.xml', compressedSize: 512, uncompressedSize: 20 * 1024 * 1024 },
  ]);
  await assert.rejects(
    () => parseSpreadsheetBuffer(zipBombBuf, { documentName: 'bomb.xlsx' }),
    (err: unknown) => err instanceof ExtractionServiceError && err.statusCode === 422
  );

  // 5. Embedded VBA macro binary inside OOXML -> 415 rejection
  const macroZipBuf = buildSyntheticZip([
    { name: 'xl/vbaProject.bin', compressedSize: 128, uncompressedSize: 256 },
  ]);
  await assert.rejects(
    () => parseSpreadsheetBuffer(macroZipBuf, { documentName: 'macro.xlsx' }),
    (err: unknown) => err instanceof ExtractionServiceError && err.statusCode === 415
  );

  // 6. Isolated worker parses valid XLSX cleanly without inheriting parent prototype mutation or secrets
  const validBuf = await makeXlsxBuffer([
    {
      sheet: 'Quote',
      data: [
        ['Description', 'Qty', 'Rate'],
        ['Hydraulic Valve', 10, 450],
      ],
    },
  ]);
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
  await assert.rejects(
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
  await assert.rejects(
    () => parseSpreadsheetBuffer(backslashZip, { documentName: 'winpath.xlsx' }),
    (err: unknown) => err instanceof ExtractionServiceError && err.statusCode === 422
  );

  // POSIX path traversal smuggling -> 422
  const posixTraversalZip = buildSyntheticZip([
    {
      name: '../../etc/passwd',
      compressedSize: samplePayload.length,
      uncompressedSize: samplePayload.length,
      content: samplePayload,
    },
  ]);
  await assert.rejects(
    () => parseSpreadsheetBuffer(posixTraversalZip, { documentName: 'traversal.xlsx' }),
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
  await assert.rejects(
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
  await assert.rejects(
    () => parseSpreadsheetBuffer(overlapZip, { documentName: 'overlap.xlsx' }),
    (err: unknown) => err instanceof ExtractionServiceError && err.statusCode === 422
  );

  // Native TSV parsing via tab delimiter detection without touching binary parser
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

test('Task 013: handles multi-sheet, date/boolean/blank/empty workbooks, blocks XXE & malformed XML, and enforces binary OLE2 .xls 415 policy', async () => {
  // 1. Multi-sheet workbook with empty sheet excluded, dates/booleans/blanks/prototype-key sheet names
  const multiBuf = await makeXlsxBuffer([
    {
      sheet: 'Quote',
      dateFormat: 'yyyy-mm-dd',
      data: [
        ['Item', 'Qty', 'Date', 'Confirmed', 'Note'],
        ['Forged Flange', 12, new Date(Date.UTC(2026, 10, 25)), true, null],
      ],
    },
    {
      sheet: 'BlankSheet',
      data: [],
    },
    {
      sheet: 'toString',
      data: [
        ['Term', 'Value'],
        ['Warranty', '12 months'],
      ],
    },
  ]);
  const parsedMulti = await parseSpreadsheetBufferIsolated(multiBuf, { documentName: 'multi.xlsx' });
  assert.equal(parsedMulti.sheetPreview.length, 2);
  assert.equal(parsedMulti.sheetPreview[0].sheetName, 'Quote');
  assert.equal(parsedMulti.sheetPreview[0].rows[1][1], '12');
  assert.equal(parsedMulti.sheetPreview[0].rows[1][2], '2026-11-25');
  assert.equal(parsedMulti.sheetPreview[0].rows[1][3], 'true');
  assert.equal(parsedMulti.sheetPreview[0].rows[1][4], '');
  assert.equal(parsedMulti.sheetPreview[1].sheetName, 'toString');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);

  // 2. All-empty XLSX workbook parses cleanly to empty result
  const emptyWbBuf = await makeXlsxBuffer([{ sheet: 'EmptyOnly', data: [[null, '']] }]);
  const emptyParsed = await parseSpreadsheetBufferIsolated(emptyWbBuf, { documentName: 'empty.xlsx' });
  assert.equal(emptyParsed.structuredText, '');
  assert.deepEqual(emptyParsed.sheetPreview, []);

  // 3. Malformed / non-worksheet XML inside valid OOXML ZIP -> 422
  const malformedXmlZip = Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8(
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'
      ),
      '_rels/.rels': strToU8(
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
      ),
      'xl/workbook.xml': strToU8('<<broken-xml'),
      'xl/_rels/workbook.xml.rels': strToU8(
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
      ),
      'xl/worksheets/sheet1.xml': strToU8('<<broken-xml'),
    })
  );
  await assert.rejects(
    () => parseSpreadsheetBufferIsolated(malformedXmlZip, { documentName: 'broken.xlsx' }),
    (err: unknown) => err instanceof ExtractionServiceError && err.statusCode === 422
  );

  // 4. XXE / external entity declaration inside valid OOXML sheet XML does NOT read local files
  const xxeXmlZip = Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8(
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>'
      ),
      '_rels/.rels': strToU8(
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
      ),
      'xl/workbook.xml': strToU8(
        '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="XXE" sheetId="1" r:id="rId1"/></sheets></workbook>'
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
      ),
      'xl/worksheets/sheet1.xml': strToU8(
        '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&xxe;</t></is></c><c r="B1" t="inlineStr"><is><t>SafeCell</t></is></c></row></sheetData></worksheet>'
      ),
    })
  );
  const xxeRes = await parseSpreadsheetBufferIsolated(xxeXmlZip, { documentName: 'xxe.xlsx' });
  assert.ok(!xxeRes.structuredText.includes('root:x:0:0'));
  assert.ok(xxeRes.structuredText.includes('SafeCell'));

  // 5. Plain UTF-8 text-table .xls remains supported while binary OLE2 .xls returns structured 415
  const textXlsBuf = Buffer.from('Item,Qty,Rate\nSS304 Gasket,50,120\n', 'utf8');
  const parsedTextXls = await parseSpreadsheetBufferIsolated(textXlsBuf, {
    documentName: 'legacy_export.xls',
    mimeType: 'application/vnd.ms-excel',
  });
  assert.equal(parsedTextXls.sheetPreview[0].rows[1][0], 'SS304 Gasket');

  const cleanOle2XlsBuf = Buffer.alloc(1024);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(cleanOle2XlsBuf, 0);
  cleanOle2XlsBuf.writeUInt16LE(0xfffe, 28);
  cleanOle2XlsBuf.writeUInt16LE(9, 30);
  await assert.rejects(
    () =>
      parseSpreadsheetBufferIsolated(cleanOle2XlsBuf, {
        documentName: 'legacy.xls',
        mimeType: 'application/vnd.ms-excel',
      }),
    (err: unknown) =>
      err instanceof ExtractionServiceError &&
      err.statusCode === 415 &&
      err.message.includes('Legacy binary Excel (.xls BIFF5/BIFF8)')
  );

  // 6. OLE2 .xls containing UTF-16LE VBA macro storage marker -> 415 rejection
  const macroXlsBuf = Buffer.alloc(1024);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(macroXlsBuf, 0);
  macroXlsBuf.writeUInt16LE(0xfffe, 28);
  macroXlsBuf.writeUInt16LE(9, 30);
  Buffer.from('_VBA_PROJECT_CUR', 'utf16le').copy(macroXlsBuf, 512);
  await assert.rejects(
    () =>
      parseSpreadsheetBufferIsolated(macroXlsBuf, {
        documentName: 'macro.xls',
        mimeType: 'application/vnd.ms-excel',
      }),
    (err: unknown) => err instanceof ExtractionServiceError && err.statusCode === 415
  );

  // 7. Truncated / malformed OLE2 .xls header -> 422 rejection
  const truncatedOle2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);
  await assert.rejects(
    () =>
      parseSpreadsheetBufferIsolated(truncatedOle2, {
        documentName: 'truncated.xls',
        mimeType: 'application/vnd.ms-excel',
      }),
    (err: unknown) => err instanceof ExtractionServiceError && err.statusCode === 422
  );

  // 8. Isolated worker timeout boundary -> kills child and rejects cleanly with 422
  const validSmallXlsx = await makeXlsxBuffer([
    { sheet: 'TimeoutCheck', data: [['Item', 'Qty'], ['Bolt', 10]] },
  ]);
  await assert.rejects(
    () =>
      parseSpreadsheetBufferIsolated(validSmallXlsx, {
        documentName: 'timeout.xlsx',
        timeoutMs: 1,
      }),
    (err: unknown) => err instanceof ExtractionServiceError && err.statusCode === 422
  );
});
