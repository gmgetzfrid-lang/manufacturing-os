"use client";

// Ask Knowledge — ask a library a quick question right on the dashboard.
//
// The same engine and the same rules as the Assistant (documents only,
// cited to the page), shaped for a card: the verdict and the direct answer
// first, the passages that prove it as tappable quotes (each opens the page
// with the words highlighted), "to settle this" when the library can't, and
// a door into the full conversation. The question is saved as a real
// conversation, so "Continue in Assistant" picks up exactly here.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import {
  Sparkles, ArrowRight, Loader2, MessageSquare, FileText, CornerDownRight, RotateCcw, AlertTriangle,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { askTurn, listThreads, type ChatThread } from "@/lib/chatClient";
import { listKnowledgeLibraries, type KnowledgeAnswer, type KnowledgeCitation, type KnowledgeLibrary } from "@/lib/knowledge";
import { SourcesMenu, AnswerMenu, SkillHint, useAnswerSkills } from "@/components/chat/AskControls";
import {
  parseAnswerBlocks, structureAnswer, splitVerdict, extractAnswerMeta, quoteWindow, docDesignation, clauseFor,
  type Verdict,
} from "@/lib/knowledgeText";
import { useWidget, useSetting, useSessionState, useWidgetData, Empty, timeAgo, SCROLL } from "../kit";

const CitedPageViewer = dynamic(() => import("@/components/knowledge/CitedPageViewer"), { ssr: false });

type Mode = "auto" | "answer" | "compliance" | "explore" | "deviation";

const VERDICT: Record<Verdict, { label: string; cls: string }> = {
  yes: { label: "Yes", cls: "bg-emerald-600 text-white" },
  conditional: { label: "Yes, with conditions", cls: "bg-amber-500 text-white" },
  no: { label: "No", cls: "bg-rose-600 text-white" },
  unsettled: { label: "Not settled", cls: "bg-slate-600 text-white" },
  complies: { label: "Complies", cls: "bg-emerald-600 text-white" },
  fails: { label: "Does not comply", cls: "bg-rose-600 text-white" },
  undetermined: { label: "Can't determine", cls: "bg-slate-600 text-white" },
};

interface Turn {
  question: string;
  answer: KnowledgeAnswer | null;
  error: string | null;
}

interface ViewerTarget {
  fileKey: string; page: number; quote: string | null; title: string; section: string | null; documentId: string;
  sources: Array<{ fileKey: string; page: number; quote: string | null; title: string; section?: string | null; documentId?: string; n?: number }>;
  index: number;
}

/** With the verdict lifted into its badge, the rest starts mid-sentence. */
const capFirst = (t: string) => t.replace(/^(\W*)([a-z])/, (_m, p: string, c: string) => p + c.toUpperCase());

/** "**bold**" and "[3]" → bold text and tappable citation chips. */
function Inline({ text, onCite }: { text: string; onCite: (n: number) => void }) {
  const parts = text.split(/(\[\d{1,3}(?:\s*,\s*\d{1,3})*\]|\*\*[^*]+\*\*)/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) => {
        const cite = p.match(/^\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]$/);
        if (cite) {
          return cite[1].split(/\s*,\s*/).map((n) => (
            <button key={`${i}-${n}`} type="button" onClick={() => onCite(Number(n))}
              className="align-super mx-px px-1 rounded bg-[var(--color-accent-soft)] text-[var(--color-accent)] text-[9px] font-black hover:bg-[var(--color-accent)] hover:text-white transition-colors">
              {n}
            </button>
          ));
        }
        if (p.startsWith("**") && p.endsWith("**")) return <b key={i} className="font-black text-[var(--color-text)]">{p.slice(2, -2)}</b>;
        return <React.Fragment key={i}>{p.replace(/\s*\[image \d+\]/gi, "")}</React.Fragment>;
      })}
    </>
  );
}

