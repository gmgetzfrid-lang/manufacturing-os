"use client";

// Setup › Unit & equipment: the units the project is on, and for each work
// order its equipment, unit and equipment type. The unit and type are read
// from the site code in the schedule (5630.06: LRU, Exchangers) against the
// Site Codebook, else the registry and the tag's letters; the equipment is
// matched from the names against the registry. One tap confirms them all;
// any one can be changed. A tag the registry files under another unit is
// flagged (V-7 on the Crude Unit may not be this unit's V-7), with a way to
// move it; one not in the registry is added under its work order's unit.
// The project then shows on the Intelligence graph with its units and
// equipment, every view filters by unit and type, and what's learned on
// that equipment reaches the next job on it.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Loader2, Pencil, Plus, X } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import type { Milestone } from "@/types/schema";
import { tagKey, registryTagKey } from "@/lib/findings";
import {
  loadProjectEquipment, matchWorkOrders, setupOrders, undecided, withEquipment, setProjectUnitOn, setWorkOrderEquipment, pruneEquipmentLinks,
  addToRegistry, moveToUnit, requestEquipment, unitName, EQUIPMENT_CHANGED, type ProjectEquipmentData, type RegistryAsset, type WorkOrderMatch, type SavedHere, type UnitChoice,
} from "@/lib/projectEquipment";
import { typeLabel, fromWords, type WoClass } from "@/lib/woClass";
import { sameEquipmentId, requestOf, equipmentLabel } from "@/lib/equipmentPick";
import { EquipmentField } from "@/components/projects/EquipmentPicker";
import { cache, read, noteSaved, savedHere, forgetRead } from "@/components/projects/equipmentData";

export { withSavedHere, useEquipmentRegistry, noteEquipmentSaved } from "@/components/projects/equipmentData";

/** The project's unit, the registry and each work order's match, re-read
 *  whenever any of it changes. `set`: unit chosen and nothing left to
 *  confirm (null while reading). */
