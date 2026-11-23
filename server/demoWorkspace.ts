import crypto from 'node:crypto';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import type {
  AuditLogEntry,
  AwardAllocation,
  AwardDecision,
  AuthUser,
  CatalogItem,
  OrganizationSettings,
  OrganizationSummary,
  Quotation,
  QuotationLine,
  Rfq,
  RfqItem,
  Supplier,
  TaxRegime,
  WorkspaceState,
} from '../src/types.ts';
import {
  buildQuotationFromExtraction,
  parseSpreadsheetBuffer,
} from './geminiExtractor.ts';
import { recomputeQuotation } from './normalization.ts';
import { rankQuotations } from '../src/lib/ranking.ts';

export const DEMO_ORGANIZATION_ID = 'demo-org-synthetic';

export const DEMO_USER: AuthUser = {
  id: 'demo-user-synthetic',
  email: 'demo-buyer@sample-workspace.invalid',
  fullName: 'Demo Buyer (Sample)',
  title: 'Procurement Lead (Demo)',
  emailVerified: true,
  hasPassword: false,
  hasGoogleLinked: false,
};

export const DEMO_ORGANIZATION_SUMMARY: OrganizationSummary = {
  id: DEMO_ORGANIZATION_ID,
  slug: 'meridian-demo-workspace',
  name: 'Meridian Industrial Demo Works (Sample)',
  countryCode: 'IN',
  defaultCurrency: 'INR',
  taxRegime: 'INDIA_GST',
  defaultTaxCreditable: true,
  role: 'owner',
};

export class DemoStoreError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'DemoStoreError';
    this.statusCode = statusCode;
  }
}

export interface DemoStoredDocument {
  id: string;
  demoSessionId: string;
  originalFilename: string;
  mimeType: string;
  buffer: Buffer;
  createdAt: string;
  isSeedSample?: boolean;
}

interface DemoSeedDocTemplate {
  id: string;
  originalFilename: string;
  mimeType: string;
  buffer: Buffer;
  createdAt: string;
}

interface DemoSessionState {
  id: string;
  workspace: WorkspaceState;
  documents: Map<string, DemoStoredDocument>;
  rfqSeq: number;
  lastAccessedAt: number;
}

const DEMO_SAMPLE_SUPPLIER_INFO: Record<
  string,
  { name: string; taxId: string; city: string; email: string }
> = {
  'sup-demo-1': {
    name: 'Northstar Precision CNC (Demo)',
    taxId: '27DEMO0001A1Z1',
    city: 'Pune, MH',
    email: 'demo-quotes@northstar-sample.example',
  },
  'sup-demo-4': {
    name: 'Clearwater Seals & Gauges (Demo)',
    taxId: '33DEMO0004D4Z4',
    city: 'Coimbatore, TN',
    email: 'demo-rfq@clearwater-sample.example',
  },
};

const samplePdfCache = new Map<string, Buffer>();
const sampleXlsxCache = new Map<string, Buffer>();

function buildSampleSupplierPdfBuffer(params: {
  cacheKey: string;
  supplierId: string;
  rfq: Rfq;
  quote: Quotation;
}): Buffer {
  const cached = samplePdfCache.get(params.cacheKey);
  if (cached) return cached;

  const sup = DEMO_SAMPLE_SUPPLIER_INFO[params.supplierId] || {
    name: 'Synthetic Demo Vendor',
    taxId: '27DEMO0000Z1Z1',
    city: 'Pune, MH',
    email: 'demo@sample-vendor.invalid',
  };

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  doc.setFontSize(14);
  doc.setTextColor(15, 23, 42);
  doc.text(sup.name, 14, 18);

  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text(`GSTIN: ${sup.taxId}  |  ${sup.city}  |  ${sup.email}`, 14, 24);
  doc.text('SYNTHETIC DEMO DOCUMENT — NOT A CUSTOMER RECORD', 14, 29);

  doc.setFontSize(11);
  doc.setTextColor(15, 76, 129);
  doc.text(`QUOTATION REF: ${params.quote.quoteReference}`, 14, 38);
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text(
    `Date: ${params.quote.quoteDate}  |  Valid Until: ${params.quote.validUntil || 'N/A'}  |  Currency: ${params.quote.currency}`,
    14,
    44
  );
  doc.text(
    `To: Meridian Industrial Demo Works (Sample)  |  RFQ: ${params.rfq.rfqNumber} (${params.rfq.deliveryLocation})`,
    14,
    49
  );

  autoTable(doc, {
    startY: 55,
    head: [['#', 'Description', 'Quoted Qty', 'UOM', 'Unit Rate', 'GST %', 'Line Total']],
    body: params.quote.lines.map((l) => [
      String(l.vendorLineNo),
      l.rawDescription,
      l.quotedQty !== null ? String(l.quotedQty) : '—',
      l.quotedUom || '—',
      l.quotedUnitRate !== null ? l.quotedUnitRate.toFixed(2) : '—',
      `${l.taxRatePct}%`,
      l.lineTotalQuoted !== null ? l.lineTotalQuoted.toFixed(2) : '—',
    ]),
    styles: { fontSize: 8.5, cellPadding: 2.5 },
    headStyles: { fillColor: [15, 76, 129], textColor: 255 },
  });

  const finalY =
    (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 120;

  doc.setFontSize(9.5);
  doc.setTextColor(15, 23, 42);
  doc.text(
    `Freight & Transit Insurance: ${params.quote.currency} ${params.quote.freightCharges.toFixed(2)}`,
    14,
    finalY + 10
  );
  doc.text(
    `Packing & Crating: ${params.quote.currency} ${params.quote.packingForwarding.toFixed(2)}`,
    14,
    finalY + 16
  );
  doc.text(
    `Lead Time: ${params.quote.leadTimeDays ?? '—'} days  |  Payment Terms: ${params.quote.paymentTerms || '—'}`,
    14,
    finalY + 22
  );
  doc.text(
    `Tax Treatment: ${params.quote.taxIncludedInRates ? 'Included in quoted unit rates' : 'GST Extra as Applicable'}`,
    14,
    finalY + 28
  );

  const buffer = Buffer.from(doc.output('arraybuffer'));
  samplePdfCache.set(params.cacheKey, buffer);
  return buffer;
}

function buildSampleExcelBuffer(
  cacheKey: string,
  sheets: Array<{ sheetName: string; rows: string[][] }>
): Buffer {
  const cached = sampleXlsxCache.get(cacheKey);
  if (cached) return cached;

  const wb = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(sheet.rows);
    XLSX.utils.book_append_sheet(wb, ws, sheet.sheetName);
  }
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  sampleXlsxCache.set(cacheKey, buffer);
  return buffer;
}

