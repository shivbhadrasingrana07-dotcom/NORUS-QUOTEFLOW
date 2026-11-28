import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, Type } from '@google/genai';
import {
  AiTokenUsageTelemetry,
  OrganizationSettings,
  Quotation,
  QuotationLine,
  Rfq,
  SourceTrace,
} from '../src/types.ts';
import { recomputeQuotation } from './normalization.ts';
import { isPlaceholderSecret, stripSurroundingQuotes } from './security.ts';
import {
  colIndexToLetter,
  MAX_SPREADSHEET_BYTES,
  parseSpreadsheetHardened,
  SPREADSHEET_WORKER_MAX_OLD_SPACE_MB,
  SPREADSHEET_WORKER_TIMEOUT_MS,
  SpreadsheetSecurityError,
} from './spreadsheetWorker.mjs';

export { colIndexToLetter };

export const GEMINI_EXTRACTION_MODEL = 'gemini-4-hydrogen';

const REFERENCE_USD_RATES: Record<'INR' | 'USD' | 'GBP' | 'EUR', number> = {
  USD: 1,
  INR: 84.5,
  EUR: 0.92,
  GBP: 0.79,
};

export function estimateExchangeRate(
  fromCurrency: 'INR' | 'USD' | 'GBP' | 'EUR',
  toCurrency: 'INR' | 'USD' | 'GBP' | 'EUR'
): number {
  if (fromCurrency === toCurrency) return 1;
  const fromPerUsd = REFERENCE_USD_RATES[fromCurrency];
  const toPerUsd = REFERENCE_USD_RATES[toCurrency];
  return Math.round((toPerUsd / fromPerUsd) * 10000) / 10000;
}

export class ExtractionServiceError extends Error {
  statusCode: number;
  tokenUsage?: AiTokenUsageTelemetry;
  constructor(message: string, statusCode = 500, tokenUsage?: AiTokenUsageTelemetry) {
    super(message);
    this.name = 'ExtractionServiceError';
    this.statusCode = statusCode;
    this.tokenUsage = tokenUsage;
  }
}

export interface GeminiRawUsageMetadata {
  promptTokenCount?: number | null;
  candidatesTokenCount?: number | null;
  totalTokenCount?: number | null;
  thoughtsTokenCount?: number | null;
  cachedContentTokenCount?: number | null;
  toolUsePromptTokenCount?: number | null;
}

function parseOptionalTokenInt(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

export function normalizeGeminiUsageMetadata(
  raw: unknown,
  model: string = GEMINI_EXTRACTION_MODEL
): AiTokenUsageTelemetry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      model,
      usageAvailable: false,
      promptTokenCount: null,
      candidatesTokenCount: null,
      totalTokenCount: null,
      thoughtsTokenCount: null,
    };
  }
  const obj = raw as Record<string, unknown>;
  const promptTokenCount = parseOptionalTokenInt(obj.promptTokenCount);
  const candidatesTokenCount = parseOptionalTokenInt(obj.candidatesTokenCount);
  const totalTokenCount = parseOptionalTokenInt(obj.totalTokenCount);
  const thoughtsTokenCount = parseOptionalTokenInt(obj.thoughtsTokenCount);
  const usageAvailable =
    promptTokenCount !== null || candidatesTokenCount !== null || totalTokenCount !== null;

  return {
    model,
    usageAvailable,
    promptTokenCount: usageAvailable ? promptTokenCount : null,
    candidatesTokenCount: usageAvailable ? candidatesTokenCount : null,
    totalTokenCount: usageAvailable ? totalTokenCount : null,
    thoughtsTokenCount: usageAvailable ? thoughtsTokenCount : null,
  };
}