export function useProjectEquipment(orgId: string | null | undefined, projectId: string, milestones: Milestone[]) {
  const [data, setData] = useState<ProjectEquipmentData | null>(() => cache.get(projectId) ?? null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback((fresh: boolean) => {
    if (!orgId) return;
    void read(orgId, projectId, fresh).then((d) => { cache.set(projectId, d); setData(d); setError(null); }).catch((e) => setError((e as Error).message));
  }, [orgId, projectId]);
  const reload = useCallback(() => load(true), [load]);
  useEffect(() => {
    load(false);
    // After a change: the first to hear it reads afresh, the rest share it.
    const on = () => load(false);
    window.addEventListener(EQUIPMENT_CHANGED, on);
    return () => window.removeEventListener(EQUIPMENT_CHANGED, on);
  }, [load]);
  const matches = useMemo(() => {
    if (!data) return [];
    const ms = withEquipment(milestones, savedHere.get(projectId));
    return matchWorkOrders(setupOrders(ms), ms, data.registry, data.projectUnits.map((u) => u.code), data.book);
  }, [data, milestones, projectId]);
  const set = data ? data.projectUnits.length > 0 && undecided(matches).length === 0 : null;
  return { data, matches, set, error, reload };
}

const btn = "inline-flex items-center justify-center gap-1.5 rounded-lg bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] text-[12.5px] font-bold px-3.5 py-2 shadow-sm disabled:opacity-50";
const quiet = "inline-flex items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] text-[12px] font-semibold text-[var(--color-text)] px-2.5 py-1.5 disabled:opacity-50";
const field = "h-9 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[13px] text-[var(--color-text)]";

export function EquipmentStep({ projectId, projectName, milestones, canManage, userId }: {
  projectId: string; projectName?: string; milestones: Milestone[]; canManage: boolean; userId: string;
}) {
  const orgId = milestones.find((m) => m.orgId)?.orgId ?? null;
  const { userEmail, hasAnyRole } = useRole();
  // Adding or moving equipment in a unit: admins only. Anyone else's
  // missing tags go to the admins as asks, kept on the work order.
  const canEditEquipment = hasAnyRole(["Admin"]);
  const actor = useMemo(() => ({ id: userId || null, name: userEmail ?? null }), [userId, userEmail]);
  const { data, matches, error } = useProjectEquipment(orgId, projectId, milestones);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const name = projectName ?? "this project";
  const pUnits = data?.projectUnits ?? [];
  const asks = useMemo(() => milestones.filter((m) => !m.cancelledAt && m.id).map((m) => ({ m, r: requestOf(m) })).filter((x): x is { m: Milestone; r: NonNullable<ReturnType<typeof requestOf>> } => !!x.r), [milestones]);
  const todo = undecided(matches);
  const unitOf = (code: string | null | undefined): UnitChoice | undefined => (code ? data?.units.find((u) => u.code === code) ?? { code, label: `Unit ${code}` } : undefined);
  const where = (a: RegistryAsset) => (a.unitCode ? unitName(unitOf(a.unitCode)) : "no unit");
  // The unit a work order's new equipment goes under: its own, else the project's first.
  const homeOf = (m: WorkOrderMatch) => m.cls.unit ?? pUnits[0]?.code ?? null;
  const flagged = matches.filter((m) => m.otherUnit && m.asset);
  const flaggedAssets = [...new Map(flagged.map((m) => [m.asset!.id, { asset: m.asset!, to: homeOf(m) }])).values()].filter((x) => x.to);
  // Units the work orders are on that the project isn't (yet).
  const woUnits = useMemo(() => {
    const n = new Map<string, number>();
    for (const m of matches) if (m.cls.unit && m.cls.unitFrom !== "project" && m.cls.unitFrom !== "main") n.set(m.cls.unit, (n.get(m.cls.unit) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1]);
  }, [matches]);
  const missingUnits = woUnits.filter(([c]) => !pUnits.some((u) => u.code === c));
  const unknownTypes = [...new Set(matches.map((m) => m.cls.type).filter((t): t is string => !!t && !data?.book.equipmentTypes.some((x) => x.code === t)))];

  const run = async (what: string, fn: () => Promise<void>) => {
    if (!orgId) return;
    setBusy(what); setErr(null);
    try { await fn(); }
    catch (e) { setErr(/permission|policy|row-level/i.test((e as Error).message) ? `Linking the project to its units and equipment needs the database update (20261115_project_findings.sql), or an org Admin, Manager, Supervisor or Document Control.` : (e as Error).message); }
    finally { setBusy(null); forgetRead(projectId); window.dispatchEvent(new CustomEvent(EQUIPMENT_CHANGED)); }
  };
  const unitOn = (u: UnitChoice, on: boolean) => { if (orgId && data) void run(`unit:${u.code}`, () => setProjectUnitOn({ orgId, projectId, projectName: name, unit: u, on, before: data.edges, actor })); };
  const addUnits = (codes: string[]) => { if (orgId && data) void run("units", async () => { for (const c of codes) await setProjectUnitOn({ orgId, projectId, projectName: name, unit: unitOf(c)!, on: true, before: data.edges, actor }); }); };

  /** Save one work order: a tag (found in the registry, else added under its
   *  unit) or on no equipment (null), or its equipment left as is
   *  (undefined); and its unit and type. `made` keeps a tag added once. */
  // A new registry entry gets its site code only when every work order on
  // that tag (in that unit) has the same one: C-01's VFD (5679.03) and the
  // compressor C-01 (5628.01) share a tag, not a number.
  const codeFor = (home: string | null, k: string) => {
    const cs = new Set(matches.filter((x) => x.tag && tagKey(x.tag) === k && (x.cls.unit ?? pUnits[0]?.code ?? null) === home).map((x) => x.cls.code));
    const c = cs.size === 1 ? [...cs][0] : null;
    return c && /^\d+\.\w+$/.test(c) ? c : null;
  };
  const saveOne = async (m: WorkOrderMatch, tag: string | null | undefined, cls: { unit: string | null; type: string | null }, made = new Map<string, RegistryAsset>()): Promise<string | null | undefined> => {
    if (!orgId) return undefined;
    const keep = { unit: cls.unit, type: cls.type };
    if (tag === undefined) {
      await setWorkOrderEquipment({ orgId, projectId, projectName: name, ownerId: m.ownerId, title: m.title, equipment: undefined, ...keep, actor, existing: data?.edges });
      noteSaved(projectId, m.ownerId, keep);
      return m.state === "linked" ? m.asset?.id ?? null : undefined;
    }
    if (!tag) {
      await setWorkOrderEquipment({ orgId, projectId, projectName: name, ownerId: m.ownerId, title: m.title, equipment: null, ...keep, actor, existing: data?.edges });
      noteSaved(projectId, m.ownerId, { equipment: null, ...keep });
      return null;
    }
    const home = cls.unit ?? pUnits[0]?.code ?? null;
    const k = tagKey(tag);
    const hits = (data?.registry ?? []).filter((a) => registryTagKey(a.tag) === k);
    // Sure of the unit: only that unit's equipment by this tag.
    const sure = cls.unit != null;
    let asset = (m.asset && registryTagKey(m.asset.tag) === k && (!sure || m.asset.unitCode === home) ? m.asset : null)
      ?? hits.find((a) => a.unitCode === home) ?? (sure ? null : hits[0] ?? null) ?? made.get(`${home}:${k}`) ?? null;
    if (!asset && home && !canEditEquipment) {
      await requestEquipment({ orgId, projectId, projectName: name, ownerId: m.ownerId, title: m.title, tag: tag.trim(), unit: unitOf(home) ?? null, actor });
      noteSaved(projectId, m.ownerId, { equipment: { assetId: null, tag: tag.trim() }, ...keep });
      return null;
    }
    if (!asset && home) {
      // The ID: the plant's number from the schedule's Equipment column (never
      // worked out from the name); one already used isn't taken twice.
      const code = codeFor(home, k);
      const free = code && !(data?.registry ?? []).some((a) => sameEquipmentId(a.code, code)) ? code : null;
      asset = await addToRegistry({ orgId, tag, unitCode: home, createdBy: userId, code: free });
      made.set(`${home}:${k}`, asset);
    }
    const equipment = { assetId: asset?.id ?? null, tag: asset ? asset.tag.replace(/\s*\(.*$/, "") : tag.trim() };
    await setWorkOrderEquipment({ orgId, projectId, projectName: name, ownerId: m.ownerId, title: m.title, equipment, ...keep, actor, existing: data?.edges });
    noteSaved(projectId, m.ownerId, { equipment, ...keep });
    return asset?.id ?? null;
  };

  const inUseAfter = (changes: Map<string, string | null>) => {
    const ids = new Set<string>();
    for (const m of matches) {
      if (changes.has(m.ownerId)) { const id = changes.get(m.ownerId); if (id) ids.add(id); }
      else if (m.state === "linked" && m.asset) ids.add(m.asset.id);
    }
    return ids;
  };

  const confirmAll = () => run("all", async () => {
    const made = new Map<string, RegistryAsset>();
    const changes = new Map<string, string | null>();
    for (const m of todo) {
      const needsTag = m.state === "found" || m.state === "other_unit" || m.state === "not_in_registry";
      const id = await saveOne(m, needsTag ? m.tag : undefined, { unit: m.cls.unit, type: m.cls.type }, made);
      if (id !== undefined) changes.set(m.ownerId, id);
    }
    if (data) await pruneEquipmentLinks(data.edges, inUseAfter(changes));
  });

  if (!canManage) return <div className="text-[12px] text-[var(--color-text-muted)]">Only the project owner, a co-owner or an admin can change this.</div>;
  if (!orgId) return <div className="text-[12px] text-[var(--color-text-muted)]">Import the schedule first: the work orders come from it.</div>;
  if (!data) return <div className="flex items-center gap-2 text-[12.5px] text-[var(--color-text-muted)]">{error ? <span className="text-rose-700 dark:text-rose-300">{error}</span> : <><Loader2 className="w-4 h-4 animate-spin" /> Reading the registry…</>}</div>;

  // Tags to add: once per tag and unit (three C-01 work orders, one C-01).
  const notIn = [...new Set(todo.filter((m) => m.state === "not_in_registry" && m.tag).map((m) => `${homeOf(m)}:${tagKey(m.tag!)}`))];
  const others = data.units.filter((u) => !pUnits.some((p) => p.code === u.code));
  return (
    <div className="space-y-4">
      {/* The units */}
      <div className="space-y-1.5">
        <div className="text-[11px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">Units this project is on</div>
        {data.units.length === 0 ? (
          <div className="text-[12.5px] text-[var(--color-text-muted)]">No units in the Site Codebook yet. Add them under Admin › Codebook.</div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              {pUnits.map((u, i) => {
                const n = woUnits.find(([c]) => c === u.code)?.[1] ?? 0;
                const own = data.edges.some((e) => e.b === `cbunit:${u.code}` && e.evidence?.source === "setup");
                return (
                  <span key={u.code} className="inline-flex items-center gap-1 rounded-full border border-[var(--color-accent)] bg-[var(--color-accent-soft)] pl-2.5 pr-1 py-1 text-[12.5px] font-semibold text-[var(--color-text)]">
                    <span className="min-w-0">{unitName(u)}<span className="font-normal text-[var(--color-text-muted)]">{i === 0 && pUnits.length > 1 ? " · main" : ""}{n ? ` · ${n} WO${n === 1 ? "" : "s"}` : ""}</span></span>
                    {busy === `unit:${u.code}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : own ? <button type="button" disabled={!!busy} onClick={() => unitOn(u, false)} aria-label={`Take the project off ${u.label}`} className="p-0.5 rounded-full hover:bg-[var(--color-surface-2)]"><X className="w-3.5 h-3.5" /></button>
                        : <span className="px-1 text-[10.5px] font-normal text-[var(--color-text-muted)]" title="Linked in Documents › Scope">Scope</span>}
                  </span>
                );
              })}
              {!adding ? (
                <button type="button" disabled={!!busy} onClick={() => setAdding(true)} className={quiet}><Plus className="w-3.5 h-3.5" /> {pUnits.length ? "Add a unit" : "Pick a unit"}</button>
              ) : (
                <select autoFocus value="" aria-label="Add a unit" onBlur={() => setAdding(false)}
                  onChange={(e) => { const u = unitOf(e.target.value); setAdding(false); if (u) unitOn(u, true); }}
                  className={`${field} min-w-0 w-full sm:w-auto sm:min-w-[18rem]`}>
                  <option value="">Pick the unit…</option>
                  {others.map((u) => <option key={u.code} value={u.code}>{unitName(u)}</option>)}
                </select>
              )}
              {busy === "units" && <Loader2 className="w-4 h-4 animate-spin text-[var(--color-text-muted)]" />}
            </div>
            {missingUnits.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--color-text-muted)]">
                <span>{pUnits.length ? "Work orders are also on" : "The work orders' equipment numbers put them on"} {missingUnits.map(([c, n]) => `${unitName(unitOf(c))} (${n})`).join(", ")}.</span>
                <button type="button" disabled={!!busy} onClick={() => addUnits(missingUnits.map(([c]) => c))} className={quiet}><Plus className="w-3.5 h-3.5" /> Add {missingUnits.length === 1 ? "it" : `all ${missingUnits.length}`}</button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Asks waiting on an admin: each opens on its work order, ready to add. */}
      {asks.length > 0 && (
        <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-3 py-2.5 space-y-2">
          <div className="text-[12.5px] font-bold text-amber-900 dark:text-amber-200">
            {asks.length === 1 ? "1 work order is" : `${asks.length} work orders are`} waiting on equipment to be added{canEditEquipment ? "" : " by an admin"}
          </div>
          <ul className="space-y-1.5">
            {asks.map(({ m, r }) => (
              <li key={m.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
                <span className="flex-1 min-w-[10rem] text-[var(--color-text)]">{m.workOrderRef ? `WO ${m.workOrderRef} · ` : ""}{m.name}<span className="text-[var(--color-text-muted)]">{r.byName ? ` · asked by ${r.byName}` : ""}</span></span>
                <EquipmentField milestone={m} milestones={milestones} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* The work orders */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="text-[11px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">Work orders: equipment, unit and type · {matches.length}</div>
          {todo.length > 0 && (
            <button type="button" onClick={confirmAll} disabled={!!busy || !pUnits.length} className={`${btn} ml-auto`} title={pUnits.length ? undefined : "Pick the project's unit first"}>
              {busy === "all" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Confirm all {todo.length}
            </button>
          )}
        </div>
        {todo.length > 0 && (
          <p className="text-[12px] text-[var(--color-text-muted)]">
            {!pUnits.length ? "Pick the project's unit first. " : ""}
            Confirm all saves each work order&apos;s equipment, unit and type as shown{notIn.length && pUnits.length ? (canEditEquipment ? `, and adds ${notIn.length === 1 ? "the 1 tag" : `the ${notIn.length} tags`} not in the equipment list under their unit` : `, and asks an admin to add ${notIn.length === 1 ? "the 1 tag" : `the ${notIn.length} tags`} not in the equipment list (only admins add equipment)`) : ""}. Change any one first if it&apos;s wrong.
          </p>
        )}
        {unknownTypes.length > 0 && (
          <div className="text-[12px] text-amber-800 dark:text-amber-300">
            Equipment type {unknownTypes.map((t) => `${t}`).join(", ")} {unknownTypes.length === 1 ? "is" : "are"} in your equipment numbers but not in the Site Codebook. Add {unknownTypes.length === 1 ? "it" : "them"} under Admin › Codebook to name {unknownTypes.length === 1 ? "it" : "them"}.
          </div>
        )}
        {flaggedAssets.length > 0 && (
          <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-[12.5px] text-amber-900 dark:text-amber-200 space-y-1.5">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                The registry has {flaggedAssets.length === 1 ? `${flaggedAssets[0].asset.tag}` : `${flaggedAssets.length} of these`} under {[...new Set(flaggedAssets.map((x) => where(x.asset)))].join(", ")}, not the work order&apos;s unit.
                {" "}If that&apos;s wrong, move {flaggedAssets.length === 1 ? "it" : "them"}. If that unit has its own, leave {flaggedAssets.length === 1 ? "it" : "them"} and change the work order.
              </span>
            </div>
            {canEditEquipment ? <button type="button" disabled={!!busy} className={quiet}
              onClick={() => void run("move", async () => { for (const x of flaggedAssets) await moveToUnit(x.asset.id, x.to!, userId); })}>
              {busy === "move" && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Move {flaggedAssets.length === 1 ? flaggedAssets[0].asset.tag : `all ${flaggedAssets.length}`} to {flaggedAssets.length === 1 ? unitOf(flaggedAssets[0].to)?.label : "their work order's unit"}
            </button> : <span className="text-[12px]">Only an admin can move equipment to another unit.</span>}
          </div>
        )}
        {matches.length === 0 ? (
          <div className="text-[12.5px] text-[var(--color-text-muted)]">No work orders on the schedule yet.</div>
        ) : (
          <ul className="rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
            {matches.map((m) => (
              <li key={m.ownerId} className="px-3 py-2 text-[12.5px]">
                <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
                  <div className="flex-1 min-w-[12rem]">
                    <div className="font-semibold text-[var(--color-text)] break-words">{m.title}{m.wo ? <span className="font-normal text-[var(--color-text-muted)]"> · WO {m.wo}</span> : null}</div>
                    <MatchLine m={m} where={where} />
                    <ClassLine c={m.cls} unit={(c) => (c ? unitName(unitOf(c)) : "")} type={(t) => typeLabel(t, data.book)} known={(t) => data.book.equipmentTypes.some((x) => x.code === t)} />
                  </div>
                  {editing !== m.ownerId && (
                    <button type="button" disabled={!!busy} onClick={() => setEditing(m.ownerId)} className={quiet}><Pencil className="w-3.5 h-3.5" /> Change</button>
                  )}
                </div>
                {editing === m.ownerId && (
                  <EditRow m={m} data={data} busy={busy === m.ownerId}
                    onCancel={() => setEditing(null)}
                    onSave={(tag, cls) => void run(m.ownerId, async () => {
                      const id = await saveOne(m, tag, cls);
                      if (id !== undefined) await pruneEquipmentLinks(data.edges, inUseAfter(new Map([[m.ownerId, id]])));
                      setEditing(null);
                    })} />
                )}
              </li>
            ))}
          </ul>
        )}
        {err && <div className="text-[12px] text-rose-700 dark:text-rose-300">{err}</div>}
      </div>
    </div>
  );
}

const chip = (t: string, tone: "emerald" | "amber" | "slate") => (
  <span className={`inline-block rounded px-1.5 py-px text-[10.5px] font-black uppercase tracking-wider ${tone === "emerald" ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300" : tone === "amber" ? "bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"}`}>{t}</span>
);

function MatchLine({ m, where }: { m: WorkOrderMatch; where: (a: RegistryAsset) => string }) {
  // Written as everywhere: "E-26 (5530.19) Debutanizer Trim Cooler".
  const tag = m.asset ? <b className="text-[var(--color-text)]">{equipmentLabel(m.asset)}</b> : m.tag ? <b className="text-[var(--color-text)]">{m.tag}</b> : null;
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[var(--color-text-muted)]">
      {m.state === "none" && <>{chip("No equipment", "slate")}</>}
      {m.state === "no_tag" && <span>No tag in the name.</span>}
      {m.state === "linked" && <>{chip("Linked", "emerald")} {tag} {m.asset ? <span>· {where(m.asset)}</span> : <span>· not in the registry</span>}</>}
      {m.state === "found" && <>{tag} <span>· in the registry, {m.asset ? where(m.asset) : ""}</span></>}
      {m.state === "other_unit" && <>{tag} <span>· in the registry under {m.asset ? where(m.asset) : ""}</span></>}
      {m.state === "not_in_registry" && <>{tag} <span>· not in the registry, will be added under its unit</span></>}
      {m.otherUnit && chip("Different unit", "amber")}
    </div>
  );
}

/** Its type and unit, and where each came from. */
function ClassLine({ c, unit, type, known }: { c: WoClass; unit: (code: string | null) => string; type: (code: string) => string; known: (code: string) => boolean }) {
  const saved = c.unitFrom === "saved" && (c.typeFrom === "saved" || !c.type);
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[var(--color-text-muted)]">
      {c.type ? <b className="text-[var(--color-text)]">{type(c.type)}</b> : <span>No type</span>}
      {c.type && !known(c.type) && chip("Not in codebook", "amber")}
      <span>·</span>
      {c.unit ? <span className="text-[var(--color-text)]">{unit(c.unit)}</span> : <span>No unit</span>}
      {saved ? chip("Confirmed", "emerald") : (c.typeFrom || c.unitFrom) && <span>· {fromWords(c.typeFrom ?? c.unitFrom, c)}</span>}
    </div>
  );
}

function EditRow({ m, data, busy, onSave, onCancel }: {
  m: WorkOrderMatch; data: ProjectEquipmentData; busy: boolean;
  /** tag: a tag, null (no equipment) or undefined (left as is). */
  onSave: (tag: string | null | undefined, cls: { unit: string | null; type: string | null }) => void; onCancel: () => void;
}) {
  const [tag, setTag] = useState(m.state === "none" ? "" : m.tag ?? "");
  const [unit, setUnit] = useState(m.cls.unit ?? data.projectUnits[0]?.code ?? "");
  const [type, setType] = useState(m.cls.type ?? "");
  const id = `eq-tags-${m.ownerId}`;
  const known = tag.trim() && data.registry.some((a) => registryTagKey(a.tag) === tagKey(tag));
  const units = [...data.projectUnits, ...data.units.filter((u) => !data.projectUnits.some((p) => p.code === u.code))];
  const types = [...data.book.equipmentTypes].sort((a, b) => a.label.localeCompare(b.label));
  const cls = { unit: unit || null, type: type || null };
  const tagNow = tag.trim() ? tag.trim() : m.state === "none" ? null : undefined;
  return (
    <form className="mt-2 space-y-1.5" onSubmit={(e) => { e.preventDefault(); onSave(tagNow, cls); }}>
      <div className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)]">
        <label className="text-[11px] font-semibold text-[var(--color-text-muted)]">Tag
          <input value={tag} onChange={(e) => setTag(e.target.value)} list={id} placeholder="E-12" aria-label="Equipment tag" autoFocus className={`${field} mt-0.5 w-full`} />
          <datalist id={id}>{data.registry.slice(0, 400).map((a) => <option key={a.id} value={a.tag.replace(/\s*\(.*$/, "")} />)}</datalist>
        </label>
        <label className="text-[11px] font-semibold text-[var(--color-text-muted)]">Unit
          <select value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Unit" className={`${field} mt-0.5 w-full`}>
            <option value="">No unit</option>
            {units.map((u) => <option key={u.code} value={u.code}>{unitName(u)}</option>)}
          </select>
        </label>
        <label className="text-[11px] font-semibold text-[var(--color-text-muted)]">Equipment type
          <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Equipment type" className={`${field} mt-0.5 w-full`}>
            <option value="">No type</option>
            {type && !types.some((t) => t.code === type) && <option value={type}>Type {type} (not in the codebook)</option>}
            {types.map((t) => <option key={t.code} value={t.code}>{t.label} ({t.code})</option>)}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={busy} className={btn}>{busy && <Loader2 className="w-4 h-4 animate-spin" />} Save</button>
        <button type="button" disabled={busy} onClick={() => onSave(null, cls)} className={quiet}>No equipment</button>
        <button type="button" disabled={busy} onClick={onCancel} className="text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-1">Cancel</button>
      </div>
      {tag.trim() && !known && <div className="text-[11.5px] text-[var(--color-text-muted)]">Not in the registry: it will be added under {unit ? unitName(units.find((u) => u.code === unit)) : "the project's unit"}.</div>}
    </form>
  );
}
