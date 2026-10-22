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
//
// DF-P18 (drafting-flow TIER-3 dw1; the DF-P7 editor residual): a NOTIFY-ONLY
// slot may be limited to some of the workspace's work classes — chips from
// its own list (lib/reviewModel.ts reviewClassOptions), shown only when the
// workspace configured work classes (DEC-90 ruling (1) for DF-P18); a
// consent-window slot's window length (working days) and reminder point are
// edited on the slot (blank = the defaults). lib/routingControl.ts validates
// both as before (a class limit on a blocking slot is refused).

import React, { useEffect, useState } from "react";
import { Route, Plus, Trash2, Loader2 } from "lucide-react";
import { searchOrgUsers, type OrgUser } from "@/lib/notifications";
import { appConfirm } from "@/components/providers/DialogProvider";
import {
  parseRoutingControl, readRoutingControlAt, setRoutingControl, validateRoutingDraft, reviewsInFlightUnder, MODE_LABEL, ROUTING_PARTIES, examinationOptInAllowed, notifyExaminationOptInAllowed,
  type RoutingControl, type RoutingLevel, type RoutingSlot, type RoutingSlotFill, type RoutingSlotMode,
} from "@/lib/routingControl";
import { CAPABILITY_DEFS, type CapabilityId } from "@/lib/capabilityPolicy";
import { ALL_ROLES, type OrgDraftingSettings } from "@/types/schema";
import { supabase } from "@/lib/supabase";
import { reviewClassOptions, type ReviewClassEntry } from "@/lib/reviewModel";
import { CONSENT_WINDOW_DEFAULT_DAYS, CONSENT_WINDOW_DEFAULT_WARN_FRACTION, CONSENT_WINDOW_MIN_DAYS, CONSENT_WINDOW_MAX_DAYS, CONSENT_WARN_FRACTION_MIN, CONSENT_WARN_FRACTION_MAX } from "@/lib/consentWindow";

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
  /** GAP-102 (DF-P20 fix pass 2): the controller's assurance opt-in — the
   *  slot's reviewer records what they examined (lib/routingControl.ts
   *  records_examination). Written only on a blocking slot; never set by
   *  default. */
  recordsExamination?: boolean;
  /** GAP-109 mechanism 2 (DF-P22): the controller's standing
   *  pre-authorization opt-in (lib/routingControl.ts
   *  accepts_preauthorization). Written only where an assurance check could
   *  ride and the slot is not one; never set by default. */
  acceptsPreauthorization?: boolean;
  /** DF-P5 fix pass: what a stored slot carries that this editor cannot show
   *  — a fill's other sources (a fill naming roles AND people), the
   *  override (`waivable_by`) and named alternate people. Carried through a
   *  save untouched, never silently dropped; the slot says they are there. */
  kept?: { fill?: RoutingSlotFill; waivableBy?: RoutingSlot["waivable_by"]; alternateUsers?: string[]; workClasses?: string[]; windowDays?: number; warnFraction?: number };
}

const emptySlot = (n: number): DraftSlot => ({
  kind: `slot-${n}`, label: "", mode: "blocking", fillKind: "roles", roles: [], users: [], capability: "",
  independentOf: ["drafter"], timeoutDays: "", alternateRoles: [],
});

/** GAP-102 (DF-P20 fix pass 2; reworded at the merge-time fix pass): what
 *  the assurance opt-in does — never a suggestion to add a sign-off. GAP-102
 *  says not to add a roster slot or a sign-off for assurance: the opt-in only
 *  records on a slot that already must sign off; a check that is told stays
 *  notify-only. Nothing is ticked for you. */
export const ASSURANCE_OPT_IN_HINT =
  "(the files and a note with each sign-off; a revision request must say why). It records on a slot that already must sign off and adds no sign-off — a check that only needs to be told stays \"Told, no sign-off\". The requester's own acceptance never records one.";

/** GAP-102 (DF-P20 merge-time fix pass): why a "must sign off" slot filled
 *  by an engineering capability offers no assurance check. */
export const ASSURANCE_ENGINEERING_NOTE = "No assurance check here — the engineering approval records its own sign-off.";