function sanitizeErrorMessage(raw: string): string {
  const apiKey = process.env.GEMINI_API_KEY;
  let msg = raw || 'Quotation extraction failed.';
  if (apiKey && apiKey.length > 4) {
    msg = msg.split(apiKey).join('[REDACTED]');
  }
  return msg.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]');
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = stripSurroundingQuotes(process.env.GEMINI_API_KEY || '');
  if (!apiKey || isPlaceholderSecret(apiKey)) {
    throw new ExtractionServiceError(
      'GEMINI_API_KEY is not configured. Add a valid key in server configuration to extract supplier quotations.',
      503
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

export interface ParsedSpreadsheetResult {
  structuredText: string;
  sheetPreview: { sheetName: string; rows: string[][] }[];
}

export async function parseSpreadsheetBuffer(
  buffer: Buffer,
  options?: { documentName?: string; mimeType?: string }
): Promise<ParsedSpreadsheetResult> {
  try {
    return await parseSpreadsheetHardened(buffer, options);
  } catch (err) {
    if (err instanceof SpreadsheetSecurityError) {
      throw new ExtractionServiceError(err.message, err.statusCode);
    }
    throw new ExtractionServiceError(
      `Unable to parse spreadsheet file: ${err instanceof Error ? err.message : 'Invalid format'}`,
      422
    );
  }
}

const WORKER_SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'spreadsheetWorker.mjs'
);

export async function parseSpreadsheetBufferIsolated(
  buffer: Buffer,
  options?: { documentName?: string; mimeType?: string; timeoutMs?: number }
): Promise<ParsedSpreadsheetResult> {
  if (!Buffer.isBuffer(buffer) || buffer.byteLength === 0) {
    throw new ExtractionServiceError('Uploaded spreadsheet file is empty.', 400);
  }
  if (buffer.byteLength > MAX_SPREADSHEET_BYTES) {
    throw new ExtractionServiceError(
      `Spreadsheet file exceeds maximum ${Math.round(MAX_SPREADSHEET_BYTES / (1024 * 1024))} MB limit.`,
      413
    );
  }

  const timeoutMs = options?.timeoutMs ?? SPREADSHEET_WORKER_TIMEOUT_MS;

  return new Promise<ParsedSpreadsheetResult>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [`--max-old-space-size=${SPREADSHEET_WORKER_MAX_OLD_SPACE_MB}`, WORKER_SCRIPT_PATH],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        // Strip parent environment secrets so untrusted parser never sees GEMINI_API_KEY, SESSION_SECRET, SQL_PASSWORD, etc.
        env: { NODE_OPTIONS: '' },
      }
    );

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let totalStdoutBytes = 0;

    const finishError = (err: ExtractionServiceError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignore already-exited worker
      }
      finishError(
        new ExtractionServiceError(
          'Spreadsheet parsing timed out inside isolated worker.',
          422
        )
      );
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      totalStdoutBytes += chunk.byteLength;
      if (totalStdoutBytes > 6 * 1024 * 1024) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Ignore
        }
        finishError(
          new ExtractionServiceError('Parsed spreadsheet output exceeded safety cap.', 422)
        );
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrChunks.reduce((n, b) => n + b.byteLength, 0) < 16384) {
        stderrChunks.push(chunk);
      }
    });

    child.on('error', () => {
      finishError(new ExtractionServiceError('Failed to launch isolated spreadsheet parser.', 500));
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (signal === 'SIGKILL' || signal === 'SIGTERM') {
        reject(
          new ExtractionServiceError(
            'Spreadsheet parsing aborted after exceeding sandbox limits.',
            422
          )
        );
        return;
      }

      const rawOut = Buffer.concat(stdoutChunks).toString('utf8').trim();
      if (!rawOut) {
        reject(
          new ExtractionServiceError(
            code === 0
              ? 'Spreadsheet parser returned empty output.'
              : 'Spreadsheet parsing failed inside isolated sandbox.',
            422
          )
        );
        return;
      }

      try {
        const parsed = JSON.parse(rawOut) as
          | { ok: true; result: ParsedSpreadsheetResult }
          | { ok: false; statusCode?: number; message?: string };
        if (
          parsed &&
          typeof parsed === 'object' &&
          parsed.ok === true &&
          parsed.result &&
          typeof parsed.result.structuredText === 'string' &&
          Array.isArray(parsed.result.sheetPreview)
        ) {
          resolve(parsed.result);
        } else if (parsed && typeof parsed === 'object' && parsed.ok === false) {
          reject(
            new ExtractionServiceError(
              typeof parsed.message === 'string' && parsed.message
                ? parsed.message
                : 'Unable to parse spreadsheet file.',
              typeof parsed.statusCode === 'number' ? parsed.statusCode : 422
            )
          );
        } else {
          reject(
            new ExtractionServiceError(
              'Isolated spreadsheet parser returned unexpected payload shape.',
              422
            )
          );
        }
      } catch {
        reject(
          new ExtractionServiceError(
            'Isolated spreadsheet parser returned malformed output.',
            422
          )
        );
      }
    });

    const inputPayload = JSON.stringify({
      base64: buffer.toString('base64'),
      documentName: options?.documentName || '',
      mimeType: options?.mimeType || '',
    });
    child.stdin.on('error', () => {
      // Handled via close/error
    });
    child.stdin.end(inputPayload);
  });
}

