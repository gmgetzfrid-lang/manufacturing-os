"use client";

// RightPanel — the on-demand column. Anything you read for longer than a
// glance lives here instead of the stream: a cited page (the viewer,
// docked), a past answer under review, an attachment, and the
// instructions for this conversation plus your own standing profile.

import React, { useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import {
  X, Maximize2, History, SlidersHorizontal, Paperclip, FileText, AlertTriangle, Redo2, Save, ArrowUpToLine, Loader2, CheckCircle2,
} from "lucide-react";
import type { ChatThread, PastAnswer, ChatProfile, ChatAttachment } from "@/lib/chatClient";
import { attachmentUrl } from "@/lib/chatClient";
import type { KnowledgeLibrary, KnowledgeCitation } from "@/lib/knowledge";
import type { CitedSource } from "@/components/knowledge/CitedPageViewer";
import { AnswerExperience, AnswerView, CitationChips } from "@/components/knowledge/answer/AnswerExperience";
import AssistantAnswer from "@/components/assistant/AssistantAnswer";
import { AttachmentCard } from "./Turns";
import { relativeTime, fmtBytes } from "./shared";

const CitedPageViewer = dynamic(() => import("@/components/knowledge/CitedPageViewer"), { ssr: false });

export interface ViewerTarget {
  fileKey: string;
  page: number;
  quote: string | null;
  title: string;
  section?: string | null;
  documentId?: string;
  tags?: string[];
  sources?: CitedSource[];
  sourceIndex?: number;
}

export type PanelState =
  | { kind: "viewer"; target: ViewerTarget }
  | { kind: "review"; past: PastAnswer; changed: string[] | null }
  | { kind: "attachment"; att: ChatAttachment }
  | { kind: "instructions" };

export default function RightPanel({
  state, onClose, orgId, thread, libraries, canPromote,
  instructions, onSaveInstructions, profile, onSaveProfile, standingCount,
  onPromote, onReuse, onCite,
}: {
  state: PanelState;
  onClose: () => void;
  orgId: string;
  thread: ChatThread | null;
  libraries: KnowledgeLibrary[];
  canPromote: boolean;
  instructions: string;
  onSaveInstructions: (text: string) => Promise<void>;
  profile: ChatProfile;
  onSaveProfile: (p: ChatProfile) => Promise<void>;
  standingCount: number;
  onPromote: (text: string) => Promise<void>;
  onReuse: (past: PastAnswer) => void;
  onCite: (c: KnowledgeCitation) => void;
}) {
  const [popped, setPopped] = useState(false);

  const header = (title: string, Icon: React.ComponentType<{ className?: string }>, extra?: React.ReactNode) => (
    <div className="h-11 px-3 border-b border-[var(--color-border)] flex items-center gap-2 shrink-0">
      <Icon className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
      <span className="text-xs font-black text-[var(--color-text)] truncate flex-1">{title}</span>
      {extra}
      <button onClick={onClose} title="Close panel" className="p-1 rounded-md text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
        <X className="w-4 h-4" />
      </button>
    </div>
  );

  if (state.kind === "viewer") {
    const t = state.target;
    if (popped) {
      return (
        <CitedPageViewer
          fileKey={t.fileKey} page={t.page} quote={t.quote} title={t.title} section={t.section}
          orgId={orgId} documentId={t.documentId} tags={t.tags} sources={t.sources} initialIndex={t.sourceIndex}
          onClose={() => setPopped(false)}
        />
      );
    }
    return (
      <div className="h-full flex flex-col">
        {header(t.title.replace(/\.pdf$/i, ""), FileText, (
          <button onClick={() => setPopped(true)} title="Open large" className="p-1 rounded-md text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
            <Maximize2 className="w-4 h-4" />
          </button>
        ))}
        <div className="flex-1 min-h-0">
          <CitedPageViewer
            key={`${t.fileKey}:${t.page}:${t.sourceIndex ?? 0}`}
            embedded
            fileKey={t.fileKey} page={t.page} quote={t.quote} title={t.title} section={t.section}
            orgId={orgId} documentId={t.documentId} tags={t.tags} sources={t.sources} initialIndex={t.sourceIndex}
            onClose={onClose}
          />
        </div>
      </div>
    );
  }

  if (state.kind === "review") {
    const { past, changed } = state;
    const payload = past.payload;
    return (
      <div className="h-full flex flex-col">
        {header("Asked before", History)}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <div className="text-[11px] text-[var(--color-text-muted)]">
            {(past.userName ?? "Someone").split("@")[0]} asked {relativeTime(past.createdAt)} ago
            {past.threadTitle ? <> in <Link className="font-bold hover:underline" href={`/assistant?thread=${past.threadId}`}>{past.threadTitle}</Link></> : null}
          </div>
          <div className="rounded-xl bg-[var(--color-surface-2)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)]">{past.question}</div>
          {changed && changed.length > 0 && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-[11px] font-bold text-amber-800 dark:text-amber-300">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
              <span>The sources moved on since this was answered: {changed.join("; ")}. Ask fresh to be safe.</span>
            </div>
          )}
          {payload.kind === "tools" ? (
            <AssistantAnswer answer={past.answer} mentionedDocs={payload.mentionedDocs} />
          ) : payload.mode === "internet" ? (
            <>
              <AnswerView answer={past.answer} citations={payload.citations ?? []} onCite={onCite} />
              <CitationChips citations={payload.citations ?? []} onOpen={onCite} />
            </>
          ) : (
            <AnswerExperience question={past.question} showQuestion={false}
              answer={{ ...payload, answer: past.answer, provider: "memory", model: "past answer" }}
              onCite={onCite} />
          )}
        </div>
        <div className="p-3 border-t border-[var(--color-border)] shrink-0">
          <button onClick={() => onReuse(past)}
            className="w-full inline-flex items-center justify-center gap-1.5 h-9 rounded-lg bg-violet-600 text-white text-xs font-black hover:bg-violet-500 transition-colors">
            <Redo2 className="w-3.5 h-3.5" /> Use this answer here - no AI call
          </button>
        </div>
      </div>
    );
  }

  if (state.kind === "attachment") {
    return <AttachmentPane att={state.att} header={header} />;
  }

  return (
    <InstructionsPane
      header={header} thread={thread} libraries={libraries} canPromote={canPromote}
      instructions={instructions} onSaveInstructions={onSaveInstructions}
      profile={profile} onSaveProfile={onSaveProfile} standingCount={standingCount} onPromote={onPromote}
    />
  );
}

