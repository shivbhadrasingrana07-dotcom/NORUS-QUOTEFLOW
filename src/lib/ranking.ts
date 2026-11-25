import { CostBasis, Quotation, QuotationLine, Rfq, RfqItem } from '../types.ts';

/**
 * Base tolerance in RFQ base-UOM units for floating-point UOM conversion rounding
 * (e.g. fractional pack/weight conversions such as 3 * 0.333333 kg = 0.999999 kg).
 * For micro-quantities (< 1 unit), tolerance scales proportionally with requiredQty
 * so tiny lines cannot pass with large percentage shortfalls.
 */
export const QUANTITY_EPSILON = 1e-4;
export const ALLOCATION_QTY_EPSILON = 1e-6;

export function getQuantityTolerance(requiredQty: number): number {
  if (!Number.isFinite(requiredQty) || requiredQty <= 0) {
    return QUANTITY_EPSILON;
  }
  return requiredQty < 1
    ? Math.max(requiredQty * QUANTITY_EPSILON, Number.EPSILON * 16)
    : QUANTITY_EPSILON;
}

export function getAllocationTolerance(targetQty: number): number {
  if (!Number.isFinite(targetQty) || targetQty <= 0) {
    return ALLOCATION_QTY_EPSILON;
  }
  return Math.max(
    Math.min(ALLOCATION_QTY_EPSILON, targetQty * ALLOCATION_QTY_EPSILON),
    Number.EPSILON * 16
  );
}

export function sumExactQuantities(values: number[]): number {
  let sum = 0;
  let compensation = 0;
  for (const v of values) {
    const y = v - compensation;
    const t = sum + y;
    compensation = t - sum - y;
    sum = t;
  }
  return sum;
}

export interface RankedQuotation {
  quotation: Quotation;
  rankIndex: number | null; // 1 = L1, 2 = L2, etc.; null if ineligible
  rankLabel: string;
  eligibleForAwardRank: boolean;
  ineligibilityReasons: string[];
  totalForBasis: number;
}

export function getConvertedQuotedQuantity(line: QuotationLine): number | null {
  if (
    line.quotedQty === null ||
    !Number.isFinite(line.quotedQty) ||
    line.quotedQty <= 0 ||
    !Number.isFinite(line.uomConversionFactor) ||
    line.uomConversionFactor <= 0
  ) {
    return null;
  }
  const raw = line.quotedQty * line.uomConversionFactor;
  return raw >= 1e-6 ? Math.round(raw * 1_000_000_000) / 1_000_000_000 : raw;
}

export function isLineQuantitySufficient(
  line: QuotationLine,
  rfqItem: RfqItem
): { ok: boolean; convertedQty: number | null; requiredQty: number } {
  const convertedQty = getConvertedQuotedQuantity(line);
  const requiredQty = rfqItem.quantity;
  if (convertedQty === null || !Number.isFinite(requiredQty) || requiredQty <= 0) {
    return { ok: false, convertedQty, requiredQty };
  }
  return {
    ok: convertedQty + getQuantityTolerance(requiredQty) >= requiredQty,
    convertedQty,
    requiredQty,
  };
}

/**
 * Currency amounts are compared at integer-cent precision (0.01 currency units)
 * with tiny floating-point normalization (1e-9) so exact ties never trigger
 * non-L1 justification while any >= $0.01 / ₹0.01 exceedance is enforced.
 */
export function roundCurrencyCents(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Math.sign(value) * 1e-9) * 100);
}

export function isExceedingL1Total(recommendedTotal: number, l1Total: number): boolean {
  return roundCurrencyCents(recommendedTotal) > roundCurrencyCents(l1Total);
}

export function getQuoteTotalForBasis(q: Quotation, basis: CostBasis): number {
  if (basis === 'base') return q.subtotalBase;
  if (basis === 'gross') return q.totalGrossPayable;
  return q.totalLandedCost;
}

