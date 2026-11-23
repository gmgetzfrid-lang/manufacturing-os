"use client";

import React, { useEffect, useMemo, useState } from "react";
import { X, Plus, Trash2, Check } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { btnIcon, btnLink } from "@/components/admin/kit";
import { bandSeg, bandSegItem, plural } from "@/components/admin/band";
import { said } from "@/components/admin/said";
import { supabase } from "@/lib/supabase";
import { buildAclIndexFromChain } from "@/lib/acl";
import { useRole } from "@/components/providers/RoleContext";
import { appAlert } from "@/components/providers/DialogProvider";
import { listTeams, type Team } from "@/lib/teams";
import { RoleTreeSelector } from "./RoleTreeSelector";
import type {
  AccessControl,
  AccessRule,
  PermissionAction,
  PermissionEffect,
  PermissionSubjectType,
  Role,
  Timestamp,
  NodeVisibility,
} from "@/types/schema";

export type NodeType = "library" | "collection" | "document" | "set";

const ACTIONS: Array<{ key: PermissionAction; label: string; hint: string }> = [
  { key: "discover", label: "Find", hint: "Can see that it exists (its name)" },
  { key: "read", label: "Read", hint: "Can open and view it" },
  { key: "download", label: "Download", hint: "Can download it" },
  { key: "upload", label: "Upload", hint: "Can upload into it" },
  { key: "createFolder", label: "Make folders", hint: "Can make folders inside it" },
  { key: "editMetadata", label: "Edit fields", hint: "Can edit the document fields" },
  { key: "write", label: "Change files", hint: "Can change or replace the files" },
  { key: "publish", label: "Publish revisions", hint: "Can rev up or revert here, including over someone else's checkout (grant it on the library)" },
  { key: "managePermissions", label: "Change permissions", hint: "Can change these rules" },
  { key: "admin", label: "Admin", hint: "Full control" },
];

const SUBJECT_TYPES: Array<{ key: PermissionSubjectType; label: string; placeholder: string }> = [
  { key: "user", label: "User", placeholder: "uid (or email later)" },
  { key: "team", label: "Team", placeholder: "teamId" },
  { key: "role", label: "Role", placeholder: "Role (e.g. Engineer-2)" },
  { key: "org", label: "Org", placeholder: "orgId" },
];

const ROLES: Role[] = [
  "Requester",
  "Drafter",
  "Supervisor",
  "Engineer-1",
  "Engineer-2",
  "Engineer-3",
  "Engineer-4",
  "DocCtrl",
  "Admin",
  "Manager",
  "HR",
  "Safety",
  "Accounting",
  "Auditor",
  "Maintenance",
  "Operations",
  "Contractor",
  "Viewer",
];

function collectionNameFor(nodeType: NodeType): string {
  switch (nodeType) {
    case "library":
      return "libraries";
    case "collection":
      return "collections";
    case "document":
      return "documents";
    case "set":
      return "document_sets";
    default:
      return "collections";
  }
}

function safeAcl(acl?: AccessControl | null): AccessControl {
  return {
    inherit: acl?.inherit ?? true,
    visibility: acl?.visibility ?? "normal",
    rules: Array.isArray(acl?.rules) ? acl!.rules : [],
  };
}

