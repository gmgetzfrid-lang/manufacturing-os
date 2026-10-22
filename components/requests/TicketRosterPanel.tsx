"use client";

// TicketRosterPanel — who must act on a request's review, who did, who was
// told (drafting-flow Round G, DF-P5 ROSTER; GAP-103, FRIC-2, FRIC-4, DCW-6,
// TIER-5, TIER-8).
//
//   * A request in a routed library reviews on a PARALLEL roster (the ticket
//     carries it: metadata.review_roster). Every slot is listed — its label,
//     what it asks ("is this what I asked for" for the requester's own slot,
//     "is it correct" for a technical one), who fills it, and, once signed,
//     by whom and when. The viewer's own open slots get ONE "Sign off" button
//     (DEC-37: one sign-off fills every slot they can fill); it runs the
//     e-signature ceremony against THIS ticket, bound to the roster's content
//     hash (EVID-12), then posts `sign_slot` with the signature. A slot the
//     viewer occupies but may not sign says which independence rule blocks
//     it (DEC-37) — never a missing button.
//   * An unconfigured request (no routing table on its chain — today's
//     serial machine, unchanged) is shown the seeded default read-only
//     (lib/routingControl.ts seededSlotsFor): requester acceptance, then an
//     engineer where the gate applies.
//   * DCW-6: when the request targets a library with a review policy, the
//     policy's reviewers are surfaced here BEFORE the deliverable is approved.
//   * TIER-8: the panel says plainly that signing here approves the drafting
//     deliverable, and that publishing it as a revision is the library's own
//     review — a different question, not the same review twice.
//   * GAP-102 (DF-P20): an ASSURANCE slot (lib/assuranceExamination.ts — a
//     blocking slot that is not the engineering approval and not the
//     requester's own acceptance; never notify-only or consent-window) records
//     what its reviewer examined with the sign-off or the veto it backs: the
//     reviewed version's hash (the roster's, shortened, with a copy button),
//     the files examined (all by default; the reviewer may narrow) and a note
//     — required, asked here in place, for a revision request (with the same
//     reason category the page's Request Revision asks). Each assurance
//     sign-off shows its record (read from the roster's ledger); one signed
//     before DF-P20 says "Examination not recorded". A roster with no
//     assurance slot, and every request with none, is exactly as before:
//     nothing is read and nothing new is shown.
//
// Read only through the signed-in client (RLS decides); the one write is the
// workflow route.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Users, CheckCircle2, Clock, Bell, ShieldAlert, Loader2, Library } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { recordSignature, type SigningCredential, type SignatureIntent } from "@/lib/eSignatures";
import SignatureCeremony from "@/components/signatures/SignatureCeremony";
import { currentRoster, slotSignPlan, separationOfDutiesActive, engineeringGateRequired, slotBlocks, issueReadyFor, ISSUE_AS_IS_NOTE, unhashedFilesNote, ROUTED_NO_ROSTER_REASON } from "@/lib/workflow";
import { engineeringOverrideOf } from "@/lib/reviewModel";
import { seededSlotsFor, MODE_LABEL, isMissingRosterLedger } from "@/lib/routingControl";
import {
  isAssuranceSlot, rosterHasAssuranceSlot, rosterOnRecord, examinationFileKey, examinationOf, shortHash, examinedFilesText,
  EXAMINATION_NOT_RECORDED, EXAMINATION_NOTE_MAX, type ExaminationRecord,
} from "@/lib/assuranceExamination";
import { effectiveReviewControlForDocument, expandReviewers } from "@/lib/reviewControl";
import type { CapabilityPolicy } from "@/lib/capabilityPolicy";
import type { Ticket, TicketReviewRoster, TicketReviewSlot } from "@/types/schema";
import { appConfirm } from "@/components/providers/DialogProvider";
import { sourceDriftRefusalLabels, sourceDriftConfirmation } from "@/lib/requestPageReview";

