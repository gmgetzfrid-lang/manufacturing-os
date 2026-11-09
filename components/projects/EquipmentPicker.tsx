"use client";

// EquipmentPicker - the equipment a work order is on, picked from the
// project's unit. Set on the work order (the task); its steps take it from
// there. On a work order card and in the step panel (which sets its work
// order).
//
//   - No unit on the project yet: the owner, a co-owner or an admin picks it
//     first, then goes straight on to the equipment.
//   - Everyone who can edit the schedule picks from the unit's list.
//   - Not in the list: an admin adds it there and then (name, unit, ID,
//     checked against what's there so nothing is added twice) and it's linked;
//     anyone else asks an admin, and the ask stays on the work order until
//     it's answered.

import React, { useMemo, useState } from "react";
import { Wrench, Loader2, Plus, Search, Check, AlertTriangle, Send, X, Ban } from "lucide-react";
import type { Milestone } from "@/types/schema";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { useRole } from "@/components/providers/RoleContext";
import { useToast } from "@/components/providers/ToastProvider";
import { useEquipmentScope } from "@/components/projects/EquipmentScope";
import { useEquipmentRegistry, noteEquipmentSaved } from "@/components/projects/equipmentData";
import { equipmentOf, EQUIP_NONE } from "@/lib/findings";
import { setupOrders, proposeTag, setProjectUnit, setWorkOrderEquipment, addToRegistry, requestEquipment, clearEquipmentRequest, unitName, EQUIPMENT_CHANGED, type UnitChoice } from "@/lib/projectEquipment";
import { invalidateAssetCache } from "@/lib/assets";
import { searchFilter } from "@/lib/fuzzySearch";
import { nameKey, plainName, scheduleId, checkNew, unitEquipment, sameNameElsewhere, requestOf, type PickAsset } from "@/lib/equipmentPick";
import { splitTag } from "@/lib/codebook";

const btn = "inline-flex items-center justify-center gap-1.5 rounded-lg bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] text-[13px] font-bold px-3.5 h-10 shadow-sm disabled:opacity-50";
const quiet = "inline-flex items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] text-[13px] font-semibold text-[var(--color-text)] px-3 h-10 disabled:opacity-50";
const field = "h-10 w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-[14px] text-[var(--color-text)]";

/** The work order a step belongs to (the step itself when it is one). */
function ownerOf(m: Milestone, milestones: Milestone[]): Milestone {
  const owners = new Set(setupOrders(milestones).map((o) => o.owner.id));
  const byId = new Map(milestones.filter((x) => x.id).map((x) => [x.id!, x]));
  const seen = new Set<string>();
  for (let x: Milestone | undefined = m; x && x.id && !seen.has(x.id); x = x.parentId ? byId.get(x.parentId) : undefined) {
    seen.add(x.id);
    if (owners.has(x.id)) return x;
  }
  return m;
}

/** The equipment line on a work order card or step: what it's on, tap to
 *  change. Nothing outside a project's schedule. */
export function EquipmentField({ milestone, milestones, compact }: { milestone: Milestone; milestones: Milestone[]; compact?: boolean }) {
  const scope = useEquipmentScope();
  const { data } = useEquipmentRegistry(scope?.orgId, scope?.projectId ?? "");
  const [open, setOpen] = useState(false);
  const byId = useMemo(() => new Map(milestones.filter((x) => x.id).map((x) => [x.id!, x])), [milestones]);
  if (!scope) return null;
  const eq = equipmentOf(milestone, byId);
  const none = (milestone.attributes ?? {})[EQUIP_NONE] === true;
  const ask = requestOf(milestone) ?? requestOf(ownerOf(milestone, milestones));
  const asset = eq?.assetId ? data?.registry.find((a) => a.id === eq.assetId) : undefined;
  const label = asset ? `${plainName(asset.tag)}${asset.code ? ` · ${asset.code}` : ""}`
    : ask ? `${ask.tag} · asked for`
      : eq ? `${eq.tag} · not linked`
        : none ? "No equipment" : "Equipment";
  const tone = asset ? "border-[var(--color-border-strong)] text-[var(--color-text)]"
    : ask ? "border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30"
      : "border-dashed border-[var(--color-border-strong)] text-[var(--color-text-muted)]";
  const inner = <><Wrench className="w-3.5 h-3.5 shrink-0" /><span className="truncate">{label}</span>{!asset && !ask && !eq && !none && scope.canEdit && <Plus className="w-3 h-3 shrink-0" />}</>;
  const cls = `inline-flex items-center gap-1.5 max-w-full ${compact ? "h-8 px-2.5 text-[12px]" : "h-8 px-3 text-[12px]"} rounded-lg border font-bold ${tone}`;
  return (
    <>
      {scope.canEdit
        ? <button type="button" onClick={() => setOpen(true)} className={`${cls} hover:bg-[var(--color-surface-2)]`} title="The equipment this is on">{inner}</button>
        : <span className={cls}>{inner}</span>}
      {open && <EquipmentPicker target={milestone} milestones={milestones} onClose={() => setOpen(false)} />}
    </>
  );
}

