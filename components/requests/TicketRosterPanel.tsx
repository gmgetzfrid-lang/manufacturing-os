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
//
// Read only through the signed-in client (RLS decides); the one write is the
// workflow route.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Users, CheckCircle2, Clock, Bell, ShieldAlert, Loader2, Library } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { recordSignature, type SigningCredential, type SignatureIntent } from "@/lib/eSignatures";
import SignatureCeremony from "@/components/signatures/SignatureCeremony";
import { currentRoster, slotSignPlan, separationOfDutiesActive, engineeringGateRequired, slotBlocks, issueReadyFor, ISSUE_AS_IS_NOTE, unhashedFilesNote, ROUTED_NO_ROSTER_REASON } from "@/lib/workflow";
import { seededSlotsFor, MODE_LABEL } from "@/lib/routingControl";
import { effectiveReviewControlForDocument, expandReviewers } from "@/lib/reviewControl";
import type { CapabilityPolicy } from "@/lib/capabilityPolicy";
import type { Ticket, TicketReviewRoster, TicketReviewSlot } from "@/types/schema";

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
 *  files bound by identity rather than content (EVID-12). */
export function rosterSignStatement(input: {
  userName?: string | null;
  ticketLabel: string;
  roster: Pick<TicketReviewRoster, "cycle" | "files">;
  labels: string[];
  issueReady: boolean;
}): string {
  const { roster } = input;
  const unhashed = unhashedFilesNote(roster);
  return `I, ${input.userName ?? ""}, have reviewed ${input.ticketLabel}${roster.cycle ? ` Rev ${roster.cycle}` : ""} (${roster.files.map((f) => f.name).filter(Boolean).join(", ")}) and sign off as ${input.labels.join(", ")}, and affirm this as my electronic signature.${input.issueReady ? ` ${ISSUE_AS_IS_NOTE}` : ""}${unhashed ? ` ${unhashed}` : ""}`;
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
  ticket, orgId, uid, userName, capPolicy, activeMemberCount, requesterRoles, onChanged, reviewRouted, reviewRoutedReason,
}: TicketRosterPanelProps) {
  const roster: TicketReviewRoster | null = useMemo(() => currentRoster(ticket), [ticket]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [libraryReview, setLibraryReview] = useState<{ mode: string; reviewers: string[] } | "none" | "unreadable" | null>(null);
  const [signing, setSigning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        body: JSON.stringify({ ticketId: ticket.id, actionType: "sign_slot", signatureId: sig.id }),
      });
      const { res, out } = await postSignOffOnce(post);
      if (!res.ok) throw new Error(out.error || `The sign-off was not recorded (HTTP ${res.status})`);
      setSigning(false);
      if (out.warning) setError(out.warning);
      await onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [roster, orgId, uid, ticket.id, userName, onChanged]);

  // TIER-8 / EVID-12 (DF-P5 fix pass 3): the route is asked FIRST whether
  // it would take this sign-off (a dry run: nothing written, no signature),
  // so an e-signature is minted only for a sign-off that can land — never an
  // orphan attesting a review that satisfied nothing.
  const openCeremony = useCallback(async () => {
    if (!ticket.id) return;
    setBusy(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/tickets/workflow-action", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token ?? ""}` },
        body: JSON.stringify({ ticketId: ticket.id, actionType: "sign_slot", dryRun: true }),
      });
      const out = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(out.error || `This sign-off can't be taken right now (HTTP ${res.status})`);
      setSigning(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [ticket.id]);

  const inReview = ticket.status === "PENDING_REVIEW" || ticket.status === "PENDING_FINAL_APPROVAL";
  // TIER-5 (DF-P5 fix pass 4): routed with no roster — no seed (that is the
  // unconfigured picture, and its approvals are refused here); the way
  // forward instead.
  const routedNoRoster = !roster && inReview && reviewRouted === true;
  const showSeed = !roster && inReview && !routedNoRoster;
  if (!roster && !showSeed && !routedNoRoster && !libraryReview) return null;

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
          {seededSlotsFor(ticket, engineeringGateRequired(ticket, requesterRoles, capPolicy)).map((v) => (
            <li key={v.kind} className="text-[var(--color-text-muted)]">
              <span className="font-bold text-[var(--color-text)]">{v.label}</span> — {v.occupant} ·{" "}
              {v.state === "waiting" ? "waiting now" : v.state === "pending" ? "after the step before it" : v.state === "done" ? "done" : "not required for this request"}
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

      {error && <div role="alert" className="text-xs text-red-700">{error}</div>}

      {signing && roster && (
        <SignatureCeremony
          signerName={userName ?? ""}
          resourceLabel={`${ticket.ticketId}${roster.cycle ? ` Rev ${roster.cycle}` : ""}`}
          defaultIntent="Reviewed"
          defaultStatement={rosterSignStatement({ userName, ticketLabel: ticket.ticketId, roster, labels: (plan?.fillable ?? []).map((f) => f.slot.label), issueReady })}
          lockIntent
          busy={busy}
          onCancel={() => !busy && setSigning(false)}
          onSign={sign}
        />
      )}
    </section>
  );
}
