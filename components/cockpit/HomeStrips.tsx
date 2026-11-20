"use client";

// Home's "your work": the document libraries and the active projects you own or
// are on, each a compact ruled table with its counts (documents and checked out per library;
// owner, dates and last activity per project). Side by side on a wide
// screen, stacked on a phone. The numbers come from the same counts the
// libraries use; a count that couldn't be read shows a dash, never a wrong 0.

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import { phasesOfRow, projectDue, projectDueWords } from "@/lib/projectPhases";
import { myProjectIds } from "@/lib/projects";
import { dayKey } from "@/lib/scheduleTz";
import { FolderOpen, Library, Briefcase } from "lucide-react";
import { sheet, thead, th, rowHover, link, StatusTag, LateEdge, WorkBar, humanDate } from "./ui";
import { useProjectProgress } from "./projectProgress";

/** Counts are null when they couldn't be read. */
interface LibRow { id: string; name: string; docs: number | null; out: number | null }
interface ProjRow {
  id: string; name: string; owner: string | null; moc: string | null; lastActivity: string | null;
  due: string | null; late: boolean; timezone: string | null;
}

async function headCount(build: () => PromiseLike<{ count: number | null; error: unknown }>): Promise<number | null> {
  try { const r = await build(); return r.error ? null : r.count; } catch { return null; }
}

function ago(iso: string | null): string {
  if (!iso) return "";
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (!Number.isFinite(d)) return "";
  return d <= 0 ? "Today" : d === 1 ? "Yesterday" : d < 14 ? `${d} days ago` : humanDate(iso);
}

const agoLower = (iso: string | null) => { const a = ago(iso); return a === "Today" || a === "Yesterday" ? a.toLowerCase() : a; };
const num = (n: number | null) => (n == null ? "–" : n.toLocaleString());

function Section({ title, icon, count, href, linkText, children }: { title: string; icon: React.ReactNode; count?: number; href: string; linkText: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="min-w-0">
      <div className="flex items-center gap-2 mb-2.5 min-h-9">
        <span aria-hidden className="ui-icon-tile is-sm is-solid">{icon}</span>
        <h2 className="font-display text-[19px] leading-tight font-semibold text-[var(--color-text)]">{title}</h2>
        {count !== undefined && count > 1 && <span className="ui-count is-solid">{count.toLocaleString()}</span>}
        <div className="flex-1" />
        <Link href={href} className={`text-[14px] ${link}`}>{linkText}</Link>
      </div>
      <div className={sheet}>{children}</div>
    </section>
  );
}

export default function HomeStrips() {
  const { activeOrgId, uid } = useRole();
  const [libs, setLibs] = useState<LibRow[] | null>(null);
  const [projects, setProjects] = useState<ProjRow[] | null>(null);

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
        // Only yours: the projects you own or are a member of.
        const [{ data }, mine] = await Promise.all([
          supabase.from("projects")
            .select("id, name, owner_user_id, owner_user_name, moc_reference, last_activity_at, target_completion_date, timezone, phases, st_phases:shift_times->phases")
            .eq("org_id", activeOrgId).eq("status", "active")
            .order("last_activity_at", { ascending: false, nullsFirst: false }).limit(200),
          uid ? myProjectIds(activeOrgId, uid) : Promise.resolve(new Set<string>()),
        ]);
        const now = Date.now();
        const rows = ((data ?? []) as Array<{
          id: string; name: string | null; owner_user_id: string | null; owner_user_name: string | null; moc_reference: string | null;
          last_activity_at: string | null; target_completion_date: string | null; timezone?: string | null; phases?: unknown; st_phases?: unknown;
        }>).filter((p) => mine.has(p.id) || (!!uid && p.owner_user_id === uid)).slice(0, 12).map((p) => {
          const due = projectDue(phasesOfRow({ phases: p.phases, shift_times: p.st_phases != null ? { phases: p.st_phases } : null }), p.target_completion_date, dayKey(now, p.timezone || "America/Los_Angeles"));
          return {
            id: p.id, name: p.name ?? "Untitled project",
            owner: p.owner_user_id && p.owner_user_id === uid ? "You" : p.owner_user_name,
            moc: p.moc_reference, lastActivity: p.last_activity_at,
            due: due ? projectDueWords(due) : null, late: due?.kind === "past target", timezone: p.timezone ?? null,
          };
        });
        if (alive) setProjects(rows);
      } catch { if (alive) setProjects([]); }
    })();
    return () => { alive = false; };
  }, [activeOrgId, uid]);

  if (!libs?.length && !projects?.length) return null;
  return <Strips libs={libs} projects={projects} orgId={activeOrgId} />;
}

/** A project's state as a pill: work done in green, late in red, else running. */
function ProjState({ p, pct }: { p: ProjRow; pct: number | undefined }) {
  // All the work done outranks a target date: the rest is close-out.
  if (pct != null && pct >= 100) return <StatusTag tone="released">Work done</StatusTag>;
  if (p.late) return <StatusTag tone="overdue">Late</StatusTag>;
  return <StatusTag tone="neutral">Active</StatusTag>;
}

