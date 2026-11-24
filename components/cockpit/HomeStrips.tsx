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
import { useRole } from "@/components/providers/RoleContext";
import { sharedLoad, lastLoaded } from "@/lib/warmLoads";
import { homeLibrariesKey, homeProjectsKey, loadHomeLibraries, loadHomeProjects, type HomeLibRow, type HomeProjRow, type LastChange } from "@/lib/dashboard/widgetLoads";
import { transitionPush, onTransitionClick } from "@/lib/viewTransition";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { sheet, thead, th, rowHover, link, StatusTag, LateEdge, WorkBar, agoWords, SectionHead } from "./ui";
import { useProjectProgress } from "./projectProgress";

// The loads live in lib/dashboard/widgetLoads (sign-in starts them too).
type LibRow = HomeLibRow;
type ProjRow = HomeProjRow;

const num = (n: number | null) => (n == null ? "–" : n.toLocaleString());

export default function HomeStrips() {
  const { activeOrgId, uid } = useRole();
  const libsKey = activeOrgId ? homeLibrariesKey(activeOrgId, uid ?? null) : null;
  const projKey = activeOrgId ? homeProjectsKey(activeOrgId, uid ?? null) : null;
  // This screen's answers, with the keys they were read for; until they
  // come, the last ones read (Home opened again shows them at once).
  const [gotLibs, setLibs] = useState<{ key: string; v: LibRow[] } | null>(null);
  const [gotProj, setProjects] = useState<{ key: string; v: ProjRow[] } | null>(null);
  const libs = (gotLibs && gotLibs.key === libsKey ? gotLibs.v : lastLoaded<LibRow[]>(libsKey)) ?? null;
  const projects = (gotProj && gotProj.key === projKey ? gotProj.v : lastLoaded<ProjRow[]>(projKey)) ?? null;

  useEffect(() => {
    if (!activeOrgId || !libsKey || !projKey) return;
    let alive = true;
    const me = uid ?? null;
    // Sign-in may have started these; a reader a moment ago shares its load.
    void sharedLoad(libsKey, () => loadHomeLibraries(activeOrgId, me), { maxAgeMs: 1500 })
      .then((v) => { if (alive) setLibs({ key: libsKey, v }); }, () => { if (alive) setLibs({ key: libsKey, v: [] }); });
    void sharedLoad(projKey, () => loadHomeProjects(activeOrgId, me), { maxAgeMs: 1500 })
      .then((v) => { if (alive) setProjects({ key: projKey, v }); }, () => { if (alive) setProjects({ key: projKey, v: [] }); });
    return () => { alive = false; };
  }, [activeOrgId, uid, libsKey, projKey]);

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
    : l.out > 0 ? <span className="font-medium tabular-nums text-[var(--state-held-text)]">{num(l.out)}</span>
      : <span className="tabular-nums text-[var(--color-text-faint)]">0</span>;
  const docsCell = (l: LibRow) => l.docs == null ? <span className="text-[var(--color-text-faint)]">–</span>
    : <span className={`tabular-nums ${l.docs === 0 ? "text-[var(--color-text-faint)]" : "text-[var(--color-text)]"}`}>{num(l.docs)}</span>;

  return (
    <div className={`grid gap-x-8 gap-y-8 ${both ? "xl:grid-cols-[minmax(0,62fr)_minmax(0,38fr)]" : ""}`}>
      {!!libs?.length && (
        <section aria-label="Libraries" className="min-w-0">
          <SectionHead title="Libraries" count={libs.length > 1 ? libs.length : undefined}>
            <Link href="/documents" className={`text-body ${link}`}>All documents</Link>
          </SectionHead>
          <div className={`${sheet} @container`}>
            <table className="hidden @[30rem]:table w-full text-body">
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
                        className="block truncate font-medium text-[var(--color-text)] hover:text-[var(--color-accent-text)]">{l.name}</Link>
                      <span className="@[44rem]:hidden block mt-0.5 text-body truncate"><Changed last={l.last} /></span>
                    </td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">{docsCell(l)}</td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">{outCell(l)}</td>
                    <td className="hidden @[44rem]:table-cell px-4 py-2.5 max-w-0 text-body"><div className="flex min-w-0"><Changed last={l.last} /></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* Narrow: a card per library. */}
            <ul className="@[30rem]:hidden divide-y divide-[var(--color-border)]">
              {libs.map((l) => (
                <li key={l.id}>
                  <Link href={`/documents/${l.id}`} onClick={(e) => onTransitionClick(e, () => router.push(`/documents/${l.id}`))} className="block px-4 py-3 hover:bg-[var(--color-surface-2)]">
                    <span className="block truncate font-medium text-reading text-[var(--color-text)]">{l.name}</span>
                    <span className="mt-0.5 flex flex-wrap gap-x-4 text-body text-[var(--color-text-muted)]">
                      <span>Documents {docsCell(l)}</span>
                      <span>Checked out {outCell(l)}</span>
                    </span>
                    <span className="mt-0.5 flex min-w-0 text-body"><Changed last={l.last} /></span>
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
            <Link href="/projects" className={`text-body ${link}`}>All projects</Link>
          </SectionHead>
          <div className={`${sheet} @container`}>
            <table className="hidden @[36rem]:table w-full text-body">
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
                        className="block truncate font-medium text-[var(--color-text)] hover:text-[var(--color-accent-text)]">{p.name}</Link>
                      {(progress.get(p.id) !== undefined || p.moc) && (
                        <span className="mt-1 flex items-center gap-x-4 gap-y-1 flex-wrap text-body text-[var(--color-text-muted)]">
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
                    <td className={`px-4 py-2.5 whitespace-nowrap text-body ${p.late && (progress.get(p.id)?.pct ?? 0) < 100 ? "font-medium text-[var(--state-overdue-text)]" : "text-[var(--color-text)]"}`}>
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
                        <span className="min-w-0 flex-1 truncate font-medium text-reading text-[var(--color-text)]">{p.name}</span>
                        <ProjState p={p} pct={pr?.pct} />
                      </span>
                      <span className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-body text-[var(--color-text-muted)]">
                        {pr && <WorkBar pct={pr.pct} late={p.late && pr.pct < 100} width="w-20" title={`${pr.done} of ${pr.steps} steps done`} />}
                        {p.due && <span className={p.late && (pr?.pct ?? 0) < 100 ? "font-medium text-[var(--state-overdue-text)]" : ""}>{p.due}</span>}
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