export function EquipmentPicker({ target, milestones, onClose }: { target: Milestone; milestones: Milestone[]; onClose: () => void }) {
  const scope = useEquipmentScope()!;
  const { hasAnyRole } = useRole();
  const { showToast } = useToast();
  const isAdmin = hasAnyRole(["Admin"]);
  const canSetUnit = scope.canManage || isAdmin;
  const { data, error, reload } = useEquipmentRegistry(scope.orgId, scope.projectId);
  const owner = useMemo(() => ownerOf(target, milestones), [target, milestones]);
  const byId = useMemo(() => new Map(milestones.filter((x) => x.id).map((x) => [x.id!, x])), [milestones]);
  // Equipment goes on the work order (the task); its steps take it from there.
  const isStep = owner.id !== target.id;
  const saveOn = owner;
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [unitQuery, setUnitQuery] = useState("");
  const [adding, setAdding] = useState<{ tag: string; unit: string; code: string; touched: boolean } | null>(null);
  const actor = { id: scope.userId, name: scope.userName };

  const units: UnitChoice[] = data?.projectUnits ?? [];
  const unitCodes = units.map((u) => u.code);
  const unitLabel = (code: string | null | undefined) => unitName(units.find((u) => u.code === code) ?? data?.units.find((u) => u.code === code) ?? (code ? { code, label: `Unit ${code}` } : null));
  const registry: PickAsset[] = data?.registry ?? [];
  const ask = requestOf(saveOn) ?? requestOf(owner);
  const current = equipmentOf(saveOn, byId);
  // What the work order's name says it's on (E-12 - Transmix Feed…).
  const guess = useMemo(() => ask?.tag ?? proposeTag(owner, byId), [ask, owner, byId]);
  const list = useMemo(() => unitEquipment(registry, unitCodes, query), [registry, unitCodes, query]);
  const guessHit = guess ? registry.find((a) => a.unitCode != null && unitCodes.includes(a.unitCode) && nameKey(a.tag) === nameKey(guess)) : undefined;
  // The name to add or ask for: what's typed when it reads as a tag, else the guess.
  const typedTag = query.trim() && splitTag(query.trim()) ? query.trim().toUpperCase() : null;
  const want = typedTag ?? (guessHit ? null : guess);
  const wantHere = want ? registry.some((a) => a.unitCode != null && unitCodes.includes(a.unitCode) && nameKey(a.tag) === nameKey(want)) : false;
  const elsewhere = want ? sameNameElsewhere(want, registry, unitCodes) : [];

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setErr(null);
    try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  const done = (words: string) => {
    window.dispatchEvent(new CustomEvent(EQUIPMENT_CHANGED));
    scope.onChanged?.();
    showToast({ type: "success", title: words });
    onClose();
  };
  const titleOf = (m: Milestone) => `${m.workOrderRef ? `WO ${m.workOrderRef} · ` : ""}${m.name}`;
  const link = (a: PickAsset) => run(a.id, async () => {
    const equipment = { assetId: a.id, tag: plainName(a.tag) };
    await setWorkOrderEquipment({ orgId: scope.orgId, projectId: scope.projectId, projectName: scope.projectName, ownerId: saveOn.id!, title: titleOf(saveOn), equipment, unit: a.unitCode ?? undefined, actor, existing: data?.edges });
    noteEquipmentSaved(scope.projectId, saveOn.id!, { equipment, unit: a.unitCode ?? undefined });
    done(`${titleOf(saveOn)} is on ${plainName(a.tag)}`);
  });
  const setNone = () => run("none", async () => {
    await setWorkOrderEquipment({ orgId: scope.orgId, projectId: scope.projectId, projectName: scope.projectName, ownerId: saveOn.id!, title: titleOf(saveOn), equipment: null, actor, existing: data?.edges });
    noteEquipmentSaved(scope.projectId, saveOn.id!, { equipment: null });
    done(`${titleOf(saveOn)}: on no equipment`);
  });
  const pickUnit = (u: UnitChoice) => run(`unit:${u.code}`, async () => {
    await setProjectUnit({ orgId: scope.orgId, projectId: scope.projectId, projectName: scope.projectName, unit: u, before: data?.edges ?? [], actor });
    await reload();
    window.dispatchEvent(new CustomEvent(EQUIPMENT_CHANGED));
  });
  const askAdmin = (tag: string) => run("ask", async () => {
    await requestEquipment({ orgId: scope.orgId, projectId: scope.projectId, projectName: scope.projectName, ownerId: saveOn.id!, title: titleOf(saveOn), tag, unit: units[0] ?? null, actor });
    done(`Asked an admin to add ${tag}. When it's added, it links to this work order.`);
  });
  const withdraw = () => run("withdraw", async () => {
    await clearEquipmentRequest(saveOn.id!, scope.userId);
    if (saveOn.id !== owner.id) await clearEquipmentRequest(owner.id!, scope.userId);
    done(isAdmin ? "Turned down" : "Ask withdrawn");
  });
  // The plant's number for the work order's own equipment, from the
  // schedule's Equipment column; a different name typed gets no number.
  const fromSchedule = useMemo(() => scheduleId(saveOn, byId) ?? scheduleId(owner, byId), [saveOn, owner, byId]);
  const idFor = (tag: string) => (fromSchedule && guess && nameKey(tag) === nameKey(guess) ? fromSchedule : "");
  const startAdd = (tag: string) => {
    const code = idFor(tag);
    const byCode = code ? units.find((u) => code.startsWith(u.code))?.code : undefined;
    const unit = byCode ?? (ask?.unit && unitCodes.includes(ask.unit) ? ask.unit : units[0]?.code) ?? "";
    setAdding({ tag, unit, code, touched: false });
  };

  const header = <ModalHeader icon={Wrench} title="Equipment" subtitle={titleOf(owner)} onClose={onClose} />;

  if (!data) {
    return (
      <Modal onClose={onClose} size="md">
        {header}
        <ModalBody><div className="flex items-center gap-2 text-[13px] text-[var(--color-text-muted)]">{error ? <span className="text-rose-700 dark:text-rose-300">{error}</span> : <><Loader2 className="w-4 h-4 animate-spin" /> Reading the equipment list…</>}</div></ModalBody>
      </Modal>
    );
  }

  // ── No unit on the project: set it first, then straight on. ──
  if (!units.length) {
    const shown = searchFilter(data.units, unitQuery, (u) => `${u.label} ${u.code}`);
    return (
      <Modal onClose={onClose} size="md">
        {header}
        <ModalBody className="space-y-3">
          <p className="text-[13px] text-[var(--color-text)]"><b>This project isn&apos;t on a unit yet.</b> The equipment comes from the unit&apos;s list, so the unit comes first.</p>
          {!canSetUnit ? (
            <p className="text-[13px] text-[var(--color-text-muted)]">The project owner, a co-owner or an admin sets it: in Setup › Unit &amp; equipment, or here.</p>
          ) : data.units.length === 0 ? (
            <p className="text-[13px] text-[var(--color-text-muted)]">There are no units in the Site Codebook yet. An admin adds them under Admin › Codebook.</p>
          ) : (
            <>
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" />
                <input autoFocus value={unitQuery} onChange={(e) => setUnitQuery(e.target.value)} placeholder="Which unit? (Transmix, 55…)" aria-label="Find the unit" className={`${field} pl-9`} />
              </div>
              <ul className="max-h-[50vh] overflow-y-auto rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
                {shown.map((u) => (
                  <li key={u.code}>
                    <button type="button" disabled={!!busy} onClick={() => void pickUnit(u)} className="w-full flex items-center gap-2 px-3 min-h-11 text-left text-[13.5px] hover:bg-[var(--color-surface-2)]">
                      <span className="font-mono text-[12px] text-[var(--color-text-muted)] w-8 shrink-0">{u.code}</span>
                      <span className="flex-1 min-w-0 font-semibold text-[var(--color-text)]">{u.label}</span>
                      {busy === `unit:${u.code}` && <Loader2 className="w-4 h-4 animate-spin" />}
                    </button>
                  </li>
                ))}
                {shown.length === 0 && <li className="px-3 py-3 text-[13px] text-[var(--color-text-muted)]">No unit matches.</li>}
              </ul>
            </>
          )}
          {err && <p className="text-[12.5px] text-rose-700 dark:text-rose-300">{err}</p>}
        </ModalBody>
      </Modal>
    );
  }

  // ── An admin adding equipment to the unit (and linking it). ──
  if (adding) {
    const check = checkNew({ tag: adding.tag, code: adding.code, unitCode: adding.unit }, registry);
    const suggested = idFor(adding.tag);
    const save = () => run("add", async () => {
      const a = await addToRegistry({ orgId: scope.orgId, tag: plainName(adding.tag).toUpperCase(), unitCode: adding.unit, createdBy: scope.userId ?? "", code: adding.code.trim() });
      invalidateAssetCache();
      await reload();
      const equipment = { assetId: a.id, tag: plainName(a.tag) };
      await setWorkOrderEquipment({ orgId: scope.orgId, projectId: scope.projectId, projectName: scope.projectName, ownerId: saveOn.id!, title: titleOf(saveOn), equipment, unit: adding.unit, actor, existing: data.edges });
      if (saveOn.id !== owner.id && requestOf(owner)) await clearEquipmentRequest(owner.id!, scope.userId);
      noteEquipmentSaved(scope.projectId, saveOn.id!, { equipment, unit: adding.unit });
      done(`Added ${plainName(a.tag)} (${adding.code.trim()}) to ${unitLabel(adding.unit)} and linked it`);
    });
    return (
      <Modal onClose={onClose} size="md">
        {header}
        <ModalBody className="space-y-3">
          <p className="text-[13px] font-bold text-[var(--color-text)]">Add equipment to the unit</p>
          <label className="block text-[12px] font-bold text-[var(--color-text-muted)]">Name
            <input autoFocus value={adding.tag} onChange={(e) => { const tag = e.target.value; setAdding({ ...adding, tag, code: adding.touched ? adding.code : idFor(tag) }); }} className={`${field} mt-1 font-mono uppercase`} placeholder="V-7" />
          </label>
          {units.length > 1 && (
            <label className="block text-[12px] font-bold text-[var(--color-text-muted)]">Unit
              <select value={adding.unit} onChange={(e) => setAdding({ ...adding, unit: e.target.value })} className={`${field} mt-1`}>
                {units.map((u) => <option key={u.code} value={u.code}>{unitName(u)}</option>)}
              </select>
            </label>
          )}
          <label className="block text-[12px] font-bold text-[var(--color-text-muted)]">ID
            <input value={adding.code} onChange={(e) => setAdding({ ...adding, code: e.target.value.toUpperCase(), touched: true })} className={`${field} mt-1 font-mono`} placeholder={`${adding.unit}10.19`} />
            <span className="block mt-1 font-normal text-[11.5px]">
              {suggested ? (adding.code.trim() === suggested ? `From the schedule's Equipment column for ${owner.workOrderRef ? `WO ${owner.workOrderRef}` : "this work order"}.` : `The schedule's Equipment column says ${suggested}.`)
                : "Type its ID as the plant numbers it. It isn't worked out from the name: the number after the point isn't the tag's number."}
            </span>
          </label>
          {units.length === 1 && <p className="text-[12px] text-[var(--color-text-muted)]">On {unitLabel(adding.unit)}.</p>}
          {check.kind === "same_name" && (
            <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-[12.5px] text-amber-900 dark:text-amber-200 space-y-2">
              <p><b>{plainName(check.asset.tag)} is already on {unitLabel(check.asset.unitCode)}</b>{check.asset.code ? ` (${check.asset.code})` : ""}. Link that one: adding it again would make two.</p>
              <button type="button" disabled={!!busy} onClick={() => void link(check.asset)} className={quiet}><Check className="w-4 h-4" /> Link {plainName(check.asset.tag)}</button>
            </div>
          )}
          {check.kind === "same_id" && <p className="text-[12.5px] text-rose-700 dark:text-rose-300"><AlertTriangle className="inline w-3.5 h-3.5 mr-1" />ID {adding.code.trim()} is already {plainName(check.asset.tag)} on {unitLabel(check.asset.unitCode)}. Each ID is one piece of equipment.</p>}
          {check.kind === "bad_id" && adding.code.trim() !== "" && <p className="text-[12.5px] text-rose-700 dark:text-rose-300">{check.words}</p>}
          {sameNameElsewhere(adding.tag, registry, [adding.unit]).length > 0 && check.kind !== "same_name" && (
            <p className="text-[12px] text-[var(--color-text-muted)]">{plainName(adding.tag)} is also on {sameNameElsewhere(adding.tag, registry, [adding.unit]).map((a) => `${unitLabel(a.unitCode)}${a.code ? ` (${a.code})` : ""}`).join(", ")}: a different piece, with its own ID.</p>
          )}
          {err && <p className="text-[12.5px] text-rose-700 dark:text-rose-300">{err}</p>}
        </ModalBody>
        <ModalFooter>
          <button type="button" onClick={() => setAdding(null)} className={quiet}>Back</button>
          <button type="button" disabled={!!busy || check.kind !== "ok"} onClick={() => void save()} className={btn}>
            {busy === "add" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Add and link
          </button>
        </ModalFooter>
      </Modal>
    );
  }

  // ── Pick from the unit's list. ──
  return (
    <Modal onClose={onClose} size="md">
      {header}
      <ModalBody className="space-y-3">
        {isStep && <p className="text-[12px] text-[var(--color-text-muted)]">For the whole work order: every step on it is on the same equipment.</p>}
        <p className="text-[12px] text-[var(--color-text-muted)]">
          From {units.map(unitName).join(" and ")}{current ? <> · now <b className="text-[var(--color-text)]">{current.tag}{current.assetId ? "" : " (not linked)"}</b></> : null}
        </p>
        {ask && (
          <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-[12.5px] text-amber-900 dark:text-amber-200 space-y-2">
            <p><b>{ask.tag}</b> asked for{ask.byName ? ` by ${ask.byName}` : ""}{ask.at ? ` on ${new Date(ask.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })}` : ""}: not in the unit&apos;s list yet.</p>
            <div className="flex flex-wrap gap-2">
              {isAdmin && !registry.some((a) => a.unitCode != null && unitCodes.includes(a.unitCode) && nameKey(a.tag) === nameKey(ask.tag)) && <button type="button" onClick={() => startAdd(ask.tag)} className={btn}><Plus className="w-4 h-4" /> Add {ask.tag}</button>}
              <button type="button" disabled={!!busy} onClick={() => void withdraw()} className={quiet}><X className="w-4 h-4" /> {isAdmin ? "Turn down" : "Withdraw the ask"}</button>
            </div>
          </div>
        )}
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" />
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="V-7, 5510.19 or a word" aria-label="Find equipment" className={`${field} pl-9`} />
        </div>
        {!query && guessHit && (
          <button type="button" disabled={!!busy} onClick={() => void link(guessHit)}
            className="w-full flex items-center gap-2 rounded-lg border-2 border-[var(--color-accent)] bg-[var(--color-accent-soft)] px-3 min-h-12 text-left">
            <span className="text-[10.5px] font-black uppercase tracking-wider text-[var(--color-accent)] shrink-0">From its name</span>
            <span className="flex-1 min-w-0 font-mono font-bold text-[14px] text-[var(--color-text)]">{plainName(guessHit.tag)}</span>
            <span className="font-mono text-[12px] text-[var(--color-text-muted)]">{guessHit.code ?? "no ID"}</span>
            {busy === guessHit.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4 text-[var(--color-accent)]" />}
          </button>
        )}
        <ul className="max-h-[42vh] overflow-y-auto rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
          {list.slice(0, 80).map((a) => {
            const on = current?.assetId === a.id;
            return (
              <li key={a.id}>
                <button type="button" disabled={!!busy} onClick={() => void link(a)} className={`w-full flex items-center gap-2 px-3 min-h-11 text-left hover:bg-[var(--color-surface-2)] ${on ? "bg-[var(--color-accent-soft)]" : ""}`}>
                  <span className="flex-1 min-w-0 font-mono font-bold text-[13.5px] text-[var(--color-text)]">{plainName(a.tag)}</span>
                  {units.length > 1 && <span className="text-[11px] text-[var(--color-text-muted)]">{a.unitCode}</span>}
                  <span className="font-mono text-[12px] text-[var(--color-text-muted)]">{a.code ?? "no ID"}</span>
                  {busy === a.id ? <Loader2 className="w-4 h-4 animate-spin" /> : on ? <Check className="w-4 h-4 text-[var(--color-accent)]" /> : null}
                </button>
              </li>
            );
          })}
          {list.length === 0 && (
            <li className="px-3 py-3 text-[13px] text-[var(--color-text-muted)]">
              {registry.some((a) => a.unitCode != null && unitCodes.includes(a.unitCode)) ? "Nothing on the unit matches." : `${units.map((u) => u.label).join(" and ")} ${units.length === 1 ? "has" : "have"} no equipment in the list yet.`}
            </li>
          )}
        </ul>
        {!want && (
          <p className="text-[12px] text-[var(--color-text-muted)]">Not listed? Type its name, like V-7, to {isAdmin ? "add it to the unit" : "ask an admin to add it"}.</p>
        )}
        {want && !wantHere && (
          <div className="rounded-lg border border-[var(--color-border)] px-3 py-2.5 space-y-2">
            <p className="text-[12.5px] text-[var(--color-text)]"><b className="font-mono">{want}</b> isn&apos;t in {units.length === 1 ? `${units[0].label}'s` : "the units'"} list.</p>
            {elsewhere.length > 0 && <p className="text-[12px] text-[var(--color-text-muted)]">{elsewhere.map((a) => `${plainName(a.tag)} on ${unitLabel(a.unitCode)}${a.code ? ` (${a.code})` : ""}`).join(", ")} {elsewhere.length === 1 ? "is a different piece" : "are different pieces"}: not this unit&apos;s.</p>}
            {isAdmin
              ? <button type="button" disabled={!!busy} onClick={() => startAdd(want)} className={btn}><Plus className="w-4 h-4" /> Add {want} to {units.length === 1 ? units[0].label : "the unit"}</button>
              : ask && nameKey(ask.tag) === nameKey(want)
                ? <p className="text-[12px] text-[var(--color-text-muted)]">Already asked for.</p>
                : <button type="button" disabled={!!busy} onClick={() => void askAdmin(want)} className={btn}>{busy === "ask" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Ask an admin to add {want}</button>}
            {!isAdmin && <p className="text-[11.5px] text-[var(--color-text-muted)]">Only admins add equipment to a unit, so nothing gets added twice or wrong.</p>}
          </div>
        )}
        {err && <p className="text-[12.5px] text-rose-700 dark:text-rose-300">{err}</p>}
      </ModalBody>
      <ModalFooter>
        <button type="button" disabled={!!busy} onClick={() => void setNone()} className={quiet}><Ban className="w-4 h-4" /> On no equipment</button>
        <button type="button" onClick={onClose} className={quiet}>Close</button>
      </ModalFooter>
    </Modal>
  );
}
