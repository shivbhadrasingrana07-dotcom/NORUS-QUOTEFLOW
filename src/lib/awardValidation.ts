import type { AwardAllocation, Quotation, QuotationLine, Rfq, RfqItem } from '../types.ts';
import {
  getAllocationTolerance,
  isExceedingL1Total,
  isLineQuantitySufficient,
  rankQuotations,
  sumExactQuantities,
} from './ranking.ts';

export {
  QUANTITY_EPSILON,
  ALLOCATION_QTY_EPSILON,
  getQuantityTolerance,
  getAllocationTolerance,
  getConvertedQuotedQuantity,
  isExceedingL1Total,
  isLineQuantitySufficient,
  roundCurrencyCents,
  sumExactQuantities,
} from './ranking.ts';

export class AwardValidationError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'AwardValidationError';
    this.statusCode = statusCode;
  }
}

export interface AwardValidationInput {
  rfq: Rfq;
  rfqQuotes: Quotation[];
  isSplitAward: boolean;
  allocations: unknown;
  nonL1Justification?: unknown;
  acceptedAlternateLineIds?: unknown;
  commercialExceptionAccepted?: unknown;
  hasApprovedAward?: boolean;
  hasPendingAward?: boolean;
}

export interface ValidatedAwardResult {
  allocations: AwardAllocation[];
  totalAwardedLanded: number;
  isNonL1: boolean;
  nonL1Justification: string | null;
  requiresCommercialException: boolean;
  alternateLineIds: string[];
}

