"use client";

// SkillStudio — where a member teaches the engine a new detector, with the
// AI as co-author.
//
// Phase 1 — DESCRIBE: say what your documents do in plain words ("our
// maintenance procedures call out work orders like WO-48122"). The member's
// own model drafts the whole skill — name, description, patterns, and a
// sample line per pattern. Or skip it and start blank; the AI is a
// co-author, never a gatekeeper.
//
// Phase 2 — PROVE & PUBLISH: the draft lands in an editor whose live tester
// runs the EXACT compiler the engine runs — what matches here is what the
// engine will match. Then choose sharing: org-wide or private. Either way a
// custom skill's findings only ever queue for review.

import React, { useMemo, useState } from "react";
import {
  X, Plus, Loader2, Sparkles, FlaskConical, CheckCircle2, AlertTriangle,
  Users, Lock, Wand2, PenLine, ArrowLeft,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { createLinkRule, testSkillPatterns, type LinkRuleVisibility } from "@/lib/linkRules";
import { createAnswerSkill } from "@/lib/answerSkills";

export type StudioKind = "connection" | "reasoning";

export default function SkillStudio({ orgId, userId, userName, kind = "connection", onClose, onCreated }: {
  orgId: string;
  userId: string;
  userName?: string;
  /** connection = pattern detector the engine runs; reasoning = instruction
   *  pack the AI carries when answering. */
  kind?: StudioKind;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [phase, setPhase] = useState<"describe" | "edit">("describe");
  const [describeText, setDescribeText] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [draftNote, setDraftNote] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [patternsRaw, setPatternsRaw] = useState("");
  const [sample, setSample] = useState("");
  const [visibility, setVisibility] = useState<LinkRuleVisibility>("org");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patterns = useMemo(
    () => patternsRaw.split("\n").map((p) => p.trim()).filter(Boolean),
    [patternsRaw],
  );
  const test = useMemo(
    () => (patterns.length > 0 ? testSkillPatterns(patterns, sample) : { matches: [], errors: [] }),
    [patterns, sample],
  );

  const draft = async () => {
    setDrafting(true); setError(null); setDraftNote(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/links/skill-assist", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token ?? ""}`,
        },
        body: JSON.stringify({ orgId, description: describeText, kind }),
        signal: AbortSignal.timeout(45_000),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Drafting failed.");
      setName(json.name || "");
      setDescription(json.description || "");
      if (kind === "reasoning") {
        setInstructions(json.instructions || "");
        setPhase("edit");
        return;
      }
      setPatternsRaw((json.patterns as string[]).join("\n"));
      setSample(((json.samples as string[]) ?? []).join("\n"));
      if (json.dropped > 0) {
        setDraftNote(`${json.dropped} drafted pattern${json.dropped === 1 ? "" : "s"} didn't compile and ${json.dropped === 1 ? "was" : "were"} dropped.`);
      }
      setPhase("edit");
    } catch (e) { setError((e as Error).message); }
    finally { setDrafting(false); }
  };

  const save = async () => {
    setSaving(true); setError(null);
    try {
      if (kind === "reasoning") {
        await createAnswerSkill({ orgId, name, description, instructions, visibility, userId, userName });
      } else {
        await createLinkRule({ orgId, name, description, patterns, visibility, userId, userName });
      }
      onCreated();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-lg max-h-[92vh] overflow-y-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="h-1.5 bg-gradient-to-r from-violet-500 via-fuchsia-500 to-violet-500 motion-safe:animate-[shimmer_6s_linear_infinite]" style={{ backgroundSize: "200% 100%" }} />
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border)]">
          {phase === "edit" && (
            <button onClick={() => setPhase("describe")} title="Back to the description"
              className="p-1 rounded-lg text-[var(--color-text-faint)] hover:text-[var(--color-text)]">
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          <Sparkles className="w-4 h-4 text-violet-600" />
          <div className="flex-1">
            <div className="text-sm font-black text-[var(--color-text)]">
              {phase === "describe"
                ? (kind === "reasoning" ? "New reasoning skill" : "New connection skill")
                : (kind === "reasoning" ? "Refine it, then publish" : "Prove it, then publish")}
            </div>
            <div className="text-[11px] text-[var(--color-text-muted)]">
              {phase === "describe"
                ? (kind === "reasoning"
                  ? "Teach the AI a discipline for HOW it answers — when it applies, and what it must do."
                  : "Teach the engine how YOUR facility's documents reference each other.")
                : (kind === "reasoning"
                  ? "The pack must open with APPLIES WHEN — it rides every question and gates itself."
                  : "The tester runs the exact compiler the engine runs — what matches here is what it will match.")}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-[var(--color-text-faint)] hover:text-[var(--color-text)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        {phase === "describe" ? (
          <div className="p-4 space-y-3">
            <textarea
              value={describeText}
              onChange={(e) => setDescribeText(e.target.value)}
              rows={4}
              placeholder={kind === "reasoning"
                ? 'Describe the discipline in your own words…\n\ne.g. "When someone asks about torque values, always state the lubrication condition the value assumes and warn if the passage does not say."'
                : 'Describe the connection in your own words…\n\ne.g. "Our maintenance procedures reference work orders like WO-48122, and inspection reports cite permits written as PTW-2024-0113."'}
              className="w-full px-3 py-2.5 rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-sm leading-relaxed"
            />
            {error && (
              <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 dark:bg-rose-950/40 px-2.5 py-2 text-[11px] text-rose-700 dark:text-rose-300">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
              </div>
            )}
            <div className="flex items-center gap-2">
              <button onClick={() => void draft()} disabled={drafting || describeText.trim().length < 8}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-xl text-xs font-black text-white bg-violet-600 hover:bg-violet-500 disabled:opacity-50">
                {drafting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                {drafting ? "Drafting with your model…" : "Draft it with AI"}
              </button>
              <button onClick={() => setPhase("edit")}
                className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl text-xs font-bold text-[var(--color-text-muted)] border border-[var(--color-border-strong)] hover:text-[var(--color-text)]">
                <PenLine className="w-3.5 h-3.5" /> Start blank
              </button>
            </div>
            <p className="text-[10px] text-[var(--color-text-faint)]">
              Drafting runs on your own AI key and lands in an editor — you publish, never the model.
            </p>
          </div>
        ) : (
          <div className="p-4 space-y-3">
            {draftNote && (
              <div className="text-[11px] text-amber-700 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-lg px-2.5 py-1.5">{draftNote}</div>
            )}
            <div>
              <label className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)}
                placeholder="Work order references"
                className="mt-1 w-full px-3 py-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-sm" />
            </div>
            <div>
              <label className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">
                {kind === "reasoning" ? "What it does" : "What it finds"}
              </label>
              <input value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder={kind === "reasoning"
                  ? "Torque answers always state the lubrication condition the value assumes."
                  : "Documents that call out a work order number connect to that work order's record."}
                className="mt-1 w-full px-3 py-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-sm" />
            </div>

            {kind === "reasoning" && (
              <div>
                <label className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">
                  The discipline — must open with when it applies
                </label>
                <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)}
                  placeholder={"APPLIES WHEN the question asks about torque values. Otherwise ignore this skill.\n- State the lubrication condition the value assumes.\n- Warn when the passage does not say."}
                  rows={7}
                  className="mt-1 w-full px-3 py-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-sm leading-relaxed" />
                {instructions.trim().length > 0 && !/applies when/i.test(instructions) && (
                  <div className="mt-1 text-[11px] text-amber-700">
                    Start with &ldquo;APPLIES WHEN …&rdquo; — the pack rides every question and must gate itself.
                  </div>
                )}
              </div>
            )}

            {kind === "connection" && (
            <div>
              <label className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">
                Patterns — one per line (regular expressions)
              </label>
              <textarea value={patternsRaw} onChange={(e) => setPatternsRaw(e.target.value)}
                placeholder={"\\bWO-\\d{5}\\b\n\\bPERMIT-\\d{4}\\b"}
                rows={3}
                className="mt-1 w-full px-3 py-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-sm font-mono" />
              {test.errors.length > 0 && (
                <div className="mt-1 text-[11px] text-rose-600">{test.errors[0]}</div>
              )}
            </div>
            )}

            {kind === "connection" && (
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/50 p-3">
              <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-1.5">
                <FlaskConical className="w-3.5 h-3.5 text-violet-600" /> Prove it on real text
              </div>
              <textarea value={sample} onChange={(e) => setSample(e.target.value)}
                placeholder="Paste a paragraph from one of your documents…"
                rows={3}
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-sm" />
              {sample && patterns.length > 0 && (
                <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                  {test.matches.length === 0 ? (
                    <span className="text-[11px] text-amber-700">No matches in this sample.</span>
                  ) : test.matches.map((m) => (
                    <span key={m} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-emerald-100 dark:bg-emerald-950/50 text-[11px] font-mono font-bold text-emerald-800 dark:text-emerald-300"
                      style={{ animation: "pop 0.2s var(--ease-fluid) both" }}>
                      <CheckCircle2 className="w-3 h-3" /> {m}
                    </span>
                  ))}
                </div>
              )}
            </div>
            )}

            <div>
              <label className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">Sharing</label>
              <div className="mt-1 flex items-center gap-2">
                <button type="button" onClick={() => setVisibility("org")}
                  className={`flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border text-[11px] font-black ${visibility === "org"
                    ? "border-violet-400 text-violet-700 bg-violet-50 dark:bg-violet-950/40"
                    : "border-[var(--color-border-strong)] text-[var(--color-text-muted)]"}`}>
                  <Users className="w-3.5 h-3.5" /> Share org-wide
                </button>
                <button type="button" onClick={() => setVisibility("private")}
                  className={`flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border text-[11px] font-black ${visibility === "private"
                    ? "border-violet-400 text-violet-700 bg-violet-50 dark:bg-violet-950/40"
                    : "border-[var(--color-border-strong)] text-[var(--color-text-muted)]"}`}>
                  <Lock className="w-3.5 h-3.5" /> Just me
                </button>
              </div>
              <p className="mt-1 text-[10px] text-[var(--color-text-faint)]">
                {kind === "reasoning"
                  ? "Org-wide rides every member's questions; private rides only yours. It shapes reasoning and reporting — never the citation or safety rules."
                  : "Either way its findings only ever QUEUE for review — custom skills never apply links by themselves."}
              </p>
            </div>

            {error && (
              <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 dark:bg-rose-950/40 px-2.5 py-2 text-[11px] text-rose-700 dark:text-rose-300">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button onClick={onClose} className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                Cancel
              </button>
              <button onClick={() => void save()}
                disabled={saving || !name.trim() || (kind === "reasoning"
                  ? instructions.trim().length < 40
                  : patterns.length === 0 || test.errors.length > 0)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-black text-white bg-violet-600 hover:bg-violet-500 disabled:opacity-50">
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                Publish skill
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
