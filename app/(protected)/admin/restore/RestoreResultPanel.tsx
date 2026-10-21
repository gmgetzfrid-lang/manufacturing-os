"use client";

// /admin/restore — the result panel: what a records restore did, said plainly.
// Moved out of page.tsx verbatim by admin-and-org Round G P17 so it can be
// rendered on its own (a Next.js page file may export only its page); P17
// (BKP-16) then gave a request restored under a fresh number, and the two
// request-number refusals, lines of their own. Everything else renders as it
// did (pinned by digest in lib/__tests__/aoRoundGP17RestoreRenumberReport.test.ts).

import React from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import {
  RESTORE_ADDITIVE_NOTE, RESTORE_HELD_ELSEWHERE_NOTE, restoreRefusalLabel, isDanglingFlowRefusal, DANGLING_FLOW_CODE,
  TICKET_RENUMBERED, TICKET_NUMBER_IN_USE, TICKET_NUMBER_UNSETTLED,
  type ChunkedRestoreResult, type RestoreRenumbering, type RestoreRowRefusal,
} from "@/lib/dataRestore";

export function fmtNum(n: number) { return n >= 1000 ? n.toLocaleString() : String(n); }

/** BKP-16: how many renumbered requests (or refused numbers) are listed
 *  before the rest go behind "Show all". */
const RENUMBER_LINES_SHOWN = 10;

/** BKP-16: a `cleared` note that is a renumbering (TICKET_RENUMBERED) — a
 *  request restored under a fresh number, never "a pointer cleared". */
const isRenumberNote = (r: Pick<RestoreRowRefusal, "code">) => r.code === TICKET_RENUMBERED;

/** BKP-16: the two request-number refusals, said on lines of their own. */
const isTicketNumberRefusal = (r: Pick<RestoreRowRefusal, "code">) => r.code === TICKET_NUMBER_IN_USE || r.code === TICKET_NUMBER_UNSETTLED;

/** BKP-16: one renumbered request, its old and new number read from
 *  RestoreTableOutcome.renumbered (and carried on the line as data
 *  attributes). An entry the database did not confirm is never said as
 *  restored. */
function RenumberLine({ r }: { r: RestoreRenumbering }) {
  const holder = r.numberHeldBy ? <> (request <span className="font-mono">{r.numberHeldBy}</span> has it)</> : null;
  return r.unconfirmed
    ? <li data-testid="restore-renumbered-line" data-renumbered-from={r.from} data-renumbered-to={r.to} data-unconfirmed="true">sent as <b>{r.to}</b> — <b>{r.from}</b> was taken{holder}; not confirmed as restored</li>
    : <li data-testid="restore-renumbered-line" data-renumbered-from={r.from} data-renumbered-to={r.to}>restored as <b>{r.to}</b> — <b>{r.from}</b> was taken{holder}</li>;
}

/** BKP-16: a list of lines, the first RENUMBER_LINES_SHOWN shown and every
 *  line behind "Show all" when there are more. */
function ShownList({ lines, testId }: { lines: React.ReactNode[]; testId: string }) {
  const more = lines.length - RENUMBER_LINES_SHOWN;
  return (
    <>
      <ul className="ml-3 list-disc pl-4">{lines.slice(0, RENUMBER_LINES_SHOWN)}</ul>
      {more > 0 && (
        <details data-testid={testId} className="ml-3">
          <summary className="cursor-pointer font-bold underline">and {fmtNum(more)} more — show all {fmtNum(lines.length)}</summary>
          <ul className="list-disc pl-4">{lines}</ul>
        </details>
      )}
    </>
  );
}

/** BKP-16: a refused request's number, from the refusal's `ticketNumber`
 *  (never parsed from its message); the request's id when it has none. */
const refusedNumberLine = (r: RestoreRowRefusal, i: number) => (
  <li key={`${r.id ?? "none"}:${i}`}>
    {r.ticketNumber ? <b>{r.ticketNumber}</b> : <>a request</>}
    {r.id ? <> (request <span className="font-mono">{r.id}</span>)</> : null}
  </li>
);

/** BKP-16: what the restore did with request numbers, per table — each
 *  request restored under a fresh number on its own line, and the two
 *  request-number refusals in words naming the number and what to do. */
