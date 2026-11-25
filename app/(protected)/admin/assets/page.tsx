"use client";

// /admin/assets — Operating Areas.
//
// The landing page is the SITE: one card per operating unit (from the Site
// Codebook). Step into a unit and you're in that unit's hub — its equipment
// grouped by type, the libraries/folders pinned to it (P&IDs, operating
// manuals, unit data — whatever this org wires up), and every document that
// references the unit's equipment. The unit is the front door; everything
// about it lives one click inside.

import React, { useEffect, useState, useCallback, useMemo, useDeferredValue, Suspense } from "react";
import { createPortal } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Tag, Plus, Search, Camera,
  Image as ImageIcon, AlertTriangle,
  Lock, X, Edit3, Trash2,
  FileText, Upload, QrCode, BookMarked, FolderTree,
  FolderOpen, Link2, ArrowLeft, Waypoints, RotateCcw, ExternalLink,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import {
  listAssets, listAssetTypes, getPhotoCounts, getCoverPhotoUrls, createAsset, createAssetType,
  updateAsset, deleteAsset, listAssetPhotos, deletePhoto, updatePhoto,
  invalidateAssetCache, photoAgeCategory,
  type Asset, type AssetType, type AssetPhoto, type PhotoStatus,
} from "@/lib/assets";
import {
  loadCodebook, tagToCode, parseDrawingNumber, saveUnitLinks, EMPTY_CODEBOOK,
  type Codebook, type UnitResourceLink,
} from "@/lib/codebook";
import { listLibraryFoldersOnce, type PickerFolder } from "@/lib/libraryCollections";
import { getDocumentsForAssetsHydrated } from "@/lib/operationalGraph";
import AssetPhotoCarousel from "@/components/assets/AssetPhotoCarousel";
import { CategorizeBanner, FlowPanel } from "@/components/assets/UnitOpsPanels";
import { AreaKnowledgePanel } from "@/components/assets/AreaKnowledgePanel";
import DocumentLinkPicker from "@/components/documents/DocumentLinkPicker";
import AssetPhotoUploader from "@/components/assets/AssetPhotoUploader";
import AssetCsvImportModal from "@/components/assets/AssetCsvImportModal";
import EquipmentStartOver from "@/components/assets/EquipmentStartOver";
import TreeList, { type TreeRow } from "@/components/assets/TreeList";
import WatchButton from "@/components/ui/WatchButton";
import Link from "next/link";
import { getDocumentsForAssetHydrated, type AssetDocumentRow } from "@/lib/operationalGraph";
import QuickNoteComposer from "@/components/notes/QuickNoteComposer";
import SignedImg from "@/components/assets/SignedImg";
import DuplicateAwareInput from "@/components/ui/DuplicateAwareInput";
import { translatePostgresError } from "@/lib/inputValidation";
import { normalizeTag } from "@/lib/assets";
import ViewTabs, { EQUIPMENT_VIEWS } from "@/components/navigation/ViewTabs";
import { appAlert, appConfirm } from "@/components/providers/DialogProvider";
import LoadingBlock from "@/components/ui/LoadingBlock";
import HelpTooltip from "@/components/ui/HelpTooltip";
import MoreMenu, { type MoreItem } from "@/components/ui/MoreMenu";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { useDraft } from "@/hooks/useDraft";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, heroPrimary, heroQuiet, type HeroFact } from "@/components/ui/PageHero";
import { Button, useActionFeedback } from "@/components/ui/Button";
import { CopyId } from "@/components/ui/CopyId";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { friendlyError } from "@/lib/friendlyError";
import { transitionPush } from "@/lib/viewTransition";
import { sheet, link, btnQuiet, btnLink, btnDanger, btnIcon, field, label as labelCls, StatusTag, Problem, Section, shortDate } from "@/components/admin/kit";
import { bandInput, bandInputIcon, bandSelect, bandSeg, bandSegItem, plural } from "@/components/admin/band";
import EquipmentFilesDialog from "@/components/assets/EquipmentFilesDialog";
import { loadTree } from "@/lib/equipmentLibraryPush";
import type { EquipmentTree } from "@/lib/equipmentLibrary";
import { useEquipmentFilesSync } from "@/components/assets/useEquipmentFilesSync";
import { assetHref } from "@/lib/equipmentIdentity";

/** Full-screen overlays live on <body>, above the top bar (the page is its
 *  own stacking layer while it animates between views). */
const onBody = (node: React.ReactNode) => (typeof document === "undefined" ? node : createPortal(node, document.body));

// DocCtrl belongs here: document controllers own the asset↔document wiring
// (categories, codebook areas, file links), so gating them out of asset
// creation left them able to manage everything about an asset EXCEPT
// making it exist.
const ADMIN_ROLES = ["Admin", "DocCtrl", "Manager", "Supervisor"];

export default function AssetsPage() {
  // useSearchParams needs a Suspense boundary at build time.
  return (
    <Suspense fallback={<PageShell><PageHero kicker="Operating areas" title="Operating areas" overlap={false} /><LoadingBlock what="operating areas" /></PageShell>}>
      <AssetsPageInner />
    </Suspense>
  );
}

