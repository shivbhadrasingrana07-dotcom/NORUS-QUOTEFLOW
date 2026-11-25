import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ClipboardCheck,
  Copy,
  FileSpreadsheet,
  FileText,
  Mail,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  AuditLogEntry,
  AwardAllocation,
  AwardDecision,
  CatalogItem,
  CostBasis,
  OrganizationSettings,
  Quotation,
  QuotationLine,
  Rfq,
  Supplier,
} from '../types.ts';
import { formatDateShort, formatMoney, rfqStatusLabel } from '../lib/format.ts';
import { exportComparativeStatementExcel, exportComparativeStatementPdf } from '../lib/exporters.ts';
import { isLineQuantitySufficient } from '../lib/awardValidation.ts';
import { rankQuotations } from '../lib/ranking.ts';
import { ExtractionReviewPane } from './ExtractionReviewPane.tsx';
import { ComparisonMatrixPane } from './ComparisonMatrixPane.tsx';

export type RfqTab = 'overview' | 'upload' | 'review' | 'compare' | 'approval';

interface RfqWorkspaceProps {
  rfq: Rfq;
  quotes: Quotation[];
  suppliers: Supplier[];
  catalogItems: CatalogItem[];
  awards: AwardDecision[];
  auditLogs: AuditLogEntry[];
  settings: OrganizationSettings;
  activeTab: RfqTab;
  selectedQuoteId: string | null;
  onChangeTab: (tab: RfqTab) => void;
  onSelectQuote: (id: string) => void;
  onBack: () => void;
  onExtractQuote: (params: {
    rfqId: string;
    supplierId: string;
    file?: File;
    rawEmailText?: string;
  }) => Promise<Quotation>;
  onUpdateHeader: (quoteId: string, patch: Partial<Quotation>) => Promise<void>;
  onUpdateLine: (quoteId: string, lineId: string, patch: Partial<QuotationLine>) => Promise<void>;
  onVerifyQuote: (quoteId: string) => Promise<void>;
  onDeleteQuote: (quoteId: string) => Promise<void>;
  onSubmitAward: (params: {
    rfqId: string;
    isSplitAward: boolean;
    allocations: AwardAllocation[];
    totalAwardedLanded: number;
    isNonL1: boolean;
    nonL1Justification: string;
    acceptedAlternateLineIds: string[];
    commercialExceptionAccepted: boolean;
  }) => Promise<void>;
  onDecideAward: (
    awardId: string,
    decision: 'approved' | 'rejected',
    approverNotes: string
  ) => Promise<void>;
  onWithdrawAward: (awardId: string) => Promise<void>;
  demoMode?: boolean;
  demoSessionId?: string | null;
}