export interface TicketRosterPanelProps {
  ticket: Ticket;
  orgId: string | null;
  uid: string | null;
  /** The viewer's display name for the signature statement. */
  userName?: string | null;
  capPolicy?: CapabilityPolicy | null;
  activeMemberCount?: number;
  /** The requester's current role collection (DEC-16), when known. */
  requesterRoles?: readonly string[] | null;
  /** Called after a sign-off lands, so the page re-reads the ticket. */
  onChanged?: () => void | Promise<void>;
  /** TIER-5 (DF-P5 fix pass 4): the request's library routes its reviews
   *  (the page's ticketReviewRouting). A routed review with no roster is
   *  NOT the unconfigured seed — its serial approvals are refused — so the
   *  panel says so instead of showing the seed. */
  reviewRouted?: boolean;
  /** Why (routedNoRosterReason — a routing table that can't be used names
   *  the document controller, not a revision). */
  reviewRoutedReason?: string | null;
  /** HAND-7 dw3 (DF-P18): the source documents that moved since the request
   *  was raised (the page's SourceDriftBanner read). Non-empty = a sign-off
   *  asks for the acknowledgement the workflow route requires, and sends
   *  `sourceDriftAcknowledged` with its dry run and its post. Absent / empty
   *  = the panel exactly as before. */
  sourceDrift?: readonly string[] | null;
}

/** HAND-7 dw3 (DF-P18): what the panel asks before a sign-off over a moved
 *  source (pure; exported for tests). null = nothing to ask. */
export function rosterDriftNote(sourceDrift: readonly string[] | null | undefined): string | null {
  const moved = (sourceDrift ?? []).filter((x) => typeof x === "string" && x.trim());
  return moved.length ? `The source revision has moved since this request was raised (${moved.join("; ")}). Signing off asks you to acknowledge it.` : null;
}

/** TIER-8: the one sentence that keeps the two reviews apart. */
export const TWO_REVIEWS_NOTE =
  "Signing here approves the drafting deliverable — the exact files listed, bound by their content hash. Publishing it as a revision of a controlled document is that library's own review: a different question (is this revision ready to be the current one?), asked once, at publish.";

/** DEC-13 / DEC-16 / DEC-36 (fix pass 2): why a slot the routing table did
 *  not declare is on the roster. */
export const ENGINEERING_GATE_NOTE =
  "Engineering sign-off was added to this review: this workspace requires an engineer to approve this request, and the routing table names none. A routing table adds reviewers; it never removes the engineering gate.";

/** The statement a sign-off's e-signature carries: what was reviewed, as
 *  which slots — and, when they apply, the issue-as-is mark (FRIC-5) and the
 *  files bound by identity rather than content (EVID-12). DF-P20: `examined`
 *  — the names of the files an assurance reviewer narrowed their examination
 *  to; said only when it is fewer than every file under review (absent or
 *  all: the statement is exactly as before). */
export function rosterSignStatement(input: {
  userName?: string | null;
  ticketLabel: string;
  roster: Pick<TicketReviewRoster, "cycle" | "files">;
  labels: string[];
  issueReady: boolean;
  examined?: string[] | null;
}): string {
  const { roster } = input;
  const unhashed = unhashedFilesNote(roster);
  const narrowed = input.examined && input.examined.length < roster.files.length ? `, having examined ${input.examined.join(", ")},` : "";
  return `I, ${input.userName ?? ""}, have reviewed ${input.ticketLabel}${roster.cycle ? ` Rev ${roster.cycle}` : ""} (${roster.files.map((f) => f.name).filter(Boolean).join(", ")})${narrowed} and sign off as ${input.labels.join(", ")}, and affirm this as my electronic signature.${input.issueReady ? ` ${ISSUE_AS_IS_NOTE}` : ""}${unhashed ? ` ${unhashed}` : ""}`;
}

/** DF-P20: what the panel sends as `examination` — the files picked (absent:
 *  every file under review) and the note (trimmed; null when blank). Pure. */
export function examinationBody(pick: string[] | null, note: string): { files?: string[]; note: string | null } {
  return { ...(pick ? { files: pick } : {}), note: note.trim() || null };
}

/** DF-P20 fix pass: the reason categories the panel's in-place revision
 *  request offers — the request page's own Request Revision list
 *  (REVISION_REASONS in app/(protected)/requests/[id]/page.tsx; a test pins
 *  the two equal), so a revision requested here carries its category too. */
export const REVISION_CATEGORIES: readonly string[] = [
  "Drafting Error",
  "Missing Information",
  "Incorrect Information",
  "Standards Violation",
  "Scope Change",
  "Design Update",
  "Other",
];

/** DF-P20: one row of the roster's ledger as the panel reads it. */
export interface SlotEventRow {
  id: string;
  roster_id: string;
  slot_kind: string;
  event: string;
  actor_id: string | null;
  actor_name: string | null;
  content_hash: string | null;
  details: unknown;
  created_at: string;
}

