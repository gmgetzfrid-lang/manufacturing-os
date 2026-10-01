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
//
// ONE UNIT IDENTITY (GAP-305): each operational unit can be mapped to the
// Site Codebook unit it is (units.codebook_code — the mapping is data, one
// codebook unit per operational unit), and the "Unit identity" panel runs
// the decode that writes documents.unit_code from each drawing number and
// fills an empty assets.unit_id from the mapping (POST /api/admin/unit-
// identity; a value already there is never rewritten). Numbers that do not
// decode are listed, never guessed — a restricted document's number only to
// a controller (the rest are counted). Unit names in the mapping come from
// the codebook (DEC-35). The mapping itself is guarded in the database
// (20261138: only the scope writer tier sets units.codebook_code, and
// archiving a unit releases its code). Which codes are taken is read
// directly (listCodebookMappings), not from the tree on screen: archiving a
// PLANT does not archive its units, so a unit under an archived plant keeps
// its code while the default tree does not show it. The codebook's unit list
// (the picker, its labels and the "mapped" count) is read whole, in keyset
// pages (listCodebookUnits): loadCodebook is one request, which PostgREST
// cuts at 1,000 entries of every kind. Equipment follows the mapping in the
// database (20261138): mapping, remapping or archiving a unit moves its
// projected equipment at once, and a refiled item follows its filing.

