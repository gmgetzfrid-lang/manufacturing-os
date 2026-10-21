"use client";

// PackPrintHistory — a work package's print history, and the controller's
// recall of a printed pack (public-surfaces PS-P10; intelligence DACL-8
// residual (c), the integrator's ruling (3) under DEC-90).
//
// Each row is one immutable print snapshot (work_package_prints, PKG-2 —
// readable by every active member of the workspace, as the cover scan's
// record). Beside each, the print's per-print code state, read by the server
// (POST /api/print-sheet-tokens `history` — the token rows are service-role
// only; public-surfaces PHYS-20 limb 3):
//   * Recalled — on <date> by <who> (from the recall's audit row);
//   * Stopped — nothing downloaded (every linked code voided 'print_aborted':
//     the print was stopped after its snapshot was recorded — no paper left);
//   * Per-print codes not linked — the record cannot show whether the pack
//     was downloaded or recalled (printed before database update 20261240,
//     no code could be issued, or its link failed or was refused); a recall
//     from here cannot reach it, so none is offered;
//   * otherwise (codes linked) nothing more is said.
// Before 20261240 every row is "not linked" (no code can be linked yet). A
// state that could not be read is said once, and each row then shows no state.
//
// A controller (Admin / Document Control by the role COLLECTION — the caller
// passes isControllerPrincipal over the headline and the roles) sees "Recall"
// on a print whose codes are linked (or whose state could not be read — the
// server decides): the reason is asked for, then POST /api/print-sheet-tokens
// `void` voids every live sheet code of that print as the service role,
// after writing the audit row (DISTRIBUTION_RECALL, with the reason). Every
// sheet of the recalled print then scans "PRINT RECALLED — DO NOT USE" (red,
// never green — PHYS-20 limb 2) and the pack's cover reads "PACK RECALLED"
// (limb 1). The server re-checks the role: the button is a convenience, not
// the gate. (PS-P10 shipped the history and the Recall control OFF behind
// PACK_PRINT_HISTORY_UI_ENABLED / PACK_RECALL_UI_ENABLED until PHYS-20; both
// switches are gone now that its three limbs hold — the integrator at the
// PS-P10 merge, DEC-90.)
//
// The history lists the newest PACK_PRINT_HISTORY_LIMIT prints and pages
// back through older ones ("Show older prints", keyset on printed_at, id),
// so every print of the package is reachable from here.

import React, { useCallback, useEffect, useState } from "react";
import { History, Loader2, Ban, ChevronDown, ChevronRight } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { appPrompt } from "@/components/providers/DialogProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { readSheetPrintStates, recallSheetPrint, type SheetPrintCodeState } from "@/lib/printSheetTokensClient";

/** How many prints the history reads at a time (newest first; older ones
 *  page in by "Show older prints"). */
export const PACK_PRINT_HISTORY_LIMIT = 10;

interface PrintRow { id: string; printedAt: string | null; printedByName: string | null; sheets: number }

/** The PostgREST filter for "strictly older than `c` in (printed_at desc,
 *  id desc) order". Values are double-quoted — a timestamp carries '.', ':'
 *  and '+' — and an embedded quote or backslash is escaped. Pure. */