/** The fill a draft slot stores: what the editor shows over what it keeps. */
function draftFill(d: DraftSlot): RoutingSlot["fill"] {
  const shown: RoutingSlot["fill"] = d.fillKind === "requester" ? { identity: "requester" }
    : d.fillKind === "users" ? { users: d.users.map((u) => u.uid) }
    : d.fillKind === "capability" ? (d.capability ? { capability: d.capability } : {})
    : { roles: d.roles };
  return { ...(d.kept?.fill ?? {}), ...shown };
}

/** GAP-102 (DF-P20 merge-time fix pass): how a draft slot offers the
 *  assurance opt-in — "offer" (the checkbox), "engineering" (a blocking slot
 *  filled by an engineering capability: hidden, with the reason) or "none"
 *  (another mode, or the requester's own slot: hidden, as before). Pure;
 *  exported for tests. */
export function assuranceOptInFor(d: DraftSlot): "offer" | "engineering" | "none" {
  if (d.mode !== "blocking") return "none";
  // DF-P23 (the DF-P20 follow-up (c), DEC-31): decided by the parser's own
  // rule (examinationOptInAllowed) over the fill the editor writes back, not
  // by the shown fill kind — a slot shown as the requester's that is ALSO
  // filled by roles (or people, or a permission) keeps a stored opt-in
  // through the editor's next save, as the parser keeps it. The requester's
  // own slot alone still offers nothing.
  const fill = draftFill(d);
  if (examinationOptInAllowed({ mode: d.mode, fill })) return "offer";
  const requesterAlone = fill.identity === "requester" && !fill.roles?.length && !fill.users?.length && !fill.capability;
  return requesterAlone ? "none" : "engineering";
}

/** drafting-flow DF-P25 (GAP-102 ruling (2), the notify-only limb): how a
 *  draft NOTIFY-ONLY slot offers the examination opt-in — "offer" where the
 *  parser keeps it (lib/routingControl.ts notifyExaminationOptInAllowed),
 *  "none" otherwise. It adds no sign-off and no wait: its people's stop is a
 *  hold that records what they examined. Never offered on another mode
 *  (assuranceOptInFor decides a blocking slot, unchanged). Pure; exported
 *  for tests. */
export function notifyExaminationOptInFor(d: DraftSlot): "offer" | "none" {
  if (d.mode !== "notify_only") return "none";
  return notifyExaminationOptInAllowed({ mode: d.mode, fill: draftFill(d) }) ? "offer" : "none";
}

/** DF-P25 (review fix pass 4): a slot's mode changed in the editor. The
 *  examination opt-in means one thing on a "must sign off" slot (an
 *  assurance sign-off that must record what was examined) and another on a
 *  notify-only slot (a stop that is a hold with the record), so a mode
 *  change drops it — the controller ticks it again under the new meaning,
 *  never carried over unchosen. Pure; exported for tests. */
export function withSlotMode(d: DraftSlot, mode: RoutingSlotMode): DraftSlot {
  if (d.mode === mode) return d;
  const next: DraftSlot = { ...d, mode };
  delete next.recordsExamination;
  return next;
}

/** DF-P25: what the notify-only opt-in does — never a suggestion to add a
 *  sign-off (GAP-102: assurance as notice plus a stop). DF-P25 review fix
 *  pass 5: and never a claim the hold stops the request — it stops work on
 *  the source document only (GAP-116 owns a stop of the request). */
export const NOTIFY_EXAMINATION_HINT =
  "Its people are still only told — nobody waits on them and no sign-off is added. If one of them finds a problem, they can place a hold on the request's source document from the request page, and the hold records the files they examined and why. The hold stops work on the document (no new revision of it is published, and it is not transmitted or shared, until the hold is released); it does not stop the request — its review can still complete and its deliverable be issued. Its people need permission to place holds (Admin → Permissions → Action permissions, Place a hold).";

/** GAP-109 mechanism 2 (DF-P22): may this slot accept a standing
 *  pre-authorization? Exactly where the assurance opt-in may ride
 *  (assuranceOptInFor "offer"), and not while the slot IS an assurance
 *  check (lib/routingControl.ts preauthorizationOptInAllowed). */
