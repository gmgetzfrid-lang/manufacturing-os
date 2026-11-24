"use client";

// /checkouts — every active checkout in the org, in one place.
//
// Two display modes (toggle): grouped by project, or flat list. Filters
// by library, by user, by project status, by mode. Anyone can open this
// page — collaboration depends on everyone seeing what's locked.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Search, Lock,
  ExternalLink, ChevronDown, ChevronRight,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { SkeletonRows } from "@/components/ui/Skeleton";
import ErrorNote from "@/components/ui/ErrorNote";
import { friendlyError } from "@/lib/friendlyError";
import { transitionPush } from "@/lib/viewTransition";
import { Button } from "@/components/ui/Button";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card } from "@/components/ui/PageHero";
import { bandInput, bandInputIcon, bandSelect, bandSeg, bandSegItem } from "@/components/admin/band";
import { useRole } from "@/components/providers/RoleContext";
import { listAllActiveCheckouts, autoReleaseExpiredAdHoc } from "@/lib/projects";
import { findCheckoutOverlaps, type ConsolidationOverlap } from "@/lib/consolidation";
import { notifyMany } from "@/lib/inAppNotifications";
import { useToast } from "@/components/providers/ToastProvider";
import StaleCheckoutBanner from "@/components/projects/StaleCheckoutBanner";
import EditOverlapBanner from "@/components/documents/EditOverlapBanner";
import DocViewTabs from "@/components/documents/DocViewTabs";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { supabase } from "@/lib/supabase";
import { Send } from "lucide-react";
import type { CheckoutSession, Project, Timestamp } from "@/types/schema";

type CheckoutWithContext = CheckoutSession & {
  docNumber?: string;
  docTitle?: string;
  libraryName?: string;
  project?: Project | null;
};

