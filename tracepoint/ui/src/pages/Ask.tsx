import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUp, Bot, Boxes, BookOpen, Brain, ExternalLink, FileText, Globe, Library, Loader2, MessageSquarePlus, Plus, Search, Settings2, Square, Trash2, X } from "lucide-react";
import { api, fileUrl, onEvent } from "../lib/api";
import type { AppState, Facet } from "../lib/types";
import { Button, Empty, IconButton, Input, Modal, Pill, cx, useToast } from "../components/ui";
import { when } from "../lib/format";
import type { Nav } from "../Shell";

export interface Scope { kind: "thor" | "equipment" | "library"; id?: number; label?: string }
interface Source { n: number; file_id: number; name: string; page?: number | null; path: string; folder: string; snippet: string; score?: number }
interface Msg { id?: number; role: "user" | "assistant"; content: string; sources?: Source[]; meta?: { model?: string; ms?: number; input_tokens?: number; output_tokens?: number; read?: number; searched?: string[] }; pending?: boolean; status?: string[]; error?: string }
interface ThreadSummary { id: number; title: string; updated_at: string; scope: Scope }
interface LibrarySummary { id: number; name: string; files: number; indexed: number; created_at: string }

const SUGGESTIONS = [
  "What was the minimum thickness found on V-2 (5610.15) and when?",
  "Summarise the last external inspection of TK-1100.",
  "Which relief valves in the SRU had service reports in 2025?",
  "What repairs were made to the crude unit overhead line?",
];

