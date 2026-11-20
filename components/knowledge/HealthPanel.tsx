"use client";

// Library health — is this knowledge library a true, complete copy of the
// document libraries it's linked to? Every linked document is accounted
// for under exactly one status, the numbers add up to the source's real
// total, and Repair fixes everything fixable without throwing paid-for
// index work away.

import React, { useCallback, useEffect, useState } from "react";
import {
  Loader2, RefreshCw, Wrench, ChevronDown, ChevronRight, HeartPulse,
} from "lucide-react";
import { getLibraryHealth, repairLibrary, fixLinkedDocumentNames, type KnowledgeHealthReport, type RepairResult } from "@/lib/knowledge";
import type { NameRepairResult } from "@/lib/documentNameRepair";
import { MEANING_PROGRESS_EVENT } from "@/components/knowledge/SemanticIndexPanel";
import { STATUS_LABEL, FIXABLE, NOT_INDEXABLE, type HealthStatus } from "@/lib/knowledgeHealth";
import { Section, tbl, sheet, btnQuiet, btnRow, link } from "@/components/admin/kit";
import { StatusTag } from "@/components/documents/StatusTag";
import { Note, Cells, Bar } from "@/components/knowledge/panelKit";

const ORDER: HealthStatus[] = [
  "indexed", "indexing", "waiting", "outdated", "partial", "stuck", "failed", "missing", "retired",
  "notPdf", "noFile", "heldBack", "notCurrent",
];
/** One color per status, the same in the bar and in the table (the table
 *  is the bar's key): indexed in the brand color, in flight a tint of it,
 *  fixable in the waiting or failed color, can't-be-indexed grey. */
