// lib/routingControl.ts
//
// drafting-flow Round G, DF-P5 ROSTER — GAP-112, the routing table (DEC-35,
// DEC-36, DEC-37). Routing is DATA: a `routing_control` JSONB column on
// `libraries`, `collections` and `documents` (migration 20261241, the
// doc_class shape), resolved along THE container chain — document → its
// folder → that folder's ancestors (nearest first) → library, most specific
// DEFINED level wins — through lib/containerChain.ts. There is no second walk.
//
// A routing table is a list of SLOTS. Code knows slot PROPERTIES (mode, how
// it is filled, which parties it must be independent of, a timeout for its
// alternates, who may stand in as an override); it never knows what a
// facility calls a slot. `kind` and `label` are the facility's own words.
//
// Two properties are copied from lib/docClass.ts, not just its shape:
//   1. Declared, never guessed. Nothing here infers a slot from a title, a
//      filename or a request type. A ticket with no declared routing is
//      UNCONFIGURED and runs today's state machine, unchanged.
//   2. Fail closed on a transient failure. A chain read that fails THROWS —
//      "we couldn't read the routing" must never resolve as "no routing",
//      which is how a review gate quietly turns itself off. The workflow
//      route refuses the transition with a legible reason.
//      A declaration that is there but malformed is not "unconfigured"
//      either: it is reported as `invalid` and the route refuses with the
//      reason, so a typo in a routing table never silently drops a reviewer.
//
// Pre-migration tolerance (DEC-30): before 20261241 is pasted the column does
// not exist; the read answers 42703 / PGRST204 and every ticket is
// unconfigured — today's routing, exactly.
//
// The SEED (DEC-90 ruling (2), 2026-10-21): an org that has configured
// nothing routes byte-for-byte as today. `SEEDED_ROUTING` / `seededSlotsFor`
// express today's serial behaviour as slots — requester acceptance (the
// requester's identity, blocking), engineering (an engineer, blocking where
// the engineer gate applies, independent of the drafter), and a management
// override (optional) — so the roster panel can say who must act on an
// unconfigured ticket. The seed is DESCRIPTIVE: the transitions of an
// unconfigured ticket are the state machine's own (lib/workflow.ts), and a
// test pins the seed against it. The name-matching helpers
// (isEngineerRole / isManagementRole / isDocCtrlRole) are quarantined as the
// seed's predicates, not deleted (DEC-35).

import { supabase } from "@/lib/supabase";
import { checkedWrite } from "@/lib/checkedWrite";
import { loadContainerChain, firstDefinedInChain, type ContainerChain } from "@/lib/containerChain";
import type { CapabilityId } from "@/lib/capabilityPolicy";
import { currentRoster } from "@/lib/workflow";
import { parseSourceDocument } from "@/lib/sourceDocRef";
import type { Ticket } from "@/types/schema";
import {
  CONSENT_REFUSED_CAPABILITIES, CONSENT_WINDOW_MIN_DAYS, CONSENT_WINDOW_MAX_DAYS, CONSENT_WINDOW_DEFAULT_DAYS,
  CONSENT_WARN_FRACTION_MIN, CONSENT_WARN_FRACTION_MAX, CONSENT_WINDOW_MIGRATION,
} from "@/lib/consentWindow";

export type RoutingSlotMode = "blocking" | "consent_window" | "notify_only";
export const ROUTING_SLOT_MODES: readonly RoutingSlotMode[] = ["blocking", "consent_window", "notify_only"];

/** The parties a slot may name in `independent_of` besides another slot's
 *  kind: the deliverable's producer and its requester (DEC-37). */
export const ROUTING_PARTIES = ["drafter", "requester"] as const;
export type RoutingParty = (typeof ROUTING_PARTIES)[number];

/** How a slot is filled. Exactly one of the four is the slot's primary
 *  source; `identity: "requester"` is the ticket's own requester. */
export interface RoutingSlotFill {
  roles?: string[];
  users?: string[];
  capability?: CapabilityId;
  identity?: "requester";
}

