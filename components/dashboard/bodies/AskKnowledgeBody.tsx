"use client";

// Ask Knowledge: ask a library a quick question right on the dashboard.
//
// The same engine and the same rules as the Assistant (documents only,
// cited to the page), shaped for a card: the verdict and the direct answer
// first, the passages that prove it as tappable quotes (each opens the page
// with the words highlighted), "to settle this" when the library can't, and
// a door into the full conversation. The question is saved as a real
// conversation, so "Continue in Assistant" picks up exactly here.
//
// The question box has every state drawn: quiet at rest; a soft focus ring
// on the box (its edge never jumps); it grows with the question while the
// send button stays put; the send button wakes (filled) once there is
// text; while the answer comes it turns into Stop in the same place, and
// Stop puts the question back in the box.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import {
  Sparkles, ArrowUp, Square, Loader2, MessageSquare, FileText, CornerDownRight, RotateCcw, AlertTriangle,
} from "lucide-react";
import { friendlyError } from "@/lib/friendlyError";
import { SkeletonText } from "@/components/ui/Skeleton";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { askTurn, listThreads, type ChatThread } from "@/lib/chatClient";
import { type KnowledgeAnswer, type KnowledgeCitation, type KnowledgeLibrary } from "@/lib/knowledge";
import { loadKnowledgeLibs } from "@/lib/dashboard/widgetLoads";
import { SourcesMenu, AnswerMenu, SkillHint, useAnswerSkills } from "@/components/chat/AskControls";
import {
  parseAnswerBlocks, structureAnswer, splitVerdict, extractAnswerMeta, quoteWindow, docDesignation, clauseFor,
  type Verdict,
} from "@/lib/knowledgeText";
import { useWidget, useSetting, useSessionState, useWidgetData, Empty, timeAgo, SCROLL } from "../kit";
import { useDraft } from "@/hooks/useDraft";
import { StatusTag, rowBtn, link, type StatusTone } from "@/components/cockpit/ui";

const CitedPageViewer = dynamic(() => import("@/components/knowledge/CitedPageViewer"), { ssr: false });

type Mode = "auto" | "answer" | "compliance" | "explore" | "deviation";

// The verdict as a status tag: green yes, amber with conditions, red no.
const VERDICT: Record<Verdict, { label: string; tone: StatusTone }> = {
  yes: { label: "Yes", tone: "released" },
  conditional: { label: "Yes, with conditions", tone: "held" },
  no: { label: "No", tone: "overdue" },
  unsettled: { label: "Not settled", tone: "neutral" },
  complies: { label: "Complies", tone: "released" },
  fails: { label: "Does not comply", tone: "overdue" },
  undetermined: { label: "Can't determine", tone: "neutral" },
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
            <button key={`${i}-${n}`} type="button" onClick={() => onCite(Number(n))} aria-label={`Source ${n}`}
              className="align-super mx-px px-1 rounded bg-[var(--color-surface-2)] text-[var(--color-accent-text)] text-body font-medium hover:bg-[var(--color-accent)] hover:text-[var(--color-accent-fg)] transition-colors">
              {n}
            </button>
          ));
        }
        if (p.startsWith("**") && p.endsWith("**")) return <b key={i} className="font-medium text-[var(--color-text)]">{p.slice(2, -2)}</b>;
        return <React.Fragment key={i}>{p.replace(/\s*\[image \d+\]/gi, "")}</React.Fragment>;
      })}
    </>
  );
}

