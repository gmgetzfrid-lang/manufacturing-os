"use client";

// AskControls — the controls under every question box, the same everywhere
// someone can ask (the chat, a library's page, the dashboard card):
//
//   Sources ▾  where answers come from — a library (with "also search the
//              web" inside it), system tools, or the internet only
//   Answer ▾   how to answer — its shape (Auto, Direct, Compliance,
//              Deviation, Explore) and the Reasoning Skills that ride on
//              this question, each switchable, with what it does
//   SkillHint  as you type, which skills will kick in for this question
//
// Skills are the workspace's own (Skill Library); picking here changes only
// this question. Leaving them alone keeps the workspace's defaults.

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, Globe, Sparkles, SlidersHorizontal, Check, BookOpen, Bot, Wand2 } from "lucide-react";
import { ANSWER_MODES, AUTO_MODE_HINT, type AnswerMode } from "@/lib/answerModes";
import { skillFits } from "@/lib/answerSkillsData";
import type { AnswerSkill } from "@/lib/answerSkills";
import type { KnowledgeLibrary } from "@/lib/knowledge";
import type { ChatScope } from "@/lib/chatClient";

/** The workspace's skills this member can see (built-ins seeded on first use). */
export function useAnswerSkills(orgId: string | null): AnswerSkill[] | null {
  const [skills, setSkills] = useState<AnswerSkill[] | null>(null);
  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    void (async () => {
      const m = await import("@/lib/answerSkills");
      const { supabase } = await import("@/lib/supabase");
      const { data } = await supabase.auth.getUser();
      // Seeding the built-ins is background work: a failure only means the
      // list below shows what's already there.
      if (data.user) await m.seedBuiltinAnswerSkills(orgId, data.user.id).catch((e: unknown) => console.warn("[skills] seed failed", e));
      const list = await m.listAnswerSkills(orgId).catch((e: unknown) => { console.warn("[skills] list failed", e); return null; });
      if (!cancelled) setSkills(list ?? []);
    })();
    return () => { cancelled = true; };
  }, [orgId]);
  return skills;
}

/** Ids on for this question: the picked set, else the workspace's enabled. */
export const skillsOn = (skills: AnswerSkill[] | null, picked: string[] | null) =>
  picked ?? (skills ?? []).filter((s) => s.enabled).map((s) => s.id);

function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, close]);
  return ref;
}

/** A menu button under the question box: a white, ruled secondary button. */
const pill = "h-8 inline-flex items-center gap-1.5 px-2.5 rounded-md text-[13px] font-semibold whitespace-nowrap border transition-colors";

// ─── Sources ─────────────────────────────────────────────────────────