export interface RoutingSlot {
  /** The facility's own key for the slot ("qa", "insp", "process-safety"…). */
  kind: string;
  /** What the facility calls it, shown in the UI. Defaults to `kind`. */
  label?: string;
  mode: RoutingSlotMode;
  fill: RoutingSlotFill;
  /** Who may stand in once the slot has been open `timeoutDays`. */
  alternates?: { roles?: string[]; users?: string[] };
  /** Days the slot waits on its primaries before its alternates may act. */
  timeoutDays?: number;
  /** DEC-37: parties ("drafter", "requester") or other slot kinds this
   *  slot's occupant must not also be (enforced at the DEC-12 threshold). */
  independent_of?: string[];
  /** Who may sign the slot as an OVERRIDE (optional for them; recorded as
   *  an override). Absent = nobody: a configured blocking slot is blocking. */
  waivable_by?: { roles?: string[]; capability?: CapabilityId };
  /** GAP-102 / TIER-3 (DF-P6): a NOTIFY-ONLY slot may name the work classes
   *  it applies to (the workspace's own values — DEC-35) — e.g. the people
   *  told of every issue of one kind of work. Absent = every request. A
   *  request with no work class gets the slot (the safe reading: told).
   *  Refused on a blocking or consent slot: a condition must never be able
   *  to drop a sign-off (routingForWorkClass). */
  work_classes?: string[];
  /** GAP-109 (DF-P7): a CONSENT-WINDOW slot's window — whole working days
   *  (1–30; default 3) and the fraction of it at which the people asked are
   *  reminded (0.1–0.9; default 2/3). Refused on any other mode. */
  window_days?: number;
  warn_fraction?: number;
  /** GAP-109 (DF-P7 fix pass 3): the post-DF-P7 opt-in — stamped by
   *  setRoutingControl on every consent-window slot a controller saves
   *  under the consent-window label. A consent_window slot stored before it
   *  (when the editor said "waits like a sign-off") has none, and keeps
   *  waiting like a sign-off (lib/consentWindow.ts planConsentWindow). Kept
   *  only on a consent-window slot. */
  consent_confirmed?: true;
  /** GAP-102 (DF-P20 fix pass 2): the controller's explicit opt-in — this
   *  BLOCKING slot is an assurance check, and its reviewer records what they
   *  examined with the sign-off or the revision request it backs
   *  (lib/assuranceExamination.ts isAssuranceSlot). Absent = the slot
   *  behaves and renders exactly as before (no slot is made one by
   *  inference). Kept only where examinationOptInAllowed says it can ride:
   *  dropped (never refused — merge-time fix pass) on a notify-only or
   *  consent-window slot (no sign-off to record it on), on a slot only the
   *  requester fills (their own acceptance is not an assurance check) and on
   *  a slot filled by an engineering capability (the engineering approval
   *  records its own sign-off); the editor refuses a save that writes one. */
  records_examination?: true;
  /** GAP-109 mechanism 2 (drafting-flow DF-P22): the controller's explicit
   *  opt-in — this BLOCKING slot accepts a standing pre-authorization: an
   *  occupant who recorded one whose scope matches the request has the slot
   *  satisfied by it, recorded on the request's history and audit row
   *  (lib/ticketPreauthorization.ts). Absent = the slot behaves exactly as
   *  before. Kept only where preauthorizationOptInAllowed says it can ride —
   *  never an engineering slot, never an assurance slot (records_examination
   *  wins), never a notice or a consent window, never the requester's own
   *  acceptance; dropped silently otherwise (a stored value never makes the
   *  table invalid), and the editor refuses a save that writes one. */
  accepts_preauthorization?: true;
}

export interface RoutingControl {
  slots: RoutingSlot[];
}

/** Where along the chain the effective declaration was found. */
export type RoutingLevel = "document" | "collection" | "library";

export type EffectiveRouting =
  | { state: "unconfigured" }
  | { state: "configured"; control: RoutingControl; level: RoutingLevel }
  | { state: "invalid"; error: string; level: RoutingLevel };

const KIND_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,59}$/;
const strList = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]).map((s) => s.trim()).filter(Boolean) : null;

/** GAP-102 (DF-P20 merge-time fix pass): the slots the assurance opt-in
 *  (`records_examination`) can ride — a BLOCKING slot that is not filled by
 *  the requester alone (their own acceptance is not an assurance check) and
 *  not filled by an engineering capability (the engineering approval records
 *  its own sign-off; lib/assuranceExamination.ts isAssuranceSlot never treats
 *  it as one). CONSENT_REFUSED_CAPABILITIES is lib/ticketRoster.ts
 *  ENGINEERING_CAPABILITIES (pinned equal by a test). Pure. */
export function examinationOptInAllowed(slot: Pick<RoutingSlot, "mode" | "fill">): boolean {
  if (slot.mode !== "blocking") return false;
  const f = slot.fill ?? {};
  if (f.identity === "requester" && !f.roles?.length && !f.users?.length && !f.capability) return false;
  if (f.capability && CONSENT_REFUSED_CAPABILITIES.includes(f.capability)) return false;
  return true;
}

/** GAP-109 mechanism 2 (drafting-flow DF-P22; DEC-90 ruling (2)): the slots
 *  the standing pre-authorization opt-in (`accepts_preauthorization`) can
 *  ride — exactly the slots the assurance opt-in can (a BLOCKING slot not
 *  filled by the requester alone nor by an engineering capability), less an
 *  assurance slot itself (its reviewer records what they examined on each
 *  request; a standing consent examines nothing). Pure. */
export function preauthorizationOptInAllowed(slot: Pick<RoutingSlot, "mode" | "fill" | "records_examination">): boolean {
  return examinationOptInAllowed(slot) && slot.records_examination !== true;
}

/** A declared level is any non-null value (NULL = inherit). */
export const isRoutingDeclared = (v: unknown): v is Record<string, unknown> => v !== null && v !== undefined;

/**
 * Validate a stored routing_control. NULL / undefined is `null` (inherit).
 * Anything else is either a well-formed RoutingControl or an error naming
 * what is wrong — never silently trimmed into something that requires less.
 */
