import test from 'node:test';
import assert from 'node:assert/strict';
import { recomputeQuotation } from '../server/normalization.ts';
import { computeEvaluatedSavings, rankQuotations } from '../src/lib/ranking.ts';
import { Quotation, Rfq } from '../src/types.ts';

function makeRfq(): Rfq {
  return {
    id: 'rfq-test-1',
    rfqNumber: 'RFQ-2026-9901',
    title: 'Test Hydraulic Assembly',
    status: 'in_review',
    currency: 'INR',
    incoterms: 'FOR Pune',
    deliveryLocation: 'Pune',
    deadlineDate: '2026-12-15',
    createdBy: 'Test Buyer',
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
    invitedSupplierIds: ['sup-1', 'sup-2'],
    items: [
      {
        id: 'rfq-test-1-item-1',
        rfqId: 'rfq-test-1',
        itemId: 'cat-1',
        lineNo: 1,
        skuCode: 'SKU-1',
        description: 'Hex Bolt M12',
        quantity: 500,
        uom: 'pcs',
        targetUnitPrice: 45,
      },
      {
        id: 'rfq-test-1-item-2',
        rfqId: 'rfq-test-1',
        itemId: 'cat-2',
        lineNo: 2,
        skuCode: 'SKU-2',
        description: 'Hydraulic Manifold',
        quantity: 10,
        uom: 'pcs',
        targetUnitPrice: 2000,
      },
    ],
  };
}

function makeQuote(overrides: Partial<Quotation> = {}): Quotation {
  return {
    id: 'q-test-1',
    rfqId: 'rfq-test-1',
    supplierId: 'sup-1',
    documentName: 'quote.pdf',
    documentKind: 'pdf',
    mimeType: 'application/pdf',
    parseStatus: 'verified',
    quoteReference: 'QT-001',
    quoteDate: '2026-11-20',
    validUntil: '2026-12-20',
    currency: 'INR',
    exchangeRateToRfq: 1,
    leadTimeDays: 7,
    paymentTerms: 'Net 30',
    freightCharges: 0,
    packingForwarding: 0,
    otherCharges: 0,
    globalDiscount: 0,
    taxIncludedInRates: false,
    missingFreightWarning: false,
    subtotalBase: 0,
    totalTax: 0,
    totalLandedCost: 0,
    totalGrossPayable: 0,
    completenessRatio: 0,
    isVerified: true,
    verifiedBy: 'Test Buyer',
    verifiedAt: '2026-11-20T00:00:00.000Z',
    headerTraces: {},
    createdAt: '2026-11-20T00:00:00.000Z',
    lines: [
      {
        id: 'ql-1',
        quotationId: 'q-test-1',
        rfqItemId: 'rfq-test-1-item-1',
        vendorLineNo: 1,
        rawDescription: 'Hex Bolt Box of 10 pcs',
        quotedQty: 50,
        quotedUom: 'box',
        uomConversionFactor: 10,
        quotedUnitRate: 400,
        discountAmount: 0,
        taxRatePct: 18,
        taxCreditable: true,
        allocatedOverhead: 0,
        normalizedUnitBase: null,
        normalizedUnitLanded: null,
        normalizedUnitGross: null,
        lineTotalQuoted: 20000,
        expectedLineTotal: null,
        mathValid: true,
        mathErrorDetail: null,
        matchStatus: 'matched',
        confidenceScore: 0.95,
        humanEdited: false,
        verifiedField: true,
        sourceTrace: { sourceType: 'pdf', snippet: '50 box @ 400 = 20000' },
      },
      {
        id: 'ql-2',
        quotationId: 'q-test-1',
        rfqItemId: 'rfq-test-1-item-2',
        vendorLineNo: 2,
        rawDescription: 'Hydraulic Manifold',
        quotedQty: 10,
        quotedUom: 'pcs',
        uomConversionFactor: 1,
        quotedUnitRate: 2000,
        discountAmount: 0,
        taxRatePct: 18,
        taxCreditable: true,
        allocatedOverhead: 0,
        normalizedUnitBase: null,
        normalizedUnitLanded: null,
        normalizedUnitGross: null,
        lineTotalQuoted: 20000,
        expectedLineTotal: null,
        mathValid: true,
        mathErrorDetail: null,
        matchStatus: 'matched',
        confidenceScore: 0.95,
        humanEdited: false,
        verifiedField: true,
        sourceTrace: { sourceType: 'pdf', snippet: '10 pcs @ 2000 = 20000' },
      },
    ],
    ...overrides,
  };
}