const SWATCH: Record<HealthStatus, string> = {
  indexed: "var(--color-main)",
  indexing: "color-mix(in srgb, var(--color-main) 50%, transparent)",
  waiting: "color-mix(in srgb, var(--color-main) 28%, transparent)",
  outdated: "var(--state-held)", partial: "var(--state-held)", stuck: "var(--state-held)", retired: "var(--state-held)",
  failed: "var(--state-overdue)", missing: "var(--state-overdue)",
  notPdf: "var(--color-border-strong)", noFile: "var(--color-border-strong)", heldBack: "var(--color-border-strong)", notCurrent: "var(--color-border-strong)",
};
const EXPLAIN: Partial<Record<HealthStatus, string>> = {
  indexed: "Current revision, every page read.",
  indexing: "Being read now.",
  waiting: "Queued. Read automatically while the library is open, and in the background.",
  outdated: "A newer revision was published. Repair queues the new file.",
  partial: "Some pages weren't read. Repair resumes from the last page; pages read aren't paid for again.",
  stuck: "Started reading and stopped. Repair queues them again.",
  failed: "Reading failed. Repair retries; the reason is shown per file.",
  missing: "In the linked library but not in the index. Repair adds them.",
  retired: "Set aside when they left the library. The next sync restores them at no cost.",
  notPdf: "CAD, images, spreadsheets: they can't be read. Expected.",
  noFile: "No file on the current revision.",
  heldBack: "Held back from AI by a controller.",
  notCurrent: "Superseded, void or archived. The AI reads only documents in force.",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A timeout or gateway error: the platform or a busy database, not a fault. */
const isWeather = (e: unknown) => !!(e as { transient?: boolean })?.transient || /^HTTP 50[234]$/.test((e as Error)?.message ?? "");
const friendly = (e: unknown) => isWeather(e)
  ? "The database is busy (the meaning index is probably being written). Nothing was lost; try again in a few minutes."
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
  const [expandedPref, setExpanded] = useState<boolean | null>(null);
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
        ? "Repair ran out of time, which is common while the meaning index is being written. What it did is saved; press Repair again to finish."
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

  const actions = (canRepair: boolean) => (
    <div className="flex items-center gap-2">
      <button type="button" onClick={() => void check()} disabled={checking || repairing} className={btnQuiet}>
        <RefreshCw className={`w-4 h-4 ${checking ? "animate-spin" : ""}`} /> Check again
      </button>
      {isController && canRepair && (
        <button type="button" onClick={() => void repair()} disabled={repairing || checking} className={btnQuiet}>
          {repairing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wrench className="w-4 h-4" />}
          {repairing ? "Repairing…" : "Repair"}
        </button>
      )}
    </div>
  );

  if (!report) {
    return (
      <Section label="Library health" icon={HeartPulse} action={error ? actions(false) : undefined}>
        <div className={`${sheet} px-4 py-4 text-[14px]`}>
          {error
            ? <p role="alert" className="text-[var(--state-overdue)]"><span className="font-semibold">Couldn&apos;t check the library.</span> <span className="text-[var(--color-text-muted)]">{error}</span></p>
            : <p className="flex items-center gap-2 text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin" /> Checking that every linked document is accounted for…</p>}
        </div>
      </Section>
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
  const allGood = healthy && !report.incomplete;
  const expanded = expandedPref ?? !allGood;
  const verdict = allGood
    ? <StatusTag tone="good">{inFlight > 0 ? "Accounted for" : "Healthy"}</StatusTag>
    : fixable > 0 ? <StatusTag tone="warn">{fixable.toLocaleString()} to repair</StatusTag>
    : report.incomplete ? <StatusTag tone="warn">Numbers may be short</StatusTag>
    : <StatusTag tone="warn">Needs attention</StatusTag>;
  const statuses = L ? ORDER.filter((k) => L.counts[k] > 0 || k === "indexed") : [];

  return (
    <Section
      icon={HeartPulse}
      label={<span className="inline-flex items-center gap-2.5">Library health {verdict}</span>}
      action={actions(true)}
    >
      <div className={`${sheet} overflow-hidden`}>
        {/* The answer in four numbers. */}
        <Cells cells={[
          L
            ? { label: "Indexed", value: <>{L.counts.indexed.toLocaleString()}<span className="text-[var(--color-text-muted)] font-medium text-[18px]"> of {L.indexable.toLocaleString()}</span></> }
            : { label: "PDFs indexed", value: <>{report.uploaded.ready.toLocaleString()}<span className="text-[var(--color-text-muted)] font-medium text-[18px]"> of {report.uploaded.total.toLocaleString()}</span></> },
          ...(L ? [{ label: report.sources.length === 1 ? "In the linked source" : "In the linked sources", value: L.total.toLocaleString() }] : []),
          { label: "To repair", value: fixable.toLocaleString(), tone: fixable > 0 ? "warn" as const : undefined },
          { label: "Can't be indexed", value: notIndexable.toLocaleString(), hint: "Not PDFs, held back or superseded. Expected." },
        ]} />

        {/* The whole source as one bar: every document is in exactly one color. */}
        {L && L.total > 0 && (
          <div className="px-4 sm:px-5 pb-4">
            <Bar segments={ORDER.filter((k) => L.counts[k] > 0).map((k) => ({ key: k, value: L.counts[k], color: SWATCH[k], title: `${STATUS_LABEL[k]}: ${L.counts[k].toLocaleString()}` }))} total={L.total} />
            <p className="mt-1.5 text-[13px] text-[var(--color-text-muted)]">
              {allGood
                ? (inFlight > 0 ? `${inFlight.toLocaleString()} still being read. Everything is accounted for.` : "Every linked document is accounted for.")
                : fixable > 0 ? "Repair fixes them without paying again for work already done."
                : report.incomplete ? "Part of the check couldn't be read. Nothing is removed on an incomplete read."
                : report.names?.wrong ? "Every document is indexed; some names need correcting."
                : "Some uploaded PDFs need attention. Repair queues them again."}
            </p>
          </div>
        )}

        {(last || error || report.incomplete || report.skipped?.length > 0 || deadSources.length > 0 || (N && N.wrong > 0) || nameResult) && (
          <div className="border-t border-[var(--color-border)] px-4 sm:px-5 py-3 space-y-2.5">
            {last && (
              <Note tone="good" title="Repair done.">
                {[
                  last.sync ? `Added ${last.sync.added}, refreshed ${last.sync.refreshed}${last.sync.renamed ? `, renamed ${last.sync.renamed}` : ""}, restored ${last.sync.restored} at no cost, set aside ${last.sync.retired}.` : "",
                  `Queued again: ${last.requeued.failed} failed, ${last.requeued.stuck} stuck, ${last.requeued.partial} partly read.`,
                ].filter(Boolean).join(" ")}
                {last.sync && last.sync.removed > 0 && <span className="block text-[var(--state-held)]">{last.sync.removed} were deleted instead of set aside: the database update (20261024) hasn&apos;t been run.</span>}
                {last.sync?.errors.length ? <span className="block text-[var(--state-held)]">{last.sync.errors.slice(0, 3).join("; ")}</span> : null}
              </Note>
            )}
            {error && <Note tone="bad" title="Something went wrong.">{error}</Note>}
            {report.incomplete && (
              <Note tone="warn" title="Some numbers may be short.">{report.errors.slice(0, 2).join("; ") || "Part of the check couldn't be read."}</Note>
            )}
            {report.skipped?.length > 0 && (
              <Note tone="none" title="Left out to answer quickly:">{report.skipped.join(", ")}. The database is slow; check again in a few minutes.</Note>
            )}
            {deadSources.length > 0 && (
              <Note tone="bad" title={deadSources.length === 1 ? "A linked source no longer exists:" : `${deadSources.length} linked sources no longer exist:`}>
                {deadSources.map((s) => s.name).join(", ")}. Unlink {deadSources.length === 1 ? "it" : "them"} under Documents.
              </Note>
            )}
            {N && N.wrong > 0 && (
              <Note
                tone="warn"
                title={nameKinds && nameKinds.reader === 0
                  ? `${N.wrong.toLocaleString()} drawing ${N.wrong === 1 ? "number carries" : "numbers carry"} a count an upload added`
                  : `${N.wrong.toLocaleString()} document ${N.wrong === 1 ? "number or revision was" : "numbers or revisions were"} read wrong from the file name`}
                action={isController && nameFixable > 0 ? (
                  <button type="button" onClick={() => void fixNames()} disabled={!!naming || repairing} className={btnRow}>
                    {naming ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wrench className="w-3.5 h-3.5" />}
                    {naming ? `Correcting… ${naming.fixed.toLocaleString()}` : `Correct ${nameFixable.toLocaleString()}`}
                  </button>
                ) : undefined}
              >
                {nameKinds && nameKinds.reader === 0
                  ? <>Like &ldquo;{nameKinds.example ?? "5602-D 1000-7"}&rdquo;. The sheet stays in its own field; Correct takes the count off.</>
                  : <>Like &ldquo;EP 5-3-10&rdquo; cut to &ldquo;EP&rdquo;. Files, titles and the index are fine.{nameKinds && nameKinds.suffix > 0 && ` ${nameKinds.suffix.toLocaleString()} carry a count an upload added.`}</>}
                {N.clashes > 0 && <span className="block">{N.clashes.toLocaleString()} can&apos;t be corrected automatically: the right number is already used. They&apos;re marked in the list.</span>}
                <button type="button" onClick={() => setNamesOpen((v) => !v)} aria-expanded={namesOpen} className={`${link} mt-0.5 inline-flex items-center gap-0.5`}>
                  {namesOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />} {namesOpen ? "Hide" : "Show"} the list
                </button>
              </Note>
            )}
            {N && namesOpen && (
              <div className={`${tbl.wrap} max-h-72 overflow-auto`}>
                <table className="w-full text-[14px]">
                  <thead className={`${tbl.thead} sticky top-0`}>
                    <tr><th className={tbl.th}>File</th><th className={tbl.th}>Now</th><th className={tbl.th}>Corrected to</th></tr>
                  </thead>
                  <tbody className={tbl.tbody}>
                    {N.samples.map((f) => (
                      <tr key={f.id}>
                        <td className="px-4 py-2 max-w-0 w-1/2">
                          <div className="truncate" title={f.fileName}>{f.fileName}</div>
                          {f.clash && <div className="text-[13px] text-[var(--state-held)]">Needs you: {f.clash}</div>}
                        </td>
                        <td className="px-4 py-2 font-display tabular-nums text-[var(--color-text-muted)] whitespace-nowrap"><s>{f.from.documentNumber || "-"}{f.from.rev !== f.to.rev ? ` rev ${f.from.rev}` : ""}</s></td>
                        <td className="px-4 py-2 font-display tabular-nums font-semibold whitespace-nowrap">
                          {f.to.documentNumber}{f.from.rev !== f.to.rev ? ` rev ${f.to.rev}` : ""}
                          {f.kind === "sheet-suffix" && f.sheet ? <span className="font-sans font-normal text-[13px] text-[var(--color-text-muted)]">, sheet {String(f.sheet).replace(/^0+(?=\d)/, "")}</span> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {N.wrong > N.samples.length && <p className={tbl.foot}>Showing {N.samples.length} of {N.wrong.toLocaleString()}.</p>}
              </div>
            )}
            {nameResult && (
              <Note tone={nameResult.failed.length ? "bad" : nameResult.conflicts.length ? "warn" : "good"} title={`Corrected ${nameResult.fixed.toLocaleString()} ${nameResult.fixed === 1 ? "name" : "names"}.`}>
                {[
                  nameResult.skipped > 0 ? `${nameResult.skipped} left alone: someone changed them since the check.` : "",
                  nameResult.remaining > 0 ? `${nameResult.remaining} not reached yet; press Correct again.` : "",
                  nameResult.failed.length > 0 ? `${nameResult.failed.length} couldn't be saved (${nameResult.failed[0].reason}); Correct again retries them.` : "",
                ].filter(Boolean).join(" ") || "The index now cites them by their real numbers."}
                {nameResult.conflicts.length > 0 && (
                  <>
                    <span className="block mt-1 font-semibold">{nameResult.conflicts.length} need your decision: the right number is already in use.</span>
                    <ul className="mt-0.5 max-h-32 overflow-auto">
                      {nameResult.conflicts.slice(0, 100).map((c) => <li key={c.id} className="truncate">{c.fileName}: wants {c.wanted}{c.clashesWith ? `, used by ${c.clashesWith}` : ""}</li>)}
                    </ul>
                  </>
                )}
              </Note>
            )}
          </div>
        )}

        <div className="border-t border-[var(--color-border)] px-4 sm:px-5 h-11 flex items-center gap-3 text-[13px] text-[var(--color-text-muted)]">
          <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} className={`${link} inline-flex items-center gap-1 text-[14px]`}>
            {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />} {expanded ? "Hide the details" : "Every status, in detail"}
          </button>
          <span className="flex-1" />
          <span className="tabular-nums">Checked {new Date(report.checkedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</span>
        </div>

        {expanded && (
          <div className="border-t border-[var(--color-border)]">
            {L && (
              <table className="w-full text-[14px]">
                <thead className={tbl.thead}>
                  <tr>
                    <th className={tbl.th}>Status</th>
                    <th className={`${tbl.th} text-right`}>Documents</th>
                    <th className={`${tbl.th} max-md:hidden`}>What it means</th>
                  </tr>
                </thead>
                <tbody className={tbl.tbody}>
                  {statuses.map((k) => {
                    const n = L.counts[k];
                    const items = L.samples[k] ?? [];
                    const isOpen = open === k;
                    return (
                      <React.Fragment key={k}>
                        <tr className={items.length ? `${tbl.tr} cursor-pointer` : ""} onClick={items.length ? () => setOpen(isOpen ? null : k) : undefined}>
                          <td className="px-4 py-2.5">
                            <span className="inline-flex items-center gap-2.5">
                              <span aria-hidden className="w-3 h-3 rounded-sm shrink-0" style={{ background: SWATCH[k] }} />
                              {items.length > 0 ? (
                                <button type="button" aria-expanded={isOpen} onClick={(e) => { e.stopPropagation(); setOpen(isOpen ? null : k); }} className="inline-flex items-center gap-1 font-semibold text-[var(--color-text)] hover:text-[var(--color-accent-text)]">
                                  {STATUS_LABEL[k]} {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                                </button>
                              ) : <span className="font-semibold text-[var(--color-text)]">{STATUS_LABEL[k]}</span>}
                            </span>
                          </td>
                          <td className={`px-4 py-2.5 text-right font-display text-[16px] font-semibold tabular-nums ${FIXABLE.has(k) && n > 0 ? (k === "failed" || k === "missing" ? "text-[var(--state-overdue)]" : "text-[var(--state-held)]") : "text-[var(--color-text)]"}`}>{n.toLocaleString()}</td>
                          <td className="px-4 py-2.5 max-md:hidden text-[var(--color-text-muted)]">{EXPLAIN[k]}</td>
                        </tr>
                        {isOpen && (
                          <tr>
                            <td colSpan={3} className="px-4 pb-3 pt-0">
                              <p className="md:hidden mb-1.5 text-[13px] text-[var(--color-text-muted)]">{EXPLAIN[k]}</p>
                              <ul className="max-h-56 overflow-auto rounded-md border border-[var(--color-border)] divide-y divide-[var(--color-border)] bg-[var(--color-surface)]">
                                {items.map((it) => (
                                  <li key={it.id} className="px-3 py-1.5 flex items-center gap-3 text-[14px]">
                                    <span className="font-display tabular-nums truncate flex-1 text-[var(--color-text)]">{it.name}</span>
                                    {it.detail && <span className="shrink-0 max-w-[50%] truncate text-[13px] text-[var(--color-text-muted)]" title={it.detail}>{it.detail}</span>}
                                  </li>
                                ))}
                              </ul>
                              {n > items.length && <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">Showing {items.length} of {n.toLocaleString()}.</p>}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                  {L.leftovers.length > 0 && (
                    <>
                      <tr className={`${tbl.tr} cursor-pointer`} onClick={() => setOpen(open === "leftovers" ? null : "leftovers")}>
                        <td className="px-4 py-2.5">
                          <span className="inline-flex items-center gap-2.5">
                            <span aria-hidden className="w-3 h-3 rounded-sm shrink-0 bg-[var(--state-held)]" />
                            <button type="button" aria-expanded={open === "leftovers"} onClick={(e) => { e.stopPropagation(); setOpen(open === "leftovers" ? null : "leftovers"); }} className="inline-flex items-center gap-1 font-semibold text-[var(--color-text)] hover:text-[var(--color-accent-text)]">
                              Left behind {open === "leftovers" ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                            </button>
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right font-display text-[16px] font-semibold tabular-nums text-[var(--state-held)]">{L.leftovers.length.toLocaleString()}</td>
                        <td className="px-4 py-2.5 max-md:hidden text-[var(--color-text-muted)]">Their document moved out, was held back or deleted. Repair sets them aside; they come back at no cost.</td>
                      </tr>
                      {open === "leftovers" && (
                        <tr>
                          <td colSpan={3} className="px-4 pb-3 pt-0">
                            <ul className="max-h-56 overflow-auto rounded-md border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
                              {L.leftovers.slice(0, 100).map((it) => <li key={it.mirrorId ?? it.id} className="px-3 py-1.5 text-[14px] font-display tabular-nums truncate">{it.name}</li>)}
                            </ul>
                          </td>
                        </tr>
                      )}
                    </>
                  )}
                </tbody>
              </table>
            )}

            <div className={L ? "border-t border-[var(--color-border)]" : ""}>
              <Cells size="sm" cells={[
                {
                  label: "Meaning index",
                  value: report.meaning && meaningPct !== null ? `${meaningPct}%` : "-",
                  hint: report.meaning ? `${report.meaning.embedded.toLocaleString()} of ${report.meaning.chunks.toLocaleString()} passages` : "Being built; the count shows on the next check.",
                  bar: report.meaning && meaningPct !== null ? meaningPct : undefined,
                },
                {
                  label: "Uploaded PDFs",
                  value: `${report.uploaded.ready.toLocaleString()} of ${report.uploaded.total.toLocaleString()}`,
                  hint: [report.uploaded.waiting ? `${report.uploaded.waiting} waiting` : "", report.uploaded.failed ? `${report.uploaded.failed} failed` : "", report.uploaded.partial ? `${report.uploaded.partial} partly read` : ""].filter(Boolean).join(", ") || "All indexed",
                  tone: report.uploaded.failed ? "bad" : undefined,
                },
                { label: "Set aside", value: report.retired.toLocaleString(), hint: "Kept to restore at no cost; not searched" },
              ]} />
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}
