"use client";

// Library health — is this knowledge library a true, complete copy of the
// document libraries it's linked to? Every linked document is accounted
// for under exactly one status, the numbers add up to the source's real
// total, and Repair fixes everything fixable without throwing paid-for
// index work away.

import React, { useCallback, useEffect, useState } from "react";
import {
  ShieldCheck, ShieldAlert, Loader2, RefreshCw, Wrench, ChevronDown, ChevronRight, AlertTriangle, CheckCircle2, Info, Unlink, Tag,
} from "lucide-react";
import { getLibraryHealth, repairLibrary, fixLinkedDocumentNames, type KnowledgeHealthReport, type RepairResult } from "@/lib/knowledge";
import type { NameRepairResult } from "@/lib/documentNameRepair";
import { MEANING_PROGRESS_EVENT } from "@/components/knowledge/SemanticIndexPanel";
import { STATUS_LABEL, FIXABLE, NOT_INDEXABLE, type HealthStatus } from "@/lib/knowledgeHealth";

const ORDER: HealthStatus[] = [
  "indexed", "indexing", "waiting", "outdated", "partial", "stuck", "failed", "missing", "retired",
  "notPdf", "noFile", "heldBack", "notCurrent",
];
const TONE: Record<HealthStatus, string> = {
  indexed: "bg-[var(--state-released)]", indexing: "bg-[var(--color-text-muted)]", waiting: "bg-[var(--color-border)]",
  outdated: "bg-[var(--state-held)]", partial: "bg-amber-400", stuck: "bg-[var(--color-text-muted)]", failed: "bg-[var(--state-overdue)]",
  missing: "bg-rose-400", retired: "bg-[var(--color-text-muted)]",
  notPdf: "bg-slate-400", noFile: "bg-slate-300", heldBack: "bg-slate-500", notCurrent: "bg-slate-300",
};
const EXPLAIN: Partial<Record<HealthStatus, string>> = {
  waiting: "Queued - the library reads these automatically while it's open, and in the background.",
  outdated: "A newer revision was published. Repair queues the new file.",
  partial: "Marked done but some pages weren't read. Repair resumes from the last page - pages already read aren't paid for again.",
  stuck: "Started reading and stopped moving. Repair re-queues them; reading resumes where it stopped.",
  failed: "Reading failed. Repair retries; the reason is shown per file.",
  missing: "In the linked library but not in the index - the sync never got to them. Repair adds them.",
  retired: "Their index was set aside when they left the library. The next sync restores it - no re-reading, no new meaning-index cost.",
  notPdf: "Not PDFs (CAD, images, spreadsheets) - they can't be read, so they're never indexed. This is expected.",
  noFile: "No file attached to the current revision.",
  heldBack: "Held back from AI by a controller.",
  notCurrent: "Superseded, void or archived - the AI reads only documents in force.",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A timeout or gateway error: the platform or a busy database, not a fault. */
const isWeather = (e: unknown) => !!(e as { transient?: boolean })?.transient || /^HTTP 50[234]$/.test((e as Error)?.message ?? "");
const friendly = (e: unknown) => isWeather(e)
  ? "The database is busy right now (usually: the meaning index is being written), so this took too long. Nothing was lost - try again in a few minutes."
  : (e as Error)?.message ?? String(e);

export default function HealthPanel({ orgId, libraryId, isController, onRepaired }: {
  orgId: string; libraryId: string; isController: boolean; onRepaired?: () => void;
}) {
  const [report, setReport] = useState<KnowledgeHealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [last, setLast] = useState<RepairResult | null>(null);
  const [open, setOpen] = useState<HealthStatus | "leftovers" | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [naming, setNaming] = useState<{ fixed: number } | null>(null);
  const [nameResult, setNameResult] = useState<NameRepairResult | null>(null);
  const [namesOpen, setNamesOpen] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    // A timeout while the database is busy is retried quietly, twice.
    for (let attempt = 0; ; attempt++) {
      try {
        setReport(await getLibraryHealth(orgId, libraryId));
        break;
      } catch (e) {
        if (!isWeather(e) || attempt >= 2) { setError(friendly(e)); break; }
        await sleep(4_000 * (attempt + 1));
      }
    }
    setChecking(false);
  }, [orgId, libraryId]);
  useEffect(() => { void Promise.resolve().then(check); }, [check]);
  // The meaning-index panel's numbers, live, so the two never disagree.
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ libraryId: string; chunks: number; embedded: number }>).detail;
      if (d?.libraryId !== libraryId) return;
      setReport((r) => r ? { ...r, meaning: { chunks: d.chunks, embedded: d.embedded } } : r);
    };
    window.addEventListener(MEANING_PROGRESS_EVENT, on);
    return () => window.removeEventListener(MEANING_PROGRESS_EVENT, on);
  }, [libraryId]);

  const repair = async () => {
    setRepairing(true);
    setError(null);
    // Kept past the fresh check below (which clears its own error line).
    let note: string | null = null;
    try {
      setLast(await repairLibrary(orgId, libraryId));
      onRepaired?.();
    } catch (e) {
      note = isWeather(e)
        ? "Repair ran longer than the host allows, which is common while the meaning index is being written. What it did is saved; press Repair again to finish."
        : friendly(e);
      setError(note);
    } finally {
      setRepairing(false);
    }
    // The fresh report is its own request — together they outran the limit.
    await check();
    if (note) setError(note);
  };

  // Rounds that each fit the host's time limit; every round's corrections
  // are saved as it goes, so stopping part-way loses nothing.
  const fixNames = async () => {
    setNaming({ fixed: 0 });
    setError(null);
    let note: string | null = null;
    const total: NameRepairResult = { fixed: 0, skipped: 0, conflicts: [], failed: [], remaining: 0 };
    let weather = 0;
    try {
      for (let round = 0; round < 60; round++) {
        const exclude = [...total.conflicts.map((c) => c.id), ...total.failed.flatMap((f) => (f.id ? [f.id] : []))];
        let r: Awaited<ReturnType<typeof fixLinkedDocumentNames>>;
        try {
          r = await fixLinkedDocumentNames(orgId, libraryId, exclude);
          weather = 0;
        } catch (e) {
          if (!isWeather(e) || ++weather > 3) throw e;
          await sleep(5_000 * weather);
          continue;
        }
        total.fixed += r.names.fixed;
        total.skipped += r.names.skipped;
        total.conflicts.push(...r.names.conflicts);
        total.failed.push(...r.names.failed.filter((f) => f.id));
        total.remaining = r.names.remaining;
        setNaming({ fixed: total.fixed });
        if (r.names.remaining === 0) break;
        if (r.names.fixed === 0 && r.names.conflicts.length === 0 && r.names.failed.length === 0) break; // no progress
      }
      setNameResult(total);
      // Bring the index's names up to date (a sync — label changes only,
      // nothing re-read), then a fresh report.
      if (total.fixed > 0) await repairLibrary(orgId, libraryId).catch((e: unknown) => {
        note = `Names corrected, but the index's labels weren't refreshed: ${friendly(e)} Press Repair to finish.`;
      });
      onRepaired?.();
    } catch (e) {
      setNameResult(total);
      note = `${friendly(e)}${total.fixed ? ` ${total.fixed} corrected before it stopped are saved. Press Correct again to finish.` : ""}`;
    } finally {
      setNaming(null);
    }
    await check();
    if (note) setError(note);
  };

  if (!report) {
    return (
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-[13px] text-[var(--color-text-muted)] flex items-center gap-2">
        {error ? <><AlertTriangle className="w-4 h-4 text-[var(--state-held)]" /> {error} <button onClick={() => void check()} className="ml-1 font-bold underline">Try again</button></>
          : <><Loader2 className="w-4 h-4 animate-spin" /> Checking that every linked document is accounted for…</>}
      </div>
    );
  }

  const L = report.linked;
  const fixable = L ? [...FIXABLE].reduce((n, k) => n + L.counts[k], 0) + L.leftovers.length : 0;
  const notIndexable = L ? [...NOT_INDEXABLE].reduce((n, k) => n + L.counts[k], 0) : 0;
  const inFlight = L ? L.counts.waiting + L.counts.indexing : 0;
  const healthy = (L ? L.healthy : true) && report.uploaded.failed === 0 && report.uploaded.partial === 0 && !(report.names?.wrong);
  const deadSources = report.sources.filter((s) => !s.exists);
  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 100);
  const meaningPct = report.meaning ? pct(report.meaning.embedded, report.meaning.chunks) : null;
  const N = report.names;
  const nameFixable = N ? N.wrong - N.clashes : 0;
  // How many of each fault, when every one found is in hand (the list is
  // capped; with more than it holds, the split isn't known and isn't said).
  const nameKinds = N && N.wrong > 0 && N.samples.length >= N.wrong ? (() => {
    const tails = N.samples.filter((f) => f.kind === "sheet-suffix");
    return { suffix: tails.length, reader: N.samples.length - tails.length, example: tails[0]?.from.documentNumber ?? null };
  })() : null;

  return (
    <div className={`rounded-lg border border-[var(--color-border)] ${healthy && !report.incomplete ? "" : "border-l-[3px] border-l-[var(--state-held)]"} bg-[var(--color-surface)] overflow-hidden`}>
      <div className="px-4 py-3 flex items-center gap-3 flex-wrap">
        {healthy && !report.incomplete
          ? <ShieldCheck className="w-5 h-5 text-[var(--state-released)] shrink-0" />
          : <ShieldAlert className="w-5 h-5 text-[var(--state-held)] shrink-0" />}
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-[var(--color-text-muted)]">Library health</div>
          <div className="font-display text-[17px] font-semibold text-[var(--color-text)]">
            {L
              ? <>{L.counts.indexed.toLocaleString()} of {L.indexable.toLocaleString()} readable documents indexed
                  <span className="font-semibold text-[var(--color-text-muted)]"> · {L.total.toLocaleString()} in the linked {report.sources.length === 1 ? "source" : "sources"}</span></>
              : <>{report.uploaded.ready.toLocaleString()} of {report.uploaded.total.toLocaleString()} uploaded PDFs indexed</>}
          </div>
          <div className="text-[13px] text-[var(--color-text-muted)]">
            {healthy && !report.incomplete
              ? (inFlight > 0 ? `${inFlight.toLocaleString()} still being read - everything is accounted for.` : "Every linked document is accounted for.")
              : fixable > 0 ? `${fixable.toLocaleString()} need attention - Repair fixes them without re-paying for work already done.`
              : report.incomplete ? "Some numbers may be short - see below."
              : report.names?.wrong ? "Every document is indexed; some names need correcting - see below."
              : "Some uploaded PDFs need attention - Repair re-queues them."}
            {notIndexable > 0 && ` ${notIndexable.toLocaleString()} can't be indexed (not PDFs, held back, superseded) - expected.`}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button onClick={() => void check()} disabled={checking || repairing}
            className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg border border-[var(--color-border)] text-[13px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${checking ? "animate-spin" : ""}`} /> Re-check
          </button>
          {isController && (
            <button onClick={() => void repair()} disabled={repairing || checking}
              className={`inline-flex items-center gap-1 h-8 px-3 rounded-lg text-[13px] font-semibold disabled:opacity-50 ${
                fixable > 0 || report.incomplete ? "bg-[var(--color-text)] text-[var(--color-surface)] hover:opacity-90" : "border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}>
              {repairing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wrench className="w-3.5 h-3.5" />}
              {repairing ? "Repairing…" : "Repair"}
            </button>
          )}
          <button onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} aria-label={expanded ? "Hide details" : "Show every status"} className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]" title={expanded ? "Hide details" : "Show every status"}>
            {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* The whole source as one bar — every document is in exactly one colour. */}
      {L && L.total > 0 && (
        <div className="px-4 pb-2">
          <div className="h-2 rounded-full overflow-hidden flex bg-[var(--color-surface-2)]">
            {ORDER.filter((k) => L.counts[k] > 0).map((k) => (
              <span key={k} className={TONE[k]} style={{ width: `${(L.counts[k] / L.total) * 100}%` }} title={`${STATUS_LABEL[k]}: ${L.counts[k]}`} />
            ))}
          </div>
        </div>
      )}

      {last && (
        <div className="mx-4 mb-2 border-l-2 border-emerald-500 pl-3 py-1 text-[13px] text-emerald-900 flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0 mt-px" />
          <span>
            Repair done.{" "}
            {last.sync ? <>Added {last.sync.added}, refreshed {last.sync.refreshed}{last.sync.renamed ? `, renamed ${last.sync.renamed}` : ""}, restored {last.sync.restored} from set-aside (free), set aside {last.sync.retired}.</> : null}{" "}
            Re-queued {last.requeued.failed} failed, {last.requeued.stuck} stuck, {last.requeued.partial} partly read - they resume where they stopped.
            {last.sync && last.sync.removed > 0 && <b> {last.sync.removed} were deleted instead of set aside because the database update (20261024) hasn&apos;t been run.</b>}
            {last.sync?.errors.length ? <span className="block mt-0.5 text-[var(--state-held)]">{last.sync.errors.slice(0, 3).join(" · ")}</span> : null}
          </span>
        </div>
      )}
      {error && <div className="mx-4 mb-2 text-[13px] text-[var(--state-overdue)]">{error}</div>}
      {report.incomplete && (
        <div className="mx-4 mb-2 border-l-2 border-[var(--state-held)] pl-3 py-1 text-[13px] text-[var(--state-held)] flex gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          Part of the check couldn&apos;t be read, so some numbers may be short. Nothing is ever removed on an incomplete read. {report.errors.slice(0, 2).join(" · ")}
        </div>
      )}
      {report.skipped?.length > 0 && (
        <div className="mx-4 mb-2 border-l-2 border-[var(--color-border-strong)] pl-3 py-1 text-[13px] text-[var(--color-text)] dark:text-[var(--color-text)] flex gap-2">
          <Info className="w-4 h-4 shrink-0" />
          <span>The database is slow right now (usually: the meaning index is being written), so to answer quickly this check left out: {report.skipped.join(", ")}. Press Re-check in a few minutes for the full picture.</span>
        </div>
      )}
      {deadSources.length > 0 && (
        <div className="mx-4 mb-2 border-l-2 border-[var(--state-overdue)] pl-3 py-1 text-[13px] text-[var(--state-overdue)] flex gap-2">
          <Unlink className="w-4 h-4 shrink-0" />
          {deadSources.length === 1 ? "A linked source no longer exists" : `${deadSources.length} linked sources no longer exist`}: {deadSources.map((s) => s.name).join(", ")}. Unlink {deadSources.length === 1 ? "it" : "them"} in Sources below.
        </div>
      )}

      {N && N.wrong > 0 && (
        <div className="mx-4 mb-2 border-l-2 border-[var(--state-held)]">
          <div className="px-3 py-2 flex items-start gap-2 text-[13px] text-[var(--state-held)]">
            <Tag className="w-4 h-4 shrink-0 mt-px" />
            <div className="flex-1 min-w-0">
              {/* Two different faults, each said as what it is. */}
              {nameKinds && nameKinds.reader === 0 ? (
                <><b>{N.wrong.toLocaleString()} drawing {N.wrong === 1 ? "number carries" : "numbers carry"} a count an upload added</b>
                  {" "}(like &ldquo;{nameKinds.example ?? "5602-D 1000-7"}&rdquo;). It is not the sheet: each one&apos;s sheet is in its own field and stays. Correct takes the count off. The files and index are fine.</>
              ) : (
                <><b>{N.wrong.toLocaleString()} document {N.wrong === 1 ? "number or revision was" : "numbers or revisions were"} read wrong from {N.wrong === 1 ? "its file name" : "their file names"}</b>
                  {" "}(e.g. &ldquo;EP 5-3-10&rdquo; cut to &ldquo;EP&rdquo;). The files, titles and index are fine.
                  {nameKinds && nameKinds.suffix > 0 && ` ${nameKinds.suffix.toLocaleString()} of them carry a count an upload added after the number (not the sheet); Correct takes it off.`}</>
              )}
              {nameFixable > 0 && " Correcting them only touches values nobody has edited since upload; each change is recorded in the document's history."}
              {N.clashes > 0 && <span className="block mt-0.5">{N.clashes.toLocaleString()} can&apos;t be corrected automatically - their correct number is already used (often two files that are revisions of one document). They&apos;re listed for you to decide.</span>}
              <button onClick={() => setNamesOpen((v) => !v)} className="mt-1 inline-flex items-center gap-0.5 font-bold underline-offset-2 hover:underline">
                {namesOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />} {namesOpen ? "Hide" : "Show"} the list
              </button>
            </div>
            {isController && nameFixable > 0 && (
              <button onClick={() => void fixNames()} disabled={!!naming || repairing}
                className="shrink-0 inline-flex items-center gap-1 h-8 px-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] text-[13px] font-semibold hover:bg-[var(--color-surface-2)] disabled:opacity-60">
                {naming ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wrench className="w-3.5 h-3.5" />}
                {naming ? `Correcting… ${naming.fixed.toLocaleString()}` : `Correct ${nameFixable.toLocaleString()}`}
              </button>
            )}
          </div>
          {namesOpen && (
            <div className="px-3 pb-2">
              <ul className="max-h-64 overflow-auto divide-y divide-[var(--color-border)] rounded border border-[var(--color-border)] bg-[var(--color-surface)]">
                {N.samples.map((f) => (
                  <li key={f.id} className="px-2 py-1 text-[13px] grid sm:grid-cols-[1fr_auto] gap-x-2">
                    <span className="truncate text-[var(--color-text)]" title={f.fileName}>{f.fileName}</span>
                    <span className="font-display text-[14px] text-[var(--color-text-muted)] truncate">
                      <s>{f.from.documentNumber || "-"}{f.from.rev !== f.to.rev ? ` rev ${f.from.rev}` : ""}</s> → <b className="text-[var(--color-text)]">{f.to.documentNumber}{f.from.rev !== f.to.rev ? ` rev ${f.to.rev}` : ""}</b>
                      {f.kind === "sheet-suffix" && f.sheet ? ` · sheet ${String(f.sheet).replace(/^0+(?=\d)/, "")}` : ""}
                    </span>
                    {f.clash && <span className="sm:col-span-2 text-[var(--state-held)]">Needs you: {f.clash}</span>}
                  </li>
                ))}
              </ul>
              {N.wrong > N.samples.length && <p className="text-[13px] text-[var(--color-text-faint)] mt-1">Showing {N.samples.length} of {N.wrong.toLocaleString()}.</p>}
            </div>
          )}
        </div>
      )}
      {nameResult && (
        <div className="mx-4 mb-2 border-l-2 border-emerald-500 pl-3 py-1 text-[13px] text-emerald-900">
          <div className="flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-px" />
            <span>
              Corrected {nameResult.fixed.toLocaleString()} {nameResult.fixed === 1 ? "name" : "names"}; the index now cites them by their real numbers.
              {nameResult.skipped > 0 && ` ${nameResult.skipped} left alone - someone changed them since the check.`}
              {nameResult.remaining > 0 && ` ${nameResult.remaining} not reached yet - press Correct again to finish.`}
            </span>
          </div>
          {nameResult.conflicts.length > 0 && (
            <div className="mt-1 text-[var(--state-held)]">
              <b>{nameResult.conflicts.length} need your decision</b> - the correct number is already in use:
              <ul className="mt-0.5 max-h-32 overflow-auto">
                {nameResult.conflicts.slice(0, 100).map((c) => <li key={c.id} className="truncate">{c.fileName}: wants {c.wanted}{c.clashesWith ? `, used by ${c.clashesWith}` : ""}</li>)}
              </ul>
            </div>
          )}
          {nameResult.failed.length > 0 && (
            <div className="mt-1 text-[var(--state-overdue)]">{nameResult.failed.length} couldn&apos;t be saved - Correct again retries them. {nameResult.failed[0].reason}</div>
          )}
        </div>
      )}

      {expanded && (
        <div className="px-4 pb-4 space-y-3">
          {L && (
            <div className="grid sm:grid-cols-2 gap-1.5">
              {ORDER.map((k) => {
                const n = L.counts[k];
                if (n === 0 && k !== "indexed") return null;
                const isOpen = open === k;
                const items = L.samples[k] ?? [];
                return (
                  <div key={k} className={`rounded-lg border ${FIXABLE.has(k) ? "border-amber-200 dark:border-amber-900" : "border-[var(--color-border)]"} ${isOpen ? "sm:col-span-2" : ""}`}>
                    <button onClick={() => setOpen(isOpen ? null : k)} className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left">
                      <span className={`w-2.5 h-2.5 rounded-sm shrink-0 ${TONE[k]}`} />
                      <span className="flex-1 text-[12px] font-bold text-[var(--color-text)]">{STATUS_LABEL[k]}</span>
                      <span className="text-[12px] font-semibold tabular-nums text-[var(--color-text)]">{n.toLocaleString()}</span>
                      {items.length > 0 && (isOpen ? <ChevronDown className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> : <ChevronRight className="w-3.5 h-3.5 text-[var(--color-text-faint)]" />)}
                    </button>
                    {isOpen && (
                      <div className="px-2.5 pb-2">
                        {EXPLAIN[k] && <p className="text-[13px] text-[var(--color-text-muted)] mb-1.5 flex gap-1"><Info className="w-3 h-3 shrink-0 mt-0.5" />{EXPLAIN[k]}</p>}
                        <ul className="max-h-48 overflow-auto divide-y divide-[var(--color-border)] rounded border border-[var(--color-border)]">
                          {items.map((it) => (
                            <li key={it.id} className="px-2 py-1 flex items-center gap-2 text-[13px]">
                              <span className="font-display truncate flex-1 text-[var(--color-text)]">{it.name}</span>
                              {it.detail && <span className="shrink-0 max-w-[50%] truncate text-[var(--color-text-muted)]" title={it.detail}>{it.detail}</span>}
                            </li>
                          ))}
                        </ul>
                        {n > items.length && <p className="text-[13px] text-[var(--color-text-faint)] mt-1">Showing {items.length} of {n.toLocaleString()}.</p>}
                      </div>
                    )}
                  </div>
                );
              })}
              {L.leftovers.length > 0 && (
                <div className={`rounded-lg border border-amber-200 dark:border-amber-900 ${open === "leftovers" ? "sm:col-span-2" : ""}`}>
                  <button onClick={() => setOpen(open === "leftovers" ? null : "leftovers")} className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left">
                    <span className="w-2.5 h-2.5 rounded-sm shrink-0 bg-amber-300" />
                    <span className="flex-1 text-[12px] font-bold text-[var(--color-text)]">Left behind (file left the source)</span>
                    <span className="text-[12px] font-semibold tabular-nums">{L.leftovers.length.toLocaleString()}</span>
                  </button>
                  {open === "leftovers" && (
                    <div className="px-2.5 pb-2">
                      <p className="text-[13px] text-[var(--color-text-muted)] mb-1.5">Still searchable but their document was moved out, held back or deleted. Repair sets them aside - kept, not searched, restored free if the file comes back.</p>
                      <ul className="max-h-48 overflow-auto divide-y divide-[var(--color-border)] rounded border border-[var(--color-border)]">
                        {L.leftovers.slice(0, 100).map((it) => <li key={it.mirrorId ?? it.id} className="px-2 py-1 text-[14px] font-display truncate">{it.name}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="grid sm:grid-cols-3 gap-2 text-[13px]">
            <div className="rounded-lg border border-[var(--color-border)] px-2.5 py-2">
              <div className="font-semibold text-[var(--color-text)]">Meaning index</div>
              {report.meaning && meaningPct !== null ? (
                <>
                  <div className="text-[var(--color-text-muted)]">{report.meaning.embedded.toLocaleString()} of {report.meaning.chunks.toLocaleString()} passages ({meaningPct}%)</div>
                  <div className="mt-1 h-1.5 rounded-full bg-[var(--color-surface-2)] overflow-hidden"><div className="h-full bg-[var(--color-text-muted)]" style={{ width: `${meaningPct}%` }} /></div>
                </>
              ) : (
                <div className="text-[var(--color-text-muted)]">Busy building - the count will show on the next check.</div>
              )}
            </div>
            <div className="rounded-lg border border-[var(--color-border)] px-2.5 py-2">
              <div className="font-semibold text-[var(--color-text)]">Uploaded PDFs</div>
              <div className="text-[var(--color-text-muted)]">
                {report.uploaded.ready} indexed · {report.uploaded.waiting} waiting{report.uploaded.failed ? ` · ${report.uploaded.failed} failed` : ""}{report.uploaded.partial ? ` · ${report.uploaded.partial} partly read` : ""}
              </div>
            </div>
            <div className="rounded-lg border border-[var(--color-border)] px-2.5 py-2">
              <div className="font-semibold text-[var(--color-text)]">Set aside</div>
              <div className="text-[var(--color-text-muted)]">{report.retired.toLocaleString()} kept for free restore - not searched</div>
            </div>
          </div>
          <p className="text-[13px] text-[var(--color-text-faint)]">
            Checked {new Date(report.checkedAt).toLocaleTimeString()}. Moving files inside a linked library never touches their index; files added are picked up automatically; a file moved out is set aside, not deleted.
          </p>
        </div>
      )}
    </div>
  );
}
