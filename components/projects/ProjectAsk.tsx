"use client";

// ProjectAsk: "Needed from you" at the top of a project when the person came
// for one step that is late or due this week (?ask=late|due&m=<step id>,
// from the Inbox). It names the step, its date and where it stands, and the
// buttons open that step's own panel (record progress, or move its date).

import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/Button";
import { NeededFromYou } from "@/components/ui/NeededFromYou";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { dueWords, plainDate } from "@/lib/asks";
import { openStep } from "@/lib/stepOpen";

type Step = { id: string; name: string; plannedAt: string | null; actualAt: string | null; status: string; pct: number | null; cancelled: boolean; projectId: string | null;
  /** Steps under it (not cancelled): its status rolls up from them, as on the schedule. */
  kids: number; kidsDone: number };

const STATUS_WORDS: Record<string, string> = {
  planned: "not started", in_progress: "in progress", blocked: "blocked", on_hold: "on hold", missed: "missed",
};

export default function ProjectAsk({ stepId, projectId, onWorkTab }: {
  stepId: string;
  projectId: string;
  /** The Work tab (where a step's panel opens) is the one showing. */
  onWorkTab: boolean;
}) {
  const [step, setStep] = useState<Step | null | undefined>(undefined);
  const [err, setErr] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  const load = useCallback(async () => {
    setErr(null);
    try {
      const [{ data, error }, { data: kidRows }] = await Promise.all([
        supabase.from("milestones").select("*").eq("id", stepId).maybeSingle(),
        supabase.from("milestones").select("status, cancelled_at").eq("parent_id", stepId),
      ]);
      if (error) throw error;
      const r = data as Record<string, unknown> | null;
      const kids = ((kidRows ?? []) as Array<{ status: string; cancelled_at: string | null }>).filter((k) => !k.cancelled_at);
      setStep(r ? {
        id: r.id as string, name: (r.name as string) || "This step",
        plannedAt: (r.planned_at as string | null) ?? null, actualAt: (r.actual_at as string | null) ?? null,
        status: (r.status as string) || "planned", pct: typeof r.percent_complete === "number" ? (r.percent_complete as number) : null,
        cancelled: !!r.cancelled_at, projectId: (r.project_id as string | null) ?? null,
        kids: kids.length, kidsDone: kids.filter((k) => k.status === "completed").length,
      } : null);
    } catch (e) { setErr(e); }
  }, [stepId]);
  useEffect(() => { void load(); }, [load, tick]);
  // A change on the schedule (progress, a new date) is read again.
  useEffect(() => {
    const on = () => setTick((n) => n + 1);
    window.addEventListener("schedule:changed", on);
    return () => window.removeEventListener("schedule:changed", on);
  }, []);

  if (err) return <ErrorNote error={err} title="Couldn't read the step you came for." onRetry={() => setTick((n) => n + 1)} />;
  if (step === undefined) return <NeededFromYou what="" loading />;
  if (!step || step.projectId !== projectId) return <NeededFromYou done what={<>That step isn&apos;t on this project&apos;s schedule any more.</>} />;
  if (step.cancelled) return <NeededFromYou done what={<>{step.name} was taken off the schedule. Nothing is needed.</>} />;
  if (step.kids > 0 && step.kidsDone === step.kids) return <NeededFromYou done what={<>{step.name} is done: all {step.kids} of its steps are complete. Nothing is needed.</>} />;
  if (step.status === "completed") return <NeededFromYou done what={<>{step.name} is done{step.actualAt ? ` (${plainDate(step.actualAt)})` : ""}. Nothing is needed.</>} />;
  const due = dueWords(step.plannedAt);
  const where = step.kids > 0
    ? `${step.kidsDone} of its ${step.kids} steps done`
    : `${STATUS_WORDS[step.status] ?? step.status.replace(/_/g, " ")}${step.pct != null && step.pct > 0 ? `, ${step.pct}% done` : ""}`;
  // The step's panel lives on the Work tab: go there first when needed.
  const open = (edit: boolean) => {
    if (!onWorkTab) window.dispatchEvent(new CustomEvent("project:tab", { detail: "work" }));
    openStep(step.id, edit);
  };
  // One short question: the step and its date; where it stands under it, and
  // why it matters one tap away (the buttons say what to do).
  return (
    <NeededFromYou
      what={due?.late
        ? <>{step.name} is late: due {plainDate(step.plannedAt)}.</>
        : <>{step.name} is due {plainDate(step.plannedAt)}.</>}
      why={<>
        {step.kids > 0 ? where.charAt(0).toUpperCase() + where.slice(1) : <>It&apos;s {where}</>}.{" "}
        <MoreWhy>
          {due?.late
            ? <>Record where it stands, or move its date. Late steps show red on the plan, the shift report and the project&apos;s reports until they&apos;re updated.</>
            : <>Record its progress as it goes, or move its date if it won&apos;t make it. Late steps show red on the plan, the shift report and the project&apos;s reports until they&apos;re updated.</>}
        </MoreWhy>
      </>}
      when={due}
    >
      <Button onClick={() => open(false)}>Update it</Button>
      <Button variant="secondary" onClick={() => open(true)}>Move its date</Button>
    </NeededFromYou>
  );
}

/** Why it matters, one tap away under the line (in the box's flow, so
 *  nothing is cut off at its edge). */
function MoreWhy({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="inline-flex items-center min-h-8 pointer-coarse:min-h-11 font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2">
        {open ? "Less" : "Why it matters"}
      </button>
      {open && <span className="block mt-1 text-[var(--color-text-muted)]">{children}</span>}
    </>
  );
}