export function getIneligibilityReasons(q: Quotation, rfq?: Rfq): string[] {
  const reasons: string[] = [];
  if (q.completenessRatio < 1) {
    reasons.push(`Incomplete (${Math.round(q.completenessRatio * 100)}% lines)`);
  }
  const mathErrors = q.lines.filter((l) => !l.mathValid).length;
  if (mathErrors > 0) {
    reasons.push(`${mathErrors} math mismatch`);
  }
  if (!q.isVerified) {
    reasons.push('Unverified');
  }
  if (q.missingFreightWarning) {
    reasons.push('Unconfirmed freight/commercial terms');
  }
  const unreviewedAlternate = q.lines.filter(
    (l) => l.matchStatus === 'alternate_spec' && !l.verifiedField
  ).length;
  if (unreviewedAlternate > 0) {
    reasons.push(`${unreviewedAlternate} unreviewed alternate spec`);
  }
  if (rfq) {
    let shortCount = 0;
    for (const item of rfq.items) {
      const line = q.lines.find(
        (l) =>
          l.rfqItemId === item.id &&
          l.matchStatus !== 'not_quoted' &&
          l.matchStatus !== 'unmapped'
      );
      if (line && !isLineQuantitySufficient(line, item).ok) {
        shortCount += 1;
      }
    }
    if (shortCount > 0) {
      reasons.push(`${shortCount} insufficient quoted qty`);
    }
  } else {
    const missingQty = q.lines.filter(
      (l) =>
        Boolean(l.rfqItemId) &&
        l.matchStatus !== 'not_quoted' &&
        l.matchStatus !== 'unmapped' &&
        getConvertedQuotedQuantity(l) === null
    ).length;
    if (missingQty > 0) {
      reasons.push(`${missingQty} missing/invalid quoted qty`);
    }
  }
  return reasons;
}

/**
 * Deterministic ranking convention:
 * 1. Only complete (100% of RFQ items quoted with sufficient converted qty),
 *    math-valid, commercially confirmed, human-verified quotations are eligible
 *    for L1 / L2 / L3 package ranking.
 * 2. Incomplete, insufficient-quantity, invalid, or unverified quotations sort
 *    after eligible quotes and are explicitly labeled so they can never
 *    masquerade as L1 due to missing items, short quantities, or omitted freight.
 */
export function rankQuotations(
  quotes: Quotation[],
  basis: CostBasis,
  rfq?: Rfq
): RankedQuotation[] {
  const enriched = quotes.map((q) => {
    const reasons = getIneligibilityReasons(q, rfq);
    return {
      quotation: q,
      eligibleForAwardRank: reasons.length === 0,
      ineligibilityReasons: reasons,
      totalForBasis: getQuoteTotalForBasis(q, basis),
    };
  });

  enriched.sort((a, b) => {
    if (a.eligibleForAwardRank !== b.eligibleForAwardRank) {
      return a.eligibleForAwardRank ? -1 : 1;
    }
    if (b.quotation.completenessRatio !== a.quotation.completenessRatio) {
      // Among ineligible quotes, complete-but-unverified comes before partial quotes
      const aComplete = a.quotation.completenessRatio >= 1 ? 1 : 0;
      const bComplete = b.quotation.completenessRatio >= 1 ? 1 : 0;
      if (aComplete !== bComplete) return bComplete - aComplete;
    }
    return a.totalForBasis - b.totalForBasis;
  });

  let rankCounter = 0;
  return enriched.map((item) => {
    if (item.eligibleForAwardRank) {
      rankCounter += 1;
      return {
        ...item,
        rankIndex: rankCounter,
        rankLabel: `L${rankCounter}`,
      };
    }
    const label =
      item.quotation.completenessRatio < 1
        ? 'Incomplete'
        : !item.quotation.isVerified
        ? 'Pending Audit'
        : 'Flagged';
    return {
      ...item,
      rankIndex: null,
      rankLabel: label,
    };
  });
}

/**
 * Honest evaluated savings: compares only complete, math-valid, quantity-sufficient
 * quotations (100% BOM coverage) so partial/short quotes never inflate savings.
 */
export function computeEvaluatedSavings(rfqs: Rfq[], quotations: Quotation[]): number {
  let savings = 0;
  for (const rfq of rfqs) {
    const completeValid = quotations.filter(
      (q) =>
        q.rfqId === rfq.id &&
        q.completenessRatio >= 1 &&
        q.totalLandedCost > 0 &&
        q.lines.every((l) => l.mathValid) &&
        rfq.items.every((item) => {
          const line = q.lines.find(
            (l) =>
              l.rfqItemId === item.id &&
              l.matchStatus !== 'not_quoted' &&
              l.matchStatus !== 'unmapped'
          );
          return Boolean(line && isLineQuantitySufficient(line, item).ok);
        })
    );
    if (completeValid.length >= 2) {
      const min = Math.min(...completeValid.map((q) => q.totalLandedCost));
      const mean =
        completeValid.reduce((sum, q) => sum + q.totalLandedCost, 0) / completeValid.length;
      if (mean > min) {
        savings += mean - min;
      }
    }
  }
  return Math.round(savings * 100) / 100;
}