export function SourcesMenu({ scope, libraryId, libraries, onScopeChange, scopeLocked, webOn, onToggleWeb, fixedLibrary, librariesOnly, down }: {
  scope: ChatScope;
  libraryId: string | null;
  libraries: KnowledgeLibrary[];
  onScopeChange?: (scope: ChatScope, libraryId: string | null) => void;
  scopeLocked?: boolean;
  webOn: boolean;
  onToggleWeb: () => void;
  /** Asking from a library's own page: the library is fixed; only web toggles. */
  fixedLibrary?: string;
  /** Libraries (and web) only — no system tools or internet-only. */
  librariesOnly?: boolean;
  /** Open below the button (for controls at the top of a card). */
  down?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  const libName = fixedLibrary ?? (scope !== "tools" ? libraries.find((l) => l.id === libraryId)?.name ?? "Pick a library" : null);
  const label = scope === "tools" ? "System tools" : scope === "internet" ? "Internet only" : `${libName}${webOn ? " + web" : ""}`;
  const Icon = scope === "tools" ? Bot : scope === "internet" ? Globe : BookOpen;
  const tone = "border-[var(--color-border-strong)] text-[var(--color-text)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)]";
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}
        title="Where answers come from" className={`${pill} max-w-[136px] sm:max-w-[280px] ${tone}`}>
        <Icon className="w-3.5 h-3.5 shrink-0" /> <span className="truncate">{label}</span>
        {webOn && scope === "library" && <Globe className="w-3 h-3 shrink-0" />}
        <ChevronDown className="w-3 h-3 shrink-0 opacity-70" />
      </button>
      {open && (
        <div className={`absolute left-0 ${down ? "top-10" : "bottom-10"} z-50 w-80 max-w-[90vw] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] ui-float ui-float-in p-1.5`}>
          <Head>Where answers come from</Head>
          {scopeLocked && <div className="px-2 pb-1 text-[13px] text-[var(--color-text-muted)]">Picking another source starts a new conversation</div>}
          {fixedLibrary ? (
            <Item active label={fixedLibrary} sub="This library's documents, cited to the page" icon={BookOpen} />
          ) : (
            <div className="max-h-44 overflow-y-auto">
              {libraries.map((l) => (
                <Item key={l.id} active={scope === "library" && libraryId === l.id} icon={BookOpen} label={l.name}
                  sub={`${l.documentCount ?? 0} documents, cited to the page`}
                  onClick={() => { setOpen(false); onScopeChange?.("library", l.id); }} />
              ))}
            </div>
          )}
          {scope === "library" && (
            <button type="button" onClick={onToggleWeb} role="menuitemcheckbox" aria-checked={webOn}
              className="mt-1 w-full flex items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--color-surface-2)]">
              <Toggle on={webOn} />
              <span className="min-w-0">
                <span className="block text-[14px] font-semibold text-[var(--color-text)]">Also search the web</span>
                <span className="block text-[12px] text-[var(--color-text-muted)]">Your documents first, they govern. Every web statement links to its page.</span>
              </span>
            </button>
          )}
          {!fixedLibrary && !librariesOnly && onScopeChange && (
            <>
              <div className="my-1 h-px bg-[var(--color-border)]" />
              <Item active={scope === "tools"} icon={Bot} label="System tools" sub="Documents, equipment, audit history, P&ID traces"
                onClick={() => { setOpen(false); onScopeChange("tools", null); }} />
              <Item active={scope === "internet"} icon={Globe} label="Internet only" sub="Web and general knowledge, not your documents"
                onClick={() => { setOpen(false); onScopeChange("internet", libraryId ?? libraries[0]?.id ?? null); }} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Answer: shape + skills ──────────────────────────────────────────

export function AnswerMenu({ answerMode, onAnswerMode, skills, picked, onPick, question, instructionCount, onOpenInstructions, down }: {
  answerMode: AnswerMode | null;
  onAnswerMode: (m: AnswerMode | null) => void;
  skills: AnswerSkill[] | null;
  /** Skills picked for this question; null = the workspace's defaults. */
  picked: string[] | null;
  onPick: (ids: string[] | null) => void;
  question: string;
  instructionCount?: number;
  onOpenInstructions?: () => void;
  down?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  const on = skillsOn(skills, picked);
  const modeLabel = answerMode ? ANSWER_MODES.find((m) => m.id === answerMode)?.label ?? "Auto" : "Auto";
  const toggle = (id: string) => onPick(on.includes(id) ? on.filter((x) => x !== id) : [...on, id]);
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}
        title="How to answer: the answer's shape and the skills it uses"
        className={`${pill} border-[var(--color-border-strong)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] ${answerMode || picked ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
        <Sparkles className="w-3.5 h-3.5" /> {modeLabel}<span className="max-sm:hidden"> · {on.length} skill{on.length === 1 ? "" : "s"}</span> <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div className={`absolute ${down ? "right-0 top-10" : "left-0 bottom-10"} z-50 w-[22rem] max-w-[90vw] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] ui-float ui-float-in p-1.5 max-h-[70vh] overflow-y-auto`}>
          <Head>Shape of the answer</Head>
          {[{ id: null as AnswerMode | null, label: "Auto", hint: AUTO_MODE_HINT }, ...ANSWER_MODES].map((m) => (
            <button key={m.id ?? "auto"} type="button" role="menuitemradio" aria-checked={answerMode === m.id}
              onClick={() => onAnswerMode(m.id)}
              className={`w-full text-left px-2 py-1.5 rounded-md flex items-start gap-2 hover:bg-[var(--color-surface-2)] ${answerMode === m.id ? "bg-[var(--color-surface-2)]" : ""}`}>
              <span className="w-3.5 mt-0.5 shrink-0">{answerMode === m.id && <Check className="w-3.5 h-3.5 text-[var(--color-text)]" />}</span>
              <span className="min-w-0"><span className="block text-[14px] font-semibold text-[var(--color-text)]">{m.label}</span>
                <span className="block text-[12px] text-[var(--color-text-muted)]">{m.hint}</span></span>
            </button>
          ))}
          <div className="my-1.5 h-px bg-[var(--color-border)]" />
          <div className="flex items-center justify-between pr-1">
            <Head>Skills for this question</Head>
            {picked && <button type="button" onClick={() => onPick(null)} className="text-[13px] text-[var(--color-accent-text)] hover:underline">Back to workspace defaults</button>}
          </div>
          <div className="px-2 pb-1 text-[12px] text-[var(--color-text-muted)]">A skill applies itself when the question fits what you typed.</div>
          {skills === null && <div className="px-2 py-1.5 text-[12px] text-[var(--color-text-muted)]">Loading skills…</div>}
          {[...(skills ?? [])].sort((a, b) => Number(skillFits(b, question)) - Number(skillFits(a, question))).map((s) => {
            const fits = skillFits(s, question);
            return (
              <button key={s.id} type="button" role="menuitemcheckbox" aria-checked={on.includes(s.id)} onClick={() => toggle(s.id)}
                className="w-full text-left px-2 py-1.5 rounded-md flex items-start gap-2 hover:bg-[var(--color-surface-2)]">
                <Toggle on={on.includes(s.id)} />
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-[14px] font-semibold text-[var(--color-text)]">
                    {s.name}
                    {fits && <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--color-text)]"><span aria-hidden className="w-2 h-2 rounded-full bg-[var(--state-released)]" />Fits</span>}
                    {s.visibility === "private" && <span className="text-[12px] font-normal text-[var(--color-text-muted)]">Yours</span>}
                  </span>
                  {s.description && <span className="block text-[12px] text-[var(--color-text-muted)] line-clamp-2">{s.description}</span>}
                </span>
              </button>
            );
          })}
          <div className="my-1.5 h-px bg-[var(--color-border)]" />
          <div className="flex items-center justify-between gap-2 px-2 py-1 text-[13px]">
            <Link href="/intelligence/skills" className="inline-flex items-center gap-1 text-[var(--color-accent-text)] hover:underline"><Wand2 className="w-3.5 h-3.5" /> Write your own skill</Link>
            {onOpenInstructions && (
              <button type="button" onClick={() => { setOpen(false); onOpenInstructions(); }} className="inline-flex items-center gap-1 text-[var(--color-accent-text)] hover:underline">
                <SlidersHorizontal className="w-3.5 h-3.5" /> Instructions{instructionCount ? ` (${instructionCount})` : ""}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** As you type: which skills will kick in, so their help is never a secret. */
export function SkillHint({ skills, picked, question, answerMode }: { skills: AnswerSkill[] | null; picked: string[] | null; question: string; answerMode?: AnswerMode | null }) {
  const on = new Set(skillsOn(skills, picked));
  const fit = (skills ?? []).filter((s) => on.has(s.id) && skillFits(s, question));
  const off = (skills ?? []).filter((s) => !on.has(s.id) && skillFits(s, question));
  if (fit.length === 0 && off.length === 0 && !answerMode) return null;
  return (
    <div className="flex items-center gap-x-3 gap-y-0.5 flex-wrap text-[12px] text-[var(--color-text-muted)]">
      {fit.length > 0 && <span className="inline-flex items-center gap-1"><Sparkles className="w-3 h-3" /> Will apply: {fit.map((s) => <b key={s.id} className="font-semibold text-[var(--color-text)]">{s.name}</b>).reduce<React.ReactNode[]>((a, x, i) => (i ? [...a, ", ", x] : [x]), [])}</span>}
      {off.length > 0 && <span className="text-[var(--color-text-faint)]">Fits but switched off: {off.map((s) => s.name).join(", ")}</span>}
      {answerMode && <span>Shape: <b className="font-semibold text-[var(--color-text)]">{ANSWER_MODES.find((m) => m.id === answerMode)?.label}</b></span>}
    </div>
  );
}

function Head({ children }: { children: React.ReactNode }) {
  return <div className="px-2 pt-1 pb-0.5 text-[13px] font-semibold text-[var(--color-text-muted)]">{children}</div>;
}

function Toggle({ on }: { on: boolean }) {
  return (
    <span className={`mt-0.5 shrink-0 inline-flex w-7 h-4 rounded-full transition-colors ${on ? "bg-[var(--color-text)]" : "bg-[var(--color-border-strong)]"}`}>
      <span className={`m-0.5 w-3 h-3 rounded-full bg-[var(--color-surface)] transition-transform ${on ? "translate-x-3" : ""}`} />
    </span>
  );
}

function Item({ active, icon: Icon, label, sub, onClick }: {
  active: boolean; icon: React.ComponentType<{ className?: string }>; label: string; sub?: string; onClick?: () => void;
}) {
  return (
    <button type="button" onClick={onClick} disabled={!onClick}
      className={`w-full flex items-start gap-2.5 px-2 py-1.5 rounded-md text-left ${active ? "bg-[var(--color-accent-soft)]" : "hover:bg-[var(--color-surface-2)]"}`}>
      <span aria-hidden className={`ui-icon-tile is-sm ${active ? "is-solid" : ""}`}><Icon className="w-4 h-4" /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-semibold text-[var(--color-text)] truncate">{label}</span>
        {sub && <span className="block text-[12px] text-[var(--color-text-muted)] truncate">{sub}</span>}
      </span>
    </button>
  );
}