function createSyntheticDemoRfqAndQuotes(suffix = ''): {
  rfq: Rfq;
  quotes: Quotation[];
  documents: DemoSeedDocTemplate[];
} {
  const rfqId = suffix ? `demo-rfq-sample-${suffix}` : 'demo-rfq-2026-101';
  const rfqNumber = suffix ? `DEMO-RFQ-2026-${suffix.slice(-3)}` : 'DEMO-RFQ-2026-101';

  const rfq: Rfq = {
    id: rfqId,
    rfqNumber,
    title: 'Sample Batch — SS316L Process Valves & Flange Hardware (Demo)',
    status: 'in_review',
    currency: 'INR',
    incoterms: 'FOR Destination (Demo Plant)',
    deliveryLocation: 'Industrial Estate Phase III (Sample), Pune',
    deadlineDate: '2026-12-05',
    createdBy: DEMO_USER.fullName,
    createdAt: '2026-11-19T09:00:00.000Z',
    updatedAt: '2026-11-21T11:30:00.000Z',
    invitedSupplierIds: ['sup-demo-1', 'sup-demo-2', 'sup-demo-3'],
    items: [
      {
        id: `${rfqId}-item-1`,
        rfqId,
        itemId: 'demo-item-valve',
        lineNo: 1,
        skuCode: 'DEMO-VLV-316',
        description: 'SS316L Flanged Ball Valve DN50 PN40 (Demo)',
        quantity: 30,
        uom: 'pcs',
        targetUnitPrice: 4100,
      },
      {
        id: `${rfqId}-item-2`,
        rfqId,
        itemId: 'demo-item-bolt',
        lineNo: 2,
        skuCode: 'DEMO-BLT-M16',
        description: 'M16 x 60mm Stud Bolt & Heavy Hex Nut ASTM A193 B8 (Demo)',
        quantity: 400,
        uom: 'pcs',
        targetUnitPrice: 52,
      },
      {
        id: `${rfqId}-item-3`,
        rfqId,
        itemId: 'demo-item-gasket',
        lineNo: 3,
        skuCode: 'DEMO-GSK-PTFE',
        description: 'Spiral Wound PTFE Gasket DN50 RF (Demo)',
        quantity: 80,
        uom: 'pcs',
        targetUnitPrice: 118,
      },
      {
        id: `${rfqId}-item-4`,
        rfqId,
        itemId: 'demo-item-gauge',
        lineNo: 4,
        skuCode: 'DEMO-GAU-160',
        description: 'Bourdon Pressure Gauge 0-160 Bar 1/2" BSP Bottom (Demo)',
        quantity: 20,
        uom: 'pcs',
        targetUnitPrice: 840,
      },
    ],
  };

  const q1DocId = `${rfqId}-doc-1`;
  const q1Raw: Quotation = {
    id: `${rfqId}-q1`,
    rfqId,
    supplierId: 'sup-demo-1',
    documentId: q1DocId,
    documentName: 'Northstar_Demo_Quote_NSQ-401.pdf',
    documentKind: 'pdf',
    mimeType: 'application/pdf',
    parseStatus: 'verified',
    quoteReference: 'NSQ/DEMO/401',
    quoteDate: '2026-11-20',
    validUntil: '2026-12-15',
    currency: 'INR',
    exchangeRateToRfq: 1,
    leadTimeDays: 10,
    paymentTerms: 'Net 30 Days from GRN',
    freightCharges: 2800,
    packingForwarding: 950,
    otherCharges: 0,
    globalDiscount: 0,
    taxIncludedInRates: false,
    missingFreightWarning: false,
    subtotalBase: 0,
    totalTax: 0,
    totalLandedCost: 0,
    totalGrossPayable: 0,
    completenessRatio: 1,
    isVerified: true,
    verifiedBy: DEMO_USER.fullName,
    verifiedAt: '2026-11-21T09:15:00.000Z',
    headerTraces: {
      freightCharges: {
        sourceType: 'pdf',
        page: 1,
        bbox: [56, 68, 92, 73],
        snippet: 'Freight & Transit Insurance: Rs. 2,800.00',
      },
      packingForwarding: {
        sourceType: 'pdf',
        page: 1,
        bbox: [56, 73, 92, 78],
        snippet: 'Packing & Crating: Rs. 950.00',
      },
      paymentTerms: {
        sourceType: 'pdf',
        page: 1,
        bbox: [8, 82, 54, 87],
        snippet: 'Terms: Net 30 Days post inspection',
      },
    },
    createdAt: '2026-11-20T10:00:00.000Z',
    lines: [
      {
        id: `${rfqId}-q1-l1`,
        quotationId: `${rfqId}-q1`,
        rfqItemId: rfq.items[0].id,
        vendorLineNo: 1,
        rawDescription: 'SS316L Flanged Ball Valve DN50 PN40',
        quotedQty: 30,
        quotedUom: 'Nos',
        uomConversionFactor: 1,
        quotedUnitRate: 3980,
        discountAmount: 0,
        taxRatePct: 18,
        taxCreditable: true,
        allocatedOverhead: 0,
        normalizedUnitBase: null,
        normalizedUnitLanded: null,
        normalizedUnitGross: null,
        lineTotalQuoted: 119400,
        expectedLineTotal: null,
        mathValid: true,
        mathErrorDetail: null,
        matchStatus: 'matched',
        confidenceScore: 0.98,
        humanEdited: false,
        verifiedField: true,
        sourceTrace: {
          sourceType: 'pdf',
          page: 1,
          bbox: [6, 36, 94, 41],
          snippet: '1 | SS316L Flanged Ball Valve DN50 | 30 Nos | 3,980.00 | 18% | 1,19,400.00',
        },
      },
      {
        id: `${rfqId}-q1-l2`,
        quotationId: `${rfqId}-q1`,
        rfqItemId: rfq.items[1].id,
        vendorLineNo: 2,
        rawDescription: 'M16x60 Stud Bolt & Nut ASTM A193 B8 (Pack of 20)',
        quotedQty: 20,
        quotedUom: 'Pack (20 pcs)',
        uomConversionFactor: 20,
        quotedUnitRate: 980,
        discountAmount: 0,
        taxRatePct: 18,
        taxCreditable: true,
        allocatedOverhead: 0,
        normalizedUnitBase: null,
        normalizedUnitLanded: null,
        normalizedUnitGross: null,
        lineTotalQuoted: 19600,
        expectedLineTotal: null,
        mathValid: true,
        mathErrorDetail: null,
        matchStatus: 'matched',
        confidenceScore: 0.95,
        humanEdited: false,
        verifiedField: true,
        sourceTrace: {
          sourceType: 'pdf',
          page: 1,
          bbox: [6, 42, 94, 47],
          snippet: '2 | M16x60 Stud Bolt & Nut (Pack of 20) | 20 Pack | 980.00 | 18% | 19,600.00',
        },
      },
      {
        id: `${rfqId}-q1-l3`,
        quotationId: `${rfqId}-q1`,
        rfqItemId: rfq.items[2].id,
        vendorLineNo: 3,
        rawDescription: 'Spiral Wound PTFE Gasket DN50 RF',
        quotedQty: 80,
        quotedUom: 'Pcs',
        uomConversionFactor: 1,
        quotedUnitRate: 112,
        discountAmount: 0,
        taxRatePct: 18,
        taxCreditable: true,
        allocatedOverhead: 0,
        normalizedUnitBase: null,
        normalizedUnitLanded: null,
        normalizedUnitGross: null,
        lineTotalQuoted: 8960,
        expectedLineTotal: null,
        mathValid: true,
        mathErrorDetail: null,
        matchStatus: 'matched',
        confidenceScore: 0.97,
        humanEdited: false,
        verifiedField: true,
        sourceTrace: {
          sourceType: 'pdf',
          page: 1,
          bbox: [6, 48, 94, 53],
          snippet: '3 | Spiral Wound PTFE Gasket DN50 | 80 Pcs | 112.00 | 18% | 8,960.00',
        },
      },
      {
        id: `${rfqId}-q1-l4`,
        quotationId: `${rfqId}-q1`,
        rfqItemId: rfq.items[3].id,
        vendorLineNo: 4,
        rawDescription: 'Bourdon Pressure Gauge 0-160 Bar 1/2" BSP',
        quotedQty: 20,
        quotedUom: 'Nos',
        uomConversionFactor: 1,
        quotedUnitRate: 810,
        discountAmount: 0,
        taxRatePct: 18,
        taxCreditable: true,
        allocatedOverhead: 0,
        normalizedUnitBase: null,
        normalizedUnitLanded: null,
        normalizedUnitGross: null,
        lineTotalQuoted: 16200,
        expectedLineTotal: null,
        mathValid: true,
        mathErrorDetail: null,
        matchStatus: 'matched',
        confidenceScore: 0.99,
        humanEdited: false,
        verifiedField: true,
        sourceTrace: {
          sourceType: 'pdf',
          page: 1,
          bbox: [6, 54, 94, 59],
          snippet: '4 | Bourdon Pressure Gauge 0-160 Bar | 20 Nos | 810.00 | 18% | 16,200.00',
        },
      },
    ],
  };

  const q2DocId = `${rfqId}-doc-2`;
  const q2Raw: Quotation = {
    id: `${rfqId}-q2`,
    rfqId,
    supplierId: 'sup-demo-2',
    documentId: q2DocId,
    documentName: 'Vanguard_Demo_Commercial_Offer.xlsx',
    documentKind: 'excel',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    parseStatus: 'needs_review',
    quoteReference: 'VGF/DEMO/26-88',
    quoteDate: '2026-11-20',
    validUntil: '2026-12-10',
    currency: 'INR',
    exchangeRateToRfq: 1,
    leadTimeDays: 8,
    paymentTerms: '30% Advance, 70% Against Dispatch',
    freightCharges: 0,
    packingForwarding: 1200,
    otherCharges: 0,
    globalDiscount: 2000,
    taxIncludedInRates: true,
    missingFreightWarning: false,
    subtotalBase: 0,
    totalTax: 0,
    totalLandedCost: 0,
    totalGrossPayable: 0,
    completenessRatio: 0,
    isVerified: false,
    verifiedBy: null,
    verifiedAt: null,
    headerTraces: {
      packingForwarding: {
        sourceType: 'excel',
        sheet: 'Demo_Offer',
        cell: 'F7',
        snippet: 'Packing & Crating: 1200 (GST Incl.)',
      },
      globalDiscount: {
        sourceType: 'excel',
        sheet: 'Demo_Offer',
        cell: 'F8',
        snippet: 'Sample Volume Rebate: -2000',
      },
      paymentTerms: {
        sourceType: 'excel',
        sheet: 'Demo_Offer',
        cell: 'B9',
        snippet: '30% Advance, 70% Against Dispatch',
      },
    },
    sheetPreview: [
      {
        sheetName: 'Demo_Offer',
        rows: [
          ['Line', 'Vendor Description', 'Qty', 'UOM', 'Rate (GST Incl.)', 'Line Total'],
          ['1', 'Ball Valve DN50 SS316L Flanged', '30', 'Pcs', '4820.00', '144600.00'],
          ['2', 'M16x60 Stud Bolt & Nut B8', '400', 'Pcs', '56.64', '22656.00'],
          ['3', 'PTFE Spiral Wound Gasket DN50', '80', 'Pcs', '115.00', '10400.00'],
          ['4', 'Bourdon Pressure Gauge 0-160 Bar', '0', 'Pcs', 'REGRET / NOT QUOTED', '0.00'],
          ['', 'Packing & Crating Charge', '', '', '', '1200.00'],
          ['', 'Sample Volume Rebate', '', '', '', '-2000.00'],
        ],
      },
    ],
    createdAt: '2026-11-20T12:15:00.000Z',
    lines: [
      {
        id: `${rfqId}-q2-l1`,
        quotationId: `${rfqId}-q2`,
        rfqItemId: rfq.items[0].id,
        vendorLineNo: 1,
        rawDescription: 'Ball Valve DN50 SS316L Flanged',
        quotedQty: 30,
        quotedUom: 'Pcs',
        uomConversionFactor: 1,
        quotedUnitRate: 4820,
        discountAmount: 0,
        taxRatePct: 18,
        taxCreditable: true,
        allocatedOverhead: 0,
        normalizedUnitBase: null,
        normalizedUnitLanded: null,
        normalizedUnitGross: null,
        lineTotalQuoted: 144600,
        expectedLineTotal: null,
        mathValid: true,
        mathErrorDetail: null,
        matchStatus: 'matched',
        confidenceScore: 0.99,
        humanEdited: false,
        verifiedField: true,
        sourceTrace: {
          sourceType: 'excel',
          sheet: 'Demo_Offer',
          cell: 'E2:F2',
          snippet: 'Demo_Offer!E2 = 4820.00 (Incl. 18% GST) | F2 = 144600.00',
        },
      },
      {
        id: `${rfqId}-q2-l2`,
        quotationId: `${rfqId}-q2`,
        rfqItemId: rfq.items[1].id,
        vendorLineNo: 2,
        rawDescription: 'M16x60 Stud Bolt & Nut B8',
        quotedQty: 400,
        quotedUom: 'Pcs',
        uomConversionFactor: 1,
        quotedUnitRate: 56.64,
        discountAmount: 0,
        taxRatePct: 18,
        taxCreditable: true,
        allocatedOverhead: 0,
        normalizedUnitBase: null,
        normalizedUnitLanded: null,
        normalizedUnitGross: null,
        lineTotalQuoted: 22656,
        expectedLineTotal: null,
        mathValid: true,
        mathErrorDetail: null,
        matchStatus: 'matched',
        confidenceScore: 0.99,
        humanEdited: false,
        verifiedField: true,
        sourceTrace: {
          sourceType: 'excel',
          sheet: 'Demo_Offer',
          cell: 'E3:F3',
          snippet: 'Demo_Offer!E3 = 56.64 (Incl. 18% GST) | F3 = 22656.00',
        },
      },
      {
        id: `${rfqId}-q2-l3`,
        quotationId: `${rfqId}-q2`,
        rfqItemId: rfq.items[2].id,
        vendorLineNo: 3,
        rawDescription: 'PTFE Spiral Wound Gasket DN50',
        quotedQty: 80,
        quotedUom: 'Pcs',
        uomConversionFactor: 1,
        quotedUnitRate: 115,
        discountAmount: 0,
        taxRatePct: 18,
        taxCreditable: true,
        allocatedOverhead: 0,
        normalizedUnitBase: null,
        normalizedUnitLanded: null,
        normalizedUnitGross: null,
        // Deliberate mismatch: 80 * 115 = 9200, printed 10400
        lineTotalQuoted: 10400,
        expectedLineTotal: null,
        mathValid: false,
        mathErrorDetail: null,
        matchStatus: 'matched',
        confidenceScore: 0.91,
        humanEdited: false,
        verifiedField: false,
        sourceTrace: {
          sourceType: 'excel',
          sheet: 'Demo_Offer',
          cell: 'E4:F4',
          snippet: 'Demo_Offer!E4 = 115.00 | F4 = 10400.00 (Formula mismatch)',
        },
      },
      {
        id: `${rfqId}-q2-l4`,
        quotationId: `${rfqId}-q2`,
        rfqItemId: rfq.items[3].id,
        vendorLineNo: 4,
        rawDescription: 'Bourdon Pressure Gauge 0-160 Bar — REGRET / NOT QUOTED',
        quotedQty: null,
        quotedUom: null,
        uomConversionFactor: 1,
        quotedUnitRate: null,
        discountAmount: 0,
        taxRatePct: 18,
        taxCreditable: true,
        allocatedOverhead: 0,
        normalizedUnitBase: null,
        normalizedUnitLanded: null,
        normalizedUnitGross: null,
        lineTotalQuoted: null,
        expectedLineTotal: null,
        mathValid: true,
        mathErrorDetail: null,
        matchStatus: 'not_quoted',
        confidenceScore: 0.99,
        humanEdited: false,
        verifiedField: true,
        sourceTrace: {
          sourceType: 'excel',
          sheet: 'Demo_Offer',
          cell: 'E5',
          snippet: 'Demo_Offer!E5 = REGRET / NOT QUOTED',
        },
      },
    ],
  };

  const q3Raw: Quotation = {
    id: `${rfqId}-q3`,
    rfqId,
    supplierId: 'sup-demo-3',
    documentName: 'Crestline_Demo_Email_Quote.txt',
    documentKind: 'email',
    mimeType: 'text/plain',
    rawEmailText: [
      'From: Crestline Fluid Controls (Demo) <demo-sales@crestline-sample.example>',
      'Subject: Demo Quotation CLF/26/219 for Process Valves & Gauges',
      '',
      '1. Ball Valve DN50 PN40 (Offered in CF8M Alternate Grade): 30 Nos @ Rs 4,150/pc = 1,24,500',
      '2. M16x60 Stud Bolt & Nut ASTM A193 B8: 400 Pcs @ Rs 47.00/pc = 18,800',
      '3. Spiral Wound PTFE Gasket DN50: 80 Pcs @ Rs 108.00/pc = 8,640',
      '4. Bourdon Gauge 0-160 Bar 1/2" BSP: 20 Nos @ Rs 780.00/pc = 15,600',
      '',
      'GST: 18% extra. Packing: Rs 750. Freight: Extra at actuals (To-Pay).',
      'Delivery: 14 days. Payment: Net 45 Days.',
    ].join('\n'),
    parseStatus: 'needs_review',
    quoteReference: 'CLF/DEMO/219',
    quoteDate: '2026-11-21',
    validUntil: '2026-12-12',
    currency: 'INR',
    exchangeRateToRfq: 1,
    leadTimeDays: 14,
    paymentTerms: 'Net 45 Days',
    freightCharges: 0,
    packingForwarding: 750,
    otherCharges: 0,
    globalDiscount: 0,
    taxIncludedInRates: false,
    missingFreightWarning: true,
    subtotalBase: 0,
    totalTax: 0,
    totalLandedCost: 0,
    totalGrossPayable: 0,
    completenessRatio: 0,
    isVerified: false,
    verifiedBy: null,
    verifiedAt: null,
    headerTraces: {
      packingForwarding: {
        sourceType: 'email',
        page: 1,
        snippet: 'Packing: Rs 750. Freight: Extra at actuals (To-Pay).',
      },
      paymentTerms: {
        sourceType: 'email',
        page: 1,
        snippet: 'Delivery: 14 days. Payment: Net 45 Days.',
      },
    },
    createdAt: '2026-11-21T08:30:00.000Z',
    lines: [
      {
        id: `${rfqId}-q3-l1`,
        quotationId: `${rfqId}-q3`,
        rfqItemId: rfq.items[0].id,
        vendorLineNo: 1,
        rawDescription: 'Ball Valve DN50 PN40 (CF8M Alternate Grade)',
        quotedQty: 30,
        quotedUom: 'Nos',
        uomConversionFactor: 1,
        quotedUnitRate: 4150,
        discountAmount: 0,
        taxRatePct: 18,
        taxCreditable: true,
        allocatedOverhead: 0,
        normalizedUnitBase: null,
        normalizedUnitLanded: null,
        normalizedUnitGross: null,
        lineTotalQuoted: 124500,
        expectedLineTotal: null,
        mathValid: true,
        mathErrorDetail: null,
        matchStatus: 'alternate_spec',
        confidenceScore: 0.82,
        humanEdited: false,
        verifiedField: false,
        sourceTrace: {
          sourceType: 'email',
          page: 1,
          snippet: '1. Ball Valve DN50 PN40 (Offered in CF8M Alternate Grade): 30 Nos @ Rs 4,150/pc = 1,24,500',
        },
      },
      {
        id: `${rfqId}-q3-l2`,
        quotationId: `${rfqId}-q3`,
        rfqItemId: rfq.items[1].id,
        vendorLineNo: 2,
        rawDescription: 'M16x60 Stud Bolt & Nut ASTM A193 B8',
        quotedQty: 400,
        quotedUom: 'Pcs',
        uomConversionFactor: 1,
        quotedUnitRate: 47,
        discountAmount: 0,
        taxRatePct: 18,
        taxCreditable: true,
        allocatedOverhead: 0,
        normalizedUnitBase: null,
        normalizedUnitLanded: null,
        normalizedUnitGross: null,
        lineTotalQuoted: 18800,
        expectedLineTotal: null,
        mathValid: true,
        mathErrorDetail: null,
        matchStatus: 'matched',
        confidenceScore: 0.94,
        humanEdited: false,
        verifiedField: false,
        sourceTrace: {
          sourceType: 'email',
          page: 1,
          snippet: '2. M16x60 Stud Bolt & Nut ASTM A193 B8: 400 Pcs @ Rs 47.00/pc = 18,800',
        },
      },
      {
        id: `${rfqId}-q3-l3`,
        quotationId: `${rfqId}-q3`,
        rfqItemId: rfq.items[2].id,
        vendorLineNo: 3,
        rawDescription: 'Spiral Wound PTFE Gasket DN50',
        quotedQty: 80,
        quotedUom: 'Pcs',
        uomConversionFactor: 1,
        quotedUnitRate: 108,
        discountAmount: 0,
        taxRatePct: 18,
        taxCreditable: true,
        allocatedOverhead: 0,
        normalizedUnitBase: null,
        normalizedUnitLanded: null,
        normalizedUnitGross: null,
        lineTotalQuoted: 8640,
        expectedLineTotal: null,
        mathValid: true,
        mathErrorDetail: null,
        matchStatus: 'matched',
        confidenceScore: 0.92,
        humanEdited: false,
        verifiedField: false,
        sourceTrace: {
          sourceType: 'email',
          page: 1,
          snippet: '3. Spiral Wound PTFE Gasket DN50: 80 Pcs @ Rs 108.00/pc = 8,640',
        },
      },
      {
        id: `${rfqId}-q3-l4`,
        quotationId: `${rfqId}-q3`,
        rfqItemId: rfq.items[3].id,
        vendorLineNo: 4,
        rawDescription: 'Bourdon Gauge 0-160 Bar 1/2" BSP',
        quotedQty: 20,
        quotedUom: 'Nos',
        uomConversionFactor: 1,
        quotedUnitRate: 780,
        discountAmount: 0,
        taxRatePct: 18,
        taxCreditable: true,
        allocatedOverhead: 0,
        normalizedUnitBase: null,
        normalizedUnitLanded: null,
        normalizedUnitGross: null,
        lineTotalQuoted: 15600,
        expectedLineTotal: null,
        mathValid: true,
        mathErrorDetail: null,
        matchStatus: 'matched',
        confidenceScore: 0.93,
        humanEdited: false,
        verifiedField: false,
        sourceTrace: {
          sourceType: 'email',
          page: 1,
          snippet: '4. Bourdon Gauge 0-160 Bar 1/2" BSP: 20 Nos @ Rs 780.00/pc = 15,600',
        },
      },
    ],
  };

  const q1Norm = recomputeQuotation(q1Raw, rfq);
  const q2Norm = recomputeQuotation(q2Raw, rfq);
  const q3Norm = recomputeQuotation(q3Raw, rfq);

  const q1PdfBuf = buildSampleSupplierPdfBuffer({
    cacheKey: 'northstar-nsq-401',
    supplierId: q1Norm.supplierId,
    rfq,
    quote: q1Norm,
  });
  const q2XlsxBuf = buildSampleExcelBuffer(
    'vanguard-offer-26-88',
    q2Norm.sheetPreview || []
  );

  return {
    rfq,
    quotes: [q1Norm, q2Norm, q3Norm],
    documents: [
      {
        id: q1DocId,
        originalFilename: q1Norm.documentName,
        mimeType: q1Norm.mimeType,
        buffer: q1PdfBuf,
        createdAt: q1Norm.createdAt,
      },
      {
        id: q2DocId,
        originalFilename: q2Norm.documentName,
        mimeType: q2Norm.mimeType,
        buffer: q2XlsxBuf,
        createdAt: q2Norm.createdAt,
      },
    ],
  };
}

