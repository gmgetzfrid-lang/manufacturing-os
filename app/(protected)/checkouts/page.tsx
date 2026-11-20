"use client";

// /checkouts — every active checkout in the org, in one place.
//
// Two display modes (toggle): grouped by project, or flat list. Filters
// by library, by user, by project status, by mode. Anyone can open this
// page — collaboration depends on everyone seeing what's locked.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  KeyRound, Search, AlertTriangle, Lock, Clock,
  Layers, User as UserIcon, FileText, Briefcase, AlarmClock,
  ExternalLink, Network, Tag, ChevronDown,
} from "lucide-react";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card } from "@/components/ui/PageHero";
import { Spinner } from "@/components/ui/Spinner";
import { useRole } from "@/components/providers/RoleContext";
import { listAllActiveCheckouts, autoReleaseExpiredAdHoc } from "@/lib/projects";
import { findCheckoutOverlaps, type ConsolidationOverlap } from "@/lib/consolidation";
import { notifyMany } from "@/lib/inAppNotifications";
import { useToast } from "@/components/providers/ToastProvider";
import StaleCheckoutBanner from "@/components/projects/StaleCheckoutBanner";
import EditOverlapBanner from "@/components/documents/EditOverlapBanner";
import ViewTabs, { DOCUMENT_VIEWS } from "@/components/navigation/ViewTabs";
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
      setError((e as Error).message || "Failed to load checkouts");
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
  const answerBits: string[] = [];
  if (!loading && !error && rows.length > 0) {
    if (mine > 0) answerBits.push(`${mine === rows.length ? "All" : mine} by you.`);
    if (stale > 0) answerBits.push(`${stale} past ${stale === 1 ? "its" : "their"} expected release.`);
    if (overlaps.length > 0) answerBits.push(`${overlaps.length} overlap${overlaps.length === 1 ? "" : "s"} to talk through.`);
  }
  const darkField = "h-10 w-full rounded-[10px] border border-[var(--color-ink-line)] bg-[var(--color-ink-2)] text-white placeholder:text-[var(--color-ink-muted)] px-3 text-base sm:text-[14px] focus:outline-none focus:border-[var(--color-ink-muted)] focus:ring-2 focus:ring-[var(--color-accent)]/40 [&_option]:bg-[var(--color-surface)] [&_option]:text-[var(--color-text)]";

  return (
    <PageShell width="work">
      <PageHero
        kicker="Document control · Checkouts"
        title={answer}
        sub={
          <>
            {answerBits.length > 0 ? answerBits.join(" ") : "Every document locked right now, across every library."}{" "}
            <HelpTooltip className="align-middle">
              A <b>checkout</b> declares &ldquo;I&rsquo;m working on this drawing - don&rsquo;t touch.&rdquo;
              <b className="block mt-1">Project checkouts</b> are tied to an open project and stay until the project closes or the user releases.
              <b className="block mt-1">Ad-hoc checkouts</b> auto-expire after 24h.
              <b className="block mt-1">Collaborative sessions</b> share one lockId so multiple people can co-edit.
            </HelpTooltip>
          </>
        }
        tools={
          <div className="inline-flex rounded-[10px] border border-[var(--color-ink-line)] bg-[var(--color-ink-2)] p-0.5" role="group" aria-label="Group the list">
            <button
              onClick={() => setView("grouped")}
              aria-pressed={view === "grouped"}
              className={`h-8 px-3 text-[13px] font-semibold rounded-lg transition-colors ${view === "grouped" ? "bg-white text-[var(--color-ink)] shadow-sm" : "text-[var(--color-ink-muted)] hover:text-white"}`}
            >
              By project
            </button>
            <button
              onClick={() => setView("flat")}
              aria-pressed={view === "flat"}
              className={`h-8 px-3 text-[13px] font-semibold rounded-lg transition-colors ${view === "flat" ? "bg-white text-[var(--color-ink)] shadow-sm" : "text-[var(--color-ink-muted)] hover:text-white"}`}
            >
              One list
            </button>
          </div>
        }
      >
        <ViewTabs tabs={DOCUMENT_VIEWS} variant="dark" />
        {/* Filters */}
        <div className="mt-3 grid grid-cols-2 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2">
          <div className="relative col-span-2 md:col-span-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-ink-muted)] pointer-events-none" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by document, person or project"
              aria-label="Search checkouts"
              className={`${darkField} pl-9`}
            />
          </div>
          <select value={libraryFilter} onChange={(e) => setLibraryFilter(e.target.value)} aria-label="Library" className={darkField}>
            <option value="">All libraries</option>
            {uniqueLibs.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <select value={userFilter} onChange={(e) => setUserFilter(e.target.value)} aria-label="Person" className={darkField}>
            <option value="">Everyone</option>
            {uniqueUsers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </div>
      </PageHero>

      <PageBody>
        {/* What needs a word: checkouts past their date, edits that overlap. */}
        <div className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] p-4 sm:p-5 space-y-3 empty:hidden [&>*]:!mb-0">
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
                showToast({ type: "error", title: "The heads-up didn't send", message: (e as Error).message });
                throw e;
              }
              showToast({ type: "success", title: "Heads-up sent", message: `Told ${recipients.length} ${recipients.length === 1 ? "person" : "people"} about ${what}.` });
            }}
          />
        )}

        {loading ? (
          <Card>
            <div className="flex items-center gap-2 text-[14px] text-[var(--color-text-muted)]">
              <Spinner size="sm" /> Loading checkouts…
            </div>
          </Card>
        ) : error ? (
          <Card>
            <div role="alert" className="text-[14px] text-rose-700 dark:text-rose-300 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> Couldn&apos;t load the checkouts: {error}
            </div>
          </Card>
        ) : filtered.length === 0 ? (
          <Card>
            <div className="py-8 text-center">
              <KeyRound className="w-8 h-8 mx-auto text-[var(--color-text-faint)] mb-3" />
              <p className="text-[14px] text-[var(--color-text-muted)]">
                {rows.length === 0 ? "No one has a document checked out." : "No checkouts match your filters."}
              </p>
            </div>
          </Card>
        ) : view === "grouped" ? (
          <>
            {grouped.map((g, idx) => <ProjectGroup key={idx} project={g.project} items={g.items} />)}
          </>
        ) : (
          <FlatTable items={filtered} />
        )}
      </PageBody>
    </PageShell>
  );
}

