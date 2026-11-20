"use client";

// Home's "your work": the document libraries and the active projects, each a
// compact ruled table with its counts (documents and checked out per library;
// owner, dates and last activity per project). Side by side on a wide
// screen, stacked on a phone. The numbers come from the same counts the
// libraries use; a count that couldn't be read shows a dash, never a wrong 0.

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import { phasesOfRow, projectDue, projectDueWords } from "@/lib/projectPhases";
import { dayKey } from "@/lib/scheduleTz";
import { sheet, thead, th, rowHover, link, StatusTag, LateEdge, humanDate } from "./ui";

/** Counts are null when they couldn't be read. */
interface LibRow { id: string; name: string; docs: number | null; out: number | null }
interface ProjRow {
  id: string; name: string; owner: string | null; moc: string | null; lastActivity: string | null;
  due: string | null; late: boolean;
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

function Section({ title, href, linkText, children }: { title: string; href: string; linkText: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="min-w-0">
      <div className="flex items-center gap-3 mb-2.5 min-h-9">
        <h2 className="font-display text-[19px] leading-tight font-semibold text-[var(--color-text)]">{title}</h2>
        <div className="flex-1" />
        <Link href={href} className={`text-[14px] ${link}`}>{linkText}</Link>
      </div>
      <div className={sheet}>{children}</div>
    </section>
  );
}

export default function HomeStrips() {
  const { activeOrgId, uid } = useRole();
  const router = useRouter();
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
  const both = !!libs?.length && !!projects?.length;

  return (
    <div className={`grid gap-x-6 gap-y-8 ${both ? "xl:grid-cols-2" : ""}`}>
      {!!libs?.length && (
        <Section title="Libraries" href="/documents" linkText="All documents">
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
                  <td className="px-4 py-2.5 max-w-0 w-full">
                    <Link href={`/documents/${l.id}`} onClick={(e) => e.stopPropagation()}
                      className="block truncate font-semibold text-[var(--color-text)] hover:text-[var(--color-accent-text)]">{l.name}</Link>
                  </td>
                  <td className="px-4 py-2.5 text-right font-display tabular-nums text-[var(--color-text)]">{num(l.docs)}</td>
                  <td className="px-4 py-2.5 text-right font-display tabular-nums text-[var(--color-text-muted)]">{num(l.out)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
      {!!projects?.length && (
        <Section title={projects.length === 1 ? "Your project" : "Active projects"} href="/projects" linkText="All projects">
          <div className="@container">
            <table className="hidden @[30rem]:table w-full text-[15px]">
              <thead className={thead}>
                <tr>
                  <th className={th}>Project</th>
                  <th className={`${th} hidden @[40rem]:table-cell`}>Owner</th>
                  <th className={th}>Dates</th>
                  <th className={th}>Last activity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {projects.map((p) => (
                  <tr key={p.id} className={rowHover} onClick={() => router.push(`/projects/${p.id}`)}>
                    <td className="relative px-4 py-2.5 max-w-0 w-full">
                      {p.late && <LateEdge />}
                      <Link href={`/projects/${p.id}`} onClick={(e) => e.stopPropagation()}
                        className="block truncate font-semibold text-[var(--color-text)] hover:text-[var(--color-accent-text)]">{p.name}</Link>
                      {p.moc && <span className="block text-[13px] text-[var(--color-text-muted)] truncate">MOC <span className="font-display tabular-nums">{p.moc}</span></span>}
                    </td>
                    <td className="hidden @[40rem]:table-cell px-4 py-2.5 text-[var(--color-text-muted)] whitespace-nowrap">{p.owner ?? "–"}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      {p.due ? (p.late ? <StatusTag tone="overdue">{p.due}</StatusTag> : <span className="text-[14px] text-[var(--color-text)]">{p.due}</span>) : <span className="text-[var(--color-text-muted)]">–</span>}
                    </td>
                    <td className="px-4 py-2.5 text-[var(--color-text-muted)] whitespace-nowrap">{ago(p.lastActivity) || "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="@[30rem]:hidden divide-y divide-[var(--color-border)]">
              {projects.map((p) => (
                <li key={p.id} className="relative">
                  {p.late && <LateEdge />}
                  <Link href={`/projects/${p.id}`} className="block px-4 py-3 hover:bg-[var(--color-surface-2)]">
                    <span className="flex items-baseline gap-3">
                      <span className="min-w-0 flex-1 truncate font-semibold text-[15px] text-[var(--color-text)]">{p.name}</span>
                      {p.due && (p.late ? <StatusTag tone="overdue">{p.due}</StatusTag> : <span className="shrink-0 text-[13px] text-[var(--color-text)]">{p.due}</span>)}
                    </span>
                    <span className="mt-0.5 block text-[13px] text-[var(--color-text-muted)] truncate">
                      {[p.owner, p.lastActivity ? `last activity ${agoLower(p.lastActivity)}` : null].filter(Boolean).join(", ")}
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
