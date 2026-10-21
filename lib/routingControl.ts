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

/** The words for a mode, as a person reads them. consent_window waits like a
 *  blocking slot until consent windows exist (GAP-109 needs GAP-113's
 *  delivery record first — DEC-38: no delivery record, no silent advance). */
export const MODE_LABEL: Record<RoutingSlotMode, string> = {
  blocking: "Must sign off",
  consent_window: "Must sign off (consent windows are not available yet, so this waits like a sign-off)",
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
   *  "not_required" — the engineer gate does not apply. */
  state: "waiting" | "pending" | "done" | "not_required";
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
}, engineerRequired: boolean): SeededSlotView[] {
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
      : s === "PENDING_FINAL_APPROVAL" ? "waiting" : ticket.engineerApprovedAt ? "done" : "pending",
    occupant: ticket.assignedEngineerName || "An engineer the requester picks",
  });
  return out;
}

/** Validate an editor's draft before it is written; the same rule the
 *  resolver applies to a stored value. */
export function validateRoutingDraft(control: RoutingControl | null): string | null {
  if (control === null) return null;
  const p = parseRoutingControl(control);
  return p && !p.ok ? p.error : null;
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
  const invalid = validateRoutingDraft(input.control);
  if (invalid) throw new Error(`This routing table can't be saved: ${invalid}.`);
  const table = input.level === "library" ? "libraries" : input.level === "collection" ? "collections" : "documents";
  const res = await checkedWrite(supabase.from(table).update({ routing_control: input.control }).eq("id", input.id).select("id"));
  if (res.ok) return;
  if (res.pgCode === "42703" || res.pgCode === "PGRST204") throw new Error("Review routing needs database update 20261241 — ask an Admin to apply it, then try again.");
  if (res.code === "refused") {
    throw new Error(`The routing table was not saved — only a document controller can set the routing of a ${input.level === "library" ? "library" : input.level === "collection" ? "folder" : "document"}.`);
  }
  throw new Error(res.error);
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
