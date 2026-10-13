"use client";

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useRole } from '@/components/providers/RoleContext';
import { revokeMember } from '@/lib/members';
import { pruneRemovedMemberAclIndex, aclIndexScopeOf } from '@/lib/memberAclIndexPrune';
import type { Role } from '@/types/schema';
import { capabilitiesAdded, primaryRole, CAPABILITY_LABELS, isDormantRole, roleDisplayNote, DORMANT_ROLE_NOTE, pickerRoster, pickerNote } from '@/lib/roleCapabilities';
import { holdsReadOnlyRole, READ_ONLY_ROLES } from '@/lib/roleHeld';
import {
  Users,
  UserPlus,
  Trash2,
  AlertCircle,
  Loader2,
  Building2,
  Plus,
  X,
  Inbox,
} from 'lucide-react';
import { PageShell, PageHeaderBar } from '@/components/ui/PageShell';
import { logAuditAction } from '@/lib/audit';
import { invalidateCapabilityPolicy } from '@/lib/capabilityPolicy';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';
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

/** A role write RLS filtered out: zero rows changed, no error (ALOG-4). */
const ROLE_WRITE_REFUSED = "the database changed nothing — you may not have permission to change this member's roles. Nothing was saved.";

// The member's role collection, tolerating pre-migration rows that only have
// the single `role`.
const rolesOf = (m: MemberRow): Role[] =>
  (m.roles && m.roles.length > 0 ? m.roles : [m.role]) as Role[];

// Single source of truth for the assignable roles, used by both the
// "Add member" modal and the inline role editor so they never drift.
const ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: 'Viewer', label: 'Viewer (Read Only)' },
  { value: 'Requester', label: 'Requester' },
  { value: 'Drafter', label: 'Drafter' },
  { value: 'DraftingSupervisor', label: 'Drafting Supervisor (routes incoming requests)' },
  { value: 'Engineer-1', label: 'Engineer · level 1 (tiers are labels — identical authority)' },
  { value: 'Engineer-2', label: 'Engineer · level 2 (tiers are labels — identical authority)' },
  { value: 'Engineer-3', label: 'Engineer · level 3 (tiers are labels — identical authority)' },
  { value: 'Engineer-4', label: 'Engineer · level 4 (tiers are labels — identical authority)' },
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

// drafting-flow EDGE-4 / DEC-103: a departure hands the member's in-flight
// drafting requests back (20261195's org_members triggers — suspend and
// remove alike; a restore does not move them back). The confirm says so.
const DRAFTING_HANDBACK_NOTE = "Drafting requests assigned to them are taken off them and handed back: to the assignment queue, or to the requester when one was waiting on their approval. Restoring them later does not give those back.";

