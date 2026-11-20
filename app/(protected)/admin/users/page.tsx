"use client";

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useRole } from '@/components/providers/RoleContext';
import type { Role } from '@/types/schema';
import { addableRoles, capabilitiesAdded, primaryRole, CAPABILITY_LABELS } from '@/lib/roleCapabilities';
import {
  Users,
  UserPlus,
  Trash2,
  AlertCircle,
  Loader2,
  Building2,
  Plus,
  X,
} from 'lucide-react';
import { PageShell, PageHeaderBar } from '@/components/ui/PageShell';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';
import LoadingBlock from '@/components/ui/LoadingBlock';
import { Modal, ModalHeader, ModalBody } from '@/components/ui/Modal';
import UserAvatar from '@/components/ui/UserAvatar';
import { appAlert, appConfirm } from '@/components/providers/DialogProvider';

interface MemberRow {
  id: string;
  uid?: string | null;
  email: string;
  display_name?: string | null;
  role: string;          // headline / primary role
  roles?: string[] | null; // additive collection (falls back to [role])
  status: string;
  created_at?: string | null;
}

// The member's role collection, tolerating pre-migration rows that only have
// the single `role`.
// The role last picked when adding someone comes back as the default.
const LAST_ROLE_KEY = 'admin:add-member-role';
const lastRole = (): string => {
  try { return localStorage.getItem(LAST_ROLE_KEY) || 'Viewer'; } catch { return 'Viewer'; }
};

const rolesOf = (m: MemberRow): Role[] =>
  (m.roles && m.roles.length > 0 ? m.roles : [m.role]) as Role[];

// Single source of truth for the assignable roles, used by both the
// "Add member" modal and the inline role editor so they never drift.
const ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: 'Viewer', label: 'Viewer (Read Only)' },
  { value: 'Requester', label: 'Requester' },
  { value: 'Drafter', label: 'Drafter' },
  { value: 'DraftingSupervisor', label: 'Drafting Supervisor (routes incoming requests)' },
  { value: 'Engineer-1', label: 'Engineer · level 1' },
  { value: 'Engineer-2', label: 'Engineer · level 2' },
  { value: 'Engineer-3', label: 'Engineer · level 3' },
  { value: 'Engineer-4', label: 'Engineer · level 4' },
  { value: 'Supervisor', label: 'Supervisor' },
  { value: 'Manager', label: 'Manager' },
  { value: 'DocCtrl', label: 'Doc Control' },
  { value: 'Admin', label: 'Admin' },
  // Request-only staff roles + limited-access roles: previously defined in
  // the role model but unassignable here — the audit's "7 unreachable roles".
  { value: 'Operations', label: 'Operations (requests only)' },
  { value: 'Maintenance', label: 'Maintenance (requests only)' },
  { value: 'Safety', label: 'Safety (requests only)' },
  { value: 'HR', label: 'HR (requests only)' },
  { value: 'Accounting', label: 'Accounting (requests only)' },
  { value: 'Contractor', label: 'Contractor (reduced navigation)' },
  { value: 'Auditor', label: 'Auditor (read-only + audit log)' },
];