import React, { useCallback, useEffect, useState } from "react";
import {
  Loader2, Plus, ChevronRight, ChevronDown, Archive, Pencil,
  Factory, Layers, Cpu, AlertTriangle, Lock, Save, X, Link2,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import {
  getScopeTree, createPlant, createUnit, createSystem,
  updatePlant, updateUnit, updateSystem,
  archivePlant, archiveUnit, archiveSystem,
  setUnitCodebookCode, runUnitIdentityBackfill, listCodebookMappings, listCodebookUnits,
  type ScopeNode, type UnitIdentityReport, type CodebookMappingHolder,
} from "@/lib/operationalGraph";
import { loadCodebook, EMPTY_CODEBOOK, type Codebook } from "@/lib/codebook";
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
  const { activeOrgId, roles, uid } = useRole();
  // ADD-1: authority by the role COLLECTION, never the headline alone.
  const canEdit = roles.some((r) => ADMIN_ROLES.has(r));

  const [tree, setTree] = useState<ScopeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const [expandedPlants, setExpandedPlants] = useState<Set<string>>(new Set());
  const [expandedUnits, setExpandedUnits] = useState<Set<string>>(new Set());
  const [addingChildOf, setAddingChildOf] = useState<{ kind: "root" | "plant" | "unit"; parentId?: string } | null>(null);
  const [editing, setEditing] = useState<EditTarget>(null);
  const [book, setBook] = useState<Codebook>(EMPTY_CODEBOOK);
  /** The codebook's unit list could not be read whole — said, never a short list presented as the codebook. */
  const [bookError, setBookError] = useState<string | null>(null);
  /** Every codebook code held by an operational unit, under any plant (null:
   *  the read failed — the tree on screen is the fallback, and says so). */
  const [holders, setHolders] = useState<CodebookMappingHolder[] | null>(null);
  const [holdersError, setHoldersError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeOrgId) return;
    let alive = true;
    // The unit entries are read whole (keyset pages) and replace the book's
    // unit list: loadCodebook's one request is cut at PostgREST's max-rows.
    Promise.all([
      loadCodebook(activeOrgId).catch(() => EMPTY_CODEBOOK),
      listCodebookUnits(activeOrgId).then(
        (units) => ({ units, error: null as string | null }),
        (e: unknown) => ({ units: null, error: (e as Error).message }),
      ),
    ]).then(([b, u]) => {
      if (!alive) return;
      setBook(u.units ? { ...b, units: u.units } : b);
      setBookError(u.error);
    });
    return () => { alive = false; };
  }, [activeOrgId]);

  // Codebook code → the operational unit that holds it (one each, 20261138).
  // Read directly from units, under ANY plant: an archived unit holds no code
  // (20261138's guard releases it), but archiving a PLANT does not archive
  // its units — a unit under an archived plant keeps its code and is not on
  // the default tree. The tree is only the fallback when that read fails.
  const mappedTo = React.useMemo(() => {
    const m = new Map<string, CodebookMappingHolder>();
    if (holders) {
      for (const h of holders) m.set(h.code, h);
      return m;
    }
    for (const { plant, units } of tree) {
      for (const u of units) {
        if (!u.codebookCode) continue;
        m.set(u.codebookCode, {
          code: u.codebookCode, unitId: u.unit.id!, unitName: u.unit.name, plantId: plant.id ?? null,
          plantName: plant.name, plantArchived: !!plant.archived,
        });
      }
    }
    return m;
  }, [holders, tree]);

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    setLoading(true);
    setError(null);
    try {
      const [t, h] = await Promise.all([
        getScopeTree(activeOrgId, { includeArchived: showArchived }),
        listCodebookMappings(activeOrgId).then(
          (rows) => ({ rows, error: null as string | null }),
          (e: unknown) => ({ rows: null, error: (e as Error).message }),
        ),
      ]);
      setTree(t);
      setHolders(h.rows);
      setHoldersError(h.error);
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

  const onMapUnit = async (unitId: string, code: string | null) => {
    if (!uid) return;
    setError(null);
    try {
      await setUnitCodebookCode(unitId, code, uid);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
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

      {holdersError && (
        <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5" /> The Site Codebook mapping could not be read in full ({holdersError}) — a code held by a unit under an archived plant may still be offered.
        </div>
      )}

      {bookError && (
        <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5" /> The Site Codebook&apos;s units could not be read in full ({bookError}) — the unit list below may be short, so a mapped code can read &quot;not in the codebook&quot;.
        </div>
      )}

      <UnitIdentityPanel orgId={activeOrgId} canEdit={canEdit} book={book} mappedTo={mappedTo} />

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
                      units.map(({ unit, systems, codebookCode }) => {
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
                              extra={
                                <UnitMapping
                                  current={codebookCode}
                                  book={book}
                                  takenBy={mappedTo}
                                  unitId={unit.id!}
                                  canEdit={canEdit && !unit.archived}
                                  onChange={(code) => onMapUnit(unit.id!, code)}
                                />
                              }
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
  icon, name, code, extra, badge, archived, indent = 0,
  open, onToggle, canEdit, onAdd, addLabel, onEdit, onArchive,
}: {
  icon: React.ReactNode; name: string; code: string | null | undefined;
  extra?: React.ReactNode;
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
          {extra}
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

// ─── Unit identity (GAP-305) ────────────────────────────────────

/** Which Site Codebook unit this operational unit IS. A codebook unit maps to
 *  at most one operational unit, so codes taken elsewhere are disabled and
 *  name the unit (and plant) that holds them. */
function UnitMapping({
  current, book, takenBy, unitId, canEdit, onChange,
}: {
  current: string | null; book: Codebook; takenBy: Map<string, CodebookMappingHolder>;
  unitId: string; canEdit: boolean; onChange: (code: string | null) => void;
}) {
  const entry = current ? book.units.find((u) => u.code === current) : null;
  if (!canEdit) {
    return (
      <span className="text-[10px] text-[var(--color-text-muted)] inline-flex items-center gap-1" title="The Site Codebook unit this operational unit is">
        <Link2 className="w-3 h-3" />
        {current ? `Site Codebook ${current}${entry ? ` · ${entry.label}` : " (not in the codebook)"}` : "Not mapped to the Site Codebook"}
      </span>
    );
  }
  return (
    <label className="inline-flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]" title="The Site Codebook unit this operational unit is">
      <Link2 className="w-3 h-3" />
      <select
        value={current ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="text-[10px] border border-[var(--color-border-strong)] rounded px-1 py-0.5 bg-[var(--color-surface)]"
        aria-label="Site Codebook unit"
      >
        <option value="">Not mapped</option>
        {current && !entry && <option value={current}>{current} (not in the codebook)</option>}
        {book.units.map((u) => {
          const holder = takenBy.get(u.code);
          const elsewhere = !!holder && holder.unitId !== unitId;
          return (
            <option key={u.code} value={u.code} disabled={elsewhere}>
              {u.code} · {u.label}{elsewhere ? ` (mapped to ${holder.unitName}${holder.plantName ? ` · ${holder.plantName}` : ""}${holder.plantArchived ? ", an archived plant" : ""})` : ""}
            </option>
          );
        })}
      </select>
    </label>
  );
}

/** The decode: drawing numbers → documents.unit_code, the mapping →
 *  assets.unit_id. Preview first (writes nothing), then apply. */
function UnitIdentityPanel({ orgId, canEdit, book, mappedTo }: {
  orgId: string; canEdit: boolean; book: Codebook; mappedTo: Map<string, CodebookMappingHolder>;
}) {
  const [busy, setBusy] = useState<null | "preview" | "apply">(null);
  const [report, setReport] = useState<UnitIdentityReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Counted over every holder, under any plant — not the tree on screen.
  const mapped = book.units.filter((u) => mappedTo.has(u.code)).length;
  const underArchivedPlant = [...mappedTo.values()].filter((h) => h.plantArchived).length;

  const run = async (dryRun: boolean) => {
    setBusy(dryRun ? "preview" : "apply");
    setErr(null);
    try {
      setReport(await runUnitIdentityBackfill(orgId, { dryRun }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const d = report?.documents;
  const a = report?.assets;
  return (
    <div className="border border-[var(--color-border)] rounded-xl bg-[var(--color-surface)] px-4 py-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <Link2 className="w-4 h-4 text-purple-600" />
        <span className="text-sm font-bold text-[var(--color-text)]">Unit identity</span>
        <span className="text-xs text-[var(--color-text-muted)]">
          {mapped} of {book.units.length} Site Codebook unit{book.units.length === 1 ? "" : "s"} mapped to an operational unit{underArchivedPlant > 0 ? ` (${underArchivedPlant} to a unit under an archived plant — shown with "Show archived")` : ""}.
        </span>
        {canEdit && (
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => run(true)}>
              {busy === "preview" ? <Loader2 className="w-3 h-3 animate-spin" /> : null} Preview the decode
            </Button>
            <Button size="sm" disabled={!!busy || !report} onClick={() => run(false)} title={report ? undefined : "Preview first"}>
              {busy === "apply" ? <Loader2 className="w-3 h-3 animate-spin" /> : null} Decode and write
            </Button>
          </div>
        )}
      </div>
      <div className="text-[11px] text-[var(--color-text-muted)]">
        Each drawing number is decoded with the Site Codebook and the unit it names is written to the document; equipment with no operational unit takes the one its codebook unit is mapped to (a unit already set by hand is never changed). Equipment follows the mapping on its own — mapping, remapping or archiving a unit, or refiling an item, moves its unit at once; the decode fills what was missed. A number that does not decode is listed here — never guessed.
      </div>
      {err && (
        <div className="flex items-center gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5" /> {err}
        </div>
      )}
      {report && d && a && (
        <div className="text-xs text-[var(--color-text)] space-y-1">
          <div className="font-bold">{report.dryRun ? "Preview — nothing written" : "Written"}</div>
          <div>
            Documents: {d.scanned} read · {d.decoded} decode to a codebook unit · {report.dryRun ? `${d.toWrite} to write` : `${d.written} written`}
            {d.toClear > 0 ? ` (${d.toClear} ${report.dryRun ? "to clear" : "planned to clear"} — no longer decode)` : ""}
            {(d.changed ?? 0) > 0 ? ` · ${d.changed} changed since they were read (left as they are)` : ""}
            {d.refused > 0 ? ` · ${d.refused} refused` : ""}
          </div>
          {d.notDecoding.count > 0 && (
            <details>
              <summary className="cursor-pointer">{d.notDecoding.count} number{d.notDecoding.count === 1 ? "" : "s"} do not decode</summary>
              <ul className="mt-1 ml-4 list-disc space-y-0.5">
                {d.notDecoding.samples.map((s) => (
                  <li key={s.number}><span className="font-mono">{s.number}</span> — {s.reason}</li>
                ))}
                {d.notDecoding.count - (d.notDecoding.unlisted ?? 0) > d.notDecoding.samples.length && (
                  <li>… and {d.notDecoding.count - (d.notDecoding.unlisted ?? 0) - d.notDecoding.samples.length} more</li>
                )}
                {(d.notDecoding.unlisted ?? 0) > 0 && (
                  <li>{d.notDecoding.unlisted} restricted number{d.notDecoding.unlisted === 1 ? "" : "s"} do not decode (not listed — a controller sees them)</li>
                )}
              </ul>
            </details>
          )}
          {d.unknownUnit.count > 0 && (
            <div>
              {d.unknownUnit.count} decode to a unit the codebook does not hold
              {d.unknownUnit.codes.length > 0 ? `: ${d.unknownUnit.codes.map((c) => `${c.code} (${c.count})`).join(", ")}` : ""}
              {(d.unknownUnit.unlisted ?? 0) > 0 ? ` (${d.unknownUnit.unlisted} restricted, not listed)` : ""}
            </div>
          )}
          {d.noUnitSegment > 0 && <div>{d.noUnitSegment} decode, but the number format has no unit segment.</div>}
          {d.noNumber > 0 && <div>{d.noNumber} have no document number.</div>}
          {(d.disagreeWithUnitId > 0 || d.unitIdUnmapped > 0) && (
            <div>
              {d.disagreeWithUnitId > 0 && `${d.disagreeWithUnitId} decode to a different unit than their operational unit (both are kept). `}
              {d.unitIdUnmapped > 0 && `${d.unitIdUnmapped} have an operational unit that is not mapped to the Site Codebook, so the two cannot be compared.`}
            </div>
          )}
          <div>
            Equipment: {a.scanned} read · {report.dryRun ? `${a.toSet} to fill` : `${a.written} filled`}
            {(a.changed ?? 0) > 0 ? ` · ${a.changed} changed since they were read (left as they are)` : ""}
            {a.refused > 0 ? ` · ${a.refused} refused` : ""}
          </div>
          {(a.disagreeWithFiling > 0 || a.keptWithoutFiling > 0) && (
            <div>
              {a.disagreeWithFiling > 0 && `${a.disagreeWithFiling} already point at a different operational unit than their codebook filing maps to (kept — the decode never overwrites a unit already set). `}
              {a.keptWithoutFiling > 0 && `${a.keptWithoutFiling} point at an operational unit while their filing maps to none (kept).`}
            </div>
          )}
          {!report.dryRun && report.remaining > 0 && (
            <div className="text-amber-700">{report.remaining} write(s) still to do — run &quot;Decode and write&quot; again to continue.</div>
          )}
          {report.mapping.codebookUnitsUnmapped.length > 0 && (
            <div>Codebook units with no operational unit: {report.mapping.codebookUnitsUnmapped.join(", ")}</div>
          )}
          {report.notes.map((n) => <div key={n} className="text-amber-700">{n}</div>)}
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