function Strips({ libs, projects, orgId }: { libs: LibRow[] | null; projects: ProjRow[] | null; orgId: string | null | undefined }) {
  const router = useRouter();
  const progress = useProjectProgress(orgId, projects ?? [], 8);
  const both = !!libs?.length && !!projects?.length;

  return (
    <div className={`grid gap-x-6 gap-y-8 ${both ? "xl:grid-cols-2" : ""}`}>
      {!!libs?.length && (
        <Section title="Libraries" icon={<Library className="w-4 h-4" />} count={libs.length} href="/documents" linkText="All documents">
          <table className="w-full text-[15px]">
            <thead className={thead}>
              <tr>
                <th className={th}>Library</th>
                <th className={`${th} text-right`}>Documents</th>
                <th className={`${th} text-right`}>Checked out</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {libs.map((l) => (
                <tr key={l.id} className={rowHover} onClick={() => router.push(`/documents/${l.id}`)}>
                  <td className="px-4 py-2 max-w-0 w-full">
                    <span className="flex items-center gap-3 min-w-0">
                      <span aria-hidden className="ui-icon-tile is-sm"><FolderOpen className="w-4 h-4" /></span>
                      <Link href={`/documents/${l.id}`} onClick={(e) => e.stopPropagation()}
                        className="min-w-0 truncate font-semibold text-[var(--color-text)] hover:text-[var(--color-accent-text)]">{l.name}</Link>
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    {l.docs == null ? <span className="text-[var(--color-text-faint)]">–</span> : <span className="ui-count">{num(l.docs)}</span>}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {l.out == null ? <span className="text-[var(--color-text-faint)]">–</span>
                      : l.out > 0 ? <span className="ui-count is-warn">{num(l.out)}</span>
                        : <span className="font-display font-semibold tabular-nums text-[var(--color-text-muted)]">0</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
      {!!projects?.length && (
        <Section title={projects.length === 1 ? "Your project" : "Your projects"} icon={<Briefcase className="w-4 h-4" />} count={projects.length} href="/projects" linkText="All projects">
          <div className="@container">
            <table className="hidden @[30rem]:table w-full text-[15px]">
              <thead className={thead}>
                <tr>
                  <th className={th}>Project</th>
                  <th className={th}>Status</th>
                  <th className={`${th} hidden @[52rem]:table-cell`}>Owner</th>
                  <th className={th}>Dates</th>
                  <th className={`${th} hidden @[44rem]:table-cell`}>Last activity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {projects.map((p) => (
                  <tr key={p.id} className={rowHover} onClick={() => router.push(`/projects/${p.id}`)}>
                    <td className="relative px-4 py-2.5 max-w-0 w-full">
                      {p.late && (progress.get(p.id)?.pct ?? 0) < 100 && <LateEdge />}
                      <Link href={`/projects/${p.id}`} onClick={(e) => e.stopPropagation()}
                        className="block truncate font-semibold text-[var(--color-text)] hover:text-[var(--color-accent-text)]">{p.name}</Link>
                      {(progress.get(p.id) !== undefined || p.moc) && (
                        <span className="mt-1 flex items-center gap-x-4 gap-y-1 flex-wrap text-[13px] text-[var(--color-text-muted)]">
                          {(() => {
                            const pr = progress.get(p.id);
                            if (pr) return <WorkBar pct={pr.pct} late={p.late && pr.pct < 100} width="w-28" title={`${pr.done} of ${pr.steps} steps done`} />;
                            if (pr === null) return <span>No schedule yet</span>;
                            return null;
                          })()}
                          {p.moc && <span>MOC <span className="ui-id">{p.moc}</span></span>}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap"><ProjState p={p} pct={progress.get(p.id)?.pct} /></td>
                    <td className="hidden @[52rem]:table-cell px-4 py-2.5 text-[var(--color-text-muted)] whitespace-nowrap">{p.owner ?? "–"}</td>
                    <td className={`px-4 py-2.5 whitespace-nowrap text-[14px] ${p.late ? "font-semibold text-[var(--state-overdue)]" : "text-[var(--color-text)]"}`}>
                      {p.due ?? <span className="text-[var(--color-text-muted)]">–</span>}
                    </td>
                    <td className="hidden @[44rem]:table-cell px-4 py-2.5 text-[var(--color-text-muted)] whitespace-nowrap">{ago(p.lastActivity) || "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="@[30rem]:hidden divide-y divide-[var(--color-border)]">
              {projects.map((p) => (
                <li key={p.id} className="relative">
                  {p.late && (progress.get(p.id)?.pct ?? 0) < 100 && <LateEdge />}
                  <Link href={`/projects/${p.id}`} className="block px-4 py-3 hover:bg-[var(--color-surface-2)]">
                    <span className="flex items-center gap-3">
                      <span className="min-w-0 flex-1 truncate font-semibold text-[15px] text-[var(--color-text)]">{p.name}</span>
                      <ProjState p={p} pct={progress.get(p.id)?.pct} />
                    </span>
                    <span className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-[var(--color-text-muted)]">
                      {progress.get(p.id) && <WorkBar pct={progress.get(p.id)!.pct} late={p.late && progress.get(p.id)!.pct < 100} width="w-20" />}
                      {p.due && <span className={p.late ? "font-semibold text-[var(--state-overdue)]" : ""}>{p.due}</span>}
                      {p.lastActivity && <span>Last activity {agoLower(p.lastActivity)}</span>}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </Section>
      )}
    </div>
  );
}