test('recomputeQuotation computes UOM normalization, pro-rata overhead, ITC exclusion, and gross payable', () => {
  const rfq = makeRfq();
  const q = makeQuote({
    freightCharges: 1500,
    packingForwarding: 500,
    globalDiscount: 1000, // netOverhead = 1000 split 50/50 since both lines are 20,000 base
  });

  const out = recomputeQuotation(q, rfq);

  assert.equal(out.subtotalBase, 40000);
  assert.equal(out.totalTax, 7200);
  assert.equal(out.totalLandedCost, 41000); // ITC creditable -> tax excluded from landed
  assert.equal(out.totalGrossPayable, 48200);
  assert.equal(out.completenessRatio, 1);
  assert.equal(out.isVerified, true);

  // Line 1: 50 boxes * 10 = 500 effective pcs; base=20000, overhead=500 -> 20500 / 500 = 41
  assert.equal(out.lines[0].allocatedOverhead, 500);
  assert.equal(out.lines[0].normalizedUnitBase, 40);
  assert.equal(out.lines[0].normalizedUnitLanded, 41);
  assert.equal(out.lines[0].normalizedUnitGross, 48.2); // (23600 + 500) / 500
  assert.equal(out.lines[0].mathValid, true);
});

test('recomputeQuotation handles taxIncludedInRates=true and non-creditable tax accurately', () => {
  const rfq = makeRfq();
  const baseQuote = makeQuote();
  const q = makeQuote({
    taxIncludedInRates: true,
    lines: [
      {
        ...baseQuote.lines[0],
        quotedQty: 100,
        uomConversionFactor: 5, // 500 pcs
        quotedUnitRate: 118, // 11800 gross, 10000 base + 1800 GST
        taxRatePct: 18,
        taxCreditable: false, // non-creditable tax enters landed cost
        lineTotalQuoted: 11800,
      },
      {
        ...baseQuote.lines[1],
        quotedQty: 10,
        quotedUnitRate: 2360, // 23600 gross, 20000 base + 3600 GST
        taxRatePct: 18,
        taxCreditable: true,
        lineTotalQuoted: 23600,
      },
    ],
  });

  const out = recomputeQuotation(q, rfq);
  assert.equal(out.subtotalBase, 30000);
  assert.equal(out.totalTax, 5400);
  // Only line 1 tax (1800) is non-creditable
  assert.equal(out.totalLandedCost, 31800);
  assert.equal(out.totalGrossPayable, 35400);
  assert.equal(out.lines[0].normalizedUnitLanded, 23.6); // 11800 / 500 pcs
  assert.equal(out.lines[1].normalizedUnitLanded, 2000);
});

test('recomputeQuotation converts foreign currency using exchangeRateToRfq', () => {
  const rfq = makeRfq();
  const baseQuote = makeQuote();
  const q = makeQuote({
    currency: 'USD',
    exchangeRateToRfq: 84.5,
    freightCharges: 10, // USD 10 = INR 845
    lines: [
      {
        ...baseQuote.lines[0],
        quotedQty: 500,
        uomConversionFactor: 1,
        quotedUnitRate: 1, // USD 500 -> INR 42,250
        taxRatePct: 0,
        lineTotalQuoted: 500,
      },
      {
        ...baseQuote.lines[1],
        quotedQty: 10,
        quotedUnitRate: 50, // USD 500 -> INR 42,250
        taxRatePct: 0,
        lineTotalQuoted: 500,
      },
    ],
  });

  const out = recomputeQuotation(q, rfq);
  assert.equal(out.subtotalBase, 84500);
  assert.equal(out.totalLandedCost, 85345);
  assert.equal(out.lines[0].normalizedUnitBase, 84.5);
});

