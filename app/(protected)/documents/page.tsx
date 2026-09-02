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
  FileText,
} from "lucide-react";
import { searchDocuments, type DocumentRow } from "@/lib/search";
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

const toArrayRole = (v: unknown): Role[] => (Array.isArray(v) ? (v as Role[]) : []);
const safeLower = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : "");

function computeCanRead(lib: Partial<LibraryConfig>, role: Role, roles: Role[] = []) {
  const readAccess = (lib as { readAccess?: Role[] | "ALL" }).readAccess;
  if (readAccess === "ALL") return true;

  const readList = toArrayRole(readAccess);
  const visibleTo = toArrayRole((lib as { visibleTo?: unknown }).visibleTo);
  // ADD-1: a role-granted read follows the full collection, not the headline.
  const held = [role, ...roles];

  return held.some((r) => readList.includes(r) || visibleTo.includes(r));
}

function computeIsPublicRead(lib: Partial<LibraryConfig>) {
  return (lib as { readAccess?: Role[] | "ALL" }).readAccess === "ALL";
}

export default function DocumentsHomePage() {
  const router = useRouter();
  const { activeRole, roles, hasAnyRole, userEmail, activeOrgId } = useRole();

  // Start false — only flip to true once we actually have everything we need
  // to fetch. This avoids "Loading libraries..." showing up forever when the
  // useEffect bails out before calling fetchLibraries.
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [libraries, setLibraries] = useState<UiLibrary[]>([]);
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

  // Short-link resolution (EGRESS-2). `/d/<number>` redirects here with `?d=`;
  // we resolve the drawing number CLIENT-SIDE under the caller's own session,
  // so org scope and the document ACL are enforced by RLS — never by a
  // service-role oracle. An exact normalized match deep-links into the viewer;
  // anything else falls back to a pre-filled search, disclosing nothing beyond
  // what this user could already search for.
  useEffect(() => {
    if (!activeOrgId || typeof window === "undefined") return;
    const raw = new URLSearchParams(window.location.search).get("d");
    if (!raw) return;
    const norm = raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
    let alive = true;
    void (async () => {
      let hit: DocumentRow | undefined;
      try {
        const rows = await searchDocuments({ orgId: activeOrgId, query: raw, limit: 25 });
        hit = rows.find((r) => (r.document_number ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "") === norm);
      } catch { /* fall through to search */ }
      if (!alive) return;
      if (hit) {
        router.replace(`/documents/${hit.library_id}?doc=${hit.id}`);
      } else {
        // No exact match the caller can see — pre-fill search, drop the ?d=.
        setSearch(raw);
        router.replace("/documents");
      }
    })();
    return () => { alive = false; };
  }, [activeOrgId, router]);

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

  // OWN-3: controller tier follows the full role collection.
  const isController = hasAnyRole(["Admin", "DocCtrl"]);

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

        const _canRead = computeCanRead(normalized, activeRole, roles);
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
  }, [userEmail, activeRole, roles, activeOrgId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return libraries;

    return libraries.filter((l) => {
      const hay = `${safeLower(l.name)} ${safeLower(l.description)} ${safeLower(l.type)}`;
      return hay.includes(q);
    });
  }, [libraries, search]);

  // The search box reaches INSIDE the libraries too: typing here sweeps every
  // document in the workspace (title, number, and equipment tags — "e22"
  // finds E-22), not just library names. Results respect library read access
  // by only showing hits from libraries this user can already see.
  const [docHits, setDocHits] = useState<DocumentRow[] | null>(null);
  const [docSearching, setDocSearching] = useState(false);
  useEffect(() => {
    const q = search.trim();
    const t = setTimeout(() => {
      if (!activeOrgId || q.length < 2) { setDocHits(null); return; }
      setDocSearching(true);
      searchDocuments({ orgId: activeOrgId, query: q, limit: 12 })
        .then(setDocHits)
        .catch(() => setDocHits([]))
        .finally(() => setDocSearching(false));
    }, 250);
    return () => clearTimeout(t);
  }, [search, activeOrgId]);

  const libById = useMemo(() => new Map(libraries.map((l) => [l._id, l])), [libraries]);
  const visibleDocHits = useMemo(
    () => (docHits ?? []).filter((d) => libById.has(d.library_id)),
    [docHits, libById],
  );

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

  return (
    <div className="min-h-full p-4 sm:p-8 pb-20">
      <div className="max-w-6xl mx-auto">
        <ViewTabs title="Documents" tabs={DOCUMENT_VIEWS} />
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-black text-[var(--color-text)] tracking-tight">Document Control</h1>
            <p className="text-sm text-[var(--color-text-muted)] mt-1">
              Secure libraries{orgName ? <> for <span className="font-bold text-[var(--color-text)]">{orgName}</span></> : ""}.
            </p>
          </div>

          <div className="flex items-center gap-3 w-full md:w-auto">
            <div className="relative flex-1 md:flex-none">
              <Search className="w-4 h-4 text-[var(--color-text-faint)] absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search libraries & documents… (e.g. E-22)"
                className="pl-9 pr-4 py-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 w-full md:w-72"
              />
            </div>

            <button
              onClick={async () => {
                setRefreshing(true);
                await fetchLibraries({ silent: true });
                setRefreshing(false);
              }}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)] shadow-sm hover:bg-[var(--color-surface-2)] font-bold text-sm"
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            <div className="flex items-center gap-2 font-bold">
              <AlertTriangle className="h-4 w-4" />
              {error}
            </div>
            <div className="mt-2 text-xs text-red-700">
              If this keeps happening, ask your Admin to check that your membership is active for this workspace.
            </div>
          </div>
        )}

        {/* Document hits across every library — the search box looks inside,
            not just at library names. */}
        {search.trim().length >= 2 && (docSearching || visibleDocHits.length > 0) && (
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-2">
              <FileText className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
              <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">
                Documents matching &ldquo;{search.trim()}&rdquo;
              </span>
              {docSearching && <Loader2 className="w-3 h-3 animate-spin text-[var(--color-text-faint)]" />}
            </div>
            {visibleDocHits.length > 0 && (
              <ul className="rounded-2xl border border-[var(--color-border)] divide-y divide-[var(--color-border)] bg-[var(--color-surface)] shadow-sm overflow-hidden">
                {visibleDocHits.map((d) => (
                  <li key={String(d.id)}>
                    <Link
                      href={`/documents/${d.library_id}?doc=${d.id}`}
                      className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--color-surface-2)]/70 transition-colors"
                    >
                      <FileText className="w-4 h-4 text-[var(--color-text-faint)] shrink-0" />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-bold text-[var(--color-text)]">
                          {d.document_number || d.title || d.name || "Untitled"}
                        </span>
                        {d.title && d.document_number && (
                          <span className="text-sm text-[var(--color-text-muted)]"> · {d.title}</span>
                        )}
                      </div>
                      <span className="text-[10px] font-bold text-[var(--color-text-muted)] bg-[var(--color-surface-2)] rounded-full px-2 py-0.5 shrink-0 max-w-[180px] truncate">
                        {libById.get(d.library_id)?.name ?? "Library"}
                      </span>
                      <ArrowRight className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {filtered.length === 0 ? (
          search.trim() ? (
            visibleDocHits.length === 0 && !docSearching ? (
              <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-10 text-center">
                <p className="text-sm font-bold text-[var(--color-text)]">No libraries or documents match &ldquo;{search.trim()}&rdquo;.</p>
                <button onClick={() => setSearch("")} className="mt-3 text-sm font-bold text-[var(--color-accent)] hover:underline">
                  Clear search
                </button>
              </div>
            ) : null
          ) : (
            <EmptyState />
          )
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filtered.map((lib) => {
              const isPending = pendingLibId === lib._id;
              const menuOpen = menuOpenForLibId === lib._id;
              return (
              <button
                key={lib._id}
                onClick={() => {
                  if (menuOpen) return;
                  setPendingLibId(lib._id);
                  startTransition(() => {
                    router.push(`/documents/${lib._id}`);
                  });
                }}
                disabled={isPending}
                className={`text-left bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl shadow-sm hover:border-[var(--color-border-strong)] hover-lift transition cursor-pointer relative overflow-hidden ${isPending ? "opacity-60 ring-2 ring-slate-900/10" : ""}`}
              >
                {/* Cover banner — image (with palette tint) or color/brand panel */}
                <NodeCover
                  appearance={{ color: lib.color, icon: lib.icon, coverImageUrl: lib.coverImageUrl, coverTint: lib.coverTint }}
                  className="h-24 w-full"
                  rounded="rounded-none"
                  iconSize="w-7 h-7"
                />
                {isController && (
                  <LibraryAdminMenu
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
                )}
                {isPending && (
                  <div className="absolute top-3 right-12 inline-flex items-center gap-1.5 text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider bg-[var(--color-surface-2)] px-2 py-1 rounded-md">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Opening
                  </div>
                )}
                <div className="p-6 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-lg font-black text-[var(--color-text)] truncate">{lib.name}</div>
                    <div className="text-sm text-[var(--color-text-muted)] mt-1 line-clamp-2">{lib.description}</div>

                    <div className="mt-4 flex flex-wrap gap-2">
                      {lib._isPublicRead ? (
                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                          <Eye className="w-3 h-3" /> Public Read
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-bold bg-[var(--color-surface-2)] text-[var(--color-text)] border border-[var(--color-border)]">
                          <Lock className="w-3 h-3" /> Controlled
                        </span>
                      )}
                      {!lib._canRead && !isController && (
                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-bold bg-amber-50 text-amber-800 border border-amber-200">
                          <AlertTriangle className="w-3 h-3" /> No Access
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="shrink-0 inline-flex items-center gap-2 text-[var(--color-text)] font-black">
                    Open <ArrowRight className="w-4 h-4" />
                  </div>
                </div>
              </button>
              );
            })}
          </div>
        )}
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
  libId, libName, open, deleting,
  onToggle, onClose, onDelete, onCustomize,
}: {
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
    <div className="absolute top-3 right-3 z-10" onClick={(e) => e.stopPropagation()}>
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
