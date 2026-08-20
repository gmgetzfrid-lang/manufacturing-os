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
  CheckCircle2, ArrowRight,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";

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
  icon: typeof BookMarked; hue: string;
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
        blurb: "Units, equipment prefixes, and your drawing-number format live in the Site Codebook — imported from your own documents or entered by hand. Everything downstream decodes through it.",
        icon: BookMarked, hue: "from-violet-500 to-purple-600",
        checks: [
          { label: `${f.units} operating unit${f.units === 1 ? "" : "s"} defined`, ok: f.units > 0 },
          { label: `${f.equipTypes} equipment type${f.equipTypes === 1 ? "" : "s"} with prefixes`, ok: f.equipTypes > 0 },
        ],
        href: "/admin/codebook", cta: "Open the Site Codebook",
      },
      {
        key: "registry", title: "Register the equipment",
        blurb: "Every physical thing gets one canonical record. The codebook auto-categorizes tags it recognizes; what it can't decode is reported so you can teach it the prefix.",
        icon: Tag, hue: "from-emerald-500 to-teal-600",
        checks: [
          { label: `${f.assets} asset${f.assets === 1 ? "" : "s"} registered`, ok: f.assets > 0 },
          { label: f.uncategorized === 0 ? "All categorized" : `${f.uncategorized} uncategorized — auto-categorize in Operating areas`, ok: f.assets > 0 && f.uncategorized === 0 },
          { label: f.unitless === 0 ? "All filed to a unit" : `${f.unitless} not filed to a unit`, ok: f.assets > 0 && f.unitless === 0 },
        ],
        href: "/admin/assets", cta: "Open Operating areas",
      },
      {
        key: "documents", title: "Bring the documents under control",
        blurb: "Libraries, revisions, locks, distribution. The title-block ingest wizard reads numbers and titles off the drawings themselves during mass transition.",
        icon: FileStack, hue: "from-blue-500 to-indigo-600",
        checks: [
          { label: `${f.libraries} librar${f.libraries === 1 ? "y" : "ies"} · ${f.documents} document${f.documents === 1 ? "" : "s"}`, ok: f.documents > 0 },
          { label: `${f.numbered} carry document numbers`, ok: f.numbered > 0 },
        ],
        href: "/documents", cta: "Open Documents",
      },
      {
        key: "bridge", title: "Bridge paper to plant",
        blurb: "Link documents to the equipment they govern — the Equipment sweep reads tags off each library, and every link becomes a graph edge and an answer source.",
        icon: Link2, hue: "from-amber-500 to-orange-600",
        checks: [
          { label: `${f.docAssetLinks} document↔equipment link${f.docAssetLinks === 1 ? "" : "s"}`, ok: f.docAssetLinks > 0 },
          { label: `${f.mentions} text mention${f.mentions === 1 ? "" : "s"} indexed`, ok: f.mentions > 0 },
        ],
        href: "/documents", cta: "Run an Equipment sweep",
      },
      {
        key: "ai", title: "Index the knowledge",
        blurb: "Knowledge libraries make documents askable — link your document-control libraries as sources so answers cite the real controlled files, on your own AI key.",
        icon: Bot, hue: "from-fuchsia-500 to-pink-600",
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
        icon: Waypoints, hue: "from-cyan-500 to-sky-600",
        checks: [
          { label: `${f.skillsEnabled} connection skill${f.skillsEnabled === 1 ? "" : "s"} + ${f.reasoningSkills} reasoning skill${f.reasoningSkills === 1 ? "" : "s"} enabled`, ok: f.skillsEnabled > 0 },
          { label: `${f.curatedLinks} curated link${f.curatedLinks === 1 ? "" : "s"}${f.pendingProposals > 0 ? ` · ${f.pendingProposals} proposal${f.pendingProposals === 1 ? "" : "s"} awaiting review` : ""}`, ok: f.curatedLinks > 0 },
        ],
        href: "/intelligence/skills", cta: "Open the Skill library",
        extraHref: "/admin/proposed-links", extraCta: "Review queue",
      },
      {
        key: "process", title: "Map the process",
        blurb: "Flows turn the graph into the plant: draw them on the Process lens, or point the reader at a PFD and confirm what it finds. Plot plans add the spatial picture.",
        icon: Compass, hue: "from-rose-500 to-red-600",
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

  return (
    <PageShell>
      <PageHeaderBar
        icon={Compass}
        eyebrow="Facility setup"
        title="Setup navigator"
        subtitle="Launch this at any point — it reads the live state of every subsystem and resumes from wherever your workspace actually is. Nothing here is a checkbox; every line is a real count."
      />

      {facts === null ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-[var(--color-text-faint)]" /></div>
      ) : (
        <div className="relative">
          {/* The rail — setup as a route to walk, same stepper language as answers. */}
          <div className="absolute left-[15px] top-6 bottom-6 w-0.5 bg-[var(--color-border)]" aria-hidden />
          <div className="space-y-3">
            {stages.map((s, i) => {
              const done = s.checks.every((c) => c.ok);
              const active = i === firstIncomplete;
              const Icon = s.icon;
              return (
                <div key={s.key} className="relative pl-11"
                  style={{ animation: "rise 0.45s var(--ease-fluid) both", animationDelay: `${i * 60}ms` }}>
                  <span className={`absolute left-0 top-3 w-8 h-8 rounded-full flex items-center justify-center text-white text-[12px] font-black ring-4 ring-[var(--color-canvas)] bg-gradient-to-br ${done ? "from-emerald-500 to-teal-600" : s.hue} ${active ? "shadow-lg" : ""}`}>
                    {done ? <CheckCircle2 className="w-4 h-4" /> : i + 1}
                  </span>
                  <div className={`rounded-2xl border p-4 ${active
                    ? "border-violet-300 dark:border-violet-800 bg-violet-50/40 dark:bg-violet-950/20 shadow-md"
                    : "border-[var(--color-border)] bg-[var(--color-surface)]"} ${done ? "opacity-80" : ""}`}>
                    <div className="flex items-start gap-3 flex-wrap">
                      <div className="flex-1 min-w-[16rem]">
                        <div className="flex items-center gap-2">
                          <Icon className="w-4 h-4 text-[var(--color-text-muted)]" />
                          <span className="text-sm font-black text-[var(--color-text)]">{s.title}</span>
                          {active && (
                            <span className="px-1.5 py-0.5 rounded-full bg-violet-600 text-white text-[9px] font-black uppercase tracking-wide">
                              Continue here
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed mt-1">{s.blurb}</p>
                        <div className="mt-2 space-y-0.5">
                          {s.checks.map((c) => (
                            <div key={c.label} className="flex items-center gap-1.5 text-[11px]">
                              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${c.ok ? "bg-emerald-500" : "bg-amber-500"}`} />
                              <span className={c.ok ? "text-[var(--color-text-muted)]" : "font-bold text-[var(--color-text)]"}>{c.label}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="flex flex-col items-stretch gap-1.5 shrink-0">
                        <Link href={s.href}
                          className={`inline-flex items-center justify-center gap-1 px-3 py-2 rounded-lg text-[11px] font-black transition-colors ${active
                            ? "text-white bg-violet-600 hover:bg-violet-500"
                            : "text-[var(--color-text)] border border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)]"}`}>
                          {s.cta} <ArrowRight className="w-3 h-3" />
                        </Link>
                        {s.extraHref && (
                          <Link href={s.extraHref}
                            className="inline-flex items-center justify-center gap-1 px-3 py-1.5 rounded-lg text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                            {s.extraCta}
                          </Link>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {firstIncomplete === -1 && (
            <div className="mt-4 rounded-2xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/30 p-4 text-center">
              <div className="text-sm font-black text-emerald-800 dark:text-emerald-300">Every stage reads healthy.</div>
              <div className="text-[11px] text-[var(--color-text-muted)] mt-1">
                Setup is never truly finished — new documents, equipment, and questions keep feeding the web — but nothing is waiting on you.
              </div>
            </div>
          )}
        </div>
      )}
    </PageShell>
  );
}