function toDateInput(tsOrDate: unknown): string {
  if (!tsOrDate) return "";
  try {
    const d =
      typeof (tsOrDate as { toDate?: () => Date })?.toDate === "function"
        ? (tsOrDate as { toDate: () => Date }).toDate()
        : tsOrDate instanceof Date
        ? tsOrDate
        : typeof (tsOrDate as { seconds?: number })?.seconds === "number"
        ? new Date((tsOrDate as { seconds: number }).seconds * 1000)
        : null;
    if (!d) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
      d.getHours()
    )}:${pad(d.getMinutes())}`;
  } catch {
    return "";
  }
}

function fromDateInput(value: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

export default function PermissionsDrawer(props: {
  // ... props
  isOpen: boolean;
  onClose: () => void;

  nodeType: NodeType;
  nodeId: string;

  acl?: AccessControl | null;
  visibility?: "normal" | "hidden" | "private";

  aclChain?: (AccessControl | undefined)[];
  canEdit: boolean;

  title?: string;
}) {
  const { isOpen, onClose, nodeType, nodeId, canEdit } = props;

  // ... (keep existing state)
  const initial = useMemo(() => {
    const merged = safeAcl(props.acl);
    const v = (props.visibility ?? merged.visibility ?? "normal") as NodeVisibility;
    return { ...merged, visibility: v };
  }, [props.acl, props.visibility]);

  const [inherit, setInherit] = useState<boolean>(initial.inherit ?? true);
  const [visibility, setVisibility] = useState<"normal" | "hidden" | "private">(
    (initial.visibility as NodeVisibility) ?? "normal"
  );
  const [rules, setRules] = useState<AccessRule[]>(initial.rules ?? []);
  const [saving, setSaving] = useState(false);

  const [effect, setEffect] = useState<PermissionEffect>("allow");
  const [subjectType, setSubjectType] = useState<PermissionSubjectType>("user");
  const [subjectId, setSubjectId] = useState("");
  const [rolePick, setRolePick] = useState<Role>("Engineer-1");
  const [actions, setActions] = useState<PermissionAction[]>(["discover", "read"]);
  const [expiresAt, setExpiresAt] = useState<string>("");

  // Real people & teams so admins pick by NAME instead of typing UUIDs.
  const { activeOrgId } = useRole();
  const [orgMembers, setOrgMembers] = useState<{ uid: string; name: string; email: string | null }[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  useEffect(() => {
    if (!isOpen || !activeOrgId) return;
    let cancelled = false;
    (async () => {
      const [{ data: m }, t] = await Promise.all([
        supabase.from("org_members").select("uid, display_name, email").eq("org_id", activeOrgId).eq("status", "active"),
        listTeams(activeOrgId).catch(() => [] as Team[]),
      ]);
      if (cancelled) return;
      setOrgMembers((m ?? []).map((r) => ({ uid: (r as { uid: string }).uid, name: ((r as { display_name: string | null }).display_name) || ((r as { email: string | null }).email) || (r as { uid: string }).uid, email: (r as { email: string | null }).email })));
      setTeams(t);
    })();
    return () => { cancelled = true; };
  }, [isOpen, activeOrgId]);

  // Resolve a subject id to a friendly label for display in the rules list.
  const subjectLabel = (type: PermissionSubjectType, id: string): string => {
    if (type === "user") return orgMembers.find((u) => u.uid === id)?.name ?? id;
    if (type === "team") return teams.find((t) => t.id === id)?.name ?? id;
    return id;
  };

  // BULK ADD STATE
  const [showBulkSelector, setShowBulkSelector] = useState(false);
  const [bulkRoles, setBulkRoles] = useState<Role[]>([]);

  // ... (keep existing resetFromProps, close, nodeLabel)
  const resetFromProps = () => {
    setInherit(initial.inherit ?? true);
    setVisibility((initial.visibility as NodeVisibility) ?? "normal");
    setRules(initial.rules ?? []);
    setBulkRoles([]);
    setShowBulkSelector(false);
  };

  const close = () => {
    resetFromProps();
    onClose();
  };

  // Escape closes, like the X (not while saving).
  useEffect(() => {
    if (!isOpen || saving) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, saving]);

  const nodeLabel = useMemo(() => {
    if (props.title) return props.title;
    const t = nodeType === "collection" ? "Folder" : nodeType[0].toUpperCase() + nodeType.slice(1);
    return `${t} permissions`;
  }, [nodeType, props.title]);

  const addRule = () => {
    const sid = subjectType === "role" ? String(rolePick) : (subjectId || "").trim();
    if (!sid) return;

    const exp = fromDateInput(expiresAt);
    const next: AccessRule = {
      effect,
      subject: { type: subjectType, id: sid },
      actions: actions.length ? actions : ["discover", "read"],
      ...(exp ? { expiresAt: exp as Timestamp } : {}),
    };

    setRules((prev) => [next, ...prev]);
    setSubjectId("");
    setExpiresAt("");
  };

  const addBulkRules = () => {
    if (bulkRoles.length === 0) return;
    
    const exp = fromDateInput(expiresAt);
    const newRules: AccessRule[] = bulkRoles.map(role => ({
      effect,
      subject: { type: 'role', id: role },
      actions: actions.length ? actions : ["discover", "read"],
      ...(exp ? { expiresAt: exp as Timestamp } : {}),
    }));

    setRules((prev) => [...newRules, ...prev]);
    setBulkRoles([]);
    setShowBulkSelector(false);
  };

  // ... (keep removeRule, toggleAction, save)
  const removeRule = (idx: number) => {
    setRules((prev) => prev.filter((_, i) => i !== idx));
  };

  const toggleAction = (a: PermissionAction) => {
    setActions((prev) => (prev.includes(a) ? prev.filter((x) => x !== a) : [...prev, a]));
  };

  const save = async () => {
    if (!canEdit) return;

    setSaving(true);
    try {
      const table = collectionNameFor(nodeType);

      const nextAcl: AccessControl = {
        inherit,
        visibility,
        rules: rules.map((r) => {
          const { expiresAt, ...rest } = r;
          return expiresAt ? { ...rest, expiresAt } : rest;
        }),
      };

      const chain = [...(props.aclChain ?? []), nextAcl];
      const aclIndex = buildAclIndexFromChain(chain);

      const payload: Record<string, unknown> = {
        acl: nextAcl,
        acl_index: aclIndex ?? null,
        updated_at: new Date().toISOString(),
      };

      if (nodeType !== "library") payload.visibility = visibility;

      const { error } = await supabase.from(table).update(payload).eq("id", nodeId);
      if (error) throw error;

      // Full before/after audit — a permission change must always be
      // reconstructable. Best-effort: the save above already committed.
      if (activeOrgId) {
        const { data: auth } = await supabase.auth.getUser();
        const { error: auditError } = await supabase.from("audit_logs").insert({
          action: "NODE_ACL_CHANGED",
          resource_type: nodeType,
          resource_id: nodeId,
          org_id: activeOrgId,
          user_id: auth.user?.id ?? null,
          user_email: auth.user?.email ?? null,
          details: {
            before: { acl: props.acl ?? null, visibility: props.visibility ?? "normal" },
            after: { acl: nextAcl, visibility },
          },
        });
        if (auditError) {
          await appAlert({ title: "Saved, but not logged", message: said(auditError, "The change saved, but its audit record didn't."), tone: "danger" });
        }
      }
      close();
    } catch (e) {
      console.error(e);
      await appAlert({ title: "Couldn't save the permissions", message: said(e), tone: "danger" });
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  const subjectWord: Record<PermissionSubjectType, string> = { user: "Person", team: "Team", role: "Role", org: "Everyone in the workspace" };
  const actionWord = (a: string) => ACTIONS.find((x) => x.key === a)?.label ?? a;
  const dirty = JSON.stringify({ i: inherit, v: visibility, r: rules }) !== JSON.stringify({ i: initial.inherit ?? true, v: initial.visibility ?? "normal", r: initial.rules ?? [] });
  const canAdd = showBulkSelector ? bulkRoles.length > 0 : subjectType === "role" ? true : !!subjectId.trim();
  const h3 = "text-[16px] font-semibold text-[var(--color-text)]";

  return (
    <div role="dialog" aria-modal="true" aria-label={`Permissions for ${nodeLabel}`} className="fixed inset-0 z-[400] flex justify-end">
      <div className="absolute inset-0 bg-[var(--color-ink)]/55 animate-in fade-in motion-reduce:animate-none" onClick={() => { if (!saving) close(); }} />
      <div className="relative h-full w-full max-w-[560px] bg-[var(--color-surface)] text-[var(--color-text)] ui-float sm:rounded-l-xl animate-in slide-in-from-right duration-300 motion-reduce:animate-none flex flex-col">
        <div className="flex items-start justify-between gap-3 px-5 sm:px-6 pt-5 pb-4 border-b border-[var(--color-border)] shrink-0">
          <div className="min-w-0">
            <div className="text-[13px] text-[var(--color-text-muted)]">
              Permissions · {nodeType === "collection" ? "folder" : nodeType}{!canEdit && <span className="text-[var(--color-text)]"> · read only</span>}
            </div>
            <h2 className="mt-1 font-display text-[24px] leading-tight font-semibold break-words">{nodeLabel}</h2>
          </div>
          <button type="button" onClick={close} disabled={saving} className={`-mr-2 ${btnIcon}`} title="Close" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 sm:px-6 py-5 space-y-7">
          {/* Who can find it, and whether the parent's rules apply. */}
          <section className="space-y-4">
            <div>
              <div className="text-[14px] font-semibold text-[var(--color-text)] mb-1.5 inline-flex items-center gap-1.5">
                Visibility <HelpTooltip>Hidden: nobody finds it unless a rule below allows them.</HelpTooltip>
              </div>
              <div role="radiogroup" aria-label="Visibility" className={bandSeg}>
                {(["normal", "hidden"] as const).map((v) => (
                  <button key={v} type="button" role="radio" aria-checked={visibility === v} disabled={!canEdit} onClick={() => setVisibility(v)} className={bandSegItem(visibility === v)}>
                    {v === "normal" ? "Normal" : "Hidden"}
                  </button>
                ))}
              </div>
              {visibility === "private" && <p className="mt-1.5 text-[13px] text-[var(--color-text-muted)]">Private now. Pick Normal or Hidden to change it.</p>}
            </div>
            <label className="flex items-start gap-2.5 text-[15px] text-[var(--color-text)]">
              <input type="checkbox" disabled={!canEdit} checked={inherit} onChange={(e) => setInherit(e.target.checked)} className="mt-1 h-4 w-4" />
              <span>Follow the parent&apos;s rules<span className="block text-[13px] text-[var(--color-text-muted)]">The rules above this apply here, unless a rule below says otherwise.</span></span>
            </label>
          </section>

          {/* The rules on this one. */}
          <section>
            <h3 className={`${h3} inline-flex items-center gap-1.5`}>Rules <span className="ui-count">{rules.length || ""}</span> <HelpTooltip>A deny rule always wins over an allow rule.</HelpTooltip></h3>
            {rules.length === 0 ? (
              <p className="mt-2 text-[14px] text-[var(--color-text-muted)]">None here{inherit ? "; the parent's rules apply" : ""}.</p>
            ) : (
              <ul className="mt-2 rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
                {rules.map((r, idx) => (
                  <li key={idx} className="flex items-start gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px]">
                        <span className={`font-semibold ${r.effect === "deny" ? "text-[var(--state-overdue-text)]" : "text-[var(--color-text)]"}`}>{r.effect === "deny" ? "Deny" : "Allow"}</span>{" "}
                        <span className="text-[var(--color-text)]">{r.subject.type === "org" ? subjectWord.org : `${subjectWord[r.subject.type]}: ${subjectLabel(r.subject.type, r.subject.id)}`}</span>
                      </div>
                      <div className="text-[13px] text-[var(--color-text-muted)]">
                        {(r.actions || []).map(actionWord).join(", ")}
                        {r.expiresAt && <>. Until {toDateInput(r.expiresAt).replace("T", " ")}</>}
                      </div>
                    </div>
                    {canEdit && (
                      <button type="button" onClick={() => removeRule(idx)} className={`${btnIcon} hover:!text-[var(--state-overdue-text)]`} title="Remove the rule" aria-label={`Remove the rule for ${subjectLabel(r.subject.type, r.subject.id)}`}>
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Add a rule. */}
          {canEdit && (
            <section className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className={h3}>Add a rule</h3>
                <button type="button" onClick={() => setShowBulkSelector(!showBulkSelector)} className={btnLink}>
                  {showBulkSelector ? "One person, team or role" : "Several roles at once"}
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Allow or deny">
                  <Select value={effect} onChange={(e) => setEffect(e.target.value as PermissionEffect)}>
                    <option value="allow">Allow</option>
                    <option value="deny">Deny</option>
                  </Select>
                </Field>
                {!showBulkSelector && (
                  <Field label="Who">
                    <Select value={subjectType} onChange={(e) => { setSubjectType(e.target.value as PermissionSubjectType); setSubjectId(""); }}>
                      {SUBJECT_TYPES.map((s) => <option key={s.key} value={s.key}>{subjectWord[s.key]}</option>)}
                    </Select>
                  </Field>
                )}
                {showBulkSelector ? (
                  <div className="sm:col-span-2">
                    <div className="text-[14px] font-semibold text-[var(--color-text)] mb-1.5">Roles</div>
                    <div className="max-h-72 overflow-y-auto rounded-xl border border-[var(--color-border)]">
                      <RoleTreeSelector selected={bulkRoles} onChange={setBulkRoles} />
                    </div>
                  </div>
                ) : subjectType === "role" ? (
                  <Field label="Role" className="sm:col-span-2">
                    <Select value={rolePick} onChange={(e) => setRolePick(e.target.value as Role)}>
                      {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </Select>
                  </Field>
                ) : subjectType === "user" ? (
                  <Field label="Person" className="sm:col-span-2">
                    <Select value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
                      <option value="">Pick a person</option>
                      {orgMembers.map((u) => <option key={u.uid} value={u.uid}>{u.name}{u.email && u.email !== u.name ? ` (${u.email})` : ""}</option>)}
                    </Select>
                  </Field>
                ) : subjectType === "team" ? (
                  <Field label="Team" className="sm:col-span-2" hint={teams.length === 0 ? "No teams yet. Make them in Admin, Teams." : undefined}>
                    <Select value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
                      <option value="">Pick a team</option>
                      {teams.map((t) => <option key={t.id} value={t.id}>{t.name}, {t.memberCount ?? 0} {(t.memberCount ?? 0) === 1 ? "person" : "people"}</option>)}
                    </Select>
                  </Field>
                ) : (
                  <Field label="Workspace ID" className="sm:col-span-2" hint={activeOrgId ? `This workspace is ${activeOrgId}.` : undefined}>
                    <Input value={subjectId} onChange={(e) => setSubjectId(e.target.value)} placeholder={activeOrgId ?? ""} spellCheck={false} />
                  </Field>
                )}

                <div className="sm:col-span-2">
                  <div className="text-[14px] font-semibold text-[var(--color-text)] mb-1.5">What they can do</div>
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="What they can do">
                    {ACTIONS.map((a) => {
                      const on = actions.includes(a.key);
                      return (
                        <button key={a.key} type="button" role="checkbox" aria-checked={on} onClick={() => toggleAction(a.key)} title={a.hint}
                          className={`inline-flex items-center gap-1 h-8 pointer-coarse:h-10 px-2.5 rounded-md text-[13px] font-semibold border transition-colors ${on ? "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-text)]" : "bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border-strong)] hover:text-[var(--color-text)]"}`}>
                          {on && <Check aria-hidden className="w-3.5 h-3.5" />}{a.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <Field label="Until" hint="Optional. Blank: until someone removes it." className="sm:col-span-2">
                  <Input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className="[color-scheme:light] dark:[color-scheme:dark]" />
                </Field>

                <div className="sm:col-span-2 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <Button type="button" variant="secondary" disabled={!canAdd} onClick={showBulkSelector ? addBulkRules : addRule}>
                    <Plus className="h-4 w-4" />
                    {showBulkSelector ? (bulkRoles.length ? `Add ${plural(bulkRoles.length, "rule")}` : "Pick roles to add") : "Add the rule"}
                  </Button>
                  {!showBulkSelector && (
                    <span className="inline-flex items-center gap-1">
                      <button type="button" className={btnLink}
                        onClick={() => { setVisibility("hidden"); setEffect("allow"); setActions(["discover", "read"]); setSubjectType("user"); }}>
                        Blind-drill setup
                      </button>
                      <HelpTooltip>Hides this from everyone, then lets you allow one person at a time to find and read it.</HelpTooltip>
                    </span>
                  )}
                </div>
              </div>
            </section>
          )}
        </div>

        <div className="shrink-0 px-5 sm:px-6 py-3.5 pb-[calc(14px+env(safe-area-inset-bottom))] border-t border-[var(--color-border)] bg-[var(--color-surface-2)] flex items-center justify-end gap-2 sm:rounded-bl-xl">
          {canEdit && dirty && <span className="mr-auto text-[13px] text-[var(--color-text-muted)]">Not saved yet</span>}
          <Button variant="secondary" onClick={close} disabled={saving}>{canEdit ? "Cancel" : "Close"}</Button>
          {canEdit && (
            <Button onClick={() => void save()} loading={saving} disabled={!dirty} title={!dirty ? "Nothing changed yet" : undefined}>Save</Button>
          )}
        </div>
      </div>
    </div>
  );
}