test('recomputeQuotation detects printed line total mismatch and clears isVerified', () => {
  const rfq = makeRfq();
  const baseQuote = makeQuote();
  const q = makeQuote({
    isVerified: true,
    lines: [
      {
        ...baseQuote.lines[0],
        lineTotalQuoted: 22500, // expected is 20000 (or 23600 with tax), mismatch!
      },
      baseQuote.lines[1],
    ],
  });

  const out = recomputeQuotation(q, rfq);
  assert.equal(out.lines[0].mathValid, false);
  assert.ok(out.lines[0].mathErrorDetail?.includes('Printed'));
  assert.equal(out.isVerified, false);
  assert.equal(out.parseStatus, 'needs_review');
});

test('recomputeQuotation handles FOC (0-base) lines, globalDiscount clamping, fractional UOM, and invalid numbers', () => {
  const rfq = makeRfq();
  const baseQuote = makeQuote();

  // Case 1: 0-base lines split overhead equally and clamp negative total to 0
  const focQuote = makeQuote({
    freightCharges: 200,
    globalDiscount: 500,
    lines: [
      { ...baseQuote.lines[0], quotedUnitRate: 0, lineTotalQuoted: 0, uomConversionFactor: 0.5 },
      { ...baseQuote.lines[1], quotedUnitRate: 0, lineTotalQuoted: 0 },
    ],
  });
  const focOut = recomputeQuotation(focQuote, rfq);
  assert.equal(focOut.totalLandedCost, 0);
  assert.equal(focOut.totalGrossPayable, 0);
  assert.equal(focOut.lines[0].allocatedOverhead, -150);

  // Case 2: negative rate or tax > 100 triggers mathValid: false without throwing
  const badQuote = makeQuote({
    lines: [
      { ...baseQuote.lines[0], quotedUnitRate: -10 },
      { ...baseQuote.lines[1], taxRatePct: 120 },
    ],
  });
  const badOut = recomputeQuotation(badQuote, rfq);
  assert.equal(badOut.lines[0].mathValid, false);
  assert.equal(badOut.lines[1].mathValid, false);
  assert.equal(badOut.isVerified, false);
});

test('rankQuotations never grants L1 to incomplete or unverified quotes and computeEvaluatedSavings excludes partial quotes', () => {
  const rfq = makeRfq();
  const baseQuote = makeQuote();

  const partialCheap = recomputeQuotation(
    makeQuote({
      id: 'q-partial',
      supplierId: 'sup-2',
      isVerified: false,
      lines: [
        baseQuote.lines[0],
        {
          ...baseQuote.lines[1],
          quotedQty: null,
          quotedUnitRate: null,
          lineTotalQuoted: null,
          matchStatus: 'not_quoted',
        },
      ],
    }),
    rfq
  );

  const completeVerifiedA = recomputeQuotation(
    makeQuote({ id: 'q-complete-a', supplierId: 'sup-1', isVerified: true }),
    rfq
  );

  const completeVerifiedB = recomputeQuotation(
    makeQuote({
      id: 'q-complete-b',
      supplierId: 'sup-3',
      isVerified: true,
      freightCharges: 4000,
    }),
    rfq
  );

  const ranked = rankQuotations([partialCheap, completeVerifiedB, completeVerifiedA], 'landed');
  assert.equal(ranked[0].quotation.id, 'q-complete-a');
  assert.equal(ranked[0].rankLabel, 'L1');
  assert.equal(ranked[1].quotation.id, 'q-complete-b');
  assert.equal(ranked[1].rankLabel, 'L2');
  assert.equal(ranked[2].quotation.id, 'q-partial');
  assert.equal(ranked[2].rankIndex, null);
  assert.equal(ranked[2].rankLabel, 'Incomplete');

  // Savings should compare complete quotes (40000 vs 44000 -> mean 42000 - min 40000 = 2000)
  // and ignore the incomplete 20000 quote
  const savings = computeEvaluatedSavings([rfq], [partialCheap, completeVerifiedA, completeVerifiedB]);
  assert.equal(savings, 2000);
});
