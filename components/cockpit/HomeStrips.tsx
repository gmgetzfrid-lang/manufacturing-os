"use client";

// Home's "your work": the document libraries and the active projects you own
// or are on. Libraries take the wide side (about 62%): each with its counts
// (documents, checked out) and what changed last in it (which document, who,
// when). Your projects take the narrow side (about 38%): state, dates and
// last activity. Stacked on a phone, where each row is a card. The numbers
// come from the same counts the libraries use; a count that couldn't be
// read shows a dash, never a wrong 0.

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import { phasesOfRow, projectDue, projectDueWords } from "@/lib/projectPhases";
import { myProjectIds } from "@/lib/projects";
import { dayKey } from "@/lib/scheduleTz";
import { transitionPush, onTransitionClick } from "@/lib/viewTransition";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { sheet, thead, th, rowHover, link, StatusTag, LateEdge, WorkBar, agoWords, SectionHead } from "./ui";
import { useProjectProgress } from "./projectProgress";

/** What changed last in a library: the document, who, when. */
interface LastChange { label: string; rev: string | null; by: string | null; at: string }
/** Counts are null when they couldn't be read. */
interface LibRow { id: string; name: string; docs: number | null; out: number | null; last: LastChange | null }
interface ProjRow {
  id: string; name: string; owner: string | null; moc: string | null; lastActivity: string | null;
  due: string | null; late: boolean; timezone: string | null;
}

async function headCount(build: () => PromiseLike<{ count: number | null; error: unknown }>): Promise<number | null> {
  try { const r = await build(); return r.error ? null : r.count; } catch { return null; }
}

const num = (n: number | null) => (n == null ? "–" : n.toLocaleString());

/** The most recently changed document in each library, with who changed
 *  it (names read in one batch). Best effort: a failure leaves it blank. */
async function lastChanges(orgId: string, libIds: string[], uid: string | null): Promise<Map<string, LastChange>> {
  const out = new Map<string, LastChange>();
  try {
    const rows = await Promise.all(libIds.map(async (id) => {
      const { data } = await supabase.from("documents")
        .select("library_id, document_number, title, name, rev, revision, updated_at, updated_by")
        .eq("org_id", orgId).eq("library_id", id).not("updated_at", "is", null)
        .order("updated_at", { ascending: false }).limit(1);
      return ((data ?? []) as Array<Record<string, unknown>>)[0] ?? null;
    }));
    const who = [...new Set(rows.map((r) => (r?.updated_by as string | null) ?? null).filter((x): x is string => !!x))];
    const names = new Map<string, string>();
    if (who.length) {
      const { data } = await supabase.from("users").select("id, display_name, email").in("id", who);
      for (const u of (data ?? []) as Array<{ id: string; display_name: string | null; email: string | null }>) {
        names.set(u.id, u.id === uid ? "you" : u.display_name || (u.email ?? "").split("@")[0] || "");
      }
    }
    rows.forEach((r, i) => {
      if (!r?.updated_at) return;
      const label = String(r.document_number || r.title || r.name || "A document");
      const rev = (r.rev ?? r.revision ?? null) as string | null;
      const by = r.updated_by ? names.get(String(r.updated_by)) || null : null;
      out.set(libIds[i], { label, rev: rev ? String(rev) : null, by, at: String(r.updated_at) });
    });
  } catch { /* the column stays blank */ }
  return out;
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
        const [counted, last] = await Promise.all([
          Promise.all(rows.map(async (l) => ({
            id: l.id,
            name: l.name ?? "Library",
            docs: await headCount(() => supabase.from("documents").select("id", { count: "exact", head: true }).eq("org_id", activeOrgId).eq("library_id", l.id)),
            out: await headCount(() => supabase.from("documents").select("id", { count: "exact", head: true }).eq("org_id", activeOrgId).eq("library_id", l.id).not("checked_out_by", "is", null)),
          }))),
          lastChanges(activeOrgId, rows.map((l) => l.id), uid ?? null),
        ]);
        const withLast: LibRow[] = counted.map((l) => ({ ...l, last: last.get(l.id) ?? null }));
        // The library changed most recently first, so the busy ones are in sight.
        withLast.sort((a, b) => (b.last?.at ?? "").localeCompare(a.last?.at ?? "") || ((b.docs ?? 0) > 0 ? 1 : 0) - ((a.docs ?? 0) > 0 ? 1 : 0));
        if (alive) setLibs(withLast);
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

  // While both load: the shape of what's coming, in place.
  if (libs === null && projects === null) {
    return (
      <div className="grid gap-x-8 gap-y-8 xl:grid-cols-[minmax(0,62fr)_minmax(0,38fr)]" aria-busy="true">
        <section className="min-w-0"><SectionHead title="Libraries" /><SkeletonRows rows={4} cols={2} what="libraries" /></section>
        <section className="min-w-0"><SectionHead title="Your projects" /><SkeletonRows rows={2} cols={1} what="your projects" /></section>
      </div>
    );
  }
  if (!libs?.length && !projects?.length) return null;
  return <Strips libs={libs} projects={projects} orgId={activeOrgId} />;
}

