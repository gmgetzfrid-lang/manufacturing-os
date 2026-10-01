// lib/holds.ts
//
// Phase 5 — Hold tracking & roadblock metrics.
//
// A hold is an explicit operational block on a document. Opening
// one announces "this drawing can't be advanced until X is cleared";
// releasing one records who cleared it and when. The duration
// (released_at - opened_at) is computed at read time so we never
// have to maintain a stale "total_hold_days" column.
//
// Multiple holds can be active on the same document simultaneously
// (e.g. "Awaiting Engineering" + "Missing Vendor Data" at once).
// The partial unique index in the migration prevents the same
// reason from being opened twice without first being released.
//
// Every open and release writes an audit_logs row via lib/audit.ts —
// the standard flow used by checkouts and revisions — so the events
// merge cleanly into the Phase 3 timeline. Round F (HLD-5): on a
// 20261073 database the HOLD_RELEASED row for a signed-in release is
// written by the document_holds guard itself (so a release issued
// outside this module still leaves a trail); the guard stamps
// release_recorded_at on the row and releaseHold() then writes no
// second row. The gate that other doors call is lib/holdGate.ts.

import { supabase } from "@/lib/supabase";
import { logHoldEvent } from "@/lib/audit";
import { loadCapabilityPolicy, policyAllows, tokensFor, heldMatchesTokens, grantActive, type CapabilityPolicy } from "@/lib/capabilityPolicy";
import { isControllerRole } from "@/lib/permissions";
import { heldRoles, holdsReadOnlyRole } from "@/lib/roleHeld";
import { OTHER_HOLD_REASON, holdReasonLabel } from "@/lib/holdGate";
import type { DocumentHold, HoldReason, Role } from "@/types/schema";

/** The default predefined reasons surfaced by the picker UI. */
export const PREDEFINED_HOLD_REASONS: HoldReason[] = [
  "Awaiting Engineering",
  "Field Verification Needed",
  "Missing Vendor Data",
  "Client Review",
];

/** VFY-6 (P15): the "Other" slot of HoldReason. A hold for anything the four
 *  predefined reasons do not cover is placed under this code, with what it
 *  is for written to the hold's NOTE — never to `reason`, which a public
 *  surface may name (by category only, publicHoldReason). Defined in
 *  lib/holdGate.ts (pure) with holdReasonLabel, so the hold gate's refusal
 *  sentence names a custom hold the same way. */
export { OTHER_HOLD_REASON, holdReasonLabel } from "@/lib/holdGate";

/** VFY-6 (P15): the reason CODES this module writes — the predefined
 *  reasons and "Other". The column itself has no CHECK (holds placed before
 *  P15 may carry operator text, and a lifecycle copy carries a source's
 *  legacy reason across unchanged); openHold, the one app door that places a
 *  hold, writes nothing else. Second review fix — the database holds the
 *  same rules (20261152 enforce_document_hold_reason_code): a signed-in
 *  INSERT writes a code, "Other" with a non-blank note, or a legacy reason
 *  the org already carries (a carry); and an "Other" hold's note — its
 *  description — cannot be changed once placed. */
export const HOLD_REASON_CODES: readonly HoldReason[] = [...PREDEFINED_HOLD_REASONS, OTHER_HOLD_REASON];

export function isHoldReasonCode(reason: string | null | undefined): boolean {
  return (HOLD_REASON_CODES as readonly string[]).includes((reason ?? "").trim());
}

/** VFY-6 (P15 review fix): an OPEN hold's identity as the open-reason unique
 *  index keys it (20261152 document_holds_open_reason_uniq: the document,
 *  the reason, and for an "Other" hold its note, btrim'd — spaces only, as
 *  Postgres trims. The index keys the md5 of that note so a long one never
 *  exceeds the btree row limit; equal hashes are equal notes, so this key —
 *  the note itself — answers the same). Every reason but "Other" is one open
 *  hold per document; two "Other" holds are one hold only when their notes
 *  match. The
 *  lifecycle carry (copyActiveHoldsToDoc) skips a hold already open on the
 *  target by THIS key — never by the reason alone, which would drop the
 *  second of two different custom holds now that both are "Other". */
