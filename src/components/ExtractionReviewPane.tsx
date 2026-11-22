import { useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Mail,
  ShieldAlert,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Quotation, QuotationLine, Rfq, Supplier } from '../types.ts';
import { formatMoney } from '../lib/format.ts';

interface ExtractionReviewPaneProps {
  rfq: Rfq;
  quotes: Quotation[];
  suppliers: Supplier[];
  selectedQuoteId: string | null;
  onSelectQuote: (id: string) => void;
  onUpdateHeader: (quoteId: string, patch: Partial<Quotation>) => Promise<void>;
  onUpdateLine: (quoteId: string, lineId: string, patch: Partial<QuotationLine>) => Promise<void>;
  onVerifyQuote: (quoteId: string) => Promise<void>;
  onGoToCompare: () => void;
}

export function ExtractionReviewPane({
  rfq,
  quotes,
  suppliers,
  selectedQuoteId,
  onSelectQuote,
  onUpdateHeader,
  onUpdateLine,
  onVerifyQuote,
  onGoToCompare,
}: ExtractionReviewPaneProps) {
  const activeQuote = quotes.find((q) => q.id === selectedQuoteId) || quotes[0] || null;
  const [focusedLineId, setFocusedLineId] = useState<string | null>(null);
  const [focusedHeaderField, setFocusedHeaderField] = useState<string | null>(null);
  const [zoom, setZoom] = useState(100);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!activeQuote) {
    return (
      <div className="bg-white border border-[#E2E8F0] rounded-lg p-10 text-center">
        <p className="text-sm text-[#475569]">
          No quotations uploaded yet for {rfq.rfqNumber}. Upload a supplier PDF, Excel, or WhatsApp image first.
        </p>
      </div>
    );
  }

  const supplier = suppliers.find((s) => s.id === activeQuote.supplierId);
  const unresolvedMathCount = activeQuote.lines.filter((l) => !l.mathValid).length;
  const focusedLine = activeQuote.lines.find((l) => l.id === focusedLineId) || null;

  const colLetter = (idx: number) => String.fromCharCode(65 + idx);

  const isCellHighlighted = (sheetName: string, rowIdx: number, colIdx: number) => {
    const coord = `${colLetter(colIdx)}${rowIdx + 1}`;
    if (focusedLine?.sourceTrace.sheet === sheetName && focusedLine.sourceTrace.cell) {
      const ref = focusedLine.sourceTrace.cell;
      if (ref.includes(':')) {
        const [start, end] = ref.split(':');
        const startRow = parseInt(start.replace(/[^0-9]/g, ''), 10);
        const endRow = parseInt(end.replace(/[^0-9]/g, ''), 10);
        const startCol = start.replace(/[0-9]/g, '');
        const endCol = end.replace(/[0-9]/g, '');
        const curCol = colLetter(colIdx);
        return (
          rowIdx + 1 >= startRow &&
          rowIdx + 1 <= endRow &&
          curCol >= startCol &&
          curCol <= endCol
        );
      }
      return ref === coord;
    }
    if (focusedHeaderField && activeQuote.headerTraces[focusedHeaderField]) {
      const tr = activeQuote.headerTraces[focusedHeaderField];
      return tr.sheet === sheetName && tr.cell === coord;
    }
    return false;
  };

  const handleVerify = async () => {
    setErrorMsg(null);
    try {
      setSavingId('verify');
      await onVerifyQuote(activeQuote.id);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setSavingId(null);
    }
  };

  const handleSaveLinePatch = async (lineId: string, patch: Partial<QuotationLine>) => {
    setErrorMsg(null);
    try {
      setSavingId(lineId);
      await onUpdateLine(activeQuote.id, lineId, patch);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to update line');
    } finally {
      setSavingId(null);
    }
  };

  const handleSaveHeaderPatch = async (patch: Partial<Quotation>) => {
    setErrorMsg(null);
    try {
      setSavingId('header');
      await onUpdateHeader(activeQuote.id, patch);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to update header');
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* Quote Selector & Verification Header */}
      <div className="bg-white border border-[#E2E8F0] rounded-lg p-3.5 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {quotes.map((q) => {
            const sup = suppliers.find((s) => s.id === q.supplierId);
            const hasErr = q.lines.some((l) => !l.mathValid);
            const active = q.id === activeQuote.id;
            return (
              <button
                key={q.id}
                onClick={() => {
                  onSelectQuote(q.id);
                  setFocusedLineId(null);
                  setFocusedHeaderField(null);
                }}
                className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap flex items-center gap-1.5 ${
                  active
                    ? 'bg-[#0F4C81] text-white border-[#0F4C81]'
                    : 'bg-[#F8FAFC] text-[#0F172A] border-[#E2E8F0] hover:bg-slate-100'
                }`}
              >
                {q.isVerified ? (
                  <CheckCircle2 className={`w-3.5 h-3.5 ${active ? 'text-emerald-200' : 'text-[#059669]'}`} />
                ) : hasErr ? (
                  <AlertTriangle className={`w-3.5 h-3.5 ${active ? 'text-red-200' : 'text-[#DC2626]'}`} />
                ) : (
                  <FileText className="w-3.5 h-3.5 opacity-70" />
                )}
                <span>{sup?.name.split(' ').slice(0, 2).join(' ') || 'Supplier'}</span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <div className="text-xs text-[#475569] font-mono tabular-nums">
            Landed: <span className="font-semibold text-[#0F172A]">{formatMoney(activeQuote.totalLandedCost, rfq.currency)}</span>
          </div>
          {activeQuote.isVerified ? (
            <button
              onClick={onGoToCompare}
              className="px-3.5 py-1.5 text-xs font-medium text-white bg-[#059669] rounded-md hover:bg-emerald-700 whitespace-nowrap flex items-center gap-1.5"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Verified — Open Matrix</span>
            </button>
          ) : (
            <button
              onClick={handleVerify}
              disabled={savingId === 'verify' || unresolvedMathCount > 0}
              className="px-3.5 py-1.5 text-xs font-medium text-white bg-[#0F4C81] rounded-md hover:bg-[#0A365C] disabled:opacity-50 whitespace-nowrap flex items-center gap-1.5"
              title={
                unresolvedMathCount > 0
                  ? 'Resolve arithmetic mismatch before verifying'
                  : 'Confirm extracted figures and mark verified'
              }
            >
              <Check className="w-3.5 h-3.5" />
              <span>{savingId === 'verify' ? 'Verifying...' : 'Mark Quote Verified'}</span>
            </button>
          )}
        </div>
      </div>

      {errorMsg && (
        <div className="p-3 bg-[#FEF2F2] border border-[#FECACA] text-[#DC2626] text-xs rounded-md flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {unresolvedMathCount > 0 && (
        <div className="p-3 bg-[#FEF2F2] border border-[#FECACA] text-[#DC2626] text-xs rounded-md flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>
              <strong>Arithmetic Verification Gate:</strong> {unresolvedMathCount} line item(s) have a mismatch between printed total and <span className="font-mono">Qty × Rate</span>. Review and correct before verifying.
            </span>
          </div>
        </div>
      )}

      {/* Split Pane: Left 60% Source Viewer / Right 40% Structured Editor */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
        {/* LEFT PANE (7 cols ~ 58%) */}
        <div className="xl:col-span-7 bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[#E2E8F0] bg-[#F8FAFC] flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-medium text-[#0F172A] min-w-0">
              {activeQuote.documentKind === 'excel' ? (
                <FileSpreadsheet className="w-4 h-4 text-[#059669] shrink-0" />
              ) : activeQuote.documentKind === 'image' ? (
                <ImageIcon className="w-4 h-4 text-[#0F4C81] shrink-0" />
              ) : activeQuote.documentKind === 'email' ? (
                <Mail className="w-4 h-4 text-[#0F4C81] shrink-0" />
              ) : (
                <FileText className="w-4 h-4 text-[#0F4C81] shrink-0" />
              )}
              <span className="truncate font-mono">{activeQuote.documentName}</span>
              <span className="text-[#475569] shrink-0">· {activeQuote.quoteReference}</span>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => setZoom((z) => Math.max(75, z - 15))}
                className="p-1 text-[#475569] hover:bg-white rounded border border-transparent hover:border-[#E2E8F0]"
                title="Zoom out"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <span className="font-mono text-[11px] text-[#475569] w-10 text-center">{zoom}%</span>
              <button
                onClick={() => setZoom((z) => Math.min(145, z + 15))}
                className="p-1 text-[#475569] hover:bg-white rounded border border-transparent hover:border-[#E2E8F0]"
                title="Zoom in"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="p-4 bg-slate-100 min-h-[540px] max-h-[720px] overflow-auto">
            {/* Case 1: Spreadsheet Preview */}
            {activeQuote.sheetPreview && activeQuote.sheetPreview.length > 0 ? (
              <div
                style={{ transform: `scale(${zoom / 100})`, transformOrigin: 'top left' }}
                className="space-y-4"
              >
                {activeQuote.sheetPreview.map((sheet) => (
                  <div key={sheet.sheetName} className="bg-white border border-[#CBD5E1] rounded overflow-hidden">
                    <div className="px-3 py-1.5 bg-slate-50 border-b border-[#E2E8F0] text-xs font-mono font-semibold text-[#0F172A]">
                      Sheet: {sheet.sheetName}
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse text-xs font-mono">
                        <thead>
                          <tr className="bg-slate-100 text-[#475569]">
                            <th className="w-8 py-1 px-2 border border-[#E2E8F0] text-center">#</th>
                            {(sheet.rows[0] || []).map((_, cIdx) => (
                              <th key={cIdx} className="py-1 px-2 border border-[#E2E8F0] text-center">
                                {colLetter(cIdx)}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {sheet.rows.map((row, rIdx) => (
                            <tr key={rIdx} className={rIdx === 0 ? 'bg-slate-50 font-semibold' : ''}>
                              <td className="py-1.5 px-2 border border-[#E2E8F0] bg-slate-50 text-[#475569] text-center">
                                {rIdx + 1}
                              </td>
                              {row.map((cell, cIdx) => {
                                const highlighted = isCellHighlighted(sheet.sheetName, rIdx, cIdx);
                                return (
                                  <td
                                    key={cIdx}
                                    className={`py-1.5 px-2 border border-[#E2E8F0] whitespace-nowrap ${
                                      highlighted
                                        ? 'bg-[#FFFBEB] ring-2 ring-inset ring-[#D97706] font-semibold text-[#0F172A]'
                                        : 'text-[#0F172A]'
                                    }`}
                                  >
                                    {cell}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            ) : activeQuote.fileDataUrl && activeQuote.documentKind === 'image' ? (
              /* Case 2: Uploaded Real Image with BBox Overlays */
              <div
                className="relative inline-block bg-white shadow-sm border border-[#CBD5E1]"
                style={{ width: `${zoom}%` }}
              >
                <img
                  src={activeQuote.fileDataUrl}
                  alt={activeQuote.documentName}
                  className="w-full h-auto block"
                />
                {activeQuote.lines.map((line) => {
                  const bbox = line.sourceTrace.bbox;
                  if (!bbox) return null;
                  const isFocused = line.id === focusedLineId;
                  return (
                    <button
                      key={line.id}
                      type="button"
                      onClick={() => setFocusedLineId(line.id)}
                      style={{
                        left: `${bbox[0]}%`,
                        top: `${bbox[1]}%`,
                        width: `${Math.max(5, bbox[2] - bbox[0])}%`,
                        height: `${Math.max(3, bbox[3] - bbox[1])}%`,
                      }}
                      className={`absolute transition-all border-2 rounded-sm ${
                        isFocused
                          ? 'border-[#0F4C81] bg-[#0F4C81]/20 z-20'
                          : !line.mathValid
                          ? 'border-[#DC2626] bg-[#DC2626]/10'
                          : 'border-[#D97706]/60 bg-[#D97706]/5 hover:bg-[#0F4C81]/15'
                      }`}
                      title={line.sourceTrace.snippet}
                    />
                  );
                })}
              </div>
            ) : activeQuote.fileDataUrl && activeQuote.documentKind === 'pdf' ? (
              /* Case 3: Uploaded Real PDF */
              <iframe
                src={activeQuote.fileDataUrl}
                title={activeQuote.documentName}
                className="w-full h-[640px] bg-white border border-[#CBD5E1] rounded"
              />
            ) : activeQuote.rawEmailText ? (
              /* Case 4: Pasted Email / WhatsApp Quote Text */
              <div className="bg-white border border-[#CBD5E1] rounded p-5 font-mono text-xs leading-relaxed text-[#0F172A] whitespace-pre-wrap">
                {activeQuote.rawEmailText}
              </div>
            ) : (
              /* Case 5: High-Fidelity Reconstructed Document Sheet (Digital PDF or WhatsApp Scan) with Exact Interactive BBoxes */
              <div
                style={{ transform: `scale(${zoom / 100})`, transformOrigin: 'top left' }}
                className={`relative bg-white border border-[#CBD5E1] shadow-sm p-6 mx-auto max-w-[680px] ${
                  activeQuote.documentKind === 'image' ? 'rotate-[-0.6deg] bg-[#FFFDF9]' : ''
                }`}
              >
                <div className="flex items-start justify-between border-b-2 border-[#0F172A] pb-3 mb-4">
                  <div>
                    <div className="font-display text-base font-bold text-[#0F172A]">
                      {supplier?.name}
                    </div>
                    <div className="text-[11px] text-[#475569] font-mono">
                      GSTIN: {supplier?.taxId} · {supplier?.city}
                    </div>
                  </div>
                  <div className="text-right text-[11px] font-mono">
                    <div className="font-bold text-[#0F172A]">QUOTATION</div>
                    <div>Ref: {activeQuote.quoteReference}</div>
                    <div>Date: {activeQuote.quoteDate}</div>
                  </div>
                </div>

                <div className="text-[11px] text-[#475569] mb-3">
                  To: {rfq.deliveryLocation} · Ref: {rfq.rfqNumber} ({rfq.title})
                </div>

                <table className="w-full border-collapse text-[11px] font-mono mb-4">
                  <thead>
                    <tr className="bg-slate-100 border-y border-[#CBD5E1] text-[#0F172A]">
                      <th className="py-1.5 px-1.5 text-left">#</th>
                      <th className="py-1.5 px-1.5 text-left">Description</th>
                      <th className="py-1.5 px-1.5 text-right">Qty / UOM</th>
                      <th className="py-1.5 px-1.5 text-right">Rate</th>
                      <th className="py-1.5 px-1.5 text-right">GST</th>
                      <th className="py-1.5 px-1.5 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeQuote.lines.map((line) => {
                      const isFocused = line.id === focusedLineId;
                      return (
                        <tr
                          key={line.id}
                          onClick={() => setFocusedLineId(line.id)}
                          className={`cursor-pointer border-b border-slate-200 transition-colors ${
                            isFocused
                              ? 'bg-[#0F4C81]/15 ring-2 ring-[#0F4C81]'
                              : !line.mathValid
                              ? 'bg-[#FEF2F2] ring-1 ring-[#DC2626]'
                              : line.confidenceScore < 0.85
                              ? 'bg-[#FFFBEB]'
                              : 'hover:bg-slate-50'
                          }`}
                        >
                          <td className="py-2 px-1.5">{line.vendorLineNo}</td>
                          <td className="py-2 px-1.5 font-sans text-[#0F172A]">
                            {line.rawDescription}
                          </td>
                          <td className="py-2 px-1.5 text-right whitespace-nowrap">
                            {line.quotedQty ?? '—'} {line.quotedUom ?? ''}
                          </td>
                          <td className="py-2 px-1.5 text-right">
                            {line.quotedUnitRate !== null ? line.quotedUnitRate.toFixed(2) : '—'}
                          </td>
                          <td className="py-2 px-1.5 text-right">{line.taxRatePct}%</td>
                          <td className="py-2 px-1.5 text-right font-semibold">
                            {line.lineTotalQuoted !== null ? line.lineTotalQuoted.toFixed(2) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                <div className="grid grid-cols-2 gap-4 pt-3 border-t border-[#CBD5E1] text-[11px] font-mono">
                  <div
                    onClick={() => setFocusedHeaderField('paymentTerms')}
                    className={`p-2 rounded cursor-pointer ${
                      focusedHeaderField === 'paymentTerms'
                        ? 'bg-[#0F4C81]/15 ring-2 ring-[#0F4C81]'
                        : 'bg-slate-50'
                    }`}
                  >
                    <div className="font-semibold text-[#0F172A]">Commercial Terms</div>
                    <div className="text-[#475569] mt-0.5">
                      Payment: {activeQuote.paymentTerms || 'Not stated'}
                    </div>
                    <div className="text-[#475569]">
                      Delivery: {activeQuote.leadTimeDays ? `${activeQuote.leadTimeDays} days` : '—'}
                    </div>
                  </div>

                  <div
                    onClick={() => setFocusedHeaderField('freightCharges')}
                    className={`p-2 rounded cursor-pointer text-right ${
                      focusedHeaderField === 'freightCharges'
                        ? 'bg-[#0F4C81]/15 ring-2 ring-[#0F4C81]'
                        : 'bg-slate-50'
                    }`}
                  >
                    <div>
                      Freight:{' '}
                      {activeQuote.missingFreightWarning
                        ? 'Extra at Actuals'
                        : formatMoney(activeQuote.freightCharges, activeQuote.currency)}
                    </div>
                    <div>
                      P&F: {formatMoney(activeQuote.packingForwarding, activeQuote.currency)}
                    </div>
                    <div className="font-bold text-[#0F172A] mt-1">
                      Tax Mode: {activeQuote.taxIncludedInRates ? 'Incl. in Rates' : 'Extra as Applicable'}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {focusedLine && (
              <div className="mt-3 p-2.5 bg-white border border-[#E2E8F0] rounded text-xs flex items-center justify-between gap-2">
                <div className="font-mono text-[#0F172A] truncate">
                  Source Trace: {focusedLine.sourceTrace.snippet}
                </div>
                <span className="font-mono text-[11px] text-[#475569] shrink-0">
                  {focusedLine.sourceTrace.sheet
                    ? `${focusedLine.sourceTrace.sheet}!${focusedLine.sourceTrace.cell}`
                    : `Page ${focusedLine.sourceTrace.page ?? 1}`}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT PANE (5 cols ~ 42%): Structured Header + Line Editor */}
        <div className="xl:col-span-5 space-y-4">
          {/* Commercial Header Card */}
          <div className="bg-white border border-[#E2E8F0] rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-sm font-semibold text-[#0F172A]">
                Commercial Header & Overheads
              </h3>
              <span className="text-xs text-[#475569]">
                Completeness: <strong className="font-mono">{Math.round(activeQuote.completenessRatio * 100)}%</strong>
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div
                onClick={() => setFocusedHeaderField('freightCharges')}
                className="cursor-pointer"
              >
                <label className="block text-[#475569] mb-1">
                  Freight Charges ({activeQuote.currency})
                </label>
                <input
                  type="number"
                  step="any"
                  value={activeQuote.freightCharges}
                  onChange={(e) =>
                    handleSaveHeaderPatch({
                      freightCharges: Number(e.target.value) || 0,
                      missingFreightWarning: false,
                    })
                  }
                  className="w-full px-2.5 py-1.5 border border-[#E2E8F0] rounded font-mono tabular-nums"
                />
              </div>

              <div>
                <label className="block text-[#475569] mb-1">
                  Packing & Forwarding
                </label>
                <input
                  type="number"
                  step="any"
                  value={activeQuote.packingForwarding}
                  onChange={(e) =>
                    handleSaveHeaderPatch({ packingForwarding: Number(e.target.value) || 0 })
                  }
                  className="w-full px-2.5 py-1.5 border border-[#E2E8F0] rounded font-mono tabular-nums"
                />
              </div>

              <div>
                <label className="block text-[#475569] mb-1">Global Discount</label>
                <input
                  type="number"
                  step="any"
                  value={activeQuote.globalDiscount}
                  onChange={(e) =>
                    handleSaveHeaderPatch({ globalDiscount: Number(e.target.value) || 0 })
                  }
                  className="w-full px-2.5 py-1.5 border border-[#E2E8F0] rounded font-mono tabular-nums"
                />
              </div>

              <div>
                <label className="block text-[#475569] mb-1">Lead Time (Days)</label>
                <input
                  type="number"
                  value={activeQuote.leadTimeDays ?? ''}
                  onChange={(e) =>
                    handleSaveHeaderPatch({
                      leadTimeDays: e.target.value ? Number(e.target.value) : null,
                    })
                  }
                  className="w-full px-2.5 py-1.5 border border-[#E2E8F0] rounded font-mono tabular-nums"
                />
              </div>

              <div
                onClick={() => setFocusedHeaderField('paymentTerms')}
                className="col-span-2"
              >
                <label className="block text-[#475569] mb-1">Payment Terms</label>
                <input
                  type="text"
                  value={activeQuote.paymentTerms ?? ''}
                  onChange={(e) => handleSaveHeaderPatch({ paymentTerms: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-[#E2E8F0] rounded"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#E2E8F0] text-xs">
              <label className="flex items-center gap-2 cursor-pointer text-[#0F172A]">
                <input
                  type="checkbox"
                  checked={activeQuote.taxIncludedInRates}
                  onChange={(e) => handleSaveHeaderPatch({ taxIncludedInRates: e.target.checked })}
                  className="rounded border-[#CBD5E1]"
                />
                <span>Unit rates are GST/VAT inclusive</span>
              </label>

              {activeQuote.missingFreightWarning && (
                <span className="text-[#D97706] font-medium flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  Freight To-Pay / Omitted
                </span>
              )}
            </div>
          </div>

          {/* Line Items Extraction Review */}
          <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-[#E2E8F0] flex items-center justify-between">
              <h3 className="font-display text-sm font-semibold text-[#0F172A]">
                Extracted Line Items ({activeQuote.lines.length})
              </h3>
              <span className="text-xs text-[#475569]">Click row to highlight source</span>
            </div>

            <div className="divide-y divide-[#E2E8F0] max-h-[480px] overflow-y-auto">
              {activeQuote.lines.map((line) => {
                const isFocused = line.id === focusedLineId;
                return (
                  <div
                    key={line.id}
                    onClick={() => {
                      setFocusedLineId(line.id);
                      setFocusedHeaderField(null);
                    }}
                    className={`p-3.5 space-y-2.5 cursor-pointer transition-colors ${
                      isFocused
                        ? 'bg-[#0F4C81]/5'
                        : !line.mathValid
                        ? 'bg-[#FEF2F2]/60'
                        : 'hover:bg-[#F8FAFC]'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-[#0F172A] truncate">
                          {line.vendorLineNo}. {line.rawDescription}
                        </div>
                        <div className="text-[11px] text-[#475569] mt-0.5 flex flex-wrap items-center gap-x-2">
                          <span className="font-mono">
                            Conf: {Math.round(line.confidenceScore * 100)}%
                          </span>
                          <span aria-hidden="true">·</span>
                          {!line.mathValid ? (
                            <span className="text-[#DC2626] font-semibold">
                              Math Mismatch
                            </span>
                          ) : line.matchStatus === 'not_quoted' ? (
                            <span className="text-[#D97706] font-medium">Not Quoted</span>
                          ) : line.matchStatus === 'alternate_spec' ? (
                            <span className="text-[#D97706] font-medium">Alternate Spec</span>
                          ) : (
                            <span className="text-[#059669] font-medium">Math Valid</span>
                          )}
                          {line.humanEdited && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="text-[#0F4C81]">Edited</span>
                            </>
                          )}
                        </div>
                      </div>

                      <div className="text-right shrink-0">
                        <div className="text-[11px] text-[#475569]">Norm. Landed / Unit</div>
                        <div className="font-mono tabular-nums text-xs font-bold text-[#0F172A]">
                          {formatMoney(line.normalizedUnitLanded, rfq.currency)}
                        </div>
                      </div>
                    </div>

                    {!line.mathValid && line.mathErrorDetail && (
                      <div className="p-2 bg-[#FEF2F2] border border-[#FECACA] rounded text-[11px] text-[#DC2626] font-mono flex items-center justify-between gap-2">
                        <span>{line.mathErrorDetail}</span>
                        {line.expectedLineTotal !== null && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSaveLinePatch(line.id, {
                                lineTotalQuoted: line.expectedLineTotal,
                              });
                            }}
                            className="px-2 py-0.5 bg-[#DC2626] text-white rounded text-[11px] font-sans font-medium shrink-0"
                          >
                            Accept {line.expectedLineTotal}
                          </button>
                        )}
                      </div>
                    )}

                    {/* Inline Editable Fields */}
                    <div
                      className="grid grid-cols-4 gap-2 text-[11px]"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="col-span-2">
                        <label className="block text-[#475569] mb-0.5">Mapped RFQ Item</label>
                        <select
                          value={line.rfqItemId || ''}
                          onChange={(e) =>
                            handleSaveLinePatch(line.id, {
                              rfqItemId: e.target.value || null,
                              matchStatus: e.target.value
                                ? line.matchStatus === 'unmapped'
                                  ? 'matched'
                                  : line.matchStatus
                                : 'unmapped',
                            })
                          }
                          className="w-full px-2 py-1 border border-[#E2E8F0] rounded bg-white"
                        >
                          <option value="">Unmapped</option>
                          {rfq.items.map((it) => (
                            <option key={it.id} value={it.id}>
                              #{it.lineNo} {it.description.slice(0, 32)}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-[#475569] mb-0.5">Match Status</label>
                        <select
                          value={line.matchStatus}
                          onChange={(e) =>
                            handleSaveLinePatch(line.id, {
                              matchStatus: e.target.value as QuotationLine['matchStatus'],
                            })
                          }
                          className="w-full px-2 py-1 border border-[#E2E8F0] rounded bg-white"
                        >
                          <option value="matched">Matched</option>
                          <option value="alternate_spec">Alt Spec</option>
                          <option value="not_quoted">Not Quoted</option>
                          <option value="unmapped">Unmapped</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-[#475569] mb-0.5">UOM Factor</label>
                        <input
                          type="number"
                          min="0.01"
                          step="any"
                          value={line.uomConversionFactor}
                          onChange={(e) =>
                            handleSaveLinePatch(line.id, {
                              uomConversionFactor: Number(e.target.value) || 1,
                            })
                          }
                          title="Number of RFQ units per quoted UOM (e.g. 10 for Box of 10)"
                          className="w-full px-2 py-1 border border-[#E2E8F0] rounded font-mono tabular-nums text-right"
                        />
                      </div>

                      <div>
                        <label className="block text-[#475569] mb-0.5">Quoted Qty</label>
                        <input
                          type="number"
                          step="any"
                          value={line.quotedQty ?? ''}
                          onChange={(e) =>
                            handleSaveLinePatch(line.id, {
                              quotedQty: e.target.value === '' ? null : Number(e.target.value),
                            })
                          }
                          className="w-full px-2 py-1 border border-[#E2E8F0] rounded font-mono tabular-nums text-right"
                        />
                      </div>

                      <div>
                        <label className="block text-[#475569] mb-0.5">Unit Rate</label>
                        <input
                          type="number"
                          step="any"
                          value={line.quotedUnitRate ?? ''}
                          onChange={(e) =>
                            handleSaveLinePatch(line.id, {
                              quotedUnitRate: e.target.value === '' ? null : Number(e.target.value),
                            })
                          }
                          className="w-full px-2 py-1 border border-[#E2E8F0] rounded font-mono tabular-nums text-right"
                        />
                      </div>

                      <div>
                        <label className="block text-[#475569] mb-0.5">Tax %</label>
                        <input
                          type="number"
                          step="any"
                          value={line.taxRatePct}
                          onChange={(e) =>
                            handleSaveLinePatch(line.id, {
                              taxRatePct: Number(e.target.value) || 0,
                            })
                          }
                          className="w-full px-2 py-1 border border-[#E2E8F0] rounded font-mono tabular-nums text-right"
                        />
                      </div>

                      <div>
                        <label className="block text-[#475569] mb-0.5">Printed Total</label>
                        <input
                          type="number"
                          step="any"
                          value={line.lineTotalQuoted ?? ''}
                          onChange={(e) =>
                            handleSaveLinePatch(line.id, {
                              lineTotalQuoted: e.target.value === '' ? null : Number(e.target.value),
                            })
                          }
                          className="w-full px-2 py-1 border border-[#E2E8F0] rounded font-mono tabular-nums text-right"
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
