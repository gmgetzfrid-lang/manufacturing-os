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
} from "lucide-react";
import { useFind } from "@/components/find/useFind";
import FindPanel, { findMapState } from "@/components/find/FindPanel";
import FindMap from "@/components/find/FindMap";
import { folderForUnit } from "@/lib/findEverywhere";
import RouteLoader from "@/components/ui/RouteLoader";
import NodeCover from "@/components/documents/NodeCover";
import CustomizeNodeModal, { type CustomizeValue } from "@/components/documents/CustomizeNodeModal";
import ViewTabs, { DOCUMENT_VIEWS } from "@/components/navigation/ViewTabs";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary, heroQuiet } from "@/components/ui/PageHero";
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
  // A /d/<number> short link that found no exact match lands here with ?q=
  // pre-filling the search, so the user sees the nearest hits immediately.
  const [search, setSearch] = useState(() =>
    typeof window === "undefined" ? "" : (new URLSearchParams(window.location.search).get("q") ?? ""));
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
      <div className="flex items-start gap-4">
        <div className="h-10 w-10 rounded-xl bg-[var(--color-surface-2)] text-[var(--color-text-muted)] flex items-center justify-center shrink-0">
          <Library className="h-5 w-5" />
        </div>

        <div className="flex-1">
          <h2 className="text-[14px] font-bold text-[var(--color-text)]">No libraries you can open</h2>
          <p className="text-[14px] text-[var(--color-text-muted)] mt-1">
            {isController
              ? "There are no libraries configured yet. Create your first library in the Library Admin panel."
              : "You don't currently have access to any controlled libraries. Contact Doc Control or an Admin to grant access."}
          </p>

          {/* Library Admin is the band's orange action for controllers. */}
          {!isController && (
            <p className="mt-3 text-[14px] font-semibold text-[var(--color-text)]">
              Only Doc Control or an Admin can give access.
            </p>
          )}
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

  // One line per library: what it is, how many documents, who can read it.
  const libraryRows = (list: UiLibrary[]) => (
    <div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_2rem] sm:grid-cols-[minmax(0,1fr)_auto_7.5rem_2rem] items-center gap-3 px-4 sm:px-5 pb-2 border-b border-[var(--color-border)] text-[11px] font-extrabold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
        <span>Library</span><span className="text-right">Documents</span><span className="hidden sm:block">Access</span><span />
      </div>
      {list.map((lib) => {
        const isPending = pendingLibId === lib._id;
        const menuOpen = menuOpenForLibId === lib._id;
        const n = libCounts.get(lib._id!);
        return (
          <div key={lib._id} role="link" tabIndex={0} data-doc-lib={lib._id}
            onClick={() => { if (!menuOpen) openLib(lib._id!); }}
            onKeyDown={(e) => { if (e.key === "Enter") openLib(lib._id!); }}
            className={`group grid grid-cols-[minmax(0,1fr)_auto_2rem] sm:grid-cols-[minmax(0,1fr)_auto_7.5rem_2rem] items-center gap-3 px-4 sm:px-5 py-3 border-b last:border-b-0 last:rounded-b-2xl border-[var(--color-border)] cursor-pointer hover:bg-[var(--color-surface-2)] transition-colors ${isPending ? "opacity-60" : ""}`}>
            <span className="flex items-center gap-3 min-w-0">
              <NodeCover appearance={{ color: lib.color, icon: lib.icon, coverImageUrl: lib.coverImageUrl, coverTint: lib.coverTint }}
                className="w-9 h-9 shrink-0" rounded="rounded-[9px]" iconSize="w-4 h-4" />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-[14px] font-bold text-[var(--color-text)]">
                  <span className="truncate">{lib.name}</span>
                  {isPending && <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-[var(--color-text-faint)]" />}
                </span>
                {lib.description && <span className="block text-[13px] text-[var(--color-text-muted)] truncate">{lib.description}</span>}
              </span>
            </span>
            <span className="text-right text-[14px] font-semibold tabular-nums text-[var(--color-text)]">{n != null ? n.toLocaleString() : ""}</span>
            <span className="hidden sm:inline-flex items-center gap-1 text-[13px] text-[var(--color-text-muted)]">
              {!lib._canRead && !isController ? <><AlertTriangle className="w-3 h-3 text-amber-600" /> No access</>
                : lib._isPublicRead ? <><Eye className="w-3 h-3" /> Public read</> : <><Lock className="w-3 h-3" /> Controlled</>}
            </span>
            <span className="flex justify-end">
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
              ) : <ChevronRight className="w-4 h-4 text-[var(--color-text-faint)] group-hover:text-[var(--color-text-muted)]" />}
            </span>
          </div>
        );
      })}
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
    ? (error ? "Refresh to try again. If it keeps happening, ask an Admin to check your access to this workspace." : isController ? "Set one up in Library Admin." : "You don't have access to a controlled library yet.")
    : countsIn && totalDocs > 0 ? `In ${nLibs}${orgName ? ` at ${orgName}` : ""}.`
    : countsIn ? `Nothing filed yet${orgName ? ` at ${orgName}` : ""}.`
    : orgName ?? undefined;

  return (
    <PageShell width="full" className="max-w-[1500px]">
      <PageHero
        kicker="Document control"
        title={answer}
        sub={answerSub}
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
        <ViewTabs tabs={DOCUMENT_VIEWS} variant="dark" />
        <form role="search" onSubmit={(e) => e.preventDefault()} className="relative mt-3">
          <Search className="w-4 h-4 text-[var(--color-ink-muted)] absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setSearch(""); }}
            placeholder="Find by equipment tag (E-22), drawing number or words inside"
            aria-label="Search documents and equipment"
            data-find-input
            className="w-full h-12 pl-11 pr-11 rounded-xl border border-[var(--color-ink-line)] bg-[var(--color-ink-2)] text-white placeholder:text-[var(--color-ink-muted)] text-base sm:text-[15px] focus:outline-none focus:border-[var(--color-ink-muted)] focus:ring-2 focus:ring-[var(--color-accent)]/40"
          />
          {search && (
            <button aria-label="Clear search" type="button" onClick={() => setSearch("")} title="Clear the search"
              className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 grid place-items-center rounded-lg text-[var(--color-ink-muted)] hover:text-white hover:bg-[var(--color-ink-line)]">
              <X className="w-4 h-4" />
            </button>
          )}
        </form>
      </PageHero>

      <PageBody>
        {/* The list (or the search) on the left; the map beside it, always. */}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(380px,44%)] items-start">
          <div className="min-w-0 space-y-4">
            {searching ? (
              <>
                {filtered.length > 0 && (
                  <Card label="Libraries" pad={false}>
                    {libraryRows(filtered)}
                  </Card>
                )}
                <Card label={<>Search: “{search.trim()}”</>}>
                  <FindPanel orgId={activeOrgId} f={finder} unit={null} hideMap
                    onOpenFolder={(fo) => router.push(`/documents/${fo.libraryId}?folderId=${fo.id}`)}
                    onOpenHref={(href) => router.push(href)} />
                </Card>
              </>
            ) : libraries.length === 0 ? (error ? (
              <Card>
                <p role="alert" className="text-[14px] text-rose-700 dark:text-rose-300 flex items-center gap-2 font-semibold">
                  <AlertTriangle className="h-4 w-4" /> {error}
                </p>
              </Card>
            ) : emptyState) : (
              <Card label="Libraries" pad={false} className="pb-1">
                {libraryRows(libraries)}
              </Card>
            )}
          </div>

          {/* On a phone the map leads, so it is never a scroll away. */}
          <Card label="Map" className="min-w-0 order-first lg:order-none lg:sticky lg:top-4">
            <FindMap orgId={activeOrgId} unit={searching ? ms.unit : null}
              assetId={searching ? ms.assetId : null} docs={searching ? ms.docs : null} candidates={searching ? ms.candidates : undefined}
              onPickAsset={(id, tag) => {
                if (searching && finder.quick?.equipment.some((e) => e.id === id)) finder.pick(id);
                else { setSearch(tag); finder.pickWhenFound(id); }
              }}
              onUnit={(code) => void openUnitFolder(code)}
              className="h-64 lg:h-[calc(100vh-16rem)] lg:min-h-[26rem]" />
            <p className="mt-2 text-[13px] text-[var(--color-text-muted)]">Tap a unit to open its drawings, a piece of equipment to see its documents, a document to open it here.</p>
          </Card>
        </div>
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
        className={`p-1.5 rounded-md transition-colors ${open ? "bg-[var(--color-text)] text-[var(--color-surface)]" : "text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}
      >
        <MoreVertical className="w-4 h-4" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[5]" onClick={(e) => { e.stopPropagation(); onClose(); }} />
          <div className="absolute right-0 top-full mt-1 w-52 bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] ring-1 ring-black/5 rounded-xl shadow-lg overflow-hidden z-[10] animate-in fade-in zoom-in-95 duration-150 origin-top-right">
            <div className="px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface-2)]">
              <div className="text-[11px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">Admin</div>
              <div className="text-xs font-bold text-[var(--color-text)] truncate">{libName}</div>
            </div>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onClose(); onCustomize(); }}
              className="w-full text-left flex items-center gap-2 px-3 py-2 text-xs font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
            >
              <Palette className="w-3.5 h-3.5" /> Customize appearance
            </button>
            <Link
              href={`/admin/libraries?lib=${libId}`}
              onClick={(e) => { e.stopPropagation(); onClose(); }}
              className="flex items-center gap-2 px-3 py-2 text-xs font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
            >
              <Settings className="w-3.5 h-3.5" /> Configure (name, columns)
            </Link>
            <Link
              href={`/admin/permissions?lib=${libId}`}
              onClick={(e) => { e.stopPropagation(); onClose(); }}
              className="flex items-center gap-2 px-3 py-2 text-xs font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
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
              className="w-full text-left flex items-center gap-2 px-3 py-2 text-xs font-bold text-red-700 hover:bg-red-50 border-t border-[var(--color-border)] disabled:opacity-50"
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