export function olderPrintsFilter(c: { printedAt: string; id: string }): string {
  const v = (x: string) => `"${x.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `printed_at.lt.${v(c.printedAt)},and(printed_at.eq.${v(c.printedAt)},id.lt.${v(c.id)})`;
}

function toPrintRow(r: Record<string, unknown>): PrintRow {
  return {
    id: String(r.id),
    printedAt: (r.printed_at as string | null) ?? null,
    printedByName: (r.printed_by_name as string | null) ?? null,
    sheets: printedSheetCount(r.sheets),
  };
}

/** The sheets a snapshot says were printed: every entry whose `printed` is
 *  not false (a snapshot from before VFY-19 has no `printed` key). Pure. */
export function printedSheetCount(sheets: unknown): number {
  if (!Array.isArray(sheets)) return 0;
  return (sheets as Array<Record<string, unknown> | null>).filter((s) => !!s && typeof s === "object" && s.printed !== false).length;
}

export default function PackPrintHistory({ orgId, packageId, canRecall, refreshKey = 0 }: {
  orgId: string;
  packageId: string;
  /** Admin / Document Control by the role collection. */
  canRecall: boolean;
  /** Bumped by the page after a print, so an open history re-reads. */
  refreshKey?: number;
}) {
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<PrintRow[] | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [recalled, setRecalled] = useState<Set<string>>(new Set());
  // PHYS-20 limb 3: each print's code state (the server's read), and whether
  // the read said "not available" (before 20261240) or failed.
  const [codeStates, setCodeStates] = useState<Map<string, SheetPrintCodeState>>(new Map());
  const [statesUnavailable, setStatesUnavailable] = useState(false);
  const [statesUnread, setStatesUnread] = useState(false);

  // Read the code state of these prints and merge it in. A failed read is
  // said once; its rows show no state (and a controller's Recall stays —
  // the server decides).
  const readStates = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    const r = await readSheetPrintStates({ orgId, coverPrintIds: ids });
    if (!r.ok) {
      setStatesUnread(true);
      return;
    }
    if (!r.available) {
      setStatesUnavailable(true);
      return;
    }
    setStatesUnavailable(false);
    setCodeStates((prev) => {
      const next = new Map(prev);
      for (const id of ids) next.delete(id.toLowerCase());
      for (const [id, st] of r.prints) next.set(id, st);
      return next;
    });
  }, [orgId]);
  const stateOf = (id: string): SheetPrintCodeState | undefined =>
    statesUnavailable ? { state: "unlinked" } : codeStates.get(id.toLowerCase());

  // One page of prints, newest first; `after` is the last row already shown.
  // One more than a page is read, so "Show older prints" appears only when
  // there are older prints.
  const readPage = useCallback(async (after: { printedAt: string; id: string } | null) => {
    let q = supabase
      .from("work_package_prints")
      .select("id, printed_at, printed_by_name, sheets")
      .eq("org_id", orgId)
      .eq("package_id", packageId);
    if (after) q = q.or(olderPrintsFilter(after));
    const { data, error } = await q
      .order("printed_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(PACK_PRINT_HISTORY_LIMIT + 1);
    if (error) return null;
    const got = ((data as Array<Record<string, unknown>> | null) ?? []).map(toPrintRow);
    return { rows: got.slice(0, PACK_PRINT_HISTORY_LIMIT), more: got.length > PACK_PRINT_HISTORY_LIMIT };
  }, [orgId, packageId]);

  const load = useCallback(async () => {
    const page = await readPage(null);
    setOlderError(null);
    if (!page) {
      setRows(null);
      setHasOlder(false);
      setReadError("This package's print history could not be read just now — reload to try again.");
      return;
    }
    setReadError(null);
    setRows(page.rows);
    setHasOlder(page.more);
    setStatesUnread(false);
    await readStates(page.rows.map((r) => r.id));
  }, [readPage, readStates]);

  const loadOlder = async () => {
    const last = rows && rows.length > 0 ? rows[rows.length - 1] : null;
    if (!last || !last.printedAt) return;
    setOlderBusy(true);
    try {
      const page = await readPage({ printedAt: last.printedAt, id: last.id });
      if (!page) {
        setOlderError("Older prints could not be read just now — try again.");
        return;
      }
      setOlderError(null);
      setRows((prev) => {
        const seen = new Set((prev ?? []).map((r) => r.id));
        return [...(prev ?? []), ...page.rows.filter((r) => !seen.has(r.id))];
      });
      setHasOlder(page.more);
      await readStates(page.rows.map((r) => r.id));
    } finally {
      setOlderBusy(false);
    }
  };

  useEffect(() => {
    if (open) void load();
  }, [open, load, refreshKey]);

  const recall = async (row: PrintRow) => {
    const when = row.printedAt ? new Date(row.printedAt).toLocaleString() : "an unknown time";
    const reason = await appPrompt({
      title: "Recall this printed pack?",
      message:
        `Every sheet of the pack printed ${when}${row.printedByName ? ` by ${row.printedByName}` : ""} will scan ` +
        "\"PRINT RECALLED — DO NOT USE\", and the pack's cover will read \"PACK RECALLED\". This cannot be undone. " +
        "Tell the crew holding the pack as well. The reason is recorded in the audit trail.",
      placeholder: "Why is this print recalled? (e.g. issued with the wrong revision)",
      required: true,
      minLength: 3,
      confirmLabel: "Recall print",
      tone: "danger",
    });
    if (reason === null) return;
    setBusy(row.id);
    try {
      const r = await recallSheetPrint({ orgId, coverPrintId: row.id, reason: reason.trim() });
      if (r.ok) {
        setRecalled((prev) => new Set(prev).add(row.id));
        showToast({
          type: "success",
          title: "Print recalled",
          message: `${r.voided} sheet${r.voided === 1 ? "" : "s"} of this print now scan${r.voided === 1 ? "s" : ""} "PRINT RECALLED — DO NOT USE", and its cover reads "PACK RECALLED".` +
            (r.alreadyVoid > 0 ? ` ${r.alreadyVoid} ${r.alreadyVoid === 1 ? "was" : "were"} already void.` : "") +
            " Tell the crew holding the pack.",
        });
        // The recall's date and author, as the server now records them.
        void readStates([row.id]);
      } else {
        showToast({ type: r.unavailable ? "warning" : "error", title: "Print not recalled", message: r.error });
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="px-3 pb-2" data-testid="pack-print-history">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-[11px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <History className="w-3 h-3" /> Print history
      </button>
      {open && (
        <div className="mt-1 space-y-0.5">
          {readError ? (
            <div className="text-[11px] text-amber-700" role="status">{readError}</div>
          ) : rows === null ? (
            <div className="text-[11px] text-[var(--color-text-faint)]"><Loader2 className="w-3 h-3 inline animate-spin" /> Reading…</div>
          ) : rows.length === 0 ? (
            <div className="text-[11px] text-[var(--color-text-faint)]">Not printed yet.</div>
          ) : (
            rows.map((row) => {
              const st = stateOf(row.id);
              return (

              <div key={row.id} className="flex items-center gap-2 px-2 py-1 rounded-lg bg-[var(--color-surface-2)] text-[11px]" data-testid="pack-print-row">
                <span className="font-bold text-[var(--color-text)] truncate flex-1">
                  {row.printedAt ? new Date(row.printedAt).toLocaleString() : "Time not recorded"}
                  {row.printedByName ? ` · ${row.printedByName}` : ""}
                </span>
                <span className="text-[var(--color-text-faint)] shrink-0">{row.sheets} sheet{row.sheets === 1 ? "" : "s"}</span>
                {recalled.has(row.id) || st?.state === "recalled" ? (
                  <span className="shrink-0 text-[10px] font-black uppercase text-red-700" data-testid="pack-print-recalled">
                    Recalled
                    {st?.state === "recalled" && st.recalledAt ? ` ${new Date(st.recalledAt).toLocaleDateString()}` : ""}
                    {st?.state === "recalled" && st.recalledBy ? ` · by ${st.recalledBy}` : ""}
                  </span>
                ) : st?.state === "stopped" ? (
                  <span
                    className="shrink-0 text-[10px] font-bold text-[var(--color-text-faint)]"
                    data-testid="pack-print-stopped"
                    title="This print was stopped before anything was downloaded — no paper left, so there is nothing to recall."
                  >
                    Stopped — nothing downloaded
                  </span>
                ) : st?.state === "unlinked" ? (
                  <span
                    className="shrink-0 text-[10px] font-bold text-[var(--color-text-faint)]"
                    data-testid="pack-print-unlinked"
                    title={
                      "No per-print sheet code is linked to this print, so this record cannot show whether the pack was downloaded or recalled " +
                      "(printed before database update 20261240, no code could be issued, or its link failed). A recall from here cannot reach " +
                      "its sheets — withdraw its paper by hand, and hold or supersede the revision if its sheets must read red."
                    }
                  >
                    Per-print codes not linked
                  </span>
                ) : canRecall ? (
                  <button
                    type="button"
                    onClick={() => void recall(row)}
                    disabled={busy === row.id}
                    className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50"
                    title="Recall this printed pack: every sheet of this print will scan PRINT CANCELLED — DO NOT USE"
                  >
                    {busy === row.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Ban className="w-3 h-3" />}
                    Recall
                  </button>
                ) : null}
              </div>
              );
            })
          )}
          {!readError && rows && rows.length > 0 && statesUnread && (
            <div className="text-[11px] text-amber-700 px-2" role="status">
              Whether these prints were recalled or stopped could not be read just now — reload to try again.
            </div>
          )}
          {!readError && rows && rows.length > 0 && (hasOlder || olderError) && (
            <div className="flex items-center gap-2 px-2">
              {olderError && <span className="text-[11px] text-amber-700" role="status">{olderError}</span>}
              {hasOlder && (
                <button
                  type="button"
                  onClick={() => void loadOlder()}
                  disabled={olderBusy}
                  className="inline-flex items-center gap-1 text-[11px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-50"
                >
                  {olderBusy && <Loader2 className="w-3 h-3 animate-spin" />}
                  Show older prints
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
