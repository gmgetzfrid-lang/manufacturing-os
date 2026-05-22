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
} from "lucide-react";
import type { LibraryConfig, LibraryType, MetadataFieldDefinition, Role } from "@/types/schema";
import { ALL_ROLES } from "@/types/schema";

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
  icon: any;
  color: string;
  bg: string;
}> = [
  {
    type: "Engineering",
    label: "Engineering & Drawings",
    example: "P&IDs, CAD drawings, schematics",
    desc: "For technical documents that need strict revision tracking (Rev A, B, 0, 1).",
    icon: Database,
    color: "text-blue-600",
    bg: "bg-blue-50 border-blue-200",
  },
  {
    type: "Procedure",
    label: "Procedures & Policies",
    example: "SOPs, safety procedures, work instructions",
    desc: "For documents that need periodic review cycles and training records.",
    icon: FileText,
    color: "text-teal-600",
    bg: "bg-teal-50 border-teal-200",
  },
  {
    type: "Business",
    label: "Business Documents",
    example: "HR, finance, legal, contracts",
    desc: "Secure storage for internal business documents with department-level access.",
    icon: Users,
    color: "text-purple-600",
    bg: "bg-purple-50 border-purple-200",
  },
  {
    type: "UserSpace",
    label: "Personal Workspaces",
    example: "Individual work files, drafts, personal folders",
    desc: "Each user gets their own private space with optional shared folders.",
    icon: LibraryIcon,
    color: "text-orange-600",
    bg: "bg-orange-50 border-orange-200",
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
        className="w-3.5 h-3.5 text-slate-400 cursor-help"
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
      />
      {show && (
        <span className="absolute left-5 top-0 z-50 w-48 bg-slate-900 text-white text-xs rounded-lg px-3 py-2 shadow-xl">
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
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">{group.title}</p>
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
                      ? "bg-slate-900 text-white border-slate-900"
                      : "border-slate-200 text-slate-500 hover:border-slate-400 hover:text-slate-700"
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
  }, [isOpen, initialData]);

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
    if (step < 3) setStep((s) => (s + 1) as any);
  };

  const handleSubmit = async () => {
    setError(null);

    const allColumns = columns.map((f) => ({ ...f, key: f.key || toKey(f.label) }));

    const readAccess = viewAccess === "all" ? "ALL" : viewRoles;
    const adminRoles: Role[] = ["Admin", "DocCtrl"];
    const writeRoles = Array.from(new Set([...uploadRoles, ...adminRoles])) as Role[];
    const visibleTo = viewAccess === "all" ? ALL_ROLES : Array.from(new Set([...viewRoles, ...writeRoles])) as Role[];

    const rules: any[] = [];
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
    } as any);
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/80 backdrop-blur-sm p-4">
      <div className="bg-white w-full max-w-3xl rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-slate-200 max-h-[92vh]">

        {/* Header */}
        <div className="px-8 py-5 border-b border-slate-100 flex justify-between items-center shrink-0">
          <div>
            <h2 className="text-xl font-black text-slate-900">
              {initialData ? "Edit Library" : "Create New Library"}
            </h2>
            <p className="text-slate-500 text-sm mt-0.5">{STEPS[step - 1]}</p>
          </div>
          <div className="flex items-center gap-3">
            {/* Step indicators */}
            <div className="flex items-center gap-1.5 mr-2">
              {STEPS.map((label, i) => (
                <React.Fragment key={i}>
                  <div
                    className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all ${
                      step > i + 1
                        ? "bg-green-500 text-white"
                        : step === i + 1
                        ? "bg-orange-600 text-white"
                        : "bg-slate-100 text-slate-400"
                    }`}
                  >
                    {step > i + 1 ? <CheckCircle2 className="w-4 h-4" /> : i + 1}
                  </div>
                  {i < STEPS.length - 1 && (
                    <div className={`w-6 h-0.5 ${step > i + 1 ? "bg-green-400" : "bg-slate-200"}`} />
                  )}
                </React.Fragment>
              ))}
            </div>
            <button onClick={onClose} className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-8">

          {/* STEP 1: Library Info */}
          {step === 1 && (
            <div className="space-y-8">
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-bold text-slate-700 mb-1.5">
                    Library Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Bakersfield P&IDs, Safety Procedures"
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 font-bold focus:ring-2 focus:ring-orange-500 focus:bg-white outline-none transition-all text-lg placeholder:text-slate-300"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-slate-700 mb-1.5">
                    What is this library for?
                    <span className="text-slate-400 font-normal ml-2 text-xs">(optional)</span>
                  </label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Briefly describe what's stored here and who uses it..."
                    rows={2}
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-700 focus:ring-2 focus:ring-orange-500 focus:bg-white outline-none resize-none transition-all placeholder:text-slate-300"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-bold text-slate-700 mb-3">
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
                          active ? "border-orange-500 bg-orange-50" : `border-slate-200 hover:border-slate-300 ${t.bg}`
                        }`}
                      >
                        <div className="flex items-center gap-3 mb-2">
                          <Icon className={`w-5 h-5 ${active ? "text-orange-600" : t.color}`} />
                          <span className="font-bold text-sm text-slate-900">{t.label}</span>
                          {active && <CheckCircle2 className="w-4 h-4 text-orange-600 ml-auto" />}
                        </div>
                        <p className="text-xs text-slate-500 leading-relaxed">{t.desc}</p>
                        <p className="text-[11px] text-slate-400 mt-1.5 italic">{t.example}</p>
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
              <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
                <p className="text-sm font-bold text-blue-900 mb-0.5">Define what information is tracked per document</p>
                <p className="text-xs text-blue-700">These fields appear as columns in the document list. Edit, reorder, or add fields. The first four are pre-set but fully editable.</p>
              </div>

              <div className="space-y-2">
                {columns.map((f, i) => (
                  <div key={i} className="flex items-center gap-2 p-3 bg-white border border-slate-200 rounded-xl group">
                    {/* Reorder buttons */}
                    <div className="flex flex-col gap-0.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => moveField(i, "up")}
                        disabled={i === 0}
                        className="p-1 rounded hover:bg-slate-100 text-slate-300 hover:text-slate-600 disabled:opacity-0 transition-all"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" /></svg>
                      </button>
                      <button
                        type="button"
                        onClick={() => moveField(i, "down")}
                        disabled={i === columns.length - 1}
                        className="p-1 rounded hover:bg-slate-100 text-slate-300 hover:text-slate-600 disabled:opacity-0 transition-all"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                      </button>
                    </div>

                    {/* Field label */}
                    <input
                      value={f.label}
                      onChange={(e) => updateField(i, { label: e.target.value, key: f.key || toKey(e.target.value) })}
                      placeholder="Field label (e.g. Project Code)"
                      className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm font-medium focus:ring-2 focus:ring-orange-500 outline-none transition-all"
                    />

                    {/* Field type */}
                    <select
                      value={f.type}
                      onChange={(e) => updateField(i, { type: e.target.value as any })}
                      className="w-32 px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-orange-500 outline-none bg-white"
                    >
                      {FIELD_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                      ))}
                    </select>

                    {/* Toggles */}
                    <div className="flex items-center gap-3 shrink-0">
                      <label className="flex items-center gap-1 text-[11px] text-slate-500 cursor-pointer">
                        <input type="checkbox" checked={f.required ?? false} onChange={(e) => updateField(i, { required: e.target.checked })} className="rounded" />
                        Required
                      </label>
                      <label className="flex items-center gap-1 text-[11px] text-slate-500 cursor-pointer">
                        <input type="checkbox" checked={f.searchable ?? true} onChange={(e) => updateField(i, { searchable: e.target.checked })} className="rounded" />
                        Searchable
                      </label>
                      <label className="flex items-center gap-1 text-[11px] text-slate-500 cursor-pointer">
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
                className="flex items-center gap-2 px-4 py-3 border-2 border-dashed border-slate-300 rounded-xl text-sm font-bold text-slate-500 hover:border-orange-400 hover:text-orange-600 transition-all w-full justify-center"
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
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-5 py-4 bg-slate-50 border-b border-slate-200">
                  <p className="text-sm font-bold text-slate-900">
                    Who can view documents in this library?
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">Read and download access.</p>
                </div>
                <div className="p-5 space-y-3">
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => setViewAccess("all")}
                      className={`flex-1 px-4 py-3 rounded-xl border-2 text-sm font-bold transition-all text-left ${
                        viewAccess === "all"
                          ? "border-green-500 bg-green-50 text-green-800"
                          : "border-slate-200 text-slate-500 hover:border-slate-300"
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
                          ? "border-orange-500 bg-orange-50 text-orange-800"
                          : "border-slate-200 text-slate-500 hover:border-slate-300"
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
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-5 py-4 bg-slate-50 border-b border-slate-200">
                  <p className="text-sm font-bold text-slate-900">
                    Who can upload and edit documents?
                    <Tooltip text="These roles can upload new files, edit metadata, and manage document revisions." />
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">Admins and Doc Control always have full access.</p>
                </div>
                <div className="p-5">
                  <RolePicker selected={uploadRoles} onChange={setUploadRoles} />
                </div>
              </div>

              {/* Advanced (collapsed by default) */}
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="flex items-center gap-2 text-xs font-bold text-slate-400 hover:text-slate-600 transition-colors"
              >
                {showAdvanced ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                Advanced settings
              </button>

              {showAdvanced && (
                <div className="border border-slate-200 rounded-xl p-5 space-y-4 bg-slate-50">
                  <p className="text-xs text-slate-500">These settings have sensible defaults and rarely need changing.</p>
                  <div className="text-xs text-slate-600 space-y-2">
                    <p><span className="font-bold">Folder permissions:</span> Folders inherit the library's settings by default. Individual folder overrides can be set after creation.</p>
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
        <div className="px-8 py-5 bg-slate-50 border-t border-slate-200 flex justify-between items-center shrink-0">
          <button
            onClick={step === 1 ? onClose : () => setStep((s) => (s - 1) as any)}
            className="text-sm font-bold text-slate-500 hover:text-slate-800 transition-colors"
            type="button"
          >
            {step === 1 ? "Cancel" : "← Back"}
          </button>

          <div className="flex items-center gap-3">
            {step < 3 ? (
              <button
                onClick={handleNext}
                type="button"
                className="px-6 py-2.5 text-sm font-bold text-white bg-orange-600 rounded-xl shadow hover:bg-orange-500 flex items-center transition-all"
              >
                Continue <ArrowRight className="w-4 h-4 ml-2" />
              </button>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={isLoading}
                type="button"
                className="px-6 py-2.5 text-sm font-bold text-white bg-orange-600 rounded-xl shadow hover:bg-orange-500 flex items-center disabled:opacity-60 transition-all"
              >
                <Save className="w-4 h-4 mr-2" />
                {isLoading ? "Saving..." : "Create Library"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
