"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  X,
  Shield,
  ShieldAlert,
  Eye,
  EyeOff,
  Plus,
  Trash2,
  Save,
  Loader2,
  Users
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { buildAclIndexFromChain } from "@/lib/acl";
import { useRole } from "@/components/providers/RoleContext";
import { appAlert } from "@/components/providers/DialogProvider";
import { listTeams, type Team } from "@/lib/teams";
import { RoleTreeSelector } from "./RoleTreeSelector"; // Import the selector
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
  { key: "discover", label: "Discover", hint: "Can see that it exists (name/presence)" },
  { key: "read", label: "Read", hint: "Can open/view" },
  { key: "download", label: "Download", hint: "Can download (watermarked later)" },
  { key: "upload", label: "Upload", hint: "Can upload into this container" },
  { key: "createFolder", label: "Create Folder", hint: "Can create subfolders here" },
  { key: "editMetadata", label: "Edit Metadata", hint: "Can edit metadata fields" },
  { key: "write", label: "Write", hint: "Can modify/replace content" },
  { key: "publish", label: "Publish Revisions", hint: "Can rev-up / revert here, incl. publishing over another user's checkout (grant at the library level)" },
  { key: "managePermissions", label: "Manage Permissions", hint: "Can edit ACL on this node" },
  { key: "admin", label: "Admin", hint: "Full control (implies everything in UI)" },
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
    const t = nodeType[0].toUpperCase() + nodeType.slice(1);
    return `${t} Permissions`;
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
      if (error) throw new Error(error.message);

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
          await appAlert({ title: "Saved, but not logged", message: `The permission change saved, but its audit record didn't: ${auditError.message}`, tone: "danger" });
        }
      }
      close();
    } catch (e) {
      console.error(e);
      await appAlert({ title: "Couldn't save permissions", message: (e as Error)?.message || "Check the rules and your connection, then try again.", tone: "danger" });
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div role="dialog" aria-modal="true" aria-label={`Permissions for ${nodeLabel}`} className="fixed inset-0 z-[90] flex justify-end bg-[var(--color-ink)]/60 animate-in fade-in">
      <div className="h-full w-full max-w-[560px] bg-[var(--color-surface)] text-[var(--color-text)] shadow-2xl sm:rounded-l-[20px] animate-in slide-in-from-right duration-300 ease-fluid flex flex-col">
        <div className="flex items-start justify-between gap-3 px-5 sm:px-6 pt-5 pb-4 border-b border-[var(--color-border)] shrink-0">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-text-muted)]">
              <Shield className="h-3.5 w-3.5" /> Permissions · {nodeType === "collection" ? "folder" : nodeType}
            </div>
            <h2 className="mt-2 text-[30px] sm:text-[34px] leading-none font-black tracking-[-0.03em] break-words">{nodeLabel}</h2>
            <div className="mt-2 text-[12px] text-[var(--color-text-muted)] truncate" title={nodeId}>ID {nodeId}</div>
          </div>

          <button
            onClick={close}
            className="w-9 h-9 shrink-0 grid place-items-center rounded-[10px] bg-[var(--color-surface-2)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            title="Close"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 sm:px-6 py-5 space-y-6">
          {/* ... (Visibility Section) */}
          <div className="border-t border-[var(--color-border)] pt-5 first:border-t-0 first:pt-0">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold flex items-center gap-2">
                {visibility === "hidden" || visibility === "private" ? (
                  <EyeOff className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                ) : (
                  <Eye className="h-4 w-4 text-[var(--color-text-muted)]" />
                )}
                Visibility and Inheritance
              </div>
              {!canEdit && (
                <div className="text-xs text-amber-700 dark:text-amber-300 flex items-center gap-1">
                  <ShieldAlert className="h-4 w-4" />
                  Read-only
                </div>
              )}
            </div>

            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                <div className="text-xs text-[var(--color-text-muted)] mb-2">Visibility</div>
                <div className="flex gap-2">
                  <button
                    disabled={!canEdit}
                    onClick={() => setVisibility("normal")}
                    aria-pressed={visibility === "normal"}
                    className={`flex-1 rounded-lg px-3 py-2 text-sm border ${
                      visibility === "normal"
                        ? "border-transparent bg-[var(--color-text)] text-[var(--color-surface)]"
                        : "border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"
                    } ${!canEdit ? "opacity-50 cursor-not-allowed" : ""}`}
                  >
                    Normal
                  </button>
                  <button
                    disabled={!canEdit}
                    onClick={() => setVisibility("hidden")}
                    aria-pressed={visibility === "hidden"}
                    className={`flex-1 rounded-lg px-3 py-2 text-sm border ${
                      visibility === "hidden"
                        ? "border-transparent bg-[var(--color-text)] text-[var(--color-surface)]"
                        : "border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"
                    } ${!canEdit ? "opacity-50 cursor-not-allowed" : ""}`}
                  >
                    Hidden
                  </button>
                </div>
                <div className="mt-2 text-xs text-[var(--color-text-faint)]">
                  Hidden = not discoverable unless explicitly allowed.
                </div>
              </div>

              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                <div className="text-xs text-[var(--color-text-muted)] mb-2">Inherit from parent</div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    disabled={!canEdit}
                    checked={inherit}
                    onChange={(e) => setInherit(e.target.checked)}
                    className="h-4 w-4 accent-[var(--color-text)]"
                  />
                  Inherit ACL rules
                </label>
                <div className="mt-2 text-xs text-[var(--color-text-faint)]">
                  If enabled, parent rules apply unless overridden here.
                </div>
              </div>
            </div>
          </div>

          {/* ... (Rules List Section) */}
          <div className="border-t border-[var(--color-border)] pt-5 first:border-t-0 first:pt-0">
            <div className="text-sm font-semibold">Rules</div>
            <div className="text-xs text-[var(--color-text-faint)] mt-1">
              Deny rules win, and inheritance can be cut at any node.
            </div>

            <div className="mt-4 space-y-3">
              {rules.length === 0 ? (
                <div className="text-sm text-[var(--color-text-muted)]">No rules yet.</div>
              ) : (
                rules.map((r, idx) => (
                  <div
                    key={idx}
                    className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`text-xs px-2 py-1 rounded-lg border ${
                              r.effect === "allow"
                                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                                : "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300"
                            }`}
                          >
                            {r.effect.toUpperCase()}
                          </span>

                          <span className="text-xs px-2 py-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)]">
                            {r.subject.type}: {subjectLabel(r.subject.type, r.subject.id)}
                          </span>

                          {r.expiresAt && (
                            <span className="text-[11px] px-2 py-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text-muted)]">
                              expires {toDateInput(r.expiresAt).replace("T", " ")}
                            </span>
                          )}
                        </div>

                        <div className="mt-2 flex flex-wrap gap-2">
                          {(r.actions || []).map((a) => (
                            <span
                              key={a}
                              className="text-[11px] px-2 py-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)]"
                            >
                              {a}
                            </span>
                          ))}
                        </div>
                      </div>

                      <button
                        disabled={!canEdit}
                        onClick={() => removeRule(idx)}
                        className={`p-2 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-surface-2)] ${
                          !canEdit ? "opacity-50 cursor-not-allowed" : ""
                        }`}
                        title="Remove rule"
                        aria-label="Remove rule"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="border-t border-[var(--color-border)] pt-5 first:border-t-0 first:pt-0">
            <div className="flex items-center justify-between mb-4">
              <div className="text-sm font-semibold flex items-center gap-2">
                <Plus className="h-4 w-4" />
                Add rule
              </div>
              <button
                onClick={() => setShowBulkSelector(!showBulkSelector)}
                className="text-xs flex items-center border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-2 py-1 rounded-lg hover:bg-[var(--color-surface-2)] transition-colors"
              >
                <Users className="w-3 h-3 mr-1" />
                {showBulkSelector ? "Manual Entry" : "Use Directory Tree"}
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-[var(--color-text-muted)] mb-1">Effect</div>
                <select
                  disabled={!canEdit}
                  value={effect}
                  onChange={(e) => setEffect(e.target.value as PermissionEffect)}
                  className={`w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm ${
                    !canEdit ? "opacity-50 cursor-not-allowed" : ""
                  }`}
                >
                  <option value="allow">allow</option>
                  <option value="deny">deny</option>
                </select>
              </div>

              {showBulkSelector ? (
                <div className="sm:col-span-2">
                  <div className="text-xs text-[var(--color-text-muted)] mb-1">Select Roles (Multi)</div>
                  <div className="max-h-64 overflow-y-auto custom-scrollbar border border-[var(--color-border)] rounded-lg">
                    <RoleTreeSelector 
                      selected={bulkRoles} 
                      onChange={setBulkRoles} 
                      disabled={!canEdit}
                    />
                  </div>
                </div>
              ) : (
                <>
                  <div>
                    <div className="text-xs text-[var(--color-text-muted)] mb-1">Subject type</div>
                    <select
                      disabled={!canEdit}
                      value={subjectType}
                      onChange={(e) => setSubjectType(e.target.value as PermissionSubjectType)}
                      className={`w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm ${
                        !canEdit ? "opacity-50 cursor-not-allowed" : ""
                      }`}
                    >
                      {SUBJECT_TYPES.map((s) => (
                        <option key={s.key} value={s.key}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  {subjectType === "role" ? (
                    <div className="sm:col-span-2">
                      <div className="text-xs text-[var(--color-text-muted)] mb-1">Role</div>
                      <select
                        disabled={!canEdit}
                        value={rolePick}
                        onChange={(e) => setRolePick(e.target.value as Role)}
                        className={`w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm ${
                          !canEdit ? "opacity-50 cursor-not-allowed" : ""
                        }`}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : subjectType === "user" ? (
                    <div className="sm:col-span-2">
                      <div className="text-xs text-[var(--color-text-muted)] mb-1">Person</div>
                      <select
                        disabled={!canEdit}
                        value={subjectId}
                        onChange={(e) => setSubjectId(e.target.value)}
                        className={`w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm ${!canEdit ? "opacity-50 cursor-not-allowed" : ""}`}
                      >
                        <option value="">Select a person…</option>
                        {orgMembers.map((u) => (
                          <option key={u.uid} value={u.uid}>{u.name}{u.email ? ` (${u.email})` : ""}</option>
                        ))}
                      </select>
                    </div>
                  ) : subjectType === "team" ? (
                    <div className="sm:col-span-2">
                      <div className="text-xs text-[var(--color-text-muted)] mb-1">Team</div>
                      <select
                        disabled={!canEdit}
                        value={subjectId}
                        onChange={(e) => setSubjectId(e.target.value)}
                        className={`w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm ${!canEdit ? "opacity-50 cursor-not-allowed" : ""}`}
                      >
                        <option value="">Select a team…</option>
                        {teams.map((t) => (
                          <option key={t.id} value={t.id}>{t.name} · {t.memberCount ?? 0} member{(t.memberCount ?? 0) === 1 ? "" : "s"}</option>
                        ))}
                      </select>
                      {teams.length === 0 && <div className="text-[11px] text-[var(--color-text-faint)] mt-1">No teams yet. Create them in Admin, Teams.</div>}
                    </div>
                  ) : (
                    <div className="sm:col-span-2">
                      <div className="text-xs text-[var(--color-text-muted)] mb-1">Subject id</div>
                      <input
                        disabled={!canEdit}
                        value={subjectId}
                        onChange={(e) => setSubjectId(e.target.value)}
                        placeholder={SUBJECT_TYPES.find((x) => x.key === subjectType)?.placeholder ?? "id"}
                        className={`w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm ${!canEdit ? "opacity-50 cursor-not-allowed" : ""}`}
                      />
                    </div>
                  )}
                </>
              )}

              <div className="sm:col-span-2">
                <div className="text-xs text-[var(--color-text-muted)] mb-2">Actions</div>
                <div className="flex flex-wrap gap-2">
                  {ACTIONS.map((a) => {
                    const on = actions.includes(a.key);
                    return (
                      <button
                        key={a.key}
                        disabled={!canEdit}
                        onClick={() => toggleAction(a.key)}
                        className={`text-xs px-3 py-2 rounded-xl border ${
                          on
                            ? "border-transparent bg-[var(--color-text)] text-[var(--color-surface)]"
                            : "border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] text-[var(--color-text)]"
                        } ${!canEdit ? "opacity-50 cursor-not-allowed" : ""}`}
                        title={a.hint}
                        aria-pressed={on}
                        type="button"
                      >
                        {a.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="sm:col-span-2">
                <div className="text-xs text-[var(--color-text-muted)] mb-1">Expires (optional)</div>
                <input
                  disabled={!canEdit}
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                  className={`w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm ${
                    !canEdit ? "opacity-50 cursor-not-allowed" : ""
                  }`}
                />
              </div>

              <div className="sm:col-span-2 flex gap-2">
                <button
                  disabled={!canEdit}
                  onClick={showBulkSelector ? addBulkRules : addRule}
                  type="button"
                  className={`flex-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm hover:bg-[var(--color-surface-2)] flex items-center justify-center gap-2 ${
                    !canEdit ? "opacity-50 cursor-not-allowed" : ""
                  }`}
                >
                  <Plus className="h-4 w-4" />
                  {showBulkSelector ? `Add ${bulkRoles.length} Rules` : "Add rule"}
                </button>

                {!showBulkSelector && (
                  <button
                    disabled={!canEdit}
                    onClick={() => {
                      setVisibility("hidden");
                      setEffect("allow");
                      setActions(["discover", "read"]);
                      setSubjectType("user");
                    }}
                    type="button"
                    className={`rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm hover:bg-[var(--color-surface-2)] ${
                      !canEdit ? "opacity-50 cursor-not-allowed" : ""
                    }`}
                    title="Preset for blind drilling"
                  >
                    Blind-drill preset
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="pb-8 flex gap-3">
            <button
              onClick={close}
              className="flex-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm hover:bg-[var(--color-surface-2)]"
            >
              Cancel
            </button>
            <button
              disabled={!canEdit || saving}
              onClick={save}
              className={`flex-1 rounded-xl bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] font-bold px-3 py-2 text-sm flex items-center justify-center gap-2 disabled:opacity-60 ${
                !canEdit ? "opacity-50 cursor-not-allowed" : ""
              }`}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}
