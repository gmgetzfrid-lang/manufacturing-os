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
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import { Input, Select } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { useRole } from "@/components/providers/RoleContext";
import { listAllActiveCheckouts, autoReleaseExpiredAdHoc } from "@/lib/projects";
import { findCheckoutOverlaps, type ConsolidationOverlap } from "@/lib/consolidation";
import { notifyMany } from "@/lib/inAppNotifications";
import { useToast } from "@/components/providers/ToastProvider";
import StaleCheckoutBanner from "@/components/projects/StaleCheckoutBanner";
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

  return (
    <PageShell width="work">
        <ViewTabs title="Documents" tabs={DOCUMENT_VIEWS} />
        <StaleCheckoutBanner userId={uid ?? undefined} />
        <PageHeaderBar
          icon={KeyRound}
          title="Active Checkouts"
          subtitle={
            <>
              Every document currently locked, across every library. {rows.length} active.{" "}
              <HelpTooltip className="align-middle">
                A <b>checkout</b> declares &ldquo;I&rsquo;m working on this drawing — don&rsquo;t touch.&rdquo;
                <b className="block mt-1">Project checkouts</b> are tied to an open project and stay until the project closes or the user releases.
                <b className="block mt-1">Ad-hoc checkouts</b> auto-expire after 24h.
                <b className="block mt-1">Collaborative sessions</b> share one lockId so multiple people can co-edit.
              </HelpTooltip>
            </>
          }
          actions={
            <div className="flex bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg p-1">
              <button
                onClick={() => setView("grouped")}
                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-colors ${view === "grouped" ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}
              >
                By Project
              </button>
              <button
                onClick={() => setView("flat")}
                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-colors ${view === "flat" ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}
              >
                Flat
              </button>
            </div>
          }
        />

        {/* Filters */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-6">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-faint)]" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by doc, user, project…"
              className="pl-9"
            />
          </div>
          <Select value={libraryFilter} onChange={(e) => setLibraryFilter(e.target.value)}>
            <option value="">All libraries</option>
            {uniqueLibs.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </Select>
          <Select value={userFilter} onChange={(e) => setUserFilter(e.target.value)}>
            <option value="">All users</option>
            {uniqueUsers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </Select>
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
              await notifyMany({
                orgId: activeOrgId,
                userIds: recipients,
                actorUserId: uid ?? undefined,
                kind: "checkout_conflict",
                title: "Coordinate — overlapping checkout",
                body: `${userEmail?.split("@")[0] ?? "A colleague"} flagged that you're both working on ${what} (${names}). Sync up before issuing so changes don't collide.`,
                link: "/checkouts",
                resourceType: "checkout",
              });
              showToast({ type: "success", title: "Heads-up sent", message: `Notified ${recipients.length} ${recipients.length === 1 ? "person" : "people"} to coordinate on ${what}.` });
            }}
          />
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)] p-8">
            <Spinner size="sm" /> Loading checkouts…
          </div>
        ) : error ? (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-12 text-center">
            <KeyRound className="w-10 h-10 mx-auto text-[var(--color-text-faint)] mb-3" />
            <p className="text-sm text-[var(--color-text-muted)]">No active checkouts match your filters.</p>
          </div>
        ) : view === "grouped" ? (
          <div className="space-y-4">
            {grouped.map((g, idx) => <ProjectGroup key={idx} project={g.project} items={g.items} />)}
          </div>
        ) : (
          <FlatTable items={filtered} />
        )}
    </PageShell>
  );
}

function ProjectGroup({ project, items }: { project: Project | null; items: CheckoutWithContext[] }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
      <div className={`px-5 py-3 border-b border-slate-200 flex items-center justify-between ${
        project ? "bg-[var(--color-accent-soft)]" : "bg-slate-50"
      }`}>
        <div className="flex items-center gap-3 min-w-0">
          {project ? (
            <Briefcase className="w-5 h-5 text-[var(--color-accent)] shrink-0" />
          ) : (
            <Clock className="w-5 h-5 text-slate-400 shrink-0" />
          )}
          <div className="min-w-0">
            {project ? (
              <Link href={`/projects/${project.id}`} className="text-sm font-black text-slate-900 hover:text-[var(--color-accent)] transition-colors">
                {project.name}
              </Link>
            ) : (
              <div className="text-sm font-black text-slate-700">Ad-hoc checkouts</div>
            )}
            <div className="text-[10px] text-slate-500 flex items-center gap-2 mt-0.5">
              {project ? (
                <>
                  <span>{project.ownerUserName}</span>
                  {project.visibility === "private" && <Lock className="w-3 h-3" />}
                  <span className="px-1.5 py-0.5 rounded bg-white border border-slate-200 font-mono">{project.status}</span>
                </>
              ) : (
                <span>Quick reviews — auto-release after 24h</span>
              )}
            </div>
          </div>
        </div>
        <span className="text-[10px] font-bold text-slate-500 bg-white border border-slate-200 px-2 py-0.5 rounded-full">
          {items.length} file{items.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="divide-y divide-slate-100">
        {items.map((r) => <CheckoutRow key={r.id} row={r} />)}
      </div>
    </div>
  );
}

function FlatTable({ items }: { items: CheckoutWithContext[] }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
      <div className="divide-y divide-slate-100">
        {items.map((r) => <CheckoutRow key={r.id} row={r} showProject />)}
      </div>
    </div>
  );
}