export default function AskKnowledgeBody() {
  const { activeOrgId, uid } = useRole();
  const { expanded } = useWidget();
  const [libraryId, setLibraryId] = useSetting<string>("libraryId", "");
  const [mode, setMode] = useSetting<Mode>("mode", "auto");
  // The same choices as the chat's prompt bar: skills and web.
  const skills = useAnswerSkills(activeOrgId ?? null);
  const [picked, setPicked] = useSetting<string[] | null>("skills", null);
  const [web, setWeb] = useSetting<boolean>("web", false);

  const { data: libs } = useWidgetData(async (orgId) => {
    try { return (await listKnowledgeLibraries(orgId)).map((l) => ({ id: l.id, name: l.name })); }
    catch { return []; }
  });
  // Unset (or deleted) library → the first one, until the person picks.
  const lib = useMemo(() => {
    if (!libs || libs.length === 0) return null;
    return libs.find((l) => l.id === libraryId) ?? libs[0];
  }, [libs, libraryId]);

  const { data: recent } = useWidgetData(async (orgId) => {
    if (!lib) return [] as ChatThread[];
    try { return await listThreads(orgId, { libraryId: lib.id, scope: "library", mine: uid ?? undefined, limit: 6 }); }
    catch { return [] as ChatThread[]; }
  }, [lib?.id]);

  const [q, setQ] = useState("");
  const [threadId, setThreadId] = useSessionState<string | null>("threadId", null);
  const [turns, setTurns] = useSessionState<Turn[]>("turns", []);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewer, setViewer] = useState<ViewerTarget | null>(null);
  const [fileKeys, setFileKeys] = useState<Map<string, { fileKey: string; name: string }>>(new Map());
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const last = turns[turns.length - 1] ?? null;

  const ask = useCallback(async (question: string) => {
    if (!activeOrgId || !lib || !question.trim() || busy) return;
    const text = question.trim();
    setBusy(true);
    setStatus("Reading the library…");
    setTurns((t) => [...t, { question: text, answer: null, error: null }]);
    setQ("");
    const ctl = new AbortController();
    abortRef.current = ctl;
    let gotResult = false;
    try {
      await askTurn({
        orgId: activeOrgId, scope: "library", libraryId: lib.id, threadId, question: text,
        ...(mode !== "auto" ? { answerMode: mode } : {}),
        ...(web ? { useWeb: true } : {}),
        ...(picked ? { skills: picked } : {}),
      }, (ev) => {
        if (ev.t === "thread") setThreadId(String((ev.thread as { id?: string }).id ?? "") || null);
        else if (ev.t === "status") setStatus(ev.text);
        else if (ev.t === "result") {
          gotResult = true;
          if (ev.threadId) setThreadId(ev.threadId);
          const reply = ev.reply as unknown as KnowledgeAnswer;
          setTurns((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, answer: reply } : x)));
        } else if (ev.t === "error") {
          gotResult = true;
          setTurns((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, error: ev.error ?? `Error ${ev.status}` } : x)));
        }
      }, ctl.signal);
      if (!gotResult) {
        setTurns((t) => t.map((x, i) => (i === t.length - 1 && !x.answer ? { ...x, error: "The answer didn't come back — try again." } : x)));
      }
    } catch (e) {
      if (!ctl.signal.aborted) {
        setTurns((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, error: (e as Error).message } : x)));
      }
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }, [activeOrgId, lib, busy, threadId, mode, web, picked, setThreadId, setTurns]);

  // Resolve the cited documents' files once per answer, so a tap opens the
  // page straight away.
  const citations = useMemo(() => (last?.answer?.citations ?? []).filter((c) => c.documentId && !c.url), [last]);
  useEffect(() => {
    const ids = [...new Set(citations.map((c) => c.documentId!))].filter((id) => !fileKeys.has(id));
    if (ids.length === 0) return;
    let alive = true;
    void supabase.from("knowledge_documents").select("id, file_key, name").in("id", ids.slice(0, 60)).then(({ data }) => {
      if (!alive || !data) return;
      setFileKeys((prev) => {
        const next = new Map(prev);
        for (const r of data as Array<{ id: string; file_key: string; name: string }>) next.set(r.id, { fileKey: r.file_key, name: r.name });
        return next;
      });
    });
    return () => { alive = false; };
  }, [citations, fileKeys]);

  const openCite = (c: KnowledgeCitation | undefined) => {
    if (!c) return;
    if (c.url) { window.open(c.url, "_blank", "noopener"); return; }
    const sources = citations
      .map((x) => {
        const d = x.documentId ? fileKeys.get(x.documentId) : undefined;
        return d ? { fileKey: d.fileKey, page: x.page ?? 1, quote: x.highlight ?? x.quote ?? null, title: x.documentName ?? d.name, section: x.section ?? null, documentId: x.documentId, n: x.n } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    const index = Math.max(0, sources.findIndex((s) => s.n === c.n));
    const s = sources[index];
    if (!s) return;
    setViewer({ fileKey: s.fileKey, page: s.page, quote: s.quote, title: s.title, section: s.section ?? null, documentId: s.documentId ?? "", sources, index });
  };
  const citeByN = (n: number) => last?.answer?.citations?.find((c) => c.n === n);

  // ── States ────────────────────────────────────────────────────────
  if (libs && libs.length === 0) {
    return (
      <Empty>
        No AI knowledge library yet.{" "}
        <Link href="/knowledge" className="font-bold text-[var(--color-accent)] hover:underline">Create one and add your standards →</Link>
      </Empty>
    );
  }

  const parts = last?.answer ? (() => {
    const meta = extractAnswerMeta(last.answer.answer ?? "");
    const p = structureAnswer(parseAnswerBlocks(meta.answer), last.answer.answerMode ?? null);
    const v = p.hero !== null ? splitVerdict(p.hero) : null;
    return { p, v, followup: last.answer.followup ?? meta.followup ?? null };
  })() : null;

  const proof = (last?.answer?.citations ?? [])
    .slice()
    .sort((a, b) => (a.role === "decides" ? 0 : a.role === "limits" ? 1 : 2) - (b.role === "decides" ? 0 : b.role === "limits" ? 1 : 2))
    .slice(0, expanded ? 6 : 3);

  const continueHref = threadId && lib ? `/assistant?thread=${threadId}&library=${lib.id}` : lib ? `/assistant?library=${lib.id}` : "/assistant";

  return (
    <div className="mt-3 flex-1 min-h-0 flex flex-col gap-2">
      {/* Library + how to answer */}
      <div className="flex items-center gap-2 shrink-0 flex-wrap">
        <SourcesMenu scope="library" libraryId={lib?.id ?? null} librariesOnly down
          libraries={(libs ?? []).map((l) => ({ ...l } as unknown as KnowledgeLibrary))}
          onScopeChange={(_s, id) => { if (id) { setLibraryId(id); setThreadId(null); setTurns([]); } }}
          webOn={web} onToggleWeb={() => setWeb(!web)} />
        <span className="ml-auto" />
        <AnswerMenu down answerMode={mode === "auto" ? null : mode} onAnswerMode={(m) => setMode((m ?? "auto") as Mode)}
          skills={skills} picked={picked} onPick={setPicked} question={q} />
      </div>
      <SkillHint skills={skills} picked={picked} question={q} answerMode={mode === "auto" ? null : mode} />

      {/* Ask */}
      <form onSubmit={(e) => { e.preventDefault(); void ask(q); }}
        className="shrink-0 flex items-center gap-1.5 rounded-xl border-2 border-[var(--color-border)] bg-[var(--color-surface)] pl-2.5 pr-1 py-1 focus-within:border-[var(--color-accent)] transition-colors">
        <Sparkles className="w-4 h-4 text-[var(--color-accent)] shrink-0" />
        <input value={q} onChange={(e) => setQ(e.target.value)} disabled={busy || !lib}
          placeholder={threadId ? "Ask a follow-up…" : lib ? `Ask ${lib.name}…` : "Loading libraries…"}
          className="flex-1 min-w-0 bg-transparent text-[13px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] outline-none py-1" />
        <button type="submit" disabled={busy || !q.trim() || !lib}
          className="shrink-0 inline-flex items-center gap-1 h-8 px-3 rounded-lg bg-[var(--color-accent)] text-white text-[12px] font-black disabled:opacity-40 hover:opacity-90">
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}
          Ask
        </button>
      </form>

      <div className={`${SCROLL} space-y-2`}>
        {/* Working */}
        {busy && (
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/50 p-3">
            <div className="text-[12px] font-bold text-[var(--color-text)] truncate">{last?.question}</div>
            <div className="mt-2 flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
              <span className="relative flex w-2 h-2"><span className="absolute inset-0 rounded-full bg-[var(--color-accent)] animate-ping opacity-60" /><span className="relative w-2 h-2 rounded-full bg-[var(--color-accent)]" /></span>
              {status ?? "Working…"}
            </div>
            <div className="mt-2 space-y-1.5">
              <div className="h-2.5 w-3/4 rounded bg-[var(--color-surface-2)] animate-pulse" />
              <div className="h-2.5 w-1/2 rounded bg-[var(--color-surface-2)] animate-pulse" />
            </div>
          </div>
        )}

        {/* The answer */}
        {!busy && last && (
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
            <div className="flex items-start gap-1.5 text-[11px] text-[var(--color-text-muted)]">
              <CornerDownRight className="w-3 h-3 mt-0.5 shrink-0" />
              <span className="font-semibold line-clamp-2">{last.question}</span>
            </div>
            {last.error ? (
              <div className="mt-2 flex items-start gap-2 text-[12px] text-rose-700 dark:text-rose-300">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{last.error}</span>
              </div>
            ) : parts && (
              <>
                {parts.v?.verdict && (
                  <span className={`mt-2 inline-flex px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-[0.08em] ${VERDICT[parts.v.verdict].cls}`}>
                    {VERDICT[parts.v.verdict].label}
                  </span>
                )}
                <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--color-text)]">
                  <Inline text={capFirst(parts.v?.text ?? parts.p.hero ?? last.answer?.answer?.slice(0, 400) ?? "")} onCite={(n) => openCite(citeByN(n))} />
                </p>
                {parts.p.settle.length > 0 && (
                  <div className="mt-2 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/20 px-2.5 py-1.5">
                    <div className="text-[10px] font-black uppercase tracking-wider text-amber-800 dark:text-amber-300">To settle this</div>
                    <ul className="mt-0.5 space-y-0.5">
                      {parts.p.settle.slice(0, 2).map((b, i) => (
                        <li key={i} className="text-[11px] text-[var(--color-text)]"><Inline text={b.text} onCite={(n) => openCite(citeByN(n))} /></li>
                      ))}
                    </ul>
                  </div>
                )}
                {expanded && parts.p.why.length > 0 && (
                  <ul className="mt-2 space-y-1 list-disc pl-4">
                    {parts.p.why.slice(0, 5).map((b, i) => (
                      <li key={i} className="text-[12px] text-[var(--color-text)]"><Inline text={b.text} onCite={(n) => openCite(citeByN(n))} /></li>
                    ))}
                  </ul>
                )}
                {proof.length > 0 && (
                  <div className="mt-2.5 space-y-1.5">
                    <div className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-faint)]">The proof</div>
                    {proof.map((c) => {
                      const win = c.quote ? (c.highlight ? quoteWindow(c.quote, c.highlight) : null) : null;
                      const clause = c.quote ? clauseFor(c.quote, c.highlight, c.section) : null;
                      return (
                        <button key={c.n} type="button" onClick={() => openCite(c)}
                          className="w-full text-left rounded-lg border border-[var(--color-border)] hover:border-[var(--color-accent)] bg-[var(--color-surface-2)]/40 px-2.5 py-1.5 transition-colors">
                          <div className="flex items-center gap-1.5 text-[10px] font-black text-[var(--color-text-muted)]">
                            <span className="px-1 rounded bg-[var(--color-accent-soft)] text-[var(--color-accent)]">{c.n}</span>
                            <FileText className="w-3 h-3" />
                            <span className="truncate">
                              {c.url ? (c.title ?? c.url) : docDesignation(c.documentName ?? "Document")}
                              {clause ? ` § ${clause}` : ""}{c.page ? ` · p.${c.page}` : ""}
                            </span>
                            {c.role === "decides" && <span className="ml-auto shrink-0 text-emerald-700 dark:text-emerald-400">decides</span>}
                            {c.role === "limits" && <span className="ml-auto shrink-0 text-amber-700 dark:text-amber-400">limits</span>}
                          </div>
                          <div className="mt-0.5 text-[11px] leading-snug text-[var(--color-text-muted)] line-clamp-3">
                            {win ? (
                              <>{win.clippedStart ? "… " : ""}{win.before}<mark className="rounded px-0.5 bg-yellow-200 dark:bg-yellow-700/60 text-[var(--color-text)] font-bold">{win.hit}</mark>{win.after}{win.clippedEnd ? " …" : ""}</>
                            ) : (c.quote ?? c.claim ?? "Open the page")}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
                {/* The library asking YOU something back — answer it in the box above. */}
                {parts.followup && (
                  <div className="mt-2 text-[11px] rounded-lg border border-dashed border-[var(--color-accent)]/60 px-2.5 py-1.5 text-[var(--color-text)]">
                    <span className="font-black text-[var(--color-accent)]">One question for you: </span>{parts.followup.question}
                    {parts.followup.options.length > 0 ? (
                      <span className="mt-1 flex flex-wrap gap-1">
                        {parts.followup.options.slice(0, 4).map((o) => (
                          <button key={o} type="button" onClick={() => void ask(o)}
                            className="px-2 py-0.5 rounded-md border border-[var(--color-accent)]/50 text-[10px] font-bold text-[var(--color-accent)] hover:bg-[var(--color-accent)] hover:text-white">
                            {o}
                          </button>
                        ))}
                      </span>
                    ) : (
                      <span className="block text-[10px] text-[var(--color-text-muted)] mt-0.5">Answer it in the box above — it continues this conversation.</span>
                    )}
                  </div>
                )}
              </>
            )}
            <div className="mt-2.5 flex items-center gap-2 flex-wrap">
              <Link href={continueHref}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[var(--color-text)] text-[var(--color-surface)] text-[11px] font-black hover:opacity-90">
                <MessageSquare className="w-3.5 h-3.5" /> Continue in Assistant
              </Link>
              <button type="button" onClick={() => { setThreadId(null); setTurns([]); }}
                className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]">
                <RotateCcw className="w-3.5 h-3.5" /> New question
              </button>
              {turns.length > 1 && <span className="text-[10px] text-[var(--color-text-faint)]">{turns.length} questions in this conversation</span>}
            </div>
          </div>
        )}

        {/* Recent questions */}
        {!busy && !last && (
          (recent ?? []).length > 0 ? (
            <div>
              <div className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-faint)] mb-1">Your recent questions</div>
              <ul className="space-y-0.5">
                {(recent ?? []).map((t) => (
                  <li key={t.id}>
                    <Link href={`/assistant?thread=${t.id}&library=${t.libraryId ?? lib?.id ?? ""}`}
                      className="group flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--color-surface-2)]">
                      <MessageSquare className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />
                      <span className="flex-1 min-w-0 truncate text-[12px] font-semibold text-[var(--color-text)] group-hover:text-[var(--color-accent)]">{t.title || "Untitled"}</span>
                      <span className="shrink-0 text-[10px] text-[var(--color-text-faint)] tabular-nums">{timeAgo(t.lastMessageAt)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <Empty>Ask anything your library can answer — the answer comes back cited to the page, from your documents only.</Empty>
          )
        )}
      </div>

      {viewer && (
        <CitedPageViewer
          fileKey={viewer.fileKey} page={viewer.page} quote={viewer.quote} title={viewer.title}
          section={viewer.section} orgId={activeOrgId ?? undefined} documentId={viewer.documentId || undefined}
          sources={viewer.sources} initialIndex={viewer.index}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  );
}
