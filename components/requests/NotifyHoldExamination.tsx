"use client";

// components/requests/NotifyHoldExamination.tsx
//
// drafting-flow Round G, DF-P25 — GAP-102 ruling (2), the notify-only limb.
// A notify-only slot the document controller opted in to recording what its
// people examined (lib/routingControl.ts notifyExaminationOptInAllowed →
// the roster slot's `recordsExamination` on a notify_only slot) is told,
// never waited on. Its people's stop is a document HOLD on the request's
// source document, and the hold carries what they examined in its OWN
// insert (document_holds.examination, 20261267 — lib/holds.ts openHold), so
// the record and the stop cannot disagree. This panel:
//   * shows each hold placed from this request with its record (read as the
//     viewer reads holds — RLS), and
//   * offers that slot's own people, while the review is open and the
//     request names a source document, "Stop it with a hold" — the files
//     they examined (every file under review by default), a note of what
//     they found (required — a stop says why) and the hold's reason.
//     The form is offered only when the viewer may place holds (holds.open,
//     judged by lib/holds.ts holdControlsFor — the same policy, additive
//     roles and read-only subtraction openHold's capability check applies);
//     otherwise the occupant is told plainly they cannot stop it with a hold
//     and where an Admin allows it. The policy is read for this (fail
//     closed: until it is read, or when it cannot be, no form). A round with
//     no files under review records the note alone.
// A record is shown as a slot's stop ONLY when the hold's opener (opened_by —
// tied to the session for a record, and pinned once it carries one, by
// 20261267's opener checks) is one of
// that notify-only slot's people in the round the record names (the roster
// on record, or the roster ledger ticket_review_slots for an earlier round —
// lib/assuranceExamination.ts holdOpenerInSlot). Any other record is counted,
// never shown as anyone's stop. A slot's stop is headed with the name the
// workspace's member list gives that opener (org_members, read as the
// viewer) — never the hold's opened_by_name, which its writer typed (it is
// not even read). The holds are read filtered to this request in the query
// (examination->>ticketId), and a full page says more exist.
// It renders NOTHING and reads NOTHING on a request whose roster has no such
// slot (every request today) — the roster panel is exactly as before. It
// adds no sign-off and no wait; nothing about the review's sign-offs, vetoes
// or ledger changes.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { currentRoster } from "@/lib/workflow";
import { parseSourceDocument } from "@/lib/sourceDocRef";
import {
  rosterOnRecord, isNotifyExaminationSlot, holdExaminationRecord, holdExaminationOf, examinationFileKey, examinedFilesText, shortHash,
  EXAMINATION_NOTE_MAX, rosterOccupancy, holdOpenerInSlot, type SlotOccupancy,
} from "@/lib/assuranceExamination";
import { openHold, isMissingHoldExaminationColumn, holdControlsFor, HOLD_REASON_CODES, OTHER_HOLD_REASON } from "@/lib/holds";
import { loadCapabilityPolicyEntry, type CapabilityPolicy } from "@/lib/capabilityPolicy";
import { affordancePolicyFault } from "@/lib/checkoutAffordances";
import type { Ticket } from "@/types/schema";

export interface NotifyHoldExaminationProps {
  ticket: Ticket;
  orgId: string | null;
  uid: string | null;
  userName?: string | null;
  /** The viewer's headline role and additive role collection (useRole()),
   *  for the holds.open check that decides whether the form is offered. */
  role?: string | null;
  roles?: readonly string[] | null;
}

/** What the panel says when the hold landed but its record could not be
 *  stored (the database has no column for it yet — before 20261267). */
export const HOLD_RECORD_NOT_STORED =
  "The hold is placed. What you examined could not be stored with it yet (the database update 20261267 is not applied) — add it to the hold's description if it matters.";
/** DF-P25 (review fix pass 4): what the panel says when the hold landed
 *  but the database refused its record for size. */
export const HOLD_RECORD_TOO_LARGE =
  "The hold is placed. What you examined was too large to store with it — add what matters to the hold's description.";
