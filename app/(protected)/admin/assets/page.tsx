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
import MoreMenu from "@/components/ui/MoreMenu";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { useDraft } from "@/hooks/useDraft";
import { badgeText } from "@/lib/badge";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary, heroQuiet } from "@/components/ui/PageHero";
import { bandInput, bandInputIcon, bandSelect, bandSeg, bandSegItem, plural } from "@/components/admin/band";

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

  if (!activeOrgId) return <PageShell><PageHero kicker="Operating areas" title="Operating areas" overlap={false} /><LoadingBlock what="operating areas" /></PageShell>;

  const printLabels = async () => {
    const list = filtered.slice(0, 200);
    if (list.length === 0) return;
    try {
      const { printEquipmentLabels } = await import("@/lib/physicalBridge");
      await printEquipmentLabels(list.map((a) => ({
        tag: a.tag,
        description: a.description ?? null,
        location: a.location ?? null,
      })));
    } catch (e) {
      await appAlert({ title: "Couldn't print labels", message: (e as Error).message, tone: "danger" });
    }
  };
  // Less-used tools fold into More: QR label sheets and the CSV import.
  const moreItems = [
    ...(filtered.length > 0 ? [{ icon: <QrCode className="w-4 h-4" />, label: `QR labels (${Math.min(filtered.length, 200)})`, onClick: () => void printLabels() }] : []),
    ...(canEditEquipment ? [{ icon: <Upload className="w-4 h-4" />, label: "Import CSV", onClick: () => setCsvOpen(true) }] : []),
  ];

  // The answer: how much equipment, and the one gap that matters (photos).
  const scope = unitFilter
    ? assets.filter((a) => unitFilter === "__unassigned" ? !a.unit_code : a.unit_code === unitFilter)
    : assets;
  const scopeNoPhotos = scope.reduce((n, a) => n + ((photoCounts.get(a.id) || 0) === 0 ? 1 : 0), 0);
  const answer = loading
    ? (unitFilter ? (currentUnit?.label ?? (unitFilter === "__unassigned" ? "No unit assigned" : `Unit ${unitFilter}`)) : "Operating areas")
    : error
      ? "Couldn't load the equipment."
      : unitFilter === "__unassigned"
        ? (scope.length === 0 ? "Everything is filed." : `${plural(scope.length, "piece")} of equipment need an area.`)
        : scope.length === 0
          ? (unitFilter ? "No equipment here yet." : "No equipment yet.")
          : `${plural(scope.length, "piece")} of equipment${scopeNoPhotos > 0 ? `, ${scopeNoPhotos.toLocaleString()} without photos` : ""}.`;
  const sub = loading || error ? undefined : unitFilter ? (
    <>
      {unitFilter === "__unassigned" ? "Equipment with no operating area" : <>Unit {unitFilter}{currentUnit?.label ? ` · ${currentUnit.label}` : " · not in the Site Codebook yet"}</>}
      {searchActive && <> · {filtered.length.toLocaleString()} match the filters</>}
    </>
  ) : (
    <>
      {book.units.length > 0 ? plural(book.units.length, "operating area") : "No operating areas yet"}
      {unitCounts.unassigned > 0 && <> · <span className="font-semibold text-amber-300">{unitCounts.unassigned.toLocaleString()} not in an area</span></>}
      {searchActive && <> · {filtered.length.toLocaleString()} match the filters</>}
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
    // added inside their category's section.
    <button type="button" onClick={() => setAddCategoryOpen(true)} className={heroPrimary}>
      <Plus className="w-4 h-4" /> New category
    </button>
  );

  return (
    <PageShell>
      <PageHero
        kicker={unitFilter ? <>Operating areas · {unitFilter === "__unassigned" ? "No unit" : `Unit ${unitFilter}`}</> : "Operating areas"}
        back={unitFilter ? { onClick: () => setUnitFilter(null), label: "All operating areas" } : undefined}
        title={answer}
        sub={sub}
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
        {/* Search + filters steer the whole page, so they live in the band. */}
        <div className="mt-4 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[220px]">
            <Search className={bandInputIcon} />
            <label htmlFor="equipment-search" className="sr-only">Search all equipment</label>
            <input
              id="equipment-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Find by tag (E-22), site code or description"
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
        {/* Inside a unit: the unit's pinned libraries come first. */}
        {unitFilter && (currentUnit || (unitFilter !== "__unassigned" && canEditLinks)) && (
          <Card label="This unit's libraries"
            action={canEditLinks && unitFilter !== "__unassigned" ? (
              <Link href="/admin/codebook" className="inline-flex items-center gap-1 text-[13px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                <Edit3 className="w-3.5 h-3.5" /> {currentUnit ? "Edit unit" : "Add this unit to the codebook"}
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
              <p className="text-[13px] text-[var(--color-text-muted)]">Unit {unitFilter} is on equipment but not in the Site Codebook yet. Add it there to pin its libraries.</p>
            )}
          </Card>
        )}
        {unitFilter === "__unassigned" && canEditEquipment && book.units.length > 0 && filtered.length > 0 && (
          <UnassignedAssignPanel
            assets={filtered}
            book={book}
            userId={uid || ""}
            onAssigned={() => { invalidateAssetCache(); void refresh(); }}
          />
        )}

        {/* This area's knowledge: setup path, live state, and drift review,
            so the order of operations lives ON the unit page. */}
        {currentUnit && !loading && uid && activeOrgId && (
          <AreaKnowledgePanel
            orgId={activeOrgId}
            userId={uid}
            userName={userEmail ?? "Member"}
            unit={{ code: currentUnit.code, label: currentUnit.label || `Unit ${currentUnit.code}` }}
            unitAssetIds={areaAssetIds}
          />
        )}

        {/* Grid */}
        {loading ? (
          <Card><LoadingBlock what="the equipment" rows={6} className="border-0 p-0" /></Card>
        ) : error ? (
          <Card>
            <p role="alert" className="text-[14px] text-red-700 dark:text-red-400">
              Couldn&apos;t load the equipment: {error}{" "}
              <button type="button" onClick={() => void refresh()} className="font-bold underline">Try again</button>
            </p>
          </Card>
        ) : unitFilter ? (
          // The unit hub: equipment by type, then every document that
          // references the unit's equipment.
          <>
            {filtered.length === 0 ? (
              unitFilter === "__unassigned" ? (
                <Card className="text-center py-8">
                  <p className="text-[14px] font-bold text-emerald-700 dark:text-emerald-400">No equipment is missing an operating area.</p>
                  <button type="button" onClick={() => setUnitFilter(null)}
                    className="mt-3 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] text-[var(--color-text)] text-[13px] font-semibold">
                    <ArrowLeft className="w-4 h-4" /> Back to all areas
                  </button>
                </Card>
              ) : (
                <EmptyState onCreate={canEditEquipment ? () => setCreating(true) : undefined} hasAny={assets.length > 0} />
              )
            ) : (
              <Card label="Equipment" pad={false} className="overflow-hidden">
                {groupedByType?.map((g) => {
                  const open = !closedTypes.has(g.typeId);
                  const isUncat = g.typeId === "__none";
                  const cb = isUncat ? undefined : cbTypeByLabel.get(g.name.trim().toLowerCase());
                  return (
                  <div key={g.typeId} className="border-t border-[var(--color-border)]">
                    {/* Category rows are the unit's chapter titles: they
                        carry the codebook's code and prefixes so the
                        numbering you taught is visibly at work. */}
                    <div className="flex items-center gap-2.5 px-4 sm:px-5 py-2.5">
                      <button type="button" aria-expanded={open}
                        onClick={() => setClosedTypes((prev) => {
                          const next = new Set(prev);
                          if (next.has(g.typeId)) next.delete(g.typeId); else next.add(g.typeId);
                          return next;
                        })}
                        className="flex items-center gap-2.5 text-left flex-1 min-w-0 min-h-9">
                        <ChevronDown className={`w-4 h-4 shrink-0 text-[var(--color-text-muted)] transition-transform ${open ? "" : "-rotate-90"}`} />
                        <span className="min-w-0">
                          <span className="flex items-center gap-2 flex-wrap">
                            <span className="text-[14px] font-bold text-[var(--color-text)]">{g.name}</span>
                            <span className="text-[13px] text-[var(--color-text-muted)]">{badgeText(g.list.length)}</span>
                            {cb && (
                              <span className="font-mono text-[11px] font-semibold text-[var(--color-text-muted)] bg-[var(--color-surface-2)] rounded px-1.5 py-0.5"
                                title={`Site Codebook equipment-type code ${cb.code}`}>
                                code {cb.code}{cb.prefixes.length > 0 ? ` · ${cb.prefixes.join(" · ")}` : ""}
                              </span>
                            )}
                          </span>
                          {isUncat && (
                            <span className="flex items-center gap-1 text-[12px] text-amber-700 dark:text-amber-400 font-semibold mt-0.5">
                              <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> Sort these: tap Categorize on a card, or Auto-categorize below.
                            </span>
                          )}
                        </span>
                      </button>
                      {canEditEquipment && (
                        <button type="button"
                          onClick={() => openCreate({
                            typeId: g.typeId === "__none" ? undefined : g.typeId,
                            unitCode: unitFilter === "__unassigned" ? undefined : (unitFilter ?? undefined),
                          })}
                          aria-label={`Add equipment to ${g.name}`}
                          className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[12px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] shrink-0">
                          <Plus className="w-3.5 h-3.5" /> Asset
                        </button>
                      )}
                    </div>
                    {open && (g.list.length === 0 ? (
                      <div className="px-4 sm:px-5 pb-4">
                        <button type="button"
                          onClick={() => canEditEquipment && openCreate({
                            typeId: g.typeId === "__none" ? undefined : g.typeId,
                            unitCode: unitFilter === "__unassigned" ? undefined : (unitFilter ?? undefined),
                          })}
                          className="w-full rounded-xl bg-[var(--color-surface-2)] py-4 text-[13px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                          No {g.name.toLowerCase()} in this area yet{canEditEquipment ? ". Add the first." : "."}
                        </button>
                      </div>
                    ) : (
                    <div className="px-4 sm:px-5 pb-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                      {g.list.map((a) => {
                        const type = types.find((t) => t.id === a.type_id);
                        const count = photoCounts.get(a.id) || 0;
                        return (
                          <AssetCard key={a.id} asset={a} type={type} photoCount={count} coverUrl={coverUrls.get(a.id)}
                            onClick={() => count > 0 ? setCarouselOpenFor(a) : setSelectedAsset(a)}
                            onEdit={canEditEquipment ? () => setSelectedAsset(a) : undefined}
                            onAddPhotos={isAdmin ? () => setUploaderOpenFor(a) : undefined} />
                        );
                      })}
                    </div>
                    ))}
                  </div>
                  );
                })}
              </Card>
            )}
            {unitAssetIds.length > 0 && <UnitDocuments assetIds={unitAssetIds} assets={filtered} />}
            {unitFilter && unitFilter !== "__unassigned" && uid && (
              <FlowPanel orgId={activeOrgId!} userId={uid} userName={userEmail ?? undefined}
                isAdmin={isAdmin} unitCode={unitFilter} unitAssets={filtered} />
            )}
          </>
        ) : book.units.length > 0 && !searchActive ? (
          // The landing page IS the site: one card per operating area.
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {unitSummaries.map((s) => (
              <UnitCard key={s.unit.code} summary={s} onOpen={() => setUnitFilter(s.unit.code)}
                onEdit={canEditLinks ? () => router.push("/admin/codebook") : undefined} />
            ))}
            {unknownUnits.map(([code, n]) => (
              <button key={code} type="button" onClick={() => setUnitFilter(code)}
                className="text-left rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] hover:bg-[var(--color-surface-2)] p-5 transition-colors">
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="font-mono text-[14px] font-bold text-[var(--color-text)]">{code}</span>
                  <span className="text-[14px] font-bold text-[var(--color-text)]">Unknown unit</span>
                </div>
                <div className="text-[13px] text-[var(--color-text-muted)]">
                  {plural(n, "asset")} carry this code, but it isn&apos;t in the Site Codebook yet.
                </div>
              </button>
            ))}
            {unitCounts.unassigned > 0 && (
              <button type="button" onClick={() => setUnitFilter("__unassigned")}
                className="text-left rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] hover:bg-[var(--color-surface-2)] p-5 transition-colors">
                <div className="flex items-center gap-2 mb-1">
                  <AlertTriangle className="w-4 h-4 text-amber-600" />
                  <span className="text-[14px] font-bold text-[var(--color-text)]">No unit assigned</span>
                </div>
                <div className="text-[13px] text-amber-700 dark:text-amber-400 font-semibold">
                  {plural(unitCounts.unassigned, "asset")} waiting to be filed under an operating area.
                </div>
              </button>
            )}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState onCreate={canEditEquipment ? () => setCreating(true) : undefined} hasAny={assets.length > 0} />
        ) : (
          // Search results (across every unit) or a no-codebook org's flat registry.
          <Card label={searchActive ? `${plural(filtered.length, "match", "matches")}` : "All equipment"}>
            <ShowMoreGrid items={filtered} render={(a) => {
              const type = types.find((t) => t.id === a.type_id);
              const count = photoCounts.get(a.id) || 0;
              return (
                <AssetCard
                  key={a.id}
                  asset={a}
                  type={type}
                  photoCount={count}
                  coverUrl={coverUrls.get(a.id)}
                  onClick={() => count > 0 ? setCarouselOpenFor(a) : setSelectedAsset(a)}
                  onEdit={canEditEquipment ? () => setSelectedAsset(a) : undefined}
                  onAddPhotos={isAdmin ? () => setUploaderOpenFor(a) : undefined}
                />
              );
            }} />
          </Card>
        )}

        {/* The Site Codebook already knows the taxonomy: put it to work. */}
        {canEditEquipment && !loading && uid && activeOrgId && (
          <CategorizeBanner orgId={activeOrgId} userId={uid} assets={assets} types={types} book={book}
            onDone={() => { invalidateAssetCache(); void refresh(); }} />
        )}

        {/* No codebook units yet: show admins the path instead of a silently
            flat registry. The unit-first view lights up the moment units exist. */}
        {book.units.length === 0 && isAdmin && !loading && (
          <Card label="Group by unit">
            <p className="text-[13px] text-[var(--color-text-muted)] flex items-start gap-2">
              <BookMarked className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                Name your units in the Site Codebook (20 = Crude, 25 = DHT) and this list groups itself by unit, then equipment type.{" "}
                <Link href="/admin/codebook" className="font-bold text-[var(--color-accent-text)] hover:underline">Set up the codebook</Link>
              </span>
            </p>
          </Card>
        )}

        {!canEditEquipment && (
          <p className="px-1 text-[13px] text-[var(--color-text-muted)] flex items-start gap-2">
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

// ─── A grid that shows it keeps going ─────────────────────

/** The first screenful of cards, then "Show N more" so a long registry
 *  never renders hundreds of photos at once and still says how many are left. */
function ShowMoreGrid<T>({ items, render, step = 24 }: { items: T[]; render: (item: T) => React.ReactNode; step?: number }) {
  const [shown, setShown] = useState(step);
  const rest = items.length - shown;
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {items.slice(0, shown).map(render)}
      </div>
      {rest > 0 && (
        <div className="mt-3 pt-3 border-t border-[var(--color-border)] flex items-center justify-between text-[13px]">
          <span className="text-[var(--color-text-muted)]">{Math.min(shown, items.length).toLocaleString()} of {items.length.toLocaleString()} shown</span>
          <button type="button" onClick={() => setShown((n) => n + step * 2)} className="font-bold text-[var(--color-accent-text)] hover:underline">
            Show {Math.min(rest, step * 2).toLocaleString()} more
          </button>
        </div>
      )}
    </>
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
      className="text-left rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] hover:-translate-y-0.5 transition-transform p-5 flex flex-col gap-3 group cursor-pointer">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-[10px] bg-[var(--color-surface-2)] flex items-center justify-center shrink-0">
          <Factory className="w-4.5 h-4.5 text-[var(--color-text-muted)]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[14px] font-bold text-[var(--color-text-muted)]">{unit.code}</span>
            <span className="text-[14px] font-bold text-[var(--color-text)] truncate">{unit.label}</span>
          </div>
          <div className="text-[13px] text-[var(--color-text-muted)]">
            {count} asset{count === 1 ? "" : "s"}
            {links.length > 0 && ` · ${links.length} pinned librar${links.length === 1 ? "y" : "ies"}`}
          </div>
        </div>
        {onEdit && (
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            title="Rename or manage this unit (Site Codebook)"
            aria-label={`Manage unit ${unit.code} in the Site Codebook`}
            className="p-1.5 rounded-lg text-[var(--color-text-faint)] hover:text-[var(--color-accent-hover)] hover:bg-[var(--color-surface-2)] shrink-0"
          >
            <Edit3 className="w-3.5 h-3.5" />
          </button>
        )}
        <ArrowRight className="w-4 h-4 text-[var(--color-text-faint)] group-hover:text-[var(--color-text)] group-hover:translate-x-0.5 transition-all shrink-0 mt-1" />
      </div>
      {topTypes.length > 0 && (
        <div className="flex gap-1.5 flex-wrap">
          {topTypes.map(([name, n]) => (
            <span key={name} className="text-[12px] font-semibold text-[var(--color-text-muted)] bg-[var(--color-surface-2)] rounded-full px-2 py-0.5">
              {name} <span className="text-[var(--color-text-faint)]">{n}</span>
            </span>
          ))}
        </div>
      )}
      {needPhotos > 0 && (
        <div className="text-[12px] font-semibold text-amber-700 dark:text-amber-400 flex items-center gap-1">
          <Camera className="w-3.5 h-3.5" /> {needPhotos} without photos
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
    <div>
      <div className="flex gap-2 flex-wrap items-stretch">
        {links.map((l) => (
          <div key={l.id} className="group relative">
            <Link
              href={`/documents/${l.libraryId}${l.folderId ? `?folderId=${l.folderId}` : ""}`}
              className="flex items-center gap-2.5 pl-3 pr-8 py-2.5 rounded-xl bg-[var(--color-surface-2)] hover:bg-[var(--color-border)] transition-colors h-full"
            >
              <FolderOpen className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
              <div className="min-w-0">
                <div className="text-[14px] font-bold text-[var(--color-text)] truncate">{l.label}</div>
                <div className="text-[12px] text-[var(--color-text-muted)] truncate">
                  {l.libraryName}{l.folderName ? ` › ${l.folderName}` : ""}
                </div>
              </div>
            </Link>
            {canEdit && (
              <button onClick={() => void removeLink(l.id)} disabled={busy} title="Unpin" aria-label={`Unpin ${l.label}`}
                className="absolute top-1.5 right-1.5 p-0.5 rounded text-[var(--color-text-faint)] hover:text-rose-600 opacity-70 group-hover:opacity-100 transition-opacity">
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        ))}
        {canEdit && (
          <button onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-xl border border-[var(--color-border)] text-[13px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors">
            <Link2 className="w-3.5 h-3.5" />
            {links.length === 0 ? "Pin this unit's libraries: P&IDs, manuals, unit data…" : "Pin another"}
          </button>
        )}
        {!canEdit && links.length === 0 && (
          <div className="text-[13px] text-[var(--color-text-muted)] py-2">
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
  const [libs, setLibs] = useState<Array<{ id: string; name: string }> | null>(null);
  const [libraryId, setLibraryId] = useState("");
  const [folders, setFolders] = useState<PickerFolder[]>([]);
  const [folderId, setFolderId] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void supabase.from("libraries").select("id, name").eq("org_id", orgId).order("name")
      .then(({ data, error: e }) => {
        if (e) { setError(`Couldn't load the libraries: ${e.message}`); setLibs([]); return; }
        setLibs((data ?? []) as Array<{ id: string; name: string }>);
      });
  }, [orgId]);

  useEffect(() => {
    if (!libraryId) return;
    let alive = true;
    listLibraryFoldersOnce(libraryId)
      .then((f) => { if (alive) setFolders(f); })
      .catch((e) => { if (alive) { setFolders([]); setError(`Couldn't load that library's folders: ${(e as Error).message}`); } });
    return () => { alive = false; };
  }, [libraryId]);

  const lib = (libs ?? []).find((l) => l.id === libraryId);
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
    <Modal onClose={onClose} size="sm" zIndex={500} dismissable={!busy}>
      <ModalHeader icon={Link2} title="Pin a library to this unit" subtitle="A whole library, or one folder of it, named for what it means here." onClose={busy ? undefined : onClose} />
      <ModalBody className="space-y-3">
        <div>
          <label className="text-[13px] font-semibold text-[var(--color-text)] ">Library</label>
          <select value={libraryId} disabled={libs === null}
            onChange={(e) => { setLibraryId(e.target.value); setFolders([]); setFolderId(""); }}
            className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)] text-[var(--color-text)]">
            <option value="">{libs === null ? "Loading libraries…" : "Pick a library"}</option>
            {(libs ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        {folders.length > 0 && (
          <div>
            <label className="text-[13px] font-semibold text-[var(--color-text)] ">Folder (optional)</label>
            <select value={folderId} onChange={(e) => setFolderId(e.target.value)}
              className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)] text-[var(--color-text)]">
              <option value="">Whole library</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>{f.pathNames.join(" › ") || f.name}</option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label className="text-[13px] font-semibold text-[var(--color-text)] ">Label on the unit page</label>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={effectiveLabel || "e.g. P&IDs, Operating manuals, Unit data"}
            className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)] text-[var(--color-text)]" />
        </div>
        {error && (
          <p role="alert" className="border-l-2 border-red-500 pl-2.5 text-xs text-red-700 dark:text-red-400 flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
          </p>
        )}
      </ModalBody>
      <ModalFooter>
        <button onClick={onClose} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)]">Cancel</button>
        <button onClick={() => void save()} disabled={busy || !libraryId}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-black text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />} Pin it
        </button>
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

  const assign = async (rows: Array<{ asset: Asset; unitCode: string }>) => {
    setBusy(true);
    try {
      for (const r of rows) {
        await updateAsset(r.asset.id, {
          unit_code: r.unitCode,
          code: r.asset.code ?? tagToCode(r.asset.tag, r.unitCode, book) ?? null,
        }, userId);
      }
      onAssigned();
    } catch (e) { await appAlert({ message: (e as Error).message, tone: "danger" }); }
    finally { setBusy(false); }
  };

  const chosen = assets.filter((a) => choices.get(a.id));
  const shown = assets.slice(0, 50);

  return (
    <Card label="File this equipment under its operating area">
      <p className="text-[13px] text-[var(--color-text-muted)] mb-2.5">
        Pick a unit for each one. Where its drawings say which unit, it&apos;s picked already. The site code fills in.
      </p>
      <div className="divide-y divide-[var(--color-border)]">
        {shown.map((a) => {
          const hint = hints.get(a.id);
          const choice = choices.get(a.id) ?? "";
          return (
            <div key={a.id} className="flex items-center gap-2.5 py-2 flex-wrap">
              <span className="font-mono text-[13px] font-bold text-[var(--color-text)] w-20 shrink-0">{a.tag}</span>
              <select
                value={choice}
                onChange={(e) => setChoices((prev) => new Map(prev).set(a.id, e.target.value))}
                disabled={busy}
                aria-label={`Unit for ${a.tag}`}
                className="h-9 px-2 border border-[var(--color-border-strong)] rounded-lg text-[13px] bg-[var(--color-surface)] text-[var(--color-text)] font-semibold"
              >
                <option value="">Pick a unit</option>
                {book.units.map((u) => (
                  <option key={u.code} value={u.code}>{u.code} · {u.label}</option>
                ))}
              </select>
              <span className="text-[12px] text-[var(--color-text-muted)] flex-1 min-w-[120px]">
                {hint
                  ? <>drawings say <b className="text-[var(--color-text)] font-mono">{hint.unitCode}</b> ({hint.drawings} linked drawing{hint.drawings === 1 ? "" : "s"})</>
                  : a.description || ""}
              </span>
              <button
                onClick={() => { if (choice) void assign([{ asset: a, unitCode: choice }]); }}
                disabled={busy || !choice}
                className="h-8 text-[12px] font-semibold text-[var(--color-text)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] rounded-lg px-2.5 disabled:opacity-40"
              >
                Assign
              </button>
            </div>
          );
        })}
        {assets.length > shown.length && (
          <div className="pt-2 text-[12px] text-[var(--color-text-muted)]">Showing the first {shown.length} of {assets.length}. Assign these and the next ones come up.</div>
        )}
      </div>
      {chosen.length > 1 && (
        <button
          onClick={() => void assign(chosen.map((a) => ({ asset: a, unitCode: choices.get(a.id)! })))}
          disabled={busy}
          className="mt-3 inline-flex items-center gap-1.5 h-9 text-[13px] font-bold text-[var(--color-surface)] bg-[var(--color-text)] hover:opacity-90 rounded-lg px-3.5 disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          Assign all {chosen.length} selected
        </button>
      )}
    </Card>
  );
}

// ─── Documents referencing the unit's equipment ────────────

function UnitDocuments({ assetIds, assets }: { assetIds: string[]; assets: Asset[] }) {
  const [rows, setRows] = useState<Array<{
    documentId: string; documentNumber: string | null; title: string | null;
    libraryId: string; tags: string[];
  }> | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
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
      .catch((e) => { if (alive) { setRows([]); setFailed((e as Error).message || "Couldn't find them."); } });
    return () => { alive = false; };
    // assets is derived from the same filter as assetIds — idsKey covers both.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  if (rows === null) {
    return (
      <Card label="Documents about this equipment">
        <div className="text-[13px] text-[var(--color-text-muted)] flex items-center gap-1.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Finding documents that reference this unit&apos;s equipment…
        </div>
      </Card>
    );
  }
  if (failed) {
    return <Card label="Documents about this equipment"><p role="alert" className="text-[13px] text-rose-700 dark:text-rose-400">Couldn&apos;t load the documents that reference this unit&apos;s equipment: {failed}</p></Card>;
  }
  if (rows.length === 0) return null;
  const shown = expanded ? rows : rows.slice(0, 12);

  return (
    <Card label={<>Documents about this equipment · {badgeText(rows.length)}</>} pad={false} className="overflow-hidden">
      <ul className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
        {shown.map((d) => (
          <li key={d.documentId}>
            <Link href={`/documents/${d.libraryId}?doc=${d.documentId}`}
              className="flex items-center gap-3 px-4 sm:px-5 py-2.5 hover:bg-[var(--color-surface-2)]/70 transition-colors">
              <FileText className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />
              <div className="flex-1 min-w-0 text-[14px]">
                <span className="font-bold text-[var(--color-text)]">{d.documentNumber || "(no number)"}</span>
                {d.title && <span className="text-[var(--color-text-muted)]"> · {d.title}</span>}
              </div>
              <div className="flex gap-1 flex-wrap justify-end max-w-[45%]">
                {d.tags.slice(0, 6).map((t) => (
                  <span key={t} className="text-[11px] font-mono font-bold text-[var(--color-text)] bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded px-1 py-0.5">{t}</span>
                ))}
                {d.tags.length > 6 && <span className="text-[11px] font-bold text-[var(--color-text-faint)]">+{d.tags.length - 6}</span>}
              </div>
            </Link>
          </li>
        ))}
      </ul>
      {rows.length > 12 && (
        <div className="px-4 sm:px-5 py-3 border-t border-[var(--color-border)] flex items-center justify-between text-[13px]">
          <span className="text-[var(--color-text-muted)]">{shown.length} of {rows.length} shown</span>
          <button type="button" onClick={() => setExpanded((v) => !v)}
            className="font-bold text-[var(--color-accent-text)] hover:underline">
            {expanded ? "Show fewer" : `Show ${rows.length - shown.length} more`}
          </button>
        </div>
      )}
    </Card>
  );
}

// ─── Asset card ────────────────────────────────────────────

function AssetCard({
  asset, type, photoCount, coverUrl, onClick, onEdit, onAddPhotos,
}: {
  asset: Asset; type?: AssetType; photoCount: number; coverUrl?: string | null;
  onClick: () => void; onEdit?: () => void; onAddPhotos?: () => void;
}) {

  return (
    <div className="group bg-[var(--color-surface)] rounded-xl ring-1 ring-[var(--color-border)] hover:shadow-[var(--shadow-card)] transition-shadow overflow-hidden flex flex-col">
      {/* Cover area */}
      <button type="button" onClick={onClick} aria-label={`Open ${asset.tag}`} className="block aspect-[4/3] w-full relative overflow-hidden bg-[var(--color-surface-2)]">
        {coverUrl ? (
          <SignedImg path={coverUrl} alt={asset.tag} className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <ImageIcon className="w-8 h-8 text-[var(--color-text-faint)]" />
          </div>
        )}
      </button>
      {/* Info */}
      <div className="p-3 flex-1 flex flex-col">
        <div className="flex items-center gap-2 mb-1">
          <button type="button" onClick={onClick} className="text-[14px] font-bold text-[var(--color-text)] hover:underline truncate flex-1 text-left">
            {asset.tag}
          </button>
          {type && (
            <span className="text-[13px] font-semibold text-[var(--color-text-muted)] shrink-0">
              {type.name}
            </span>
          )}
        </div>
        {asset.description && (
          <div className="text-[13px] text-[var(--color-text-muted)] line-clamp-2 mb-1">{asset.description}</div>
        )}
        {asset.location && (
          <div className="text-[12px] text-[var(--color-text-muted)] flex items-center gap-1 truncate">
            <MapPin className="w-3 h-3" /> {asset.location}
          </div>
        )}
        <div className="mt-2 pt-2 border-t border-[var(--color-border)] flex items-center justify-between">
          <div className="text-[12px] font-semibold text-[var(--color-text-muted)]">
            {photoCount === 0 ? (
              <span className="text-amber-700 dark:text-amber-400 inline-flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> No photos</span>
            ) : (
              <span className="inline-flex items-center gap-1 text-[var(--color-text)]"><Camera className="w-3 h-3" /> {photoCount} photo{photoCount === 1 ? "" : "s"}</span>
            )}
          </div>
          {/* Always visible — a hover-only edit button doesn't exist on
              touchscreens, and "how do I edit this?" should never be a
              puzzle. An uncategorized asset gets a LABELED door out of
              limbo, not a pencil icon to decode. */}
          <div className="flex items-center gap-1">
            {!type && onEdit && (
              <button type="button" onClick={onEdit}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-amber-800 dark:text-amber-300 text-[12px] font-bold hover:bg-amber-50 dark:hover:bg-amber-950/40">
                <Tag className="w-2.5 h-2.5" /> Categorize
              </button>
            )}
            {onAddPhotos && (
              <button onClick={onAddPhotos} title="Add photos" aria-label={`Add photos to ${asset.tag}`} className="p-1 text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] rounded">
                <Camera className="w-3.5 h-3.5" />
              </button>
            )}
            {onEdit && (
              <button onClick={onEdit} title="Edit asset" aria-label={`Edit ${asset.tag}`} className="p-1 text-[var(--color-text-faint)] hover:text-[var(--color-accent-hover)] hover:bg-[var(--color-surface-2)] rounded">
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
    <Card className="text-center py-10">
      <div className="w-12 h-12 rounded-xl bg-[var(--color-surface-2)] mx-auto mb-3 flex items-center justify-center">
        <Tag className="w-6 h-6 text-[var(--color-text-muted)]" />
      </div>
      <h3 className="text-[14px] font-bold text-[var(--color-text)] mb-1">
        {hasAny ? "No matches" : "Start with one piece of equipment"}
      </h3>
      <p className="text-[14px] text-[var(--color-text-muted)] max-w-md mx-auto mb-4">
        {hasAny
          ? "Try a different search or clear the filters."
          : "Add the first piece of equipment: a pump, instrument, valve, anything with a tag."}
      </p>
      {!hasAny && onCreate && (
        <button type="button" onClick={onCreate} className="inline-flex items-center gap-1.5 h-10 px-4 rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] text-[var(--color-text)] text-[14px] font-bold">
          <Plus className="w-4 h-4" /> Add the first piece of equipment
        </button>
      )}
    </Card>
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
    const { error: e } = await supabase.from("document_assets").delete()
      .eq("document_id", documentId).eq("asset_id", asset.id);
    if (e) { setError(`Couldn't unlink the document: ${e.message}`); return; }
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
        onClose();
      }
    } catch (e) {
      const friendly = translatePostgresError(e, { entity: "asset", field: "tag" });
      setError(`${friendly.heading}: ${friendly.message}`);
    }
    finally { setBusy(false); }
  };

  const onDelete = async () => {
    if (!asset) return;
    if (!(await appConfirm({ message: `Delete asset "${asset.tag}" and all its photos? This can't be undone.`, tone: "danger" }))) return;
    setBusy(true);
    try {
      await deleteAsset(asset.id);
      invalidateAssetCache();
      onSaved();
      onClose();
    } catch (e) {
      const f = translatePostgresError(e, { entity: "asset" });
      setError(`${f.heading}: ${f.message}`);
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
    <div role="dialog" aria-modal="true" aria-label={isCreate ? "New asset" : `Asset ${asset?.tag ?? ""}`} className="fixed inset-0 z-[400] flex" onClick={() => { if (!busy) onClose(); }}>
      <div className="absolute inset-0 bg-[var(--color-ink)]/60" />
      <div onClick={(e) => e.stopPropagation()} className="relative ml-auto w-full max-w-xl bg-[var(--color-surface)] shadow-2xl sm:rounded-l-[20px] flex flex-col h-dvh">
        <div className="px-5 sm:px-6 pt-5 pb-4 border-b border-[var(--color-border)] shrink-0">
          <div className="flex items-center gap-2">
            <div className="min-w-0 truncate text-[13px] font-semibold text-[var(--color-text-muted)]">
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
            <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="w-9 h-9 grid place-items-center rounded-[10px] bg-[var(--color-surface-2)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
              <X className="w-4 h-4" />
            </button>
          </div>
          <h2 className="mt-3 text-[32px] sm:text-[38px] leading-none font-black tracking-[-0.03em] text-[var(--color-text)] break-words">
            {isCreate ? (tag.trim() || "New asset") : asset?.tag}
          </h2>
          <p className="mt-2 text-[14px] text-[var(--color-text-muted)]">
            {isCreate ? "Its tag, type and where it is." : <>{types.find((t) => t.id === asset?.type_id)?.name ?? "No type"} · {photos.length} photo{photos.length === 1 ? "" : "s"}{linkedDocs ? ` · ${linkedDocs.length} document${linkedDocs.length === 1 ? "" : "s"}` : ""}</>}
          </p>
        </div>

        <div className="flex-1 overflow-auto p-5 space-y-5">
          {/* Form */}
          <div className="space-y-3">
            <div>
              <label className="text-[13px] font-semibold text-[var(--color-text)] ">Tag *</label>
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
                <div className="text-[11px] text-[var(--color-text-muted)] mt-1">Normalized: <span className="font-mono">{normalizeTag(tag)}</span></div>
              )}
            </div>
            <div>
              <label className="text-[13px] font-semibold text-[var(--color-text)] ">Type</label>
              <select value={typeId} onChange={(e) => setTypeId(e.target.value)} disabled={!canEdit || busy} className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)] text-[var(--color-text)]">
                <option value="">No type</option>
                {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[13px] font-semibold text-[var(--color-text)] ">Description</label>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} disabled={!canEdit || busy} rows={2} placeholder="What it is" className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm resize-y bg-[var(--color-surface)] text-[var(--color-text)]" />
            </div>
            <div>
              <label className="text-[13px] font-semibold text-[var(--color-text)] ">Location</label>
              <input value={location} onChange={(e) => setLocation(e.target.value)} disabled={!canEdit || busy} placeholder="e.g. Unit 200 cold side" className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)] text-[var(--color-text)]" />
            </div>
            {book.units.length > 0 && (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[13px] font-semibold text-[var(--color-text)] ">Operating unit</label>
                  <select value={unitCode} onChange={(e) => setUnitCode(e.target.value)} disabled={!canEdit || busy}
                    className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)] text-[var(--color-text)]">
                    <option value="">None</option>
                    {book.units.map((u) => <option key={u.code} value={u.code}>{u.code} · {u.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[13px] font-semibold text-[var(--color-text)] ">Site code</label>
                  <input value={siteCode} onChange={(e) => setSiteCode(e.target.value)} disabled={!canEdit || busy}
                    placeholder="Auto, e.g. 2030.22" className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm font-mono bg-[var(--color-surface)] text-[var(--color-text)]" />
                </div>
              </div>
            )}
          </div>

          {/* Photos section (edit mode only) */}
          {!isCreate && asset && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="text-[13px] font-semibold text-[var(--color-text)] ">
                  Photos ({photos.length})
                </div>
                <div className="flex items-center gap-1.5">
                  {photos.length > 0 && (
                    <button type="button" onClick={() => onOpenCarousel(asset)} className="inline-flex items-center gap-1 text-[12px] font-bold text-[var(--color-text)] hover:underline">
                      <ImageIcon className="w-3 h-3" /> Open photos
                    </button>
                  )}
                  {canEdit && (
                    <button type="button" onClick={() => onOpenUploader(asset)} className="inline-flex items-center gap-1 text-[12px] font-bold text-[var(--color-text)] hover:underline">
                      <Camera className="w-3 h-3" /> Add photos
                    </button>
                  )}
                </div>
              </div>
              {photosFailed ? (
                <div role="alert" className="text-center text-xs text-rose-700 dark:text-rose-400 py-6 border border-dashed border-[var(--color-border)] rounded-lg">
                  Couldn&apos;t load the photos.
                </div>
              ) : photos.length === 0 ? (
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
                        {/* Date and status on one strip along the bottom of the photo. */}
                        <div className="absolute bottom-0 inset-x-0 px-1.5 py-1 bg-black/65">
                          <div className="text-[11px] font-mono flex items-center gap-1 text-white">
                            <span className={age.category === "stale" ? "text-red-300" : age.category === "aging" ? "text-amber-300" : ""}>
                              {p.captured_at ? new Date(p.captured_at).toLocaleDateString() : "No date"}
                            </span>
                            {p.status !== "current" && (
                              <span className={`ml-auto font-sans font-bold ${p.status === "needs_verification" ? "text-amber-300" : "text-red-300"}`}>
                                {p.status === "needs_verification" ? "Check" : "Old"}
                              </span>
                            )}
                          </div>
                        </div>
                        {canEdit && (
                          <div className="absolute top-1 right-1 flex flex-col gap-1 opacity-80 group-hover:opacity-100 transition-opacity">
                            <button onClick={() => markPhotoStatus(p, p.status === "current" ? "needs_verification" : "current")} title={p.status === "current" ? "Mark as needs checking" : "Mark as current"} aria-label={p.status === "current" ? "Mark as needs checking" : "Mark as current"} className="p-1 bg-[var(--color-surface)]/90 rounded hover:bg-[var(--color-surface)]">
                              <AlertTriangle className="w-3 h-3 text-amber-600" />
                            </button>
                            <button onClick={() => onDeletePhoto(p)} title="Delete photo" aria-label="Delete photo" className="p-1 bg-[var(--color-surface)]/90 rounded hover:bg-[var(--color-surface)]">
                              <Trash2 className="w-3 h-3 text-red-600" />
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
              <div className="text-[13px] font-semibold text-[var(--color-text)] mb-2 flex items-center gap-1.5">
                <FileText className="w-3 h-3" /> Linked documents
                {linkedDocs && <span className="text-[var(--color-text-faint)] font-bold">({linkedDocs.length})</span>}
                <span className="flex-1" />
                <Link href={`/graph?focus=${encodeURIComponent(`asset:${asset.id}`)}`}
                  className="inline-flex items-center gap-1 normal-case tracking-normal text-[11px] font-black text-[var(--color-accent-text)] hover:text-[var(--color-accent-hover)]">
                  <Waypoints className="w-3 h-3" /> See on graph
                </Link>
                {canEdit && (
                  <button type="button" onClick={() => setDocPickerOpen(true)}
                    className="inline-flex items-center gap-1 normal-case tracking-normal px-2 py-1 rounded-md border border-[var(--color-border-strong)] text-[11px] font-black text-[var(--color-text-muted)] hover:text-[var(--color-accent-text)] hover:border-[var(--color-accent)]">
                    <Plus className="w-3 h-3" /> Link document
                  </button>
                )}
              </div>
              {linkedDocs === null ? (
                <div className="text-[11px] text-[var(--color-text-muted)] py-2 inline-flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Loading linked documents…</div>
              ) : docsFailed ? (
                <div role="alert" className="text-xs text-rose-700 dark:text-rose-400 py-2">
                  Couldn&apos;t load the linked documents. <button type="button" onClick={refreshDocs} className="font-bold underline">Try again</button>
                </div>
              ) : linkedDocs.length === 0 ? (
                <div className="text-center text-xs text-[var(--color-text-faint)] italic py-4 border border-dashed border-[var(--color-border)] rounded-lg">
                  No documents reference this asset yet.
                </div>
              ) : (
                <ul className="rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)] max-h-56 overflow-auto">
                  {linkedDocs.map((d) => (
                    <li key={d.documentId} className="relative group/docrow">
                      {canEdit && (
                        <button type="button" title="Unlink from this equipment" aria-label="Unlink from this equipment"
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
                            <div className="text-[11px] font-mono text-[var(--color-text-faint)] truncate">tag: {d.tagText}</div>
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
              <div className="text-[13px] font-semibold text-[var(--color-text)] mb-2">Quick notes</div>
              <QuickNoteComposer
                orgId={orgId}
                userId={userId}
                userEmail={userEmail}
                scope={{ assetId: asset.id }}
              />
            </div>
          )}

          {error && (
            <p role="alert" className="border-l-2 border-red-500 pl-2.5 text-xs text-red-700 dark:text-red-400 flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
            </p>
          )}
        </div>

        <div className="px-5 sm:px-6 py-3 pb-[calc(12px+env(safe-area-inset-bottom))] border-t border-[var(--color-border)] flex items-center justify-between shrink-0">
          {!isCreate && canEdit ? (
            <button type="button" onClick={onDelete} disabled={busy} className="text-[13px] font-semibold text-red-600 hover:text-red-700 inline-flex items-center gap-1">
              <Trash2 className="w-3.5 h-3.5" /> Delete asset
            </button>
          ) : <div />}
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} disabled={busy} className="h-10 px-3.5 rounded-xl text-[13px] font-semibold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)]">Cancel</button>
            {canEdit && (
              <button type="button" onClick={save} disabled={busy || !tag.trim() || hasTagConflict} className={heroPrimary}>
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const save = async () => {
    const c = code.trim();
    if (!c) { setError("Give the area its number/code (e.g. 20)."); return; }
    if (existingCodes.includes(c)) { setError(`Unit ${c} already exists.`); return; }
    setBusy(true); setError(null);
    const { error: e } = await supabase.from("codebook_entries").insert({
      org_id: orgId, kind: "unit", code: c, label: label.trim() || `Unit ${c}`,
      meta: {}, sort: existingCodes.length, origin: "manual", created_by: userId,
    });
    setBusy(false);
    if (e) { setError(e.message); return; }
    onCreated(c);
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="New operating area" className="fixed inset-0 z-[700] flex items-start justify-center bg-[var(--color-ink)]/60 pt-[14vh] p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl bg-[var(--color-surface)] shadow-2xl p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <Factory className="w-4 h-4 text-[var(--color-text-muted)]" />
          <div className="flex-1">
            <div className="text-[14px] font-bold text-[var(--color-text)]">New operating area</div>
            <div className="text-[12px] text-[var(--color-text-muted)]">
              Saved in your Site Codebook, where the whole app reads units from.
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-[var(--color-text-faint)] hover:text-[var(--color-text)]"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex items-center gap-2">
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code (20)" aria-label="Unit code" autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
            className="w-28 px-3 py-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] text-sm font-mono" />
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name (Crude Unit)" aria-label="Unit name"
            onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
            className="flex-1 px-3 py-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] text-sm" />
        </div>
        {error && <div role="alert" className="text-[11px] text-rose-700 dark:text-rose-400">{error}</div>}
        <div className="flex items-center justify-between gap-2">
          <Link href="/admin/codebook" className="text-[11px] font-bold text-[var(--color-accent-text)] hover:underline inline-flex items-center gap-1">
            <BookMarkedIcon className="w-3 h-3" /> Full codebook (AI import, decoder)
          </Link>
          <button onClick={() => void save()} disabled={busy}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-black text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Create area
          </button>
        </div>
      </div>
    </div>
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const save = async () => {
    const n = name.trim();
    if (!n) { setError("Name the category (Pump, Exchanger…)."); return; }
    // Teaching moment: a code (with or without prefixes) writes a real Site
    // Codebook entry — it must never be swallowed silently. Validate BEFORE
    // creating anything so a fixable problem doesn't half-save.
    const px = prefixes.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
    const tc = typeCode.trim();
    if (px.length > 0 && !tc) {
      setError("Prefixes need a code to go under. Add the equipment-type code (e.g. 02).");
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
        if (cbErr) { setError(cbErr.message); setBusy(false); return; }
      }
      await createAssetType({ orgId, name: n });
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="New equipment category" className="fixed inset-0 z-[700] flex items-start justify-center bg-[var(--color-ink)]/60 pt-[14vh] p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl bg-[var(--color-surface)] shadow-2xl p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <Tag className="w-4 h-4 text-[var(--color-text-muted)]" />
          <div className="flex-1">
            <div className="text-[14px] font-bold text-[var(--color-text)]">New equipment category</div>
            <div className="text-[12px] text-[var(--color-text-muted)]">
              A section in every operating area. Add its tag prefix and new equipment sorts itself.
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-[var(--color-text-faint)] hover:text-[var(--color-text)]"><X className="w-4 h-4" /></button>
        </div>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (Exchanger)" aria-label="Category name" autoFocus
          className="w-full px-3 py-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] text-sm" />
        <div className="flex items-center gap-2">
          <input value={prefixes} onChange={(e) => setPrefixes(e.target.value)} placeholder="Tag prefixes (E, EA), optional" aria-label="Tag prefixes"
            className="flex-1 px-3 py-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] text-sm font-mono" />
          <input value={typeCode} onChange={(e) => setTypeCode(e.target.value)} placeholder="Code (02)" aria-label="Equipment-type code"
            className="w-24 px-3 py-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] text-sm font-mono" />
        </div>
        <p className="text-[11px] text-[var(--color-text-faint)]">
          No numbering system? Leave prefixes blank. You can add them later.
        </p>
        {error && <div role="alert" className="text-[11px] text-rose-700 dark:text-rose-400">{error}</div>}
        <div className="flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Cancel</button>
          <button onClick={() => void save()} disabled={busy}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-black text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Create category
          </button>
        </div>
      </div>
    </div>
  );
}