function createInitialDemoWorkspaceAndDocs(): {
  workspace: WorkspaceState;
  documents: DemoSeedDocTemplate[];
} {
  const sample = createSyntheticDemoRfqAndQuotes();

  const awardedRfq: Rfq = {
    id: 'demo-rfq-2026-100',
    rfqNumber: 'DEMO-RFQ-2026-100',
    title: 'Sample Q3 — Process Valve & Stud Replenishment (Demo)',
    status: 'awarded',
    currency: 'INR',
    incoterms: 'FOR Destination (Demo Plant)',
    deliveryLocation: 'Industrial Estate Phase III (Sample), Pune',
    deadlineDate: '2026-09-20',
    createdBy: DEMO_USER.fullName,
    createdAt: '2026-09-05T09:00:00.000Z',
    updatedAt: '2026-09-22T15:30:00.000Z',
    invitedSupplierIds: ['sup-demo-1', 'sup-demo-4'],
    items: [
      {
        id: 'demo-rfq-100-item-1',
        rfqId: 'demo-rfq-2026-100',
        itemId: 'demo-item-valve',
        lineNo: 1,
        skuCode: 'DEMO-VLV-316',
        description: 'SS316L Flanged Ball Valve DN50 PN40 (Demo)',
        quantity: 20,
        uom: 'pcs',
        targetUnitPrice: 4050,
      },
      {
        id: 'demo-rfq-100-item-2',
        rfqId: 'demo-rfq-2026-100',
        itemId: 'demo-item-gasket',
        lineNo: 2,
        skuCode: 'DEMO-GSK-PTFE',
        description: 'Spiral Wound PTFE Gasket DN50 RF (Demo)',
        quantity: 60,
        uom: 'pcs',
        targetUnitPrice: 115,
      },
    ],
  };

  const awardedQ1 = recomputeQuotation(
    {
      id: 'demo-rfq-100-q1',
      rfqId: 'demo-rfq-2026-100',
      supplierId: 'sup-demo-1',
      documentId: 'demo-rfq-100-doc-1',
      documentName: 'Northstar_Demo_Q3_380.pdf',
      documentKind: 'pdf',
      mimeType: 'application/pdf',
      parseStatus: 'verified',
      quoteReference: 'NSQ/DEMO/380',
      quoteDate: '2026-09-10',
      validUntil: '2026-10-10',
      currency: 'INR',
      exchangeRateToRfq: 1,
      leadTimeDays: 9,
      paymentTerms: 'Net 30 Days',
      freightCharges: 1800,
      packingForwarding: 600,
      otherCharges: 0,
      globalDiscount: 0,
      taxIncludedInRates: false,
      missingFreightWarning: false,
      subtotalBase: 0,
      totalTax: 0,
      totalLandedCost: 0,
      totalGrossPayable: 0,
      completenessRatio: 1,
      isVerified: true,
      verifiedBy: DEMO_USER.fullName,
      verifiedAt: '2026-09-12T11:00:00.000Z',
      headerTraces: {},
      createdAt: '2026-09-10T10:00:00.000Z',
      lines: [
        {
          id: 'demo-rfq-100-q1-l1',
          quotationId: 'demo-rfq-100-q1',
          rfqItemId: 'demo-rfq-100-item-1',
          vendorLineNo: 1,
          rawDescription: 'SS316L Flanged Ball Valve DN50',
          quotedQty: 20,
          quotedUom: 'Nos',
          uomConversionFactor: 1,
          quotedUnitRate: 3920,
          discountAmount: 0,
          taxRatePct: 18,
          taxCreditable: true,
          allocatedOverhead: 0,
          normalizedUnitBase: null,
          normalizedUnitLanded: null,
          normalizedUnitGross: null,
          lineTotalQuoted: 78400,
          expectedLineTotal: null,
          mathValid: true,
          mathErrorDetail: null,
          matchStatus: 'matched',
          confidenceScore: 0.99,
          humanEdited: false,
          verifiedField: true,
          sourceTrace: {
            sourceType: 'pdf',
            page: 1,
            bbox: [6, 36, 94, 41],
            snippet: 'SS316L Flanged Ball Valve DN50 | 20 Nos @ 3,920.00',
          },
        },
        {
          id: 'demo-rfq-100-q1-l2',
          quotationId: 'demo-rfq-100-q1',
          rfqItemId: 'demo-rfq-100-item-2',
          vendorLineNo: 2,
          rawDescription: 'Spiral Wound PTFE Gasket DN50',
          quotedQty: 60,
          quotedUom: 'Pcs',
          uomConversionFactor: 1,
          quotedUnitRate: 109,
          discountAmount: 0,
          taxRatePct: 18,
          taxCreditable: true,
          allocatedOverhead: 0,
          normalizedUnitBase: null,
          normalizedUnitLanded: null,
          normalizedUnitGross: null,
          lineTotalQuoted: 6540,
          expectedLineTotal: null,
          mathValid: true,
          mathErrorDetail: null,
          matchStatus: 'matched',
          confidenceScore: 0.98,
          humanEdited: false,
          verifiedField: true,
          sourceTrace: {
            sourceType: 'pdf',
            page: 1,
            bbox: [6, 42, 94, 47],
            snippet: 'Spiral Wound PTFE Gasket DN50 | 60 Pcs @ 109.00',
          },
        },
      ],
    },
    awardedRfq
  );

  const awardedQ2 = recomputeQuotation(
    {
      id: 'demo-rfq-100-q2',
      rfqId: 'demo-rfq-2026-100',
      supplierId: 'sup-demo-4',
      documentId: 'demo-rfq-100-doc-2',
      documentName: 'Clearwater_Demo_Q3_109.pdf',
      documentKind: 'pdf',
      mimeType: 'application/pdf',
      parseStatus: 'verified',
      quoteReference: 'CWS/DEMO/109',
      quoteDate: '2026-09-11',
      validUntil: '2026-10-05',
      currency: 'INR',
      exchangeRateToRfq: 1,
      leadTimeDays: 12,
      paymentTerms: 'Net 30 Days',
      freightCharges: 2400,
      packingForwarding: 800,
      otherCharges: 0,
      globalDiscount: 0,
      taxIncludedInRates: false,
      missingFreightWarning: false,
      subtotalBase: 0,
      totalTax: 0,
      totalLandedCost: 0,
      totalGrossPayable: 0,
      completenessRatio: 1,
      isVerified: true,
      verifiedBy: DEMO_USER.fullName,
      verifiedAt: '2026-09-12T11:45:00.000Z',
      headerTraces: {},
      createdAt: '2026-09-11T09:15:00.000Z',
      lines: [
        {
          id: 'demo-rfq-100-q2-l1',
          quotationId: 'demo-rfq-100-q2',
          rfqItemId: 'demo-rfq-100-item-1',
          vendorLineNo: 1,
          rawDescription: 'SS316L Flanged Ball Valve DN50',
          quotedQty: 20,
          quotedUom: 'Nos',
          uomConversionFactor: 1,
          quotedUnitRate: 4180,
          discountAmount: 0,
          taxRatePct: 18,
          taxCreditable: true,
          allocatedOverhead: 0,
          normalizedUnitBase: null,
          normalizedUnitLanded: null,
          normalizedUnitGross: null,
          lineTotalQuoted: 83600,
          expectedLineTotal: null,
          mathValid: true,
          mathErrorDetail: null,
          matchStatus: 'matched',
          confidenceScore: 0.97,
          humanEdited: false,
          verifiedField: true,
          sourceTrace: {
            sourceType: 'pdf',
            page: 1,
            bbox: [6, 36, 94, 41],
            snippet: 'SS316L Flanged Ball Valve DN50 | 20 Nos @ 4,180.00',
          },
        },
        {
          id: 'demo-rfq-100-q2-l2',
          quotationId: 'demo-rfq-100-q2',
          rfqItemId: 'demo-rfq-100-item-2',
          vendorLineNo: 2,
          rawDescription: 'Spiral Wound PTFE Gasket DN50',
          quotedQty: 60,
          quotedUom: 'Pcs',
          uomConversionFactor: 1,
          quotedUnitRate: 118,
          discountAmount: 0,
          taxRatePct: 18,
          taxCreditable: true,
          allocatedOverhead: 0,
          normalizedUnitBase: null,
          normalizedUnitLanded: null,
          normalizedUnitGross: null,
          lineTotalQuoted: 7080,
          expectedLineTotal: null,
          mathValid: true,
          mathErrorDetail: null,
          matchStatus: 'matched',
          confidenceScore: 0.96,
          humanEdited: false,
          verifiedField: true,
          sourceTrace: {
            sourceType: 'pdf',
            page: 1,
            bbox: [6, 42, 94, 47],
            snippet: 'Spiral Wound PTFE Gasket DN50 | 60 Pcs @ 118.00',
          },
        },
      ],
    },
    awardedRfq
  );

  const awardedQ1Buf = buildSampleSupplierPdfBuffer({
    cacheKey: 'northstar-q3-380',
    supplierId: awardedQ1.supplierId,
    rfq: awardedRfq,
    quote: awardedQ1,
  });
  const awardedQ2Buf = buildSampleSupplierPdfBuffer({
    cacheKey: 'clearwater-q3-109',
    supplierId: awardedQ2.supplierId,
    rfq: awardedRfq,
    quote: awardedQ2,
  });

  const workspace: WorkspaceState = {
    settings: {
      id: DEMO_ORGANIZATION_ID,
      slug: DEMO_ORGANIZATION_SUMMARY.slug,
      name: DEMO_ORGANIZATION_SUMMARY.name,
      countryCode: 'IN',
      defaultCurrency: 'INR',
      taxRegime: 'INDIA_GST',
      defaultTaxCreditable: true,
      uomAliases: {
        nos: 'pcs',
        units: 'pcs',
        pc: 'pcs',
        kgs: 'kg',
        mtr: 'm',
        mtrs: 'm',
      },
      activeUserName: DEMO_USER.fullName,
      activeUserTitle: DEMO_USER.title,
      activeUserRole: 'owner',
    },
    suppliers: [
      {
        id: 'sup-demo-1',
        name: 'Northstar Precision CNC (Demo)',
        taxId: '27DEMO0001A1Z1',
        city: 'Pune, MH',
        contactName: 'Aarav Nair',
        email: 'demo-quotes@northstar-sample.example',
        phoneWhatsapp: '+91 90000 10001',
        defaultPaymentTerms: 'Net 30 Days',
        categories: ['Process Valves', 'CNC Machining', 'Hardware'],
        createdAt: '2026-05-10T10:00:00.000Z',
      },
      {
        id: 'sup-demo-2',
        name: 'Vanguard Fasteners & Hardware (Demo)',
        taxId: '24DEMO0002B2Z2',
        city: 'Vadodara, GJ',
        contactName: 'Meera Joshi',
        email: 'demo-bids@vanguard-sample.example',
        phoneWhatsapp: '+91 90000 10002',
        defaultPaymentTerms: '30% Advance',
        categories: ['Stud Bolts', 'SS Fasteners', 'Gaskets'],
        createdAt: '2026-06-14T10:00:00.000Z',
      },
      {
        id: 'sup-demo-3',
        name: 'Crestline Fluid Controls (Demo)',
        taxId: '29DEMO0003C3Z3',
        city: 'Bengaluru, KA',
        contactName: 'Rohan Kulkarni',
        email: 'demo-sales@crestline-sample.example',
        phoneWhatsapp: '+91 90000 10003',
        defaultPaymentTerms: 'Net 45 Days',
        categories: ['Ball Valves', 'Instrumentation', 'Gauges'],
        createdAt: '2026-07-02T10:00:00.000Z',
      },
      {
        id: 'sup-demo-4',
        name: 'Clearwater Seals & Gauges (Demo)',
        taxId: '33DEMO0004D4Z4',
        city: 'Coimbatore, TN',
        contactName: 'Divya Krishnan',
        email: 'demo-rfq@clearwater-sample.example',
        phoneWhatsapp: '+91 90000 10004',
        defaultPaymentTerms: 'Net 30 Days',
        categories: ['PTFE Gaskets', 'Seals', 'Pressure Gauges'],
        createdAt: '2026-08-01T10:00:00.000Z',
      },
    ],
    items: [
      {
        id: 'demo-item-valve',
        skuCode: 'DEMO-VLV-316',
        name: 'SS316L Flanged Ball Valve DN50 PN40 (Demo)',
        normalizedName: 'ss316l flanged ball valve dn50 pn40 demo',
        defaultUom: 'pcs',
        hsnSacCode: '84818030',
        lastAwardedUnitPrice: awardedQ1.lines[0].normalizedUnitLanded ?? 4030.89,
        lastAwardedCurrency: 'INR',
        lastAwardedAt: '2026-09-22T15:30:00.000Z',
        lastSupplierId: 'sup-demo-1',
        priceHistory: [
          {
            rfqId: 'demo-rfq-2026-100',
            rfqNumber: 'DEMO-RFQ-2026-100',
            supplierId: 'sup-demo-1',
            supplierName: 'Northstar Precision CNC (Demo)',
            unitLandedPrice: awardedQ1.lines[0].normalizedUnitLanded ?? 4030.89,
            currency: 'INR',
            awardedAt: '2026-09-22T15:30:00.000Z',
          },
        ],
      },
      {
        id: 'demo-item-bolt',
        skuCode: 'DEMO-BLT-M16',
        name: 'M16 x 60mm Stud Bolt & Heavy Hex Nut ASTM A193 B8 (Demo)',
        normalizedName: 'm16 x 60mm stud bolt heavy hex nut astm a193 b8 demo',
        defaultUom: 'pcs',
        hsnSacCode: '73181500',
        lastAwardedUnitPrice: 50.5,
        lastAwardedCurrency: 'INR',
        lastAwardedAt: '2026-08-18T12:00:00.000Z',
        lastSupplierId: 'sup-demo-2',
        priceHistory: [
          {
            rfqId: 'demo-rfq-2026-092',
            rfqNumber: 'DEMO-RFQ-2026-092',
            supplierId: 'sup-demo-2',
            supplierName: 'Vanguard Fasteners & Hardware (Demo)',
            unitLandedPrice: 50.5,
            currency: 'INR',
            awardedAt: '2026-08-18T12:00:00.000Z',
          },
        ],
      },
      {
        id: 'demo-item-gasket',
        skuCode: 'DEMO-GSK-PTFE',
        name: 'Spiral Wound PTFE Gasket DN50 RF (Demo)',
        normalizedName: 'spiral wound ptfe gasket dn50 rf demo',
        defaultUom: 'pcs',
        hsnSacCode: '84841090',
        lastAwardedUnitPrice: awardedQ1.lines[1].normalizedUnitLanded ?? 112.08,
        lastAwardedCurrency: 'INR',
        lastAwardedAt: '2026-09-22T15:30:00.000Z',
        lastSupplierId: 'sup-demo-1',
        priceHistory: [
          {
            rfqId: 'demo-rfq-2026-100',
            rfqNumber: 'DEMO-RFQ-2026-100',
            supplierId: 'sup-demo-1',
            supplierName: 'Northstar Precision CNC (Demo)',
            unitLandedPrice: awardedQ1.lines[1].normalizedUnitLanded ?? 112.08,
            currency: 'INR',
            awardedAt: '2026-09-22T15:30:00.000Z',
          },
        ],
      },
      {
        id: 'demo-item-gauge',
        skuCode: 'DEMO-GAU-160',
        name: 'Bourdon Pressure Gauge 0-160 Bar 1/2" BSP Bottom (Demo)',
        normalizedName: 'bourdon pressure gauge 0 160 bar 1 2 bsp bottom demo',
        defaultUom: 'pcs',
        hsnSacCode: '90262000',
        lastAwardedUnitPrice: 825.0,
        lastAwardedCurrency: 'INR',
        lastAwardedAt: '2026-07-29T10:00:00.000Z',
        lastSupplierId: 'sup-demo-4',
        priceHistory: [
          {
            rfqId: 'demo-rfq-2026-085',
            rfqNumber: 'DEMO-RFQ-2026-085',
            supplierId: 'sup-demo-4',
            supplierName: 'Clearwater Seals & Gauges (Demo)',
            unitLandedPrice: 825.0,
            currency: 'INR',
            awardedAt: '2026-07-29T10:00:00.000Z',
          },
        ],
      },
    ],
    rfqs: [sample.rfq, awardedRfq],
    quotations: [...sample.quotes, awardedQ1, awardedQ2],
    awards: [
      {
        id: 'demo-award-2026-100',
        rfqId: 'demo-rfq-2026-100',
        isSplitAward: false,
        recommendedBy: DEMO_USER.fullName,
        approvedBy: 'Demo Approver (Sample)',
        approvalStatus: 'approved',
        nonL1Justification: null,
        approverNotes: 'Sample approved L1 package award for DEMO demonstration.',
        totalAwardedLanded: awardedQ1.totalLandedCost,
        allocations: [
          {
            rfqItemId: 'demo-rfq-100-item-1',
            quotationId: awardedQ1.id,
            quotationLineId: awardedQ1.lines[0].id,
            supplierId: 'sup-demo-1',
            awardedQty: 20,
            awardedUnitLanded: awardedQ1.lines[0].normalizedUnitLanded ?? 4030.89,
          },
          {
            rfqItemId: 'demo-rfq-100-item-2',
            quotationId: awardedQ1.id,
            quotationLineId: awardedQ1.lines[1].id,
            supplierId: 'sup-demo-1',
            awardedQty: 60,
            awardedUnitLanded: awardedQ1.lines[1].normalizedUnitLanded ?? 112.08,
          },
        ],
        decidedAt: '2026-09-22T15:30:00.000Z',
        createdAt: '2026-09-22T11:00:00.000Z',
      },
    ],
    auditLogs: [
      {
        id: 'demo-aud-1',
        actorName: DEMO_USER.fullName,
        actorRole: 'owner',
        entityType: 'quotation',
        entityId: sample.quotes[0].id,
        action: 'QUOTATION_VERIFIED',
        detail:
          'Verified Northstar Precision CNC (Demo) quote NSQ/DEMO/401 (Pack of 20 UOM factor = 20x confirmed).',
        createdAt: '2026-11-21T09:15:00.000Z',
      },
      {
        id: 'demo-aud-2',
        actorName: 'Demo Approver (Sample)',
        actorRole: 'approver',
        entityType: 'award',
        entityId: 'demo-award-2026-100',
        action: 'AWARD_APPROVED',
        detail:
          'Approved synthetic L1 award to Northstar Precision CNC (Demo) for DEMO-RFQ-2026-100.',
        createdAt: '2026-09-22T15:30:00.000Z',
      },
    ],
  };

  return {
    workspace,
    documents: [
      ...sample.documents,
      {
        id: 'demo-rfq-100-doc-1',
        originalFilename: awardedQ1.documentName,
        mimeType: awardedQ1.mimeType,
        buffer: awardedQ1Buf,
        createdAt: awardedQ1.createdAt,
      },
      {
        id: 'demo-rfq-100-doc-2',
        originalFilename: awardedQ2.documentName,
        mimeType: awardedQ2.mimeType,
        buffer: awardedQ2Buf,
        createdAt: awardedQ2.createdAt,
      },
    ],
  };
}

