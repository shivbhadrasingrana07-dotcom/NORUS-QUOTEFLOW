import { useState } from 'react';
import {
  Building2,
  FilePlus2,
  History,
  Plus,
  Search,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import {
  AuditLogEntry,
  AwardDecision,
  CatalogItem,
  OrganizationSettings,
  Quotation,
  Rfq,
  Supplier,
  TaxRegime,
  UserRole,
} from '../types.ts';
import { formatDateShort, formatMoney, rfqStatusLabel } from '../lib/format.ts';

export function RfqsListView({
  rfqs,
  quotations,
  onOpenRfq,
  onNewRfq,
}: {
  rfqs: Rfq[];
  quotations: Quotation[];
  onOpenRfq: (id: string) => void;
  onNewRfq: () => void;
}) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const filtered = rfqs.filter((r) => {
    const matchesQ =
      r.rfqNumber.toLowerCase().includes(query.toLowerCase()) ||
      r.title.toLowerCase().includes(query.toLowerCase());
    const matchesStatus = statusFilter === 'all' || r.status === statusFilter;
    return matchesQ && matchesStatus;
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-[#E2E8F0]">
        <div>
          <div className="text-xs text-[#475569]">Workspace / RFQs</div>
          <h1 className="font-display text-2xl font-bold text-[#0F172A] mt-1">
            RFQs & Quotation Folders
          </h1>
        </div>
        <button
          onClick={onNewRfq}
          className="px-4 py-2 text-sm font-medium text-white bg-[#0F4C81] rounded-lg hover:bg-[#0A365C] flex items-center gap-2 self-start sm:self-auto"
        >
          <FilePlus2 className="w-4 h-4" />
          <span>Create RFQ</span>
        </button>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="relative w-full sm:w-80">
          <Search className="w-4 h-4 text-[#475569] absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search RFQ # or title..."
            className="w-full pl-9 pr-3 py-2 text-xs bg-white border border-[#E2E8F0] rounded-lg"
          />
        </div>

        <div className="flex items-center gap-1 p-1 bg-white border border-[#E2E8F0] rounded-lg overflow-x-auto">
          {[
            { id: 'all', label: 'All' },
            { id: 'collecting', label: 'Collecting' },
            { id: 'in_review', label: 'In Review' },
            { id: 'pending_approval', label: 'Pending Approval' },
            { id: 'awarded', label: 'Awarded' },
          ].map((f) => (
            <button
              key={f.id}
              onClick={() => setStatusFilter(f.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
                statusFilter === f.id
                  ? 'bg-[#0F4C81] text-white'
                  : 'text-[#475569] hover:text-[#0F172A]'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr className="bg-[#F8FAFC] border-b border-[#E2E8F0] text-xs font-medium text-[#475569]">
                <th className="py-2.5 px-4">RFQ #</th>
                <th className="py-2.5 px-4">Title</th>
                <th className="py-2.5 px-4">Delivery Location</th>
                <th className="py-2.5 px-4 text-right">Lines</th>
                <th className="py-2.5 px-4 text-right">Quotes</th>
                <th className="py-2.5 px-4 text-right">Best Landed</th>
                <th className="py-2.5 px-4">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0]">
              {filtered.map((rfq) => {
                const rq = quotations.filter((q) => q.rfqId === rfq.id);
                const best = rq.length ? Math.min(...rq.map((q) => q.totalLandedCost)) : null;
                return (
                  <tr
                    key={rfq.id}
                    onClick={() => onOpenRfq(rfq.id)}
                    className="hover:bg-[#F8FAFC] cursor-pointer"
                  >
                    <td className="py-3 px-4 font-mono text-xs font-semibold text-[#0F4C81]">
                      {rfq.rfqNumber}
                    </td>
                    <td className="py-3 px-4 font-medium text-[#0F172A]">{rfq.title}</td>
                    <td className="py-3 px-4 text-xs text-[#475569]">{rfq.deliveryLocation}</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">
                      {rfq.items.length}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">{rq.length}</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold">
                      {best !== null ? formatMoney(best, rfq.currency) : '—'}
                    </td>
                    <td className="py-3 px-4 text-xs font-medium text-[#0F172A]">
                      {rfqStatusLabel(rfq.status)}
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

export function SuppliersView({
  suppliers,
  quotations,
  awards,
  onAddSupplier,
}: {
  suppliers: Supplier[];
  quotations: Quotation[];
  awards: AwardDecision[];
  onAddSupplier: (payload: {
    name: string;
    taxId: string;
    city: string;
    contactName: string;
    email: string;
    phoneWhatsapp: string;
    defaultPaymentTerms: string;
    categories: string[];
  }) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    name: '',
    taxId: '',
    city: '',
    contactName: '',
    email: '',
    phoneWhatsapp: '',
    defaultPaymentTerms: 'Net 30 Days',
    categoriesText: '',
  });
  const [error, setError] = useState<string | null>(null);

  const filtered = suppliers.filter(
    (s) =>
      s.name.toLowerCase().includes(query.toLowerCase()) ||
      s.taxId.toLowerCase().includes(query.toLowerCase()) ||
      s.city.toLowerCase().includes(query.toLowerCase())
  );

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await onAddSupplier({
        name: form.name,
        taxId: form.taxId,
        city: form.city,
        contactName: form.contactName,
        email: form.email,
        phoneWhatsapp: form.phoneWhatsapp,
        defaultPaymentTerms: form.defaultPaymentTerms,
        categories: form.categoriesText
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean),
      });
      setForm({
        name: '',
        taxId: '',
        city: '',
        contactName: '',
        email: '',
        phoneWhatsapp: '',
        defaultPaymentTerms: 'Net 30 Days',
        categoriesText: '',
      });
      setAdding(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add supplier');
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-[#E2E8F0]">
        <div>
          <div className="text-xs text-[#475569]">Workspace / Suppliers</div>
          <h1 className="font-display text-2xl font-bold text-[#0F172A] mt-1">
            Supplier Directory & Performance
          </h1>
        </div>
        <button
          onClick={() => setAdding((v) => !v)}
          className="px-4 py-2 text-sm font-medium text-white bg-[#0F4C81] rounded-lg hover:bg-[#0A365C] flex items-center gap-2 self-start sm:self-auto"
        >
          <Plus className="w-4 h-4" />
          <span>Add Supplier</span>
        </button>
      </div>

      {adding && (
        <form
          onSubmit={handleCreate}
          className="bg-white border border-[#E2E8F0] rounded-lg p-5 space-y-4"
        >
          <div className="text-sm font-semibold text-[#0F172A]">New Supplier Profile</div>
          {error && (
            <div className="p-2.5 bg-[#FEF2F2] border border-[#FECACA] text-[#DC2626] text-xs rounded">
              {error}
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
            <input
              required
              placeholder="Legal Company Name *"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="px-3 py-2 border border-[#E2E8F0] rounded-md"
            />
            <input
              placeholder="GSTIN / VAT / Tax ID"
              value={form.taxId}
              onChange={(e) => setForm({ ...form, taxId: e.target.value })}
              className="px-3 py-2 border border-[#E2E8F0] rounded-md font-mono"
            />
            <input
              placeholder="City / State"
              value={form.city}
              onChange={(e) => setForm({ ...form, city: e.target.value })}
              className="px-3 py-2 border border-[#E2E8F0] rounded-md"
            />
            <input
              placeholder="Contact Name"
              value={form.contactName}
              onChange={(e) => setForm({ ...form, contactName: e.target.value })}
              className="px-3 py-2 border border-[#E2E8F0] rounded-md"
            />
            <input
              type="email"
              placeholder="Email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="px-3 py-2 border border-[#E2E8F0] rounded-md"
            />
            <input
              placeholder="WhatsApp / Phone"
              value={form.phoneWhatsapp}
              onChange={(e) => setForm({ ...form, phoneWhatsapp: e.target.value })}
              className="px-3 py-2 border border-[#E2E8F0] rounded-md font-mono"
            />
            <input
              placeholder="Default Payment Terms"
              value={form.defaultPaymentTerms}
              onChange={(e) => setForm({ ...form, defaultPaymentTerms: e.target.value })}
              className="px-3 py-2 border border-[#E2E8F0] rounded-md"
            />
            <input
              placeholder="Categories (comma separated)"
              value={form.categoriesText}
              onChange={(e) => setForm({ ...form, categoriesText: e.target.value })}
              className="sm:col-span-2 px-3 py-2 border border-[#E2E8F0] rounded-md"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="px-3 py-1.5 text-xs text-[#475569]"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 text-xs font-medium text-white bg-[#0F4C81] rounded-md"
            >
              Save Supplier
            </button>
          </div>
        </form>
      )}

      <div className="relative w-full sm:w-80">
        <Search className="w-4 h-4 text-[#475569] absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, GSTIN, city..."
          className="w-full pl-9 pr-3 py-2 text-xs bg-white border border-[#E2E8F0] rounded-lg"
        />
      </div>

      <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-[#F8FAFC] border-b border-[#E2E8F0] text-[#475569]">
                <th className="py-2.5 px-4">Supplier</th>
                <th className="py-2.5 px-4">GSTIN / Tax ID</th>
                <th className="py-2.5 px-4">Contact & WhatsApp</th>
                <th className="py-2.5 px-4">Default Terms</th>
                <th className="py-2.5 px-4 text-right">Quotes</th>
                <th className="py-2.5 px-4 text-right">Awards Won</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0]">
              {filtered.map((s) => {
                const quoteCount = quotations.filter((q) => q.supplierId === s.id).length;
                const wonCount = awards.filter(
                  (a) =>
                    a.approvalStatus === 'approved' &&
                    a.allocations.some((al) => al.supplierId === s.id)
                ).length;
                return (
                  <tr key={s.id} className="hover:bg-[#F8FAFC]">
                    <td className="py-3 px-4">
                      <div className="font-semibold text-sm text-[#0F172A] flex items-center gap-2">
                        <Building2 className="w-3.5 h-3.5 text-[#475569]" />
                        <span>{s.name}</span>
                      </div>
                      <div className="text-[#475569] mt-0.5">
                        {s.city}
                        {s.categories.length > 0 && ` · ${s.categories.join(', ')}`}
                      </div>
                    </td>
                    <td className="py-3 px-4 font-mono text-[#0F172A]">{s.taxId || '—'}</td>
                    <td className="py-3 px-4 text-[#475569]">
                      <div>{s.contactName || '—'}</div>
                      <div className="font-mono">{s.phoneWhatsapp || s.email}</div>
                    </td>
                    <td className="py-3 px-4 text-[#0F172A]">{s.defaultPaymentTerms}</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">{quoteCount}</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold text-[#059669]">
                      {wonCount}
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

export function ItemsView({ items, suppliers }: { items: CatalogItem[]; suppliers: Supplier[] }) {
  const [query, setQuery] = useState('');
  const filtered = items.filter(
    (it) =>
      it.name.toLowerCase().includes(query.toLowerCase()) ||
      it.skuCode.toLowerCase().includes(query.toLowerCase()) ||
      it.hsnSacCode.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="space-y-5">
      <div className="pb-4 border-b border-[#E2E8F0]">
        <div className="text-xs text-[#475569]">Workspace / Item Price Memory</div>
        <h1 className="font-display text-2xl font-bold text-[#0F172A] mt-1">
          Item Master & Historical Price Intelligence
        </h1>
      </div>

      <div className="relative w-full sm:w-80">
        <Search className="w-4 h-4 text-[#475569] absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search SKU, item name, HSN..."
          className="w-full pl-9 pr-3 py-2 text-xs bg-white border border-[#E2E8F0] rounded-lg"
        />
      </div>

      <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-[#F8FAFC] border-b border-[#E2E8F0] text-[#475569]">
                <th className="py-2.5 px-4">SKU</th>
                <th className="py-2.5 px-4">Item Description</th>
                <th className="py-2.5 px-4">HSN / SAC</th>
                <th className="py-2.5 px-4">Last Supplier</th>
                <th className="py-2.5 px-4 text-right">Last Awarded Landed</th>
                <th className="py-2.5 px-4">Last Awarded Date</th>
                <th className="py-2.5 px-4 text-right">Trend</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0]">
              {filtered.map((item) => {
                const supName =
                  suppliers.find((s) => s.id === item.lastSupplierId)?.name || '—';
                const prev = item.priceHistory[1]?.unitLandedPrice;
                const curr = item.lastAwardedUnitPrice;
                const deltaPct = prev && curr ? ((curr - prev) / prev) * 100 : null;
                return (
                  <tr key={item.id} className="hover:bg-[#F8FAFC]">
                    <td className="py-3 px-4 font-mono font-semibold text-[#0F4C81]">
                      {item.skuCode || '—'}
                    </td>
                    <td className="py-3 px-4 font-medium text-sm text-[#0F172A]">
                      {item.name}
                      <span className="text-xs font-normal text-[#475569] ml-2">
                        ({item.defaultUom})
                      </span>
                    </td>
                    <td className="py-3 px-4 font-mono text-[#475569]">
                      {item.hsnSacCode || '—'}
                    </td>
                    <td className="py-3 px-4 text-[#0F172A]">{supName}</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums font-bold text-[#0F172A]">
                      {curr !== null
                        ? formatMoney(curr, item.lastAwardedCurrency || 'INR')
                        : '—'}
                    </td>
                    <td className="py-3 px-4 font-mono text-[#475569]">
                      {formatDateShort(item.lastAwardedAt)}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">
                      {deltaPct === null ? (
                        <span className="text-[#475569]">Baseline</span>
                      ) : deltaPct > 0 ? (
                        <span className="text-[#DC2626] inline-flex items-center gap-1">
                          <TrendingUp className="w-3.5 h-3.5" />+{deltaPct.toFixed(1)}%
                        </span>
                      ) : (
                        <span className="text-[#059669] inline-flex items-center gap-1">
                          <TrendingDown className="w-3.5 h-3.5" />
                          {deltaPct.toFixed(1)}%
                        </span>
                      )}
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

export function ReportsView({
  awards,
  rfqs,
  auditLogs,
  onOpenRfq,
}: {
  awards: AwardDecision[];
  rfqs: Rfq[];
  auditLogs: AuditLogEntry[];
  onOpenRfq: (rfqId: string) => void;
}) {
  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-[#E2E8F0]">
        <div className="text-xs text-[#475569]">Workspace / CS Archive & Audit</div>
        <h1 className="font-display text-2xl font-bold text-[#0F172A] mt-1">
          Comparative Statements & Audit Trail
        </h1>
      </div>

      <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
        <div className="px-5 py-3.5 border-b border-[#E2E8F0]">
          <h2 className="font-display text-sm font-semibold text-[#0F172A]">
            Award Decisions ({awards.length})
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-[#F8FAFC] border-b border-[#E2E8F0] text-[#475569]">
                <th className="py-2.5 px-4">RFQ #</th>
                <th className="py-2.5 px-4">Type</th>
                <th className="py-2.5 px-4">Recommended By</th>
                <th className="py-2.5 px-4">Approved By</th>
                <th className="py-2.5 px-4 text-right">Total Landed</th>
                <th className="py-2.5 px-4">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0]">
              {awards.map((a) => {
                const rfq = rfqs.find((r) => r.id === a.rfqId);
                return (
                  <tr
                    key={a.id}
                    onClick={() => onOpenRfq(a.rfqId)}
                    className="hover:bg-[#F8FAFC] cursor-pointer"
                  >
                    <td className="py-3 px-4 font-mono font-semibold text-[#0F4C81]">
                      {rfq?.rfqNumber || a.rfqId}
                    </td>
                    <td className="py-3 px-4">{a.isSplitAward ? 'Split Award' : 'Full Package'}</td>
                    <td className="py-3 px-4">{a.recommendedBy}</td>
                    <td className="py-3 px-4">{a.approvedBy || 'Pending'}</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold">
                      {formatMoney(a.totalAwardedLanded, rfq?.currency || 'INR')}
                    </td>
                    <td className="py-3 px-4 font-semibold uppercase">{a.approvalStatus}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
        <div className="px-5 py-3.5 border-b border-[#E2E8F0] flex items-center gap-2">
          <History className="w-4 h-4 text-[#475569]" />
          <h2 className="font-display text-sm font-semibold text-[#0F172A]">
            Immutable Extraction & Approval Audit Log
          </h2>
        </div>
        <div className="divide-y divide-[#E2E8F0] max-h-96 overflow-y-auto">
          {auditLogs.map((log) => (
            <div key={log.id} className="px-5 py-3 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <span className="font-mono font-semibold text-[#0F4C81] mr-2">{log.action}</span>
                <span className="text-[#0F172A]">{log.detail}</span>
              </div>
              <div className="text-[#475569] font-mono shrink-0">
                {log.actorName} · {formatDateShort(log.createdAt)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function SettingsView({
  settings,
  onSaveSettings,
}: {
  settings: OrganizationSettings;
  onSaveSettings: (patch: Partial<OrganizationSettings>) => Promise<void>;
}) {
  const [name, setName] = useState(settings.name);
  const [currency, setCurrency] = useState(settings.defaultCurrency);
  const [taxRegime, setTaxRegime] = useState<TaxRegime>(settings.taxRegime);
  const [itc, setItc] = useState(settings.defaultTaxCreditable);
  const [role, setRole] = useState<UserRole>(settings.activeUserRole);
  const [saved, setSaved] = useState(false);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSaveSettings({
      name,
      defaultCurrency: currency,
      taxRegime,
      defaultTaxCreditable: itc,
      activeUserRole: role,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="space-y-5 max-w-2xl">
      <div className="pb-4 border-b border-[#E2E8F0]">
        <div className="text-xs text-[#475569]">Workspace / Settings</div>
        <h1 className="font-display text-2xl font-bold text-[#0F172A] mt-1">
          Organization & Normalization Defaults
        </h1>
      </div>

      <form
        onSubmit={handleSave}
        className="bg-white border border-[#E2E8F0] rounded-lg p-6 space-y-4 text-sm"
      >
        <div>
          <label className="block text-xs font-medium text-[#475569] mb-1">
            Organization Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 border border-[#E2E8F0] rounded-md"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-[#475569] mb-1">
              Default Currency
            </label>
            <select
              value={currency}
              onChange={(e) =>
                setCurrency(e.target.value as OrganizationSettings['defaultCurrency'])
              }
              className="w-full px-3 py-2 border border-[#E2E8F0] rounded-md bg-white"
            >
              <option value="INR">INR (₹)</option>
              <option value="USD">USD ($)</option>
              <option value="GBP">GBP (£)</option>
              <option value="EUR">EUR (€)</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-[#475569] mb-1">
              Tax Regime
            </label>
            <select
              value={taxRegime}
              onChange={(e) => setTaxRegime(e.target.value as TaxRegime)}
              className="w-full px-3 py-2 border border-[#E2E8F0] rounded-md bg-white"
            >
              <option value="INDIA_GST">India GST (CGST+SGST / IGST)</option>
              <option value="UK_VAT">UK / EU VAT</option>
              <option value="US_TAX">US Sales Tax</option>
              <option value="NONE">Tax Exempt</option>
            </select>
          </div>
        </div>

        <label className="flex items-center gap-2.5 text-xs text-[#0F172A] cursor-pointer">
          <input
            type="checkbox"
            checked={itc}
            onChange={(e) => setItc(e.target.checked)}
            className="rounded border-[#CBD5E1]"
          />
          <span>
            Input Tax Credit (ITC) / VAT Reclaim Eligible by default (excludes creditable GST/VAT from Net Landed Cost)
          </span>
        </label>

        <div>
          <label className="block text-xs font-medium text-[#475569] mb-1">
            Active User Role (RBAC Simulation)
          </label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as UserRole)}
            className="w-full px-3 py-2 border border-[#E2E8F0] rounded-md bg-white"
          >
            <option value="buyer">Buyer (Create RFQs, Upload/Verify Quotes, Recommend Awards)</option>
            <option value="approver">Approver / MD (Approve/Reject Awards)</option>
            <option value="admin">Admin (Full Workspace & Approval Access)</option>
            <option value="viewer">Viewer (Read-Only Finance / Audit)</option>
          </select>
        </div>

        <div className="pt-2 flex items-center gap-3">
          <button
            type="submit"
            className="px-4 py-2 text-sm font-medium text-white bg-[#0F4C81] rounded-lg hover:bg-[#0A365C]"
          >
            Save Settings
          </button>
          {saved && <span className="text-xs font-medium text-[#059669]">Saved</span>}
        </div>
      </form>
    </div>
  );
}
