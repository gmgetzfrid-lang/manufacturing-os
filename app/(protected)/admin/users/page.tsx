"use client";

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useRole } from '@/components/providers/RoleContext';
import type { Role } from '@/types/schema';
import { addableRoles, capabilitiesAdded, primaryRole, CAPABILITY_LABELS } from '@/lib/roleCapabilities';
import {
  UserPlus,
  Trash2,
  AlertCircle,
  Loader2,
  Building2,
  Plus,
  X,
} from 'lucide-react';
import { PageShell } from '@/components/ui/PageShell';
import { PageHero, PageBody, heroPrimary } from '@/components/ui/PageHero';
import { tbl, StatusTag, Problem, btnIcon, link, shortDate } from '@/components/admin/kit';
import { plural } from '@/components/admin/band';
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
  const [memberLimit, setMemberLimit] = useState(100);

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
    return (
      <PageShell width="work">
        <PageHero kicker="Admin · Users" title="Admins and managers only." sub="Only Admins and Managers manage members." overlap={false} />
      </PageShell>
    );
  }

  const active = members.filter((m) => m.status === 'active').length;
  const notActive = members.length - active;
  const admins = members.filter((m) => rolesOf(m).includes('Admin' as Role)).length;
  const answer = loading && members.length === 0 ? 'Users'
    : loadError ? "Couldn't load members."
    : members.length === 0 ? 'No members yet.'
    : `${plural(members.length, 'member')}.`;
  const shownMembers = members.slice(0, memberLimit);

  return (
    <PageShell width="work">
      <PageHero
        kicker="Admin · Users"
        title={answer}
        sub={<span className="inline-flex items-center gap-2"><Building2 className="w-4 h-4" /> {orgName || 'Loading…'}</span>}
        facts={members.length > 0 ? [
          { label: 'Active', value: active },
          { label: 'Not active', value: notActive, tone: notActive > 0 ? 'warn' : undefined },
          { label: 'Admins', value: admins },
        ] : undefined}
        primary={
          <button type="button" className={heroPrimary} onClick={() => { setFormData((f) => ({ ...f, role: lastRole() })); setError(null); setIsModalOpen(true); }}>
            <UserPlus className="w-4 h-4" />
            Add a member
          </button>
        }
      />

      <PageBody>
        {loading && members.length === 0 ? (
          <LoadingBlock what="members" />
        ) : loadError ? (
          <Problem retry={() => void fetchMembers()}>Couldn&apos;t load members: {loadError}</Problem>
        ) : (
          <div className={tbl.wrap}>
            <table className={tbl.table}>
              <thead className={`${tbl.thead} max-sm:hidden`}>
                <tr>
                  <th className={tbl.th}>Member</th>
                  <th className={tbl.th}>Roles</th>
                  <th className={tbl.th}>Status</th>
                  <th className={`${tbl.th} max-md:hidden`}>Joined</th>
                  <th className={`${tbl.th} w-14`}><span className="sr-only">Remove</span></th>
                </tr>
              </thead>
              <tbody className={tbl.tbody}>
                {shownMembers.map((m) => {
                  const memberRoles = rolesOf(m);
                  const headline = primaryRole(memberRoles);
                  const isSelf = !!uid && m.uid === uid;
                  const locked = isSelf || savingRoleId === m.id;
                  const status = m.status === 'active'
                    ? <StatusTag tone="none">Active</StatusTag>
                    : <StatusTag tone="warn">{m.status.charAt(0).toUpperCase() + m.status.slice(1)}</StatusTag>;
                  return (
                    <tr key={m.id} className={`${tbl.tr} max-sm:grid max-sm:grid-cols-[1fr_auto] max-sm:py-1`}>
                      <td className={`${tbl.td} max-sm:pb-1`}>
                        <div className="flex items-center gap-3 min-w-0">
                          <UserAvatar uid={m.uid} name={m.display_name} email={m.email} size={36} rounded="full" />
                          <div className="min-w-0">
                            <div className="font-semibold text-[var(--color-text)] truncate">{m.display_name || m.email}{isSelf && <span className="ml-1.5 text-[13px] font-normal text-[var(--color-text-muted)]">(you)</span>}</div>
                            <div className="text-[13px] text-[var(--color-text-muted)] truncate">{m.display_name ? m.email : 'No name yet'}</div>
                          </div>
                        </div>
                      </td>
                      <td className={`${tbl.td} max-sm:col-span-2 max-sm:row-start-2 max-sm:pt-0 max-sm:pl-[64px]`}>
                        <div className="flex flex-wrap items-center gap-1.5 max-w-md">
                          {memberRoles.map((r) => {
                            const canRemove = !locked && memberRoles.length > 1;
                            return (
                              <span
                                key={r}
                                title={r === headline ? 'Primary role (highest access)' : undefined}
                                className={`inline-flex items-center gap-1 h-7 pl-2 ${canRemove ? 'pr-0.5' : 'pr-2'} rounded-md border text-[13px] ${r === headline ? 'font-semibold text-[var(--color-text)] border-[var(--color-border-strong)] bg-[var(--color-surface)]' : 'text-[var(--color-text-muted)] border-[var(--color-border)] bg-[var(--color-surface-2)]'}`}
                              >
                                {r}
                                {canRemove && (
                                  <button
                                    type="button"
                                    onClick={() => removeRole(m, r)}
                                    title={`Remove ${r}`}
                                    aria-label={`Remove ${r}`}
                                    className="w-6 h-6 grid place-items-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-border)] hover:text-[var(--color-text)]"
                                  >
                                    <X className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </span>
                            );
                          })}
                          {!isSelf && (
                            <RoleAddPicker current={memberRoles} disabled={locked} onAdd={(r) => addRole(m, r)} />
                          )}
                          {savingRoleId === m.id && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--color-text-faint)]" />}
                          <span className="sm:hidden ml-1">{status}</span>
                        </div>
                      </td>
                      <td className={`${tbl.td} max-sm:hidden whitespace-nowrap`}>{status}</td>
                      <td className={`${tbl.td} max-md:hidden whitespace-nowrap text-[var(--color-text-muted)]`}>
                        {shortDate(m.created_at) || '-'}
                      </td>
                      <td className={`${tbl.td} max-sm:col-start-2 max-sm:row-start-1 text-right`}>
                        <button
                          type="button"
                          onClick={() => handleRemoveMember(m)}
                          disabled={removingId === m.id || isSelf}
                          title={isSelf ? "You can't remove yourself" : 'Remove from workspace'}
                          aria-label={`Remove ${m.display_name || m.email} from workspace`}
                          className={`${btnIcon} hover:text-[var(--state-overdue)]`}
                        >
                          {removingId === m.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {members.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-10 text-center text-[var(--color-text-muted)]">No members yet. Add the first one.</td></tr>
                )}
              </tbody>
            </table>
            {members.length > memberLimit && (
              <div className={tbl.foot}>
                <span className="text-[var(--color-text-muted)]">{memberLimit} of {members.length} shown</span>
                <button type="button" onClick={() => setMemberLimit((n) => n + 100)} className={link}>
                  Show {Math.min(100, members.length - memberLimit)} more
                </button>
              </div>
            )}
          </div>
        )}
      </PageBody>

      {/* Add User Modal */}
      {isModalOpen && (
        <Modal onClose={() => { if (!processing) setIsModalOpen(false); }} size="sm" dismissable={!processing}>
          <ModalHeader icon={UserPlus} title="Add a member" onClose={processing ? undefined : () => setIsModalOpen(false)} />
          <ModalBody>
            <form onSubmit={handleCreateMember} className="space-y-4">
              {error && (
                <p role="alert" className="text-[var(--state-overdue)] text-[14px] font-semibold flex items-center">
                  <AlertCircle className="w-4 h-4 mr-2 shrink-0" />
                  {error}
                </p>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[13px] font-semibold text-[var(--color-text-muted)] mb-1">First name</label>
                  <Input
                    required type="text" value={formData.firstName}
                    onChange={e => setFormData({...formData, firstName: e.target.value})}
                    placeholder="Jane"
                  />
                </div>
                <div>
                  <label className="block text-[13px] font-semibold text-[var(--color-text-muted)] mb-1">Last name</label>
                  <Input
                    required type="text" value={formData.lastName}
                    onChange={e => setFormData({...formData, lastName: e.target.value})}
                    placeholder="Doe"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[13px] font-semibold text-[var(--color-text-muted)] mb-1">Work email</label>
                <Input
                  required type="email" value={formData.email}
                  onChange={e => setFormData({...formData, email: e.target.value})}
                  placeholder="jane.doe@company.com"
                />
              </div>

              <div>
                <label className="block text-[13px] font-semibold text-[var(--color-text-muted)] mb-1">Temporary password</label>
                <Input
                  required type="text" value={formData.password}
                  onChange={e => setFormData({...formData, password: e.target.value})}
                  placeholder="e.g. Welcome2024!"
                />
              </div>

              <div>
                <label className="block text-[13px] font-semibold text-[var(--color-text-muted)] mb-1">Role</label>
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
                  Create account
                </Button>
                <p className="text-[13px] text-center text-[var(--color-text-muted)] mt-2.5">
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
    return <span className="text-[13px] text-[var(--color-text-muted)] px-1">Full access</span>;
  }

  return (
    <div className="relative inline-block">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-[13px] font-semibold border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        <Plus className="w-3 h-3" /> Add role
      </button>
      {open && !disabled && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div role="menu" className="absolute left-0 z-50 mt-1 w-72 bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border-strong)] rounded-lg shadow-lg py-1 max-h-72 overflow-auto">
            <div className="px-3 py-1.5 text-[13px] text-[var(--color-text-muted)] border-b border-[var(--color-border)]">
              Roles that add new access
            </div>
            {options.map((r) => {
              const adds = capabilitiesAdded(r, current).map((c) => CAPABILITY_LABELS[c]);
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => { onAdd(r); setOpen(false); }}
                  role="menuitem"
                  className="block w-full text-left px-3 py-2 hover:bg-[var(--color-surface-2)] transition-colors"
                >
                  <div className="text-[14px] font-semibold text-[var(--color-text)]">{r}</div>
                  <div className="text-[13px] text-[var(--color-text-muted)] leading-snug mt-0.5">Adds {adds.join(', ')}</div>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
