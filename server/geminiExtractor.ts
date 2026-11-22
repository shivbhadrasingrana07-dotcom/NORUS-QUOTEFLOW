import { GoogleGenAI, Type } from '@google/genai';
import * as XLSX from 'xlsx';
import {
  OrganizationSettings,
  Quotation,
  QuotationLine,
  Rfq,
  SourceTrace,
} from '../src/types.ts';
import { recomputeQuotation } from './normalization.ts';

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not configured. Add it in Settings > Secrets to extract supplier quotations.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function colIndexToLetter(index: number): string {
  let letter = '';
  let n = index;
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

export function parseSpreadsheetBuffer(buffer: Buffer): {
  structuredText: string;
  sheetPreview: { sheetName: string; rows: string[][] }[];
} {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetPreview: { sheetName: string; rows: string[][] }[] = [];
  const textBlocks: string[] = [];

  for (const sheetName of workbook.SheetNames.slice(0, 4)) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(sheet, {
      header: 1,
      defval: '',
    });

    const normalizedRows = rows
      .slice(0, 120)
      .map((row) => row.map((cell) => (cell === null || cell === undefined ? '' : String(cell).trim())));

    const nonEmptyRows = normalizedRows.filter((r) => r.some((c) => c !== ''));
    if (nonEmptyRows.length === 0) continue;

    sheetPreview.push({
      sheetName,
      rows: nonEmptyRows.slice(0, 60),
    });

    const cellLines: string[] = [`=== SHEET: ${sheetName} ===`];
    nonEmptyRows.forEach((row, rIdx) => {
      const cells = row
        .map((val, cIdx) => (val ? `${colIndexToLetter(cIdx)}${rIdx + 1}: ${val}` : null))
        .filter(Boolean);
      if (cells.length > 0) {
        cellLines.push(`Row ${rIdx + 1} | ${cells.join(' | ')}`);
      }
    });
    textBlocks.push(cellLines.join('\n'));
  }

  return {
    structuredText: textBlocks.join('\n\n'),
    sheetPreview,
  };
}

interface GeminiExtractedLine {
  vendorLineNo: number;
  rawDescription: string;
  matchedRfqItemId: string | null;
  matchStatus: 'matched' | 'unmapped' | 'not_quoted' | 'alternate_spec';
  quotedQty: number | null;
  quotedUom: string | null;
  uomConversionFactor: number;
  quotedUnitRate: number | null;
  discountAmount: number;
  taxRatePct: number;
  lineTotalQuoted: number | null;
  confidenceScore: number;
  sourcePage: number | null;
  bboxPct: number[] | null;
  sheetName: string | null;
  cellRef: string | null;
  snippet: string;
}

interface GeminiExtractedQuote {
  quoteReference: string | null;
  quoteDate: string | null;
  validUntil: string | null;
  currency: 'INR' | 'USD' | 'GBP' | 'EUR' | null;
  leadTimeDays: number | null;
  paymentTerms: string | null;
  freightCharges: number | null;
  packingForwarding: number | null;
  otherCharges: number | null;
  globalDiscount: number | null;
  taxIncludedInRates: boolean;
  missingFreightWarning: boolean;
  freightSnippet: string | null;
  paymentSnippet: string | null;
  lines: GeminiExtractedLine[];
}

export interface ExtractQuoteInput {
  rfq: Rfq;
  supplierId: string;
  settings: OrganizationSettings;
  documentName: string;
  mimeType: string;
  fileBuffer?: Buffer;
  rawEmailText?: string;
}