/** How many holds the panel reads for one request (a fuller page says more exist). */
export const NOTIFY_HOLD_READ_LIMIT = 50;
/** What the panel says when the read filled its page. */
export const NOTIFY_HOLDS_MORE =
  `Only the ${NOTIFY_HOLD_READ_LIMIT} newest holds placed from this request are shown — more exist on the source document.`;
/** What the panel says of records it will not show as a slot's stop. */
export const notSlotHoldsText = (n: number): string =>
  `${n} hold${n === 1 ? "" : "s"} on the source document name${n === 1 ? "s" : ""} this request but ${n === 1 ? "was" : "were"} not placed by the people of the slot named — not shown as their stop.`;
export const uncheckedHoldsText = (n: number): string =>
  `${n} hold${n === 1 ? "" : "s"} from an earlier review round could not be checked against that round's slot (its roster record could not be read) — not shown.`;
/** What the panel says to an occupant whose role may not place holds. */
export const HOLD_NOT_PERMITTED =
  "Your role isn't allowed to place holds, so you cannot stop this review with a hold. An Admin can change this under Admin → Permissions → Action permissions (Place a hold). To stop it now, raise it with the assignment queue.";
/** What the panel says when whether the viewer may place holds could not be read. */
export const holdPermissionUncheckedText = (why: string): string =>
  `Whether you may place a hold could not be checked just now (${why}).`;
/** What the panel says when the round has no files under review. */
export const NO_FILES_UNDER_REVIEW =
  "There are no files under review in this round — what you found is the record.";
/** Who a slot's stop is shown as placed by: the opener's name from the
 *  workspace's member list (`names`, uid → display name), never the hold's
 *  own opened_by_name (written by the client that placed it); when the
 *  member list could not give a name, the slot's people, unnamed. Pure. */
export function slotStopHolder(openedBy: string, names: ReadonlyMap<string, string>, slotLabel: string | null | undefined): string {
  return names.get(openedBy) || `a member of ${slotLabel || "this slot"}`;
}

/** What the panel says to an occupant when the request names no document. */
export const NO_SOURCE_TO_HOLD =
  "This request names no controlled document, so there is nothing to hold. To stop it, raise it with the assignment queue.";

interface HoldRow {
  id: string;
  reason: string;
  notes: string | null;
  opened_by: string;
  opened_at: string;
  released_at: string | null;
  examination: unknown;
}