export function openHoldKey(h: { reason: string; notes?: string | null }): string {
  if (h.reason !== OTHER_HOLD_REASON) return h.reason;
  return `${OTHER_HOLD_REASON}\u0000${(h.notes ?? "").replace(/^ +| +$/g, "")}`;
}

/** HLD-7 / VFY-6: what an UNAUTHENTICATED surface may say about a hold's
 *  reason. `reason` may be operator text — the schema has no CHECK, and
 *  before P15 the picker's "Other…" stored whatever was typed — so the public verify
 *  endpoint returns it only when it is one of the predefined categories and
 *  says "On hold" otherwise. The card the QR sits on prints the sentence in
 *  full; this is about what a forwarded URL discloses. */
export const PUBLIC_HOLD_REASON_FALLBACK = "On hold";
export function publicHoldReason(reason: string | null | undefined): string {
  const r = (reason ?? "").trim();
  return (PREDEFINED_HOLD_REASONS as string[]).includes(r) ? r : PUBLIC_HOLD_REASON_FALLBACK;
}

interface HoldRow {
  id: string;
  org_id: string;
  document_id: string;
  reason: string;
  notes: string | null;
  expected_release_at: string | null;
  opened_by: string;
  opened_by_name: string | null;
  opened_at: string;
  released_by: string | null;
  released_by_name: string | null;
  released_at: string | null;
  released_reason: string | null;
  /** LIFE-6 / DEC-25 (20261047): the drafting ticket whose check-in placed it. */
  origin_ticket_id?: string | null;
  /** HLD-7 (20261073): the document's rev / current version when the hold was
   *  placed — captured by the database at INSERT, immutable after. Absent on a
   *  pre-migration database. */
  held_rev_label?: string | null;
  held_version_id?: string | null;
  /** HLD-5 (20261073): set by the guard when IT wrote the HOLD_RELEASED audit
   *  row; absent (undefined) on a pre-migration database. */
  release_recorded_at?: string | null;
}

/** A hold as this module returns it: the schema's DocumentHold plus the
 *  revision it stopped (HLD-7). `heldRevLabel` is null for holds placed
 *  before 20261073 — the rev they stopped is not knowable after the fact. */
export interface HoldRecord extends DocumentHold {
  heldRevLabel: string | null;
  heldVersionId: string | null;
}

function rowToHold(r: HoldRow): HoldRecord {
  return {
    id: r.id,
    orgId: r.org_id,
    documentId: r.document_id,
    reason: r.reason,
    notes: r.notes,
    expectedReleaseAt: r.expected_release_at,
    openedBy: r.opened_by,
    openedByName: r.opened_by_name,
    openedAt: r.opened_at,
    releasedBy: r.released_by,
    releasedByName: r.released_by_name,
    releasedAt: r.released_at,
    releasedReason: r.released_reason,
    originTicketId: r.origin_ticket_id ?? null,
    heldRevLabel: r.held_rev_label ?? null,
    heldVersionId: r.held_version_id ?? null,
  };
}

// ─── Authority (HLD-8) ──────────────────────────────────────────

export interface HoldControls {
  canOpen: boolean;
  canRelease: boolean;
}

/** HLD-8: what the hold UI may show a person — decided by the org's
 *  capability policy through the SAME evaluator the database and
 *  assertHoldCapability use (role tokens, the additive collection, and live
 *  per-person grants), never a literal role list. Both surfaces (the
 *  inspector strip and /admin/holds) call this; a grant of holds.release
 *  lights the Release control exactly as widening the role list does.
 *  ROLE-5: a read-only role (Viewer / Auditor) anywhere in the held
 *  collection SUBTRACTS — deny-if-any, no headline shortcut, no controller
 *  escape — the same way every restriction-style check in the app does, so
 *  the shipped "*" default does not hand an Auditor a live Release control. */
