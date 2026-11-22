import { useState } from 'react';
import {
  Building2,
  ChevronDown,
  FileSpreadsheet,
  FolderKanban,
  History,
  LayoutDashboard,
  Menu,
  Package,
  Settings,
  X,
} from 'lucide-react';
import { OrganizationSettings, UserRole } from '../types.ts';

export type NavSection = 'dashboard' | 'rfqs' | 'suppliers' | 'items' | 'reports' | 'settings';

interface SidebarProps {
  activeSection: NavSection;
  onNavigate: (section: NavSection) => void;
  settings: OrganizationSettings;
  pendingReviewCount: number;
  pendingApprovalCount: number;
  onRoleSwitch: (role: UserRole, userName: string, title: string) => void;
}

const ROLE_PRESETS: Array<{ role: UserRole; name: string; title: string }> = [
  { role: 'buyer', name: 'Priya Sharma', title: 'Senior Purchase Executive' },
  { role: 'approver', name: 'Rakesh Verma', title: 'Managing Director (Approver)' },
  { role: 'admin', name: 'Priya Sharma', title: 'Workspace Admin' },
  { role: 'viewer', name: 'Neha Kulkarni', title: 'Finance Viewer' },
];

export function Sidebar({
  activeSection,
  onNavigate,
  settings,
  pendingReviewCount,
  pendingApprovalCount,
  onRoleSwitch,
}: SidebarProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const [roleMenuOpen, setRoleMenuOpen] = useState(false);

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
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  const renderNavContent = () => (
    <div className="flex flex-col h-full bg-white border-r border-[#E2E8F0]">
      <div className="px-5 py-4 border-b border-[#E2E8F0]">
        <div className="font-display text-base font-bold tracking-tight text-[#0F172A] whitespace-nowrap">
          NORUS QUOTEFLOW
        </div>
        <div className="text-xs text-[#475569] mt-0.5 truncate">{settings.name}</div>
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

      <div className="p-3 border-t border-[#E2E8F0] relative">
        <button
          onClick={() => setRoleMenuOpen((v) => !v)}
          className="w-full flex items-center gap-3 p-2 rounded-lg hover:bg-[#F8FAFC] transition-colors text-left"
          title="Switch active persona to test Buyer vs MD Approver permissions"
        >
          {!imgFailed ? (
            <img
              src="/src/assets/images/avatar_buyer_priya_1795293597100.jpg"
              alt={settings.activeUserName}
              referrerPolicy="no-referrer"
              onError={() => setImgFailed(true)}
              className="w-9 h-9 rounded-lg object-cover shrink-0 border border-[#E2E8F0]"
            />
          ) : (
            <div className="w-9 h-9 rounded-lg bg-[#0F4C81] text-white flex items-center justify-center text-xs font-semibold shrink-0">
              {settings.activeUserName
                .split(' ')
                .map((n) => n[0])
                .join('')
                .slice(0, 2)}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-[#0F172A] truncate">
              {settings.activeUserName}
            </div>
            <div className="text-xs text-[#475569] truncate">
              {settings.activeUserRole.toUpperCase()} · {settings.taxRegime.replace('_', ' ')}
            </div>
          </div>
          <ChevronDown className="w-4 h-4 text-[#475569] shrink-0" />
        </button>

        {roleMenuOpen && (
          <div className="absolute bottom-16 left-3 right-3 bg-white border border-[#E2E8F0] rounded-lg shadow-lg p-1.5 z-40">
            <div className="px-2 py-1 text-[11px] font-medium text-[#475569]">
              Switch Active Role
            </div>
            {ROLE_PRESETS.map((preset) => (
              <button
                key={preset.role}
                onClick={() => {
                  onRoleSwitch(preset.role, preset.name, preset.title);
                  setRoleMenuOpen(false);
                }}
                className={`w-full text-left px-2.5 py-2 rounded-md text-xs transition-colors ${
                  settings.activeUserRole === preset.role
                    ? 'bg-[#0F4C81]/10 text-[#0F4C81] font-medium'
                    : 'text-[#0F172A] hover:bg-[#F8FAFC]'
                }`}
              >
                <div>{preset.name}</div>
                <div className="text-[11px] text-[#475569]">{preset.title}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      <div className="hidden lg:block w-[240px] shrink-0 h-screen sticky top-0">
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
          <div
            className="flex-1 bg-slate-900/40"
            onClick={() => setMobileOpen(false)}
          />
        </div>
      )}
    </>
  );
}
