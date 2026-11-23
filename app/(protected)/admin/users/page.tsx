"use client";

// Admin · People: who is in the workspace, their roles, and whether they
// can sign in. A table on a desk, a card per person on a phone. Adding
// someone makes (or reuses) their sign-in by email, one email per
// workspace; removing someone deletes their sign-in when this was their
// last workspace (both on the server: /api/admin/create-user and
// /api/admin/remove-member).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useRole } from '@/components/providers/RoleContext';
import type { Role } from '@/types/schema';
import { addableRoles, capabilitiesAdded, primaryRole, CAPABILITY_LABELS } from '@/lib/roleCapabilities';
import { UserPlus, KeyRound, UserMinus, Loader2, Plus, X, ShieldCheck, Search } from 'lucide-react';
import { PageShell } from '@/components/ui/PageShell';
import { PageHero, PageBody, heroPrimary } from '@/components/ui/PageHero';
import { tbl, btnIcon, link, shortDate, StatusTag, type Tone } from '@/components/admin/kit';
import { bandInput, bandInputIcon, plural } from '@/components/admin/band';
import { said, responseError } from '@/components/admin/said';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { Skeleton, SkeletonRows } from '@/components/ui/Skeleton';
import { ErrorNote } from '@/components/ui/ErrorNote';
import MoreMenu from '@/components/ui/MoreMenu';
import { Modal, ModalHeader, ModalBody } from '@/components/ui/Modal';
import UserAvatar from '@/components/ui/UserAvatar';
import { appAlert, appConfirm } from '@/components/providers/DialogProvider';
import { DEFAULT_SIGNIN_POLICY, mustUseMicrosoft, endOfDay, type SigninPolicy } from '@/lib/signinPolicy';
import { loadSigninPolicy } from '@/lib/signinPolicyClient';
import { TempPasswordNotice } from '@/components/admin/TempPasswordNotice';

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

// The role last picked when adding someone comes back as the default.
const LAST_ROLE_KEY = 'admin:add-member-role';
const lastRole = (): string => {
  try { return localStorage.getItem(LAST_ROLE_KEY) || 'Viewer'; } catch { return 'Viewer'; }
};

// The member's role collection, tolerating pre-migration rows that only have
// the single `role`.
const rolesOf = (m: MemberRow): Role[] =>
  (m.roles && m.roles.length > 0 ? m.roles : [m.role]) as Role[];

// Single source of truth for the assignable roles, used by both the
// "Add a person" dialog and the inline role editor so they never drift.
const ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: 'Viewer', label: 'Viewer (read only)' },
  { value: 'Requester', label: 'Requester' },
  { value: 'Drafter', label: 'Drafter' },
  { value: 'DraftingSupervisor', label: 'Drafting supervisor (routes incoming requests)' },
  { value: 'Engineer-1', label: 'Engineer, level 1' },
  { value: 'Engineer-2', label: 'Engineer, level 2' },
  { value: 'Engineer-3', label: 'Engineer, level 3' },
  { value: 'Engineer-4', label: 'Engineer, level 4' },
  { value: 'Supervisor', label: 'Supervisor' },
  { value: 'Manager', label: 'Manager' },
  { value: 'DocCtrl', label: 'Doc control' },
  { value: 'Admin', label: 'Admin' },
  // Request-only staff roles and limited-access roles.
  { value: 'Operations', label: 'Operations (requests only)' },
  { value: 'Maintenance', label: 'Maintenance (requests only)' },
  { value: 'Safety', label: 'Safety (requests only)' },
  { value: 'HR', label: 'HR (requests only)' },
  { value: 'Accounting', label: 'Accounting (requests only)' },
  { value: 'Contractor', label: 'Contractor (fewer menus)' },
  { value: 'Auditor', label: 'Auditor (read only, plus the audit log)' },
];

/** A member's status as a dot and a word: only a suspended account needs
 *  someone (an admin resets it), so only that one is colored. */
