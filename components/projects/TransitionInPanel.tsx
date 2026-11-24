"use client";

// TransitionInPanel — the adoption step after intake. A contractor's new
// drawing set sits in the project's intake folder; this panel scans each
// sheet against the existing register (equipment tie-ins, number collisions,
// overlapping drawings) and then moves the clean ones into a real library —
// renumbered if wanted, equipment linked, project association kept,
// provenance untouched. Anything with a collision stays put until a human
// resolves it — a single source of truth is the whole point.

import { Card } from "@/components/ui/PageHero";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRightCircle, Loader2, ShieldAlert, ShieldCheck, Cable, Layers, ChevronRight, RefreshCw,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import {
  TransitionCandidate, TransitionImpact,
  listTransitionCandidates, scanTransitionImpact, adoptDocument,
} from "@/lib/transitionIn";
import { sayError } from "@/components/projects/sayError";
import { SkeletonRows } from "@/components/ui/Skeleton";

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
  // The library picked last time on this project, to start with.
  const destKey = `transition-in.dest:${projectId}`;
  const [destLib, setDestLibState] = useState(() => { try { return localStorage.getItem(destKey) ?? ""; } catch { return ""; } });
  const setDestLib = (v: string) => { setDestLibState(v); try { localStorage.setItem(destKey, v); } catch { /* private mode */ } };
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
      setMsg(`Couldn't load the transition list: ${sayError(e)}`);
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
      // A remembered library that's gone: pick again.
      if (alive && libs.length && !libs.some((l) => l.id === destLib)) setDestLib("");
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- libs only checks a remembered pick
  }, [destLib, libs]);

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
    } catch (e) { setMsg(sayError(e)); }
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
      ? `Adopted ${ok} of ${clean.length}. Not adopted: ${failed.join(", ")}`
      : `Adopted ${ok} clean document${ok === 1 ? "" : "s"} into the controlled register. ${flaggedCount ? `${flaggedCount} flagged sheet${flaggedCount === 1 ? "" : "s"} stayed for resolution.` : ""}`);
    await refresh();
  };

  if (loading && candidates.length === 0) {
    return <SkeletonRows rows={3} cols={1} what="the intake" sheet={false} />;
  }
  // Nothing to transition: stay out of the way, unless the read failed.
  if (candidates.length === 0) return msg ? <Card><div role="alert" className="text-body font-medium text-[var(--state-overdue-text)]">{msg}</div></Card> : null;

  return (
    <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-4 sm:p-5 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-body font-medium text-[var(--color-text-muted)]">Transition in</span>
        <span className="text-body text-[var(--color-text-muted)]">
          {candidates.length} sheet{candidates.length === 1 ? "" : "s"} in intake ·{" "}
          <b className="text-[var(--state-released-text)]">{cleanCount} clean</b>
          {flaggedCount > 0 && <> · <b className="text-[var(--state-held-text)]">{flaggedCount} need review</b></>}
          {scanning && <> · scanning…</>}
        </span>
        <button onClick={() => void refresh()} disabled={loading} title="Scan again" aria-label="Scan again" className="ui-hit ml-auto p-1 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {msg && <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/50 px-3 py-2 text-caption font-medium text-[var(--color-text)]">{msg}</div>}

      {canManage && (
        <div className="flex items-center gap-2 flex-wrap rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface-2)]/40 p-2.5">
          <span className="text-caption font-medium text-[var(--color-text-muted)]">Adopt into</span>
          <select value={destLib} onChange={(e) => setDestLib(e.target.value)} aria-label="Adopt into library" className="h-7 pointer-coarse:h-11 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-caption">
            <option value="">Library…</option>
            {libs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <select value={destCol} onChange={(e) => setDestCol(e.target.value)} disabled={!destLib} aria-label="Adopt into collection" className="h-7 pointer-coarse:h-11 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-caption disabled:opacity-50">
            <option value="">Folder (library root)…</option>
            {cols.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button onClick={() => void adoptAllClean()} disabled={busy === "bulk" || cleanCount === 0 || !destLib}
            className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-caption font-medium hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
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
            <li key={c.docId} className={`rounded-xl border px-2.5 py-1.5 border-[var(--color-border)] ${impact && !impact.clean ? "border-l-2 border-l-[var(--state-held)]" : ""}`}>
              <button onClick={() => setOpen(expanded ? null : c.docId)} className="w-full flex items-center gap-2 text-left">
                <ChevronRight className={`w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0 ui-chevron${(expanded) ? " rotate-90" : ""}`} />
                <span className="text-body font-medium text-[var(--color-text)] truncate">{c.label}</span>
                <span className="text-caption text-[var(--color-text-muted)] shrink-0">Rev {c.rev ?? "-"}{c.company ? ` · ${c.company}` : ""}</span>
                <span className="ml-auto flex items-center gap-1.5 shrink-0">
                  {!impact && <Loader2 className="w-3 h-3 animate-spin text-[var(--color-text-faint)]" />}
                  {impact?.matchedAssets.length ? (
                    <span className="inline-flex items-center gap-0.5 text-caption font-medium text-[var(--color-text)]" title={`Equipment in the registry: ${impact.matchedAssets.map((a) => a.tag).join(", ")}`}>
                      <Cable className="w-3 h-3" /> {impact.matchedAssets.length}
                    </span>
                  ) : null}
                  {impact?.numberCollision && (
                    <span className="inline-flex items-center gap-0.5 text-caption font-medium text-[var(--state-overdue-text)]"><ShieldAlert className="w-3 h-3" /> number collision</span>
                  )}
                  {impact && impact.overlapDocs.length > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-caption font-medium text-[var(--state-held-text)]"><Layers className="w-3 h-3" /> {impact.overlapDocs.length} overlap{impact.overlapDocs.length === 1 ? "" : "s"}</span>
                  )}
                  {impact?.clean && <span className="text-caption font-medium text-[var(--state-released-text)]">clean</span>}
                </span>
              </button>

              {expanded && impact && (
                <div className="mt-2 pt-2 border-t border-[var(--color-border)] space-y-2 text-caption">
                  {impact.numberCollision && (
                    <div className="border-l-2 border-[var(--state-overdue)] pl-2.5">
                      <b className="text-[var(--state-overdue-text)]">Number collision:</b>{" "}
                      <span className="text-[var(--color-text)]">{impact.numberCollision.label} (Rev {impact.numberCollision.rev ?? "-"}) already exists in the register.</span>{" "}
                      <span className="text-[var(--color-text-muted)]">Renumber this sheet below, or resolve which one is the source of truth before adopting.</span>
                    </div>
                  )}
                  {impact.overlapDocs.length > 0 && (
                    <div className="border-l-2 border-[var(--state-held)] pl-2.5 space-y-1">
                      <div><b className="text-[var(--state-held-text)]">Equipment overlap:</b> <span className="text-[var(--color-text-muted)]">existing sheets carry the same equipment and likely need a tie-in revision.</span></div>
                      <ul className="space-y-0.5">
                        {impact.overlapDocs.slice(0, 8).map((o) => (
                          <li key={o.id} className="text-[var(--color-text)]">
                            <b>{o.label}</b> <span className="text-[var(--color-text-muted)]">Rev {o.rev ?? "-"} · shares {o.sharedTags.join(", ")}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {impact.matchedAssets.length > 0 && (
                    <div className="text-[var(--color-text-muted)]">
                      Registry equipment on this sheet: <b className="text-[var(--color-text)]">{impact.matchedAssets.map((a) => a.tag).join(", ")}</b>, linked on adoption.
                    </div>
                  )}
                  {impact.tags.length === 0 && (
                    <div className="text-[var(--color-text-faint)] italic">No equipment tags found in the number or title. It can still be adopted; links can be added later.</div>
                  )}

                  {canManage && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <input
                        aria-label="New document number"
                        value={renumber.get(c.docId) ?? ""}
                        onChange={(e) => setRenumber(new Map(renumber).set(c.docId, e.target.value))}
                        placeholder={`Renumber (now ${c.number ?? "unnumbered"})…`}
                        className="h-7 w-56 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-caption"
                      />
                      <button onClick={() => void adoptOne(c)} disabled={busy === c.docId || !destLib}
                        title={!destLib ? "Pick the destination library above" : undefined}
                        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors">
                        {busy === c.docId ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowRightCircle className="w-3 h-3" />} Adopt
                      </button>
                      {!impact.clean && onFlagCollision && (
                        <button onClick={() => onFlagCollision(c, impact)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 pointer-coarse:min-h-11 rounded-lg border border-[var(--state-held)] text-[var(--state-held-text)] text-caption font-medium hover:bg-[color-mix(in_srgb,var(--state-held)_10%,transparent)]">
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