export function preauthOptInFor(d: DraftSlot): "offer" | "none" {
  return assuranceOptInFor(d) === "offer" && !d.recordsExamination ? "offer" : "none";
}

export const PREAUTH_OPT_IN_HINT =
  "A person this slot names who recorded a standing pre-authorization covering the request (their own, signed, with an expiry) has it signed off for them — never on engineered work, and never for the last sign-off a review waits on.";

/** DF-P22 fix pass: said when the opt-in is set on a table with at most one
 *  "must sign off" slot — a pre-authorization never satisfies the last open
 *  sign-off, so on such a table it never acts. (Fix pass 2: an engineering
 *  sign-off a review gains never makes room for it — the gate that adds that
 *  slot makes the request engineered, and nothing applies on engineered
 *  work; lib/ticketPreauthorizationApply.ts.) */
export const PREAUTH_SINGLE_SLOT_NOTE =
  "This table has only one \u201cmust sign off\u201d slot, so a standing pre-authorization will never act here: a review always waits on at least one live sign-off. It can act only on a table with two or more \u201cmust sign off\u201d slots, and never on engineered work.";

export function preauthNeverActsNote(slots: readonly DraftSlot[]): string | null {
  if (slots.filter((d) => d.mode === "blocking").length > 1) return null;
  return slots.some((d) => d.acceptsPreauthorization && preauthOptInFor(d) === "offer") ? PREAUTH_SINGLE_SLOT_NOTE : null;
}

/** Draft slots → the stored shape (pure; exported for tests). */
export function draftToControl(slots: DraftSlot[]): RoutingControl {
  return {
    slots: slots.map((d): RoutingSlot => {
      const fill = draftFill(d);
      const altUsers = d.kept?.alternateUsers ?? [];
      const t = Number(d.timeoutDays);
      return {
        kind: d.kind.trim(),
        ...(d.label.trim() ? { label: d.label.trim() } : {}),
        mode: d.mode,
        fill,
        ...(d.independentOf.length ? { independent_of: d.independentOf } : {}),
        ...(d.alternateRoles.length || altUsers.length
          ? { alternates: { ...(d.alternateRoles.length ? { roles: d.alternateRoles } : {}), ...(altUsers.length ? { users: altUsers } : {}) } }
          : {}),
        ...(d.timeoutDays.trim() && Number.isInteger(t) ? { timeoutDays: t } : {}),
        ...(d.kept?.waivableBy ? { waivable_by: d.kept.waivableBy } : {}),
        // DF-P6 (GAP-102): a notify-only slot's work classes, kept as stored.
        ...(d.kept?.workClasses?.length ? { work_classes: d.kept.workClasses } : {}),
        // DF-P7 (merge-time fix pass): a consent slot's window, kept as stored
        // (a slot switched to another mode drops it — only a consent slot has one).
        ...(d.mode === "consent_window" && d.kept?.windowDays !== undefined ? { window_days: d.kept.windowDays } : {}),
        ...(d.mode === "consent_window" && d.kept?.warnFraction !== undefined ? { warn_fraction: d.kept.warnFraction } : {}),
        // DF-P20 fix pass 2: the assurance opt-in, on a blocking slot not
        // filled by the requester alone, nor (merge-time fix pass) by an
        // engineering capability — a slot switched away drops it.
        // DF-P25: or on a notify-only slot the parser keeps it on (its stop
        // is a hold with the record — no sign-off, no wait).
        ...(d.recordsExamination && (assuranceOptInFor(d) === "offer" || notifyExaminationOptInFor(d) === "offer") ? { records_examination: true as const } : {}),
        // DF-P22 (GAP-109 mechanism 2): the standing pre-authorization
        // opt-in, on a slot that can carry it (never an assurance check) — a
        // slot switched away, or made an assurance check, drops it.
        ...(d.acceptsPreauthorization && preauthOptInFor(d) === "offer" ? { accepts_preauthorization: true as const } : {}),
      };
    }),
  };
}