export function parseRoutingControl(raw: unknown): { ok: true; control: RoutingControl } | { ok: false; error: string } | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "the routing table is not an object" };
  const slotsRaw = (raw as { slots?: unknown }).slots;
  if (!Array.isArray(slotsRaw) || slotsRaw.length === 0) return { ok: false, error: "the routing table declares no slots" };
  const slots: RoutingSlot[] = [];
  const kinds = new Set<string>();
  for (const [i, s] of slotsRaw.entries()) {
    const where = `slot ${i + 1}`;
    if (!s || typeof s !== "object") return { ok: false, error: `${where} is not an object` };
    const o = s as Record<string, unknown>;
    const kind = typeof o.kind === "string" ? o.kind.trim() : "";
    if (!KIND_RE.test(kind)) return { ok: false, error: `${where} has no usable kind (letters, digits, space, _ . -; up to 60)` };
    if ((ROUTING_PARTIES as readonly string[]).includes(kind)) return { ok: false, error: `${where}: "${kind}" is reserved for the ticket's own party` };
    if (kinds.has(kind)) return { ok: false, error: `${where}: the kind "${kind}" is used twice` };
    kinds.add(kind);
    if (!(ROUTING_SLOT_MODES as readonly unknown[]).includes(o.mode)) return { ok: false, error: `slot "${kind}" has no valid mode (blocking, consent_window or notify_only)` };
    const f = (o.fill ?? null) as Record<string, unknown> | null;
    if (!f || typeof f !== "object") return { ok: false, error: `slot "${kind}" says nothing about who fills it` };
    const fill: RoutingSlotFill = {};
    const roles = f.roles === undefined ? null : strList(f.roles);
    const users = f.users === undefined ? null : strList(f.users);
    if (f.roles !== undefined && roles === null) return { ok: false, error: `slot "${kind}": fill.roles is not a list of roles` };
    if (f.users !== undefined && users === null) return { ok: false, error: `slot "${kind}": fill.users is not a list of people` };
    if (roles?.length) fill.roles = roles;
    if (users?.length) fill.users = users;
    if (typeof f.capability === "string" && f.capability.trim()) fill.capability = f.capability.trim() as CapabilityId;
    if (f.identity === "requester") fill.identity = "requester";
    else if (f.identity !== undefined) return { ok: false, error: `slot "${kind}": the only identity a slot can name is "requester"` };
    if (!fill.roles && !fill.users && !fill.capability && !fill.identity) return { ok: false, error: `slot "${kind}" names nobody to fill it` };
    const slot: RoutingSlot = { kind, mode: o.mode as RoutingSlotMode, fill };
    if (typeof o.label === "string" && o.label.trim()) slot.label = o.label.trim().slice(0, 80);
    if (o.alternates !== undefined && o.alternates !== null) {
      const a = o.alternates as Record<string, unknown>;
      const ar = a.roles === undefined ? [] : strList(a.roles);
      const au = a.users === undefined ? [] : strList(a.users);
      if (ar === null || au === null) return { ok: false, error: `slot "${kind}": alternates must be lists of roles / people` };
      if (ar.length || au.length) slot.alternates = { ...(ar.length ? { roles: ar } : {}), ...(au.length ? { users: au } : {}) };
    }
    if (o.timeoutDays !== undefined && o.timeoutDays !== null) {
      const t = o.timeoutDays;
      if (typeof t !== "number" || !Number.isInteger(t) || t < 1 || t > 365) return { ok: false, error: `slot "${kind}": timeoutDays is a whole number of days from 1 to 365` };
      slot.timeoutDays = t;
    }
    if (o.independent_of !== undefined && o.independent_of !== null) {
      const ind = strList(o.independent_of);
      if (ind === null) return { ok: false, error: `slot "${kind}": independent_of is not a list` };
      if (ind.length) slot.independent_of = [...new Set(ind)];
    }
    if (o.waivable_by !== undefined && o.waivable_by !== null) {
      const w = o.waivable_by as Record<string, unknown>;
      const wr = w.roles === undefined ? [] : strList(w.roles);
      if (wr === null) return { ok: false, error: `slot "${kind}": waivable_by.roles is not a list` };
      const wc = typeof w.capability === "string" && w.capability.trim() ? (w.capability.trim() as CapabilityId) : undefined;
      if (wr.length || wc) slot.waivable_by = { ...(wr.length ? { roles: wr } : {}), ...(wc ? { capability: wc } : {}) };
    }
    if (o.work_classes !== undefined && o.work_classes !== null) {
      const wcl = strList(o.work_classes);
      if (wcl === null) return { ok: false, error: `slot "${kind}": work_classes is not a list of work classes` };
      if (wcl.length && slot.mode !== "notify_only") return { ok: false, error: `slot "${kind}": only a notify-only slot can be limited to some work classes — a sign-off applies to every request` };
      if (wcl.length) slot.work_classes = [...new Set(wcl)];
    }
    // GAP-109 (DF-P7): only a consent-window slot has a window.
    for (const key of ["window_days", "warn_fraction"] as const) {
      if (o[key] === undefined || o[key] === null) continue;
      if (slot.mode !== "consent_window") return { ok: false, error: `slot "${kind}": only a consent-window slot has a ${key === "window_days" ? "window length" : "reminder point"}` };
      const v = o[key];
      if (key === "window_days") {
        if (typeof v !== "number" || !Number.isInteger(v) || v < CONSENT_WINDOW_MIN_DAYS || v > CONSENT_WINDOW_MAX_DAYS) return { ok: false, error: `slot "${kind}": window_days is a whole number of working days from ${CONSENT_WINDOW_MIN_DAYS} to ${CONSENT_WINDOW_MAX_DAYS}` };
        slot.window_days = v;
      } else {
        if (typeof v !== "number" || !(v >= CONSENT_WARN_FRACTION_MIN && v <= CONSENT_WARN_FRACTION_MAX)) return { ok: false, error: `slot "${kind}": warn_fraction is a fraction of the window from ${CONSENT_WARN_FRACTION_MIN} to ${CONSENT_WARN_FRACTION_MAX}` };
        slot.warn_fraction = v;
      }
    }
    // Fix pass 3: the opt-in rides only a consent-window slot (a slot
    // switched to another mode simply drops it).
    if (o.consent_confirmed === true && slot.mode === "consent_window") slot.consent_confirmed = true;
    // GAP-102 (DF-P20 fix pass 2): the assurance opt-in — a blocking slot a
    // reviewer other than the requester signs. Never inferred. Merge-time
    // fix pass (DEC-90, no regression): read exactly like consent_confirmed —
    // kept only when it is `true` on a slot that can carry it, dropped
    // silently otherwise. A stored value in the wrong place never makes the
    // table invalid (that would refuse every submission and routed approval
    // in the library); the editor refuses one at save (validateRoutingDraft).
    if (o.records_examination === true && examinationOptInAllowed(slot)) slot.records_examination = true;
    // GAP-109 mechanism 2 (DF-P22): the standing pre-authorization opt-in —
    // read exactly like the assurance opt-in: kept only when `true` on a
    // slot that can carry it, dropped silently otherwise (never refused).
    if (o.accepts_preauthorization === true && preauthorizationOptInAllowed(slot)) slot.accepts_preauthorization = true;
    slots.push(slot);
  }
  // independent_of may name a party or another slot of THIS table.
  for (const s of slots) {
    for (const k of s.independent_of ?? []) {
      if (k === s.kind) return { ok: false, error: `slot "${s.kind}" cannot be independent of itself` };
      if (!(ROUTING_PARTIES as readonly string[]).includes(k) && !kinds.has(k)) {
        return { ok: false, error: `slot "${s.kind}" is independent of "${k}", which is neither a party (drafter, requester) nor a slot of this table` };
      }
    }
  }
  // A routing table that blocks on nobody would let a draft through with no
  // review at all — a widening a typo could cause. Refused, never assumed.
  if (!slots.some((s) => s.mode !== "notify_only")) return { ok: false, error: "the routing table has no blocking slot (every slot only notifies)" };
  return { ok: true, control: { slots } };
}

