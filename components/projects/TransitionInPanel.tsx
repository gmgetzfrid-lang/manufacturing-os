"use client";

// TransitionInPanel — the adoption step after intake. A contractor's new
// drawing set sits in the project's intake folder; this panel scans each
// sheet against the existing register (equipment tie-ins, number collisions,
// overlapping drawings) and then moves sheets into a real library —
// renumbered if wanted, equipment linked, project association kept,
// provenance untouched. Only CLEAN sheets (every check ran, nothing found)
// are bulk-adopted. A sheet with a number collision cannot be adopted until
// it is renumbered to a clear number — adoptDocument re-checks at the click
// and refuses otherwise — where the number identifies a document in the
// destination library; in a multi-sheet library (a tuple beyond the number)
// sheets INSIDE that library share numbers and the full key decides at the
// click, while a same-numbered live document in any other library still
// blocks. A sheet still awaiting review — never approved, or an approved
// sheet with a newer submission in review — cannot be adopted until it is
// decided (a never-approved rejected sheet is not listed); one whose
// pending revision names a RETIRED draft is marked "stuck" and the operator
// is told Document Control must clear it — the review queue never lists a
// retired draft, so it is never pointed at. A sheet whose
// checks could not run (no number, no
// recognised equipment) is "unverifiable": single adopt only, after an
// explicit confirmation. Adopting moves documents between folders, which
// the database reserves for Admin / Document Control — the controls are
// shown to them only (SAF-13).

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRightCircle, Loader2, ShieldAlert, ShieldCheck, Cable, Layers,
  ChevronDown, ChevronRight, RefreshCw,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { userFacingCaughtError } from "@/lib/userFacingError";
import {
  TransitionCandidate, TransitionImpact, UnverifiableReason,
  listTransitionCandidates, scanTransitionImpact, adoptDocument, blockingNumberCollision, candidateInReview,
  candidateReviewNote,
} from "@/lib/transitionIn";
import { numberIsTheKey } from "@/lib/intakeLinks";
import { useRole } from "@/components/providers/RoleContext";
import { isControllerPrincipal } from "@/lib/permissions";
import { appConfirm } from "@/components/providers/DialogProvider";
import { DECISION_TARGET } from "@/components/projects/decisionTarget";

const UNVERIFIABLE_TEXT: Record<UnverifiableReason, string> = {
  no_number: "no drawing number — it was not checked against the register",
  no_equipment: "no equipment recognised — overlapping drawings were not checked",
  check_failed: "a check could not run",
};

