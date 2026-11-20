"use client";

// /setup — the Facility Setup navigator.
//
// Setup is the most meticulous part of adopting a system like this, and the
// old way to do it was remembering which of nine tools you'd half-finished.
// This page removes that: it reads the LIVE state of every subsystem — the
// codebook, the registry, the document bridge, the knowledge index, the
// connection engine, the process map — and always knows exactly where you
// left off. Launch it at any point; it resumes from whatever stage the
// workspace is actually in. Every stage links straight into the tool that
// advances it, and the checks are real counts, never a checklist you tick.

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Compass, BookMarked, Tag, FileStack, Link2, Bot, Waypoints, Loader2,
  Check, ArrowRight,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, StepLine, heroPrimary } from "@/components/ui/PageHero";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { StatusTag } from "@/components/requests/RequestBits";

interface Facts {
  units: number; equipTypes: number;
  assets: number; uncategorized: number; unitless: number;
  libraries: number; documents: number; numbered: number;
  docAssetLinks: number; mentions: number;
  kdocs: number; mirrored: number; hasAiKey: boolean;
  skillsEnabled: number; reasoningSkills: number; curatedLinks: number; pendingProposals: number;
  flows: number; plotPlans: number;
}

type Filter = Record<string, unknown>;

interface StageCheck { label: string; ok: boolean }
interface Stage {
  key: string; title: string; blurb: string;
  icon: typeof BookMarked;
  checks: StageCheck[];
  href: string; cta: string;
  extraHref?: string; extraCta?: string;
}