/** GAP-102 / TIER-3 (DF-P6): the table as it applies to ONE request — a
 *  notify-only slot limited to some work classes is left out for a request
 *  of another class (kept for an unclassified one). Blocking and consent
 *  slots are never conditional (parseRoutingControl refuses it), so this can
 *  never drop a sign-off. Pure. */
export function routingForWorkClass(control: RoutingControl, workClass: string | null | undefined): RoutingControl {
  if (!workClass) return control;
  return { slots: control.slots.filter((s) => s.mode !== "notify_only" || !s.work_classes?.length || s.work_classes.includes(workClass)) };
}

/** The effective routing for a chain: the nearest DEFINED level, validated.
 *  Pure — the live loader below and the tests share it. */
export function resolveRoutingControlChain(chain: ContainerChain<unknown>): EffectiveRouting {
  let level: RoutingLevel = "library";
  if (isRoutingDeclared(chain.document)) level = "document";
  else if (chain.folders.some((f) => isRoutingDeclared(f.value))) level = "collection";
  const raw = firstDefinedInChain<unknown>(chain, (v): v is unknown => isRoutingDeclared(v));
  const parsed = parseRoutingControl(raw);
  if (parsed === null) return { state: "unconfigured" };
  if (!parsed.ok) return { state: "invalid", error: parsed.error, level };
  return { state: "configured", control: parsed.control, level };
}

/** Most specific DEFINED level wins — the same cases as
 *  resolveEffectiveDocClass (a single folder is a chain of one). */
export function resolveEffectiveRoutingControl(
  documentValue?: unknown,
  folderValue?: unknown,
  libraryValue?: unknown,
): EffectiveRouting {
  return resolveRoutingControlChain({ document: documentValue, folders: [{ id: "folder", value: folderValue }], library: libraryValue });
}

/** True when the error means the 20261241 routing_control columns are not
 *  applied (today's routing then holds). The error must NAME routing_control
 *  (DF-P5 fix pass 2): a 42703 / PGRST204 for any other column — a partial
 *  restore missing collections.path_ids, schema drift — is a read failure
 *  and fails closed (DEC-36 property 2: "we couldn't read" never reads as
 *  "none declared"). */
export function isMissingRoutingSchema(err: unknown): boolean {
  const e = err as { code?: string; message?: string; details?: string; hint?: string } | null;
  if (!e) return false;
  const msg = `${e.message ?? ""} ${e.details ?? ""} ${e.hint ?? ""}`.toLowerCase();
  if (!msg.includes("routing_control")) return false;
  if (e.code === "42703" || e.code === "PGRST204") return true;
  return msg.includes("does not exist") || msg.includes("schema cache") || msg.includes("could not find");
}

/**
 * The routing that applies to a ticket, from the live chain: the ticket's
 * source document (only when it sits in the ticket's library — DF-P4 derives
 * the library from it), its folder chain, and the ticket's library. A ticket
 * with no library resolves nothing: unconfigured, with no read at all.
 *
 * Throws on a transient failure (fail closed). Run it inside
 * runWithServerClient(supabaseAdmin, …) on the server: lib/containerChain.ts
 * reads through the shared client.
 */
export async function effectiveRoutingForTicket(ticket: {
  libraryId?: string | null;
  sourceDocument?: { id: string; collectionId: string | null; libraryId: string | null } | null;
}): Promise<EffectiveRouting> {
  if (!ticket.libraryId) return { state: "unconfigured" };
  const doc = ticket.sourceDocument && ticket.sourceDocument.libraryId === ticket.libraryId ? ticket.sourceDocument : null;
  try {
    const chain = await loadContainerChain<unknown>("routing_control", {
      id: doc?.id ?? null,
      collectionId: doc?.collectionId ?? null,
      libraryId: ticket.libraryId,
    });
    return resolveRoutingControlChain(chain);
  } catch (e) {
    if (isMissingRoutingSchema(e)) return { state: "unconfigured" };
    throw new Error(`Couldn't read this request's routing: ${(e as { message?: string })?.message ?? "unknown error"}`);
  }
}