export function createInitialDemoWorkspaceState(): WorkspaceState {
  return createInitialDemoWorkspaceAndDocs().workspace;
}

function normalizeNameKey(v: string): string {
  return v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function extractDemoQuotationOffline(params: {
  rfq: Rfq;
  supplierId: string;
  settings: OrganizationSettings;
  documentName: string;
  mimeType: string;
  fileBuffer?: Buffer;
  rawEmailText?: string;
}): Quotation {
  const { rfq, supplierId, settings, documentName, mimeType, fileBuffer, rawEmailText } = params;
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
  if (isSpreadsheet && fileBuffer) {
    try {
      const parsedSheet = parseSpreadsheetBuffer(fileBuffer);
      sheetPreview = parsedSheet.sheetPreview;
    } catch {
      // Fall back gracefully in offline demo mode
    }
  }

  // Deterministic demo fallback extraction based on RFQ items & optional raw text lines
  const lines = rfq.items.map((item, idx) => {
    const rate =
      item.targetUnitPrice && item.targetUnitPrice > 0
        ? Math.round(item.targetUnitPrice * 0.97 * 100) / 100
        : 100;
    const total = Math.round(item.quantity * rate * 100) / 100;
    return {
      vendorLineNo: idx + 1,
      rawDescription: `${item.description} (Demo Parsed)`,
      matchedRfqItemId: item.id,
      matchStatus: 'matched',
      quotedQty: item.quantity,
      quotedUom: item.uom,
      uomConversionFactor: 1,
      quotedUnitRate: rate,
      discountAmount: 0,
      taxRatePct: settings.taxRegime === 'INDIA_GST' ? 18 : 0,
      lineTotalQuoted: total,
      confidenceScore: 0.88,
      sourcePage: 1,
      sheetName: sheetPreview?.[0]?.sheetName,
      cellRef: sheetPreview?.[0] ? `A${idx + 2}:F${idx + 2}` : undefined,
      snippet: `${item.description} — ${item.quantity} ${item.uom} @ ${rate}`,
    };
  });

  return buildQuotationFromExtraction({
    parsed: {
      quoteReference: `DEMO-EXT-${Date.now().toString().slice(-4)}`,
      currency: rfq.currency,
      leadTimeDays: 10,
      paymentTerms: 'Net 30 Days (Demo)',
      freightCharges: 1500,
      packingForwarding: 500,
      otherCharges: 0,
      globalDiscount: 0,
      taxIncludedInRates: false,
      missingFreightWarning: false,
      lines,
    },
    rfq,
    supplierId,
    settings,
    documentName,
    documentKind,
    mimeType,
    rawEmailText,
    sheetPreview,
  });
}

const MAX_UPLOADED_DOCS_PER_SESSION = 25;
const MAX_UPLOADED_BYTES_PER_SESSION = 30 * 1024 * 1024;
const MAX_RFQS_PER_SESSION = 30;

export class DemoWorkspaceStore {
  private readonly sessions = new Map<string, DemoSessionState>();
  private readonly maxSessions: number;

  constructor(maxSessions = 120) {
    this.maxSessions = maxSessions;
  }

  private createFreshSession(id: string): DemoSessionState {
    if (this.sessions.size >= this.maxSessions) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, v] of this.sessions.entries()) {
        if (v.lastAccessedAt < oldestTime) {
          oldestTime = v.lastAccessedAt;
          oldestKey = k;
        }
      }
      if (oldestKey) {
        this.sessions.delete(oldestKey);
      }
    }
    const { workspace, documents } = createInitialDemoWorkspaceAndDocs();
    const docMap = new Map<string, DemoStoredDocument>();
    for (const d of documents) {
      docMap.set(d.id, {
        id: d.id,
        demoSessionId: id,
        originalFilename: d.originalFilename,
        mimeType: d.mimeType,
        buffer: d.buffer,
        createdAt: d.createdAt,
        isSeedSample: true,
      });
    }
    const created: DemoSessionState = {
      id,
      workspace,
      documents: docMap,
      rfqSeq: 102,
      lastAccessedAt: Date.now(),
    };
    this.sessions.set(id, created);
    return created;
  }

  getExistingSession(sessionId: string): DemoSessionState | null {
    const existing = this.sessions.get(sessionId);
    if (!existing) return null;
    existing.lastAccessedAt = Date.now();
    return existing;
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  getOrCreateSession(sessionId: string): DemoSessionState {
    const existing = this.getExistingSession(sessionId);
    if (existing) {
      return existing;
    }
    return this.createFreshSession(sessionId);
  }

  resetSession(sessionId: string): WorkspaceState {
    const fresh = this.createFreshSession(sessionId);
    return structuredClone(fresh.workspace);
  }

  getWorkspace(sessionId: string): WorkspaceState {
    return structuredClone(this.getOrCreateSession(sessionId).workspace);
  }

  private addAudit(
    session: DemoSessionState,
    entry: Omit<AuditLogEntry, 'id' | 'createdAt'>
  ) {
    session.workspace.auditLogs.unshift({
      id: `demo-aud-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
      createdAt: new Date().toISOString(),
      ...entry,
    });
  }

  updateSettings(
    sessionId: string,
    patch: {
      name?: unknown;
      defaultCurrency?: unknown;
      taxRegime?: unknown;
      defaultTaxCreditable?: unknown;
    }
  ): OrganizationSettings {
    const session = this.getOrCreateSession(sessionId);
    const s = session.workspace.settings;
    if (typeof patch.name === 'string' && patch.name.trim()) {
      s.name = patch.name.trim().slice(0, 140);
    }
    if (
      patch.defaultCurrency === 'INR' ||
      patch.defaultCurrency === 'USD' ||
      patch.defaultCurrency === 'GBP' ||
      patch.defaultCurrency === 'EUR'
    ) {
      s.defaultCurrency = patch.defaultCurrency;
    }
    if (
      patch.taxRegime === 'INDIA_GST' ||
      patch.taxRegime === 'UK_VAT' ||
      patch.taxRegime === 'US_TAX' ||
      patch.taxRegime === 'NONE'
    ) {
      s.taxRegime = patch.taxRegime as TaxRegime;
    }
    if (typeof patch.defaultTaxCreditable === 'boolean') {
      s.defaultTaxCreditable = patch.defaultTaxCreditable;
    }
    this.addAudit(session, {
      actorName: DEMO_USER.fullName,
      actorRole: 'owner',
      entityType: 'settings',
      entityId: s.id,
      action: 'DEMO_SETTINGS_UPDATED',
      detail: `Updated demo workspace defaults (${s.defaultCurrency}, ${s.taxRegime}).`,
    });
    return structuredClone(s);
  }

  createRfq(
    sessionId: string,
    input: {
      title?: unknown;
      currency?: unknown;
      incoterms?: unknown;
      deliveryLocation?: unknown;
      deadlineDate?: unknown;
      invitedSupplierIds?: unknown;
      items?: unknown;
    }
  ): Rfq {
    const session = this.getOrCreateSession(sessionId);
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title) {
      throw new DemoStoreError('RFQ title is required.', 400);
    }
    const rawItems = Array.isArray(input.items) ? input.items : [];
    const validItems = rawItems.filter(
      (it): it is Record<string, unknown> =>
        Boolean(it && typeof it === 'object' && typeof (it as Record<string, unknown>).description === 'string' && String((it as Record<string, unknown>).description).trim())
    );
    if (validItems.length === 0) {
      throw new DemoStoreError('At least one RFQ line item with a description is required.', 400);
    }

    const rfqId = `demo-rfq-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
    const rfqNumber = `DEMO-RFQ-2026-${String(session.rfqSeq++).padStart(3, '0')}`;
    const currency: Rfq['currency'] =
      input.currency === 'USD' || input.currency === 'GBP' || input.currency === 'EUR' || input.currency === 'INR'
        ? input.currency
        : session.workspace.settings.defaultCurrency;

    const supplierIds = new Set(session.workspace.suppliers.map((s) => s.id));
    const invitedSupplierIds = Array.isArray(input.invitedSupplierIds)
      ? input.invitedSupplierIds.filter((id): id is string => typeof id === 'string' && supplierIds.has(id))
      : [];

    if (session.workspace.rfqs.length >= MAX_RFQS_PER_SESSION) {
      throw new DemoStoreError(
        `Demo session RFQ limit reached (${MAX_RFQS_PER_SESSION}). Reset demo data to continue.`,
        400
      );
    }

    const now = new Date().toISOString();
    const items: RfqItem[] = validItems.map((raw, idx) => {
      const sku = typeof raw.skuCode === 'string' ? raw.skuCode.trim() : '';
      const desc = String(raw.description).trim();
      const qtyRaw = Number(raw.quantity);
      if (!Number.isFinite(qtyRaw) || qtyRaw <= 0) {
        throw new DemoStoreError(`Item "${desc}" must have quantity > 0.`, 400);
      }
      const quantity = qtyRaw;
      const uom = typeof raw.uom === 'string' && raw.uom.trim() ? raw.uom.trim() : 'pcs';
      const targetRaw =
        raw.targetUnitPrice === null || raw.targetUnitPrice === undefined || raw.targetUnitPrice === ''
          ? null
          : Number(raw.targetUnitPrice);
      if (targetRaw !== null && (!Number.isFinite(targetRaw) || targetRaw < 0)) {
        throw new DemoStoreError('Target unit price cannot be negative.', 400);
      }
      const targetUnitPrice = targetRaw;

      const matchedCatalog = session.workspace.items.find(
        (c) =>
          (sku && c.skuCode.toLowerCase() === sku.toLowerCase()) ||
          c.normalizedName === normalizeNameKey(desc)
      );

      return {
        id: `${rfqId}-item-${idx + 1}`,
        rfqId,
        itemId: matchedCatalog?.id ?? null,
        lineNo: idx + 1,
        skuCode: sku,
        description: desc,
        quantity,
        uom,
        targetUnitPrice,
      };
    });

    const created: Rfq = {
      id: rfqId,
      rfqNumber,
      title,
      status: 'collecting',
      currency,
      incoterms:
        typeof input.incoterms === 'string' && input.incoterms.trim()
          ? input.incoterms.trim()
          : 'FOR Destination',
      deliveryLocation:
        typeof input.deliveryLocation === 'string' && input.deliveryLocation.trim()
          ? input.deliveryLocation.trim()
          : 'Demo Receiving Plant',
      deadlineDate:
        typeof input.deadlineDate === 'string' && input.deadlineDate.trim()
          ? input.deadlineDate.trim()
          : new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
      createdBy: DEMO_USER.fullName,
      createdAt: now,
      updatedAt: now,
      items,
      invitedSupplierIds,
    };

    session.workspace.rfqs.unshift(created);
    this.addAudit(session, {
      actorName: DEMO_USER.fullName,
      actorRole: 'owner',
      entityType: 'rfq',
      entityId: created.id,
      action: 'DEMO_RFQ_CREATED',
      detail: `Created demo RFQ ${created.rfqNumber}: ${created.title} (${items.length} lines).`,
    });

    return structuredClone(created);
  }

  loadSampleRfq(sessionId: string): { rfq: Rfq; quotes: Quotation[] } {
    const session = this.getOrCreateSession(sessionId);
    if (session.workspace.rfqs.length >= MAX_RFQS_PER_SESSION) {
      throw new DemoStoreError(
        `Demo session RFQ limit reached (${MAX_RFQS_PER_SESSION}). Reset demo data to continue.`,
        400
      );
    }
    const suffix = String(session.rfqSeq++);
    const sample = createSyntheticDemoRfqAndQuotes(suffix);
    for (const d of sample.documents) {
      session.documents.set(d.id, {
        id: d.id,
        demoSessionId: session.id,
        originalFilename: d.originalFilename,
        mimeType: d.mimeType,
        buffer: d.buffer,
        createdAt: d.createdAt,
        isSeedSample: true,
      });
    }
    session.workspace.rfqs.unshift(sample.rfq);
    session.workspace.quotations.unshift(...sample.quotes);
    this.addAudit(session, {
      actorName: DEMO_USER.fullName,
      actorRole: 'owner',
      entityType: 'rfq',
      entityId: sample.rfq.id,
      action: 'DEMO_SAMPLE_LOADED',
      detail: `Loaded synthetic sample RFQ ${sample.rfq.rfqNumber} with 3 vendor quotations.`,
    });
    return {
      rfq: structuredClone(sample.rfq),
      quotes: structuredClone(sample.quotes),
    };
  }

  createSupplier(
    sessionId: string,
    input: {
      name?: unknown;
      taxId?: unknown;
      city?: unknown;
      contactName?: unknown;
      email?: unknown;
      phoneWhatsapp?: unknown;
      defaultPaymentTerms?: unknown;
      categories?: unknown;
    }
  ): Supplier {
    const session = this.getOrCreateSession(sessionId);
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) {
      throw new DemoStoreError('Supplier legal company name is required.', 400);
    }
    const taxId = typeof input.taxId === 'string' ? input.taxId.trim().toUpperCase() : '';
    const dup = session.workspace.suppliers.find(
      (s) =>
        s.name.toLowerCase() === name.toLowerCase() ||
        (taxId && s.taxId.toUpperCase() === taxId)
    );
    if (dup) {
      throw new DemoStoreError('A supplier with this name or Tax ID already exists in the demo workspace.', 409);
    }

    const supplier: Supplier = {
      id: `sup-demo-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
      name,
      taxId,
      city: typeof input.city === 'string' ? input.city.trim() : '',
      contactName: typeof input.contactName === 'string' ? input.contactName.trim() : '',
      email: typeof input.email === 'string' ? input.email.trim() : '',
      phoneWhatsapp: typeof input.phoneWhatsapp === 'string' ? input.phoneWhatsapp.trim() : '',
      defaultPaymentTerms:
        typeof input.defaultPaymentTerms === 'string' && input.defaultPaymentTerms.trim()
          ? input.defaultPaymentTerms.trim()
          : 'Net 30 Days',
      categories: Array.isArray(input.categories)
        ? input.categories.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
        : [],
      createdAt: new Date().toISOString(),
    };

    session.workspace.suppliers.push(supplier);
    this.addAudit(session, {
      actorName: DEMO_USER.fullName,
      actorRole: 'owner',
      entityType: 'supplier',
      entityId: supplier.id,
      action: 'DEMO_SUPPLIER_CREATED',
      detail: `Added demo supplier ${supplier.name}.`,
    });

    return structuredClone(supplier);
  }

  getExtractionContext(sessionId: string, rfqId: string, supplierId: string): {
    rfq: Rfq;
    settings: OrganizationSettings;
    supplierName: string;
  } {
    const session = this.getOrCreateSession(sessionId);
    const rfq = session.workspace.rfqs.find((r) => r.id === rfqId);
    if (!rfq) {
      throw new DemoStoreError('Demo RFQ not found.', 404);
    }
    const supplier = session.workspace.suppliers.find((s) => s.id === supplierId);
    if (!supplier) {
      throw new DemoStoreError('Demo supplier not found.', 404);
    }
    return {
      rfq: structuredClone(rfq),
      settings: structuredClone(session.workspace.settings),
      supplierName: supplier.name,
    };
  }

  saveExtractedQuotation(params: {
    sessionId: string;
    rfqId: string;
    supplierName: string;
    quotation: Quotation;
    file?: { buffer: Buffer; originalFilename: string; mimeType: string };
  }): Quotation {
    const session = this.getOrCreateSession(params.sessionId);
    const rfq = session.workspace.rfqs.find((r) => r.id === params.rfqId);
    if (!rfq) {
      throw new DemoStoreError('Demo RFQ not found.', 404);
    }

    let documentId: string | null = null;
    if (params.file) {
      let uploadedCount = 0;
      let uploadedBytes = 0;
      for (const doc of session.documents.values()) {
        if (!doc.isSeedSample) {
          uploadedCount += 1;
          uploadedBytes += doc.buffer.byteLength;
        }
      }
      if (
        uploadedCount >= MAX_UPLOADED_DOCS_PER_SESSION ||
        uploadedBytes + params.file.buffer.byteLength > MAX_UPLOADED_BYTES_PER_SESSION
      ) {
        throw new DemoStoreError(
          'Demo session upload quota reached (max 25 uploaded files or 30 MB). Delete old quotes or reset demo data.',
          413
        );
      }

      documentId = `demo-doc-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
      session.documents.set(documentId, {
        id: documentId,
        demoSessionId: session.id,
        originalFilename: params.file.originalFilename,
        mimeType: params.file.mimeType,
        buffer: params.file.buffer,
        createdAt: new Date().toISOString(),
        isSeedSample: false,
      });
    }

    const toSave: Quotation = {
      ...params.quotation,
      documentId,
      fileDataUrl: undefined,
    };

    session.workspace.quotations.unshift(toSave);
    if (rfq.status === 'draft' || rfq.status === 'collecting') {
      rfq.status = 'in_review';
      rfq.updatedAt = new Date().toISOString();
    }

    this.addAudit(session, {
      actorName: DEMO_USER.fullName,
      actorRole: 'owner',
      entityType: 'quotation',
      entityId: toSave.id,
      action: 'DEMO_QUOTATION_EXTRACTED',
      detail: `Extracted demo quotation ${toSave.quoteReference} from ${params.supplierName} (${toSave.documentName}).`,
    });

    return structuredClone(toSave);
  }

  getDocument(sessionId: string, docId: string): DemoStoredDocument | null {
    const session = this.getExistingSession(sessionId);
    if (!session) return null;
    return session.documents.get(docId) ?? null;
  }

  updateQuotationHeader(
    sessionId: string,
    quoteId: string,
    body: Record<string, unknown>
  ): Quotation {
    const session = this.getOrCreateSession(sessionId);
    const idx = session.workspace.quotations.findIndex((q) => q.id === quoteId);
    if (idx === -1) {
      throw new DemoStoreError('Demo quotation not found.', 404);
    }
    const q = session.workspace.quotations[idx];
    const rfq = session.workspace.rfqs.find((r) => r.id === q.rfqId);
    if (!rfq) {
      throw new DemoStoreError('Parent demo RFQ not found.', 404);
    }

    const updatedRaw: Quotation = { ...q };
    if (body.freightCharges !== undefined) {
      const n = Number(body.freightCharges);
      if (!Number.isFinite(n) || n < 0) throw new DemoStoreError('Invalid freightCharges.', 400);
      updatedRaw.freightCharges = n;
    }
    if (body.packingForwarding !== undefined) {
      const n = Number(body.packingForwarding);
      if (!Number.isFinite(n) || n < 0) throw new DemoStoreError('Invalid packingForwarding.', 400);
      updatedRaw.packingForwarding = n;
    }
    if (body.otherCharges !== undefined) {
      const n = Number(body.otherCharges);
      if (!Number.isFinite(n) || n < 0) throw new DemoStoreError('Invalid otherCharges.', 400);
      updatedRaw.otherCharges = n;
    }
    if (body.globalDiscount !== undefined) {
      const n = Number(body.globalDiscount);
      if (!Number.isFinite(n) || n < 0) throw new DemoStoreError('Invalid globalDiscount.', 400);
      updatedRaw.globalDiscount = n;
    }
    if (body.exchangeRateToRfq !== undefined) {
      const n = Number(body.exchangeRateToRfq);
      if (!Number.isFinite(n) || n <= 0) throw new DemoStoreError('Invalid exchangeRateToRfq.', 400);
      updatedRaw.exchangeRateToRfq = n;
    }
    if (body.leadTimeDays !== undefined) {
      if (body.leadTimeDays === null || body.leadTimeDays === '') {
        updatedRaw.leadTimeDays = null;
      } else {
        const n = Number(body.leadTimeDays);
        if (!Number.isFinite(n) || n < 0) throw new DemoStoreError('Invalid leadTimeDays.', 400);
        updatedRaw.leadTimeDays = Math.round(n);
      }
    }
    if (typeof body.paymentTerms === 'string') {
      updatedRaw.paymentTerms = body.paymentTerms.trim() || null;
    }
    if (typeof body.taxIncludedInRates === 'boolean') {
      updatedRaw.taxIncludedInRates = body.taxIncludedInRates;
    }
    if (typeof body.missingFreightWarning === 'boolean') {
      updatedRaw.missingFreightWarning = body.missingFreightWarning;
    }

    const recomputed = recomputeQuotation(updatedRaw, rfq);
    session.workspace.quotations[idx] = recomputed;
    this.addAudit(session, {
      actorName: DEMO_USER.fullName,
      actorRole: 'owner',
      entityType: 'quotation',
      entityId: recomputed.id,
      action: 'DEMO_QUOTATION_HEADER_UPDATED',
      detail: `Updated demo commercial header on ${recomputed.quoteReference}.`,
    });
    return structuredClone(recomputed);
  }

  updateQuotationLine(
    sessionId: string,
    quoteId: string,
    lineId: string,
    body: Record<string, unknown>
  ): Quotation {
    const session = this.getOrCreateSession(sessionId);
    const qIdx = session.workspace.quotations.findIndex((q) => q.id === quoteId);
    if (qIdx === -1) throw new DemoStoreError('Demo quotation not found.', 404);
    const q = session.workspace.quotations[qIdx];
    const rfq = session.workspace.rfqs.find((r) => r.id === q.rfqId);
    if (!rfq) throw new DemoStoreError('Parent demo RFQ not found.', 404);

    const lineIdx = q.lines.findIndex((l) => l.id === lineId);
    if (lineIdx === -1) throw new DemoStoreError('Demo quotation line not found.', 404);

    const nextLines = q.lines.map((l, idx) => {
      if (idx !== lineIdx) return l;
      const next: QuotationLine = { ...l, humanEdited: true };
      if (body.quotedQty !== undefined) {
        if (body.quotedQty === null || body.quotedQty === '') {
          next.quotedQty = null;
        } else {
          const n = Number(body.quotedQty);
          if (!Number.isFinite(n) || n <= 0) {
            throw new DemoStoreError('Quoted quantity must be greater than 0.', 400);
          }
          next.quotedQty = n;
        }
      }
      if (body.quotedUnitRate !== undefined) {
        if (body.quotedUnitRate === null || body.quotedUnitRate === '') {
          next.quotedUnitRate = null;
        } else {
          const n = Number(body.quotedUnitRate);
          if (!Number.isFinite(n) || n < 0) {
            throw new DemoStoreError('Unit rate cannot be negative.', 400);
          }
          next.quotedUnitRate = n;
        }
      }
      if (body.uomConversionFactor !== undefined) {
        const n = Number(body.uomConversionFactor);
        if (!Number.isFinite(n) || n <= 0) throw new DemoStoreError('UOM factor must be > 0.', 400);
        next.uomConversionFactor = n;
      }
      if (body.taxRatePct !== undefined) {
        const n = Number(body.taxRatePct);
        if (!Number.isFinite(n) || n < 0 || n > 100) throw new DemoStoreError('Tax % must be 0-100.', 400);
        next.taxRatePct = n;
      }
      if (body.lineTotalQuoted !== undefined) {
        if (body.lineTotalQuoted === null || body.lineTotalQuoted === '') {
          next.lineTotalQuoted = null;
        } else {
          const n = Number(body.lineTotalQuoted);
          if (!Number.isFinite(n) || n < 0) {
            throw new DemoStoreError('Line total cannot be negative.', 400);
          }
          next.lineTotalQuoted = n;
        }
      }
      if (typeof body.taxCreditable === 'boolean') {
        next.taxCreditable = body.taxCreditable;
      }
      if (body.rfqItemId !== undefined) {
        next.rfqItemId =
          typeof body.rfqItemId === 'string' && rfq.items.some((it) => it.id === body.rfqItemId)
            ? body.rfqItemId
            : null;
      }
      if (
        body.matchStatus === 'matched' ||
        body.matchStatus === 'unmapped' ||
        body.matchStatus === 'not_quoted' ||
        body.matchStatus === 'alternate_spec'
      ) {
        next.matchStatus = body.matchStatus;
      }
      return next;
    });

    const recomputed = recomputeQuotation(
      { ...q, isVerified: false, verifiedBy: null, verifiedAt: null, lines: nextLines },
      rfq
    );
    session.workspace.quotations[qIdx] = recomputed;
    this.addAudit(session, {
      actorName: DEMO_USER.fullName,
      actorRole: 'owner',
      entityType: 'quotation_line',
      entityId: lineId,
      action: 'DEMO_QUOTATION_LINE_EDITED',
      detail: `Edited demo line ${lineId} on quotation ${recomputed.quoteReference}.`,
    });
    return structuredClone(recomputed);
  }

  verifyQuotation(sessionId: string, quoteId: string): Quotation {
    const session = this.getOrCreateSession(sessionId);
    const qIdx = session.workspace.quotations.findIndex((q) => q.id === quoteId);
    if (qIdx === -1) throw new DemoStoreError('Demo quotation not found.', 404);
    const q = session.workspace.quotations[qIdx];
    const rfq = session.workspace.rfqs.find((r) => r.id === q.rfqId);
    if (!rfq) throw new DemoStoreError('Parent demo RFQ not found.', 404);

    const recomputed = recomputeQuotation(q, rfq);
    if (recomputed.lines.some((l) => !l.mathValid)) {
      throw new DemoStoreError(
        'Cannot verify quotation while arithmetic discrepancies remain on one or more lines.',
        422
      );
    }

    const verified: Quotation = {
      ...recomputed,
      isVerified: true,
      parseStatus: 'verified',
      verifiedBy: DEMO_USER.fullName,
      verifiedAt: new Date().toISOString(),
      lines: recomputed.lines.map((l) => ({ ...l, verifiedField: true })),
    };
    session.workspace.quotations[qIdx] = verified;
    this.addAudit(session, {
      actorName: DEMO_USER.fullName,
      actorRole: 'owner',
      entityType: 'quotation',
      entityId: verified.id,
      action: 'DEMO_QUOTATION_VERIFIED',
      detail: `Verified demo quotation ${verified.quoteReference}.`,
    });
    return structuredClone(verified);
  }

  deleteQuotation(sessionId: string, quoteId: string): void {
    const session = this.getOrCreateSession(sessionId);
    const qIdx = session.workspace.quotations.findIndex((q) => q.id === quoteId);
    if (qIdx === -1) throw new DemoStoreError('Demo quotation not found.', 404);
    const q = session.workspace.quotations[qIdx];

    const blocksApproved = session.workspace.awards.some(
      (a) =>
        a.approvalStatus === 'approved' &&
        a.allocations.some((al) => al.quotationId === quoteId)
    );
    if (blocksApproved) {
      throw new DemoStoreError(
        'Cannot delete a quotation referenced by an approved award.',
        409
      );
    }

    session.workspace.quotations.splice(qIdx, 1);
    if (q.documentId) {
      session.documents.delete(q.documentId);
    }
    this.addAudit(session, {
      actorName: DEMO_USER.fullName,
      actorRole: 'owner',
      entityType: 'quotation',
      entityId: quoteId,
      action: 'DEMO_QUOTATION_DELETED',
      detail: `Deleted demo quotation ${q.quoteReference}.`,
    });
  }

  submitAward(
    sessionId: string,
    params: {
      rfqId: string;
      isSplitAward: boolean;
      nonL1Justification?: unknown;
      allocations?: unknown;
    }
  ): AwardDecision {
    const session = this.getOrCreateSession(sessionId);
    const rfq = session.workspace.rfqs.find((r) => r.id === params.rfqId);
    if (!rfq) throw new DemoStoreError('Demo RFQ not found.', 404);

    const existingApproved = session.workspace.awards.find(
      (a) => a.rfqId === rfq.id && a.approvalStatus === 'approved'
    );
    if (existingApproved) {
      throw new DemoStoreError('This demo RFQ already has an approved award.', 409);
    }

    const rawAllocs = Array.isArray(params.allocations) ? params.allocations : [];
    if (rawAllocs.length === 0) {
      throw new DemoStoreError('At least one award line allocation is required.', 400);
    }

    const rfqQuotes = session.workspace.quotations.filter((q) => q.rfqId === rfq.id);
    const validatedAllocs: AwardAllocation[] = [];
    let totalAwardedLanded = 0;

    for (const raw of rawAllocs) {
      if (!raw || typeof raw !== 'object') throw new DemoStoreError('Invalid allocation.', 400);
      const r = raw as Record<string, unknown>;
      const rfqItemId = String(r.rfqItemId || '');
      const quotationId = String(r.quotationId || '');
      const quotationLineId = String(r.quotationLineId || '');
      const rfqItem = rfq.items.find((it) => it.id === rfqItemId);
      const quote = rfqQuotes.find((q) => q.id === quotationId);
      const line = quote?.lines.find((l) => l.id === quotationLineId);
      if (!rfqItem || !quote || !line || line.normalizedUnitLanded === null) {
        throw new DemoStoreError('Allocation references invalid demo RFQ item or unpriced quote line.', 400);
      }
      const qty = Number(r.awardedQty ?? rfqItem.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new DemoStoreError('Awarded quantity must be > 0.', 400);
      }
      validatedAllocs.push({
        rfqItemId,
        quotationId,
        quotationLineId,
        supplierId: quote.supplierId,
        awardedQty: qty,
        awardedUnitLanded: line.normalizedUnitLanded,
      });
      totalAwardedLanded += qty * line.normalizedUnitLanded;
    }

    totalAwardedLanded = Math.round(totalAwardedLanded * 100) / 100;
    const ranked = rankQuotations(rfqQuotes, 'landed');
    const l1 = ranked.find((r) => r.rankIndex === 1);
    const isNonL1 = Boolean(l1 && totalAwardedLanded > l1.totalForBasis + 0.01);
    const justification =
      typeof params.nonL1Justification === 'string' ? params.nonL1Justification.trim() : '';
    if (isNonL1 && !justification) {
      throw new DemoStoreError(
        'Non-L1 justification is mandatory because recommended total exceeds verified L1.',
        400
      );
    }

    // Replace any prior pending/rejected award on this demo RFQ
    session.workspace.awards = session.workspace.awards.filter(
      (a) => !(a.rfqId === rfq.id && a.approvalStatus !== 'approved')
    );

    const award: AwardDecision = {
      id: `demo-award-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
      rfqId: rfq.id,
      isSplitAward: Boolean(params.isSplitAward),
      recommendedBy: DEMO_USER.fullName,
      approvedBy: null,
      approvalStatus: 'pending',
      nonL1Justification: justification || null,
      approverNotes: null,
      totalAwardedLanded,
      allocations: validatedAllocs,
      decidedAt: null,
      createdAt: new Date().toISOString(),
    };

    session.workspace.awards.unshift(award);
    rfq.status = 'pending_approval';
    rfq.updatedAt = new Date().toISOString();

    this.addAudit(session, {
      actorName: DEMO_USER.fullName,
      actorRole: 'owner',
      entityType: 'award',
      entityId: award.id,
      action: 'DEMO_AWARD_RECOMMENDED',
      detail: `Submitted demo ${award.isSplitAward ? 'split' : 'package'} award recommendation for ${rfq.rfqNumber}.`,
    });
    return structuredClone(award);
  }

  decideAward(
    sessionId: string,
    awardId: string,
    decision: unknown,
    approverNotes?: unknown
  ): AwardDecision {
    const session = this.getOrCreateSession(sessionId);
    if (decision !== 'approved' && decision !== 'rejected') {
      throw new DemoStoreError('Decision must be approved or rejected.', 400);
    }
    const award = session.workspace.awards.find((a) => a.id === awardId);
    if (!award) throw new DemoStoreError('Demo award not found.', 404);
    if (award.approvalStatus !== 'pending') {
      throw new DemoStoreError('This demo award has already been decided.', 409);
    }

    const rfq = session.workspace.rfqs.find((r) => r.id === award.rfqId);
    if (!rfq) throw new DemoStoreError('Parent demo RFQ not found.', 404);

    const now = new Date().toISOString();
    award.approvalStatus = decision;
    award.approvedBy = DEMO_USER.fullName;
    award.approverNotes = typeof approverNotes === 'string' && approverNotes.trim() ? approverNotes.trim() : null;
    award.decidedAt = now;

    if (decision === 'approved') {
      rfq.status = 'awarded';
      rfq.updatedAt = now;
      for (const alloc of award.allocations) {
        const rfqItem = rfq.items.find((it) => it.id === alloc.rfqItemId);
        const supplier = session.workspace.suppliers.find((s) => s.id === alloc.supplierId);
        if (!rfqItem) continue;
        let cat: CatalogItem | undefined = session.workspace.items.find(
          (c) =>
            (rfqItem.itemId && c.id === rfqItem.itemId) ||
            c.normalizedName === normalizeNameKey(rfqItem.description)
        );
        if (!cat) {
          cat = {
            id: `demo-item-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
            skuCode: rfqItem.skuCode || '',
            name: rfqItem.description,
            normalizedName: normalizeNameKey(rfqItem.description),
            defaultUom: rfqItem.uom,
            hsnSacCode: '',
            lastAwardedUnitPrice: null,
            lastAwardedCurrency: null,
            lastAwardedAt: null,
            lastSupplierId: null,
            priceHistory: [],
          };
          session.workspace.items.unshift(cat);
        }
        cat.lastAwardedUnitPrice = alloc.awardedUnitLanded;
        cat.lastAwardedCurrency = rfq.currency;
        cat.lastAwardedAt = now;
        cat.lastSupplierId = alloc.supplierId;
        cat.priceHistory.unshift({
          rfqId: rfq.id,
          rfqNumber: rfq.rfqNumber,
          supplierId: alloc.supplierId,
          supplierName: supplier?.name || 'Demo Supplier',
          unitLandedPrice: alloc.awardedUnitLanded,
          currency: rfq.currency,
          awardedAt: now,
        });
      }
    } else {
      rfq.status = 'in_review';
      rfq.updatedAt = now;
    }

    this.addAudit(session, {
      actorName: DEMO_USER.fullName,
      actorRole: 'owner',
      entityType: 'award',
      entityId: award.id,
      action: decision === 'approved' ? 'DEMO_AWARD_APPROVED' : 'DEMO_AWARD_REJECTED',
      detail: `${decision === 'approved' ? 'Approved' : 'Returned'} demo award for ${rfq.rfqNumber}.`,
    });

    return structuredClone(award);
  }
}