/** The stored shape → draft slots (pure; exported for tests). Whatever the
 *  editor cannot show is kept on the slot and written back as it was. */
export function controlToDraft(c: RoutingControl): DraftSlot[] {
  return c.slots.map((s) => {
    const fillKind: FillKind = s.fill.identity ? "requester" : s.fill.users?.length ? "users" : s.fill.capability ? "capability" : "roles";
    const shownKey = fillKind === "requester" ? "identity" : fillKind;
    const otherFill = Object.fromEntries(Object.entries(s.fill).filter(([k]) => k !== shownKey)) as RoutingSlotFill;
    const kept: NonNullable<DraftSlot["kept"]> = {
      ...(Object.keys(otherFill).length ? { fill: otherFill } : {}),
      ...(s.waivable_by ? { waivableBy: s.waivable_by } : {}),
      ...(s.alternates?.users?.length ? { alternateUsers: s.alternates.users } : {}),
      ...(s.work_classes?.length ? { workClasses: s.work_classes } : {}),
      ...(s.window_days !== undefined ? { windowDays: s.window_days } : {}),
      ...(s.warn_fraction !== undefined ? { warnFraction: s.warn_fraction } : {}),
    };
    return {
      kind: s.kind, label: s.label ?? "", mode: s.mode, fillKind,
      roles: s.fill.roles ?? [], users: (s.fill.users ?? []).map((uid) => ({ uid, name: null, email: uid } as unknown as OrgUser)),
      capability: s.fill.capability ?? "", independentOf: s.independent_of ?? [],
      timeoutDays: s.timeoutDays ? String(s.timeoutDays) : "", alternateRoles: s.alternates?.roles ?? [],
      ...(s.records_examination === true ? { recordsExamination: true } : {}),
      ...(s.accepts_preauthorization === true ? { acceptsPreauthorization: true } : {}),
      ...(Object.keys(kept).length ? { kept } : {}),
    };
  });
}

/** What a slot carries that the editor does not show, in words (or null).
 *  DF-P18: `shown` names what the editor now shows on this slot (the work
 *  classes on a notify-only slot when the workspace has a list; the window on
 *  a consent slot) — those are no longer "settings this editor does not
 *  show". Absent = as before. */
export function keptNote(d: Pick<DraftSlot, "kept">, shown?: { workClasses?: boolean; window?: boolean }): string | null {
  const k0 = d.kept;
  if (!k0) return null;
  const k = { ...k0 };
  if (shown?.workClasses) delete k.workClasses;
  if (shown?.window) { delete k.windowDays; delete k.warnFraction; }
  const parts: string[] = [];
  if (k.fill?.roles?.length) parts.push(`also filled by roles: ${k.fill.roles.join(", ")}`);
  if (k.fill?.users?.length) parts.push(`also filled by ${k.fill.users.length} named ${k.fill.users.length === 1 ? "person" : "people"}`);
  if (k.fill?.capability) parts.push(`also filled by the permission ${k.fill.capability}`);
  if (k.fill?.identity) parts.push("also filled by the requester");
  if (k.waivableBy) parts.push("an override (who may sign in place of the slot's people)");
  if (k.alternateUsers?.length) parts.push(`${k.alternateUsers.length} named alternate ${k.alternateUsers.length === 1 ? "person" : "people"}`);
  if (k.workClasses?.length) parts.push(`told only for the work classes ${k.workClasses.join(", ")}`);
  if (k.windowDays !== undefined) parts.push(`a consent window of ${k.windowDays} working day${k.windowDays === 1 ? "" : "s"}`);
  if (k.warnFraction !== undefined) parts.push(`a reminder at ${Math.round(k.warnFraction * 100)}% of the window`);
  return parts.length ? `This slot also carries settings this editor does not show — ${parts.join("; ")}. Saving keeps them as they are.` : null;
}

/** TIER-5 / DEC-29 (DF-P5 fix pass 4): what a saved routing table does, as
 *  the controller reads it — including to the requests already in review. */
export function routingSavedNote(levelWord: string): string {
  return `Routing saved. Every request submitted for review in this ${levelWord} from now on opens a sign-off roster. A request already in review here without a roster can no longer be approved the usual way: it needs a revision, and its resubmission opens the roster.`;
}