function ProjectGroup({ project, items }: { project: Project | null; items: CheckoutWithContext[] }) {
  return (
    <section className="bg-[var(--color-surface)] rounded-2xl overflow-hidden shadow-[var(--shadow-card)]">
      <div className="px-4 sm:px-5 py-3.5 border-b border-[var(--color-border)] flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {project ? (
            <Briefcase className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
          ) : (
            <Clock className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
          )}
          <div className="min-w-0">
            {project ? (
              <Link href={`/projects/${project.id}`} className="text-[14px] font-bold text-[var(--color-text)] hover:underline">
                {project.name}
              </Link>
            ) : (
              <h2 className="text-[14px] font-bold text-[var(--color-text)]">Ad-hoc checkouts</h2>
            )}
            <div className="text-[12px] text-[var(--color-text-muted)] flex items-center gap-2 mt-0.5">
              {project ? (
                <>
                  <span>{project.ownerUserName}</span>
                  {project.visibility === "private" && <Lock className="w-3 h-3" />}
                  <span>· {project.status}</span>
                </>
              ) : (
                <span>Quick reviews: auto-release after 24h</span>
              )}
            </div>
          </div>
        </div>
        <span className="shrink-0 text-[13px] text-[var(--color-text-muted)] tabular-nums">
          {items.length} file{items.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="divide-y divide-[var(--color-border)]">
        {items.map((r) => <CheckoutRow key={r.id} row={r} />)}
      </div>
    </section>
  );
}

function FlatTable({ items }: { items: CheckoutWithContext[] }) {
  return (
    <Card pad={false} className="overflow-hidden">
      <div className="divide-y divide-[var(--color-border)]">
        {items.map((r) => <CheckoutRow key={r.id} row={r} showProject />)}
      </div>
    </Card>
  );
}