/** DF-P20: an examination record as the panel shows it — the reviewed
 *  version's hash shortened with a copy button (the full value is copied),
 *  the files examined, the note. */
export function ExaminationView({ record }: { record: ExaminationRecord }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    try {
      void navigator.clipboard?.writeText(record.contentHash).then(() => setCopied(true), () => undefined);
    } catch { /* no clipboard: the hash stays readable in the title */ }
  };
  return (
    <div data-testid="examination-record" className="mt-1 rounded border border-[var(--color-border)] px-2 py-1 text-[var(--color-text-muted)] space-y-0.5">
      <div>
        Reviewed version{record.cycle ? ` (Rev ${record.cycle})` : ""}: <code title={record.contentHash} data-testid="examination-hash">{shortHash(record.contentHash)}</code>{" "}
        <button type="button" onClick={copy} className="underline text-[var(--color-accent)]" aria-label="Copy the reviewed version's full content hash">{copied ? "Copied" : "Copy"}</button>
      </div>
      <div data-testid="examination-files">{examinedFilesText(record)}</div>
      {record.note && <div data-testid="examination-note">Note: {record.note}{record.noteTruncated ? "… (shortened — the full reason is the revision request's comment)" : ""}</div>}
    </div>
  );
}

/** FRIC-2: what a slot asks, as a person reads it. */
export function slotQuestion(slot: Pick<TicketReviewSlot, "kind" | "primaries">, ticket: Pick<Ticket, "requesterId">): string {
  const requesterOnly = slot.primaries.length === 1 && slot.primaries[0] === ticket.requesterId;
  return requesterOnly ? "Is this what you asked for?" : "Is it correct?";
}

/** The words for one slot's state. */
export function slotStateText(slot: TicketReviewSlot, names: ReadonlyMap<string, string>, now: number = Date.now(), openedAt?: string): string {
  if (slot.status === "satisfied") {
    const who = (slot.satisfiedBy && names.get(slot.satisfiedBy)) || slot.satisfiedByName || "someone";
    const how = slot.via === "alternate" ? " (as alternate)" : slot.via === "override" ? " (as an override)" : "";
    return `Signed by ${who}${how}${slot.satisfiedAt ? ` · ${new Date(slot.satisfiedAt).toLocaleString()}` : ""}`;
  }
  if (slot.status === "told") return `Told — ${slot.primaries.length} ${slot.primaries.length === 1 ? "person" : "people"}`;
  if (slot.status === "void") return "Closed — the review ended before this was signed";
  const n = slot.primaries.length;
  const waiting = `Waiting on any one of ${n} ${n === 1 ? "person" : "people"}${slot.fallback ? " (the management tier — the routing named nobody active)" : ""}`;
  if (slot.timeoutDays && openedAt && slot.alternates.length > 0) {
    const due = Date.parse(openedAt) + slot.timeoutDays * 86_400_000;
    return `${waiting} · alternates may sign ${now >= due ? "now" : `from ${new Date(due).toLocaleDateString()}`}`;
  }
  return waiting;
}

/**
 * Post a sign-off. Two people signing at the same moment: one write wins the
 * compare-and-set, the other is retried once on the fresh row — neither waits
 * on the other. DF-P5 fix pass 5: ONLY the compare-and-set conflict
 * (`conflict: true`) is retried; any other 409 is a refusal the route has
 * already recorded once (recordRefusedSignOff), and is returned as is — so a
 * refused signature is never refused (and recorded) twice.
 */
export async function postSignOffOnce(post: () => Promise<Response>): Promise<{ res: Response; out: { error?: string; warning?: string; conflict?: boolean } }> {
  let res = await post();
  let out = (await res.json().catch(() => ({}))) as { error?: string; warning?: string; conflict?: boolean };
  if (res.status === 409 && out.conflict === true) {
    res = await post();
    out = (await res.json().catch(() => ({}))) as typeof out;
  }
  return { res, out };
}

