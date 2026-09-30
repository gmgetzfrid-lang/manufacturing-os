"use client";

// /admin/assets — Operating Areas.
//
// The landing page is the SITE: one card per operating unit (from the Site
// Codebook). Step into a unit and you're in that unit's hub — its equipment
// grouped by type, the libraries/folders pinned to it (P&IDs, operating
// manuals, unit data — whatever this org wires up), and every document that
// references the unit's equipment. The unit is the front door; everything
// about it lives one click inside.

import React, { useEffect, useState, useCallback, useMemo, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Tag, Plus, Search, Camera, Loader2,
  Image as ImageIcon, MapPin, AlertTriangle,
  Lock, X, Save, Edit3, Trash2, Factory,
  FileText, Upload, QrCode, BookMarked, ArrowRight,
  FolderOpen, Link2, ArrowLeft, Waypoints, ChevronDown, BookMarked as BookMarkedIcon,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import {
  listAssets, listAssetTypes, getPhotoCounts, getCoverPhotoUrls, createAsset, createAssetType,
  updateAsset, deleteAsset, archiveAsset, listAssetPhotos, deletePhoto, updatePhoto,
  invalidateAssetCache, photoAgeCategory, listAssetIdentities, getAsset,
  type Asset, type AssetType, type AssetPhoto, type PhotoStatus, type AssetIdentity,
} from "@/lib/assets";
import {
  loadCodebook, tagToCode, parseDrawingNumber, saveUnitLinks, EMPTY_CODEBOOK,
  codeProblem, prefixClaimsElsewhere, codeToTag,
  type Codebook, type UnitResourceLink,
} from "@/lib/codebook";
import { isControllerRole } from "@/lib/permissions";
import {
  codeUnitConflict, planIdentityReview, assetsMatchingTagPrefix, sharedSiteCodes, type IdentityReviewRow,
} from "@/lib/assetCategorize";
import type { Role } from "@/types/schema";
import { listLibraryFoldersOnce, type PickerFolder } from "@/lib/libraryCollections";
import { getDocumentsForAssetsHydrated } from "@/lib/operationalGraph";
import AssetPhotoCarousel from "@/components/assets/AssetPhotoCarousel";
import { CategorizeBanner, FlowPanel } from "@/components/assets/UnitOpsPanels";
import { AreaKnowledgePanel } from "@/components/assets/AreaKnowledgePanel";
import DocumentLinkPicker from "@/components/documents/DocumentLinkPicker";
import AssetPhotoUploader from "@/components/assets/AssetPhotoUploader";
import AssetCsvImportModal from "@/components/assets/AssetCsvImportModal";
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

// DocCtrl belongs here: document controllers own the asset↔document wiring
// (categories, codebook areas, file links), so gating them out of asset
// creation left them able to manage everything about an asset EXCEPT
// making it exist.
const ADMIN_ROLES = ["Admin", "DocCtrl", "Manager", "Supervisor"];

export default function AssetsPage() {
  // useSearchParams needs a Suspense boundary at build time.
  return (
    <Suspense fallback={null}>
      <AssetsPageInner />
    </Suspense>
  );
}

function AssetsPageInner() {
  const { activeOrgId, activeRole, roles, uid, userEmail } = useRole();
  // ADD-1: authority by the role COLLECTION, never the headline alone.
  const isAdmin = roles.some((r) => ADMIN_ROLES.includes(r));
  // AREA-1 / IRLS-5: the controller tier (what is_org_controller means) —
  // deletes registry equipment and photos (20261128) and writes the Site
  // Codebook (20261046). The writer tier above creates, edits and archives.
  const isController = roles.some((r) => isControllerRole(r as Role));
  const router = useRouter();
  const searchParams = useSearchParams();

  const [assets, setAssets] = useState<Asset[]>([]);
  // CB-10: every asset's identity columns, archived included — the unique
  // index and 20261128's inventory count archived rows, so the shared-code
  // list and the derived-code holders must too.
  const [identities, setIdentities] = useState<AssetIdentity[]>([]);
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
  // BR-8: provenance is a filter — equipment the drawings created, awaiting
  // a person to vouch for it.
  const [discoveredOnly, setDiscoveredOnly] = useState(false);
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

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    setLoading(true);
    setError(null);
    try {
      const [as, ts, cb, ids] = await Promise.all([
        listAssets({ orgId: activeOrgId, archived: false }),
        listAssetTypes(activeOrgId),
        loadCodebook(activeOrgId),
        listAssetIdentities(activeOrgId),
      ]);
      setAssets(as);
      setIdentities(ids);
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
      if (discoveredOnly && a.origin !== "drawing") return false;
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
  }, [assets, photoCounts, typeFilter, filterMode, search, unitFilter, discoveredOnly]);
  const discoveredCount = useMemo(() => assets.filter((a) => a.origin === "drawing").length, [assets]);
  // AREA-11 / CB-6: every asset whose stored identity disagrees with the
  // codebook as it stands (the code names another unit; the code re-derives).
  const identityReview = useMemo(() => planIdentityReview(assets, book, identities), [assets, book, identities]);
  // CB-10: one site code, one asset — codes already shared are listed first
  // (the database's unique index waits until there are none). Archived
  // assets count: they block the index exactly like active ones.
  const sharedCodes = useMemo(() => sharedSiteCodes(identities), [identities]);

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
      .sort((x, y) => x.name.localeCompare(y.name));
  }, [unitFilter, filtered, types]);
  // Accordion state per category; everything starts open.
  const [closedTypes, setClosedTypes] = useState<Set<string>>(new Set());

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
  // as every other codebook write (RLS: the controller tier).
  const canEditLinks = isController;
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

  const searchActive = search.trim().length > 0 || typeFilter !== "" || filterMode !== "all" || discoveredOnly;

  if (!activeOrgId) return null;

  return (
    <div className="p-4 sm:p-8 pb-20">
      <div className="max-w-7xl mx-auto">
        <ViewTabs title="Operating areas" tabs={EQUIPMENT_VIEWS} />
        {/* Header */}
        <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-black text-[var(--color-text)] flex items-center gap-3">
              <Tag className="w-7 h-7 text-purple-600" />
              Operating Areas
            </h1>
            <p className="text-sm text-[var(--color-text-muted)] mt-1 max-w-2xl">
              Each operating area is a front door: step inside for its equipment by type, its
              pinned libraries (P&amp;IDs, manuals, unit data), and every document that
              references its equipment.
            </p>
          </div>
          {isAdmin && (
            <div className="flex items-center gap-2 flex-wrap">
              {/* Bulk QR labels for whatever the filters currently show —
                  laminate onto the equipment; every scan lands on that
                  asset's hub (drawings, holds, doc pack, report-a-problem). */}
              <button
                onClick={async () => {
                  const list = filtered.slice(0, 200);
                  if (list.length === 0) return;
                  const { printEquipmentLabels } = await import("@/lib/physicalBridge");
                  await printEquipmentLabels(list.map((a) => ({
                    tag: a.tag,
                    description: a.description ?? null,
                    location: a.location ?? null,
                  })));
                }}
                disabled={filtered.length === 0}
                title={`Print a QR label sheet for the ${filtered.length} asset${filtered.length === 1 ? "" : "s"} currently shown (Avery 5163 layout)`}
                className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-xl bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] text-[var(--color-text)] text-sm font-bold border border-[var(--color-border)] disabled:opacity-40"
              >
                <QrCode className="w-4 h-4" /> QR labels ({filtered.length})
              </button>
              <button
                onClick={() => setCsvOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-xl bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] text-[var(--color-text)] text-sm font-bold border border-[var(--color-border)]"
              >
                <Upload className="w-4 h-4" /> Import CSV
              </button>
              {!unitFilter ? (
                // The root IS the site — the primary act here is defining an
                // operating area, not dropping a loose asset. An area is a
                // Site Codebook entry: the controller tier writes it.
                canEditLinks && <button
                  onClick={() => setAddUnitOpen(true)}
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-sm font-black shadow-lg shadow-purple-900/20"
                >
                  <Plus className="w-4 h-4" /> New operating area
                </button>
              ) : (
                <>
                  {/* CATEGORY leads — it is the next level of the hierarchy.
                      Assets are added inside their category's section. */}
                  <button
                    onClick={() => openCreate({ unitCode: unitFilter === "__unassigned" ? undefined : unitFilter })}
                    className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-xl bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] text-[var(--color-text)] text-sm font-bold border border-[var(--color-border)]"
                  >
                    <Plus className="w-4 h-4" /> New asset
                  </button>
                  <button
                    onClick={() => setAddCategoryOpen(true)}
                    className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-sm font-black shadow-lg shadow-purple-900/20"
                  >
                    <Plus className="w-4 h-4" /> New category
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {!isAdmin && (
          <div className="mb-6 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 flex items-start gap-2">
            <Lock className="w-4 h-4 mt-0.5 shrink-0" />
            <span>Only Admin / Doc Control / Manager / Supervisor can create, edit or archive equipment; deleting it is Admin / Doc Control only. Your role: <b>{activeRole}</b>. You can still browse + view photos.</span>
          </div>
        )}

        {/* No codebook units yet → show admins the path instead of a silently
            flat registry. The unit-first view lights up the moment units exist. */}
        {book.units.length === 0 && isAdmin && (
          <div className="mb-4 rounded-2xl border border-violet-200 bg-violet-50/60 p-4 flex items-start gap-3 flex-wrap">
            <div className="w-9 h-9 rounded-xl bg-violet-100 border border-violet-200 flex items-center justify-center shrink-0">
              <BookMarked className="w-4 h-4 text-violet-700" />
            </div>
            <div className="flex-1 min-w-[240px]">
              <div className="text-sm font-black text-[var(--color-text)]">Break this registry into operating areas</div>
              <p className="text-xs text-[var(--color-text-muted)] mt-0.5 leading-relaxed">
                Teach the Site Codebook your units (20 = Crude, 25 = DHT…) and this page reorganizes itself:
                pick a unit first, equipment grouped by type inside it, every asset carrying its site code (E-22 ↔ 2030.22).
                The same codebook feeds the knowledge AI and drafting request forms.
              </p>
            </div>
            <Link href="/admin/codebook"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white bg-violet-600 hover:bg-violet-700 transition-colors shrink-0">
              Set up the Site Codebook <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        )}

        {/* Inside a unit: identity header + the unit's pinned libraries. */}
        {unitFilter && (
          <div className="mb-5">
            <button onClick={() => setUnitFilter(null)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 mb-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-xs font-black text-[var(--color-text)] hover:bg-[var(--color-surface-2)] shadow-sm">
              <ArrowLeft className="w-3.5 h-3.5" /> All operating areas
            </button>
            <div className="flex items-baseline gap-2.5 flex-wrap">
              {unitFilter !== "__unassigned" && (
                <span className="font-mono text-3xl font-black text-purple-700">{unitFilter}</span>
              )}
              <span className="text-2xl font-black text-[var(--color-text)]">
                {unitFilter === "__unassigned" ? "No unit assigned" : (currentUnit?.label ?? unitFilter)}
              </span>
              <span className="text-xs font-bold text-[var(--color-text-muted)]">
                {filtered.length} asset{filtered.length === 1 ? "" : "s"}
              </span>
              {canEditLinks && unitFilter !== "__unassigned" && (
                <Link href="/admin/codebook"
                  className="inline-flex items-center gap-1 text-[11px] font-bold text-violet-700 hover:underline">
                  <Edit3 className="w-3 h-3" /> {currentUnit ? "Edit unit" : "Add this unit to the codebook"}
                </Link>
              )}
            </div>
            {currentUnit && (
              <UnitResources
                orgId={activeOrgId}
                unitCode={currentUnit.code}
                links={(currentUnit.meta.links ?? []) as UnitResourceLink[]}
                canEdit={canEditLinks}
                onChanged={() => { void loadCodebook(activeOrgId).then(setBook); }}
              />
            )}
            {unitFilter === "__unassigned" && isAdmin && book.units.length > 0 && filtered.length > 0 && (
              <UnassignedAssignPanel
                assets={filtered}
                book={book}
                userId={uid || ""}
                onAssigned={() => { invalidateAssetCache(); void refresh(); }}
              />
            )}
          </div>
        )}

        {/* This area's knowledge: setup path, live state, and drift review —
            the order of operations lives ON the unit page. */}
        {currentUnit && !loading && uid && activeOrgId && (
          <AreaKnowledgePanel
            orgId={activeOrgId}
            userId={uid}
            userName={userEmail ?? "Member"}
            unit={{ code: currentUnit.code, label: currentUnit.label || `Unit ${currentUnit.code}` }}
            unitAssetIds={areaAssetIds}
          />
        )}

        {/* The Site Codebook already knows the taxonomy — put it to work. */}
        {isAdmin && !loading && uid && activeOrgId && (
          <CategorizeBanner orgId={activeOrgId} userId={uid} assets={assets} types={types} book={book}
            onDone={() => { invalidateAssetCache(); void refresh(); }} />
        )}

        {/* AREA-11 / CB-6: stored identity that disagrees with the codebook —
            reviewed per asset, never rewritten silently. */}
        {isAdmin && !loading && uid && (identityReview.length > 0 || sharedCodes.length > 0) && (
          <IdentityReviewPanel rows={identityReview} shared={sharedCodes} book={book} userId={uid}
            onOpen={(id) => {
              const a = assets.find((x) => x.id === id);
              if (a) { setSelectedAsset(a); return; }
              // An archived asset is not in the grid; open it from the registry.
              void getAsset(id).then((hit) => { if (hit) setSelectedAsset(hit); }).catch(() => undefined);
            }}
            onChanged={() => { invalidateAssetCache(); void refresh(); }} />
        )}

        {/* BR-8: equipment the drawings created, awaiting a person. */}
        {isAdmin && !loading && uid && discoveredOnly && (
          <DiscoveredReviewPanel assets={filtered} userId={uid}
            onChanged={() => { invalidateAssetCache(); void refresh(); }} />
        )}

        {/* Search + filters */}
        <div className="mb-4 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-faint)]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search all equipment — tag (E-22), site code (2030.22), description, location…"
              className="w-full pl-10 pr-3 py-2.5 text-base sm:text-sm border border-[var(--color-border)] rounded-lg bg-[var(--color-surface)] focus:ring-2 focus:ring-purple-500 focus:border-transparent outline-none"
            />
          </div>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="px-3 py-2.5 text-sm border border-[var(--color-border)] rounded-lg bg-[var(--color-surface)] font-medium">
            <option value="">All types</option>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <div className="flex bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg p-1">
            {(["all", "with_photos", "no_photos"] as const).map((m) => (
              <button key={m} onClick={() => setFilterMode(m)} className={`px-2.5 py-1.5 text-xs font-bold rounded-md ${filterMode === m ? "bg-slate-900 text-white" : "text-[var(--color-text-muted)]"}`}>
                {m === "all" ? "All" : m === "with_photos" ? "With photos" : "No photos"}
              </button>
            ))}
          </div>
          {discoveredCount > 0 && (
            <button onClick={() => setDiscoveredOnly((v) => !v)}
              title="Equipment the drawing sweep created (origin: drawing) — review, confirm or archive it"
              className={`px-3 py-2.5 text-xs font-bold rounded-lg border ${discoveredOnly
                ? "bg-sky-700 text-white border-sky-700"
                : "bg-[var(--color-surface)] text-sky-800 border-sky-200 hover:bg-sky-50"}`}>
              Discovered from drawings ({discoveredCount})
            </button>
          )}
        </div>

        {/* Grid */}
        {loading ? (
          <div className="text-center py-16 text-sm text-[var(--color-text-muted)]"><Loader2 className="w-5 h-5 animate-spin inline" /> Loading…</div>
        ) : error ? (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">{error}</div>
        ) : unitFilter ? (
          // ── The unit hub: equipment by type, then every document that
          //    references the unit's equipment.
          <div className="space-y-6">
            {filtered.length === 0 ? (
              unitFilter === "__unassigned" ? (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-8 text-center">
                  <p className="text-sm font-black text-[var(--color-text)]">Everything is filed.</p>
                  <p className="text-xs text-[var(--color-text-muted)] mt-1">No equipment is missing an operating area.</p>
                  <button onClick={() => setUnitFilter(null)}
                    className="mt-3 inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-sm font-black shadow">
                    <ArrowLeft className="w-4 h-4" /> Back to all areas
                  </button>
                </div>
              ) : (
                <EmptyState onCreate={isAdmin ? () => setCreating(true) : undefined} hasAny={assets.length > 0} />
              )
            ) : (
              groupedByType?.map((g) => {
                const open = !closedTypes.has(g.typeId);
                const isUncat = g.typeId === "__none";
                const cb = isUncat ? undefined : cbTypeByLabel.get(g.name.trim().toLowerCase());
                return (
                <div key={g.typeId}>
                  {/* Category headers are the unit's chapter titles — they
                      carry the codebook's code + prefixes so the numbering
                      system you taught is visibly at work. */}
                  <div className={`flex items-center gap-2.5 mb-2.5 rounded-xl border px-3 py-2 ${isUncat
                    ? "border-amber-300 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/30"
                    : "border-purple-200 dark:border-purple-900 bg-gradient-to-r from-purple-50/80 to-transparent dark:from-purple-950/30"}`}>
                    <button type="button"
                      onClick={() => setClosedTypes((prev) => {
                        const next = new Set(prev);
                        if (next.has(g.typeId)) next.delete(g.typeId); else next.add(g.typeId);
                        return next;
                      })}
                      className="flex items-center gap-2.5 text-left flex-1 min-w-0">
                      <ChevronDown className={`w-4 h-4 shrink-0 ${isUncat ? "text-amber-500" : "text-purple-400"} transition-transform ${open ? "" : "-rotate-90"}`} />
                      <span className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${isUncat
                        ? "bg-amber-100 dark:bg-amber-900/50"
                        : "bg-purple-100 dark:bg-purple-900/50"}`}>
                        {isUncat
                          ? <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                          : <Tag className="w-3.5 h-3.5 text-purple-600" />}
                      </span>
                      <span className="min-w-0">
                        <span className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-black text-[var(--color-text)]">{g.name}</span>
                          <span className={`text-[10px] font-black rounded-full px-2 py-0.5 ${isUncat
                            ? "bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300"
                            : "bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300"}`}>
                            {g.list.length}
                          </span>
                          {cb && (
                            <span className="font-mono text-[10px] font-black text-purple-700 dark:text-purple-300 bg-[var(--color-surface)] border border-purple-200 dark:border-purple-800 rounded px-1.5 py-0.5"
                              title={`Site Codebook equipment-type code ${cb.code}`}>
                              code {cb.code}
                            </span>
                          )}
                          {cb && cb.prefixes.length > 0 && (
                            <span className="font-mono text-[10px] font-bold text-[var(--color-text-muted)] bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-1.5 py-0.5"
                              title="Tag prefixes that auto-categorize into this section">
                              {cb.prefixes.join(" · ")}
                            </span>
                          )}
                        </span>
                        {isUncat && (
                          <span className="block text-[10px] text-amber-700 dark:text-amber-400 font-bold mt-0.5">
                            File these: hit Categorize on a card, or run Auto-categorize above.
                          </span>
                        )}
                      </span>
                    </button>
                    {isAdmin && (
                      <button type="button"
                        onClick={() => openCreate({
                          typeId: g.typeId === "__none" ? undefined : g.typeId,
                          unitCode: unitFilter === "__unassigned" ? undefined : (unitFilter ?? undefined),
                        })}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[10px] font-black text-[var(--color-text-muted)] hover:text-purple-700 hover:border-purple-400 shrink-0">
                        <Plus className="w-3 h-3" /> Asset
                      </button>
                    )}
                  </div>
                  {open && (g.list.length === 0 ? (
                    <button type="button"
                      onClick={() => isAdmin && openCreate({
                        typeId: g.typeId === "__none" ? undefined : g.typeId,
                        unitCode: unitFilter === "__unassigned" ? undefined : (unitFilter ?? undefined),
                      })}
                      className="w-full rounded-xl border-2 border-dashed border-[var(--color-border)] py-5 text-xs font-bold text-[var(--color-text-faint)] hover:border-purple-400 hover:text-purple-700">
                      No {g.name.toLowerCase()} in this area yet{isAdmin ? " — add the first" : ""}
                    </button>
                  ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {g.list.map((a) => {
                      const type = types.find((t) => t.id === a.type_id);
                      const count = photoCounts.get(a.id) || 0;
                      return (
                        <AssetCard key={a.id} asset={a} type={type} photoCount={count} coverUrl={coverUrls.get(a.id)} book={book}
                          onClick={() => count > 0 ? setCarouselOpenFor(a) : setSelectedAsset(a)}
                          onEdit={isAdmin ? () => setSelectedAsset(a) : undefined}
                          onAddPhotos={isAdmin ? () => setUploaderOpenFor(a) : undefined} />
                      );
                    })}
                  </div>
                  ))}
                </div>
                );
              })
            )}
            {unitAssetIds.length > 0 && <UnitDocuments assetIds={unitAssetIds} assets={filtered} />}
            {unitFilter && unitFilter !== "__unassigned" && uid && (
              <FlowPanel orgId={activeOrgId!} userId={uid} userName={userEmail ?? undefined}
                isAdmin={isAdmin} unitCode={unitFilter} unitAssets={filtered} />
            )}
          </div>
        ) : book.units.length > 0 && !searchActive ? (
          // ── The landing page IS the site: one card per operating area.
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {unitSummaries.map((s) => (
              <UnitCard key={s.unit.code} summary={s} onOpen={() => setUnitFilter(s.unit.code)}
                onEdit={canEditLinks ? () => router.push("/admin/codebook") : undefined} />
            ))}
            {unknownUnits.map(([code, n]) => (
              <button key={code} onClick={() => setUnitFilter(code)}
                className="text-left rounded-2xl border-2 border-dashed border-purple-200 bg-[var(--color-surface)] hover:border-purple-300 p-5 transition-colors">
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="font-mono text-lg font-black text-purple-700">{code}</span>
                  <span className="text-sm font-black text-[var(--color-text)]">Unknown unit</span>
                </div>
                <div className="text-xs text-[var(--color-text-muted)]">
                  {n} asset{n === 1 ? "" : "s"} carry this code, but it isn&apos;t in the Site Codebook yet.
                </div>
              </button>
            ))}
            {unitCounts.unassigned > 0 && (
              <button onClick={() => setUnitFilter("__unassigned")}
                className="text-left rounded-2xl border-2 border-dashed border-amber-300 bg-amber-50/50 hover:bg-amber-50 p-5 transition-colors">
                <div className="flex items-center gap-2 mb-1">
                  <AlertTriangle className="w-4 h-4 text-amber-600" />
                  <span className="text-sm font-black text-[var(--color-text)]">No unit assigned</span>
                </div>
                <div className="text-xs text-[var(--color-text-muted)]">
                  {unitCounts.unassigned} asset{unitCounts.unassigned === 1 ? "" : "s"} waiting to be filed under an operating area.
                </div>
              </button>
            )}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState onCreate={isAdmin ? () => setCreating(true) : undefined} hasAny={assets.length > 0} />
        ) : (
          // Search results (across every unit) or a no-codebook org's flat registry.
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {filtered.map((a) => {
              const type = types.find((t) => t.id === a.type_id);
              const count = photoCounts.get(a.id) || 0;
              return (
                <AssetCard
                  key={a.id}
                  asset={a}
                  type={type}
                  photoCount={count}
                  coverUrl={coverUrls.get(a.id)}
                  book={book}
                  onClick={() => count > 0 ? setCarouselOpenFor(a) : setSelectedAsset(a)}
                  onEdit={isAdmin ? () => setSelectedAsset(a) : undefined}
                  onAddPhotos={isAdmin ? () => setUploaderOpenFor(a) : undefined}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Modals */}
      {addUnitOpen && canEditLinks && (
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
          existingTypes={book.equipmentTypes}
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
          canEdit={isAdmin}
          canDelete={isController}
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

      {csvOpen && uid && (
        <AssetCsvImportModal
          isOpen={csvOpen}
          onClose={() => setCsvOpen(false)}
          orgId={activeOrgId}
          actorUserId={uid}
          onImported={() => { invalidateAssetCache(); void refresh(); }}
        />
      )}
    </div>
  );
}

// ─── Unit card (the landing page) ──────────────────────────

function UnitCard({ summary, onOpen, onEdit }: {
  summary: {
    unit: { code: string; label: string };
    count: number;
    needPhotos: number;
    topTypes: Array<[string, number]>;
    links: UnitResourceLink[];
  };
  onOpen: () => void;
  onEdit?: () => void;
}) {
  const { unit, count, needPhotos, topTypes, links } = summary;
  return (
    <div onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      className="text-left rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm hover:shadow-lg hover:border-purple-300 transition-all p-5 flex flex-col gap-3 group cursor-pointer">
      <div className="flex items-start gap-3">
        <div className="w-11 h-11 rounded-xl bg-purple-100 border border-purple-200 flex items-center justify-center shrink-0 group-hover:bg-purple-200 transition-colors">
          <Factory className="w-5 h-5 text-purple-700" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-lg font-black text-purple-700">{unit.code}</span>
            <span className="text-sm font-black text-[var(--color-text)] truncate">{unit.label}</span>
          </div>
          <div className="text-[11px] text-[var(--color-text-muted)]">
            {count} asset{count === 1 ? "" : "s"}
            {links.length > 0 && ` · ${links.length} pinned librar${links.length === 1 ? "y" : "ies"}`}
          </div>
        </div>
        {onEdit && (
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            title="Rename or manage this unit (Site Codebook)"
            className="p-1.5 rounded-lg text-[var(--color-text-faint)] hover:text-violet-700 hover:bg-violet-50 shrink-0"
          >
            <Edit3 className="w-3.5 h-3.5" />
          </button>
        )}
        <ArrowRight className="w-4 h-4 text-[var(--color-text-faint)] group-hover:text-purple-600 group-hover:translate-x-0.5 transition-all shrink-0 mt-1" />
      </div>
      {topTypes.length > 0 && (
        <div className="flex gap-1.5 flex-wrap">
          {topTypes.map(([name, n]) => (
            <span key={name} className="text-[10px] font-bold text-[var(--color-text-muted)] bg-[var(--color-surface-2)] rounded-full px-2 py-0.5">
              {name} <span className="text-[var(--color-text-faint)]">{n}</span>
            </span>
          ))}
        </div>
      )}
      {needPhotos > 0 && (
        <div className="text-[10px] font-bold text-amber-700 flex items-center gap-1">
          <Camera className="w-3 h-3" /> {needPhotos} without photos
        </div>
      )}
    </div>
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
    if (!(await appConfirm({ message: "Unpin this from the unit? The library itself is untouched.", tone: "danger" }))) return;
    setBusy(true);
    try {
      await saveUnitLinks(orgId, unitCode, links.filter((l) => l.id !== id));
      onChanged();
    } catch (e) { await appAlert({ message: (e as Error).message, tone: "danger" }); }
    finally { setBusy(false); }
  };

  return (
    <div className="mt-3">
      <div className="flex gap-2 flex-wrap items-stretch">
        {links.map((l) => (
          <div key={l.id} className="group relative">
            <Link
              href={`/documents/${l.libraryId}${l.folderId ? `?folderId=${l.folderId}` : ""}`}
              className="flex items-center gap-2.5 pl-3 pr-8 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] hover:border-purple-300 hover:shadow-md transition-all h-full"
            >
              <FolderOpen className="w-4 h-4 text-purple-600 shrink-0" />
              <div className="min-w-0">
                <div className="text-xs font-black text-[var(--color-text)] truncate">{l.label}</div>
                <div className="text-[10px] text-[var(--color-text-muted)] truncate">
                  {l.libraryName}{l.folderName ? ` › ${l.folderName}` : ""}
                </div>
              </div>
            </Link>
            {canEdit && (
              <button onClick={() => void removeLink(l.id)} disabled={busy} title="Unpin"
                className="absolute top-1.5 right-1.5 p-0.5 rounded text-[var(--color-text-faint)] hover:text-rose-600 opacity-60 sm:opacity-0 group-hover:opacity-100 transition-opacity">
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        ))}
        {canEdit && (
          <button onClick={() => setAdding(true)}
            className={`inline-flex items-center gap-1.5 px-3 py-2.5 rounded-xl border-2 border-dashed text-xs font-bold transition-colors ${
              links.length === 0
                ? "border-purple-300 text-purple-700 bg-purple-50/50 hover:bg-purple-50"
                : "border-[var(--color-border-strong)] text-[var(--color-text-muted)] hover:border-purple-300 hover:text-purple-700"
            }`}>
            <Link2 className="w-3.5 h-3.5" />
            {links.length === 0 ? "Pin this unit's libraries — P&IDs, manuals, unit data…" : "Pin another"}
          </button>
        )}
        {!canEdit && links.length === 0 && (
          <div className="text-[11px] text-[var(--color-text-faint)] italic py-2">
            No libraries pinned to this unit yet.
          </div>
        )}
      </div>
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
  const [libs, setLibs] = useState<Array<{ id: string; name: string }>>([]);
  const [libraryId, setLibraryId] = useState("");
  const [folders, setFolders] = useState<PickerFolder[]>([]);
  const [folderId, setFolderId] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void supabase.from("libraries").select("id, name").eq("org_id", orgId).order("name")
      .then(({ data }) => setLibs((data ?? []) as Array<{ id: string; name: string }>));
  }, [orgId]);

  useEffect(() => {
    if (!libraryId) return;
    let alive = true;
    listLibraryFoldersOnce(libraryId)
      .then((f) => { if (alive) setFolders(f); })
      .catch(() => { if (alive) setFolders([]); });
    return () => { alive = false; };
  }, [libraryId]);

  const lib = libs.find((l) => l.id === libraryId);
  const folder = folders.find((f) => f.id === folderId);
  const effectiveLabel = label.trim() || folder?.name || lib?.name || "";

  const save = async () => {
    if (!lib) { setError("Pick a library first."); return; }
    setBusy(true); setError(null);
    try {
      await onSave({
        id: crypto.randomUUID(),
        label: effectiveLabel,
        libraryId: lib.id,
        libraryName: lib.name,
        folderId: folder?.id ?? null,
        folderName: folder?.name ?? null,
      });
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[500] bg-slate-900/60 backdrop-blur-sm flex items-start sm:items-center justify-center overflow-y-auto p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md bg-[var(--color-surface)] rounded-2xl shadow-2xl max-h-[90vh] flex flex-col">
        <div className="px-5 py-3.5 border-b border-[var(--color-border)] flex items-center gap-2.5">
          <Link2 className="w-4 h-4 text-purple-600" />
          <div className="flex-1">
            <div className="text-sm font-black text-[var(--color-text)]">Pin a library to this unit</div>
            <div className="text-[11px] text-[var(--color-text-muted)]">A whole library, or one folder of it — labeled for what it means here.</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4 text-[var(--color-text-muted)]" /></button>
        </div>
        <div className="p-5 space-y-3 overflow-y-auto">
          <div>
            <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">Library</label>
            <select value={libraryId}
              onChange={(e) => { setLibraryId(e.target.value); setFolders([]); setFolderId(""); }}
              className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)]">
              <option value="">— Pick a library —</option>
              {libs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          {folders.length > 0 && (
            <div>
              <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">Folder (optional)</label>
              <select value={folderId} onChange={(e) => setFolderId(e.target.value)}
                className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)]">
                <option value="">Whole library</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>{f.pathNames.join(" › ") || f.name}</option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">Label on the unit page</label>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={effectiveLabel || "e.g. P&IDs, Operating manuals, Unit data"}
              className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm" />
          </div>
          {error && (
            <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700 flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] rounded-b-2xl flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)]">Cancel</button>
          <button onClick={() => void save()} disabled={busy || !libraryId}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-black text-white bg-purple-600 hover:bg-purple-500 disabled:opacity-50 shadow">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />} Pin it
          </button>
        </div>
      </div>
    </div>
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
  const [busy, setBusy] = useState(false);
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

  // AREA-7 / CB-10: every row is attempted on its own — one refusal never
  // stops the rest of a bulk filing. The derived site code is OPTIONAL: when
  // another asset already carries it (one site code is one asset), the asset
  // is still filed, without the code, and the identity review lists it.
  const assign = async (rows: Array<{ asset: Asset; unitCode: string }>) => {
    setBusy(true);
    let filed = 0;
    const codeless: string[] = [];
    const failed: string[] = [];
    try {
      for (const r of rows) {
        const derived = r.asset.code ? null : tagToCode(r.asset.tag, r.unitCode, book);
        try {
          const { codeDropped } = await updateAsset(r.asset.id, {
            unit_code: r.unitCode,
            ...(derived ? { code: derived } : {}),
          }, userId, { codeOptional: true });
          filed += 1;
          if (codeDropped) codeless.push(`${r.asset.tag} (${codeDropped})`);
        } catch (e) { failed.push(`${r.asset.tag}: ${(e as Error).message}`); }
      }
    } finally {
      setBusy(false);
      onAssigned();
    }
    if (failed.length > 0 || codeless.length > 0) {
      const list = (xs: string[]) => `${xs.slice(0, 5).join(" · ")}${xs.length > 5 ? ` (+${xs.length - 5} more)` : ""}`;
      await appAlert({
        title: `Filed ${filed} of ${rows.length}`,
        message: [
          codeless.length > 0 ? `${codeless.length} filed WITHOUT a site code — another asset already carries the code the codebook derives (one site code is one asset): ${list(codeless)}. Give each its own code; they are listed under Identity review.` : null,
          failed.length > 0 ? `${failed.length} not filed — ${list(failed)}` : null,
        ].filter(Boolean).join("\n\n"),
        tone: failed.length > 0 ? "danger" : "default",
      });
    }
  };

  const chosen = assets.filter((a) => choices.get(a.id));
  const shown = assets.slice(0, 50);
  // AREA-7: file a whole master list by tag prefix instead of 50 dropdowns
  // at a time — every unassigned tag starting with the prefix (one grammar)
  // is selected for the unit; Assign then writes them with derived codes.
  const [bulkPrefix, setBulkPrefix] = useState("");
  const [bulkUnit, setBulkUnit] = useState("");
  const bulkMatches = useMemo(() => (bulkPrefix.trim() ? assetsMatchingTagPrefix(assets, bulkPrefix) : []), [assets, bulkPrefix]);

  return (
    <div className="mt-3 rounded-2xl border border-violet-200 bg-violet-50/60 p-4">
      <div className="text-sm font-black text-[var(--color-text)] mb-0.5">File this equipment under its operating area</div>
      <p className="text-xs text-[var(--color-text-muted)] mb-2.5">
        Pick a unit for each asset and hit Assign — the site code fills in automatically.
        Where the linked drawings already say which unit, it&apos;s pre-selected for you.
      </p>
      <div className="flex items-center gap-2 flex-wrap mb-2.5 text-[11px]">
        <span className="font-bold text-[var(--color-text)]">Bulk:</span>
        every tag starting with
        <input value={bulkPrefix} onChange={(e) => setBulkPrefix(e.target.value)} placeholder="E, P-1, 10-HV"
          className="w-24 px-2 py-1 border border-[var(--color-border-strong)] rounded-lg font-mono bg-[var(--color-surface)]" />
        goes to
        <select value={bulkUnit} onChange={(e) => setBulkUnit(e.target.value)} disabled={busy}
          className="px-2 py-1 border border-[var(--color-border-strong)] rounded-lg bg-[var(--color-surface)] font-bold">
          <option value="">— unit —</option>
          {book.units.map((u) => <option key={u.code} value={u.code}>{u.code} — {u.label}</option>)}
        </select>
        <button type="button" disabled={busy || !bulkUnit || bulkMatches.length === 0}
          onClick={() => setChoices((prev) => { const next = new Map(prev); for (const a of bulkMatches) next.set(a.id, bulkUnit); return next; })}
          className="px-2 py-1 rounded-lg border border-purple-300 bg-[var(--color-surface)] font-black text-purple-700 disabled:opacity-40">
          Select {bulkMatches.length} matching
        </button>
      </div>
      <div className="space-y-1.5">
        {shown.map((a) => {
          const hint = hints.get(a.id);
          const choice = choices.get(a.id) ?? "";
          return (
            <div key={a.id} className="flex items-center gap-2.5 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl px-3 py-2 flex-wrap">
              <span className="font-mono text-xs font-black text-[var(--color-text)] w-20 shrink-0">{a.tag}</span>
              <select
                value={choice}
                onChange={(e) => setChoices((prev) => new Map(prev).set(a.id, e.target.value))}
                disabled={busy}
                className="px-2 py-1.5 border border-[var(--color-border-strong)] rounded-lg text-xs bg-[var(--color-surface)] font-bold"
              >
                <option value="">— pick a unit —</option>
                {book.units.map((u) => (
                  <option key={u.code} value={u.code}>{u.code} — {u.label}</option>
                ))}
              </select>
              <span className="text-[10px] text-[var(--color-text-faint)] flex-1 min-w-[120px]">
                {hint
                  ? <>drawings say <b className="text-purple-700 font-mono">{hint.unitCode}</b> ({hint.drawings} linked drawing{hint.drawings === 1 ? "" : "s"})</>
                  : a.description || ""}
              </span>
              <button
                onClick={() => { if (choice) void assign([{ asset: a, unitCode: choice }]); }}
                disabled={busy || !choice}
                className="text-[11px] font-black text-white bg-purple-600 hover:bg-purple-500 rounded-lg px-2.5 py-1 disabled:opacity-40"
              >
                Assign
              </button>
            </div>
          );
        })}
        {assets.length > shown.length && (
          <div className="text-[10px] text-[var(--color-text-faint)]">Showing the first {shown.length} of {assets.length}.</div>
        )}
      </div>
      {chosen.length > 1 && (
        <button
          onClick={() => void assign(chosen.map((a) => ({ asset: a, unitCode: choices.get(a.id)! })))}
          disabled={busy}
          className="mt-2 inline-flex items-center gap-1.5 text-xs font-black text-white bg-purple-600 hover:bg-purple-500 rounded-lg px-3 py-1.5 disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          Assign all {chosen.length} selected
        </button>
      )}
    </div>
  );
}

// ─── Identity review (AREA-11 / CB-6) ──────────────────────
//
// Stored identity that disagrees with the codebook as it stands: a site code
// naming a different unit than the filing (AREA-11), or a code the codebook
// now derives differently after a padding / type-code / prefix edit (CB-6).
// Nothing is rewritten until a person accepts it, asset by asset (or the
// shown batch) — the codebook never silently re-files the plant.

function IdentityReviewPanel({ rows, shared, book, userId, onOpen, onChanged }: {
  rows: IdentityReviewRow[];
  shared: Array<{ code: string; assets: Array<{ id: string; tag: string; archived?: boolean }> }>;
  book: Codebook; userId: string; onOpen: (assetId: string) => void; onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conflicts = rows.filter((r) => r.kind === "code_names_other_unit").length;
  // CB-10: filed without a code because the derived one is already carried.
  const taken = rows.filter((r) => r.kind === "derived_code_taken").length;
  const drift = rows.length - conflicts - taken;
  const shown = rows.slice(0, 50);
  const unitLabel = (code: string | null) => (code ? book.units.find((u) => u.code === code)?.label ?? null : null);

  const apply = async (fixes: Array<{ assetId: string; patch: { unit_code?: string; code?: string } }>) => {
    setBusy(true); setError(null);
    let done = 0;
    const failed: string[] = [];
    for (const f of fixes) {
      try { await updateAsset(f.assetId, f.patch, userId); done += 1; }
      catch (e) { failed.push((e as Error).message); }
    }
    setBusy(false);
    if (failed.length > 0) setError(`${done} of ${fixes.length} updated — ${failed[0]}${failed.length > 1 ? ` (+${failed.length - 1} more)` : ""}`);
    if (done > 0) onChanged();
  };

  return (
    <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50/60 px-3.5 py-3">
      <button type="button" onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-2 text-left">
        <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
        <span className="text-xs font-black text-[var(--color-text)] flex-1">
          Identity review — {conflicts > 0 ? `${conflicts} site code${conflicts === 1 ? "" : "s"} naming a different unit than the filing` : ""}
          {conflicts > 0 && drift > 0 ? " · " : ""}
          {drift > 0 ? `${drift} code${drift === 1 ? "" : "s"} the codebook now derives differently` : ""}
          {(conflicts > 0 || drift > 0) && taken > 0 ? " · " : ""}
          {taken > 0 ? `${taken} asset${taken === 1 ? "" : "s"} without a site code (the derived one is already carried)` : ""}
          {(conflicts > 0 || drift > 0 || taken > 0) && shared.length > 0 ? " · " : ""}
          {shared.length > 0 ? `${shared.length} site code${shared.length === 1 ? "" : "s"} carried by more than one asset` : ""}
        </span>
        <ChevronDown className={`w-4 h-4 text-rose-500 transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && (
        <div className="mt-2 space-y-1.5">
          <p className="text-[11px] text-[var(--color-text-muted)]">
            Codes are frozen when they are written; nothing here changes until you accept it.
          </p>
          {shared.map((g) => (
            <div key={`shared-${g.code}`} className="flex items-center gap-2 flex-wrap bg-[var(--color-surface)] border border-rose-300 rounded-lg px-2.5 py-1.5 text-[11px]">
              <span className="font-mono font-black text-rose-800">{g.code}</span>
              <span className="text-[var(--color-text-muted)]">one site code on {g.assets.length} assets — give each its own:</span>
              {g.assets.map((a) => (
                <button key={a.id} type="button" onClick={() => onOpen(a.id)}
                  title={a.archived ? "Archived — still holds the code; the unique index counts it" : undefined}
                  className="px-2 py-0.5 rounded border border-[var(--color-border-strong)] font-mono font-bold hover:bg-[var(--color-surface-2)]">
                  {a.tag}{a.archived ? <span className="ml-1 font-sans font-normal text-[var(--color-text-faint)]">(archived)</span> : null}
                </button>
              ))}
            </div>
          ))}
          {shown.map((r) => (
            <div key={r.assetId} className="flex items-center gap-2 flex-wrap bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg px-2.5 py-1.5 text-[11px]">
              <span className="font-mono font-black w-20 shrink-0">{r.tag}</span>
              <span className="flex-1 min-w-[12rem] text-[var(--color-text-muted)]">
                {r.kind === "code_names_other_unit"
                  ? <>code <b className="font-mono">{r.code}</b> names unit <b className="font-mono">{r.codeUnit}</b>{unitLabel(r.codeUnit) ? ` (${unitLabel(r.codeUnit)})` : ""}; filed under <b className="font-mono">{r.unitCode}</b></>
                  : r.kind === "derived_code_taken"
                    ? <>no site code — the codebook derives <b className="font-mono">{r.derivedCode}</b>, which <b className="font-mono">{r.heldBy?.tag}</b>{r.heldBy?.archived ? " (archived)" : ""} already carries; give this one its own code</>
                    : <>code <b className="font-mono">{r.code}</b>; the codebook now derives <b className="font-mono">{r.derivedCode}</b></>}
              </span>
              {r.kind === "derived_code_taken" && (
                <button type="button" onClick={() => onOpen(r.assetId)}
                  className="px-2 py-0.5 rounded border border-[var(--color-border-strong)] font-bold hover:bg-[var(--color-surface-2)]">
                  Open — set its code
                </button>
              )}
              {r.kind === "code_names_other_unit" && r.codeUnit && (
                <button type="button" disabled={busy} onClick={() => void apply([{ assetId: r.assetId, patch: { unit_code: r.codeUnit! } }])}
                  className="px-2 py-0.5 rounded border border-[var(--color-border-strong)] font-bold hover:bg-[var(--color-surface-2)]">
                  Keep the code — file under {r.codeUnit}
                </button>
              )}
              {r.derivedCode && r.kind !== "derived_code_taken" && (
                <button type="button" disabled={busy} onClick={() => void apply([{ assetId: r.assetId, patch: { code: r.derivedCode! } }])}
                  className="px-2 py-0.5 rounded border border-[var(--color-border-strong)] font-bold hover:bg-[var(--color-surface-2)]">
                  {r.kind === "code_names_other_unit" ? "Keep the filing — code" : "Re-derive —"} <span className="font-mono">{r.derivedCode}</span>
                </button>
              )}
            </div>
          ))}
          {rows.length > shown.length && (
            <div className="text-[10px] text-[var(--color-text-faint)]">Showing the first {shown.length} of {rows.length}.</div>
          )}
          {drift > 1 && (
            <button type="button" disabled={busy}
              onClick={() => void apply(shown.filter((r) => r.kind === "code_rederives" && r.derivedCode).map((r) => ({ assetId: r.assetId, patch: { code: r.derivedCode! } })))}
              className="inline-flex items-center gap-1.5 text-[11px] font-black text-white bg-rose-600 hover:bg-rose-500 rounded-lg px-2.5 py-1 disabled:opacity-50">
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
              Re-derive the {Math.min(drift, shown.filter((r) => r.kind === "code_rederives").length)} codes shown
            </button>
          )}
          {error && <div className="text-[11px] text-rose-700">{error}</div>}
        </div>
      )}
    </div>
  );
}

// ─── Discovered equipment (BR-8) ────────────────────────────
//
// The drawing sweep records where every discovered asset came from
// (origin 'drawing', discovered_from {documentId, pages}); this is the one
// screen that reads it: which drawing, which pages, and a bulk way to vouch
// for the good rows (origin → 'manual'; the provenance stays) or archive the
// junk (the writer tier's reversible removal; deleting is a controller act).

function DiscoveredReviewPanel({ assets, userId, onChanged }: {
  assets: Asset[]; userId: string; onChanged: () => void;
}) {
  const discovered = useMemo(() => assets.filter((a) => a.origin === "drawing"), [assets]);
  const [docs, setDocs] = useState<Map<string, { number: string | null; title: string | null; libraryId: string | null }>>(new Map());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = discovered.slice(0, 100);
  const docIdsKey = useMemo(() => [...new Set(shown
    .map((a) => String((a.discovered_from as { documentId?: unknown } | null)?.documentId ?? ""))
    .filter(Boolean))].sort().join(","), [shown]);

  useEffect(() => {
    let alive = true;
    const ids = docIdsKey ? docIdsKey.split(",") : [];
    if (ids.length === 0) return;
    void supabase.from("documents").select("id, document_number, title, library_id").in("id", ids)
      .then(({ data }) => {
        if (!alive) return;
        setDocs(new Map(((data ?? []) as Array<{ id: string; document_number: string | null; title: string | null; library_id: string | null }>)
          .map((d) => [d.id, { number: d.document_number, title: d.title, libraryId: d.library_id }])));
      });
    return () => { alive = false; };
  }, [docIdsKey]);

  const act = async (verb: "confirm" | "archive") => {
    const ids = [...picked];
    if (ids.length === 0) return;
    if (verb === "archive" && !(await appConfirm({ message: `Archive ${ids.length} discovered asset${ids.length === 1 ? "" : "s"}? They leave the registry views and can be restored.`, confirmLabel: "Archive" }))) return;
    setBusy(true); setError(null);
    let done = 0;
    const failed: string[] = [];
    for (const id of ids) {
      try {
        if (verb === "confirm") await updateAsset(id, { origin: "manual" }, userId);
        else await archiveAsset(id, userId);
        done += 1;
      } catch (e) { failed.push((e as Error).message); }
    }
    setBusy(false);
    setPicked(new Set());
    if (failed.length > 0) setError(`${done} of ${ids.length} done — ${failed[0]}`);
    if (done > 0) onChanged();
  };

  if (discovered.length === 0) return null;
  const allShownPicked = shown.every((a) => picked.has(a.id));

  return (
    <div className="mb-4 rounded-xl border border-sky-200 bg-sky-50/60 px-3.5 py-3 space-y-2">
      <div className="text-xs font-black text-[var(--color-text)]">
        {discovered.length} asset{discovered.length === 1 ? "" : "s"} created by the drawing sweep, not yet vouched for by a person
      </div>
      <p className="text-[11px] text-[var(--color-text-muted)]">
        Confirm the real equipment (it stops being flagged; where it came from stays recorded) and archive what the sweep misread.
      </p>
      <div className="max-h-72 overflow-y-auto space-y-1">
        <label className="flex items-center gap-2 text-[10px] font-bold text-[var(--color-text-muted)] px-1">
          <input type="checkbox" checked={allShownPicked}
            onChange={() => setPicked(allShownPicked ? new Set() : new Set(shown.map((a) => a.id)))} />
          Select all {shown.length} shown
        </label>
        {shown.map((a) => {
          const from = (a.discovered_from ?? {}) as { documentId?: string; pages?: number[] };
          const doc = from.documentId ? docs.get(from.documentId) : undefined;
          return (
            <label key={a.id} className="flex items-center gap-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg px-2.5 py-1.5 text-[11px] cursor-pointer">
              <input type="checkbox" checked={picked.has(a.id)}
                onChange={() => setPicked((prev) => { const n = new Set(prev); if (n.has(a.id)) n.delete(a.id); else n.add(a.id); return n; })} />
              <span className="font-mono font-black w-20 shrink-0">{a.tag}</span>
              <span className="flex-1 min-w-0 truncate text-[var(--color-text-muted)]">
                {from.documentId ? (
                  <Link href={doc?.libraryId ? `/documents/${doc.libraryId}?doc=${from.documentId}` : "/documents"} onClick={(e) => e.stopPropagation()}
                    className="font-bold text-sky-800 hover:underline">
                    {doc?.number || doc?.title || "source drawing"}
                  </Link>
                ) : "source drawing not recorded"}
                {Array.isArray(from.pages) && from.pages.length > 0 ? ` · page${from.pages.length === 1 ? "" : "s"} ${from.pages.slice(0, 6).join(", ")}${from.pages.length > 6 ? "…" : ""}` : ""}
              </span>
            </label>
          );
        })}
        {discovered.length > shown.length && (
          <div className="text-[10px] text-[var(--color-text-faint)]">Showing the first {shown.length} of {discovered.length}.</div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button type="button" disabled={busy || picked.size === 0} onClick={() => void act("confirm")}
          className="inline-flex items-center gap-1.5 text-[11px] font-black text-white bg-sky-700 hover:bg-sky-600 rounded-lg px-2.5 py-1 disabled:opacity-50">
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} Confirm {picked.size || ""}
        </button>
        <button type="button" disabled={busy || picked.size === 0} onClick={() => void act("archive")}
          className="inline-flex items-center gap-1.5 text-[11px] font-black text-amber-800 bg-[var(--color-surface)] border border-amber-300 hover:bg-amber-50 rounded-lg px-2.5 py-1 disabled:opacity-50">
          <Trash2 className="w-3 h-3" /> Archive {picked.size || ""}
        </button>
        {error && <span className="text-[11px] text-rose-700">{error}</span>}
      </div>
    </div>
  );
}

// ─── Documents referencing the unit's equipment ────────────

function UnitDocuments({ assetIds, assets }: { assetIds: string[]; assets: Asset[] }) {
  const [rows, setRows] = useState<Array<{
    documentId: string; documentNumber: string | null; title: string | null;
    libraryId: string; tags: string[];
  }> | null>(null);
  const [expanded, setExpanded] = useState(false);
  const idsKey = useMemo(() => [...assetIds].sort().join(","), [assetIds]);

  useEffect(() => {
    let alive = true;
    setRows(null);
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
      .catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
    // assets is derived from the same filter as assetIds — idsKey covers both.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  if (rows === null) {
    return (
      <div className="text-[11px] text-[var(--color-text-faint)] italic flex items-center gap-1.5">
        <Loader2 className="w-3 h-3 animate-spin" /> Finding documents that reference this unit&apos;s equipment…
      </div>
    );
  }
  if (rows.length === 0) return null;
  const shown = expanded ? rows : rows.slice(0, 12);

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <FileText className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
        <span className="text-xs font-black text-[var(--color-text)]">Documents referencing this unit&apos;s equipment</span>
        <span className="text-[10px] font-bold text-[var(--color-text-muted)] bg-[var(--color-surface-2)] rounded-full px-1.5">{rows.length}</span>
      </div>
      <ul className="rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)] bg-[var(--color-surface)]">
        {shown.map((d) => (
          <li key={d.documentId}>
            <Link href={`/documents/${d.libraryId}?doc=${d.documentId}`}
              className="flex items-center gap-3 px-3.5 py-2.5 hover:bg-[var(--color-surface-2)]/70 transition-colors">
              <FileText className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="text-xs font-bold text-[var(--color-text)]">{d.documentNumber || "(no number)"}</span>
                {d.title && <span className="text-xs text-[var(--color-text-muted)]"> · {d.title}</span>}
              </div>
              <div className="flex gap-1 flex-wrap justify-end max-w-[45%]">
                {d.tags.slice(0, 6).map((t) => (
                  <span key={t} className="text-[9px] font-mono font-bold text-purple-700 bg-purple-50 border border-purple-200 rounded px-1 py-0.5">{t}</span>
                ))}
                {d.tags.length > 6 && <span className="text-[9px] font-bold text-[var(--color-text-faint)]">+{d.tags.length - 6}</span>}
              </div>
            </Link>
          </li>
        ))}
      </ul>
      {rows.length > 12 && (
        <button onClick={() => setExpanded((v) => !v)}
          className="mt-1.5 text-[11px] font-bold text-[var(--color-accent)] hover:underline">
          {expanded ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  );
}

// ─── Asset card ────────────────────────────────────────────

function AssetCard({
  asset, type, photoCount, coverUrl, book, onClick, onEdit, onAddPhotos,
}: {
  asset: Asset; type?: AssetType; photoCount: number; coverUrl?: string | null; book: Codebook;
  onClick: () => void; onEdit?: () => void; onAddPhotos?: () => void;
}) {
  // AREA-11: the code/unit contradiction, visible on the card itself.
  const clash = codeUnitConflict(asset, book);

  return (
    <div className="group bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm hover:shadow-lg hover:border-[var(--color-border-strong)] transition-all overflow-hidden flex flex-col">
      {/* Cover area */}
      <button onClick={onClick} className="block aspect-[4/3] w-full relative bg-gradient-to-br from-slate-100 to-slate-200 overflow-hidden">
        {coverUrl ? (
          <>
            <SignedImg path={coverUrl} alt={asset.tag} className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
            {photoCount > 1 && (
              <div className="absolute top-2 right-2 inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-black/60 backdrop-blur-sm text-white text-[10px] font-bold">
                <Camera className="w-3 h-3" /> {photoCount}
              </div>
            )}
          </>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="p-5 rounded-2xl bg-white/60 backdrop-blur border border-white">
              <ImageIcon className="w-8 h-8 text-[var(--color-text-faint)]" />
            </div>
          </div>
        )}
      </button>
      {/* Info */}
      <div className="p-3 flex-1 flex flex-col">
        <div className="flex items-center gap-2 mb-1">
          <button onClick={onClick} className="text-sm font-black text-[var(--color-text)] hover:text-purple-700 truncate flex-1 text-left">
            {asset.tag}
          </button>
          {type && (
            <span className="text-[9px] font-black uppercase tracking-widest bg-[var(--color-surface-2)] text-[var(--color-text-muted)] px-1.5 py-0.5 rounded shrink-0">
              {type.name}
            </span>
          )}
        </div>
        {(asset.origin === "drawing" || clash) && (
          <div className="flex gap-1 flex-wrap mb-1">
            {asset.origin === "drawing" && (
              <span title="Created by the drawing sweep — not yet vouched for by a person"
                className="text-[9px] font-black uppercase tracking-wider text-sky-800 bg-sky-50 border border-sky-200 rounded px-1.5 py-0.5">
                Discovered
              </span>
            )}
            {clash && (
              <span title={`Site code ${asset.code} names unit ${clash.codeUnit}; the asset is filed under ${clash.unitCode}`}
                className="text-[9px] font-black uppercase tracking-wider text-rose-800 bg-rose-50 border border-rose-200 rounded px-1.5 py-0.5">
                Code says {clash.codeUnit} ≠ {clash.unitCode}
              </span>
            )}
          </div>
        )}
        {asset.description && (
          <div className="text-[11px] text-[var(--color-text-muted)] line-clamp-2 mb-1">{asset.description}</div>
        )}
        {asset.location && (
          <div className="text-[10px] text-[var(--color-text-faint)] flex items-center gap-1 truncate">
            <MapPin className="w-3 h-3" /> {asset.location}
          </div>
        )}
        <div className="mt-2 pt-2 border-t border-[var(--color-border)] flex items-center justify-between">
          <div className="text-[10px] font-bold text-[var(--color-text-muted)]">
            {photoCount === 0 ? (
              <span className="text-amber-700 inline-flex items-center gap-1"><AlertTriangle className="w-2.5 h-2.5" /> No photos</span>
            ) : (
              <span className="inline-flex items-center gap-1 text-blue-700"><Camera className="w-2.5 h-2.5" /> {photoCount} photo{photoCount === 1 ? "" : "s"}</span>
            )}
          </div>
          {/* Always visible — a hover-only edit button doesn't exist on
              touchscreens, and "how do I edit this?" should never be a
              puzzle. An uncategorized asset gets a LABELED door out of
              limbo, not a pencil icon to decode. */}
          <div className="flex items-center gap-1 opacity-70 group-hover:opacity-100 transition-opacity">
            {!type && onEdit && (
              <button onClick={onEdit}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-300 text-[9px] font-black uppercase tracking-wider hover:bg-amber-200 dark:hover:bg-amber-900">
                <Tag className="w-2.5 h-2.5" /> Categorize
              </button>
            )}
            {onAddPhotos && (
              <button onClick={onAddPhotos} title="Add photos" className="p-1 text-[var(--color-text-faint)] hover:text-emerald-600 hover:bg-emerald-50 rounded">
                <Camera className="w-3.5 h-3.5" />
              </button>
            )}
            {onEdit && (
              <button onClick={onEdit} title="Edit asset" className="p-1 text-[var(--color-text-faint)] hover:text-purple-700 hover:bg-purple-50 rounded">
                <Edit3 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Empty state ────────────────────────────────────────────

function EmptyState({ onCreate, hasAny }: { onCreate?: () => void; hasAny: boolean }) {
  return (
    <div className="bg-[var(--color-surface)] border border-dashed border-[var(--color-border-strong)] rounded-2xl p-12 text-center">
      <div className="p-5 rounded-2xl bg-purple-50 w-fit mx-auto mb-4 border border-purple-100">
        <Tag className="w-10 h-10 text-purple-500" />
      </div>
      <h3 className="text-base font-black text-[var(--color-text)] mb-1">
        {hasAny ? "No matches" : "No assets yet"}
      </h3>
      <p className="text-sm text-[var(--color-text-muted)] max-w-md mx-auto mb-4">
        {hasAny
          ? "Try a different search or clear the filters."
          : "Create your first asset — equipment, instrument, valve, anything taggable. Once an asset exists, its tag becomes a clickable chip everywhere you reference it."}
      </p>
      {!hasAny && onCreate && (
        <button onClick={onCreate} className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-sm font-black shadow-lg">
          <Plus className="w-4 h-4" /> Create first asset
        </button>
      )}
    </div>
  );
}

// ─── Edit / Create drawer ──────────────────────────────────

function AssetEditDrawer({
  asset, preset, orgId, userId, userEmail, types, canEdit, canDelete, book,
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
  /** AREA-1 / IRLS-5: hard delete is the controller tier; the writer tier archives. */
  canDelete: boolean;
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
  // AREA-11: the site code carries its unit. When the filing and the code
  // disagree, say so BEFORE saving, with both ways out — never keep both
  // silently.
  const codeUnit = siteCode.trim() ? (codeToTag(siteCode.trim(), book)?.unitCode ?? null) : null;
  const identityClash = !!(unitCode && codeUnit && codeUnit !== unitCode);
  const derivedForUnit = identityClash ? tagToCode(tag, unitCode, book) : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasTagConflict, setHasTagConflict] = useState(false);
  const [photos, setPhotos] = useState<AssetPhoto[]>([]);
  const [linkedDocs, setLinkedDocs] = useState<AssetDocumentRow[] | null>(null);
  const [docPickerOpen, setDocPickerOpen] = useState(false);

  const refreshDocs = useCallback(() => {
    if (!asset) return;
    getDocumentsForAssetHydrated(asset.id).then(setLinkedDocs).catch(() => setLinkedDocs([]));
  }, [asset]);

  useEffect(() => {
    if (!asset) return;
    listAssetPhotos(asset.id).then(setPhotos).catch(() => {});
    refreshDocs();
  }, [asset, refreshDocs]);

  const linkDocument = async (documentId: string) => {
    if (!asset) return;
    const { error: e } = await supabase.from("document_assets").insert({
      org_id: orgId, document_id: documentId, asset_id: asset.id,
      tag_text: asset.tag, source: "manual",
    });
    if (e && e.code !== "23505") { setError(e.message); return; }
    setDocPickerOpen(false);
    refreshDocs();
  };

  const unlinkDocument = async (documentId: string) => {
    if (!asset) return;
    const ok = await appConfirm({
      title: "Unlink this document?",
      message: "The document stays; only its link to this equipment is removed. A future sweep can re-link it if the document still carries the tag.",
      confirmLabel: "Unlink",
    });
    if (!ok) return;
    await supabase.from("document_assets").delete()
      .eq("document_id", documentId).eq("asset_id", asset.id);
    refreshDocs();
  };

  const save = async () => {
    if (!tag.trim()) { setError("Tag required"); return; }
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
        onSaved();
        // Stay open so user can immediately upload photos
        // Replace `asset` in url? Simplification: just close.
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
        onClose();
      }
    } catch (e) {
      const friendly = translatePostgresError(e, { entity: "asset", field: "tag" });
      setError(`${friendly.heading} — ${friendly.message}`);
    }
    finally { setBusy(false); }
  };

  const onDelete = async () => {
    if (!asset) return;
    if (!(await appConfirm({ message: `Delete asset "${asset.tag}" and all its photos, aliases and document links? This can't be undone — the deletion is recorded in the audit log.`, tone: "danger" }))) return;
    setBusy(true);
    try {
      await deleteAsset(asset.id);
      invalidateAssetCache();
      onSaved();
      onClose();
    } catch (e) {
      const f = translatePostgresError(e, { entity: "asset" });
      setError(`${f.heading} — ${f.message}`);
      setBusy(false);
    }
  };

  // IRLS-5: the writer tier's removal — reversible; photos, aliases and
  // document links stay.
  const onArchive = async () => {
    if (!asset) return;
    if (!(await appConfirm({ message: `Archive "${asset.tag}"? It leaves the registry views but keeps its photos, aliases and document links, and can be restored.`, confirmLabel: "Archive" }))) return;
    setBusy(true);
    try {
      await archiveAsset(asset.id, userId);
      invalidateAssetCache();
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const markPhotoStatus = async (p: AssetPhoto, status: PhotoStatus) => {
    try {
      await updatePhoto(p.id, { status }, userId);
      setPhotos((prev) => prev.map((x) => x.id === p.id ? { ...x, status } : x));
    } catch (e) { await appAlert({ message: (e as Error).message, tone: "danger" }); }
  };

  const onDeletePhoto = async (p: AssetPhoto) => {
    if (!(await appConfirm({ message: "Remove this photo?", tone: "danger" }))) return;
    try {
      await deletePhoto(p.id);
      setPhotos((prev) => prev.filter((x) => x.id !== p.id));
    } catch (e) { await appAlert({ message: (e as Error).message, tone: "danger" }); }
  };

  return (
    <div className="fixed inset-0 z-[400] flex" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" />
      <div onClick={(e) => e.stopPropagation()} className="relative ml-auto w-full max-w-xl bg-[var(--color-surface)] shadow-2xl border-l border-[var(--color-border)] flex flex-col h-dvh">
        <div className="px-5 py-3 border-b border-[var(--color-border)] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 bg-purple-100 rounded-lg"><Tag className="w-4 h-4 text-purple-700" /></div>
            <div>
              <div className="text-sm font-black text-[var(--color-text)]">
                {isCreate ? "Create asset" : `Edit ${asset?.tag}`}
              </div>
              <div className="text-[11px] text-[var(--color-text-muted)]">Canonical record + photo gallery</div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {!isCreate && asset && userId && (
              <WatchButton
                orgId={orgId}
                userId={userId}
                resourceType="asset"
                resourceId={asset.id}
                size="sm"
              />
            )}
            <button onClick={onClose} disabled={busy} className="p-1.5 rounded text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-5 space-y-5">
          {/* Form */}
          <div className="space-y-3">
            <div>
              <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">Tag *</label>
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
                className="font-mono mt-1"
              />
              {tag && (
                <div className="text-[10px] text-[var(--color-text-muted)] mt-1">Normalized: <span className="font-mono">{normalizeTag(tag)}</span></div>
              )}
            </div>
            <div>
              <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">Type</label>
              <select value={typeId} onChange={(e) => setTypeId(e.target.value)} disabled={!canEdit || busy} className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm">
                <option value="">— Untyped —</option>
                {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">Description</label>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} disabled={!canEdit || busy} rows={2} placeholder="What this thing is" className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm resize-y" />
            </div>
            <div>
              <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">Location</label>
              <input value={location} onChange={(e) => setLocation(e.target.value)} disabled={!canEdit || busy} placeholder="e.g. Unit 200 cold side" className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm" />
            </div>
            {book.units.length > 0 && (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">Operating unit</label>
                  <select value={unitCode} onChange={(e) => setUnitCode(e.target.value)} disabled={!canEdit || busy}
                    className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)]">
                    <option value="">—</option>
                    {book.units.map((u) => <option key={u.code} value={u.code}>{u.code} — {u.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">Site code</label>
                  <input value={siteCode} onChange={(e) => setSiteCode(e.target.value)} disabled={!canEdit || busy}
                    placeholder="auto — e.g. 2030.22" className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm font-mono" />
                </div>
                {identityClash && (
                  <div className="col-span-2 rounded-lg border border-rose-200 bg-rose-50 p-2 text-[11px] text-rose-800 space-y-1.5">
                    <div>
                      Site code <b className="font-mono">{siteCode.trim()}</b> names unit <b className="font-mono">{codeUnit}</b>
                      {book.units.find((u) => u.code === codeUnit)?.label ? ` (${book.units.find((u) => u.code === codeUnit)?.label})` : ""},
                      {" "}but this asset is filed under <b className="font-mono">{unitCode}</b>. Saving as-is keeps both — the QR label and doc packs would say one area, the registry another.
                    </div>
                    {canEdit && (
                      <div className="flex gap-1.5 flex-wrap">
                        {derivedForUnit && (
                          <button type="button" onClick={() => setSiteCode(derivedForUnit)} disabled={busy}
                            className="px-2 py-1 rounded-md bg-[var(--color-surface)] border border-rose-300 font-bold hover:bg-rose-100">
                            Re-derive the code → <span className="font-mono">{derivedForUnit}</span>
                          </button>
                        )}
                        <button type="button" onClick={() => codeUnit && setUnitCode(codeUnit)} disabled={busy}
                          className="px-2 py-1 rounded-md bg-[var(--color-surface)] border border-rose-300 font-bold hover:bg-rose-100">
                          Keep the code — file under <span className="font-mono">{codeUnit}</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            <div className="hidden">
            </div>
          </div>

          {/* Photos section (edit mode only) */}
          {!isCreate && asset && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">
                  Photos ({photos.length})
                </div>
                <div className="flex items-center gap-1.5">
                  {photos.length > 0 && (
                    <button onClick={() => onOpenCarousel(asset)} className="inline-flex items-center gap-1 text-[11px] font-bold text-blue-700 hover:text-blue-800">
                      <ImageIcon className="w-3 h-3" /> Open carousel
                    </button>
                  )}
                  {canEdit && (
                    <button onClick={() => onOpenUploader(asset)} className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 hover:text-emerald-800">
                      <Camera className="w-3 h-3" /> Add photos
                    </button>
                  )}
                </div>
              </div>
              {photos.length === 0 ? (
                <div className="text-center text-xs text-[var(--color-text-faint)] italic py-6 border border-dashed border-[var(--color-border)] rounded-lg">
                  No photos yet.
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {photos.map((p) => {
                    const age = photoAgeCategory(p.captured_at);
                    return (
                      <div key={p.id} className="relative group rounded-lg overflow-hidden border border-[var(--color-border)] aspect-square bg-[var(--color-surface-2)]">
                        <SignedImg path={p.file_url} alt={p.caption || ""} className="w-full h-full object-cover" />
                        <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent p-1.5">
                          <div className="text-[9px] text-white font-mono flex items-center gap-1">
                            <span className={`w-1.5 h-1.5 rounded-full ${
                              age.category === "fresh" ? "bg-emerald-400" :
                              age.category === "aging" ? "bg-amber-400" :
                              age.category === "stale" ? "bg-red-400" : "bg-slate-400"
                            }`} />
                            {p.captured_at ? new Date(p.captured_at).toLocaleDateString() : "no date"}
                          </div>
                        </div>
                        {p.status !== "current" && (
                          <div className={`absolute top-1 left-1 text-[8px] font-black uppercase px-1 py-0.5 rounded ${
                            p.status === "needs_verification" ? "bg-amber-500 text-white" : "bg-red-500 text-white"
                          }`}>
                            {p.status === "needs_verification" ? "Verify" : "Old"}
                          </div>
                        )}
                        {canEdit && (
                          <div className="absolute top-1 right-1 flex flex-col gap-1 opacity-60 sm:opacity-0 group-hover:opacity-100 transition-opacity">
                            <button onClick={() => markPhotoStatus(p, p.status === "current" ? "needs_verification" : "current")} title="Toggle verification" className="p-1 bg-white/90 rounded hover:bg-[var(--color-surface)]">
                              <AlertTriangle className="w-3 h-3 text-amber-600" />
                            </button>
                            {canDelete && (
                              <button onClick={() => onDeletePhoto(p)} title="Delete photo" className="p-1 bg-white/90 rounded hover:bg-[var(--color-surface)]">
                                <Trash2 className="w-3 h-3 text-red-600" />
                              </button>
                            )}
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
              <div className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest mb-2 flex items-center gap-1.5">
                <FileText className="w-3 h-3" /> Linked documents
                {linkedDocs && <span className="text-[var(--color-text-faint)] font-bold">({linkedDocs.length})</span>}
                <span className="flex-1" />
                <Link href={`/graph?focus=${encodeURIComponent(`asset:${asset.id}`)}`}
                  className="inline-flex items-center gap-1 normal-case tracking-normal text-[10px] font-black text-violet-700 hover:text-violet-600">
                  <Waypoints className="w-3 h-3" /> See on graph
                </Link>
                {canEdit && (
                  <button type="button" onClick={() => setDocPickerOpen(true)}
                    className="inline-flex items-center gap-1 normal-case tracking-normal px-2 py-1 rounded-md border border-[var(--color-border-strong)] text-[10px] font-black text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)]">
                    <Plus className="w-3 h-3" /> Link document
                  </button>
                )}
              </div>
              {linkedDocs === null ? (
                <div className="text-[11px] text-[var(--color-text-faint)] italic py-2">Loading…</div>
              ) : linkedDocs.length === 0 ? (
                <div className="text-center text-xs text-[var(--color-text-faint)] italic py-4 border border-dashed border-[var(--color-border)] rounded-lg">
                  No documents reference this asset yet.
                </div>
              ) : (
                <ul className="rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)] max-h-56 overflow-auto">
                  {linkedDocs.map((d) => (
                    <li key={d.documentId} className="relative group/docrow">
                      {canEdit && (
                        <button type="button" title="Unlink from this equipment"
                          onClick={() => void unlinkDocument(d.documentId)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 z-10 p-1.5 rounded-md text-[var(--color-text-faint)] hover:text-rose-600 opacity-0 group-hover/docrow:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <Link
                        href={`/documents/${d.libraryId}?doc=${d.documentId}`}
                        onClick={onClose}
                        className="flex items-center gap-2 px-3 py-2 pr-9 hover:bg-[var(--color-surface-2)]"
                      >
                        <FileText className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-bold text-[var(--color-text)] truncate">
                            {d.documentNumber || "(no number)"} {d.title && <span className="font-normal text-[var(--color-text-muted)]">· {d.title}</span>}
                          </div>
                          {d.tagText && (
                            <div className="text-[10px] font-mono text-[var(--color-text-faint)] truncate">tag: {d.tagText}</div>
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
              <div className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest mb-2">Quick notes</div>
              <QuickNoteComposer
                orgId={orgId}
                userId={userId}
                userEmail={userEmail}
                scope={{ assetId: asset.id }}
              />
            </div>
          )}

          {error && (
            <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700 flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex items-center justify-between shrink-0">
          {!isCreate && canDelete ? (
            <button onClick={onDelete} disabled={busy} className="text-xs font-bold text-red-600 hover:text-red-700 inline-flex items-center gap-1">
              <Trash2 className="w-3 h-3" /> Delete asset
            </button>
          ) : !isCreate && canEdit ? (
            <button onClick={onArchive} disabled={busy} title="Deleting equipment is Admin / Doc Control only — archiving keeps its history"
              className="text-xs font-bold text-amber-700 hover:text-amber-800 inline-flex items-center gap-1">
              <Trash2 className="w-3 h-3" /> Archive asset
            </button>
          ) : <div />}
          <div className="flex items-center gap-2">
            <button onClick={onClose} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)]">Cancel</button>
            {canEdit && (
              <button onClick={save} disabled={busy || !tag.trim() || hasTagConflict} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-black text-white bg-purple-600 hover:bg-purple-500 disabled:opacity-50 shadow">
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                {isCreate ? "Create & add photos" : "Save"}
              </button>
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
    if (!c) { setError("Give the area its number/code (e.g. 20)."); return; }
    // CB-3: the shared shape guard — a unit code is digits.
    const shape = codeProblem("unit", c);
    if (shape) { setError(shape); return; }
    if (existingCodes.includes(c)) { setError(`Unit ${c} already exists.`); return; }
    setBusy(true); setError(null);
    const { error: e } = await supabase.from("codebook_entries").insert({
      org_id: orgId, kind: "unit", code: c, label: label.trim() || `Unit ${c}`,
      meta: {}, sort: existingCodes.length, origin: "manual", created_by: userId,
    });
    setBusy(false);
    if (e) {
      setError(e.code === "42501" ? "Only Admin or Doc Control can add operating areas to the Site Codebook."
        : e.code === "23514" ? "Unit codes are digits — the database refused a letter code." : e.message);
      return;
    }
    onCreated(c);
  };

  return (
    <div className="fixed inset-0 z-[700] flex items-start justify-center bg-black/50 pt-[14vh] p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <Factory className="w-4 h-4 text-purple-600" />
          <div className="flex-1">
            <div className="text-sm font-black text-[var(--color-text)]">New operating area</div>
            <div className="text-[11px] text-[var(--color-text-muted)]">
              Written into your Site Codebook — the one place the whole app decodes units from.
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-[var(--color-text-faint)] hover:text-[var(--color-text)]"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex items-center gap-2">
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code (20)"
            className="w-28 px-3 py-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-sm font-mono" />
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name (Crude Unit)"
            className="flex-1 px-3 py-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-sm" />
        </div>
        {error && <div className="text-[11px] text-rose-600">{error}</div>}
        <div className="flex items-center justify-between gap-2">
          <Link href="/admin/codebook" className="text-[10px] font-bold text-violet-700 hover:underline inline-flex items-center gap-1">
            <BookMarkedIcon className="w-3 h-3" /> Full codebook (AI import, decoder)
          </Link>
          <button onClick={() => void save()} disabled={busy}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-black text-white bg-purple-600 hover:bg-purple-500 disabled:opacity-50">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Create area
          </button>
        </div>
      </div>
    </div>
  );
}

function AddCategoryModal({ orgId, userId, existingTypes, onClose, onCreated }: {
  orgId: string;
  userId: string;
  existingTypes: Codebook["equipmentTypes"];
  onClose: () => void;
  onCreated: () => void;
}) {
  const existingTypeCodes = existingTypes.map((t) => t.code);
  const [name, setName] = useState("");
  const [prefixes, setPrefixes] = useState("");
  const [typeCode, setTypeCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const n = name.trim();
    if (!n) { setError("Name the category (Pump, Exchanger…)."); return; }
    // Teaching moment: a code (with or without prefixes) writes a real Site
    // Codebook entry — it must never be swallowed silently. Validate BEFORE
    // creating anything so a fixable problem doesn't half-save.
    const px = prefixes.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
    const tc = typeCode.trim();
    if (px.length > 0 && !tc) {
      setError("Prefixes need a code to live under — add the equipment-type code (e.g. 02).");
      return;
    }
    if (tc && existingTypeCodes.some((c) => c.trim().toLowerCase() === tc.toLowerCase())) {
      setError(`Code ${tc} is already used by another equipment type in the Site Codebook — pick a different code or leave it blank.`);
      return;
    }
    // CB-3: an equipment-type code is digits (it is composed into site codes).
    const shape = tc ? codeProblem("equipment_type", tc) : null;
    if (shape) { setError(shape); return; }
    // CB-8: one prefix, one equipment type — a second claimant leaves every
    // tag with that prefix uncategorized.
    const clash = tc ? prefixClaimsElsewhere(existingTypes, { code: tc, tagPrefixes: px }) : [];
    if (clash.length > 0) {
      setError(`Prefix ${clash[0].prefix}- is already claimed by ${clash[0].code} ${clash[0].label} in the Site Codebook — two types on one prefix leave every ${clash[0].prefix}- tag uncategorized.`);
      return;
    }
    setBusy(true); setError(null);
    try {
      // Codebook FIRST — it's the write most likely to be refused (RLS
      // requires the controller tier by the role collection; codes collide
      // under a unique index; letter codes fail the CB-3 CHECK). Ordering it first means a refusal leaves NOTHING
      // half-created, so a retry can never mint duplicate categories.
      if (tc) {
        const { error: cbErr } = await supabase.from("codebook_entries").insert({
          org_id: orgId, kind: "equipment_type", code: tc, label: n,
          meta: { tagPrefixes: px }, sort: existingTypeCodes.length,
          origin: "manual", created_by: userId,
        });
        if (cbErr && cbErr.code === "23505") {
          setError(`Code ${tc} is already used in the Site Codebook — pick a different code or leave it blank.`);
          setBusy(false); return;
        }
        if (cbErr && cbErr.code === "42501") {
          setError("Only Admin or Doc Control can teach the Site Codebook — leave the code blank to create the category alone, or ask a controller.");
          setBusy(false); return;
        }
        if (cbErr && cbErr.code === "23514") {
          setError("Equipment-type codes are digits — the database refused a letter code.");
          setBusy(false); return;
        }
        if (cbErr) { setError(cbErr.message); setBusy(false); return; }
      }
      await createAssetType({ orgId, name: n });
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[700] flex items-start justify-center bg-black/50 pt-[14vh] p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <Tag className="w-4 h-4 text-purple-600" />
          <div className="flex-1">
            <div className="text-sm font-black text-[var(--color-text)]">New equipment category</div>
            <div className="text-[11px] text-[var(--color-text-muted)]">
              Becomes a section in every operating area. Add the tag prefix and it also teaches
              your Site Codebook — future assets categorize themselves.
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-[var(--color-text-faint)] hover:text-[var(--color-text)]"><X className="w-4 h-4" /></button>
        </div>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (Exchanger)"
          className="w-full px-3 py-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-sm" />
        <div className="flex items-center gap-2">
          <input value={prefixes} onChange={(e) => setPrefixes(e.target.value)} placeholder="Tag prefixes (E, EA) — optional"
            className="flex-1 px-3 py-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-sm font-mono" />
          <input value={typeCode} onChange={(e) => setTypeCode(e.target.value)} placeholder="Code (02)"
            className="w-24 px-3 py-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-sm font-mono" />
        </div>
        <p className="text-[10px] text-[var(--color-text-faint)]">
          No numbering system? Leave prefixes blank and organize manually — you can teach the
          codebook later and auto-categorize will catch up.
        </p>
        {error && <div className="text-[11px] text-rose-600">{error}</div>}
        <div className="flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Cancel</button>
          <button onClick={() => void save()} disabled={busy}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-black text-white bg-purple-600 hover:bg-purple-500 disabled:opacity-50">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Create category
          </button>
        </div>
      </div>
    </div>
  );
}