/** The question asked BEFORE a table is declared on a level that had none:
 *  how many requests in review lose their usual approval (pure; exported
 *  for tests). null when there is nothing to ask. */
export function inFlightConfirmMessage(levelWord: string, count: { ok: true; n: number; capped: boolean } | { ok: false; error: string }): string | null {
  if (count.ok && count.n === 0) return null;
  const tail = "can no longer be approved the usual way once this routing is saved — each needs a revision, and its resubmission opens a sign-off roster. Save the routing?";
  if (!count.ok) return `The requests in review in this ${levelWord} could not be counted (${count.error}). Any of them without a sign-off roster ${tail}`;
  const n = `${count.capped ? "At least " : ""}${count.n}`;
  return `${n} request${count.n === 1 && !count.capped ? " is" : "s are"} in review in this ${levelWord} (that you can see) without a sign-off roster. ${count.n === 1 && !count.capped ? "It" : "They"} ${tail}`;
}

const chip = (on: boolean) => `px-2 py-0.5 rounded-full text-[10px] font-bold border transition-colors ${on ? "bg-[var(--color-accent)] text-white border-transparent" : "bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:border-[var(--color-border-strong)]"}`;
const inp = "text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 outline-none focus:border-[var(--color-accent)]";

/** DF-P18: the class chips a notify-only slot offers — the workspace's work
 *  classes, plus any value the slot already stores that the list no longer
 *  names (so it can be seen and removed, never silently kept). Pure. */
export function workClassChoices(options: readonly ReviewClassEntry[], stored: readonly string[] | undefined): Array<{ value: string; label: string; unlisted?: boolean }> {
  const out: Array<{ value: string; label: string; unlisted?: boolean }> = options.map((o) => ({ value: o.value, label: o.label }));
  for (const v of stored ?? []) if (!options.some((o) => o.value === v)) out.push({ value: v, label: v, unlisted: true });
  return out;
}

/** DF-P18: a consent window's settings as typed → the stored numbers (blank
 *  = the default, so nothing is stored). Out-of-range input is kept as
 *  typed so lib/routingControl.ts names the problem. Pure. */
export function windowSettingsFromInput(daysText: string, percentText: string): { windowDays?: number; warnFraction?: number } {
  const out: { windowDays?: number; warnFraction?: number } = {};
  if (daysText.trim()) out.windowDays = Number(daysText.trim());
  if (percentText.trim()) out.warnFraction = Number(percentText.trim()) / 100;
  return out;
}

/** DF-P18 fix pass 3 (review minor): the patch ONE window field's edit makes
 *  — the days field sets only windowDays, the percent field only
 *  warnFraction (the key is always present; undefined = blank = cleared).
 *  The other stored setting is never re-derived from its displayed text, so
 *  editing the days keeps a stored fraction that is not a whole percent
 *  (0.333) exactly as stored. Pure. */
export function windowFieldPatch(field: "days" | "percent", text: string): { windowDays: number | undefined } | { warnFraction: number | undefined } {
  const v = field === "days" ? windowSettingsFromInput(text, "") : windowSettingsFromInput("", text);
  return field === "days" ? { windowDays: v.windowDays } : { warnFraction: v.warnFraction };
}

