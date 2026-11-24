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

/** Open a step's panel on the schedule (ExecutionView listens). */
export const OPEN_STEP_EVENT = "step:open";

type Step = { id: string; name: string; plannedAt: string | null; actualAt: string | null; status: string; pct: number | null; cancelled: boolean; projectId: string | null };

const STATUS_WORDS: Record<string, string> = {
  planned: "not started", in_progress: "in progress", blocked: "blocked", on_hold: "on hold", missed: "missed",
};

export default function ProjectAsk({ stepId, projectId }: { stepId: string; projectId: string }) {
  const [step, setStep] = useState<Step | null | undefined>(undefined);
  const [err, setErr] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  const load = useCallback(async () => {
    setErr(null);
    try {
      const { data, error } = await supabase.from("milestones").select("*").eq("id", stepId).maybeSingle();
      if (error) throw error;
      const r = data as Record<string, unknown> | null;
      setStep(r ? {
        id: r.id as string, name: (r.name as string) || "This step",
        plannedAt: (r.planned_at as string | null) ?? null, actualAt: (r.actual_at as string | null) ?? null,
        status: (r.status as string) || "planned", pct: typeof r.percent_complete === "number" ? (r.percent_complete as number) : null,
        cancelled: !!r.cancelled_at, projectId: (r.project_id as string | null) ?? null,
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
  if (step.status === "completed") return <NeededFromYou done what={<>{step.name} is done{step.actualAt ? ` (${plainDate(step.actualAt)})` : ""}. Nothing is needed.</>} />;
  const due = dueWords(step.plannedAt);
  const where = `${STATUS_WORDS[step.status] ?? step.status.replace(/_/g, " ")}${step.pct != null && step.pct > 0 ? `, ${step.pct}% done` : ""}`;
  const open = (edit: boolean) => window.dispatchEvent(new CustomEvent(edit ? "step:edit-plan" : OPEN_STEP_EVENT, { detail: { id: step.id } }));
  return (
    <NeededFromYou
      what={due?.late
        ? <>{step.name} was due {plainDate(step.plannedAt)} and is still open: record where it stands, or move its date.</>
        : <>{step.name} is due {plainDate(step.plannedAt)}: record its progress as it goes, or move its date if it won&apos;t make it.</>}
      why={<>It&apos;s {where}. Late steps show red on the plan, the shift report and the project&apos;s reports until they&apos;re updated.</>}
      when={due}
    >
      <Button onClick={() => open(false)}>Update it</Button>
      <Button variant="secondary" onClick={() => open(true)}>Move its date</Button>
    </NeededFromYou>
  );
}
