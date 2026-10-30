"use client";

// AnswerTestEditor — mark what a right answer to a question must do.
//
// Written for the engineer who knows the answer, not for a tester: tick the
// pages a right answer cites (or add one it missed), list the facts it must
// state, and say what it must never do. Opened from under an answer (the
// question and its citations come pre-filled) or from the library's Answer
// tests panel.

import React, { useMemo, useState } from "react";
import { Plus, X, Loader2, FlaskConical } from "lucide-react";
import { pressureClassOf } from "@/lib/pressureClass";
import type { AnswerTestExpect } from "@/lib/knowledge";

export interface EditorCitation { documentName: string; page: number }

export interface AnswerTestDraft {
  id?: string;
  question: string;
  expect: AnswerTestExpect;
  tags: string[];
  notes?: string;
  sourceQuestionId?: string | null;
}

const field = "w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-indigo-400";
const label = "text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]";

/** Strip a document name down to what people call it ("EP 5-2-3"). */
const shortName = (name: string) => name.replace(/\.pdf$/i, "").split(/\s+[-–—]\s+/)[0].trim();

export default function AnswerTestEditor({ initial, citations = [], onSave, onCancel }: {
  initial: AnswerTestDraft;
  /** The answer's citations, offered as tick-boxes. */
  citations?: EditorCitation[];
  onSave: (draft: AnswerTestDraft) => Promise<void>;
  onCancel: () => void;
}) {
  const [question, setQuestion] = useState(initial.question);
  const [pages, setPages] = useState<Array<{ document: string; page: string }>>(
    (initial.expect.mustCite ?? []).map((c) => ({ document: c.document, page: String(c.page) })));
  const [contain, setContain] = useState((initial.expect.mustContain ?? []).join("\n"));
  const [mustNot, setMustNot] = useState((initial.expect.mustNot ?? []).join("\n"));
  const [terms, setTerms] = useState<Array<{ term: string; not: string }>>(
    (initial.expect.termRules ?? []).map((r) => ({ term: r.term, not: r.mustNotEquate.join(", ") })));
  const [critical, setCritical] = useState(initial.tags.includes("critical"));
  const [notes, setNotes] = useState(initial.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const offered = useMemo(() => {
    const seen = new Set<string>();
    return citations.filter((c) => {
      const k = `${shortName(c.documentName)}|${c.page}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [citations]);
  const ticked = (c: EditorCitation) => pages.some((p) => p.document === shortName(c.documentName) && p.page === String(c.page));
  const toggle = (c: EditorCitation) => setPages((ps) => ticked(c)
    ? ps.filter((p) => !(p.document === shortName(c.documentName) && p.page === String(c.page)))
    : [...ps, { document: shortName(c.documentName), page: String(c.page) }]);

  const rating = pressureClassOf(question);
  const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

  const save = async () => {
    if (!question.trim()) { setError("Write the question."); return; }
    const mustCite = pages.filter((p) => p.document.trim() && Number(p.page) >= 1)
      .map((p) => ({ document: p.document.trim(), page: Math.round(Number(p.page)) }));
    const expect: AnswerTestExpect = {
      ...(mustCite.length ? { mustCite } : {}),
      ...(lines(contain).length ? { mustContain: lines(contain) } : {}),
      ...(lines(mustNot).length ? { mustNot: lines(mustNot) } : {}),
      ...(terms.some((t) => t.term.trim() && t.not.trim()) ? {
        termRules: terms.filter((t) => t.term.trim() && t.not.trim())
          .map((t) => ({ term: t.term.trim(), mustNotEquate: t.not.split(",").map((x) => x.trim()).filter(Boolean) })),
      } : {}),
    };
    if (!expect.mustCite && !expect.mustContain && !expect.mustNot && !expect.termRules) {
      setError("Mark at least one thing a right answer must do - a page, a fact, or something it must not say.");
      return;
    }
    setSaving(true); setError(null);
    try {
      const tags = initial.tags.filter((t) => t !== "critical").concat(critical ? ["critical"] : []);
      await onSave({ id: initial.id, question: question.trim(), expect, tags, notes: notes.trim() || undefined, sourceQuestionId: initial.sourceQuestionId });
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center gap-2 text-[var(--color-text)]">
        <FlaskConical className="w-4 h-4 text-indigo-600" />
        <b>{initial.id ? "Edit test case" : "Make this a test case"}</b>
      </div>
      <p className="text-[11px] text-[var(--color-text-muted)]">
        Every run asks this question again and checks the answer against what you mark here. A change that breaks it shows up before it reaches anyone.
      </p>

      <div className="space-y-1">
        <div className={label}>Question</div>
        <textarea value={question} onChange={(e) => setQuestion(e.target.value)} rows={2} className={field} />
        {rating && <div className="text-[10px] text-[var(--color-text-muted)]">Checked automatically: the answer must stay on <b>Class {rating}</b>.</div>}
      </div>

      <div className="space-y-1">
        <div className={label}>Pages a right answer cites</div>
        {offered.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {offered.map((c) => (
              <button key={`${c.documentName}|${c.page}`} type="button" onClick={() => toggle(c)}
                className={`rounded-md border px-2 py-0.5 text-[11px] ${ticked(c) ? "border-emerald-500 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200" : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
                {ticked(c) ? "✓ " : ""}{shortName(c.documentName)} p.{c.page}
              </button>
            ))}
          </div>
        )}
        {pages.filter((p) => !offered.some((c) => shortName(c.documentName) === p.document && String(c.page) === p.page)).map((p) => {
          const i = pages.indexOf(p);
          return (
            <div key={i} className="flex gap-1.5">
              <input value={p.document} placeholder="Document number or name" onChange={(e) => setPages((ps) => ps.map((x, j) => j === i ? { ...x, document: e.target.value } : x))} className={field} />
              <input value={p.page} placeholder="Page" inputMode="numeric" onChange={(e) => setPages((ps) => ps.map((x, j) => j === i ? { ...x, page: e.target.value } : x))} className={`${field} w-20`} />
              <button type="button" aria-label="Remove page" onClick={() => setPages((ps) => ps.filter((_, j) => j !== i))} className="px-1 text-[var(--color-text-muted)] hover:text-rose-600"><X className="w-3.5 h-3.5" /></button>
            </div>
          );
        })}
        <button type="button" onClick={() => setPages((ps) => [...ps, { document: "", page: "" }])} className="inline-flex items-center gap-1 text-[11px] font-bold text-indigo-600 hover:underline">
          <Plus className="w-3 h-3" /> A page the answer missed
        </button>
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <div className={label}>Facts it must state (one per line)</div>
          <textarea value={contain} onChange={(e) => setContain(e.target.value)} rows={3} className={field}
            placeholder={"the class code a right answer names\nfree water | water present"} />
          <div className="text-[10px] text-[var(--color-text-faint)]">Use “ | ” for either wording.</div>
        </div>
        <div className="space-y-1">
          <div className={label}>It must never say (one per line)</div>
          <textarea value={mustNot} onChange={(e) => setMustNot(e.target.value)} rows={3} className={field}
            placeholder={"Class 1500"} />
        </div>
      </div>

      <div className="space-y-1">
        <div className={label}>Terms it must not treat as the same without a passage that does</div>
        {terms.map((t, i) => (
          <div key={i} className="flex gap-1.5 items-center">
            <input value={t.term} placeholder="sour gas" onChange={(e) => setTerms((ts) => ts.map((x, j) => j === i ? { ...x, term: e.target.value } : x))} className={field} />
            <span className="text-[var(--color-text-muted)] shrink-0">≠</span>
            <input value={t.not} placeholder="wet H2S, NACE service" onChange={(e) => setTerms((ts) => ts.map((x, j) => j === i ? { ...x, not: e.target.value } : x))} className={field} />
            <button type="button" aria-label="Remove rule" onClick={() => setTerms((ts) => ts.filter((_, j) => j !== i))} className="px-1 text-[var(--color-text-muted)] hover:text-rose-600"><X className="w-3.5 h-3.5" /></button>
          </div>
        ))}
        <button type="button" onClick={() => setTerms((ts) => [...ts, { term: "", not: "" }])} className="inline-flex items-center gap-1 text-[11px] font-bold text-indigo-600 hover:underline">
          <Plus className="w-3 h-3" /> A term rule
        </button>
        <div className="text-[10px] text-[var(--color-text-faint)]">Common related terms are checked on every test already; add one when your standards draw a line the system can&apos;t know.</div>
      </div>

      <div className="space-y-1">
        <div className={label}>Note (optional)</div>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} className={field} placeholder="Why this answer is right, for whoever reads a failure" />
      </div>

      <label className="flex items-center gap-2 text-[11px] text-[var(--color-text)]">
        <input type="checkbox" checked={critical} onChange={(e) => setCritical(e.target.checked)} />
        Critical - a version that fails this is flagged as a regression
      </label>

      {error && <div className="text-[11px] font-bold text-rose-600">{error}</div>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-lg px-3 py-1.5 text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Cancel</button>
        <button type="button" onClick={() => void save()} disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-indigo-700 disabled:opacity-60">
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save test case
        </button>
      </div>
    </div>
  );
}