export interface GeminiExtractedLine {
  vendorLineNo?: number;
  rawDescription?: string;
  matchedRfqItemId?: string | null;
  matchStatus?: string;
  quotedQty?: number | null;
  quotedUom?: string | null;
  uomConversionFactor?: number;
  quotedUnitRate?: number | null;
  discountAmount?: number;
  taxRatePct?: number;
  lineTotalQuoted?: number | null;
  confidenceScore?: number;
  sourcePage?: number | null;
  bboxPct?: number[] | null;
  sheetName?: string | null;
  cellRef?: string | null;
  snippet?: string;
}

export interface GeminiExtractedQuote {
  quoteReference?: string | null;
  quoteDate?: string | null;
  validUntil?: string | null;
  currency?: string | null;
  leadTimeDays?: number | null;
  paymentTerms?: string | null;
  freightCharges?: number | null;
  packingForwarding?: number | null;
  otherCharges?: number | null;
  globalDiscount?: number | null;
  taxIncludedInRates?: boolean;
  missingFreightWarning?: boolean;
  freightSnippet?: string | null;
  paymentSnippet?: string | null;
  lines?: GeminiExtractedLine[];
}

export function parseAndValidateAiJson(rawText: string | undefined): GeminiExtractedQuote {
  if (!rawText || !rawText.trim()) {
    throw new ExtractionServiceError('AI extraction returned an empty response.', 502);
  }
  let cleaned = rawText.trim();
  // Strip optional markdown code fences if returned
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new ExtractionServiceError('AI extraction returned malformed JSON output.', 502);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ExtractionServiceError('AI extraction response must be a JSON object.', 502);
  }

  const obj = parsed as GeminiExtractedQuote;
  if (!Array.isArray(obj.lines)) {
    throw new ExtractionServiceError('AI extraction response is missing the lines array.', 502);
  }

  return obj;
}

