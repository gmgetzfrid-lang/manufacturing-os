"use client";

import React, { useState, useEffect } from "react";
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Database,
  FileText,
  Plus,
  Save,
  Trash2,
  Users,
  X,
  Library as LibraryIcon,
  Info,
  type LucideIcon,
} from "lucide-react";
import type { AccessRule, LibraryConfig, LibraryType, MetadataFieldDefinition, Role } from "@/types/schema";
import { ALL_ROLES } from "@/types/schema";
import StepPath from "@/components/ui/StepPath";
import { useDraft } from "@/hooks/useDraft";

/** Where a new library's description is kept while it's being written. */
export const newLibraryDraftKey = (orgId: string) => `new-library:${orgId}`;

interface LibraryWizardProps {
  orgId: string;
  isOpen: boolean;
  onClose: () => void;
  onSave: (config: Omit<LibraryConfig, "id">) => Promise<void>;
  isLoading: boolean;
  initialData?: LibraryConfig | null;
}

const LIBRARY_TYPES: Array<{
  type: LibraryType;
  label: string;
  example: string;
  desc: string;
  icon: LucideIcon;
  color: string;
  bg: string;
}> = [
  {
    type: "Engineering",
    label: "Engineering & Drawings",
    example: "P&IDs, CAD drawings, schematics",
    desc: "For technical documents that need strict revision tracking (Rev A, B, 0, 1).",
    icon: Database,
    color: "text-[var(--color-text)]",
    bg: "bg-[var(--color-surface-2)] border-[var(--color-border)]",
  },
  {
    type: "Procedure",
    label: "Procedures & Policies",
    example: "SOPs, safety procedures, work instructions",
    desc: "For documents that need periodic review cycles and training records.",
    icon: FileText,
    color: "text-[var(--color-text)]",
    bg: "bg-[var(--color-surface-2)] border-[var(--color-border)]",
  },
  {
    type: "Business",
    label: "Business Documents",
    example: "HR, finance, legal, contracts",
    desc: "Secure storage for internal business documents with department-level access.",
    icon: Users,
    color: "text-[var(--color-text)]",
    bg: "bg-[var(--color-surface-2)] border-[var(--color-border)]",
  },
  {
    type: "UserSpace",
    label: "Personal Workspaces",
    example: "Individual work files, drafts, personal folders",
    desc: "Each user gets their own private space with optional shared folders.",
    icon: LibraryIcon,
    color: "text-[var(--color-text)]",
    bg: "bg-[var(--color-surface-2)] border-[var(--color-border)]",
  },
];

const FIELD_TYPES: Array<{ value: MetadataFieldDefinition["type"]; label: string; hint: string }> = [
  { value: "text", label: "Text", hint: "Single line of text" },
  { value: "number", label: "Number", hint: "Numeric value" },
  { value: "date", label: "Date", hint: "Date picker" },
  { value: "boolean", label: "Yes / No", hint: "Checkbox" },
  { value: "select", label: "Dropdown", hint: "Select from a list" },
  { value: "user", label: "User", hint: "Pick a person from your org" },
];

const ROLE_GROUPS = [
  { title: "Leadership", roles: ["Admin", "DocCtrl", "Manager", "Supervisor"] as Role[] },
  { title: "Engineering", roles: ["Engineer-1", "Engineer-2", "Engineer-3", "Engineer-4"] as Role[] },
  { title: "Operations", roles: ["Operations", "Maintenance", "Safety"] as Role[] },
  { title: "Business", roles: ["Accounting", "HR", "Auditor"] as Role[] },
  { title: "Other", roles: ["Requester", "Drafter", "Contractor", "Viewer"] as Role[] },
];

function toKey(label: string) {
  return label.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
}

function defaultColumns(): MetadataFieldDefinition[] {
  return [
    { key: "document_number", label: "Document Number", type: "text", searchable: true, required: true, visible: true },
    { key: "rev", label: "Revision", type: "text", searchable: true, required: true, visible: true },
    { key: "title", label: "Title", type: "text", searchable: true, required: true, visible: true },
    { key: "status", label: "Status", type: "text", searchable: true, required: false, visible: true },
  ];
}

