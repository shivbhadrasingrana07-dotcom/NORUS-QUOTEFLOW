import { useCallback, useEffect, useState } from 'react';
import { NavSection, Sidebar } from './components/Sidebar.tsx';
import { DashboardView } from './components/DashboardView.tsx';
import { RfqCreateModal } from './components/RfqCreateModal.tsx';
import { RfqTab, RfqWorkspace } from './components/RfqWorkspace.tsx';
import {
  ItemsView,
  ReportsView,
  RfqsListView,
  SettingsView,
  SuppliersView,
} from './components/SecondaryViews.tsx';
import {
  AwardAllocation,
  OrganizationSettings,
  Quotation,
  QuotationLine,
  UserRole,
  WorkspaceState,
} from './types.ts';

async function apiJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data as T;
}

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [activeSection, setActiveSection] = useState<NavSection>('dashboard');
  const [activeRfqId, setActiveRfqId] = useState<string | null>(null);
  const [activeRfqTab, setActiveRfqTab] = useState<RfqTab>('compare');
  const [selectedQuoteId, setSelectedQuoteId] = useState<string | null>(null);

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [loadingSample, setLoadingSample] = useState(false);

  const refreshWorkspace = useCallback(async () => {
    try {
      const data = await apiJson<WorkspaceState>('/api/workspace');
      setWorkspace(data);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load workspace');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshWorkspace();
  }, [refreshWorkspace]);

  const handleOpenRfq = (rfqId: string, tab: RfqTab = 'compare', quoteId?: string) => {
    setActiveRfqId(rfqId);
    setActiveRfqTab(tab);
    setSelectedQuoteId(quoteId || null);
    setActiveSection('rfqs');
  };

  const handleLoadSample = async () => {
    try {
      setLoadingSample(true);
      const result = await apiJson<{ rfq: { id: string } }>('/api/rfqs/load-sample', {
        method: 'POST',
      });
      await refreshWorkspace();
      handleOpenRfq(result.rfq.id, 'compare');
    } finally {
      setLoadingSample(false);
    }
  };

  const handleRoleSwitch = async (role: UserRole, activeUserName: string, activeUserTitle: string) => {
    await apiJson('/api/demo/switch-persona', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeUserRole: role, activeUserName, activeUserTitle }),
    });
    await refreshWorkspace();
  };

  const handleSaveSettings = async (patch: Partial<OrganizationSettings>) => {
    await apiJson('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    await refreshWorkspace();
  };

  const handleCreateRfq = async (payload: {
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
  }) => {
    const created = await apiJson<{ id: string }>('/api/rfqs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    await refreshWorkspace();
    handleOpenRfq(created.id, 'upload');
  };

  const handleAddSupplier = async (payload: {
    name: string;
    taxId: string;
    city: string;
    contactName: string;
    email: string;
    phoneWhatsapp: string;
    defaultPaymentTerms: string;
    categories: string[];
  }) => {
    await apiJson('/api/suppliers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    await refreshWorkspace();
  };

  const handleExtractQuote = async (params: {
    rfqId: string;
    supplierId: string;
    file?: File;
    rawEmailText?: string;
  }): Promise<Quotation> => {
    const formData = new FormData();
    formData.append('supplierId', params.supplierId);
    if (params.file) formData.append('file', params.file);
    if (params.rawEmailText) formData.append('rawEmailText', params.rawEmailText);

    const created = await apiJson<Quotation>(`/api/rfqs/${params.rfqId}/quotes/extract`, {
      method: 'POST',
      body: formData,
    });
    await refreshWorkspace();
    return created;
  };

  const handleUpdateHeader = async (quoteId: string, patch: Partial<Quotation>) => {
    await apiJson(`/api/quotations/${quoteId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    await refreshWorkspace();
  };

  const handleUpdateLine = async (
    quoteId: string,
    lineId: string,
    patch: Partial<QuotationLine>
  ) => {
    await apiJson(`/api/quotations/${quoteId}/lines/${lineId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    await refreshWorkspace();
  };

  const handleVerifyQuote = async (quoteId: string) => {
    await apiJson(`/api/quotations/${quoteId}/verify`, { method: 'POST' });
    await refreshWorkspace();
  };

  const handleDeleteQuote = async (quoteId: string) => {
    await apiJson(`/api/quotations/${quoteId}`, { method: 'DELETE' });
    await refreshWorkspace();
  };

  const handleSubmitAward = async (params: {
    rfqId: string;
    isSplitAward: boolean;
    allocations: AwardAllocation[];
    totalAwardedLanded: number;
    isNonL1: boolean;
    nonL1Justification: string;
  }) => {
    await apiJson(`/api/rfqs/${params.rfqId}/award`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    await refreshWorkspace();
  };

  const handleDecideAward = async (
    awardId: string,
    decision: 'approved' | 'rejected',
    approverNotes: string
  ) => {
    await apiJson(`/api/awards/${awardId}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, approverNotes }),
    });
    await refreshWorkspace();
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center">
        <div className="w-full max-w-md p-6 space-y-3">
          <div className="h-5 w-48 bg-slate-200 rounded animate-pulse" />
          <div className="h-24 w-full bg-slate-200 rounded animate-pulse" />
          <div className="h-24 w-full bg-slate-200 rounded animate-pulse" />
        </div>
      </div>
    );
  }

  if (loadError || !workspace) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center p-6">
        <div className="bg-white border border-[#E2E8F0] rounded-lg p-6 max-w-md space-y-3">
          <div className="text-sm font-semibold text-[#DC2626]">
            Unable to load workspace
          </div>
          <p className="text-xs text-[#475569]">{loadError || 'Unknown error'}</p>
          <button
            onClick={refreshWorkspace}
            className="px-4 py-2 text-xs font-medium text-white bg-[#0F4C81] rounded-md"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const pendingReviewCount = workspace.quotations.filter((q) => !q.isVerified).length;
  const pendingApprovalCount = workspace.awards.filter(
    (a) => a.approvalStatus === 'pending'
  ).length;

  const activeRfq = activeRfqId
    ? workspace.rfqs.find((r) => r.id === activeRfqId) || null
    : null;

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex">
      <Sidebar
        activeSection={activeSection}
        onNavigate={(section) => {
          setActiveSection(section);
          if (section !== 'rfqs') {
            setActiveRfqId(null);
          } else if (section === 'rfqs' && activeRfqId) {
            setActiveRfqId(null);
          }
        }}
        settings={workspace.settings}
        pendingReviewCount={pendingReviewCount}
        pendingApprovalCount={pendingApprovalCount}
        onRoleSwitch={handleRoleSwitch}
      />

      <main className="flex-1 min-w-0 pt-16 lg:pt-0">
        <div className="max-w-[1360px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
          {activeSection === 'dashboard' && (
            <DashboardView
              rfqs={workspace.rfqs}
              quotations={workspace.quotations}
              suppliers={workspace.suppliers}
              awards={workspace.awards}
              defaultCurrency={workspace.settings.defaultCurrency}
              onOpenRfq={handleOpenRfq}
              onNewRfq={() => setCreateModalOpen(true)}
              onLoadSample={handleLoadSample}
              loadingSample={loadingSample}
            />
          )}

          {activeSection === 'rfqs' && activeRfq && (
            <RfqWorkspace
              rfq={activeRfq}
              quotes={workspace.quotations.filter((q) => q.rfqId === activeRfq.id)}
              suppliers={workspace.suppliers}
              catalogItems={workspace.items}
              awards={workspace.awards}
              auditLogs={workspace.auditLogs}
              settings={workspace.settings}
              activeTab={activeRfqTab}
              selectedQuoteId={selectedQuoteId}
              onChangeTab={setActiveRfqTab}
              onSelectQuote={setSelectedQuoteId}
              onBack={() => setActiveRfqId(null)}
              onExtractQuote={handleExtractQuote}
              onUpdateHeader={handleUpdateHeader}
              onUpdateLine={handleUpdateLine}
              onVerifyQuote={handleVerifyQuote}
              onDeleteQuote={handleDeleteQuote}
              onSubmitAward={handleSubmitAward}
              onDecideAward={handleDecideAward}
            />
          )}

          {activeSection === 'rfqs' && !activeRfq && (
            <RfqsListView
              rfqs={workspace.rfqs}
              quotations={workspace.quotations}
              onOpenRfq={(id) => {
                const hasQuotes = workspace.quotations.some((q) => q.rfqId === id);
                handleOpenRfq(id, hasQuotes ? 'compare' : 'upload');
              }}
              onNewRfq={() => setCreateModalOpen(true)}
            />
          )}

          {activeSection === 'suppliers' && (
            <SuppliersView
              suppliers={workspace.suppliers}
              quotations={workspace.quotations}
              awards={workspace.awards}
              onAddSupplier={handleAddSupplier}
            />
          )}

          {activeSection === 'items' && (
            <ItemsView items={workspace.items} suppliers={workspace.suppliers} />
          )}

          {activeSection === 'reports' && (
            <ReportsView
              awards={workspace.awards}
              rfqs={workspace.rfqs}
              auditLogs={workspace.auditLogs}
              onOpenRfq={(rfqId) => handleOpenRfq(rfqId, 'approval')}
            />
          )}

          {activeSection === 'settings' && (
            <SettingsView
              settings={workspace.settings}
              onSaveSettings={handleSaveSettings}
            />
          )}
        </div>
      </main>

      {createModalOpen && (
        <RfqCreateModal
          suppliers={workspace.suppliers}
          defaultCurrency={workspace.settings.defaultCurrency}
          onClose={() => setCreateModalOpen(false)}
          onCreate={handleCreateRfq}
        />
      )}
    </div>
  );
}
