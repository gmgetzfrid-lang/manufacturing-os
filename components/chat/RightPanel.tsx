"use client";

// RightPanel — the on-demand column. Anything you read for longer than a
// glance lives here instead of the stream: a cited page (the viewer,
// docked), a past answer under review, an attachment, and the
// instructions for this conversation plus your own standing profile.
// Each pane opens the same way: where you are in small caps, the thing's
// name big, one line of its state, then the content; at most one orange.

import React, { useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import {
  X, AlertTriangle, Redo2, Save, ArrowUpToLine, Loader2, CheckCircle2,
} from "lucide-react";
import type { ChatThread, PastAnswer, ChatProfile, ChatAttachment } from "@/lib/chatClient";
import { attachmentUrl } from "@/lib/chatClient";
import type { KnowledgeLibrary, KnowledgeCitation } from "@/lib/knowledge";
import type { CitedSource } from "@/components/knowledge/CitedPageViewer";
import { AnswerExperience, AnswerView, CitationChips } from "@/components/knowledge/answer/AnswerExperience";
import AssistantAnswer from "@/components/assistant/AssistantAnswer";
import { AttachmentCard } from "./Turns";
import { fmtBytes } from "./shared";

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

  const header: PaneHeader = (kicker, title, sub) => (
    <div className="px-5 pt-4 pb-4 border-b border-[var(--color-border)] shrink-0">
      <div className="flex items-center gap-2 min-h-9">
        <div className="min-w-0 flex-1 truncate text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">{kicker}</div>
        <button onClick={onClose} title="Close panel" aria-label="Close panel" className="w-9 h-9 grid place-items-center rounded-[10px] bg-[var(--color-surface-2)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
          <X className="w-4 h-4" />
        </button>
      </div>
      <h2 className="mt-1.5 text-[26px] leading-[1.1] font-black tracking-[-0.02em] text-[var(--color-text)] line-clamp-2 break-words">{title}</h2>
      {sub && <div className="mt-1.5 text-[13.5px] text-[var(--color-text-muted)]">{sub}</div>}
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
    // The viewer draws its own panel header (where you are, the document's
    // name, the page) so nothing is said twice.
    return (
      <div className="h-full">
        <CitedPageViewer
          key={`${t.fileKey}:${t.page}:${t.sourceIndex ?? 0}`}
          embedded
          fileKey={t.fileKey} page={t.page} quote={t.quote} title={t.title} section={t.section}
          orgId={orgId} documentId={t.documentId} tags={t.tags} sources={t.sources} initialIndex={t.sourceIndex}
          onClose={onClose} onExpand={() => setPopped(true)}
        />
      </div>
    );
  }

  if (state.kind === "review") {
    const { past, changed } = state;
    const payload = past.payload;
    return (
      <div className="h-full flex flex-col">
        {header("Asked before",
          changed && changed.length > 0 ? "Its sources changed." : "Answered before.",
          <>
            {(past.userName ?? "Someone").split("@")[0]} asked on {new Date(past.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
            {past.threadTitle ? <> in <Link className="font-bold text-[var(--color-text)] hover:underline" href={`/assistant?thread=${past.threadId}`}>{past.threadTitle}</Link></> : null}
          </>)}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <div className="rounded-2xl rounded-tr-md bg-[var(--color-surface-2)] px-4 py-2.5 text-[14.5px] leading-relaxed text-[var(--color-text)]">{past.question}</div>
          {changed && changed.length > 0 && (
            <div className="flex items-start gap-2 text-[13px] font-semibold text-amber-800 dark:text-amber-300">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
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
        <div className="px-5 py-3.5 border-t border-[var(--color-border)] shrink-0">
          <button onClick={() => onReuse(past)}
            className="w-full inline-flex items-center justify-center gap-2 h-11 rounded-xl bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[14px] font-extrabold hover:bg-[var(--color-accent-hover)] shadow-[0_12px_24px_-12px_var(--color-accent)] transition-colors">
            <Redo2 className="w-4 h-4" /> Use this answer here (no AI call)
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

/** Where you are, the thing's name (big), and one line of its state. */
type PaneHeader = (kicker: React.ReactNode, title: React.ReactNode, sub?: React.ReactNode) => React.ReactNode;

function AttachmentPane({ att, header }: {
  att: ChatAttachment;
  header: PaneHeader;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void attachmentUrl(att.path).then((u) => { if (!cancelled) setUrl(u); }, (e: unknown) => { if (!cancelled) setFailed(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [att.path]);
  return (
    <div className="h-full flex flex-col">
      {header(`Attachment · ${att.kind === "image" ? "Image" : "PDF"}`, att.name,
        `${fmtBytes(att.size)} · for that question only. Not indexed, not a controlled document.`)}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        {att.kind === "image" ? (
          <AttachmentCard a={att} onOpen={() => { if (url) window.open(url, "_blank", "noopener"); }} large />
        ) : url ? (
          <iframe src={url} title={att.name} className="w-full h-[70vh] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]" />
        ) : failed ? (
          <p role="alert" className="flex items-start gap-2 text-[13.5px] font-semibold text-rose-700 dark:text-rose-400"><AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> Couldn&apos;t open the file: {failed}</p>
        ) : (
          <div className="flex items-center gap-2 text-[13.5px] text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin" /> Loading the file…</div>
        )}
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer" className="inline-block text-[13px] font-bold text-[var(--color-accent)] hover:underline">Open in a new tab</a>
        )}
      </div>
    </div>
  );
}

function InstructionsPane({
  header, thread, libraries, canPromote, instructions, onSaveInstructions, profile, onSaveProfile, standingCount, onPromote,
}: {
  header: PaneHeader;
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
  const [saveError, setSaveError] = useState<{ what: string; msg: string } | null>(null);
  // Every save says when it didn't go through, in place.
  const run = async (what: "instructions" | "profile" | "promote", fn: () => Promise<void>) => {
    setSaving(what); setSaveError(null);
    try { await fn(); flash(what); }
    catch (e) { setSaveError({ what, msg: e instanceof Error ? e.message : String(e) }); }
    finally { setSaving(null); }
  };
  useEffect(() => { setText(instructions); }, [instructions]);
  useEffect(() => { setProf(profile); }, [profile]);

  const flash = (what: string) => { setSaved(what); setTimeout(() => setSaved(null), 1800); };
  const field = "w-full px-3 py-2 text-[13.5px] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none focus:border-[var(--color-border-strong)] focus:ring-2 focus:ring-[var(--color-border)]";
  const label = "text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-muted)] mb-1";
  const own = instructions.trim() ? 1 : 0;
  const total = own + standingCount;

  return (
    <div className="h-full flex flex-col">
      {header("Instructions",
        total === 0 ? "None yet." : `${total} ${total === 1 ? "applies" : "apply"} here.`,
        `${own ? "This conversation has its own" : "Nothing set for this conversation"} · ${standingCount} from the org playbook`)}
      <div className="flex-1 overflow-y-auto px-5 divide-y divide-[var(--color-border)]">
        <section className="py-4">
          <label htmlFor="chat-instructions" className={`block ${label}`}>This conversation</label>
          <p className="text-[12.5px] text-[var(--color-text-muted)] mb-2">
            Applied to every answer in this conversation only. {thread ? "" : "Saved once the conversation starts."}
          </p>
          <textarea id="chat-instructions" value={text} onChange={(e) => setText(e.target.value)} rows={5}
            placeholder={'e.g. "Answer in SI units. Treat EP 5-5-1 as governing. Keep it to the piping class."'}
            className={`${field} resize-y min-h-[88px]`} />
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <button disabled={saving !== null || text === instructions}
              onClick={() => void run("instructions", () => onSaveInstructions(text))}
              className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[13px] font-extrabold hover:bg-[var(--color-accent-hover)] disabled:opacity-40 transition-colors">
              {saving === "instructions" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save
            </button>
            {canPromote && text.trim() && (
              <button disabled={saving !== null}
                title="Make this a standing instruction for everyone's library answers (Org Playbook)"
                onClick={() => void run("promote", () => onPromote(text.trim()))}
                className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text)] text-[13px] font-bold hover:bg-[var(--color-surface-2)] hover:border-[var(--color-border-strong)] disabled:opacity-40 transition-colors">
                {saving === "promote" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowUpToLine className="w-3.5 h-3.5" />} Promote to playbook
              </button>
            )}
            {saved && saved !== "profile" && <span className="inline-flex items-center gap-1 text-[12.5px] font-bold text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="w-4 h-4" /> Saved</span>}
          </div>
          {saveError && saveError.what !== "profile" && <p role="alert" className="mt-1.5 text-[12.5px] font-semibold text-rose-700 dark:text-rose-400">Not saved: {saveError.msg}</p>}
        </section>

        <section className="py-4">
          <div className={label}>Standing instructions</div>
          <p className="text-[13px] text-[var(--color-text-muted)]">
            {standingCount > 0
              ? <>{standingCount} org playbook instruction{standingCount === 1 ? "" : "s"} appl{standingCount === 1 ? "ies" : "y"} to every library answer. </>
              : <>No org playbook instructions yet. </>}
            <Link href="/admin/ai-instructions" className="font-bold text-[var(--color-accent)] hover:underline">Open playbooks</Link>
          </p>
        </section>

        <section className="py-4">
          <div className={label}>About you</div>
          <p className="text-[12.5px] text-[var(--color-text-muted)] mb-2">
            Sent with every question you ask. Nothing here is guessed.
          </p>
          <div className="space-y-2">
            <input value={prof.discipline} onChange={(e) => setProf({ ...prof, discipline: e.target.value })}
              aria-label="Discipline" placeholder="Discipline, e.g. Mechanical / rotating equipment" className={field} />
            <input value={prof.units} onChange={(e) => setProf({ ...prof, units: e.target.value })}
              aria-label="Preferred units" placeholder="Preferred units, e.g. US customary, SI" className={field} />
            <select value={prof.defaultLibraryId ?? ""} onChange={(e) => setProf({ ...prof, defaultLibraryId: e.target.value || null })}
              aria-label="Default library" className={field}>
              <option value="">Default library: none</option>
              {libraries.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <textarea value={prof.notes} onChange={(e) => setProf({ ...prof, notes: e.target.value })} rows={3}
              aria-label="Anything every answer should know"
              placeholder="Anything every answer should know, e.g. &quot;I work the crude unit; assume carbon steel unless told.&quot;"
              className={`${field} resize-y`} />
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button disabled={saving !== null}
              onClick={() => void run("profile", () => onSaveProfile(prof))}
              className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] text-[13px] font-bold hover:bg-[var(--color-surface-2)] hover:border-[var(--color-border-strong)] disabled:opacity-40 transition-colors">
              {saving === "profile" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save profile
            </button>
            {saved === "profile" && <span className="inline-flex items-center gap-1 text-[12.5px] font-bold text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="w-4 h-4" /> Saved</span>}
          </div>
          {saveError?.what === "profile" && <p role="alert" className="mt-1.5 text-[12.5px] font-semibold text-rose-700 dark:text-rose-400">Not saved: {saveError.msg}</p>}
        </section>
      </div>
    </div>
  );
}