export default function TicketRosterPanel({
  ticket, orgId, uid, userName, capPolicy, activeMemberCount, requesterRoles, onChanged, reviewRouted, reviewRoutedReason, sourceDrift,
}: TicketRosterPanelProps) {
  // DF-P18 fix pass (review, blocker): the route reads the source documents
  // as the service role, so a move the page's own (RLS-limited) read could
  // not see comes back on the dry run as a 409 naming it — those labels
  // then stand in for the page's, and the panel asks from them.
  const [serverDrift, setServerDrift] = useState<string[]>([]);
  const driftNote = rosterDriftNote(sourceDrift && sourceDrift.length > 0 ? sourceDrift : serverDrift);
  const [driftAck, setDriftAck] = useState(false);
  const roster: TicketReviewRoster | null = useMemo(() => currentRoster(ticket), [ticket]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [libraryReview, setLibraryReview] = useState<{ mode: string; reviewers: string[] } | "none" | "unreadable" | null>(null);
  const [signing, setSigning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // GAP-102 (DF-P20): the roster's ledger, read only when the request's
  // roster (open or closed) carries an assurance slot; what the viewer
  // examined (null = every file under review) and their note.
  const recordRoster = useMemo(() => rosterOnRecord(ticket), [ticket]);
  const assuranceOnRecord = rosterHasAssuranceSlot(recordRoster, ticket);
  const [events, setEvents] = useState<SlotEventRow[] | "unreadable" | null>(null);
  // True once a sign-off with no event on record has been read again (the
  // event never came: "not recorded", as an event without a record says).
  const [eventsSettled, setEventsSettled] = useState(false);
  const [examPick, setExamPick] = useState<string[] | null>(null);
  const [examNote, setExamNote] = useState("");
  const [vetoCategory, setVetoCategory] = useState<string>(REVISION_CATEGORIES[0]);

  // Names of everyone the roster names (RLS: members of the workspace).
  useEffect(() => {
    if (!roster || !orgId) return;
    const uids = [...new Set(roster.slots.flatMap((s) => [...s.primaries, ...(s.satisfiedBy ? [s.satisfiedBy] : [])]))].slice(0, 200);
    if (uids.length === 0) return;
    let alive = true;
    void (async () => {
      const { data, error: e } = await supabase.from("org_members").select("uid, display_name, email").eq("org_id", orgId).in("uid", uids);
      if (!alive || e) return;
      setNames(new Map(((data ?? []) as Array<{ uid: string; display_name?: string | null; email?: string | null }>)
        .map((m) => [m.uid, (m.display_name ?? "").trim() || (m.email ?? "").split("@")[0] || "member"])));
    })();
    return () => { alive = false; };
  }, [roster, orgId]);

  // GAP-102 (DF-P20): the ledger's sign-off and veto events (RLS: read as
  // the ticket reads), re-read when a slot or the roster's state changes.
  // The route writes the ledger just AFTER the ticket row, so a sign-off
  // whose event is not there yet is read once more, shortly after.
  const eventsKey = recordRoster ? `${recordRoster.id}:${recordRoster.slots.filter((s) => s.status !== "open").length}:${recordRoster.closedAt ?? ""}` : "";
  const recordRosterId = recordRoster?.id ?? "";
  const signedAssuranceKey = recordRoster ? recordRoster.slots.filter((s) => s.status === "satisfied" && isAssuranceSlot(s, ticket)).map((s) => s.kind).join("\u0001") : "";
  useEffect(() => {
    if (!assuranceOnRecord || !ticket.id) { setEvents(null); setEventsSettled(false); return; }
    // A re-read (a sign-off just landed, a realtime refresh): the rows held
    // are the old ones, so nothing is "not recorded" until this read answers.
    setEventsSettled(false);
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const want = signedAssuranceKey ? signedAssuranceKey.split("\u0001") : [];
    const load = async (attempt: number) => {
      try {
        const { data, error: e } = await supabase.from("ticket_review_slot_events")
          .select("id, roster_id, slot_kind, event, actor_id, actor_name, content_hash, details, created_at")
          .eq("ticket_id", ticket.id).in("event", ["satisfied", "voided"]).order("created_at", { ascending: false }).limit(200);
        if (!alive) return;
        if (e) { setEvents(isMissingRosterLedger(e) ? [] : "unreadable"); setEventsSettled(true); return; }
        const rows = (data ?? []) as SlotEventRow[];
        setEvents(rows);
        const missing = want.some((k) => !rows.some((r) => r.roster_id === recordRosterId && r.slot_kind === k && r.event === "satisfied"));
        setEventsSettled(!missing || attempt > 0);
        if (missing && attempt === 0) timer = setTimeout(() => { void load(1); }, 2000);
      } catch {
        if (alive) setEvents("unreadable");
      }
    };
    void load(0);
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [assuranceOnRecord, ticket.id, eventsKey, recordRosterId, signedAssuranceKey]);
  // A new roster reviews new files: what was picked for the old one goes.
  useEffect(() => { setExamPick(null); }, [roster?.id]);

  // DCW-6: the target library's own review policy, before approval.
  useEffect(() => {
    if (!ticket.libraryId || !orgId) { setLibraryReview(null); return; }
    let alive = true;
    void (async () => {
      try {
        const control = await effectiveReviewControlForDocument({ libraryId: ticket.libraryId as string });
        if (!alive) return;
        if (!control || control.mode === "none") { setLibraryReview("none"); return; }
        const { primaries } = await expandReviewers(orgId, control);
        if (alive) setLibraryReview({ mode: control.mode, reviewers: primaries.map((p) => p.name || "member") });
      } catch {
        if (alive) setLibraryReview("unreadable");
      }
    })();
    return () => { alive = false; };
  }, [ticket.libraryId, orgId]);

  const sod = separationOfDutiesActive(activeMemberCount);
  const plan = roster ? slotSignPlan(roster, ticket, uid, sod) : null;
  // FRIC-5 (fix pass 2): the drafter's issue-as-is mark is in front of every
  // signer — on the panel and in the statement they sign.
  const issueReady = issueReadyFor(ticket);
  // EVID-12 (fix pass 2): files bound by identity, not content, are named.
  const unhashed = roster ? unhashedFilesNote(roster) : null;
  // GAP-102 (DF-P20): the viewer signs an assurance slot / occupies one they
  // may send back (a veto).
  const signsAssurance = !!plan && plan.fillable.some((f) => isAssuranceSlot(f.slot, ticket));
  const occupiesAssurance = !!plan && [...plan.fillable, ...plan.blocked].some((x) => isAssuranceSlot(x.slot, ticket));
  const examinedNames = roster && examPick ? roster.files.filter((f) => examPick.includes(examinationFileKey(f))).map((f) => f.name || "a file") : null;
  // The examination records the ledger holds: per slot of the roster under
  // review, and every record of an earlier round (a veto closes its roster).
  const eventRows = Array.isArray(events) ? events : [];
  // undefined: no event on record yet (the ledger is written just after the
  // ticket row); null: an event with no record (written before DF-P20).
  const slotRecord = (kind: string): ExaminationRecord | null | undefined => {
    const ev = roster ? eventRows.find((e) => e.roster_id === roster.id && e.slot_kind === kind && e.event === "satisfied") : undefined;
    return ev ? examinationOf(ev.details) : undefined;
  };
  const history = eventRows
    .filter((e) => (!roster || e.roster_id !== roster.id) && examinationOf(e.details))
    .slice(0, 20);

  const sign = useCallback(async (intent: SignatureIntent, statement: string, signatureImage?: string | null, reauth?: SigningCredential) => {
    if (!roster || !orgId || !uid || !ticket.id) return;
    setBusy(true);
    setError(null);
    try {
      const sig = await recordSignature({
        orgId, resourceType: "ticket", resourceId: ticket.id, contentHash: roster.contentHash,
        intent: intent === "Approved" ? "Approved" : "Reviewed", statement, signerUserId: uid, signerName: userName ?? "",
        signatureImage: signatureImage ?? null, reauth: reauth ?? null,
      });
      const { data: { session } } = await supabase.auth.getSession();
      const post = () => fetch("/api/tickets/workflow-action", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token ?? ""}` },
        body: JSON.stringify({ ticketId: ticket.id, actionType: "sign_slot", signatureId: sig.id, ...(driftNote && driftAck ? { sourceDriftAcknowledged: true } : {}), ...(signsAssurance ? { examination: examinationBody(examPick, examNote) } : {}) }),
      });
      const { res, out } = await postSignOffOnce(post);
      if (!res.ok) {
        // (DF-P18 fix pass) a source that moved after the dry run: the
        // refusal names it, so the acknowledgement checkbox shows from the
        // route's labels before the viewer signs again.
        const moved = res.status === 409 ? sourceDriftRefusalLabels(out) : null;
        if (moved) { setServerDrift(moved); setDriftAck(false); setSigning(false); }
        throw new Error(out.error || `The sign-off was not recorded (HTTP ${res.status})`);
      }
      setSigning(false);
      if (out.warning) setError(out.warning);
      await onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [roster, orgId, uid, ticket.id, userName, onChanged, driftNote, driftAck, signsAssurance, examPick, examNote]);

  // TIER-8 / EVID-12 (DF-P5 fix pass 3): the route is asked FIRST whether
  // it would take this sign-off (a dry run: nothing written, no signature),
  // so an e-signature is minted only for a sign-off that can land — never an
  // orphan attesting a review that satisfied nothing.
  const openCeremony = useCallback(async () => {
    if (!ticket.id) return;
    if (driftNote && !driftAck) { setError("Tick the acknowledgement that the source revision has moved before signing off."); return; }
    if (signsAssurance && examPick && examPick.length === 0) { setError("Mark at least one file you examined."); return; }
    setBusy(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const dryRun = (ack: boolean) => fetch("/api/tickets/workflow-action", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token ?? ""}` },
        body: JSON.stringify({ ticketId: ticket.id, actionType: "sign_slot", dryRun: true, ...(ack ? { sourceDriftAcknowledged: true } : {}), ...(signsAssurance ? { examination: examinationBody(examPick, examNote) } : {}) }),
      });
      const acked = !!driftNote && driftAck;
      let res = await dryRun(acked);
      let out = (await res.json().catch(() => ({}))) as { error?: string };
      // HAND-7 dw3 (DF-P18 fix pass): the route found a moved source the
      // panel was not told about — ask from the route's own labels, and on
      // the acknowledgement ask the dry run once more (never a second time).
      const moved = res.status === 409 && !acked ? sourceDriftRefusalLabels(out) : null;
      if (moved) {
        setServerDrift(moved);
        if (!(await appConfirm({ title: "The source revision has moved", message: sourceDriftConfirmation(moved), confirmLabel: "Acknowledge and continue" }))) return;
        setDriftAck(true);
        res = await dryRun(true);
        out = (await res.json().catch(() => ({}))) as { error?: string };
      }
      if (!res.ok) throw new Error(out.error || `This sign-off can't be taken right now (HTTP ${res.status})`);
      setSigning(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [ticket.id, driftNote, driftAck, signsAssurance, examPick, examNote]);

  // GAP-102 (DF-P20): a veto in place — the revision request, with the note
  // (required: a rejection must say why) as its comment and the record of
  // what was examined. One step: nothing else is asked.
  const veto = useCallback(async () => {
    if (!ticket.id) return;
    const note = examNote.trim();
    if (!note) { setError("Say why you are requesting a revision — the note is required."); return; }
    if (examPick && examPick.length === 0) { setError("Mark at least one file you examined."); return; }
    setBusy(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/tickets/workflow-action", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token ?? ""}` },
        body: JSON.stringify({ ticketId: ticket.id, actionType: "request_revision", comment: note, category: vetoCategory, examination: { ...(examPick ? { files: examPick } : {}), note } }),
      });
      const out = (await res.json().catch(() => ({}))) as { error?: string; warning?: string };
      if (!res.ok) throw new Error(out.error || `The revision request was not recorded (HTTP ${res.status})`);
      if (out.warning) setError(out.warning);
      setExamNote("");
      setExamPick(null);
      setVetoCategory(REVISION_CATEGORIES[0]);
      await onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [ticket.id, examNote, examPick, vetoCategory, onChanged]);

  const inReview = ticket.status === "PENDING_REVIEW" || ticket.status === "PENDING_FINAL_APPROVAL";
  // TIER-5 (DF-P5 fix pass 4): routed with no roster — no seed (that is the
  // unconfigured picture, and its approvals are refused here); the way
  // forward instead.
  const routedNoRoster = !roster && inReview && reviewRouted === true;
  const showSeed = !roster && inReview && !routedNoRoster;
  if (!roster && !showSeed && !routedNoRoster && !libraryReview && history.length === 0) return null;

  return (
    <section data-testid="ticket-roster-panel" className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Users className="w-4 h-4 text-[var(--color-accent)]" />
        <h3 className="text-sm font-black text-[var(--color-text)]">Review</h3>
        {roster && <span className="text-[10px] font-bold text-[var(--color-text-muted)]">Sign-offs in any order{roster.cycle ? ` · Rev ${roster.cycle}` : ""}</span>}
      </div>

      {roster && (
        <ul className="space-y-2" data-testid="roster-slots">
          {roster.slots.map((s) => {
            const blockedHere = plan?.blocked.find((b) => b.slot.kind === s.kind);
            return (
              <li key={s.id} className="flex items-start gap-2 text-xs">
                {s.status === "satisfied" ? <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" />
                  : s.status === "told" ? <Bell className="w-4 h-4 text-[var(--color-text-faint)] shrink-0" />
                  : <Clock className="w-4 h-4 text-amber-600 shrink-0" />}
                <div className="min-w-0">
                  <div className="font-bold text-[var(--color-text)]">
                    {s.label} <span className="font-normal text-[var(--color-text-muted)]">— {slotBlocks(s) ? slotQuestion(s, ticket) : MODE_LABEL.notify_only}</span>
                  </div>
                  <div className="text-[var(--color-text-muted)]">{slotStateText(s, names, Date.now(), roster.openedAt)}</div>
                  {s.status === "open" && s.primaries.length > 0 && s.primaries.length <= 8 && (
                    <div className="text-[var(--color-text-faint)]">{s.primaries.map((p) => names.get(p) ?? "member").join(", ")}</div>
                  )}
                  {blockedHere && <div className="text-red-700 flex items-center gap-1"><ShieldAlert className="w-3 h-3" /> {blockedHere.reason}</div>}
                  {s.status === "satisfied" && s.via !== "consent" && events !== null && isAssuranceSlot(s, ticket) && (() => {
                    if (events === "unreadable") return <div className="text-[var(--color-text-faint)]" data-testid="examination-unreadable">The record of what was examined could not be read right now.</div>;
                    const rec = slotRecord(s.kind);
                    if (rec === undefined && !eventsSettled) return null;
                    return rec ? <ExaminationView record={rec} /> : <div className="text-[var(--color-text-faint)]" data-testid="examination-not-recorded">{EXAMINATION_NOT_RECORDED}</div>;
                  })()}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {roster?.engineeringGateAdded && (
        <p className="text-xs text-[var(--color-text-muted)]" data-testid="engineering-gate-added">{ENGINEERING_GATE_NOTE}</p>
      )}

      {roster && issueReady && (
        <p role="note" className="text-xs font-bold text-amber-800" data-testid="roster-issue-as-is">{ISSUE_AS_IS_NOTE}</p>
      )}

      {roster && unhashed && (
        <p className="text-xs text-[var(--color-text-muted)]" data-testid="roster-unhashed-files">{unhashed}</p>
      )}

      {roster && plan && plan.fillable.length > 0 && driftNote && (
        <label className="flex items-start gap-2 text-xs text-amber-900" data-testid="roster-source-drift">
          <input type="checkbox" checked={driftAck} onChange={(e) => setDriftAck(e.target.checked)} className="mt-0.5" />
          <span>{driftNote} I have checked the draft against the current revision.</span>
        </label>
      )}

      {roster && occupiesAssurance && (
        <fieldset className="text-xs space-y-1.5 rounded-lg border border-[var(--color-border)] p-2" data-testid="examination-form" disabled={busy || signing}>
          <legend className="font-bold text-[var(--color-text)] px-1">What you examined</legend>
          <div className="text-[var(--color-text-muted)]">
            Recorded with your sign-off or revision request, against the reviewed version <code title={roster.contentHash}>{shortHash(roster.contentHash)}</code>.
          </div>
          <ul className="space-y-0.5">
            {roster.files.map((f) => {
              const key = examinationFileKey(f);
              const checked = examPick ? examPick.includes(key) : true;
              return (
                <li key={key || f.name || "file"}>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        const cur = examPick ?? roster.files.map(examinationFileKey);
                        const next = e.target.checked ? [...new Set([...cur, key])] : cur.filter((k) => k !== key);
                        setExamPick(next.length === roster.files.length ? null : next);
                      }}
                    />
                    <span>{f.name || "a file"}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          <label className="block">
            <span className="text-[var(--color-text-muted)]">Note — optional with a sign-off; required to request a revision</span>
            <textarea
              value={examNote}
              onChange={(e) => setExamNote(e.target.value)}
              maxLength={EXAMINATION_NOTE_MAX}
              rows={2}
              data-testid="examination-note-input"
              className="mt-0.5 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-1 text-[var(--color-text)]"
            />
          </label>
          <label className="block">
            <span className="text-[var(--color-text-muted)]">Reason category — with a revision request</span>
            <select
              value={vetoCategory}
              onChange={(e) => setVetoCategory(e.target.value)}
              data-testid="examination-veto-category"
              className="mt-0.5 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-1 text-[var(--color-text)]"
            >
              {REVISION_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <div className="text-[var(--color-text-faint)]" data-testid="examination-veto-redline">To send a redline with it, use the page&rsquo;s Request Revision — it records every file, with your comment as the note.</div>
          <button
            type="button"
            onClick={() => { void veto(); }}
            data-testid="examination-veto"
            className="px-3 py-1.5 rounded-lg text-xs font-bold bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
          >
            Request revision
          </button>
        </fieldset>
      )}

      {roster && plan && plan.fillable.length > 0 && (
        <button
          type="button"
          onClick={() => { void openCeremony(); }}
          disabled={busy}
          className="px-4 py-2 rounded-lg text-sm font-bold bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin inline mr-1" /> : null}
          Sign off — {plan.fillable.map((f) => f.slot.label).join(", ")}
        </button>
      )}

      {routedNoRoster && (
        <div className="text-xs space-y-1" data-testid="routed-no-roster">
          <div className="font-bold text-[var(--color-text)] flex items-center gap-1"><ShieldAlert className="w-3.5 h-3.5 text-amber-600" /> No sign-off roster</div>
          <p className="text-[var(--color-text-muted)]">{reviewRoutedReason || ROUTED_NO_ROSTER_REASON}</p>
        </div>
      )}

      {showSeed && (
        <ul className="space-y-1 text-xs" data-testid="seeded-slots">
          {seededSlotsFor(ticket, engineeringGateRequired(ticket, requesterRoles, capPolicy), !!engineeringOverrideOf(ticket)).map((v) => (
            <li key={v.kind} className="text-[var(--color-text-muted)]">
              <span className="font-bold text-[var(--color-text)]">{v.label}</span> — {v.occupant} ·{" "}
              {v.state === "waiting" ? "waiting now" : v.state === "pending" ? "after the step before it" : v.state === "done" ? "done" : v.state === "overridden" ? "issued by management override — no engineer sign-off" : "not required for this request"}
            </li>
          ))}
        </ul>
      )}

      {libraryReview && libraryReview !== "none" && (
        <div className="text-xs text-[var(--color-text-muted)] flex items-start gap-1.5" data-testid="library-review-policy">
          <Library className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          {libraryReview === "unreadable"
            ? <span>This request&apos;s library has a publish review policy that could not be read right now.</span>
            : <span>This request&apos;s library reviews revisions before they publish ({libraryReview.mode === "require" ? "always" : "when the publisher routes it"}){libraryReview.reviewers.length ? `: ${libraryReview.reviewers.slice(0, 8).join(", ")}` : ""}.</span>}
        </div>
      )}

      {(roster || (libraryReview && libraryReview !== "none")) && (
        <p className="text-[10px] text-[var(--color-text-faint)]" data-testid="two-reviews-note">{TWO_REVIEWS_NOTE}</p>
      )}

      {history.length > 0 && (
        <div className="text-xs space-y-1" data-testid="examination-history">
          <div className="font-bold text-[var(--color-text)]">What assurance reviewers examined{roster ? " — earlier rounds" : ""}</div>
          <ul className="space-y-1.5">
            {history.map((e) => {
              const rec = examinationOf(e.details)!;
              const label = recordRoster?.id === e.roster_id ? (recordRoster.slots.find((x) => x.kind === e.slot_kind)?.label || e.slot_kind) : e.slot_kind;
              return (
                <li key={e.id}>
                  <span className="font-bold text-[var(--color-text)]">{label}</span>{" "}
                  <span className="text-[var(--color-text-muted)]">— {rec.act === "veto" ? "revision requested" : "signed off"} by {(e.actor_id && names.get(e.actor_id)) || e.actor_name || "someone"} · {new Date(e.created_at).toLocaleString()}</span>
                  <ExaminationView record={rec} />
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {error && <div role="alert" className="text-xs text-red-700">{error}</div>}

      {signing && roster && (
        <SignatureCeremony
          signerName={userName ?? ""}
          resourceLabel={`${ticket.ticketId}${roster.cycle ? ` Rev ${roster.cycle}` : ""}`}
          defaultIntent="Reviewed"
          defaultStatement={rosterSignStatement({ userName, ticketLabel: ticket.ticketId, roster, labels: (plan?.fillable ?? []).map((f) => f.slot.label), issueReady, ...(signsAssurance ? { examined: examinedNames } : {}) })}
          lockIntent
          busy={busy}
          onCancel={() => !busy && setSigning(false)}
          onSign={sign}
        />
      )}
    </section>
  );
}
