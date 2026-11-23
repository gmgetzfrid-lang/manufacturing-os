"use client";

// New library / edit library: four steps by topic (what it is, the fields
// each document carries, who can see and change it, then a review), with
// each step checked before the next and the typed name and description
// kept on this device until the library is made.

import React, { useState, useEffect } from "react";
import { ArrowLeft, Check, ChevronDown, ChevronUp, Plus, Trash2, X } from "lucide-react";
import type { AccessRule, LibraryConfig, LibraryType, MetadataFieldDefinition, Role } from "@/types/schema";
import { ALL_ROLES } from "@/types/schema";
import StepPath from "@/components/ui/StepPath";
import { useDraft } from "@/hooks/useDraft";
import { Modal, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select, Textarea, FieldError } from "@/components/ui/Field";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { btnIcon, btnLink } from "@/components/admin/kit";

/** Where a new library's description is kept while it's being written. */
export const newLibraryDraftKey = (orgId: string) => `new-library:${orgId}`;
/** Where a new library's name is kept while it's being written. */
export const newLibraryNameDraftKey = (orgId: string) => `new-library:${orgId}:name`;

interface LibraryWizardProps {
  orgId: string;
  isOpen: boolean;
  onClose: () => void;
  onSave: (config: Omit<LibraryConfig, "id">) => Promise<void>;
  isLoading: boolean;
  initialData?: LibraryConfig | null;
}

const LIBRARY_TYPES: Array<{ type: LibraryType; label: string; example: string; desc: string }> = [
  { type: "Engineering", label: "Engineering and drawings", example: "P&IDs, CAD drawings, schematics", desc: "Strict revision tracking (Rev A, B, 0, 1)." },
  { type: "Procedure", label: "Procedures and policies", example: "SOPs, safety procedures, work instructions", desc: "Periodic review cycles and training records." },
  { type: "Business", label: "Business documents", example: "HR, finance, legal, contracts", desc: "Department-level access to internal documents." },
  { type: "UserSpace", label: "Personal workspaces", example: "Work files, drafts, personal folders", desc: "A private space for each person, with optional shared folders." },
];

const FIELD_TYPES: Array<{ value: MetadataFieldDefinition["type"]; label: string }> = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "boolean", label: "Yes or no" },
  { value: "select", label: "Pick from a list" },
  { value: "user", label: "Person" },
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
    { key: "document_number", label: "Document number", type: "text", searchable: true, required: true, visible: true },
    { key: "rev", label: "Revision", type: "text", searchable: true, required: true, visible: true },
    { key: "title", label: "Title", type: "text", searchable: true, required: true, visible: true },
    { key: "status", label: "Status", type: "text", searchable: true, required: false, visible: true },
  ];
}

