"use client";

// SetupChecklist — first-run guidance for a fresh organization.
//
// A new admin lands on empty admin lists with no starting point. This detects
// what's set up (libraries, team, equipment, request forms) and shows a
// dismissible checklist with deep links to each next step. It only renders
// when something is still missing AND the user hasn't dismissed it — per the
// "don't interrupt experienced users" rule. Auto-hides once everything's done.

import React from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import {
  CheckCircle2, Circle, Library, Users, Factory, MailPlus, Map as MapIcon, X, Rocket, ChevronRight,
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

  return (
    <section className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-[var(--color-surface-2)] flex items-center justify-center shrink-0">
          <Rocket className="w-[18px] h-[18px] text-[var(--color-text-muted)]" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-[14px] font-bold text-[var(--color-text)]">Get your workspace ready</h2>
            <span className="text-[12px] font-semibold text-[var(--color-text-muted)]">{doneCount} of {steps.length} done</span>
          </div>
          {(() => {
            const next = steps.find((s) => !s.done);
            return next ? (
              <Link href={next.href} className="mt-2 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-[var(--color-text)] text-[var(--color-surface)] text-[13px] font-bold hover:opacity-90">
                Next: {next.label} <ChevronRight className="w-3.5 h-3.5" />
              </Link>
            ) : null;
          })()}
        </div>
        <button onClick={dismiss} aria-label="Dismiss" className="p-1.5 rounded-md text-[var(--color-text-faint)] hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
      </div>

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 border-t border-[var(--color-border)]">
        {steps.map((s) => {
          const Icon = s.icon;
          return (
            <Link
              key={s.key}
              href={s.href}
              className="flex items-center gap-3 py-3 border-b border-[var(--color-border)] transition-colors hover:bg-[var(--color-surface-2)] -mx-2 px-2 rounded-lg"
            >
              {s.done ? <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" /> : <Circle className="w-5 h-5 text-[var(--color-text-faint)] shrink-0" />}
              <div className="flex-1 min-w-0">
                <div className={`text-[14px] font-semibold ${s.done ? "text-[var(--color-text-muted)] line-through" : "text-[var(--color-text)]"}`}>{s.label}</div>
                {!s.done && <div className="text-[12.5px] text-[var(--color-text-muted)] truncate">{s.blurb}</div>}
              </div>
              {!s.done && <Icon className="w-4 h-4 text-[var(--color-text-faint)] shrink-0" />}
              {!s.done && <ChevronRight className="w-4 h-4 text-[var(--color-text-faint)] shrink-0" />}
            </Link>
          );
        })}
      </div>
    </section>
  );
}
