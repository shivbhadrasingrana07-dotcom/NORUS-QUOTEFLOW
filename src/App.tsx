import { useCallback, useEffect, useRef, useState } from 'react';
import { AuthView } from './components/AuthView.tsx';
import { DashboardView } from './components/DashboardView.tsx';
import { OrganizationView } from './components/OrganizationView.tsx';
import { RfqCreateModal } from './components/RfqCreateModal.tsx';
import { RfqTab, RfqWorkspace } from './components/RfqWorkspace.tsx';
import {
  ItemsView,
  ReportsView,
  RfqsListView,
  SettingsView,
  SuppliersView,
} from './components/SecondaryViews.tsx';
import { NavSection, Sidebar } from './components/Sidebar.tsx';
import { RotateCcw } from 'lucide-react';
import {
  AuthStatePayload,
  AwardAllocation,
  AuthUser,
  OrganizationSettings,
  OrganizationSummary,
  Quotation,
  QuotationLine,
  WorkspaceState,
} from './types.ts';

interface DemoWorkspaceResponse extends WorkspaceState {
  demoMode: true;
  demoSessionId: string;
  user: AuthUser;
  activeOrganization: OrganizationSummary;
  organizations: OrganizationSummary[];
}

const DEMO_SESSION_STORAGE_KEY = 'norus_demo_session_id';

function readCookie(name: string): string | null {
  const parts = document.cookie.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return part.slice(eq + 1).trim();
      }
    }
  }
  return null;
}

function getInitialUrlTokens() {
  const params = new URLSearchParams(window.location.search);
  return {
    invite: params.get('invite'),
    verify: params.get('verify'),
    reset: params.get('reset'),
  };
}