export default function NotifyHoldExamination({ ticket, orgId, uid, userName, role, roles }: NotifyHoldExaminationProps) {
  const ticketId = ticket.id ?? "";
  const recordRoster = useMemo(() => rosterOnRecord(ticket), [ticket]);
  const recordRosterId = recordRoster?.id ?? null;
  const openRoster = useMemo(() => currentRoster(ticket), [ticket]);
  const slots = useMemo(() => (recordRoster ? recordRoster.slots.filter((s) => isNotifyExaminationSlot(s, ticket)) : []), [recordRoster, ticket]);
  const active = slots.length > 0;
  const source = useMemo(() => (active ? parseSourceDocument(ticket.metadata) : null), [active, ticket.metadata]);
  const sourceId = source?.id ?? null;
  const occupantSlot = useMemo(() => (openRoster && uid
    ? openRoster.slots.find((s) => isNotifyExaminationSlot(s, ticket) && (s.primaries.includes(uid) || (s.alternates ?? []).includes(uid)))
    : undefined), [openRoster, uid, ticket]);

  const [holds, setHolds] = useState<HoldRow[] | "unreadable" | "not_migrated" | null>(null);
  const [more, setMore] = useState(false);
  const [ledger, setLedger] = useState<SlotOccupancy[]>([]);
  const [openerNames, setOpenerNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [reloadKey, setReloadKey] = useState(0);
  const [pick, setPick] = useState<string[] | null>(null);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState<string>(OTHER_HOLD_REASON);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);
  const [policy, setPolicy] = useState<CapabilityPolicy | null>(null);
  const [policyFault, setPolicyFault] = useState<string | null>(null);
  const [policyTry, setPolicyTry] = useState(0);
  const offerForm = !!occupantSlot && !!sourceId && !!orgId;

  // Whether the occupant may place holds at all (holds.open), read only for
  // an occupant who would be offered the form. Fail closed: no policy read,
  // no form — the same rule as the hold strip (AUTHZ-15).
  useEffect(() => {
    if (!offerForm || !orgId) { setPolicy(null); setPolicyFault(null); return; }
    let alive = true;
    void loadCapabilityPolicyEntry(orgId)
      .then((e) => {
        if (!alive) return;
        const fault = affordancePolicyFault(e);
        if (fault) { setPolicy(null); setPolicyFault(fault); return; }
        setPolicy(e.policy); setPolicyFault(null);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setPolicy(null); setPolicyFault((err as Error)?.message || "the capability policy could not be read");
      });
    return () => { alive = false; };
  }, [offerForm, orgId, policyTry]);
  const mayPlace = !!policy && holdControlsFor(policy, role ?? null, roles ?? null, uid).canOpen;

  useEffect(() => {
    if (!active || !sourceId || !orgId || !ticketId) { setHolds(null); return; }
    let alive = true;
    void (async () => {
      // Filtered to THIS request in the query, so other requests' holds on
      // the same document never crowd it out of the page.
      const { data, error } = await supabase.from("document_holds")
        .select("id, reason, notes, opened_by, opened_at, released_at, examination")
        .eq("org_id", orgId).eq("document_id", sourceId).eq("examination->>ticketId", ticketId)
        .order("opened_at", { ascending: false }).limit(NOTIFY_HOLD_READ_LIMIT + 1);
      if (!alive) return;
      if (error) { setHolds(isMissingHoldExaminationColumn(error) ? "not_migrated" : "unreadable"); setMore(false); setLedger([]); setOpenerNames(new Map()); return; }
      const all = (data ?? []) as HoldRow[];
      const rows = all.slice(0, NOTIFY_HOLD_READ_LIMIT).filter((h) => holdExaminationOf(h.examination, ticketId) !== null);
      // An earlier round's slots come from the roster ledger (read as the
      // viewer). Unreadable → those records stay unchecked, never shown.
      const earlier = [...new Set(rows.map((h) => holdExaminationOf(h.examination, ticketId)?.rosterId).filter((x): x is string => !!x && x !== recordRosterId))];
      let occ: SlotOccupancy[] = [];
      if (earlier.length > 0) {
        const { data: slotRows, error: slotErr } = await supabase.from("ticket_review_slots")
          .select("roster_id, slot_kind, label, mode, primaries, alternates")
          .eq("org_id", orgId).eq("ticket_id", ticketId).in("roster_id", earlier);
        if (!alive) return;
        if (!slotErr) {
          occ = ((slotRows ?? []) as Array<{ roster_id: string; slot_kind: string; label: string | null; mode: string; primaries: string[] | null; alternates: string[] | null }>)
            .map((r) => ({ rosterId: r.roster_id, kind: r.slot_kind, mode: r.mode, primaries: r.primaries ?? [], alternates: r.alternates ?? [], label: r.label }));
        }
      }
      // The openers' names come from the member list (read as the viewer),
      // never from the hold's own opened_by_name. Unreadable → unnamed.
      const openers = [...new Set(rows.map((h) => h.opened_by).filter((x): x is string => !!x))];
      let names = new Map<string, string>();
      if (openers.length > 0) {
        const { data: mem, error: memErr } = await supabase.from("org_members")
          .select("uid, display_name, email").eq("org_id", orgId).in("uid", openers);
        if (!alive) return;
        if (!memErr) {
          names = new Map(((mem ?? []) as Array<{ uid: string; display_name?: string | null; email?: string | null }>)
            .map((m) => [m.uid, (m.display_name ?? "").trim() || (m.email ?? "").split("@")[0] || "member"]));
        }
      }
      setOpenerNames(names);
      setLedger(occ);
      setMore(all.length > NOTIFY_HOLD_READ_LIMIT);
      setHolds(rows);
    })();
    return () => { alive = false; };
  }, [active, sourceId, orgId, ticketId, reloadKey, recordRosterId]);

  const files = openRoster?.files ?? [];
  const allKeys = files.map(examinationFileKey);
  const picked = pick ?? allKeys;

  const place = useCallback(async () => {
    if (!openRoster || !occupantSlot || !sourceId || !orgId || !uid || !ticketId) return;
    setMessage(null);
    // A round with no files under review: the note alone is the record.
    const built = holdExaminationRecord(openRoster, ticketId, occupantSlot, { files: files.length > 0 ? picked : undefined, note }, description);
    if (!built.ok) { setMessage({ tone: "error", text: built.error }); return; }
    if (reason === OTHER_HOLD_REASON && !description.trim()) {
      setMessage({ tone: "error", text: `An "${OTHER_HOLD_REASON}" hold needs a description — say what the document is held for.` });
      return;
    }
    setBusy(true);
    try {
      const hold = await openHold({
        orgId, documentId: sourceId, reason, notes: description.trim() || undefined,
        openedBy: uid, openedByName: userName ?? undefined, examination: { ...built.record },
      });
      setMessage(hold.examinationNotRecorded ? { tone: "warn", text: hold.examinationTooLarge ? HOLD_RECORD_TOO_LARGE : HOLD_RECORD_NOT_STORED } : { tone: "ok", text: "Hold placed, with what you examined." });
      setNote("");
      setDescription("");
      setPick(null);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setMessage({ tone: "error", text: (e as Error)?.message ?? String(e) });
    } finally {
      setBusy(false);
    }
  }, [openRoster, occupantSlot, sourceId, orgId, uid, ticketId, files.length, picked, note, description, reason, userName]);

  if (!active) return null;

  const occupancy = [...rosterOccupancy(recordRoster), ...ledger];
  const judged = (Array.isArray(holds) ? holds : []).map((h) => {
    const rec = holdExaminationOf(h.examination, ticketId)!;
    // the slot's name as the round named it, never the record's own claim
    const label = occupancy.find((o) => o.rosterId === rec.rosterId && o.kind === rec.slotKind)?.label || rec.slotKind;
    return { h, rec, label, by: holdOpenerInSlot(h.opened_by, rec, occupancy) };
  });
  const placed = judged.filter((j) => j.by === "slot");
  const notSlot = judged.filter((j) => j.by === "not_slot").length;
  const unchecked = judged.filter((j) => j.by === "unknown").length;
  return (
    <div className="text-xs space-y-2" data-testid="notify-hold-examination">
      <div className="font-bold text-[var(--color-text)] flex items-center gap-1.5">
        <ShieldAlert className="w-3.5 h-3.5" /> Stops by the people told, with what they examined
      </div>
      {holds === "not_migrated" && <p className="text-[var(--color-text-faint)]" data-testid="notify-hold-not-migrated">Hold records of what was examined are kept from the database update 20261267.</p>}
      {holds === "unreadable" && <p className="text-[var(--color-text-faint)]" data-testid="notify-hold-unreadable">The holds on the source document could not be read just now.</p>}
      {placed.length > 0 && (
        <ul className="space-y-1.5" data-testid="notify-hold-list">
          {placed.map(({ h, rec, label }) => {
            return (
              <li key={h.id}>
                <span className="font-bold text-[var(--color-text)]">{label || "Told"}</span>{" "}
                <span className="text-[var(--color-text-muted)]">— held by {slotStopHolder(h.opened_by, openerNames, label)} · {new Date(h.opened_at).toLocaleString()}{h.released_at ? ` · released ${new Date(h.released_at).toLocaleString()}` : " · in force"}</span>
                <div className="text-[var(--color-text-muted)]">{examinedFilesText(rec)}</div>
                {rec.note && <div className="text-[var(--color-text)] whitespace-pre-wrap">{rec.note}</div>}
                <div className="text-[var(--color-text-faint)]">Reviewed version {shortHash(rec.contentHash)}{rec.cycle ? ` · Rev ${rec.cycle}` : ""}</div>
              </li>
            );
          })}
        </ul>
      )}
      {notSlot > 0 && <p className="text-[var(--color-text-faint)]" data-testid="notify-hold-not-slot">{notSlotHoldsText(notSlot)}</p>}
      {unchecked > 0 && <p className="text-[var(--color-text-faint)]" data-testid="notify-hold-unchecked">{uncheckedHoldsText(unchecked)}</p>}
      {more && <p className="text-[var(--color-text-faint)]" data-testid="notify-hold-more">{NOTIFY_HOLDS_MORE}</p>}
      {occupantSlot && !sourceId && <p className="text-[var(--color-text-muted)]" data-testid="notify-hold-no-source">{NO_SOURCE_TO_HOLD}</p>}
      {offerForm && !policy && policyFault && (
        <p className="text-[var(--color-text-muted)]" data-testid="notify-hold-permission-unchecked">
          {holdPermissionUncheckedText(policyFault)}{" "}
          <button type="button" className="underline" onClick={() => setPolicyTry((n) => n + 1)}>Try again</button>
        </p>
      )}
      {offerForm && policy && !mayPlace && <p className="text-[var(--color-text-muted)]" data-testid="notify-hold-not-permitted">{HOLD_NOT_PERMITTED}</p>}
      {offerForm && mayPlace && occupantSlot && (
        <div className="space-y-1.5 border border-[var(--color-border)] rounded-lg p-2" data-testid="notify-hold-form">
          <div className="text-[var(--color-text-muted)]">You are told of this review ({occupantSlot.label || occupantSlot.kind}) and nobody waits on you. To stop it, place a hold on its source document{source?.documentNumber ? ` ${source.documentNumber}` : ""} — it records what you examined.</div>
          {files.length === 0 && <div className="text-[var(--color-text-muted)]" data-testid="notify-hold-no-files">{NO_FILES_UNDER_REVIEW}</div>}
          {files.length > 0 && (
            <fieldset className="space-y-0.5">
              <legend className="font-bold text-[var(--color-text-muted)]">What you examined</legend>
              {files.map((f) => {
                const k = examinationFileKey(f);
                return (
                  <label key={k} className="flex items-center gap-1.5">
                    <input type="checkbox" checked={picked.includes(k)} onChange={(e) => setPick(e.target.checked ? [...new Set([...picked, k])] : picked.filter((x) => x !== k))} />
                    <span>{f.name || "a file"}</span>
                  </label>
                );
              })}
            </fieldset>
          )}
          <label className="block">
            <span className="font-bold text-[var(--color-text-muted)]">What you found (required)</span>
            <textarea aria-label="What you found" className="w-full border border-[var(--color-border)] rounded p-1" maxLength={EXAMINATION_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <label className="block">
            <span className="font-bold text-[var(--color-text-muted)]">Hold reason</span>{" "}
            <select aria-label="Hold reason" value={reason} onChange={(e) => setReason(e.target.value)} className="border border-[var(--color-border)] rounded">
              {HOLD_REASON_CODES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="font-bold text-[var(--color-text-muted)]">Hold description{reason === OTHER_HOLD_REASON ? " (required)" : ""}</span>
            <input aria-label="Hold description" className="w-full border border-[var(--color-border)] rounded p-1" value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <button type="button" disabled={busy || (files.length > 0 && picked.length === 0)} onClick={() => void place()} className="text-xs font-bold text-rose-700 disabled:opacity-50" data-testid="notify-hold-place">
            {busy ? "Placing…" : "Stop it with a hold"}
          </button>
        </div>
      )}
      {message && <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "ok" ? "text-green-700" : message.tone === "warn" ? "text-amber-700" : "text-red-700"}>{message.text}</p>}
    </div>
  );
}