export default function AdminUsersPage() {
  const { activeRole, activeOrgId, uid, userEmail, hasAnyRole } = useRole();
  const userEmailForAudit = userEmail ?? null;

  const [members, setMembers] = useState<MemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  // ORG-15: a failed read is said, never drawn as an empty roster.
  const [membersError, setMembersError] = useState<string | null>(null);
  const [orgName, setOrgName] = useState<string>('');
  // Pending access requests for THIS org (EGRESS-5 / DEC-19). The SELECT policy
  // is Admin-only, so the card renders only for Admins — a Manager would see a
  // permanently empty list.
  // SURF-16 / DEC-2: every gate on this page reads the role COLLECTION and
  // matches the server rule it fronts — create-user is Admin|DocCtrl (the
  // route), suspend/restore is Admin|Manager and remove is Admin (revoke_member).
  const isAdmin = hasAnyRole(['Admin']);
  const canAddMember = hasAnyRole(['Admin', 'DocCtrl']);
  const canManageMembership = hasAnyRole(['Admin', 'Manager']);
  const [pendingRequests, setPendingRequests] = useState<Array<{ id: string; display_name: string; email: string; created_at: string }>>([]);
  const [pendingError, setPendingError] = useState<string | null>(null);
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
      const { data, error: readError } = await supabase
        .from('org_members')
        .select('*')
        .eq('org_id', activeOrgId)
        .order('created_at', { ascending: false });
      if (readError) throw new Error(readError.message || 'the member list could not be read');
      setMembersError(null);
      setMembers(data || []);
    } catch (e) {
      console.error("Fetch members error:", e);
      setMembersError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [activeOrgId]);

  useEffect(() => {
    fetchMembers();
  }, [fetchMembers]);

  const fetchPendingRequests = useCallback(async () => {
    if (!activeOrgId || !isAdmin) { setPendingRequests([]); setPendingError(null); return; }
    // Org-scoped by RLS (access_requests_admin_select) AND explicitly here.
    // ORG-15: a failed read shows an error card, never a missing one.
    const { data, error: readError } = await supabase
      .from('access_requests')
      .select('id, display_name, email, created_at')
      .eq('org_id', activeOrgId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    if (readError) { setPendingError(readError.message || 'the pending requests could not be read'); return; }
    setPendingError(null);
    setPendingRequests((data ?? []) as Array<{ id: string; display_name: string; email: string; created_at: string }>);
  }, [activeOrgId, isAdmin]);

  useEffect(() => {
    void fetchPendingRequests();
  }, [fetchPendingRequests]);

  // Decline goes through a service-role route (the tightened RLS gives admins
  // SELECT only on access_requests); the route re-checks controller authority
  // against the org the stored request names. Declining frees the address to
  // re-request later — the public door 409s while a request is pending.
  const handleDeclineRequest = async (id: string) => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Not authenticated");
      const res = await fetch('/api/admin/access-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
        body: JSON.stringify({ id, action: 'decline' }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Failed to decline request');
      void fetchPendingRequests();
    } catch (err) {
      console.error('Decline request failed:', err);
      setError(err instanceof Error ? err.message : 'Failed to decline request.');
    }
  };

  // Persist a member's additive role collection. Writes the full `roles` array
  // plus the headline `role` (highest-ranked) so the legacy single-role checks
  // and the database RLS policies stay correct. Optimistic, reverts on failure.
  // This is the ONLY surface allowed to shrink a collection (the Add-member
  // route merges, never removes — ORGSEL-3), so a removal here is confirmed
  // and audited: capability loss reaches RLS via the recomputed headline, and
  // "who removed this person's hat, and when" must have an answer.
  const persistRoles = async (member: MemberRow, nextRoles: Role[]) => {
    const cleaned = Array.from(new Set(nextRoles)) as Role[];
    if (cleaned.length === 0) {
      await appAlert('A member needs at least one role.');
      return;
    }
    const before = rolesOf(member);
    const removed = before.filter((r) => !cleaned.includes(r));
    if (removed.length > 0) {
      const ok = await appConfirm({
        message: `Remove the ${removed.join(', ')} role${removed.length > 1 ? 's' : ''} from ${member.display_name || member.email}? They lose that role's capabilities immediately.`,
        tone: 'danger',
        confirmLabel: 'Remove role',
      });
      if (!ok) return;
    }
    const headline = primaryRole(cleaned);
    setSavingRoleId(member.id);
    const prevMembers = members;
    setMembers((prev) => prev.map((m) => (m.id === member.id ? { ...m, roles: cleaned, role: headline } : m)));
    try {
      // ALOG-4 / ORG-4's shape: the update reads back the row it changed, so
      // a write RLS filtered out (zero rows, no error) is a refusal — never a
      // role shown as saved that the database never stored.
      const { data: changed, error } = await supabase
        .from('org_members')
        .update({ roles: cleaned, role: headline })
        .eq('id', member.id)
        .select('id');
      if (error) {
        // Pre-migration fallback: the roles[] column may not exist yet. Persist
        // the headline so editing still works, and point at the migration.
        const msg = error.message || '';
        if (/roles/i.test(msg) && /(column|schema|find)/i.test(msg)) {
          const { data: changed2, error: e2 } = await supabase.from('org_members').update({ role: headline }).eq('id', member.id).select('id');
          if (e2) throw e2;
          if (!changed2 || changed2.length === 0) throw new Error(ROLE_WRITE_REFUSED);
          await appAlert('Saved the primary role. To stack multiple roles, apply migration 20260722_member_roles_collection.sql to your database.');
        } else {
          throw error;
        }
      } else if (!changed || changed.length === 0) {
        throw new Error(ROLE_WRITE_REFUSED);
      }
      // ALOG-4: every change of a member's roles is on the record — a grant
      // as much as a removal (a removal reaches RLS through the recomputed
      // headline; a grant widens it) — naming the actor, the subject and the
      // roles before and after. The write is awaited and checked: a refused
      // audit row is said, never swallowed.
      const added = cleaned.filter((r) => !before.includes(r));
      if ((removed.length > 0 || added.length > 0) && uid) {
        const audit = await logAuditAction({
          action: removed.length > 0 ? 'ROLE_REMOVED' : 'ROLE_GRANTED',
          resourceType: 'org_member',
          resourceId: (member.uid as string | null) || member.id,
          orgId: activeOrgId || undefined,
          userId: uid,
          userEmail: userEmailForAudit ?? undefined,
          userRole: activeRole ?? undefined,
          details: { memberEmail: member.email, memberUid: member.uid ?? null, added, removed, before, after: cleaned, headlineBefore: member.role, headlineAfter: headline },
        });
        if (!audit.ok) {
          await appAlert({ message: `The roles were saved, but the audit record could not be written: ${audit.error ?? 'unknown error'}`, tone: 'danger' });
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

  // SURF-1 / DEC-20: revocation goes through the `revoke_member` RPC — the
  // one path that actually revokes (there was no DELETE policy; the old
  // client delete matched zero rows and reported success), surfaces a refusal
  // as an error instead of a disappearing row, and on REMOVE runs the GAP-5
  // succession sweep. Suspend is the default; remove is behind a confirmation.
  const handleSuspendMember = async (member: MemberRow) => {
    if (!!uid && member.uid === uid) { await appAlert("You can't suspend yourself."); return; }
    if (!activeOrgId) return;
    const who = member.display_name || member.email || 'this member';
    if (!(await appConfirm({ message: `Suspend ${who}? They lose access immediately but keep their membership record, roles, and ownership — you can restore them later. ${DRAFTING_HANDBACK_NOTE}`, tone: 'danger' }))) return;
    setRemovingId(member.id);
    try {
      await revokeMember({ memberId: member.id, mode: 'suspend', orgId: activeOrgId, actorUserId: uid ?? '', actorName: userEmailForAudit, memberLabel: who });
      setMembers((prev) => prev.map((m) => m.id === member.id ? { ...m, status: 'suspended' } : m));
    } catch (err) {
      await appAlert({ message: `Couldn't suspend member: ${err instanceof Error ? err.message : String(err)}`, tone: 'danger' });
    } finally { setRemovingId(null); }
  };

  const handleRestoreMember = async (member: MemberRow) => {
    if (!activeOrgId) return;
    setRemovingId(member.id);
    try {
      await revokeMember({ memberId: member.id, mode: 'restore', orgId: activeOrgId, actorUserId: uid ?? '', actorName: userEmailForAudit });
      setMembers((prev) => prev.map((m) => m.id === member.id ? { ...m, status: 'active' } : m));
    } catch (err) {
      await appAlert({ message: `Couldn't restore member: ${err instanceof Error ? err.message : String(err)}`, tone: 'danger' });
    } finally { setRemovingId(null); }
  };

  const handleRemoveMember = async (member: MemberRow) => {
    if (!!uid && member.uid === uid) {
      await appAlert("You can't remove yourself from the workspace.");
      return;
    }
    if (!activeOrgId) return;
    const who = member.display_name || member.email || 'this member';
    if (!(await appConfirm({ message: `Remove ${who} from this workspace? They lose access immediately, everything they own becomes UNOWNED (cleared and audited — never silently reassigned), their open checkouts end, and their personal grants are revoked. ${DRAFTING_HANDBACK_NOTE} This does not delete their login account. Prefer Suspend if this may be temporary.`, tone: 'danger' }))) {
      return;
    }
    setRemovingId(member.id);
    try {
      const result = await revokeMember({ memberId: member.id, mode: 'remove', orgId: activeOrgId, actorUserId: uid ?? '', actorName: userEmailForAudit, memberLabel: who });
      setMembers((prev) => prev.filter((m) => m.id !== member.id));
      // revoke_member stripped their personal capability grants: this tab
      // re-reads the policy at once (a display refresh — every server-side
      // decision already reads it fresh).
      invalidateCapabilityPolicy(activeOrgId);
      // ORG-7 (admin-and-org Round G, review fix): revoke_member pruned the
      // rules naming them; the nodes that only inherited a grant still list
      // them in their acl_index and are cleared here in bounded chunks (one
      // statement each — never one statement big enough to time out). Fix
      // pass 3: only under the libraries / folders whose own acl carried the
      // grant (revoke_member's aclIndexScope) — a member who held no such
      // grant makes no call at all. Not awaited, and never a failure of the
      // removal: nothing leaks meanwhile (a non-member is refused
      // everywhere), and the nightly re-index finishes a run cut short.
      const prunedUid = member.uid;
      const scope = aclIndexScopeOf(result);
      if (prunedUid && scope && (scope.libraries.length > 0 || scope.collections.length > 0)) {
        void pruneRemovedMemberAclIndex(supabase, activeOrgId, prunedUid, scope, { deadlineMs: 120_000 }).then(async (p) => {
          if (!p.ok) {
            await appAlert(`${who} was removed. The access their grants left in the document index is not cleared yet (${p.error}); they can't open anything as a non-member, and tonight's re-index finishes the clean-up.`);
          } else if (!p.done) {
            await appAlert(`${who} was removed. ${p.pruned.toLocaleString()} indexed item${p.pruned === 1 ? '' : 's'} no longer list them; tonight's re-index clears the rest.`);
          }
        });
      }
      const c = result.cleared;
      const total = c ? c.libraries.length + c.collections.length + c.documents.length + c.teams.length : 0;
      if (total > 0) {
        await appAlert(`${who} was removed. ${total} item${total === 1 ? '' : 's'} they owned ${total === 1 ? 'is' : 'are'} now unowned — assign new owners from the register (controllers have been notified).`);
      }
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

      setFormData({ firstName: '', lastName: '', email: '', password: '', role: 'Viewer' });
      setIsModalOpen(false);
      // ALOG-4: the membership was granted; if its audit row was refused the
      // admin is told so, never left to assume it was recorded.
      if (typeof body.auditError === 'string' && body.auditError) {
        void appAlert({ message: `The member was added, but the audit record could not be written: ${body.auditError}`, tone: 'danger' });
      }
      fetchMembers();
      // create-user resolves the matching pending access request server-side —
      // refresh the card so an accepted request leaves it immediately.
      void fetchPendingRequests();

    } catch (err) {
      console.error("Create user failed:", err);
      setError(err instanceof Error ? err.message : "Failed to create user.");
    } finally {
      setProcessing(false);
    }
  };

  if (!hasAnyRole(['Admin', 'Manager', 'DocCtrl'])) {
    return <div className="p-8 text-red-600">Access Denied. Admins Only.</div>;
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
            <span>Organization: <span className="text-[var(--color-text)] font-bold">{orgName || 'Loading...'}</span></span>
          </span>
        }
        actions={
          canAddMember ? (
            <Button onClick={() => setIsModalOpen(true)}>
              <UserPlus className="w-4 h-4" />
              Add Team Member
            </Button>
          ) : undefined
        }
      />

      {/* ORG-15: the pending-requests read failed — said, with a retry. */}
      {isAdmin && pendingError && (
        <div role="alert" data-testid="pending-requests-error" className="mb-5 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-3 flex items-center justify-between gap-4">
          <span className="text-sm text-rose-800 inline-flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            Couldn&apos;t load pending access requests ({pendingError}). Anyone waiting to join is not shown until this loads.
          </span>
          <Button size="sm" variant="secondary" onClick={() => void fetchPendingRequests()}>Retry</Button>
        </div>
      )}

      {/* Pending access requests (Admin-only; EGRESS-5 / DEC-19) */}
      {isAdmin && !pendingError && pendingRequests.length > 0 && (
        <div className="mb-5 bg-[var(--color-surface)] rounded-2xl border border-amber-300/60 shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-[var(--color-border)] flex items-center gap-2 bg-amber-50/50">
            <Inbox className="w-4 h-4 text-amber-600" />
            <span className="text-sm font-bold text-[var(--color-text)]">Pending access requests</span>
            <span className="text-xs font-bold text-amber-700 bg-amber-100 rounded-full px-2 py-0.5">{pendingRequests.length}</span>
            <span className="text-xs text-[var(--color-text-muted)] ml-1">people who asked to join this workspace</span>
          </div>
          <ul className="divide-y divide-[var(--color-border)]">
            {pendingRequests.map((r) => (
              <li key={r.id} className="px-5 py-3 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-[var(--color-text)] truncate">{r.display_name}</p>
                  <p className="text-xs text-[var(--color-text-muted)] truncate">{r.email} · requested {new Date(r.created_at).toLocaleDateString()}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button size="sm" variant="secondary" onClick={() => {
                    const [first, ...rest] = (r.display_name || '').trim().split(/\s+/);
                    setFormData((f) => ({ ...f, email: r.email, firstName: first ?? '', lastName: rest.join(' ') }));
                    setIsModalOpen(true);
                  }}>
                    <UserPlus className="w-3.5 h-3.5" /> Add
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void handleDeclineRequest(r.id)}>
                    Decline
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Main Content */}
        <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm overflow-hidden">
          {loading ? (
            <div className="p-12 text-center text-[var(--color-text-muted)]"><Spinner className="mx-auto" /></div>
          ) : membersError ? (
            <div role="alert" data-testid="members-error" className="p-10 text-center space-y-3">
              <p className="text-sm text-rose-700 inline-flex items-center gap-2">
                <AlertCircle className="w-4 h-4" /> Couldn&apos;t load the member list ({membersError}). Nothing is shown rather than an empty roster.
              </p>
              <div><Button size="sm" variant="secondary" onClick={() => void fetchMembers()}>Retry</Button></div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-[var(--color-border)]">
                <thead className="bg-slate-50/50">
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
                                    className={`inline-flex items-center gap-1 pl-2.5 ${canRemove ? 'pr-1' : 'pr-2.5'} py-0.5 rounded-full text-[11px] font-bold border ${r === headline ? 'bg-slate-900 text-white border-slate-900' : 'bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]'}`}
                                  >
                                    {r}
                                    {canRemove && (
                                      <button
                                        type="button"
                                        onClick={() => removeRole(m, r)}
                                        title={`Remove ${r}`}
                                        className="rounded-full p-0.5 hover:bg-white/20"
                                      >
                                        <X className="w-3 h-3" />
                                      </button>
                                    )}
                                  </span>
                                );
                              })}
                              {memberRoles.length > 1 && holdsReadOnlyRole(memberRoles) && (
                                <span
                                  title={`Holds ${memberRoles.filter((r) => READ_ONLY_ROLES.includes(r)).join(' + ')}: read-only on document editing and equipment state whatever else they hold (deny-if-any). Remove it to lift the restriction.`}
                                  className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800"
                                >
                                  read-only
                                </span>
                              )}
                              {!isSelf && (
                                <RoleAddPicker current={memberRoles} disabled={locked} onAdd={(r) => addRole(m, r)} />
                              )}
                              {savingRoleId === m.id && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--color-text-faint)]" />}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`px-2 py-1 inline-flex text-xs leading-5 font-bold rounded-full ${m.status === 'active' ? 'text-emerald-700 bg-emerald-50' : 'text-[var(--color-text-muted)] bg-[var(--color-surface-2)]'}`}>
                          {m.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-[var(--color-text-muted)] font-medium">
                        {m.created_at ? new Date(m.created_at).toLocaleDateString() : '-'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <div className="inline-flex items-center gap-2">
                          {m.status === 'active' ? (
                            <button
                              type="button"
                              onClick={() => handleSuspendMember(m)}
                              disabled={removingId === m.id || (!!uid && m.uid === uid) || !canManageMembership}
                              title={!canManageMembership ? 'Only an Admin or Manager can suspend a member' : !!uid && m.uid === uid ? "You can't suspend yourself" : 'Suspend (keeps the record; restorable)'}
                              className="px-2 py-1 rounded text-[11px] font-bold border border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-amber-400 hover:text-amber-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              Suspend
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleRestoreMember(m)}
                              disabled={removingId === m.id || !canManageMembership}
                              title="Restore access"
                              className="px-2 py-1 rounded text-[11px] font-bold border border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-emerald-400 hover:text-emerald-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              Restore
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handleRemoveMember(m)}
                            disabled={removingId === m.id || (!!uid && m.uid === uid) || !isAdmin}
                            title={!!uid && m.uid === uid ? "You can't remove yourself" : 'Remove from workspace (clears what they own)'}
                            className="text-[var(--color-text-faint)] hover:text-red-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {removingId === m.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                          </button>
                        </div>
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
        <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center overflow-y-auto p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in">
          <div className="bg-[var(--color-surface)] rounded-2xl shadow-2xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95">
            <div className="px-6 py-4 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] flex justify-between items-center">
              <h3 className="text-lg font-bold text-[var(--color-text)]">Add Team Member</h3>
              <button onClick={() => setIsModalOpen(false)} className="text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)] transition-colors">
                <span className="sr-only">Close</span>
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateMember} className="p-6 space-y-4">
              {error && (
                <div className="p-3 rounded-lg bg-red-50 text-red-600 text-sm font-medium flex items-center">
                  <AlertCircle className="w-4 h-4 mr-2" />
                  {error}
                </div>
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
                  {ROLE_OPTIONS.filter((r) => !isDormantRole(r.value)).map((r) => (
                    <option key={r.value} value={r.value} title={roleDisplayNote(r.value) ?? undefined}>{r.label}</option>
                  ))}
                  {/* DEC-3: dormant roles stay assignable but are visibly discouraged. */}
                  <optgroup label="Dormant — use a team instead">
                    {ROLE_OPTIONS.filter((r) => isDormantRole(r.value)).map((r) => (
                      <option key={r.value} value={r.value} title={DORMANT_ROLE_NOTE}>{r.label} · dormant</option>
                    ))}
                  </optgroup>
                </Select>
              </div>

              <div className="pt-2">
                <Button type="submit" loading={processing} className="w-full">
                  Create Account
                </Button>
                <p className="text-xs text-center text-[var(--color-text-faint)] mt-3">
                  User will be able to log in immediately with these credentials.
                </p>
              </div>
            </form>
          </div>
        </div>
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
  // ROLE-4: the WHOLE roster, in three labelled groups — a hidden role
  // explains nothing; a grouped one explains itself.
  const roster = pickerRoster(current);
  const groups: Array<{ title: string; hint: string | null; roles: Role[]; dim: boolean }> = [
    { title: 'Roles that add new access', hint: null, roles: roster.adds, dim: false },
    { title: 'Labels and restrictions', hint: 'Add nothing this member lacks — recorded as a label, or a read-only / reduced-navigation restriction.', roles: roster.addsNothing, dim: false },
    { title: 'Dormant department labels', hint: DORMANT_ROLE_NOTE, roles: roster.dormant, dim: true },
  ].filter((g) => g.roles.length > 0);

  // Every role is already held.
  if (groups.length === 0) {
    return <span className="text-[10px] text-[var(--color-text-faint)] italic px-1">every role held</span>;
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
            {groups.map((g) => (
              <React.Fragment key={g.title}>
                <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-faint)] border-b border-[var(--color-border)]" title={g.hint ?? undefined}>
                  {g.title}
                </div>
                {g.roles.map((r) => {
                  const adds = capabilitiesAdded(r, current).map((c) => CAPABILITY_LABELS[c]);
                  const note = pickerNote(r, current) ?? roleDisplayNote(r);
                  const dormant = isDormantRole(r);
                  return (
                    <button
                      key={r}
                      type="button"
                      title={note ?? undefined}
                      onClick={() => { onAdd(r); setOpen(false); }}
                      className={`block w-full text-left px-3 py-2 hover:bg-[var(--color-accent-soft)] transition-colors ${g.dim ? 'opacity-60' : ''}`}
                    >
                      <div className="text-xs font-bold text-[var(--color-text)]">
                        {r}
                        {dormant && <span className="ml-2 text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">dormant</span>}
                      </div>
                      {adds.length > 0 && <div className="text-[10px] text-[var(--color-text-muted)] leading-tight mt-0.5">+ {adds.join(' · ')}</div>}
                      {note && <div className="text-[10px] text-[var(--color-text-faint)] leading-tight mt-0.5 italic">{note}</div>}
                    </button>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