function Tooltip({ text }: { text: string }) {
  const [show, setShow] = useState(false);
  return (
    <span className="relative inline-flex items-center ml-1.5">
      <Info
        className="w-3.5 h-3.5 text-[var(--color-text-faint)] cursor-help"
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
      />
      {show && (
        <span className="absolute left-5 top-0 z-50 w-48 bg-[var(--color-text)] text-[var(--color-surface)] text-xs rounded-lg px-3 py-2 shadow-xl">
          {text}
        </span>
      )}
    </span>
  );
}

function RolePicker({
  selected,
  onChange,
  includeAll,
  onAllChange,
}: {
  selected: Role[];
  onChange: (roles: Role[]) => void;
  includeAll?: boolean;
  onAllChange?: (all: boolean) => void;
}) {
  const toggle = (role: Role) => {
    if (selected.includes(role)) onChange(selected.filter((r) => r !== role));
    else onChange([...selected, role]);
  };

  return (
    <div className="space-y-3">
      {includeAll && onAllChange && (
        <button
          type="button"
          onClick={() => onAllChange(true)}
          className="w-full text-left px-3 py-2 rounded-lg border border-green-200 bg-green-50 text-green-800 text-xs font-bold"
        >
          Everyone in the organization
        </button>
      )}
      {ROLE_GROUPS.map((group) => (
        <div key={group.title}>
          <p className="text-[11px] font-bold text-[var(--color-text-faint)] uppercase tracking-wider mb-1.5">{group.title}</p>
          <div className="flex flex-wrap gap-1.5">
            {group.roles.map((role) => {
              const active = selected.includes(role);
              return (
                <button
                  key={role}
                  type="button"
                  onClick={() => toggle(role)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-bold border transition-all ${
                    active
                      ? "bg-[var(--color-text)] text-[var(--color-surface)] border-transparent"
                      : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
                  }`}
                >
                  {role}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function LibraryWizard({ orgId, isOpen, onClose, onSave, isLoading, initialData }: LibraryWizardProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [error, setError] = useState<string | null>(null);

  // Step 1
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<LibraryType>("Engineering");

  // Step 2 — all fields (standard pre-populated + custom)
  const [columns, setColumns] = useState<MetadataFieldDefinition[]>([]);

  // Step 3 — permissions (plain language)
  const [viewAccess, setViewAccess] = useState<"all" | "restricted">("all");
  const [viewRoles, setViewRoles] = useState<Role[]>([]);
  const [uploadRoles, setUploadRoles] = useState<Role[]>(["DocCtrl", "Admin", "Engineer-1", "Engineer-2"]);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    // Seed the form when the modal opens. Wrapped in an IIFE so these resets
    // aren't read as cascading setState-in-effect; they still run synchronously.
    void (async () => {
      setStep(1);
      setError(null);

      if (initialData) {
        setName(initialData.name ?? "");
        setDescription(initialData.description ?? "");
        setType(initialData.type ?? "Engineering");
        setColumns(initialData.customColumns?.length ? initialData.customColumns : defaultColumns());
        setViewAccess(initialData.readAccess === "ALL" ? "all" : "restricted");
        setViewRoles(Array.isArray(initialData.readAccess) ? initialData.readAccess : []);
        setUploadRoles(initialData.writeAccess ?? ["DocCtrl", "Admin"]);
      } else {
        setName("");
        setDescription("");
        setType("Engineering");
        setColumns(defaultColumns());
        setViewAccess("all");
        setViewRoles([]);
        setUploadRoles(["DocCtrl", "Admin", "Engineer-1", "Engineer-2"]);
        setShowAdvanced(false);
      }
    })();
  }, [isOpen, initialData]);

  // A new library's description autosaves on this device (not when editing).
  useDraft<string>(isOpen && !initialData ? newLibraryDraftKey(orgId) : null, description, setDescription, (v) => !v.trim());

  useEffect(() => {
    if (!isOpen || isLoading) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, isLoading, onClose]);

  const handleNext = () => {
    setError(null);
    if (step === 1) {
      if (!name.trim()) { setError("Please give this library a name."); return; }
    }
    if (step === 2) {
      for (const f of columns) {
        if (!f.label.trim()) { setError("Each field needs a label."); return; }
      }
    }
    if (step < 3) setStep((s) => (s + 1) as 1 | 2 | 3);
  };

  const handleSubmit = async () => {
    setError(null);

    const allColumns = columns.map((f) => ({ ...f, key: f.key || toKey(f.label) }));

    const readAccess = viewAccess === "all" ? "ALL" : viewRoles;
    const adminRoles: Role[] = ["Admin", "DocCtrl"];
    const writeRoles = Array.from(new Set([...uploadRoles, ...adminRoles])) as Role[];
    const visibleTo = viewAccess === "all" ? ALL_ROLES : Array.from(new Set([...viewRoles, ...writeRoles])) as Role[];

    const rules: AccessRule[] = [];
    if (viewAccess === "all") {
      rules.push({ effect: "allow", subject: { type: "org", id: orgId }, actions: ["discover", "read", "download"] });
    } else {
      viewRoles.forEach((r) => rules.push({ effect: "allow", subject: { type: "role", id: r }, actions: ["discover", "read", "download"] }));
    }
    writeRoles.forEach((r) => rules.push({ effect: "allow", subject: { type: "role", id: r }, actions: ["upload", "createFolder", "editMetadata", "write", "download", "read", "discover"] }));
    adminRoles.forEach((r) => rules.push({ effect: "allow", subject: { type: "role", id: r }, actions: ["admin", "managePermissions"] }));

    const acl = { inherit: true, visibility: "normal" as const, rules };

    await onSave({
      name: name.trim(),
      description: description.trim(),
      type,
      customColumns: allColumns,
      readAccess,
      writeAccess: writeRoles,
      adminAccess: adminRoles,
      visibleTo,
      folderSecurity: "Inherited",
      defaultNewVisibility: "normal",
      acl,
      defaultNewAcl: acl,
    } as Omit<LibraryConfig, "id">);
  };

  const addField = () => {
    setColumns((f) => [...f, { key: "", label: "", type: "text", searchable: true, required: false, visible: true }]);
  };

  const removeField = (i: number) => setColumns((f) => f.filter((_, idx) => idx !== i));

  const moveField = (i: number, dir: "up" | "down") => {
    setColumns((f) => {
      const next = [...f];
      const swap = dir === "up" ? i - 1 : i + 1;
      if (swap < 0 || swap >= next.length) return f;
      [next[i], next[swap]] = [next[swap], next[i]];
      return next;
    });
  };

  const updateField = (i: number, patch: Partial<MetadataFieldDefinition>) => {
    setColumns((f) => {
      const next = [...f];
      next[i] = { ...next[i], ...patch };
      if (patch.label && !next[i].key) next[i].key = toKey(patch.label);
      return next;
    });
  };

  if (!isOpen) return null;

  const STEPS = ["Library Info", "Document Fields", "Permissions"];

  return (
    <div role="dialog" aria-modal="true" aria-label={initialData ? "Edit Library" : "Create New Library"} className="fixed inset-0 z-50 flex items-start sm:items-center justify-center overflow-y-auto bg-slate-900/50 backdrop-blur-sm p-4">
      <div className="bg-[var(--color-surface)] w-full max-w-3xl rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-[var(--color-border)] max-h-[92vh]">

        {/* Header */}
        <div className="px-8 py-5 border-b border-[var(--color-border)] flex justify-between items-center shrink-0">
          <div>
            <h2 className="text-xl font-black text-[var(--color-text)]">
              {initialData ? "Edit Library" : "Create New Library"}
            </h2>
          </div>
          <button onClick={onClose} disabled={isLoading} aria-label="Close" className="p-2 text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-8 pt-4 shrink-0">
          <StepPath steps={STEPS} current={step - 1} onPick={(i) => setStep((i + 1) as 1 | 2 | 3)} />
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-8">

          {/* STEP 1: Library Info */}
          {step === 1 && (
            <div className="space-y-8">
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-bold text-[var(--color-text)] mb-1.5">
                    Library Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Bakersfield P&IDs, Safety Procedures"
                    className="w-full px-4 py-3 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-xl text-[var(--color-text)] font-bold focus:ring-2 focus:ring-[var(--color-accent-ring)] focus:bg-[var(--color-surface)] outline-none transition-all text-lg placeholder:text-[var(--color-text-faint)]"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-[var(--color-text)] mb-1.5">
                    What is this library for?
                    <span className="text-[var(--color-text-faint)] font-normal ml-2 text-xs">(optional)</span>
                  </label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Briefly describe what's stored here and who uses it..."
                    rows={2}
                    className="w-full px-4 py-3 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-xl text-[var(--color-text)] focus:ring-2 focus:ring-[var(--color-accent-ring)] focus:bg-[var(--color-surface)] outline-none resize-none transition-all placeholder:text-[var(--color-text-faint)]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-bold text-[var(--color-text)] mb-3">
                  What type of documents will go here?
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {LIBRARY_TYPES.map((t) => {
                    const Icon = t.icon;
                    const active = type === t.type;
                    return (
                      <button
                        key={t.type}
                        type="button"
                        onClick={() => setType(t.type)}
                        className={`text-left p-4 rounded-xl border-2 transition-all ${
                          active ? "border-[var(--color-text)] bg-[var(--color-surface-2)]" : `border-[var(--color-border)] hover:border-[var(--color-border-strong)] ${t.bg}`
                        }`}
                      >
                        <div className="flex items-center gap-3 mb-2">
                          <Icon className={`w-5 h-5 ${active ? "text-[var(--color-text-muted)]" : t.color}`} />
                          <span className="font-bold text-sm text-[var(--color-text)]">{t.label}</span>
                          {active && <CheckCircle2 className="w-4 h-4 text-[var(--color-text-muted)] ml-auto" />}
                        </div>
                        <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">{t.desc}</p>
                        <p className="text-[11px] text-[var(--color-text-faint)] mt-1.5 italic">{t.example}</p>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* STEP 2: Document Fields */}
          {step === 2 && (
            <div className="space-y-4">
              <div className="bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-xl p-4">
                <p className="text-sm font-bold text-[var(--color-text)] mb-0.5">Define what information is tracked per document</p>
                <p className="text-xs text-[var(--color-text)]">These fields appear as columns in the document list. Edit, reorder, or add fields. The first four are pre-set but fully editable.</p>
              </div>

              <div className="space-y-2">
                {columns.map((f, i) => (
                  <div key={i} className="flex items-center gap-2 p-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl group">
                    {/* Reorder buttons */}
                    <div className="flex flex-col gap-0.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => moveField(i, "up")}
                        disabled={i === 0}
                        className="p-1 rounded hover:bg-[var(--color-surface-2)] text-slate-300 hover:text-[var(--color-text-muted)] disabled:opacity-0 transition-all"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" /></svg>
                      </button>
                      <button
                        type="button"
                        onClick={() => moveField(i, "down")}
                        disabled={i === columns.length - 1}
                        className="p-1 rounded hover:bg-[var(--color-surface-2)] text-slate-300 hover:text-[var(--color-text-muted)] disabled:opacity-0 transition-all"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                      </button>
                    </div>

                    {/* Field label */}
                    <input
                      value={f.label}
                      onChange={(e) => updateField(i, { label: e.target.value, key: f.key || toKey(e.target.value) })}
                      placeholder="Field label (e.g. Project Code)"
                      className="flex-1 px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm font-medium focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none transition-all"
                    />

                    {/* Field type */}
                    <select
                      value={f.type}
                      onChange={(e) => updateField(i, { type: e.target.value as MetadataFieldDefinition["type"] })}
                      className="w-32 px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none bg-[var(--color-surface)]"
                    >
                      {FIELD_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                      ))}
                    </select>

                    {/* Toggles */}
                    <div className="flex items-center gap-3 shrink-0">
                      <label className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] cursor-pointer">
                        <input type="checkbox" checked={f.required ?? false} onChange={(e) => updateField(i, { required: e.target.checked })} className="rounded" />
                        Required
                      </label>
                      <label className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] cursor-pointer">
                        <input type="checkbox" checked={f.searchable ?? true} onChange={(e) => updateField(i, { searchable: e.target.checked })} className="rounded" />
                        Searchable
                      </label>
                      <label className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] cursor-pointer">
                        <input type="checkbox" checked={f.visible ?? true} onChange={(e) => updateField(i, { visible: e.target.checked })} className="rounded" />
                        Visible
                      </label>
                    </div>

                    {/* Remove */}
                    <button
                      type="button"
                      onClick={() => removeField(i)}
                      className="p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors shrink-0"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>

              <button
                onClick={addField}
                type="button"
                className="flex items-center gap-2 px-4 py-3 border-2 border-dashed border-[var(--color-border-strong)] rounded-xl text-sm font-bold text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-all w-full justify-center"
              >
                <Plus className="w-4 h-4" />
                Add Field
              </button>
            </div>
          )}

          {/* STEP 3: Permissions */}
          {step === 3 && (
            <div className="space-y-6">
              {/* View access */}
              <div className="border border-[var(--color-border)] rounded-xl overflow-hidden">
                <div className="px-5 py-4 bg-[var(--color-surface-2)] border-b border-[var(--color-border)]">
                  <p className="text-sm font-bold text-[var(--color-text)]">
                    Who can view documents in this library?
                  </p>
                  <p className="text-xs text-[var(--color-text-muted)] mt-0.5">Read and download access.</p>
                </div>
                <div className="p-5 space-y-3">
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => setViewAccess("all")}
                      className={`flex-1 px-4 py-3 rounded-xl border-2 text-sm font-bold transition-all text-left ${
                        viewAccess === "all"
                          ? "border-green-500 bg-green-50 text-green-800"
                          : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)]"
                      }`}
                    >
                      <div className="font-bold">Everyone</div>
                      <div className="text-xs font-normal mt-0.5 opacity-70">All org members can view</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewAccess("restricted")}
                      className={`flex-1 px-4 py-3 rounded-xl border-2 text-sm font-bold transition-all text-left ${
                        viewAccess === "restricted"
                          ? "border-[var(--color-text)] bg-[var(--color-text)] text-[var(--color-surface)]"
                          : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)]"
                      }`}
                    >
                      <div className="font-bold">Restricted</div>
                      <div className="text-xs font-normal mt-0.5 opacity-70">Only selected roles</div>
                    </button>
                  </div>
                  {viewAccess === "restricted" && (
                    <div className="pt-2">
                      <RolePicker selected={viewRoles} onChange={setViewRoles} />
                    </div>
                  )}
                </div>
              </div>

              {/* Upload access */}
              <div className="border border-[var(--color-border)] rounded-xl overflow-hidden">
                <div className="px-5 py-4 bg-[var(--color-surface-2)] border-b border-[var(--color-border)]">
                  <p className="text-sm font-bold text-[var(--color-text)]">
                    Who can upload and edit documents?
                    <Tooltip text="These roles can upload new files, edit metadata, and manage document revisions." />
                  </p>
                  <p className="text-xs text-[var(--color-text-muted)] mt-0.5">Admins and Doc Control always have full access.</p>
                </div>
                <div className="p-5">
                  <RolePicker selected={uploadRoles} onChange={setUploadRoles} />
                </div>
              </div>

              {/* Advanced (collapsed by default) */}
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="flex items-center gap-2 text-xs font-bold text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)] transition-colors"
              >
                {showAdvanced ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                Advanced settings
              </button>

              {showAdvanced && (
                <div className="border border-[var(--color-border)] rounded-xl p-5 space-y-4 bg-[var(--color-surface-2)]">
                  <p className="text-xs text-[var(--color-text-muted)]">These settings have sensible defaults and rarely need changing.</p>
                  <div className="text-xs text-[var(--color-text-muted)] space-y-2">
                    <p><span className="font-bold">Folder permissions:</span> Folders inherit the library&rsquo;s settings by default. Individual folder overrides can be set after creation.</p>
                    <p><span className="font-bold">New document visibility:</span> Documents are visible to anyone with library access by default.</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 font-medium">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-8 py-5 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex justify-between items-center shrink-0">
          <button
            onClick={step === 1 ? onClose : () => setStep((s) => (s - 1) as 1 | 2 | 3)}
            className="text-sm font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            type="button"
          >
            {step === 1 ? "Cancel" : "← Back"}
          </button>

          <div className="flex items-center gap-3">
            {step < 3 ? (
              <button
                onClick={handleNext}
                type="button"
                className="px-6 py-2.5 text-sm font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] rounded-xl shadow hover:bg-[var(--color-accent-hover)] flex items-center transition-all"
              >
                Continue <ArrowRight className="w-4 h-4 ml-2" />
              </button>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={isLoading}
                type="button"
                className="px-6 py-2.5 text-sm font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] rounded-xl shadow hover:bg-[var(--color-accent-hover)] flex items-center disabled:opacity-60 transition-all"
              >
                <Save className="w-4 h-4 mr-2" />
                {isLoading ? "Saving…" : initialData ? "Save Library" : "Create Library"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