export function holdControlsFor(
  policy: CapabilityPolicy | null | undefined,
  role: string | null | undefined,
  extraRoles: readonly string[] | null | undefined,
  uid: string | null | undefined,
): HoldControls {
  const extra = extraRoles ? [...extraRoles] : null;
  const readOnly = holdsReadOnlyRole([role ?? "", ...(extra ?? [])].filter(Boolean));
  return {
    canOpen: !readOnly && policyAllows(policy, "holds.open", role, extra, uid),
    canRelease: !readOnly && policyAllows(policy, "holds.release", role, extra, uid),
  };
}

// ─── Mutations ──────────────────────────────────────────────────

export interface OpenHoldInput {
  orgId: string;
  documentId: string;
  /** A reason CODE (HOLD_REASON_CODES) — VFY-6: anything else is refused. */
  reason: string;
  /** Required with "Other": what the document is held for (private: no
   *  public surface publishes a hold's notes). */
  notes?: string;
  expectedReleaseAt?: string;       // ISO timestamp
  openedBy: string;
  openedByName?: string;
  openedByEmail?: string;
  openedByRole?: string;
  /** LIFE-6 / DEC-25: the ticket this hold originates from (a check-in's
   *  "Field Verification Needed" offer) — the close gate finds it here. */
  originTicketId?: string | null;
}

/** HLD-14: the picker's expected-release date (a YYYY-MM-DD from a date
 *  input) → the ISO instant stored on the hold: the END of that local day,
 *  so a hold expected "by Friday" is not late at 00:01 Friday. Blank or
 *  malformed → undefined (no date; the age-based nudge applies instead). */