export default function CheckoutsPage() {
  const { activeOrgId, uid, userEmail } = useRole();
  const { showToast } = useToast();

  const [rows, setRows] = useState<CheckoutWithContext[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Phase 6 — scope-consolidation signals computed from the active
  // checkout list. Asset and scope overlaps; same-document and
  // same-project overlaps are covered by other UIs.
  const [overlaps, setOverlaps] = useState<ConsolidationOverlap[]>([]);
  const [consolidationOpen, setConsolidationOpen] = useState(true);

  const [view, setView] = useState<"grouped" | "flat">("grouped");
  const [search, setSearch] = useState("");
  const [libraryFilter, setLibraryFilter] = useState<string>("");
  const [userFilter, setUserFilter] = useState<string>("");

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    setLoading(true);
    setError(null);
    try {
      // Opportunistically auto-release expired ad-hoc checkouts on load —
      // keeps the list honest without needing a server cron.
      await autoReleaseExpiredAdHoc(activeOrgId);

      const sessions = await listAllActiveCheckouts(activeOrgId);
      if (sessions.length === 0) {
        setRows([]); setLoading(false); return;
      }

      // Hydrate document + library + project context in parallel
      const docIds = Array.from(new Set(sessions.map((s) => s.documentId).filter(Boolean)));
      const libIds = Array.from(new Set(sessions.map((s) => s.libraryId).filter(Boolean)));
      const projIds = Array.from(new Set(sessions.map((s) => s.projectId).filter(Boolean) as string[]));

      const [docsRes, libsRes, projsRes] = await Promise.all([
        docIds.length ? supabase.from("documents").select("id, document_number, title, name").in("id", docIds) : Promise.resolve({ data: [] }),
        libIds.length ? supabase.from("libraries").select("id, name").in("id", libIds) : Promise.resolve({ data: [] }),
        projIds.length ? supabase.from("projects").select("*").in("id", projIds) : Promise.resolve({ data: [] }),
      ]);

      const docMap = new Map<string, { docNumber?: string; docTitle?: string }>();
      (docsRes.data as Array<{ id: string; document_number?: string; title?: string; name?: string }> || [])
        .forEach((d) => docMap.set(d.id, { docNumber: d.document_number, docTitle: d.title || d.name }));
      const libMap = new Map<string, string>();
      (libsRes.data as Array<{ id: string; name?: string }> || []).forEach((l) => libMap.set(l.id, l.name ?? ""));
      const projMap = new Map<string, Project>();
      (projsRes.data as Array<Record<string, unknown>> || []).forEach((p) => {
        projMap.set(p.id as string, {
          id: p.id as string, orgId: p.org_id as string, name: p.name as string,
          description: p.description as string | undefined, status: p.status as Project["status"],
          ownerUserId: p.owner_user_id as string, ownerUserName: p.owner_user_name as string | undefined,
          visibility: p.visibility as Project["visibility"],
          createdBy: p.created_by as string,
          lastActivityAt: p.last_activity_at as Project["lastActivityAt"],
        });
      });

      const enriched: CheckoutWithContext[] = sessions.map((s) => ({
        ...s,
        docNumber: docMap.get(s.documentId)?.docNumber,
        docTitle: docMap.get(s.documentId)?.docTitle,
        libraryName: s.libraryId ? libMap.get(s.libraryId) : undefined,
        project: s.projectId ? projMap.get(s.projectId) ?? null : null,
      }));

      setRows(enriched);

      // Compute overlaps off the loaded sessions. One DB read pair
      // (document_assets + documents.plant/unit/system).
      try {
        const ov = await findCheckoutOverlaps({ activeCheckouts: sessions });
        setOverlaps(ov);
      } catch {
        // Non-fatal — the consolidation signal is supplementary.
        setOverlaps([]);
      }
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }, [activeOrgId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Filter chain
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (libraryFilter && r.libraryId !== libraryFilter) return false;
      if (userFilter && r.userId !== userFilter) return false;
      if (q) {
        const blob = `${r.docNumber || ""} ${r.docTitle || ""} ${r.userName || ""} ${r.project?.name || ""} ${r.purpose || r.note || ""}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  }, [rows, search, libraryFilter, userFilter]);

  // For the grouped view: group by project (and an "Ad-hoc" bucket for null)
  const grouped = useMemo(() => {
    const m = new Map<string, { project: Project | null; items: CheckoutWithContext[] }>();
    for (const r of filtered) {
      const key = r.project?.id ?? "__adhoc__";
      const entry = m.get(key) ?? { project: r.project ?? null, items: [] as CheckoutWithContext[] };
      entry.items.push(r);
      m.set(key, entry);
    }
    return Array.from(m.values()).sort((a, b) => {
      // Project groups first, ad-hoc last
      if (!a.project && b.project) return 1;
      if (a.project && !b.project) return -1;
      return (b.items.length - a.items.length);
    });
  }, [filtered]);

  // Unique users + libs for filter dropdowns
  const uniqueUsers = useMemo(() => {
    const m = new Map<string, string>();
    rows.forEach((r) => m.set(r.userId, r.userName || r.userId.slice(0, 8)));
    return Array.from(m.entries());
  }, [rows]);
  const uniqueLibs = useMemo(() => {
    const m = new Map<string, string>();
    rows.forEach((r) => r.libraryId && m.set(r.libraryId, r.libraryName || r.libraryId.slice(0, 8)));
    return Array.from(m.entries());
  }, [rows]);

  // The answer: how many are locked right now, and what needs a word.
  const mine = rows.filter((r) => r.userId === uid).length;
  const stale = rows.filter((r) => r.expectedReleaseAt && new Date(r.expectedReleaseAt as string) < new Date()).length;
  const answer = loading && rows.length === 0 ? "Checkouts"
    : error ? "Checkouts didn't load."
    : rows.length === 0 ? "Nothing checked out."
    : `${rows.length.toLocaleString()} checked out.`;
  const ready = !loading && !error && rows.length > 0;
  // The numbers that back it up, in ruled cells.
  const answerFacts = ready ? [
    { label: "Past their release date", value: stale.toLocaleString(), tone: stale > 0 ? "bad" as const : undefined, hero: stale > 0 },
    { label: "By you", value: mine.toLocaleString() },
    { label: "Overlapping", value: overlaps.length.toLocaleString(), tone: overlaps.length > 0 ? "warn" as const : undefined },
  ] : undefined;

  return (
    <PageShell width="work">
      <PageHero
        kicker="Document control"
        title={answer}
        sub={
          <>
            Every document locked right now, across every library.{" "}
            <HelpTooltip className="align-middle">
              A <b>checkout</b> says &ldquo;I&rsquo;m working on this drawing, don&rsquo;t touch.&rdquo;
              <b className="block mt-1">Project checkouts</b> are tied to an open project and stay until the project closes or the person releases them.
              <b className="block mt-1">Ad-hoc checkouts</b> release on their own after 24 hours.
              <b className="block mt-1">Shared checkouts</b> let several people work on one drawing together.
            </HelpTooltip>
          </>
        }
        facts={answerFacts}
        factsHero={stale > 0 ? "auto" : "none"}
        tools={
          <div className={bandSeg} role="group" aria-label="Group the list">
            <button type="button" onClick={() => setView("grouped")} aria-pressed={view === "grouped"} className={bandSegItem(view === "grouped")}>
              By project
            </button>
            <button type="button" onClick={() => setView("flat")} aria-pressed={view === "flat"} className={bandSegItem(view === "flat")}>
              One list
            </button>
          </div>
        }
      >
        <DocViewTabs />
        {/* Filters */}
        <div className="mt-4 grid grid-cols-2 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2">
          <div className="relative col-span-2 md:col-span-1">
            <Search className={bandInputIcon} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              type="search"
              placeholder="Search by document, person or project"
              aria-label="Search checkouts"
              className={`${bandInput} max-sm:text-reading`}
            />
          </div>
          <select value={libraryFilter} onChange={(e) => setLibraryFilter(e.target.value)} aria-label="Library" className={`${bandSelect} w-full min-w-0`}>
            <option value="">All libraries</option>
            {uniqueLibs.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <select value={userFilter} onChange={(e) => setUserFilter(e.target.value)} aria-label="Person" className={`${bandSelect} w-full min-w-0`}>
            <option value="">Everyone</option>
            {uniqueUsers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </div>
        {(search.trim() || libraryFilter || userFilter) && rows.length > 0 && (
          <div className="mt-2 flex items-center gap-2 text-body text-[var(--color-text-muted)]">
            <span className="tabular-nums">{filtered.length.toLocaleString()} of {rows.length.toLocaleString()} checkouts</span>
            <button type="button" onClick={() => { setSearch(""); setLibraryFilter(""); setUserFilter(""); }}
              className="font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2 pointer-coarse:min-h-11">Clear</button>
          </div>
        )}
      </PageHero>

      <PageBody>
        {/* What needs a word: checkouts past their date, edits that overlap. */}
        <div className="space-y-3 empty:hidden [&>*]:!mb-0">
          <StaleCheckoutBanner userId={uid ?? undefined} />
          {activeOrgId && uid && (
            <EditOverlapBanner
              orgId={activeOrgId}
              currentUserId={uid}
              currentUserName={userEmail?.split("@")[0] ?? null}
              onlyMine={false}
            />
          )}
        </div>

        {/* Phase 6 — Coordination signals */}
        {overlaps.length > 0 && (
          <ConsolidationPanel
            overlaps={overlaps}
            checkouts={rows}
            isOpen={consolidationOpen}
            onToggle={() => setConsolidationOpen((v) => !v)}
            onNudge={async (overlap, involved) => {
              if (!activeOrgId) return;
              const recipients = Array.from(new Set(
                involved.map((c) => c.userId).filter((u) => u && u !== uid),
              ));
              if (recipients.length === 0) {
                showToast({ type: "info", title: "Nobody to notify", message: "You're the only person on this overlap." });
                return;
              }
              const what =
                overlap.kind === "asset"
                  ? `asset ${overlap.assetTag}`
                  : `${overlap.level === "system" ? "system" : "unit"} ${overlap.scopeName}`;
              const names = involved.map((c) => c.userName || c.userId.slice(0, 8)).join(", ");
              // The link opens a document on the overlap, not just the list.
              const first = involved.find((c) => c.libraryId && c.documentId);
              try {
                await notifyMany({
                  orgId: activeOrgId,
                  userIds: recipients,
                  actorUserId: uid ?? undefined,
                  kind: "checkout_conflict",
                  title: "Overlapping checkouts: talk first",
                  body: `${userEmail?.split("@")[0] ?? "A colleague"} says you're both working on ${what} (${names}). Talk before you issue so changes don't clash.`,
                  link: first ? `/documents/${first.libraryId}?doc=${first.documentId}` : "/checkouts",
                  resourceType: "checkout",
                });
              } catch (e) {
                showToast({ type: "error", title: "The heads-up didn't send", message: friendlyError(e) });
                throw e;
              }
              showToast({ type: "success", title: "Heads-up sent", message: `Told ${recipients.length} ${recipients.length === 1 ? "person" : "people"} about ${what}.` });
            }}
          />
        )}

        {loading ? (
          <SkeletonRows rows={5} cols={4} what="checkouts" />
        ) : error ? (
          <ErrorNote error={error} title="The checkouts didn't load." onRetry={() => void refresh()} />
        ) : filtered.length === 0 ? (
          <Card>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
              <p className="flex-1 min-w-[14rem] text-reading text-[var(--color-text)]">
                {rows.length === 0 ? "No one has a document checked out." : "No checkouts match these filters."}
              </p>
              {rows.length > 0 && (
                <Button variant="secondary" onClick={() => { setSearch(""); setLibraryFilter(""); setUserFilter(""); }}>Clear the filters</Button>
              )}
            </div>
          </Card>
        ) : view === "grouped" ? (
          <>
            {grouped.map((g, idx) => <ProjectGroup key={idx} project={g.project} items={g.items} />)}
          </>
        ) : (
          <CheckoutsTable items={filtered} showProject />
        )}
      </PageBody>
    </PageShell>
  );
}

function ProjectGroup({ project, items }: { project: Project | null; items: CheckoutWithContext[] }) {
  return (
    <section className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-2.5">
        <h2 className="font-display text-section leading-tight font-semibold text-[var(--color-heading)] min-w-0 self-center">
          {project ? (
            <Link href={`/projects/${project.id}`} className="hover:text-[var(--color-accent-text)] hover:underline underline-offset-4">
              {project.name}
            </Link>
          ) : "Ad-hoc checkouts"}
        </h2>
        <span className="text-body text-[var(--color-text-muted)] inline-flex items-center gap-1.5">
          {project ? (
            <>
              {project.ownerUserName && <span>{project.ownerUserName}</span>}
              {project.visibility === "private" && <Lock className="w-3 h-3" aria-label="Private" />}
              {project.status && <span className="ui-pill is-muted">{(() => { const t = String(project.status).replace(/_/g, " "); return t.charAt(0).toUpperCase() + t.slice(1); })()}</span>}
            </>
          ) : (
            <span>Release on their own after 24 hours</span>
          )}
        </span>
        <span className="ml-auto self-center text-body text-[var(--color-text-muted)] tabular-nums">
          {items.length.toLocaleString()} file{items.length === 1 ? "" : "s"}
        </span>
      </div>
      <CheckoutsTable items={items} />
    </section>
  );
}

const MODE_LABEL: Record<string, string> = { view: "View", markup: "Markup", edit: "Edit", drafting: "Drafting" };

/** Every checkout as a row: the document, who has it, since when, when it
 *  comes back. A checkout past its release date gets a red left edge. */
function CheckoutsTable({ items, showProject }: { items: CheckoutWithContext[]; showProject?: boolean }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
      <table className="w-full text-body">
        <thead className="text-body text-[var(--color-text-muted)] text-left max-sm:hidden border-b border-[var(--color-border)]">
          <tr>
            <th className="font-medium px-4 h-10">Document</th>
            <th className="font-medium px-4 hidden lg:table-cell">Library</th>
            <th className="font-medium px-4">Checked out by</th>
            <th className="font-medium px-4 hidden md:table-cell">Kind</th>
            <th className="font-medium px-4">Since</th>
            <th className="font-medium px-4">Release</th>
            {showProject && <th className="font-medium px-4 hidden xl:table-cell">Project</th>}
            <th className="w-12"><span className="sr-only">Open</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {items.map((r) => <CheckoutRow key={r.id} row={r} showProject={showProject} />)}
        </tbody>
      </table>
    </div>
  );
}

function CheckoutRow({ row, showProject }: { row: CheckoutWithContext; showProject?: boolean }) {
  const router = useRouter();
  const isStale = !!row.expectedReleaseAt && new Date(row.expectedReleaseAt as string) < new Date();
  const isAdhoc = !row.projectId;
  const href = `/documents/${row.libraryId}?doc=${row.documentId}`;
  const release = isStale
    ? <span className="ui-pill is-bad">Was due {formatRelative(row.expectedReleaseAt as Timestamp)}</span>
    : row.expectedReleaseAt ? <span>Due {formatRelative(row.expectedReleaseAt as Timestamp)}</span>
    : isAdhoc && row.autoExpiresAt ? <span>Releases {formatRelative(row.autoExpiresAt)}</span>
    : <span className="text-[var(--color-text-muted)]">At check-in</span>;
  const why = row.purpose || row.note;
  const sub = row.docTitle && row.docTitle !== row.docNumber ? row.docTitle : why ? `“${why}”` : null;
  // The whole row opens the document; links inside keep their own clicks.
  const open = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("a,button")) return;
    transitionPush(router, href);
  };
  return (
    <tr onClick={open} className="cursor-pointer hover:bg-[var(--color-surface-2)] transition-colors max-sm:block max-sm:relative">
      <td className="px-4 py-3 relative max-sm:block max-sm:pr-14">
        {isStale && <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--state-overdue)]" />}
        <Link href={href} className="ui-id text-reading">
          {row.docNumber || "-"}
        </Link>
        {sub && (
          <div className="text-body text-[var(--color-text-muted)] truncate max-w-[42ch]" title={why ? `Why: ${why}` : undefined}>{sub}</div>
        )}
        {/* Phone: who, since and release under the document. */}
        <div className="sm:hidden mt-1 flex flex-wrap gap-x-3 text-body text-[var(--color-text-muted)]">
          <span className="font-medium text-[var(--color-text)]">{row.userName}</span>
          <span>{MODE_LABEL[row.mode] ?? row.mode}</span>
          <span>Since {formatRelative(row.startedAt)}</span>
          {release}
        </div>
      </td>
      <td className="px-4 py-3 hidden lg:table-cell">
        {row.libraryName
          ? <Link href={`/documents/${row.libraryId}`} className="ui-tag !font-sans" title={`Open ${row.libraryName}`}>{row.libraryName}</Link>
          : <span className="text-[var(--color-text-muted)]">-</span>}
      </td>
      <td className="px-4 py-3 font-medium text-[var(--color-text)] max-sm:hidden whitespace-nowrap">{row.userName}</td>
      <td className="px-4 py-3 hidden md:table-cell text-[var(--color-text)]">{MODE_LABEL[row.mode] ?? row.mode}</td>
      <td className="px-4 py-3 whitespace-nowrap max-sm:hidden">{formatRelative(row.startedAt)}</td>
      <td className="px-4 py-3 whitespace-nowrap max-sm:hidden">{release}</td>
      {showProject && (
        <td className="px-4 py-3 hidden xl:table-cell">
          {row.project ? (
            <Link href={`/projects/${row.project.id}`} className="text-[var(--color-accent-text)] hover:underline">{row.project.name}</Link>
          ) : <span className="text-[var(--color-text-muted)]">Ad-hoc</span>}
        </td>
      )}
      <td className="pr-3 py-3 text-right max-sm:absolute max-sm:right-1 max-sm:top-1.5">
        <ChevronRight aria-hidden className="inline w-4 h-4 text-[var(--color-text-faint)]" />
      </td>
    </tr>
  );
}

function formatRelative(ts: Timestamp): string {
  if (!ts) return "-";
  try {
    const d = new Date(ts as string);
    const diff = d.getTime() - Date.now();
    const future = diff > 0;
    const abs = Math.abs(diff);
    const min = Math.floor(abs / 60000);
    if (min < 1) return future ? "any moment" : "just now";
    const say = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
    if (min < 60) return future ? `in ${say(min, "min")}` : `${say(min, "min")} ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return future ? `in ${say(hr, "hour")}` : `${say(hr, "hour")} ago`;
    const days = Math.floor(hr / 24);
    if (days > 13) return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return future ? `in ${say(days, "day")}` : `${say(days, "day")} ago`;
  } catch { return "-"; }
}

// ─── Phase 6: Consolidation panel ───────────────────────────────
//
// Surfaces overlap signals computed by lib/consolidation.ts.
// Asset overlaps and scope overlaps are rendered as two stripes
// inside one collapsible panel — visually contained so the queue
// below isn't pushed off-screen.

function ConsolidationPanel({
  overlaps, checkouts, isOpen, onToggle, onNudge,
}: {
  overlaps: ConsolidationOverlap[];
  checkouts: CheckoutWithContext[];
  isOpen: boolean;
  onToggle: () => void;
  onNudge: (overlap: ConsolidationOverlap, involved: CheckoutWithContext[]) => Promise<void>;
}) {
  const assetCount = overlaps.filter((o) => o.kind === "asset").length;
  const scopeCount = overlaps.filter((o) => o.kind === "scope").length;
  const checkoutById = new Map(checkouts.map((c) => [c.id ?? "", c]));

  return (
    <section className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-2.5 min-h-8">
        <h2 className="font-display text-section leading-tight font-semibold text-[var(--color-heading)]">
          Checkouts that overlap
        </h2>
        <span className="text-body text-[var(--color-text-muted)] inline-flex items-center gap-3">
          {assetCount > 0 && <span className="inline-flex items-center gap-1.5"><span className="ui-count is-warn">{assetCount}</span> on the same equipment</span>}
          {scopeCount > 0 && <span className="inline-flex items-center gap-1.5"><span className="ui-count is-warn">{scopeCount}</span> in the same unit or system</span>}
        </span>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={isOpen}
          className="ml-auto inline-flex items-center gap-1.5 h-10 pointer-coarse:h-11 px-3.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
        >
          {isOpen ? "Hide" : "Show"}
          <ChevronDown className={`ui-chevron w-4 h-4 text-[var(--color-text-muted)] ${isOpen ? "rotate-180" : ""}`} />
        </button>
      </div>
      {isOpen && (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-border)]">
          {overlaps.map((o, i) => (
            <OverlapCard key={i} overlap={o} checkoutById={checkoutById} onNudge={onNudge} />
          ))}
        </div>
      )}
    </section>
  );
}