export default function SetupPage() {
  const { activeOrgId, uid } = useRole();
  const [facts, setFacts] = useState<Facts | null>(null);

  useEffect(() => {
    if (!activeOrgId || !uid) return;
    let alive = true;

    // Count with missing-table tolerance: a pre-migration workspace reads as
    // zero, which is exactly what the navigator should report.
    const count = async (table: string, match: Filter = {}, extra?: (q: unknown) => unknown): Promise<number> => {
      try {
        let q: unknown = supabase.from(table)
          .select("id", { count: "exact", head: true })
          .match({ org_id: activeOrgId, ...match });
        if (extra) q = extra(q);
        const { count: c, error } = await (q as PromiseLike<{ count: number | null; error: unknown }>);
        return error ? 0 : (c ?? 0);
      } catch { return 0; }
    };
    type Q = { is: (c: string, v: null) => Q; not: (c: string, op: string, v: null) => Q };

    (async () => {
      const [
        units, equipTypes,
        assets, uncategorized, unitless,
        libraries, documents, numbered,
        docAssetLinks, mentions,
        kdocs, mirrored, aiKeyCount,
        skillsEnabled, reasoningSkills, curatedLinks, pendingProposals,
        flows, plotPlans,
      ] = await Promise.all([
        count("codebook_entries", { kind: "unit" }),
        count("codebook_entries", { kind: "equipment_type" }),
        count("assets", { archived: false }),
        count("assets", { archived: false }, (q) => (q as Q).is("type_id", null)),
        count("assets", { archived: false }, (q) => (q as Q).is("unit_code", null)),
        count("libraries"),
        count("documents"),
        count("documents", {}, (q) => (q as Q).not("document_number", "eq", null as never)),
        count("document_assets"),
        count("entity_mentions"),
        count("knowledge_documents"),
        count("knowledge_documents", {}, (q) => (q as Q).not("source_document_id", "eq", null as never)),
        count("ai_connections", { user_id: uid }),
        count("link_rules", { enabled: true }),
        count("answer_skills", { enabled: true }),
        count("document_related_resources"),
        count("proposed_links", { status: "pending" }),
        count("process_flows", { status: "confirmed" }),
        count("plot_plans"),
      ]);
      if (!alive) return;
      setFacts({
        units, equipTypes, assets, uncategorized, unitless,
        libraries, documents, numbered, docAssetLinks, mentions,
        kdocs, mirrored, hasAiKey: aiKeyCount > 0,
        skillsEnabled, reasoningSkills, curatedLinks, pendingProposals,
        flows, plotPlans,
      });
    })();
    return () => { alive = false; };
  }, [activeOrgId, uid]);

  const stages: Stage[] = useMemo(() => {
    if (!facts) return [];
    const f = facts;
    return [
      {
        key: "codebook", title: "Teach it your language",
        blurb: "Units, equipment prefixes, and your drawing-number format live in the Site Codebook, imported from your own documents or entered by hand. Everything downstream decodes through it.",
        icon: BookMarked,
        checks: [
          { label: `${f.units} operating unit${f.units === 1 ? "" : "s"} defined`, ok: f.units > 0 },
          { label: `${f.equipTypes} equipment type${f.equipTypes === 1 ? "" : "s"} with prefixes`, ok: f.equipTypes > 0 },
        ],
        href: "/admin/codebook", cta: "Open the Site Codebook",
      },
      {
        key: "registry", title: "Register the equipment",
        blurb: "Every physical thing gets one canonical record. The codebook auto-categorizes tags it recognizes; what it can't decode is reported so you can teach it the prefix.",
        icon: Tag,
        checks: [
          { label: `${f.assets} asset${f.assets === 1 ? "" : "s"} registered`, ok: f.assets > 0 },
          { label: f.assets === 0 ? "Nothing to categorize yet" : f.uncategorized === 0 ? "All categorized" : `${f.uncategorized} uncategorized (auto-categorize in Operating areas)`, ok: f.assets > 0 && f.uncategorized === 0 },
          { label: f.assets === 0 ? "Nothing to file to a unit yet" : f.unitless === 0 ? "All filed to a unit" : `${f.unitless} not filed to a unit`, ok: f.assets > 0 && f.unitless === 0 },
        ],
        href: "/admin/assets", cta: "Open Operating areas",
      },
      {
        key: "documents", title: "Bring the documents under control",
        blurb: "Libraries, revisions, locks, distribution. The title-block ingest wizard reads numbers and titles off the drawings themselves during mass transition.",
        icon: FileStack,
        checks: [
          { label: `${f.libraries} librar${f.libraries === 1 ? "y" : "ies"}, ${f.documents} document${f.documents === 1 ? "" : "s"}`, ok: f.documents > 0 },
          { label: `${f.numbered} carry document numbers`, ok: f.numbered > 0 },
        ],
        href: "/documents", cta: "Open Documents",
      },
      {
        key: "bridge", title: "Bridge paper to plant",
        blurb: "Link documents to the equipment they govern. The Equipment sweep reads tags off each library, and every link becomes a graph edge and an answer source.",
        icon: Link2,
        checks: [
          { label: `${f.docAssetLinks} document-to-equipment link${f.docAssetLinks === 1 ? "" : "s"}`, ok: f.docAssetLinks > 0 },
          { label: `${f.mentions} text mention${f.mentions === 1 ? "" : "s"} indexed`, ok: f.mentions > 0 },
        ],
        href: "/documents", cta: "Run an Equipment sweep",
      },
      {
        key: "ai", title: "Index the knowledge",
        blurb: "Knowledge libraries make documents askable. Link your document-control libraries as sources so answers cite the real controlled files, on your own AI key.",
        icon: Bot,
        checks: [
          { label: `${f.kdocs} document${f.kdocs === 1 ? "" : "s"} indexed (${f.mirrored} mirroring controlled files)`, ok: f.kdocs > 0 },
          { label: f.hasAiKey ? "Your AI key is set" : "Add your AI key in AI settings", ok: f.hasAiKey },
        ],
        href: "/knowledge", cta: "Open Knowledge",
        extraHref: "/intelligence/setup", extraCta: "AI settings",
      },
      {
        key: "connections", title: "Grow the web",
        blurb: "Connection Skills discover links; Reasoning Skills shape answers; the review queue keeps a human on every uncertain edge.",
        icon: Waypoints,
        checks: [
          { label: `${f.skillsEnabled} connection skill${f.skillsEnabled === 1 ? "" : "s"} + ${f.reasoningSkills} reasoning skill${f.reasoningSkills === 1 ? "" : "s"} enabled`, ok: f.skillsEnabled > 0 },
          { label: `${f.curatedLinks} curated link${f.curatedLinks === 1 ? "" : "s"}${f.pendingProposals > 0 ? `, ${f.pendingProposals} proposal${f.pendingProposals === 1 ? "" : "s"} awaiting review` : ""}`, ok: f.curatedLinks > 0 },
        ],
        href: "/intelligence/skills", cta: "Open the Skill library",
        extraHref: "/admin/proposed-links", extraCta: "Review queue",
      },
      {
        key: "process", title: "Map the process",
        blurb: "Flows turn the graph into the plant: draw them on the Process lens, or point the reader at a PFD and confirm what it finds. Plot plans add the spatial picture.",
        icon: Compass,
        checks: [
          { label: `${f.flows} confirmed flow${f.flows === 1 ? "" : "s"}`, ok: f.flows > 0 },
          { label: `${f.plotPlans} plot plan${f.plotPlans === 1 ? "" : "s"}`, ok: f.plotPlans > 0 },
        ],
        href: "/graph", cta: "Open the graph",
        extraHref: "/plot-plans", extraCta: "Plot plans",
      },
    ];
  }, [facts]);

  const firstIncomplete = stages.findIndex((s) => !s.checks.every((c) => c.ok));

  const doneCount = stages.filter((x) => x.checks.every((c) => c.ok)).length;
  const next = firstIncomplete >= 0 ? stages[firstIncomplete] : null;

  return (
    <PageShell>
      <PageHero
        kicker="Facility setup"
        title={facts === null ? "Setup navigator" : !next ? "Every stage reads healthy." : `${doneCount} of ${stages.length} stages done.`}
        sub={facts === null ? "Reading where your workspace is…" : next ? `Next: ${next.title}. Counts are live, so this picks up where you left off.` : "Nothing is waiting on you."}
        facts={facts === null ? undefined : [
          { label: "Done", value: doneCount, tone: doneCount === stages.length ? "good" : undefined },
          { label: "To go", value: stages.length - doneCount },
        ]}
        primary={next ? <Link href={next.href} className={heroPrimary}>{next.cta} <ArrowRight className="w-4 h-4" /></Link> : undefined}
      >
        {facts !== null && (
          <>
            <p className="sm:hidden mb-2.5 text-[14px] font-semibold text-[var(--color-text)]">{next ? `Stage ${firstIncomplete + 1} of ${stages.length}: ${next.title}` : `All ${stages.length} stages done`}</p>
            <div className="max-sm:hidden">
              <StepLine steps={stages.map((st, i) => ({ label: st.title, state: st.checks.every((c) => c.ok) ? "done" : i === firstIncomplete ? "now" : "next" }))} />
            </div>
          </>
        )}
      </PageHero>

      <PageBody>
      {facts === null ? (
        <Card><p className="flex items-center justify-center gap-2 py-12 text-[15px] text-[var(--color-text-muted)]"><Loader2 className="w-5 h-5 animate-spin" /> Reading where your workspace is…</p></Card>
      ) : (
        <Card label="Stages" pad={false} className="overflow-hidden">
          <table className="w-full text-[15px]">
            <thead className="bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)] text-left max-md:hidden">
              <tr>
                <th className="font-semibold pl-4 pr-2 h-10 w-10">#</th>
                <th className="font-semibold px-4 h-10">Stage</th>
                <th className="font-semibold px-4 h-10">Status</th>
                <th className="font-semibold px-4 h-10">What&apos;s there now</th>
                <th className="font-semibold px-4 h-10 text-right">Go to</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {stages.map((s, i) => {
                const done = s.checks.every((c) => c.ok);
                const active = i === firstIncomplete;
                return (
                  <tr key={s.key} aria-current={active ? "step" : undefined} className="max-md:flex max-md:flex-col max-md:px-4 max-md:py-3 max-md:gap-1.5">
                    <td className="md:pl-4 md:pr-2 md:py-3 align-top font-display text-[17px] font-semibold tabular-nums text-[var(--color-text-muted)] max-md:hidden">{i + 1}</td>
                    <td className="md:px-4 md:py-3 align-top">
                      <div className="flex items-center gap-1.5">
                        <span className="md:hidden font-display tabular-nums text-[var(--color-text-muted)]">{i + 1}.</span>
                        <span className="font-semibold text-[var(--color-text)]">{s.title}</span>
                        <HelpTooltip>{s.blurb}</HelpTooltip>
                      </div>
                    </td>
                    <td className="md:px-4 md:py-3 align-top whitespace-nowrap">
                      {done ? <StatusTag tone="good">Done</StatusTag> : active ? <StatusTag tone="warn">Next</StatusTag> : <StatusTag>To do</StatusTag>}
                    </td>
                    <td className="md:px-4 md:py-3 align-top">
                      <ul className="space-y-0.5">
                        {s.checks.map((c) => (
                          <li key={c.label} className={`flex items-start gap-2 text-[14px] ${c.ok ? "text-[var(--color-text-muted)]" : "text-[var(--color-text)]"}`}>
                            {c.ok
                              ? <Check aria-label="Done" className="w-4 h-4 mt-0.5 shrink-0 text-[var(--state-released)]" />
                              : <span aria-label="Not yet" className="w-4 h-4 mt-0.5 shrink-0 grid place-items-center"><span className="w-2 h-2 rounded-full border-2 border-[var(--state-held)]" /></span>}
                            {c.label}
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className="md:px-4 md:py-3 align-top md:text-right">
                      <div className="flex flex-wrap md:flex-col md:items-end gap-x-4 gap-y-0.5 text-[14px]">
                        <Link href={s.href} className="inline-flex items-center gap-1 text-[var(--color-accent-text)] hover:underline underline-offset-2 whitespace-nowrap">{s.cta} <ArrowRight className="w-3.5 h-3.5" /></Link>
                        {s.extraHref && <Link href={s.extraHref} className="text-[var(--color-accent-text)] hover:underline underline-offset-2 whitespace-nowrap">{s.extraCta}</Link>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      </PageBody>
    </PageShell>
  );
}
