"use client";

// Setup › Unit & equipment: the unit the project is on, and the equipment
// each work order is on, matched from the names against the equipment
// registry. One tap confirms them all; any one can be changed. A tag the
// registry files under another unit is flagged (V-7 on the Crude Unit may
// not be this unit's V-7), with a way to move it; one not in the registry
// is added to the project's unit. The project then shows on the
// Intelligence graph with its unit and equipment, and what's learned on
// that equipment reaches the next job on it.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Loader2, Pencil } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import type { Milestone } from "@/types/schema";
import { tagKey, registryTagKey, type Equipment } from "@/lib/findings";
import {
  loadProjectEquipment, matchWorkOrders, setupOrders, undecided, withEquipment, setProjectUnit, setWorkOrderEquipment, pruneEquipmentLinks,
  addToRegistry, moveToUnit, unitName, EQUIPMENT_CHANGED, type ProjectEquipmentData, type RegistryAsset, type WorkOrderMatch,
} from "@/lib/projectEquipment";

const cache = new Map<string, ProjectEquipmentData>();
// Work orders' equipment saved here, by project: shown at once, before the
// schedule on screen is read again.
const savedHere = new Map<string, Map<string, Equipment | null>>();
const noteSaved = (projectId: string, ownerId: string, e: Equipment | null) => {
  const m = savedHere.get(projectId) ?? new Map<string, Equipment | null>();
  m.set(ownerId, e);
  savedHere.set(projectId, m);
};
// One read shared by everything on the page that asks at once (the banner
// and the Setup button); a change starts a fresh one.
const inflight = new Map<string, Promise<ProjectEquipmentData>>();
const read = (orgId: string, projectId: string, fresh: boolean) => {
  if (fresh) inflight.delete(projectId);
  let p = inflight.get(projectId);
  if (!p) {
    p = loadProjectEquipment(orgId, projectId);
    inflight.set(projectId, p);
    p.finally(() => setTimeout(() => { if (inflight.get(projectId) === p) inflight.delete(projectId); }, 10_000)).catch(() => undefined);
  }
  return p;
};

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
    return matchWorkOrders(setupOrders(ms), ms, data.registry, data.unit?.code ?? null);
  }, [data, milestones, projectId]);
  const set = data ? !!data.unit && undecided(matches).length === 0 : null;
  return { data, matches, set, error, reload };
}

const btn = "inline-flex items-center justify-center gap-1.5 rounded-lg bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] text-[12.5px] font-bold px-3.5 py-2 shadow-sm disabled:opacity-50";
const quiet = "inline-flex items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] text-[12px] font-semibold text-[var(--color-text)] px-2.5 py-1.5 disabled:opacity-50";
const field = "h-9 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[13px] text-[var(--color-text)]";