function TicketNumberLines({ result }: { result: ChunkedRestoreResult }) {
  return (
    <>
      {result.tables.map((t) => {
        const listed = t.renumbered ?? [];
        const confirmed = listed.filter((r) => !r.unconfirmed);
        const unconfirmed = listed.filter((r) => r.unconfirmed);
        // a renumbering note whose numbers could not be read (never dropped)
        const unread = Math.max(0, t.cleared.filter(isRenumberNote).length - listed.length);
        const inUse = t.refused.filter((r) => r.code === TICKET_NUMBER_IN_USE);
        const unsettled = t.refused.filter((r) => r.code === TICKET_NUMBER_UNSETTLED);
        if (listed.length + unread + inUse.length + unsettled.length === 0) return null;
        return (
          <React.Fragment key={`numbers-${t.name}`}>
            {confirmed.length > 0 && (
              <div data-testid="restore-renumbered">
                <span className="font-mono">{t.name}</span>: {fmtNum(confirmed.length)} request(s) restored under a new number — another
                request here already had its number, so the restore gave it the next free one instead of filing two requests under one
                number. The number it was issued stays on it (in its history and the audit log&apos;s RESTORE_CHUNK rows); labels,
                transmittals and archives printed with that number now mean the new one.
                <ShownList testId="restore-renumbered-all" lines={confirmed.map((r, i) => <RenumberLine key={`${r.id ?? "none"}:${i}`} r={r} />)} />
              </div>
            )}
            {unconfirmed.length > 0 && (
              <div data-testid="restore-renumbered-unconfirmed">
                <span className="font-mono">{t.name}</span>: {fmtNum(unconfirmed.length)} request(s) sent under a new number but NOT
                confirmed as restored — the server accepted the write without confirming these rows were written, so each may or may
                not be here under its new number. Look for the new number under Requests, or run the restore again: a re-run settles
                it and never gives a request a second number.
                <ShownList testId="restore-renumbered-unconfirmed-all" lines={unconfirmed.map((r, i) => <RenumberLine key={`${r.id ?? "none"}:${i}`} r={r} />)} />
              </div>
            )}
            {unread > 0 && (
              <div data-testid="restore-renumbered-unread">
                <span className="font-mono">{t.name}</span>: {fmtNum(unread)} more request(s) given a new number that this page could
                not read — each is named, with its old and new number, in the audit log&apos;s RESTORE_CHUNK rows.
              </div>
            )}
            {inUse.length > 0 && (
              <div data-testid="restore-number-in-use">
                <span className="font-mono">{t.name}</span>: {fmtNum(inUse.length)} request(s) NOT restored — another request here
                already has the number, and the restore could not take a new number for it this time. Run the restore again: a re-run
                gives each one a new number (records already restored are skipped, not duplicated).
                <ShownList testId="restore-number-in-use-all" lines={inUse.map(refusedNumberLine)} />
              </div>
            )}
            {unsettled.length > 0 && (
              <div data-testid="restore-number-unsettled">
                <span className="font-mono">{t.name}</span>: {fmtNum(unsettled.length)} request(s) NOT restored — several requests in
                this backup carry the same number, and every one of them tried first was refused, so the restore could not tell which
                should keep it. Resolve the duplicates first: fix what refused the other requests carrying the number (their reasons are
                listed here and in the audit log&apos;s RESTORE_CHUNK rows), then run the restore again.
                <ShownList testId="restore-number-unsettled-all" lines={unsettled.map(refusedNumberLine)} />
              </div>
            )}
          </React.Fragment>
        );
      })}
    </>
  );
}

/** BKP-5: what the restore did, said plainly — never a green panel over a
 *  run that stopped, refused rows, cleared pointers, wrote nothing, wrote
 *  rows the server did not count, or met ids another workspace holds. */