export function validateAwardSubmission(params: AwardValidationInput): ValidatedAwardResult {
  const { rfq, rfqQuotes, isSplitAward } = params;

  if (params.hasApprovedAward) {
    throw new AwardValidationError(409, 'This RFQ already has an approved award.');
  }

  if (params.hasPendingAward) {
    throw new AwardValidationError(
      409,
      'This RFQ already has a pending award recommendation. Withdraw the pending award before submitting a replacement.'
    );
  }

  const rawAllocs = Array.isArray(params.allocations) ? params.allocations : [];
  if (rawAllocs.length === 0) {
    throw new AwardValidationError(
      400,
      'Award recommendation must include at least one item allocation.'
    );
  }

  interface ParsedAllocEntry {
    rfqItem: RfqItem;
    quote: Quotation;
    line: QuotationLine;
    hasExplicitQty: boolean;
    providedQty: number | null;
  }

  const seenItemQuotePairs = new Set<string>();
  const seenItemLinePairs = new Set<string>();
  const entriesByRfqItem = new Map<string, ParsedAllocEntry[]>();

  for (const raw of rawAllocs) {
    if (!raw || typeof raw !== 'object') {
      throw new AwardValidationError(400, 'Invalid allocation entry.');
    }
    const r = raw as Record<string, unknown>;
    const rfqItemId = typeof r.rfqItemId === 'string' ? r.rfqItemId.trim() : '';
    const quotationId = typeof r.quotationId === 'string' ? r.quotationId.trim() : '';
    const quotationLineId = typeof r.quotationLineId === 'string' ? r.quotationLineId.trim() : '';

    if (!rfqItemId || !quotationId || !quotationLineId) {
      throw new AwardValidationError(
        400,
        'Each allocation must specify rfqItemId, quotationId, and quotationLineId.'
      );
    }

    const rfqItem = rfq.items.find((it) => it.id === rfqItemId);
    const quote = rfqQuotes.find((q) => q.id === quotationId);
    const line = quote?.lines.find((l) => l.id === quotationLineId);

    if (!rfqItem || !quote || !line) {
      throw new AwardValidationError(
        400,
        'Invalid allocation reference to RFQ item or quotation line.'
      );
    }

    if (line.rfqItemId !== rfqItem.id) {
      throw new AwardValidationError(
        400,
        'Quotation line does not correspond to the allocated RFQ item.'
      );
    }

    const pairKey = `${rfqItem.id}::${quote.id}`;
    const lineKey = `${rfqItem.id}::${line.id}`;
    if (seenItemQuotePairs.has(pairKey) || seenItemLinePairs.has(lineKey)) {
      throw new AwardValidationError(
        400,
        'Duplicate quotation allocation for the same RFQ item.'
      );
    }
    seenItemQuotePairs.add(pairKey);
    seenItemLinePairs.add(lineKey);

    const existingList = entriesByRfqItem.get(rfqItem.id) || [];
    if (!isSplitAward && existingList.length > 0) {
      throw new AwardValidationError(400, 'Duplicate RFQ item in award allocations.');
    }

    const hasExplicitQty = r.awardedQty !== undefined && r.awardedQty !== null;
    let providedQty: number | null = null;
    if (hasExplicitQty) {
      const n = Number(r.awardedQty);
      if (!Number.isFinite(n) || n <= 0) {
        throw new AwardValidationError(
          400,
          'Awarded quantity must be positive and match the full RFQ item quantity.'
        );
      }
      providedQty = n;
    }

    existingList.push({ rfqItem, quote, line, hasExplicitQty, providedQty });
    entriesByRfqItem.set(rfqItem.id, existingList);
  }

  if (rfq.items.some((it) => !entriesByRfqItem.has(it.id))) {
    throw new AwardValidationError(
      400,
      'Award recommendation must cover 100% of RFQ line items.'
    );
  }

  const validatedAllocations: AwardAllocation[] = [];
  const referencedQuotesMap = new Map<string, Quotation>();
  const referencedLines: QuotationLine[] = [];
  let computedTotalLanded = 0;

  for (const rfqItem of rfq.items) {
    const group = entriesByRfqItem.get(rfqItem.id)!;

    if (group.length > 1) {
      if (group.some((g) => !g.hasExplicitQty || g.providedQty === null)) {
        throw new AwardValidationError(
          400,
          'Multi-supplier split allocations for an item must specify awardedQty on every split entry.'
        );
      }
      const totalAllocatedForItem = sumExactQuantities(group.map((g) => g.providedQty!));
      if (
        Math.abs(totalAllocatedForItem - rfqItem.quantity) >
        getAllocationTolerance(rfqItem.quantity)
      ) {
        throw new AwardValidationError(
          400,
          `Split allocations total (${totalAllocatedForItem} ${rfqItem.uom}) must equal full RFQ item quantity (${rfqItem.quantity} ${rfqItem.uom}).`
        );
      }
    } else {
      const sole = group[0];
      if (
        sole.hasExplicitQty &&
        sole.providedQty !== null &&
        Math.abs(sole.providedQty - rfqItem.quantity) > getAllocationTolerance(rfqItem.quantity)
      ) {
        throw new AwardValidationError(
          400,
          'Awarded quantity must be positive and match the full RFQ item quantity.'
        );
      }
    }

    for (const entry of group) {
      const { quote, line } = entry;
      const allocQty = entry.hasExplicitQty && entry.providedQty !== null ? entry.providedQty : rfqItem.quantity;

      if (!quote.isVerified) {
        throw new AwardValidationError(
          422,
          `Quotation ${quote.quoteReference} must be verified before it can be included in an award.`
        );
      }

      if (line.matchStatus === 'not_quoted' || line.matchStatus === 'unmapped') {
        throw new AwardValidationError(
          422,
          `Line "${line.rawDescription}" is ${line.matchStatus} and cannot be awarded.`
        );
      }

      if (
        !line.mathValid ||
        line.normalizedUnitLanded === null ||
        !Number.isFinite(line.normalizedUnitLanded)
      ) {
        throw new AwardValidationError(
          422,
          `Cannot include line "${line.rawDescription}" in an award while arithmetic mismatch or missing price remains.`
        );
      }

      const qtyCheck = isLineQuantitySufficient(line, { ...rfqItem, quantity: allocQty });
      if (!qtyCheck.ok) {
        const convertedLabel =
          qtyCheck.convertedQty === null
            ? 'missing/invalid'
            : `${qtyCheck.convertedQty} ${rfqItem.uom}`;
        throw new AwardValidationError(
          422,
          `Quoted quantity (${convertedLabel}) for "${line.rawDescription}" is below allocated RFQ quantity (${allocQty} ${rfqItem.uom}).`
        );
      }

      referencedQuotesMap.set(quote.id, quote);
      referencedLines.push(line);

      const unitLanded = line.normalizedUnitLanded;
      computedTotalLanded += unitLanded * allocQty;
      validatedAllocations.push({
        rfqItemId: rfqItem.id,
        quotationId: quote.id,
        quotationLineId: line.id,
        supplierId: quote.supplierId,
        awardedQty: allocQty,
        awardedUnitLanded: unitLanded,
      });
    }
  }

  const distinctQuoteIds = new Set(validatedAllocations.map((a) => a.quotationId));
  if (!isSplitAward) {
    if (distinctQuoteIds.size !== 1) {
      throw new AwardValidationError(
        400,
        'Single-vendor package award must allocate all lines to one quotation.'
      );
    }
    const soleQuote = referencedQuotesMap.get([...distinctQuoteIds][0])!;
    if (soleQuote.completenessRatio < 1) {
      throw new AwardValidationError(
        422,
        `Quotation ${soleQuote.quoteReference} does not have 100% BOM coverage for a full package award.`
      );
    }
    computedTotalLanded = soleQuote.totalLandedCost;
  }

  computedTotalLanded = Math.round(computedTotalLanded * 100) / 100;

  const trimmedJustification =
    typeof params.nonL1Justification === 'string' && params.nonL1Justification.trim()
      ? params.nonL1Justification.trim()
      : null;

  const quotesWithMissingFreight = [...referencedQuotesMap.values()].filter(
    (q) => q.missingFreightWarning
  );
  const requiresCommercialException = quotesWithMissingFreight.length > 0;
  if (
    requiresCommercialException &&
    (params.commercialExceptionAccepted !== true || !trimmedJustification)
  ) {
    throw new AwardValidationError(
      422,
      `Freight or commercial terms remain unconfirmed on ${quotesWithMissingFreight
        .map((q) => q.quoteReference)
        .join(', ')}. Confirm freight terms in Extraction Review or explicitly accept the commercial exception with written justification.`
    );
  }

  const alternateLines = referencedLines.filter((l) => l.matchStatus === 'alternate_spec');
  const acceptedAltSet = new Set(
    Array.isArray(params.acceptedAlternateLineIds)
      ? params.acceptedAlternateLineIds.filter((id): id is string => typeof id === 'string')
      : []
  );
  if (alternateLines.length > 0) {
    const missingAlt = alternateLines.filter((l) => !acceptedAltSet.has(l.id));
    if (missingAlt.length > 0 || !trimmedJustification) {
      throw new AwardValidationError(
        422,
        `Award includes alternate-specification line(s) (${alternateLines
          .map((l) => l.rawDescription)
          .join('; ')}). Explicitly accept alternate specifications with written justification before awarding.`
      );
    }
  }

  const ranked = rankQuotations(rfqQuotes, 'landed', rfq);
  const l1Eligible = ranked.find((r) => r.rankIndex === 1);
  const isNonL1 = Boolean(
    l1Eligible && isExceedingL1Total(computedTotalLanded, l1Eligible.totalForBasis)
  );
  if (isNonL1 && !trimmedJustification) {
    throw new AwardValidationError(
      400,
      'Non-L1 justification is mandatory because recommended total exceeds verified L1 lowest landed cost.'
    );
  }

  return {
    allocations: validatedAllocations,
    totalAwardedLanded: computedTotalLanded,
    isNonL1,
    nonL1Justification: trimmedJustification,
    requiresCommercialException,
    alternateLineIds: alternateLines.map((l) => l.id),
  };
}
