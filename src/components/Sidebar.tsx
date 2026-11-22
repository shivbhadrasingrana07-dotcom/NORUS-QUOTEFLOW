import { useState } from 'react';
import {
  Building2,
  ChevronDown,
  FileSpreadsheet,
  FolderKanban,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  Settings,
  Users,
  X,
} from 'lucide-react';
import {
  AuthUser,
  OrganizationSettings,
  OrganizationSummary,
} from '../types.ts';

export type NavSection =
  | 'dashboard'
  | 'rfqs'
  | 'suppliers'
  | 'items'
  | 'reports'
  | 'organization'
  | 'settings';

interface SidebarProps {
  activeSection: NavSection;
  onNavigate: (section: NavSection) => void;
  settings: OrganizationSettings;
  user: AuthUser;
  activeOrganization: OrganizationSummary;
  organizations: OrganizationSummary[];
  pendingReviewCount: number;
  pendingApprovalCount: number;
  onSwitchOrganization: (orgId: string) => Promise<void>;
  onSignOut: () => Promise<void>;
}

export function Sidebar({
  activeSection,
  onNavigate,
  settings,
  user,
  activeOrganization,
  organizations,
  pendingReviewCount,
  pendingApprovalCount,
  onSwitchOrganization,
  onSignOut,
}: SidebarProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [orgMenuOpen, setOrgMenuOpen] = useState(false);
  const [switching, setSwitching] = useState(false);

  const navItems: Array<{
    id: NavSection;
    label: string;
    icon: typeof LayoutDashboard;
    count?: number;
  }> = [
    { id: 'dashboard', label: 'Command Center', icon: LayoutDashboard },
    {
      id: 'rfqs',
      label: 'RFQs & Quotes',
      icon: FolderKanban,
      count: pendingReviewCount + pendingApprovalCount,
    },
    { id: 'suppliers', label: 'Suppliers', icon: Building2 },
    { id: 'items', label: 'Item Price Memory', icon: Package },
    { id: 'reports', label: 'CS Archive & Audit', icon: FileSpreadsheet },
    { id: 'organization', label: 'Team & Organizations', icon: Users },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  const handleSelectOrg = async (orgId: string) => {
    setOrgMenuOpen(false);
    if (orgId === activeOrganization.id || switching) return;
    try {
      setSwitching(true);
      await onSwitchOrganization(orgId);
    } finally {
      setSwitching(false);
    }
  };

  const initials = user.fullName
    .split(' ')
    .filter(Boolean)
    .map((n) => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  const renderNavContent = () => (
    <div className="flex flex-col h-full bg-white border-r border-[#E2E8F0]">
      <div className="px-4 py-4 border-b border-[#E2E8F0] relative">
        <div className="font-display text-base font-bold tracking-tight text-[#0F172A] whitespace-nowrap">
          NORUS QUOTEFLOW
        </div>
        <button
          type="button"
          onClick={() => setOrgMenuOpen((v) => !v)}
          className="mt-2 w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md bg-[#F8FAFC] border border-[#E2E8F0] hover:bg-slate-100 text-left transition-colors"
        >
          <div className="min-w-0">
            <div className="text-xs font-medium text-[#0F172A] truncate">
              {activeOrganization.name}
            </div>
            <div className="text-[11px] font-mono text-[#475569]">
              {activeOrganization.defaultCurrency} · {activeOrganization.role.toUpperCase()}
            </div>
          </div>
          <ChevronDown className="w-3.5 h-3.5 text-[#475569] shrink-0" />
        </button>

        {orgMenuOpen && (
          <div className="absolute left-3 right-3 top-[92px] bg-white border border-[#E2E8F0] rounded-lg shadow-lg p-1.5 z-40">
            <div className="px-2 py-1 text-[11px] font-medium text-[#475569]">
              Switch Organization
            </div>
            {organizations.map((org) => (
              <button
                key={org.id}
                type="button"
                onClick={() => handleSelectOrg(org.id)}
                className={`w-full text-left px-2.5 py-2 rounded-md text-xs transition-colors ${
                  org.id === activeOrganization.id
                    ? 'bg-[#0F4C81]/10 text-[#0F4C81] font-medium'
                    : 'text-[#0F172A] hover:bg-[#F8FAFC]'
                }`}
              >
                <div className="truncate">{org.name}</div>
                <div className="text-[11px] text-[#475569] font-mono">
                  {org.role} · {org.defaultCurrency}
                </div>
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                setOrgMenuOpen(false);
                onNavigate('organization');
                setMobileOpen(false);
              }}
              className="w-full text-left px-2.5 py-2 mt-1 border-t border-[#E2E8F0] text-xs font-medium text-[#0F4C81] hover:bg-[#F8FAFC]"
            >
              + Create or Manage Organizations
            </button>
          </div>
        )}
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = activeSection === item.id;
          return (
            <button
              key={item.id}
              onClick={() => {
                onNavigate(item.id);
                setMobileOpen(false);
              }}
              className={`w-full flex items-center justify-between px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
                active
                  ? 'bg-[#0F4C81]/10 text-[#0F4C81]'
                  : 'text-[#475569] hover:bg-[#F8FAFC] hover:text-[#0F172A]'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </span>
              {item.count !== undefined && item.count > 0 && (
                <span className="font-mono tabular-nums text-xs font-semibold text-[#D97706]">
                  {item.count}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="p-3 border-t border-[#E2E8F0] space-y-2">
        <div className="flex items-center gap-2.5 px-2 py-1.5">
          <div className="w-8 h-8 rounded-lg bg-[#0F4C81] text-white flex items-center justify-center text-xs font-semibold shrink-0">
            {initials || 'NQ'}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-[#0F172A] truncate">{user.fullName}</div>
            <div className="text-[11px] text-[#475569] truncate">{user.email}</div>
            <div className="text-[10px] font-mono text-[#0F4C81] mt-0.5">
              {settings.activeUserRole.toUpperCase()} · {settings.taxRegime.replace('_', ' ')}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onSignOut}
          className="w-full flex items-center justify-center gap-2 px-3 py-1.5 text-xs font-medium text-[#475569] hover:text-[#DC2626] hover:bg-[#FEF2F2] rounded-md border border-[#E2E8F0] transition-colors"
        >
          <LogOut className="w-3.5 h-3.5" />
          <span>Sign Out</span>
        </button>
      </div>
    </div>
  );

  return (
    <>
      <div className="hidden lg:block w-[248px] shrink-0 h-screen sticky top-0">
        {renderNavContent()}
      </div>

      {/* Mobile Header */}
      <div className="lg:hidden fixed top-0 inset-x-0 h-14 bg-white border-b border-[#E2E8F0] px-4 flex items-center justify-between z-40">
        <button
          onClick={() => setMobileOpen(true)}
          aria-label="Open navigation"
          className="p-2 -ml-2 text-[#0F172A] rounded-lg hover:bg-[#F8FAFC]"
        >
          <Menu className="w-5 h-5" />
        </button>
        <span className="font-display text-sm font-bold text-[#0F172A]">NORUS QUOTEFLOW</span>
        <button
          onClick={() => onNavigate('reports')}
          aria-label="Audit history"
          className="p-2 -mr-2 text-[#475569]"
        >
          <History className="w-4 h-4" />
        </button>
      </div>

      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div className="w-64 max-w-[80vw] h-full relative z-10">
            <button
              onClick={() => setMobileOpen(false)}
              aria-label="Close navigation"
              className="absolute top-3 right-3 p-1.5 rounded-md text-[#475569] hover:bg-[#F8FAFC]"
            >
              <X className="w-4 h-4" />
            </button>
            {renderNavContent()}
          </div>
          <div className="flex-1 bg-slate-900/40" onClick={() => setMobileOpen(false)} />
        </div>
      )}
    </>
  );
}