export function expectedReleaseIso(date: string | null | undefined): string | undefined {
  const d = (date ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return undefined;
  const [y, m, day] = d.split("-").map(Number);
  const at = new Date(y, m - 1, day, 23, 59, 59, 999);
  if (Number.isNaN(at.getTime()) || at.getMonth() !== m - 1 || at.getDate() !== day) return undefined;
  return at.toISOString();
}

/** The inverse, for a date input's initial value: the stored instant (the
 *  record's Timestamp) → the LOCAL calendar day it falls on (YYYY-MM-DD).
 *  Null / unparsable → null. */
export function expectedReleaseDate(iso: Date | number | string | null | undefined): string | null {
  if (iso === null || iso === undefined || iso === "") return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
}

/** Self-contained capability check for holds — enforced HERE so every entry
 *  point (inspector strip, quick-hold button, admin page) obeys the org's
 *  Action-permissions policy without each caller re-plumbing role state.
 *  Default policy is "*" (everyone) = historical behavior. */
async function assertHoldCapability(
  orgId: string,
  cap: "holds.open" | "holds.release",
  // DEC-13 stage 2: the evaluator takes a resource; no hold caller threads
  // one today (a hold's library is not in hand here), so the BASE list
  // governs — which is also what the document_holds policies see through
  // the 3-argument org_capability_allows. Both halves agree by construction.
  resource?: import("@/lib/capabilityPolicy").CapabilityResource,
): Promise<void> {
  try {
    const [{ loadCapabilityPolicy, policyAllows }, { data: auth }] = await Promise.all([
      import("@/lib/capabilityPolicy"),
      supabase.auth.getUser(),
    ]);
    const uid = auth.user?.id;
    if (!uid) return; // server/cron contexts: not policy-gated here
    const [{ data: member }, policy] = await Promise.all([
      supabase.from("org_members").select("role, roles").eq("org_id", orgId).eq("uid", uid).eq("status", "active").maybeSingle(),
      loadCapabilityPolicy(orgId),
    ]);
    const role = (member?.role as string | undefined) ?? "Viewer";
    const extra = (member?.roles as string[] | null) ?? [];
    if (!policyAllows(policy, cap, role, extra, uid, resource)) {
      throw new Error(cap === "holds.open"
        ? "Your role isn't allowed to place holds. An Admin can change this under Admin → Permissions → Action permissions."
        : "Your role isn't allowed to release holds. An Admin can change this under Admin → Permissions → Action permissions.");
    }
  } catch (e) {
    if ((e as Error).message?.includes("Action permissions")) throw e;
    /* policy lookup hiccup: fail open — matches historical behavior */
  }
}

export async function openHold(input: OpenHoldInput): Promise<HoldRecord> {
  if (!input.reason.trim()) throw new Error("Hold reason is required.");
  // VFY-6: the reason is a code. Free text goes in the note of an "Other"
  // hold, which the public verify surfaces never publish.
  if (!isHoldReasonCode(input.reason)) {
    throw new Error(`A hold's reason is one of: ${HOLD_REASON_CODES.join(", ")}. For anything else choose "${OTHER_HOLD_REASON}" and describe it in the hold's note.`);
  }
  if (input.reason.trim() === OTHER_HOLD_REASON && !input.notes?.trim()) {
    throw new Error(`An "${OTHER_HOLD_REASON}" hold needs a description — say what the document is held for.`);
  }
  await assertHoldCapability(input.orgId, "holds.open");

  // HLD-7: held_rev_label / held_version_id are NOT sent from here — the
  // 20261073 INSERT guard derives them from the document, and a
  // pre-migration database has no such columns to receive.
  const { data, error } = await supabase
    .from("document_holds")
    .insert({
      org_id: input.orgId,
      document_id: input.documentId,
      reason: input.reason.trim(),
      notes: input.notes?.trim() || null,
      expected_release_at: input.expectedReleaseAt ?? null,
      opened_by: input.openedBy,
      opened_by_name: input.openedByName ?? null,
      ...(input.originTicketId ? { origin_ticket_id: input.originTicketId } : {}),
    })
    .select("*")
    .single();

  if (error) {
    // The partial unique index surfaces as a 23505 here when a hold
    // with the same reason is already active. Translate to a clearer
    // error so the UI can show "already on hold for that reason."
    if (error.code === "23505") {
      // VFY-6: "Other" holds are told apart by their note once 20261152 is
      // applied; before it, one "Other" hold at a time per document.
      if (input.reason.trim() === OTHER_HOLD_REASON) {
        throw new Error(`An "${OTHER_HOLD_REASON}" hold is already open on this document — with this description, or (until database update 20261152 is applied) with any description. Release it first, or choose a different description.`);
      }
      throw new Error(`A "${input.reason}" hold is already open on this document.`);
    }
    throw new Error(error.message);
  }
  const row = data as HoldRow;

  await logHoldEvent({
    orgId: input.orgId,
    documentId: input.documentId,
    holdId: row.id,
    userId: input.openedBy,
    userEmail: input.openedByEmail,
    userRole: input.openedByRole,
    type: "HOLD_OPENED",
    reason: row.reason,
    details: { notes: row.notes, expectedReleaseAt: row.expected_release_at, heldRevLabel: row.held_rev_label ?? null },
  });

  void notifyHoldChange({
    orgId: input.orgId,
    documentId: input.documentId,
    opened: true,
    reason: holdReasonLabel(row),
    actorUserId: input.openedBy,
    actorName: input.openedByName,
  });

  return rowToHold(row);
}

export interface ReleaseHoldInput {
  holdId: string;
  releasedBy: string;
  releasedByName?: string;
  releasedByEmail?: string;
  releasedByRole?: string;
  /** HLD-10: required — a stop-work is lifted for a stated reason. */
  releasedReason: string;
}

export async function releaseHold(input: ReleaseHoldInput): Promise<HoldRecord> {
  // HLD-10: refuse before any write — mirrors revertToVersion. The 20261073
  // guard holds the same rule at the database for a write that skips this.
  const releasedReason = (input.releasedReason ?? "").trim();
  if (!releasedReason) throw new Error("A release reason is required — say what cleared the hold.");

  // Policy gate first — resolve the hold's org from its row.
  const { data: holdRow } = await supabase
    .from("document_holds").select("org_id").eq("id", input.holdId).maybeSingle();
  if (holdRow?.org_id) await assertHoldCapability(String(holdRow.org_id), "holds.release");

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("document_holds")
    .update({
      released_at: now,
      released_by: input.releasedBy,
      released_by_name: input.releasedByName ?? null,
      released_reason: releasedReason,
    })
    .eq("id", input.holdId)
    .is("released_at", null)   // safety: don't double-release
    .select("*")
    .single();

  if (error || !data) throw new Error(error?.message || "Hold already released or not found.");
  const row = data as HoldRow;

  // HLD-5: on a 20261073 database the guard wrote the HOLD_RELEASED row itself
  // and says so on the returned row; a pre-migration row carries no such
  // column (undefined) and the app writes it as it always did. Never both.
  if (!row.release_recorded_at) {
    await logHoldEvent({
      orgId: row.org_id,
      documentId: row.document_id,
      holdId: row.id,
      userId: input.releasedBy,
      userEmail: input.releasedByEmail,
      userRole: input.releasedByRole,
      type: "HOLD_RELEASED",
      reason: row.reason,
      details: { releasedReason: row.released_reason, durationMs: durationMs(row.opened_at, row.released_at) },
    });
  }

  void notifyHoldChange({
    orgId: row.org_id,
    documentId: row.document_id,
    opened: false,
    reason: holdReasonLabel(row),
    actorUserId: input.releasedBy,
    actorName: input.releasedByName,
    // HLD-10: the person who stopped work is always told it resumed.
    involved: [row.opened_by],
  });

  return rowToHold(row);
}

/** HLD-14: re-date an OPEN hold — the remedy the aging nudge asks for ("set
 *  a new expected date"). Writes expected_release_at only (null clears it,
 *  and the hold falls back to the age-based nudge); the CAS predicate keeps a
 *  released hold untouched, and the 20261073 guard admits exactly this column
 *  on an open row. Authority is holds.release — the same capability the
 *  document_holds UPDATE policy (20260901) gates every update on — so the
 *  control sits beside Release on both surfaces. A re-date is not a hold
 *  event: it writes no HOLD_* audit row and sends no notification; the next
 *  aging sweep keys on the new date. */
export async function updateHoldExpectedRelease(holdId: string, expectedReleaseAt: string | null): Promise<HoldRecord> {
  const { data: holdRow } = await supabase
    .from("document_holds").select("org_id").eq("id", holdId).maybeSingle();
  if (holdRow?.org_id) await assertHoldCapability(String(holdRow.org_id), "holds.release");

  const { data, error } = await supabase
    .from("document_holds")
    .update({ expected_release_at: expectedReleaseAt })
    .eq("id", holdId)
    .is("released_at", null)   // an open hold only; a released one is closed history
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "Hold already released or not found.");
  return rowToHold(data as HoldRow);
}