function statusOf(m: MemberRow): { tone: Tone; word: string } {
  if (m.status === 'active') return { tone: 'none', word: 'Active' };
  if (m.status === 'suspended') return { tone: 'warn', word: 'Suspended' };
  if (m.status === 'disabled' || m.status === 'removed') return { tone: 'bad', word: m.status === 'disabled' ? 'Disabled' : 'Removed' };
  return { tone: 'none', word: m.status.charAt(0).toUpperCase() + m.status.slice(1) };
}

export default function AdminUsersPage() {
  const { activeRole, activeOrgId, uid } = useRole();

  const [members, setMembers] = useState<MemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [orgName, setOrgName] = useState<string>('');
  const [savingRoleId, setSavingRoleId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    role: 'Viewer'
  });
  // The workspace's sign-in rules: who uses Microsoft, whether others may
  // have a password account (see lib/signinPolicy).
  const [policy, setPolicy] = useState<SigninPolicy>(DEFAULT_SIGNIN_POLICY);
  useEffect(() => { if (activeOrgId) void loadSigninPolicy(activeOrgId).then(setPolicy).catch(() => undefined); }, [activeOrgId]);
  // A one-time password to show once, after adding or resetting.
  const [issued, setIssued] = useState<{ email: string; password: string; expiresAt: string | null } | null>(null);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [memberLimit, setMemberLimit] = useState(100);

  useEffect(() => {
    if (!activeOrgId) return;
    const fetchOrgName = async () => {
      try {
        const { data } = await supabase.from('orgs').select('name').eq('id', activeOrgId).single();
        if (data) setOrgName(data.name || 'Unnamed workspace');
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
      setLoadError(e);
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
      await appAlert('A person needs at least one role.');
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
          await appAlert('Saved the primary role. To give one person several roles, apply migration 20260722_member_roles_collection.sql to your database.');
        } else {
          throw error;
        }
      }
    } catch (err) {
      console.error('Role update failed:', err);
      await appAlert({ message: said(err, "Couldn't change the roles."), tone: 'danger' });
      setMembers(prevMembers); // revert
    } finally {
      setSavingRoleId(null);
    }
  };

  const addRole = (member: MemberRow, role: Role) => persistRoles(member, [...rolesOf(member), role]);
  const removeRole = (member: MemberRow, role: Role) =>
    persistRoles(member, rolesOf(member).filter((r) => r !== role));

  // A new one-time password for someone who signs in with a password; it
  // also lifts a suspension from an expired one.
  const handleResetPassword = async (member: MemberRow) => {
    if (!activeOrgId || !member.uid) return;
    const who = member.display_name || member.email || 'this person';
    if (!(await appConfirm({ message: `Give ${who} a new one-time password? Their current password stops working, and they must set their own today.`, confirmLabel: 'Reset password' }))) return;
    setResettingId(member.id);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error('Your sign-in has expired. Sign in again, then try again.');
      const res = await fetch('/api/admin/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ orgId: activeOrgId, uid: member.uid, expiresAt: endOfDay() }),
      });
      if (!res.ok) throw await responseError(res);
      const body = await res.json();
      setIssued({ email: member.email, password: body.tempPassword, expiresAt: body.expiresAt ?? null });
      fetchMembers();
    } catch (err) {
      await appAlert({ message: said(err, "Couldn't reset the password."), tone: 'danger' });
    } finally {
      setResettingId(null);
    }
  };

  const handleRemoveMember = async (member: MemberRow) => {
    if (!!uid && member.uid === uid) {
      await appAlert("You can't remove yourself from the workspace.");
      return;
    }
    const who = member.display_name || member.email || 'this person';
    // On the server: when this was their last workspace, their sign-in is
    // deleted too, so no account is left that belongs to no workspace.
    if (!(await appConfirm({ message: `Remove ${who} from this workspace? They lose access now, and their sign-in is deleted unless they're in another workspace. To bring them back, add them again.`, tone: 'danger', confirmLabel: 'Remove' }))) {
      return;
    }
    setRemovingId(member.id);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error('Your sign-in has expired. Sign in again, then try again.');
      const res = await fetch('/api/admin/remove-member', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ orgId: activeOrgId, memberId: member.id }),
      });
      if (!res.ok) throw await responseError(res);
      setMembers((prev) => prev.filter((m) => m.id !== member.id));
    } catch (err) {
      console.error('Remove member failed:', err);
      await appAlert({ message: said(err, `Couldn't remove ${who}.`), tone: 'danger' });
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
      if (!session?.access_token) throw new Error('Your sign-in has expired. Sign in again, then try again.');

      const res = await fetch('/api/admin/create-user', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          email: formData.email,
          orgId: activeOrgId,
          role: formData.role,
          displayName,
          expiresAt: endOfDay(),
        }),
      });

      if (!res.ok) throw await responseError(res);
      const body = await res.json();

      try { localStorage.setItem(LAST_ROLE_KEY, formData.role); } catch { /* private mode */ }
      setFormData({ firstName: '', lastName: '', email: '', role: formData.role });
      setIsModalOpen(false);
      if (body.tempPassword) setIssued({ email: formData.email, password: body.tempPassword, expiresAt: body.expiresAt ?? null });
      fetchMembers();

    } catch (err) {
      console.error("Create user failed:", err);
      setError(said(err, "Couldn't add them."));
    } finally {
      setProcessing(false);
    }
  };

  const q = query.trim().toLowerCase();
  const matching = useMemo(() => q
    ? members.filter((m) => `${m.display_name ?? ''} ${m.email} ${rolesOf(m).join(' ')}`.toLowerCase().includes(q))
    : members, [members, q]);

  if (!['Admin', 'Manager'].includes(activeRole)) {
    return (
      <PageShell width="work">
        <PageHero kicker="Admin · Users" title="Admins and managers only." sub="Ask an admin to change who is in the workspace." />
      </PageShell>
    );
  }

  const active = members.filter((m) => m.status === 'active').length;
  const suspended = members.filter((m) => m.status === 'suspended').length;
  const notActive = members.length - active - suspended;
  const admins = members.filter((m) => rolesOf(m).includes('Admin' as Role)).length;
  const firstLoad = loading && members.length === 0;
  const answer = firstLoad ? 'People'
    : loadError ? "Couldn't load the people in this workspace."
    : members.length === 0 ? 'Nobody here yet.'
    : `${plural(members.length, 'person', 'people')}.`;
  const shown = matching.slice(0, memberLimit);
  const openAdd = () => { setFormData((f) => ({ ...f, role: lastRole() })); setError(null); setIsModalOpen(true); };

  // The rest of a row: reset a password (password sign-in only), remove.
  const rowMenu = (m: MemberRow) => {
    const isSelf = !!uid && m.uid === uid;
    if (isSelf) return null;
    if (removingId === m.id || resettingId === m.id) {
      return <span className={btnIcon} role="status" aria-label={removingId === m.id ? 'Removing' : 'Resetting the password'}><Loader2 className="w-4 h-4 animate-spin" /></span>;
    }
    const canReset = !mustUseMicrosoft(m.email, policy) && policy.allowPasswords && (activeRole === 'Admin' || activeRole === 'DocCtrl');
    const who = m.display_name || m.email;
    return (
      <MoreMenu iconOnly label={`More for ${who}`} triggerClass={btnIcon} items={[
        ...(canReset ? [{ icon: <KeyRound className="w-4 h-4" />, label: m.status === 'suspended' ? 'Reset password and lift suspension' : 'Reset password', onClick: () => handleResetPassword(m) }] : []),
        { icon: <UserMinus className="w-4 h-4" />, label: 'Remove from workspace', tone: 'bad' as const, line: canReset, onClick: () => handleRemoveMember(m) },
      ]} />
    );
  };

  return (
    <PageShell width="work">
      <PageHero
        kicker="Admin · Users"
        title={answer}
        sub={orgName ? <>In {orgName}.</> : <Skeleton className="inline-block w-40 h-4 align-middle" />}
        factsHero="none"
        facts={members.length > 0 ? [
          { label: 'Active', value: active },
          ...(suspended > 0 ? [{ label: 'Suspended', value: suspended, tone: 'warn' as const }] : []),
          { label: 'Invited or off', value: notActive },
          { label: 'Admins', value: admins },
        ] : undefined}
        primary={
          <button type="button" className={heroPrimary} onClick={openAdd}>
            <UserPlus className="w-4 h-4" />
            Add a person
          </button>
        }
      />

      <PageBody>
        {firstLoad ? (
          <SkeletonRows rows={5} cols={2} what="people" />
        ) : loadError && members.length === 0 ? (
          <ErrorNote error={loadError} title="Couldn't load the people in this workspace." onRetry={() => void fetchMembers()} />
        ) : members.length === 0 ? (
          <div className={`${tbl.wrap} px-4 py-8 text-center`}>
            <p className="text-[15px] text-[var(--color-text)]">Nobody is in this workspace yet.</p>
            <button type="button" onClick={openAdd} className={`${link} mt-2 font-semibold`}>Add the first person</button>
          </div>
        ) : (
          <div className="space-y-3">
            {members.length > 8 && (
              <div className="relative max-w-md">
                <Search className={bandInputIcon} />
                <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find a person"
                  placeholder="Find by name, email or role" className={bandInput} />
              </div>
            )}
            {loadError != null && <ErrorNote compact error={loadError} title="Couldn't refresh the list." onRetry={() => void fetchMembers()} />}

            {/* Desk: a table with real columns. */}
            <div className={`${tbl.wrap} max-sm:hidden`}>
              <table className={tbl.table}>
                <thead className={tbl.thead}>
                  <tr>
                    <th className={tbl.th}>Person</th>
                    <th className={tbl.th}>Roles</th>
                    <th className={tbl.th}>Status</th>
                    <th className={`${tbl.th} max-md:hidden`}>Added</th>
                    <th className={`${tbl.th} w-14`}><span className="sr-only">More</span></th>
                  </tr>
                </thead>
                <tbody className={tbl.tbody}>
                  {shown.map((m) => {
                    const isSelf = !!uid && m.uid === uid;
                    const st = statusOf(m);
                    return (
                      <tr key={m.id} className={tbl.tr}>
                        <td className={tbl.td}>
                          <Person m={m} isSelf={isSelf} />
                        </td>
                        <td className={tbl.td}>
                          <RoleChips m={m} isSelf={isSelf} saving={savingRoleId === m.id} onAdd={(r) => addRole(m, r)} onRemove={(r) => removeRole(m, r)} />
                        </td>
                        <td className={`${tbl.td} whitespace-nowrap`}>
                          <StatusTag tone={st.tone}>{st.word}</StatusTag>
                          {mustUseMicrosoft(m.email, policy) && <div className="text-[13px] text-[var(--color-text-muted)] mt-0.5">Signs in with Microsoft</div>}
                        </td>
                        <td className={`${tbl.td} max-md:hidden whitespace-nowrap text-[var(--color-text-muted)]`}>
                          {shortDate(m.created_at) || <span className="text-[var(--color-text-faint)]">Not recorded</span>}
                        </td>
                        <td className={`${tbl.td} text-right`}>{rowMenu(m)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {matching.length === 0 && (
                <p className="px-4 py-6 text-center text-[var(--color-text-muted)]">Nobody matches &ldquo;{query}&rdquo;. <button type="button" className={link} onClick={() => setQuery('')}>Clear</button></p>
              )}
              {matching.length > memberLimit && (
                <div className={tbl.foot}>
                  <span className="text-[var(--color-text-muted)]">{memberLimit} of {matching.length} shown</span>
                  <button type="button" onClick={() => setMemberLimit((n) => n + 100)} className={link}>
                    Show {Math.min(100, matching.length - memberLimit)} more
                  </button>
                </div>
              )}
            </div>

            {/* Phone: a card per person, the same facts. */}
            <ul className="sm:hidden space-y-2" aria-label="People">
              {shown.map((m) => {
                const isSelf = !!uid && m.uid === uid;
                const st = statusOf(m);
                return (
                  <li key={m.id} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1"><Person m={m} isSelf={isSelf} /></div>
                      <div className="-mr-2 -mt-2">{rowMenu(m)}</div>
                    </div>
                    <div className="mt-3">
                      <RoleChips m={m} isSelf={isSelf} saving={savingRoleId === m.id} onAdd={(r) => addRole(m, r)} onRemove={(r) => removeRole(m, r)} />
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-[var(--color-text-muted)]">
                      <StatusTag tone={st.tone}>{st.word}</StatusTag>
                      {mustUseMicrosoft(m.email, policy) && <span>Signs in with Microsoft</span>}
                      {m.created_at && <span>Added {shortDate(m.created_at)}</span>}
                    </div>
                  </li>
                );
              })}
              {matching.length === 0 && (
                <li className="px-4 py-6 text-center text-[var(--color-text-muted)]">Nobody matches &ldquo;{query}&rdquo;.</li>
              )}
              {matching.length > memberLimit && (
                <li className="text-center">
                  <button type="button" onClick={() => setMemberLimit((n) => n + 100)} className={link}>
                    Show {Math.min(100, matching.length - memberLimit)} more
                  </button>
                </li>
              )}
            </ul>
          </div>
        )}
      </PageBody>

      {issued && <TempPasswordNotice email={issued.email} password={issued.password} expiresAt={issued.expiresAt} onClose={() => setIssued(null)} />}
      {isModalOpen && (
        <AddPersonDialog
          formData={formData}
          setFormData={setFormData}
          policy={policy}
          members={members}
          processing={processing}
          error={error}
          onSubmit={handleCreateMember}
          onClose={() => { if (!processing) setIsModalOpen(false); }}
        />
      )}
    </PageShell>
  );
}

/** Avatar, name and email. */
function Person({ m, isSelf }: { m: MemberRow; isSelf: boolean }) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <UserAvatar uid={m.uid} name={m.display_name} email={m.email} size={36} rounded="full" />
      <div className="min-w-0">
        <div className="font-semibold text-[var(--color-text)] truncate">
          {m.display_name || m.email}
          {isSelf && <span className="ml-1.5 text-[13px] font-normal text-[var(--color-text-muted)]">(you)</span>}
        </div>
        <div className="text-[13px] text-[var(--color-text-muted)] truncate">{m.display_name ? m.email : 'No name yet'}</div>
      </div>
    </div>
  );
}

/** A person's roles as neutral chips. The primary one (the highest access)
 *  carries a small shield; a chip's x takes that role off; Add role offers
 *  only roles that would give new access. Your own roles are read-only. */
function RoleChips({ m, isSelf, saving, onAdd, onRemove }: {
  m: MemberRow; isSelf: boolean; saving: boolean;
  onAdd: (r: Role) => void; onRemove: (r: Role) => void;
}) {
  const memberRoles = rolesOf(m);
  const headline = primaryRole(memberRoles);
  const locked = isSelf || saving;
  return (
    <div className="flex flex-wrap items-center gap-1.5 max-w-md">
      {memberRoles.map((r) => {
        const canRemove = !locked && memberRoles.length > 1;
        return (
          <span key={r} title={r === headline ? 'Primary role (the highest access)' : undefined}
            className={`ui-tag !h-7 ${canRemove ? '!pr-0.5' : ''}`}>
            {r === headline && <ShieldCheck aria-hidden className="w-3.5 h-3.5 text-[var(--color-text-faint)]" />}
            {r}
            {r === headline && memberRoles.length > 1 && <span className="sr-only"> (primary)</span>}
            {canRemove && (
              <button type="button" onClick={() => onRemove(r)} title={`Remove ${r}`} aria-label={`Remove the ${r} role`}
                className="w-6 h-6 pointer-coarse:w-8 pointer-coarse:h-8 grid place-items-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--state-overdue-text)] transition-colors">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </span>
        );
      })}
      {!isSelf && <RoleAddPicker current={memberRoles} disabled={locked} onAdd={onAdd} />}
      {saving && <Loader2 role="status" aria-label="Saving roles" className="w-3.5 h-3.5 animate-spin text-[var(--color-text-faint)]" />}
    </div>
  );
}

/** Add a person: their name, sign-in email and first role. */
function AddPersonDialog({ formData, setFormData, policy, members, processing, error, onSubmit, onClose }: {
  formData: { firstName: string; lastName: string; email: string; role: string };
  setFormData: React.Dispatch<React.SetStateAction<{ firstName: string; lastName: string; email: string; role: string }>>;
  policy: SigninPolicy;
  members: MemberRow[];
  processing: boolean;
  error: string | null;
  onSubmit: (e: React.FormEvent) => void;
  onClose: () => void;
}) {
  const email = formData.email.trim();
  const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const viaMicrosoft = looksLikeEmail && mustUseMicrosoft(email, policy);
  // One email per workspace: adding someone already here re-activates them
  // with the role picked here (the server does this; say so first).
  const already = looksLikeEmail ? members.find((m) => m.email.toLowerCase() === email.toLowerCase()) : undefined;
  const emailNote = !looksLikeEmail ? 'The address they sign in with.'
    : already ? `Already here as ${rolesOf(already).join(', ')}. Adding them again sets their role to the one below and makes them active.`
    : viaMicrosoft ? 'Signs in with their company Microsoft account. No password is made.'
    : policy.allowPasswords ? 'Gets a one-time password to set their own today. If they don’t, the account is suspended until you reset it.'
    : undefined;
  const blocked = looksLikeEmail && !viaMicrosoft && !policy.allowPasswords;
  return (
    <Modal onClose={onClose} size="sm" dismissable={!processing}>
      <ModalHeader title="Add a person" onClose={processing ? undefined : onClose} />
      <ModalBody>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="First name">
              <Input required type="text" autoComplete="off" value={formData.firstName}
                onChange={(e) => setFormData((f) => ({ ...f, firstName: e.target.value }))} placeholder="Jane" />
            </Field>
            <Field label="Last name">
              <Input required type="text" autoComplete="off" value={formData.lastName}
                onChange={(e) => setFormData((f) => ({ ...f, lastName: e.target.value }))} placeholder="Doe" />
            </Field>
          </div>

          <Field label="Work email" hint={blocked ? undefined : emailNote}
            error={blocked ? 'This workspace only lets people in with Microsoft. Use an address on one of its Microsoft domains.' : undefined}>
            <Input required type="email" inputMode="email" autoComplete="off" spellCheck={false} value={formData.email}
              onChange={(e) => setFormData((f) => ({ ...f, email: e.target.value }))} placeholder="jane.doe@company.com" />
          </Field>

          <Field label="Role" hint="You can add more roles from the list later.">
            <Select value={formData.role} onChange={(e) => setFormData((f) => ({ ...f, role: e.target.value }))}>
              {ROLE_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </Select>
          </Field>

          {error && <p role="alert" className="text-[14px] font-semibold text-[var(--state-overdue-text)]">{error}</p>}

          <div className="pt-1">
            <Button type="submit" loading={processing} disabled={blocked} className="w-full">
              {already ? 'Add them again' : 'Add to workspace'}
            </Button>
            <p className="text-[13px] text-center text-[var(--color-text-muted)] mt-2.5">
              {already ? 'Their sign-in stays as it is.'
                : viaMicrosoft ? 'They sign in with Microsoft using this email.'
                : "If they have no sign-in yet, you'll get a one-time password to give them."}
            </p>
          </div>
        </form>
      </ModalBody>
    </Modal>
  );
}

// "Add role" offers only roles that would give a capability the person
// doesn't already have, so a role that does nothing can't be added. Each
// option says what it adds.
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

  // Nothing left that would grant new access.
  if (options.length === 0) {
    return <span className="text-[13px] text-[var(--color-text-muted)]">Full access</span>;
  }

  return (
    <div className="relative inline-block">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="ui-tag is-more !h-7 pointer-coarse:!h-9 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Plus className="w-3.5 h-3.5" /> Add role
      </button>
      {open && !disabled && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div role="menu" className="on-sheet ui-float ui-float-in absolute left-0 z-50 mt-1 w-72 max-w-[calc(100vw-3rem)] bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] rounded-xl py-1 max-h-72 overflow-auto">
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
