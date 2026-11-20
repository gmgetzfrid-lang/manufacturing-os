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
  Factory, Layers, Cpu, Save, X,
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
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, heroPrimary, heroQuiet } from "@/components/ui/PageHero";
import { tbl, sheet, field, btnIcon, btnQuiet, StatusTag, Problem } from "@/components/admin/kit";
import LoadingBlock from "@/components/ui/LoadingBlock";
import { plural } from "@/components/admin/band";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Field";
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
      setError(`Couldn't load the scope tree. ${f.heading}: ${f.message}`);
    }
    finally { setLoading(false); }
  }, [activeOrgId, showArchived]);

  // Every write says when it didn't work, in place.
  const attempt = async (what: string, run: () => Promise<unknown>): Promise<boolean> => {
    setError(null);
    try { await run(); return true; }
    catch (e) {
      const f = translatePostgresError(e, { entity: "scope row" });
      setError(`Couldn't ${what}. ${f.heading}: ${f.message}`);
      return false;
    }
  };

  useEffect(() => { void refresh(); }, [refresh]);

  // ─── Mutations ─────────────────────────────────────────────
  const onAddPlant = async (input: { name: string; code: string; description: string; location: string }) => {
    if (!activeOrgId || !uid) return;
    if (!(await attempt("add the plant", () => createPlant({ orgId: activeOrgId, createdBy: uid, ...input })))) return;
    setAddingChildOf(null);
    await refresh();
  };
  const onAddUnit = async (plantId: string, input: { name: string; code: string; description: string }) => {
    if (!activeOrgId || !uid) return;
    if (!(await attempt("add the unit", () => createUnit({ orgId: activeOrgId, plantId, createdBy: uid, ...input })))) return;
    setAddingChildOf(null);
    setExpandedPlants((s) => new Set(s).add(plantId));
    await refresh();
  };
  const onAddSystem = async (unitId: string, plantId: string, input: { name: string; code: string; description: string }) => {
    if (!activeOrgId || !uid) return;
    if (!(await attempt("add the system", () => createSystem({ orgId: activeOrgId, unitId, plantId, createdBy: uid, ...input })))) return;
    setAddingChildOf(null);
    setExpandedUnits((s) => new Set(s).add(unitId));
    await refresh();
  };

  const onSaveEdit = async (patch: { name: string; code: string; description: string }) => {
    if (!editing || !uid) return;
    const ok = await attempt("save the change", async () => {
      if (editing.kind === "plant")  await updatePlant(editing.row.id!,  patch, uid);
      if (editing.kind === "unit")   await updateUnit(editing.row.id!,   patch, uid);
      if (editing.kind === "system") await updateSystem(editing.row.id!, patch, uid);
    });
    if (!ok) throw new Error("not saved");
    setEditing(null);
    await refresh();
  };

  const onArchive = async (kind: "plant" | "unit" | "system", id: string) => {
    if (!uid) return;
    if (!(await appConfirm({ message: "Archive this scope node? Documents and equipment that reference it keep their data; the row is hidden from picker UIs.", tone: "danger" }))) return;
    const ok = await attempt("archive it", async () => {
      if (kind === "plant")  await archivePlant(id, uid);
      if (kind === "unit")   await archiveUnit(id, uid);
      if (kind === "system") await archiveSystem(id, uid);
    });
    if (ok) await refresh();
  };

  // ─── Render ─────────────────────────────────────────────────

  if (!activeOrgId) {
    return (
      <PageShell width="work">
        <PageHero kicker="Admin · Operational scope" title="Operational scope" sub="No active organization." overlap={false} />
      </PageShell>
    );
  }

  const unitTotal = tree.reduce((n, p) => n + p.units.length, 0);
  const answer = loading ? "Operational scope"
    : tree.length === 0 ? "No scope defined yet."
    : `${plural(tree.length, "plant")} in scope.`;

  return (
    <PageShell width="work">
      <PageHero
        kicker="Admin · Operational scope"
        title={answer}
        sub={canEdit ? "Plants, units and systems that documents and equipment can belong to." : "Read only: Admin, Manager, Supervisor or DocCtrl edit the scope."}
        facts={tree.length > 0 ? [
          { label: "Units", value: unitTotal },
          { label: "Systems", value: tree.reduce((n, t) => n + t.units.reduce((m, u) => m + u.systems.length, 0), 0) },
        ] : undefined}
        tools={
          <label className={`${heroQuiet} cursor-pointer`}>
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              className="w-4 h-4 accent-[var(--color-text)]"
            />
            Show archived
          </label>
        }
        primary={canEdit && addingChildOf === null ? (
          <button type="button" className={heroPrimary} onClick={() => setAddingChildOf({ kind: "root" })}>
            <Plus className="w-4 h-4" /> Add plant
          </button>
        ) : undefined}
      />

      <PageBody>
      {error && <Problem>{error}</Problem>}

      {/* New-plant inline form */}
      {addingChildOf?.kind === "root" && (
        <NewScopeRowForm
          title="New plant"
          fields={["name", "code", "description", "location"]}
          onCancel={() => setAddingChildOf(null)}
          onSave={(values) => onAddPlant(values as { name: string; code: string; description: string; location: string })}
          codeCheck={{ table: "plants", scope: { org_id: activeOrgId! } }}
        />
      )}

      {/* Tree */}
      {loading ? (
        <LoadingBlock what="the scope tree" />
      ) : tree.length === 0 ? (
        <div className={`${sheet} py-10 px-5 text-center`}>
          <div className="font-display text-[19px] font-semibold text-[var(--color-text)]">Start with one plant</div>
          <p className="mt-1 text-[15px] text-[var(--color-text-muted)] max-w-lg mx-auto">
            Plants hold units (crude, FCC), units hold systems (overhead). Then a search like &ldquo;all P&amp;IDs in the FCC&rdquo; just works.
          </p>
        </div>
      ) : (
        <div className={`${tbl.wrap} divide-y divide-[var(--color-border)]`}>
          <div className="max-sm:hidden flex items-center gap-2 px-3 h-10 bg-[var(--color-surface-2)] text-[13px] font-semibold text-[var(--color-text-muted)]">
            <span className="flex-1 pl-14">Name</span><span className="w-24 text-right">Holds</span>{canEdit && <span className="w-[120px]" />}
          </div>
          {tree.map(({ plant, units }) => {
            const plantOpen = expandedPlants.has(plant.id!);
            return (
              <div key={plant.id}>
                {/* Plant row */}
                <ScopeRow
                  icon={<Factory className="w-4 h-4 text-[var(--color-text-muted)]" />}
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
                  addLabel="Add unit"
                  onEdit={() => setEditing({ kind: "plant", row: plant })}
                  onArchive={() => onArchive("plant", plant.id!)}
                />

                {/* Add-unit inline form */}
                {addingChildOf?.kind === "plant" && addingChildOf.parentId === plant.id && (
                  <div className="px-4 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)]">
                    <NewScopeRowForm
                      title={`New unit in ${plant.name}`}
                      fields={["name", "code", "description"]}
                      onCancel={() => setAddingChildOf(null)}
                      onSave={(values) => onAddUnit(plant.id!, values as { name: string; code: string; description: string })}
                      codeCheck={{ table: "units", scope: { plant_id: plant.id! } }}
                    />
                  </div>
                )}

                {/* Units */}
                {plantOpen && (
                  <div className="border-t border-[var(--color-border)]">
                    {units.length === 0 ? (
                      <div className="text-[14px] text-[var(--color-text-muted)] pl-16 py-3">No units in this plant.</div>
                    ) : (
                      units.map(({ unit, systems }) => {
                        const unitOpen = expandedUnits.has(unit.id!);
                        return (
                          <div key={unit.id} className="border-t border-[var(--color-border)] first:border-t-0">
                            <ScopeRow
                              indent={1}
                              icon={<Layers className="w-4 h-4 text-[var(--color-text-muted)]" />}
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
                              addLabel="Add system"
                              onEdit={() => setEditing({ kind: "unit", row: unit })}
                              onArchive={() => onArchive("unit", unit.id!)}
                            />

                            {addingChildOf?.kind === "unit" && addingChildOf.parentId === unit.id && (
                              <div className="px-4 py-3 ml-6 bg-[var(--color-surface-2)] border-t border-[var(--color-border)]">
                                <NewScopeRowForm
                                  title={`New system in ${unit.name}`}
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
                                    icon={<Cpu className="w-4 h-4 text-[var(--color-text-muted)]" />}
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
      </PageBody>

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
      className={`flex items-center gap-2 px-3 py-2 hover:bg-[var(--color-surface-2)] transition-colors ${archived ? "opacity-60" : ""}`}
      style={{ paddingLeft: 12 + indent * 28 }}
    >
      {onToggle ? (
        <button type="button" onClick={onToggle} aria-expanded={open} aria-label={open ? `Collapse ${name}` : `Expand ${name}`} className={btnIcon}>
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
      ) : <div className="w-8" />}
      <div className="shrink-0">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {code && <span className="font-display text-[16px] font-semibold tabular-nums text-[var(--color-text)] shrink-0">{code}</span>}
          <span className={`${indent === 0 ? "font-semibold" : ""} text-[15px] text-[var(--color-text)] truncate`}>{name}</span>
          {archived && <StatusTag tone="none">Archived</StatusTag>}
        </div>
      </div>
      {badge && <span className="w-24 text-right text-[14px] text-[var(--color-text-muted)] shrink-0 tabular-nums">{badge}</span>}
      {canEdit && (
        <div className="flex items-center justify-end gap-1 shrink-0 w-[120px]">
          {onAdd && addLabel && (
            <button type="button" onClick={onAdd} title={addLabel} aria-label={`${addLabel} to ${name}`} className={btnIcon}>
              <Plus className="w-4 h-4" />
            </button>
          )}
          {onEdit && (
            <button type="button" onClick={onEdit} title="Edit" aria-label={`Edit ${name}`} className={btnIcon}>
              <Pencil className="w-4 h-4" />
            </button>
          )}
          {onArchive && !archived && (
            <button type="button" onClick={onArchive} title="Archive" aria-label={`Archive ${name}`} className={`${btnIcon} hover:text-[var(--state-overdue)]`}>
              <Archive className="w-4 h-4" />
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
    catch { /* the page shows why it wasn't saved */ }
    finally { setSubmitting(false); }
  };

  return (
    <form onSubmit={onSubmit} className={`${sheet} p-4 space-y-3`}>
      <div className="font-display text-[17px] font-semibold text-[var(--color-text)]">{title}</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
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
              />
            );
          }
          return (
            <input
              key={f}
              placeholder={f === "name" ? "Name (required)" : f[0].toUpperCase() + f.slice(1)}
              value={values[f] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))}
              aria-label={f === "name" ? "Name" : f[0].toUpperCase() + f.slice(1)}
              className={field}
            />
          );
        })}
      </div>
      <div className="flex items-center justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className={btnQuiet}>Cancel</button>
        <button type="submit" className={btnQuiet} disabled={!values.name?.trim() || submitting || codeConflict}>
          {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save
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
    catch { /* the page shows why it wasn't saved */ }
    finally { setSubmitting(false); }
  };

  React.useEffect(() => {
    if (submitting) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [submitting, onCancel]);

  const kindLabel = target.kind === "plant" ? "Plant" : target.kind === "unit" ? "Unit" : "System";

  return (
    <div role="dialog" aria-modal="true" aria-label={`Edit ${kindLabel.toLowerCase()}`} className="fixed inset-0 z-[200] bg-[var(--color-ink)]/60 animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <form onSubmit={onSubmit} className="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] shadow-2xl w-full max-w-md p-5 space-y-3 animate-in fade-in zoom-in-95">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-[19px] font-semibold text-[var(--color-text)]">Edit {kindLabel.toLowerCase()}</h2>
          <button type="button" onClick={onCancel} aria-label="Close" className={btnIcon}><X className="w-4 h-4" /></button>
        </div>
        <div className="space-y-2">
          <Field label="Name (required)"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Code"><Input value={code} onChange={(e) => setCode(e.target.value)} /></Field>
          <Field label="Description"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} /></Field>
        </div>
        <div className="flex items-center justify-end gap-2 pt-2">
          <button type="button" onClick={onCancel} className={btnQuiet}>Cancel</button>
          <Button type="submit" disabled={!name.trim() || submitting}>
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
          </Button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[13px] font-semibold text-[var(--color-text-muted)]">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
