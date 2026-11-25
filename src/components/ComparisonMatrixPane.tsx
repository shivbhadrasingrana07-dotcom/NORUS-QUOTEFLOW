import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  FileSpreadsheet,
  FileText,
  Sparkles,
} from 'lucide-react';
import {
  AwardAllocation,
  CatalogItem,
  CostBasis,
  Quotation,
  QuotationLine,
  Rfq,
  Supplier,
} from '../types.ts';
import { formatMoney, formatPct } from '../lib/format.ts';
import { isExceedingL1Total, isLineQuantitySufficient } from '../lib/awardValidation.ts';
import { rankQuotations } from '../lib/ranking.ts';

interface ComparisonMatrixPaneProps {
  rfq: Rfq;
  quotes: Quotation[];
  suppliers: Supplier[];
  catalogItems: CatalogItem[];
  basis: CostBasis;
  onChangeBasis: (basis: CostBasis) => void;
  onInspectQuote: (quoteId: string) => void;
  onProceedToAward: (params: {
    isSplitAward: boolean;
    allocations: AwardAllocation[];
    totalAwardedLanded: number;
    isNonL1: boolean;
  }) => void;
  onExportPdf: () => void;
  onExportExcel: () => void;
}

export function ComparisonMatrixPane({
  rfq,
  quotes,
  suppliers,
  catalogItems,
  basis,
  onChangeBasis,
  onInspectQuote,
  onProceedToAward,
  onExportPdf,
  onExportExcel,
}: ComparisonMatrixPaneProps) {
  const [awardMode, setAwardMode] = useState<'package' | 'split'>('package');
  const [discrepanciesOnly, setDiscrepanciesOnly] = useState(false);
  const [selectedPackageQuoteId, setSelectedPackageQuoteId] = useState<string | null>(null);
  const [splitSelection, setSplitSelection] = useState<Record<string, string>>({});
  const [inspectedCell, setInspectedCell] = useState<{
    supplierName: string;
    line: QuotationLine;
    quoteId: string;
  } | null>(null);

  if (quotes.length === 0) {
    return (
      <div className="bg-white border border-[#E2E8F0] rounded-lg p-10 text-center">
        <p className="text-sm text-[#475569]">
          Upload at least one supplier quotation to generate the normalized comparison matrix.
        </p>
      </div>
    );
  }

  const getLineUnitForBasis = (line: QuotationLine) => {
    if (basis === 'base') return line.normalizedUnitBase;
    if (basis === 'gross') return line.normalizedUnitGross;
    return line.normalizedUnitLanded;
  };

  const rankedQuotes = rankQuotations(quotes, basis, rfq);
  const sortedQuotes = rankedQuotes.map((r) => r.quotation);
  const l1Eligible = rankedQuotes.find((r) => r.rankIndex === 1) || null;
  const baselineTotal = l1Eligible ? l1Eligible.totalForBasis : rankedQuotes[0].totalForBasis;
  const activePackageId = selectedPackageQuoteId || (l1Eligible ? l1Eligible.quotation.id : sortedQuotes[0].id);

  const getSupplier = (id: string) => suppliers.find((s) => s.id === id);

  const getLastPaidPrice = (item: Rfq['items'][number]) => {
    const cat = catalogItems.find(
      (c) =>
        c.id === item.itemId ||
        (item.skuCode && c.skuCode.toLowerCase() === item.skuCode.toLowerCase())
    );
    return cat?.lastAwardedUnitPrice ?? item.targetUnitPrice ?? null;
  };

  const getEffectiveSplitQuoteForItem = (rfqItemId: string): string => {
    if (splitSelection[rfqItemId]) return splitSelection[rfqItemId];
    const rfqItem = rfq.items.find((it) => it.id === rfqItemId);
    let bestQuoteId = sortedQuotes[0].id;
    let bestUnit = Infinity;
    for (const q of sortedQuotes) {
      const line = q.lines.find((l) => l.rfqItemId === rfqItemId);
      const qtyOk = rfqItem && line ? isLineQuantitySufficient(line, rfqItem).ok : true;
      const u =
        line &&
        line.matchStatus !== 'not_quoted' &&
        line.matchStatus !== 'unmapped' &&
        line.mathValid &&
        qtyOk
          ? getLineUnitForBasis(line)
          : null;
      if (u !== null && u < bestUnit) {
        bestUnit = u;
        bestQuoteId = q.id;
      }
    }
    return bestQuoteId;
  };

  const visibleItems = rfq.items.filter((item) => {
    if (!discrepanciesOnly) return true;
    return sortedQuotes.some((q) => {
      const line = q.lines.find((l) => l.rfqItemId === item.id);
      return (
        !line ||
        !line.mathValid ||
        line.matchStatus === 'not_quoted' ||
        line.matchStatus === 'alternate_spec' ||
        line.uomConversionFactor !== 1 ||
        !isLineQuantitySufficient(line, item).ok
      );
    });
  });

  // Compute Split Award Blended Total (in Landed basis for award submission)
  const splitAllocations: AwardAllocation[] = [];
  let splitTotalLanded = 0;
  let splitHasInvalidSelection = false;
  let splitHasInsufficientQty = false;
  let splitHasUnverifiedSelection = false;

  for (const item of rfq.items) {
    const qId = getEffectiveSplitQuoteForItem(item.id);
    const quote = sortedQuotes.find((q) => q.id === qId) || sortedQuotes[0];
    const line = quote.lines.find((l) => l.rfqItemId === item.id);
    if (!quote.isVerified) {
      splitHasUnverifiedSelection = true;
    }
    if (
      !line ||
      line.matchStatus === 'not_quoted' ||
      line.matchStatus === 'unmapped' ||
      !line.mathValid ||
      line.normalizedUnitLanded === null
    ) {
      splitHasInvalidSelection = true;
    } else if (!isLineQuantitySufficient(line, item).ok) {
      splitHasInsufficientQty = true;
    } else {
      splitTotalLanded += line.normalizedUnitLanded * item.quantity;
      splitAllocations.push({
        rfqItemId: item.id,
        quotationId: quote.id,
        quotationLineId: line.id,
        supplierId: quote.supplierId,
        awardedQty: item.quantity,
        awardedUnitLanded: line.normalizedUnitLanded,
      });
    }
  }

  const activePackageQuote =
    sortedQuotes.find((q) => q.id === activePackageId) || sortedQuotes[0];
  let packageHasInsufficientQty = false;
  const activePackageAllocations: AwardAllocation[] = rfq.items
    .map((item) => {
      const line = activePackageQuote.lines.find((l) => l.rfqItemId === item.id);
      if (
        !line ||
        line.matchStatus === 'not_quoted' ||
        line.matchStatus === 'unmapped' ||
        !line.mathValid ||
        line.normalizedUnitLanded === null
      ) {
        return null;
      }
      if (!isLineQuantitySufficient(line, item).ok) {
        packageHasInsufficientQty = true;
        return null;
      }
      return {
        rfqItemId: item.id,
        quotationId: activePackageQuote.id,
        quotationLineId: line.id,
        supplierId: activePackageQuote.supplierId,
        awardedQty: item.quantity,
        awardedUnitLanded: line.normalizedUnitLanded,
      };
    })
    .filter((x): x is AwardAllocation => x !== null);

  const packageBlockReason = !activePackageQuote.isVerified
    ? `Verify quotation ${activePackageQuote.quoteReference} before recommending award`
    : packageHasInsufficientQty
    ? `Quotation ${activePackageQuote.quoteReference} has insufficient quoted quantity on one or more RFQ lines`
    : activePackageQuote.completenessRatio < 1 || activePackageAllocations.length !== rfq.items.length
    ? `Quotation ${activePackageQuote.quoteReference} must cover 100% of RFQ lines for a package award`
    : null;

  const splitBlockReason = splitHasInvalidSelection
    ? 'Select valid, quoted lines for all items before recommending a split award'
    : splitHasInsufficientQty
    ? 'Selected split lines must cover 100% of required RFQ quantities before recommending a split award'
    : splitHasUnverifiedSelection
    ? 'Verify all selected quotations before recommending a split award'
    : null;

  const activeBlockReason =
    awardMode === 'package' ? packageBlockReason : splitBlockReason;

  const handleRecommendClick = () => {
    if (activeBlockReason) return;
    if (awardMode === 'package') {
      const chosen = activePackageQuote;
      const l1Landed = l1Eligible ? l1Eligible.quotation.totalLandedCost : chosen.totalLandedCost;
      onProceedToAward({
        isSplitAward: false,
        allocations: activePackageAllocations,
        totalAwardedLanded: chosen.totalLandedCost,
        isNonL1: l1Eligible ? isExceedingL1Total(chosen.totalLandedCost, l1Landed) : false,
      });
    } else {
      const l1LandedTotal = l1Eligible ? l1Eligible.quotation.totalLandedCost : splitTotalLanded;
      onProceedToAward({
        isSplitAward: true,
        allocations: splitAllocations,
        totalAwardedLanded: Math.round(splitTotalLanded * 100) / 100,
        isNonL1: l1Eligible ? isExceedingL1Total(splitTotalLanded, l1LandedTotal) : false,
      });
    }
  };

  return (
    <div className="space-y-4">
      {/* Controls Bar */}
      <div className="bg-white border border-[#E2E8F0] rounded-lg p-3.5 flex flex-col xl:flex-row xl:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 p-1 bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg">
            {(
              [
                { id: 'base', label: 'Base Ex-Tax' },
                { id: 'landed', label: 'Landed Cost' },
                { id: 'gross', label: 'Gross Payable' },
              ] as const
            ).map((b) => (
              <button
                key={b.id}
                onClick={() => onChangeBasis(b.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  basis === b.id
                    ? 'bg-white text-[#0F4C81] shadow-sm border border-[#E2E8F0]'
                    : 'text-[#475569] hover:text-[#0F172A]'
                }`}
              >
                {b.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1 p-1 bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg">
            <button
              onClick={() => setAwardMode('package')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                awardMode === 'package'
                  ? 'bg-white text-[#0F172A] shadow-sm border border-[#E2E8F0]'
                  : 'text-[#475569] hover:text-[#0F172A]'
              }`}
            >
              Full Package L1/L2/L3
            </button>
            <button
              onClick={() => setAwardMode('split')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                awardMode === 'split'
                  ? 'bg-white text-[#0F172A] shadow-sm border border-[#E2E8F0]'
                  : 'text-[#475569] hover:text-[#0F172A]'
              }`}
            >
              Split-Award Simulator
            </button>
          </div>

          <label className="flex items-center gap-2 text-xs text-[#475569] cursor-pointer px-2">
            <input
              type="checkbox"
              checked={discrepanciesOnly}
              onChange={(e) => setDiscrepanciesOnly(e.target.checked)}
              className="rounded border-[#CBD5E1]"
            />
            <span>Discrepancies & UOM conversions only</span>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            onClick={onExportExcel}
            className="px-3 py-1.5 text-xs font-medium text-[#0F172A] bg-white border border-[#E2E8F0] rounded-md hover:bg-[#F8FAFC] whitespace-nowrap flex items-center gap-1.5"
          >
            <FileSpreadsheet className="w-3.5 h-3.5 text-[#059669]" />
            <span>Export CS Excel</span>
          </button>
          <button
            onClick={onExportPdf}
            className="px-3 py-1.5 text-xs font-medium text-[#0F172A] bg-white border border-[#E2E8F0] rounded-md hover:bg-[#F8FAFC] whitespace-nowrap flex items-center gap-1.5"
          >
            <FileText className="w-3.5 h-3.5 text-[#0F4C81]" />
            <span>Export CS PDF</span>
          </button>
          <button
            onClick={handleRecommendClick}
            disabled={Boolean(activeBlockReason)}
            className="px-3.5 py-1.5 text-xs font-medium text-white bg-[#0F4C81] rounded-md hover:bg-[#0A365C] disabled:opacity-50 whitespace-nowrap"
            title={activeBlockReason || 'Proceed to award approval'}
          >
            {awardMode === 'split'
              ? `Proceed with Split Award (${formatMoney(splitTotalLanded, rfq.currency)})`
              : 'Recommend Award'}
          </button>
        </div>
      </div>

      {activeBlockReason && (
        <div className="p-3 bg-[#FFFBEB] border border-[#FDE68A] text-[#92400E] text-xs rounded-md flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-[#D97706] shrink-0" />
          <span>{activeBlockReason}.</span>
        </div>
      )}

      {!l1Eligible && (
        <div className="p-3 bg-[#FFFBEB] border border-[#FDE68A] text-[#92400E] text-xs rounded-md flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-[#D97706] shrink-0" />
          <span>
            No quotation is currently complete, quantity-sufficient, commercially confirmed, and verified. Incomplete, short-quantity, unconfirmed-freight, or unverified quotes are excluded from L1 ranking until audited.
          </span>
        </div>
      )}

      {/* Main Comparison Matrix Table */}
      <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                <th className="sticky left-0 z-20 bg-[#F8FAFC] py-3 px-4 min-w-[260px] border-r border-[#E2E8F0] align-top">
                  <div className="text-xs font-semibold text-[#0F172A]">
                    RFQ Line Item & Benchmark
                  </div>
                  <div className="text-[11px] text-[#475569] mt-0.5">
                    Qty · UOM · Last Awarded Rate
                  </div>
                </th>

                {rankedQuotes.map((rk) => {
                  const q = rk.quotation;
                  const sup = getSupplier(q.supplierId);
                  const total = rk.totalForBasis;
                  const delta = total - baselineTotal;
                  const deltaPct = baselineTotal > 0 ? (delta / baselineTotal) * 100 : 0;
                  const isL1 = rk.rankIndex === 1;
                  const isSelectedPkg = awardMode === 'package' && activePackageId === q.id;
                  const mathErrCount = q.lines.filter((l) => !l.mathValid).length;
                  const unmappedCount = q.lines.filter((l) => l.matchStatus === 'unmapped').length;

                  return (
                    <th
                      key={q.id}
                      onClick={() => awardMode === 'package' && setSelectedPackageQuoteId(q.id)}
                      className={`py-3 px-4 min-w-[235px] border-r border-[#E2E8F0] last:border-r-0 align-top transition-colors ${
                        awardMode === 'package' ? 'cursor-pointer' : ''
                      } ${isSelectedPkg ? 'bg-[#0F4C81]/5' : ''}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className={`font-mono text-xs font-bold ${
                            isL1
                              ? 'text-[#059669]'
                              : rk.eligibleForAwardRank
                              ? 'text-[#0F4C81]'
                              : 'text-[#D97706]'
                          }`}
                        >
                          {rk.rankLabel}
                          {isL1
                            ? ' · Lowest Verified'
                            : rk.eligibleForAwardRank
                            ? ` · ${formatPct(deltaPct)}`
                            : ' · Excluded'}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onInspectQuote(q.id);
                          }}
                          className="text-[11px] font-medium text-[#0F4C81] hover:underline flex items-center gap-1"
                        >
                          <Eye className="w-3 h-3" />
                          <span>Review</span>
                        </button>
                      </div>

                      <div className="text-sm font-bold text-[#0F172A] mt-1 truncate">
                        {sup?.name || 'Supplier'}
                      </div>

                      <div className="font-mono tabular-nums text-lg font-bold text-[#0F172A] mt-1">
                        {formatMoney(total, rfq.currency)}
                      </div>

                      <div className="text-[11px] text-[#475569] mt-1 font-normal space-y-0.5">
                        <div className="font-mono tabular-nums">
                          {rk.eligibleForAwardRank
                            ? isL1
                              ? 'Baseline L1'
                              : `${delta >= 0 ? '+' : ''}${formatMoney(delta, rfq.currency)} vs L1`
                            : `${Math.round(q.completenessRatio * 100)}% BOM coverage`}
                        </div>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {q.isVerified ? (
                            <span className="text-[#059669] font-medium flex items-center gap-1">
                              <CheckCircle2 className="w-3 h-3" /> Verified
                            </span>
                          ) : (
                            <span className="text-[#D97706] font-medium flex items-center gap-1">
                              <AlertTriangle className="w-3 h-3" /> Needs Review
                            </span>
                          )}
                          {mathErrCount > 0 && (
                            <span className="text-[#DC2626] font-semibold">
                              · {mathErrCount} Math Mismatch
                            </span>
                          )}
                          {unmappedCount > 0 && (
                            <span className="text-[#D97706]">· {unmappedCount} Unmapped</span>
                          )}
                          {q.missingFreightWarning && (
                            <span className="text-[#D97706]">· Freight To-Pay</span>
                          )}
                        </div>
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>

            <tbody className="divide-y divide-[#E2E8F0] text-xs">
              {visibleItems.map((item) => {
                const lastPaid = getLastPaidPrice(item);

                let minRowUnit = Infinity;
                for (const q of sortedQuotes) {
                  const l = q.lines.find((ql) => ql.rfqItemId === item.id);
                  const qtyOk = l ? isLineQuantitySufficient(l, item).ok : false;
                  const val =
                    l && l.matchStatus !== 'not_quoted' && l.matchStatus !== 'unmapped' && l.mathValid && qtyOk
                      ? getLineUnitForBasis(l)
                      : null;
                  if (val !== null && val < minRowUnit) minRowUnit = val;
                }

                const splitSelectedQid = getEffectiveSplitQuoteForItem(item.id);

                return (
                  <tr key={item.id} className="hover:bg-[#F8FAFC]/80">
                    <td className="sticky left-0 z-10 bg-white py-3 px-4 border-r border-[#E2E8F0] align-top">
                      <div className="font-medium text-[#0F172A]">
                        <span className="font-mono text-[#475569] mr-1.5">#{item.lineNo}</span>
                        {item.description}
                      </div>
                      <div className="text-[11px] text-[#475569] mt-1 font-mono tabular-nums">
                        {item.skuCode ? `${item.skuCode} · ` : ''}
                        {item.quantity} {item.uom}
                        {lastPaid !== null && (
                          <span className="text-[#0F4C81]">
                            {' '}
                            · Last Paid: {formatMoney(lastPaid, rfq.currency)}
                          </span>
                        )}
                      </div>
                    </td>

                    {sortedQuotes.map((q) => {
                      const line = q.lines.find((l) => l.rfqItemId === item.id);
                      const sup = getSupplier(q.supplierId);

                      if (!line || line.matchStatus === 'not_quoted' || line.quotedUnitRate === null) {
                        return (
                          <td
                            key={q.id}
                            className="py-3 px-4 border-r border-[#E2E8F0] last:border-r-0 align-top bg-[#FFFBEB]/40"
                          >
                            <div className="text-[#D97706] font-medium flex items-center gap-1">
                              <AlertTriangle className="w-3.5 h-3.5" />
                              <span>Not Quoted</span>
                            </div>
                            <div className="text-[11px] text-[#475569] mt-0.5">
                              Omitted in {q.quoteReference}
                            </div>
                          </td>
                        );
                      }

                      const unitVal = getLineUnitForBasis(line);
                      const qtyCheck = isLineQuantitySufficient(line, item);
                      const lineSelectable =
                        line.mathValid && line.matchStatus !== 'unmapped' && qtyCheck.ok;
                      const isRowBest =
                        lineSelectable &&
                        unitVal !== null &&
                        Math.abs(unitVal - minRowUnit) < 0.01;
                      const vsLastPaid =
                        lastPaid && unitVal ? ((unitVal - lastPaid) / lastPaid) * 100 : null;
                      const isSplitChosen = awardMode === 'split' && splitSelectedQid === q.id;

                      return (
                        <td
                          key={q.id}
                          onClick={() => {
                            if (awardMode === 'split' && lineSelectable) {
                              setSplitSelection((prev) => ({ ...prev, [item.id]: q.id }));
                            }
                          }}
                          className={`py-3 px-4 border-r border-[#E2E8F0] last:border-r-0 align-top transition-colors ${
                            awardMode === 'split' && lineSelectable ? 'cursor-pointer' : ''
                          } ${
                            isSplitChosen
                              ? 'bg-[#0F4C81]/10 ring-1 ring-inset ring-[#0F4C81]'
                              : isRowBest
                              ? 'bg-[#ECFDF5]/60'
                              : !line.mathValid
                              ? 'bg-[#FEF2F2]/60'
                              : !qtyCheck.ok
                              ? 'bg-[#FFFBEB]/60'
                              : ''
                          }`}
                        >
                          <div className="flex items-baseline justify-between gap-2">
                            <span
                              className={`font-mono tabular-nums text-sm font-bold ${
                                !line.mathValid
                                  ? 'text-[#DC2626]'
                                  : isRowBest
                                  ? 'text-[#059669]'
                                  : 'text-[#0F172A]'
                              }`}
                            >
                              {formatMoney(unitVal, rfq.currency)}
                              <span className="text-[11px] font-normal text-[#475569]">
                                /{item.uom}
                              </span>
                            </span>

                            {awardMode === 'split' && (
                              <input
                                type="radio"
                                name={`split-${item.id}`}
                                disabled={!lineSelectable}
                                checked={isSplitChosen}
                                onChange={() =>
                                  setSplitSelection((prev) => ({ ...prev, [item.id]: q.id }))
                                }
                                className="text-[#0F4C81]"
                              />
                            )}
                          </div>

                          <div className="text-[11px] text-[#475569] mt-1 font-mono tabular-nums space-y-0.5">
                            <div>
                              Line: {formatMoney((unitVal ?? 0) * item.quantity, rfq.currency)}
                            </div>

                            {!qtyCheck.ok && (
                              <div className="text-[#D97706] font-semibold">
                                Short Qty: {qtyCheck.convertedQty} / {item.quantity} {item.uom}
                              </div>
                            )}

                            {line.uomConversionFactor !== 1 && (
                              <div className="text-[#0F4C81]">
                                Quoted {formatMoney(line.quotedUnitRate, q.currency)}/{line.quotedUom} (÷{line.uomConversionFactor})
                              </div>
                            )}

                            {vsLastPaid !== null && (
                              <div
                                className={
                                  vsLastPaid > 2
                                    ? 'text-[#DC2626]'
                                    : vsLastPaid < -0.5
                                    ? 'text-[#059669]'
                                    : 'text-[#475569]'
                                }
                              >
                                {formatPct(vsLastPaid)} vs Last Paid
                              </div>
                            )}

                            <div className="flex items-center justify-between gap-2 pt-0.5">
                              {!line.mathValid ? (
                                <span className="text-[#DC2626] font-sans font-semibold">
                                  Math Mismatch
                                </span>
                              ) : !qtyCheck.ok ? (
                                <span className="text-[#D97706] font-sans font-semibold">
                                  Insufficient Qty
                                </span>
                              ) : line.matchStatus === 'alternate_spec' ? (
                                <span className="text-[#D97706] font-sans font-medium">
                                  Alternate Spec
                                </span>
                              ) : isRowBest ? (
                                <span className="text-[#059669] font-sans font-medium">
                                  Row L1 Best
                                </span>
                              ) : (
                                <span />
                              )}

                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setInspectedCell({
                                    supplierName: sup?.name || 'Supplier',
                                    line,
                                    quoteId: q.id,
                                  });
                                }}
                                className="font-sans text-[11px] text-[#0F4C81] hover:underline"
                              >
                                Source
                              </button>
                            </div>
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}

              <tr className="bg-[#F8FAFC] font-medium">
                <td className="sticky left-0 z-10 bg-[#F8FAFC] py-2.5 px-4 border-r border-[#E2E8F0] text-[#0F172A]">
                  Freight, P&F & Discounts ({rfq.currency})
                </td>
                {sortedQuotes.map((q) => {
                  const fx = q.exchangeRateToRfq > 0 ? q.exchangeRateToRfq : 1;
                  const overhead =
                    (q.freightCharges + q.packingForwarding + q.otherCharges - q.globalDiscount) *
                    fx;
                  return (
                    <td
                      key={q.id}
                      className="py-2.5 px-4 border-r border-[#E2E8F0] last:border-r-0 font-mono tabular-nums text-[#0F172A]"
                    >
                      {formatMoney(overhead, rfq.currency)}
                      <div className="text-[11px] font-sans font-normal text-[#475569]">
                        Freight: {formatMoney(q.freightCharges * fx, rfq.currency)} · P&F:{' '}
                        {formatMoney(q.packingForwarding * fx, rfq.currency)}
                        {q.globalDiscount > 0 &&
                          ` · Disc: -${formatMoney(q.globalDiscount * fx, rfq.currency)}`}
                      </div>
                    </td>
                  );
                })}
              </tr>

              <tr className="bg-[#F8FAFC]">
                <td className="sticky left-0 z-10 bg-[#F8FAFC] py-2.5 px-4 border-r border-[#E2E8F0] font-medium text-[#0F172A]">
                  Delivery Lead Time
                </td>
                {sortedQuotes.map((q) => (
                  <td
                    key={q.id}
                    className="py-2.5 px-4 border-r border-[#E2E8F0] last:border-r-0 font-mono tabular-nums text-[#0F172A]"
                  >
                    {q.leadTimeDays !== null ? `${q.leadTimeDays} Days` : 'Not specified'}
                  </td>
                ))}
              </tr>

              <tr className="bg-[#F8FAFC]">
                <td className="sticky left-0 z-10 bg-[#F8FAFC] py-2.5 px-4 border-r border-[#E2E8F0] font-medium text-[#0F172A]">
                  Payment Terms & Tax Basis
                </td>
                {sortedQuotes.map((q) => (
                  <td
                    key={q.id}
                    className="py-2.5 px-4 border-r border-[#E2E8F0] last:border-r-0 text-[#0F172A]"
                  >
                    <div>{q.paymentTerms || 'Not specified'}</div>
                    <div className="text-[11px] text-[#475569]">
                      {q.taxIncludedInRates ? 'Quoted GST/VAT Inclusive' : 'Quoted GST/VAT Extra'}
                    </div>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {inspectedCell && (
        <div className="bg-white border border-[#0F4C81]/40 rounded-lg p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-xs font-semibold text-[#0F172A] flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5 text-[#0F4C81]" />
              <span>Source Trace — {inspectedCell.supplierName}</span>
            </div>
            <div className="font-mono text-xs text-[#475569]">
              {inspectedCell.line.sourceTrace.snippet}
            </div>
            <div className="text-[11px] text-[#475569]">
              {inspectedCell.line.sourceTrace.sheet
                ? `Excel Cell: ${inspectedCell.line.sourceTrace.sheet}!${inspectedCell.line.sourceTrace.cell}`
                : `Document Page ${inspectedCell.line.sourceTrace.page ?? 1}`}
              {' · '}Confidence: {Math.round(inspectedCell.line.confidenceScore * 100)}%
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => onInspectQuote(inspectedCell.quoteId)}
              className="px-3 py-1.5 text-xs font-medium text-white bg-[#0F4C81] rounded-md"
            >
              Open Split-Pane Viewer
            </button>
            <button
              onClick={() => setInspectedCell(null)}
              className="px-3 py-1.5 text-xs text-[#475569] hover:text-[#0F172A]"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