export async function extractQuotationWithGemini(input: ExtractQuoteInput): Promise<Quotation> {
  const ai = getGeminiClient();
  const { rfq, supplierId, settings, documentName, mimeType, fileBuffer, rawEmailText } = input;

  const isSpreadsheet =
    mimeType.includes('spreadsheet') ||
    mimeType.includes('excel') ||
    mimeType.includes('csv') ||
    /\.(xlsx|xls|csv)$/i.test(documentName);

  const isImage = mimeType.startsWith('image/');
  const isPdf = mimeType === 'application/pdf' || /\.pdf$/i.test(documentName);

  let documentKind: Quotation['documentKind'] = 'email';
  if (isSpreadsheet) documentKind = 'excel';
  else if (isImage) documentKind = 'image';
  else if (isPdf) documentKind = 'pdf';

  let sheetPreview: { sheetName: string; rows: string[][] }[] | undefined;
  let spreadsheetText = '';

  if (isSpreadsheet && fileBuffer) {
    const parsed = parseSpreadsheetBuffer(fileBuffer);
    sheetPreview = parsed.sheetPreview;
    spreadsheetText = parsed.structuredText;
    if (!spreadsheetText.trim()) {
      throw new Error('The uploaded spreadsheet contains no readable rows or quotation data.');
    }
  }

  const rfqCatalogSummary = rfq.items
    .map(
      (item) =>
        `- rfqItemId: "${item.id}" | Line ${item.lineNo} | SKU: ${item.skuCode || 'N/A'} | Description: ${item.description} | Qty: ${item.quantity} ${item.uom}`
    )
    .join('\n');

  const promptText = `Extract commercial terms and all line items from the supplier quotation for RFQ ${rfq.rfqNumber} (${rfq.title}).

Target RFQ Line Items to match against:
${rfqCatalogSummary}

Organization UOM Aliases: ${JSON.stringify(settings.uomAliases)}
Default RFQ Currency: ${rfq.currency}
Default Tax Regime: ${settings.taxRegime}

Instructions:
1. Extract ONLY values explicitly present in the quotation. Never invent or calculate missing prices, lead times, or quantities—use null when absent.
2. Map each quoted line item to the closest rfqItemId from the Target RFQ Line Items list above, or null if unmatched.
3. If the supplier quotes in packs/boxes/dozens (e.g., "Box of 10 pcs", "50 Nos/Pack") while the RFQ item UOM is pcs/nos, set uomConversionFactor to the multiplier (e.g., 10 or 50). Otherwise set uomConversionFactor to 1.
4. Set taxIncludedInRates=true ONLY if unit rates explicitly state "incl. GST/VAT/tax".
5. Set missingFreightWarning=true if freight/delivery charges are omitted or stated as "extra at actuals" / "to-pay".
6. For PDFs or Images, provide approximate bboxPct [x0, y0, x1, y1] as 0-100 percentages of page width/height where the line appears, plus a concise verbatim snippet.
7. For Spreadsheets, populate sheetName and cellRef (e.g., "E4:F4") plus snippet.
8. Set lineTotalQuoted to the EXACT total printed on the supplier document for that line (do not fix arithmetic errors—preserve what is printed so our deterministic auditor can flag discrepancies).`;

  const contentsParts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];

  if (isSpreadsheet) {
    contentsParts.push({
      text: `${promptText}\n\nParsed Spreadsheet Content:\n${spreadsheetText}`,
    });
  } else if ((isPdf || isImage) && fileBuffer) {
    contentsParts.push({
      inlineData: {
        mimeType: isPdf ? 'application/pdf' : mimeType,
        data: fileBuffer.toString('base64'),
      },
    });
    contentsParts.push({ text: promptText });
  } else if (rawEmailText) {
    contentsParts.push({
      text: `${promptText}\n\nSupplier Email / WhatsApp Quote Text:\n${rawEmailText}`,
    });
  } else {
    throw new Error('No readable document buffer or quote text provided.');
  }

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: { parts: contentsParts },
    config: {
      systemInstruction:
        'You are a precision B2B procurement quotation extraction engine. You strictly extract verifiable commercial terms and line items from supplier quotations with zero hallucination. Never compute or correct vendor arithmetic errors; extract the printed numbers verbatim.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          quoteReference: { type: Type.STRING, nullable: true },
          quoteDate: { type: Type.STRING, nullable: true },
          validUntil: { type: Type.STRING, nullable: true },
          currency: { type: Type.STRING, nullable: true },
          leadTimeDays: { type: Type.INTEGER, nullable: true },
          paymentTerms: { type: Type.STRING, nullable: true },
          freightCharges: { type: Type.NUMBER, nullable: true },
          packingForwarding: { type: Type.NUMBER, nullable: true },
          otherCharges: { type: Type.NUMBER, nullable: true },
          globalDiscount: { type: Type.NUMBER, nullable: true },
          taxIncludedInRates: { type: Type.BOOLEAN },
          missingFreightWarning: { type: Type.BOOLEAN },
          freightSnippet: { type: Type.STRING, nullable: true },
          paymentSnippet: { type: Type.STRING, nullable: true },
          lines: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                vendorLineNo: { type: Type.INTEGER },
                rawDescription: { type: Type.STRING },
                matchedRfqItemId: { type: Type.STRING, nullable: true },
                matchStatus: { type: Type.STRING },
                quotedQty: { type: Type.NUMBER, nullable: true },
                quotedUom: { type: Type.STRING, nullable: true },
                uomConversionFactor: { type: Type.NUMBER },
                quotedUnitRate: { type: Type.NUMBER, nullable: true },
                discountAmount: { type: Type.NUMBER },
                taxRatePct: { type: Type.NUMBER },
                lineTotalQuoted: { type: Type.NUMBER, nullable: true },
                confidenceScore: { type: Type.NUMBER },
                sourcePage: { type: Type.INTEGER, nullable: true },
                bboxPct: {
                  type: Type.ARRAY,
                  items: { type: Type.NUMBER },
                  nullable: true,
                },
                sheetName: { type: Type.STRING, nullable: true },
                cellRef: { type: Type.STRING, nullable: true },
                snippet: { type: Type.STRING },
              },
              required: [
                'vendorLineNo',
                'rawDescription',
                'matchStatus',
                'uomConversionFactor',
                'discountAmount',
                'taxRatePct',
                'confidenceScore',
                'snippet',
              ],
            },
          },
        },
        required: ['taxIncludedInRates', 'missingFreightWarning', 'lines'],
      },
    },
  });

  const rawJson = (response.text ?? '{}').trim();
  const parsed = JSON.parse(rawJson) as GeminiExtractedQuote;

  const quotationId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const validRfqItemIds = new Set(rfq.items.map((i) => i.id));

  const extractedLines: QuotationLine[] = (parsed.lines || []).map((line, idx) => {
    const safeMatchedId =
      line.matchedRfqItemId && validRfqItemIds.has(line.matchedRfqItemId)
        ? line.matchedRfqItemId
        : null;

    let matchStatus: QuotationLine['matchStatus'] = 'unmapped';
    if (line.matchStatus === 'not_quoted') matchStatus = 'not_quoted';
    else if (line.matchStatus === 'alternate_spec' && safeMatchedId) matchStatus = 'alternate_spec';
    else if (safeMatchedId) matchStatus = 'matched';

    const bbox: [number, number, number, number] | undefined =
      Array.isArray(line.bboxPct) && line.bboxPct.length === 4
        ? [
            Number(line.bboxPct[0]) || 6,
            Number(line.bboxPct[1]) || 35 + idx * 7,
            Number(line.bboxPct[2]) || 94,
            Number(line.bboxPct[3]) || 41 + idx * 7,
          ]
        : undefined;

    const sourceTrace: SourceTrace = {
      sourceType: documentKind,
      page: line.sourcePage ?? 1,
      bbox,
      sheet: line.sheetName ?? undefined,
      cell: line.cellRef ?? undefined,
      snippet: line.snippet || line.rawDescription,
    };

    return {
      id: `${quotationId}-l${idx + 1}`,
      quotationId,
      rfqItemId: safeMatchedId,
      vendorLineNo: line.vendorLineNo || idx + 1,
      rawDescription: line.rawDescription,
      quotedQty: line.quotedQty ?? null,
      quotedUom: line.quotedUom ?? null,
      uomConversionFactor: line.uomConversionFactor > 0 ? line.uomConversionFactor : 1,
      quotedUnitRate: line.quotedUnitRate ?? null,
      discountAmount: line.discountAmount ?? 0,
      taxRatePct: line.taxRatePct ?? (settings.taxRegime === 'INDIA_GST' ? 18 : 0),
      taxCreditable: settings.defaultTaxCreditable,
      allocatedOverhead: 0,
      normalizedUnitBase: null,
      normalizedUnitLanded: null,
      normalizedUnitGross: null,
      lineTotalQuoted: line.lineTotalQuoted ?? null,
      expectedLineTotal: null,
      mathValid: true,
      mathErrorDetail: null,
      matchStatus,
      confidenceScore: Math.max(0.1, Math.min(1, line.confidenceScore ?? 0.85)),
      humanEdited: false,
      verifiedField: false,
      sourceTrace,
    };
  });

  // Ensure any unquoted RFQ item gets an explicit missing/not_quoted entry if not present
  const coveredRfqIds = new Set(
    extractedLines.map((l) => l.rfqItemId).filter((id): id is string => Boolean(id))
  );
  for (const rfqItem of rfq.items) {
    if (!coveredRfqIds.has(rfqItem.id)) {
      extractedLines.push({
        id: `${quotationId}-miss-${rfqItem.lineNo}`,
        quotationId,
        rfqItemId: rfqItem.id,
        vendorLineNo: extractedLines.length + 1,
        rawDescription: `${rfqItem.description} — Not found in vendor quotation`,
        quotedQty: null,
        quotedUom: null,
        uomConversionFactor: 1,
        quotedUnitRate: null,
        discountAmount: 0,
        taxRatePct: 0,
        taxCreditable: settings.defaultTaxCreditable,
        allocatedOverhead: 0,
        normalizedUnitBase: null,
        normalizedUnitLanded: null,
        normalizedUnitGross: null,
        lineTotalQuoted: null,
        expectedLineTotal: null,
        mathValid: true,
        mathErrorDetail: null,
        matchStatus: 'not_quoted',
        confidenceScore: 0.95,
        humanEdited: false,
        verifiedField: false,
        sourceTrace: {
          sourceType: documentKind,
          snippet: 'Item omitted in uploaded supplier document',
        },
      });
    }
  }

  let fileDataUrl: string | undefined;
  if ((isImage || isPdf) && fileBuffer && fileBuffer.byteLength <= 4 * 1024 * 1024) {
    fileDataUrl = `data:${isPdf ? 'application/pdf' : mimeType};base64,${fileBuffer.toString('base64')}`;
  }

  const currencyCode =
    parsed.currency && ['INR', 'USD', 'GBP', 'EUR'].includes(parsed.currency)
      ? parsed.currency
      : rfq.currency;

  const headerTraces: Record<string, SourceTrace> = {};
  if (parsed.freightSnippet) {
    headerTraces.freightCharges = {
      sourceType: documentKind,
      page: 1,
      snippet: parsed.freightSnippet,
    };
  }
  if (parsed.paymentSnippet) {
    headerTraces.paymentTerms = {
      sourceType: documentKind,
      page: 1,
      snippet: parsed.paymentSnippet,
    };
  }

  const rawQuotation: Quotation = {
    id: quotationId,
    rfqId: rfq.id,
    supplierId,
    documentName,
    documentKind,
    mimeType,
    fileDataUrl,
    rawEmailText,
    sheetPreview,
    parseStatus: 'needs_review',
    quoteReference: parsed.quoteReference || `EXT-${Date.now().toString().slice(-5)}`,
    quoteDate: parsed.quoteDate || new Date().toISOString().slice(0, 10),
    validUntil: parsed.validUntil || null,
    currency: currencyCode,
    exchangeRateToRfq: currencyCode === rfq.currency ? 1 : currencyCode === 'USD' ? 84.5 : 1,
    leadTimeDays: parsed.leadTimeDays ?? null,
    paymentTerms: parsed.paymentTerms ?? null,
    freightCharges: parsed.freightCharges ?? 0,
    packingForwarding: parsed.packingForwarding ?? 0,
    otherCharges: parsed.otherCharges ?? 0,
    globalDiscount: parsed.globalDiscount ?? 0,
    taxIncludedInRates: Boolean(parsed.taxIncludedInRates),
    missingFreightWarning: Boolean(parsed.missingFreightWarning),
    subtotalBase: 0,
    totalTax: 0,
    totalLandedCost: 0,
    totalGrossPayable: 0,
    completenessRatio: 0,
    isVerified: false,
    verifiedBy: null,
    verifiedAt: null,
    headerTraces,
    lines: extractedLines,
    createdAt: new Date().toISOString(),
  };

  return recomputeQuotation(rawQuotation, rfq);
}
