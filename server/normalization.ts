import { Quotation, QuotationLine, Rfq } from '../src/types.ts';

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

export function recomputeQuotation(quote: Quotation, rfq: Rfq): Quotation {
  const fx = quote.exchangeRateToRfq > 0 ? quote.exchangeRateToRfq : 1;

  // Step 1: Validate arithmetic and compute base + tax per line
  const intermediate = quote.lines.map((line) => {
    if (
      line.matchStatus === 'not_quoted' ||
      line.quotedQty === null ||
      line.quotedUnitRate === null ||
      line.quotedQty <= 0
    ) {
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

    const qty = line.quotedQty;
    const rate = line.quotedUnitRate;
    const disc = line.discountAmount || 0;
    const taxPct = line.taxRatePct || 0;
    const factor = line.uomConversionFactor > 0 ? line.uomConversionFactor : 1;
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
  const netOverhead =
    ((quote.freightCharges || 0) +
      (quote.packingForwarding || 0) +
      (quote.otherCharges || 0) -
      (quote.globalDiscount || 0)) *
    fx;

  // Step 2: Allocate overheads pro-rata and compute normalized unit costs
  let totalNonCreditableTax = 0;

  const updatedLines: QuotationLine[] = intermediate.map((item) => {
    const { line, lineBase, lineTax, lineGross, effectiveQty } = item;
    if (effectiveQty <= 0 || line.matchStatus === 'not_quoted') {
      return line;
    }

    const share = subtotalBase > 0 ? lineBase / subtotalBase : 0;
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

  // Completeness: how many RFQ items have a valid matched/alternate quote line
  const quotedRfqItemIds = new Set(
    updatedLines
      .filter((l) => l.rfqItemId && l.matchStatus !== 'not_quoted' && l.quotedUnitRate !== null)
      .map((l) => l.rfqItemId as string)
  );
  const totalRfqItems = rfq.items.length || 1;
  const completenessRatio = round4(quotedRfqItemIds.size / totalRfqItems);

  const totalLandedCost = round2(subtotalBase + netOverhead + totalNonCreditableTax);
  const totalGrossPayable = round2(subtotalBase + netOverhead + totalLineTax);

  const hasMathErrors = updatedLines.some((l) => !l.mathValid);
  const hasLowConfidence = updatedLines.some((l) => l.confidenceScore < 0.85 && !l.verifiedField);
  const parseStatus = quote.isVerified
    ? 'verified'
    : hasMathErrors || hasLowConfidence || quote.missingFreightWarning
    ? 'needs_review'
    : 'needs_review';

  return {
    ...quote,
    subtotalBase: round2(subtotalBase),
    totalTax: round2(totalLineTax),
    totalLandedCost,
    totalGrossPayable,
    completenessRatio,
    parseStatus: quote.isVerified ? 'verified' : parseStatus,
    lines: updatedLines,
  };
}
