"use client";

// RoutingControlSection — the review ROUTING of a library, folder or
// document (drafting-flow Round G, DF-P5; GAP-112, DEC-35, DEC-36, DEC-37).
// A sibling of the pre-publish review editor (ReviewControlModal), shown
// beside it: the routing decides who signs off a DRAFTING request's
// deliverable on the request's parallel roster; the review policy decides who
// signs off a REVISION before it publishes.
//
// A routing table is a list of slots, each named in the facility's own words
// (no vocabulary is baked in — DEC-35): who fills it (roles, named people, a
// capability, or the request's own requester), whether the request waits on
// it (must sign off) or only tells its people, which parties or other slots
// its signer must be independent of (DEC-37: one person may fill many slots;
// independence is a property of a slot), and alternates who may stand in
// after a number of days. "Inherit" clears the level (the folder / library
// above decides; nothing anywhere = today's routing). The database decides
// who may save (20261241) and records every change.

import React, { useEffect, useState } from "react";
import { Route, Plus, Trash2, Loader2 } from "lucide-react";
import { searchOrgUsers, type OrgUser } from "@/lib/notifications";
import {
  parseRoutingControl, readRoutingControlAt, setRoutingControl, validateRoutingDraft, MODE_LABEL, ROUTING_PARTIES,
  type RoutingControl, type RoutingLevel, type RoutingSlot, type RoutingSlotMode,
} from "@/lib/routingControl";
import { CAPABILITY_DEFS, type CapabilityId } from "@/lib/capabilityPolicy";
import { ALL_ROLES } from "@/types/schema";

type FillKind = "roles" | "users" | "capability" | "requester";

interface DraftSlot {
  kind: string;
  label: string;
  mode: RoutingSlotMode;
  fillKind: FillKind;
  roles: string[];
  users: OrgUser[];
  capability: CapabilityId | "";
  independentOf: string[];
  timeoutDays: string;
  alternateRoles: string[];
}

const emptySlot = (n: number): DraftSlot => ({
  kind: `slot-${n}`, label: "", mode: "blocking", fillKind: "roles", roles: [], users: [], capability: "",
  independentOf: ["drafter"], timeoutDays: "", alternateRoles: [],
});

/** Draft slots → the stored shape (pure; exported for tests). */
export function draftToControl(slots: DraftSlot[]): RoutingControl {
  return {
    slots: slots.map((d): RoutingSlot => {
      const fill: RoutingSlot["fill"] = d.fillKind === "requester" ? { identity: "requester" }
        : d.fillKind === "users" ? { users: d.users.map((u) => u.uid) }
        : d.fillKind === "capability" ? (d.capability ? { capability: d.capability } : {})
        : { roles: d.roles };
      const t = Number(d.timeoutDays);
      return {
        kind: d.kind.trim(),
        ...(d.label.trim() ? { label: d.label.trim() } : {}),
        mode: d.mode,
        fill,
        ...(d.independentOf.length ? { independent_of: d.independentOf } : {}),
        ...(d.alternateRoles.length ? { alternates: { roles: d.alternateRoles } } : {}),
        ...(d.timeoutDays.trim() && Number.isInteger(t) ? { timeoutDays: t } : {}),
      };
    }),
  };
}

function controlToDraft(c: RoutingControl): DraftSlot[] {
  return c.slots.map((s) => ({
    kind: s.kind, label: s.label ?? "", mode: s.mode,
    fillKind: s.fill.identity ? "requester" : s.fill.users?.length ? "users" : s.fill.capability ? "capability" : "roles",
    roles: s.fill.roles ?? [], users: (s.fill.users ?? []).map((uid) => ({ uid, name: null, email: uid } as unknown as OrgUser)),
    capability: s.fill.capability ?? "", independentOf: s.independent_of ?? [],
    timeoutDays: s.timeoutDays ? String(s.timeoutDays) : "", alternateRoles: s.alternates?.roles ?? [],
  }));
}

const chip = (on: boolean) => `px-2 py-0.5 rounded-full text-[10px] font-bold border transition-colors ${on ? "bg-[var(--color-accent)] text-white border-transparent" : "bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:border-[var(--color-border-strong)]"}`;
const inp = "text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 outline-none focus:border-[var(--color-accent)]";