/** Roles as chips you tick: a picked one shows a check and a darker edge. */
function RolePicker({ selected, onChange, label }: { selected: Role[]; onChange: (roles: Role[]) => void; label: string }) {
  const toggle = (role: Role) => {
    if (selected.includes(role)) onChange(selected.filter((r) => r !== role));
    else onChange([...selected, role]);
  };
  return (
    <div className="space-y-3" role="group" aria-label={label}>
      {ROLE_GROUPS.map((group) => (
        <div key={group.title}>
          <p className="text-[13px] text-[var(--color-text-muted)] mb-1.5">{group.title}</p>
          <div className="flex flex-wrap gap-1.5">
            {group.roles.map((role) => {
              const active = selected.includes(role);
              return (
                <button key={role} type="button" role="checkbox" aria-checked={active} onClick={() => toggle(role)}
                  className={`inline-flex items-center gap-1 h-8 pointer-coarse:h-10 px-2.5 rounded-md text-[13px] font-semibold border transition-colors ${
                    active
                      ? "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-text)]"
                      : "bg-[var(--color-surface)] border-[var(--color-border-strong)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-border-control)]"
                  }`}>
                  {active && <Check aria-hidden className="w-3.5 h-3.5" />}
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

/** A choice as a card you pick: a ring marks the picked one. */
function ChoiceCard({ on, onPick, title, children }: { on: boolean; onPick: () => void; title: string; children?: React.ReactNode }) {
  return (
    <button type="button" role="radio" aria-checked={on} onClick={onPick}
      className={`text-left p-3.5 rounded-xl border transition-colors bg-[var(--color-surface)] ${on ? "border-[var(--color-text)] ring-1 ring-[var(--color-text)]" : "border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)]"}`}>
      <span className="flex items-center gap-2.5">
        <span aria-hidden className={`w-4 h-4 rounded-full border-2 grid place-items-center shrink-0 ${on ? "border-[var(--color-text)]" : "border-[var(--color-border-control)]"}`}>
          {on && <span className="w-2 h-2 rounded-full bg-[var(--color-text)]" />}
        </span>
        <span className="text-[15px] font-semibold text-[var(--color-text)]">{title}</span>
      </span>
      {children && <span className="block mt-1 pl-[26px] text-[13px] text-[var(--color-text-muted)] leading-snug">{children}</span>}
    </button>
  );
}

const STEPS = ["What it is", "Document fields", "Who can use it", "Review"];

export default function LibraryWizard({ orgId, isOpen, onClose, onSave, isLoading, initialData }: LibraryWizardProps) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [error, setError] = useState<string | null>(null);
  const [nameTouched, setNameTouched] = useState(false);

  // Step 1
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<LibraryType>("Engineering");

  // Step 2: every field (the standard four pre-set, plus custom)
  const [columns, setColumns] = useState<MetadataFieldDefinition[]>([]);

  // Step 3: permissions, in plain words
  const [viewAccess, setViewAccess] = useState<"all" | "restricted">("all");
  const [viewRoles, setViewRoles] = useState<Role[]>([]);
  const [uploadRoles, setUploadRoles] = useState<Role[]>(["DocCtrl", "Admin", "Engineer-1", "Engineer-2"]);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    // Seed the form when the dialog opens. Wrapped in an IIFE so these resets
    // aren't read as cascading setState-in-effect; they still run synchronously.
    void (async () => {
      setStep(1);
      setError(null);
      setNameTouched(false);

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

  // A new library's name and description autosave on this device (not when editing).
  useDraft<string>(isOpen && !initialData ? newLibraryDraftKey(orgId) : null, description, setDescription, (v) => !v.trim());
  useDraft<string>(isOpen && !initialData ? newLibraryNameDraftKey(orgId) : null, name, setName, (v) => !v.trim());

  // What stops each step, said where it happens.
  const nameError = !name.trim() ? "Give the library a name, like Bakersfield P&IDs." : null;
  const fieldError = columns.some((f) => !f.label.trim()) ? "Each field needs a name. Fill it in or remove the field." : null;
  const viewError = viewAccess === "restricted" && viewRoles.length === 0 ? "Pick at least one role that can see it, or choose Everyone." : null;
  const stepError = step === 1 ? nameError : step === 2 ? fieldError : step === 3 ? viewError : null;

  const go = (to: 1 | 2 | 3 | 4) => { setError(null); setStep(to); };
  const handleNext = () => {
    setError(null);
    if (step === 1) setNameTouched(true);
    if (stepError) { setError(stepError); return; }
    if (step < 4) setStep((s) => (s + 1) as 1 | 2 | 3 | 4);
  };

  const handleSubmit = async () => {
    setError(null);
    const blocking = nameError ?? fieldError ?? viewError;
    if (blocking) { setError(blocking); return; }

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

  const typeLabel = LIBRARY_TYPES.find((t) => t.type === type)?.label ?? type;
  const writers = Array.from(new Set([...uploadRoles, "Admin", "DocCtrl"]));

  return (
    <Modal onClose={onClose} size="xl" zIndex={50} dismissable={!isLoading}>
      {/* Header: where you are in the flow. */}
      <div className="px-5 sm:px-6 pt-4 pb-4 border-b border-[var(--color-border)] shrink-0">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-[var(--color-text-muted)]">Admin · Libraries</div>
            <h2 className="font-display text-[20px] leading-tight font-semibold text-[var(--color-text)] truncate">
              {initialData ? `Edit ${initialData.name || "library"}` : "New library"}
            </h2>
          </div>
          <button type="button" onClick={onClose} disabled={isLoading} aria-label="Close" title="Close" className={`-mr-2 ${btnIcon}`}>
            <X className="w-5 h-5" />
          </button>
        </div>
        <StepPath className="mt-4" steps={STEPS} current={step - 1} onPick={(i) => go((i + 1) as 1 | 2 | 3 | 4)} />
      </div>

      <ModalBody className="flex-1 sm:px-6 py-5">
        {/* STEP 1: what it is */}
        {step === 1 && (
          <div className="space-y-6">
            <Field label="Library name" error={nameTouched && nameError ? nameError : undefined}>
              <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setNameTouched(true)}
                placeholder="Bakersfield P&IDs" autoFocus />
            </Field>
            <Field label={<>What it&apos;s for <span className="font-normal text-[var(--color-text-muted)]">(optional)</span></>}>
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2}
                placeholder="What's kept here and who uses it" />
            </Field>
            <div>
              <span className="block text-[14px] font-semibold text-[var(--color-text)] mb-2">What kind of documents</span>
              <div role="radiogroup" aria-label="What kind of documents" className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {LIBRARY_TYPES.map((t) => (
                  <ChoiceCard key={t.type} on={type === t.type} onPick={() => setType(t.type)} title={t.label}>
                    {t.desc} <span className="text-[var(--color-text-faint)]">{t.example}.</span>
                  </ChoiceCard>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* STEP 2: the fields each document carries */}
        {step === 2 && (
          <div className="space-y-3">
            <p className="text-[14px] text-[var(--color-text-muted)] inline-flex items-center gap-1.5">
              Each field is a column in the document list.
              <HelpTooltip>Rename, reorder or add fields. The first four are set for you but can be changed. Required fields must be filled before a document is saved; searchable ones are found by search; hidden ones are kept but not shown as a column.</HelpTooltip>
            </p>
            <ul className="space-y-2">
              {columns.map((f, i) => (
                <li key={i} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                  <div className="flex items-center gap-2">
                    <div className="flex flex-col shrink-0">
                      <button type="button" onClick={() => moveField(i, "up")} disabled={i === 0} aria-label={`Move ${f.label || "this field"} up`}
                        className="w-7 h-5 pointer-coarse:h-7 grid place-items-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-25"><ChevronUp className="w-3.5 h-3.5" /></button>
                      <button type="button" onClick={() => moveField(i, "down")} disabled={i === columns.length - 1} aria-label={`Move ${f.label || "this field"} down`}
                        className="w-7 h-5 pointer-coarse:h-7 grid place-items-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-25"><ChevronDown className="w-3.5 h-3.5" /></button>
                    </div>
                    <Input value={f.label} aria-label="Field name" aria-invalid={!f.label.trim() && !!error ? true : undefined}
                      onChange={(e) => updateField(i, { label: e.target.value, key: f.key || toKey(e.target.value) })}
                      placeholder="Field name, like Project code" className="flex-1 min-w-0" />
                    <Select value={f.type} aria-label="Kind of field" onChange={(e) => updateField(i, { type: e.target.value as MetadataFieldDefinition["type"] })} className="w-40 shrink-0 max-sm:hidden">
                      {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </Select>
                    <button type="button" onClick={() => removeField(i)} aria-label={`Remove ${f.label || "this field"}`} title="Remove the field"
                      className={`${btnIcon} hover:!text-[var(--state-overdue-text)] shrink-0`}><Trash2 className="w-4 h-4" /></button>
                  </div>
                  <div className="mt-2 pl-9 flex flex-wrap items-center gap-x-4 gap-y-2">
                    <Select value={f.type} aria-label="Kind of field" onChange={(e) => updateField(i, { type: e.target.value as MetadataFieldDefinition["type"] })} className="w-full sm:hidden">
                      {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </Select>
                    {([["required", "Required", false], ["searchable", "Searchable", true], ["visible", "Shown as a column", true]] as const).map(([k, word, dflt]) => (
                      <label key={k} className="inline-flex items-center gap-1.5 text-[14px] text-[var(--color-text)] cursor-pointer min-h-8 pointer-coarse:min-h-11">
                        <input type="checkbox" className="w-4 h-4" checked={f[k] ?? dflt} onChange={(e) => updateField(i, { [k]: e.target.checked })} />
                        {word}
                      </label>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
            <button type="button" onClick={addField}
              className="w-full flex items-center justify-center gap-2 h-11 rounded-xl border border-dashed border-[var(--color-border-strong)] text-[14px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors">
              <Plus className="w-4 h-4" /> Add a field
            </button>
          </div>
        )}

        {/* STEP 3: who can see it, who can change it */}
        {step === 3 && (
          <div className="space-y-7">
            <section>
              <h3 className="text-[16px] font-semibold text-[var(--color-text)]">Who can see documents here?</h3>
              <p className="text-[13px] text-[var(--color-text-muted)] mb-3">Read and download.</p>
              <div role="radiogroup" aria-label="Who can see documents" className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <ChoiceCard on={viewAccess === "all"} onPick={() => setViewAccess("all")} title="Everyone">Everyone in the workspace</ChoiceCard>
                <ChoiceCard on={viewAccess === "restricted"} onPick={() => setViewAccess("restricted")} title="Only some roles">Pick them below</ChoiceCard>
              </div>
              {viewAccess === "restricted" && (
                <div className="mt-4">
                  <RolePicker label="Roles that can see documents" selected={viewRoles} onChange={setViewRoles} />
                  {error && viewError && <FieldError>{viewError}</FieldError>}
                </div>
              )}
            </section>

            <section>
              <h3 className="text-[16px] font-semibold text-[var(--color-text)] inline-flex items-center gap-1.5">
                Who can upload and edit?
                <HelpTooltip>These roles can upload new files, edit the fields, and make new revisions.</HelpTooltip>
              </h3>
              <p className="text-[13px] text-[var(--color-text-muted)] mb-3">Admin and Doc Control always can.</p>
              <RolePicker label="Roles that can upload and edit" selected={uploadRoles} onChange={setUploadRoles} />
            </section>

            <div>
              <button type="button" onClick={() => setShowAdvanced((v) => !v)} aria-expanded={showAdvanced}
                className="inline-flex items-center gap-1.5 text-[14px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                <ChevronDown aria-hidden className={`ui-chevron w-4 h-4 ${showAdvanced ? "rotate-180" : ""}`} />
                Folders and new documents
              </button>
              {showAdvanced && (
                <div className="mt-2 rounded-xl border border-[var(--color-border)] p-4 space-y-2 text-[14px] text-[var(--color-text-muted)]">
                  <p><span className="font-semibold text-[var(--color-text)]">Folders</span> follow the library&rsquo;s settings. A folder can have its own after the library is made.</p>
                  <p><span className="font-semibold text-[var(--color-text)]">New documents</span> can be seen by anyone who can see the library.</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* STEP 4: review before anything is saved */}
        {step === 4 && (
          <dl className="rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
            {([
              ["Name", <><span className="font-semibold">{name.trim()}</span>{description.trim() && <span className="block text-[var(--color-text-muted)]">{description.trim()}</span>}</>, 1],
              ["Kind", typeLabel, 1],
              ["Fields", columns.map((c) => c.label || "Unnamed").join(", "), 2],
              ["Who can see", viewAccess === "all" ? "Everyone in the workspace" : viewRoles.join(", "), 3],
              ["Who can upload and edit", writers.join(", "), 3],
            ] as const).map(([k, v, s]) => (
              <div key={k} className="grid grid-cols-1 sm:grid-cols-[180px_1fr_auto] gap-x-4 gap-y-0.5 px-4 py-3 items-start">
                <dt className="text-[14px] text-[var(--color-text-muted)]">{k}</dt>
                <dd className="text-[15px] text-[var(--color-text)] min-w-0 break-words">{v}</dd>
                <dd><button type="button" onClick={() => go(s as 1 | 2 | 3 | 4)} className={btnLink} aria-label={`Change ${k.toLowerCase()}`}>Change</button></dd>
              </div>
            ))}
          </dl>
        )}

        {error && !(step === 3 && viewError) && !(step === 1 && nameTouched && nameError) && (
          <p role="alert" className="mt-4 text-[14px] font-semibold text-[var(--state-overdue-text)]">{error}</p>
        )}
      </ModalBody>

      <ModalFooter className="justify-between">
        <button type="button" onClick={step === 1 ? onClose : () => go((step - 1) as 1 | 2 | 3 | 4)} disabled={isLoading} className={`${btnLink} !text-[var(--color-text-muted)] hover:!text-[var(--color-text)]`}>
          {step === 1 ? "Cancel" : <><ArrowLeft aria-hidden className="w-4 h-4" /> Back</>}
        </button>
        <div className="flex items-center gap-3 min-w-0">
          {step < 4 ? (
            <Button onClick={handleNext}>Next</Button>
          ) : (
            <Button onClick={() => void handleSubmit()} loading={isLoading}>
              {initialData ? "Save library" : "Make the library"}
            </Button>
          )}
        </div>
      </ModalFooter>
    </Modal>
  );
}