/** The workflow route's `warning` when a transition landed but the roster's
 *  ledger (20261242) could not be written (GAP-103). Here, beside
 *  isMissingRosterLedger, so the request page can recognise it (DF-P20
 *  merge-time fix pass: an assurance sign-off's record then reads "could
 *  not be read yet", never "not recorded"). */
export const ROSTER_LEDGER_NOT_WRITTEN = "Done — but the review roster's record could not be written; the request carries it and it will be reconciled.";

/** True when the error means the 20261242 ledger is not there yet. (Here,
 *  not only in lib/ticketRoster.ts, because the request page asks too and
 *  that module hashes with node:crypto; lib/ticketRoster.ts re-exports it.) */
export function isMissingRosterLedger(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  if (e.code === "42P01" || e.code === "PGRST205") return true;
  const m = (e.message ?? "").toLowerCase();
  return m.includes("ticket_review_slot") && (m.includes("does not exist") || m.includes("could not find") || m.includes("schema cache"));
}

/**
 * TIER-5 (DF-P5 fix pass 3): does this ticket review on a roster? True when
 * a routing table is declared on its chain (well-formed or not — a broken
 * table is not "no routing") AND the 20261242 ledger is there to hold the
 * roster (before it is pasted, submissions take the usual review, so the
 * usual approvals stay open). Reads the source document's folder, the
 * chain, and probes the ledger with a GET (never a HEAD — see the workflow
 * route). Reads through the shared client: the route binds it to the
 * service role (runWithServerClient), the request page reads through RLS.
 * THROWS on any read failure — the route fails closed (503); the page
 * treats it as unknown and leaves the decision to the route.
 */
export async function ticketReviewRouting(ticket: {
  id: string;
  orgId: string;
  libraryId?: string | null;
  sourceDocumentId?: string | null;
}): Promise<{ routed: boolean; routing: EffectiveRouting }> {
  if (!ticket.libraryId) return { routed: false, routing: { state: "unconfigured" } };
  let sourceDocument: { id: string; collectionId: string | null; libraryId: string | null } | null = null;
  if (ticket.sourceDocumentId && /^[0-9a-f-]{36}$/i.test(ticket.sourceDocumentId)) {
    const { data, error } = await supabase
      .from("documents").select("id, collection_id, library_id").eq("id", ticket.sourceDocumentId).eq("org_id", ticket.orgId).maybeSingle();
    if (error) throw new Error(`Couldn't read this request's source document: ${error.message}`);
    const d = data as { id?: string; collection_id?: string | null; library_id?: string | null } | null;
    if (d?.id) sourceDocument = { id: d.id, collectionId: d.collection_id ?? null, libraryId: d.library_id ?? null };
  }
  const routing = await effectiveRoutingForTicket({ libraryId: ticket.libraryId, sourceDocument });
  if (routing.state === "unconfigured") return { routed: false, routing };
  const { error: ledgerErr } = await supabase.from("ticket_review_slots").select("id").eq("ticket_id", ticket.id).limit(1);
  if (ledgerErr && isMissingRosterLedger(ledgerErr)) return { routed: false, routing };
  if (ledgerErr) throw new Error(`Couldn't check the review roster: ${ledgerErr.message}`);
  return { routed: true, routing };
}

/** The label a slot is shown under. */
export const slotLabel = (s: Pick<RoutingSlot, "kind" | "label">): string => s.label?.trim() || s.kind;

/** The words for a mode, as a person reads them. GAP-109 (DF-P7): a
 *  consent_window slot advances on silence only where lib/consentWindow.ts
 *  planConsentWindow allows it (never on engineered work, never as the
 *  engineering sign-off, never with nobody to ask, never before 20261255) —
 *  everywhere else it waits like a sign-off, and the request says why. */
export const MODE_LABEL: Record<RoutingSlotMode, string> = {
  blocking: "Must sign off",
  consent_window: `May object within a window (default ${CONSENT_WINDOW_DEFAULT_DAYS} working days) — silence counts as no objection only once database update ${CONSENT_WINDOW_MIGRATION} is applied, on one consent slot per table, never on engineered work, never as the engineering sign-off and never with only the drafter to ask; otherwise it waits like a sign-off`,
  notify_only: "Told, no sign-off",
};

// ─── The seed (DEC-90 ruling (2)) ───────────────────────────────────────────

/** Today's behaviour, as slots, for an org that configured nothing. */
export const SEEDED_ROUTING = {
  slots: [
    { kind: "requester_acceptance", label: "Requester acceptance", mode: "blocking", fill: { identity: "requester" } },
    // Who may be PICKED as the engineer today: the route's engineer check
    // (an Engineer role) under the org's ticket.final_approve list — the
    // shipped default is ["Engineer"], every Engineer tier.
    { kind: "engineering", label: "Engineering sign-off", mode: "blocking", fill: { capability: "ticket.final_approve" }, independent_of: ["drafter"] },
  ],
  /** The management tier (`ticket.manage`) may co-review on the requester's
   *  behalf and override an assigned engineer — optional, never waited on. */
  managementOverride: { capability: "ticket.manage" as CapabilityId, optional: true },
} as const satisfies { slots: RoutingSlot[]; managementOverride: { capability: CapabilityId; optional: true } };

