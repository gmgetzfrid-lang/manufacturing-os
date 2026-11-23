"use client";

import React, { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import { LibraryConfig, Role } from "@/types/schema";
import {
  Library,
  Search,
  Settings,
  RefreshCw,
  Loader2,
  MoreVertical,
  Trash2,
  KeyRound,
  Palette,
  ChevronRight,
  X,
} from "lucide-react";
import { useFind } from "@/components/find/useFind";
import FindPanel, { findMapState } from "@/components/find/FindPanel";
import FindMap from "@/components/find/FindMap";
import { folderForUnit } from "@/lib/findEverywhere";
import { withParams } from "@/lib/docsPlace";
import { SkeletonRows } from "@/components/ui/Skeleton";
import ErrorNote from "@/components/ui/ErrorNote";
import { friendlyError } from "@/lib/friendlyError";
import { humanDate } from "@/components/documents/StatusTag";
import { onTransitionClick, transitionNavigate } from "@/lib/viewTransition";
import NodeCover from "@/components/documents/NodeCover";
import CustomizeNodeModal, { type CustomizeValue } from "@/components/documents/CustomizeNodeModal";
import DocViewTabs from "@/components/documents/DocViewTabs";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroQuiet } from "@/components/ui/PageHero";
import { bandInput, bandInputIcon } from "@/components/admin/band";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { appAlert, appConfirm } from "@/components/providers/DialogProvider";

type UiLibrary = LibraryConfig & {
  _id: string;
  _canRead: boolean;
  _isPublicRead: boolean;
};

const isControllerRole = (role: Role) => role === "Admin" || role === "DocCtrl";
const toArrayRole = (v: unknown): Role[] => (Array.isArray(v) ? (v as Role[]) : []);
const safeLower = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : "");

function computeCanRead(lib: Partial<LibraryConfig>, role: Role) {
  const readAccess = (lib as { readAccess?: Role[] | "ALL" }).readAccess;
  if (readAccess === "ALL") return true;

  const readList = toArrayRole(readAccess);
  const visibleTo = toArrayRole((lib as { visibleTo?: unknown }).visibleTo);

  return readList.includes(role) || visibleTo.includes(role);
}

function computeIsPublicRead(lib: Partial<LibraryConfig>) {
  return (lib as { readAccess?: Role[] | "ALL" }).readAccess === "ALL";
}

