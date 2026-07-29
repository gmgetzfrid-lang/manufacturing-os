"use client";

// TransitionInPanel — the adoption step after intake. A contractor's new
// drawing set sits in the project's intake folder; this panel scans each
// sheet against the existing register (equipment tie-ins, number collisions,
// overlapping drawings) and then moves the clean ones into a real library —
// renumbered if wanted, equipment linked, project association kept,
// provenance untouched. Anything with a collision stays put until a human
// resolves it — a single source of truth is the whole point.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRightCircle, Loader2, ShieldAlert, ShieldCheck, Cable, Layers,
  ChevronDown, ChevronRight, RefreshCw,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import {
  TransitionCandidate, TransitionImpact,
  listTransitionCandidates, scanTransitionImpact, adoptDocument,
} from "@/lib/transitionIn";

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
  const [libs, setLibs] = useState<Array<{ id: string; name: string }>>([]);
  const [cols, setCols] = useState<Array<{ id: string; name: string }>>([]);
  const [destLib, setDestLib] = useState("");
  const [destCol, setDestCol] = useState("");
  const [renumber, setRenumber] = useState<Map<string, string>>(new Map());

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [cands, { data: ls }] = await Promise.all([
        listTransitionCandidates(orgId, intakeCollectionId),
        supabase.from("libraries").select("id, name").eq("org_id", orgId).order("name"),
      ]);
      setCandidates(cands);
      setLibs(((ls ?? []) as Array<{ id: string; name: string }>));
      // Scan sequentially in small batches — read-only, best-effort.
      setScanning(true);
      const next = new Map<string, TransitionImpact>();
      for (const c of cands) {
        next.set(c.docId, await scanTransitionImpact(orgId, c, intakeCollectionId));
        setImpacts(new Map(next));
      }
      setScanning(false);
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

  const cleanCount = useMemo(
    () => candidates.filter((c) => impacts.get(c.docId)?.clean).length,
    [candidates, impacts],
  );
  const flaggedCount = useMemo(
    () => candidates.filter((c) => { const i = impacts.get(c.docId); return i && !i.clean; }).length,
    [candidates, impacts],
  );

  const adoptOne = async (c: TransitionCandidate) => {
    if (!destLib) { setMsg("Pick the destination library first."); return; }
    const impact = impacts.get(c.docId);
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
      setMsg(`${c.label} adopted into the controlled register.`);
      await refresh();
    } catch (e) { setMsg((e as Error).message); }
    finally { setBusy(null); }
  };

  const adoptAllClean = async () => {
    if (!destLib) { setMsg("Pick the destination library first."); return; }
    const clean = candidates.filter((c) => impacts.get(c.docId)?.clean);
    if (!clean.length) return;
    setBusy("bulk"); setMsg(null);
    let ok = 0; const failed: string[] = [];
    for (const c of clean) {
      const res = await adoptDocument({
        orgId, projectId, docId: c.docId,
        libraryId: destLib, collectionId: destCol || null,
        newNumber: (renumber.get(c.docId) ?? "").trim() || null,
        linkAssets: impacts.get(c.docId)?.matchedAssets ?? [],
        actorId: uid, actorEmail: userEmail ?? null,
      });
      if (res.ok) ok++; else failed.push(c.label);
    }
    setBusy(null);
    setMsg(failed.length
      ? `Adopted ${ok} of ${clean.length} — failed: ${failed.join(", ")}`
      : `Adopted ${ok} clean document${ok === 1 ? "" : "s"} into the controlled register. ${flaggedCount ? `${flaggedCount} flagged sheet${flaggedCount === 1 ? "" : "s"} stayed for resolution.` : ""}`);
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
          <b className="text-emerald-600">{cleanCount} clean</b>
          {flaggedCount > 0 && <> · <b className="text-amber-600">{flaggedCount} need review</b></>}
          {scanning && <> · scanning…</>}
        </span>
        <button onClick={() => void refresh()} disabled={loading} title="Re-scan" className="ml-auto p-1 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {msg && <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/50 px-3 py-2 text-xs font-bold text-[var(--color-text)]">{msg}</div>}

      {canManage && (
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
            className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-xs font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
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
            <li key={c.docId} className={`rounded-xl border px-2.5 py-1.5 ${!impact ? "border-[var(--color-border)]" : impact.clean ? "border-emerald-500/30 bg-emerald-500/[0.04]" : "border-amber-500/40 bg-amber-500/[0.05]"}`}>
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
                  {impact?.clean && <span className="text-[10px] font-bold text-emerald-600">clean</span>}
                </span>
              </button>

              {expanded && impact && (
                <div className="mt-2 pt-2 border-t border-[var(--color-border)] space-y-2 text-xs">
                  {impact.numberCollision && (
                    <div className="rounded-lg border border-rose-500/40 bg-rose-500/[0.06] px-2.5 py-1.5">
                      <b className="text-rose-700 dark:text-rose-300">Number collision:</b>{" "}
                      <span className="text-[var(--color-text)]">{impact.numberCollision.label} (Rev {impact.numberCollision.rev ?? "—"}) already exists in the register.</span>{" "}
                      <span className="text-[var(--color-text-muted)]">Renumber this sheet below, or resolve which one is the source of truth before adopting.</span>
                    </div>
                  )}
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
                  {impact.tags.length === 0 && (
                    <div className="text-[var(--color-text-faint)] italic">No equipment tags recognized in the number/title — adoption still works, links can be added later.</div>
                  )}

                  {canManage && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <input
                        value={renumber.get(c.docId) ?? ""}
                        onChange={(e) => setRenumber(new Map(renumber).set(c.docId, e.target.value))}
                        placeholder={`Renumber (now ${c.number ?? "unnumbered"})…`}
                        className="h-7 w-56 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs"
                      />
                      <button onClick={() => void adoptOne(c)} disabled={busy === c.docId || !destLib}
                        title={!destLib ? "Pick the destination library above" : undefined}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-500 text-white text-[11px] font-black hover:bg-emerald-600 disabled:opacity-50">
                        {busy === c.docId ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowRightCircle className="w-3 h-3" />} Adopt
                      </button>
                      {!impact.clean && onFlagCollision && (
                        <button onClick={() => onFlagCollision(c, impact)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-amber-500/50 text-amber-700 dark:text-amber-400 text-[11px] font-black hover:bg-amber-500/10">
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
