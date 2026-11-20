"use client";

// Home's "your work" rows: the document libraries and the active projects,
// each a row of cards that runs off the right edge (it scrolls sideways), so
// it is plain there are more than fit. Each card says what is in it in a few
// words; the numbers come from the same counts the libraries use.

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight, Folder } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import { CardStrip } from "@/components/ui/PageHero";
import { phasesOfRow, projectDue, projectDueWords } from "@/lib/projectPhases";
import { dayKey } from "@/lib/scheduleTz";

/** Counts are null when they couldn't be read: then the card says nothing
 *  rather than a wrong "Empty". */
interface LibCard { id: string; name: string; docs: number | null; out: number | null }
interface ProjCard {
  id: string; name: string; owner: string | null; moc: string | null; lastActivity: string | null;
  due: string | null; late: boolean;
}

const label = "text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-muted)]";
const card = "shrink-0 w-[236px] sm:w-[280px] rounded-2xl bg-[var(--color-surface)] shadow-[0_1px_2px_rgb(11_18_32/0.06)] px-4 sm:px-5 py-4 text-[var(--color-text)] hover:shadow-[var(--shadow-card)] transition-shadow";

async function headCount(build: () => PromiseLike<{ count: number | null; error: unknown }>): Promise<number | null> {
  try { const r = await build(); return r.error ? null : r.count; } catch { return null; }
}

function ago(iso: string | null): string {
  if (!iso) return "";
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (!Number.isFinite(d)) return "";
  return d <= 0 ? "active today" : d === 1 ? "active yesterday" : `active ${d} days ago`;
}

