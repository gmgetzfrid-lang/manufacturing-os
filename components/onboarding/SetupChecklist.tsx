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
      const [libs, members, assets, tickets] = await Promise.all([
        countOf("libraries"), countOf("org_members"), countOf("assets"), countOf("tickets"),
      ]).catch(() => [0, 0, 0, 0]);
      if (!alive) return;
      setSteps([
        { key: "library", label: "Create your first library", blurb: "Controlled documents live in libraries.", href: "/admin/libraries", icon: Library, done: libs > 0 },
        { key: "team", label: "Invite your team", blurb: "Add drafters, engineers, and controllers.", href: "/admin/users", icon: Users, done: members > 1 },
        { key: "scope", label: "Register equipment", blurb: "Tag assets so documents and markers can reference them.", href: "/admin/assets", icon: Factory, done: assets > 0 },
        { key: "plot", label: "Add a plot plan", blurb: "Navigate equipment spatially by operational state.", href: "/plot-plans", icon: MapIcon, done: false },
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
    <div className="rounded-2xl border border-orange-200 bg-gradient-to-br from-orange-50 to-amber-50 p-5 mb-6">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-orange-700 flex items-center justify-center shadow-sm shrink-0">
          <Rocket className="w-5 h-5 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-black text-slate-900">Get your workspace ready</h2>
            <span className="text-[11px] font-bold text-orange-700">{doneCount}/{steps.length} done</span>
          </div>
          <p className="text-xs text-slate-600 mt-0.5">A few steps to go from empty to operational.</p>
        </div>
        <button onClick={dismiss} aria-label="Dismiss" className="p-1.5 rounded-md text-slate-400 hover:bg-white/60"><X className="w-4 h-4" /></button>
      </div>

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
        {steps.map((s) => {
          const Icon = s.icon;
          return (
            <Link
              key={s.key}
              href={s.href}
              className={`flex items-center gap-3 rounded-xl border p-3 transition-colors ${s.done ? "border-emerald-200 bg-emerald-50/60" : "border-slate-200 bg-white hover:border-orange-300"}`}
            >
              {s.done ? <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" /> : <Circle className="w-5 h-5 text-slate-300 shrink-0" />}
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-bold ${s.done ? "text-slate-500 line-through" : "text-slate-900"}`}>{s.label}</div>
                {!s.done && <div className="text-[11px] text-slate-500 truncate">{s.blurb}</div>}
              </div>
              {!s.done && <Icon className="w-4 h-4 text-slate-300 shrink-0" />}
              {!s.done && <ChevronRight className="w-4 h-4 text-slate-300 shrink-0" />}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
