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
    } catch (e) { setError((e as Error).message); }
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
    if (!confirm("Archive this scope node? Documents and equipment that reference it keep their data; the row is hidden from picker UIs.")) return;
    if (kind === "plant")  await archivePlant(id, uid);
    if (kind === "unit")   await archiveUnit(id, uid);
    if (kind === "system") await archiveSystem(id, uid);
    await refresh();
  };

  // ─── Render ─────────────────────────────────────────────────

  if (!activeOrgId) {
    return <div className="p-6 text-sm text-slate-500">No active organization.</div>;
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-black text-slate-900 flex items-center gap-2">
            <Factory className="w-5 h-5 text-blue-600" /> Operational Scope
          </h1>
          <p className="text-xs text-slate-500 mt-1 max-w-xl">
            Plants, units, and systems used to scope documents and equipment.
            Existing records continue to work with no scope assigned —
            attaching scope is per-document and per-asset.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <label className="flex items-center gap-1.5 text-slate-600">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived
          </label>
          {canEdit && (
            <button
              onClick={() => setAddingChildOf({ kind: "root" })}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-blue-600 text-white rounded-md font-bold hover:bg-blue-700"
            ><Plus className="w-3.5 h-3.5" /> Add Plant</button>
          )}
        </div>
      </div>

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
        />
      )}

      {/* Tree */}
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-slate-500 py-8 justify-center">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading scope tree…
        </div>
      ) : tree.length === 0 ? (
        <div className="text-sm text-slate-500 py-12 text-center border border-dashed border-slate-300 rounded-xl">
          No plants yet.{canEdit && " Click 'Add Plant' to start."}
        </div>
      ) : (
        <div className="space-y-1">
          {tree.map(({ plant, units }) => {
            const plantOpen = expandedPlants.has(plant.id!);
            return (
              <div key={plant.id} className="border border-slate-200 rounded-xl bg-white overflow-hidden">
                {/* Plant row */}
                <ScopeRow
                  icon={<Factory className="w-4 h-4 text-blue-600" />}
                  open={plantOpen}
                  onToggle={() => setExpandedPlants((s) => {
                    const next = new Set(s); next.has(plant.id!) ? next.delete(plant.id!) : next.add(plant.id!); return next;
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
                    />
                  </div>
                )}

                {/* Units */}
                {plantOpen && (
                  <div className="border-t border-slate-200 bg-slate-50/40">
                    {units.length === 0 ? (
                      <div className="text-xs text-slate-500 px-4 py-3">No units in this plant.</div>
                    ) : (
                      units.map(({ unit, systems }) => {
                        const unitOpen = expandedUnits.has(unit.id!);
                        return (
                          <div key={unit.id} className="border-t border-slate-200 first:border-t-0">
                            <ScopeRow
                              indent={1}
                              icon={<Layers className="w-4 h-4 text-purple-600" />}
                              open={unitOpen}
                              onToggle={() => setExpandedUnits((s) => {
                                const next = new Set(s); next.has(unit.id!) ? next.delete(unit.id!) : next.add(unit.id!); return next;
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
    </div>
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
      className={`flex items-center gap-2 px-3 py-2.5 hover:bg-slate-100/50 ${archived ? "opacity-50" : ""}`}
      style={{ paddingLeft: 12 + indent * 24 }}
    >
      {onToggle ? (
        <button onClick={onToggle} className="p-0.5 hover:bg-slate-200 rounded">
          {open ? <ChevronDown className="w-3.5 h-3.5 text-slate-500" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-500" />}
        </button>
      ) : <div className="w-4" />}
      <div className="shrink-0">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-slate-800 truncate">{name}</span>
          {code && <span className="text-[10px] font-mono text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">{code}</span>}
          {archived && <span className="text-[10px] font-bold text-slate-500 bg-slate-200 px-1.5 py-0.5 rounded uppercase">Archived</span>}
        </div>
      </div>
      {badge && <span className="text-[10px] text-slate-500 font-mono shrink-0">{badge}</span>}
      {canEdit && (
        <div className="flex items-center gap-1 shrink-0">
          {onAdd && addLabel && (
            <button onClick={onAdd} title={addLabel} className="p-1.5 rounded text-slate-500 hover:text-blue-600 hover:bg-blue-50">
              <Plus className="w-3.5 h-3.5" />
            </button>
          )}
          {onEdit && (
            <button onClick={onEdit} title="Edit" className="p-1.5 rounded text-slate-500 hover:text-orange-600 hover:bg-orange-50">
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
          {onArchive && !archived && (
            <button onClick={onArchive} title="Archive" className="p-1.5 rounded text-slate-500 hover:text-red-600 hover:bg-red-50">
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
  title, fields, onCancel, onSave,
}: {
  title: string;
  fields: Array<"name" | "code" | "description" | "location">;
  onCancel: () => void;
  onSave: (values: Record<string, string>) => void | Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!values.name?.trim()) return;
    setSubmitting(true);
    try { await onSave(values); }
    finally { setSubmitting(false); }
  };

  return (
    <form onSubmit={onSubmit} className="bg-white border border-blue-200 rounded-lg p-3 space-y-2">
      <div className="text-[11px] font-bold text-slate-700 uppercase tracking-wider">{title}</div>
      <div className="grid grid-cols-2 gap-2">
        {fields.map((f) => (
          <input
            key={f}
            placeholder={f === "name" ? "Name (required)" : f[0].toUpperCase() + f.slice(1)}
            value={values[f] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))}
            className="text-xs border border-slate-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        ))}
      </div>
      <div className="flex items-center justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className="text-xs px-2 py-1 text-slate-600 hover:text-slate-900">Cancel</button>
        <button
          type="submit"
          disabled={!values.name?.trim() || submitting}
          className="inline-flex items-center gap-1 text-xs font-bold px-2.5 py-1 bg-blue-600 text-white rounded disabled:opacity-40 hover:bg-blue-700"
        >
          {submitting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} Save
        </button>
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
    <div className="fixed inset-0 z-[200] bg-slate-900/70 backdrop-blur-sm flex items-center justify-center p-4">
      <form onSubmit={onSubmit} className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-black text-slate-900">Edit {kindLabel}</h2>
          <button type="button" onClick={onCancel} className="p-1 rounded hover:bg-slate-100"><X className="w-4 h-4" /></button>
        </div>
        <div className="space-y-2">
          <Field label="Name (required)"><input value={name} onChange={(e) => setName(e.target.value)} className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-sm" /></Field>
          <Field label="Code"><input value={code} onChange={(e) => setCode(e.target.value)} className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-sm font-mono" /></Field>
          <Field label="Description"><textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-sm" /></Field>
        </div>
        <div className="flex items-center justify-end gap-2 pt-2">
          <button type="button" onClick={onCancel} className="text-sm px-3 py-1.5 text-slate-600 hover:text-slate-900">Cancel</button>
          <button
            type="submit"
            disabled={!name.trim() || submitting}
            className="inline-flex items-center gap-1.5 text-sm font-bold px-3 py-1.5 bg-blue-600 text-white rounded disabled:opacity-40 hover:bg-blue-700"
          >
            {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] font-bold text-slate-600 uppercase tracking-wider">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
