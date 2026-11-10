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
  ArrowRight,
  Settings,
  RefreshCw,
  AlertTriangle,
  Shield,
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
    if (error) { await appAlert({ message: `Save failed: ${error.message}`, tone: "danger" }); return; }
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
      setError("Failed to load libraries. Check Supabase permissions and console errors.");
      setLibraries([]);
    } finally {
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
      <div className="min-h-full p-4 sm:p-8">
        <div className="max-w-3xl mx-auto bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="h-12 w-12 rounded-2xl bg-slate-900 text-white flex items-center justify-center shadow">
              <Shield className="h-6 w-6" />
            </div>
            <div className="flex-1">
              <h2 className="text-xl font-black text-[var(--color-text)]">Workspace not selected</h2>
              <p className="text-sm text-[var(--color-text-muted)] mt-2">
                Please select a workspace from the sidebar to view your documents and libraries.
              </p>
              <p className="text-xs text-[var(--color-text-muted)] mt-3">
                Your access is determined by your membership in the selected organization.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const EmptyState = () => (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-10 shadow-sm">
      <div className="flex items-start gap-4">
        <div className="h-12 w-12 rounded-2xl bg-slate-900 text-white flex items-center justify-center shadow">
          <Library className="h-6 w-6" />
        </div>

        <div className="flex-1">
          <h2 className="text-xl font-bold text-[var(--color-text)]">No libraries available</h2>
          <p className="text-sm text-[var(--color-text-muted)] mt-1">
            {isController
              ? "There are no libraries configured yet. Create your first library in the Library Admin panel."
              : "You don't currently have access to any controlled libraries. Contact Doc Control or an Admin to grant access."}
          </p>

          <div className="mt-6 flex flex-wrap gap-3">
            {isController ? (
              <Link
                href="/admin/libraries"
                className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-sm font-bold text-white shadow hover:bg-slate-800 transition"
              >
                <Settings className="h-4 w-4" />
                Open Library Admin
                <ArrowRight className="h-4 w-4" />
              </Link>
            ) : (
              <div className="inline-flex items-center gap-2 rounded-xl bg-amber-50 px-4 py-2 text-sm font-bold text-amber-800 border border-amber-200">
                <AlertTriangle className="h-4 w-4" />
                Access is controlled by DocCtrl/Admin only.
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );

  if (loading) {
    return <RouteLoader label="Loading libraries…" />;
  }

  const openLib = (id: string) => {
    setPendingLibId(id);
    startTransition(() => { router.push(`/documents/${id}`); });
  };

  // One line per library: what it is, how many documents, who can read it.
  const libraryRows = (list: UiLibrary[]) => (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_2rem] sm:grid-cols-[minmax(0,1fr)_auto_7.5rem_2rem] items-center gap-3 px-4 py-2 border-b border-[var(--color-border)] text-[10.5px] font-black uppercase tracking-wider text-[var(--color-text-faint)]">
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
            className={`group grid grid-cols-[minmax(0,1fr)_auto_2rem] sm:grid-cols-[minmax(0,1fr)_auto_7.5rem_2rem] items-center gap-3 px-4 py-2.5 border-b last:border-b-0 border-[var(--color-border)] cursor-pointer hover:bg-[var(--color-surface-2)] transition-colors ${isPending ? "opacity-60" : ""}`}>
            <span className="flex items-center gap-3 min-w-0">
              <NodeCover appearance={{ color: lib.color, icon: lib.icon, coverImageUrl: lib.coverImageUrl, coverTint: lib.coverTint }}
                className="w-8 h-8 shrink-0" rounded="rounded-md" iconSize="w-4 h-4" />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm font-bold text-[var(--color-text)] group-hover:text-[var(--color-accent)]">
                  <span className="truncate">{lib.name}</span>
                  {isPending && <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-[var(--color-text-faint)]" />}
                </span>
                {lib.description && <span className="block text-xs text-[var(--color-text-muted)] truncate">{lib.description}</span>}
              </span>
            </span>
            <span className="text-right text-sm font-semibold tabular-nums text-[var(--color-text)]">{n != null ? n.toLocaleString() : ""}</span>
            <span className="hidden sm:inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--color-text-muted)]">
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
              ) : <ChevronRight className="w-4 h-4 text-[var(--color-text-faint)] group-hover:text-[var(--color-accent)]" />}
            </span>
          </div>
        );
      })}
    </div>
  );

  const totalDocs = [...libCounts.values()].reduce((a, b) => a + b, 0);

  return (
    <div className="min-h-full p-4 sm:p-6 pb-20">
      <div className="max-w-[1500px] mx-auto">
        <ViewTabs title="Documents" tabs={DOCUMENT_VIEWS} />
        <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-3 mb-4">
          <div>
            <h1 className="text-2xl font-black text-[var(--color-text)] tracking-tight">Document Control</h1>
            <p className="text-sm text-[var(--color-text-muted)] mt-0.5">
              {libraries.length} librar{libraries.length === 1 ? "y" : "ies"}{totalDocs ? ` · ${totalDocs.toLocaleString()} documents` : ""}{orgName ? <> · <span className="font-semibold text-[var(--color-text)]">{orgName}</span></> : ""}
            </p>
          </div>

          <div className="flex items-center gap-2 w-full lg:w-auto min-w-0">
            <form role="search" onSubmit={(e) => e.preventDefault()} className="relative flex-1 min-w-0 lg:w-[30rem] lg:flex-none">
              <Search className="w-4 h-4 text-[var(--color-text-faint)] absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") setSearch(""); }}
                placeholder="Search tags, equipment IDs, drawing numbers, words"
                aria-label="Search documents and equipment"
                data-find-input
                className="pl-9 pr-8 h-10 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/30 focus:border-[var(--color-accent)] w-full"
              />
              {search && (
                <button type="button" onClick={() => setSearch("")} title="Clear the search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-[var(--color-text-faint)] hover:text-[var(--color-text)]">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </form>
            <button
              onClick={async () => {
                setRefreshing(true);
                await fetchLibraries({ silent: true });
                setRefreshing(false);
              }}
              title="Refresh"
              className="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            <div className="flex items-center gap-2 font-bold">
              <AlertTriangle className="h-4 w-4" />
              {error}
            </div>
            <div className="mt-2 text-xs text-red-700">
              If this keeps happening, ask your Admin to check that your membership is active for this workspace.
            </div>
          </div>
        )}

        {/* The list (or the search) on the left; the map beside it, always. */}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(380px,44%)] items-start">
          <div className="min-w-0 space-y-4">
            {searching ? (
              <>
                {filtered.length > 0 && (
                  <div>
                    <div className="mb-1.5 text-[10.5px] font-black uppercase tracking-wider text-[var(--color-text-faint)]">Libraries</div>
                    {libraryRows(filtered)}
                  </div>
                )}
                <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm p-3">
                  <FindPanel orgId={activeOrgId} f={finder} unit={null} hideMap
                    onOpenFolder={(fo) => router.push(`/documents/${fo.libraryId}?folderId=${fo.id}`)}
                    onOpenHref={(href) => router.push(href)} />
                </div>
              </>
            ) : libraries.length === 0 ? <EmptyState /> : libraryRows(libraries)}
          </div>

          {/* On a phone the map leads, so it is never a scroll away. */}
          <div className="min-w-0 order-first lg:order-none lg:sticky lg:top-4">
            <FindMap orgId={activeOrgId} unit={searching ? ms.unit : null}
              assetId={searching ? ms.assetId : null} docs={searching ? ms.docs : null} candidates={searching ? ms.candidates : undefined}
              onPickAsset={(id, tag) => {
                if (searching && finder.quick?.equipment.some((e) => e.id === id)) finder.pick(id);
                else { setSearch(tag); finder.pickWhenFound(id); }
              }}
              onUnit={(code) => void openUnitFolder(code)}
              onDoc={(d) => { if (searching && finder.docs[d.id]) finder.setPreview(d.id); else router.push(d.href); }}
              className="h-64 lg:h-[calc(100vh-13rem)] lg:min-h-[28rem]" />
            <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">Tap a unit to open its drawings, a piece of equipment to see its documents.</p>
          </div>
        </div>
      </div>

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
    </div>
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
        className={`p-1.5 rounded-md transition-colors ${open ? "bg-slate-900 text-white" : "text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}
      >
        <MoreVertical className="w-4 h-4" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[5]" onClick={(e) => { e.stopPropagation(); onClose(); }} />
          <div className="absolute right-0 top-full mt-1 w-52 bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] ring-1 ring-black/5 rounded-xl shadow-lg overflow-hidden z-[10] animate-in fade-in zoom-in-95 duration-150 origin-top-right">
            <div className="px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface-2)]">
              <div className="text-[9px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">Admin</div>
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