export interface SeededSlotView {
  kind: string;
  label: string;
  /** "waiting" — the ticket waits on this slot now; "pending" — it will
   *  once the earlier step is done (today's machine is serial); "done";
   *  "not_required" — the engineer gate does not apply; "overridden" — the
   *  request was issued by a management override of the engineering
   *  sign-off, which nobody gave (DF-P6 fix pass, SM-3). */
  state: "waiting" | "pending" | "done" | "not_required" | "overridden";
  /** Who fills it, in words (an identity, or a named engineer). */
  occupant: string;
}

/**
 * The seed applied to an UNCONFIGURED ticket, for display: who must act and
 * in what order under today's serial machine. `engineerRequired` is the
 * state machine's own engineer gate (lib/workflow.ts
 * engineerApprovalRequired), passed in so the seed can never disagree with
 * the engine.
 */
export function seededSlotsFor(ticket: {
  status: string;
  requesterName?: string | null;
  assignedEngineerName?: string | null;
  engineerApprovedAt?: unknown;
}, engineerRequired: boolean, engineeringOverridden = false): SeededSlotView[] {
  const s = ticket.status;
  const reviewDone = ["PENDING_FINAL_APPROVAL", "PENDING_IFC", "FINAL_DRAFT", "CLOSED"].includes(s);
  const out: SeededSlotView[] = [{
    kind: "requester_acceptance",
    label: "Requester acceptance",
    state: s === "PENDING_REVIEW" ? "waiting" : reviewDone ? "done" : "pending",
    occupant: ticket.requesterName || "The requester",
  }];
  out.push({
    kind: "engineering",
    label: "Engineering sign-off",
    state: !engineerRequired && s !== "PENDING_FINAL_APPROVAL"
      ? "not_required"
      : s === "PENDING_FINAL_APPROVAL" ? "waiting"
        // DF-P6 fix pass (review, issue 7): issued by override — never "pending".
        : engineeringOverridden && ["PENDING_IFC", "FINAL_DRAFT", "CLOSED"].includes(s) ? "overridden"
        : ticket.engineerApprovedAt ? "done" : "pending",
    occupant: ticket.assignedEngineerName || "An engineer the requester picks",
  });
  return out;
}

/** A routing slot as a save compares it with the stored table: its parsed
 *  shape with object keys in a fixed order, the opt-in left out (the opt-in
 *  is what the comparison decides, never part of it). */
function slotFingerprint(s: RoutingSlot): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
    return v;
  };
  const rest: Record<string, unknown> = { ...s };
  delete rest.consent_confirmed;
  return JSON.stringify(canon(rest));
}

/**
 * DEC-90 rulings (2) and (3) for DF-P7 (merge-time fix pass): the slots of
 * `control` an editor TOUCHED in this save — new (no stored slot of that
 * kind) or changed (its parsed shape differs from the stored slot's, the
 * opt-in aside). `stored` is the raw value stored at the level (null: none
 * declared — every slot is new; a stored value that does not parse is
 * replaced whole — every slot is new). Pure.
 */
export function touchedSlotKinds(control: RoutingControl, stored: unknown): Set<string> {
  const parsedDraft = parseRoutingControl(control);
  const draftSlots = parsedDraft && parsedDraft.ok ? parsedDraft.control.slots : control.slots;
  const parsedStored = parseRoutingControl(stored);
  const before = new Map((parsedStored && parsedStored.ok ? parsedStored.control.slots : []).map((s) => [s.kind, slotFingerprint(s)]));
  return new Set(draftSlots.filter((s) => before.get(s.kind) !== slotFingerprint(s)).map((s) => s.kind));
}

/** The stored slots carrying the opt-in, by kind (pure). */
function storedConfirmedKinds(stored: unknown): Set<string> {
  const p = parseRoutingControl(stored);
  return new Set(p && p.ok ? p.control.slots.filter((s) => s.mode === "consent_window" && s.consent_confirmed === true).map((s) => s.kind) : []);
}

/** Validate an editor's draft before it is written; the same rule the
 *  resolver applies to a stored value. `stored` (the raw value stored at
 *  the level, null for none) lets an untouched stored slot pass — see
 *  below; omitted, every slot is treated as new. */