// ─── Audience (HLD-10 / DEC-35) ─────────────────────────────────

/** HLD-10 / DEC-35: the pool told about a hold change is the pool the org's
 *  policy lets RELEASE it — role tokens (including "Engineer" = every tier)
 *  and live per-person grants — read from the capability policy, never a
 *  literal list. The shipped default admits everyone ("*"): a broadcast to
 *  the whole org on every hold change is noise, not a signal, so the
 *  wildcard (and an empty list) falls back to the controller tier — what
 *  is_org_controller / isControllerRole already mean by "controller", and
 *  exactly the pool this module hard-coded before. An org that names roles
 *  for holds.release names its own pool. Pure; the members come from one
 *  org-scoped read. */
export function holdPoolFromMembers(
  policy: CapabilityPolicy | null | undefined,
  members: ReadonlyArray<{ uid: string; role?: unknown; roles?: unknown }>,
  now: Date = new Date(),
): string[] {
  const tokens = tokensFor(policy, "holds.release");
  const wildcard = tokens.length === 0 || tokens.includes("*");
  const out = new Set<string>();
  for (const m of members) {
    const held = heldRoles(m);
    const admitted = wildcard
      ? held.some((r) => isControllerRole(r as Role))
      : heldMatchesTokens(tokens, held);
    if (admitted) out.add(m.uid);
  }
  for (const g of policy?.grants ?? []) {
    if (g.cap === "holds.release" && grantActive(g, now)) out.add(g.uid);
  }
  return Array.from(out);
}

async function resolveHoldAudience(orgId: string, policy: CapabilityPolicy): Promise<string[]> {
  const { data } = await supabase
    .from("org_members")
    .select("uid, role, roles")
    .eq("org_id", orgId)
    .eq("status", "active");
  return holdPoolFromMembers(policy, ((data as Array<{ uid: string; role?: unknown; roles?: unknown }> | null) ?? []));
}