function CheckoutRow({ row, showProject }: { row: CheckoutWithContext; showProject?: boolean }) {
  const isStale = row.expectedReleaseAt && new Date(row.expectedReleaseAt as string) < new Date();
  const isAdhoc = !row.projectId;
  return (
    <div className="px-4 sm:px-5 py-3 hover:bg-[var(--color-surface-2)]/60 transition-colors">
      <div className="flex items-center gap-3">
        <FileText className="w-4 h-4 text-[var(--color-text-faint)] shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-[14px] font-bold text-[var(--color-text)] truncate">{row.docNumber || "-"}</span>
            {row.docTitle && row.docTitle !== row.docNumber && <span className="text-[13px] text-[var(--color-text-muted)] truncate">{row.docTitle}</span>}
            {row.libraryName && <span className="text-[13px] text-[var(--color-text-muted)] truncate">in {row.libraryName}</span>}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-[var(--color-text-muted)]">
            <span className="inline-flex items-center gap-1">
              <UserIcon className="w-3 h-3" /><b className="text-[var(--color-text)] font-medium">{row.userName}</b>
            </span>
            <span className="inline-flex items-center gap-1 uppercase text-[11px] font-bold bg-[var(--color-surface-2)] px-1.5 py-0.5 rounded">{row.mode}</span>
            <span className="inline-flex items-center gap-1">
              <Clock className="w-3 h-3" />since {formatRelative(row.startedAt)}
            </span>
            {isStale && (
              <span className="inline-flex items-center gap-1 font-bold text-amber-700 dark:text-amber-400">
                <AlarmClock className="w-3 h-3" /> Past expected release
              </span>
            )}
            {isAdhoc && row.autoExpiresAt && (
              <span className="inline-flex items-center gap-1 text-[var(--color-text-muted)]">
                <AlarmClock className="w-3 h-3" /> Expires {formatRelative(row.autoExpiresAt)}
              </span>
            )}
            {showProject && row.project && (
              <Link href={`/projects/${row.project.id}`} className="inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline">
                <Briefcase className="w-3 h-3" /> {row.project.name}
              </Link>
            )}
          </div>
          {(row.purpose || row.note) && (
            <div className="mt-1 text-[13px] text-[var(--color-text-muted)] line-clamp-1">&ldquo;{row.purpose || row.note}&rdquo;</div>
          )}
        </div>
        <Link
          href={`/documents/${row.libraryId}?doc=${row.documentId}`}
          className="shrink-0 w-9 h-9 grid place-items-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors"
          title="Open document"
          aria-label="Open document"
        >
          <ExternalLink className="w-4 h-4" />
        </Link>
      </div>
    </div>
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
    if (min < 60) return future ? `in ${min}m` : `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return future ? `in ${hr}h` : `${hr}h ago`;
    const days = Math.floor(hr / 24);
    return future ? `in ${days}d` : `${days}d ago`;
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
    <section className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] overflow-hidden">
      <button
        onClick={onToggle}
        aria-expanded={isOpen}
        className="w-full px-4 sm:px-5 py-3.5 flex items-center justify-between gap-3 text-left hover:bg-[var(--color-surface-2)]/60 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <Network className="w-4 h-4 text-amber-600 shrink-0" />
          <h2 className="text-[14px] font-bold text-[var(--color-text)]">
            Checkouts that overlap
          </h2>
          <div className="text-[13px] text-amber-800 dark:text-amber-300">
            {assetCount > 0 && <span className="mr-2">{assetCount} asset overlap{assetCount === 1 ? "" : "s"}</span>}
            {scopeCount > 0 && <span>{scopeCount} scope overlap{scopeCount === 1 ? "" : "s"}</span>}
          </div>
        </div>
        <ChevronDown className={`w-4 h-4 text-[var(--color-text-muted)] transition-transform ${isOpen ? "" : "-rotate-90"}`} />
      </button>
      {isOpen && (
        <div className="border-t border-[var(--color-border)] divide-y divide-[var(--color-border)]">
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
      ? <><Tag className="w-3 h-3" /> Asset <b className="font-mono">{overlap.assetTag}</b></>
      : <><Layers className="w-3 h-3" /> {overlap.level === "system" ? "System" : "Unit"} <b>{overlap.scopeName}</b></>;

  return (
    <div className="px-4 sm:px-5 py-3">
      <div className="flex items-center gap-2">
        <div className="text-[13px] font-bold text-[var(--color-text)] inline-flex items-center gap-1.5 flex-1 min-w-0">
          {heading}
          <span className="text-[var(--color-text-muted)] font-normal">, {involved.length} checkout{involved.length === 1 ? "" : "s"}</span>
        </div>
        {involved.length >= 2 && (
          <button
            onClick={doNudge}
            disabled={nudging || nudged}
            title="Send everyone here an in-app heads-up to coordinate"
            className={`shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-bold transition-colors ${
              nudged ? "text-emerald-700 dark:text-emerald-400"
                     : "border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-60"
            }`}
          >
            <Send className="w-3 h-3" /> {nudged ? "Heads-up sent" : nudging ? "Sending…" : "Send a heads-up"}
          </button>
        )}
      </div>
      <div className="mt-1.5 space-y-1">
        {involved.map((c) => (
          <div key={c.id} className="flex items-center gap-2 text-[13px] text-[var(--color-text)]">
            <Lock className="w-3 h-3 text-[var(--color-text-faint)] shrink-0" />
            <span className="font-mono text-[var(--color-text-muted)] shrink-0">{c.docNumber || "-"}</span>
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