/** A project's state: work done in green, late in red, else running. */
function ProjState({ p, pct }: { p: ProjRow; pct: number | undefined }) {
  // All the work done outranks a target date: the rest is close-out.
  if (pct != null && pct >= 100) return <StatusTag tone="released">Work done</StatusTag>;
  if (p.late) return <StatusTag tone="overdue">Late</StatusTag>;
  return <StatusTag tone="neutral">Active</StatusTag>;
}

/** "5602-D 1000 Rev 10" then "by eng, 2 h ago". */
function Changed({ last, compact = false }: { last: LastChange | null; compact?: boolean }) {
  if (!last) return <span className="text-[var(--color-text-faint)]">No changes yet</span>;
  return (
    <span className={`min-w-0 inline-flex items-baseline gap-1.5 ${compact ? "" : "max-w-full"}`}>
      <span className="ui-id truncate">{last.label}{last.rev ? ` Rev ${last.rev}` : ""}</span>
      <span className="shrink-0 text-[var(--color-text-muted)] whitespace-nowrap">{last.by ? `by ${last.by}, ` : ""}{agoWords(last.at).replace(/^(Just now|Yesterday)$/, (m) => m.toLowerCase())}</span>
    </span>
  );
}

function Strips({ libs, projects, orgId }: { libs: LibRow[] | null; projects: ProjRow[] | null; orgId: string | null | undefined }) {
  const router = useRouter();
  const progress = useProjectProgress(orgId, projects ?? [], 8);
  const both = !!libs?.length && !!projects?.length;
  const go = (href: string) => transitionPush(router, href);
  const outCell = (l: LibRow) => l.out == null ? <span className="text-[var(--color-text-faint)]">–</span>
    : l.out > 0 ? <span className="font-semibold tabular-nums text-[var(--state-held-text)]">{num(l.out)}</span>
      : <span className="tabular-nums text-[var(--color-text-faint)]">0</span>;
  const docsCell = (l: LibRow) => l.docs == null ? <span className="text-[var(--color-text-faint)]">–</span>
    : <span className={`tabular-nums ${l.docs === 0 ? "text-[var(--color-text-faint)]" : "text-[var(--color-text)]"}`}>{num(l.docs)}</span>;

  return (
    <div className={`grid gap-x-8 gap-y-8 ${both ? "xl:grid-cols-[minmax(0,62fr)_minmax(0,38fr)]" : ""}`}>
      {!!libs?.length && (
        <section aria-label="Libraries" className="min-w-0">
          <SectionHead title="Libraries" count={libs.length > 1 ? libs.length : undefined}>
            <Link href="/documents" className={`text-[14px] ${link}`}>All documents</Link>
          </SectionHead>
          <div className={`${sheet} @container`}>
            <table className="hidden @[30rem]:table w-full text-[15px]">
              <thead className={thead}>
                <tr>
                  <th className={th}>Library</th>
                  <th className={`${th} text-right`}>Documents</th>
                  <th className={`${th} text-right`}>Checked out</th>
                  <th className={`${th} hidden @[44rem]:table-cell`}>Last change</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {libs.map((l) => (
                  <tr key={l.id} className={rowHover} onClick={() => go(`/documents/${l.id}`)}>
                    <td className="px-4 py-2.5 max-w-0 w-[34%]">
                      <Link href={`/documents/${l.id}`} onClick={(e) => { e.stopPropagation(); onTransitionClick(e, () => router.push(`/documents/${l.id}`)); }}
                        className="block truncate font-semibold text-[var(--color-text)] hover:text-[var(--color-accent-text)]">{l.name}</Link>
                      <span className="@[44rem]:hidden block mt-0.5 text-[13px] truncate"><Changed last={l.last} /></span>
                    </td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">{docsCell(l)}</td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">{outCell(l)}</td>
                    <td className="hidden @[44rem]:table-cell px-4 py-2.5 max-w-0 text-[14px]"><div className="flex min-w-0"><Changed last={l.last} /></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* Narrow: a card per library. */}
            <ul className="@[30rem]:hidden divide-y divide-[var(--color-border)]">
              {libs.map((l) => (
                <li key={l.id}>
                  <Link href={`/documents/${l.id}`} onClick={(e) => onTransitionClick(e, () => router.push(`/documents/${l.id}`))} className="block px-4 py-3 hover:bg-[var(--color-surface-2)]">
                    <span className="block truncate font-semibold text-[15px] text-[var(--color-text)]">{l.name}</span>
                    <span className="mt-0.5 flex flex-wrap gap-x-4 text-[13px] text-[var(--color-text-muted)]">
                      <span>Documents {docsCell(l)}</span>
                      <span>Checked out {outCell(l)}</span>
                    </span>
                    <span className="mt-0.5 flex min-w-0 text-[13px]"><Changed last={l.last} /></span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
      {!!projects?.length && (
        <section aria-label="Your projects" className="min-w-0">
          <SectionHead title={projects.length === 1 ? "Your project" : "Your projects"} count={projects.length > 1 ? projects.length : undefined}>
            <Link href="/projects" className={`text-[14px] ${link}`}>All projects</Link>
          </SectionHead>
          <div className={`${sheet} @container`}>
            <table className="hidden @[36rem]:table w-full text-[15px]">
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
                  <tr key={p.id} className={rowHover} onClick={() => go(`/projects/${p.id}`)}>
                    <td className="relative px-4 py-2.5 max-w-0 w-full">
                      {p.late && (progress.get(p.id)?.pct ?? 0) < 100 && <LateEdge />}
                      <Link href={`/projects/${p.id}`} onClick={(e) => { e.stopPropagation(); onTransitionClick(e, () => router.push(`/projects/${p.id}`)); }}
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
                    <td className={`px-4 py-2.5 whitespace-nowrap text-[14px] ${p.late && (progress.get(p.id)?.pct ?? 0) < 100 ? "font-semibold text-[var(--state-overdue-text)]" : "text-[var(--color-text)]"}`}>
                      {p.due ?? <span className="text-[var(--color-text-muted)]">–</span>}
                    </td>
                    <td className="hidden @[44rem]:table-cell px-4 py-2.5 text-[var(--color-text-muted)] whitespace-nowrap">{agoWords(p.lastActivity) || "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* Narrow (the 38% side, a phone): a card per project. */}
            <ul className="@[36rem]:hidden divide-y divide-[var(--color-border)]">
              {projects.map((p) => {
                const pr = progress.get(p.id);
                return (
                  <li key={p.id} className="relative">
                    {p.late && (pr?.pct ?? 0) < 100 && <LateEdge />}
                    <Link href={`/projects/${p.id}`} onClick={(e) => onTransitionClick(e, () => router.push(`/projects/${p.id}`))} className="block px-4 py-3 hover:bg-[var(--color-surface-2)]">
                      <span className="flex items-center gap-3">
                        <span className="min-w-0 flex-1 truncate font-semibold text-[15px] text-[var(--color-text)]">{p.name}</span>
                        <ProjState p={p} pct={pr?.pct} />
                      </span>
                      <span className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-[var(--color-text-muted)]">
                        {pr && <WorkBar pct={pr.pct} late={p.late && pr.pct < 100} width="w-20" title={`${pr.done} of ${pr.steps} steps done`} />}
                        {p.due && <span className={p.late && (pr?.pct ?? 0) < 100 ? "font-semibold text-[var(--state-overdue-text)]" : ""}>{p.due}</span>}
                        {p.lastActivity && <span>Last activity {agoWords(p.lastActivity).replace(/^(Just now|Yesterday)$/, (m) => m.toLowerCase())}</span>}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      )}
    </div>
  );
}
