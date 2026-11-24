"use client";

// /admin/scope: the operational scope tree.
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
import { Plus, ChevronRight, Archive, Pencil } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import {
  getScopeTree, createPlant, createUnit, createSystem,
  updatePlant, updateUnit, updateSystem,
  archivePlant, archiveUnit, archiveSystem,
  type ScopeNode,
} from "@/lib/operationalGraph";
import type { Plant, Unit, PlantSystem } from "@/types/schema";
import DuplicateAwareInput from "@/components/ui/DuplicateAwareInput";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, heroPrimary } from "@/components/ui/PageHero";
import { tbl, sheet, label, link, btnIcon, btnLink, Problem } from "@/components/admin/kit";
import { said } from "@/components/admin/said";
import { SkeletonRows } from "@/components/ui/Skeleton";
import MoreMenu from "@/components/ui/MoreMenu";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { plural } from "@/components/admin/band";
import { Button } from "@/components/ui/Button";
import { Field, Input, Textarea } from "@/components/ui/Field";
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
      setError(said(e, "Couldn't load the scope tree."));
    }
    finally { setLoading(false); }
  }, [activeOrgId, showArchived]);

  // Every write says when it didn't work, in place.
  const attempt = async (what: string, run: () => Promise<unknown>): Promise<boolean> => {
    setError(null);
    try { await run(); return true; }
    catch (e) {
      setError(said(e, `Couldn't ${what}.`));
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
    if (!(await appConfirm({ message: `Archive this ${kind}? Documents and equipment that point at it keep their data; it stops showing up in pickers. Show archived brings it back into view.`, tone: "danger", confirmLabel: "Archive" }))) return;
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
        <PageHero kicker="Admin · Operational scope" title="Operational scope" sub="Pick a workspace first, from your profile." />
      </PageShell>
    );
  }

  const unitTotal = tree.reduce((n, p) => n + p.units.length, 0);
  const systemTotal = tree.reduce((n, t) => n + t.units.reduce((m, u) => m + u.systems.length, 0), 0);
  const answer = loading && tree.length === 0 ? "Operational scope"
    : tree.length === 0 ? "No plants yet."
    : `${plural(tree.length, "plant")} in scope.`;

  return (
    <PageShell width="work">
      <PageHero
        kicker="Admin · Operational scope"
        title={answer}
        sub={canEdit ? "Plants, units and systems that documents and equipment can belong to." : "Read only. Admin, Manager, Supervisor and Doc Control change the scope."}
        factsHero="none"
        facts={tree.length > 0 ? [
          { label: "Units", value: unitTotal },
          { label: "Systems", value: systemTotal },
        ] : undefined}
        tools={
          <label className="inline-flex items-center gap-2 h-10 pointer-coarse:h-11 px-1 text-body text-[var(--color-text-muted)] cursor-pointer">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="w-4 h-4" />
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

      {/* The tree: plants, their units 16 px in, their systems 16 px more. */}
      {loading && tree.length === 0 ? (
        <SkeletonRows rows={4} cols={1} what="the scope tree" />
      ) : tree.length === 0 ? (
        addingChildOf?.kind !== "root" && (
          <div className={`${sheet} py-8 px-5 text-center`}>
            <p className="text-reading text-[var(--color-text)]">Plants hold units (crude, FCC), units hold systems (overhead). Then a search like &ldquo;all P&amp;IDs in the FCC&rdquo; works.</p>
            {canEdit && <button type="button" onClick={() => setAddingChildOf({ kind: "root" })} className={`${link} mt-1.5 font-medium`}>Add the first plant</button>}
          </div>
        )
      ) : (
        <div role="tree" aria-label="Plants, units and systems" onKeyDown={onScopeKeys} className={`${tbl.wrap} divide-y divide-[var(--color-border)]`}>
          <div className="max-sm:hidden flex items-center gap-2 px-3 h-10 bg-[var(--color-surface-2)] text-body font-medium text-[var(--color-text-muted)]">
            <span className="flex-1 pl-9">Name</span><span className="w-28 text-right">Contains</span>{canEdit && <span className="w-12" />}
          </div>
          {tree.map(({ plant, units }) => {
            const plantOpen = expandedPlants.has(plant.id!);
            return (
              <div key={plant.id}>
                <ScopeRow
                  open={plantOpen}
                  onToggle={() => setExpandedPlants((s) => {
                    const next = new Set(s);
                    if (next.has(plant.id!)) next.delete(plant.id!); else next.add(plant.id!);
                    return next;
                  })}
                  name={plant.name}
                  code={plant.code}
                  badge={{ n: units.length, one: "unit", many: "units" }}
                  archived={!!plant.archived}
                  canEdit={canEdit}
                  onAdd={() => setAddingChildOf({ kind: "plant", parentId: plant.id })}
                  addLabel="Add a unit"
                  onEdit={() => setEditing({ kind: "plant", row: plant })}
                  onArchive={() => onArchive("plant", plant.id!)}
                />

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

                {plantOpen && (
                  <div role="group" className="ml-4 border-l border-[var(--color-border)]">
                    {units.length === 0 ? (
                      <div className="text-body text-[var(--color-text-muted)] pl-4 py-2.5 border-t border-[var(--color-border)]">No units in this plant yet.</div>
                    ) : (
                      units.map(({ unit, systems }) => {
                        const unitOpen = expandedUnits.has(unit.id!);
                        return (
                          <div key={unit.id} className="border-t border-[var(--color-border)]">
                            <ScopeRow
                              level={1}
                              open={unitOpen}
                              onToggle={() => setExpandedUnits((s) => {
                                const next = new Set(s);
                                if (next.has(unit.id!)) next.delete(unit.id!); else next.add(unit.id!);
                                return next;
                              })}
                              name={unit.name}
                              code={unit.code}
                              badge={{ n: systems.length, one: "system", many: "systems" }}
                              archived={!!unit.archived}
                              canEdit={canEdit}
                              onAdd={() => setAddingChildOf({ kind: "unit", parentId: unit.id })}
                              addLabel="Add a system"
                              onEdit={() => setEditing({ kind: "unit", row: unit })}
                              onArchive={() => onArchive("unit", unit.id!)}
                            />

                            {addingChildOf?.kind === "unit" && addingChildOf.parentId === unit.id && (
                              <div className="px-4 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)]">
                                <NewScopeRowForm
                                  title={`New system in ${unit.name}`}
                                  fields={["name", "code", "description"]}
                                  onCancel={() => setAddingChildOf(null)}
                                  onSave={(values) => onAddSystem(unit.id!, plant.id!, values as { name: string; code: string; description: string })}
                                  codeCheck={{ table: "systems", scope: { unit_id: unit.id! } }}
                                />
                              </div>
                            )}

                            {unitOpen && (
                              <div role="group" className="ml-4 border-l border-[var(--color-border)]">
                                {systems.length === 0 && <div className="text-body text-[var(--color-text-muted)] pl-4 py-2.5 border-t border-[var(--color-border)]">No systems in this unit yet.</div>}
                                {systems.map((sys) => (
                                  <div key={sys.id} className="border-t border-[var(--color-border)]">
                                    <ScopeRow
                                      level={2}
                                      name={sys.name}
                                      code={sys.code}
                                      archived={!!sys.archived}
                                      canEdit={canEdit}
                                      onEdit={() => setEditing({ kind: "system", row: sys })}
                                      onArchive={() => onArchive("system", sys.id!)}
                                    />
                                  </div>
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

// Arrow keys through the tree: Up/Down move between rows, Right opens a
// row (or steps in), Left closes it.
function onScopeKeys(e: React.KeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft"].includes(e.key)) return;
  const t = e.target as HTMLElement;
  if (t.closest("input, textarea, select, form")) return;
  const row = t.closest<HTMLElement>("[data-tree-row]");
  if (!row) return;
  const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-tree-row]"));
  const i = rows.indexOf(row);
  const toggle = row.querySelector<HTMLButtonElement>("button[aria-expanded]");
  const focusRow = (r?: HTMLElement) => { if (r) { e.preventDefault(); r.focus(); } };
  if (e.key === "ArrowDown") focusRow(rows[i + 1]);
  else if (e.key === "ArrowUp") focusRow(rows[i - 1]);
  else if (e.key === "ArrowRight" && toggle) { e.preventDefault(); if (toggle.getAttribute("aria-expanded") === "false") toggle.click(); else focusRow(rows[i + 1]); }
  else if (e.key === "ArrowLeft" && toggle && toggle.getAttribute("aria-expanded") === "true") { e.preventDefault(); toggle.click(); }
}

// ─── One row ────────────────────────────────────────────────────

function ScopeRow({
  name, code, badge, archived, level = 0,
  open, onToggle, canEdit, onAdd, addLabel, onEdit, onArchive,
}: {
  name: string; code: string | null | undefined;
  badge?: { n: number; one: string; many: string }; archived?: boolean; level?: number;
  open?: boolean; onToggle?: () => void;
  canEdit?: boolean;
  onAdd?: () => void; addLabel?: string;
  onEdit?: () => void; onArchive?: () => void;
}) {
  return (
    <div role="treeitem" aria-selected={false} aria-level={level + 1} aria-expanded={onToggle ? !!open : undefined} tabIndex={level === 0 ? 0 : -1} data-tree-row
      className={`flex items-center gap-2 pl-2 pr-3 min-h-11 hover:bg-[var(--color-surface-2)] focus:bg-[var(--color-surface-2)] transition-colors ${archived ? "opacity-60" : ""}`}>
      {onToggle ? (
        <button type="button" tabIndex={-1} onClick={onToggle} aria-expanded={open} aria-label={open ? `Close ${name}` : `Open ${name}`}
          className="w-7 h-7 pointer-coarse:w-9 pointer-coarse:h-9 grid place-items-center rounded-md shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)]">
          <ChevronRight aria-hidden className={`ui-chevron w-4 h-4 ${open ? "rotate-90" : ""}`} />
        </button>
      ) : <span className="w-7 shrink-0" />}
      <div className="flex-1 min-w-0 py-1.5">
        <div className="flex items-center gap-2 min-w-0">
          {code && <span className="ui-tag shrink-0">{code}</span>}
          <span className={`${level === 0 ? "font-medium" : ""} text-reading text-[var(--color-text)] sm:truncate break-words min-w-0`}>{name}</span>
          {archived && <span className="text-body text-[var(--color-text-muted)] shrink-0">Archived</span>}
        </div>
        {badge && <div className="sm:hidden text-body text-[var(--color-text-muted)] tabular-nums">{plural(badge.n, badge.one, badge.many)}</div>}
      </div>
      {badge && (
        <span className={`max-sm:hidden w-28 text-right shrink-0 text-body tabular-nums ${badge.n === 0 ? "text-[var(--color-text-faint)]" : "text-[var(--color-text-muted)]"}`}>
          {plural(badge.n, badge.one, badge.many)}
        </span>
      )}
      {canEdit && (
        <div className="w-12 flex justify-end shrink-0">
          <MoreMenu iconOnly label={`More for ${name}`} triggerClass={btnIcon} items={[
            ...(onAdd && addLabel ? [{ icon: <Plus className="w-4 h-4" />, label: addLabel, onClick: onAdd }] : []),
            ...(onEdit ? [{ icon: <Pencil className="w-4 h-4" />, label: "Rename or edit", onClick: onEdit }] : []),
            ...(onArchive && !archived ? [{ icon: <Archive className="w-4 h-4" />, label: "Archive", tone: "bad" as const, line: true, onClick: onArchive }] : []),
          ]} />
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
  /** When present, the `code` field checks for a duplicate as it's typed
   *  (code uniqueness is partial-unique in the database). */
  codeCheck?: { table: "plants" | "units" | "systems"; scope: Record<string, string> };
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [codeConflict, setCodeConflict] = useState(false);
  const WORD: Record<string, string> = { name: "Name", code: "Code", description: "Description", location: "Location" };

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
      <div className="text-reading font-medium text-[var(--color-text)]">{title}</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {fields.map((f) => (
          <label key={f} className="block">
            <span className={label}>{WORD[f]}{f === "name" ? "" : <span className="font-normal text-[var(--color-text-muted)]"> (optional)</span>}</span>
            {f === "code" && codeCheck ? (
              <DuplicateAwareInput
                value={values[f] ?? ""}
                onChange={(v) => setValues((vs) => ({ ...vs, [f]: v }))}
                onDuplicateChange={(isDup) => setCodeConflict(isDup)}
                check={{ table: codeCheck.table, column: "code", scope: codeCheck.scope }}
                fieldLabel="code"
                placeholder="FCC"
              />
            ) : (
              <Input value={values[f] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))}
                placeholder={f === "name" ? "Bakersfield refinery" : f === "location" ? "Bakersfield, CA" : ""} autoFocus={f === "name"} />
            )}
          </label>
        ))}
      </div>
      <div className="flex items-center justify-end gap-3 pt-1">
        <button type="button" onClick={onCancel} className={btnLink}>Cancel</button>
        <Button type="submit" variant="secondary" loading={submitting} disabled={!values.name?.trim() || codeConflict}>Save</Button>
      </div>
    </form>
  );
}

// ─── Edit dialog ────────────────────────────────────────────────

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

  const kindLabel = target.kind === "plant" ? "plant" : target.kind === "unit" ? "unit" : "system";

  return (
    <Modal onClose={onCancel} size="sm" dismissable={!submitting}>
      <ModalHeader title={`Edit the ${kindLabel}`} subtitle={row.name} onClose={submitting ? undefined : onCancel} />
      <form onSubmit={onSubmit}>
        <ModalBody className="space-y-3">
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
          <Field label="Code"><Input value={code} onChange={(e) => setCode(e.target.value)} /></Field>
          <Field label="Description"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} /></Field>
        </ModalBody>
        <ModalFooter>
          {!name.trim() && <span className="mr-auto text-body text-[var(--color-text-muted)]">Give it a name.</span>}
          <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>Cancel</Button>
          <Button type="submit" loading={submitting} disabled={!name.trim()}>Save</Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
