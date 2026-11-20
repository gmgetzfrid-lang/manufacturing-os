"use client";

// SetupChecklist — first-run guidance for a fresh organization.
//
// A new admin lands on empty admin lists with no starting point. This detects
// what's set up (libraries, team, equipment, request forms) and shows a
// dismissible checklist with deep links to each next step. It only renders
// when something is still missing AND the user hasn't dismissed it — per the
// "don't interrupt experienced users" rule. Auto-hides once everything's done.

import React from "react";
import { heroQuiet } from "@/components/ui/PageHero";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import {
  CheckCircle2, Circle, Library, Users, Factory, MailPlus, Map as MapIcon, X, ChevronRight,
} from "lucide-react";

interface Step {
  key: string;
  label: string;
  blurb: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  done: boolean;
}

const DISMISS_KEY = "mfg-os.setup-checklist.dismissed";

export default function SetupChecklist() {
  const { activeOrgId, activeRole } = useRole();
  const [steps, setSteps] = React.useState<Step[] | null>(null);
  const [dismissed, setDismissed] = React.useState(true);

  const isAdmin = activeRole === "Admin" || activeRole === "DocCtrl";

  React.useEffect(() => {
    try { setDismissed(localStorage.getItem(DISMISS_KEY) === "1"); } catch { setDismissed(false); }
  }, []);

  React.useEffect(() => {
    if (!activeOrgId || !isAdmin) return;
    let alive = true;
    const run = async () => {
      const countOf = async (table: string) => {
        const { count } = await supabase.from(table).select("id", { count: "exact", head: true }).eq("org_id", activeOrgId);
        return count ?? 0;
      };
      const [libs, members, assets, tickets, plots] = await Promise.all([
        countOf("libraries"), countOf("org_members"), countOf("assets"), countOf("tickets"), countOf("plot_plans"),
      ]).catch(() => [0, 0, 0, 0, 0]);
      if (!alive) return;
      setSteps([
        { key: "library", label: "Create your first library", blurb: "Controlled documents live in libraries.", href: "/admin/libraries", icon: Library, done: libs > 0 },
        { key: "team", label: "Invite your team", blurb: "Add drafters, engineers, and controllers.", href: "/admin/users", icon: Users, done: members > 1 },
        { key: "scope", label: "Register equipment", blurb: "Tag assets so documents and markers can reference them.", href: "/admin/assets", icon: Factory, done: assets > 0 },
        { key: "plot", label: "Add a plot plan", blurb: "Navigate equipment spatially by operational state.", href: "/plot-plans", icon: MapIcon, done: plots > 0 },
        { key: "request", label: "Open the request portal", blurb: "Drafting & design requests flow through here.", href: "/requests", icon: MailPlus, done: tickets > 0 },
      ]);
    };
    void run();
    return () => { alive = false; };
  }, [activeOrgId, isAdmin]);

  if (!isAdmin || dismissed || !steps) return null;
  const doneCount = steps.filter((s) => s.done).length;
  // Hide once the essentials (library + team + equipment) are done.
  const essentialsDone = steps.filter((s) => ["library", "team", "scope"].includes(s.key)).every((s) => s.done);
  if (essentialsDone) return null;

  const dismiss = () => { try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* ignore */ } setDismissed(true); };

  const next = steps.find((s) => !s.done);
  return (
    <section className="min-w-0">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2 mb-2.5 min-h-8">
        <h2 className="font-display text-[19px] leading-tight font-semibold text-[var(--color-text)]">Get your workspace ready</h2>
        <span className="text-[13px] text-[var(--color-text-muted)] tabular-nums">{doneCount} of {steps.length} done</span>
        <div className="flex-1" />
        {next && (
          <Link href={next.href} className={heroQuiet}>
            Next: {next.label} <ChevronRight className="w-4 h-4" />
          </Link>
        )}
        <button type="button" onClick={dismiss} aria-label="Hide this list" className="w-9 h-9 grid place-items-center rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)]"><X className="w-4 h-4" /></button>
      </div>

      <ul className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] grid grid-cols-1 sm:grid-cols-2 [&>li]:border-b [&>li]:border-[var(--color-border)] [&>li:last-child]:border-b-0 sm:[&>li:nth-last-child(2):nth-child(odd)]:border-b-0 overflow-hidden">
        {steps.map((s) => {
          const Icon = s.icon;
          return (
            <li key={s.key} className="sm:odd:border-r">
              <Link href={s.href} className="flex items-center gap-3 px-4 py-3 hover:bg-[var(--color-surface-2)]">
                {s.done
                  ? <CheckCircle2 aria-label="Done" className="w-5 h-5 text-[var(--state-released)] shrink-0" />
                  : <Circle aria-label="Not done" className="w-5 h-5 text-[var(--color-text-faint)] shrink-0" />}
                <div className="flex-1 min-w-0">
                  <div className={`text-[15px] font-semibold ${s.done ? "text-[var(--color-text-muted)]" : "text-[var(--color-text)]"}`}>{s.label}</div>
                  {!s.done && <div className="text-[13px] text-[var(--color-text-muted)] truncate">{s.blurb}</div>}
                </div>
                {!s.done && <Icon className="w-4 h-4 text-[var(--color-text-faint)] shrink-0" />}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