export default function DocumentsHomePage() {
  const router = useRouter();
  const { activeRole, userEmail, activeOrgId } = useRole();

  // Start false — only flip to true once we actually have everything we need
  // to fetch. This avoids "Loading libraries..." showing up forever when the
  // useEffect bails out before calling fetchLibraries.
  const [loading, setLoading] = useState(false);
  // "No libraries" is only true once a load has answered.
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [libraries, setLibraries] = useState<UiLibrary[]>([]);
  // Documents per library (current ones — archived excluded), counted on the
  // server without fetching rows.
  const [libCounts, setLibCounts] = useState<Map<string, number>>(new Map());
  const libIdsKey = libraries.map((l) => l._id).join(",");
  useEffect(() => {
    if (!activeOrgId || !libIdsKey) return;
    let alive = true;
    void Promise.all(libIdsKey.split(",").map(async (id) => {
      const { count } = await supabase.from("documents").select("id", { count: "exact", head: true })
        .eq("org_id", activeOrgId).eq("library_id", id).neq("status", "Archived");
      return [id, count ?? 0] as const;
    })).then((pairs) => { if (alive) setLibCounts(new Map(pairs)); }).catch(() => undefined);
    return () => { alive = false; };
  }, [activeOrgId, libIdsKey]);
  // Two facts that say how the files stand today: how many are checked out
  // right now, and how many changed in the last seven days.
  const [orgFacts, setOrgFacts] = useState<{ out: number; week: number } | null>(null);
  useEffect(() => {
    if (!activeOrgId || !libIdsKey) return;
    let alive = true;
    const since = new Date(Date.now() - 7 * 86400e3).toISOString();
    const base = () => supabase.from("documents").select("id", { count: "exact", head: true })
      .eq("org_id", activeOrgId).neq("status", "Archived");
    void Promise.all([
      base().not("checked_out_by", "is", null),
      base().gte("updated_at", since),
    ]).then(([a, b]) => {
      if (alive && !a.error && !b.error) setOrgFacts({ out: a.count ?? 0, week: b.count ?? 0 });
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [activeOrgId, libIdsKey]);
  // What changed last in each library: the most recently updated document,
  // its number and rev, and when (so a row says more than a count).
  const [lastChange, setLastChange] = useState<Map<string, { number: string; rev: string | null; at: string }>>(new Map());
  useEffect(() => {
    if (!activeOrgId || !libIdsKey) return;
    let alive = true;
    void Promise.all(libIdsKey.split(",").map(async (id) => {
      const { data } = await supabase.from("documents").select("document_number,title,name,rev,updated_at")
        .eq("org_id", activeOrgId).eq("library_id", id).neq("status", "Archived")
        .order("updated_at", { ascending: false }).limit(1);
      const r = (data?.[0] ?? null) as { document_number?: string | null; title?: string | null; name?: string | null; rev?: string | null; updated_at?: string | null } | null;
      return [id, r?.updated_at ? { number: r.document_number || r.title || r.name || "A document", rev: r.rev ?? null, at: r.updated_at } : null] as const;
    })).then((pairs) => {
      if (!alive) return;
      const m = new Map<string, { number: string; rev: string | null; at: string }>();
      for (const [id, v] of pairs) if (v) m.set(id, v);
      setLastChange(m);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [activeOrgId, libIdsKey]);
  // The map under the list: each library and its top folders, named as in
  // the libraries' own lists. Hidden folders stay hidden from who can't see them.
  const [topFolders, setTopFolders] = useState<Map<string, Array<{ id: string; name: string }>>>(new Map());
  const controllerHere = isControllerRole(activeRole);
  useEffect(() => {
    if (!activeOrgId || !libIdsKey) return;
    let alive = true;
    let q = supabase.from("collections").select("id,name,library_id,parent_id,deleted_at,visibility")
      .eq("org_id", activeOrgId).is("parent_id", null);
    if (!controllerHere) q = q.eq("visibility", "normal");
    void q.then(({ data }) => {
      if (!alive || !data) return;
      const m = new Map<string, Array<{ id: string; name: string }>>();
      for (const r of data as Array<{ id: string; name: string | null; library_id: string; deleted_at?: string | null }>) {
        if (r.deleted_at) continue;
        m.set(r.library_id, [...(m.get(r.library_id) ?? []), { id: r.id, name: r.name ?? "Folder" }]);
      }
      setTopFolders(m);
    });
    return () => { alive = false; };
  }, [activeOrgId, libIdsKey, controllerHere]);
  const mapLibraries = useMemo(
    () => libraries.map((l) => ({ id: l._id, name: l.name, folders: topFolders.get(l._id) ?? [] })),
    [libraries, topFolders],
  );
  // A /d/<number> short link that found no exact match lands here with ?q=
  // pre-filling the search, so the user sees the nearest hits immediately.
  const [search, setSearch] = useState(() =>
    typeof window === "undefined" ? "" : (new URLSearchParams(window.location.search).get("q") ?? ""));
  // The search is kept in the address as it is typed (the entry is
  // rewritten, never a step per letter): opening a result and coming back
  // lands on the same search, its results kept (components/find/useFind).
  useEffect(() => {
    const t = window.setTimeout(() => {
      const next = withParams(window.location.search, { q: search.trim() ? search : null });
      if (next !== window.location.search) window.history.replaceState(null, "", `${window.location.pathname}${next}`);
    }, 350);
    return () => window.clearTimeout(t);
  }, [search]);
  const [orgName, setOrgName] = useState<string | null>(null);
  const [menuOpenForLibId, setMenuOpenForLibId] = useState<string | null>(null);
  const [deletingLibId, setDeletingLibId] = useState<string | null>(null);
  // Track which library tile the user clicked so we can render a
  // pending state on it while the route transition + page mount work.
  // useTransition keeps the click handler from blocking the UI.
  const [pendingLibId, setPendingLibId] = useState<string | null>(null);
  const [customizeLib, setCustomizeLib] = useState<UiLibrary | null>(null);
  const [, startTransition] = useTransition();

  // Resolve the active org's NAME for the subtitle (was showing the raw uuid).
  useEffect(() => {
    if (!activeOrgId) { setOrgName(null); return; }
    let alive = true;
    void supabase.from("orgs").select("name").eq("id", activeOrgId).maybeSingle()
      .then(({ data }) => { if (alive) setOrgName((data as { name?: string } | null)?.name ?? null); });
    return () => { alive = false; };
  }, [activeOrgId]);

  const saveLibraryAppearance = async (libId: string, v: CustomizeValue) => {
    const existing = libraries.find((l) => l._id === libId)?.pageConfig ?? {};
    const height = v.headerHeight === "auto" ? undefined : v.headerHeight;
    const background = v.bgType && v.bgType !== "none"
      ? { type: v.bgType, tint: v.bgTint, imagePath: v.bgImagePath, opacity: v.bgOpacity }
      : { type: "none" as const };
    const pageConfig = { ...existing, header: { ...(existing.header ?? {}), height }, background };
    const { error } = await supabase.from("libraries").update({
      color: v.color ?? null,
      icon: v.icon ?? null,
      cover_image_url: v.coverImageUrl ?? null,
      cover_tint: v.coverTint ?? null,
      description: v.description ?? null,
      page_config: pageConfig,
      updated_at: new Date().toISOString(),
    }).eq("id", libId);
    // Thrown, so the customize window stays open and says it didn't save.
    if (error) throw new Error(error.message);
    setLibraries((arr) => arr.map((l) => l._id === libId
      ? { ...l, color: v.color, icon: v.icon, coverImageUrl: v.coverImageUrl, coverTint: v.coverTint, description: v.description ?? l.description, pageConfig }
      : l));
  };

  const isController = isControllerRole(activeRole);

  const fetchLibraries = async (opts?: { silent?: boolean }) => {
    if (!activeOrgId) {
      setLibraries([]);
      setLoading(false);
      return;
    }

    if (!opts?.silent) setLoading(true);
    setError(null);

    try {
      const { data, error: qErr } = await supabase
        .from("libraries")
        .select("*")
        .eq("org_id", activeOrgId)
        .order("created_at", { ascending: false });

      if (qErr) throw qErr;

      const libs = (data || []).map((row) => {
        const normalized: Partial<LibraryConfig> = {
          id: row.id,
          orgId: row.org_id ?? activeOrgId ?? "",
          name: row.name ?? "Untitled Library",
          description: row.description ?? "",
          type: row.type ?? "Engineering",
          customColumns: Array.isArray(row.custom_columns) ? row.custom_columns : [],
          writeAccess: toArrayRole(row.write_access),
          adminAccess: toArrayRole(row.admin_access),
          readAccess: row.read_access ?? "ALL",
          visibleTo: toArrayRole(row.visible_to),
          folderSecurity: row.folder_security ?? "Inherited",
          color: row.color ?? undefined,
          icon: row.icon ?? undefined,
          coverImageUrl: row.cover_image_url ?? undefined,
          coverTint: row.cover_tint ?? undefined,
          pageConfig: row.page_config ?? undefined,
        };

        const _canRead = computeCanRead(normalized, activeRole);
        const _isPublicRead = computeIsPublicRead(normalized);

        return {
          ...(normalized as LibraryConfig),
          _id: row.id,
          _canRead,
          _isPublicRead,
        } as UiLibrary;
      });

      const visible = isController ? libs : libs.filter((l) => l._canRead);
      setLibraries(visible);
    } catch (e: unknown) {
      console.error("DocumentsHomePage: failed to load libraries", e);
      setError("Couldn't load the libraries.");
      setLibraries([]);
    } finally {
      setLoadedOnce(true);
      if (!opts?.silent) setLoading(false);
    }
  };

  useEffect(() => {
    // Only fetch once we have both the user identity and a workspace.
    // Missing either is a benign empty state, not a loading state.
    if (!userEmail || !activeOrgId) return;
    fetchLibraries();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userEmail, activeRole, activeOrgId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return libraries;

    return libraries.filter((l) => {
      const hay = `${safeLower(l.name)} ${safeLower(l.description)} ${safeLower(l.type)}`;
      return hay.includes(q);
    });
  }, [libraries, search]);

  // The search box is the one search (equipment with its unit and ID,
  // drawings, words inside them), and the map beside the list follows it.
  const finder = useFind(activeOrgId, search, null, { controller: isController });
  const searching = search.trim().length >= 2;
  const ms = findMapState(finder);
  const openUnitFolder = async (code: string) => {
    if (!activeOrgId) return;
    const f = await folderForUnit(activeOrgId, code, null);
    if (f) router.push(`/documents/${f.libraryId}?folderId=${f.chain[f.chain.length - 1].id}`);
  };

  if (!activeOrgId) {
    return (
      <PageShell width="full" className="max-w-[1500px]">
        <PageHero overlap={false} kicker="Document control" title="Pick a workspace."
          sub="Select a workspace from the sidebar to see its libraries. What you can open depends on your membership there." />
      </PageShell>
    );
  }

  const emptyState = (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-6 flex flex-wrap items-center gap-x-4 gap-y-3">
      <p className="flex-1 min-w-[16rem] text-[15px] text-[var(--color-text)]">
        {isController ? "No libraries yet. Libraries hold your drawings, procedures and standards." : "No libraries you can open yet. Doc Control or an Admin can give you access."}
      </p>
      {isController && <Link href="/admin/libraries" className={heroQuiet}>Set up a library</Link>}
    </div>
  );

  const listLoading = loading || (!loadedOnce && !error && !!userEmail);

  const openLib = (id: string) => {
    setPendingLibId(id);
    startTransition(() => { router.push(`/documents/${id}`); });
  };

  // One row per library: what it is, how many documents, what changed last
  // and who can read it. The whole row opens it; the name is the real link.
  // Under 640 px each row is a card with the same facts.
  const libraryRows = (list: UiLibrary[]) => (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <table className="w-full text-[14px]">
        <thead className="text-[13px] text-[var(--color-text-muted)] text-left max-sm:hidden border-b border-[var(--color-border)]">
          <tr>
            <th className="font-semibold px-4 h-10">Library</th>
            <th className="font-semibold px-4 text-right w-28">Documents</th>
            <th className="font-semibold px-4 w-64 max-lg:hidden">Last change</th>
            <th className="font-semibold px-4 w-44">Access</th>
            <th className="w-14"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {list.map((lib) => {
            const isPending = pendingLibId === lib._id;
            const menuOpen = menuOpenForLibId === lib._id;
            const n = libCounts.get(lib._id!);
            const last = lastChange.get(lib._id!);
            const custom = !!(lib.color || lib.icon || lib.coverImageUrl);
            const access = !lib._canRead && !isController
              ? <span className="ui-pill is-warn">No access</span>
              : lib._isPublicRead ? <span className="ui-pill is-muted">Everyone can read</span>
              : <span className="ui-pill is-muted !text-[var(--color-text)]">Controlled</span>;
            const lastLine = last ? (
              <span className="min-w-0 flex items-baseline gap-2">
                <span className="truncate text-[var(--color-text)]">
                  <span className="ui-id">{last.number}</span>
                  {last.rev ? <span className="text-[var(--color-text-muted)]"> rev <span className="ui-id text-[var(--color-text)]">{last.rev}</span></span> : null}
                </span>
                <span className="shrink-0 text-[13px] text-[var(--color-text-muted)] tabular-nums">{humanDate(last.at)}</span>
              </span>
            ) : null;
            return (
              <tr key={lib._id} data-doc-lib={lib._id}
                onClick={() => { if (!menuOpen) transitionNavigate(() => openLib(lib._id!)); }}
                className={`group cursor-pointer hover:bg-[var(--color-surface-2)] transition-colors ${isPending ? "opacity-60" : ""}`}>
                <td className="px-4 py-3">
                  <span className="flex items-center gap-3 min-w-0">
                    {custom
                      ? <NodeCover appearance={{ color: lib.color, icon: lib.icon, coverImageUrl: lib.coverImageUrl, coverTint: lib.coverTint }}
                          className="w-8 h-8 shrink-0" rounded="rounded-lg" iconSize="w-4 h-4" />
                      : <Library aria-hidden className="w-[18px] h-[18px] shrink-0 text-[var(--color-text-faint)]" />}
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5">
                        <Link href={`/documents/${lib._id}`}
                          onClick={(e) => { e.stopPropagation(); onTransitionClick(e, () => openLib(lib._id!)); if (!e.defaultPrevented) setPendingLibId(lib._id!); }}
                          className="truncate text-[16px] font-semibold text-[var(--color-text)] group-hover:text-[var(--color-accent-text)] hover:underline underline-offset-2">
                          {lib.name}
                        </Link>
                        {isPending && <Loader2 aria-label="Opening" className="w-3.5 h-3.5 shrink-0 animate-spin text-[var(--color-text-faint)]" />}
                      </span>
                      {lib.description && <span className="block text-[13px] text-[var(--color-text-muted)] truncate">{lib.description}</span>}
                      {/* Phone: the facts under the name. */}
                      <span className="sm:hidden flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-[13px] text-[var(--color-text-muted)]">
                        {n != null && <span className="tabular-nums">{n.toLocaleString()} document{n === 1 ? "" : "s"}</span>}
                        {access}
                      </span>
                      {last && <span className="sm:hidden flex mt-0.5 text-[13px] min-w-0">{lastLine}</span>}
                    </span>
                  </span>
                </td>
                <td className={`px-4 py-3 text-right tabular-nums max-sm:hidden ${n ? "text-[var(--color-text)]" : "text-[var(--color-text-faint)]"}`}>{n != null ? n.toLocaleString() : ""}</td>
                <td className="px-4 py-3 max-lg:hidden">{lastLine ?? <span className="text-[var(--color-text-faint)]">Nothing filed yet</span>}</td>
                <td className="px-4 py-3 whitespace-nowrap max-sm:hidden">{access}</td>
                <td className="pr-3 py-3 text-right">
                  {isController ? (
                    <LibraryAdminMenu inline
                      libId={lib._id!}
                      libName={lib.name}
                      open={menuOpen}
                      onToggle={() => setMenuOpenForLibId(menuOpen ? null : lib._id!)}
                      onClose={() => setMenuOpenForLibId(null)}
                      onCustomize={() => setCustomizeLib(lib)}
                      deleting={deletingLibId === lib._id}
                      onDelete={async () => {
                        setDeletingLibId(lib._id!);
                        try {
                          const { error } = await supabase.from("libraries").delete().eq("id", lib._id!);
                          if (error) { await appAlert({ message: `Couldn't delete ${lib.name}. ${friendlyError(error)}`, tone: "danger" }); return; }
                          setLibraries((arr) => arr.filter((l) => l._id !== lib._id));
                        } finally {
                          setDeletingLibId(null);
                          setMenuOpenForLibId(null);
                        }
                      }}
                    />
                  ) : <ChevronRight aria-hidden className="w-4 h-4 inline text-[var(--color-text-faint)] group-hover:text-[var(--color-text-muted)]" />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  const totalDocs = [...libCounts.values()].reduce((a, b) => a + b, 0);
  // The answer: how much is filed, and where. Counts arrive after the list.
  const countsIn = libraries.length > 0 && libraries.every((l) => libCounts.has(l._id));
  const nLibs = `${libraries.length} librar${libraries.length === 1 ? "y" : "ies"}`;
  const answer = listLoading ? "Libraries" : libraries.length === 0 ? (error ? "Libraries didn't load." : "No libraries yet.")
    : countsIn && totalDocs > 0 ? `${totalDocs.toLocaleString()} document${totalDocs === 1 ? "" : "s"}.`
    : `${nLibs}.`;
  const answerSub = listLoading ? undefined : libraries.length === 0
    ? (error ? undefined : isController ? "Set one up in Library admin." : "You don't have access to a controlled library yet.")
    : countsIn && totalDocs === 0 ? `Nothing filed yet${orgName ? ` at ${orgName}` : ""}.`
    : orgName ?? undefined;
  // The numbers behind it, small (the title carries the count): the other
  // count, what is checked out now and what changed this week.
  const docsAnswer = countsIn && totalDocs > 0;
  const answerFacts = libraries.length === 0 ? undefined : [
    docsAnswer ? { label: "Libraries", value: libraries.length.toLocaleString() } : { label: "Documents", value: countsIn ? totalDocs.toLocaleString() : "-" },
    ...(orgFacts ? [
      { label: "Checked out now", value: orgFacts.out.toLocaleString() },
      { label: "Changed this week", value: orgFacts.week.toLocaleString() },
    ] : []),
  ];

  return (
    <PageShell width="full" className="max-w-[1500px]">
      <PageHero
        kicker="Document control"
        title={answer}
        sub={answerSub}
        facts={answerFacts}
        factsHero="none"
        tools={<>
          <button
            onClick={async () => {
              setRefreshing(true);
              await fetchLibraries({ silent: true });
              setRefreshing(false);
            }}
            title="Refresh the libraries"
            aria-label="Refresh"
            className={heroQuiet}
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
          </button>
          {/* Setting libraries up is Doc Control's, now and then: a quiet
              tool, not the page's main action. */}
          {isController && (
            <Link href="/admin/libraries" className={heroQuiet} title="Create libraries, set their columns and who can read them">
              <Settings className="h-4 w-4" /><span className="max-sm:hidden">Library admin</span>
            </Link>
          )}
        </>}
      >
        <DocViewTabs />
        <form role="search" onSubmit={(e) => e.preventDefault()} className="relative mt-4">
          <Search className={bandInputIcon} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setSearch(""); }}
            placeholder="Number, tag (E-22) or words inside"
            title="Equipment tag (E-22), drawing number or words inside"
            aria-label="Search documents and equipment"
            data-find-input
            className={`${bandInput} !pr-11 max-sm:text-base`}
          />
          {search && (
            <button aria-label="Clear search" type="button" onClick={() => setSearch("")} title="Clear the search"
              className="absolute right-1 top-1/2 -translate-y-1/2 w-8 h-8 grid place-items-center rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
              <X className="w-4 h-4" />
            </button>
          )}
        </form>
      </PageHero>

      <PageBody>
        {/* The libraries (or the search), full width; the map under them. */}
        {searching ? (
          <>
            {filtered.length > 0 && (
              <section>
                <h2 className="flex items-baseline gap-2 font-display text-[20px] leading-tight font-semibold text-[var(--color-heading)] mb-3">
                  Libraries <span className="font-sans text-[14px] font-normal tabular-nums text-[var(--color-text-muted)]">{filtered.length}</span>
                </h2>
                {libraryRows(filtered)}
              </section>
            )}
            <Card label={<>Search: “{search.trim()}”</>}>
              <FindPanel orgId={activeOrgId} f={finder} unit={null} hideMap
                onOpenFolder={(fo) => router.push(`/documents/${fo.libraryId}?folderId=${fo.id}`)}
                onOpenHref={(href) => router.push(href)} />
            </Card>
          </>
        ) : listLoading ? (
          <section>
            <h2 className="font-display text-[20px] leading-tight font-semibold text-[var(--color-heading)] mb-3">Libraries</h2>
            <SkeletonRows rows={4} cols={3} what="libraries" />
          </section>
        ) : libraries.length === 0 ? (error ? (
          <ErrorNote error={error} title="The libraries didn't load." onRetry={() => void fetchLibraries()} />
        ) : emptyState) : (
          <section>
            <h2 className="flex items-baseline gap-2 font-display text-[20px] leading-tight font-semibold text-[var(--color-heading)] mb-3">
              Libraries <span className="font-sans text-[14px] font-normal tabular-nums text-[var(--color-text-muted)]">{libraries.length}</span>
            </h2>
            {libraryRows(libraries)}
          </section>
        )}

        <Card label={<span className="inline-flex items-center gap-2 text-[var(--color-heading)]">Map <HelpTooltip>Tap a library or a folder to open it. Whole site shows the units and their equipment.</HelpTooltip></span>} className="min-w-0">
          <FindMap orgId={activeOrgId} unit={searching ? ms.unit : null}
            libraries={mapLibraries}
            onPlace={(lib, folder) => router.push(folder ? `/documents/${lib}?folderId=${folder}` : `/documents/${lib}`)}
            assetId={searching ? ms.assetId : null} docs={searching ? ms.docs : null} candidates={searching ? ms.candidates : undefined}
            onPickAsset={(id, tag) => {
              if (searching && finder.quick?.equipment.some((e) => e.id === id)) finder.pick(id);
              else { setSearch(tag); finder.pickWhenFound(id); }
            }}
            onUnit={(code) => void openUnitFolder(code)}
            className="h-72 lg:h-[420px]" />
        </Card>
      </PageBody>

      {customizeLib && (
        <CustomizeNodeModal
          key={customizeLib._id}
          open={!!customizeLib}
          title={`Customize “${customizeLib.name}”`}
          storagePrefix={activeOrgId ? `orgs/${activeOrgId}/branding` : undefined}
          initial={{
            description: customizeLib.description,
            color: customizeLib.color,
            icon: customizeLib.icon,
            coverImageUrl: customizeLib.coverImageUrl,
            coverTint: customizeLib.coverTint,
            headerHeight: customizeLib.pageConfig?.header?.height ?? "auto",
            bgType: customizeLib.pageConfig?.background?.type ?? "none",
            bgTint: customizeLib.pageConfig?.background?.tint ?? "neutral",
            bgImagePath: customizeLib.pageConfig?.background?.imagePath,
            bgOpacity: customizeLib.pageConfig?.background?.opacity ?? 0.18,
          }}
          onClose={() => setCustomizeLib(null)}
          onSave={(v) => saveLibraryAppearance(customizeLib._id!, v)}
        />
      )}
    </PageShell>
  );
}

// LibraryAdminMenu — 3-dot menu overlay on library tiles. Admin-only.
// Stops click propagation so opening the menu doesn't trigger the
// tile's navigation. Delete prompts for confirm before firing.
function LibraryAdminMenu({
  libId, libName, open, deleting, inline,
  onToggle, onClose, onDelete, onCustomize,
}: {
  inline?: boolean;
  libId: string;
  libName: string;
  open: boolean;
  deleting: boolean;
  onToggle: () => void;
  onClose: () => void;
  onDelete: () => void;
  onCustomize: () => void;
}) {
  return (
    <div className={inline ? "relative z-10" : "absolute top-3 right-3 z-10"} onClick={(e) => e.stopPropagation()}>
      <button
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
        title="Library admin"
        aria-label={`Library admin: ${libName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`w-8 h-8 grid place-items-center rounded-md transition-colors ${open ? "bg-[var(--color-surface-2)] text-[var(--color-text)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}
      >
        <MoreVertical className="w-4 h-4" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[5]" onClick={(e) => { e.stopPropagation(); onClose(); }} />
          <div role="menu" className="ui-float ui-float-in absolute right-0 top-full mt-1 w-60 text-left bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] rounded-xl overflow-hidden z-[10] origin-top-right py-1">
            <div className="px-3 pt-1.5 pb-1 text-[12px] text-[var(--color-text-muted)] truncate">{libName}</div>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onClose(); onCustomize(); }}
              role="menuitem" className="w-full text-left flex items-center gap-2.5 px-3 min-h-10 text-[14px] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
            >
              <Palette className="w-4 h-4 text-[var(--color-text-faint)]" /> Customize appearance
            </button>
            <Link
              href={`/admin/libraries?lib=${libId}`}
              onClick={(e) => { e.stopPropagation(); onClose(); }}
              role="menuitem" className="flex items-center gap-2.5 px-3 min-h-10 text-[14px] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
            >
              <Settings className="w-4 h-4 text-[var(--color-text-faint)]" /> Name and columns
            </Link>
            <Link
              href={`/admin/permissions?lib=${libId}`}
              onClick={(e) => { e.stopPropagation(); onClose(); }}
              role="menuitem" className="flex items-center gap-2.5 px-3 min-h-10 text-[14px] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
            >
              <KeyRound className="w-4 h-4 text-[var(--color-text-faint)]" /> Who can open it
            </Link>
            <button
              type="button"
              onClick={async (e) => {
                e.stopPropagation();
                if (!(await appConfirm({ title: `Delete the ${libName} library?`, message: "Its documents stay in the workspace but no longer belong to a library. The delete is recorded in the audit log and can't be undone.", confirmLabel: "Delete library", tone: "danger" }))) return;
                onDelete();
              }}
              disabled={deleting}
              role="menuitem" className="w-full text-left flex items-center gap-2.5 px-3 min-h-10 mt-1 text-[14px] text-[var(--state-overdue-text)] hover:bg-[var(--color-surface-2)] border-t border-[var(--color-border)] disabled:opacity-50"
            >
              {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              {deleting ? "Deleting…" : "Delete library"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