export function RestoreResultPanel({ result }: { result: ChunkedRestoreResult }) {
  const stopped = result.stoppedAt;
  // An uncounted write is unknown — never "nothing new" (fix pass 2).
  const nothingNew = result.totalInserted === 0 && result.totalUncounted === 0;
  const tone = stopped || result.totalHeldElsewhere > 0
    ? "border-red-200 bg-red-50 text-red-900"
    : result.totalDanglingFlows > 0 || result.totalRefused > 0 || result.totalCleared > 0 || result.totalUncounted > 0 || nothingNew ? "border-amber-200 bg-amber-50 text-amber-900" : "border-emerald-200 bg-emerald-50 text-emerald-900";
  // BKP-15: a process flow whose equipment or unit is gone is said on its own
  // line — it was dangling in the backup — never counted with real refusals.
  // BKP-16: the two request-number refusals are said on lines of their own
  // (TicketNumberLines), not under the generic refused line.
  const refusedByTable = result.tables
    .map((t) => ({ ...t, refused: t.refused.filter((r) => !isDanglingFlowRefusal(r)).filter((r) => !isTicketNumberRefusal(r)) }))
    .filter((t) => t.refused.length > 0);
  const danglingByTable = result.tables
    .map((t) => ({ name: t.name, n: t.refused.filter(isDanglingFlowRefusal).length }))
    .filter((t) => t.n > 0);
  // BKP-16: a request restored under a fresh number rides `cleared`
  // (TICKET_RENUMBERED) but is never "a pointer cleared": it has its own
  // lines, and the headline counts it apart.
  const clearedByTable = result.tables
    .map((t) => ({ ...t, cleared: t.cleared.filter((r) => !isRenumberNote(r)) }))
    .filter((t) => t.cleared.length > 0);
  const renumberNotes = result.tables.reduce((s, t) => s + t.cleared.filter(isRenumberNote).length, 0);
  const pointersCleared = Math.max(0, result.totalCleared - renumberNotes);
  const renumberedConfirmed = result.tables.reduce((s, t) => s + (t.renumbered ?? []).filter((r) => !r.unconfirmed).length, 0);
  // not confirmed as written, or a note whose numbers could not be read — never said as restored
  const renumberedNotConfirmed = renumberNotes - renumberedConfirmed;
  const elsewhereByTable = result.tables.filter((t) => t.heldElsewhere > 0);
  return (
    <div className={`rounded-2xl border p-4 ${tone}`}>
      <div className="flex items-center gap-2 text-sm font-black mb-1">
        {stopped
          ? <><AlertTriangle className="w-4 h-4" /> Restore stopped at <span className="font-mono">{stopped.table}</span> — {result.notAttempted.length} table(s) not attempted</>
          : result.totalHeldElsewhere > 0
            ? <><AlertTriangle className="w-4 h-4" /> {fmtNum(result.totalHeldElsewhere)} record(s) could NOT be restored — their ids are in use elsewhere</>
            : nothingNew
              ? <><AlertTriangle className="w-4 h-4" /> Nothing new was restored</>
              : result.totalRefused > 0
                ? <><AlertTriangle className="w-4 h-4" /> Records restored — {fmtNum(result.totalRefused)} row(s) refused</>
                : result.totalDanglingFlows > 0
                  ? <><AlertTriangle className="w-4 h-4" /> Records restored — {fmtNum(result.totalDanglingFlows)} dangling process flow(s) not restored</>
                  : result.totalUncounted > 0
                    ? <><AlertTriangle className="w-4 h-4" /> Restored — {fmtNum(result.totalUncounted)} record(s) the server did not count</>
                    : renumberNotes > 0
                      ? <><AlertTriangle className="w-4 h-4" /> Records restored — {[
                          pointersCleared > 0 ? `${fmtNum(pointersCleared)} pointer(s) cleared` : null,
                          renumberedConfirmed > 0 ? `${fmtNum(renumberedConfirmed)} request(s) restored under a new number` : null,
                          renumberedNotConfirmed > 0 ? `${fmtNum(renumberedNotConfirmed)} request(s) sent under a new number, not confirmed as restored` : null,
                        ].filter(Boolean).join(" · ")}</>
                      : result.totalCleared > 0
                        ? <><AlertTriangle className="w-4 h-4" /> Records restored — {fmtNum(result.totalCleared)} pointer(s) cleared</>
                        : <><CheckCircle2 className="w-4 h-4" /> Records restored</>}
      </div>
      <div className="text-[11px] leading-relaxed space-y-1">
        <div>
          Imported <b>{fmtNum(result.totalInserted)}</b> new record(s) · <b>{fmtNum(result.totalExisting)}</b> already here, kept exactly as they were
          {result.totalHeldElsewhere > 0 && <> · <b>{fmtNum(result.totalHeldElsewhere)}</b> NOT restored (ids in use by another workspace)</>}
          {result.totalUncounted > 0 && <> · <b>{fmtNum(result.totalUncounted)}</b> not counted by the server</>}
          {result.totalFiltered > 0 && <> · <b>{fmtNum(result.totalFiltered)}</b> comment(s) on tickets archived since the backup left out</>}
          {result.totalAdvanced > 0 && <> · <b>{fmtNum(result.totalAdvanced)}</b> numbering counter(s) advanced past the restored numbers (never lowered; a gap, never a repeat, where this workspace&apos;s prefix differs)</>}
          {" "}· re-linked <b>{result.linkedUsers}</b> user(s) · created <b>{result.createdUsers}</b> restored placeholder(s).
        </div>
        {result.totalExisting > 0 && <div>{RESTORE_ADDITIVE_NOTE}</div>}
        {result.totalHeldElsewhere > 0 && (
          <div>
            <b>Not restored:</b> {RESTORE_HELD_ELSEWHERE_NOTE}{" "}
            {elsewhereByTable.map((t, i) => <React.Fragment key={t.name}>{i > 0 ? ", " : ""}<span className="font-mono">{t.name}</span> ({fmtNum(t.heldElsewhere)})</React.Fragment>)}.
          </div>
        )}
        {stopped && (
          <div>
            <b>Why it stopped:</b> {stopped.error}. Tables restore parents-first, so nothing after <span className="font-mono">{stopped.table}</span> was attempted
            {result.notAttempted.length > 0 && <> (<span className="font-mono">{result.notAttempted.join(", ")}</span>)</>}.
            Records already written stay. Fix the cause and run the restore again — rows already restored are skipped, not duplicated.
          </div>
        )}
        {refusedByTable.map((t) => (
          <div key={t.name}>
            <span className="font-mono">{t.name}</span>: {t.refused.length} row(s) refused —{" "}
            {Array.from(new Set(t.refused.map((r) => restoreRefusalLabel(r.code)))).join("; ")} (see the audit log&apos;s RESTORE_CHUNK rows for each id).
          </div>
        ))}
        {danglingByTable.map((t) => (
          <div key={`dangling-${t.name}`}>
            <span className="font-mono">{t.name}</span>: {t.n} flow(s) not restored — {restoreRefusalLabel(DANGLING_FLOW_CODE)}. Draw them again once the equipment or unit exists.
          </div>
        ))}
        <TicketNumberLines result={result} />
        {clearedByTable.map((t) => (
          <div key={t.name}>
            <span className="font-mono">{t.name}</span>: {t.cleared.length} row(s) restored with a pointer cleared —{" "}
            {Array.from(new Set(t.cleared.map((r) => r.message.split(" ")[0]))).join(", ")} (
            {Array.from(new Set(t.cleared.map((r) => restoreRefusalLabel(r.code)))).join("; ")}).
          </div>
        ))}
        {result.tables.filter((t) => (t.notApplied ?? []).length > 0).map((t) => (
          <div key={`not-applied-${t.name}`} data-testid="restore-not-applied">
            <span className="font-mono">{t.name}</span>: {t.notApplied.length} backup decision(s) not applied — this workspace holds the same{" "}
            {t.name === "entity_mentions" ? "link" : "row"} under its key, and the live row was kept exactly as it is.
            {t.notApplied.slice(0, 5).map((r, i) => (
              <div key={`${t.name}-${r.id ?? i}`} className="ml-3">Backup row <span className="font-mono">{r.id ?? "(no id)"}</span>: {r.message}</div>
            ))}
            {t.notApplied.length > 5 && <div className="ml-3">…and {t.notApplied.length - 5} more (each is in the audit log&apos;s RESTORE_CHUNK rows).</div>}
          </div>
        ))}
        {result.unmappedMembers > 0 && (
          <div>
            <b>{fmtNum(result.unmappedMembers)}</b> backup member(s) have no email address and no membership here, so no person here could be found for them — every record naming one was refused (above). Add their address to the backup&apos;s org_members and restore again.
          </div>
        )}
        {result.placeholdersWithoutProfile > 0 && (
          <div>
            <b>{fmtNum(result.placeholdersWithoutProfile)}</b> restored placeholder(s) have no sign-in account yet, so a team membership naming one was not restored and a team creator / adder naming one was cleared — add them to their teams again once they accept the invitation.
          </div>
        )}
        <div>Restored users are inactive — re-invite them to grant access.</div>
      </div>
    </div>
  );
}