export default function AdminUsersPage() {
  const { activeRole, activeOrgId, uid } = useRole();

  const [members, setMembers] = useState<MemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [orgName, setOrgName] = useState<string>('');
  const [savingRoleId, setSavingRoleId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    password: '',
    role: 'Viewer'
  });
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeOrgId) return;
    const fetchOrgName = async () => {
      try {
        const { data } = await supabase.from('orgs').select('name').eq('id', activeOrgId).single();
        if (data) setOrgName(data.name || 'Unnamed Org');
      } catch (e) {
        console.error("Failed to fetch org name", e);
      }
    };
    fetchOrgName();
  }, [activeOrgId]);

  const fetchMembers = useCallback(async () => {
    if (!activeOrgId) return;
    setLoading(true);
    try {
      const { data, error: e } = await supabase
        .from('org_members')
        .select('*')
        .eq('org_id', activeOrgId)
        .order('created_at', { ascending: false });
      if (e) throw e;
      setMembers(data || []);
      setLoadError(null);
    } catch (e) {
      console.error("Fetch members error:", e);
      setLoadError(e instanceof Error ? e.message : "Couldn't load members.");
    } finally {
      setLoading(false);
    }
  }, [activeOrgId]);

  useEffect(() => {
    fetchMembers();
  }, [fetchMembers]);

  // Persist a member's additive role collection. Writes the full `roles` array
  // plus the headline `role` (highest-ranked) so the legacy single-role checks
  // and the database RLS policies stay correct. Optimistic, reverts on failure.
  const persistRoles = async (member: MemberRow, nextRoles: Role[]) => {
    const cleaned = Array.from(new Set(nextRoles)) as Role[];
    if (cleaned.length === 0) {
      await appAlert('A member needs at least one role.');
      return;
    }
    const headline = primaryRole(cleaned);
    setSavingRoleId(member.id);
    const prevMembers = members;
    setMembers((prev) => prev.map((m) => (m.id === member.id ? { ...m, roles: cleaned, role: headline } : m)));
    try {
      const { error } = await supabase
        .from('org_members')
        .update({ roles: cleaned, role: headline })
        .eq('id', member.id);
      if (error) {
        // Pre-migration fallback: the roles[] column may not exist yet. Persist
        // the headline so editing still works, and point at the migration.
        const msg = error.message || '';
        if (/roles/i.test(msg) && /(column|schema|find)/i.test(msg)) {
          const { error: e2 } = await supabase.from('org_members').update({ role: headline }).eq('id', member.id);
          if (e2) throw e2;
          await appAlert('Saved the primary role. To stack multiple roles, apply migration 20260722_member_roles_collection.sql to your database.');
        } else {
          throw error;
        }
      }
    } catch (err) {
      console.error('Role update failed:', err);
      await appAlert({ message: `Couldn't update roles: ${err instanceof Error ? err.message : String(err)}`, tone: 'danger' });
      setMembers(prevMembers); // revert
    } finally {
      setSavingRoleId(null);
    }
  };

  const addRole = (member: MemberRow, role: Role) => persistRoles(member, [...rolesOf(member), role]);
  const removeRole = (member: MemberRow, role: Role) =>
    persistRoles(member, rolesOf(member).filter((r) => r !== role));

  // Remove a member from this workspace. Deletes the org_members row (revokes
  // access immediately) — it does NOT delete their login account, so they can
  // be re-added later. Guards against removing yourself.
  const handleRemoveMember = async (member: MemberRow) => {
    if (!!uid && member.uid === uid) {
      await appAlert("You can't remove yourself from the workspace.");
      return;
    }
    const who = member.display_name || member.email || 'this member';
    if (!(await appConfirm({ message: `Remove ${who} from this workspace? They lose access immediately. This does not delete their login account, and you can re-add them later.`, tone: 'danger' }))) {
      return;
    }
    setRemovingId(member.id);
    try {
      const { error } = await supabase.from('org_members').delete().eq('id', member.id);
      if (error) throw error;
      setMembers((prev) => prev.filter((m) => m.id !== member.id));
    } catch (err) {
      console.error('Remove member failed:', err);
      await appAlert({ message: `Couldn't remove member: ${err instanceof Error ? err.message : String(err)}`, tone: 'danger' });
    } finally {
      setRemovingId(null);
    }
  };

  const handleCreateMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeOrgId) return;
    setProcessing(true);
    setError(null);

    const displayName = `${formData.firstName} ${formData.lastName}`.trim();

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Not authenticated");

      const res = await fetch('/api/admin/create-user', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          email: formData.email,
          password: formData.password,
          orgId: activeOrgId,
          role: formData.role,
          displayName,
        }),
      });

      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Failed to create user');

      try { localStorage.setItem(LAST_ROLE_KEY, formData.role); } catch { /* private mode */ }
      setFormData({ firstName: '', lastName: '', email: '', password: '', role: formData.role });
      setIsModalOpen(false);
      fetchMembers();

    } catch (err) {
      console.error("Create user failed:", err);
      setError(err instanceof Error ? err.message : "Failed to create user.");
    } finally {
      setProcessing(false);
    }
  };

  if (!['Admin', 'Manager'].includes(activeRole)) {
    return <div className="p-8 text-sm text-[var(--color-text-muted)]">Only Admins and Managers manage members.</div>;
  }

  return (
    <PageShell width="work">

      {/* Header */}
      <PageHeaderBar
        icon={Users}
        title="Team Management"
        subtitle={
          <span className="inline-flex items-center gap-2 font-medium">
            <Building2 className="w-4 h-4" />
            <span>Organization: <span className="text-[var(--color-text)] font-bold">{orgName || 'Loading…'}</span>{!loading && !loadError && <> · {members.length} member{members.length === 1 ? '' : 's'}</>}</span>
          </span>
        }
        actions={
          <Button onClick={() => { setFormData((f) => ({ ...f, role: lastRole() })); setError(null); setIsModalOpen(true); }}>
            <UserPlus className="w-4 h-4" />
            Add Team Member
          </Button>
        }
      />

      {/* Main Content */}
        <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm overflow-hidden">
          {loading && members.length === 0 ? (
            <LoadingBlock what="members" className="border-0 rounded-none" />
          ) : loadError ? (
            <p role="alert" className="m-4 border-l-2 border-red-500 pl-3 text-sm text-red-700 dark:text-red-400">
              Couldn&apos;t load members: {loadError}{" "}
              <button type="button" onClick={() => void fetchMembers()} className="font-bold underline">Try again</button>
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-[var(--color-border)]">
                <thead className="bg-[var(--color-surface-2)]">
                  <tr>
                    <th className="px-6 py-4 text-left text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">User</th>
                    <th className="px-6 py-4 text-left text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">Role</th>
                    <th className="px-6 py-4 text-left text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">Status</th>
                    <th className="px-6 py-4 text-left text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">Joined</th>
                    <th className="px-6 py-4 text-right text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody className="bg-[var(--color-surface)] divide-y divide-[var(--color-border)]">
                  {members.map((m) => (
                    <tr key={m.id} className="hover:bg-[var(--color-surface-2)] transition-colors">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center">
                          <UserAvatar uid={m.uid} name={m.display_name} email={m.email} size={40} rounded="full" />
                          <div className="ml-4">
                            <div className="text-sm font-bold text-[var(--color-text)]">{m.display_name || 'No Name'}</div>
                            <div className="text-sm text-[var(--color-text-muted)]">{m.email}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        {(() => {
                          const memberRoles = rolesOf(m);
                          const headline = primaryRole(memberRoles);
                          const isSelf = !!uid && m.uid === uid;
                          const locked = isSelf || savingRoleId === m.id;
                          return (
                            <div className="flex flex-wrap items-center gap-1.5 max-w-md">
                              {memberRoles.map((r) => {
                                const canRemove = !locked && memberRoles.length > 1;
                                return (
                                  <span
                                    key={r}
                                    title={r === headline ? 'Primary role (highest access)' : undefined}
                                    className={`inline-flex items-center gap-1 pl-2.5 ${canRemove ? 'pr-1' : 'pr-2.5'} py-0.5 rounded-full text-[11px] font-bold border ${r === headline ? 'bg-[var(--color-text)] text-[var(--color-surface)] border-transparent' : 'bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]'}`}
                                  >
                                    {r}
                                    {canRemove && (
                                      <button
                                        type="button"
                                        onClick={() => removeRole(m, r)}
                                        title={`Remove ${r}`}
                                        aria-label={`Remove ${r}`}
                                        className="rounded-full p-0.5 hover:bg-[var(--color-border)]"
                                      >
                                        <X className="w-3 h-3" />
                                      </button>
                                    )}
                                  </span>
                                );
                              })}
                              {!isSelf && (
                                <RoleAddPicker current={memberRoles} disabled={locked} onAdd={(r) => addRole(m, r)} />
                              )}
                              {savingRoleId === m.id && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--color-text-faint)]" />}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`px-2 py-1 inline-flex text-xs leading-5 font-bold rounded-full ${m.status === 'active' ? 'text-[var(--color-text)] bg-[var(--color-surface-2)]' : 'text-[var(--color-text-muted)] bg-[var(--color-surface-2)]'}`}>
                          {m.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-[var(--color-text-muted)] font-medium">
                        {m.created_at ? new Date(m.created_at).toLocaleDateString() : '-'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <button
                          onClick={() => handleRemoveMember(m)}
                          disabled={removingId === m.id || (!!uid && m.uid === uid)}
                          title={!!uid && m.uid === uid ? "You can't remove yourself" : 'Remove from workspace'}
                          aria-label={`Remove ${m.display_name || m.email} from workspace`}
                          className="text-[var(--color-text-faint)] hover:text-red-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {removingId === m.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                        </button>
                      </td>
                    </tr>
                  ))}
                  {members.length === 0 && (
                    <tr><td colSpan={5} className="px-6 py-12 text-center text-[var(--color-text-faint)] italic">No team members found.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>

      {/* Add User Modal */}
      {isModalOpen && (
        <Modal onClose={() => { if (!processing) setIsModalOpen(false); }} size="sm" dismissable={!processing}>
          <ModalHeader icon={UserPlus} title="Add Team Member" onClose={processing ? undefined : () => setIsModalOpen(false)} />
          <ModalBody>
            <form onSubmit={handleCreateMember} className="space-y-4">
              {error && (
                <p role="alert" className="border-l-2 border-red-500 pl-3 text-red-700 dark:text-red-400 text-sm font-medium flex items-center">
                  <AlertCircle className="w-4 h-4 mr-2 shrink-0" />
                  {error}
                </p>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider mb-1">First Name</label>
                  <Input
                    required type="text" value={formData.firstName}
                    onChange={e => setFormData({...formData, firstName: e.target.value})}
                    placeholder="Jane"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider mb-1">Last Name</label>
                  <Input
                    required type="text" value={formData.lastName}
                    onChange={e => setFormData({...formData, lastName: e.target.value})}
                    placeholder="Doe"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider mb-1">Work Email</label>
                <Input
                  required type="email" value={formData.email}
                  onChange={e => setFormData({...formData, email: e.target.value})}
                  placeholder="jane.doe@company.com"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider mb-1">Temporary Password</label>
                <Input
                  required type="text" value={formData.password}
                  onChange={e => setFormData({...formData, password: e.target.value})}
                  className="font-mono"
                  placeholder="e.g. Welcome2024!"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider mb-1">Role</label>
                <Select
                  value={formData.role}
                  onChange={e => setFormData({...formData, role: e.target.value})}
                >
                  {ROLE_OPTIONS.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </Select>
              </div>

              <div className="pt-2">
                <Button type="submit" loading={processing} className="w-full">
                  Create Account
                </Button>
                <p className="text-xs text-center text-[var(--color-text-faint)] mt-3">
                  They can sign in right away with these details.
                </p>
              </div>
            </form>
          </ModalBody>
        </Modal>
      )}
    </PageShell>
  );
}

// Smart "add role" picker. Only offers roles that would grant a capability the
// member doesn't already have — so you can never add a role that does nothing.
// Each option shows exactly what it adds.
function RoleAddPicker({
  current,
  disabled,
  onAdd,
}: {
  current: Role[];
  disabled?: boolean;
  onAdd: (role: Role) => void;
}) {
  const [open, setOpen] = useState(false);
  const options = addableRoles(current);

  // Nothing left that would grant new access — the guardrail in action.
  if (options.length === 0) {
    return <span className="text-[11px] text-[var(--color-text-faint)] italic px-1">full access</span>;
  }

  return (
    <div className="relative inline-block">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[11px] font-bold border border-dashed border-[var(--color-border-strong)] text-[var(--color-text-muted)] hover:border-[var(--color-accent-ring)] hover:text-[var(--color-accent)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        <Plus className="w-3 h-3" /> Add role
      </button>
      {open && !disabled && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 z-50 mt-1 w-72 bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] ring-1 ring-black/5 rounded-xl shadow-lg py-1 max-h-72 overflow-auto animate-in fade-in zoom-in-95 duration-150">
            <div className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-faint)] border-b border-[var(--color-border)]">
              Roles that add new access
            </div>
            {options.map((r) => {
              const adds = capabilitiesAdded(r, current).map((c) => CAPABILITY_LABELS[c]);
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => { onAdd(r); setOpen(false); }}
                  className="block w-full text-left px-3 py-2 hover:bg-[var(--color-surface-2)] transition-colors"
                >
                  <div className="text-xs font-bold text-[var(--color-text)]">{r}</div>
                  <div className="text-[11px] text-[var(--color-text-muted)] leading-tight mt-0.5">+ {adds.join(' · ')}</div>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