function AssetsPageInner() {
  const { activeOrgId, activeRole, uid, userEmail, hasAnyRole } = useRole();
  const isAdmin = ADMIN_ROLES.includes(activeRole);
  // Adding, changing or removing equipment: admins only (the database holds
  // the same rule). The rest of the managing roles keep labels, photos and
  // categories.
  const canEditEquipment = hasAnyRole(["Admin"]);
  const router = useRouter();
  const searchParams = useSearchParams();

  const [assets, setAssets] = useState<Asset[]>([]);
  const [types, setTypes] = useState<AssetType[]>([]);
  const [photoCounts, setPhotoCounts] = useState<Map<string, number>>(new Map());
  const [coverUrls, setCoverUrls] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // A ?tag= deep link (global search asset hits) lands with that tag in the
  // search box, already narrowed.
  const [search, setSearch] = useState(() => searchParams.get("tag") ?? "");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [filterMode, setFilterMode] = useState<"all" | "with_photos" | "no_photos">("all");
  // Unit-first browsing (Site Codebook): no ?unit= param = the unit picker; a
  // unit code (or "__unassigned") = inside that unit. Living in the URL means
  // the browser back button leaves a unit the way people expect — no trap.
  const unitFilter = searchParams.get("unit");
  const setUnitFilter = useCallback((code: string | null) => {
    router.push(code ? `/admin/assets?unit=${encodeURIComponent(code)}` : "/admin/assets");
  }, [router]);
  const [book, setBook] = useState<Codebook>(EMPTY_CODEBOOK);

  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
  const [creating, setCreating] = useState(false);
  // Where you stand decides what "new" means: root → operating area,
  // unit → category, category → asset (preset lands in the drawer).
  const [createPreset, setCreatePreset] = useState<{ typeId?: string; unitCode?: string } | null>(null);
  const [addUnitOpen, setAddUnitOpen] = useState(false);
  const [addCategoryOpen, setAddCategoryOpen] = useState(false);
  const openCreate = useCallback((preset?: { typeId?: string; unitCode?: string }) => {
    setCreatePreset(preset ?? null);
    setCreating(true);
  }, []);
  const [carouselOpenFor, setCarouselOpenFor] = useState<Asset | null>(null);
  const [uploaderOpenFor, setUploaderOpenFor] = useState<Asset | null>(null);
  const [csvOpen, setCsvOpen] = useState(false);
  // Start over from the drawings: an admin clears what the reader added.
  const [startOverOpen, setStartOverOpen] = useState(() => searchParams.get("startOver") === "1");
  // The Equipment Files library: document control laid out like these areas.
  const [efOpen, setEfOpen] = useState(() => searchParams.get("equipmentFiles") === "1");
  const [efTree, setEfTree] = useState<EquipmentTree | null | undefined>(undefined);
  useEffect(() => {
    if (!activeOrgId) return;
    let on = true;
    void loadTree(activeOrgId).then((t) => { if (on) setEfTree(t); }, () => { if (on) setEfTree(null); });
    return () => { on = false; };
  }, [activeOrgId]);

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    setLoading(true);
    setError(null);
    try {
      const [as, ts, cb] = await Promise.all([
        listAssets({ orgId: activeOrgId, archived: false }),
        listAssetTypes(activeOrgId),
        loadCodebook(activeOrgId),
      ]);
      setAssets(as);
      setTypes(ts);
      setBook(cb);
      const [counts, covers] = await Promise.all([
        getPhotoCounts(activeOrgId, as.map((a) => a.id)),
        getCoverPhotoUrls(as),
      ]);
      setPhotoCounts(counts);
      setCoverUrls(covers);
    } catch (e) {
      setError((e as Error).message);
    } finally { setLoading(false); }
  }, [activeOrgId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Equipment Files keeps itself in step with this registry and the site
  // codebook: each time the equipment loads or changes, missing folders are
  // made, renamed or renumbered ones renamed, re-typed equipment moved. Admin
  // and Document Control only (the database makes folders for them alone).
  const canSyncFolders = hasAnyRole(["Admin", "DocCtrl"]);
  const efSync = useEquipmentFilesSync({
    orgId: activeOrgId, uid, email: userEmail, can: canSyncFolders && !!efTree?.assets,
    trigger: efTree?.assets && !loading ? assets : null,
    onSynced: setEfTree,
  });

  // ── Filters ────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return assets.filter((a) => {
      if (unitFilter === "__unassigned" && a.unit_code) return false;
      if (unitFilter && unitFilter !== "__unassigned" && a.unit_code !== unitFilter) return false;
      if (typeFilter && a.type_id !== typeFilter) return false;
      const count = photoCounts.get(a.id) || 0;
      if (filterMode === "with_photos" && count === 0) return false;
      if (filterMode === "no_photos" && count > 0) return false;
      if (q) {
        // Both identities are searchable: field tag (E-22) AND site code
        // (2030.22) — and forgivingly: "e22" finds E-22, "203022" finds
        // 2030.22 (punctuation squashed from both sides).
        const haystack = `${a.tag} ${a.code ?? ""} ${a.description ?? ""} ${a.location ?? ""}`.toLowerCase();
        if (!haystack.includes(q)) {
          const qNorm = q.replace(/[^a-z0-9]+/g, "");
          const tolerant = qNorm.length >= 2 && qNorm.length <= 12 &&
            (normalizeTag(a.tag).includes(qNorm) || normalizeTag(a.code ?? "").includes(qNorm));
          if (!tolerant) return false;
        }
      }
      return true;
    });
  }, [assets, photoCounts, typeFilter, filterMode, search, unitFilter]);

  // Per-unit counts for the picker cards.
  const unitCounts = useMemo(() => {
    const m = new Map<string, number>();
    let unassigned = 0;
    for (const a of assets) {
      if (a.unit_code) m.set(a.unit_code, (m.get(a.unit_code) ?? 0) + 1);
      else unassigned++;
    }
    return { byUnit: m, unassigned };
  }, [assets]);

  // Inside a unit, the grid groups by equipment type (name-sorted sections;
  // typeless assets gather under "Uncategorized").
  const groupedByType = useMemo(() => {
    if (!unitFilter) return null;
    const groups = new Map<string, Asset[]>();
    // Every category exists as a section even when empty — a category you
    // just created must be a real place you can step into and fill.
    for (const t of types) groups.set(t.id, []);
    for (const a of filtered) {
      const key = a.type_id ?? "__none";
      const list = groups.get(key) ?? [];
      list.push(a);
      groups.set(key, list);
    }
    return [...groups.entries()]
      .map(([typeId, list]) => ({
        typeId,
        name: typeId === "__none" ? "Uncategorized" : (types.find((t) => t.id === typeId)?.name ?? "Uncategorized"),
        list: list.sort((x, y) => x.tag.localeCompare(y.tag, undefined, { numeric: true })),
      }))
      .filter((g) => g.list.length > 0 || g.typeId !== "__none")
      // A-Z, with the "sort these" bucket last.
      .sort((x, y) => (x.typeId === "__none" ? 1 : 0) - (y.typeId === "__none" ? 1 : 0) || x.name.localeCompare(y.name));
  }, [unitFilter, filtered, types]);
  // Inside a unit every equipment type starts open; on the landing tree
  // every unit starts closed. A branch that was just opened builds its rows
  // a moment later (deferred), with skeleton rows in its place meanwhile.
  const [closedTypes, setClosedTypes] = useState<Set<string>>(new Set());
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set());
  const deferredClosed = useDeferredValue(closedTypes);
  const deferredOpen = useDeferredValue(openKeys);
  // How many rows a long branch shows before "Show more".
  const [limits, setLimits] = useState<Map<string, number>>(new Map());

  // The Site Codebook's numbering for each category (matched by label):
  // "Exchanger" → code 02, prefixes E/EA. Painted on the section header so
  // the code you taught the codebook is VISIBLY doing something.
  const cbTypeByLabel = useMemo(() => {
    const m = new Map<string, { code: string; prefixes: string[] }>();
    for (const e of book.equipmentTypes) {
      const label = (e.label ?? "").trim().toLowerCase();
      if (!label) continue;
      m.set(label, {
        code: e.code,
        prefixes: (e.meta.tagPrefixes ?? []).slice(0, 4),
      });
    }
    return m;
  }, [book.equipmentTypes]);

  // Landing cards: everything a unit card says about itself — equipment
  // count, the top types inside, photo debt, pinned resources.
  const unitSummaries = useMemo(() => {
    return book.units.map((u) => {
      const inUnit = assets.filter((a) => a.unit_code === u.code);
      const typeCount = new Map<string, number>();
      let needPhotos = 0;
      for (const a of inUnit) {
        if ((photoCounts.get(a.id) || 0) === 0) needPhotos++;
        const name = types.find((t) => t.id === a.type_id)?.name ?? "Uncategorized";
        typeCount.set(name, (typeCount.get(name) ?? 0) + 1);
      }
      const topTypes = [...typeCount.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3);
      return {
        unit: u,
        count: inUnit.length,
        needPhotos,
        topTypes,
        links: (u.meta.links ?? []) as UnitResourceLink[],
      };
    });
  }, [book.units, assets, photoCounts, types]);

  // Unit codes that live on assets but aren't in the codebook (discovery
  // before the codebook caught up, imports, typos). They still get a landing
  // card — an asset must never be invisible from the front door.
  const unknownUnits = useMemo(() => {
    const known = new Set(book.units.map((u) => u.code));
    const m = new Map<string, number>();
    for (const a of assets) {
      if (a.unit_code && !known.has(a.unit_code)) m.set(a.unit_code, (m.get(a.unit_code) ?? 0) + 1);
    }
    return [...m.entries()].sort((x, y) => x[0].localeCompare(y[0], undefined, { numeric: true }));
  }, [assets, book.units]);

  // Pinning libraries to a unit writes the unit's codebook entry — same bar
  // as every other codebook write (RLS: Admin / DocCtrl).
  const canEditLinks = activeRole === "Admin" || activeRole === "DocCtrl";
  const currentUnit = unitFilter && unitFilter !== "__unassigned"
    ? book.units.find((u) => u.code === unitFilter) ?? null
    : null;
  const unitAssetIds = useMemo(
    () => (unitFilter ? filtered.map((a) => a.id) : []),
    [unitFilter, filtered],
  );
  // The area's FULL asset list, independent of search/type/photo filters —
  // the knowledge panel's counts describe the area, not the current view.
  const areaAssetIds = useMemo(
    () => (unitFilter && unitFilter !== "__unassigned"
      ? assets.filter((a) => a.unit_code === unitFilter).map((a) => a.id)
      : []),
    [unitFilter, assets],
  );

  const searchActive = search.trim().length > 0 || typeFilter !== "" || filterMode !== "all";

  if (!activeOrgId) return <PageShell><PageHero kicker="Operating areas" title="Operating areas" overlap={false} /><SkeletonRows rows={6} what="operating areas" className="mt-6" /></PageShell>;

  const printLabels = async (list: Asset[] = filtered) => {
    const some = list.slice(0, 200);
    if (some.length === 0) return;
    try {
      const { printEquipmentLabels } = await import("@/lib/physicalBridge");
      await printEquipmentLabels(some.map((a) => ({
        tag: a.tag,
        code: a.code ?? null,
        description: a.description ?? null,
        location: a.location ?? null,
      })));
    } catch (e) {
      await appAlert({ title: "Couldn't print labels", message: friendlyError(e), tone: "danger" });
    }
  };
  // Less-used tools fold into More: QR label sheets and the CSV import.
  const moreItems: MoreItem[] = [
    ...(filtered.length > 0 ? [{ icon: <QrCode className="w-4 h-4" />, label: `QR labels (${Math.min(filtered.length, 200)})`, onClick: () => void printLabels() }] : []),
    ...(canEditEquipment ? [{ icon: <Upload className="w-4 h-4" />, label: "Import CSV", onClick: () => setCsvOpen(true) }] : []),
    ...(canEditEquipment && !unitFilter && assets.length > 0 ? [{ icon: <FolderTree className="w-4 h-4" />, label: efTree?.assets ? "Equipment files library" : "Push to a library (Equipment Files)", onClick: () => setEfOpen(true) }] : []),
    ...(canEditEquipment && activeOrgId && !unitFilter && assets.length > 0 ? [{ icon: <RotateCcw className="w-4 h-4" />, label: "Start over from the drawings", tone: "bad" as const, line: true, onClick: () => setStartOverOpen(true) }] : []),
  ];

  // The answer: how much equipment, and the one gap that matters (photos).
  const scope = unitFilter
    ? assets.filter((a) => unitFilter === "__unassigned" ? !a.unit_code : a.unit_code === unitFilter)
    : assets;
  const scopeNoPhotos = scope.reduce((n, a) => n + ((photoCounts.get(a.id) || 0) === 0 ? 1 : 0), 0);
  const scopeUncat = scope.reduce((n, a) => n + (a.type_id ? 0 : 1), 0);
  const unitName = currentUnit?.label || (unitFilter === "__unassigned" ? "No operating area" : `Unit ${unitFilter}`);
  const answer = loading
    ? (unitFilter ? unitName : "Operating areas")
    : error
      ? "Couldn't load the equipment."
      : unitFilter === "__unassigned"
        ? (scope.length === 0 ? "Everything is filed." : `${plural(scope.length, "piece")} of equipment need an area.`)
        : scope.length === 0
          ? (unitFilter ? `No equipment in ${unitName} yet.` : "No equipment yet.")
          : unitFilter
            ? `${unitName} has ${plural(scope.length, "piece")} of equipment.`
            : `${plural(scope.length, "piece")} of equipment in ${plural(book.units.length + unknownUnits.length, "area")}.`;
  // One number leads only when it needs someone: equipment with no area.
  const facts: HeroFact[] | undefined = loading || error || scope.length === 0 ? undefined : [
    ...(!unitFilter && unitCounts.unassigned > 0 ? [{ label: "Not in an area", value: unitCounts.unassigned.toLocaleString(), tone: "warn" as const, hero: true }] : []),
    // Zeros that aren't news stay quiet: a fact shows only when it counts.
    ...(scopeNoPhotos > 0 ? [{ label: "Without photos", value: scopeNoPhotos.toLocaleString() }] : []),
    ...(scopeUncat > 0 ? [{ label: "No type yet", value: scopeUncat.toLocaleString() }] : []),
    ...(unitFilter && currentUnit && ((currentUnit.meta.links ?? []) as UnitResourceLink[]).length > 0 ? [{ label: "Libraries pinned", value: ((currentUnit.meta.links ?? []) as UnitResourceLink[]).length.toLocaleString() }] : []),
  ];
  const sub = loading || error ? undefined : unitFilter ? (
    <>
      {unitFilter === "__unassigned" ? "Equipment with no operating area." : !currentUnit ? `Unit ${unitFilter} is on equipment but not in the Site Codebook yet.` : null}
      {searchActive && <> {plural(filtered.length, "match", "matches")} the filters.</>}
    </>
  ) : (
    <>
      {book.units.length === 0 ? "No operating areas yet." : searchActive ? `${plural(filtered.length, "match", "matches")} the filters.` : null}
    </>
  );
  const primary = !isAdmin ? undefined : !unitFilter ? (
    // The root IS the site: the primary act here is defining an operating
    // area, not dropping a loose asset.
    <button type="button" onClick={() => setAddUnitOpen(true)} className={heroPrimary}>
      <Plus className="w-4 h-4" /> New operating area
    </button>
  ) : (
    // CATEGORY leads: it is the next level of the hierarchy. Assets are
    // added inside their category (its row menu, or New asset).
    <button type="button" onClick={() => setAddCategoryOpen(true)} className={heroPrimary}>
      <Plus className="w-4 h-4" /> New category
    </button>
  );

  // ── Rows of the tree ─────────────────────────────────────────
  const openAsset = (a: Asset) => transitionPush(router, assetHref(a));
  const openUnit = (code: string) => transitionPush(router, `/admin/assets?unit=${encodeURIComponent(code)}`);
  const typeNameOf = (a: Asset) => (a.type_id ? types.find((t) => t.id === a.type_id)?.name : null) ?? null;
  const assetMenu = (a: Asset): MoreItem[] => {
    const n = photoCounts.get(a.id) || 0;
    return [
      ...(n > 0 ? [{ icon: <ImageIcon className="w-4 h-4" />, label: `See photos (${n})`, onClick: () => setCarouselOpenFor(a) }] : []),
      ...(isAdmin ? [{ icon: <Camera className="w-4 h-4" />, label: "Add photos", onClick: () => setUploaderOpenFor(a) }] : []),
      canEditEquipment
        ? { icon: a.type_id ? <Edit3 className="w-4 h-4" /> : <Tag className="w-4 h-4" />, label: a.type_id ? "Edit" : "Pick its type", onClick: () => setSelectedAsset(a) }
        : { icon: <FileText className="w-4 h-4" />, label: "Details and notes", onClick: () => setSelectedAsset(a) },
    ];
  };
  // Cells after the name, in the columns of the grid in use.
  const COLS_LAND = ["max-sm:hidden text-right", "max-sm:hidden text-right", "max-lg:hidden min-w-0", ""];
  const GRID_LAND = "grid-cols-[minmax(0,1fr)_32px] sm:grid-cols-[minmax(0,1fr)_88px_112px_32px] lg:grid-cols-[minmax(0,1fr)_88px_112px_minmax(0,260px)_32px]";
  const COLS_HUB = ["max-lg:hidden min-w-0 truncate text-body text-[var(--color-text-muted)]", "max-sm:hidden", "max-lg:hidden min-w-0", ""];
  const GRID_HUB = "grid-cols-[minmax(0,1fr)_32px] sm:grid-cols-[minmax(0,1fr)_112px_32px] lg:grid-cols-[minmax(0,1fr)_minmax(0,180px)_112px_minmax(0,240px)_32px]";
  const cells = (cols: string[], first: React.ReactNode, rest: React.ReactNode[]) => (
    <>
      <div className="min-w-0">{first}</div>
      {cols.map((c, i) => <div key={i} className={c}>{rest[i] ?? null}</div>)}
    </>
  );
  const muted = (n: number, word?: string) => n > 0
    ? <span className="text-body tabular-nums text-[var(--color-text)]">{n.toLocaleString()}{word ? ` ${word}` : ""}</span>
    : <span className="text-body tabular-nums text-[var(--color-text-faint)]">0</span>;
  const changeLine = (list: Asset[]) => {
    const c = lastChange(list);
    if (!c) return null;
    return (
      <span className="block truncate text-body text-[var(--color-text-muted)]" title={`Last change: ${c.text}`}>
        <span className="font-display font-semibold tabular-nums text-[var(--color-text)]">{c.a.tag}</span> {c.text}
      </span>
    );
  };
  const photosText = (a: Asset) => {
    const n = photoCounts.get(a.id) || 0;
    return n > 0
      ? <span className="text-body text-[var(--color-text)] tabular-nums">{plural(n, "photo")}</span>
      : <span className="text-body text-[var(--color-text-faint)]">No photos</span>;
  };
  // One equipment row: the tag (click to copy) and what it is; the row
  // opens its page; everything else is in its menu.
  const assetRow = (a: Asset, level: number, ancestors: string[], cols: string[], opts: { showType?: boolean; landing?: boolean } = {}): TreeRow => {
    const cover = coverUrls.get(a.id);
    const what = [opts.showType ? typeNameOf(a) ?? "No type" : null, a.description].filter(Boolean).join(" · ");
    const name = (
      <div className="flex items-center gap-3 min-w-0">
        {cover && (
          <button type="button" onClick={(e) => { e.stopPropagation(); setCarouselOpenFor(a); }} aria-label={`Photos of ${a.tag}`}
            className="shrink-0 w-10 h-8 pointer-coarse:w-14 pointer-coarse:h-11 rounded-md overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface-2)] relative">
            <SignedImg path={cover} alt="" className="absolute inset-0 w-full h-full object-cover" />
          </button>
        )}
        <div className="min-w-0">
          <CopyId value={a.tag} label="tag" className="text-reading" />
          {what && <div className="text-body text-[var(--color-text-muted)] truncate">{what}</div>}
          <div className="sm:hidden text-body text-[var(--color-text-muted)] truncate">{(photoCounts.get(a.id) || 0) > 0 ? plural(photoCounts.get(a.id) || 0, "photo") : "No photos"}{a.location ? ` · ${a.location}` : ""}</div>
        </div>
      </div>
    );
    const menu = <RowMenu items={assetMenu(a)} label={`More for ${a.tag}`} />;
    return {
      key: `a:${a.id}`, level, ancestors, label: `${a.tag}${a.description ? `, ${a.description}` : ""}`,
      onActivate: () => openAsset(a),
      cells: opts.landing
        ? cells(cols, name, [null, photosText(a), <span key="c" className="block truncate text-body text-[var(--color-text-muted)]">{assetChange(a)}</span>, menu])
        : cells(cols, name, [a.location ?? "", photosText(a), <span key="c" className="block truncate text-body text-[var(--color-text-muted)]">{assetChange(a)}</span>, menu]),
    };
  };
  // A long branch shows the first rows, then one row that shows more.
  const branchRows = (parentKey: string, list: Asset[], level: number, ancestors: string[], cols: string[], opts: { showType?: boolean; landing?: boolean } = {}): TreeRow[] => {
    const max = limits.get(parentKey) ?? 60;
    const out = list.slice(0, max).map((a) => assetRow(a, level, ancestors, cols, opts));
    if (list.length > max) {
      const more = Math.min(list.length - max, 120);
      out.push({
        key: `${parentKey}/more`, level, ancestors, label: `Show ${more} more`,
        onActivate: () => setLimits((m) => new Map(m).set(parentKey, max + more)),
        cells: cells(cols, <span className="text-body font-medium text-[var(--color-accent-text)]">Show {more.toLocaleString()} more <span className="font-normal text-[var(--color-text-muted)]">of {list.length.toLocaleString()}</span></span>, []),
      });
    }
    return out;
  };
  const byType = (list: Asset[]) => {
    const m = new Map<string, Asset[]>();
    for (const a of list) m.set(a.type_id ?? "__none", [...(m.get(a.type_id ?? "__none") ?? []), a]);
    return [...m.entries()]
      .map(([typeId, l]) => ({ typeId, name: typeId === "__none" ? "No type yet" : (types.find((t) => t.id === typeId)?.name ?? "No type yet"), list: l.sort((x, y) => x.tag.localeCompare(y.tag, undefined, { numeric: true })) }))
      .sort((x, y) => (x.typeId === "__none" ? 1 : 0) - (y.typeId === "__none" ? 1 : 0) || x.name.localeCompare(y.name));
  };
  const pendingOf = (key: string, open: boolean, n: number, deferredIsOpen: boolean) => (open && !deferredIsOpen ? Math.min(n, 3) : 0);

  // Landing: units > equipment types > equipment.
  const unitBranch = (key: string, code: string | null, list: Asset[], head: { name: React.ReactNode; aria: string; edge?: "warn"; activate: () => void; menu?: MoreItem[]; libs?: number }): TreeRow[] => {
    const open = openKeys.has(key);
    const noPhotos = list.reduce((n, a) => n + ((photoCounts.get(a.id) || 0) === 0 ? 1 : 0), 0);
    const rows: TreeRow[] = [{
      key, level: 0, ancestors: [], expandable: list.length > 0, open, edge: head.edge,
      pending: pendingOf(key, open, list.length, deferredOpen.has(key)),
      label: `${head.aria}, ${plural(list.length, "piece")} of equipment, ${noPhotos} without photos`,
      onActivate: head.activate,
      cells: cells(COLS_LAND, (
        <div className="min-w-0">
          {head.name}
          <div className="sm:hidden text-body text-[var(--color-text-muted)] truncate">{plural(list.length, "piece")}{noPhotos > 0 ? `, ${noPhotos.toLocaleString()} without photos` : ""}</div>
        </div>
      ), [muted(list.length), muted(noPhotos), changeLine(list), head.menu && head.menu.length > 0 ? <RowMenu items={head.menu} label="More for this area" /> : null]),
    }];
    if (!open || !deferredOpen.has(key)) return rows;
    for (const g of byType(list)) {
      const tkey = `${key}/t:${g.typeId}`;
      const topen = openKeys.has(tkey);
      const gNoPhotos = g.list.reduce((n, a) => n + ((photoCounts.get(a.id) || 0) === 0 ? 1 : 0), 0);
      rows.push({
        key: tkey, level: 1, ancestors: [key], expandable: true, open: topen,
        pending: pendingOf(tkey, topen, g.list.length, deferredOpen.has(tkey)),
        label: `${g.name}, ${g.list.length}`,
        cells: cells(COLS_LAND, <span className="text-body text-[var(--color-text)]">{g.name}</span>, [muted(g.list.length), muted(gNoPhotos), changeLine(g.list), null]),
      });
      if (topen && deferredOpen.has(tkey)) rows.push(...branchRows(tkey, g.list, 2, [key, tkey], COLS_LAND, { landing: true }));
    }
    return rows;
  };
  const landingRows: TreeRow[] = [];
  if (!unitFilter && !searchActive && book.units.length > 0) {
    for (const s of unitSummaries) {
      const inUnit = assets.filter((a) => a.unit_code === s.unit.code);
      landingRows.push(...unitBranch(`u:${s.unit.code}`, s.unit.code, inUnit, {
        name: <><span className="font-medium text-reading text-[var(--color-text)]">{s.unit.label}</span> <span className="ml-1.5 text-body text-[var(--color-text-muted)] tabular-nums">Unit {s.unit.code}</span>{s.links.length > 0 && <span className="max-sm:hidden ml-2 text-body text-[var(--color-text-muted)]">· {plural(s.links.length, "library", "libraries")} pinned</span>}</>,
        aria: `${s.unit.label}, unit ${s.unit.code}`,
        activate: () => openUnit(s.unit.code),
        menu: [
          { icon: <ExternalLink className="w-4 h-4" />, label: `Open ${s.unit.label}`, onClick: () => openUnit(s.unit.code) },
          ...(inUnit.length > 0 ? [{ icon: <QrCode className="w-4 h-4" />, label: `QR labels (${Math.min(inUnit.length, 200)})`, onClick: () => void printLabels(inUnit) }] : []),
          ...(canEditLinks ? [{ icon: <Edit3 className="w-4 h-4" />, label: "Rename in the Site Codebook", onClick: () => router.push("/admin/codebook") }] : []),
        ],
      }));
    }
    for (const [code] of unknownUnits) {
      const inUnit = assets.filter((a) => a.unit_code === code);
      landingRows.push(...unitBranch(`u:${code}`, code, inUnit, {
        name: <><span className="font-medium text-reading text-[var(--color-text)]">Unit {code}</span> <span className="ml-1.5 text-body text-[var(--color-text-muted)]">Not in the Site Codebook yet</span></>,
        aria: `Unit ${code}, not in the Site Codebook yet`, edge: "warn",
        activate: () => openUnit(code),
        menu: canEditLinks ? [{ icon: <BookMarked className="w-4 h-4" />, label: "Add it to the Site Codebook", onClick: () => router.push("/admin/codebook") }] : undefined,
      }));
    }
    if (unitCounts.unassigned > 0) {
      landingRows.push(...unitBranch("u:__unassigned", null, assets.filter((a) => !a.unit_code), {
        name: <><span className="font-medium text-reading text-[var(--color-text)]">No operating area</span> <span className="ml-1.5 text-body text-[var(--color-text-muted)]">Waiting to be filed</span></>,
        aria: "No operating area, waiting to be filed", edge: "warn",
        activate: () => openUnit("__unassigned"),
      }));
    }
  }
  // Inside a unit: equipment types > equipment.
  const hubRows: TreeRow[] = [];
  if (unitFilter && groupedByType) {
    for (const g of groupedByType) {
      const tkey = `t:${g.typeId}`;
      const open = !closedTypes.has(tkey);
      const cb = g.typeId === "__none" ? undefined : cbTypeByLabel.get(g.name.trim().toLowerCase());
      const gNoPhotos = g.list.reduce((n, a) => n + ((photoCounts.get(a.id) || 0) === 0 ? 1 : 0), 0);
      const addHere = canEditEquipment ? () => openCreate({
        typeId: g.typeId === "__none" ? undefined : g.typeId,
        unitCode: unitFilter === "__unassigned" ? undefined : unitFilter,
      }) : undefined;
      hubRows.push({
        key: tkey, level: 0, ancestors: [], expandable: g.list.length > 0, open,
        pending: pendingOf(tkey, open, g.list.length, !deferredClosed.has(tkey)),
        label: `${g.typeId === "__none" ? "No type yet" : g.name}, ${g.list.length}`,
        onActivate: g.list.length === 0 ? addHere : undefined,
        cells: cells(COLS_HUB, (
          <div className="min-w-0">
            <span className="font-medium text-reading text-[var(--color-text)]">{g.typeId === "__none" ? "No type yet" : g.name}</span>
            <span className="ml-2 text-body text-[var(--color-text-muted)] tabular-nums">{g.list.length.toLocaleString()}</span>
            {cb && <span className="max-sm:hidden ml-2 text-body text-[var(--color-text-muted)]" title={`Site Codebook equipment-type code ${cb.code}`}>· code <span className="ui-id">{cb.code}</span>{cb.prefixes.length > 0 ? `, tags ${cb.prefixes.join(", ")}` : ""}</span>}
            {g.typeId === "__none" && g.list.length > 0 && <div className="text-body text-[var(--color-text-muted)]">Pick a type in each row&apos;s menu, or sort them from the codebook below.</div>}
            {g.list.length === 0 && <div className="text-body text-[var(--color-text-muted)]">None in this area yet.{addHere ? " Add the first." : ""}</div>}
          </div>
        ), [null, g.list.length > 0 ? <span key="p" className="text-body text-[var(--color-text-muted)] tabular-nums">{gNoPhotos > 0 ? `${gNoPhotos.toLocaleString()} without` : "All have photos"}</span> : null, changeLine(g.list), addHere ? <RowMenu items={[{ icon: <Plus className="w-4 h-4" />, label: `Add equipment to ${g.typeId === "__none" ? "this area" : g.name}`, onClick: addHere }]} label={`More for ${g.name}`} /> : null]),
      });
      if (open && !deferredClosed.has(tkey) && g.list.length > 0) hubRows.push(...branchRows(tkey, g.list, 1, [tkey], COLS_HUB));
    }
  }
  const searchRows: TreeRow[] = !unitFilter && (searchActive || book.units.length === 0)
    ? branchRows("search", filtered, 0, [], COLS_HUB, { showType: true })
    : [];

  return (
    <PageShell>
      <PageHero
        kicker={unitFilter ? <>Operating areas · {unitFilter === "__unassigned" ? "No unit" : `Unit ${unitFilter}`}</> : "Operating areas"}
        back={unitFilter ? { onClick: () => transitionPush(router, "/admin/assets"), label: "All operating areas" } : undefined}
        title={answer}
        sub={sub}
        facts={facts}
        factsHero={facts?.some((f) => f.hero) ? "auto" : "none"}
        tools={isAdmin ? (
          <>
            {unitFilter && canEditEquipment && (
              <button type="button" className={heroQuiet}
                onClick={() => openCreate({ unitCode: unitFilter === "__unassigned" ? undefined : unitFilter })}>
                <Plus className="w-4 h-4" /> <span className="max-sm:hidden">New asset</span><span className="sm:hidden">Asset</span>
              </button>
            )}
            {/* Bulk QR labels for whatever the filters currently show, and
                the CSV import: laminate a label onto the equipment and every
                scan lands on that asset's page. */}
            {moreItems.length > 0 && <MoreMenu items={moreItems} triggerClass={heroQuiet} />}
          </>
        ) : undefined}
        primary={primary}
      >
        <div className="[&>div]:mb-0">
          <ViewTabs tabs={EQUIPMENT_VIEWS} variant="dark" />
        </div>
        {/* Search + filters steer the whole page, so they live in the header. */}
        <div className="mt-4 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[220px]">
            <Search className={bandInputIcon} />
            <label htmlFor="equipment-search" className="sr-only">Search all equipment</label>
            <input
              id="equipment-search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Find by tag (E-22), site code or description"
              enterKeyHint="search"
              autoComplete="off"
              className={bandInput}
            />
          </div>
          <label htmlFor="equipment-type" className="sr-only">Equipment type</label>
          <select id="equipment-type" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className={bandSelect}>
            <option value="">All types</option>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <div className={bandSeg} role="group" aria-label="Photos">
            {(["all", "with_photos", "no_photos"] as const).map((m) => (
              <button key={m} type="button" onClick={() => setFilterMode(m)} aria-pressed={filterMode === m} className={bandSegItem(filterMode === m)}>
                {m === "all" ? "All" : m === "with_photos" ? "With photos" : "No photos"}
              </button>
            ))}
          </div>
        </div>
      </PageHero>

      <PageBody>
        {/* Document control laid out like these areas: offered until it's made, then where it is and what's new. */}
        {!unitFilter && !loading && !error && assets.length > 0 && efTree !== undefined && (canEditEquipment || efTree?.assets) && (() => {
          const open = efTree?.assets ? `/documents/${efTree.libraryId}${efTree.collectionId ? `?folderId=${efTree.collectionId}` : ""}` : "";
          return (
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              <FolderTree aria-hidden className="w-5 h-5 text-[var(--color-text-muted)] shrink-0" />
              {efTree?.assets ? (
                <>
                  <div className="min-w-0 flex-1 basis-64 grid gap-0.5">
                    <p className="text-body text-[var(--color-text)]"><b>Equipment files</b> live in <a href={open} className="font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2">{efTree.libraryName ?? "the library"}</a>: a folder for each unit, type and piece of equipment, kept in step with this registry and the site codebook.</p>
                    {efSync.busy ? <p role="status" className="text-body text-[var(--color-text-muted)]">Bringing it up to date: {efSync.busy.toLowerCase()}…</p>
                      : efSync.error ? <p role="alert" className="text-body text-[var(--state-overdue-text)]">Couldn&apos;t bring it up to date: {efSync.error}</p>
                      : efSync.words ? <p role="status" className="text-body text-[var(--color-text-muted)]">Just brought up to date: {efSync.words}.</p> : null}
                  </div>
                  {efSync.error && <Button variant="secondary" onClick={() => void efSync.run()}>Try again</Button>}
                </>
              ) : (
                <>
                  <p className="min-w-0 flex-1 basis-64 text-body text-[var(--color-text)]"><b>Push these areas to a library?</b> Equipment Files: a folder for each unit, equipment type and piece of equipment, linked so each piece shows its documents and work packages file into its folder.</p>
                  <Button variant="secondary" onClick={() => setEfOpen(true)}>Set it up</Button>
                </>
              )}
            </div>
          );
        })()}
        {loading ? (
          <SkeletonRows rows={6} cols={3} what="the equipment" />
        ) : error ? (
          <ErrorNote error={error} title="Couldn't load the equipment." onRetry={() => void refresh()} />
        ) : unitFilter ? (
          // The unit hub: its equipment by type first (what people come
          // for), then its libraries, knowledge, documents and flows.
          <>
            {filtered.length === 0 ? (
              unitFilter === "__unassigned" ? (
                <div className={`${sheet} px-5 py-6`}>
                  <StatusTag tone="good">No equipment is missing an operating area.</StatusTag>
                  <div><button type="button" onClick={() => transitionPush(router, "/admin/assets")} className={`mt-3 ${btnQuiet}`}>
                    <ArrowLeft className="w-4 h-4" /> Back to all areas
                  </button></div>
                </div>
              ) : (
                <EmptyState onCreate={canEditEquipment ? () => openCreate({ unitCode: unitFilter }) : undefined} hasAny={assets.length > 0} onClear={searchActive ? () => { setSearch(""); setTypeFilter(""); setFilterMode("all"); } : undefined} />
              )
            ) : (
              <Section label="Equipment" count={filtered.length}
                action={hubRows.length > 1 ? (
                  <span className="flex items-center gap-3">
                    <button type="button" className={btnLink} onClick={() => setClosedTypes(new Set())}>Open all</button>
                    <button type="button" className={btnLink} onClick={() => setClosedTypes(new Set(hubRows.filter((r) => r.level === 0).map((r) => r.key)))}>Close all</button>
                  </span>
                ) : undefined}>
                <TreeList rows={hubRows} grid={GRID_HUB} ariaLabel={`Equipment in ${unitName}`}
                  onToggle={(key, open) => setClosedTypes((prev) => { const next = new Set(prev); if (open) next.delete(key); else next.add(key); return next; })}
                  head={cells(COLS_HUB, "Type and equipment", ["Location", "Photos", "Last change", null])} />
              </Section>
            )}
            {unitFilter === "__unassigned" && canEditEquipment && book.units.length > 0 && filtered.length > 0 && (
              <UnassignedAssignPanel
                assets={filtered}
                book={book}
                userId={uid || ""}
                onAssigned={() => { invalidateAssetCache(); void refresh(); }}
              />
            )}
            {(currentUnit || (unitFilter !== "__unassigned" && canEditLinks)) && (
              <Section label="This unit's libraries"
                action={canEditLinks && unitFilter !== "__unassigned" ? (
                  <Link href="/admin/codebook" className={btnLink}>
                    {currentUnit ? "Edit unit" : "Add this unit to the codebook"}
                  </Link>
                ) : undefined}>
                {currentUnit ? (
                  <UnitResources
                    orgId={activeOrgId}
                    unitCode={currentUnit.code}
                    links={(currentUnit.meta.links ?? []) as UnitResourceLink[]}
                    canEdit={canEditLinks}
                    onChanged={() => { void loadCodebook(activeOrgId).then(setBook); }}
                  />
                ) : (
                  <p className="text-body text-[var(--color-text-muted)]">Unit {unitFilter} is on equipment but not in the Site Codebook yet. Add it there to pin its libraries.</p>
                )}
              </Section>
            )}
            {/* This area's knowledge: setup path, live state, and drift review,
                so the order of operations lives ON the unit page. */}
            {currentUnit && uid && activeOrgId && (
              <AreaKnowledgePanel
                orgId={activeOrgId}
                userId={uid}
                userName={userEmail ?? "Member"}
                unit={{ code: currentUnit.code, label: currentUnit.label || `Unit ${currentUnit.code}` }}
                unitAssetIds={areaAssetIds}
              />
            )}
            {unitAssetIds.length > 0 && <UnitDocuments assetIds={unitAssetIds} assets={filtered} />}
            {unitFilter && unitFilter !== "__unassigned" && uid && (
              <FlowPanel orgId={activeOrgId!} userId={uid} userName={userEmail ?? undefined}
                isAdmin={isAdmin} unitCode={unitFilter} unitAssets={filtered} />
            )}
          </>
        ) : landingRows.length > 0 ? (
          // The landing page IS the site: one row per operating area, each
          // opening into its equipment types and equipment.
          <TreeList rows={landingRows} grid={GRID_LAND} ariaLabel="Operating areas and their equipment"
            onToggle={(key, open) => setOpenKeys((prev) => {
              const next = new Set(prev);
              if (open) next.add(key);
              else for (const k of [...next]) if (k === key || k.startsWith(`${key}/`)) next.delete(k);
              return next;
            })}
            head={cells(COLS_LAND, "Operating area", ["Equipment", "Without photos", "Last change", null])} />
        ) : filtered.length === 0 ? (
          <EmptyState onCreate={canEditEquipment ? () => openCreate() : undefined} hasAny={assets.length > 0} onClear={searchActive ? () => { setSearch(""); setTypeFilter(""); setFilterMode("all"); } : undefined} />
        ) : (
          // Search results (across every unit) or a no-codebook org's flat registry.
          <Section label={searchActive ? "Matches" : "All equipment"} count={filtered.length}>
            <TreeList rows={searchRows} grid={GRID_HUB} ariaLabel={searchActive ? "Equipment that matches" : "All equipment"}
              onToggle={() => undefined}
              head={cells(COLS_HUB, "Equipment", ["Location", "Photos", "Last change", null])} />
          </Section>
        )}

        {/* The Site Codebook already knows the taxonomy: put it to work. */}
        {canEditEquipment && !loading && uid && activeOrgId && (
          <CategorizeBanner orgId={activeOrgId} userId={uid} assets={assets} types={types} book={book}
            onDone={() => { invalidateAssetCache(); void refresh(); }} />
        )}

        {/* No codebook units yet: show admins the path instead of a silently
            flat registry. The unit-first view lights up the moment units exist. */}
        {book.units.length === 0 && isAdmin && !loading && assets.length > 0 && (
          <Section label="Group by unit">
            <p className="text-reading text-[var(--color-text-muted)]">
              Name your units in the Site Codebook (20 = Crude, 25 = DHT) and this list groups itself by unit, then equipment type.{" "}
              <Link href="/admin/codebook" className={link}>Set up the codebook</Link>
            </p>
          </Section>
        )}

        {/* Start over: an admin clears what the drawing reader added (what
            people added stays), then reads the drawings again. Rare, so it's
            a quiet line at the foot of the page (and in More), never a
            loud button; the dialog previews and confirms. */}
        {canEditEquipment && !unitFilter && !loading && assets.length > 0 && (
          <div className="pt-6 border-t border-[var(--color-border)] flex items-center gap-x-4 gap-y-2 flex-wrap">
            <p className="text-body text-[var(--color-text-muted)] max-w-[62ch] flex-1 min-w-[16rem]">
              <span className="font-medium text-[var(--color-text)]">Start over from the drawings.</span> Clears what the drawing reader added and reads the drawings again. What people added stays.
            </p>
            <button type="button" className={btnDanger} onClick={() => setStartOverOpen(true)}>
              <RotateCcw className="w-4 h-4" /> Start over
            </button>
          </div>
        )}

        {!canEditEquipment && (
          <p className="px-1 text-body text-[var(--color-text-muted)] flex items-start gap-2">
            <Lock className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>Only admins add or change equipment. You can browse it{isAdmin ? ", print labels and add photos" : " and view photos"}. Ask an admin to add what&apos;s missing.</span>
          </p>
        )}
      </PageBody>

      {/* Modals */}
      {addUnitOpen && isAdmin && (
        <AddUnitModal
          orgId={activeOrgId}
          userId={uid || ""}
          existingCodes={book.units.map((u) => u.code)}
          onClose={() => setAddUnitOpen(false)}
          onCreated={(code) => {
            setAddUnitOpen(false);
            void loadCodebook(activeOrgId).then(setBook);
            setUnitFilter(code);
          }}
        />
      )}
      {addCategoryOpen && isAdmin && (
        <AddCategoryModal
          orgId={activeOrgId}
          userId={uid || ""}
          existingTypeCodes={book.equipmentTypes.map((t) => t.code)}
          onClose={() => setAddCategoryOpen(false)}
          onCreated={() => {
            setAddCategoryOpen(false);
            void loadCodebook(activeOrgId).then(setBook);
            invalidateAssetCache();
            void refresh();
          }}
        />
      )}
      {(creating || selectedAsset) && (
        <AssetEditDrawer
          asset={creating ? null : selectedAsset}
          preset={creating ? createPreset ?? undefined : undefined}
          orgId={activeOrgId}
          userId={uid || ""}
          userEmail={userEmail ?? undefined}
          types={types}
          canEdit={canEditEquipment}
          book={book}
          onClose={() => { setSelectedAsset(null); setCreating(false); }}
          onSaved={() => { void refresh(); }}
          onOpenCarousel={(a) => { setSelectedAsset(null); setCarouselOpenFor(a); }}
          onOpenUploader={(a) => { setSelectedAsset(null); setUploaderOpenFor(a); }}
        />
      )}

      {carouselOpenFor && (
        <AssetPhotoCarousel
          isOpen={!!carouselOpenFor}
          asset={carouselOpenFor}
          assetType={types.find((t) => t.id === carouselOpenFor.type_id)}
          canManage={isAdmin}
          onClose={() => setCarouselOpenFor(null)}
          onUploadClick={() => { const a = carouselOpenFor; setCarouselOpenFor(null); setUploaderOpenFor(a); }}
          onEditAsset={() => { const a = carouselOpenFor; setCarouselOpenFor(null); setSelectedAsset(a); }}
        />
      )}

      {uploaderOpenFor && uid && (
        <AssetPhotoUploader
          isOpen={!!uploaderOpenFor}
          asset={uploaderOpenFor}
          userId={uid}
          onClose={() => setUploaderOpenFor(null)}
          onUploaded={() => { void refresh(); }}
        />
      )}

      {efOpen && canEditEquipment && activeOrgId && uid && (
        <EquipmentFilesDialog orgId={activeOrgId} uid={uid} email={userEmail ?? undefined} onClose={() => setEfOpen(false)}
          onDone={(t) => { setEfTree(t); void refresh(); }} />
      )}

      {startOverOpen && canEditEquipment && (
        <EquipmentStartOver orgId={activeOrgId} onClose={() => setStartOverOpen(false)}
          onChanged={() => { invalidateAssetCache(); void refresh(); }} />
      )}

      {csvOpen && uid && (
        <AssetCsvImportModal
          isOpen={csvOpen}
          onClose={() => setCsvOpen(false)}
          orgId={activeOrgId}
          actorUserId={uid}
          onImported={() => { invalidateAssetCache(); void refresh(); }}
        />
      )}
    </PageShell>
  );
}

