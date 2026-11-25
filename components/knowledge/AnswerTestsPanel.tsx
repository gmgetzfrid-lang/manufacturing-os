"use client";

// AnswerTestsPanel — proof the answers are getting better, for this library.
//
// Each test is a real question an engineer marked with what a right answer
// must do. "Run tests" asks them all again on your key and scores every
// answer with fixed checks; a failure says what went wrong and where the
// right page dropped out. One run can be kept as the baseline: any critical
// test that passed there and fails now is flagged as a regression.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { friendlyError } from "@/lib/friendlyError";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Play, Square, Plus, Loader2, ChevronRight, CheckCircle2, XCircle, AlertTriangle, Pencil, Trash2, Flag } from "lucide-react";
import {
  loadAnswerTests, runAnswerTests, saveAnswerTest, archiveAnswerTest, setAnswerTestBaseline,
  type AnswerTestsState, type AnswerTestRun, type AnswerTestCase,
} from "@/lib/knowledge";
import AnswerTestEditor, { type AnswerTestDraft } from "@/components/knowledge/AnswerTestEditor";
import { FieldError } from "@/components/ui/Field";
import MoreMenu from "@/components/ui/MoreMenu";
import { btnIcon } from "@/components/admin/kit";

const CHECK_LABEL: Record<string, string> = {
  class_mixup: "Mixed up the pressure class",
  unproven_link: "Treated two terms as the same without proof",
  asks_for_held: "Asked for a document the library holds",
  missed_page: "Didn't cite the right page",
  missing_fact: "Left out a required fact",
  forbidden: "Said something it must not",
  unverified_quote: "Quoted evidence that isn't on the page",
  no_citations: "Cited nothing",
};

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default function AnswerTestsPanel({ orgId, libraryId }: { orgId: string; libraryId: string }) {
  const [state, setState] = useState<AnswerTestsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<AnswerTestDraft | null>(null);
  const [running, setRunning] = useState<{ done: number; total: number; run: AnswerTestRun } | null>(null);
  const [cap, setCap] = useState("5");
  const [expanded, setExpanded] = useState<string | null>(null);
  const stopper = useRef({ stopped: false });

  const load = useCallback(async (runId?: string) => {
    try { setState(await loadAnswerTests(orgId, libraryId, runId)); setError(null); }
    catch (e) { setError(friendlyError(e)); }
  }, [orgId, libraryId]);
  useEffect(() => { void load(); }, [load]);

  const run = useCallback(async (caseIds?: string[]) => {
    stopper.current = { stopped: false };
    setError(null);
    try {
      const final = await runAnswerTests(orgId, libraryId, {
        caseIds, costCapUsd: Number(cap) || 5, signal: stopper.current,
        onProgress: (p) => setRunning({ done: p.done, total: p.total, run: p.run }),
      });
      await load(final.id);
    } catch (e) { setError(friendlyError(e)); }
    finally { setRunning(null); }
  }, [orgId, libraryId, cap, load]);

  const results = useMemo(() => new Map((state?.results ?? []).map((r) => [r.case_id, r])), [state]);
  const baseline = useMemo(() => new Map((state?.baseline?.results ?? []).map((r) => [r.case_id, r.pass])), [state]);
  const shownRun = state?.runs.find((r) => r.id === state.runId) ?? null;
  const cases = state?.cases.filter((c) => c.status !== "archived") ?? [];
  const regressions = cases.filter((c) => c.tags.includes("critical") && baseline.get(c.id) === true && results.get(c.id)?.pass === false);

  if (error && !state) {
    return (
      <ErrorNote className="mb-6" title="Couldn't load the answer tests." next={error} onRetry={() => void load()} />
    );
  }
  if (!state) {
    return <div className="mb-6"><SkeletonRows rows={2} cols={1} what="answer tests" /></div>;
  }

  const save = async (d: AnswerTestDraft) => {
    await saveAnswerTest(orgId, libraryId, { id: d.id, question: d.question, expect: d.expect, tags: d.tags, notes: d.notes, sourceQuestionId: d.sourceQuestionId });
    setEditing(null);
    await load(state.runId ?? undefined);
  };
  const toDraft = (c: AnswerTestCase): AnswerTestDraft => ({ id: c.id, question: c.question, expect: c.expect, tags: c.tags, notes: c.notes ?? undefined, sourceQuestionId: c.source_question_id });

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5">
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex-1 min-w-0 text-left">
          <div className="font-display text-section font-semibold text-[var(--color-heading)] flex items-center gap-2">
            
            Answer tests {cases.length > 0 && <span className="ui-count font-sans">{cases.length}</span>} <ChevronRight className={`w-3.5 h-3.5 ui-chevron${(open) ? " rotate-90" : ""}`} />
          </div>
          <div className="text-body text-[var(--color-text-muted)]">
            {cases.length === 0
              ? "No tests yet. Under any answer, “Make this a test case” marks what a right answer must do."
              : shownRun
                ? <>{cases.length} test{cases.length === 1 ? "" : "s"} · last run {when(shownRun.created_at)}: <span className={`font-medium ${shownRun.failed ? "text-[var(--state-overdue-text)]" : "text-[var(--color-text)]"}`}>{shownRun.passed} of {shownRun.total} passed</span>{shownRun.status === "stopped" ? ` · stopped - ${shownRun.stop_reason ?? ""}` : ""} · ${Number(shownRun.cost_usd).toFixed(2)}</>
                : <>{cases.length} test{cases.length === 1 ? "" : "s"} · never run</>}
          </div>
        </button>
        {running ? (
          <button onClick={() => { stopper.current.stopped = true; }} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-body font-medium">
            <Square className="w-3.5 h-3.5" /> Stop
          </button>
        ) : cases.length > 0 && (
          <div className="flex items-center gap-1.5">
            <label className="text-body text-[var(--color-text-muted)] flex items-center gap-1" title="The run stops when it has spent this much on your key">
              up to $<input value={cap} onChange={(e) => setCap(e.target.value.replace(/[^0-9.]/g, ""))} className="w-10 pointer-coarse:w-16 pointer-coarse:min-h-11 pointer-coarse:text-reading rounded border border-[var(--color-border)] bg-transparent px-1 py-0.5 text-body" />
            </label>
            <button onClick={() => void run()} className="inline-flex items-center gap-1.5 pointer-coarse:min-h-11 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-1.5 text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
              <Play className="w-3.5 h-3.5" /> Run tests
            </button>
          </div>
        )}
      </div>

      {running && (
        <div className="mt-3">
          <div className="h-1.5 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
            <div className="h-full bg-[var(--color-text-muted)] transition-all" style={{ width: `${running.total ? (running.done / running.total) * 100 : 0}%` }} />
          </div>
          <div className="mt-1 text-body text-[var(--color-text-muted)]">
            <Loader2 className="w-3 h-3 animate-spin inline mr-1" />
            Asking test {Math.min(running.done + 1, running.total)} of {running.total} (each is a full question, about a minute) · {running.run.passed} passed, {running.run.failed} failed so far · ${Number(running.run.cost_usd).toFixed(2)} of ${Number(running.run.cost_cap_usd).toFixed(2)}
          </div>
        </div>
      )}

      {regressions.length > 0 && (
        <div role="alert" className="mt-3 border-l-2 border-[var(--state-overdue)] pl-3 text-body text-[var(--state-overdue)] flex gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span><b>Regression:</b> {regressions.length} critical test{regressions.length === 1 ? "" : "s"} passed on the baseline run and fail{regressions.length === 1 ? "s" : ""} now. Don&apos;t promote this version until they pass.</span>
        </div>
      )}
      {error && <div className="mt-2"><FieldError>{error}</FieldError></div>}

      {open && (
        <div className="mt-4 space-y-3">
          {editing ? (
            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <AnswerTestEditor initial={editing} onSave={save} onCancel={() => setEditing(null)} />
            </div>
          ) : (
            <button onClick={() => setEditing({ question: "", expect: {}, tags: [] })} className="inline-flex items-center gap-1 text-body font-medium text-[var(--color-accent-text)] hover:underline">
              <Plus className="w-3.5 h-3.5" /> Add a test
            </button>
          )}

          {state.runs.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap text-body text-[var(--color-text-muted)]">
              <span>Showing run</span>
              <select aria-label="Showing run" value={state.runId ?? ""} onChange={(e) => void load(e.target.value)} className="pointer-coarse:min-h-11 pointer-coarse:text-reading rounded border border-[var(--color-border)] bg-transparent px-1.5 py-0.5">
                {state.runs.map((r) => (
                  <option key={r.id} value={r.id}>{when(r.created_at)} - {r.passed}/{r.total}{r.is_baseline ? " (baseline)" : ""} · version {r.engine_version ?? "?"}</option>
                ))}
              </select>
              {shownRun && !shownRun.is_baseline && shownRun.status !== "running" && (
                <button onClick={() => void setAnswerTestBaseline(orgId, shownRun.id).then(() => load(shownRun.id), (e: unknown) => setError(`Not kept as the baseline: ${friendlyError(e)}`))} className="inline-flex items-center gap-1 font-medium text-[var(--color-accent-text)] hover:underline">
                  <Flag className="w-3 h-3" /> Keep as baseline
                </button>
              )}
              {state.baseline && <span>· compared with the baseline run</span>}
            </div>
          )}

          <ul className="divide-y divide-[var(--color-border)]">
            {cases.map((c) => {
              const r = results.get(c.id);
              const before = baseline.get(c.id);
              const failing = (r?.checks ?? []).filter((k) => !k.pass);
              const isOpen = expanded === c.id;
              return (
                <li key={c.id} className="py-2">
                  <div className="flex items-start gap-2">
                    {r ? (r.pass ? <CheckCircle2 className="w-4 h-4 text-[var(--state-released)] shrink-0 mt-0.5" /> : <XCircle className="w-4 h-4 text-[var(--state-overdue)] shrink-0 mt-0.5" />)
                      : <span className="w-4 h-4 rounded-full border border-[var(--color-border)] shrink-0 mt-0.5" />}
                    <button onClick={() => setExpanded(isOpen ? null : c.id)} className="flex-1 min-w-0 text-left">
                      <div className="text-body text-[var(--color-text)]">
                        {c.question}
                        {c.tags.includes("critical") && <span className="ml-1.5 text-body font-medium text-[var(--color-text-muted)]">critical</span>}
                        {before === true && r?.pass === false && <span className="ml-1.5 text-body font-medium text-[var(--state-overdue)]">was passing</span>}
                        {before === false && r?.pass === true && <span className="ml-1.5 text-body font-medium text-[var(--color-text-muted)]">now passing</span>}
                      </div>
                      {r?.error && <div className="text-body text-[var(--state-overdue)]">Couldn&apos;t run: {r.error}</div>}
                      {!r?.error && failing.length > 0 && (
                        <div className="text-body text-[var(--state-overdue)]">{[...new Set(failing.map((k) => CHECK_LABEL[k.code] ?? k.code))].join(" · ")}</div>
                      )}
                    </button>
                    {/* Three actions on every row: one menu (A3, B6). */}
                    <MoreMenu iconOnly label={`More for this test`} triggerClass={`${btnIcon} shrink-0`} items={[
                      ...(!running ? [{ icon: <Play className="w-4 h-4" />, label: "Run this test", onClick: () => { void run([c.id]); } }] : []),
                      { icon: <Pencil className="w-4 h-4" />, label: "Edit test", onClick: () => setEditing(toDraft(c)) },
                      { icon: <Trash2 className="w-4 h-4" />, label: "Remove test", tone: "bad" as const, line: true, onClick: () => { void archiveAnswerTest(orgId, c.id).then(() => load(state.runId ?? undefined), (e: unknown) => setError(`The test wasn't removed: ${friendlyError(e)}`)); } },
                    ]} />
                  </div>
                  {isOpen && r && (
                    <div className="mt-2 ml-6 space-y-2">
                      <ul className="space-y-0.5">
                        {r.checks.map((k, i) => (
                          <li key={i} className={`text-body ${k.pass ? "text-[var(--color-text-muted)]" : "text-[var(--state-overdue)] font-medium"}`}>
                            {k.pass ? "✓" : "✗"} {CHECK_LABEL[k.code] ?? k.code}: <span className="font-normal">{k.detail}</span>
                          </li>
                        ))}
                      </ul>
                      {r.answer && (
                        <details className="text-body">
                          <summary className="cursor-pointer text-[var(--color-text-muted)]">The answer it gave</summary>
                          <pre className="mt-1 whitespace-pre-wrap rounded-lg bg-[var(--color-surface-2)] p-2 text-body text-[var(--color-text)]">{r.answer}</pre>
                        </details>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
