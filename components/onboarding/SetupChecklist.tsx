"use client";

// SetupChecklist: a new workspace's first run, on Home, in the product.
//
// No tour and no banner. One question ("What will your team use first?"),
// answered in place and used at once: that part of setup moves to the top
// of the list. Then a short checklist that opens with step 1 already done
// (the workspace exists), each step a link into the tool that does it,
// ticked from live counts (never a box you tick yourself). One pointer at
// most: the next step says "Next". It can be hidden from the same corner
// at any time, and it hides itself once the essentials (a library, the
// team, the equipment) are in. Admins only.

import React from "react";
import Link from "next/link";
import { useRole } from "@/components/providers/RoleContext";
import { sharedLoad, lastLoaded } from "@/lib/warmLoads";
import { setupCountsKey, loadSetupCounts, type SetupCounts } from "@/lib/dashboard/homeLoads";
import { Check, ChevronRight, X } from "lucide-react";
import { SectionHead, link } from "@/components/cockpit/ui";

interface Step {
  key: string;
  label: string;
  blurb: string;
  href: string;
  done: boolean;
}

type First = "documents" | "requests" | "equipment";

const DISMISS_KEY = "mfg-os.setup-checklist.dismissed";
const FIRST_KEY = "mfg-os.setup-checklist.first";

/** The one question: what the team will use first, and the step it pulls up. */
const FIRST: Array<{ key: First; label: string; step: string }> = [
  { key: "documents", label: "Drawings and documents", step: "library" },
  { key: "requests", label: "Drafting requests", step: "request" },
  { key: "equipment", label: "Equipment and plot plans", step: "scope" },
];