export default function RoutingControlSection({ level, id, orgId }: { level: RoutingLevel; id: string; orgId: string }) {
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [inherit, setInherit] = useState(true);
  const [slots, setSlots] = useState<DraftSlot[]>([]);
  const [storedError, setStoredError] = useState<string | null>(null);
  // DF-P5 fix pass 4: whether this level declared a table when it was read
  // (declaring one where there was none is what changes in-flight reviews).
  const [storedDeclared, setStoredDeclared] = useState(false);
  // DEC-90 ruling (2) (DF-P7 merge-time fix pass): the table stored here as
  // read, so a slot the editor did not touch is never held to a rule that
  // is only for new or changed slots.
  const [storedValue, setStoredValue] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [userQuery, setUserQuery] = useState<{ index: number; q: string; hits: OrgUser[] } | null>(null);
  // DF-P18 (TIER-3 dw1): the workspace's own work classes (empty = no chips —
  // a workspace with no list sees the slot exactly as before).
  const [workClassOptions, setWorkClassOptions] = useState<ReviewClassEntry[]>([]);
  useEffect(() => {
    if (!orgId) return;
    let alive = true;
    void (async () => {
      try {
        const { data, error } = await supabase.from("org_configurations").select("data").eq("org_id", orgId).eq("key", "drafting").maybeSingle();
        if (!alive || error) return;
        setWorkClassOptions(reviewClassOptions((data?.data ?? null) as Partial<OrgDraftingSettings> | null, "workClasses"));
      } catch { /* the chips are a convenience; the stored values stay in the note */ }
    })();
    return () => { alive = false; };
  }, [orgId]);

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
        setStoredDeclared(parsed !== null);
        setStoredValue(r.value);
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
  // DF-P18: edit what the slot keeps (work classes, window settings).
  const patchKept = (i: number, p: Partial<NonNullable<DraftSlot["kept"]>>) => setSlots((all) => all.map((s, j) => {
    if (j !== i) return s;
    const kept: NonNullable<DraftSlot["kept"]> = { ...(s.kept ?? {}), ...p };
    for (const key of Object.keys(kept) as Array<keyof typeof kept>) if (kept[key] === undefined) delete kept[key];
    const { kept: _drop, ...rest } = s;
    void _drop;
    return Object.keys(kept).length ? { ...rest, kept } : rest;
  }));

  const draft = inherit ? null : draftToControl(slots);
  const problem = inherit ? null : validateRoutingDraft(draft, storedValue);

  const levelWord = level === "library" ? "library" : level === "collection" ? "folder" : "document";

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      // TIER-5 / DEC-29 (DF-P5 fix pass 4): declaring a table where there
      // was none stops the usual approval of every request already in
      // review under this level without a roster — counted and asked first.
      if (!inherit && !storedDeclared) {
        const question = inFlightConfirmMessage(levelWord, await reviewsInFlightUnder(level, id));
        if (question && !(await appConfirm({ title: "Requests in review are affected", message: question, confirmLabel: "Save the routing", tone: "danger" }))) return;
      }
      await setRoutingControl({ level, id, control: draft });
      setStoredError(null);
      setStoredDeclared(!inherit);
      setStoredValue(draft);
      setMsg({ tone: "ok", text: inherit ? "Routing cleared — this level inherits." : routingSavedNote(levelWord) });
    } catch (e) {
      setMsg({ tone: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

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
                    <select aria-label="Mode" className={inp} value={s.mode} onChange={(e) => { const mode = e.target.value as RoutingSlotMode; setSlots((all) => all.map((x, j) => (j === i ? withSlotMode(x, mode) : x))); }}>
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
                  {s.mode === "notify_only" && workClassOptions.length > 0 && (
                    <div className="flex flex-wrap gap-1 items-center text-[11px]" data-testid="routing-slot-work-classes">
                      <span className="font-bold text-[var(--color-text-muted)] mr-1">Told only for work classes</span>
                      {workClassChoices(workClassOptions, s.kept?.workClasses).map((c) => {
                        const on = !!s.kept?.workClasses?.includes(c.value);
                        return (
                          <button key={c.value} type="button" className={chip(on)} title={c.unlisted ? "No longer on the workspace's list" : undefined}
                            onClick={() => {
                              const cur = s.kept?.workClasses ?? [];
                              const next = on ? cur.filter((x) => x !== c.value) : [...cur, c.value];
                              patchKept(i, { workClasses: next.length ? next : undefined });
                            }}>{c.label}{c.unlisted ? " (not listed)" : ""}</button>
                        );
                      })}
                      <span className="text-[var(--color-text-faint)]">{s.kept?.workClasses?.length ? "" : "— none picked: told for every request"}</span>
                    </div>
                  )}
                  {s.mode === "consent_window" && (
                    <div className="flex flex-wrap gap-2 items-center text-[11px]" data-testid="routing-slot-window">
                      <span className="font-bold text-[var(--color-text-muted)]">Window</span>
                      <input aria-label="Consent window working days" className={`${inp} w-16`} inputMode="numeric"
                        value={s.kept?.windowDays !== undefined ? String(s.kept.windowDays) : ""}
                        placeholder={String(CONSENT_WINDOW_DEFAULT_DAYS)}
                        onChange={(e) => patchKept(i, windowFieldPatch("days", e.target.value.replace(/[^0-9]/g, "")))} />
                      <span className="text-[var(--color-text-muted)]">working days ({CONSENT_WINDOW_MIN_DAYS}–{CONSENT_WINDOW_MAX_DAYS}); reminder at</span>
                      <input aria-label="Consent window reminder percent" className={`${inp} w-14`} inputMode="numeric"
                        value={s.kept?.warnFraction !== undefined ? String(Math.round(s.kept.warnFraction * 100)) : ""}
                        placeholder={String(Math.round(CONSENT_WINDOW_DEFAULT_WARN_FRACTION * 100))}
                        onChange={(e) => patchKept(i, windowFieldPatch("percent", e.target.value.replace(/[^0-9]/g, "")))} />
                      <span className="text-[var(--color-text-muted)]">% of it ({Math.round(CONSENT_WARN_FRACTION_MIN * 100)}–{Math.round(CONSENT_WARN_FRACTION_MAX * 100)}). Blank = the default.</span>
                    </div>
                  )}
                  {assuranceOptInFor(s) === "engineering" && (
                    <p className="text-[11px] text-[var(--color-text-faint)]" data-testid="routing-slot-records-examination-engineering">{ASSURANCE_ENGINEERING_NOTE}</p>
                  )}
                  {assuranceOptInFor(s) === "offer" && (
                    <label className="flex flex-wrap items-center gap-1.5 text-[11px]" data-testid="routing-slot-records-examination">
                      <input type="checkbox" checked={!!s.recordsExamination} onChange={(e) => patch(i, { recordsExamination: e.target.checked })} />
                      <span className="font-bold text-[var(--color-text-muted)]">Assurance check — its reviewer records what they examined</span>
                      <span className="text-[var(--color-text-faint)]">{ASSURANCE_OPT_IN_HINT}</span>
                    </label>
                  )}
                  {notifyExaminationOptInFor(s) === "offer" && (
                    <label className="flex flex-wrap items-center gap-1.5 text-[11px]" data-testid="routing-slot-records-examination-notify">
                      <input type="checkbox" checked={!!s.recordsExamination} onChange={(e) => patch(i, { recordsExamination: e.target.checked })} />
                      <span className="font-bold text-[var(--color-text-muted)]">Record what they examined when they place a hold</span>
                      <span className="text-[var(--color-text-faint)]">{NOTIFY_EXAMINATION_HINT}</span>
                    </label>
                  )}
                  {preauthOptInFor(s) === "offer" && (
                    <label className="flex flex-wrap items-center gap-1.5 text-[11px]" data-testid="routing-slot-accepts-preauthorization">
                      <input type="checkbox" checked={!!s.acceptsPreauthorization} onChange={(e) => patch(i, { acceptsPreauthorization: e.target.checked })} />
                      <span className="font-bold text-[var(--color-text-muted)]">Accepts a standing pre-authorization</span>
                      <span className="text-[var(--color-text-faint)]">{PREAUTH_OPT_IN_HINT}</span>
                    </label>
                  )}
                  {s.acceptsPreauthorization && preauthOptInFor(s) === "offer" && preauthNeverActsNote(slots) && (
                    <p className="text-[11px] text-amber-700" data-testid="routing-slot-preauthorization-inert">{preauthNeverActsNote(slots)}</p>
                  )}
                  {keptNote(s, { workClasses: s.mode === "notify_only" && workClassOptions.length > 0, window: s.mode === "consent_window" }) && <p className="text-[11px] text-[var(--color-text-muted)]" data-testid="routing-slot-kept">{keptNote(s, { workClasses: s.mode === "notify_only" && workClassOptions.length > 0, window: s.mode === "consent_window" })}</p>}
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
