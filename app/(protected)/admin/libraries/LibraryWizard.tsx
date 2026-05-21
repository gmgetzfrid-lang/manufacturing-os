"use client";

import React, { useMemo, useState, useEffect } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowRight,
  CheckCircle2,
  Columns,
  Database,
  EyeOff,
  FileText,
  FolderLock,
  Library as LibraryIcon,
  Lock,
  Plus,
  Save,
  Trash2,
  Users,
} from "lucide-react";
import type {
  AccessControl,
  AccessRule,
  LibraryConfig,
  LibraryType,
  MetadataFieldDefinition,
  PermissionAction,
  Role,
} from "@/types/schema";
import { ALL_ROLES } from "@/types/schema";
import { RoleTreeSelector } from "@/components/permissions/RoleTreeSelector";

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
  desc: string;
  icon: any;
  accent: string;
  bg: string;
}> = [
  {
    type: "Engineering",
    label: "Engineering / Technical",
    desc: "Optimized for P&IDs, CAD drawings, and strict revision control sequences (A, B, 0, 1).",
    icon: Database,
    accent: "text-blue-600",
    bg: "bg-blue-50",
  },
  {
    type: "Procedure",
    label: "Procedures & Policies",
    desc: "Periodic review cycles, training acknowledgements, and controlled distribution.",
    icon: FileText,
    accent: "text-teal-600",
    bg: "bg-teal-50",
  },
  {
    type: "Business",
    label: "General Business",
    desc: "Secure storage for HR, Finance, and Legal with department-level visibility.",
    icon: Users,
    accent: "text-slate-600",
    bg: "bg-slate-100",
  },
  {
    type: "UserSpace",
    label: "User Workspaces",
    desc: "Personal libraries with private-by-default access and optional shares.",
    icon: LibraryIcon,
    accent: "text-orange-600",
    bg: "bg-orange-50",
  },
];

const FIELD_TYPES: Array<{ value: MetadataFieldDefinition["type"]; label: string }> = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "boolean", label: "Yes/No" },
  { value: "select", label: "Select" },
  { value: "multi", label: "Multi-Select" },
  { value: "tags", label: "Tags / Pills" },
  { value: "user", label: "User" },
  { value: "link", label: "Link" },
];

const ROLE_GROUPS: Array<{ title: string; roles: Role[] }> = [
  { title: "Leadership", roles: ["Admin", "DocCtrl", "Manager", "Supervisor"] },
  { title: "Engineering", roles: ["Engineer-1", "Engineer-2", "Engineer-3", "Engineer-4"] },
  { title: "Operations", roles: ["Operations", "Maintenance", "Safety"] },
  { title: "Business", roles: ["Accounting", "HR", "Auditor"] },
  { title: "Other", roles: ["Requester", "Drafter", "Contractor", "Viewer"] },
];