export default function App() {
  const [urlTokens, setUrlTokens] = useState(getInitialUrlTokens);
  const [authState, setAuthState] = useState<AuthStatePayload | null>(null);
  const [demoMode, setDemoMode] = useState(false);
  const [demoSessionId, setDemoSessionId] = useState<string | null>(() => {
    try {
      return window.sessionStorage.getItem(DEMO_SESSION_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const demoSessionIdRef = useRef<string | null>(demoSessionId);
  const csrfTokenRef = useRef<string | null>(null);

  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [activeSection, setActiveSection] = useState<NavSection>('dashboard');
  const [activeRfqId, setActiveRfqId] = useState<string | null>(null);
  const [activeRfqTab, setActiveRfqTab] = useState<RfqTab>('compare');
  const [selectedQuoteId, setSelectedQuoteId] = useState<string | null>(null);

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [loadingSample, setLoadingSample] = useState(false);
  const [resettingDemo, setResettingDemo] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const clearUrlParams = useCallback(() => {
    if (window.location.search) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
    setUrlTokens({ invite: null, verify: null, reset: null });
  }, []);

  const apiJson = useCallback(async <T,>(url: string, options?: RequestInit): Promise<T> => {
    const method = (options?.method || 'GET').toUpperCase();
    const headers = new Headers(options?.headers || {});
    if (url.startsWith('/api/demo-workspace') && demoSessionIdRef.current && !headers.has('X-Demo-Session')) {
      headers.set('X-Demo-Session', demoSessionIdRef.current);
    }
    if (
      !url.startsWith('/api/demo-workspace') &&
      method !== 'GET' &&
      method !== 'HEAD' &&
      method !== 'OPTIONS'
    ) {
      const csrf = csrfTokenRef.current || readCookie('nf_csrf');
      if (csrf && !headers.has('X-CSRF-Token')) {
        headers.set('X-CSRF-Token', csrf);
      }
    }
    const res = await fetch(url, {
      ...options,
      headers,
      credentials: 'include',
    });
    const data = await res.json();
    if (res.status === 401 && !url.startsWith('/api/demo-workspace')) {
      csrfTokenRef.current = null;
      setAuthState({
        authenticated: false,
        user: null,
        activeOrganization: null,
        organizations: [],
        csrfToken: null,
        googleAuthEnabled: true,
        demoMode: false,
      });
      setWorkspace(null);
      throw new Error(data.error || 'Session expired. Please sign in again.');
    }
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data as T;
  }, []);

  const applyDemoResponse = useCallback((demo: DemoWorkspaceResponse) => {
    demoSessionIdRef.current = demo.demoSessionId;
    setDemoSessionId(demo.demoSessionId);
    try {
      window.sessionStorage.setItem(DEMO_SESSION_STORAGE_KEY, demo.demoSessionId);
    } catch {
      // Ignore storage errors
    }
    setDemoMode(true);
    setAuthState({
      authenticated: true,
      user: demo.user,
      activeOrganization: demo.activeOrganization,
      organizations: demo.organizations,
      csrfToken: null,
      googleAuthEnabled: false,
      demoMode: true,
    });
    setWorkspace({
      settings: demo.settings,
      suppliers: demo.suppliers,
      items: demo.items,
      rfqs: demo.rfqs,
      quotations: demo.quotations,
      awards: demo.awards,
      auditLogs: demo.auditLogs,
    });
    setLoadError(null);
  }, []);

  const refreshAll = useCallback(async () => {
    try {
      const me = await apiJson<AuthStatePayload>('/api/auth/me');
      if (me.demoMode) {
        const demo = await apiJson<DemoWorkspaceResponse>('/api/demo-workspace');
        applyDemoResponse(demo);
        return;
      }

      setDemoMode(false);
      csrfTokenRef.current = me.csrfToken;
      setAuthState(me);

      if (!me.authenticated) {
        setWorkspace(null);
        setLoadError(null);
        return;
      }

      // Auto-accept invite link if signed-in user opens an ?invite=... link
      if (urlTokens.invite && me.csrfToken) {
        try {
          await fetch('/api/invitations/accept', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-CSRF-Token': me.csrfToken,
            },
            credentials: 'include',
            body: JSON.stringify({ token: urlTokens.invite }),
          });
          clearUrlParams();
          const updatedMe = await apiJson<AuthStatePayload>('/api/auth/me');
          csrfTokenRef.current = updatedMe.csrfToken;
          setAuthState(updatedMe);
        } catch {
          // Non-fatal: user can also manage orgs directly
        }
      }

      if (me.activeOrganization) {
        const ws = await apiJson<WorkspaceState>('/api/workspace');
        setWorkspace(ws);
      } else {
        setWorkspace(null);
      }
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load workspace');
    } finally {
      setLoading(false);
    }
  }, [apiJson, applyDemoResponse, clearUrlParams, urlTokens.invite]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  const handleAuthenticated = async (payload: AuthStatePayload) => {
    csrfTokenRef.current = payload.csrfToken;
    setAuthState(payload);
    setActiveSection('dashboard');
    setActiveRfqId(null);
    await refreshAll();
  };

  const handleSignOut = async () => {
    try {
      await apiJson('/api/auth/logout', { method: 'POST' });
    } catch {
      // Clear local state regardless
    }
    csrfTokenRef.current = null;
    setWorkspace(null);
    setAuthState({
      authenticated: false,
      user: null,
      activeOrganization: null,
      organizations: [],
      csrfToken: null,
      googleAuthEnabled: true,
    });
  };

  const handleSwitchOrganization = async (organizationId: string) => {
    await apiJson('/api/organizations/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizationId }),
    });
    setActiveRfqId(null);
    setSelectedQuoteId(null);
    await refreshAll();
  };

  const handleOpenRfq = (rfqId: string, tab: RfqTab = 'compare', quoteId?: string) => {
    setActiveRfqId(rfqId);
    setActiveRfqTab(tab);
    setSelectedQuoteId(quoteId || null);
    setActiveSection('rfqs');
  };

  const apiPrefix = demoMode ? '/api/demo-workspace' : '/api';

  const handleResetDemo = async () => {
    if (!demoMode || resettingDemo) return;
    try {
      setActionError(null);
      setResettingDemo(true);
      const reset = await apiJson<DemoWorkspaceResponse>('/api/demo-workspace/reset', {
        method: 'POST',
      });
      setActiveRfqId(null);
      setSelectedQuoteId(null);
      setActiveSection('dashboard');
      applyDemoResponse(reset);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to reset demo workspace.');
    } finally {
      setResettingDemo(false);
    }
  };

  const handleLoadSample = async () => {
    try {
      setActionError(null);
      setLoadingSample(true);
      const result = await apiJson<{ rfq: { id: string } }>(`${apiPrefix}/rfqs/load-sample`, {
        method: 'POST',
      });
      await refreshAll();
      handleOpenRfq(result.rfq.id, 'compare');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to load sample RFQ.');
    } finally {
      setLoadingSample(false);
    }
  };

  const handleSaveSettings = async (patch: Partial<OrganizationSettings>) => {
    await apiJson(`${apiPrefix}/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    await refreshAll();
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
    const created = await apiJson<{ id: string }>(`${apiPrefix}/rfqs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    await refreshAll();
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
    await apiJson(`${apiPrefix}/suppliers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    await refreshAll();
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

    const created = await apiJson<Quotation>(`${apiPrefix}/rfqs/${params.rfqId}/quotes/extract`, {
      method: 'POST',
      body: formData,
    });
    await refreshAll();
    return created;
  };

  const handleUpdateHeader = async (quoteId: string, patch: Partial<Quotation>) => {
    await apiJson(`${apiPrefix}/quotations/${quoteId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    await refreshAll();
  };

  const handleUpdateLine = async (
    quoteId: string,
    lineId: string,
    patch: Partial<QuotationLine>
  ) => {
    await apiJson(`${apiPrefix}/quotations/${quoteId}/lines/${lineId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    await refreshAll();
  };

  const handleVerifyQuote = async (quoteId: string) => {
    await apiJson(`${apiPrefix}/quotations/${quoteId}/verify`, { method: 'POST' });
    await refreshAll();
  };

  const handleDeleteQuote = async (quoteId: string) => {
    await apiJson(`${apiPrefix}/quotations/${quoteId}`, { method: 'DELETE' });
    await refreshAll();
  };

  const handleSubmitAward = async (params: {
    rfqId: string;
    isSplitAward: boolean;
    allocations: AwardAllocation[];
    totalAwardedLanded: number;
    isNonL1: boolean;
    nonL1Justification: string;
    acceptedAlternateLineIds?: string[];
    commercialExceptionAccepted?: boolean;
  }) => {
    await apiJson(`${apiPrefix}/rfqs/${params.rfqId}/award`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    await refreshAll();
  };

  const handleDecideAward = async (
    awardId: string,
    decision: 'approved' | 'rejected',
    approverNotes: string
  ) => {
    await apiJson(`${apiPrefix}/awards/${awardId}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, approverNotes }),
    });
    await refreshAll();
  };

  const handleWithdrawAward = async (awardId: string) => {
    await apiJson(`${apiPrefix}/awards/${awardId}/withdraw`, {
      method: 'POST',
    });
    await refreshAll();
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

  if (!demoMode && (!authState?.authenticated || !authState.user)) {
    return (
      <AuthView
        initialInviteToken={urlTokens.invite}
        initialVerifyToken={urlTokens.verify}
        initialResetToken={urlTokens.reset}
        onAuthenticated={handleAuthenticated}
        onClearUrlParams={clearUrlParams}
      />
    );
  }

  if (!demoMode && authState?.user && !authState.activeOrganization) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] p-6">
        <div className="max-w-4xl mx-auto space-y-4">
          <div className="flex items-center justify-between">
            <div className="font-display text-lg font-bold text-[#0F172A]">NORUS QUOTEFLOW</div>
            <button
              onClick={handleSignOut}
              className="px-3 py-1.5 text-xs font-medium text-[#475569] bg-white border border-[#E2E8F0] rounded-md"
            >
              Sign Out
            </button>
          </div>
          <OrganizationView
            user={authState.user}
            activeOrganization={null}
            organizations={authState.organizations}
            onApiJson={apiJson}
            onRefreshAuthAndWorkspace={refreshAll}
          />
        </div>
      </div>
    );
  }

  if (loadError || !workspace || !authState?.user || !authState?.activeOrganization) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center p-6">
        <div className="bg-white border border-[#E2E8F0] rounded-lg p-6 max-w-md space-y-3">
          <div className="text-sm font-semibold text-[#DC2626]">Unable to load workspace</div>
          <p className="text-xs text-[#475569]">{loadError || 'Unknown error'}</p>
          <div className="flex gap-2">
            <button
              onClick={refreshAll}
              className="px-4 py-2 text-xs font-medium text-white bg-[#0F4C81] rounded-md"
            >
              Retry
            </button>
            {!demoMode && (
              <button
                onClick={handleSignOut}
                className="px-4 py-2 text-xs font-medium text-[#475569] border border-[#E2E8F0] rounded-md"
              >
                Sign Out
              </button>
            )}
          </div>
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
        user={authState.user}
        activeOrganization={authState.activeOrganization}
        organizations={authState.organizations}
        pendingReviewCount={pendingReviewCount}
        pendingApprovalCount={pendingApprovalCount}
        onSwitchOrganization={handleSwitchOrganization}
        onSignOut={demoMode ? undefined : handleSignOut}
        demoMode={demoMode}
      />

      <main className="flex-1 min-w-0 pt-16 lg:pt-0">
        {demoMode && (
          <div className="bg-[#FFFBEB] border-b border-[#FDE68A] px-4 sm:px-6 lg:px-8 py-2.5">
            <div className="max-w-[1360px] mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
              <div className="text-[#92400E]">
                <span className="font-mono font-bold uppercase mr-2">DEMO ENVIRONMENT</span>
                <span>
                  Synthetic sample procurement data only — changes stay isolated in this demo session and never access real customer records.
                </span>
              </div>
              <button
                type="button"
                onClick={handleResetDemo}
                disabled={resettingDemo}
                className="px-2.5 py-1 bg-white border border-[#F59E0B] text-[#92400E] font-medium rounded hover:bg-amber-50 flex items-center gap-1.5 self-start sm:self-auto shrink-0 disabled:opacity-50"
              >
                <RotateCcw className="w-3 h-3" />
                <span>{resettingDemo ? 'Resetting...' : 'Reset Demo Data'}</span>
              </button>
            </div>
          </div>
        )}
        <div className="max-w-[1360px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
          {actionError && (
            <div className="mb-4 px-4 py-2.5 bg-[#FEF2F2] border border-[#FECACA] text-[#DC2626] text-xs rounded-lg flex items-center justify-between gap-3">
              <span>{actionError}</span>
              <button
                type="button"
                onClick={() => setActionError(null)}
                className="font-medium underline shrink-0 hover:text-[#991B1B]"
              >
                Dismiss
              </button>
            </div>
          )}
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
              onWithdrawAward={handleWithdrawAward}
              demoMode={demoMode}
              demoSessionId={demoSessionId}
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

          {!demoMode && activeSection === 'organization' && (
            <OrganizationView
              user={authState.user}
              activeOrganization={authState.activeOrganization}
              organizations={authState.organizations}
              onApiJson={apiJson}
              onRefreshAuthAndWorkspace={refreshAll}
            />
          )}

          {activeSection === 'settings' && (
            <SettingsView
              settings={workspace.settings}
              onSaveSettings={handleSaveSettings}
              demoMode={demoMode}
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
