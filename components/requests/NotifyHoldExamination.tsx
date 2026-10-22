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
  EXAMINATION_NOTE_MAX,
} from "@/lib/assuranceExamination";
import { openHold, isMissingHoldExaminationColumn, HOLD_REASON_CODES, OTHER_HOLD_REASON } from "@/lib/holds";
import type { Ticket } from "@/types/schema";

export interface NotifyHoldExaminationProps {
  ticket: Ticket;
  orgId: string | null;
  uid: string | null;
  userName?: string | null;
}

/** What the panel says when the hold landed but its record could not be
 *  stored (the database has no column for it yet — before 20261267). */
export const HOLD_RECORD_NOT_STORED =
  "The hold is placed. What you examined could not be stored with it yet (the database update 20261267 is not applied) — add it to the hold's description if it matters.";
/** What the panel says to an occupant when the request names no document. */
export const NO_SOURCE_TO_HOLD =
  "This request names no controlled document, so there is nothing to hold. To stop it, raise it with the assignment queue.";

interface HoldRow {
  id: string;
  reason: string;
  notes: string | null;
  opened_by: string;
  opened_by_name: string | null;
  opened_at: string;
  released_at: string | null;
  examination: unknown;
}

export default function NotifyHoldExamination({ ticket, orgId, uid, userName }: NotifyHoldExaminationProps) {
  const ticketId = ticket.id ?? "";
  const recordRoster = useMemo(() => rosterOnRecord(ticket), [ticket]);
  const openRoster = useMemo(() => currentRoster(ticket), [ticket]);
  const slots = useMemo(() => (recordRoster ? recordRoster.slots.filter((s) => isNotifyExaminationSlot(s, ticket)) : []), [recordRoster, ticket]);
  const active = slots.length > 0;
  const source = useMemo(() => (active ? parseSourceDocument(ticket.metadata) : null), [active, ticket.metadata]);
  const sourceId = source?.id ?? null;
  const occupantSlot = useMemo(() => (openRoster && uid
    ? openRoster.slots.find((s) => isNotifyExaminationSlot(s, ticket) && (s.primaries.includes(uid) || (s.alternates ?? []).includes(uid)))
    : undefined), [openRoster, uid, ticket]);

  const [holds, setHolds] = useState<HoldRow[] | "unreadable" | "not_migrated" | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [pick, setPick] = useState<string[] | null>(null);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState<string>(OTHER_HOLD_REASON);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (!active || !sourceId || !orgId || !ticketId) { setHolds(null); return; }
    let alive = true;
    void (async () => {
      const { data, error } = await supabase.from("document_holds")
        .select("id, reason, notes, opened_by, opened_by_name, opened_at, released_at, examination")
        .eq("org_id", orgId).eq("document_id", sourceId).not("examination", "is", null)
        .order("opened_at", { ascending: false }).limit(50);
      if (!alive) return;
      if (error) { setHolds(isMissingHoldExaminationColumn(error) ? "not_migrated" : "unreadable"); return; }
      setHolds(((data ?? []) as HoldRow[]).filter((h) => holdExaminationOf(h.examination, ticketId) !== null));
    })();
    return () => { alive = false; };
  }, [active, sourceId, orgId, ticketId, reloadKey]);

  const files = openRoster?.files ?? [];
  const allKeys = files.map(examinationFileKey);
  const picked = pick ?? allKeys;

  const place = useCallback(async () => {
    if (!openRoster || !occupantSlot || !sourceId || !orgId || !uid || !ticketId) return;
    setMessage(null);
    const built = holdExaminationRecord(openRoster, ticketId, occupantSlot, { files: picked, note }, description);
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
      setMessage(hold.examinationNotRecorded ? { tone: "warn", text: HOLD_RECORD_NOT_STORED } : { tone: "ok", text: "Hold placed, with what you examined." });
      setNote("");
      setDescription("");
      setPick(null);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setMessage({ tone: "error", text: (e as Error)?.message ?? String(e) });
    } finally {
      setBusy(false);
    }
  }, [openRoster, occupantSlot, sourceId, orgId, uid, ticketId, picked, note, description, reason, userName]);

  if (!active) return null;

  const placed = Array.isArray(holds) ? holds : [];
  return (
    <div className="text-xs space-y-2" data-testid="notify-hold-examination">
      <div className="font-bold text-[var(--color-text)] flex items-center gap-1.5">
        <ShieldAlert className="w-3.5 h-3.5" /> Stops by the people told, with what they examined
      </div>
      {holds === "not_migrated" && <p className="text-[var(--color-text-faint)]" data-testid="notify-hold-not-migrated">Hold records of what was examined are kept from the database update 20261267.</p>}
      {holds === "unreadable" && <p className="text-[var(--color-text-faint)]" data-testid="notify-hold-unreadable">The holds on the source document could not be read just now.</p>}
      {placed.length > 0 && (
        <ul className="space-y-1.5" data-testid="notify-hold-list">
          {placed.map((h) => {
            const rec = holdExaminationOf(h.examination, ticketId)!;
            return (
              <li key={h.id}>
                <span className="font-bold text-[var(--color-text)]">{rec.slotLabel || rec.slotKind || "Told"}</span>{" "}
                <span className="text-[var(--color-text-muted)]">— held by {h.opened_by_name || "someone"} · {new Date(h.opened_at).toLocaleString()}{h.released_at ? ` · released ${new Date(h.released_at).toLocaleString()}` : " · in force"}</span>
                <div className="text-[var(--color-text-muted)]">{examinedFilesText(rec)}</div>
                {rec.note && <div className="text-[var(--color-text)] whitespace-pre-wrap">{rec.note}</div>}
                <div className="text-[var(--color-text-faint)]">Reviewed version {shortHash(rec.contentHash)}{rec.cycle ? ` · Rev ${rec.cycle}` : ""}</div>
              </li>
            );
          })}
        </ul>
      )}
      {occupantSlot && !sourceId && <p className="text-[var(--color-text-muted)]" data-testid="notify-hold-no-source">{NO_SOURCE_TO_HOLD}</p>}
      {occupantSlot && sourceId && (
        <div className="space-y-1.5 border border-[var(--color-border)] rounded-lg p-2" data-testid="notify-hold-form">
          <div className="text-[var(--color-text-muted)]">You are told of this review ({occupantSlot.label || occupantSlot.kind}) and nobody waits on you. To stop it, place a hold on its source document{source?.documentNumber ? ` ${source.documentNumber}` : ""} — it records what you examined.</div>
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
          <button type="button" disabled={busy || picked.length === 0} onClick={() => void place()} className="text-xs font-bold text-rose-700 disabled:opacity-50" data-testid="notify-hold-place">
            {busy ? "Placing…" : "Stop it with a hold"}
          </button>
        </div>
      )}
      {message && <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "ok" ? "text-green-700" : message.tone === "warn" ? "text-amber-700" : "text-red-700"}>{message.text}</p>}
    </div>
  );
}
