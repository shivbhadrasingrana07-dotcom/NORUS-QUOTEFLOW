import { Quotation, QuotationLine, Rfq } from '../src/types.ts';

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

function isFiniteNonNeg(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/**
 * NORUS QUOTEFLOW Procurement Calculation Conventions:
 * 1. UOM Normalization: effectiveQty = quotedQty * uomConversionFactor.
 *    Example: 50 boxes * (10 pcs / box) = 500 pcs.
 * 2. Tax Inclusive vs Exclusive:
 *    - If taxIncludedInRates=true: lineGross = max(0, qty*rate - disc),
 *      lineBase = lineGross / (1 + taxPct/100), lineTax = lineGross - lineBase.
 *    - If taxIncludedInRates=false: lineBase = max(0, qty*rate - disc),
 *      lineTax = lineBase * (taxPct/100), lineGross = lineBase + lineTax.
 * 3. Commercial Overheads: netOverhead = (freightCharges + packingForwarding + otherCharges - globalDiscount) * fx.
 *    Allocated pro-rata across active lines by lineBase / subtotalBase.
 * 4. Landed Cost vs Base vs Gross:
 *    - normalizedUnitBase = lineBase / effectiveQty
 *    - normalizedUnitLanded = (lineBase + allocatedOverhead + (taxCreditable ? 0 : lineTax)) / effectiveQty
 *    - normalizedUnitGross = (lineGross + allocatedOverhead) / effectiveQty
 * 5. Arithmetic Audit:
 *    Printed lineTotalQuoted is compared against expected pre-tax or post-tax total
 *    within tolerance max(1.5, 0.5% of expected).
 */
export function recomputeQuotation(quote: Quotation, rfq: Rfq): Quotation {
  const fx =
    typeof quote.exchangeRateToRfq === 'number' &&
    Number.isFinite(quote.exchangeRateToRfq) &&
    quote.exchangeRateToRfq > 0
      ? quote.exchangeRateToRfq
      : 1;

  const safeFreight = isFiniteNonNeg(quote.freightCharges) ? quote.freightCharges : 0;
  const safePF = isFiniteNonNeg(quote.packingForwarding) ? quote.packingForwarding : 0;
  const safeOther = isFiniteNonNeg(quote.otherCharges) ? quote.otherCharges : 0;
  const safeGlobalDisc = isFiniteNonNeg(quote.globalDiscount) ? quote.globalDiscount : 0;

  // Step 1: Validate arithmetic and compute base + tax per line
  const intermediate = quote.lines.map((line) => {
    if (line.matchStatus === 'not_quoted' || line.quotedQty === null || line.quotedUnitRate === null) {
      return {
        line: {
          ...line,
          allocatedOverhead: 0,
          normalizedUnitBase: null,
          normalizedUnitLanded: null,
          normalizedUnitGross: null,
          expectedLineTotal: null,
          mathValid: true,
          mathErrorDetail: null,
        },
        lineBase: 0,
        lineTax: 0,
        lineGross: 0,
        effectiveQty: 0,
      };
    }

    // Validate numeric inputs strictly (reject negative or non-finite values)
    const invalidNumeric =
      !Number.isFinite(line.quotedQty) ||
      line.quotedQty <= 0 ||
      !Number.isFinite(line.quotedUnitRate) ||
      line.quotedUnitRate < 0 ||
      !Number.isFinite(line.discountAmount) ||
      line.discountAmount < 0 ||
      !Number.isFinite(line.taxRatePct) ||
      line.taxRatePct < 0 ||
      line.taxRatePct > 100 ||
      !Number.isFinite(line.uomConversionFactor) ||
      line.uomConversionFactor <= 0;

    if (invalidNumeric) {
      return {
        line: {
          ...line,
          allocatedOverhead: 0,
          normalizedUnitBase: null,
          normalizedUnitLanded: null,
          normalizedUnitGross: null,
          expectedLineTotal: null,
          mathValid: false,
          mathErrorDetail: 'Invalid negative, zero-qty, or non-finite rate/UOM value',
        },
        lineBase: 0,
        lineTax: 0,
        lineGross: 0,
        effectiveQty: 0,
      };
    }

    const qty = line.quotedQty;
    const rate = line.quotedUnitRate;
    const disc = line.discountAmount || 0;
    const taxPct = line.taxRatePct || 0;
    const factor = line.uomConversionFactor;
    const effectiveQty = qty * factor;

    let lineBaseLocal = 0;
    let lineTaxLocal = 0;
    let lineGrossLocal = 0;

    if (quote.taxIncludedInRates) {
      lineGrossLocal = Math.max(0, qty * rate - disc);
      lineBaseLocal = lineGrossLocal / (1 + taxPct / 100);
      lineTaxLocal = lineGrossLocal - lineBaseLocal;
    } else {
      lineBaseLocal = Math.max(0, qty * rate - disc);
      lineTaxLocal = lineBaseLocal * (taxPct / 100);
      lineGrossLocal = lineBaseLocal + lineTaxLocal;
    }

    // Arithmetic Audit: compare printed lineTotalQuoted against expected pre-tax OR post-tax
    let mathValid = true;
    let mathErrorDetail: string | null = null;
    let expectedLineTotal: number | null = round2(
      quote.taxIncludedInRates ? lineGrossLocal : lineBaseLocal
    );

    if (line.lineTotalQuoted !== null && line.lineTotalQuoted !== undefined) {
      if (!Number.isFinite(line.lineTotalQuoted) || line.lineTotalQuoted < 0) {
        mathValid = false;
        mathErrorDetail = 'Printed line total is negative or invalid';
      } else {
        const printed = line.lineTotalQuoted;
        const tolBase = Math.max(1.5, lineBaseLocal * 0.005);
        const tolGross = Math.max(1.5, lineGrossLocal * 0.005);

        if (quote.taxIncludedInRates) {
          if (Math.abs(printed - lineGrossLocal) > tolGross) {
            mathValid = false;
            const diff = round2(printed - lineGrossLocal);
            mathErrorDetail = `Printed ${round2(printed).toLocaleString()} vs calculated ${round2(lineGrossLocal).toLocaleString()} (${diff >= 0 ? '+' : ''}${diff})`;
          }
        } else {
          const matchesPreTax = Math.abs(printed - lineBaseLocal) <= tolBase;
          const matchesPostTax = Math.abs(printed - lineGrossLocal) <= tolGross;
          if (!matchesPreTax && !matchesPostTax) {
            mathValid = false;
            const diff = round2(printed - lineBaseLocal);
            mathErrorDetail = `Printed ${round2(printed).toLocaleString()} vs calculated ${round2(lineBaseLocal).toLocaleString()} pre-tax (${diff >= 0 ? '+' : ''}${diff})`;
          } else if (matchesPostTax && !matchesPreTax) {
            expectedLineTotal = round2(lineGrossLocal);
          }
        }
      }
    }

    return {
      line: {
        ...line,
        expectedLineTotal,
        mathValid,
        mathErrorDetail,
      },
      lineBase: lineBaseLocal * fx,
      lineTax: lineTaxLocal * fx,
      lineGross: lineGrossLocal * fx,
      effectiveQty,
    };
  });

  const subtotalBase = intermediate.reduce((acc, item) => acc + item.lineBase, 0);
  const totalLineTax = intermediate.reduce((acc, item) => acc + item.lineTax, 0);
  const netOverhead = (safeFreight + safePF + safeOther - safeGlobalDisc) * fx;

  // Step 2: Allocate overheads pro-rata and compute normalized unit costs
  let totalNonCreditableTax = 0;
  const activeCount = intermediate.filter((i) => i.effectiveQty > 0).length;

  const updatedLines: QuotationLine[] = intermediate.map((item) => {
    const { line, lineBase, lineTax, lineGross, effectiveQty } = item;
    if (effectiveQty <= 0 || line.matchStatus === 'not_quoted') {
      return line;
    }

    // If all lines are 0-base (e.g. 100% FOC), split overhead equally across active lines
    const share =
      subtotalBase > 0 ? lineBase / subtotalBase : activeCount > 0 ? 1 / activeCount : 0;
    const allocatedOverhead = netOverhead * share;
    const nonCreditableTax = line.taxCreditable ? 0 : lineTax;
    totalNonCreditableTax += nonCreditableTax;

    const normalizedUnitBase = round4(lineBase / effectiveQty);
    const normalizedUnitLanded = round4((lineBase + allocatedOverhead + nonCreditableTax) / effectiveQty);
    const normalizedUnitGross = round4((lineGross + allocatedOverhead) / effectiveQty);

    return {
      ...line,
      allocatedOverhead: round2(allocatedOverhead),
      normalizedUnitBase,
      normalizedUnitLanded,
      normalizedUnitGross,
    };
  });

  // Completeness: fraction of distinct RFQ items covered by a valid quoted line
  const quotedRfqItemIds = new Set(
    updatedLines
      .filter(
        (l) =>
          l.rfqItemId &&
          l.matchStatus !== 'not_quoted' &&
          l.quotedUnitRate !== null &&
          l.quotedQty !== null &&
          l.quotedQty > 0
      )
      .map((l) => l.rfqItemId as string)
  );
  const totalRfqItems = rfq.items.length || 1;
  const completenessRatio = round4(Math.min(1, quotedRfqItemIds.size / totalRfqItems));

  // Total landed cost cannot drop below 0 if global discount exceeds subtotal
  const totalLandedCost = round2(Math.max(0, subtotalBase + netOverhead + totalNonCreditableTax));
  const totalGrossPayable = round2(Math.max(0, subtotalBase + netOverhead + totalLineTax));

  const hasMathErrors = updatedLines.some((l) => !l.mathValid);
  const isVerified = quote.isVerified && !hasMathErrors;
  const parseStatus = isVerified ? 'verified' : 'needs_review';

  return {
    ...quote,
    exchangeRateToRfq: fx,
    freightCharges: safeFreight,
    packingForwarding: safePF,
    otherCharges: safeOther,
    globalDiscount: safeGlobalDisc,
    subtotalBase: round2(subtotalBase),
    totalTax: round2(totalLineTax),
    totalLandedCost,
    totalGrossPayable,
    completenessRatio,
    isVerified,
    parseStatus,
    lines: updatedLines,
  };
}