/** A hold is a stop-work signal — the people working the document must hear
 *  it, not discover it. Followers of the document + the policy-derived
 *  release pool + anyone named in `involved` (the opener, on release), bell
 *  and email, best-effort (a hold never fails because a notify did — but a
 *  failed announcement is logged, never silently swallowed). */
async function notifyHoldChange(input: {
  orgId: string;
  documentId: string;
  opened: boolean;
  reason: string;
  actorUserId: string;
  actorName?: string | null;
  involved?: string[];
}): Promise<void> {
  try {
    const [{ emit }, { data: doc }, policy] = await Promise.all([
      import("@/lib/notify/dispatch"),
      supabase.from("documents").select("document_number, title, name, library_id")
        .eq("id", input.documentId).maybeSingle(),
      loadCapabilityPolicy(input.orgId),
    ]);
    const pool = await resolveHoldAudience(input.orgId, policy);
    const label = (doc?.document_number as string) || (doc?.title as string) || (doc?.name as string) || "a document";
    await emit({
      orgId: input.orgId,
      category: "status",
      kind: input.opened ? "hold_opened" : "hold_released",
      title: input.opened
        ? `HOLD placed on ${label} — ${input.reason}`
        : `Hold released on ${label}`,
      body: input.opened
        ? `${input.actorName || "Someone"} placed a "${input.reason}" hold. Work from this document should stop until it's released.`
        : `${input.actorName || "Someone"} released the "${input.reason}" hold. Work can resume on the current revision.`,
      link: doc?.library_id ? `/documents/${doc.library_id}?doc=${input.documentId}` : "/admin/holds",
      resource: { type: "document", id: input.documentId },
      actorUserId: input.actorUserId,
      actorName: input.actorName ?? undefined,
      audience: { involved: [...(input.involved ?? []), ...pool], followers: true },
    });
  } catch (e) {
    // HLD-10: the hold itself is already written; a failed stop-work
    // announcement must at least be visible in the log, never a silent nothing.
    console.warn(`[holds] ${input.opened ? "hold_opened" : "hold_released"} notification failed (non-blocking)`, e);
  }
}

// ─── Aging sweep (HLD-14) ───────────────────────────────────────

/** A hold with no expected-release date is nudged once it has been open this
 *  long. Overridable per deployment (HOLD_AGING_DAYS); the default is a month. */
export const HOLD_AGING_DAYS = Math.max(1, Number(process.env.HOLD_AGING_DAYS) || 30);

/** HLD-14: the aging sweep. Rides the EXISTING /api/cron/maintenance route
 *  (a third vercel.json cron entry fails deployment on this plan), as one of
 *  the per-org compliance scans, on the shared client the cron swaps to the
 *  service role. For every open hold past its expected_release_at, or with
 *  no date and older than HOLD_AGING_DAYS, tells the opener and the
 *  policy-derived release pool ONCE per expectation — deduped by the hold id
 *  AND the expected date it missed (metadata.staleHoldId + staleFor, the
 *  escalateStaleCheckouts shape widened by the expectation): the nudge asks
 *  the opener to set a new expected date (the "Re-date" control beside
 *  Release on the inspector strip and /admin/holds →
 *  updateHoldExpectedRelease), and when that date passes too the hold is
 *  nudged again rather than aging silently. Returns the number of holds
 *  nudged. */
