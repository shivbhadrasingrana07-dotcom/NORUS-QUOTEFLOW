import { useState } from 'react';
import { ClipboardPaste, Plus, Trash2, X } from 'lucide-react';
import { Supplier } from '../types.ts';

interface RfqCreateModalProps {
  suppliers: Supplier[];
  defaultCurrency: 'INR' | 'USD' | 'GBP' | 'EUR';
  onClose: () => void;
  onCreate: (payload: {
    title: string;
    currency: 'INR' | 'USD' | 'GBP' | 'EUR';
    incoterms: string;
    deliveryLocation: string;
    deadlineDate: string;
    invitedSupplierIds: string[];
    items: Array<{
      skuCode: string;
      description: string;
      quantity: number;
      uom: string;
      targetUnitPrice: number | null;
    }>;
  }) => Promise<void>;
}

export function RfqCreateModal({
  suppliers,
  defaultCurrency,
  onClose,
  onCreate,
}: RfqCreateModalProps) {
  const [title, setTitle] = useState('');
  const [currency, setCurrency] = useState<'INR' | 'USD' | 'GBP' | 'EUR'>(defaultCurrency);
  const [incoterms, setIncoterms] = useState('FOR Destination');
  const [deliveryLocation, setDeliveryLocation] = useState('MIDC Chakan Phase II, Pune');
  const [deadlineDate, setDeadlineDate] = useState(
    new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)
  );
  const [invitedSupplierIds, setInvitedSupplierIds] = useState<string[]>(
    suppliers.slice(0, 3).map((s) => s.id)
  );
  const [pasteBoxOpen, setPasteBoxOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [items, setItems] = useState([
    { skuCode: '', description: '', quantity: 100, uom: 'pcs', targetUnitPrice: '' },
  ]);

  const toggleSupplier = (id: string) => {
    setInvitedSupplierIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const handleParsePaste = () => {
    const lines = pasteText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return;

    const parsed = lines.map((line) => {
      const cols = line.includes('\t') ? line.split('\t') : line.split(',');
      if (cols.length >= 3) {
        // Expect: SKU (optional) | Description | Qty | UOM
        const hasFour = cols.length >= 4;
        return {
          skuCode: hasFour ? cols[0].trim() : '',
          description: (hasFour ? cols[1] : cols[0]).trim(),
          quantity: Number((hasFour ? cols[2] : cols[1]).replace(/[^0-9.]/g, '')) || 1,
          uom: (hasFour ? cols[3] : cols[2]).trim() || 'pcs',
          targetUnitPrice: cols[4] ? cols[4].replace(/[^0-9.]/g, '') : '',
        };
      }
      return {
        skuCode: '',
        description: cols[0].trim(),
        quantity: 1,
        uom: 'pcs',
        targetUnitPrice: '',
      };
    });

    setItems(parsed);
    setPasteBoxOpen(false);
    setPasteText('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const validItems = items.filter((it) => it.description.trim().length > 0);
    if (!title.trim() || validItems.length === 0) {
      setError('Enter an RFQ title and at least one line item description.');
      return;
    }

    try {
      setSubmitting(true);
      await onCreate({
        title: title.trim(),
        currency,
        incoterms,
        deliveryLocation,
        deadlineDate,
        invitedSupplierIds,
        items: validItems.map((it) => ({
          skuCode: it.skuCode.trim(),
          description: it.description.trim(),
          quantity: Number(it.quantity) || 1,
          uom: it.uom.trim() || 'pcs',
          targetUnitPrice: it.targetUnitPrice ? Number(it.targetUnitPrice) : null,
        })),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create RFQ');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white border border-[#E2E8F0] rounded-lg w-full max-w-4xl max-h-[90vh] flex flex-col">
        <div className="px-6 py-4 border-b border-[#E2E8F0] flex items-center justify-between">
          <div>
            <h2 className="font-display text-lg font-bold text-[#0F172A]">Create New RFQ</h2>
            <p className="text-xs text-[#475569]">
              Define required BOM items or paste directly from Excel / Google Sheets
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close modal"
            className="p-1.5 text-[#475569] hover:bg-[#F8FAFC] rounded-md"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-5">
          {error && (
            <div className="p-3 bg-[#FEF2F2] border border-[#FECACA] text-[#DC2626] text-xs rounded-md">
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-[#475569] mb-1">
                RFQ Title / Project Name
              </label>
              <input
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g., Q1 Sheet Metal Enclosure & Hardware Batch"
                className="w-full px-3 py-2 text-sm border border-[#E2E8F0] rounded-md focus:outline-none focus:border-[#0F4C81]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#475569] mb-1">
                Base Comparison Currency
              </label>
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value as 'INR' | 'USD' | 'GBP' | 'EUR')}
                className="w-full px-3 py-2 text-sm border border-[#E2E8F0] rounded-md bg-white focus:outline-none focus:border-[#0F4C81]"
              >
                <option value="INR">INR (₹)</option>
                <option value="USD">USD ($)</option>
                <option value="GBP">GBP (£)</option>
                <option value="EUR">EUR (€)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-[#475569] mb-1">
                Quote Deadline
              </label>
              <input
                type="date"
                value={deadlineDate}
                onChange={(e) => setDeadlineDate(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-[#E2E8F0] rounded-md focus:outline-none focus:border-[#0F4C81]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#475569] mb-1">
                Incoterms / Delivery Basis
              </label>
              <input
                type="text"
                value={incoterms}
                onChange={(e) => setIncoterms(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-[#E2E8F0] rounded-md focus:outline-none focus:border-[#0F4C81]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#475569] mb-1">
                Delivery Location
              </label>
              <input
                type="text"
                value={deliveryLocation}
                onChange={(e) => setDeliveryLocation(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-[#E2E8F0] rounded-md focus:outline-none focus:border-[#0F4C81]"
              />
            </div>
          </div>

          {/* Target Suppliers */}
          <div>
            <div className="text-xs font-medium text-[#475569] mb-2">
              Target Suppliers ({invitedSupplierIds.length} selected)
            </div>
            {suppliers.length === 0 ? (
              <div className="px-3 py-2.5 bg-[#F8FAFC] border border-[#E2E8F0] rounded-md text-xs text-[#475569]">
                No suppliers added yet. You can create this RFQ now and add suppliers from the Suppliers tab before uploading quotes.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {suppliers.map((s) => (
                  <label
                    key={s.id}
                    className="flex items-center gap-2.5 px-3 py-2 border border-[#E2E8F0] rounded-md text-xs cursor-pointer hover:bg-[#F8FAFC]"
                  >
                    <input
                      type="checkbox"
                      checked={invitedSupplierIds.includes(s.id)}
                      onChange={() => toggleSupplier(s.id)}
                      className="rounded border-[#CBD5E1] text-[#0F4C81]"
                    />
                    <span className="font-medium text-[#0F172A] truncate">{s.name}</span>
                    <span className="text-[#475569] ml-auto shrink-0">{s.city}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* BOM Line Items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-medium text-[#475569]">
                RFQ Line Items ({items.length})
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPasteBoxOpen((v) => !v)}
                  className="px-2.5 py-1 text-xs font-medium text-[#0F4C81] border border-[#E2E8F0] rounded-md hover:bg-[#F8FAFC] flex items-center gap-1.5"
                >
                  <ClipboardPaste className="w-3.5 h-3.5" />
                  <span>Paste from Excel</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setItems((prev) => [
                      ...prev,
                      { skuCode: '', description: '', quantity: 1, uom: 'pcs', targetUnitPrice: '' },
                    ])
                  }
                  className="px-2.5 py-1 text-xs font-medium text-[#0F172A] border border-[#E2E8F0] rounded-md hover:bg-[#F8FAFC] flex items-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Line</span>
                </button>
              </div>
            </div>

            {pasteBoxOpen && (
              <div className="mb-3 p-3 bg-[#F8FAFC] border border-[#E2E8F0] rounded-md space-y-2">
                <div className="text-xs text-[#475569]">
                  Paste tab-separated or comma-separated rows: <span className="font-mono">SKU, Description, Qty, UOM</span>
                </div>
                <textarea
                  rows={4}
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  placeholder={'MF-01\tSS304 Manifold Block\t50\tpcs\nFST-12\tM12 Hex Bolt\t500\tpcs'}
                  className="w-full p-2 text-xs font-mono border border-[#E2E8F0] rounded-md bg-white"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setPasteBoxOpen(false)}
                    className="px-3 py-1 text-xs text-[#475569]"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleParsePaste}
                    className="px-3 py-1 text-xs font-medium text-white bg-[#0F4C81] rounded-md"
                  >
                    Import Rows
                  </button>
                </div>
              </div>
            )}

            <div className="border border-[#E2E8F0] rounded-md overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-[#F8FAFC] border-b border-[#E2E8F0] text-[#475569]">
                    <th className="py-2 px-2 w-8">#</th>
                    <th className="py-2 px-2 w-28">SKU</th>
                    <th className="py-2 px-2">Item Description</th>
                    <th className="py-2 px-2 w-20 text-right">Qty</th>
                    <th className="py-2 px-2 w-20">UOM</th>
                    <th className="py-2 px-2 w-24 text-right">Target Rate</th>
                    <th className="py-2 px-2 w-8"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E2E8F0]">
                  {items.map((row, idx) => (
                    <tr key={idx}>
                      <td className="py-1.5 px-2 font-mono text-[#475569]">{idx + 1}</td>
                      <td className="py-1.5 px-2">
                        <input
                          type="text"
                          value={row.skuCode}
                          onChange={(e) =>
                            setItems((prev) =>
                              prev.map((r, i) => (i === idx ? { ...r, skuCode: e.target.value } : r))
                            )
                          }
                          placeholder="Optional"
                          className="w-full px-2 py-1 border border-[#E2E8F0] rounded font-mono"
                        />
                      </td>
                      <td className="py-1.5 px-2">
                        <input
                          type="text"
                          required
                          value={row.description}
                          onChange={(e) =>
                            setItems((prev) =>
                              prev.map((r, i) =>
                                i === idx ? { ...r, description: e.target.value } : r
                              )
                            )
                          }
                          placeholder="Exact specification / grade / size"
                          className="w-full px-2 py-1 border border-[#E2E8F0] rounded"
                        />
                      </td>
                      <td className="py-1.5 px-2">
                        <input
                          type="number"
                          min="0.01"
                          step="any"
                          value={row.quantity}
                          onChange={(e) =>
                            setItems((prev) =>
                              prev.map((r, i) =>
                                i === idx ? { ...r, quantity: Number(e.target.value) } : r
                              )
                            )
                          }
                          className="w-full px-2 py-1 border border-[#E2E8F0] rounded text-right font-mono tabular-nums"
                        />
                      </td>
                      <td className="py-1.5 px-2">
                        <input
                          type="text"
                          value={row.uom}
                          onChange={(e) =>
                            setItems((prev) =>
                              prev.map((r, i) => (i === idx ? { ...r, uom: e.target.value } : r))
                            )
                          }
                          className="w-full px-2 py-1 border border-[#E2E8F0] rounded"
                        />
                      </td>
                      <td className="py-1.5 px-2">
                        <input
                          type="number"
                          step="any"
                          value={row.targetUnitPrice}
                          onChange={(e) =>
                            setItems((prev) =>
                              prev.map((r, i) =>
                                i === idx ? { ...r, targetUnitPrice: e.target.value } : r
                              )
                            )
                          }
                          placeholder="—"
                          className="w-full px-2 py-1 border border-[#E2E8F0] rounded text-right font-mono tabular-nums"
                        />
                      </td>
                      <td className="py-1.5 px-2 text-center">
                        {items.length > 1 && (
                          <button
                            type="button"
                            onClick={() => setItems((prev) => prev.filter((_, i) => i !== idx))}
                            className="text-[#475569] hover:text-[#DC2626]"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="pt-4 border-t border-[#E2E8F0] flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-[#475569] hover:text-[#0F172A]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-5 py-2 text-sm font-medium text-white bg-[#0F4C81] rounded-lg hover:bg-[#0A365C] disabled:opacity-50"
            >
              {submitting ? 'Creating...' : 'Create RFQ'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