export function validateRoutingDraft(control: RoutingControl | null, stored?: unknown): string | null {
  if (control === null) return null;
  const p = parseRoutingControl(control);
  if (p && !p.ok) return p.error;
  // GAP-102 (DF-P20 merge-time fix pass): the parser drops a misplaced
  // assurance opt-in silently (a stored table is never refused for it); a
  // save that writes one is refused with the reason instead, so it is never
  // stored. The editor's own draft never carries one (draftToControl).
  const misplaced = control.slots.find((s) => {
    const v = (s as { records_examination?: unknown }).records_examination;
    return v !== undefined && v !== null && v !== false && (v !== true || !examinationOptInAllowed(s));
  });
  if (misplaced) {
    const v = (misplaced as { records_examination?: unknown }).records_examination;
    return v !== true
      ? `slot "${misplaced.kind}": the assurance check is on or off (records_examination is true or absent)`
      : misplaced.mode !== "blocking"
        ? `slot "${misplaced.kind}": only a "must sign off" slot can be an assurance check — a notice or a consent window has no sign-off to record it on`
        : misplaced.fill?.capability && CONSENT_REFUSED_CAPABILITIES.includes(misplaced.fill.capability)
          ? `slot "${misplaced.kind}": the engineering approval records its own sign-off — it cannot be an assurance check`
          : `slot "${misplaced.kind}": the requester's own acceptance is not an assurance check`;
  }
  // GAP-109 mechanism 2 (DF-P22): a save that writes a misplaced standing
  // pre-authorization opt-in is refused with the reason (the parser drops
  // one silently from a stored table).
  const misplacedPreauth = control.slots.find((s) => {
    const v = (s as { accepts_preauthorization?: unknown }).accepts_preauthorization;
    return v !== undefined && v !== null && v !== false && (v !== true || !preauthorizationOptInAllowed(s));
  });
  if (misplacedPreauth) {
    const v = (misplacedPreauth as { accepts_preauthorization?: unknown }).accepts_preauthorization;
    return v !== true
      ? `slot "${misplacedPreauth.kind}": standing pre-authorization is on or off (accepts_preauthorization is true or absent)`
      : misplacedPreauth.mode !== "blocking"
        ? `slot "${misplacedPreauth.kind}": only a "must sign off" slot can accept a standing pre-authorization`
        : misplacedPreauth.fill?.capability && CONSENT_REFUSED_CAPABILITIES.includes(misplacedPreauth.fill.capability)
          ? `slot "${misplacedPreauth.kind}": a standing pre-authorization never stands in for the engineering sign-off`
          : misplacedPreauth.records_examination === true
            ? `slot "${misplacedPreauth.kind}": an assurance check records what its reviewer examined on each request — it cannot accept a standing pre-authorization`
            : `slot "${misplacedPreauth.kind}": the requester's own acceptance cannot be pre-authorized`;
  }
  // GAP-109 / DEC-90 ruling (1) for DF-P7: silence never stands in for the
  // engineering sign-off — the highest class of review — so a table that
  // puts a consent window on a slot filled by an engineering capability is
  // refused with the reason. DEC-90 ruling (2) (merge-time fix pass, no
  // regression): refused only when THAT slot is new or changed in this
  // save. A stored one the editor did not touch passes — a save that
  // edits another slot's label works exactly as before — and it waits as a
  // sign-off (lib/consentWindow.ts planConsentWindow; the cron re-reads the
  // slot and never opens or closes a window on it), so no in-flight review
  // changes.
  const touched = p?.ok && stored !== undefined ? touchedSlotKinds(p.control, stored) : null;
  const eng = p?.ok ? p.control.slots.find((s) => s.mode === "consent_window" && !!s.fill.capability && CONSENT_REFUSED_CAPABILITIES.includes(s.fill.capability) && (!touched || touched.has(s.kind))) : undefined;
  if (eng) return `slot "${eng.kind}": a consent window cannot stand in for the engineering sign-off — make it a "must sign off" slot`;
  return null;
}

/**
 * Write a routing table at one level (NULL clears the level back to
 * inherit). The database decides who may (20261241's guard: a document
 * controller only, on every level — a routing table decides who reviews the
 * deliverables that cite the container, so neither a document's owner nor a
 * library's owner / manager may swap it) and writes the
 * ROUTING_CONTROL_CHANGED audit row. A checked
 * write: every refusal is thrown with a plain message, never a silent save.
 */
export async function setRoutingControl(input: {
  level: RoutingLevel;
  id: string;
  control: RoutingControl | null;
}): Promise<void> {
  // DEC-90 rulings (2) and (3) (DF-P7 merge-time fix pass): the save is
  // compared with the table stored at this level — only a slot the editor
  // touched is held to the new consent rule, and only a consent slot the
  // editor touched is opted into the consent window. A stored table that
  // cannot be read is never guessed at (that would opt untouched slots in).
  let stored: unknown = null;
  if (input.control !== null) {
    const before = await readRoutingControlAt(input.level, input.id);
    if (!before.ok) {
      if (before.missing) throw new Error("Review routing needs database update 20261241 — ask an Admin to apply it, then try again.");
      throw new Error(`The routing table was not saved — the table stored here could not be read to compare with: ${before.error}. Try again in a moment.`);
    }
    stored = before.value;
  }
  const invalid = validateRoutingDraft(input.control, stored);
  if (invalid) throw new Error(`This routing table can't be saved: ${invalid}.`);
  const table = input.level === "library" ? "libraries" : input.level === "collection" ? "collections" : "documents";
  const res = await checkedWrite(supabase.from(table).update({ routing_control: confirmConsentSlots(input.control, stored) }).eq("id", input.id).select("id"));
  if (res.ok) return;
  if (res.pgCode === "42703" || res.pgCode === "PGRST204") throw new Error("Review routing needs database update 20261241 — ask an Admin to apply it, then try again.");
  if (res.code === "refused") {
    throw new Error(`The routing table was not saved — only a document controller can set the routing of a ${input.level === "library" ? "library" : input.level === "collection" ? "folder" : "document"}.`);
  }
  throw new Error(res.error);
}

/** GAP-109 (DF-P7 fix pass 3): the table as a controller saves it under the
 *  consent-window label — a consent-window slot carries the opt-in
 *  (`consent_confirmed: true`), every other slot none. A save is the
 *  re-confirmation DEC-44 (DF-P7-consent) item 18 asks for.
 *  DEC-90 ruling (3) (merge-time fix pass, fail-safe opt-in): with `stored`
 *  (the raw value stored at the level, null for none) the opt-in is stamped
 *  ONLY on a consent slot that is new or changed in this save (the editor
 *  touched it); an untouched consent slot keeps exactly what is stored — a
 *  pre-DF-P7 consent slot is never opted into silence by an unrelated edit.
 *  Omitted `stored`: every consent slot is stamped. Pure. */
