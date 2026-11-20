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
  AlertTriangle,
  Eye,
  Lock,
  Loader2,
  MoreVertical,
  Trash2,
  KeyRound,
  Palette,
  ChevronRight,
  X,
  Map as MapIcon,
} from "lucide-react";
import { useFind } from "@/components/find/useFind";
import FindPanel, { findMapState } from "@/components/find/FindPanel";
import FindMap from "@/components/find/FindMap";
import { folderForUnit } from "@/lib/findEverywhere";
import { withParams } from "@/lib/docsPlace";
import RouteLoader from "@/components/ui/RouteLoader";
import NodeCover from "@/components/documents/NodeCover";
import CustomizeNodeModal, { type CustomizeValue } from "@/components/documents/CustomizeNodeModal";
import ViewTabs, { DOCUMENT_VIEWS } from "@/components/navigation/ViewTabs";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary, heroQuiet } from "@/components/ui/PageHero";
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
    <Card>
      <div className="flex items-start gap-3">
        <span className="ui-icon-tile" aria-hidden><Library className="h-5 w-5" /></span>
        <div className="flex-1">
          <h2 className="text-[15px] font-semibold text-[var(--color-text)]">No libraries you can open</h2>
          <p className="text-[15px] text-[var(--color-text-muted)] mt-0.5">
            {isController
              ? "Create the first one in Library admin."
              : "Only Doc Control or an Admin can give you access."}
          </p>
        </div>
      </div>
    </Card>
  );

  if (loading || (!loadedOnce && !error && !!userEmail)) {
    return <RouteLoader label="Loading libraries…" />;
  }

  const openLib = (id: string) => {
    setPendingLibId(id);
    startTransition(() => { router.push(`/documents/${id}`); });
  };

  // One row per library: what it is, how many documents, who can read it.
  // The whole row opens it; the name is the real link.
  const libraryRows = (list: UiLibrary[]) => (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
      <table className="w-full text-[15px]">
        <thead className="bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)] text-left max-sm:hidden">
          <tr>
            <th className="font-semibold px-4 h-10">Library</th>
            <th className="font-semibold px-4 text-right w-32">Documents</th>
            <th className="font-semibold px-4 w-48">Access</th>
            <th className="w-14"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {list.map((lib) => {
            const isPending = pendingLibId === lib._id;
            const menuOpen = menuOpenForLibId === lib._id;
            const n = libCounts.get(lib._id!);
            const custom = !!(lib.color || lib.icon || lib.coverImageUrl);
            const access = !lib._canRead && !isController
              ? <span className="ui-pill is-warn"><AlertTriangle className="w-3.5 h-3.5" /> No access</span>
              : lib._isPublicRead ? <span className="ui-pill is-muted"><Eye className="w-3.5 h-3.5" /> Everyone can read</span>
              : <span className="ui-pill"><Lock className="w-3.5 h-3.5" /> Controlled</span>;
            return (
              <tr key={lib._id} data-doc-lib={lib._id}
                onClick={() => { if (!menuOpen) openLib(lib._id!); }}
                className={`group cursor-pointer hover:bg-[var(--color-surface-2)] transition-colors ${isPending ? "opacity-60" : ""}`}>
                <td className="px-4 py-3">
                  <span className="flex items-center gap-3 min-w-0">
                    {custom
                      ? <NodeCover appearance={{ color: lib.color, icon: lib.icon, coverImageUrl: lib.coverImageUrl, coverTint: lib.coverTint }}
                          className="w-9 h-9 shrink-0" rounded="rounded-lg" iconSize="w-[18px] h-[18px]" />
                      : <span className="ui-icon-tile" aria-hidden><Library className="w-[18px] h-[18px]" /></span>}
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5">
                        <Link href={`/documents/${lib._id}`}
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); openLib(lib._id!); }}
                          className="truncate text-[16px] font-semibold text-[var(--color-text)] group-hover:text-[var(--color-accent-text)] hover:underline underline-offset-2">
                          {lib.name}
                        </Link>
                        {isPending && <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-[var(--color-text-faint)]" />}
                      </span>
                      {lib.description && <span className="block text-[13px] text-[var(--color-text-muted)] truncate">{lib.description}</span>}
                      {/* Phone: the facts under the name. */}
                      <span className="sm:hidden flex items-center gap-3 mt-0.5 text-[13px] text-[var(--color-text-muted)]">
                        {n != null && <span className="inline-flex items-center gap-1"><span className="ui-count">{n.toLocaleString()}</span> documents</span>}
                        {access}
                      </span>
                    </span>
                  </span>
                </td>
                <td className="px-4 py-3 text-right max-sm:hidden">{n != null ? <span className={`ui-count ${n > 0 ? "" : "!bg-[var(--color-surface-2)] !text-[var(--color-text-muted)]"}`}>{n.toLocaleString()}</span> : ""}</td>
                <td className="px-4 py-3 text-[14px] text-[var(--color-text)] whitespace-nowrap max-sm:hidden">{access}</td>
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
                          if (error) { await appAlert({ message: `Delete failed: ${error.message}`, tone: "danger" }); return; }
                          setLibraries((arr) => arr.filter((l) => l._id !== lib._id));
                        } finally {
                          setDeletingLibId(null);
                          setMenuOpenForLibId(null);
                        }
                      }}
                    />
                  ) : <ChevronRight className="w-4 h-4 inline text-[var(--color-text-faint)] group-hover:text-[var(--color-text-muted)]" />}
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
  const answer = libraries.length === 0 ? (error ? "Libraries didn't load." : "No libraries yet.")
    : countsIn && totalDocs > 0 ? `${totalDocs.toLocaleString()} document${totalDocs === 1 ? "" : "s"}.`
    : `${nLibs}.`;
  const answerSub = libraries.length === 0
    ? (error ? "Refresh to try again. If it keeps happening, ask an Admin to check your access to this workspace." : isController ? "Set one up in Library admin." : "You don't have access to a controlled library yet.")
    : countsIn && totalDocs === 0 ? `Nothing filed yet${orgName ? ` at ${orgName}` : ""}.`
    : orgName ?? undefined;
  // The numbers behind it: libraries, documents, how many are controlled.
  const controlled = libraries.filter((l) => !l._isPublicRead).length;
  const docsAnswer = countsIn && totalDocs > 0;
  const answerFacts = libraries.length === 0 ? undefined : [
    ...(docsAnswer ? [{ label: "Libraries", value: libraries.length.toLocaleString() }] : []),
    ...(countsIn && !docsAnswer ? [{ label: "Documents", value: totalDocs.toLocaleString() }] : []),
    { label: "Controlled", value: controlled.toLocaleString() },
    { label: "Open to all", value: (libraries.length - controlled).toLocaleString() },
  ];

  return (
    <PageShell width="full" className="max-w-[1500px]">
      <PageHero
        kicker="Document control"
        title={answer}
        sub={answerSub}
        facts={answerFacts}
        tools={
          <button
            onClick={async () => {
              setRefreshing(true);
              await fetchLibraries({ silent: true });
              setRefreshing(false);
            }}
            title="Refresh"
            aria-label="Refresh"
            className={heroQuiet}
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
          </button>
        }
        primary={isController ? (
          <Link href="/admin/libraries" className={heroPrimary}>
            <Settings className="h-4 w-4" /> Library admin
          </Link>
        ) : undefined}
      >
        <ViewTabs tabs={DOCUMENT_VIEWS} />
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
                <h2 className="flex items-center gap-2.5 font-display text-[19px] leading-tight font-semibold text-[var(--color-heading)] mb-2.5">
                  <span className="ui-icon-tile is-sm is-solid" aria-hidden><Library className="w-4 h-4" /></span>
                  Libraries <span className="ui-count is-solid font-sans">{filtered.length}</span>
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
        ) : libraries.length === 0 ? (error ? (
          <Card>
            <p role="alert" className="text-[15px] text-[var(--state-overdue)] flex items-center gap-2 font-semibold">
              <AlertTriangle className="h-4 w-4" /> {error}
            </p>
          </Card>
        ) : emptyState) : (
          <section>
            <h2 className="flex items-center gap-2.5 font-display text-[19px] leading-tight font-semibold text-[var(--color-heading)] mb-2.5">
              <span className="ui-icon-tile is-sm is-solid" aria-hidden><Library className="w-4 h-4" /></span>
              Libraries <span className="ui-count is-solid font-sans">{libraries.length}</span>
            </h2>
            {libraryRows(libraries)}
          </section>
        )}

        <Card label={<span className="inline-flex items-center gap-2.5 text-[var(--color-heading)]"><span className="ui-icon-tile is-sm is-solid" aria-hidden><MapIcon className="w-4 h-4" /></span>Map <HelpTooltip>Tap a library or a folder to open it. Whole site shows the units and their equipment.</HelpTooltip></span>} className="min-w-0">
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
          <div className="absolute right-0 top-full mt-1 w-56 text-left bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] ring-1 ring-black/5 rounded-xl shadow-lg overflow-hidden z-[10] animate-in fade-in zoom-in-95 duration-150 origin-top-right">
            <div className="px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface-2)]">
              <div className="text-[13px] font-semibold text-[var(--color-text-muted)]">Admin</div>
              <div className="text-[14px] font-semibold text-[var(--color-text)] truncate">{libName}</div>
            </div>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onClose(); onCustomize(); }}
              className="w-full text-left flex items-center gap-2 px-3 py-2 text-[14px] font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
            >
              <Palette className="w-3.5 h-3.5" /> Customize appearance
            </button>
            <Link
              href={`/admin/libraries?lib=${libId}`}
              onClick={(e) => { e.stopPropagation(); onClose(); }}
              className="flex items-center gap-2 px-3 py-2 text-[14px] font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
            >
              <Settings className="w-3.5 h-3.5" /> Configure (name, columns)
            </Link>
            <Link
              href={`/admin/permissions?lib=${libId}`}
              onClick={(e) => { e.stopPropagation(); onClose(); }}
              className="flex items-center gap-2 px-3 py-2 text-[14px] font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
            >
              <KeyRound className="w-3.5 h-3.5" /> Permissions
            </Link>
            <button
              type="button"
              onClick={async (e) => {
                e.stopPropagation();
                if (!(await appConfirm({ message: `Delete library "${libName}"? Documents inside it will be orphaned. This action is audited and irreversible.`, tone: "danger" }))) return;
                onDelete();
              }}
              disabled={deleting}
              className="w-full text-left flex items-center gap-2 px-3 py-2 text-[14px] font-medium text-[var(--state-overdue)] hover:bg-[var(--color-surface-2)] border-t border-[var(--color-border)] disabled:opacity-50"
            >
              {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              {deleting ? "Deleting…" : "Delete library"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