export default function RoutingControlSection({ level, id, orgId }: { level: RoutingLevel; id: string; orgId: string }) {
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [inherit, setInherit] = useState(true);
  const [slots, setSlots] = useState<DraftSlot[]>([]);
  const [storedError, setStoredError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [userQuery, setUserQuery] = useState<{ index: number; q: string; hits: OrgUser[] } | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      setLoading(true);
      const r = await readRoutingControlAt(level, id);
      if (!alive) return;
      if (!r.ok) {
        setUnavailable(r.missing ? "Review routing needs database update 20261241 — until it is applied, requests here are routed the usual way." : `The routing could not be read: ${r.error}`);
      } else {
        const parsed = parseRoutingControl(r.value);
        if (parsed === null) { setInherit(true); setSlots([]); }
        else if (parsed.ok) { setInherit(false); setSlots(controlToDraft(parsed.control)); }
        else { setInherit(false); setSlots([]); setStoredError(parsed.error); }
      }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [level, id]);

  useEffect(() => {
    if (!userQuery || !userQuery.q.trim()) return;
    let alive = true;
    void (async () => {
      try {
        const hits = await searchOrgUsers(orgId, userQuery.q.trim());
        if (alive) setUserQuery((u) => (u ? { ...u, hits } : u));
      } catch { /* search is a convenience */ }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userQuery?.q, orgId]);

  const patch = (i: number, p: Partial<DraftSlot>) => setSlots((all) => all.map((s, j) => (j === i ? { ...s, ...p } : s)));
  const draft = inherit ? null : draftToControl(slots);
  const problem = inherit ? null : validateRoutingDraft(draft);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await setRoutingControl({ level, id, control: draft });
      setStoredError(null);
      setMsg({ tone: "ok", text: inherit ? "Routing cleared — this level inherits." : "Routing saved. It applies from each request's next submission for review." });
    } catch (e) {
      setMsg({ tone: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const levelWord = level === "library" ? "library" : level === "collection" ? "folder" : "document";

  return (
    <section data-testid="routing-control-section" className="rounded-xl border border-[var(--color-border)] p-3 space-y-3">
      <div className="flex items-center gap-2">
        <Route className="w-4 h-4 text-[var(--color-accent)]" />
        <div className="text-sm font-black text-[var(--color-text)]">Request review routing</div>
        {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
      </div>
      <p className="text-[11px] text-[var(--color-text-muted)]">
        Who signs off a drafting request&apos;s deliverable before it is issued, for requests in this {levelWord}. Every slot is signed in any order — adding a slot adds no wait. Leave it on inherit and requests follow the {levelWord} above, or the usual request workflow when nothing is set anywhere.
      </p>
      {unavailable ? (
        <p className="text-xs text-amber-800">{unavailable}</p>
      ) : (
        <>
          {storedError && <p className="text-xs text-red-700">The routing stored here can&apos;t be used ({storedError}) — requests here are refused until it is corrected or cleared.</p>}
          <label className="flex items-center gap-2 text-xs font-bold text-[var(--color-text)]">
            <input type="checkbox" checked={inherit} onChange={(e) => setInherit(e.target.checked)} /> Inherit (no routing set at this level)
          </label>
          {!inherit && (
            <div className="space-y-3">
              {slots.map((s, i) => (
                <div key={i} className="rounded-lg border border-[var(--color-border)] p-2 space-y-2" data-testid="routing-slot">
                  <div className="flex flex-wrap gap-2 items-center">
                    <input aria-label="Slot key" className={`${inp} w-36`} value={s.kind} onChange={(e) => patch(i, { kind: e.target.value })} placeholder="key (your words)" />
                    <input aria-label="Slot label" className={`${inp} flex-1 min-w-[10rem]`} value={s.label} onChange={(e) => patch(i, { label: e.target.value })} placeholder="What your facility calls it" />
                    <select aria-label="Mode" className={inp} value={s.mode} onChange={(e) => patch(i, { mode: e.target.value as RoutingSlotMode })}>
                      {(["blocking", "consent_window", "notify_only"] as RoutingSlotMode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
                    </select>
                    <button type="button" aria-label="Remove slot" onClick={() => setSlots((all) => all.filter((_, j) => j !== i))} className="p-1 text-[var(--color-text-faint)] hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
                  </div>
                  <div className="flex flex-wrap gap-1 items-center text-[11px]">
                    <span className="font-bold text-[var(--color-text-muted)] mr-1">Filled by</span>
                    {(["roles", "users", "capability", "requester"] as FillKind[]).map((k) => (
                      <button key={k} type="button" className={chip(s.fillKind === k)} onClick={() => patch(i, { fillKind: k })}>
                        {k === "roles" ? "Roles" : k === "users" ? "Named people" : k === "capability" ? "A permission" : "The requester"}
                      </button>
                    ))}
                  </div>
                  {s.fillKind === "roles" && (
                    <div className="flex flex-wrap gap-1">
                      {ALL_ROLES.map((r) => <button key={r} type="button" className={chip(s.roles.includes(r))} onClick={() => patch(i, { roles: s.roles.includes(r) ? s.roles.filter((x) => x !== r) : [...s.roles, r] })}>{r}</button>)}
                    </div>
                  )}
                  {s.fillKind === "users" && (
                    <div className="space-y-1">
                      <div className="flex flex-wrap gap-1">{s.users.map((u) => <span key={u.uid} className={chip(true)}>{u.name || u.email}</span>)}</div>
                      <input className={`${inp} w-full`} placeholder="Search people…" value={userQuery?.index === i ? userQuery.q : ""} onChange={(e) => setUserQuery({ index: i, q: e.target.value, hits: [] })} />
                      {userQuery?.index === i && userQuery.hits.length > 0 && (
                        <div className="rounded border border-[var(--color-border)] max-h-24 overflow-y-auto">
                          {userQuery.hits.filter((h) => !s.users.some((u) => u.uid === h.uid)).map((h) => (
                            <button key={h.uid} type="button" className="w-full text-left px-2 py-1 text-xs hover:bg-[var(--color-surface-2)] flex items-center gap-1" onClick={() => { patch(i, { users: [...s.users, h] }); setUserQuery(null); }}><Plus className="w-3 h-3" /> {h.name || h.email}</button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {s.fillKind === "capability" && (
                    <select aria-label="Permission" className={inp} value={s.capability} onChange={(e) => patch(i, { capability: e.target.value as CapabilityId })}>
                      <option value="">Choose a permission…</option>
                      {CAPABILITY_DEFS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                    </select>
                  )}
                  <div className="flex flex-wrap gap-1 items-center text-[11px]">
                    <span className="font-bold text-[var(--color-text-muted)] mr-1">Must be someone other than</span>
                    {[...ROUTING_PARTIES, ...slots.filter((o, j) => j !== i && o.kind.trim()).map((o) => o.kind.trim())].map((k) => (
                      <button key={k} type="button" className={chip(s.independentOf.includes(k))} onClick={() => patch(i, { independentOf: s.independentOf.includes(k) ? s.independentOf.filter((x) => x !== k) : [...s.independentOf, k] })}>
                        {k === "drafter" ? "the drafter" : k === "requester" ? "the requester" : `whoever signs "${slots.find((o) => o.kind.trim() === k)?.label || k}"`}
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-1 items-center text-[11px]">
                    <span className="font-bold text-[var(--color-text-muted)] mr-1">Alternates (roles) after</span>
                    <input aria-label="Alternate after days" className={`${inp} w-14`} value={s.timeoutDays} onChange={(e) => patch(i, { timeoutDays: e.target.value.replace(/[^0-9]/g, "") })} placeholder="days" />
                    {ALL_ROLES.map((r) => <button key={r} type="button" className={chip(s.alternateRoles.includes(r))} onClick={() => patch(i, { alternateRoles: s.alternateRoles.includes(r) ? s.alternateRoles.filter((x) => x !== r) : [...s.alternateRoles, r] })}>{r}</button>)}
                  </div>
                </div>
              ))}
              <button type="button" onClick={() => setSlots((all) => [...all, emptySlot(all.length + 1)])} className="inline-flex items-center gap-1 text-xs font-bold text-[var(--color-accent)]"><Plus className="w-3.5 h-3.5" /> Add a slot</button>
            </div>
          )}
          {problem && <p className="text-xs text-amber-800">{problem}</p>}
          {msg && <p role="status" className={`text-xs ${msg.tone === "ok" ? "text-green-700" : "text-red-700"}`}>{msg.text}</p>}
          <button type="button" disabled={busy || loading || !!problem} onClick={save}
            className="px-3 py-1.5 rounded-lg text-xs font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
            {busy ? "Saving…" : "Save routing"}
          </button>
        </>
      )}
    </section>
  );
}