function readLocal(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeLocal(key: string, v: string) {
  try { localStorage.setItem(key, v); } catch { /* private mode: it just asks again */ }
}

export default function SetupChecklist() {
  const { activeOrgId, activeRole, uid } = useRole();
  // Read on this device before the first paint (this list is never drawn
  // on the server: it waits for the workspace), so it doesn't pop in late.
  const [dismissed, setDismissed] = React.useState(() => typeof window === "undefined" || readLocal(DISMISS_KEY) === "1");
  const [first, setFirst] = React.useState<First | null>(() => {
    if (typeof window === "undefined" || !activeOrgId) return null;
    const v = readLocal(`${FIRST_KEY}.${activeOrgId}`);
    return FIRST.some((f) => f.key === v) ? (v as First) : null;
  });

  const isAdmin = activeRole === "Admin" || activeRole === "DocCtrl";

  React.useEffect(() => {
    if (!activeOrgId) return;
    const v = readLocal(`${FIRST_KEY}.${activeOrgId}`);
    setFirst(FIRST.some((f) => f.key === v) ? (v as First) : null);
  }, [activeOrgId]);

  // The live counts behind the ticks: shared with sign-in, which starts
  // them (lib/dashboard/homeLoads), and kept, so Home opened again shows
  // the list at once.
  const countsKey = activeOrgId && isAdmin ? setupCountsKey(activeOrgId, uid ?? null) : null;
  const [got, setGot] = React.useState<{ key: string; v: SetupCounts } | null>(null);
  const counts = got && got.key === countsKey ? got.v : lastLoaded<SetupCounts>(countsKey);
  React.useEffect(() => {
    if (!activeOrgId || !countsKey) return;
    let alive = true;
    void sharedLoad(countsKey, () => loadSetupCounts(activeOrgId), { maxAgeMs: 1500 })
      .then((v) => { if (alive) setGot({ key: countsKey, v }); }, () => undefined);
    return () => { alive = false; };
  }, [activeOrgId, countsKey]);
  const steps: Step[] | null = React.useMemo(() => counts ? [
    { key: "library", label: "Create your first library", blurb: "Controlled documents live in libraries.", href: "/admin/libraries", done: counts.libs > 0 },
    { key: "team", label: "Add your team", blurb: "Drafters, engineers and document controllers.", href: "/admin/users", done: counts.members > 1 },
    { key: "scope", label: "Register the equipment", blurb: "Tags, so documents and markups can point at them.", href: "/admin/assets", done: counts.assets > 0 },
    { key: "plot", label: "Add a plot plan", blurb: "Find equipment on the site map.", href: "/plot-plans", done: counts.plots > 0 },
    { key: "request", label: "Raise the first drafting request", blurb: "Drafting and design work runs through requests.", href: "/requests", done: counts.tickets > 0 },
  ] : null, [counts]);

  if (!isAdmin || dismissed || !steps) return null;
  // Hide once the essentials (library + team + equipment) are done.
  const essentialsDone = steps.filter((s) => ["library", "team", "scope"].includes(s.key)).every((s) => s.done);
  if (essentialsDone) return null;

  const dismiss = () => { writeLocal(DISMISS_KEY, "1"); setDismissed(true); };
  const answer = (f: First) => { if (activeOrgId) writeLocal(`${FIRST_KEY}.${activeOrgId}`, f); setFirst(f); };

  // The answer pulls its step to the top of what's left.
  const pulled = FIRST.find((f) => f.key === first)?.step;
  const ordered = [...steps].sort((a, b) => Number(b.key === pulled) - Number(a.key === pulled));
  // Step 1 is the workspace itself: already done.
  const all: Step[] = [{ key: "workspace", label: "Create the workspace", blurb: "", href: "", done: true }, ...ordered];
  const doneCount = all.filter((s) => s.done).length;
  const next = all.find((s) => !s.done);

  return (
    <section aria-label="Set up your workspace" className="min-w-0">
      <SectionHead title="Set up your workspace">
        <span className="text-body text-[var(--color-text-muted)] tabular-nums">{doneCount} of {all.length} done</span>
        <button type="button" onClick={dismiss} aria-label="Hide this list" title="Hide this list"
          className="w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 grid place-items-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
          <X className="w-4 h-4" />
        </button>
      </SectionHead>

      <div className="rounded-panel border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
        {/* The one question, answered in place. */}
        {!first ? (
          <fieldset className="px-4 py-3.5 border-b border-[var(--color-border)]">
            <legend className="float-left w-full text-reading font-medium text-[var(--color-text)]">What will your team use first?</legend>
            <div className="clear-both pt-2.5 flex flex-wrap gap-2">
              {FIRST.map((f) => (
                <button key={f.key} type="button" onClick={() => answer(f.key)}
                  className="h-10 pointer-coarse:h-11 px-3.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-border-control)] transition-colors">
                  {f.label}
                </button>
              ))}
            </div>
          </fieldset>
        ) : (
          <p className="px-4 py-2.5 border-b border-[var(--color-border)] text-body text-[var(--color-text-muted)]">
            Starting with {FIRST.find((f) => f.key === first)?.label.toLowerCase()}.{" "}
            <button type="button" onClick={() => setFirst(null)} className={`font-medium ${link}`}>Change</button>
          </p>
        )}

        <ol className="divide-y divide-[var(--color-border)]">
          {all.map((s, i) => {
            const isNext = s === next;
            const body = (
              <>
                {s.done
                  ? <span className="w-5 h-5 shrink-0 grid place-items-center rounded-full bg-[var(--state-released)] text-white"><Check aria-hidden className="w-3.5 h-3.5" /></span>
                  : <span aria-hidden className={`w-5 h-5 shrink-0 rounded-full border-2 ${isNext ? "border-[var(--color-current)]" : "border-[var(--color-border-strong)]"}`} />}
                <span className="sr-only">{s.done ? "Done:" : "To do:"}</span>
                <span className="min-w-0 flex-1">
                  <span className={`block text-reading ${s.done ? "text-[var(--color-text-muted)]" : "font-medium text-[var(--color-text)]"}`}>
                    <span className="tabular-nums text-[var(--color-text-muted)] font-normal mr-1.5">{i + 1}.</span>{s.label}
                  </span>
                  {!s.done && s.blurb && <span className="block text-body text-[var(--color-text-muted)] truncate">{s.blurb}</span>}
                </span>
                {isNext && <span className="shrink-0 text-body font-medium text-[var(--color-accent-text)]">Next</span>}
                {!s.done && <ChevronRight aria-hidden className="w-4 h-4 shrink-0 text-[var(--color-text-faint)]" />}
              </>
            );
            return (
              <li key={s.key}>
                {s.done || !s.href
                  ? <div className="flex items-center gap-3 px-4 py-3">{body}</div>
                  : <Link href={s.href} aria-current={isNext ? "step" : undefined} className="flex items-center gap-3 px-4 py-3 hover:bg-[var(--color-surface-2)] transition-colors">{body}</Link>}
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