function OverlapCard({
  overlap, checkoutById, onNudge,
}: {
  overlap: ConsolidationOverlap;
  checkoutById: Map<string, CheckoutWithContext>;
  onNudge: (overlap: ConsolidationOverlap, involved: CheckoutWithContext[]) => Promise<void>;
}) {
  const [nudging, setNudging] = React.useState(false);
  const [nudged, setNudged] = React.useState(false);
  const involved = overlap.checkoutIds
    .map((id) => checkoutById.get(id))
    .filter((c): c is CheckoutWithContext => !!c);

  const doNudge = async () => {
    if (nudging || nudged) return;
    setNudging(true);
    try { await onNudge(overlap, involved); setNudged(true); }
    catch { /* onNudge already said it failed; the button stays so it can be tried again */ }
    finally { setNudging(false); }
  };

  const heading =
    overlap.kind === "asset"
      ? <>Equipment <Link href={`/assets/${encodeURIComponent(overlap.assetTag)}`} className="ui-tag" title={`Open ${overlap.assetTag}`}>{overlap.assetTag}</Link></>
      : <>{overlap.level === "system" ? "System" : "Unit"} <span className="ui-tag">{overlap.scopeName}</span></>;

  return (
    <div className="px-4 sm:px-5 py-3">
      <div className="flex items-center gap-2">
        <div className="text-reading text-[var(--color-text)] inline-flex items-center gap-1.5 flex-1 min-w-0">
          {heading}
          <span className="text-[var(--color-text-muted)] font-normal">, {involved.length} checkout{involved.length === 1 ? "" : "s"}</span>
        </div>
        {involved.length >= 2 && (
          <button
            onClick={doNudge}
            disabled={nudging || nudged}
            title="Send everyone here an in-app heads-up to coordinate"
            className={`shrink-0 inline-flex items-center gap-1.5 h-10 pointer-coarse:h-11 px-3.5 rounded-lg text-body font-semibold transition-colors ${
              nudged ? "text-[var(--color-text)]"
                     : "border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-60"
            }`}
          >
            {nudged ? <span className="ui-pill is-good">Heads-up sent</span> : <><Send className="w-3.5 h-3.5" /> {nudging ? "Sending…" : "Send a heads-up"}</>}
          </button>
        )}
      </div>
      <div className="mt-1.5 space-y-1">
        {involved.map((c) => (
          <div key={c.id} className="flex items-center gap-2 text-body text-[var(--color-text)]">
            <Lock className="w-3 h-3 text-[var(--color-text-faint)] shrink-0" />
            {c.libraryId && c.documentId
              ? <Link href={`/documents/${c.libraryId}?doc=${c.documentId}`} className="ui-id text-reading shrink-0">{c.docNumber || "-"}</Link>
              : <span className="ui-id text-reading shrink-0">{c.docNumber || "-"}</span>}
            <span className="truncate flex-1 min-w-0">{c.docTitle || "(untitled)"}</span>
            <span className="text-[var(--color-text-muted)]">{c.userName || c.userId.slice(0, 8)}</span>
            {c.libraryId && c.documentId && (
              <Link
                href={`/documents/${c.libraryId}?doc=${c.documentId}`}
                className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] inline-flex items-center gap-0.5 transition-colors"
                title="Open the document"
                aria-label="Open the document"
              >
                <ExternalLink className="w-3 h-3" />
              </Link>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
