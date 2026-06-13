"use client";

// /admin/scope — Operational scope tree manager.
//
// Renders the Plant → Unit → System hierarchy as an expandable tree.
// Admin-class roles (Admin, Manager, Supervisor, DocCtrl) can add,
// rename, and archive scope rows; everyone else sees a read-only
// browse view.
//
// Visual design choice: indented tree, not three side-by-side
// columns. Refineries typically have 3–10 plants, 5–50 units per
// plant, 3–30 systems per unit. A tree fits that shape; column
// layouts force the eye to track three independent lists.

import React, { useCallback, useEffect, useState } from "react";
import {
  Loader2, Plus, ChevronRight, ChevronDown, Archive, Pencil,
  Factory, Layers, Cpu, AlertTriangle, Lock, Save, X,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import {
  getScopeTree, createPlant, createUnit, createSystem,
  updatePlant, updateUnit, updateSystem,
  archivePlant, archiveUnit, archiveSystem,
  type ScopeNode,
} from "@/lib/operationalGraph";
import type { Plant, Unit, PlantSystem } from "@/types/schema";
import DuplicateAwareInput from "@/components/ui/DuplicateAwareInput";
import { translatePostgresError } from "@/lib/inputValidation";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { appConfirm } from "@/components/providers/DialogProvider";

const ADMIN_ROLES = new Set(["Admin", "Manager", "Supervisor", "DocCtrl"]);

type EditTarget =
  | { kind: "plant"; row: Plant }
  | { kind: "unit"; row: Unit }
  | { kind: "system"; row: PlantSystem }
  | null;

export default function ScopePage() {
  const { activeOrgId, activeRole, uid } = useRole();
  const canEdit = !!activeRole && ADMIN_ROLES.has(activeRole);

  const [tree, setTree] = useState<ScopeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const [expandedPlants, setExpandedPlants] = useState<Set<string>>(new Set());
  const [expandedUnits, setExpandedUnits] = useState<Set<string>>(new Set());
  const [addingChildOf, setAddingChildOf] = useState<{ kind: "root" | "plant" | "unit"; parentId?: string } | null>(null);
  const [editing, setEditing] = useState<EditTarget>(null);

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    setLoading(true);
    setError(null);
    try {
      const t = await getScopeTree(activeOrgId, { includeArchived: showArchived });
      setTree(t);
    } catch (e) {
      const f = translatePostgresError(e, { entity: "scope row" });
      setError(`${f.heading} — ${f.message}`);
    }
    finally { setLoading(false); }
  }, [activeOrgId, showArchived]);

  useEffect(() => { void refresh(); }, [refresh]);

  // ─── Mutations ─────────────────────────────────────────────
  const onAddPlant = async (input: { name: string; code: string; description: string; location: string }) => {
    if (!activeOrgId || !uid) return;
    await createPlant({ orgId: activeOrgId, createdBy: uid, ...input });
    setAddingChildOf(null);
    await refresh();
  };
  const onAddUnit = async (plantId: string, input: { name: string; code: string; description: string }) => {
    if (!activeOrgId || !uid) return;
    await createUnit({ orgId: activeOrgId, plantId, createdBy: uid, ...input });
    setAddingChildOf(null);
    setExpandedPlants((s) => new Set(s).add(plantId));
    await refresh();
  };
  const onAddSystem = async (unitId: string, plantId: string, input: { name: string; code: string; description: string }) => {
    if (!activeOrgId || !uid) return;
    await createSystem({ orgId: activeOrgId, unitId, plantId, createdBy: uid, ...input });
    setAddingChildOf(null);
    setExpandedUnits((s) => new Set(s).add(unitId));
    await refresh();
  };

  const onSaveEdit = async (patch: { name: string; code: string; description: string }) => {
    if (!editing || !uid) return;
    if (editing.kind === "plant")  await updatePlant(editing.row.id!,  patch, uid);
    if (editing.kind === "unit")   await updateUnit(editing.row.id!,   patch, uid);
    if (editing.kind === "system") await updateSystem(editing.row.id!, patch, uid);
    setEditing(null);
    await refresh();
  };

  const onArchive = async (kind: "plant" | "unit" | "system", id: string) => {
    if (!uid) return;
    if (!(await appConfirm({ message: "Archive this scope node? Documents and equipment that reference it keep their data; the row is hidden from picker UIs.", tone: "danger" }))) return;
    if (kind === "plant")  await archivePlant(id, uid);
    if (kind === "unit")   await archiveUnit(id, uid);
    if (kind === "system") await archiveSystem(id, uid);
    await refresh();
  };

  // ─── Render ─────────────────────────────────────────────────

  if (!activeOrgId) {
    return <div className="p-6 text-sm text-[var(--color-text-muted)]">No active organization.</div>;
  }

  return (
    <PageShell width="form" className="space-y-4">
      {/* Header */}
      <PageHeaderBar
        icon={Factory}
        title="Operational Scope"
        subtitle="Plants, units, and systems used to scope documents and equipment. Existing records continue to work with no scope assigned — attaching scope is per-document and per-asset."
        actions={
          <div className="flex items-center gap-2 text-xs">
            <label className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />
              Show archived
            </label>
            {canEdit && (
              <Button size="sm" onClick={() => setAddingChildOf({ kind: "root" })}>
                <Plus className="w-3.5 h-3.5" /> Add Plant
              </Button>
            )}
          </div>
        }
      />

      {!canEdit && (
        <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          <Lock className="w-3.5 h-3.5" />
          Read-only — scope editing requires Admin, Manager, Supervisor, or DocCtrl.
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5" /> {error}
        </div>
      )}

      {/* New-plant inline form */}
      {addingChildOf?.kind === "root" && (
        <NewScopeRowForm
          title="New Plant"
          fields={["name", "code", "description", "location"]}
          onCancel={() => setAddingChildOf(null)}
          onSave={(values) => onAddPlant(values as { name: string; code: string; description: string; location: string })}
          codeCheck={{ table: "plants", scope: { org_id: activeOrgId! } }}
        />
      )}

      {/* Tree */}
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)] py-8 justify-center">
          <Spinner size="xs" /> Loading scope tree…
        </div>
      ) : tree.length === 0 ? (
        <div className="text-sm text-[var(--color-text-muted)] py-12 text-center border border-dashed border-[var(--color-border-strong)] rounded-xl px-6 space-y-2">
          <div className="font-bold text-[var(--color-text)]">No operational scope defined yet.</div>
          <div className="text-xs text-[var(--color-text-muted)] max-w-md mx-auto">
            Define your <b>plants</b> (sites), <b>units</b> (process units inside each plant), and <b>systems</b> (logical sub-groups like &ldquo;Overhead System&rdquo;).
            Documents and equipment can then be scoped to this tree so searches like &ldquo;all P&IDs in the FCC&rdquo; just work.
            {canEdit && " Click 'Add Plant' to start."}
          </div>
        </div>
      ) : (
        <div className="space-y-1">
          {tree.map(({ plant, units }) => {
            const plantOpen = expandedPlants.has(plant.id!);
            return (
              <div key={plant.id} className="border border-[var(--color-border)] rounded-xl bg-[var(--color-surface)] overflow-hidden">
                {/* Plant row */}
                <ScopeRow
                  icon={<Factory className="w-4 h-4 text-blue-600" />}
                  open={plantOpen}
                  onToggle={() => setExpandedPlants((s) => {
                    const next = new Set(s);
                    if (next.has(plant.id!)) next.delete(plant.id!); else next.add(plant.id!);
                    return next;
                  })}
                  name={plant.name}
                  code={plant.code}
                  badge={`${units.length} unit${units.length === 1 ? "" : "s"}`}
                  archived={!!plant.archived}
                  canEdit={canEdit}
                  onAdd={() => setAddingChildOf({ kind: "plant", parentId: plant.id })}
                  addLabel="Add Unit"
                  onEdit={() => setEditing({ kind: "plant", row: plant })}
                  onArchive={() => onArchive("plant", plant.id!)}
                />

                {/* Add-unit inline form */}
                {addingChildOf?.kind === "plant" && addingChildOf.parentId === plant.id && (
                  <div className="px-4 py-3 bg-blue-50/40 border-t border-blue-100">
                    <NewScopeRowForm
                      title={`New Unit in ${plant.name}`}
                      fields={["name", "code", "description"]}
                      onCancel={() => setAddingChildOf(null)}
                      onSave={(values) => onAddUnit(plant.id!, values as { name: string; code: string; description: string })}
                      codeCheck={{ table: "units", scope: { plant_id: plant.id! } }}
                    />
                  </div>
                )}

                {/* Units */}
                {plantOpen && (
                  <div className="border-t border-[var(--color-border)] bg-slate-50/40">
                    {units.length === 0 ? (
                      <div className="text-xs text-[var(--color-text-muted)] px-4 py-3">No units in this plant.</div>
                    ) : (
                      units.map(({ unit, systems }) => {
                        const unitOpen = expandedUnits.has(unit.id!);
                        return (
                          <div key={unit.id} className="border-t border-[var(--color-border)] first:border-t-0">
                            <ScopeRow
                              indent={1}
                              icon={<Layers className="w-4 h-4 text-purple-600" />}
                              open={unitOpen}
                              onToggle={() => setExpandedUnits((s) => {
                                const next = new Set(s);
                                if (next.has(unit.id!)) next.delete(unit.id!); else next.add(unit.id!);
                                return next;
                              })}
                              name={unit.name}
                              code={unit.code}
                              badge={`${systems.length} system${systems.length === 1 ? "" : "s"}`}
                              archived={!!unit.archived}
                              canEdit={canEdit}
                              onAdd={() => setAddingChildOf({ kind: "unit", parentId: unit.id })}
                              addLabel="Add System"
                              onEdit={() => setEditing({ kind: "unit", row: unit })}
                              onArchive={() => onArchive("unit", unit.id!)}
                            />

                            {addingChildOf?.kind === "unit" && addingChildOf.parentId === unit.id && (
                              <div className="px-4 py-3 ml-6 bg-purple-50/40 border-t border-purple-100">
                                <NewScopeRowForm
                                  title={`New System in ${unit.name}`}
                                  fields={["name", "code", "description"]}
                                  onCancel={() => setAddingChildOf(null)}
                                  onSave={(values) => onAddSystem(unit.id!, plant.id!, values as { name: string; code: string; description: string })}
                                  codeCheck={{ table: "systems", scope: { unit_id: unit.id! } }}
                                />
                              </div>
                            )}

                            {unitOpen && systems.length > 0 && (
                              <div>
                                {systems.map((sys) => (
                                  <ScopeRow
                                    key={sys.id}
                                    indent={2}
                                    icon={<Cpu className="w-4 h-4 text-emerald-600" />}
                                    name={sys.name}
                                    code={sys.code}
                                    archived={!!sys.archived}
                                    canEdit={canEdit}
                                    onEdit={() => setEditing({ kind: "system", row: sys })}
                                    onArchive={() => onArchive("system", sys.id!)}
                                  />
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Edit modal */}
      {editing && (
        <EditScopeRowModal
          target={editing}
          onCancel={() => setEditing(null)}
          onSave={onSaveEdit}
        />
      )}
    </PageShell>
  );
}

// ─── Row component ──────────────────────────────────────────────

function ScopeRow({
  icon, name, code, badge, archived, indent = 0,
  open, onToggle, canEdit, onAdd, addLabel, onEdit, onArchive,
}: {
  icon: React.ReactNode; name: string; code: string | null | undefined;
  badge?: string; archived?: boolean; indent?: number;
  open?: boolean; onToggle?: () => void;
  canEdit?: boolean;
  onAdd?: () => void; addLabel?: string;
  onEdit?: () => void; onArchive?: () => void;
}) {
  return (
    <div
      className={`flex items-center gap-2 px-3 py-2.5 hover:bg-slate-100/50 transition-colors ${archived ? "opacity-50" : ""}`}
      style={{ paddingLeft: 12 + indent * 24 }}
    >
      {onToggle ? (
        <button onClick={onToggle} className="p-0.5 hover:bg-slate-200 rounded transition-colors">
          {open ? <ChevronDown className="w-3.5 h-3.5 text-[var(--color-text-muted)]" /> : <ChevronRight className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />}
        </button>
      ) : <div className="w-4" />}
      <div className="shrink-0">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-[var(--color-text)] truncate">{name}</span>
          {code && <span className="text-[10px] font-mono text-[var(--color-text-muted)] bg-[var(--color-surface-2)] px-1.5 py-0.5 rounded">{code}</span>}
          {archived && <span className="text-[10px] font-bold text-[var(--color-text-muted)] bg-slate-200 px-1.5 py-0.5 rounded uppercase">Archived</span>}
        </div>
      </div>
      {badge && <span className="text-[10px] text-[var(--color-text-muted)] font-mono shrink-0">{badge}</span>}
      {canEdit && (
        <div className="flex items-center gap-1 shrink-0">
          {onAdd && addLabel && (
            <button onClick={onAdd} title={addLabel} className="p-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] transition-colors">
              <Plus className="w-3.5 h-3.5" />
            </button>
          )}
          {onEdit && (
            <button onClick={onEdit} title="Edit" className="p-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] transition-colors">
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
          {onArchive && !archived && (
            <button onClick={onArchive} title="Archive" className="p-1.5 rounded text-[var(--color-text-muted)] hover:text-red-600 hover:bg-red-50 transition-colors">
              <Archive className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── New-row inline form ────────────────────────────────────────

function NewScopeRowForm({
  title, fields, onCancel, onSave, codeCheck,
}: {
  title: string;
  fields: Array<"name" | "code" | "description" | "location">;
  onCancel: () => void;
  onSave: (values: Record<string, string>) => void | Promise<void>;
  /** When present, the `code` field becomes a DuplicateAwareInput
   *  scoped to the given table + scope. Code uniqueness is partial-
   *  unique in the DB; pre-flighting prevents the 23505 conflict. */
  codeCheck?: { table: "plants" | "units" | "systems"; scope: Record<string, string> };
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [codeConflict, setCodeConflict] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!values.name?.trim()) return;
    if (codeConflict) return;
    setSubmitting(true);
    try { await onSave(values); }
    finally { setSubmitting(false); }
  };

  return (
    <form onSubmit={onSubmit} className="bg-[var(--color-surface)] border border-blue-200 rounded-lg p-3 space-y-2">
      <div className="text-[11px] font-bold text-[var(--color-text)] uppercase tracking-wider">{title}</div>
      <div className="grid grid-cols-2 gap-2">
        {fields.map((f) => {
          if (f === "code" && codeCheck) {
            return (
              <DuplicateAwareInput
                key={f}
                value={values[f] ?? ""}
                onChange={(v) => setValues((vs) => ({ ...vs, [f]: v }))}
                onDuplicateChange={(isDup) => setCodeConflict(isDup)}
                check={{ table: codeCheck.table, column: "code", scope: codeCheck.scope }}
                fieldLabel="code"
                placeholder="Code (optional)"
                className="text-xs"
              />
            );
          }
          return (
            <input
              key={f}
              placeholder={f === "name" ? "Name (required)" : f[0].toUpperCase() + f.slice(1)}
              value={values[f] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))}
              className="text-xs border border-[var(--color-border-strong)] rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          );
        })}
      </div>
      <div className="flex items-center justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className="text-xs px-2 py-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">Cancel</button>
        <Button
          type="submit"
          size="sm"
          disabled={!values.name?.trim() || submitting || codeConflict}
        >
          {submitting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} Save
        </Button>
      </div>
    </form>
  );
}

// ─── Edit modal ─────────────────────────────────────────────────

function EditScopeRowModal({
  target, onCancel, onSave,
}: {
  target: NonNullable<EditTarget>;
  onCancel: () => void;
  onSave: (patch: { name: string; code: string; description: string }) => void | Promise<void>;
}) {
  const row = target.row;
  const [name, setName] = useState(row.name);
  const [code, setCode] = useState(row.code ?? "");
  const [description, setDescription] = useState(row.description ?? "");
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    try { await onSave({ name: name.trim(), code: code.trim(), description: description.trim() }); }
    finally { setSubmitting(false); }
  };

  const kindLabel = target.kind === "plant" ? "Plant" : target.kind === "unit" ? "Unit" : "System";

  return (
    <div className="fixed inset-0 z-[200] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <form onSubmit={onSubmit} className="bg-[var(--color-surface)] rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-3 animate-in fade-in zoom-in-95">
        <div className="flex items-center justify-between">
          <h2 className="font-black text-[var(--color-text)]">Edit {kindLabel}</h2>
          <button type="button" onClick={onCancel} className="p-1 rounded hover:bg-[var(--color-surface-2)] transition-colors"><X className="w-4 h-4" /></button>
        </div>
        <div className="space-y-2">
          <Field label="Name (required)"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Code"><Input value={code} onChange={(e) => setCode(e.target.value)} className="font-mono" /></Field>
          <Field label="Description"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} /></Field>
        </div>
        <div className="flex items-center justify-end gap-2 pt-2">
          <button type="button" onClick={onCancel} className="text-sm px-3 py-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">Cancel</button>
          <Button type="submit" disabled={!name.trim() || submitting}>
            {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save
          </Button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