function makeKeyFromLabel(label: string) {
  return label
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function mergeUnique(roles: Role[]) {
  return Array.from(new Set(roles));
}

function buildRulesForRoles(
  roles: Role[],
  actions: PermissionAction[],
  effect: "allow" | "deny" = "allow"
): AccessRule[] {
  return roles.map((role) => ({
    effect,
    subject: { type: "role", id: role },
    actions,
  }));
}

function buildDefaultAcl(params: {
  orgId: string;
  readAccess: Role[] | "ALL";
  writeAccess: Role[];
  adminAccess: Role[];
  visibility: "normal" | "hidden" | "private";
}): AccessControl {
  const rules: AccessRule[] = [];

  if (params.readAccess === "ALL") {
    rules.push({
      effect: "allow",
      subject: { type: "org", id: params.orgId },
      actions: ["discover", "read", "download"],
    });
  } else {
    rules.push(...buildRulesForRoles(params.readAccess, ["discover", "read", "download"]));
  }

  if (params.writeAccess.length) {
    rules.push(
      ...buildRulesForRoles(params.writeAccess, [
        "upload",
        "createFolder",
        "editMetadata",
        "write",
        "download",
        "read",
        "discover",
      ])
    );
  }

  if (params.adminAccess.length) {
    rules.push(...buildRulesForRoles(params.adminAccess, ["admin", "managePermissions"]));
  }

  return {
    inherit: true,
    visibility: params.visibility,
    rules,
  };
}

export default function LibraryWizard({
  orgId,
  isOpen,
  onClose,
  onSave,
  isLoading,
  initialData,
}: LibraryWizardProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<LibraryType>("Engineering");
  const [columns, setColumns] = useState<MetadataFieldDefinition[]>([]);

  const [readAccess, setReadAccess] = useState<Role[] | "ALL">("ALL");
  const [writeAccess, setWriteAccess] = useState<Role[]>(["DocCtrl", "Admin"]);
  const [adminAccess, setAdminAccess] = useState<Role[]>(["DocCtrl", "Admin"]);
  const [folderSecurity, setFolderSecurity] = useState<LibraryConfig["folderSecurity"]>("Inherited");
  const [defaultVisibility, setDefaultVisibility] = useState<LibraryConfig["defaultNewVisibility"]>("normal");

  useEffect(() => {
    if (!isOpen) return;
    setStep(1);

    if (initialData) {
      setName(initialData.name ?? "");
      setDescription(initialData.description ?? "");
      setType(initialData.type ?? "Engineering");
      setColumns(Array.isArray(initialData.customColumns) ? initialData.customColumns : []);
      setReadAccess(initialData.readAccess ?? "ALL");
      setWriteAccess(initialData.writeAccess ?? ["DocCtrl", "Admin"]);
      setAdminAccess(initialData.adminAccess ?? ["DocCtrl", "Admin"]);
      setFolderSecurity(initialData.folderSecurity ?? "Inherited");
      setDefaultVisibility(initialData.defaultNewVisibility ?? "normal");
    } else {
      setName("");
      setDescription("");
      setType("Engineering");
      setColumns([
        {
          key: "document_number",
          label: "Document No.",
          type: "text",
          searchable: true,
          required: true,
          visible: true,
        },
        {
          key: "rev",
          label: "Revision",
          type: "text",
          searchable: true,
          required: true,
          visible: true,
        },
        {
          key: "title",
          label: "Title",
          type: "text",
          searchable: true,
          required: true,
          visible: true,
        },
      ]);
      setReadAccess("ALL");
      setWriteAccess(["DocCtrl", "Admin"]);
      setAdminAccess(["DocCtrl", "Admin"]);
      setFolderSecurity("Inherited");
      setDefaultVisibility("normal");
    }
  }, [isOpen, initialData]);

  const blockedRoles = useMemo(() => {
    if (readAccess === "ALL") return [];
    const allowed = new Set([...adminAccess, ...writeAccess, ...readAccess]);
    return ALL_ROLES.filter((r) => !allowed.has(r));
  }, [readAccess, adminAccess, writeAccess]);

  const toggleRole = (role: Role, list: Role[], setter: (next: Role[]) => void) => {
    if (list.includes(role)) setter(list.filter((r) => r !== role));
    else setter(mergeUnique([...list, role]));
  };

  const addColumn = () => {
    setColumns((prev) => [
      ...prev,
      { key: "", label: "", type: "text", searchable: true, required: false, visible: true },
    ]);
  };

  const removeColumn = (idx: number) => {
    setColumns((prev) => prev.filter((_, i) => i !== idx));
  };

  const moveColumn = (idx: number, dir: "up" | "down") => {
    setColumns((prev) => {
      const next = [...prev];
      const swap = dir === "up" ? idx - 1 : idx + 1;
      if (swap < 0 || swap >= next.length) return prev;
      const tmp = next[idx];
      next[idx] = next[swap];
      next[swap] = tmp;
      return next;
    });
  };

  const updateColumn = (
    idx: number,
    patch: Partial<MetadataFieldDefinition>,
    autoKeyFromLabel?: boolean
  ) => {
    setColumns((prev) => {
      const next = [...prev];
      const current = next[idx];
      const updated = { ...current, ...patch };
      if (autoKeyFromLabel && !updated.key && patch.label) {
        updated.key = makeKeyFromLabel(patch.label);
      }
      next[idx] = updated;
      return next;
    });
  };

  const handleNext = () => {
    if (step === 1) {
      if (!name.trim()) return alert("Library name is required.");
      if (!description.trim()) return alert("Description is required.");
    }
    if (step === 2) {
      if (columns.some((c) => !c.key || !c.label)) {
        return alert("All metadata columns must have a label and key.");
      }
    }
    if (step < 3) setStep((prev) => (prev + 1) as any);
  };

  const handleBack = () => {
    if (step > 1) setStep((prev) => (prev - 1) as any);
  };

  const handleSubmit = async () => {
    if (columns.some((c) => !c.key || !c.label)) {
      return alert("All columns must have a valid label and database key.");
    }

    const resolvedRead = readAccess === "ALL" ? ALL_ROLES : readAccess;
    const visibleTo = readAccess === "ALL"
      ? ALL_ROLES
      : mergeUnique([...resolvedRead, ...writeAccess, ...adminAccess]);

    const acl = buildDefaultAcl({
      orgId,
      readAccess,
      writeAccess,
      adminAccess,
      visibility: "normal",
    });

    const defaultNewAcl = buildDefaultAcl({
      orgId,
      readAccess,
      writeAccess,
      adminAccess,
      visibility: defaultVisibility ?? "normal",
    });

    await onSave({
      name: name.trim(),
      description: description.trim(),
      type,
      customColumns: columns.map((c) => ({ ...c, key: c.key.trim() })),
      readAccess,
      writeAccess,
      adminAccess,
      visibleTo,
      folderSecurity,
      defaultNewVisibility: defaultVisibility ?? "normal",
      acl,
      defaultNewAcl,
    } as any);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/80 backdrop-blur-sm p-4 animate-in fade-in">
      <div className="bg-white w-full max-w-5xl h-[90vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-slate-200">
        <div className="px-8 py-6 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
          <div>
            <h2 className="text-2xl font-bold text-slate-900">
              {initialData ? "Edit Configuration" : "New Library Wizard"}
            </h2>
            <p className="text-slate-500 text-sm mt-1">
              Step {step} of 3:{" "}
              <span className="font-semibold text-slate-700">
                {step === 1 ? "Identity & Archetype" : step === 2 ? "Metadata Schema" : "Access Control"}
              </span>
            </p>
          </div>

          <div className="flex items-center space-x-2">
            {[1, 2, 3].map((s) => (
              <React.Fragment key={s}>
                <div
                  className={`flex items-center justify-center w-8 h-8 rounded-full font-bold text-xs transition-all duration-300 ${
                    step >= s ? "bg-orange-600 text-white scale-110" : "bg-slate-200 text-slate-500"
                  }`}
                >
                  {step > s ? <CheckCircle2 className="w-5 h-5" /> : s}
                </div>
                {s < 3 && (
                  <div className={`w-8 h-1 transition-all duration-500 ${step > s ? "bg-orange-600" : "bg-slate-200"}`} />
                )}
              </React.Fragment>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-8 bg-white relative">
          {step === 1 && (
            <div className="space-y-8 animate-in fade-in slide-in-from-right-8 duration-300">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
                <div className="space-y-6">
                  <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
                      Library Name <span className="text-red-500">*</span>
                    </label>
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. Bakersfield P&IDs"
                      className="w-full p-4 bg-slate-50 border border-slate-200 rounded-xl text-lg font-bold text-slate-900 focus:ring-2 focus:ring-orange-500 outline-none transition-all placeholder:text-slate-300"
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
                      Description <span className="text-red-500">*</span>
                    </label>
                    <textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="What is stored here? Who is it for?"
                      rows={5}
                      className="w-full p-4 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium text-slate-700 focus:ring-2 focus:ring-orange-500 outline-none resize-none transition-all"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-4">
                    Select Archetype
                  </label>
                  <div className="space-y-3">
                    {LIBRARY_TYPES.map((t) => {
                      const Icon = t.icon;
                      const active = type === t.type;
                      return (
                        <div
                          key={t.type}
                          onClick={() => setType(t.type)}
                          className={`p-4 rounded-xl border-2 cursor-pointer transition-all flex items-start space-x-4 ${
                            active
                              ? "border-orange-500 bg-orange-50 ring-1 ring-orange-500"
                              : "border-slate-100 hover:border-slate-300 hover:bg-slate-50"
                          }`}
                        >
                          <div className={`p-2.5 rounded-lg shrink-0 ${active ? "bg-white shadow-sm" : t.bg}`}>
                            <Icon className={`w-6 h-6 ${active ? t.accent : "text-slate-400"}`} />
                          </div>
                          <div className="flex-1">
                            <h4 className={`font-bold text-sm ${active ? "text-slate-900" : "text-slate-600"}`}>
                              {t.label}
                            </h4>
                            <p className="text-xs text-slate-500 mt-1 leading-relaxed">{t.desc}</p>
                          </div>
                          {active && (
                            <div className="bg-orange-600 rounded-full p-1">
                              <CheckCircle2 className="w-4 h-4 text-white" />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-6 animate-in fade-in slide-in-from-right-8 duration-300">
              <div className="bg-blue-50 border border-blue-100 p-6 rounded-xl flex items-start">
                <Columns className="w-8 h-8 text-blue-600 mr-4 shrink-0" />
                <div>
                  <h4 className="text-lg font-bold text-blue-900">Dynamic Metadata Definition</h4>
                  <p className="text-sm text-blue-700 mt-1 max-w-2xl">
                    Define the smart headers for this library. These columns power indexing, search, and filters.
                  </p>
                </div>
              </div>

              <div className="border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                <table className="w-full text-left">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="w-16" />
                      <th className="text-left text-xs font-bold text-slate-500 uppercase py-3 pl-4 w-1/4">
                        Column Label
                      </th>
                      <th className="text-left text-xs font-bold text-slate-500 uppercase py-3 w-1/4">
                        Database Key
                      </th>
                      <th className="text-left text-xs font-bold text-slate-500 uppercase py-3 w-1/5">
                        Data Type
                      </th>
                      <th className="text-left text-xs font-bold text-slate-500 uppercase py-3 w-1/6">
                        Flags
                      </th>
                      <th className="w-16" />
                    </tr>
                  </thead>
                  <tbody>
                    {columns.map((col, idx) => (
                      <tr key={`${col.key}-${idx}`} className="border-b border-slate-100 last:border-none">
                        <td className="py-3 pl-3">
                          <div className="flex flex-col gap-1">
                            <button
                              className="p-1.5 rounded border border-slate-200 hover:bg-slate-100 text-slate-500"
                              onClick={() => moveColumn(idx, "up")}
                              title="Move up"
                              type="button"
                            >
                              <ArrowUp className="w-3 h-3" />
                            </button>
                            <button
                              className="p-1.5 rounded border border-slate-200 hover:bg-slate-100 text-slate-500"
                              onClick={() => moveColumn(idx, "down")}
                              title="Move down"
                              type="button"
                            >
                              <ArrowDown className="w-3 h-3" />
                            </button>
                          </div>
                        </td>
                        <td className="py-3 pl-4 pr-3">
                          <input
                            value={col.label}
                            onChange={(e) => updateColumn(idx, { label: e.target.value }, true)}
                            placeholder="Label"
                            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                          />
                        </td>
                        <td className="py-3 pr-3">
                          <input
                            value={col.key}
                            onChange={(e) => updateColumn(idx, { key: e.target.value })}
                            placeholder="db_key"
                            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono"
                          />
                        </td>
                        <td className="py-3 pr-3">
                          <select
                            value={col.type}
                            onChange={(e) => updateColumn(idx, { type: e.target.value as any })}
                            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                          >
                            {FIELD_TYPES.map((t) => (
                              <option key={t.value} value={t.value}>
                                {t.label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="py-3 pr-3">
                          <div className="flex flex-wrap gap-2">
                            <label className="flex items-center text-[11px] text-slate-600">
                              <input
                                type="checkbox"
                                className="mr-1.5"
                                checked={col.searchable ?? false}
                                onChange={(e) => updateColumn(idx, { searchable: e.target.checked })}
                              />
                              Search
                            </label>
                            <label className="flex items-center text-[11px] text-slate-600">
                              <input
                                type="checkbox"
                                className="mr-1.5"
                                checked={col.required ?? false}
                                onChange={(e) => updateColumn(idx, { required: e.target.checked })}
                              />
                              Required
                            </label>
                            <label className="flex items-center text-[11px] text-slate-600">
                              <input
                                type="checkbox"
                                className="mr-1.5"
                                checked={col.visible ?? true}
                                onChange={(e) => updateColumn(idx, { visible: e.target.checked })}
                              />
                              Visible
                            </label>
                            <label className="flex items-center text-[11px] text-slate-600">
                              <input
                                type="checkbox"
                                className="mr-1.5"
                                checked={col.isPill ?? false}
                                onChange={(e) => updateColumn(idx, { isPill: e.target.checked })}
                              />
                              Pill
                            </label>
                          </div>
                        </td>
                        <td className="py-3 pr-4">
                          <button
                            onClick={() => removeColumn(idx)}
                            className="p-2 rounded-lg border border-slate-200 hover:bg-red-50 text-red-500"
                            title="Remove column"
                            type="button"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <button
                onClick={addColumn}
                className="inline-flex items-center px-4 py-2 bg-slate-900 text-white text-sm font-bold rounded-xl shadow hover:bg-slate-800"
                type="button"
              >
                <Plus className="w-4 h-4 mr-2" />
                Add Column
              </button>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-6 animate-in fade-in slide-in-from-right-8 duration-300">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="p-2 rounded-xl bg-slate-900 text-white">
                      <Lock className="w-4 h-4" />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-slate-900">Access Control</h3>
                      <p className="text-xs text-slate-500">Define who can see, write, and administer this library.</p>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div className="rounded-xl border border-slate-200 p-4">
                      <div className="text-xs font-bold text-slate-500 mb-2">Read Access</div>
                      <div className="flex items-center gap-2 mb-3">
                        <button
                          type="button"
                          onClick={() => setReadAccess("ALL")}
                          className={`px-3 py-2 rounded-lg text-xs font-bold border ${
                            readAccess === "ALL"
                              ? "bg-slate-900 text-white border-slate-900"
                              : "border-slate-200 text-slate-600 hover:bg-slate-50"
                          }`}
                        >
                          All Members
                        </button>
                        <button
                          type="button"
                          onClick={() => setReadAccess(readAccess === "ALL" ? [] : readAccess)}
                          className={`px-3 py-2 rounded-lg text-xs font-bold border ${
                            readAccess !== "ALL"
                              ? "bg-slate-900 text-white border-slate-900"
                              : "border-slate-200 text-slate-600 hover:bg-slate-50"
                          }`}
                        >
                          Restricted
                        </button>
                      </div>
                      {readAccess !== "ALL" && (
                        <RoleTreeSelector 
                          selected={readAccess as Role[]} 
                          onChange={(roles) => setReadAccess(roles)} 
                        />
                      )}
                    </div>

                    <div className="rounded-xl border border-slate-200 p-4">
                      <div className="text-xs font-bold text-slate-500 mb-2">Write Access</div>
                      <RoleTreeSelector 
                        selected={writeAccess} 
                        onChange={setWriteAccess} 
                      />
                    </div>

                    <div className="rounded-xl border border-slate-200 p-4">
                      <div className="text-xs font-bold text-slate-500 mb-2">Admin / Doc Control</div>
                      <RoleTreeSelector 
                        selected={adminAccess} 
                        onChange={setAdminAccess} 
                      />
                    </div>
                  </div>
                </div>

                <div className="space-y-6">
                  <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
                    <div className="flex items-center gap-3 mb-4">
                      <div className="p-2 rounded-xl bg-purple-600 text-white">
                        <FolderLock className="w-4 h-4" />
                      </div>
                      <div>
                        <h3 className="text-sm font-bold text-slate-900">Folder Security Mode</h3>
                        <p className="text-xs text-slate-500">Decide if subfolders inherit or manage their own ACL.</p>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 gap-3">
                      {[
                        { key: "Inherited", label: "Inherited", desc: "Folder permissions inherit from library." },
                        { key: "Granular", label: "Granular", desc: "Each folder can override ACL rules." },
                      ].map((mode) => (
                        <button
                          key={mode.key}
                          type="button"
                          onClick={() => setFolderSecurity(mode.key as any)}
                          className={`p-4 rounded-xl border text-left ${
                            folderSecurity === mode.key
                              ? "border-purple-500 bg-purple-50"
                              : "border-slate-200 hover:bg-slate-50"
                          }`}
                        >
                          <div className="text-sm font-bold text-slate-900">{mode.label}</div>
                          <div className="text-xs text-slate-500 mt-1">{mode.desc}</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
                    <div className="flex items-center gap-3 mb-4">
                      <div className="p-2 rounded-xl bg-slate-900 text-white">
                        <EyeOff className="w-4 h-4" />
                      </div>
                      <div>
                        <h3 className="text-sm font-bold text-slate-900">Default Node Visibility</h3>
                        <p className="text-xs text-slate-500">Choose how new folders/documents start out.</p>
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {["normal", "hidden", "private"].map((v) => (
                        <button
                          key={v}
                          type="button"
                          onClick={() => setDefaultVisibility(v as any)}
                          className={`px-3 py-2 rounded-lg text-xs font-bold border ${
                            defaultVisibility === v
                              ? "bg-slate-900 text-white border-slate-900"
                              : "border-slate-200 text-slate-600 hover:bg-slate-50"
                          }`}
                        >
                          {v}
                        </button>
                      ))}
                    </div>
                  </div>

                  {blockedRoles.length > 0 && (
                    <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 text-xs text-amber-700">
                      <div className="font-bold mb-2 flex items-center">
                        <EyeOff className="w-4 h-4 mr-2" /> Ghost Mode Impact
                      </div>
                      These roles will not see this library at all:
                      <div className="mt-2 flex flex-wrap gap-2">
                        {blockedRoles.map((r) => (
                          <span
                            key={r}
                            className="px-2 py-1 rounded-lg bg-white border border-amber-200 text-amber-700 font-bold"
                          >
                            {r}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="px-8 py-5 bg-slate-50 border-t border-slate-200 flex justify-between items-center">
          <button onClick={onClose} className="text-sm font-bold text-slate-600 hover:text-slate-800">
            Cancel
          </button>
          <div className="flex items-center space-x-3">
            {step > 1 && (
              <button
                onClick={handleBack}
                className="px-5 py-2.5 text-sm font-bold text-slate-600 bg-white border border-slate-200 rounded-xl hover:bg-slate-100"
                type="button"
              >
                Back
              </button>
            )}
            {step < 3 ? (
              <button
                onClick={handleNext}
                className="px-6 py-2.5 text-sm font-bold text-white bg-slate-900 rounded-xl shadow hover:bg-slate-800 flex items-center"
                type="button"
              >
                Next <ArrowRight className="w-4 h-4 ml-2" />
              </button>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={isLoading}
                className="px-6 py-2.5 text-sm font-bold text-white bg-orange-600 rounded-xl shadow hover:bg-orange-700 flex items-center disabled:opacity-60"
                type="button"
              >
                {isLoading ? (
                  <Save className="w-4 h-4 mr-2 animate-pulse" />
                ) : (
                  <Save className="w-4 h-4 mr-2" />
                )}
                Save Library
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
