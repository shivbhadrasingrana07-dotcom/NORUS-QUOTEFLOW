import type { AwardAllocation, Quotation, QuotationLine, Rfq } from '../types.ts';
import { rankQuotations } from './ranking.ts';

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

  const rawAllocs = Array.isArray(params.allocations) ? params.allocations : [];
  if (rawAllocs.length === 0) {
    throw new AwardValidationError(
      400,
      'Award recommendation must include at least one item allocation.'
    );
  }

  const seenRfqItemIds = new Set<string>();
  const validatedAllocations: AwardAllocation[] = [];
  const referencedQuotesMap = new Map<string, Quotation>();
  const referencedLines: QuotationLine[] = [];
  let computedTotalLanded = 0;

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

    if (seenRfqItemIds.has(rfqItemId)) {
      throw new AwardValidationError(400, 'Duplicate RFQ item in award allocations.');
    }
    seenRfqItemIds.add(rfqItemId);

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

    if (r.awardedQty !== undefined && r.awardedQty !== null) {
      const providedQty = Number(r.awardedQty);
      if (
        !Number.isFinite(providedQty) ||
        providedQty <= 0 ||
        Math.abs(providedQty - rfqItem.quantity) > 0.001
      ) {
        throw new AwardValidationError(
          400,
          'Awarded quantity must be positive and match the full RFQ item quantity.'
        );
      }
    }

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

    referencedQuotesMap.set(quote.id, quote);
    referencedLines.push(line);

    const qty = rfqItem.quantity;
    const unitLanded = line.normalizedUnitLanded;
    computedTotalLanded += unitLanded * qty;
    validatedAllocations.push({
      rfqItemId: rfqItem.id,
      quotationId: quote.id,
      quotationLineId: line.id,
      supplierId: quote.supplierId,
      awardedQty: qty,
      awardedUnitLanded: unitLanded,
    });
  }

  if (
    validatedAllocations.length !== rfq.items.length ||
    rfq.items.some((it) => !seenRfqItemIds.has(it.id))
  ) {
    throw new AwardValidationError(
      400,
      'Award recommendation must cover 100% of RFQ line items.'
    );
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

  const ranked = rankQuotations(rfqQuotes, 'landed');
  const l1Eligible = ranked.find((r) => r.rankIndex === 1);
  const isNonL1 = Boolean(l1Eligible && computedTotalLanded > l1Eligible.totalForBasis + 1);
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