export default function TransitionInPanel({ orgId, projectId, intakeCollectionId, canManage, uid, userEmail, onFlagCollision }: {
  orgId: string; projectId: string; intakeCollectionId: string; canManage: boolean;
  uid: string; userEmail?: string | null;
  /** EXT4 hook: raise a drafting ticket for a colliding/overlapping sheet. */
  onFlagCollision?: (candidate: TransitionCandidate, impact: TransitionImpact) => void;
}) {
  const [candidates, setCandidates] = useState<TransitionCandidate[]>([]);
  const [impacts, setImpacts] = useState<Map<string, TransitionImpact>>(new Map());
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  // Destination
  const [libs, setLibs] = useState<Array<{ id: string; name: string; uniqueness_keys?: string[] | null }>>([]);
  const [cols, setCols] = useState<Array<{ id: string; name: string }>>([]);
  const [destLib, setDestLib] = useState("");
  const [destCol, setDestCol] = useState("");
  const [renumber, setRenumber] = useState<Map<string, string>>(new Map());
  // SAF-13: adopting moves documents between folders — the database's move
  // guard reserves that for the controller tier (is_org_controller), so the
  // controls are offered to exactly that tier.
  const { activeRole, roles } = useRole();
  const canAdopt = canManage && isControllerPrincipal({ role: activeRole, roles });

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [cands, { data: ls }] = await Promise.all([
        listTransitionCandidates(orgId, intakeCollectionId),
        supabase.from("libraries").select("id, name, uniqueness_keys").eq("org_id", orgId).order("name"),
      ]);
      setCandidates(cands);
      setLibs(((ls ?? []) as Array<{ id: string; name: string; uniqueness_keys?: string[] | null }>));
      // Scan with bounded concurrency — the sequential loop was up to ~800
      // round trips for a big intake batch.
      setScanning(true);
      const next = new Map<string, TransitionImpact>();
      const CONCURRENCY = 4;
      for (let i = 0; i < cands.length; i += CONCURRENCY) {
        const batch = cands.slice(i, i + CONCURRENCY);
        const results = await Promise.all(batch.map(async (c) => ({
          id: c.docId, impact: await scanTransitionImpact(orgId, c, intakeCollectionId),
        })));
        for (const r of results) next.set(r.id, r.impact);
        setImpacts(new Map(next));
      }
      setScanning(false);
    } catch (e) {
      setMsg(`Couldn't load the transition list: ${userFacingCaughtError(e, { action: "read", context: "TransitionInPanel" })}`);
    } finally { setLoading(false); }
  }, [orgId, intakeCollectionId]);
  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!destLib) { setCols([]); setDestCol(""); return; }
    let alive = true;
    (async () => {
      const { data } = await supabase.from("collections")
        .select("id, name").eq("library_id", destLib).order("name");
      if (alive) setCols(((data ?? []) as Array<{ id: string; name: string }>));
    })();
    return () => { alive = false; };
  }, [destLib]);

  // INTK-5: does the number alone identify a document in the destination?
  // Not in a multi-sheet library — there a same-numbered sheet INSIDE that
  // library is expected, and adoptDocument checks the full key at the click.
  // SAF-12: a same-numbered live document in any OTHER library still blocks.
  const numberDecides = numberIsTheKey(libs.find((l) => l.id === destLib)?.uniqueness_keys ?? null);
  const blockingCollider = (impact: TransitionImpact | undefined) => blockingNumberCollision(impact, destLib || null, numberDecides);
  const blocksOnNumber = (impact: TransitionImpact | undefined) => !!blockingCollider(impact);

  // INTK-3: a sheet with any submission still undecided — never approved,
  // or approved with a newer submission in review — is not adoptable yet.
  // Bulk adoption takes only sheets that are approved, decided AND scanned clean.
  const bulkable = (c: TransitionCandidate) => !candidateInReview(c) && !!impacts.get(c.docId)?.clean;
  const cleanCount = useMemo(
    () => candidates.filter((c) => !candidateInReview(c) && !!impacts.get(c.docId)?.clean).length,
    [candidates, impacts],
  );
  const flaggedCount = useMemo(
    () => candidates.filter((c) => { const i = impacts.get(c.docId); return candidateInReview(c) || (i && !i.clean); }).length,
    [candidates, impacts],
  );

  const adoptOne = async (c: TransitionCandidate) => {
    if (!destLib) { setMsg("Pick the destination library first."); return; }
    const impact = impacts.get(c.docId);
    const renum = (renumber.get(c.docId) ?? "").trim();
    if (impact && impact.unverifiable.length > 0 && !blocksOnNumber(impact)) {
      const what = impact.unverifiable.map((r) => UNVERIFIABLE_TEXT[r]).join("; ");
      if (!(await appConfirm({ message: `${c.label} could not be fully checked (${what}). Adopt it into the controlled register anyway?`, tone: "danger" }))) return;
    }
    const collider = blockingCollider(impact);
    if (collider && !renum) { setMsg(`${c.label} collides with ${collider.label} — renumber it before adopting.`); return; }
    setBusy(c.docId); setMsg(null);
    try {
      const res = await adoptDocument({
        orgId, projectId, docId: c.docId,
        libraryId: destLib, collectionId: destCol || null,
        newNumber: (renumber.get(c.docId) ?? "").trim() || null,
        linkAssets: impact?.matchedAssets ?? [],
        actorId: uid, actorEmail: userEmail ?? null,
      });
      if (!res.ok) throw new Error(res.error);
      setMsg(res.note ?? `${c.label} adopted into the controlled register.`);
      await refresh();
    } catch (e) { setMsg(userFacingCaughtError(e, { context: "TransitionInPanel" })); }
    finally { setBusy(null); }
  };

  const adoptAllClean = async () => {
    if (!destLib) { setMsg("Pick the destination library first."); return; }
    const clean = candidates.filter(bulkable);
    if (!clean.length) return;
    setBusy("bulk"); setMsg(null);
    let ok = 0; const failed: string[] = []; const unkeyed: string[] = [];
    for (const c of clean) {
      const res = await adoptDocument({
        orgId, projectId, docId: c.docId,
        libraryId: destLib, collectionId: destCol || null,
        newNumber: (renumber.get(c.docId) ?? "").trim() || null,
        linkAssets: impacts.get(c.docId)?.matchedAssets ?? [],
        actorId: uid, actorEmail: userEmail ?? null,
      });
      if (res.ok) { ok++; if (res.note) unkeyed.push(c.label); } else failed.push(c.label);
    }
    setBusy(null);
    const unkeyedText = unkeyed.length
      ? ` ${unkeyed.length} adopted without a uniqueness key (the library's key names a field the sheet does not carry — set it in the document's properties): ${unkeyed.join(", ")}.`
      : "";
    setMsg((failed.length
      ? `Adopted ${ok} of ${clean.length} — failed: ${failed.join(", ")}`
      : `Adopted ${ok} clean document${ok === 1 ? "" : "s"} into the controlled register. ${flaggedCount ? `${flaggedCount} flagged sheet${flaggedCount === 1 ? "" : "s"} stayed for resolution.` : ""}`) + unkeyedText);
    await refresh();
  };

  if (loading && candidates.length === 0) {
    return <div className="py-6 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-[var(--color-accent)]" /></div>;
  }
  if (candidates.length === 0) return null; // nothing to transition — stay out of the way

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <ArrowRightCircle className="w-4 h-4 text-[var(--color-accent)]" />
        <span className="text-base font-bold text-[var(--color-text)]">Transition in</span>
        <span className="text-xs text-[var(--color-text-muted)]">
          {candidates.length} sheet{candidates.length === 1 ? "" : "s"} in intake ·{" "}
          <b className="text-emerald-700 dark:text-emerald-300">{cleanCount} clean</b>
          {flaggedCount > 0 && <> · <b className="text-amber-800 dark:text-amber-300">{flaggedCount} need review</b></>}
          {scanning && <> · scanning…</>}
        </span>
        <button onClick={() => void refresh()} disabled={loading} title="Re-scan" className="ml-auto p-1 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div aria-live="polite">{msg && <div role="status" className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/50 px-3 py-2 text-xs font-bold text-[var(--color-text)]">{msg}</div>}</div>

      {canManage && !canAdopt && (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 px-3 py-2 text-xs text-[var(--color-text-muted)]">
          Adopting sheets into the controlled register moves them between folders, which needs Admin or Document Control — ask one of them to adopt the clean sheets below.
        </div>
      )}
      {canAdopt && (
        <div className="flex items-center gap-2 flex-wrap rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface-2)]/40 p-2.5">
          <span className="text-[10px] font-bold text-[var(--color-text-muted)]">Adopt into</span>
          <select value={destLib} onChange={(e) => setDestLib(e.target.value)} className="h-7 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs">
            <option value="">Library…</option>
            {libs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <select value={destCol} onChange={(e) => setDestCol(e.target.value)} disabled={!destLib} className="h-7 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs disabled:opacity-50">
            <option value="">Folder (library root)…</option>
            {cols.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button onClick={() => void adoptAllClean()} disabled={busy === "bulk" || cleanCount === 0 || !destLib}
            className={`${DECISION_TARGET} ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-xs font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50`}>
            {busy === "bulk" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
            Adopt {cleanCount} clean
          </button>
        </div>
      )}

      <ul className="space-y-1.5">
        {candidates.map((c) => {
          const impact = impacts.get(c.docId);
          const expanded = open === c.docId;
          return (
            <li key={c.docId} className={`rounded-xl border px-2.5 py-1.5 ${!impact ? "border-[var(--color-border)]" : impact.clean && !candidateInReview(c) ? "border-emerald-500/30 bg-emerald-500/[0.04]" : "border-amber-500/40 bg-amber-500/[0.05]"}`}>
              <button onClick={() => setOpen(expanded ? null : c.docId)} className="w-full flex items-center gap-2 text-left">
                {expanded ? <ChevronDown className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />}
                <span className="text-sm font-bold text-[var(--color-text)] truncate">{c.label}</span>
                <span className="text-xs text-[var(--color-text-muted)] shrink-0">Rev {c.rev ?? "—"}{c.company ? ` · ${c.company}` : ""}</span>
                <span className="ml-auto flex items-center gap-1.5 shrink-0">
                  {!impact && <Loader2 className="w-3 h-3 animate-spin text-[var(--color-text-faint)]" />}
                  {impact?.matchedAssets.length ? (
                    <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-sky-700 dark:text-sky-300" title={`Equipment in the registry: ${impact.matchedAssets.map((a) => a.tag).join(", ")}`}>
                      <Cable className="w-3 h-3" /> {impact.matchedAssets.length}
                    </span>
                  ) : null}
                  {impact?.numberCollision && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] font-black text-rose-700 dark:text-rose-300"><ShieldAlert className="w-3 h-3" /> number collision</span>
                  )}
                  {impact && impact.overlapDocs.length > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-amber-700 dark:text-amber-400"><Layers className="w-3 h-3" /> {impact.overlapDocs.length} overlap{impact.overlapDocs.length === 1 ? "" : "s"}</span>
                  )}
                  {candidateInReview(c) && <span className="text-[10px] font-bold text-amber-700 dark:text-amber-400">{c.pendingRetired ? "stuck" : c.pendingReview ? "in review" : "not approved"}</span>}
                  {impact && !impact.numberCollision && impact.unverifiable.length > 0 && (
                    <span className="text-[10px] font-bold text-[var(--color-text-muted)]" title={impact.unverifiable.map((r) => UNVERIFIABLE_TEXT[r]).join("; ")}>unverifiable</span>
                  )}
                  {impact?.clean && !candidateInReview(c) && <span className="text-[10px] font-bold text-emerald-700 dark:text-emerald-300">clean</span>}
                </span>
              </button>

              {expanded && impact && (
                <div className="mt-2 pt-2 border-t border-[var(--color-border)] space-y-2 text-xs">
                  {impact.numberCollision && (() => {
                    const blocking = blockingCollider(impact);
                    const shown = blocking ?? impact.numberCollision;
                    return (
                    <div className="rounded-lg border border-rose-500/40 bg-rose-500/[0.06] px-2.5 py-1.5">
                      <b className="text-rose-700 dark:text-rose-300">Number collision:</b>{" "}
                      <span className="text-[var(--color-text)]">{shown.label} (Rev {shown.rev ?? "—"}) already exists in the register{blocking && !numberDecides ? " in another library" : ""}.</span>{" "}
                      <span className="text-[var(--color-text-muted)]">{blocking
                        ? "Renumber this sheet below, or resolve which one is the source of truth before adopting."
                        : "It is a sheet of the destination library, which numbers sheets separately, so a shared number is expected there — adoption checks the sheet's full key."}</span>
                    </div>
                    );
                  })()}
                  {impact.overlapDocs.length > 0 && (
                    <div className="rounded-lg border border-amber-500/40 bg-amber-500/[0.06] px-2.5 py-1.5 space-y-1">
                      <div><b className="text-amber-700 dark:text-amber-400">Equipment overlap</b> <span className="text-[var(--color-text-muted)]">— existing sheets carry the same equipment and likely need a tie-in revision:</span></div>
                      <ul className="space-y-0.5">
                        {impact.overlapDocs.slice(0, 8).map((o) => (
                          <li key={o.id} className="text-[var(--color-text)]">
                            <b>{o.label}</b> <span className="text-[var(--color-text-muted)]">Rev {o.rev ?? "—"} · shares {o.sharedTags.join(", ")}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {impact.matchedAssets.length > 0 && (
                    <div className="text-[var(--color-text-muted)]">
                      Registry equipment on this sheet: <b className="text-[var(--color-text)]">{impact.matchedAssets.map((a) => a.tag).join(", ")}</b> — linked automatically on adoption.
                    </div>
                  )}
                  {impact.unverifiable.length > 0 && (
                    <div className="text-[var(--color-text-muted)] italic">
                      Not fully checked: {impact.unverifiable.map((r) => UNVERIFIABLE_TEXT[r]).join("; ")}. It is left out of bulk adoption; adopt it on its own once you have looked at it.
                    </div>
                  )}
                  {!c.awaitingReview && c.latestRejected && (
                    <div className="text-[var(--color-text-muted)] italic">
                      The newest proposal for this sheet was rejected — adoption moves its approved Rev {c.rev ?? "—"}.
                    </div>
                  )}
                  {candidateInReview(c) && (
                    <div className="rounded-lg border border-amber-500/40 bg-amber-500/[0.06] px-2.5 py-1.5 text-[var(--color-text)]">
                      {candidateReviewNote(c)}
                    </div>
                  )}

                  {canManage && (
                    <div className="flex items-center gap-2 flex-wrap">
                      {canAdopt && (<>
                      <input
                        value={renumber.get(c.docId) ?? ""}
                        onChange={(e) => setRenumber(new Map(renumber).set(c.docId, e.target.value))}
                        placeholder={`Renumber (now ${c.number ?? "unnumbered"})…`}
                        className="h-7 w-56 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs"
                      />
                      <button onClick={() => void adoptOne(c)}
                        disabled={busy === c.docId || !destLib || candidateInReview(c) || (blocksOnNumber(impact) && !(renumber.get(c.docId) ?? "").trim())}
                        title={!destLib ? "Pick the destination library above"
                          : candidateInReview(c) ? (c.pendingRetired ? "Document Control must clear its retired pending revision first" : "Approve or reject the submission first")
                          : blocksOnNumber(impact) && !(renumber.get(c.docId) ?? "").trim() ? "Renumber it to a number that isn't in use first"
                          : undefined}
                        className={`${DECISION_TARGET} inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-500 text-white text-[11px] font-black hover:bg-emerald-600 disabled:opacity-50`}>
                        {busy === c.docId ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowRightCircle className="w-3 h-3" />} Adopt
                      </button>
                      </>)}
                      {(impact.numberCollision || impact.overlapDocs.length > 0) && onFlagCollision && (
                        <button onClick={() => onFlagCollision(c, impact)}
                          className={`${DECISION_TARGET} inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-amber-500/50 text-amber-700 dark:text-amber-400 text-[11px] font-black hover:bg-amber-500/10`}>
                          <ShieldAlert className="w-3 h-3" /> Flag to drafting
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