export function RfqWorkspace({
  rfq,
  quotes,
  suppliers,
  catalogItems,
  awards,
  auditLogs,
  settings,
  activeTab,
  selectedQuoteId,
  onChangeTab,
  onSelectQuote,
  onBack,
  onExtractQuote,
  onUpdateHeader,
  onUpdateLine,
  onVerifyQuote,
  onDeleteQuote,
  onSubmitAward,
  onDecideAward,
  onWithdrawAward,
  demoMode = false,
  demoSessionId = null,
}: RfqWorkspaceProps) {
  const [basis, setBasis] = useState<CostBasis>('landed');
  const [copiedInvite, setCopiedInvite] = useState(false);

  // Upload state
  const [uploadSupplierId, setUploadSupplierId] = useState<string>(
    rfq.invitedSupplierIds[0] || suppliers[0]?.id || ''
  );
  const [uploadMode, setUploadMode] = useState<'file' | 'email'>('file');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [rawEmailText, setRawEmailText] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Award draft state
  const [draftAward, setDraftAward] = useState<{
    isSplitAward: boolean;
    allocations: AwardAllocation[];
    totalAwardedLanded: number;
    isNonL1: boolean;
  } | null>(null);
  const [nonL1Justification, setNonL1Justification] = useState('');
  const [acceptedAlternateLineIds, setAcceptedAlternateLineIds] = useState<string[]>([]);
  const [commercialExceptionAccepted, setCommercialExceptionAccepted] = useState(false);
  const [approverNotes, setApproverNotes] = useState('');
  const [awardBusy, setAwardBusy] = useState(false);
  const [awardError, setAwardError] = useState<string | null>(null);
  const [showRevisionForm, setShowRevisionForm] = useState(false);
  const [deletingQuoteId, setDeletingQuoteId] = useState<string | null>(null);

  const quotesSignature = quotes
    .map(
      (q) =>
        `${q.id}:${q.totalLandedCost}:${q.isVerified}:${q.missingFreightWarning}:${q.lines
          .map((l) => `${l.id}:${l.matchStatus}:${l.quotedQty}:${l.uomConversionFactor}`)
          .join(',')}`
    )
    .join('|');

  // Reset per-RFQ transient state when switching RFQs
  useEffect(() => {
    setDraftAward(null);
    setNonL1Justification('');
    setAcceptedAlternateLineIds([]);
    setCommercialExceptionAccepted(false);
    setApproverNotes('');
    setAwardError(null);
    setUploadError(null);
    setShowRevisionForm(false);
    setUploadSupplierId(rfq.invitedSupplierIds[0] || suppliers[0]?.id || '');
  }, [rfq.id]);

  // Clear stale draft award simulation if underlying quote numbers/verification change
  useEffect(() => {
    setDraftAward(null);
    setAcceptedAlternateLineIds([]);
    setCommercialExceptionAccepted(false);
  }, [rfq.id, quotesSignature]);

  const rfqAwards = awards
    .filter((a) => a.rfqId === rfq.id)
    .slice()
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const approvedAward = rfqAwards.find((a) => a.approvalStatus === 'approved') || null;
  const pendingAward = rfqAwards.find((a) => a.approvalStatus === 'pending') || null;
  const rejectedAwards = rfqAwards.filter((a) => a.approvalStatus === 'rejected');
  const activeAward = approvedAward || pendingAward;

  const editLockedQuoteIds = new Set<string>();
  const deleteLockedQuoteIds = new Set<string>();
  for (const aw of rfqAwards) {
    for (const al of aw.allocations) {
      deleteLockedQuoteIds.add(al.quotationId);
      if (aw.approvalStatus === 'approved' || aw.approvalStatus === 'pending') {
        editLockedQuoteIds.add(al.quotationId);
      }
    }
  }

  const canWithdrawPending =
    demoMode || ['owner', 'admin', 'buyer'].includes(settings.activeUserRole);
  const canDecidePending =
    demoMode || ['owner', 'admin', 'approver'].includes(settings.activeUserRole);

  const getSupplierName = (id: string) =>
    suppliers.find((s) => s.id === id)?.name || 'Unknown Supplier';

  const whatsappInviteText = `Hello, please share your quotation for ${rfq.rfqNumber}: ${rfq.title}.\nDelivery: ${rfq.incoterms} (${rfq.deliveryLocation})\nQuote Deadline: ${rfq.deadlineDate}\n\nItems:\n${rfq.items
    .map((it) => `${it.lineNo}. ${it.description} — Qty: ${it.quantity} ${it.uom}`)
    .join('\n')}\n\nPlease mention GST %, Freight, P&F, Lead Time & Payment Terms clearly.`;

  const handleCopyInvite = () => {
    navigator.clipboard.writeText(whatsappInviteText);
    setCopiedInvite(true);
    setTimeout(() => setCopiedInvite(false), 2000);
  };

  const handleExtractSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setUploadError(null);
    if (!uploadSupplierId) {
      setUploadError('Select the supplier who sent this quotation.');
      return;
    }
    if (uploadMode === 'file' && !selectedFile) {
      setUploadError('Select a PDF, Excel (.xlsx/.csv), or Image (.png/.jpg) file.');
      return;
    }
    if (uploadMode === 'email' && !rawEmailText.trim()) {
      setUploadError('Paste the supplier quotation email or WhatsApp text.');
      return;
    }

    try {
      setExtracting(true);
      const created = await onExtractQuote({
        rfqId: rfq.id,
        supplierId: uploadSupplierId,
        file: uploadMode === 'file' ? selectedFile || undefined : undefined,
        rawEmailText: uploadMode === 'email' ? rawEmailText.trim() : undefined,
      });
      setSelectedFile(null);
      setRawEmailText('');
      onSelectQuote(created.id);
      onChangeTab('review');
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Extraction failed.');
    } finally {
      setExtracting(false);
    }
  };

  // Default award payload if user opens Approval tab directly (uses verified-complete L1 if available)
  const rankedQuotes = rankQuotations(quotes, 'landed', rfq);
  const l1EligibleQuote = rankedQuotes.find((r) => r.rankIndex === 1)?.quotation || null;
  const effectiveDraft =
    draftAward ||
    (l1EligibleQuote
      ? {
          isSplitAward: false,
          allocations: rfq.items
            .map((item) => {
              const line = l1EligibleQuote.lines.find((l) => l.rfqItemId === item.id);
              if (
                !line ||
                line.matchStatus === 'not_quoted' ||
                line.matchStatus === 'unmapped' ||
                !line.mathValid ||
                line.normalizedUnitLanded === null ||
                !isLineQuantitySufficient(line, item).ok
              ) {
                return null;
              }
              return {
                rfqItemId: item.id,
                quotationId: l1EligibleQuote.id,
                quotationLineId: line.id,
                supplierId: l1EligibleQuote.supplierId,
                awardedQty: item.quantity,
                awardedUnitLanded: line.normalizedUnitLanded,
              };
            })
            .filter((x): x is AwardAllocation => x !== null),
          totalAwardedLanded: l1EligibleQuote.totalLandedCost,
          isNonL1: false,
        }
      : null);

  const selectedQuotesInDraft = effectiveDraft
    ? Array.from(new Set(effectiveDraft.allocations.map((a) => a.quotationId)))
        .map((id) => quotes.find((q) => q.id === id))
        .filter((q): q is Quotation => Boolean(q))
    : [];
  const draftMissingFreightQuotes = selectedQuotesInDraft.filter((q) => q.missingFreightWarning);
  const draftAlternateLines = effectiveDraft
    ? effectiveDraft.allocations
        .map((al) => {
          const q = quotes.find((itemQ) => itemQ.id === al.quotationId);
          const l = q?.lines.find((itemL) => itemL.id === al.quotationLineId);
          if (!q || !l || l.matchStatus !== 'alternate_spec') return null;
          return {
            lineId: l.id,
            description: l.rawDescription,
            supplierName: getSupplierName(q.supplierId),
          };
        })
        .filter((x): x is { lineId: string; description: string; supplierName: string } => Boolean(x))
    : [];
  const draftHasUnverifiedQuote = selectedQuotesInDraft.some((q) => !q.isVerified);
  const draftIncompleteBom = Boolean(
    effectiveDraft && effectiveDraft.allocations.length !== rfq.items.length
  );
  const draftRequiresJustification = Boolean(
    effectiveDraft &&
      (effectiveDraft.isNonL1 ||
        draftMissingFreightQuotes.length > 0 ||
        draftAlternateLines.length > 0)
  );
  const allDraftAlternatesAccepted = draftAlternateLines.every((a) =>
    acceptedAlternateLineIds.includes(a.lineId)
  );
  const draftSubmitBlocked = Boolean(
    draftHasUnverifiedQuote ||
      draftIncompleteBom ||
      (draftMissingFreightQuotes.length > 0 && !commercialExceptionAccepted) ||
      (draftAlternateLines.length > 0 && !allDraftAlternatesAccepted)
  );

  const handleRecommendSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!effectiveDraft) return;
    setAwardError(null);
    if (draftHasUnverifiedQuote) {
      setAwardError('All quotations included in an award must be verified in Extraction Review.');
      return;
    }
    if (draftIncompleteBom) {
      setAwardError('Award recommendation must cover 100% of RFQ items.');
      return;
    }
    if (draftMissingFreightQuotes.length > 0 && !commercialExceptionAccepted) {
      setAwardError(
        'Confirm freight terms in Extraction Review or accept the commercial exception before submitting.'
      );
      return;
    }
    if (draftAlternateLines.length > 0 && !allDraftAlternatesAccepted) {
      setAwardError(
        'Explicitly accept all alternate-specification line items before submitting.'
      );
      return;
    }
    if (draftRequiresJustification && !nonL1Justification.trim()) {
      setAwardError(
        'Written award justification is mandatory for non-L1, alternate-spec, or commercial-exception awards.'
      );
      return;
    }
    try {
      setAwardBusy(true);
      await onSubmitAward({
        rfqId: rfq.id,
        ...effectiveDraft,
        nonL1Justification,
        acceptedAlternateLineIds,
        commercialExceptionAccepted,
      });
      setDraftAward(null);
      setShowRevisionForm(false);
    } catch (err) {
      setAwardError(err instanceof Error ? err.message : 'Failed to submit recommendation');
    } finally {
      setAwardBusy(false);
    }
  };

  const handleDecision = async (decision: 'approved' | 'rejected') => {
    if (!pendingAward) return;
    setAwardError(null);
    try {
      setAwardBusy(true);
      await onDecideAward(pendingAward.id, decision, approverNotes);
      setApproverNotes('');
      setShowRevisionForm(false);
    } catch (err) {
      setAwardError(err instanceof Error ? err.message : 'Decision failed');
    } finally {
      setAwardBusy(false);
    }
  };

  const handleWithdraw = async () => {
    if (!pendingAward) return;
    setAwardError(null);
    try {
      setAwardBusy(true);
      await onWithdrawAward(pendingAward.id);
      setDraftAward(null);
      setShowRevisionForm(false);
    } catch (err) {
      setAwardError(err instanceof Error ? err.message : 'Unable to withdraw recommendation');
    } finally {
      setAwardBusy(false);
    }
  };

  const tabs: Array<{ id: RfqTab; label: string; count?: number }> = [
    { id: 'overview', label: 'Overview & BOM', count: rfq.items.length },
    { id: 'upload', label: 'Upload Quotes', count: quotes.length },
    { id: 'review', label: 'Extraction Review' },
    { id: 'compare', label: 'Compare Matrix' },
    { id: 'approval', label: 'Approval & Export' },
  ];

  return (
    <div className="space-y-5">
      {/* Top Breadcrumb + Action Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-[#E2E8F0]">
        <div>
          <button
            onClick={onBack}
            className="text-xs text-[#475569] hover:text-[#0F172A] flex items-center gap-1 mb-1.5"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back to RFQs</span>
          </button>
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="font-mono text-sm font-bold text-[#0F4C81]">{rfq.rfqNumber}</span>
            <span className="text-[#CBD5E1]">/</span>
            <h1 className="font-display text-xl font-bold text-[#0F172A]">{rfq.title}</h1>
          </div>
          <div className="text-xs text-[#475569] mt-1 flex flex-wrap items-center gap-x-2">
            <span>{rfqStatusLabel(rfq.status)}</span>
            <span aria-hidden="true">·</span>
            <span>{rfq.incoterms}</span>
            <span aria-hidden="true">·</span>
            <span>Deadline {formatDateShort(rfq.deadlineDate)}</span>
            <span aria-hidden="true">·</span>
            <span>{quotes.length} quote(s) received</span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() =>
              exportComparativeStatementExcel({
                rfq,
                quotes,
                suppliers,
                settings,
                auditLogs,
                award: activeAward || undefined,
              })
            }
            disabled={quotes.length === 0}
            className="px-3 py-2 text-xs font-medium text-[#0F172A] bg-white border border-[#E2E8F0] rounded-lg hover:bg-[#F8FAFC] disabled:opacity-40 whitespace-nowrap flex items-center gap-1.5"
          >
            <FileSpreadsheet className="w-3.5 h-3.5 text-[#059669]" />
            <span>CS Excel</span>
          </button>
          <button
            onClick={() =>
              exportComparativeStatementPdf({
                rfq,
                quotes,
                suppliers,
                settings,
                basis,
                award: activeAward || undefined,
              })
            }
            disabled={quotes.length === 0}
            className="px-3 py-2 text-xs font-medium text-white bg-[#0F4C81] rounded-lg hover:bg-[#0A365C] disabled:opacity-40 whitespace-nowrap flex items-center gap-1.5"
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Export CS PDF</span>
          </button>
        </div>
      </div>

      {/* Segmented Navigation Tabs */}
      <div className="flex items-center gap-1 p-1 bg-white border border-[#E2E8F0] rounded-lg overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => onChangeTab(t.id)}
            className={`px-3.5 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 flex items-center gap-2 ${
              activeTab === t.id
                ? 'bg-[#0F4C81] text-white'
                : 'text-[#475569] hover:text-[#0F172A] hover:bg-[#F8FAFC]'
            }`}
          >
            <span>{t.label}</span>
            {t.count !== undefined && (
              <span
                className={`font-mono tabular-nums text-[11px] ${
                  activeTab === t.id ? 'text-white/80' : 'text-[#475569]'
                }`}
              >
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* TAB 1: Overview & BOM */}
      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
          <div className="lg:col-span-2 bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
            <div className="px-5 py-3.5 border-b border-[#E2E8F0] flex items-center justify-between">
              <h2 className="font-display text-sm font-semibold text-[#0F172A]">
                RFQ Bill of Materials ({rfq.items.length} Lines)
              </h2>
              <span className="font-mono text-xs text-[#475569]">Currency: {rfq.currency}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-[#F8FAFC] border-b border-[#E2E8F0] text-[#475569]">
                    <th className="py-2.5 px-4">#</th>
                    <th className="py-2.5 px-4">SKU</th>
                    <th className="py-2.5 px-4">Description</th>
                    <th className="py-2.5 px-4 text-right">Qty</th>
                    <th className="py-2.5 px-4">UOM</th>
                    <th className="py-2.5 px-4 text-right">Last Paid / Target</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E2E8F0]">
                  {rfq.items.map((item) => {
                    const cat = catalogItems.find((c) => c.id === item.itemId);
                    const benchmark = cat?.lastAwardedUnitPrice ?? item.targetUnitPrice;
                    return (
                      <tr key={item.id}>
                        <td className="py-2.5 px-4 font-mono text-[#475569]">{item.lineNo}</td>
                        <td className="py-2.5 px-4 font-mono text-[#0F172A]">
                          {item.skuCode || '—'}
                        </td>
                        <td className="py-2.5 px-4 font-medium text-[#0F172A]">
                          {item.description}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums">
                          {item.quantity}
                        </td>
                        <td className="py-2.5 px-4 text-[#475569]">{item.uom}</td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums text-[#0F4C81]">
                          {benchmark ? formatMoney(benchmark, rfq.currency) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* WhatsApp / Email Quick Share */}
          <div className="bg-white border border-[#E2E8F0] rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-sm font-semibold text-[#0F172A]">
                Zero-Login Supplier Invite
              </h3>
              <button
                onClick={handleCopyInvite}
                className="px-2.5 py-1 text-xs font-medium text-[#0F4C81] bg-[#0F4C81]/10 rounded flex items-center gap-1"
              >
                <Copy className="w-3.5 h-3.5" />
                <span>{copiedInvite ? 'Copied' : 'Copy Text'}</span>
              </button>
            </div>
            <p className="text-xs text-[#475569]">
              Suppliers reply via WhatsApp, email, PDF, or Excel—no portal account required.
            </p>
            <pre className="p-3 bg-[#F8FAFC] border border-[#E2E8F0] rounded text-[11px] font-mono text-[#0F172A] whitespace-pre-wrap max-h-64 overflow-y-auto">
              {whatsappInviteText}
            </pre>
          </div>
        </div>
      )}

      {/* TAB 2: Upload Quotes */}
      {activeTab === 'upload' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
          {/* Upload Form */}
          <form
            onSubmit={handleExtractSubmit}
            className="lg:col-span-5 bg-white border border-[#E2E8F0] rounded-lg p-5 space-y-4"
          >
            <div>
              <h2 className="font-display text-base font-semibold text-[#0F172A]">
                Extract Supplier Quotation
              </h2>
              <p className="text-xs text-[#475569] mt-0.5">
                Upload PDF, Excel (.xlsx/.csv), WhatsApp photo, or paste email body text.
              </p>
            </div>

            {uploadError && (
              <div className="p-3 bg-[#FEF2F2] border border-[#FECACA] text-[#DC2626] text-xs rounded-md">
                {uploadError}
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-[#475569] mb-1">
                Supplier
              </label>
              <select
                value={uploadSupplierId}
                onChange={(e) => setUploadSupplierId(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-[#E2E8F0] rounded-md bg-white"
              >
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.city})
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-1 p-1 bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg">
              <button
                type="button"
                onClick={() => setUploadMode('file')}
                className={`flex-1 py-1.5 text-xs font-medium rounded-md flex items-center justify-center gap-1.5 ${
                  uploadMode === 'file'
                    ? 'bg-white text-[#0F172A] shadow-sm border border-[#E2E8F0]'
                    : 'text-[#475569]'
                }`}
              >
                <Upload className="w-3.5 h-3.5" />
                <span>File (PDF / Excel / Photo)</span>
              </button>
              <button
                type="button"
                onClick={() => setUploadMode('email')}
                className={`flex-1 py-1.5 text-xs font-medium rounded-md flex items-center justify-center gap-1.5 ${
                  uploadMode === 'email'
                    ? 'bg-white text-[#0F172A] shadow-sm border border-[#E2E8F0]'
                    : 'text-[#475569]'
                }`}
              >
                <Mail className="w-3.5 h-3.5" />
                <span>Paste Email / WhatsApp</span>
              </button>
            </div>

            {uploadMode === 'file' ? (
              <label className="block border-2 border-dashed border-[#CBD5E1] hover:border-[#0F4C81] rounded-lg p-6 text-center cursor-pointer bg-[#F8FAFC] transition-colors">
                <input
                  type="file"
                  accept=".pdf,.xlsx,.xls,.csv,.png,.jpg,.jpeg,.webp"
                  onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                  className="hidden"
                />
                <Upload className="w-6 h-6 text-[#0F4C81] mx-auto mb-2" />
                {selectedFile ? (
                  <div className="text-xs font-medium text-[#0F172A] font-mono">
                    {selectedFile.name} ({Math.round(selectedFile.size / 1024)} KB)
                  </div>
                ) : (
                  <>
                    <div className="text-xs font-medium text-[#0F172A]">
                      Click to choose quotation document
                    </div>
                    <div className="text-[11px] text-[#475569] mt-1">
                      Supports PDF, XLSX, XLS, CSV, PNG, JPG up to 25 MB
                    </div>
                  </>
                )}
              </label>
            ) : (
              <div>
                <textarea
                  rows={7}
                  value={rawEmailText}
                  onChange={(e) => setRawEmailText(e.target.value)}
                  placeholder={
                    'Paste raw supplier quote here, e.g.:\n1. SS304 Manifold 60 nos @ Rs 2,310/pc\n2. M12x45 Cap Screw 500 pcs @ Rs 42.00\nGST 18% extra. Freight Rs 2,500. Delivery 10 days. Net 30.'
                  }
                  className="w-full p-3 text-xs font-mono border border-[#E2E8F0] rounded-md"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={extracting}
              className="w-full py-2.5 text-sm font-medium text-white bg-[#0F4C81] rounded-lg hover:bg-[#0A365C] disabled:opacity-50"
            >
              {extracting ? 'Extracting & Normalizing...' : 'Extract & Normalize Quotation'}
            </button>
          </form>

          {/* Uploaded Quotations Queue */}
          <div className="lg:col-span-7 bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
            <div className="px-5 py-3.5 border-b border-[#E2E8F0] flex items-center justify-between">
              <h2 className="font-display text-sm font-semibold text-[#0F172A]">
                Received Quotations ({quotes.length})
              </h2>
              <span className="text-xs text-[#475569]">Deterministic math + source trace active</span>
            </div>

            {quotes.length === 0 ? (
              <div className="p-8 text-center text-sm text-[#475569]">
                No quotations uploaded for this RFQ yet.
              </div>
            ) : (
              <div className="divide-y divide-[#E2E8F0]">
                {quotes.map((q) => {
                  const mathErrs = q.lines.filter((l) => !l.mathValid).length;
                  return (
                    <div
                      key={q.id}
                      className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-[#F8FAFC]"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-[#0F172A]">
                          {getSupplierName(q.supplierId)}
                        </div>
                        <div className="text-xs text-[#475569] font-mono truncate mt-0.5">
                          {q.documentName} · {q.quoteReference}
                        </div>
                        <div className="text-xs mt-1 flex flex-wrap items-center gap-x-2">
                          <span className="font-mono tabular-nums font-semibold text-[#0F172A]">
                            Landed: {formatMoney(q.totalLandedCost, rfq.currency)}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{Math.round(q.completenessRatio * 100)}% lines</span>
                          <span aria-hidden="true">·</span>
                          {q.isVerified ? (
                            <span className="text-[#059669] font-medium">Verified</span>
                          ) : mathErrs > 0 ? (
                            <span className="text-[#DC2626] font-semibold">
                              {mathErrs} Math Mismatch
                            </span>
                          ) : (
                            <span className="text-[#D97706] font-medium">Needs Review</span>
                          )}
                          {editLockedQuoteIds.has(q.id) && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="text-[#0F4C81] font-medium">Locked by Award</span>
                            </>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => {
                            onSelectQuote(q.id);
                            onChangeTab('review');
                          }}
                          className="px-3 py-1.5 text-xs font-medium text-[#0F4C81] bg-[#0F4C81]/10 rounded-md hover:bg-[#0F4C81]/15"
                        >
                          Inspect Source
                        </button>
                        <button
                          onClick={async () => {
                            if (deletingQuoteId || deleteLockedQuoteIds.has(q.id)) return;
                            setUploadError(null);
                            try {
                              setDeletingQuoteId(q.id);
                              await onDeleteQuote(q.id);
                            } catch (err) {
                              setUploadError(
                                err instanceof Error ? err.message : 'Unable to delete quotation.'
                              );
                            } finally {
                              setDeletingQuoteId(null);
                            }
                          }}
                          disabled={deletingQuoteId === q.id || deleteLockedQuoteIds.has(q.id)}
                          title={
                            deleteLockedQuoteIds.has(q.id)
                              ? 'Quotation is preserved because it is referenced by a pending, rejected, or approved award'
                              : 'Delete quotation'
                          }
                          className="p-1.5 text-[#475569] hover:text-[#DC2626] rounded disabled:opacity-40"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: Extraction Review */}
      {activeTab === 'review' && (
        <ExtractionReviewPane
          rfq={rfq}
          quotes={quotes}
          suppliers={suppliers}
          selectedQuoteId={selectedQuoteId}
          lockedQuoteIds={editLockedQuoteIds}
          onSelectQuote={onSelectQuote}
          onUpdateHeader={onUpdateHeader}
          onUpdateLine={onUpdateLine}
          onVerifyQuote={onVerifyQuote}
          onGoToCompare={() => onChangeTab('compare')}
          demoMode={demoMode}
          demoSessionId={demoSessionId}
        />
      )}

      {/* TAB 4: Compare Matrix */}
      {activeTab === 'compare' && (
        <ComparisonMatrixPane
          rfq={rfq}
          quotes={quotes}
          suppliers={suppliers}
          catalogItems={catalogItems}
          basis={basis}
          onChangeBasis={setBasis}
          onInspectQuote={(qId) => {
            onSelectQuote(qId);
            onChangeTab('review');
          }}
          onProceedToAward={(draft) => {
            setDraftAward(draft);
            setShowRevisionForm(true);
            onChangeTab('approval');
          }}
          onExportPdf={() =>
            exportComparativeStatementPdf({
              rfq,
              quotes,
              suppliers,
              settings,
              basis,
              award: activeAward || undefined,
            })
          }
          onExportExcel={() =>
            exportComparativeStatementExcel({
              rfq,
              quotes,
              suppliers,
              settings,
              auditLogs,
              award: activeAward || undefined,
            })
          }
        />
      )}

      {/* TAB 5: Approval & Export */}
      {activeTab === 'approval' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
          <div className="lg:col-span-7 bg-white border border-[#E2E8F0] rounded-lg p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-display text-base font-semibold text-[#0F172A]">
                  Award Recommendation & Sign-Off
                </h2>
                <p className="text-xs text-[#475569]">
                  Approving an award automatically updates Item Master Last Paid Price history.
                </p>
              </div>
              <span className="text-xs font-medium text-[#0F4C81]">
                Active Role: {settings.activeUserRole.toUpperCase()}
              </span>
            </div>

            {awardError && (
              <div className="p-3 bg-[#FEF2F2] border border-[#FECACA] text-[#DC2626] text-xs rounded-md">
                {awardError}
              </div>
            )}

            {activeAward ? (
              <div className="space-y-4">
                <div className="p-4 bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg space-y-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-[#0F172A]">
                      {activeAward.isSplitAward ? 'Split-Vendor Award' : 'Single-Vendor Package Award'}
                    </span>
                    <span
                      className={`font-semibold ${
                        activeAward.approvalStatus === 'approved'
                          ? 'text-[#059669]'
                          : 'text-[#0F4C81]'
                      }`}
                    >
                      {activeAward.approvalStatus.toUpperCase()}
                    </span>
                  </div>
                  <div className="font-mono tabular-nums text-lg font-bold text-[#0F172A]">
                    {formatMoney(activeAward.totalAwardedLanded, rfq.currency)}
                    <span className="text-xs font-sans font-normal text-[#475569] ml-2">
                      Total Landed Cost
                    </span>
                  </div>
                  <div className="text-[#475569]">
                    Recommended by {activeAward.recommendedBy} on{' '}
                    {formatDateShort(activeAward.createdAt)}
                    {activeAward.approvedBy &&
                      ` · Decided by ${activeAward.approvedBy} on ${formatDateShort(activeAward.decidedAt)}`}
                  </div>
                  {activeAward.nonL1Justification && (
                    <div className="pt-2 border-t border-[#E2E8F0] text-[#0F172A]">
                      <strong>Award Justification:</strong> {activeAward.nonL1Justification}
                    </div>
                  )}
                  {activeAward.approverNotes && (
                    <div className="text-[#0F172A]">
                      <strong>Approver Notes:</strong> {activeAward.approverNotes}
                    </div>
                  )}
                </div>

                <div className="border border-[#E2E8F0] rounded-lg overflow-hidden">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="bg-[#F8FAFC] border-b border-[#E2E8F0] text-[#475569]">
                        <th className="py-2 px-3">Item</th>
                        <th className="py-2 px-3">Awarded Supplier</th>
                        <th className="py-2 px-3 text-right">Qty</th>
                        <th className="py-2 px-3 text-right">Landed Unit</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#E2E8F0]">
                      {activeAward.allocations.map((al) => {
                        const item = rfq.items.find((i) => i.id === al.rfqItemId);
                        return (
                          <tr key={al.rfqItemId}>
                            <td className="py-2 px-3 font-medium text-[#0F172A]">
                              {item?.description || al.rfqItemId}
                            </td>
                            <td className="py-2 px-3 text-[#475569]">
                              {getSupplierName(al.supplierId)}
                            </td>
                            <td className="py-2 px-3 text-right font-mono tabular-nums">
                              {al.awardedQty} {item?.uom}
                            </td>
                            <td className="py-2 px-3 text-right font-mono tabular-nums font-semibold">
                              {formatMoney(al.awardedUnitLanded, rfq.currency)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {activeAward.approvalStatus === 'pending' && (
                  <div className="p-4 border border-[#E2E8F0] rounded-lg space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-[#0F172A] flex items-center gap-1.5">
                        <ShieldCheck className="w-4 h-4 text-[#0F4C81]" />
                        <span>MD / Approver Sign-Off</span>
                      </div>
                      {canWithdrawPending && (
                        <button
                          type="button"
                          onClick={handleWithdraw}
                          disabled={awardBusy}
                          className="px-3 py-1 text-xs font-medium text-[#475569] bg-[#F8FAFC] border border-[#E2E8F0] rounded-md hover:bg-slate-100 disabled:opacity-50"
                        >
                          Withdraw Pending Recommendation
                        </button>
                      )}
                    </div>
                    <textarea
                      rows={2}
                      value={approverNotes}
                      onChange={(e) => setApproverNotes(e.target.value)}
                      placeholder="Optional approval instructions (e.g., Release PO in Tally with 30-day credit)..."
                      className="w-full p-2.5 text-xs border border-[#E2E8F0] rounded-md"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleDecision('approved')}
                        disabled={awardBusy || !canDecidePending}
                        className="px-4 py-2 text-xs font-medium text-white bg-[#059669] rounded-md hover:bg-emerald-700 disabled:opacity-50"
                      >
                        Approve Award & Update Price Memory
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDecision('rejected')}
                        disabled={awardBusy || !canDecidePending}
                        className="px-4 py-2 text-xs font-medium text-[#DC2626] bg-[#FEF2F2] border border-[#FECACA] rounded-md hover:bg-red-100 disabled:opacity-50"
                      >
                        Return for Revision
                      </button>
                    </div>
                    {!canDecidePending && (
                      <div className="text-[11px] text-[#475569]">
                        Only an Owner, Admin, or Approver can finalize or return a pending recommendation.
                      </div>
                    )}
                  </div>
                )}

                {rejectedAwards.length > 0 && (
                  <div className="p-3 bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg space-y-1.5 text-xs">
                    <div className="font-semibold text-[#475569]">
                      Prior Returned Recommendations ({rejectedAwards.length})
                    </div>
                    {rejectedAwards.map((rej) => (
                      <div key={rej.id} className="text-[#475569]">
                        <span className="font-mono font-semibold text-[#DC2626]">REJECTED</span>{' '}
                        · {formatMoney(rej.totalAwardedLanded, rfq.currency)} · Decided{' '}
                        {formatDateShort(rej.decidedAt)}
                        {rej.approverNotes ? ` — "${rej.approverNotes}"` : ''}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : rejectedAwards.length > 0 && !showRevisionForm && !draftAward ? (
              <div className="space-y-4">
                <div className="p-4 bg-[#FEF2F2]/60 border border-[#FECACA] rounded-lg space-y-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-[#0F172A]">
                      {rejectedAwards[0].isSplitAward
                        ? 'Prior Split-Vendor Recommendation'
                        : 'Prior Single-Vendor Recommendation'}
                    </span>
                    <span className="font-semibold text-[#DC2626]">REJECTED — HISTORICAL SNAPSHOT</span>
                  </div>
                  <div className="font-mono tabular-nums text-lg font-bold text-[#0F172A]">
                    {formatMoney(rejectedAwards[0].totalAwardedLanded, rfq.currency)}
                    <span className="text-xs font-sans font-normal text-[#475569] ml-2">
                      Total Landed Cost
                    </span>
                  </div>
                  <div className="text-[#475569]">
                    Recommended by {rejectedAwards[0].recommendedBy} on{' '}
                    {formatDateShort(rejectedAwards[0].createdAt)}
                    {rejectedAwards[0].approvedBy &&
                      ` · Returned by ${rejectedAwards[0].approvedBy} on ${formatDateShort(rejectedAwards[0].decidedAt)}`}
                  </div>
                  {rejectedAwards[0].approverNotes && (
                    <div className="pt-2 border-t border-[#FECACA] text-[#0F172A]">
                      <strong>Approver Feedback:</strong> {rejectedAwards[0].approverNotes}
                    </div>
                  )}
                  {rejectedAwards[0].nonL1Justification && (
                    <div className="text-[#0F172A]">
                      <strong>Submitted Justification:</strong> {rejectedAwards[0].nonL1Justification}
                    </div>
                  )}
                </div>

                <div className="border border-[#E2E8F0] rounded-lg overflow-hidden">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="bg-[#F8FAFC] border-b border-[#E2E8F0] text-[#475569]">
                        <th className="py-2 px-3">Item</th>
                        <th className="py-2 px-3">Previously Recommended Supplier</th>
                        <th className="py-2 px-3 text-right">Qty</th>
                        <th className="py-2 px-3 text-right">Landed Unit</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#E2E8F0]">
                      {rejectedAwards[0].allocations.map((al) => {
                        const item = rfq.items.find((i) => i.id === al.rfqItemId);
                        return (
                          <tr key={al.rfqItemId}>
                            <td className="py-2 px-3 font-medium text-[#0F172A]">
                              {item?.description || al.rfqItemId}
                            </td>
                            <td className="py-2 px-3 text-[#475569]">
                              {getSupplierName(al.supplierId)}
                            </td>
                            <td className="py-2 px-3 text-right font-mono tabular-nums">
                              {al.awardedQty} {item?.uom}
                            </td>
                            <td className="py-2 px-3 text-right font-mono tabular-nums font-semibold">
                              {formatMoney(al.awardedUnitLanded, rfq.currency)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowRevisionForm(true)}
                    className="px-4 py-2 text-xs font-medium text-white bg-[#0F4C81] rounded-md hover:bg-[#0A365C]"
                  >
                    Revise &amp; Resubmit Recommendation
                  </button>
                  <button
                    type="button"
                    onClick={() => onChangeTab('compare')}
                    className="px-4 py-2 text-xs font-medium text-[#0F172A] bg-white border border-[#E2E8F0] rounded-md hover:bg-[#F8FAFC]"
                  >
                    Re-evaluate in Compare Matrix
                  </button>
                </div>
              </div>
            ) : effectiveDraft ? (
              <form onSubmit={handleRecommendSubmit} className="space-y-4">
                {rejectedAwards.length > 0 && (
                  <div className="p-3 bg-[#FFFBEB] border border-[#FDE68A] rounded-md text-xs text-[#92400E] flex items-center justify-between gap-2">
                    <span>
                      Submitting a revised recommendation for {rfq.rfqNumber}. Prior rejected decision(s) remain preserved in the audit trail.
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setDraftAward(null);
                        setShowRevisionForm(false);
                      }}
                      className="underline font-medium shrink-0"
                    >
                      View Prior Rejection
                    </button>
                  </div>
                )}

                <div className="p-4 bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg space-y-2">
                  <div className="text-xs text-[#475569]">
                    {effectiveDraft.isSplitAward
                      ? 'Split-Award Allocation across selected suppliers'
                      : `Full Package Award to ${getSupplierName(
                          effectiveDraft.allocations[0]?.supplierId || ''
                        )}`}
                  </div>
                  <div className="font-mono tabular-nums text-xl font-bold text-[#0F172A]">
                    {formatMoney(effectiveDraft.totalAwardedLanded, rfq.currency)}
                  </div>
                  {effectiveDraft.isNonL1 && (
                    <div className="text-xs text-[#D97706] font-medium flex items-center gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      <span>Selected award is above L1 package total — justification required.</span>
                    </div>
                  )}
                </div>

                {draftMissingFreightQuotes.length > 0 && (
                  <div className="p-3 bg-[#FFFBEB] border border-[#FDE68A] rounded-md space-y-2 text-xs text-[#92400E]">
                    <div className="font-semibold flex items-center gap-1.5">
                      <AlertTriangle className="w-4 h-4 text-[#D97706]" />
                      <span>
                        Unconfirmed Freight / Commercial Terms on{' '}
                        {draftMissingFreightQuotes.map((q) => q.quoteReference).join(', ')}
                      </span>
                    </div>
                    <label className="flex items-start gap-2 cursor-pointer text-[#0F172A]">
                      <input
                        type="checkbox"
                        checked={commercialExceptionAccepted}
                        onChange={(e) => setCommercialExceptionAccepted(e.target.checked)}
                        className="mt-0.5 rounded border-[#CBD5E1]"
                      />
                      <span>
                        Acknowledge commercial exception (Freight To-Pay / unconfirmed) with written justification below
                      </span>
                    </label>
                  </div>
                )}

                {draftAlternateLines.length > 0 && (
                  <div className="p-3 bg-[#FFFBEB] border border-[#FDE68A] rounded-md space-y-2 text-xs text-[#92400E]">
                    <div className="font-semibold flex items-center gap-1.5">
                      <AlertTriangle className="w-4 h-4 text-[#D97706]" />
                      <span>Alternate Specifications Included in Recommendation</span>
                    </div>
                    <div className="space-y-1.5">
                      {draftAlternateLines.map((alt) => (
                        <label
                          key={alt.lineId}
                          className="flex items-start gap-2 cursor-pointer text-[#0F172A]"
                        >
                          <input
                            type="checkbox"
                            checked={acceptedAlternateLineIds.includes(alt.lineId)}
                            onChange={(e) =>
                              setAcceptedAlternateLineIds((prev) =>
                                e.target.checked
                                  ? [...prev, alt.lineId]
                                  : prev.filter((id) => id !== alt.lineId)
                              )
                            }
                            className="mt-0.5 rounded border-[#CBD5E1]"
                          />
                          <span>
                            Accept alternate spec from <strong>{alt.supplierName}</strong>:{' '}
                            {alt.description}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-[#475569] mb-1">
                    Award Justification{' '}
                    {draftRequiresJustification
                      ? '(Mandatory for Non-L1 / Exceptions)'
                      : '(Optional)'}
                  </label>
                  <textarea
                    rows={3}
                    required={draftRequiresJustification}
                    value={nonL1Justification}
                    onChange={(e) => setNonL1Justification(e.target.value)}
                    placeholder="e.g., L1 has 14-day lead time and missing freight terms; recommended supplier offers Net 30 and complete BOM coverage."
                    className="w-full p-2.5 text-xs border border-[#E2E8F0] rounded-md"
                  />
                </div>

                <button
                  type="submit"
                  disabled={awardBusy || draftSubmitBlocked}
                  className="px-4 py-2 text-sm font-medium text-white bg-[#0F4C81] rounded-lg hover:bg-[#0A365C] disabled:opacity-50 flex items-center gap-2"
                >
                  <ClipboardCheck className="w-4 h-4" />
                  <span>{awardBusy ? 'Submitting...' : 'Submit Award for Approval'}</span>
                </button>
              </form>
            ) : (
              <div className="text-sm text-[#475569]">
                Verify at least one complete (100% BOM), quantity-sufficient, commercially confirmed quotation—or configure a verified Split Award in the Compare Matrix—before submitting an award decision.
              </div>
            )}
          </div>

          {/* Export Box */}
          <div className="lg:col-span-5 bg-white border border-[#E2E8F0] rounded-lg p-5 space-y-4">
            <h3 className="font-display text-sm font-semibold text-[#0F172A]">
              Comparative Statement (CS) Export
            </h3>
            <p className="text-xs text-[#475569]">
              Download an audit-ready Comparative Statement for management sign-off, Tally/ERP PO entry, and statutory procurement records.
            </p>
            <div className="space-y-2.5">
              <button
                onClick={() =>
                  exportComparativeStatementPdf({
                    rfq,
                    quotes,
                    suppliers,
                    settings,
                    basis,
                    award: activeAward || undefined,
                  })
                }
                disabled={quotes.length === 0}
                className="w-full px-4 py-2.5 text-xs font-medium text-white bg-[#0F4C81] rounded-lg hover:bg-[#0A365C] disabled:opacity-40 flex items-center justify-center gap-2"
              >
                <FileText className="w-4 h-4" />
                <span>Download Landscape A4 CS PDF</span>
              </button>
              <button
                onClick={() =>
                  exportComparativeStatementExcel({
                    rfq,
                    quotes,
                    suppliers,
                    settings,
                    auditLogs,
                    award: activeAward || undefined,
                  })
                }
                disabled={quotes.length === 0}
                className="w-full px-4 py-2.5 text-xs font-medium text-[#0F172A] bg-white border border-[#E2E8F0] rounded-lg hover:bg-[#F8FAFC] disabled:opacity-40 flex items-center justify-center gap-2"
              >
                <FileSpreadsheet className="w-4 h-4 text-[#059669]" />
                <span>Download Multi-Sheet CS Excel (with Formulas)</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