function safeNullableFinite(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function safeNonNegNumber(v: unknown, fallback = 0): number {
  const n = safeNullableFinite(v);
  if (n === null || n < 0) return fallback;
  return n;
}

export function buildQuotationFromExtraction(params: {
  parsed: GeminiExtractedQuote;
  rfq: Rfq;
  supplierId: string;
  settings: OrganizationSettings;
  documentName: string;
  documentKind: Quotation['documentKind'];
  mimeType: string;
  fileDataUrl?: string;
  rawEmailText?: string;
  sheetPreview?: { sheetName: string; rows: string[][] }[];
}): Quotation {
  const {
    parsed,
    rfq,
    supplierId,
    settings,
    documentName,
    documentKind,
    mimeType,
    fileDataUrl,
    rawEmailText,
    sheetPreview,
  } = params;

  const quotationId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const validRfqItemIds = new Set(rfq.items.map((i) => i.id));
  const seenRfqMappings = new Set<string>();

  const extractedLines: QuotationLine[] = (parsed.lines || []).map((line, idx) => {
    const rawDesc = String(line.rawDescription || '').trim() || `Extracted Line ${idx + 1}`;
    const candidateId =
      typeof line.matchedRfqItemId === 'string' && validRfqItemIds.has(line.matchedRfqItemId)
        ? line.matchedRfqItemId
        : null;

    // Prevent silent duplicate mapping to same RFQ item; flag second occurrence as unmapped
    const safeMatchedId =
      candidateId && !seenRfqMappings.has(candidateId) ? candidateId : null;
    if (safeMatchedId) seenRfqMappings.add(safeMatchedId);

    let matchStatus: QuotationLine['matchStatus'] = 'unmapped';
    if (line.matchStatus === 'not_quoted') {
      matchStatus = 'not_quoted';
    } else if (line.matchStatus === 'alternate_spec' && safeMatchedId) {
      matchStatus = 'alternate_spec';
    } else if (safeMatchedId) {
      matchStatus = 'matched';
    }

    const rawQty = safeNullableFinite(line.quotedQty);
    const rawRate = safeNullableFinite(line.quotedUnitRate);
    const rawTotal = safeNullableFinite(line.lineTotalQuoted);
    const rawFactor = safeNullableFinite(line.uomConversionFactor);
    const uomFactor = rawFactor !== null && rawFactor > 0 ? rawFactor : 1;
    const rawTax = safeNullableFinite(line.taxRatePct);
    const taxRatePct =
      rawTax !== null && rawTax >= 0 && rawTax <= 100
        ? rawTax
        : settings.taxRegime === 'INDIA_GST'
        ? 18
        : 0;

    // Zero silent fabrication: if matchStatus is matched/alternate_spec but rate or qty is missing, penalize confidence
    let confidence = safeNullableFinite(line.confidenceScore) ?? 0.85;
    if ((rawRate === null || rawQty === null) && matchStatus !== 'not_quoted') {
      confidence = Math.min(confidence, 0.55);
    }
    if (candidateId && !safeMatchedId) {
      // Duplicate mapping was demoted to unmapped -> force human review
      confidence = Math.min(confidence, 0.65);
    }
    confidence = Math.max(0.05, Math.min(1, confidence));

    const bbox: [number, number, number, number] | undefined =
      Array.isArray(line.bboxPct) && line.bboxPct.length === 4
        ? [
            Math.max(0, Math.min(95, Number(line.bboxPct[0]) || 6)),
            Math.max(0, Math.min(95, Number(line.bboxPct[1]) || 35 + idx * 7)),
            Math.max(5, Math.min(100, Number(line.bboxPct[2]) || 94)),
            Math.max(5, Math.min(100, Number(line.bboxPct[3]) || 41 + idx * 7)),
          ]
        : undefined;

    const snippet = String(line.snippet || '').trim() || rawDesc;
    const sourceTrace: SourceTrace = {
      sourceType: documentKind,
      page: safeNullableFinite(line.sourcePage) ?? 1,
      bbox,
      sheet: line.sheetName ? String(line.sheetName) : undefined,
      cell: line.cellRef ? String(line.cellRef) : undefined,
      snippet,
    };

    return {
      id: `${quotationId}-l${idx + 1}`,
      quotationId,
      rfqItemId: safeMatchedId,
      vendorLineNo: safeNullableFinite(line.vendorLineNo) ?? idx + 1,
      rawDescription: rawDesc,
      quotedQty: matchStatus === 'not_quoted' ? null : rawQty,
      quotedUom: line.quotedUom ? String(line.quotedUom).trim() : null,
      uomConversionFactor: uomFactor,
      quotedUnitRate: matchStatus === 'not_quoted' ? null : rawRate,
      discountAmount: safeNonNegNumber(line.discountAmount, 0),
      taxRatePct,
      taxCreditable: settings.defaultTaxCreditable,
      allocatedOverhead: 0,
      normalizedUnitBase: null,
      normalizedUnitLanded: null,
      normalizedUnitGross: null,
      lineTotalQuoted: matchStatus === 'not_quoted' ? null : rawTotal,
      expectedLineTotal: null,
      mathValid: true,
      mathErrorDetail: null,
      matchStatus,
      confidenceScore: confidence,
      humanEdited: false,
      verifiedField: false,
      sourceTrace,
    };
  });

  // Backfill explicit missing/not_quoted markers for any unquoted RFQ line
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

  const rawCurrency = String(parsed.currency || '').toUpperCase().trim();
  const currencyCode: Quotation['currency'] =
    rawCurrency === 'INR' || rawCurrency === 'USD' || rawCurrency === 'GBP' || rawCurrency === 'EUR'
      ? rawCurrency
      : rfq.currency;

  const headerTraces: Record<string, SourceTrace> = {};
  if (parsed.freightSnippet) {
    headerTraces.freightCharges = {
      sourceType: documentKind,
      page: 1,
      snippet: String(parsed.freightSnippet),
    };
  }
  if (parsed.paymentSnippet) {
    headerTraces.paymentTerms = {
      sourceType: documentKind,
      page: 1,
      snippet: String(parsed.paymentSnippet),
    };
  }

  const leadTimeRaw = safeNullableFinite(parsed.leadTimeDays);
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
    quoteReference:
      parsed.quoteReference && String(parsed.quoteReference).trim()
        ? String(parsed.quoteReference).trim()
        : `EXT-${Date.now().toString().slice(-5)}`,
    quoteDate: parsed.quoteDate || new Date().toISOString().slice(0, 10),
    validUntil: parsed.validUntil || null,
    currency: currencyCode,
    exchangeRateToRfq: estimateExchangeRate(currencyCode, rfq.currency),
    leadTimeDays: leadTimeRaw !== null && leadTimeRaw >= 0 ? Math.round(leadTimeRaw) : null,
    paymentTerms: parsed.paymentTerms ? String(parsed.paymentTerms).trim() : null,
    freightCharges: safeNonNegNumber(parsed.freightCharges, 0),
    packingForwarding: safeNonNegNumber(parsed.packingForwarding, 0),
    otherCharges: safeNonNegNumber(parsed.otherCharges, 0),
    globalDiscount: safeNonNegNumber(parsed.globalDiscount, 0),
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

export interface GenerateContentResponseLike {
  text?: string;
  usageMetadata?: GeminiRawUsageMetadata | Record<string, unknown> | null;
}

export type GenerateContentFn = (params: {
  model: string;
  contents: { parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> };
  config: Record<string, unknown>;
}) => Promise<GenerateContentResponseLike>;

async function callWithTimeoutAndRetry(
  fn: () => Promise<GenerateContentResponseLike>,
  timeoutMs: number,
  maxRetries = 2
): Promise<GenerateContentResponseLike> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        fn(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new ExtractionServiceError('AI extraction timed out.', 504)),
            timeoutMs
          );
        }),
      ]);
      return result;
    } catch (err) {
      lastErr = err;
      if (err instanceof ExtractionServiceError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient =
        msg.includes('429') ||
        msg.includes('RESOURCE_EXHAUSTED') ||
        msg.includes('503') ||
        msg.includes('UNAVAILABLE') ||
        msg.includes('ECONNRESET');

      if (!isTransient || attempt === maxRetries) {
        if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
          throw new ExtractionServiceError(
            'Gemini API rate limit or quota exceeded. Please retry shortly.',
            429
          );
        }
        if (msg.includes('403') || msg.includes('PERMISSION_DENIED') || msg.includes('API_KEY_INVALID')) {
          throw new ExtractionServiceError(
            'Gemini API authentication failed. Verify GEMINI_API_KEY in Settings > Secrets.',
            502
          );
        }
        throw new ExtractionServiceError(sanitizeErrorMessage(msg), 502);
      }
      await new Promise((r) => setTimeout(r, 400 * Math.pow(2, attempt)));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastErr;
}