// ─── What changed last ─────────────────────────────────────

/** When a row last changed: changed after it was added, read from a
 *  drawing, or added by hand. */
function changedAt(a: Asset): { at: string; text: string } {
  const created = a.created_at;
  const changed = a.updated_at && new Date(a.updated_at).getTime() - new Date(created).getTime() > 60_000 ? a.updated_at : null;
  if (changed) return { at: changed, text: `changed ${shortDate(changed)}` };
  return { at: created, text: `${a.origin === "drawing" ? "read from a drawing" : "added"} ${shortDate(created)}` };
}
function assetChange(a: Asset): string {
  const c = changedAt(a);
  return `${c.text.charAt(0).toUpperCase()}${c.text.slice(1)}`;
}
/** The newest change in a list: "C-02 read from a drawing Oct 14". */
function lastChange(list: Asset[]): { a: Asset; text: string } | null {
  let best: { a: Asset; at: string; text: string } | null = null;
  for (const a of list) {
    const c = changedAt(a);
    if (!best || c.at > best.at) best = { a, ...c };
  }
  return best;
}

/** A row's "..." menu. Clicks inside it never open the row. */
function RowMenu({ items, label }: { items: MoreItem[]; label: string }) {
  return (
    <span className="flex justify-end" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <MoreMenu items={items} label={label} iconOnly triggerClass={btnIcon} />
    </span>
  );
}

