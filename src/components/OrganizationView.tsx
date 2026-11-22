import { useCallback, useEffect, useState } from 'react';
import {
  Building2,
  CheckCircle2,
  Laptop,
  MailCheck,
  Plus,
  Shield,
  Trash2,
  UserPlus,
} from 'lucide-react';
import type {
  AuthUser,
  OrganizationInvitation,
  OrganizationMember,
  OrganizationSummary,
  SessionInfo,
  TaxRegime,
  UserRole,
} from '../types.ts';
import { formatDateShort } from '../lib/format.ts';

interface OrganizationViewProps {
  user: AuthUser;
  activeOrganization: OrganizationSummary | null;
  organizations: OrganizationSummary[];
  onApiJson: <T>(url: string, options?: RequestInit) => Promise<T>;
  onRefreshAuthAndWorkspace: () => Promise<void>;
}

export function OrganizationView({
  user,
  activeOrganization,
  organizations,
  onApiJson,
  onRefreshAuthAndWorkspace,
}: OrganizationViewProps) {
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [invitations, setInvitations] = useState<OrganizationInvitation[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Create org form
  const [creatingOrg, setCreatingOrg] = useState(false);
  const [newOrgName, setNewOrgName] = useState('');
  const [newOrgCurrency, setNewOrgCurrency] = useState<'INR' | 'USD' | 'GBP' | 'EUR'>('INR');
  const [newOrgRegime, setNewOrgRegime] = useState<TaxRegime>('INDIA_GST');

  // Invite form
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<UserRole>('buyer');
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const canManageTeam =
    activeOrganization?.role === 'owner' || activeOrganization?.role === 'admin';

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const sessRes = await onApiJson<{ sessions: SessionInfo[] }>('/api/auth/sessions');
      setSessions(sessRes.sessions);

      if (activeOrganization) {
        const memRes = await onApiJson<{ members: OrganizationMember[] }>(
          '/api/organizations/current/members'
        );
        setMembers(memRes.members);

        if (canManageTeam) {
          const invRes = await onApiJson<{ invitations: OrganizationInvitation[] }>(
            '/api/organizations/current/invitations'
          );
          setInvitations(invRes.invitations);
        } else {
          setInvitations([]);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load organization details.');
    } finally {
      setLoading(false);
    }
  }, [activeOrganization, canManageTeam, onApiJson]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleCreateOrg = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newOrgName.trim() || busyKey) return;
    setError(null);
    setNotice(null);
    try {
      setBusyKey('create-org');
      await onApiJson('/api/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newOrgName.trim(),
          defaultCurrency: newOrgCurrency,
          taxRegime: newOrgRegime,
        }),
      });
      setNewOrgName('');
      setCreatingOrg(false);
      setNotice('Created new organization and switched active workspace.');
      await onRefreshAuthAndWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create organization.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleSwitchOrg = async (organizationId: string) => {
    if (busyKey) return;
    setError(null);
    try {
      setBusyKey(`switch-${organizationId}`);
      await onApiJson('/api/organizations/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId }),
      });
      await onRefreshAuthAndWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to switch organization.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleInviteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim() || busyKey) return;
    setError(null);
    setNotice(null);
    try {
      setBusyKey('invite');
      await onApiJson('/api/organizations/current/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      setNotice(`Invitation issued to ${inviteEmail.trim()} as ${inviteRole}.`);
      setInviteEmail('');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to issue invitation.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleRevokeInvitation = async (invitationId: string) => {
    if (busyKey) return;
    setError(null);
    try {
      setBusyKey(`inv-${invitationId}`);
      await onApiJson(`/api/organizations/current/invitations/${invitationId}`, {
        method: 'DELETE',
      });
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to revoke invitation.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleRoleChange = async (userId: string, role: UserRole) => {
    if (busyKey) return;
    setError(null);
    setNotice(null);
    try {
      setBusyKey(`role-${userId}`);
      await onApiJson(`/api/organizations/current/members/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      setNotice('Updated member role.');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update member role.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleRemoveMember = async (userId: string) => {
    if (busyKey) return;
    setError(null);
    try {
      setBusyKey(`rem-${userId}`);
      await onApiJson(`/api/organizations/current/members/${userId}`, {
        method: 'DELETE',
      });
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to remove member.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleRevokeSession = async (sessionId: string) => {
    if (busyKey) return;
    setError(null);
    try {
      setBusyKey(`sess-${sessionId}`);
      await onApiJson(`/api/auth/sessions/${sessionId}`, { method: 'DELETE' });
      await onRefreshAuthAndWorkspace();
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to revoke session.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleResendVerification = async () => {
    if (busyKey) return;
    setError(null);
    setNotice(null);
    try {
      setBusyKey('verify-resend');
      await onApiJson('/api/auth/resend-verification', { method: 'POST' });
      setNotice(`Verification link sent to ${user.email}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send verification email.');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-[#E2E8F0]">
        <div>
          <div className="text-xs text-[#475569]">Workspace / Team & Security</div>
          <h1 className="font-display text-2xl font-bold text-[#0F172A] mt-1">
            Organizations, Roles & Sessions
          </h1>
        </div>
        <button
          onClick={() => setCreatingOrg((v) => !v)}
          className="px-4 py-2 text-xs font-medium text-white bg-[#0F4C81] rounded-lg hover:bg-[#0A365C] flex items-center gap-2 self-start sm:self-auto"
        >
          <Plus className="w-4 h-4" />
          <span>New Organization</span>
        </button>
      </div>

      {!user.emailVerified && (
        <div className="p-4 bg-[#FFFBEB] border border-[#FDE68A] rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 text-[#92400E]">
            <MailCheck className="w-4 h-4 shrink-0" />
            <span>
              Your email <strong>{user.email}</strong> is not verified yet.
            </span>
          </div>
          <button
            onClick={handleResendVerification}
            disabled={busyKey === 'verify-resend'}
            className="px-3 py-1.5 bg-white border border-[#F59E0B] text-[#92400E] font-medium rounded-md hover:bg-amber-50 shrink-0"
          >
            {busyKey === 'verify-resend' ? 'Sending...' : 'Resend Verification Email'}
          </button>
        </div>
      )}

      {error && (
        <div className="p-3 bg-[#FEF2F2] border border-[#FECACA] text-[#DC2626] text-xs rounded-lg">
          {error}
        </div>
      )}
      {notice && (
        <div className="p-3 bg-[#ECFDF5] border border-[#A7F3D0] text-[#059669] text-xs rounded-lg flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {creatingOrg && (
        <form
          onSubmit={handleCreateOrg}
          className="bg-white border border-[#E2E8F0] rounded-lg p-5 space-y-4 text-xs"
        >
          <div className="text-sm font-semibold text-[#0F172A]">Create Organization</div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <input
              required
              value={newOrgName}
              onChange={(e) => setNewOrgName(e.target.value)}
              placeholder="Organization / Plant Name *"
              className="px-3 py-2 border border-[#E2E8F0] rounded-md"
            />
            <select
              value={newOrgCurrency}
              onChange={(e) =>
                setNewOrgCurrency(e.target.value as 'INR' | 'USD' | 'GBP' | 'EUR')
              }
              className="px-3 py-2 border border-[#E2E8F0] rounded-md bg-white"
            >
              <option value="INR">INR (₹)</option>
              <option value="USD">USD ($)</option>
              <option value="GBP">GBP (£)</option>
              <option value="EUR">EUR (€)</option>
            </select>
            <select
              value={newOrgRegime}
              onChange={(e) => setNewOrgRegime(e.target.value as TaxRegime)}
              className="px-3 py-2 border border-[#E2E8F0] rounded-md bg-white"
            >
              <option value="INDIA_GST">India GST</option>
              <option value="UK_VAT">UK / EU VAT</option>
              <option value="US_TAX">US Sales Tax</option>
              <option value="NONE">Tax Exempt</option>
            </select>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setCreatingOrg(false)}
              className="px-3 py-1.5 text-[#475569]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busyKey === 'create-org'}
              className="px-4 py-1.5 bg-[#0F4C81] text-white font-medium rounded-md disabled:opacity-50"
            >
              {busyKey === 'create-org' ? 'Creating...' : 'Create & Switch'}
            </button>
          </div>
        </form>
      )}

      {/* Organizations Switcher */}
      <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
        <div className="px-5 py-3.5 border-b border-[#E2E8F0] flex items-center gap-2">
          <Building2 className="w-4 h-4 text-[#0F4C81]" />
          <h2 className="font-display text-sm font-semibold text-[#0F172A]">
            Your Organizations ({organizations.length})
          </h2>
        </div>
        <div className="divide-y divide-[#E2E8F0]">
          {organizations.map((org) => {
            const isCurrent = org.id === activeOrganization?.id;
            return (
              <div
                key={org.id}
                className="px-5 py-3 flex items-center justify-between gap-3 text-xs"
              >
                <div>
                  <div className="font-semibold text-sm text-[#0F172A]">{org.name}</div>
                  <div className="text-[#475569] mt-0.5 font-mono">
                    Role: {org.role.toUpperCase()} · {org.defaultCurrency} ·{' '}
                    {org.taxRegime.replace('_', ' ')}
                  </div>
                </div>
                {isCurrent ? (
                  <span className="text-xs font-semibold text-[#059669]">Active Workspace</span>
                ) : (
                  <button
                    onClick={() => handleSwitchOrg(org.id)}
                    disabled={busyKey === `switch-${org.id}`}
                    className="px-3 py-1.5 text-xs font-medium text-[#0F4C81] bg-[#0F4C81]/10 rounded-md hover:bg-[#0F4C81]/15"
                  >
                    Switch
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Team Members & Invitations */}
      {activeOrganization && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
          <div className="lg:col-span-7 bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
            <div className="px-5 py-3.5 border-b border-[#E2E8F0] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Shield className="w-4 h-4 text-[#0F4C81]" />
                <h2 className="font-display text-sm font-semibold text-[#0F172A]">
                  Team Members ({members.length})
                </h2>
              </div>
              <span className="text-xs text-[#475569]">{activeOrganization.name}</span>
            </div>
            {loading ? (
              <div className="p-6 text-xs text-[#475569]">Loading members...</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-[#F8FAFC] border-b border-[#E2E8F0] text-[#475569]">
                      <th className="py-2.5 px-4">Member</th>
                      <th className="py-2.5 px-4">Role</th>
                      <th className="py-2.5 px-4">Verified</th>
                      {canManageTeam && <th className="py-2.5 px-4 text-right">Action</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E2E8F0]">
                    {members.map((m) => (
                      <tr key={m.membershipId}>
                        <td className="py-3 px-4">
                          <div className="font-semibold text-[#0F172A]">{m.fullName}</div>
                          <div className="text-[#475569] font-mono">{m.email}</div>
                        </td>
                        <td className="py-3 px-4">
                          {canManageTeam && m.userId !== user.id ? (
                            <select
                              value={m.role}
                              onChange={(e) =>
                                handleRoleChange(m.userId, e.target.value as UserRole)
                              }
                              disabled={busyKey === `role-${m.userId}`}
                              className="px-2 py-1 border border-[#E2E8F0] rounded bg-white text-xs"
                            >
                              {activeOrganization.role === 'owner' && (
                                <option value="owner">owner</option>
                              )}
                              <option value="admin">admin</option>
                              <option value="buyer">buyer</option>
                              <option value="approver">approver</option>
                              <option value="viewer">viewer</option>
                            </select>
                          ) : (
                            <span className="font-mono font-semibold text-[#0F4C81]">
                              {m.role.toUpperCase()}
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4">
                          {m.emailVerified ? (
                            <span className="text-[#059669] font-medium">Verified</span>
                          ) : (
                            <span className="text-[#D97706]">Pending</span>
                          )}
                        </td>
                        {canManageTeam && (
                          <td className="py-3 px-4 text-right">
                            {m.userId !== user.id && (
                              <button
                                onClick={() => handleRemoveMember(m.userId)}
                                disabled={busyKey === `rem-${m.userId}`}
                                className="p-1 text-[#475569] hover:text-[#DC2626]"
                                title="Remove member"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="lg:col-span-5 bg-white border border-[#E2E8F0] rounded-lg p-5 space-y-4 text-xs">
            <div className="flex items-center gap-2">
              <UserPlus className="w-4 h-4 text-[#0F4C81]" />
              <h2 className="font-display text-sm font-semibold text-[#0F172A]">
                Invite Team Member
              </h2>
            </div>

            {canManageTeam ? (
              <>
                <form onSubmit={handleInviteSubmit} className="space-y-3">
                  <input
                    type="email"
                    required
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="colleague@company.com"
                    className="w-full px-3 py-2 border border-[#E2E8F0] rounded-md"
                  />
                  <div className="flex gap-2">
                    <select
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value as UserRole)}
                      className="flex-1 px-3 py-2 border border-[#E2E8F0] rounded-md bg-white"
                    >
                      <option value="buyer">Buyer (RFQs, Quotes, Recommend)</option>
                      <option value="approver">Approver (Approve / Reject Awards)</option>
                      <option value="admin">Admin (Full Workspace & Team)</option>
                      <option value="viewer">Viewer (Read-Only Audit)</option>
                    </select>
                    <button
                      type="submit"
                      disabled={busyKey === 'invite'}
                      className="px-4 py-2 bg-[#0F4C81] text-white font-medium rounded-md hover:bg-[#0A365C] disabled:opacity-50"
                    >
                      {busyKey === 'invite' ? 'Sending...' : 'Invite'}
                    </button>
                  </div>
                </form>

                {invitations.length > 0 && (
                  <div className="pt-3 border-t border-[#E2E8F0] space-y-2">
                    <div className="font-semibold text-[#0F172A]">Invitations</div>
                    {invitations.map((inv) => (
                      <div
                        key={inv.id}
                        className="p-2.5 bg-[#F8FAFC] border border-[#E2E8F0] rounded-md flex items-center justify-between gap-2"
                      >
                        <div className="min-w-0">
                          <div className="font-mono truncate text-[#0F172A]">{inv.email}</div>
                          <div className="text-[11px] text-[#475569]">
                            {inv.role} · {inv.status}
                          </div>
                        </div>
                        {inv.status === 'pending' && (
                          <button
                            onClick={() => handleRevokeInvitation(inv.id)}
                            disabled={busyKey === `inv-${inv.id}`}
                            className="text-[11px] text-[#DC2626] hover:underline shrink-0"
                          >
                            Revoke
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className="text-[#475569]">
                Only Organization Owners and Admins can invite or manage members.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Active Sessions */}
      <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
        <div className="px-5 py-3.5 border-b border-[#E2E8F0] flex items-center gap-2">
          <Laptop className="w-4 h-4 text-[#0F4C81]" />
          <h2 className="font-display text-sm font-semibold text-[#0F172A]">
            Active Sessions ({sessions.length})
          </h2>
        </div>
        <div className="divide-y divide-[#E2E8F0]">
          {sessions.map((s) => (
            <div
              key={s.id}
              className="px-5 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
            >
              <div className="min-w-0">
                <div className="font-medium text-[#0F172A] flex items-center gap-2">
                  <span className="font-mono uppercase">{s.authMethod}</span>
                  {s.isCurrent && (
                    <span className="text-[#059669] font-semibold">Current Session</span>
                  )}
                </div>
                <div className="text-[#475569] truncate mt-0.5 font-mono">
                  {s.ipAddress || 'Unknown IP'} · Last active {formatDateShort(s.lastSeenAt)} ·{' '}
                  {s.userAgent?.slice(0, 60) || 'Browser'}
                </div>
              </div>
              <button
                onClick={() => handleRevokeSession(s.id)}
                disabled={busyKey === `sess-${s.id}`}
                className="px-3 py-1.5 text-xs text-[#DC2626] border border-[#FECACA] bg-[#FEF2F2] rounded-md hover:bg-red-100 self-start sm:self-center shrink-0"
              >
                {s.isCurrent ? 'Sign Out Session' : 'Revoke'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
