import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  FilePlus2,
  Sparkles,
} from 'lucide-react';
import { AwardDecision, Quotation, Rfq, Supplier } from '../types.ts';
import { formatDateShort, formatMoney, rfqStatusLabel } from '../lib/format.ts';

interface DashboardViewProps {
  rfqs: Rfq[];
  quotations: Quotation[];
  suppliers: Supplier[];
  awards: AwardDecision[];
  defaultCurrency: string;
  onOpenRfq: (rfqId: string, tab?: 'overview' | 'upload' | 'review' | 'compare' | 'approval', quoteId?: string) => void;
  onNewRfq: () => void;
  onLoadSample: () => Promise<void>;
  loadingSample: boolean;
}

export function DashboardView({
  rfqs,
  quotations,
  suppliers,
  awards,
  defaultCurrency,
  onOpenRfq,
  onNewRfq,
  onLoadSample,
  loadingSample,
}: DashboardViewProps) {
  const activeRfqs = rfqs.filter((r) => r.status !== 'closed' && r.status !== 'awarded');
  const quotesPendingReview = quotations.filter((q) => !q.isVerified);
  const pendingApprovals = awards.filter((a) => a.approvalStatus === 'pending');

  // Evaluated savings: sum of (mean quote landed total - lowest L1 landed total) across active/awarded RFQs with >=2 quotes
  let evaluatedSavings = 0;
  for (const rfq of rfqs) {
    const rq = quotations.filter((q) => q.rfqId === rfq.id && q.totalLandedCost > 0);
    if (rq.length >= 2) {
      const min = Math.min(...rq.map((q) => q.totalLandedCost));
      const mean = rq.reduce((s, q) => s + q.totalLandedCost, 0) / rq.length;
      if (mean > min) evaluatedSavings += mean - min;
    }
  }

  const getSupplierName = (id: string) =>
    suppliers.find((s) => s.id === id)?.name || 'Unknown Supplier';

  return (
    <div className="space-y-6">
      {/* Top Bar Contract: Breadcrumb on left, 1-2 primary actions on right */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-[#E2E8F0]">
        <div>
          <div className="text-xs text-[#475569]">Workspace / Command Center</div>
          <h1 className="font-display text-2xl font-bold text-[#0F172A] mt-1">
            Pre-PO Quotation Command Center
          </h1>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={onLoadSample}
            disabled={loadingSample}
            className="px-4 py-2 text-sm font-medium text-[#0F4C81] bg-white border border-[#E2E8F0] rounded-lg hover:bg-[#F8FAFC] transition-colors whitespace-nowrap shrink-0 flex items-center gap-2 disabled:opacity-50"
          >
            <Sparkles className="w-4 h-4" />
            <span>{loadingSample ? 'Loading...' : 'Load Sample RFQ'}</span>
          </button>
          <button
            onClick={onNewRfq}
            className="px-4 py-2 text-sm font-medium text-white bg-[#0F4C81] rounded-lg hover:bg-[#0A365C] transition-colors whitespace-nowrap shrink-0 flex items-center gap-2"
          >
            <FilePlus2 className="w-4 h-4" />
            <span>Create RFQ</span>
          </button>
        </div>
      </div>

      {/* Top KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-[#E2E8F0] rounded-lg p-4">
          <div className="text-xs font-medium text-[#475569]">Active RFQs</div>
          <div className="font-mono tabular-nums text-2xl font-bold text-[#0F172A] mt-1.5">
            {activeRfqs.length}
          </div>
          <div className="text-xs text-[#475569] mt-1">
            {rfqs.length} total · {rfqs.filter((r) => r.status === 'awarded').length} awarded
          </div>
        </div>

        <div className="bg-white border border-[#E2E8F0] rounded-lg p-4">
          <div className="text-xs font-medium text-[#475569]">Quotes Pending Verification</div>
          <div className="font-mono tabular-nums text-2xl font-bold text-[#D97706] mt-1.5">
            {quotesPendingReview.length}
          </div>
          <div className="text-xs text-[#475569] mt-1">
            {quotations.filter((q) => q.lines.some((l) => !l.mathValid)).length} with math mismatch
          </div>
        </div>

        <div className="bg-white border border-[#E2E8F0] rounded-lg p-4">
          <div className="text-xs font-medium text-[#475569]">Pending Approvals</div>
          <div className="font-mono tabular-nums text-2xl font-bold text-[#0F172A] mt-1.5">
            {pendingApprovals.length}
          </div>
          <div className="text-xs text-[#475569] mt-1">Awaiting MD / approver sign-off</div>
        </div>

        <div className="bg-white border border-[#E2E8F0] rounded-lg p-4">
          <div className="text-xs font-medium text-[#475569]">Evaluated Savings (L1 vs Mean)</div>
          <div className="font-mono tabular-nums text-2xl font-bold text-[#059669] mt-1.5">
            {formatMoney(evaluatedSavings, defaultCurrency, 0)}
          </div>
          <div className="text-xs text-[#475569] mt-1">Normalized landed cost delta</div>
        </div>
      </div>

      {/* Action Queue: Needs Your Attention */}
      <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
        <div className="px-5 py-3.5 border-b border-[#E2E8F0] flex items-center justify-between">
          <div>
            <h2 className="font-display text-base font-semibold text-[#0F172A]">
              Needs Your Attention
            </h2>
            <p className="text-xs text-[#475569]">
              Extracted quotations with arithmetic discrepancies, omitted freight, or unverified lines
            </p>
          </div>
          <span className="font-mono tabular-nums text-xs text-[#475569]">
            {quotesPendingReview.length + pendingApprovals.length} items
          </span>
        </div>

        {quotesPendingReview.length === 0 && pendingApprovals.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-[#475569]">
            All uploaded quotations are verified and reconciled. Create a new RFQ or upload supplier quotes to continue.
          </div>
        ) : (
          <div className="divide-y divide-[#E2E8F0]">
            {quotesPendingReview.map((quote) => {
              const parentRfq = rfqs.find((r) => r.id === quote.rfqId);
              const mathErrors = quote.lines.filter((l) => !l.mathValid).length;
              const missingLines = quote.lines.filter((l) => l.matchStatus === 'not_quoted').length;
              return (
                <div
                  key={quote.id}
                  className="px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-[#F8FAFC] transition-colors"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium text-[#0F172A]">
                      {mathErrors > 0 ? (
                        <AlertTriangle className="w-4 h-4 text-[#DC2626] shrink-0" />
                      ) : (
                        <Clock className="w-4 h-4 text-[#D97706] shrink-0" />
                      )}
                      <span className="truncate">
                        {getSupplierName(quote.supplierId)} — {quote.documentName}
                      </span>
                    </div>
                    <div className="text-xs text-[#475569] mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-mono">{parentRfq?.rfqNumber}</span>
                      <span aria-hidden="true">·</span>
                      {mathErrors > 0 && (
                        <span className="text-[#DC2626] font-medium">
                          {mathErrors} arithmetic mismatch
                        </span>
                      )}
                      {missingLines > 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-[#D97706] font-medium">
                            {missingLines} unquoted item(s)
                          </span>
                        </>
                      )}
                      {quote.missingFreightWarning && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-[#D97706] font-medium">
                            Freight omitted / To-Pay
                          </span>
                        </>
                      )}
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">
                        Landed: {formatMoney(quote.totalLandedCost, parentRfq?.currency || 'INR')}
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={() => onOpenRfq(quote.rfqId, 'review', quote.id)}
                    className="px-3 py-1.5 text-xs font-medium text-[#0F4C81] bg-[#0F4C81]/10 rounded-md hover:bg-[#0F4C81]/15 transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 self-start sm:self-center"
                  >
                    <span>Verify Source</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}

            {pendingApprovals.map((award) => {
              const parentRfq = rfqs.find((r) => r.id === award.rfqId);
              return (
                <div
                  key={award.id}
                  className="px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-[#F8FAFC] transition-colors"
                >
                  <div>
                    <div className="flex items-center gap-2 text-sm font-medium text-[#0F172A]">
                      <CheckCircle2 className="w-4 h-4 text-[#0F4C81] shrink-0" />
                      <span>Award Recommendation Ready for Approval — {parentRfq?.rfqNumber}</span>
                    </div>
                    <div className="text-xs text-[#475569] mt-1">
                      Recommended by {award.recommendedBy} · Total Landed:{' '}
                      <span className="font-mono tabular-nums font-medium text-[#0F172A]">
                        {formatMoney(award.totalAwardedLanded, parentRfq?.currency || 'INR')}
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={() => onOpenRfq(award.rfqId, 'approval')}
                    className="px-3 py-1.5 text-xs font-medium text-white bg-[#0F4C81] rounded-md hover:bg-[#0A365C] transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 self-start sm:self-center"
                  >
                    <span>Review Award</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Recent RFQs Table */}
      <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
        <div className="px-5 py-3.5 border-b border-[#E2E8F0] flex items-center justify-between">
          <h2 className="font-display text-base font-semibold text-[#0F172A]">
            Recent RFQs & Comparison Matrix
          </h2>
          <span className="text-xs text-[#475569]">Click any RFQ to inspect quotes or compare landed cost</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-xs font-medium text-[#475569]">
                <th className="py-2.5 px-4">RFQ #</th>
                <th className="py-2.5 px-4">Title</th>
                <th className="py-2.5 px-4 text-right">Items</th>
                <th className="py-2.5 px-4 text-right">Quotes</th>
                <th className="py-2.5 px-4 text-right">Best Landed (L1)</th>
                <th className="py-2.5 px-4">Deadline</th>
                <th className="py-2.5 px-4">Status</th>
                <th className="py-2.5 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0] text-sm">
              {rfqs.map((rfq) => {
                const rQuotes = quotations.filter((q) => q.rfqId === rfq.id);
                const ranked = rankQuotations(rQuotes, 'landed');
                const l1 = ranked.find((r) => r.rankIndex === 1);
                const bestLanded = l1 ? l1.totalForBasis : null;
                return (
                  <tr
                    key={rfq.id}
                    onClick={() => onOpenRfq(rfq.id, rQuotes.length > 0 ? 'compare' : 'upload')}
                    className="hover:bg-[#F8FAFC] cursor-pointer transition-colors"
                  >
                    <td className="py-3 px-4 font-mono text-xs font-semibold text-[#0F4C81] whitespace-nowrap">
                      {rfq.rfqNumber}
                    </td>
                    <td className="py-3 px-4 font-medium text-[#0F172A] max-w-xs truncate">
                      {rfq.title}
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums text-right text-[#475569]">
                      {rfq.items.length}
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums text-right text-[#475569]">
                      {rQuotes.length} / {Math.max(rQuotes.length, rfq.invitedSupplierIds.length)}
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums text-right font-semibold text-[#0F172A] whitespace-nowrap">
                      {bestLanded !== null
                        ? formatMoney(bestLanded, rfq.currency)
                        : rQuotes.length > 0
                        ? 'Pending Audit'
                        : '—'}
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-[#475569] whitespace-nowrap">
                      {formatDateShort(rfq.deadlineDate)}
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      <span
                        className={`text-xs font-medium ${
                          rfq.status === 'awarded' || rfq.status === 'approved'
                            ? 'text-[#059669]'
                            : rfq.status === 'pending_approval'
                            ? 'text-[#0F4C81]'
                            : 'text-[#D97706]'
                        }`}
                      >
                        {rfqStatusLabel(rfq.status)}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenRfq(rfq.id, rQuotes.length > 0 ? 'compare' : 'upload');
                        }}
                        className="text-xs font-medium text-[#0F4C81] hover:underline"
                      >
                        {rQuotes.length > 0 ? 'Compare Matrix' : 'Upload Quotes'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