export function confirmConsentSlots(control: RoutingControl | null, stored?: unknown): RoutingControl | null {
  if (control === null) return null;
  const touched = stored !== undefined ? touchedSlotKinds(control, stored) : null;
  const confirmedBefore = stored !== undefined ? storedConfirmedKinds(stored) : null;
  return {
    ...control,
    slots: control.slots.map((s) => {
      const rest = { ...s };
      delete rest.consent_confirmed;
      if (s.mode !== "consent_window") return rest;
      const optIn = !touched || touched.has(s.kind.trim()) || !!confirmedBefore?.has(s.kind.trim());
      return optIn ? { ...rest, consent_confirmed: true as const } : rest;
    }),
  };
}

/** Read the routing table declared AT one level (not the effective one). */
export async function readRoutingControlAt(level: RoutingLevel, id: string): Promise<{ ok: true; value: unknown } | { ok: false; missing: boolean; error: string }> {
  const table = level === "library" ? "libraries" : level === "collection" ? "collections" : "documents";
  const { data, error } = await supabase.from(table).select("routing_control").eq("id", id).maybeSingle();
  if (error) return { ok: false, missing: isMissingRoutingSchema(error), error: error.message || "unreadable" };
  return { ok: true, value: (data as { routing_control?: unknown } | null)?.routing_control ?? null };
}

/** DF-P5 fix pass 4: how many in-review tickets a routing editor reads
 *  before it says "at least". */
export const IN_FLIGHT_SCAN_LIMIT = 500;

/**
 * TIER-5 / DEC-29 (DF-P5 fix pass 4): the requests IN REVIEW right now
 * (PENDING_REVIEW / PENDING_FINAL_APPROVAL) with no open sign-off roster
 * whose routing chain runs through this level — once a table is saved here,
 * their serial approvals are refused (routing_needs_roster) and each needs a
 * revision so its resubmission opens a roster. The editor shows the number
 * and asks before the save.
 *
 * A library counts every such request filed in it; a folder, those whose
 * source document sits in it or in a folder under it (path_ids); a document,
 * those raised on it — the same chain effectiveRoutingForTicket walks (a
 * source document counts only in the request's own library). Read through
 * the signed-in client, so it counts the requests the editor can see.
 */
export async function reviewsInFlightUnder(level: RoutingLevel, id: string): Promise<
  { ok: true; n: number; capped: boolean } | { ok: false; error: string }
> {
  let libraryId: string | null = level === "library" ? id : null;
  if (level !== "library") {
    const { data, error } = await supabase.from(level === "collection" ? "collections" : "documents").select("library_id").eq("id", id).maybeSingle();
    if (error) return { ok: false, error: error.message || "unreadable" };
    libraryId = (data as { library_id?: string | null } | null)?.library_id ?? null;
  }
  if (!libraryId) return { ok: true, n: 0, capped: false };
  const { data: rows, error } = await supabase.from("tickets").select("id, status, metadata")
    .eq("library_id", libraryId).in("status", ["PENDING_REVIEW", "PENDING_FINAL_APPROVAL"]).limit(IN_FLIGHT_SCAN_LIMIT + 1);
  if (error) return { ok: false, error: error.message || "unreadable" };
  const all = (rows ?? []) as Array<{ id: string; status: Ticket["status"]; metadata?: Record<string, unknown> | null }>;
  const capped = all.length > IN_FLIGHT_SCAN_LIMIT;
  const rosterless = all.slice(0, IN_FLIGHT_SCAN_LIMIT).filter((r) => !currentRoster({ status: r.status, metadata: r.metadata ?? undefined }));
  if (level === "library") return { ok: true, n: rosterless.length, capped };
  const sourceOf = (r: { metadata?: Record<string, unknown> | null }) => parseSourceDocument(r.metadata ?? null)?.id ?? null;
  if (level === "document") return { ok: true, n: rosterless.filter((r) => sourceOf(r) === id).length, capped };
  // A folder: the source documents' folders, then those folders' ancestry.
  const docIds = [...new Set(rosterless.map(sourceOf).filter((d): d is string => !!d && /^[0-9a-f-]{36}$/i.test(d)))];
  const folderOfDoc = new Map<string, string | null>();
  for (let i = 0; i < docIds.length; i += 100) {
    const { data, error: e } = await supabase.from("documents").select("id, collection_id").in("id", docIds.slice(i, i + 100)).eq("library_id", libraryId);
    if (e) return { ok: false, error: e.message || "unreadable" };
    for (const d of (data ?? []) as Array<{ id: string; collection_id?: string | null }>) folderOfDoc.set(d.id, d.collection_id ?? null);
  }
  const folderIds = [...new Set([...folderOfDoc.values()].filter((f): f is string => !!f))];
  const under = new Set<string>();
  for (let i = 0; i < folderIds.length; i += 100) {
    const { data, error: e } = await supabase.from("collections").select("id, path_ids").in("id", folderIds.slice(i, i + 100));
    if (e) return { ok: false, error: e.message || "unreadable" };
    for (const c of (data ?? []) as Array<{ id: string; path_ids?: unknown }>) {
      if (c.id === id || (Array.isArray(c.path_ids) && (c.path_ids as unknown[]).includes(id))) under.add(c.id);
    }
  }
  return { ok: true, n: rosterless.filter((r) => { const d = sourceOf(r); const f = d ? folderOfDoc.get(d) : null; return !!f && under.has(f); }).length, capped };
}