function AttachmentPane({ att, header }: {
  att: ChatAttachment;
  header: (title: string, Icon: React.ComponentType<{ className?: string }>, extra?: React.ReactNode) => React.ReactNode;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void attachmentUrl(att.path).then((u) => { if (!cancelled) setUrl(u); }, () => undefined);
    return () => { cancelled = true; };
  }, [att.path]);
  return (
    <div className="h-full flex flex-col">
      {header(att.name, Paperclip)}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        <p className="text-[11px] text-[var(--color-text-muted)]">
          {fmtBytes(att.size)} · context for that question only - not indexed, not a controlled document.
        </p>
        {att.kind === "image" ? (
          <AttachmentCard a={att} onOpen={() => { if (url) window.open(url, "_blank", "noopener"); }} large />
        ) : url ? (
          <iframe src={url} title={att.name} className="w-full h-[70vh] rounded-lg border border-[var(--color-border)] bg-white" />
        ) : (
          <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
        )}
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer" className="inline-block text-[11px] font-black text-[var(--color-accent)] hover:underline">Open in a new tab</a>
        )}
      </div>
    </div>
  );
}

function InstructionsPane({
  header, thread, libraries, canPromote, instructions, onSaveInstructions, profile, onSaveProfile, standingCount, onPromote,
}: {
  header: (title: string, Icon: React.ComponentType<{ className?: string }>, extra?: React.ReactNode) => React.ReactNode;
  thread: ChatThread | null;
  libraries: KnowledgeLibrary[];
  canPromote: boolean;
  instructions: string;
  onSaveInstructions: (text: string) => Promise<void>;
  profile: ChatProfile;
  onSaveProfile: (p: ChatProfile) => Promise<void>;
  standingCount: number;
  onPromote: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState(instructions);
  const [prof, setProf] = useState<ChatProfile>(profile);
  const [saving, setSaving] = useState<"instructions" | "profile" | "promote" | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => { setText(instructions); }, [instructions]);
  useEffect(() => { setProf(profile); }, [profile]);

  const flash = (what: string) => { setSaved(what); setTimeout(() => setSaved(null), 1800); };
  const field = "w-full px-3 py-2 text-xs rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-ring)]";

  return (
    <div className="h-full flex flex-col">
      {header("Instructions", SlidersHorizontal)}
      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        <section>
          <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-1">This conversation</div>
          <p className="text-[11px] text-[var(--color-text-muted)] mb-2">
            Applied to every answer in this conversation only. {thread ? "" : "Saved once the conversation starts."}
          </p>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5}
            placeholder={'e.g. "Answer in SI units. Treat EP 5-5-1 as governing. Keep it to the piping class."'}
            className={`${field} resize-y min-h-[88px]`} />
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <button disabled={saving !== null || text === instructions}
              onClick={async () => { setSaving("instructions"); try { await onSaveInstructions(text); flash("instructions"); } finally { setSaving(null); } }}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-40 transition-colors">
              {saving === "instructions" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save
            </button>
            {canPromote && text.trim() && (
              <button disabled={saving !== null}
                title="Make this a standing instruction for everyone's library answers (Org Playbook)"
                onClick={async () => { setSaving("promote"); try { await onPromote(text.trim()); flash("promote"); } finally { setSaving(null); } }}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-violet-300 dark:border-violet-800 text-violet-700 dark:text-violet-300 text-[11px] font-black hover:bg-violet-500/10 disabled:opacity-40 transition-colors">
                {saving === "promote" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowUpToLine className="w-3.5 h-3.5" />} Promote to playbook
              </button>
            )}
            {saved && <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="w-3.5 h-3.5" /> Saved</span>}
          </div>
        </section>

        <section>
          <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-1">Standing instructions</div>
          <p className="text-[11px] text-[var(--color-text-muted)]">
            {standingCount > 0
              ? <>{standingCount} org playbook instruction{standingCount === 1 ? "" : "s"} appl{standingCount === 1 ? "ies" : "y"} to every library answer. </>
              : <>No org playbook instructions yet. </>}
            <Link href="/admin/ai-instructions" className="font-bold text-violet-700 dark:text-violet-300 hover:underline">Open playbooks</Link>
          </p>
        </section>

        <section>
          <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-1">About you</div>
          <p className="text-[11px] text-[var(--color-text-muted)] mb-2">
            Your own standing profile, sent with every question you ask. Plain text you can read and change - nothing is inferred.
          </p>
          <div className="space-y-2">
            <input value={prof.discipline} onChange={(e) => setProf({ ...prof, discipline: e.target.value })}
              placeholder="Discipline - e.g. Mechanical / rotating equipment" className={field} />
            <input value={prof.units} onChange={(e) => setProf({ ...prof, units: e.target.value })}
              placeholder="Preferred units - e.g. US customary, SI" className={field} />
            <select value={prof.defaultLibraryId ?? ""} onChange={(e) => setProf({ ...prof, defaultLibraryId: e.target.value || null })}
              className={field}>
              <option value="">Default library - none</option>
              {libraries.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <textarea value={prof.notes} onChange={(e) => setProf({ ...prof, notes: e.target.value })} rows={3}
              placeholder="Anything every answer should know - e.g. &quot;I work the crude unit; assume carbon steel unless told.&quot;"
              className={`${field} resize-y`} />
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button disabled={saving !== null}
              onClick={async () => { setSaving("profile"); try { await onSaveProfile(prof); flash("profile"); } finally { setSaving(null); } }}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-40 transition-colors">
              {saving === "profile" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save profile
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