// ─── Unit resources — libraries/folders pinned to the unit ─────

function UnitResources({ orgId, unitCode, links, canEdit, onChanged }: {
  orgId: string; unitCode: string; links: UnitResourceLink[];
  canEdit: boolean; onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const removeLink = async (id: string) => {
    if (!(await appConfirm({ title: "Unpin this library?", message: "It comes off this unit's page. The library itself is untouched.", confirmLabel: "Unpin library", tone: "danger" }))) return;
    setBusy(true);
    try {
      await saveUnitLinks(orgId, unitCode, links.filter((l) => l.id !== id));
      onChanged();
    } catch (e) { await appAlert({ title: "Couldn't unpin it", message: friendlyError(e), tone: "danger" }); }
    finally { setBusy(false); }
  };

  if (links.length === 0) {
    return (
      <div className={`${sheet} px-4 sm:px-5 py-4 flex items-center gap-x-4 gap-y-3 flex-wrap`}>
        <p className="flex-1 min-w-[14rem] text-body text-[var(--color-text-muted)]">
          {canEdit ? "Pin the libraries this unit works from: P&IDs, operating manuals, unit data." : "No libraries pinned to this unit yet."}
        </p>
        {canEdit && (
          <button type="button" onClick={() => setAdding(true)} className={btnQuiet}>
            <Link2 className="w-4 h-4" /> Pin a library
          </button>
        )}
        {adding && <LinkResourceModal orgId={orgId} onClose={() => setAdding(false)}
          onSave={async (l) => { await saveUnitLinks(orgId, unitCode, [...links, l]); setAdding(false); onChanged(); }} />}
      </div>
    );
  }
  return (
    <div className={`${sheet} overflow-hidden py-1.5`}>
      {/* A short list: space between the rows, no line under each. */}
      <ul>
        {links.map((l) => (
          <li key={l.id} className="flex items-center gap-3 pr-2 hover:bg-[var(--color-surface-2)] transition-colors">
            <Link href={`/documents/${l.libraryId}${l.folderId ? `?folderId=${l.folderId}` : ""}`}
              className="flex-1 min-w-0 flex items-center gap-3 px-4 sm:px-5 py-2.5">
              <FolderOpen aria-hidden className="w-4 h-4 shrink-0 text-[var(--color-text-faint)]" />
              <span className="min-w-0">
                <span className="block text-reading font-medium text-[var(--color-text)] truncate">{l.label}</span>
                <span className="block text-body text-[var(--color-text-muted)] truncate">{l.libraryName}{l.folderName ? ` / ${l.folderName}` : ""}</span>
              </span>
            </Link>
            {canEdit && (
              <button type="button" onClick={() => void removeLink(l.id)} disabled={busy} title="Unpin" aria-label={`Unpin ${l.label}`} className={btnIcon}>
                <X className="w-4 h-4" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <div className="px-4 sm:px-5 pt-1 pb-1.5">
          <button type="button" onClick={() => setAdding(true)} className={btnLink}>
            <Link2 className="w-4 h-4" /> Pin another library
          </button>
        </div>
      )}
      {adding && (
        <LinkResourceModal
          orgId={orgId}
          onClose={() => setAdding(false)}
          onSave={async (link) => {
            await saveUnitLinks(orgId, unitCode, [...links, link]);
            setAdding(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function LinkResourceModal({ orgId, onClose, onSave }: {
  orgId: string; onClose: () => void;
  onSave: (link: UnitResourceLink) => Promise<void>;
}) {
  const [libs, setLibs] = useState<Array<{ id: string; name: string }> | null>(null);
  const [libraryId, setLibraryId] = useState("");
  const [folders, setFolders] = useState<PickerFolder[]>([]);
  const [folderId, setFolderId] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pin = useActionFeedback();

  useEffect(() => {
    void supabase.from("libraries").select("id, name").eq("org_id", orgId).order("name")
      .then(({ data, error: e }) => {
        if (e) { setError(`Couldn't load the libraries. ${friendlyError(e)}`); setLibs([]); return; }
        setLibs((data ?? []) as Array<{ id: string; name: string }>);
      });
  }, [orgId]);

  useEffect(() => {
    if (!libraryId) return;
    let alive = true;
    listLibraryFoldersOnce(libraryId)
      .then((f) => { if (alive) setFolders(f); })
      .catch((e) => { if (alive) { setFolders([]); setError(`Couldn't load that library's folders. ${friendlyError(e)}`); } });
    return () => { alive = false; };
  }, [libraryId]);

  const lib = (libs ?? []).find((l) => l.id === libraryId);
  const folder = folders.find((f) => f.id === folderId);
  const effectiveLabel = label.trim() || folder?.name || lib?.name || "";

  const save = async () => {
    if (!lib) { setError("Pick a library first."); return; }
    setError(null);
    try {
      await pin.run(() => onSave({
        id: crypto.randomUUID(),
        label: effectiveLabel,
        libraryId: lib.id,
        libraryName: lib.name,
        folderId: folder?.id ?? null,
        folderName: folder?.name ?? null,
      }));
    } catch (e) { setError(friendlyError(e)); }
  };

  return (
    <Modal onClose={onClose} size="sm" zIndex={500} dismissable={!pin.loading}>
      <ModalHeader title="Pin a library to this unit" subtitle="A whole library, or one folder of it, named for what it means here." onClose={pin.loading ? undefined : onClose} />
      <ModalBody className="space-y-4">
        <div>
          <label htmlFor="pin-lib" className={labelCls}>Library</label>
          <select id="pin-lib" value={libraryId} disabled={libs === null}
            onChange={(e) => { setLibraryId(e.target.value); setFolders([]); setFolderId(""); }}
            className={field}>
            <option value="">{libs === null ? "Loading libraries" : "Pick a library"}</option>
            {(libs ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        {folders.length > 0 && (
          <div>
            <label htmlFor="pin-folder" className={labelCls}>Folder <span className="font-normal text-[var(--color-text-muted)]">(optional)</span></label>
            <select id="pin-folder" value={folderId} onChange={(e) => setFolderId(e.target.value)} className={field}>
              <option value="">Whole library</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>{f.pathNames.join(" / ") || f.name}</option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label htmlFor="pin-label" className={labelCls}>Name on the unit page</label>
          <input id="pin-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={effectiveLabel || "e.g. P&IDs, Operating manuals, Unit data"} className={field} />
        </div>
        {error && <Problem>{error}</Problem>}
      </ModalBody>
      <ModalFooter>
        <button type="button" onClick={onClose} disabled={pin.loading} className={btnQuiet}>Cancel</button>
        <Button {...pin.state} doneLabel="Pinned" onClick={() => void save()} disabled={!libraryId}>
          <Link2 className="w-4 h-4" /> Pin it
        </Button>
      </ModalFooter>
    </Modal>
  );
}

// ─── Unit assignment for unassigned assets ─────────────────
//
// ALWAYS assignable: every unassigned asset gets a unit dropdown and an
// Assign button, right here — no drawer, no hover-hidden edit icon. When the
// asset's linked drawings decode to a unit through the Site Codebook, that
// unit arrives pre-selected with the evidence shown; when they don't (or
// the drawing-number format isn't configured yet), the human just picks.
// Suggestions are a convenience, never a requirement.

function UnassignedAssignPanel({ assets, book, userId, onAssigned }: {
  assets: Asset[]; book: Codebook; userId: string; onAssigned: () => void;
}) {
  const [choices, setChoices] = useState<Map<string, string>>(new Map());
  const [hints, setHints] = useState<Map<string, { unitCode: string; drawings: number }>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const all = useActionFeedback();
  const idsKey = useMemo(() => assets.map((a) => a.id).sort().join(","), [assets]);

  useEffect(() => {
    let alive = true;
    getDocumentsForAssetsHydrated(idsKey ? idsKey.split(",") : [])
      .then((links) => {
        if (!alive) return;
        // unit votes per asset, from the drawing numbers of its documents
        const votes = new Map<string, Map<string, number>>();
        for (const l of links) {
          const parsed = parseDrawingNumber(l.documentNumber ?? "", book);
          if (!parsed?.unitCode) continue;
          const m = votes.get(l.assetId) ?? new Map<string, number>();
          m.set(parsed.unitCode, (m.get(parsed.unitCode) ?? 0) + 1);
          votes.set(l.assetId, m);
        }
        const nextHints = new Map<string, { unitCode: string; drawings: number }>();
        for (const [assetId, m] of votes) {
          const [topCode, n] = [...m.entries()].sort((x, y) => y[1] - x[1])[0];
          if (book.units.some((u) => u.code === topCode)) {
            nextHints.set(assetId, { unitCode: topCode, drawings: n });
          }
        }
        setHints(nextHints);
        // Pre-select suggestions, but never stomp a unit the user already picked.
        setChoices((prev) => {
          const next = new Map(prev);
          for (const [assetId, h] of nextHints) {
            if (!next.has(assetId)) next.set(assetId, h.unitCode);
          }
          return next;
        });
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [idsKey, book]);

  const assign = async (rows: Array<{ asset: Asset; unitCode: string }>) => {
    for (const r of rows) {
      await updateAsset(r.asset.id, {
        unit_code: r.unitCode,
        code: r.asset.code ?? tagToCode(r.asset.tag, r.unitCode, book) ?? null,
      }, userId);
    }
    onAssigned();
  };
  const assignOne = async (a: Asset, unitCode: string) => {
    setBusy(a.id);
    try { await assign([{ asset: a, unitCode }]); }
    catch (e) { await appAlert({ title: `Couldn't file ${a.tag}`, message: friendlyError(e), tone: "danger" }); }
    finally { setBusy(null); }
  };

  const chosen = assets.filter((a) => choices.get(a.id));
  const shown = assets.slice(0, 50);

  return (
    <Section label={<>File each one under its operating area <HelpTooltip>Where its drawings say which unit, it&apos;s picked already. The site code fills in.</HelpTooltip></>}
      action={chosen.length > 1 ? (
        <Button variant="secondary" {...all.state} doneLabel="Filed" disabled={busy !== null}
          onClick={() => void all.run(() => assign(chosen.map((a) => ({ asset: a, unitCode: choices.get(a.id)! })))).catch(async (e) => { await appAlert({ title: "Couldn't file them all", message: friendlyError(e), tone: "danger" }); })}>
          File all {chosen.length} picked
        </Button>
      ) : undefined}>
      <div className={`${sheet} overflow-hidden`}>
        <ul className="divide-y divide-[var(--color-border)]">
          {shown.map((a) => {
            const hint = hints.get(a.id);
            const choice = choices.get(a.id) ?? "";
            return (
              <li key={a.id} className="flex items-center gap-x-3 gap-y-2 px-4 sm:px-5 py-2.5 flex-wrap">
                <CopyId value={a.tag} label="tag" className="w-24 shrink-0 text-reading" />
                <select
                  value={choice}
                  onChange={(e) => setChoices((prev) => new Map(prev).set(a.id, e.target.value))}
                  disabled={busy !== null || all.loading}
                  aria-label={`Unit for ${a.tag}`}
                  className={`${bandSelect} max-w-[16rem]`}
                >
                  <option value="">Pick a unit</option>
                  {book.units.map((u) => (
                    <option key={u.code} value={u.code}>{u.code} · {u.label}</option>
                  ))}
                </select>
                <span className="text-body text-[var(--color-text-muted)] flex-1 min-w-[120px]">
                  {hint
                    ? <>Its drawings say <span className="font-display font-semibold tabular-nums text-[var(--color-text)]">{hint.unitCode}</span> ({plural(hint.drawings, "linked drawing")})</>
                    : a.description || ""}
                </span>
                <Button variant="secondary" size="sm" loading={busy === a.id}
                  onClick={() => { if (choice) void assignOne(a, choice); }}
                  disabled={(busy !== null && busy !== a.id) || all.loading || !choice}>
                  File it
                </Button>
              </li>
            );
          })}
        </ul>
        {assets.length > shown.length && (
          <div className="px-4 sm:px-5 py-3 border-t border-[var(--color-border)] text-body text-[var(--color-text-muted)]">Showing the first {shown.length} of {assets.length}. File these and the next ones come up.</div>
        )}
      </div>
    </Section>
  );
}

// ─── Documents referencing the unit's equipment ────────────

function UnitDocuments({ assetIds, assets }: { assetIds: string[]; assets: Asset[] }) {
  const [rows, setRows] = useState<Array<{
    documentId: string; documentNumber: string | null; title: string | null;
    libraryId: string; tags: string[];
  }> | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const idsKey = useMemo(() => [...assetIds].sort().join(","), [assetIds]);

  useEffect(() => {
    let alive = true;
    setRows(null);
    setFailed(null);
    const tagById = new Map(assets.map((a) => [a.id, a.tag]));
    getDocumentsForAssetsHydrated(idsKey ? idsKey.split(",") : [])
      .then((links) => {
        if (!alive) return;
        // One row per document; collect which of the unit's tags it carries.
        const byDoc = new Map<string, { documentId: string; documentNumber: string | null; title: string | null; libraryId: string; tags: string[] }>();
        for (const l of links) {
          const cur = byDoc.get(l.documentId) ?? {
            documentId: l.documentId, documentNumber: l.documentNumber,
            title: l.title, libraryId: l.libraryId, tags: [],
          };
          const tag = tagById.get(l.assetId);
          if (tag && !cur.tags.includes(tag)) cur.tags.push(tag);
          byDoc.set(l.documentId, cur);
        }
        setRows([...byDoc.values()].sort((a, b) =>
          (a.documentNumber ?? a.title ?? "").localeCompare(b.documentNumber ?? b.title ?? "", undefined, { numeric: true })));
      })
      .catch((e) => { if (alive) { setRows([]); setFailed(e ?? true); } });
    return () => { alive = false; };
    // assets is derived from the same filter as assetIds — idsKey covers both.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, attempt]);

  if (rows === null) {
    return (
      <Section label="Documents about this equipment">
        <SkeletonRows rows={3} cols={1} what="the documents about this equipment" />
      </Section>
    );
  }
  if (failed) {
    return (
      <Section label="Documents about this equipment">
        <ErrorNote error={failed} title="Couldn't load the documents that name this equipment." onRetry={() => setAttempt((n) => n + 1)} />
      </Section>
    );
  }
  if (rows.length === 0) return null;
  const shown = expanded ? rows : rows.slice(0, 12);

  return (
    <Section label="Documents about this equipment" count={rows.length}>
      <div className={`${sheet} overflow-hidden`}>
        <ul className="divide-y divide-[var(--color-border)]">
          {shown.map((d) => (
            <li key={d.documentId}>
              <Link href={`/documents/${d.libraryId}?doc=${d.documentId}`}
                className="flex items-center gap-3 px-4 sm:px-5 py-3 hover:bg-[var(--color-surface-2)] transition-colors">
                <FileText aria-hidden className="w-4 h-4 text-[var(--color-text-faint)] shrink-0" />
                <div className="flex-1 min-w-0 text-body truncate">
                  <span className="ui-id">{d.documentNumber || "No number"}</span>
                  {d.title && <span className="text-[var(--color-text-muted)]"> · {d.title}</span>}
                </div>
                <div className="max-sm:hidden shrink-0 max-w-[45%] truncate text-body text-[var(--color-text-muted)] tabular-nums">
                  {d.tags.slice(0, 6).join(", ")}{d.tags.length > 6 ? ` and ${d.tags.length - 6} more` : ""}
                </div>
              </Link>
            </li>
          ))}
        </ul>
        {rows.length > 12 && (
          <div className="px-4 sm:px-5 py-3 border-t border-[var(--color-border)] flex items-center justify-between text-body">
            <span className="text-[var(--color-text-muted)] tabular-nums">{shown.length} of {rows.length} shown</span>
            <button type="button" onClick={() => setExpanded((v) => !v)} className={btnLink}>
              {expanded ? "Show fewer" : `Show ${rows.length - shown.length} more`}
            </button>
          </div>
        )}
      </div>
    </Section>
  );
}

// ─── Empty state ────────────────────────────────────────────

function EmptyState({ onCreate, hasAny, onClear }: { onCreate?: () => void; hasAny: boolean; onClear?: () => void }) {
  return (
    <div className={`${sheet} px-5 py-6 flex items-center gap-x-4 gap-y-3 flex-wrap`}>
      <p className="flex-1 min-w-[16rem] text-reading text-[var(--color-text-muted)]">
        {hasAny
          ? "Nothing matches. Try another tag or clear the filters."
          : "Start with one piece of equipment: a pump, instrument, valve, anything with a tag."}
      </p>
      {hasAny && onClear && <button type="button" onClick={onClear} className={btnQuiet}>Clear the filters</button>}
      {!hasAny && onCreate && (
        <button type="button" onClick={onCreate} className={btnQuiet}>
          <Plus className="w-4 h-4" /> Add the first piece of equipment
        </button>
      )}
    </div>
  );
}

// ─── Edit / Create drawer ──────────────────────────────────

function AssetEditDrawer({
  asset, preset, orgId, userId, userEmail, types, canEdit, book,
  onClose, onSaved, onOpenCarousel, onOpenUploader,
}: {
  asset: Asset | null;
  /** Creation context: the category and operating area you were standing in. */
  preset?: { typeId?: string; unitCode?: string };
  orgId: string;
  userId: string;
  userEmail?: string;
  types: AssetType[];
  canEdit: boolean;
  book: Codebook;
  onClose: () => void;
  onSaved: () => void;
  onOpenCarousel: (a: Asset) => void;
  onOpenUploader: (a: Asset) => void;
}) {
  const isCreate = !asset;
  const [tag, setTag] = useState(asset?.tag ?? "");
  const [typeId, setTypeId] = useState(asset?.type_id ?? preset?.typeId ?? "");
  const [description, setDescription] = useState(asset?.description ?? "");
  const [location, setLocation] = useState(asset?.location ?? "");
  const [unitCode, setUnitCode] = useState(asset?.unit_code ?? preset?.unitCode ?? "");
  const [siteCode, setSiteCode] = useState(asset?.code ?? "");
  // Auto-derive the site code (E-22 + unit 20 → 2030.22) whenever tag/unit
  // change and the user hasn't typed their own — the codebook does the math.
  useEffect(() => {
    if (asset?.code) return; // existing explicit code: never overwrite silently
    const derived = unitCode ? tagToCode(tag, unitCode, book) : null;
    setSiteCode(derived ?? "");
  }, [tag, unitCode, book, asset?.code]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasTagConflict, setHasTagConflict] = useState(false);
  const [saved, setSaved] = useState(false);
  const [photos, setPhotos] = useState<AssetPhoto[]>([]);
  const [photosFailed, setPhotosFailed] = useState(false);
  const [linkedDocs, setLinkedDocs] = useState<AssetDocumentRow[] | null>(null);
  const [docsFailed, setDocsFailed] = useState(false);
  const [docPickerOpen, setDocPickerOpen] = useState(false);
  // A new asset's description is kept on this device until it's created.
  const descDraft = useDraft<string>(isCreate ? `new-asset:${orgId}:${preset?.unitCode ?? ""}` : null, description, setDescription, (v) => !v.trim());

  const refreshDocs = useCallback(() => {
    if (!asset) return;
    setDocsFailed(false);
    getDocumentsForAssetHydrated(asset.id).then(setLinkedDocs).catch(() => { setLinkedDocs([]); setDocsFailed(true); });
  }, [asset]);

  useEffect(() => {
    if (!asset) return;
    listAssetPhotos(asset.id).then((p) => { setPhotos(p); setPhotosFailed(false); }).catch(() => setPhotosFailed(true));
    refreshDocs();
  }, [asset, refreshDocs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy && !docPickerOpen) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, docPickerOpen, onClose]);

  const linkDocument = async (documentId: string) => {
    if (!asset) return;
    const { error: e } = await supabase.from("document_assets").insert({
      org_id: orgId, document_id: documentId, asset_id: asset.id,
      tag_text: asset.tag, source: "manual",
    });
    if (e && e.code !== "23505") { setError(`Couldn't link the document. ${friendlyError(e)}`); return; }
    setDocPickerOpen(false);
    refreshDocs();
  };

  const unlinkDocument = async (documentId: string) => {
    if (!asset) return;
    const ok = await appConfirm({
      title: "Unlink this document?",
      message: "The document stays; only its link to this equipment is removed. A future sweep can re-link it if the document still carries the tag.",
      confirmLabel: "Unlink document",
    });
    if (!ok) return;
    const { error: e } = await supabase.from("document_assets").delete()
      .eq("document_id", documentId).eq("asset_id", asset.id);
    if (e) { setError(`Couldn't unlink the document. ${friendlyError(e)}`); return; }
    refreshDocs();
  };

  const save = async () => {
    if (!tag.trim()) { setError("Give it a tag, like FE-201."); return; }
    setBusy(true); setError(null);
    try {
      if (isCreate) {
        const created = await createAsset({
          orgId, tag: tag.trim(),
          typeId: typeId || undefined,
          description: description.trim() || undefined,
          location: location.trim() || undefined,
          unitCode: unitCode || undefined,
          code: siteCode.trim() || undefined,
          createdBy: userId,
        });
        invalidateAssetCache();
        descDraft.clear();
        onSaved();
        // Straight on to the next step: its photos.
        onOpenUploader(created);
      } else {
        await updateAsset(asset!.id, {
          tag: tag.trim(),
          type_id: typeId || null,
          description: description.trim() || null,
          location: location.trim() || null,
          unit_code: unitCode || null,
          code: siteCode.trim() || null,
        }, userId);
        invalidateAssetCache();
        onSaved();
        // "Saved" in the button for a moment, then the drawer closes.
        setSaved(true);
        window.setTimeout(onClose, 700);
      }
    } catch (e) {
      const friendly = translatePostgresError(e, { entity: "asset", field: "tag" });
      setError(friendly.code ? `${friendly.heading}. ${friendly.message}` : friendlyError(e));
    }
    finally { setBusy(false); }
  };

  const onDelete = async () => {
    if (!asset) return;
    if (!(await appConfirm({ title: `Delete ${asset.tag}?`, message: "Its photos go with it. You can't undo this.", confirmLabel: `Delete ${asset.tag}`, tone: "danger" }))) return;
    setBusy(true);
    try {
      await deleteAsset(asset.id);
      invalidateAssetCache();
      onSaved();
      onClose();
    } catch (e) {
      const f = translatePostgresError(e, { entity: "asset" });
      setError(f.code ? `${f.heading}. ${f.message}` : friendlyError(e));
      setBusy(false);
    }
  };

  const markPhotoStatus = async (p: AssetPhoto, status: PhotoStatus) => {
    try {
      await updatePhoto(p.id, { status }, userId);
      setPhotos((prev) => prev.map((x) => x.id === p.id ? { ...x, status } : x));
    } catch (e) { await appAlert({ title: "Couldn't change the photo", message: friendlyError(e), tone: "danger" }); }
  };

  const onDeletePhoto = async (p: AssetPhoto) => {
    if (!(await appConfirm({ title: "Remove this photo?", message: "It can't be brought back.", confirmLabel: "Remove photo", tone: "danger" }))) return;
    try {
      await deletePhoto(p.id);
      setPhotos((prev) => prev.filter((x) => x.id !== p.id));
    } catch (e) { await appAlert({ title: "Couldn't remove the photo", message: friendlyError(e), tone: "danger" }); }
  };

  return onBody(
    <div role="dialog" aria-modal="true" aria-label={isCreate ? "New asset" : `Asset ${asset?.tag ?? ""}`} className="fixed inset-0 z-[600] flex" onClick={() => { if (!busy) onClose(); }}>
      <div className="absolute inset-0 bg-[var(--color-ink)]/60" />
      <div onClick={(e) => e.stopPropagation()} className="relative ml-auto w-full max-w-xl bg-[var(--color-surface)] ui-float sm:rounded-l-xl flex flex-col h-dvh">
        <div className="px-5 sm:px-6 pt-5 pb-4 border-b border-[var(--color-border)] shrink-0">
          <div className="flex items-center gap-2">
            <div className="min-w-0 truncate text-body text-[var(--color-text-muted)]">
              Operating areas{(asset?.unit_code ?? preset?.unitCode) ? ` · Unit ${asset?.unit_code ?? preset?.unitCode}` : ""}{isCreate ? " · New asset" : ""}
            </div>
            <div className="flex-1" />
            {!isCreate && asset && userId && (
              <WatchButton
                orgId={orgId}
                userId={userId}
                resourceType="asset"
                resourceId={asset.id}
                size="sm"
              />
            )}
            <button type="button" onClick={onClose} disabled={busy} aria-label="Close" title="Close" className={btnIcon}>
              <X className="w-4 h-4" />
            </button>
          </div>
          <h2 className="mt-2 font-display text-title leading-tight font-semibold text-[var(--color-text)] break-words">
            {isCreate ? (tag.trim() || "New asset") : asset ? <CopyId value={asset.tag} label="tag" /> : null}
          </h2>
          <p className="mt-1 text-reading text-[var(--color-text-muted)]">
            {isCreate ? "Its tag, type and where it is." : <>{types.find((t) => t.id === asset?.type_id)?.name ?? "No type yet"} · {plural(photos.length, "photo")}{linkedDocs ? ` · ${plural(linkedDocs.length, "document")}` : ""}{asset ? ` · ${assetChange(asset)}` : ""}</>}
          </p>
        </div>

        <div className="flex-1 overflow-auto px-5 sm:px-6 py-5 space-y-8">
          {/* Form */}
          <div className="space-y-4">
            <div>
              <label className={labelCls}>Tag</label>
              <DuplicateAwareInput
                value={tag}
                onChange={setTag}
                onDuplicateChange={(isDup) => setHasTagConflict(isDup)}
                check={{
                  table: "assets",
                  column: "tag_normalized",
                  scope: { org_id: orgId },
                  normalize: normalizeTag,
                  excludeId: asset?.id,
                }}
                fieldLabel="asset tag"
                disabled={!canEdit || busy}
                placeholder="e.g. FE-201"
                className="font-display tabular-nums"
              />
              {tag && (
                <div className="text-body text-[var(--color-text-muted)] mt-1.5">Found in search as <span className="font-display tabular-nums">{normalizeTag(tag)}</span></div>
              )}
            </div>
            <div>
              <label htmlFor="asset-type" className={labelCls}>Type</label>
              <select id="asset-type" value={typeId} onChange={(e) => setTypeId(e.target.value)} disabled={!canEdit || busy} className={field}>
                <option value="">No type yet</option>
                {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="asset-desc" className={labelCls}>Description</label>
              <textarea id="asset-desc" value={description} onChange={(e) => setDescription(e.target.value)} disabled={!canEdit || busy} rows={2} placeholder="e.g. Crude charge pump" className={`${field} !h-auto py-2 resize-y [field-sizing:content] min-h-[4.5rem]`} />
            </div>
            <div>
              <label htmlFor="asset-loc" className={labelCls}>Location</label>
              <input id="asset-loc" value={location} onChange={(e) => setLocation(e.target.value)} disabled={!canEdit || busy} placeholder="e.g. Unit 200 cold side" className={field} />
            </div>
            {book.units.length > 0 && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="asset-unit" className={labelCls}>Operating unit</label>
                  <select id="asset-unit" value={unitCode} onChange={(e) => setUnitCode(e.target.value)} disabled={!canEdit || busy}
                    className={field}>
                    <option value="">None</option>
                    {book.units.map((u) => <option key={u.code} value={u.code}>{u.code} · {u.label}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="asset-code" className={labelCls}>Site code</label>
                  <input id="asset-code" value={siteCode} onChange={(e) => setSiteCode(e.target.value)} disabled={!canEdit || busy}
                    placeholder="Fills in, e.g. 2030.22" className={`${field} font-display tabular-nums`} />
                </div>
              </div>
            )}
          </div>

          {/* Photos section (edit mode only) */}
          {!isCreate && asset && (
            <div>
              <div className="flex items-end gap-3 mb-3">
                <h3 className="font-display text-section leading-tight font-semibold text-[var(--color-text)]">Photos <span className="ui-count">{photos.length}</span></h3>
                <span className="flex-1" />
                {photos.length > 0 && (
                  <button type="button" onClick={() => onOpenCarousel(asset)} className={btnLink}>Open photos</button>
                )}
                {canEdit && (
                  <button type="button" onClick={() => onOpenUploader(asset)} className={btnLink}>
                    <Camera className="w-4 h-4" /> Add photos
                  </button>
                )}
              </div>
              {photosFailed ? (
                <ErrorNote compact title="Couldn't load the photos." next="Close this and open it again." />
              ) : photos.length === 0 ? (
                <p className="text-body text-[var(--color-text-muted)]">No photos yet. A photo of the nameplate helps the field find it.</p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {photos.map((p) => {
                    const age = photoAgeCategory(p.captured_at);
                    return (
                      <div key={p.id} className="relative group rounded-lg overflow-hidden border border-[var(--color-border)] aspect-square bg-[var(--color-surface-2)]">
                        <SignedImg path={p.file_url} alt={p.caption || ""} className="w-full h-full object-cover" />
                        {/* Date and status on one strip along the bottom of the photo. */}
                        <div className="absolute bottom-0 inset-x-0 px-1.5 py-1 bg-[var(--color-surface)]/90">
                          <div className="text-body tabular-nums flex items-center gap-1 text-[var(--color-text)]">
                            <span className={age.category === "stale" ? "text-[var(--state-overdue-text)]" : age.category === "aging" ? "text-[var(--state-held-text)]" : ""}>
                              {p.captured_at ? new Date(p.captured_at).toLocaleDateString() : "No date"}
                            </span>
                            {p.status !== "current" && (
                              <span className={`ml-auto font-medium ${p.status === "needs_verification" ? "text-[var(--state-held-text)]" : "text-[var(--state-overdue-text)]"}`}>
                                {p.status === "needs_verification" ? "Check" : "Old"}
                              </span>
                            )}
                          </div>
                        </div>
                        {canEdit && (
                          <div className="absolute top-1 right-1 flex flex-col gap-1 opacity-80 group-hover:opacity-100 transition-opacity">
                            <button onClick={() => markPhotoStatus(p, p.status === "current" ? "needs_verification" : "current")} title={p.status === "current" ? "Mark as needs checking" : "Mark as current"} aria-label={p.status === "current" ? "Mark as needs checking" : "Mark as current"} className="inline-flex items-center justify-center pointer-coarse:size-11 p-1 bg-[var(--color-surface)]/90 rounded hover:bg-[var(--color-surface)]">
                              <AlertTriangle className="w-3 h-3 text-[var(--color-text-muted)]" />
                            </button>
                            <button onClick={() => onDeletePhoto(p)} title="Delete photo" aria-label="Delete photo" className="inline-flex items-center justify-center pointer-coarse:size-11 p-1 bg-[var(--color-surface)]/90 rounded hover:bg-[var(--color-surface)]">
                              <Trash2 className="w-3 h-3 text-[var(--color-text-muted)]" />
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {docPickerOpen && asset && (
            <DocumentLinkPicker
              orgId={orgId}
              userId={userId}
              excludeIds={(linkedDocs ?? []).map((d) => d.documentId)}
              onPick={linkDocument}
              onClose={() => setDocPickerOpen(false)}
            />
          )}

          {/* Linked documents (edit mode only) */}
          {!isCreate && asset && (
            <div>
              <div className="flex items-end gap-3 mb-3 flex-wrap">
                <h3 className="font-display text-section leading-tight font-semibold text-[var(--color-text)]">Linked documents {linkedDocs && <span className="ui-count">{linkedDocs.length}</span>}</h3>
                <span className="flex-1" />
                <Link href={`/graph?focus=${encodeURIComponent(`asset:${asset.id}`)}`} className={btnLink}>
                  <Waypoints className="w-4 h-4" /> See on graph
                </Link>
                {canEdit && (
                  <button type="button" onClick={() => setDocPickerOpen(true)} className={btnLink}>
                    <Plus className="w-4 h-4" /> Link a document
                  </button>
                )}
              </div>
              {linkedDocs === null ? (
                <SkeletonRows rows={2} cols={0} what="linked documents" />
              ) : docsFailed ? (
                <ErrorNote compact title="Couldn't load the linked documents." onRetry={refreshDocs} />
              ) : linkedDocs.length === 0 ? (
                <p className="text-body text-[var(--color-text-muted)]">No documents name this equipment yet.</p>
              ) : (
                <ul className="rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)] max-h-64 overflow-auto">
                  {linkedDocs.map((d) => (
                    <li key={d.documentId} className="relative group/docrow">
                      {canEdit && (
                        <button type="button" title="Unlink from this equipment" aria-label="Unlink from this equipment"
                          onClick={() => void unlinkDocument(d.documentId)}
                          className="ui-hit absolute right-2 top-1/2 -translate-y-1/2 z-10 p-1.5 rounded-md text-[var(--color-text-faint)] hover:text-[var(--state-overdue)] opacity-0 group-hover/docrow:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <Link
                        href={`/documents/${d.libraryId}?doc=${d.documentId}`}
                        onClick={onClose}
                        className="flex items-center gap-3 px-4 py-2.5 pr-11 hover:bg-[var(--color-surface-2)]"
                      >
                        <FileText aria-hidden className="w-4 h-4 text-[var(--color-text-faint)] shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-body text-[var(--color-text)] truncate">
                            <span className="ui-id">{d.documentNumber || "No number"}</span> {d.title && <span className="text-[var(--color-text-muted)]">· {d.title}</span>}
                          </div>
                          {d.tagText && (
                            <div className="text-body text-[var(--color-text-muted)] truncate">Named as {d.tagText}</div>
                          )}
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Quick notes (edit mode only) */}
          {!isCreate && asset && userId && (
            <div>
              <h3 className="mb-3 font-display text-section leading-tight font-semibold text-[var(--color-text)]">Notes</h3>
              <QuickNoteComposer
                orgId={orgId}
                userId={userId}
                userEmail={userEmail}
                scope={{ assetId: asset.id }}
              />
            </div>
          )}

          {error && <Problem>{error}</Problem>}
        </div>

        <div className="px-5 sm:px-6 py-3 pb-[calc(12px+env(safe-area-inset-bottom))] border-t border-[var(--color-border)] flex items-center justify-between gap-2 shrink-0">
          {!isCreate && canEdit ? (
            <button type="button" onClick={onDelete} disabled={busy} className={btnDanger}>
              <Trash2 className="w-4 h-4" /> <span className="max-sm:hidden">Delete</span>
            </button>
          ) : <div />}
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} disabled={busy} className={btnQuiet}>{canEdit ? "Cancel" : "Close"}</button>
            {canEdit && (
              <Button loading={busy} done={saved} doneLabel="Saved" onClick={() => void save()} disabled={!tag.trim() || hasTagConflict}>
                {isCreate ? "Create and add photos" : "Save"}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Hierarchy modals: the site grows where you stand ───────────────────────
//
// Adding an operating area WRITES THE SITE CODEBOOK — the same single truth
// the whole app decodes through — never a parallel list. Adding a category
// creates the registry group and, when you give it the prefix, teaches the
// codebook at the same time so auto-categorize and every future asset
// benefit. No numbering system yet? Both forms work standalone and say so.

function AddUnitModal({ orgId, userId, existingCodes, onClose, onCreated }: {
  orgId: string;
  userId: string;
  existingCodes: string[];
  onClose: () => void;
  onCreated: (code: string) => void;
}) {
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const c = code.trim();
    if (!c) { setError("Give the area its number or code, like 20."); return; }
    if (existingCodes.includes(c)) { setError(`Unit ${c} already exists. Pick another code.`); return; }
    setBusy(true); setError(null);
    const { error: e } = await supabase.from("codebook_entries").insert({
      org_id: orgId, kind: "unit", code: c, label: label.trim() || `Unit ${c}`,
      meta: {}, sort: existingCodes.length, origin: "manual", created_by: userId,
    });
    setBusy(false);
    if (e) { setError(friendlyError(e)); return; }
    onCreated(c);
  };

  return (
    <Modal onClose={onClose} size="sm" zIndex={700} dismissable={!busy}>
      <ModalHeader title="New operating area" subtitle="Saved in your Site Codebook, where the whole app reads units from." onClose={busy ? undefined : onClose} />
      <ModalBody>
        <form id="new-unit" onSubmit={(e) => { e.preventDefault(); void save(); }} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
          <div>
            <label htmlFor="unit-code" className={labelCls}>Code</label>
            <input id="unit-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="20" autoFocus autoComplete="off"
              aria-invalid={!!error && !code.trim()} className={`${field} font-display tabular-nums`} />
          </div>
          <div>
            <label htmlFor="unit-name" className={labelCls}>Name</label>
            <input id="unit-name" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Crude Unit" autoComplete="off" className={field} />
          </div>
        </form>
        {error && <Problem className="mt-3">{error}</Problem>}
        <Link href="/admin/codebook" className={`${btnLink} mt-3`}>Open the full Site Codebook</Link>
      </ModalBody>
      <ModalFooter>
        <button type="button" onClick={onClose} disabled={busy} className={btnQuiet}>Cancel</button>
        <Button type="submit" form="new-unit" loading={busy} variant={code.trim() ? "primary" : "secondary"}>Create area</Button>
      </ModalFooter>
    </Modal>
  );
}

function AddCategoryModal({ orgId, userId, existingTypeCodes, onClose, onCreated }: {
  orgId: string;
  userId: string;
  existingTypeCodes: string[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [prefixes, setPrefixes] = useState("");
  const [typeCode, setTypeCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const n = name.trim();
    if (!n) { setError("Name the category, like Pump or Exchanger."); return; }
    // Teaching moment: a code (with or without prefixes) writes a real Site
    // Codebook entry — it must never be swallowed silently. Validate BEFORE
    // creating anything so a fixable problem doesn't half-save.
    const px = prefixes.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
    const tc = typeCode.trim();
    if (px.length > 0 && !tc) {
      setError("Prefixes need a code to go under. Add the equipment-type code, like 02.");
      return;
    }
    if (tc && existingTypeCodes.some((c) => c.trim().toLowerCase() === tc.toLowerCase())) {
      setError(`Code ${tc} is already used by another equipment type in the Site Codebook. Pick a different code or leave it blank.`);
      return;
    }
    setBusy(true); setError(null);
    try {
      // Codebook FIRST — it's the write most likely to be refused (RLS
      // requires Admin/DocCtrl on the headline role; codes collide under a
      // unique index). Ordering it first means a refusal leaves NOTHING
      // half-created, so a retry can never mint duplicate categories.
      if (tc) {
        const { error: cbErr } = await supabase.from("codebook_entries").insert({
          org_id: orgId, kind: "equipment_type", code: tc, label: n,
          meta: { tagPrefixes: px }, sort: existingTypeCodes.length,
          origin: "manual", created_by: userId,
        });
        if (cbErr && cbErr.code === "23505") {
          setError(`Code ${tc} is already used in the Site Codebook. Pick a different code or leave it blank.`);
          setBusy(false); return;
        }
        if (cbErr && cbErr.code === "42501") {
          setError("Only Admin or Doc Control can change the Site Codebook. Leave the code blank to make the category alone, or ask a controller.");
          setBusy(false); return;
        }
        if (cbErr) { setError(friendlyError(cbErr)); setBusy(false); return; }
      }
      await createAssetType({ orgId, name: n });
      onCreated();
    } catch (e) {
      setError(friendlyError(e));
    } finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose} size="sm" zIndex={700} dismissable={!busy}>
      <ModalHeader title="New equipment category" subtitle="A group in every operating area. Give it its tag prefix and new equipment sorts itself." onClose={busy ? undefined : onClose} />
      <ModalBody>
        <form id="new-category" onSubmit={(e) => { e.preventDefault(); void save(); }} className="space-y-4">
          <div>
            <label htmlFor="cat-name" className={labelCls}>Name</label>
            <input id="cat-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Exchanger" autoFocus autoComplete="off"
              aria-invalid={!!error && !name.trim()} className={field} />
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
            <div>
              <label htmlFor="cat-prefix" className={labelCls}>Tag prefixes <span className="font-normal text-[var(--color-text-muted)]">(optional)</span></label>
              <input id="cat-prefix" value={prefixes} onChange={(e) => setPrefixes(e.target.value)} placeholder="E, EA" autoComplete="off" className={`${field} font-display`} />
            </div>
            <div>
              <label htmlFor="cat-code" className={labelCls}>Code</label>
              <input id="cat-code" value={typeCode} onChange={(e) => setTypeCode(e.target.value)} placeholder="02" autoComplete="off" className={`${field} font-display tabular-nums`} />
            </div>
          </div>
          <p className="text-body text-[var(--color-text-muted)]">No numbering system? Leave both blank. You can add them later.</p>
        </form>
        {error && <Problem className="mt-3">{error}</Problem>}
      </ModalBody>
      <ModalFooter>
        <button type="button" onClick={onClose} disabled={busy} className={btnQuiet}>Cancel</button>
        <Button type="submit" form="new-category" loading={busy} variant={name.trim() ? "primary" : "secondary"}>Create category</Button>
      </ModalFooter>
    </Modal>
  );
}