export async function scanStaleHolds(orgId: string, now: Date = new Date()): Promise<number> {
  const nowIso = now.toISOString();
  const agedBefore = new Date(now.getTime() - HOLD_AGING_DAYS * 86400_000).toISOString();
  const cols = "id, document_id, reason, opened_by, opened_by_name, opened_at, expected_release_at";
  const [late, aged] = await Promise.all([
    supabase.from("document_holds").select(cols).eq("org_id", orgId).is("released_at", null)
      .lt("expected_release_at", nowIso),
    supabase.from("document_holds").select(cols).eq("org_id", orgId).is("released_at", null)
      .is("expected_release_at", null).lt("opened_at", agedBefore),
  ]);
  if (late.error) throw new Error(late.error.message);
  if (aged.error) throw new Error(aged.error.message);
  type StaleRow = {
    id: string; document_id: string; reason: string; opened_by: string;
    opened_by_name: string | null; opened_at: string; expected_release_at: string | null;
  };
  const rows = new Map<string, StaleRow>();
  for (const r of [...((late.data as StaleRow[] | null) ?? []), ...((aged.data as StaleRow[] | null) ?? [])]) rows.set(r.id, r);
  if (rows.size === 0) return 0;

  const [{ emit }, policy] = await Promise.all([import("@/lib/notify/dispatch"), loadCapabilityPolicy(orgId)]);
  const pool = await resolveHoldAudience(orgId, policy);
  let nudged = 0;
  for (const h of rows.values()) {
    // The dedupe key is the hold AND the expectation it missed: a re-dated
    // hold that misses its new date is nudged again; an age nudge (no date)
    // fires once until a date is set.
    const staleFor = h.expected_release_at ?? "age";
    const { data: existing } = await supabase
      .from("notifications")
      .select("id")
      .eq("kind", "hold_opened")
      .contains("metadata", { staleHoldId: h.id, staleFor })
      .limit(1);
    if (((existing as unknown[] | null) ?? []).length > 0) continue;

    const { data: doc } = await supabase
      .from("documents").select("document_number, title, name, library_id")
      .eq("id", h.document_id).maybeSingle();
    const label = (doc?.document_number as string) || (doc?.title as string) || (doc?.name as string) || "a document";
    const openDays = Math.max(0, Math.floor((now.getTime() - Date.parse(h.opened_at)) / 86400_000));
    const lateDays = h.expected_release_at
      ? Math.max(0, Math.floor((now.getTime() - Date.parse(h.expected_release_at)) / 86400_000))
      : null;
    await emit({
      orgId,
      category: "sla",
      kind: "hold_opened",
      title: lateDays !== null
        ? `Hold past its expected release — ${label} (${h.reason})`
        : `Hold open ${openDays} days — ${label} (${h.reason})`,
      body: lateDays !== null
        ? `The "${h.reason}" hold ${h.opened_by_name ? `${h.opened_by_name} placed` : "placed"} on ${label} was expected to clear ${lateDays === 0 ? "today" : `${lateDays} day${lateDays === 1 ? "" : "s"} ago`}. Release it with a reason, or set a new expected date.`
        : `The "${h.reason}" hold ${h.opened_by_name ? `${h.opened_by_name} placed` : "placed"} on ${label} has been open ${openDays} days with no expected release date. Release it with a reason, or record when it is expected to clear.`,
      link: doc?.library_id ? `/documents/${doc.library_id}?doc=${h.document_id}` : "/admin/holds",
      resource: { type: "document", id: h.document_id },
      actorName: "System",
      audience: { involved: [h.opened_by, ...pool] },
      metadata: { staleHoldId: h.id, staleFor, escalation: true },
    });
    nudged += 1;
  }
  return nudged;
}

// ─── Reads ──────────────────────────────────────────────────────

/** All hold rows (active + released) for a document, newest first. */
export async function listHoldsForDocument(documentId: string): Promise<HoldRecord[]> {
  const { data, error } = await supabase
    .from("document_holds")
    .select("*")
    .eq("document_id", documentId)
    .order("opened_at", { ascending: false });
  if (error) throw new Error(error.message);
  return ((data as HoldRow[]) ?? []).map(rowToHold);
}

/** Just the active holds (released_at IS NULL) for a document. */
export async function listActiveHoldsForDocument(documentId: string): Promise<HoldRecord[]> {
  const { data, error } = await supabase
    .from("document_holds")
    .select("*")
    .eq("document_id", documentId)
    .is("released_at", null)
    .order("opened_at", { ascending: false });
  if (error) throw new Error(error.message);
  return ((data as HoldRow[]) ?? []).map(rowToHold);
}

/** Org-wide active hold queue for the bottleneck dashboard. */
export async function listActiveHoldsForOrg(orgId: string, opts?: { limit?: number }): Promise<HoldRecord[]> {
  const { data, error } = await supabase
    .from("document_holds")
    .select("*")
    .eq("org_id", orgId)
    .is("released_at", null)
    .order("opened_at", { ascending: true })   // oldest first — biggest blockers up top
    .limit(opts?.limit ?? 200);
  if (error) throw new Error(error.message);
  return ((data as HoldRow[]) ?? []).map(rowToHold);
}