export function EquipmentStep({ projectId, projectName, milestones, canManage, userId }: {
  projectId: string; projectName?: string; milestones: Milestone[]; canManage: boolean; userId: string;
}) {
  const orgId = milestones.find((m) => m.orgId)?.orgId ?? null;
  const { userEmail } = useRole();
  const actor = useMemo(() => ({ id: userId || null, name: userEmail ?? null }), [userId, userEmail]);
  const { data, matches, error } = useProjectEquipment(orgId, projectId, milestones);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const name = projectName ?? "this project";
  const unit = data?.unit ?? null;
  const unitLabel = unit ? unitName(unit) : "";
  const todo = undecided(matches);
  const flagged = matches.filter((m) => m.otherUnit && m.asset);
  const flaggedAssets = [...new Map(flagged.map((m) => [m.asset!.id, m.asset!])).values()];
  const unitOf = (code: string | null) => (code ? data?.units.find((u) => u.code === code) : undefined);
  const where = (a: RegistryAsset) => (a.unitCode ? unitName(unitOf(a.unitCode) ?? { code: a.unitCode, label: `Unit ${a.unitCode}` }) : "no unit");

  const run = async (what: string, fn: () => Promise<void>) => {
    if (!orgId) return;
    setBusy(what); setErr(null);
    try { await fn(); }
    catch (e) { setErr(/permission|policy|row-level/i.test((e as Error).message) ? `Linking the project to its unit and equipment needs the database update (20261115_project_findings.sql), or an org Admin, Manager, Supervisor or Document Control.` : (e as Error).message); }
    finally { setBusy(null); inflight.delete(projectId); window.dispatchEvent(new CustomEvent(EQUIPMENT_CHANGED)); }
  };

  /** Save one work order: a tag (found in the registry, else added to the
   *  unit) or on no equipment. `made` keeps a tag added once per run. */
  const saveOne = async (m: WorkOrderMatch, tag: string | null, made = new Map<string, RegistryAsset>()) => {
    if (!orgId) return;
    if (!tag) { await setWorkOrderEquipment({ orgId, projectId, projectName: name, ownerId: m.ownerId, title: m.title, equipment: null, actor, existing: data?.edges }); noteSaved(projectId, m.ownerId, null); return; }
    const k = tagKey(tag);
    const hits = (data?.registry ?? []).filter((a) => registryTagKey(a.tag) === k);
    let asset = (m.asset && registryTagKey(m.asset.tag) === k ? m.asset : null) ?? hits.find((a) => a.unitCode === unit?.code) ?? hits[0] ?? made.get(k) ?? null;
    if (!asset && unit) { asset = await addToRegistry({ orgId, tag, unitCode: unit.code, createdBy: userId }); made.set(k, asset); }
    const equipment = { assetId: asset?.id ?? null, tag: asset ? asset.tag.replace(/\s*\(.*$/, "") : tag.trim() };
    await setWorkOrderEquipment({ orgId, projectId, projectName: name, ownerId: m.ownerId, title: m.title, equipment, actor, existing: data?.edges });
    noteSaved(projectId, m.ownerId, equipment);
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
      await saveOne(m, m.tag, made);
      changes.set(m.ownerId, m.asset?.id ?? made.get(tagKey(m.tag))?.id ?? null);
    }
    if (data) await pruneEquipmentLinks(data.edges, inUseAfter(changes));
  });

  if (!canManage) return <div className="text-[12px] text-[var(--color-text-muted)]">Only the project owner, a co-owner or an admin can change this.</div>;
  if (!orgId) return <div className="text-[12px] text-[var(--color-text-muted)]">Import the schedule first: the work orders come from it.</div>;
  if (!data) return <div className="flex items-center gap-2 text-[12.5px] text-[var(--color-text-muted)]">{error ? <span className="text-rose-700 dark:text-rose-300">{error}</span> : <><Loader2 className="w-4 h-4 animate-spin" /> Reading the registry…</>}</div>;

  const notIn = todo.filter((m) => m.state === "not_in_registry");
  return (
    <div className="space-y-4">
      {/* The unit */}
      <div className="space-y-1.5">
        <label className="block text-[11px] font-black uppercase tracking-wider text-[var(--color-text-muted)]" htmlFor="eq-unit">Unit</label>
        {data.units.length === 0 ? (
          <div className="text-[12.5px] text-[var(--color-text-muted)]">No units in the Site Codebook yet. Add them under Admin › Codebook.</div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <select id="eq-unit" value={unit?.code ?? ""} disabled={!!busy}
              onChange={(e) => { const u = data.units.find((x) => x.code === e.target.value); if (u) void run("unit", () => setProjectUnit({ orgId, projectId, projectName: name, unit: u, before: data.edges, actor })); }}
              className={`${field} min-w-0 w-full sm:w-auto sm:min-w-[18rem]`}>
              {!unit && <option value="">Pick the unit…</option>}
              {data.units.map((u) => <option key={u.code} value={u.code}>{unitName(u)}</option>)}
            </select>
            {busy === "unit" && <Loader2 className="w-4 h-4 animate-spin text-[var(--color-text-muted)]" />}
            {unit && busy !== "unit" && <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-emerald-700 dark:text-emerald-400"><Check className="w-3.5 h-3.5" /> Saved</span>}
          </div>
        )}
      </div>

      {/* The work orders */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="text-[11px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">Work orders and their equipment · {matches.length}</div>
          {todo.length > 0 && (
            <button type="button" onClick={confirmAll} disabled={!!busy || !unit} className={`${btn} ml-auto`} title={unit ? undefined : "Pick the unit first"}>
              {busy === "all" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Confirm all {todo.length}
            </button>
          )}
        </div>
        {todo.length > 0 && (
          <p className="text-[12px] text-[var(--color-text-muted)]">
            {!unit ? "Pick the unit first. " : ""}
            Confirm all links each work order to the equipment shown{notIn.length && unit ? `, and adds ${notIn.length === 1 ? "the 1 tag" : `the ${notIn.length} tags`} not in the registry to ${unitLabel}` : ""}. Change any one first if it&apos;s wrong.
          </p>
        )}
        {unit && flaggedAssets.length > 0 && (
          <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-[12.5px] text-amber-900 dark:text-amber-200 space-y-1.5">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                The registry has {flaggedAssets.length === 1 ? `${flaggedAssets[0].tag}` : `${flaggedAssets.length} of these`} under {[...new Set(flaggedAssets.map(where))].join(", ")}, not {unitLabel}.
                {" "}If that&apos;s wrong, move {flaggedAssets.length === 1 ? "it" : "them"}. If that unit has its own, leave {flaggedAssets.length === 1 ? "it" : "them"} and change the work order.
              </span>
            </div>
            <button type="button" disabled={!!busy} className={quiet}
              onClick={() => void run("move", async () => { for (const a of flaggedAssets) await moveToUnit(a.id, unit.code, userId); })}>
              {busy === "move" && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Move {flaggedAssets.length === 1 ? flaggedAssets[0].tag : `all ${flaggedAssets.length}`} to {unit.label}
            </button>
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
                    <MatchLine m={m} where={where} unitLabel={unitLabel} />
                  </div>
                  {editing !== m.ownerId && (
                    <button type="button" disabled={!!busy} onClick={() => setEditing(m.ownerId)} className={quiet}><Pencil className="w-3.5 h-3.5" /> Change</button>
                  )}
                </div>
                {editing === m.ownerId && (
                  <EditRow m={m} registry={data.registry} busy={busy === m.ownerId} unitLabel={unitLabel}
                    onCancel={() => setEditing(null)}
                    onSave={(tag) => void run(m.ownerId, async () => {
                      const made = new Map<string, RegistryAsset>();
                      await saveOne(m, tag, made);
                      const hit = tag ? (data.registry.find((a) => registryTagKey(a.tag) === tagKey(tag) && a.unitCode === unit?.code) ?? data.registry.find((a) => registryTagKey(a.tag) === tagKey(tag)) ?? made.get(tagKey(tag))) : undefined;
                      await pruneEquipmentLinks(data.edges, inUseAfter(new Map([[m.ownerId, hit?.id ?? null]])));
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

function MatchLine({ m, where, unitLabel }: { m: WorkOrderMatch; where: (a: RegistryAsset) => string; unitLabel: string }) {
  const chip = (t: string, tone: "emerald" | "amber" | "slate") => (
    <span className={`inline-block rounded px-1.5 py-px text-[10.5px] font-black uppercase tracking-wider ${tone === "emerald" ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300" : tone === "amber" ? "bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"}`}>{t}</span>
  );
  const tag = m.tag ? <b className="text-[var(--color-text)]">{m.tag}</b> : null;
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[var(--color-text-muted)]">
      {m.state === "none" && <>{chip("No equipment", "slate")}</>}
      {m.state === "no_tag" && <span>No tag in the name. Change it to pick the equipment.</span>}
      {m.state === "linked" && <>{chip("Linked", "emerald")} {tag} {m.asset ? <span>· {where(m.asset)}</span> : <span>· not in the registry</span>}</>}
      {m.state === "found" && <>{tag} <span>· in the registry, {m.asset ? where(m.asset) : ""}</span></>}
      {m.state === "other_unit" && <>{tag} <span>· in the registry under {m.asset ? where(m.asset) : ""}</span></>}
      {m.state === "not_in_registry" && <>{tag} <span>· not in the registry{unitLabel ? `, will be added to ${unitLabel}` : ""}</span></>}
      {m.otherUnit && chip("Different unit", "amber")}
    </div>
  );
}

function EditRow({ m, registry, busy, unitLabel, onSave, onCancel }: { m: WorkOrderMatch; registry: RegistryAsset[]; busy: boolean; unitLabel: string; onSave: (tag: string | null) => void; onCancel: () => void }) {
  const [tag, setTag] = useState(m.tag ?? "");
  const id = `eq-tags-${m.ownerId}`;
  const known = tag.trim() && registry.some((a) => registryTagKey(a.tag) === tagKey(tag));
  return (
    <form className="mt-2 space-y-1.5" onSubmit={(e) => { e.preventDefault(); if (tag.trim()) onSave(tag.trim()); }}>
      <div className="flex flex-wrap items-center gap-2">
        <input value={tag} onChange={(e) => setTag(e.target.value)} list={id} placeholder="Tag, e.g. E-12" aria-label="Equipment tag" autoFocus
          className={`${field} w-40`} />
        <datalist id={id}>{registry.slice(0, 400).map((a) => <option key={a.id} value={a.tag.replace(/\s*\(.*$/, "")} />)}</datalist>
        <button type="submit" disabled={busy || !tag.trim()} className={btn}>{busy && <Loader2 className="w-4 h-4 animate-spin" />} Save</button>
        <button type="button" disabled={busy} onClick={() => onSave(null)} className={quiet}>No equipment</button>
        <button type="button" disabled={busy} onClick={onCancel} className="text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-1">Cancel</button>
      </div>
      {tag.trim() && !known && <div className="text-[11.5px] text-[var(--color-text-muted)]">Not in the registry{unitLabel ? `: it will be added to ${unitLabel}` : " (pick the unit to add it there)"}.</div>}
    </form>
  );
}