function CheckoutRow({ row, showProject }: { row: CheckoutWithContext; showProject?: boolean }) {
  const isStale = row.expectedReleaseAt && new Date(row.expectedReleaseAt as string) < new Date();
  const isAdhoc = !row.projectId;
  return (
    <div className="px-5 py-3 hover:bg-slate-50/60 transition-colors">
      <div className="flex items-center gap-3">
        <FileText className="w-4 h-4 text-slate-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-mono text-sm font-bold text-slate-900 truncate">{row.docNumber || "—"}</span>
            <span className="text-xs text-slate-600 truncate">{row.docTitle}</span>
            {row.libraryName && <span className="text-[10px] text-slate-400 truncate">in {row.libraryName}</span>}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
            <span className="inline-flex items-center gap-1">
              <UserIcon className="w-3 h-3" /><b className="text-slate-700 font-medium">{row.userName}</b>
            </span>
            <span className="inline-flex items-center gap-1 uppercase text-[10px] font-bold bg-slate-100 px-1.5 py-0.5 rounded">{row.mode}</span>
            <span className="inline-flex items-center gap-1">
              <Clock className="w-3 h-3" />since {formatRelative(row.startedAt)}
            </span>
            {isStale && (
              <span className="inline-flex items-center gap-1 text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200">
                <AlarmClock className="w-3 h-3" /> Past expected release
              </span>
            )}
            {isAdhoc && row.autoExpiresAt && (
              <span className="inline-flex items-center gap-1 text-slate-500">
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
            <div className="mt-1 text-[11px] text-slate-600 italic line-clamp-1">&ldquo;{row.purpose || row.note}&rdquo;</div>
          )}
        </div>
        <Link
          href={`/documents/${row.libraryId}?doc=${row.documentId}`}
          className="p-1.5 rounded-md text-slate-500 hover:text-amber-700 hover:bg-amber-50 transition-colors"
          title="Open document"
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </Link>
      </div>
    </div>
  );
}

function formatRelative(ts: Timestamp): string {
  if (!ts) return "—";
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
  } catch { return "—"; }
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
    <div className="bg-amber-50 border border-amber-200 rounded-2xl mb-6 overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full px-4 py-3 flex items-center justify-between gap-3 hover:bg-amber-100/40 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <Network className="w-4 h-4 text-amber-700 shrink-0" />
          <div className="text-sm font-bold text-amber-900">
            Coordination signals
          </div>
          <div className="text-xs text-amber-700">
            {assetCount > 0 && <span className="mr-2">{assetCount} asset overlap{assetCount === 1 ? "" : "s"}</span>}
            {scopeCount > 0 && <span>{scopeCount} scope overlap{scopeCount === 1 ? "" : "s"}</span>}
          </div>
        </div>
        <ChevronDown className={`w-4 h-4 text-amber-700 transition-transform ${isOpen ? "" : "-rotate-90"}`} />
      </button>
      {isOpen && (
        <div className="px-4 pb-3 space-y-2">
          <div className="text-[11px] text-amber-800/80 -mt-1">
            Two or more active checkouts touch the same asset or operational scope.
            This is a heads-up to coordinate — not a block. Open each checkout to
            see who&apos;s working on what.
          </div>
          <div className="space-y-2">
            {overlaps.map((o, i) => (
              <OverlapCard key={i} overlap={o} checkoutById={checkoutById} onNudge={onNudge} />
            ))}
          </div>
        </div>
      )}
    </div>
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
    finally { setNudging(false); }
  };

  const heading =
    overlap.kind === "asset"
      ? <><Tag className="w-3 h-3" /> Asset <b className="font-mono">{overlap.assetTag}</b></>
      : <><Layers className="w-3 h-3" /> {overlap.level === "system" ? "System" : "Unit"} <b>{overlap.scopeName}</b></>;

  return (
    <div className="bg-white rounded-lg border border-amber-200 p-3">
      <div className="flex items-center gap-2">
        <div className="text-[11px] font-bold text-amber-900 inline-flex items-center gap-1.5 flex-1 min-w-0">
          {heading}
          <span className="text-amber-700 font-normal">— {involved.length} checkout{involved.length === 1 ? "" : "s"}</span>
        </div>
        {involved.length >= 2 && (
          <button
            onClick={doNudge}
            disabled={nudging || nudged}
            title="Send everyone here an in-app heads-up to coordinate"
            className={`shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold transition-colors ${
              nudged ? "bg-emerald-100 text-emerald-700"
                     : "bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-60"
            }`}
          >
            <Send className="w-3 h-3" /> {nudged ? "Heads-up sent" : nudging ? "Sending…" : "Nudge to coordinate"}
          </button>
        )}
      </div>
      <div className="mt-1.5 space-y-1">
        {involved.map((c) => (
          <div key={c.id} className="flex items-center gap-2 text-[11px] text-slate-700">
            <Lock className="w-3 h-3 text-amber-600 shrink-0" />
            <span className="font-mono text-slate-500 shrink-0">{c.docNumber || "—"}</span>
            <span className="truncate flex-1 min-w-0">{c.docTitle || "(untitled)"}</span>
            <span className="text-slate-500">{c.userName || c.userId.slice(0, 8)}</span>
            {c.libraryId && c.documentId && (
              <Link
                href={`/documents/${c.libraryId}`}
                className="text-amber-700 hover:text-amber-900 inline-flex items-center gap-0.5 transition-colors"
                title="Open in library"
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