export interface ExtractQuoteInput {
  rfq: Rfq;
  supplierId: string;
  settings: OrganizationSettings;
  documentName: string;
  mimeType: string;
  fileBuffer?: Buffer;
  rawEmailText?: string;
  preParsedSpreadsheet?: ParsedSpreadsheetResult;
  skipInlineDataUrl?: boolean;
  generateContentOverride?: GenerateContentFn;
  timeoutMs?: number;
}

export interface ExtractQuoteTelemetryResult {
  quotation: Quotation;
  tokenUsage: AiTokenUsageTelemetry;
}

export async function extractQuotationWithTelemetry(
  input: ExtractQuoteInput
): Promise<ExtractQuoteTelemetryResult> {
  const {
    rfq,
    supplierId,
    settings,
    documentName,
    mimeType,
    fileBuffer,
    rawEmailText,
    preParsedSpreadsheet,
    skipInlineDataUrl = false,
    generateContentOverride,
    timeoutMs = 45000,
  } = input;

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

  if (isSpreadsheet && (preParsedSpreadsheet || fileBuffer)) {
    const parsed =
      preParsedSpreadsheet ??
      (await parseSpreadsheetBufferIsolated(fileBuffer!, {
        documentName,
        mimeType,
      }));
    sheetPreview = parsed.sheetPreview;
    spreadsheetText = parsed.structuredText;
    if (!spreadsheetText.trim()) {
      throw new ExtractionServiceError(
        'The uploaded spreadsheet contains no readable rows or quotation data.',
        422
      );
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

  const contentsParts: Array<
    { text: string } | { inlineData: { mimeType: string; data: string } }
  > = [];

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
  } else if (rawEmailText && rawEmailText.trim()) {
    contentsParts.push({
      text: `${promptText}\n\nSupplier Email / WhatsApp Quote Text:\n${rawEmailText.trim()}`,
    });
  } else {
    throw new ExtractionServiceError('No readable document buffer or quote text provided.', 400);
  }

  const invokeModel: GenerateContentFn =
    generateContentOverride ??
    (async (reqParams) => {
      const ai = getGeminiClient();
      return ai.models.generateContent(reqParams);
    });

  const response = await callWithTimeoutAndRetry(
    () =>
      invokeModel({
        model: GEMINI_EXTRACTION_MODEL,
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
      }),
    timeoutMs
  );

  const tokenUsage = normalizeGeminiUsageMetadata(
    response.usageMetadata,
    GEMINI_EXTRACTION_MODEL
  );

  let parsed: GeminiExtractedQuote;
  try {
    parsed = parseAndValidateAiJson(response.text);
  } catch (err) {
    if (err instanceof ExtractionServiceError) {
      err.tokenUsage = tokenUsage;
    }
    throw err;
  }

  let fileDataUrl: string | undefined;
  if (!skipInlineDataUrl && (isImage || isPdf) && fileBuffer && fileBuffer.byteLength <= 4 * 1024 * 1024) {
    fileDataUrl = `data:${isPdf ? 'application/pdf' : mimeType};base64,${fileBuffer.toString('base64')}`;
  }

  const quotation = buildQuotationFromExtraction({
    parsed,
    rfq,
    supplierId,
    settings,
    documentName,
    documentKind,
    mimeType,
    fileDataUrl,
    rawEmailText,
    sheetPreview,
  });

  return {
    quotation,
    tokenUsage,
  };
}

export async function extractQuotationWithGemini(input: ExtractQuoteInput): Promise<Quotation> {
  const { quotation } = await extractQuotationWithTelemetry(input);
  return quotation;
}