// ─── Metrics ────────────────────────────────────────────────────
//
// Computed client-side so we don't add a SQL view in this phase.
// All input rows come from one org-scoped query, so the per-row
// math is cheap. If the active set grows beyond a few thousand we
// can swap in a Postgres view without changing this API.

export interface HoldMetrics {
  activeCount: number;
  /** Active count by reason, sorted descending. */
  activeByReason: Array<{ reason: string; count: number }>;
  /** Longest-running active hold in days (0 if no active holds). */
  longestActiveDays: number;
  /** Average duration of CLOSED holds in days (lookback window: 90d). */
  avgClosedDurationDays: number;
  /** Count of holds opened in the last 7 days. */
  openedLast7Days: number;
  /** Count of holds released in the last 7 days. */
  releasedLast7Days: number;
}

export async function getHoldMetrics(orgId: string, opts?: { windowDays?: number }): Promise<HoldMetrics> {
  // Default 90-day window for the closed-duration average, but fall back to
  // all-time when the window is empty. Multi-year turnaround sites can have
  // long gaps between holds, and a window that captures zero closed holds
  // would otherwise report a misleading "0 days" average. Caller can override
  // the window (e.g. an admin "all time" toggle passes a huge number).
  const windowDays = opts?.windowDays ?? 90;
  const windowStart = new Date(Date.now() - windowDays * 86400_000).toISOString();
  const sevenDaysAgo  = new Date(Date.now() - 7  * 86400_000).toISOString();

  const [activeResult, closedResult] = await Promise.all([
    supabase
      .from("document_holds")
      .select("reason, opened_at")
      .eq("org_id", orgId)
      .is("released_at", null),
    supabase
      .from("document_holds")
      .select("opened_at, released_at")
      .eq("org_id", orgId)
      .gte("released_at", windowStart),
  ]);

  if (activeResult.error) throw new Error(activeResult.error.message);
  if (closedResult.error)  throw new Error(closedResult.error.message);

  const active = (activeResult.data as Array<{ reason: string; opened_at: string }>) ?? [];
  let closed = (closedResult.data as Array<{ opened_at: string; released_at: string }>) ?? [];

  // Fall back to all-time closed holds if the window came back empty, so the
  // average reflects real history rather than reading "0 days" on a quiet
  // quarter.
  if (closed.length === 0) {
    const { data: allClosed } = await supabase
      .from("document_holds")
      .select("opened_at, released_at")
      .eq("org_id", orgId)
      .not("released_at", "is", null);
    closed = (allClosed as Array<{ opened_at: string; released_at: string }>) ?? [];
  }

  const reasonCounts = new Map<string, number>();
  let longestMs = 0;
  let openedLast7 = 0;
  for (const a of active) {
    reasonCounts.set(a.reason, (reasonCounts.get(a.reason) ?? 0) + 1);
    const age = Date.now() - new Date(a.opened_at).getTime();
    if (age > longestMs) longestMs = age;
    if (a.opened_at >= sevenDaysAgo) openedLast7++;
  }

  let closedDurationSum = 0;
  let releasedLast7 = 0;
  for (const c of closed) {
    closedDurationSum += durationMs(c.opened_at, c.released_at);
    if (c.released_at >= sevenDaysAgo) releasedLast7++;
  }

  const activeByReason = Array.from(reasonCounts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  return {
    activeCount: active.length,
    activeByReason,
    longestActiveDays: Math.round(longestMs / 86400_000),
    avgClosedDurationDays: closed.length ? Math.round((closedDurationSum / closed.length) / 86400_000) : 0,
    openedLast7Days: openedLast7,
    releasedLast7Days: releasedLast7,
  };
}

// ─── Helpers ────────────────────────────────────────────────────

function durationMs(openedAt: string, releasedAt: string | null): number {
  if (!releasedAt) return 0;
  return new Date(releasedAt).getTime() - new Date(openedAt).getTime();
}
