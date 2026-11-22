import { CostBasis, Quotation, Rfq } from '../types.ts';

export interface RankedQuotation {
  quotation: Quotation;
  rankIndex: number | null; // 1 = L1, 2 = L2, etc.; null if ineligible
  rankLabel: string;
  eligibleForAwardRank: boolean;
  ineligibilityReasons: string[];
  totalForBasis: number;
}

export function getQuoteTotalForBasis(q: Quotation, basis: CostBasis): number {
  if (basis === 'base') return q.subtotalBase;
  if (basis === 'gross') return q.totalGrossPayable;
  return q.totalLandedCost;
}

export function getIneligibilityReasons(q: Quotation): string[] {
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
  return reasons;
}

/**
 * Deterministic ranking convention:
 * 1. Only complete (100% of RFQ items quoted), math-valid, human-verified quotations
 *    are eligible for L1 / L2 / L3 package ranking.
 * 2. Incomplete or invalid/unverified quotations sort after eligible quotes and are
 *    explicitly labeled so they can never masquerade as L1 due to missing items.
 */
export function rankQuotations(quotes: Quotation[], basis: CostBasis): RankedQuotation[] {
  const enriched = quotes.map((q) => {
    const reasons = getIneligibilityReasons(q);
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
 * Honest evaluated savings: compares only complete, math-valid quotations
 * (100% BOM coverage) so partial/incomplete quotes never inflate savings.
 */
export function computeEvaluatedSavings(rfqs: Rfq[], quotations: Quotation[]): number {
  let savings = 0;
  for (const rfq of rfqs) {
    const completeValid = quotations.filter(
      (q) =>
        q.rfqId === rfq.id &&
        q.completenessRatio >= 1 &&
        q.totalLandedCost > 0 &&
        q.lines.every((l) => l.mathValid)
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