export default function AskKnowledgeBody() {
  const { activeOrgId, uid } = useRole();
  const { expanded, widget: thisWidget } = useWidget();
  const [libraryId, setLibraryId] = useSetting<string>("libraryId", "");
  const [mode, setMode] = useSetting<Mode>("mode", "auto");
  // The same choices as the chat's prompt bar: skills and web.
  const skills = useAnswerSkills(activeOrgId ?? null);
  const [picked, setPicked] = useSetting<string[] | null>("skills", null);
  const [web, setWeb] = useSetting<boolean>("web", false);

  // A failed read throws: the frame says it failed instead of "no libraries".
  // Named: sign-in starts it, and Home opened again shows it at once.
  const { data: libs } = useWidgetData((orgId) => loadKnowledgeLibs(orgId), [], "knowledge.libs");
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
  // A half-typed question waits on this device, per widget.
  const qDraft = useDraft<string>(`home-ask:${thisWidget.id}`, q, setQ, (v) => !v.trim());
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
    qDraft.clear();
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
          setTurns((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, error: friendlyError(ev.error ?? { status: ev.status }) } : x)));
        }
      }, ctl.signal);
      // Stopped: the turn is already gone and the question back in the box.
      if (!gotResult && !ctl.signal.aborted) {
        setTurns((t) => t.map((x, i) => (i === t.length - 1 && !x.answer ? { ...x, error: "The answer didn't come back. Try again." } : x)));
      }
    } catch (e) {
      if (!ctl.signal.aborted) {
        setTurns((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, error: friendlyError(e) } : x)));
      }
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }, [activeOrgId, lib, busy, threadId, mode, web, picked, setThreadId, setTurns, qDraft]);

  // Stop waiting for the answer: the pending question leaves the list and
  // goes back into the box, as typed.
  const taRef = useRef<HTMLTextAreaElement>(null);
  const stop = useCallback(() => {
    const ctl = abortRef.current;
    if (!ctl || ctl.signal.aborted) return;
    ctl.abort();
    const pending = turns[turns.length - 1];
    setTurns((t) => (t.length && !t[t.length - 1].answer ? t.slice(0, -1) : t));
    if (pending && !pending.answer) setQ(pending.question);
    setBusy(false);
    setStatus(null);
    window.setTimeout(() => taRef.current?.focus(), 0);
  }, [turns, setTurns]);

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
        <Link href="/knowledge" className={link}>Create one and add your standards</Link>
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
    <div className="flex-1 min-h-0 flex flex-col gap-3">
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

      {/* Ask: the box grows with the question, the button stays put. */}
      <form onSubmit={(e) => { e.preventDefault(); void ask(q); }}
        className="ui-field-box shrink-0 flex items-end gap-2 rounded-lg border border-[var(--color-border-control)] bg-[var(--color-surface)] pl-3 pr-1.5 py-1.5">
        <Sparkles aria-hidden className="w-4 h-4 mb-2.5 text-[var(--color-text-muted)] shrink-0" />
        <textarea ref={taRef} rows={1} value={q} onChange={(e) => setQ(e.target.value)} disabled={!lib} readOnly={busy}
          onKeyDown={(e) => {
            // Enter asks; Shift+Enter starts a new line.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void ask(q); }
          }}
          placeholder={threadId ? "Ask a follow-up" : lib ? `Ask ${lib.name}` : "Loading libraries"}
          aria-label="Your question"
          enterKeyHint="send"
          className="ui-field-bare flex-1 min-w-0 min-h-9 pointer-coarse:min-h-11 max-h-40 resize-none overflow-y-auto [field-sizing:content] bg-transparent py-1.5 pointer-coarse:py-2.5 text-reading leading-6 text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] outline-none disabled:opacity-60" />
        {busy ? (
          // While the answer comes, the same spot stops it.
          // Its own element (key): reusing the Ask button's node would turn
          // this click into a submit once the button flips back.
          <button key="stop" type="button" onClick={(e) => { e.preventDefault(); stop(); }} aria-label="Stop waiting for the answer" title="Stop"
            className="relative shrink-0 w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 grid place-items-center rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors">
            <span aria-hidden className="absolute inset-1.5 rounded-full border-2 border-[var(--color-border)] border-t-[var(--color-current)] motion-safe:animate-spin" />
            <Square aria-hidden className="w-3 h-3 fill-current" />
          </button>
        ) : (
          <button key="ask" type="submit" disabled={!q.trim() || !lib} aria-label="Ask" title="Ask (Enter)"
            className={`shrink-0 w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 grid place-items-center rounded-lg transition-colors disabled:cursor-not-allowed ${q.trim()
              ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"
              : "text-[var(--color-text-faint)]"}`}>
            <ArrowUp aria-hidden className="w-4 h-4" />
          </button>
        )}
      </form>

      <div className={`${SCROLL} space-y-2`}>
        {/* Working */}
        {busy && (
          <div className="border-t border-[var(--color-border)] pt-3">
            <div className="text-reading font-medium text-[var(--color-text)] truncate">{last?.question}</div>
            <div role="status" className="mt-2 flex items-center gap-2 text-body text-[var(--color-text-muted)]">
              <Loader2 aria-hidden className="w-3 h-3 motion-safe:animate-spin shrink-0" />
              {status ?? "Reading the library"}
            </div>
            <SkeletonText lines={2} className="mt-2.5" />
          </div>
        )}

        {/* The answer */}
        {!busy && last && (
          <div className="border-t border-[var(--color-border)] pt-3">
            <div className="flex items-start gap-1.5 text-body text-[var(--color-text-muted)]">
              <CornerDownRight className="w-3 h-3 mt-0.5 shrink-0" />
              <span className="font-medium line-clamp-2">{last.question}</span>
            </div>
            {last.error ? (
              <div role="alert" className="mt-2 flex flex-wrap items-start gap-x-2 gap-y-1 text-body">
                <AlertTriangle aria-hidden className="w-4 h-4 shrink-0 mt-0.5 text-[var(--state-overdue)]" />
                <span className="min-w-0 flex-1 text-[var(--color-text)]">{last.error}</span>
                <button type="button" onClick={() => { const question = last.question; setTurns((t) => t.slice(0, -1)); void ask(question); }}
                  className="font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2">Try again</button>
              </div>
            ) : parts && (
              <>
                {parts.v?.verdict && (
                  <StatusTag tone={VERDICT[parts.v.verdict].tone} className="mt-2">{VERDICT[parts.v.verdict].label}</StatusTag>
                )}
                <p className="mt-1.5 text-reading leading-relaxed text-[var(--color-text)]">
                  <Inline text={capFirst(parts.v?.text ?? parts.p.hero ?? last.answer?.answer?.slice(0, 400) ?? "")} onCite={(n) => openCite(citeByN(n))} />
                </p>
                {parts.p.settle.length > 0 && (
                  <div className="mt-2 border-l-2 border-[var(--state-held)] pl-2.5">
                    <div className="text-body font-medium text-[var(--color-text)]">To settle this</div>
                    <ul className="mt-0.5 space-y-0.5">
                      {parts.p.settle.slice(0, 2).map((b, i) => (
                        <li key={i} className="text-body text-[var(--color-text)]"><Inline text={b.text} onCite={(n) => openCite(citeByN(n))} /></li>
                      ))}
                    </ul>
                  </div>
                )}
                {expanded && parts.p.why.length > 0 && (
                  <ul className="mt-2 space-y-1 list-disc pl-4">
                    {parts.p.why.slice(0, 5).map((b, i) => (
                      <li key={i} className="text-body text-[var(--color-text)]"><Inline text={b.text} onCite={(n) => openCite(citeByN(n))} /></li>
                    ))}
                  </ul>
                )}
                {proof.length > 0 && (
                  <div className="mt-2.5 space-y-1.5">
                    <div className="text-body font-medium text-[var(--color-text-faint)]">The proof</div>
                    {proof.map((c) => {
                      const win = c.quote ? (c.highlight ? quoteWindow(c.quote, c.highlight) : null) : null;
                      const clause = c.quote ? clauseFor(c.quote, c.highlight, c.section) : null;
                      return (
                        <button key={c.n} type="button" onClick={() => openCite(c)}
                          className="w-full text-left rounded-lg border border-[var(--color-border)] hover:border-[var(--color-border-control)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] px-2.5 py-1.5 transition-colors">
                          <div className="flex items-center gap-1.5 text-body font-medium text-[var(--color-text-muted)]">
                            <span className="px-1 rounded bg-[var(--color-surface-2)] text-[var(--color-text)]">{c.n}</span>
                            <FileText className="w-3 h-3" />
                            <span className="truncate">
                              {c.url ? (c.title ?? c.url) : docDesignation(c.documentName ?? "Document")}
                              {clause ? ` § ${clause}` : ""}{c.page ? ` · p.${c.page}` : ""}
                            </span>
                            {c.role === "decides" && <span className="ml-auto shrink-0 text-[var(--color-text)]">decides</span>}
                            {c.role === "limits" && <span className="ml-auto shrink-0 text-[var(--color-text)]">limits</span>}
                          </div>
                          <div className="mt-0.5 text-body leading-snug text-[var(--color-text-muted)] line-clamp-3">
                            {win ? (
                              <>{win.clippedStart ? "… " : ""}{win.before}<mark className="rounded px-0.5 bg-[color-mix(in_srgb,var(--state-held)_22%,transparent)] text-[var(--color-text)] font-medium">{win.hit}</mark>{win.after}{win.clippedEnd ? " …" : ""}</>
                            ) : (c.quote ?? c.claim ?? "Open the page")}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
                {/* The library asking YOU something back — answer it in the box above. */}
                {parts.followup && (
                  <div className="mt-2 text-body rounded-lg border border-dashed border-[var(--color-border-strong)] px-2.5 py-1.5 text-[var(--color-text)]">
                    <span className="font-medium text-[var(--color-text)]">One question for you: </span>{parts.followup.question}
                    {parts.followup.options.length > 0 ? (
                      <span className="mt-1 flex flex-wrap gap-1">
                        {parts.followup.options.slice(0, 4).map((o) => (
                          <button key={o} type="button" onClick={() => void ask(o)}
                            className="ui-tag !h-auto min-h-7 pointer-coarse:min-h-10 font-sans text-[var(--color-accent-text)]">
                            {o}
                          </button>
                        ))}
                      </span>
                    ) : (
                      <span className="block text-body text-[var(--color-text-muted)] mt-0.5">Answer it in the box above. It continues this conversation.</span>
                    )}
                  </div>
                )}
              </>
            )}
            <div className="mt-2.5 flex items-center gap-2 flex-wrap">
              <Link href={continueHref}
                className={rowBtn}>
                <MessageSquare className="w-3.5 h-3.5" /> Continue in Assistant
              </Link>
              <button type="button" onClick={() => { setThreadId(null); setTurns([]); }}
                className={rowBtn}>
                <RotateCcw className="w-3.5 h-3.5" /> New question
              </button>
              {turns.length > 1 && <span className="text-body text-[var(--color-text-faint)]">{turns.length} questions in this conversation</span>}
            </div>
          </div>
        )}

        {/* Recent questions */}
        {!busy && !last && (
          (recent ?? []).length > 0 ? (
            <div>
              <div className="text-body font-medium text-[var(--color-text-faint)] mb-1">Your recent questions</div>
              <ul className="space-y-0.5">
                {(recent ?? []).map((t) => (
                  <li key={t.id}>
                    <Link href={`/assistant?thread=${t.id}&library=${t.libraryId ?? lib?.id ?? ""}`}
                      className="group flex items-center gap-2 px-2 py-1.5 pointer-coarse:min-h-11 rounded-lg hover:bg-[var(--color-surface-2)]">
                      <MessageSquare className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />
                      <span className="flex-1 min-w-0 truncate text-body font-medium text-[var(--color-text)] group-hover:text-[var(--color-text)]">{t.title || "Untitled"}</span>
                      <span className="shrink-0 text-body text-[var(--color-text-faint)] tabular-nums">{timeAgo(t.lastMessageAt)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <Empty>Ask anything your library can answer. The answer comes from your documents only, cited to the page.</Empty>
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