export function AskPage({ state, nav }: { state: AppState; nav: Nav }) {
  const toast = useToast();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [libs, setLibs] = useState<LibrarySummary[]>([]);
  const [threadId, setThreadId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [scope, setScope] = useState<Scope>(() => (nav.params.eq ? { kind: "equipment", id: Number(nav.params.eq), label: nav.params.label } : { kind: "thor" }));
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [aiReady, setAiReady] = useState<boolean | null>(null);
  const [activeSource, setActiveSource] = useState<Source | null>(null);
  const [newLib, setNewLib] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  const loadLists = useCallback(() => {
    api<ThreadSummary[]>("chat.threads").then(setThreads).catch(() => {});
    api<LibrarySummary[]>("library.list").then(setLibs).catch(() => {});
  }, []);
  useEffect(() => {
    loadLists();
    api<{ provider?: string; has_key: boolean; can_ai: boolean }>("ai.get").then((c) => setAiReady(!!c.provider && c.has_key && c.can_ai)).catch(() => setAiReady(false));
  }, [loadLists]);
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" }); }, [messages]);

  useEffect(() => onEvent("chat", (p: { thread_id: number; type: string; text?: string; sources?: Source[]; meta?: Msg["meta"]; error?: string; status?: string }) => {
    setThreadId((cur) => cur ?? p.thread_id);
    setMessages((ms) => {
      const copy = [...ms];
      const last = copy[copy.length - 1];
      if (!last || last.role !== "assistant") return ms;
      const m = { ...last };
      if (p.type === "status" && p.status) m.status = [...(m.status ?? []), p.status];
      if (p.type === "sources") m.sources = p.sources;
      if (p.type === "delta") m.content += p.text ?? "";
      if (p.type === "done") { m.pending = false; m.meta = p.meta; if (p.text !== undefined) m.content = p.text; }
      if (p.type === "error") { m.pending = false; m.error = p.error; }
      copy[copy.length - 1] = m;
      return copy;
    });
    if (p.type === "done" || p.type === "error") { setBusy(false); loadLists(); }
  }), [loadLists]);

  const openThread = async (id: number) => {
    const t = await api<{ id: number; scope: Scope; messages: Msg[] }>("chat.thread", { id });
    setThreadId(t.id);
    setScope(t.scope);
    setMessages(t.messages);
    setActiveSource(null);
  };
  const newThread = () => { setThreadId(null); setMessages([]); setActiveSource(null); };
  const ask = async (q?: string) => {
    const question = (q ?? input).trim();
    if (!question || busy) return;
    setInput("");
    setBusy(true);
    setMessages((m) => [...m, { role: "user", content: question }, { role: "assistant", content: "", pending: true, status: [] }]);
    try {
      const r = await api<{ thread_id: number }>("chat.ask", { thread_id: threadId, question, scope });
      setThreadId(r.thread_id);
    } catch (e) {
      setBusy(false);
      setMessages((m) => { const c = [...m]; c[c.length - 1] = { role: "assistant", content: "", error: (e as Error).message }; return c; });
    }
  };
  const stop = () => api("ai.cancel");
  const delThread = async (id: number) => { await api("chat.delete", { id }); if (id === threadId) newThread(); loadLists(); };

  if (aiReady === false) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="card max-w-xl p-8 text-center animate-[var(--animate-rise)]">
          <div className="mx-auto flex size-14 items-center justify-center rounded-2xl text-white shadow-lg" style={{ background: "var(--brand-gradient)" }}><Bot className="size-7" /></div>
          <h2 className="mt-5 text-[22px] font-[700]">Ask THOR anything</h2>
          <p className="mt-2 text-[14px] leading-relaxed text-[var(--color-text-muted)]">
            TracePoint finds the right documents, reads them, and answers with citations to the exact file and page. It uses your own AI account, so connect one first.
          </p>
          {!state.policy.ai_enabled ? (
            <div className="mt-5 rounded-xl bg-[var(--color-surface-2)] p-3 text-[13px] text-[var(--color-text-muted)]">AI is turned off by your administrator.</div>
          ) : (
            <Button variant="primary" size="lg" className="mt-6" icon={<Settings2 className="size-4" />} onClick={() => nav.go("profile", { tab: "ai" })}>Set up the AI assistant</Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* Threads + libraries */}
      <aside className="flex w-[260px] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface-2)]">
        <div className="p-3"><Button className="w-full" icon={<MessageSquarePlus className="size-4" />} onClick={newThread}>New conversation</Button></div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2">
          <RailTitle>Knowledge libraries <IconButton label="New library" onClick={() => setNewLib(true)} className="size-6"><Plus className="size-3.5" /></IconButton></RailTitle>
          {libs.length === 0 && <div className="px-2.5 pb-2 text-[12px] text-[var(--color-text-faint)]">Group documents (e.g. one unit's P&IDs) to ask focused questions.</div>}
          {libs.map((l) => (
            <button key={l.id} onClick={() => { setScope({ kind: "library", id: l.id, label: l.name }); newThread(); }} className={cx("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] cursor-pointer", scope.kind === "library" && scope.id === l.id ? "bg-[var(--color-surface)] shadow-sm font-medium" : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)]")}>
              <Library className="size-3.5 shrink-0" /><span className="flex-1 truncate">{l.name}</span><span className="text-[11px] text-[var(--color-text-faint)]">{l.files}</span>
            </button>
          ))}
          <RailTitle>Conversations</RailTitle>
          {threads.map((t) => (
            <div key={t.id} className={cx("group flex items-center gap-1 rounded-lg pr-1", threadId === t.id ? "bg-[var(--color-surface)] shadow-sm" : "hover:bg-[var(--color-surface-3)]")}>
              <button onClick={() => openThread(t.id)} className="min-w-0 flex-1 px-2.5 py-1.5 text-left cursor-pointer">
                <div className="truncate text-[13px]">{t.title}</div>
                <div className="truncate text-[11px] text-[var(--color-text-faint)]">{t.scope.kind === "thor" ? "All THOR" : t.scope.label} · {when(t.updated_at)}</div>
              </button>
              <IconButton label="Delete" onClick={() => delThread(t.id)} className="size-6 opacity-0 group-hover:opacity-100"><Trash2 className="size-3.5" /></IconButton>
            </div>
          ))}
          {threads.length === 0 && <div className="px-2.5 text-[12px] text-[var(--color-text-faint)]">No conversations yet.</div>}
        </div>
      </aside>

      {/* Conversation */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--color-border)] px-5">
          <ScopePicker scope={scope} setScope={(s) => { setScope(s); if (messages.length) newThread(); }} libs={libs} />
        </div>
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
          {messages.length === 0 ? (
            <div className="mx-auto max-w-[760px] px-6 pt-[10vh] text-center animate-[var(--animate-rise)]">
              <div className="mx-auto flex size-14 items-center justify-center rounded-2xl text-white shadow-lg" style={{ background: "var(--brand-gradient)" }}><Bot className="size-7" /></div>
              <h2 className="mt-5 text-[26px] font-[700] tracking-tight">Ask {scope.kind === "thor" ? "THOR" : scope.label}</h2>
              <p className="mt-2 text-[14px] text-[var(--color-text-muted)]">Answers come only from documents on THOR, with numbered citations you can open.</p>
              <div className="mt-7 grid grid-cols-2 gap-2.5 text-left">
                {SUGGESTIONS.map((s) => <button key={s} onClick={() => ask(s)} className="card hover-lift p-3.5 text-[13px] leading-snug cursor-pointer">{s}</button>)}
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-[820px] space-y-6 px-6 py-6">
              {messages.map((m, i) => <Message key={i} m={m} onSource={setActiveSource} active={activeSource} />)}
            </div>
          )}
        </div>
        <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-4">
          <div className="mx-auto max-w-[820px]">
            <div className="flex items-end gap-2 rounded-2xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-2 shadow-md focus-within:border-[var(--color-accent)] focus-within:ring-4 focus-within:ring-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } }}
                rows={Math.min(6, Math.max(1, input.split("\n").length))}
                placeholder={`Ask about ${scope.kind === "thor" ? "anything on THOR" : scope.label}…`}
                className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-[14px] outline-none placeholder:text-[var(--color-text-faint)]"
              />
              {busy ? <Button onClick={stop} icon={<Square className="size-3.5" />}>Stop</Button> : <Button variant="primary" onClick={() => ask()} disabled={!input.trim()} className="size-10 rounded-xl p-0"><ArrowUp className="size-5" /></Button>}
            </div>
            <div className="mt-2 text-center text-[11.5px] text-[var(--color-text-faint)]">AI can be wrong. Check the cited pages before relying on an answer. Uses your own AI key.</div>
          </div>
        </div>
      </div>

      {activeSource && <SourcePane s={activeSource} onClose={() => setActiveSource(null)} />}
      <NewLibrary open={newLib} onClose={() => setNewLib(false)} onDone={(l) => { setNewLib(false); loadLists(); setScope({ kind: "library", id: l.id, label: l.name }); newThread(); toast("ok", `Library “${l.name}” created`); }} />
    </div>
  );
}

function RailTitle({ children }: { children: ReactNode }) {
  return <div className="mb-1 mt-4 flex items-center justify-between px-2.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">{children}</div>;
}

function ScopePicker({ scope, setScope, libs }: { scope: Scope; setScope: (s: Scope) => void; libs: LibrarySummary[] }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sugg, setSugg] = useState<Facet[]>([]);
  useEffect(() => {
    const t = setTimeout(() => { if (q.length >= 2) api<Facet[]>("suggest", { q }).then((s) => setSugg(s.filter((x) => x.key.startsWith("equip:")))); else setSugg([]); }, 100);
    return () => clearTimeout(t);
  }, [q]);
  const icon = scope.kind === "thor" ? <Globe className="size-4" /> : scope.kind === "equipment" ? <Boxes className="size-4" /> : <Library className="size-4" />;
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[13px] font-medium shadow-xs hover:border-[var(--color-border-strong)] cursor-pointer">
        <span className="text-[var(--color-accent)]">{icon}</span>{scope.kind === "thor" ? "All of THOR" : scope.label}<span className="text-[var(--color-text-faint)]">▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-11 z-20 w-[380px] card p-2 shadow-2xl animate-[var(--animate-pop)]">
            <button onClick={() => { setScope({ kind: "thor" }); setOpen(false); }} className="flex w-full items-start gap-3 rounded-lg p-2.5 text-left hover:bg-[var(--color-surface-3)] cursor-pointer">
              <Globe className="mt-0.5 size-4 text-[var(--color-accent)]" /><span><span className="block text-[13px] font-semibold">All of THOR</span><span className="block text-[12px] text-[var(--color-text-muted)]">TracePoint searches the whole index and reads the best matches</span></span>
            </button>
            <div className="mt-1 px-2.5 pt-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">One piece of equipment</div>
            <div className="p-1.5"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="5610.15, V-2, TK-1100…" icon={<Search className="size-4" />} autoFocus /></div>
            {sugg.map((s) => (
              <button key={s.key} onClick={() => { setScope({ kind: "equipment", id: Number(s.key.slice(6)), label: s.label.split(" — ")[0] }); setOpen(false); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-[var(--color-surface-3)] cursor-pointer">
                <Boxes className="size-3.5 text-[var(--color-accent)]" /><span className="flex-1 truncate">{s.label}</span>
              </button>
            ))}
            {libs.length > 0 && <div className="mt-1 px-2.5 pt-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">Libraries</div>}
            {libs.map((l) => (
              <button key={l.id} onClick={() => { setScope({ kind: "library", id: l.id, label: l.name }); setOpen(false); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-[var(--color-surface-3)] cursor-pointer">
                <Library className="size-3.5 text-[var(--color-accent)]" /><span className="flex-1 truncate">{l.name}</span><span className="text-[11px] text-[var(--color-text-faint)]">{l.files} files</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Minimal, safe Markdown: paragraphs, lists, bold, code, headings, and
 *  [n] citation chips. No raw HTML is ever rendered. */
function renderAnswer(text: string, sources: Source[] | undefined, onSource: (s: Source) => void, active: Source | null): ReactNode {
  const inline = (s: string, key: string): ReactNode[] => {
    const out: ReactNode[] = [];
    const re = /(\*\*[^*]+\*\*|`[^`]+`|\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\])/g;
    let last = 0, m: RegExpExecArray | null, k = 0;
    while ((m = re.exec(s))) {
      if (m.index > last) out.push(s.slice(last, m.index));
      const tok = m[0];
      if (tok.startsWith("**")) out.push(<strong key={`${key}-${k++}`}>{tok.slice(2, -2)}</strong>);
      else if (tok.startsWith("`")) out.push(<code key={`${key}-${k++}`}>{tok.slice(1, -1)}</code>);
      else {
        const nums = m[2].split(",").map((x) => Number(x.trim()));
        nums.forEach((nn) => {
          const src = sources?.find((x) => x.n === nn);
          out.push(
            <button key={`${key}-${k++}`} onClick={() => src && onSource(src)} title={src ? `${src.name}${src.page ? ` · page ${src.page}` : ""}` : undefined}
              className={cx("mx-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-md px-1 align-[1px] text-[11px] font-semibold transition cursor-pointer", active?.n === nn ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]" : "bg-[var(--color-accent-soft)] text-[var(--color-accent)] hover:bg-[var(--color-accent)] hover:text-[var(--color-accent-fg)]")}>
              {nn}
            </button>,
          );
        });
      }
      last = m.index + tok.length;
    }
    if (last < s.length) out.push(s.slice(last));
    return out;
  };
  const blocks = text.split(/\n{2,}/);
  return blocks.map((b, i) => {
    const lines = b.split("\n");
    if (lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l))) {
      const ordered = /^\s*\d/.test(lines[0]);
      const items = lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-*•]|\d+[.)])\s+/, ""), `${i}-${j}`)}</li>);
      return ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
    }
    if (/^#{1,4}\s/.test(b)) return <h4 key={i}>{inline(b.replace(/^#+\s/, ""), `${i}`)}</h4>;
    return <p key={i}>{lines.flatMap((l, j) => (j ? [<br key={`br${j}`} />, ...inline(l, `${i}-${j}`)] : inline(l, `${i}-${j}`)))}</p>;
  });
}

function Message({ m, onSource, active }: { m: Msg; onSource: (s: Source) => void; active: Source | null }) {
  if (m.role === "user") {
    return <div className="flex justify-end animate-[var(--animate-rise)]"><div className="max-w-[80%] rounded-2xl rounded-br-md bg-[var(--color-accent)] px-4 py-2.5 text-[14px] leading-relaxed text-[var(--color-accent-fg)] shadow-sm whitespace-pre-wrap">{m.content}</div></div>;
  }
  return (
    <div className="flex gap-3 animate-[var(--animate-rise)]">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-xl text-white shadow-sm" style={{ background: "var(--brand-gradient)" }}><Bot className="size-4" /></div>
      <div className="min-w-0 flex-1">
        {(m.status?.length ?? 0) > 0 && (
          <div className="mb-2 space-y-1">
            {m.status!.map((s, i) => (
              <div key={i} className="flex items-center gap-2 text-[12.5px] text-[var(--color-text-muted)]">
                {m.pending && i === m.status!.length - 1 ? <Loader2 className="size-3.5 animate-spin text-[var(--color-accent)]" /> : <span className="size-1.5 rounded-full bg-[var(--color-ok)]" />}{s}
              </div>
            ))}
          </div>
        )}
        {m.error ? (
          <div className="rounded-xl border border-[color-mix(in_srgb,var(--color-bad)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-bad)_7%,transparent)] px-4 py-3 text-[13.5px] text-[var(--color-bad)]">{m.error}</div>
        ) : (
          <div className="prose-tp text-[14.5px] text-[var(--color-text)]">{renderAnswer(m.content, m.sources, onSource, active)}{m.pending && m.content && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-[var(--color-accent)] align-middle" />}</div>
        )}
        {m.sources && m.sources.length > 0 && (
          <div className="mt-3">
            <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]"><BookOpen className="size-3.5" />Sources read</div>
            <div className="grid grid-cols-2 gap-1.5">
              {m.sources.map((s) => (
                <button key={s.n} onClick={() => onSource(s)} className={cx("flex items-start gap-2 rounded-xl border p-2.5 text-left transition cursor-pointer", active?.n === s.n ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]" : "border-[var(--color-border)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)]")}>
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-[var(--color-accent-soft)] text-[11px] font-semibold text-[var(--color-accent)]">{s.n}</span>
                  <span className="min-w-0"><span className="block truncate text-[12.5px] font-medium">{s.name}</span><span className="block truncate text-[11.5px] text-[var(--color-text-faint)]">{s.page ? `Page ${s.page} · ` : ""}{s.folder}</span></span>
                </button>
              ))}
            </div>
          </div>
        )}
        {m.meta && !m.pending && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-[var(--color-text-faint)]">
            {m.meta.model && <Pill color="var(--color-text-muted)"><Brain className="size-3" />{m.meta.model}</Pill>}
            {m.meta.read != null && <span>read {m.meta.read} documents</span>}
            {m.meta.ms != null && <span>· {(m.meta.ms / 1000).toFixed(1)} s</span>}
            {m.meta.input_tokens != null && <span>· {m.meta.input_tokens.toLocaleString()} in / {m.meta.output_tokens?.toLocaleString()} out tokens</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function SourcePane({ s, onClose }: { s: Source; onClose: () => void }) {
  const toast = useToast();
  const isPdf = s.name.toLowerCase().endsWith(".pdf");
  return (
    <aside className="flex w-[520px] shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] animate-[var(--animate-fade)]">
      <div className="flex items-start gap-2 border-b border-[var(--color-border)] px-4 py-3">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-[var(--color-accent)] text-[12px] font-semibold text-[var(--color-accent-fg)]">{s.n}</span>
        <div className="min-w-0 flex-1">
          <div className="break-words text-[13.5px] font-semibold">{s.name}</div>
          <div className="truncate text-[12px] text-[var(--color-text-faint)]">{s.page ? `Page ${s.page} · ` : ""}{s.folder}</div>
        </div>
        <IconButton label="Open" onClick={() => api("file.open", { id: s.file_id, mode: "copy" }).catch((e) => toast("error", e.message))}><ExternalLink className="size-4" /></IconButton>
        <IconButton label="Close" onClick={onClose}><X className="size-4" /></IconButton>
      </div>
      <div className="border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3">
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">Passage used</div>
        <div className="max-h-36 overflow-y-auto text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">{s.snippet}</div>
      </div>
      <div className="min-h-0 flex-1">
        {isPdf ? <iframe key={`${s.file_id}-${s.page}`} src={`${fileUrl(s.file_id)}#page=${s.page ?? 1}&view=FitH`} className="h-full w-full border-0" title={s.name} /> : <Empty icon={<FileText className="size-5" />} title="Open the file to see it in full" />}
      </div>
    </aside>
  );
}

function NewLibrary({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (l: LibrarySummary) => void }) {
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<{ total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => { if (open) { setName(""); setQuery(""); setPreview(null); } }, [open]);
  useEffect(() => {
    const t = setTimeout(() => { if (query.trim()) api<{ total: number }>("search", { query, limit: 1 }).then(setPreview).catch(() => setPreview(null)); else setPreview(null); }, 250);
    return () => clearTimeout(t);
  }, [query]);
  const create = async () => {
    setBusy(true);
    try { onDone(await api<LibrarySummary>("library.create", { name, query })); } catch (e) { toast("error", (e as Error).message); } finally { setBusy(false); }
  };
  const limit = useMemo(() => Math.min(preview?.total ?? 0, 300), [preview]);
  return (
    <Modal open={open} onClose={onClose} title="New knowledge library" subtitle="A named set of THOR documents to ask focused questions about." footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!name.trim() || !preview?.total} onClick={create}>Create library</Button></>}>
      <div className="space-y-4">
        <label className="block"><div className="mb-1.5 text-[12.5px] font-medium text-[var(--color-text-muted)]">Name</div><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Crude unit P&IDs" autoFocus /></label>
        <label className="block"><div className="mb-1.5 text-[12.5px] font-medium text-[var(--color-text-muted)]">Documents matching this search</div><Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. crude p&id   or   5610.15 inspection" icon={<Search className="size-4" />} /></label>
        <div className="rounded-xl bg-[var(--color-surface-2)] p-3 text-[13px] text-[var(--color-text-muted)]">
          {preview ? <>The library will hold the top <b className="text-[var(--color-text)]">{limit}</b> of {preview.total.toLocaleString()} matching documents (photos excluded). You can add single files from search results later.</> : "Type a search to see how many documents it would include."}
        </div>
      </div>
    </Modal>
  );
}