export default function HomeStrips() {
  const { activeOrgId, uid } = useRole();
  const [libs, setLibs] = useState<LibCard[] | null>(null);
  const [projects, setProjects] = useState<ProjCard[] | null>(null);

  useEffect(() => {
    if (!activeOrgId) return;
    let alive = true;
    void (async () => {
      try {
        const { data } = await supabase.from("libraries").select("id, name").eq("org_id", activeOrgId).order("name").limit(12);
        const rows = (data ?? []) as Array<{ id: string; name: string | null }>;
        const counted = await Promise.all(rows.map(async (l) => ({
          id: l.id,
          name: l.name ?? "Library",
          docs: await headCount(() => supabase.from("documents").select("id", { count: "exact", head: true }).eq("org_id", activeOrgId).eq("library_id", l.id)),
          out: await headCount(() => supabase.from("documents").select("id", { count: "exact", head: true }).eq("org_id", activeOrgId).eq("library_id", l.id).not("checked_out_by", "is", null)),
        })));
        // Libraries with documents first, so the busy ones are in sight.
        counted.sort((a, b) => ((b.docs ?? 0) > 0 ? 1 : 0) - ((a.docs ?? 0) > 0 ? 1 : 0));
        if (alive) setLibs(counted);
      } catch { if (alive) setLibs([]); }
    })();
    void (async () => {
      try {
        const { data } = await supabase.from("projects")
          .select("id, name, owner_user_id, owner_user_name, moc_reference, last_activity_at, target_completion_date, timezone, phases, st_phases:shift_times->phases")
          .eq("org_id", activeOrgId).eq("status", "active")
          .order("last_activity_at", { ascending: false, nullsFirst: false }).limit(12);
        const now = Date.now();
        const rows = ((data ?? []) as Array<{
          id: string; name: string | null; owner_user_id: string | null; owner_user_name: string | null; moc_reference: string | null;
          last_activity_at: string | null; target_completion_date: string | null; timezone?: string | null; phases?: unknown; st_phases?: unknown;
        }>).map((p) => {
          const due = projectDue(phasesOfRow({ phases: p.phases, shift_times: p.st_phases != null ? { phases: p.st_phases } : null }), p.target_completion_date, dayKey(now, p.timezone || "America/Los_Angeles"));
          return {
            id: p.id, name: p.name ?? "Untitled project",
            owner: p.owner_user_id && p.owner_user_id === uid ? "You" : p.owner_user_name,
            moc: p.moc_reference, lastActivity: p.last_activity_at,
            due: due ? projectDueWords(due) : null, late: due?.kind === "past target",
          };
        });
        if (alive) setProjects(rows);
      } catch { if (alive) setProjects([]); }
    })();
    return () => { alive = false; };
  }, [activeOrgId, uid]);

  if (!libs?.length && !projects?.length) return null;

  return (
    <div className="space-y-5 pt-2">
      {!!libs?.length && (
        <section aria-label="Your libraries">
          <div className="flex items-baseline gap-3 mb-3 px-1">
            <h2 className={label}>Your libraries</h2>
            <div className="flex-1" />
            <Link href="/documents" className="text-[13px] font-bold text-[var(--color-accent-text)] hover:text-[var(--color-accent-hover)]">Documents</Link>
          </div>
          <CardStrip>
            {libs.map((l) => (
              <Link key={l.id} href={`/documents/${l.id}`} className={card}>
                <span className="flex items-center gap-2.5">
                  <span className="w-8 h-8 rounded-[9px] bg-[var(--color-surface-2)] grid place-items-center shrink-0">
                    <Folder className="w-4 h-4 text-[var(--color-text-muted)]" />
                  </span>
                  <span className="text-[14px] font-bold truncate">{l.name}</span>
                </span>
                <span className="block mt-3 text-[13px] text-[var(--color-text-muted)]">
                  {l.docs == null ? "Open the library" : l.docs === 0 ? "Empty" : `${l.docs.toLocaleString()} document${l.docs === 1 ? "" : "s"}`}
                </span>
                {l.docs != null && l.docs > 0 && l.out != null && (
                  <span className="block mt-1 text-[12px] text-[var(--color-text-muted)]">
                    {l.out === 0 ? "None checked out" : `${l.out} checked out`}
                  </span>
                )}
              </Link>
            ))}
          </CardStrip>
        </section>
      )}
      {!!projects?.length && (
        <section aria-label="Your projects">
          <div className="flex items-baseline gap-3 mb-3 px-1">
            <h2 className={label}>{projects.length === 1 ? "Your project" : "Active projects"}</h2>
            <div className="flex-1" />
            <Link href="/projects" className="text-[13px] font-bold text-[var(--color-accent-text)] hover:text-[var(--color-accent-hover)]">Projects</Link>
          </div>
          {projects.length === 1 ? (
            <ProjectRow p={projects[0]} />
          ) : (
            <CardStrip>
              {projects.map((p) => (
                <Link key={p.id} href={`/projects/${p.id}`} className={card}>
                  <span className="block text-[14px] font-bold truncate">{p.name}</span>
                  <span className="block mt-1 text-[13px] text-[var(--color-text-muted)] truncate">
                    {[p.owner, p.moc ? `MOC ${p.moc}` : null].filter(Boolean).join(" · ") || "No owner set"}
                  </span>
                  <span className={`block mt-3 text-[12px] ${p.late ? "font-bold text-rose-700 dark:text-rose-400" : "text-[var(--color-text-muted)]"}`}>
                    {p.due ?? ago(p.lastActivity) ?? ""}
                  </span>
                </Link>
              ))}
            </CardStrip>
          )}
        </section>
      )}
    </div>
  );
}

function ProjectRow({ p }: { p: ProjCard }) {
  return (
    <Link href={`/projects/${p.id}`}
      className="flex items-center gap-4 rounded-2xl bg-[var(--color-surface)] shadow-[0_1px_2px_rgb(11_18_32/0.06)] hover:shadow-[var(--shadow-card)] transition-shadow px-4 sm:px-5 py-4 text-[var(--color-text)]">
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-bold truncate">{p.name}</span>
        <span className="block mt-1 text-[13px] text-[var(--color-text-muted)] truncate">
          {[p.owner, p.moc ? `MOC ${p.moc}` : null, ago(p.lastActivity)].filter(Boolean).join(" · ")}
        </span>
      </span>
      {p.due && <span className={`shrink-0 text-[12px] ${p.late ? "font-bold text-rose-700 dark:text-rose-400" : "text-[var(--color-text-muted)]"}`}>{p.due}</span>}
      <ChevronRight className="w-4 h-4 text-[var(--color-text-faint)] shrink-0" />
    </Link>
  );
}
