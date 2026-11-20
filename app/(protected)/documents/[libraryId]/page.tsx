"use client";

import { nudgeKnowledgeSources } from "@/lib/knowledge";
import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import FolderGrid from "@/components/documents/FolderGrid";
import CustomizeNodeModal from "@/components/documents/CustomizeNodeModal";
import LibraryHomeBoard from "@/components/documents/LibraryHomeBoard";
import PageHeader from "@/components/documents/PageHeader";
import PageBackground from "@/components/documents/PageBackground";
import { resolvePageHeader, resolvePageBackground } from "@/lib/pageHeader";
import ColumnManager from "@/components/documents/ColumnManager";
import CreateColumnWizard from "@/components/documents/CreateColumnWizard";
import ColumnHeaderMenu from "@/components/documents/ColumnHeaderMenu";
import CheckoutFlowModal from "@/components/documents/CheckoutFlowModal";
import EditOverlapBanner from "@/components/documents/EditOverlapBanner";
import MetadataEditor from "@/components/documents/MetadataEditor";
import InspectorPanel from "@/components/documents/InspectorPanel";
import ReviewPill from "@/components/documents/ReviewPill";
import ReviewPolicyModal from "@/components/documents/ReviewPolicyModal";
import AckPill from "@/components/documents/AckPill";
import AckPolicyModal from "@/components/documents/AckPolicyModal";
import { getAckSummaries, type AckSummary } from "@/lib/acknowledgments";
import ReviewControlModal from "@/components/documents/ReviewControlModal";
import EffectivePill from "@/components/documents/EffectivePill";
import RetentionPill from "@/components/documents/RetentionPill";
import RetentionPolicyModal from "@/components/documents/RetentionPolicyModal";
import OriginBadge from "@/components/documents/OriginBadge";
import AccessRecertModal from "@/components/documents/AccessRecertModal";
import { isLegalHold } from "@/lib/retention";
import CheckoutStatusCell from "@/components/documents/CheckoutStatusCell";
import MoveModal from "@/components/documents/MoveModal";
import HistoryDrawer from "@/components/documents/HistoryDrawer";
import PermissionsDrawer from "@/components/permissions/PermissionDrawer";
import SetManager from "@/components/documents/SetManager";
import EquipmentSweepModal from "@/components/documents/EquipmentSweepModal";
import StagingTray from "@/components/documents/StagingTray";
import MetadataStagingModal, { type StagedItem, type CustomColumnDef, type UploadOutcome } from "@/components/documents/MetadataStagingModal";
import DuplicateUploadsModal from "@/components/documents/DuplicateUploadsModal";
import CollectionsStrip from "@/components/documents/CollectionsStrip";
import FavoritesStrip from "@/components/documents/FavoritesStrip";
import ViewSelector from "@/components/documents/ViewSelector";
import LibraryOrderModal from "@/components/documents/LibraryOrderModal";
import PillCell from "@/components/documents/PillCell";
import FolderRail from "@/components/documents/FolderRail";
import PathBar from "@/components/documents/PathBar";
import FolderDeleteModal, { type FolderDeleteResult } from "@/components/documents/FolderDeleteModal";
import { hashFile } from "@/lib/duplicateFiles";
import { folderUrlAction } from "@/lib/folderUrlSync";
import { rollupFolderCounts } from "@/lib/folderCounts";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { translatePostgresError } from "@/lib/inputValidation";
import { computeUniquenessKey } from "@/lib/uniqueness";
import { forceReleaseDocument } from "@/lib/checkoutEpisodes";
import { appAlert, appConfirm } from "@/components/providers/DialogProvider";
import { tryUpload } from "@/lib/uploadRetry";
import LoadingBlock from "@/components/ui/LoadingBlock";
import { PageHero, PageBody, Card, heroPrimary, heroQuiet } from "@/components/ui/PageHero";
import { bandInput, bandInputIcon, bandSeg, bandSegItem } from "@/components/admin/band";
import { StatusTag, docStatusTone, humanDate } from "@/components/documents/StatusTag";
import { isDocumentCheckedOut } from "@/lib/documentGuards";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import WatchButton from "@/components/ui/WatchButton";
import { useFileDrag } from "@/hooks/useFileDrag";
import CommandPalette from "@/components/documents/CommandPalette";
import StatusFooter from "@/components/documents/StatusFooter";
import InspectorDrawer from "@/components/documents/InspectorDrawer";
import AssetTagChip from "@/components/assets/AssetTagChip";
// Heavy viewers (react-pdf/pdfjs + fabric + pdf-lib) are code-split so the
// library-browsing experience doesn't pay their download/parse cost up front —
// they only load when a viewer actually opens. ssr:false because they're
// client-only (canvas, window, pdfjs worker).
const FullScreenViewer = dynamic(() => import("@/components/viewers/FullScreenViewer"), { ssr: false });
const MultiDocViewer = dynamic(() => import("@/components/viewers/MultiDocViewer"), { ssr: false });
import type { TagColumnDef } from "@/lib/documentTags";
import RevUpModal from "@/components/documents/RevUpModal";
import SupersedeModal from "@/components/documents/SupersedeModal";
import ArchiveConfirmModal from "@/components/documents/ArchiveConfirmModal";
import RevertConfirmModal from "@/components/documents/RevertConfirmModal";
import BulkCheckoutToProjectModal from "@/components/documents/BulkCheckoutToProjectModal";
import BulkEditModal from "@/components/documents/BulkEditModal";
import CsvImportModal from "@/components/documents/CsvImportModal";
import RouteLoader from "@/components/ui/RouteLoader";
import { listItems as listCollectionItems } from "@/lib/collections";
import { buildAclIndexFromChain } from "@/lib/acl";
import { canDiscover, canWithAclChain, isControllerRole, canPublishOnLibrary } from "@/lib/permissions";
import { getMyTeamIds } from "@/lib/teams";
import {
  createFolder,
  listenLibraryFolders,
  moveFolderServer,
  moveDocumentsServer,
  renameFolderAndDescendants,
  reorderFolders,
  deleteDocuments,
  listDeletedFolders,
  restoreDeletedFolder,
  type DeletedFolder,
  updateCollectionAppearance,
  updateCollectionHomeConfig,
} from "@/lib/libraryCollections";
import {
  defaultColumnsFromSchema,
  listenEffectiveColumns,
  saveTableView,
  deleteTableView,
  clearTableViewColumns,
  listFoldersWithOwnColumns,
  resolveEffectiveViewState,
} from "@/lib/tableViews";
import { useColumnReorder } from "@/components/documents/useColumnReorder";
import {
  clickItem,
  contextClickItem,
  emptySelection,
  moveFocus,
  pruneSelection,
  selectAll,
  toggleFocused,
  typeAheadTarget,
  type ExplorerSelection,
  type MoveKey,
} from "@/lib/explorerSelection";
import DocContextMenu, { type ContextMenuEntry } from "@/components/documents/DocContextMenu";
import DocGridView from "@/components/documents/DocGridView";
import {
  buildFolderPlan,
  collectDroppedFiles,
  filesFromDirectoryInput,
  isJunkFile,
  FolderUploadLimitError,
  type FolderPlan,
  type PathedFile,
} from "@/lib/folderUpload";
import { makeLibraryStoragePath, uploadToPath } from "@/lib/storage";
import { nudgeEstateResolver } from "@/lib/estate/nudge";
import { estatePost, declareEdge, dismissEdge } from "@/lib/estate/client";
import { nid } from "@/lib/estate/ids";
import type { HomeSuggestion } from "@/lib/estate/watchdog";
import WatchdogBanner from "@/components/documents/WatchdogBanner";
import AlsoFiledHere from "@/components/documents/AlsoFiledHere";
import { useFind } from "@/components/find/useFind";
import FindPanel from "@/components/find/FindPanel";
import FindMap, { type MapFolder } from "@/components/find/FindMap";
import DocInPlace from "@/components/documents/DocInPlace";
import { docRecordFromRow, DOC_LIST_COLUMNS, versionFromRow } from "@/lib/docRecord";
import { folderUnit, folderForUnit } from "@/lib/findEverywhere";
import type {
  AccessControl,
  CheckoutSession,
  DocumentRecord,
  DocumentVersion,
  CheckoutMode,
  LibraryCollection,
  LibraryConfig,
  MetadataFieldDefinition,
  MetadataValue,
  NodeVisibility,
  MetadataFieldType,
  ExplorerLayout,
} from "@/types/schema";
import {
  FolderUp,
  ArrowUpDown,
  Columns,
  ScanSearch,
  CalendarClock,
  ClipboardCheck,
  ShieldCheck,
  KeyRound,
  Pin,
  Check,
  GripVertical,
  Eye,
  ChevronDown,
  Copy,
  ChevronUp,
  FileText,
  FolderPlus,
  LayoutGrid,
  FolderKanban,
  Folder as FolderIcon,
  Layers,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Search,
  Shield,
  Trash2,
  UploadCloud,
  X,
  Archive,
  ArchiveRestore,
  Briefcase,
  Hash,
  Save, ArrowRight,
  Table as TableIcon,
  List as ListIcon,
  Image as ImageIcon,
  Link as LinkIcon,
  Map as MapIcon,
  Library as LibraryIcon,
  RotateCcw,
} from "lucide-react";

const BUILTIN_COLUMNS = [
  { key: "title", label: "Title" },
  { key: "documentNumber", label: "Number" },
  { key: "rev", label: "Rev" },
  { key: "status", label: "Status" },
  { key: "updatedAt", label: "Updated" },
];

// Explorer-style file columns — available in the column manager but not in
// the default set, so existing views don't widen unasked. Values come from
// data every document already carries (upload metadata + timestamps).
const OPTIONAL_BUILTIN_COLUMNS = [
  { key: "size", label: "Size" },
  { key: "fileType", label: "Type" },
  { key: "createdAt", label: "Created" },
];

function formatBytesShort(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function docSizeBytes(d: DocumentRecord): number {
  const raw = (d.metadata ?? {})["size_bytes"];
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isFinite(n) ? n : 0;
}

function docFileExt(d: DocumentRecord): string {
  const meta = (d.metadata ?? {}) as Record<string, unknown>;
  const ext = (typeof meta.extension === "string" && meta.extension)
    || (d.name?.includes(".") ? d.name.split(".").pop() ?? "" : "");
  return ext ? ext.toLowerCase() : "";
}

function safeString(v: unknown) {
  return typeof v === "string" ? v : "";
}

function baseName(filename: string) {
  const idx = filename.lastIndexOf(".");
  return idx > 0 ? filename.slice(0, idx) : filename;
}

// Escape a literal for a LIKE pattern: % and _ are wildcards, \\ escapes.
// Used with .like() on its own (never inside .or(), whose comma/parenthesis
// syntax a document number like "EP 5-3-10 (A)" would break).
function escapeLikeLiteral(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** A filter that looks like one equipment tag or site ID: "x-31", "P11B", "2030.31". */
const isTagQuery = (q: string) => /^[a-z]{1,5}-?\d{1,5}[a-z]?$/i.test(q.trim()) || /^\d{2,6}\.\w{1,6}$/.test(q.trim());
/** A tag in its plain form: "X-31" and "x31" are one. */
const tagKey = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "");
/** Every tag-like word in a row's text, in its plain form. */
const tagTokens = (hay: string) => new Set(hay.split(/[\s,;:"'()[\]{}/]+/).filter(Boolean).map(tagKey));

export default function LibraryExplorerPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const { activeOrgId, activeRole, uid, userEmail } = useRole();

  const libraryId = params.libraryId as string;

  const [library, setLibrary] = useState<LibraryConfig | null>(null);
  const [folders, setFolders] = useState<LibraryCollection[]>([]);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  // Default false — only flip true while a real fetch is in flight, so a
  // transient null activeOrgId (e.g. on refresh before RoleContext resolves)
  // doesn't leave the page wedged on "Loading library...".
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [loadingDocs, setLoadingDocs] = useState(false);
  // The folder whose whole file list is on screen (library|folder|archived):
  // a link to a document is only called dead once ITS folder has finished
  // loading without it.
  const [docsDoneKey, setDocsDoneKey] = useState<string | null>(null);
  const [docLinkTick, setDocLinkTick] = useState(0);
  // Inline-edit state for the documentNumber cell. Click the cell to
  // begin editing; Enter saves, Esc cancels. Auto-suffix-driven
  // ugly numbers can be cleaned up without opening the metadata editor.
  const [editingDocNumId, setEditingDocNumId] = useState<string | null>(null);
  const [editingDocNumValue, setEditingDocNumValue] = useState("");
  const [editingDocNumError, setEditingDocNumError] = useState<string | null>(null);
  const [savingDocNum, setSavingDocNum] = useState(false);
  // Docs stream in progressively (500/page): first page paints, the rest
  // auto-loads. docStreamProgress = rows loaded so far while streaming
  // (null when done); docFetchHitCap = the 10k hard stop was reached.
  const [docStreamProgress, setDocStreamProgress] = useState<number | null>(null);
  const [docFetchHitCap, setDocFetchHitCap] = useState(false);
  const [loadingUpload, setLoadingUpload] = useState(false);
  // Per-batch progress: a bulk upload that shows nothing for two minutes is
  // indistinguishable from one that has died.
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number; phase?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Good news, shown the same way errors now are (in a banner, on screen).
  const [notice, setNotice] = useState<string | null>(null);
  const [showDuplicates, setShowDuplicates] = useState(false);
  // Files from the current staged batch that already landed.
  const landedFilesRef = useRef<WeakSet<File>>(new WeakSet());
  // Set when the database refuses browser-side revision inserts (a row-rule
  // loop); uploads then save each revision through /api/documents/attach-version.
  const versionsViaServerRef = useRef(false);

  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  // The convention watchdog: after an upload or a new folder, what looks
  // like it belongs elsewhere. Non-blocking; link-not-move.
  const [watchdog, setWatchdog] = useState<HomeSuggestion[]>([]);
  const [watchdogBusy, setWatchdogBusy] = useState<string | null>(null);
  const askWatchdog = (what: { documentIds?: string[]; folderIds?: string[] }) => {
    if (!activeOrgId) return;
    void estatePost<{ suggestions: HomeSuggestion[] }>("/api/estate/watchdog", { orgId: activeOrgId, ...what })
      .then((r) => { if (r.suggestions.length) setWatchdog((prev) => [...r.suggestions, ...prev.filter((p) => !r.suggestions.some((n) => n.targetId === p.targetId))]); })
      .catch(() => undefined);
  };
  const watchdogLink = async (sug: HomeSuggestion) => {
    if (!activeOrgId) return;
    setWatchdogBusy(sug.targetId);
    try {
      const isFolder = !documents.some((d) => d.id === sug.targetId) && !!folderMapRef.current?.get(sug.targetId);
      await declareEdge({ orgId: activeOrgId, a: isFolder ? nid.folder(sug.targetId) : nid.doc(sug.targetId), b: nid.folder(sug.home.id), type: "filed_under",
        summary: `Also filed under ${[sug.home.libraryName, ...sug.home.chain].join(" / ")} - ${sug.reason}`, evidence: { unit: sug.unitCode, docType: sug.docType }, actor: { userId: uid, name: userEmail } });
      setWatchdog((prev) => prev.filter((p) => p.targetId !== sug.targetId));
    } catch (e) { setError((e as Error).message); }
    finally { setWatchdogBusy(null); }
  };
  const watchdogDismiss = async (sug: HomeSuggestion) => {
    if (!activeOrgId) return;
    setWatchdogBusy(sug.targetId);
    try {
      const isFolder = !documents.some((d) => d.id === sug.targetId) && !!folderMapRef.current?.get(sug.targetId);
      await dismissEdge({ orgId: activeOrgId, a: isFolder ? nid.folder(sug.targetId) : nid.doc(sug.targetId), b: nid.folder(sug.home.id), type: "filed_under", summary: sug.reason, actor: { userId: uid, name: userEmail } })
        .catch((e: unknown) => setError(`Couldn't remember "Leave it", so it may ask again: ${(e as Error)?.message ?? "try again"}.`));
      setWatchdog((prev) => prev.filter((p) => p.targetId !== sug.targetId));
    } finally { setWatchdogBusy(null); }
  };
  const [search, setSearch] = useState("");
  // One search for everything (tags, IDs, drawing numbers, words inside the
  // documents). It stays on this page. ?find= opens it from the top search
  // bar's "Show on map".
  const [find, setFind] = useState(() => searchParams.get("find") ?? "");
  // A document opened over the page from somewhere it is not listed.
  const [peekDocId, setPeekDocId] = useState<string | null>(null);
  // The map starts folded (the documents come first); opened once, it stays open.
  const [mapOpen, setMapOpenRaw] = useState(false);
  useEffect(() => { try { if (window.localStorage.getItem("docs:mapOpen") === "1") setMapOpenRaw(true); } catch { /* default folded */ } }, []);
  // "New collection" and "Custom home", asked for from the library's menu.
  const [newCollection, setNewCollection] = useState(0);
  const [homeAsk, setHomeAsk] = useState(0);
  const setMapOpen = (fn: (v: boolean) => boolean) => setMapOpenRaw((v) => {
    const next = fn(v);
    try { window.localStorage.setItem("docs:mapOpen", next ? "1" : "0"); } catch { /* per-viewer only */ }
    return next;
  });

  const [selectedDoc, setSelectedDoc] = useState<DocumentRecord | null>(null);
  const [numberingOpen, setNumberingOpen] = useState(false);

  // Recently viewed: opening a document records it (best-effort, cross-device)
  // so the dashboard's "Recently Viewed" widget can pick up where you left off.
  useEffect(() => {
    const docId = selectedDoc?.id;
    if (!docId || !activeOrgId || !uid) return;
    void import("@/lib/recentDocs").then((m) => m.recordDocView(activeOrgId, uid, docId));
  }, [selectedDoc?.id, activeOrgId, uid]);

  // Sweep expired ad-hoc holds where they actually block people — the library
  // page — so a lapsed 24h cap releases on the next visit, not at the nightly
  // cron. Cheap (usually-empty indexed query), fire-and-forget.
  useEffect(() => {
    if (!activeOrgId) return;
    void import("@/lib/projects").then((m) => m.autoReleaseExpiredAdHoc(activeOrgId)).catch(() => undefined);
  }, [activeOrgId]);
  const [selectedVersion, setSelectedVersion] = useState<DocumentVersion | null>(null);
  const [, setSessions] = useState<CheckoutSession[]>([]);

  // Sync selectedDoc with live documents list
  useEffect(() => {
    if (selectedDoc) {
      const fresh = documents.find(d => d.id === selectedDoc.id);
      if (fresh && JSON.stringify(fresh) !== JSON.stringify(selectedDoc)) {
        setSelectedDoc(fresh);
      }
    }
  }, [documents, selectedDoc]);

  const [showColumnManager, setShowColumnManager] = useState(false);
  const [reviewPolicyTarget, setReviewPolicyTarget] = useState<{ level: "library" | "collection"; id: string; name?: string } | null>(null);
  const [ackPolicyTarget, setAckPolicyTarget] = useState<{ level: "library" | "collection"; id: string; name?: string } | null>(null);
  const [ackSummaries, setAckSummaries] = useState<Map<string, AckSummary>>(new Map());
  const [reviewControlTarget, setReviewControlTarget] = useState<{ level: "library" | "collection"; id: string; name?: string } | null>(null);
  const [retentionTarget, setRetentionTarget] = useState<{ level: "library" | "collection"; id: string; name?: string } | null>(null);
  const [recertOpen, setRecertOpen] = useState(false);
  const [showMetadataEditor, setShowMetadataEditor] = useState(false);
  
  // NEW: Wizard State
  const [showCreateColumn, setShowCreateColumn] = useState(false);
  const [wizardInitType, setWizardInitType] = useState<MetadataFieldType>('text');
  const [wizardInitStep, setWizardInitStep] = useState<1 | 2>(1);
  
  // NEW: Checkout Flow State
  const [showCheckoutFlow, setShowCheckoutFlow] = useState(false);
  const [checkoutDoc, setCheckoutDoc] = useState<DocumentRecord | null>(null);

  // ...

  // Helper to open checkout
  const openCheckout = (docRecord: DocumentRecord) => {
    setCheckoutDoc(docRecord);
    setShowCheckoutFlow(true);
  };

  const handleSaveColumn = async (field: MetadataFieldDefinition) => {
    if (!library || !activeOrgId) return;

    try {
      // For now, always update Library to ensure global availability
      const currentCols = library.customColumns || [];
      const updatedCols = [...currentCols, field];

      const { error: colErr } = await supabase.from("libraries").update({ custom_columns: updatedCols, updated_by: uid }).eq("id", library.id!);
      if (colErr) throw colErr;
      setLibrary((prev) => prev ? { ...prev, customColumns: updatedCols } : prev);

      // Auto-add to view (active columns) — schema act, lands org-wide.
      const newActive = [...activeColumns, field.key];
      await updateColumns(newActive, { scope: "org" });

    } catch (e) {
      console.error("Failed to add column", e);
      setError("Couldn't add the column. Try again.");
    }
  };

  const handleSaveUniquenessKeys = async (next: string[]) => {
    if (!library || !activeOrgId) return;
    try {
      const { error: keyErr } = await supabase.from("libraries").update({
        uniqueness_keys: next.length ? next : null,
        updated_by: uid,
      }).eq("id", library.id!);
      if (keyErr) throw keyErr;
      setLibrary((prev) => prev ? { ...prev, uniquenessKeys: next.length ? next : undefined } : prev);
    } catch (e) {
      console.error("Failed to save uniqueness keys", e);
      const f = translatePostgresError(e, { entity: "library" });
      setError(`${f.heading} - ${f.message}`);
    }
  };

  // One-click "fix" from the upload modal banner: ensure the library
  // has a Sheet column AND that 'sheet' is in the uniqueness tuple.
  const handleAddSheetAndUseForUniqueness = async () => {
    if (!library || !activeOrgId) return;
    try {
      const currentCols = library.customColumns ?? [];
      const hasSheet = currentCols.some((c) => /sheet/i.test(c.key) || /sheet/i.test(c.label));
      let nextCols = currentCols;
      if (!hasSheet) {
        nextCols = [...currentCols, { key: "sheet", label: "Sheet", type: "text" }];
        const { error: colErr } = await supabase.from("libraries").update({ custom_columns: nextCols, updated_by: uid }).eq("id", library.id!);
        if (colErr) throw colErr;
      }
      const baseKeys = library.uniquenessKeys?.length ? library.uniquenessKeys : ["documentNumber"];
      const nextKeys = Array.from(new Set([...baseKeys, "sheet"]));
      const { error: keyErr } = await supabase.from("libraries").update({ uniqueness_keys: nextKeys, updated_by: uid }).eq("id", library.id!);
      if (keyErr) throw keyErr;
      setLibrary((prev) => prev ? { ...prev, customColumns: nextCols, uniquenessKeys: nextKeys } : prev);
      if (!hasSheet && !activeColumns.includes("sheet")) {
        await updateColumns([...activeColumns, "sheet"], { scope: "org" });
      }
    } catch (e) {
      console.error("Failed to add Sheet column + uniqueness", e);
      const f = translatePostgresError(e, { entity: "library" });
      setError(`${f.heading} - ${f.message}`);
    }
  };

  const handleSort = (key: string) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  };

  // The drop area answers back like every other drop box (useFileDrag): it
  // lights up and says "Let go to add …". Only FILES from the OS count:
  // internal drags (a folder tile, a document row) carry their own MIME keys
  // and their own drop targets, so they never light it up. The whole drop
  // comes here, so a dropped folder keeps its subfolders.
  const handleDropEvent = (e: React.DragEvent) => {
    // Entries must be captured SYNCHRONOUSLY — the DataTransferItemList is
    // dead once the handler returns. Dropped FOLDERS are traversed and their
    // subtree recreated; plain files take the classic path.
    if (e.dataTransfer.items?.length) {
      // Reading a big tree takes a moment — say so at once, with a running
      // count, instead of a screen that looks frozen.
      let last = 0;
      const { hasDirectories, promise } = collectDroppedFiles(e.dataTransfer.items, (n) => {
        const now = Date.now();
        if (now - last > 120) { last = now; setReadingDrop(n); }
      });
      if (hasDirectories) {
        readingCancelledRef.current = false;
        readingStartRef.current = Date.now();
        setReadingDrop(0);
        void promise
          .then((pathed) => { if (!readingCancelledRef.current) handleUploadPathedFiles(pathed); })
          .catch((err) => {
            setError(err instanceof FolderUploadLimitError
              ? err.message
              : "Couldn't read the dropped folder. Try Upload → A whole folder instead.");
          })
          .finally(() => setReadingDrop(null));
        return;
      }
      // Plain-file drop: the classic path handles it; the traversal promise
      // is redundant here but still running — silence its rejection.
      promise.catch(() => undefined);
    }
    handleUploadFiles(e.dataTransfer.files);
  };
  // onFiles is not used: with the third argument the hook hands over the
  // whole drop (files and folders) to handleDropEvent.
  const fileDrag = useFileDrag(() => undefined, false, handleDropEvent);

  /** Stage a batch that carries subfolder structure (folder drop or the
   *  Upload-folder picker). The tree is only CREATED at upload-confirm time —
   *  cancelling the staging modal creates nothing. */
  const handleUploadPathedFiles = (pathed: PathedFile[]) => {
    // Reset the picker FIRST — an early return must not wedge the input so
    // that re-picking the same folder fires no change event.
    if (folderInputRef.current) folderInputRef.current.value = "";
    if (!pathed.length) {
      setError("That folder contained no uploadable files.");
      return;
    }
    if (!activeOrgId || !uid || !library) return;
    uploadFolderPlanRef.current = null;
    const map = new Map<File, string[]>();
    const hasTree = pathed.some((p) => p.relPath.length > 0);
    if (hasTree && !isController) {
      // Folder creation is a Doc Control act. Members still get their files —
      // flattened into the current folder — and an honest statement of why.
      setError("Creating folders needs Admin or Doc Control rights, so the files were staged flat into this folder.");
    } else if (hasTree) {
      for (const p of pathed) if (p.relPath.length) map.set(p.file, p.relPath);
    }
    uploadPathsRef.current = map;
    setFolderStaged(map.size > 0);
    setPendingUploadFiles(pathed.map((p) => p.file));
    setShowStagingModal(true);
    if (hasTree && isController) setError(null);
  };

  const handleFolderPick = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    try {
      handleUploadPathedFiles(filesFromDirectoryInput(list));
    } catch (err) {
      setError(err instanceof FolderUploadLimitError ? err.message : "Couldn't read that folder.");
      if (folderInputRef.current) folderInputRef.current.value = "";
    }
  };

  /** Create every missing folder in the plan (parents first), reusing
   *  existing folders by case-insensitive name under the same parent —
   *  dropping the same tree twice never duplicates it.
   *
   *  Every node's REAL ACL chain is tracked as the tree is built: a reused
   *  folder contributes its own actual ACL (and its real ancestors'), never
   *  a fabricated one — so a subtree dropped into or through a RESTRICTED
   *  existing folder inherits that restriction in acl_index, exactly as if
   *  each folder had been created by hand. The chains are returned so the
   *  document inserts can index against their true parent chain too. */
  interface EnsuredFolderPlan {
    idByKey: Map<string, string>;
    chainByFolderId: Map<string, AccessControl[]>;
  }
  const ensureFolderPlan = async (plan: FolderPlan, onProgress?: (done: number, total: number) => void): Promise<EnsuredFolderPlan> => {
    const idByKey = new Map<string, string>();
    const chainByFolderId = new Map<string, AccessControl[]>();
    if (!activeOrgId || !uid || !library) return { idByKey, chainByFolderId };
    const existingByParent = new Map<string | null, Map<string, string>>();
    for (const f of folders) {
      const k = f.parentId ?? null;
      if (!existingByParent.has(k)) existingByParent.set(k, new Map());
      existingByParent.get(k)!.set(f.name.trim().toLowerCase(), f.id!);
    }
    const register = (parentId: string | null, name: string, id: string) => {
      if (!existingByParent.has(parentId)) existingByParent.set(parentId, new Map());
      existingByParent.get(parentId)!.set(name.trim().toLowerCase(), id);
    };
    const baseChain = buildFolderChain(currentFolder);
    const chainOf = (folderId: string | null): AccessControl[] => {
      if (folderId === (currentFolderId ?? null)) return baseChain;
      if (folderId && chainByFolderId.has(folderId)) return chainByFolderId.get(folderId)!;
      if (folderId) {
        const f = folderMap.get(folderId);
        if (f) return buildFolderChain(f);
      }
      return baseChain;
    };
    const createdIds: string[] = [];
    let made = 0;
    const makeNode = async (node: FolderPlan["folders"][number]) => {
      const parentCollectionId = node.parentKey
        ? idByKey.get(node.parentKey) ?? (currentFolderId ?? null)
        : (currentFolderId ?? null);
      const reuse = existingByParent.get(parentCollectionId)?.get(node.name.trim().toLowerCase());
      if (reuse) {
        idByKey.set(node.key, reuse);
        chainByFolderId.set(reuse, chainOf(reuse));
        return;
      }
      const newAcl = library.defaultNewAcl
        ?? (library.folderSecurity === "Granular"
          ? { inherit: true, visibility: library.defaultNewVisibility ?? "normal", rules: [] }
          : undefined);
      const newId = await createFolder({
        orgId: activeOrgId,
        libraryId,
        parentId: parentCollectionId,
        name: node.name,
        visibility: library.defaultNewVisibility ?? "normal",
        acl: newAcl,
        createdBy: uid,
      });
      const parentChain = chainOf(parentCollectionId);
      const myChain = newAcl ? [...parentChain, newAcl] : parentChain;
      if (newAcl) {
        const aclIndex = buildAclIndexFromChain(myChain);
        // A failed index write would leave the folder's RLS index missing its
        // inherited restrictions — that must fail the upload, not pass silently.
        const { error: idxErr } = await supabase.from("collections")
          .update({ acl_index: aclIndex ?? null }).eq("id", newId);
        if (idxErr) throw new Error(`Couldn't apply permissions to the new folder "${node.name}": ${idxErr.message}`);
      }
      createdIds.push(newId);
      chainByFolderId.set(newId, myChain);
      register(parentCollectionId, node.name, newId);
      idByKey.set(node.key, newId);
    };
    // Level by level (a folder needs its parent's id), but every folder on
    // a level is created in parallel — a 100-folder tree used to be 100+
    // round trips in a row before the first file moved.
    const levels = new Map<number, Array<FolderPlan["folders"][number]>>();
    for (const n of plan.folders) {
      const l = levels.get(n.depth);
      if (l) l.push(n); else levels.set(n.depth, [n]);
    }
    for (const depth of [...levels.keys()].sort((a, b) => a - b)) {
      const queue = [...levels.get(depth)!];
      await Promise.all(Array.from({ length: Math.min(6, queue.length) }, async () => {
        for (let n = queue.shift(); n; n = queue.shift()) {
          await makeNode(n);
          onProgress?.(++made, plan.folders.length);
        }
      }));
    }
    if (createdIds.length) nudgeEstateResolver(activeOrgId, { folderIds: createdIds });
    return { idByKey, chainByFolderId };
  };
  // Survives a partial-failure retry so a second Upload click reuses the
  // folders already created instead of racing the folders listener and
  // creating the tree twice. Cleared when a new batch is staged.
  const uploadFolderPlanRef = useRef<EnsuredFolderPlan | null>(null);

  // ── Explorer selection ─────────────────────────────────────────────
  // All gestures funnel through the pure engine so click, checkbox, keyboard
  // and right-click keep ONE consistent selection with anchor semantics.
  const currentSelection = (): ExplorerSelection => ({
    ids: selectedDocIds,
    anchorId: selAnchorRef.current,
    focusId: selFocusId,
  });
  const applySelection = (next: ExplorerSelection) => {
    setSelectedDocIds(new Set(next.ids));
    selAnchorRef.current = next.anchorId;
    setSelFocusId(next.focusId);
  };
  const clearSelection = () => applySelection(emptySelection());
  const orderedDocIds = (): string[] => sortedDocs.map((d) => d.id!).filter(Boolean);

  const scrollDocIntoView = (id: string | null) => {
    if (!id) return;
    requestAnimationFrame(() => {
      document.querySelector(`[data-doc-item="${id}"]`)?.scrollIntoView({ block: "nearest" });
    });
  };

  /** Row/card click — Windows semantics: plain selects one (and focuses the
   *  inspector), ctrl toggles, shift ranges from the anchor. */
  const handleRowClick = (docRecord: DocumentRecord, e: React.MouseEvent) => {
    const mods = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
    // Shift-click would otherwise smear a text selection across the rows.
    if (mods.shift) window.getSelection()?.removeAllRanges();
    applySelection(clickItem(currentSelection(), orderedDocIds(), docRecord.id!, mods));
    if (!mods.ctrl && !mods.shift) setSelectedDoc(docRecord);
  };

  const handleRowDoubleClick = (docRecord: DocumentRecord) => {
    setSelectedDoc(docRecord);
    setShowFullScreen(true);
  };

  const handleRowContextMenu = (docRecord: DocumentRecord, e: React.MouseEvent) => {
    e.preventDefault();
    applySelection(contextClickItem(currentSelection(), orderedDocIds(), docRecord.id!));
    setCtxMenu({ x: e.clientX, y: e.clientY, doc: docRecord });
  };

  const toggleSelectDoc = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    applySelection(clickItem(currentSelection(), orderedDocIds(), id, { ctrl: true }));
  };

  const toggleSelectAll = () => {
    if (selectedDocIds.size === sortedDocs.length && sortedDocs.length > 0)
      clearSelection();
    else
      applySelection(selectAll(orderedDocIds()));
  };

  /** Shared drag source for table rows AND grid cards: dragging a selected
   *  item drags the whole selection; anything else drags just itself. */
  const handleDocDragStart = (docRecord: DocumentRecord, e: React.DragEvent) => {
    const ids = selectedDocIds.has(docRecord.id!) && selectedDocIds.size > 1
      ? [...selectedDocIds]
      : [docRecord.id!];
    e.dataTransfer.setData("application/x-doc-ids", JSON.stringify(ids));
    e.dataTransfer.effectAllowed = "move";
    if (ids.length > 1) {
      const ghost = document.createElement("div");
      ghost.textContent = `${ids.length} documents`;
      ghost.style.cssText =
        "position:absolute;top:-1000px;padding:6px 12px;background:#1e293b;color:#fff;"
        + "border-radius:10px;font-size:12px;font-weight:700;";
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 12, 12);
      setTimeout(() => ghost.remove(), 0);
    }
  };

  // ── Cut / copy / paste / undo ──────────────────────────────────────
  const pushUndo = (entry: UndoEntry) => {
    undoStackRef.current.push(entry);
    if (undoStackRef.current.length > 20) undoStackRef.current.shift();
  };

  /** Ctrl+X — mark the selection for a move. Rows dim until pasted. */
  const cutSelection = () => {
    if (!isController || selectedDocIds.size === 0) return;
    const sources = new Map<string, string | null>();
    for (const d of documents) {
      if (selectedDocIds.has(d.id!)) sources.set(d.id!, d.collectionId ?? null);
    }
    cutSourceRef.current = sources;
    setCutDocIds(new Set(selectedDocIds));
  };

  /** Ctrl+V — move the cut documents into the folder being viewed. */
  const pasteCut = async () => {
    if (!isController || cutDocIds.size === 0) return;
    const ids = [...cutDocIds];
    const target = currentFolderId ?? null;
    // Skip no-op pastes back into the source folder.
    const moving = ids.filter((id) => (cutSourceRef.current.get(id) ?? null) !== target);
    setCutDocIds(new Set());
    if (moving.length === 0) return;
    try {
      await moveDocumentsServer({ orgId: activeOrgId!, docIds: moving, targetFolderId: target });
      // Undo restores each doc to the folder it was CUT from.
      const bySource = new Map<string | null, string[]>();
      for (const id of moving) {
        const src = cutSourceRef.current.get(id) ?? null;
        const arr = bySource.get(src);
        if (arr) arr.push(id); else bySource.set(src, [id]);
      }
      pushUndo({
        kind: "docs",
        label: `Moved ${moving.length} document${moving.length === 1 ? "" : "s"}`,
        groups: [...bySource.entries()].map(([targetFolderId, docIds]) => ({ docIds, targetFolderId })),
      });
      nudgeKnowledgeSources(activeOrgId!, libraryId);
      setDocsRefreshTick((t) => t + 1);
      setError(`Moved ${moving.length} document${moving.length === 1 ? "" : "s"} here. Ctrl+Z undoes it.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't paste the documents.");
    }
  };

  /** Ctrl+C — copy the selected documents' permanent /d/ links. */
  const copySelectionLinks = () => {
    const rows = sortedDocs.filter((d) => selectedDocIds.has(d.id!));
    if (rows.length === 0) return;
    const text = rows
      .map((d) => d.documentNumber
        ? `${window.location.origin}/d/${encodeURIComponent(d.documentNumber)}`
        : (d.title || d.name || d.id))
      .join("\n");
    void navigator.clipboard?.writeText(text);
    setError(`Copied ${rows.length} document link${rows.length === 1 ? "" : "s"} to the clipboard.`);
  };

  /** Ctrl+Z — reverse the most recent move. */
  const undoLastMove = async () => {
    if (undoBusy) return;
    const entry = undoStackRef.current.pop();
    if (!entry) return;
    setUndoBusy(true);
    try {
      if (entry.kind === "docs") {
        for (const g of entry.groups) {
          await moveDocumentsServer({ orgId: activeOrgId!, docIds: g.docIds, targetFolderId: g.targetFolderId });
        }
      } else {
        await moveFolderServer({ orgId: activeOrgId!, collectionId: entry.collectionId, newParentId: entry.targetParentId });
      }
      nudgeKnowledgeSources(activeOrgId!, libraryId);
      setDocsRefreshTick((t) => t + 1);
      setError(`Undid: ${entry.label}.`);
    } catch (e) {
      // The reversal failed — put the entry back so Ctrl+Z can retry.
      undoStackRef.current.push(entry);
      setError(e instanceof Error ? e.message : "Couldn't undo that move.");
    } finally {
      setUndoBusy(false);
    }
  };

  // ── Inline title rename (details layout) ───────────────────────────
  const startTitleEdit = (docRecord: DocumentRecord) => {
    setEditingTitleId(docRecord.id!);
    setEditingTitleValue(docRecord.title || docRecord.name || "");
  };
  const saveInlineTitle = async (docId: string, value: string) => {
    const title = value.trim();
    setSavingTitle(true);
    try {
      if (title) {
        const { error: upErr } = await supabase.from("documents")
          .update({ title, updated_at: new Date().toISOString(), updated_by: uid ?? null })
          .eq("id", docId);
        if (upErr) throw new Error(upErr.message);
        setDocuments((prev) => prev.map((d) => (d.id === docId ? { ...d, title } : d)));
      }
      setEditingTitleId(null);
      setEditingTitleValue("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't rename the document.");
    } finally {
      setSavingTitle(false);
    }
  };

  // ── Marquee (rubber-band) selection ────────────────────────────────
  // Starts on empty space inside a [data-doc-marquee] container; selects
  // every [data-doc-item] whose box intersects the rectangle. Ctrl adds to
  // the selection present when the drag began.
  const marqueeRef = useRef<{ x1: number; y1: number; base: Set<string>; moved: boolean } | null>(null);
  const handleMarqueeMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // Never from the header row: a press there sorts or moves a column.
    if (target.closest("[data-doc-item], button, a, input, textarea, select, thead")) return;
    const base = e.ctrlKey || e.metaKey ? new Set(selectedDocIds) : new Set<string>();
    marqueeRef.current = { x1: e.clientX, y1: e.clientY, base, moved: false };
    const container = e.currentTarget as HTMLElement;
    const onMove = (ev: MouseEvent) => {
      const st = marqueeRef.current;
      if (!st) return;
      if (!st.moved && Math.abs(ev.clientX - st.x1) < 4 && Math.abs(ev.clientY - st.y1) < 4) return;
      st.moved = true;
      ev.preventDefault();
      const rect = {
        left: Math.min(st.x1, ev.clientX), right: Math.max(st.x1, ev.clientX),
        top: Math.min(st.y1, ev.clientY), bottom: Math.max(st.y1, ev.clientY),
      };
      setMarquee({ x1: rect.left, y1: rect.top, x2: rect.right, y2: rect.bottom });
      const hits = new Set(st.base);
      let lastHit: string | null = null;
      container.querySelectorAll("[data-doc-item]").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.left < rect.right && r.right > rect.left && r.top < rect.bottom && r.bottom > rect.top) {
          const id = el.getAttribute("data-doc-item");
          if (id) { hits.add(id); lastHit = id; }
        }
      });
      applySelection({ ids: hits, anchorId: lastHit, focusId: lastHit });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      marqueeRef.current = null;
      setMarquee(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // ── Folder tile multi-select (ctrl/shift; plain click still OPENS) ──
  const folderOrderIds = (): string[] => filteredFolders.map((f) => f.id!).filter(Boolean);
  const handleFolderTileSelect = (id: string, mods: { ctrl: boolean; shift: boolean }) => {
    const next = clickItem(
      { ids: selectedFolderIds, anchorId: folderAnchorRef.current, focusId: folderAnchorRef.current },
      folderOrderIds(), id, mods,
    );
    setSelectedFolderIds(new Set(next.ids));
    folderAnchorRef.current = next.anchorId;
  };
  // Multi-folder drag-move: dragging a SELECTED tile moves the whole set.
  const dropMoveFolders = async (dragIds: string[], targetId: string | null) => {
    const ids = dragIds.filter((id) => id !== targetId);
    for (const id of ids) {
      // Sequential — each move revalidates cycles against the live tree,
      // and dropMoveFolder records its own undo entry.
      await dropMoveFolder(id, targetId);
    }
    setSelectedFolderIds(new Set());
  };

  /** How many tiles per row the current grid actually renders — measured,
   *  because auto-fill makes the count viewport-dependent. */
  const measureGridColumns = (): number => {
    const el = document.querySelector("[data-doc-grid]");
    if (!el) return 1;
    const cols = window.getComputedStyle(el).gridTemplateColumns.split(" ").filter(Boolean).length;
    return Math.max(1, cols);
  };

  // Serializes keyboard-triggered bulk actions so key-repeat can't queue a
  // stack of confirm dialogs (appConfirm queues, it doesn't dedupe).
  const bulkKeyBusyRef = useRef(false);

  /** The full Explorer keyboard model, attached to the explorer card. Skips
   *  anything typed into an input/inline editor and any focused button (they
   *  keep their native Enter/Space), and goes quiet while the context menu
   *  is open — the menu owns the keyboard then. */
  const handleExplorerKeyDown = (e: React.KeyboardEvent) => {
    if (ctxMenu) return;
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, button, a, [contenteditable='true'], [role='menu'], [role='dialog']")) return;
    const order = orderedDocIds();
    const mods = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };

    if (mods.ctrl && e.key.toLowerCase() === "a") {
      e.preventDefault();
      applySelection(selectAll(order));
      return;
    }
    // Explorer clipboard verbs. Cut/paste are moves (controllers, like every
    // reorganizing act); copy hands out permanent /d/ links — duplicating a
    // CONTROLLED document would mint a second source of truth, so it doesn't.
    if (mods.ctrl && e.key.toLowerCase() === "x" && !e.repeat) {
      if (isController && selectedDocIds.size > 0) { e.preventDefault(); cutSelection(); }
      return;
    }
    if (mods.ctrl && e.key.toLowerCase() === "c" && !e.repeat) {
      if (selectedDocIds.size > 0) { e.preventDefault(); copySelectionLinks(); }
      return;
    }
    if (mods.ctrl && e.key.toLowerCase() === "v" && !e.repeat) {
      if (isController && cutDocIds.size > 0) { e.preventDefault(); void pasteCut(); }
      return;
    }
    if (mods.ctrl && e.key.toLowerCase() === "z" && !e.repeat) {
      if (isController && undoStackRef.current.length > 0) { e.preventDefault(); void undoLastMove(); }
      return;
    }
    // In the tile layouts, up/down move by a full ROW (measured column
    // count) and left/right by one — real 2D navigation. In the row
    // layouts, left/right alias up/down.
    const gridMode = docLayout === "grid" || docLayout === "thumbs";
    const cols = gridMode ? measureGridColumns() : 1;
    const MOVE_KEYS: Record<string, { key: MoveKey; page: number }> = {
      ArrowDown: gridMode ? { key: "pageDown", page: cols } : { key: "down", page: 1 },
      ArrowUp: gridMode ? { key: "pageUp", page: cols } : { key: "up", page: 1 },
      ArrowRight: { key: "down", page: 1 },
      ArrowLeft: { key: "up", page: 1 },
      Home: { key: "home", page: 1 },
      End: { key: "end", page: 1 },
      PageDown: { key: "pageDown", page: gridMode ? cols * 4 : 12 },
      PageUp: { key: "pageUp", page: gridMode ? cols * 4 : 12 },
    };
    if (MOVE_KEYS[e.key]) {
      e.preventDefault();
      const mv = MOVE_KEYS[e.key];
      const next = moveFocus(currentSelection(), order, mv.key, mods, mv.page);
      applySelection(next);
      scrollDocIntoView(next.focusId);
      return;
    }
    if (e.key === " " && mods.ctrl) {
      e.preventDefault();
      applySelection(toggleFocused(currentSelection()));
      return;
    }
    if (e.key === "Enter" && !e.repeat) {
      const doc = sortedDocs.find((d) => d.id === selFocusId);
      if (doc) { e.preventDefault(); handleRowDoubleClick(doc); }
      return;
    }
    if (e.key === "F2" && !e.repeat) {
      const doc = sortedDocs.find((d) => d.id === selFocusId);
      if (doc && docLayout === "details") {
        e.preventDefault();
        setEditingDocNumId(doc.id!);
        setEditingDocNumValue(doc.documentNumber || "");
        setEditingDocNumError(null);
      }
      return;
    }
    if (e.key === "Delete" && selectedDocIds.size > 0 && isController) {
      e.preventDefault();
      if (e.repeat || bulkKeyBusyRef.current) return;
      bulkKeyBusyRef.current = true;
      // Explorer's Delete = recycle (archive); Shift+Delete = permanent.
      const run = mods.shift ? handleBulkDelete() : handleBulkArchive();
      void run.finally(() => { bulkKeyBusyRef.current = false; });
      return;
    }
    if (e.key === "Escape") {
      if (cutDocIds.size > 0) setCutDocIds(new Set()); // cancel a pending cut first
      else clearSelection();
      return;
    }
    // Type-ahead: printable characters spell a document number/title.
    // stopPropagation so global single-key bindings (the "/" palette
    // shortcut) don't fire while the user is addressing the file list.
    if (e.key.length === 1 && !mods.ctrl && !e.altKey) {
      e.stopPropagation();
      const ta = typeAheadRef.current;
      if (ta.timer) clearTimeout(ta.timer);
      ta.buffer += e.key;
      ta.timer = setTimeout(() => { ta.buffer = ""; ta.timer = null; }, 700);
      const items = sortedDocs.map((d) => ({
        id: d.id!,
        label: d.documentNumber || d.title || d.name || "",
      }));
      const hit = typeAheadTarget(items, ta.buffer, selFocusId);
      if (hit) {
        e.preventDefault();
        applySelection(clickItem(currentSelection(), order, hit, {}));
        scrollDocIntoView(hit);
      }
    }
  };

  const handleBulkDelete = async () => {
    if (!activeOrgId || selectedDocIds.size === 0) return;
    const ids = Array.from(selectedDocIds);
    // Records management: legal holds freeze records against deletion. The
    // server checks again (its word is final) and skips anything held.
    // Sliced: ids ride in the URL, and a select-all of hundreds overflowed it.
    const held: Array<Record<string, unknown>> = [];
    for (let i = 0; i < ids.length; i += 100) {
      const { data } = await supabase.from("documents")
        .select("id, document_number, title, name")
        .in("id", ids.slice(i, i + 100)).eq("legal_hold", true);
      held.push(...((data ?? []) as Array<Record<string, unknown>>));
    }
    const heldN = held.length;
    if (heldN === ids.length) {
      const label = held[0];
      setError(`${heldN === 1 ? "That document is" : "Those documents are"} under a legal hold (e.g. ${(label.document_number as string) || (label.title as string) || (label.name as string) || "a record"}) and can't be deleted. Release the hold first.`);
      return;
    }
    if (!(await appConfirm({
      title: `Permanently delete ${ids.length - heldN} document${ids.length - heldN === 1 ? "" : "s"}?`,
      message: "Every revision of each is deleted. This cannot be undone." +
        (heldN ? ` ${heldN} selected record${heldN === 1 ? " is" : "s are"} under a legal hold and will be kept.` : "") +
        " To hide documents but keep them recoverable, use Archive instead.",
      confirmLabel: "Delete permanently",
      tone: "danger",
    }))) return;
    setBulkDeleting({ done: 0, total: ids.length - heldN });
    // The delete itself fires a change event per row; refreshing the list
    // for each made the rows blink. Rows leave the screen as the server
    // confirms them instead, and the list reloads once at the end.
    const dropFromView = (gone: Set<string>) => {
      setDocuments((prev) => prev.filter((d) => !gone.has(d.id!)));
      for (const [k, v] of folderDocsCache.current) folderDocsCache.current.set(k, v.filter((d) => !gone.has(d.id!)));
    };
    bulkBusyRef.current = true;
    try {
      const r = await deleteDocuments(activeOrgId, ids, (done, just) => {
        setBulkDeleting({ done, total: ids.length - heldN });
        dropFromView(new Set(just));
      });
      const gone = new Set(r.deleted);
      dropFromView(gone);
      setSelectedDocIds(new Set(r.held.map((h) => h.id)));
      if (selectedDoc?.id && gone.has(selectedDoc.id)) setSelectedDoc(null);
      if (r.held.length) setError(`${r.deleted.length} deleted. ${r.held.length} kept - under a legal hold (e.g. ${r.held[0].label}).`);
      nudgeKnowledgeSources(activeOrgId, libraryId);
    } catch (e) {
      // Loud: a banner at the top of a long list is easy to miss, and a
      // delete that silently didn't happen is the worst outcome.
      const msg = (e as Error).message;
      setError(`Delete failed: ${msg}`);
      setDocsRefreshTick((t) => t + 1);
      void appAlert({ title: "Delete failed", message: msg, tone: "danger" });
    } finally {
      bulkBusyRef.current = false;
      setBulkDeleting(null);
      setDocsRefreshTick((t) => t + 1);
    }
  };

  // Bulk archive — preserves history, sets status=Archived. Reversible
  // via the metadata editor or the per-doc inspector.
  const handleBulkArchive = async () => {
    if (selectedDocIds.size === 0) return;
    if (!(await appConfirm({ title: `Archive ${selectedDocIds.size} document${selectedDocIds.size === 1 ? "" : "s"}?`, message: "They keep their history but disappear from the default view." }))) return;
    const ids = Array.from(selectedDocIds);
    const now = new Date().toISOString();
    // Sliced (ids ride in the URL) and checked — a failed slice used to be
    // ignored while the screen showed everything archived.
    const done = new Set<string>();
    let failure: string | null = null;
    for (let i = 0; i < ids.length; i += 100) {
      const slice = ids.slice(i, i + 100);
      const { error: archErr } = await supabase.from("documents").update({
        status: "Archived",
        archived_at: now,
        archived_by: uid ?? null,
        updated_at: now,
        updated_by: uid ?? null,
      }).in("id", slice);
      if (archErr) { failure = archErr.message; break; }
      slice.forEach((id) => done.add(id));
    }
    setDocuments((prev) => prev.map((d) =>
      done.has(d.id!) ? { ...d, status: "Archived" as DocumentRecord["status"] } : d
    ));
    folderDocsCache.current.clear();
    setSelectedDocIds(new Set(ids.filter((id) => !done.has(id))));
    // Archived = no longer in force: knowledge libraries linked here set
    // their index aside now, not at the next background sync.
    if (done.size && activeOrgId) nudgeKnowledgeSources(activeOrgId, libraryId);
    if (failure) setError(`Archived ${done.size} of ${ids.length}. The rest failed: ${failure}`);
  };

  const handleStageSelected = () => {
    setStagedDocs((prev) => {
      const existingIds = new Set(prev.map((d) => d.id));
      const toAdd = sortedDocs.filter((d) => selectedDocIds.has(d.id!) && !existingIds.has(d.id));
      return [...prev, ...toAdd];
    });
    setSelectedDocIds(new Set());
  };

  const handleStageDoc = (docRecord: DocumentRecord, e: React.MouseEvent) => {
    e.stopPropagation();
    setStagedDocs((prev) => {
      if (prev.some((d) => d.id === docRecord.id)) {
        return prev.filter((d) => d.id !== docRecord.id);
      }
      return [...prev, docRecord];
    });
  };

  const handleUnstage = (id: string) => {
    setStagedDocs((prev) => prev.filter((d) => d.id !== id));
  };

  const handleClearStaged = () => setStagedDocs([]);

  const handleAddColumnClick = (type: MetadataFieldType) => {
    setWizardInitType(type);
    setWizardInitStep(2); // Jump to config
    setShowCreateColumn(true);
  };

  const [showMoveModal, setShowMoveModal] = useState(false);
  const [showMoveDocModal, setShowMoveDocModal] = useState(false);
  const [showBulkMoveModal, setShowBulkMoveModal] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showPermissions, setShowPermissions] = useState(false);
  const [showLibraryPerms, setShowLibraryPerms] = useState(false);
  const [showSetManager, setShowSetManager] = useState(false);
  const [showEquipmentSweep, setShowEquipmentSweep] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  // Folder trash (30-day delete hold): null = closed, array = open with rows.
  const [trashFolders, setTrashFolders] = useState<DeletedFolder[] | null>(null);
  const [trashBusy, setTrashBusy] = useState<string | null>(null);
  const [renameFolderId, setRenameFolderId] = useState<string | null>(null);
  const [customizeFolderId, setCustomizeFolderId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // A failed create/rename says so inside the dialog that asked for it.
  const [folderErr, setFolderErr] = useState<string | null>(null);
  const [bulkMoreOpen, setBulkMoreOpen] = useState(false);

  // UX enhancements
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  // Explorer selection companions: the shift-range anchor and the keyboard
  // focus. Together with selectedDocIds they form the ExplorerSelection the
  // pure engine (lib/explorerSelection) operates on.
  const selAnchorRef = useRef<string | null>(null);
  const [selFocusId, setSelFocusId] = useState<string | null>(null);
  // Type-ahead buffer ("P-10" jumps to P-101), reset after 700ms of silence.
  const typeAheadRef = useRef<{ buffer: string; timer: ReturnType<typeof setTimeout> | null }>({ buffer: "", timer: null });
  // Document layout: details table | compact list | tiles | large previews.
  const [docLayout, setDocLayout] = useState<ExplorerLayout>("details");
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [viewDefaults, setViewDefaults] = useState<{ hasUserRow: boolean; hasOrgRow: boolean }>({ hasUserRow: false, hasOrgRow: false });
  // Right-click context menu target (position + document).
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; doc: DocumentRecord } | null>(null);
  // Cut (Ctrl+X) marks documents for a move; Ctrl+V drops them into the
  // folder you're viewing. Marked rows dim, exactly like Explorer.
  const [cutDocIds, setCutDocIds] = useState<Set<string>>(new Set());
  // Where each cut doc CAME from — captured at cut time so paste can be undone.
  const cutSourceRef = useRef<Map<string, string | null>>(new Map());
  // Undo stack for moves (docs + folders). Ctrl+Z pops and reverses.
  type UndoEntry =
    | { kind: "docs"; label: string; groups: Array<{ docIds: string[]; targetFolderId: string | null }> }
    | { kind: "folder"; label: string; collectionId: string; targetParentId: string | null };
  const undoStackRef = useRef<UndoEntry[]>([]);
  const [undoBusy, setUndoBusy] = useState(false);
  // Marquee (rubber-band) selection rectangle, in viewport coordinates.
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  // Inline title rename (details layout) — the second F2 field.
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [editingTitleValue, setEditingTitleValue] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  // Multi-select over FOLDER tiles (ctrl/shift+click; plain click still opens).
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(new Set());
  const folderAnchorRef = useRef<string | null>(null);
  const [sortKey, setSortKey] = useState<string>("updatedAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  // The current folder's saved default sort (null = none, use app default).
  // This is per-folder and shared (controllers set it for everyone), so a
  // folder can open "Sheet Number, ascending" while others open differently.
  const [folderDefaultSort, setFolderDefaultSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);
  const [savingSortDefault, setSavingSortDefault] = useState(false);
  // Tracks the folder we've already applied the saved default to, so an
  // in-session manual re-sort isn't clobbered when the effect re-runs.
  const sortAppliedFolderRef = useRef<string | null>(null);

  // Staging area — persists across folder navigation
  const [stagedDocs, setStagedDocs] = useState<DocumentRecord[]>([]);
  const [showMultiView, setShowMultiView] = useState(false);
  // Which curated collection the open book represents (for the ?book=<id> deep
  // link). Null when the book was opened from an ad-hoc staged set.
  const [openBookId, setOpenBookId] = useState<string | null>(null);

  // Metadata-first upload staging (Phase 1)
  const [pendingUploadFiles, setPendingUploadFiles] = useState<File[]>([]);
  const [showStagingModal, setShowStagingModal] = useState(false);

  // Phase 4 + 5: views + library reorder
  const [showLibraryOrderModal, setShowLibraryOrderModal] = useState(false);
  const [showViewSelector, setShowViewSelector] = useState(false);

  // Cockpit UI
  const [density, setDensity] = useState<"compact" | "comfy">("compact");
  const [commandOpen, setCommandOpen] = useState(false);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);

  // Column resize state — persisted to libraries.column_widths in Supabase
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const colWidthsRef = useRef<Record<string, number>>({});
  const resizingRef = useRef<{ key: string; startX: number; startWidth: number } | null>(null);
  const resizeClickGuardRef = useRef(false);
  const saveWidthsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep colWidthsRef in sync so resize handler can read latest value on mouseup
  useEffect(() => { colWidthsRef.current = colWidths; }, [colWidths]);

  const [activeColumns, setActiveColumns] = useState<string[]>([]);
  // Which saved levels set this folder's columns: your own here, the org's
  // here, the library default (its columns), else the app default. The
  // first one present wins, in that order.
  const [colLevels, setColLevels] = useState<{ user: boolean; folder: boolean; library: string[] | null }>({ user: false, folder: false, library: null });
  // Other folders of this library with org columns of their own (they don't
  // follow the library default). Counted when the column manager opens.
  const [foldersWithOwnColumns, setFoldersWithOwnColumns] = useState<(string | null)[]>([]);
  const [columnDefs, setColumnDefs] = useState<MetadataFieldDefinition[]>([]);
  const [showFullScreen, setShowFullScreen] = useState(false);
  const [showRevUp, setShowRevUp] = useState(false);
  const [showBulkCheckout, setShowBulkCheckout] = useState(false);
  const [showBulkEdit, setShowBulkEdit] = useState(false);
  const [showCsvImport, setShowCsvImport] = useState(false);
  const [showSupersede, setShowSupersede] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [revertTarget, setRevertTarget] = useState<DocumentVersion | null>(null);
  // Hide archived docs from the default library list. Admins can toggle.
  const [showArchivedDocs, setShowArchivedDocs] = useState(false);
  // Bumped after a successful rev-up to force VersionHistoryPanel to re-fetch.
  const [versionHistoryRefreshKey, setVersionHistoryRefreshKey] = useState(0);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // <input webkitdirectory> — the "Upload folder" picker.
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  // File → subfolder path for the current staged batch. Files keep object
  // identity through the staging modal, so this map is how a dropped tree's
  // structure survives to the actual upload without touching the modal.
  const uploadPathsRef = useRef<Map<File, string[]>>(new Map());
  // True while the staged batch is a folder tree (the staging window leads
  // with "upload as-is" instead of a row per file).
  const [folderStaged, setFolderStaged] = useState(false);
  // Files found so far while a dropped folder is being read (null = idle).
  const [readingDrop, setReadingDrop] = useState<number | null>(null);
  const readingCancelledRef = useRef(false);
  const readingStartRef = useRef(0);
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);
  // Folders waiting on the delete window (one, or every selected tile).
  const [deleteFolders, setDeleteFolders] = useState<Array<{ id: string; name: string }> | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState<{ done: number; total: number } | null>(null);

  // ... (useEffect hooks)

  const handleForceUnlock = async (docRecord: DocumentRecord) => {
    if (!docRecord.id || !activeOrgId) return;
    if (!(await appConfirm({ title: `Force release lock for ${docRecord.title}?`, message: "This ends every active session and closes the checkout.", tone: "danger" }))) return;

    try {
      // Ends all sessions, closes the checkout episode, clears the lock +
      // collaborator columns, and posts the system alert into the episode log.
      await forceReleaseDocument({
        orgId: activeOrgId,
        documentId: docRecord.id,
        actorUserId: uid ?? "unknown",
        actorName: userEmail?.split("@")[0] || "Admin",
      });
    } catch (e) {
      console.error("Force unlock failed", e);
      setError(`Couldn't release the lock: ${(e as Error)?.message ?? "try again"}.`);
    }
  };

  const confirmDeleteDoc = async () => {
    if (!selectedDoc?.id) return;
    // Records management: a legal hold freezes the record — no deletion until it's
    // released. Checked against the DB (server truth), not just the cached row.
    if (await isLegalHold(selectedDoc.id)) {
      setError("This record is under a legal hold and can't be deleted. Release the hold first.");
      return;
    }
    if (!(await appConfirm({
      title: `Delete "${selectedDoc.title || selectedDoc.name || selectedDoc.documentNumber || "this document"}"?`,
      message: "This removes the document and every revision of it. This cannot be undone. To hide it but keep it, use Archive instead.",
      tone: "danger",
    }))) return;

    setError(null);
    try {
      // Foreign keys require us to delete versions BEFORE the parent
      // document — otherwise the constraint rejects the delete and
      // the UI silently does nothing. Order matters:
      //   1. Null out documents.current_version_id (it FKs to versions)
      //   2. Delete every document_versions row pointing to this doc
      //   3. Delete the document itself
      // We log every step so a failure is visible in the console.
      const docId = selectedDoc.id;
      console.log("[delete] starting doc delete", docId);

      // Step 1: detach current_version pointer (avoids circular FK)
      const { error: e1 } = await supabase
        .from("documents")
        .update({ current_version_id: null })
        .eq("id", docId);
      if (e1) throw new Error(`Couldn't clear current version pointer: ${e1.message}`);

      // Step 2: delete child versions
      const { error: e2 } = await supabase
        .from("document_versions")
        .delete()
        .eq("record_id", docId);
      if (e2) throw new Error(`Couldn't delete revisions: ${e2.message}`);

      // Step 3: delete the document
      const { error: e3 } = await supabase
        .from("documents")
        .delete()
        .eq("id", docId);
      if (e3) throw new Error(`Couldn't delete document: ${e3.message}`);

      console.log("[delete] success", docId);
      setDocuments(prev => prev.filter(d => d.id !== docId));
      setSelectedDoc(null);
      setSelectedVersion(null);
    } catch (e) {
      console.error("[delete] failed", e);
      const msg = (e as Error).message || String(e);
      // Surface loudly — silent failure is the worst UX
      setError(`Delete failed: ${msg}`);
      await appAlert({ title: "Delete failed", message: msg, tone: "danger" });
    }
  };

  // Folder navigation lives in the address bar, so the browser's Back
  // button steps back out of a folder (and a link opens the same folder).
  useEffect(() => {
    setCurrentFolderId(searchParams.get("folderId"));
  }, [searchParams]);

  // Deep-link via ?doc=<id> — when arriving from the global search,
  // an inbox link, a notification bell row, etc, auto-select the doc
  // and open the inspector. The document list is FOLDER-SCOPED, so a doc
  // living inside a folder won't be in `documents` when we land at the
  // library root — in that case look it up directly and jump to its
  // folder first (once per docId), then the re-run selects it.
  const handledDocLink = useRef<{ id: string; folder: string | null; found: boolean } | null>(null);
  const lastDocLink = useRef<string | null>(null);
  const autoFullScreenedDoc = useRef<string | null>(null);
  // True while an incoming ?doc/?book link is still being resolved into state
  // (e.g. navigating to the doc's folder before its row is loaded). The URL
  // writer below pauses while this is set so it can't strip the link out of the
  // address bar before the readers have applied it. Cleared in every terminal
  // branch so it can never wedge the writer.
  const deepLinkPending = useRef(false);
  useEffect(() => {
    const docId = searchParams.get("doc");
    if (!docId) { lastDocLink.current = null; return; }
    // A link to a document shows that document: a search still open would
    // sit on top of it, with the folder changing unseen underneath.
    if (lastDocLink.current !== docId) { lastDocLink.current = docId; setFind(""); }
    // ?fs=1 means "open the full-screen drawing", not just the inspector — this
    // is what a distributed/shared link should land on. We auto-full-screen at
    // most once per docId so closing it doesn't immediately reopen.
    const wantFull = searchParams.get("fs") === "1";
    const target = documents.find((d) => d.id === docId);
    if (target) {
      deepLinkPending.current = false;
      setSelectedDoc(target);
      if (wantFull && autoFullScreenedDoc.current !== docId) {
        autoFullScreenedDoc.current = docId;
        setShowFullScreen(true);
      }
      return;
    }
    // Not in the (folder-scoped) list. Find the doc's folder and go there once;
    // when that folder's files are on screen this effect re-runs and selects it.
    const st = handledDocLink.current;
    if (st && st.id === docId) {
      // Still finding its folder, or its folder's list is still loading: wait.
      // (Another folder's list landing in between used to end the wait early;
      // the link was then stripped and the page fell back to the top of the
      // library with nothing open.)
      if (!st.found) return;
      const keyOf = (f: string | null) => `${libraryId}|${f ?? "root"}|${showArchivedDocs}`;
      if (docsDoneKey !== keyOf(st.folder)) {
        // The person has gone to another folder since: the link is done with.
        if ((currentFolderId ?? null) !== st.folder && docsDoneKey === keyOf(currentFolderId ?? null)) deepLinkPending.current = false;
        return;
      }
      // Its folder is fully loaded and it isn't there → gone, or not this
      // person's to see. Stop blocking the writer so the URL can resume syncing.
      deepLinkPending.current = false;
      return;
    }
    handledDocLink.current = { id: docId, folder: null, found: false };
    deepLinkPending.current = true;
    (async () => {
      const { data } = await supabase
        .from("documents")
        .select("id, collection_id")
        .eq("id", docId)
        .maybeSingle();
      if (handledDocLink.current?.id !== docId) return; // another link was followed meanwhile
      if (data) {
        const folder = (data.collection_id as string | null) ?? null;
        handledDocLink.current = { id: docId, folder, found: true };
        setCurrentFolderId(folder);
        setDocLinkTick((n) => n + 1);
      } else deepLinkPending.current = false;
    })();
  }, [searchParams, documents, docsDoneKey, docLinkTick, libraryId, showArchivedDocs, currentFolderId]);

  // Deep-link via ?book=<curatedCollectionId> — open that collection as a book.
  // The book's documents can live in any folder, so we resolve the collection's
  // items and fetch those documents directly (RLS still applies: a recipient
  // only gets the sheets they're allowed to see). Runs once per book id.
  const handledBookLink = useRef<string | null>(null);
  useEffect(() => {
    const bookId = searchParams.get("book");
    if (!bookId || handledBookLink.current === bookId) return;
    handledBookLink.current = bookId;
    deepLinkPending.current = true;
    (async () => {
      try {
        const items = await listCollectionItems(bookId);
        const ids = items.map((i) => i.document_id).filter(Boolean);
        if (ids.length === 0) return;
        const { data } = await supabase.from("documents").select(DOC_LIST_COLUMNS).in("id", ids);
        const byId = new Map((data ?? []).map((r) => { const row = r as unknown as Record<string, unknown>; return [row.id as string, docRecordFromRow(row)] as const; }));
        const ordered = ids.map((id) => byId.get(id)).filter(Boolean) as DocumentRecord[];
        if (ordered.length === 0) return;
        setStagedDocs(ordered);
        setOpenBookId(bookId);
        setShowMultiView(true);
      } catch (e) {
        console.error("book deep-link failed", e);
      } finally {
        deepLinkPending.current = false;
      }
    })();
  }, [searchParams]);

  // WRITE side of deep-linking: mirror what's open into the URL so copying the
  // address bar produces a link that reopens exactly this (a full-screen sheet,
  // a book, or a folder). We skip the first run so we don't clobber an incoming
  // link before the readers above consume it; router.replace keeps it out of the
  // back-button history, and the no-op guard prevents an update loop with the
  // readers (which depend on searchParams).
  const urlSyncMounted = useRef(false);
  // The folder this writer last saw in STATE. It tells the two directions
  // apart: state moved (a click, Up) → write the URL; the URL moved (Back /
  // Forward) → leave it, the reader above brings state along. Without this,
  // Back made the writer push the old folder straight back, the reader
  // followed, and the two flipped the list between folders forever.
  const writerFolderRef = useRef<string | null>(null);
  useEffect(() => {
    if (!urlSyncMounted.current) {
      urlSyncMounted.current = true;
      writerFolderRef.current = currentFolderId ?? null;
      return;
    }
    if (deepLinkPending.current) return; // a deep link is still resolving — leave the URL alone
    const urlFolder = searchParams.get("folderId") ?? null;
    const action = folderUrlAction(writerFolderRef.current, currentFolderId ?? null, urlFolder);
    writerFolderRef.current = currentFolderId ?? null;
    // The address bar moved first (Back / Forward, or our own push still
    // landing) — not ours to overwrite; the reader brings state along.
    if (action === "leave") return;
    const sp = new URLSearchParams(searchParams.toString());
    sp.delete("doc"); sp.delete("fs"); sp.delete("book");
    if (selectedDoc?.id) {
      sp.set("doc", selectedDoc.id);
      if (showFullScreen) sp.set("fs", "1");
    } else if (showMultiView && openBookId) {
      sp.set("book", openBookId);
    }
    const folderChanged = action === "push";
    if (currentFolderId) sp.set("folderId", currentFolderId); else sp.delete("folderId");
    const next = sp.toString();
    if (next !== searchParams.toString()) {
      // Entering or leaving a folder is a step in history (Back undoes it);
      // opening a document in place just rewrites the current entry.
      const url = next ? `${pathname}?${next}` : pathname;
      if (folderChanged) router.push(url, { scroll: false });
      else router.replace(url, { scroll: false });
    }
  }, [selectedDoc, showFullScreen, showMultiView, openBookId, currentFolderId, searchParams, router, pathname]);

  // Note: ⌘K is owned by the single global command palette (mounted in the
  // protected layout). This library-scoped palette — folder/sheet quick-jump +
  // in-library actions (upload, new folder, stage) — opens from its own button
  // so the two no longer fight over the same shortcut.

  // Watchdog: if loadingLibrary stays true for > 15s, something is wedged
  // (RLS, supabase hung token, network black hole). Surface it instead of
  // spinning forever.
  useEffect(() => {
    if (!loadingLibrary) return;
    const t = window.setTimeout(() => {
      console.error("[libraryId] load timed out", { libraryId, activeOrgId });
      setError("The library took too long to load. Reload the page to try again.");
      setLoadingLibrary(false);
    }, 15000);
    return () => window.clearTimeout(t);
  }, [loadingLibrary, libraryId, activeOrgId]);

  // Initial library config fetch. Two paths:
  //
  // (1) sessionStorage cache hit — render immediately with the cached
  //     config, then silently refresh in the background. Repeat
  //     navigation to the same library feels instant.
  // (2) cold path — show the loading state and wait for the network.
  //
  // Fires alongside the documents fetch below (shared deps), so the
  // round trips happen in parallel.
  useEffect(() => {
    if (!libraryId || !activeOrgId) {
      setLoadingLibrary(false);
      return;
    }
    setError(null);

    const cacheKey = `mfg-os:lib:${libraryId}:${activeOrgId}`;
    let primedFromCache = false;
    if (typeof window !== "undefined") {
      try {
        const cached = window.sessionStorage.getItem(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached) as { library: LibraryConfig; colWidths: Record<string, number> };
          if (parsed?.library?.id === libraryId) {
            setLibrary(parsed.library);
            setColWidths(parsed.colWidths ?? {});
            setLoadingLibrary(false);
            primedFromCache = true;
          }
        }
      } catch { /* ignore */ }
    }
    if (!primedFromCache) setLoadingLibrary(true);

    let alive = true;
    (async () => {
      try {
        const LIB_COLS =
          "id,org_id,name,description,type,custom_columns,column_label_overrides,uniqueness_keys,write_access,admin_access,read_access,visible_to,folder_security,default_new_visibility,default_new_acl,acl,column_widths,color,icon,cover_image_url,cover_tint,home_config,page_config";
        let resp = await supabase
          .from("libraries")
          .select(LIB_COLS)
          .eq("id", libraryId)
          .single();
        if (resp.error) {
          // The DB may be behind on a migration (a selected column like
          // page_config/home_config doesn't exist yet → PostgREST 400). Rather
          // than fail the whole library with "not found", degrade gracefully to
          // whatever columns DO exist. select("*") never 400s on missing cols.
          resp = await supabase.from("libraries").select("*").eq("id", libraryId).single();
        }
        const { data } = resp;
        if (!alive) return;
        if (!data) { setLibrary(null); setError("Library not found."); return; }
        if (data.org_id && data.org_id !== activeOrgId) { setLibrary(null); setError("Library does not belong to active workspace."); return; }
        const fresh: LibraryConfig = {
          id: data.id, orgId: data.org_id, name: data.name, description: data.description,
          type: data.type, customColumns: data.custom_columns ?? [],
          columnLabelOverrides: data.column_label_overrides ?? {},
          uniquenessKeys: Array.isArray(data.uniqueness_keys) ? data.uniqueness_keys : undefined,
          writeAccess: data.write_access ?? [], adminAccess: data.admin_access ?? [],
          readAccess: data.read_access ?? "ALL", visibleTo: data.visible_to ?? [],
          folderSecurity: data.folder_security ?? "Inherited",
          defaultNewVisibility: data.default_new_visibility,
          defaultNewAcl: data.default_new_acl, acl: data.acl,
          color: data.color ?? undefined, icon: data.icon ?? undefined,
          coverImageUrl: data.cover_image_url ?? undefined, coverTint: data.cover_tint ?? undefined,
          homeConfig: data.home_config ?? undefined,
          pageConfig: data.page_config ?? undefined,
        } as LibraryConfig;
        setLibrary(fresh);
        const widths = data.column_widths ?? {};
        setColWidths(widths);
        if (typeof window !== "undefined") {
          try {
            window.sessionStorage.setItem(cacheKey, JSON.stringify({ library: fresh, colWidths: widths }));
          } catch { /* quota — ignore */ }
        }
      } catch (e) {
        if (!alive) return;
        console.error(e);
        if (!primedFromCache) setError("Failed to load library.");
      } finally {
        if (alive) setLoadingLibrary(false);
      }
    })();
    return () => { alive = false; };
  }, [libraryId, activeOrgId]);

  // Live-sync column_widths so non-admin users see admin resizes without reloading.
  useEffect(() => {
    if (!libraryId) return;
    const channel = supabase
      .channel(`library-${libraryId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "libraries", filter: `id=eq.${libraryId}` },
        (payload) => {
          const next = (payload.new as { column_widths?: Record<string, number> } | null)?.column_widths;
          if (next && !resizingRef.current) setColWidths(next);
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [libraryId]);

  useEffect(() => {
    if (!libraryId || !activeOrgId) return;

    const unsub = listenLibraryFolders(
      libraryId,
      (list) => setFolders(list),
      { 
        orgId: activeOrgId, 
        onError: (msg) => setError(`Folder Error: ${msg}`),
        hideHidden: !isControllerRole(activeRole)
      }
    );

    return () => {
      if (unsub) unsub();
    };
  }, [libraryId, activeOrgId, activeRole]);

  // Per-folder document cache (library|folder|archived → rows) for instant
  // stale-while-revalidate folder switching. A ref, so it survives re-renders
  // without itself triggering one.
  const folderDocsCache = useRef<Map<string, DocumentRecord[]>>(new Map());

  // Realtime doc changes bump this; the fetch effect below re-runs on it.
  // The channel lives in its OWN effect keyed only on libraryId — it used to
  // live inside the fetch effect, which re-runs on every folder click, so
  // each click tore the socket down mid-connect and the console filled with
  // "WebSocket is closed before the connection is established".
  const [docsRefreshTick, setDocsRefreshTick] = useState(0);
  // Set while a bulk delete runs: its own row events don't refresh the list.
  const bulkBusyRef = useRef(false);
  // The folder the list last loaded — a refresh of the SAME folder keeps
  // the rows on screen; only a folder switch paints the cache or a spinner.
  const lastDocsKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!libraryId) return;
    // One refetch per burst: a 300-file upload or a bulk delete fires a row
    // event per document, and each used to reload the whole folder. Trailing
    // debounce, but never starved longer than 2s while events keep coming.
    let timer: ReturnType<typeof setTimeout> | null = null;
    let firstAt = 0;
    const bump = () => {
      if (bulkBusyRef.current) return; // one reload at the end instead
      const now = Date.now();
      if (!timer) firstAt = now;
      else clearTimeout(timer);
      const wait = Math.max(0, Math.min(300, 2000 - (now - firstAt)));
      timer = setTimeout(() => { timer = null; setDocsRefreshTick((t) => t + 1); }, wait);
    };
    const channel = supabase.channel(`docs-lib-${libraryId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "documents", filter: `library_id=eq.${libraryId}` }, bump)
      .subscribe();
    return () => { if (timer) clearTimeout(timer); supabase.removeChannel(channel); };
  }, [libraryId]);

  // ── File counts on every level ─────────────────────────────────────
  // One light read of every document's folder (ids only, all pages), rolled
  // up the tree: each folder shows its total INCLUDING everything beneath
  // it, and the library shows its grand total. Re-counted when documents or
  // folders change (the realtime refresh is already debounced).
  const [folderCounts, setFolderCounts] = useState<{ totals: Map<string, number>; direct: Map<string | null, number>; libraryTotal: number } | null>(null);
  const folderShape = useMemo(() => folders.map((f) => `${f.id}:${f.parentId ?? ""}`).join(","), [folders]);
  useEffect(() => {
    if (!libraryId || !activeOrgId) return;
    let alive = true;
    void (async () => {
      const { rows, error: cErr } = await fetchAllRows<{ collection_id: string | null }>((from, to) => {
        let q = supabase.from("documents").select("collection_id").eq("org_id", activeOrgId).eq("library_id", libraryId);
        if (!showArchivedDocs) q = q.neq("status", "Archived");
        if (!isControllerRole(activeRole)) q = q.eq("visibility", "normal");
        return q.order("id").range(from, to);
      });
      if (!alive || cErr) return;
      const direct = new Map<string | null, number>();
      for (const r of rows) direct.set(r.collection_id ?? null, (direct.get(r.collection_id ?? null) ?? 0) + 1);
      const shape = folderShape ? folderShape.split(",").map((x) => { const [id, parentId] = x.split(":"); return { id, parentId: parentId || null }; }) : [];
      const { totals, libraryTotal } = rollupFolderCounts(shape, direct);
      setFolderCounts({ totals, direct, libraryTotal });
    })();
    return () => { alive = false; };
  }, [libraryId, activeOrgId, activeRole, showArchivedDocs, docsRefreshTick, folderShape]);

  useEffect(() => {
    if (!libraryId || !activeOrgId) return;
    let alive = true;

    const fromDocRow = docRecordFromRow;
    // Stale-while-revalidate: if this folder was loaded before, paint its last
    // docs INSTANTLY and refresh in the background instead of a spinner on every
    // switch. Keyed by library so folders never bleed across libraries.
    const cacheKey = `${libraryId}|${currentFolderId ?? "root"}|${showArchivedDocs}`;
    const cached = folderDocsCache.current.get(cacheKey);
    // Repainting the cache on a same-folder refresh flashed back rows that
    // had just been deleted or moved, then removed them again.
    const switching = lastDocsKeyRef.current !== cacheKey;
    lastDocsKeyRef.current = cacheKey;
    if (switching) {
      if (cached) { setDocuments(cached); setLoadingDocs(false); }
      else { setLoadingDocs(true); }
    }

    // Progressive full load: the first page paints fast, then the REST of the
    // folder streams in automatically (500/page, hard stop 10,000) so sorting
    // and filtering always operate on the whole folder — a sorted view over a
    // silent slice was a lie. The banner shows live progress while it streams.
    const fetchDocs = async () => {
      try {
        const PAGE = 500;
        const HARD_CAP = 10000;
        let all: DocumentRecord[] = [];
        for (let from = 0; from < HARD_CAP; from += PAGE) {
          let q = supabase.from("documents").select(DOC_LIST_COLUMNS)
            .eq("org_id", activeOrgId).eq("library_id", libraryId);
          if (currentFolderId) q = q.eq("collection_id", currentFolderId);
          else q = q.is("collection_id", null);
          if (!isControllerRole(activeRole)) q = q.eq("visibility", "normal");
          // Hide archived docs from default view. Admins can flip the toggle
          // (showArchivedDocs) to surface them for restore.
          if (!showArchivedDocs) q = q.neq("status", "Archived");
          // Stable two-key order so pages never overlap or skip rows.
          q = q.order("updated_at", { ascending: false }).order("id").range(from, from + PAGE - 1);
          const { data, error: qErr } = await q;
          if (!alive) return;
          if (qErr) {
            if (from === 0) { setError(qErr.message); if (switching) setDocuments([]); }
            else setError(`Loaded the first ${all.length.toLocaleString()} documents; the rest failed: ${qErr.message}`);
            break;
          }
          const rows = (data || []).map((r) => fromDocRow(r as unknown as Record<string, unknown>));
          all = all.concat(rows);
          const morePagesLikely = rows.length === PAGE;
          // Opening a folder streams pages in as they arrive; a refresh of
          // the folder already on screen swaps the list once, complete.
          if (switching || !morePagesLikely) {
            folderDocsCache.current.set(cacheKey, all);
            setDocuments(all);
          }
          setDocStreamProgress(morePagesLikely && from + PAGE < HARD_CAP ? all.length : null);
          setDocFetchHitCap(morePagesLikely && from + PAGE >= HARD_CAP);
          if (from === 0) setLoadingDocs(false); // first page is on screen
          if (!morePagesLikely) break;
        }
        // A refresh that stopped at the hard cap still lands what it read.
        if (!switching && all.length > 0) {
          folderDocsCache.current.set(cacheKey, all);
          setDocuments(all);
        }
      } catch (e: unknown) { if (alive) setError((e as Error).message); }
      finally {
        if (alive) { setLoadingDocs(false); setDocStreamProgress(null); setDocsDoneKey(cacheKey); }
      }
    };

    fetchDocs();

    return () => { alive = false; };
  }, [libraryId, activeOrgId, currentFolderId, activeRole, showArchivedDocs, docsRefreshTick]);

  // Read-&-understood completion for the visible docs — one grouped query per
  // page, recomputed from the roster (never a cached count), so the Ack pill/
  // column can render without an N+1 and can't drift. Gated on the opt-in
  // "ack" column actually being configured: without it this map has no
  // consumer, and realtime refetches would otherwise re-fire the roster
  // queries on every collaborator edit for nothing.
  useEffect(() => {
    if (!activeOrgId) return;
    const hasAckColumn = columnDefs.some((d) => d?.type === "ack");
    const ids = documents.map((d) => d.id).filter(Boolean) as string[];
    let alive = true;
    (async () => {
      if (!hasAckColumn || ids.length === 0) {
        if (alive) setAckSummaries((prev) => (prev.size ? new Map() : prev));
        return;
      }
      try { const m = await getAckSummaries(activeOrgId, ids); if (alive) setAckSummaries(m); }
      catch { /* best-effort — pill just won't render */ }
    })();
    return () => { alive = false; };
  }, [activeOrgId, documents, columnDefs]);

  const folderMapRef = useRef<Map<string, LibraryCollection> | null>(null);
  const folderMap = useMemo(() => {
    const map = new Map<string, LibraryCollection>();
    for (const f of folders) {
      if (f.id) map.set(f.id, f);
    }
    return map;
  }, [folders]);

  useEffect(() => { folderMapRef.current = folderMap; }, [folderMap]);
  const currentFolder = currentFolderId ? folderMap.get(currentFolderId) ?? null : null;

  // The unit of the folder you're in: the map goes into it and a tag on
  // several units picks this unit's one.
  const [folderUnitCode, setFolderUnitCode] = useState<string | null>(null);
  const folderChainKey = currentFolder ? [...(currentFolder.pathIds ?? []), currentFolder.id].join("/") : "";
  useEffect(() => {
    if (!activeOrgId || !currentFolder?.id) { setFolderUnitCode(null); return; }
    let alive = true;
    const chain = [
      ...(currentFolder.pathIds ?? []).map((id, i) => ({ id, name: currentFolder.pathNames?.[i] ?? folderMapRef.current?.get(id)?.name ?? "" })),
      { id: currentFolder.id, name: currentFolder.name },
    ];
    void folderUnit(activeOrgId, chain).then((u) => { if (alive) setFolderUnitCode(u); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOrgId, folderChainKey]);
  const finder = useFind(activeOrgId, find, folderUnitCode, { controller: isControllerRole(activeRole) });
  const findOn = find.trim().length >= 2;
  // The map drives the page: a unit opens its folder, equipment is searched.
  const openUnitFolder = async (code: string) => {
    if (!activeOrgId) return;
    const f = await folderForUnit(activeOrgId, code, libraryId);
    if (!f) return;
    const target = f.chain[f.chain.length - 1].id;
    setFind("");
    if (f.libraryId === libraryId) setCurrentFolderId(target);
    else router.push(`/documents/${f.libraryId}?folderId=${target}`);
  };
  const searchAsset = (id: string, tag: string) => { setFind(tag); finder.pickWhenFound(id); };

  // Resolved hero header (inherits cover/color up the folder→library chain).
  const pageHeader = useMemo(
    () => resolvePageHeader(currentFolder, folderMap, library),
    [currentFolder, folderMap, library],
  );
  const pageBackground = useMemo(
    () => resolvePageBackground(currentFolder, folderMap, library),
    [currentFolder, folderMap, library],
  );

  const [myTeamIds, setMyTeamIds] = useState<string[]>([]);
  useEffect(() => {
    if (!uid) { setMyTeamIds([]); return; }
    let cancelled = false;
    getMyTeamIds(uid).then((ids) => { if (!cancelled) setMyTeamIds(ids); }).catch(() => { /* noop */ });
    return () => { cancelled = true; };
  }, [uid]);

  const principal = useMemo(() => {
    return {
      uid: uid ?? "",
      role: activeRole,
      orgId: activeOrgId ?? undefined,
      teamIds: myTeamIds,
    };
  }, [uid, activeRole, activeOrgId, myTeamIds]);

  // May this user publish revisions in THIS library? True for Admin/DocCtrl
  // (broad tier) and for anyone the library's ACL grants the "publish" action
  // (e.g. a Drafting Supervisor on a drawings library). Gates the Publish/Revert
  // controls; the lib mutators + DB trigger enforce the same rule for real.
  const canPublish = useMemo(
    () => canPublishOnLibrary({ principal, libraryAcl: library?.acl }),
    [principal, library?.acl],
  );

  const buildFolderChain = useCallback(
    (folder?: LibraryCollection | null): AccessControl[] => {
      const chain: AccessControl[] = [];
      if (library?.acl) chain.push(library.acl);
      if (folder?.pathIds?.length) {
        for (const id of folder.pathIds) {
          const node = folderMap.get(id);
          if (node?.acl) chain.push(node.acl);
        }
      }
      if (folder?.acl) chain.push(folder.acl);
      return chain;
    },
    [folderMap, library?.acl]
  );

  const buildDocChain = useCallback(
    (docRecord?: DocumentRecord | null): AccessControl[] => {
      const chain: AccessControl[] = [];
      if (library?.acl) chain.push(library.acl);
      if (docRecord?.collectionId) {
        const folder = folderMap.get(docRecord.collectionId);
        chain.push(...buildFolderChain(folder));
      }
      if (docRecord?.acl) chain.push(docRecord.acl);
      return chain;
    },
    [buildFolderChain, folderMap, library?.acl]
  );

  // Explorer behaviour: changing folders drops the selection. Carrying
  // checked-but-invisible rows across navigation means the next bulk action
  // silently includes documents the person can no longer see.
  useEffect(() => { setSelectedDocIds(new Set()); }, [currentFolderId]);

  const visibleFolders = useMemo(() => {
    if (!currentFolderId) {
      // Root shows top-level folders PLUS any folder whose ancestry is
      // broken — parent deleted, or a cycle from a bad move. A folder that
      // matches no listing anywhere has, to its owner, simply vanished
      // (reported in production after a drag session). Unreachable means
      // recovered-to-root, never invisible.
      const byId = new Map(folders.map((f) => [f.id, f]));
      const reachesRoot = (f: LibraryCollection): boolean => {
        const seen = new Set<string>();
        let cur: LibraryCollection | undefined = f;
        while (cur?.parentId) {
          if (seen.has(cur.parentId)) return false;      // cycle
          seen.add(cur.parentId);
          cur = byId.get(cur.parentId);
          if (!cur) return false;                        // parent gone
        }
        return true;
      };
      return folders.filter((f) => !f.parentId
        || (f.parentId && (!byId.has(f.parentId) || !reachesRoot(f))));
    }
    return folders.filter((f) => f.parentId === currentFolderId);
  }, [folders, currentFolderId]);

  const filteredFolders = useMemo(() => {
    return visibleFolders.filter((f) =>
      canDiscover({
        principal,
        visibility: f.visibility ?? "normal",
        aclChain: buildFolderChain(f),
      })
    );
  }, [visibleFolders, principal, buildFolderChain]);

  // useDeferredValue lets typing in the search box stay responsive on
  // large libraries — React keeps the input snappy and re-runs the
  // filter pass against the deferred (slightly stale) value.
  const deferredSearch = useDeferredValue(search);
  const filteredDocs = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
    return documents.filter((docRecord) => {
      const canRead = canWithAclChain({
        principal,
        action: "read",
        aclChain: buildDocChain(docRecord),
        defaultAllow: true,
      });
      if (!canRead) return false;
      if (!q) return true;
      // Search across every field a person might recognize a sheet by — not
      // just the number/title/name, but the sheet number, rev, status and the
      // values of any custom column (equipment tag, unit, area, etc.).
      const metaValues = docRecord.metadata
        ? Object.values(docRecord.metadata)
            .map((v) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)))
            .join(" ")
        : "";
      const hay = `${safeString(docRecord.documentNumber)} ${safeString(docRecord.title)} ${safeString(docRecord.name)} ${docRecord.sheetNumber ?? ""} ${safeString(docRecord.rev)} ${safeString(docRecord.status)} ${metaValues}`.toLowerCase();
      // An equipment tag ("x-31", "X31", "2030.31") finds that equipment
      // only: X-31, not X-310 or X-31A.
      if (isTagQuery(q)) return tagTokens(hay).has(tagKey(q));
      if (hay.includes(q)) return true;
      // Identity-tolerant pass: "e22" should find "E-22" (and "203022" find
      // "2030.22") — compare token-by-token with punctuation squashed out of
      // both sides. Short queries only, so a sentence doesn't match
      // everything; per-token so fields never bleed into each other.
      const qNorm = q.replace(/[^a-z0-9]+/g, "");
      if (qNorm.length >= 2 && qNorm.length <= 12) {
        return hay.split(/\s+/).some((tok) => tok.replace(/[^a-z0-9]+/g, "").includes(qNorm));
      }
      return false;
    });
  }, [documents, principal, deferredSearch, buildDocChain]);

  // The map under the folders shows where the list is: this folder (or the
  // top of the library), with the subfolders and files this person can see.
  const mapFolder = useMemo<MapFolder>(() => {
    const cur = currentFolderId ? folders.find((f) => f.id === currentFolderId) ?? null : null;
    const parent = cur?.parentId ? folders.find((f) => f.id === cur.parentId) ?? null : null;
    return {
      id: currentFolderId ?? null,
      name: cur?.name ?? library?.name ?? "Library",
      subfolders: filteredFolders.map((f) => ({ id: f.id!, name: f.name })),
      docs: filteredDocs.filter((d) => !!d.id).map((d) => ({
        id: d.id!, number: d.documentNumber || null, title: d.title || null, name: d.name || null,
        sheet: (() => { const v = (d.metadata as Record<string, unknown> | undefined)?.sheet ?? d.sheetNumber; return v == null || v === "" ? null : String(v); })(),
        href: "",
      })),
      up: currentFolderId ? { id: parent?.id ?? null, name: parent?.name ?? library?.name ?? "Library" } : null,
    };
  }, [currentFolderId, folders, filteredFolders, filteredDocs, library?.name]);


  const sortedDocs = useMemo(() => {
    return [...filteredDocs].sort((a, b) => {
      // Size sorts numerically — "9 KB" must not beat "10 MB".
      if (sortKey === "size") {
        const cmp = docSizeBytes(a) - docSizeBytes(b);
        return sortDir === "asc" ? cmp : -cmp;
      }
      let aVal: unknown, bVal: unknown;
      if (sortKey === "title") { aVal = a.title || a.name; bVal = b.title || b.name; }
      else if (sortKey === "createdAt") { aVal = a.createdAt; bVal = b.createdAt; }
      else if (sortKey === "fileType") { aVal = docFileExt(a); bVal = docFileExt(b); }
      else if (sortKey === "documentNumber") { aVal = a.documentNumber; bVal = b.documentNumber; }
      else if (sortKey === "rev") { aVal = a.rev; bVal = b.rev; }
      else if (sortKey === "status") { aVal = a.status; bVal = b.status; }
      else if (sortKey === "updatedAt") { aVal = a.updatedAt; bVal = b.updatedAt; }
      else { aVal = (a.metadata ?? {})[sortKey]; bVal = (b.metadata ?? {})[sortKey]; }
      const aStr = String(aVal ?? "");
      const bStr = String(bVal ?? "");
      const cmp = aStr.localeCompare(bStr, undefined, { numeric: true });
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [filteredDocs, sortKey, sortDir]);

  // A wide table shows it keeps going: a fade on the right edge while
  // columns are still out of sight.
  const [tableScrollEl, setTableScrollEl] = useState<HTMLDivElement | null>(null);
  const [tableMoreRight, setTableMoreRight] = useState(false);
  useEffect(() => {
    const el = tableScrollEl;
    if (!el) { setTableMoreRight(false); return; }
    const check = () => setTableMoreRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
    check();
    el.addEventListener("scroll", check, { passive: true });
    const ro = new ResizeObserver(check);
    ro.observe(el);
    const table = el.firstElementChild;
    if (table) ro.observe(table);
    return () => { el.removeEventListener("scroll", check); ro.disconnect(); };
  }, [tableScrollEl]);

  // Selection hygiene: when the visible list changes (folder change, filter,
  // move), silently drop selected ids that are no longer on screen so bulk
  // actions can never touch rows the user can't see.
  useEffect(() => {
    const order = sortedDocs.map((d) => d.id!).filter(Boolean);
    const state = { ids: selectedDocIds, anchorId: selAnchorRef.current, focusId: selFocusId };
    const pruned = pruneSelection(state, order);
    if (pruned !== state) {
      setSelectedDocIds(new Set(pruned.ids));
      selAnchorRef.current = pruned.anchorId;
      setSelFocusId(pruned.focusId);
    }
  }, [sortedDocs, selectedDocIds, selFocusId]);

  useEffect(() => {
    if (!library || !activeOrgId) return;

    const overrides = currentFolder?.columnOverrides ?? [];
    const custom = Array.isArray(overrides) && overrides.length ? overrides : library.customColumns ?? [];
    setColumnDefs(custom);

    // The number is what engineers read first: it leads the default columns.
    const schemaDefaults = defaultColumnsFromSchema({
      customColumns: custom,
    });
    const defaults = schemaDefaults.includes("documentNumber")
      ? ["documentNumber", ...schemaDefaults.filter((k) => k !== "documentNumber")]
      : schemaDefaults;

    // First visit: the app default until the saved columns answer. A folder
    // change keeps the last folder's columns meanwhile (no flash).
    setActiveColumns((prev) => (prev.length ? prev : defaults));
    const unsub = listenEffectiveColumns(
      {
        orgId: activeOrgId,
        ownerUserId: uid ?? undefined,
        libraryId,
        collectionId: currentFolderId ?? undefined,
        defaultColumns: defaults,
      },
      (res) => {
        setActiveColumns(res.columns);
        setColLevels({
          user: !!res.userView?.columns?.length,
          folder: !!res.orgView?.columns?.length,
          library: res.libraryView?.columns?.length ? res.libraryView.columns : null,
        });
      }
    );

    return () => {
      if (unsub) unsub();
    };
  }, [library, currentFolderId, activeOrgId, uid, libraryId, currentFolder?.columnOverrides]);

  // The column manager offers to switch folders that have their own
  // columns: count them when it opens (Admin/DocCtrl only).
  useEffect(() => {
    if (!showColumnManager || !activeOrgId || !isControllerRole(activeRole)) return;
    let alive = true;
    void listFoldersWithOwnColumns({ orgId: activeOrgId, libraryId })
      .then((ids) => { if (alive) setFoldersWithOwnColumns(ids); });
    return () => { alive = false; };
  }, [showColumnManager, activeOrgId, activeRole, libraryId]);

  // Load this folder's saved default view (sort + layout + density) and apply
  // it when we enter the folder. Resolution is user default → org default →
  // app default, each field independently. Applying is gated to once per
  // folder visit so an in-session manual re-sort or layout flip isn't
  // clobbered; the indicators stay in sync though.
  useEffect(() => {
    if (!activeOrgId) return;
    const folderKey = `${libraryId}::${currentFolderId ?? "root"}`;
    let alive = true;
    void resolveEffectiveViewState({
      orgId: activeOrgId,
      ownerUserId: uid ?? undefined,
      libraryId,
      collectionId: currentFolderId ?? undefined,
    }).then((res) => {
      if (!alive) return;
      setFolderDefaultSort(res.sort ?? null);
      setViewDefaults({ hasUserRow: res.hasUserRow, hasOrgRow: res.hasOrgRow });
      if (sortAppliedFolderRef.current !== folderKey) {
        sortAppliedFolderRef.current = folderKey;
        if (res.sort?.key) { setSortKey(res.sort.key); setSortDir(res.sort.dir === "asc" ? "asc" : "desc"); }
        else { setSortKey("updatedAt"); setSortDir("desc"); }
        setDocLayout(res.view?.layout ?? "details");
        if (res.view?.density) setDensity(res.view.density);
      }
    }).catch(() => { /* view default is best-effort */ });
    return () => { alive = false; };
  }, [activeOrgId, uid, libraryId, currentFolderId]);

  useEffect(() => {
    if (!selectedDoc?.id) {
      setSelectedVersion(null);
      return;
    }

    let alive = true;


    const loadVersion = async () => {
      if (!selectedDoc.id) return;
      try {
        if (selectedDoc.currentVersionId) {
          const { data } = await supabase
            .from("document_versions")
            .select("*")
            .eq("id", selectedDoc.currentVersionId)
            .single();
          if (alive && data) {
            setSelectedVersion(versionFromRow(data as Record<string, unknown>));
            return;
          }
        }

        const { data } = await supabase
          .from("document_versions")
          .select("*")
          .eq("record_id", selectedDoc.id)
          .or("review_state.is.null,review_state.eq.approved")
          .order("created_at", { ascending: false })
          .limit(1);
        if (!alive) return;
        setSelectedVersion(data && data.length > 0 ? versionFromRow(data[0] as Record<string, unknown>) : null);
      } catch (e) {
        console.error(e);
        if (alive) setSelectedVersion(null);
      }
    };

    loadVersion();

    return () => {
      alive = false;
    };
  }, [selectedDoc]);

  useEffect(() => {
    if (!selectedDoc?.id || !activeOrgId) {
      setSessions([]);
      return;
    }

    let alive = true;

    const fromSessionRow = (r: Record<string, unknown>): CheckoutSession => ({
      id: r.id as string,
      orgId: r.org_id as string,
      documentId: r.document_id as string,
      libraryId: r.library_id as string,
      userId: r.user_id as string,
      userName: r.user_name as string | undefined,
      mode: r.mode as CheckoutMode,
      note: r.note as string | undefined,
      status: r.status as CheckoutSession['status'],
      linkedTicketId: r.linked_ticket_id as string | undefined,
      lockId: r.lock_id as string | undefined,
      startedAt: r.started_at as unknown as CheckoutSession['startedAt'],
      lastSeenAt: r.last_seen_at as unknown as CheckoutSession['lastSeenAt'],
    });

    const fetchSessions = async () => {
      const { data } = await supabase
        .from("checkout_sessions")
        .select("*")
        .eq("org_id", activeOrgId)
        .eq("document_id", selectedDoc.id)
        .order("started_at", { ascending: false });
      if (!alive) return;
      setSessions((data || []).map(r => fromSessionRow(r as Record<string, unknown>)));
    };

    fetchSessions();
    const channel = supabase.channel(`sessions-${selectedDoc.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "checkout_sessions", filter: `document_id=eq.${selectedDoc.id}` },
        () => { if (alive) fetchSessions(); })
      .subscribe();

    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
  }, [selectedDoc?.id, activeOrgId]);

  const columnOptions = useMemo(() => {
    // System columns can have admin-defined label overrides (e.g.
    // renaming "Doc No" to "Sheet No"). columnLabelOverrides is a
    // JSONB on the library row.
    const overrides = library?.columnLabelOverrides ?? {};
    const builtins = BUILTIN_COLUMNS.map((c) => ({
      key: c.key,
      label: overrides[c.key] || c.label,
      locked: true,
    }));
    // Explorer file columns — addable/removable, never in the default set.
    const optional = OPTIONAL_BUILTIN_COLUMNS.map((c) => ({
      key: c.key,
      label: overrides[c.key] || c.label,
    }));
    // A custom column that reuses a built-in key (title, rev, status) is the
    // same column: list it once, under the name its header shows.
    const builtinKeys = new Set([...builtins.map((c) => c.key), ...optional.map((c) => c.key)]);
    const dynamic = columnDefs.filter((c) => !builtinKeys.has(c.key)).map((c) => ({ key: c.key, label: c.label }));
    const known = new Set([...builtinKeys, ...dynamic.map((c) => c.key)]);
    const orphans = activeColumns
      .filter((k) => !known.has(k))
      .map((k) => ({ key: k, label: overrides[k] || k }));
    return [...builtins, ...optional, ...dynamic, ...orphans];
  }, [columnDefs, activeColumns, library?.columnLabelOverrides]);

  // Column tweaks save to YOUR view only — for everyone, admins included.
  // Publishing the current state as the org-wide default is an explicit act
  // via the View menu. The ONE exception: library SCHEMA changes (an admin
  // creating or deleting a custom column) pass scope:"org" so the change
  // reaches everyone who rides the org default, not just the admin.
  const updateColumns = async (next: string[], opts?: { scope?: "user" | "org" }) => {
    const before = activeColumns;
    setActiveColumns(next);
    if (!activeOrgId || !uid) return;
    // A schema act in a folder that follows the library default lands in
    // the library default, so the folder doesn't split off from it.
    const scope = opts?.scope === "org" && isController
      ? (colLevels.library && !colLevels.folder ? "library" : "org")
      : "user";
    try {
      await saveTableView({
        scope,
        orgId: activeOrgId,
        ownerUserId: scope === "user" ? uid : undefined,
        libraryId,
        collectionId: currentFolderId ?? undefined,
        columns: next,
      });
    } catch (e) {
      // Put the columns back: the screen must match what was saved.
      setActiveColumns(before);
      setError(`Couldn't save the columns: ${(e as Error).message}`);
      return;
    }
    setColLevels((prev) => scope === "user" ? { ...prev, user: true }
      : scope === "org" ? { ...prev, folder: true }
      : { ...prev, library: next });
    // A user row now exists here — surface the "Clear my default" escape
    // hatch immediately, not on the next folder visit.
    if (scope !== "library") {
      setViewDefaults((prev) => scope === "user"
        ? { ...prev, hasUserRow: true }
        : { ...prev, hasOrgRow: true });
    }
  };

  // ── Library-wide columns (Admin/DocCtrl) ─────────────────────────────
  // One set of columns for every folder of the library, for the whole org.
  // A folder with columns of its own keeps them until someone switches it
  // back ("Use the library's"); this folder follows the library at once.
  const viewParams = () => ({ orgId: activeOrgId!, libraryId, collectionId: currentFolderId ?? undefined });
  const refreshViewDefaults = async () => {
    try {
      const res = await resolveEffectiveViewState({ ...viewParams(), ownerUserId: uid ?? undefined });
      setViewDefaults({ hasUserRow: res.hasUserRow, hasOrgRow: res.hasOrgRow });
    } catch { /* indicator only */ }
  };
  const applyColumnsToLibrary = async (next: string[], opts?: { switchFolders?: boolean }) => {
    if (!activeOrgId || !uid || !isController) return;
    const before = activeColumns;
    setActiveColumns(next);
    try {
      await saveTableView({ scope: "library", orgId: activeOrgId, libraryId, columns: next });
      await clearTableViewColumns({ scope: "user", ...viewParams(), ownerUserId: uid });
      await clearTableViewColumns({ scope: "org", ...viewParams() });
      if (opts?.switchFolders) {
        const others = await listFoldersWithOwnColumns({ orgId: activeOrgId, libraryId });
        for (const id of others) {
          await clearTableViewColumns({ scope: "org", orgId: activeOrgId, libraryId, collectionId: id ?? undefined });
        }
        setFoldersWithOwnColumns([]);
      }
      setColLevels({ user: false, folder: false, library: next });
      void refreshViewDefaults();
    } catch (e) {
      setActiveColumns(before);
      setError(`Couldn't save the columns for the library: ${(e as Error).message}`);
    }
  };
  // This folder drops its own columns and follows the library default.
  // Anyone can drop their own; Admin/DocCtrl also drop the folder's org row.
  const followLibraryColumns = async () => {
    if (!activeOrgId || !uid || !colLevels.library) return;
    const before = activeColumns;
    setActiveColumns(colLevels.library);
    try {
      await clearTableViewColumns({ scope: "user", ...viewParams(), ownerUserId: uid });
      if (isController) await clearTableViewColumns({ scope: "org", ...viewParams() });
      setColLevels((prev) => ({ ...prev, user: false, folder: isController ? false : prev.folder }));
      if (isController) setFoldersWithOwnColumns((prev) => prev.filter((id) => id !== (currentFolderId ?? null)));
      void refreshViewDefaults();
    } catch (e) {
      setActiveColumns(before);
      setError(`Couldn't switch this folder to the library's columns: ${(e as Error).message}`);
    }
  };

  const openCreateFolder = () => {
    setRenameValue("");
    setFolderErr(null);
    setCreatingFolder(true);
  };

  const confirmCreateFolder = async () => {
    if (!activeOrgId || !uid || !library) return;
    const name = renameValue.trim();
    if (!name) return;

    try {
      const newAcl = library.defaultNewAcl ?? (library.folderSecurity === "Granular" ? { inherit: true, visibility: library.defaultNewVisibility ?? "normal", rules: [] } : undefined);
      const newId = await createFolder({
        orgId: activeOrgId,
        libraryId,
        parentId: currentFolderId ?? null,
        name,
        visibility: library.defaultNewVisibility ?? "normal",
        acl: newAcl,
        createdBy: uid,
      });

      if (newAcl) {
        const chain = [...buildFolderChain(currentFolder), newAcl];
        const aclIndex = buildAclIndexFromChain(chain);
        const { error: idxErr } = await supabase.from("collections").update({ acl_index: aclIndex ?? null }).eq("id", newId);
        if (idxErr) setError(`The folder was made, but its permissions didn't save: ${idxErr.message}. Open its permissions and save them again.`);
      }

      nudgeEstateResolver(activeOrgId, { folderIds: [newId] });
      askWatchdog({ folderIds: [newId] });
      setCreatingFolder(false);
      setRenameValue("");
      // Straight into the new folder: the next step is filling it.
      setCurrentFolderId(newId);
    } catch (e) {
      console.error(e);
      setFolderErr(`Couldn't create the folder: ${e instanceof Error ? e.message : "try again"}.`);
    }
  };

  const confirmRenameFolder = async () => {
    if (!renameFolderId) return;
    const name = renameValue.trim();
    if (!name) return;
    try {
      await renameFolderAndDescendants(renameFolderId, name);
      setRenameFolderId(null);
      setRenameValue("");
    } catch (e) {
      console.error(e);
      setFolderErr(`Couldn't rename the folder: ${e instanceof Error ? e.message : "try again"}.`);
    }
  };

  // Drag-and-drop moves. Same server calls the ⋯ menu's Move modal makes —
  // the gesture is the only thing that's new. Folders refresh themselves via
  // the live subscription; a doc moved out of this folder leaves the list
  // locally so the row disappears under the cursor instead of a beat later.
  const dropMoveFolder = async (dragId: string, targetId: string | null) => {
    try {
      const prevParent = folderMap.get(dragId)?.parentId ?? null;
      const { warning } = await moveFolderServer({ orgId: activeOrgId!, collectionId: dragId, newParentId: targetId });
      if (warning) setError(warning);
      pushUndo({
        kind: "folder",
        label: `Moved folder "${folderMap.get(dragId)?.name ?? "folder"}"`,
        collectionId: dragId,
        targetParentId: prevParent,
      });
      nudgeKnowledgeSources(activeOrgId!, libraryId);
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : "Couldn't move that folder.");
    }
  };
  /** Place dragId before/after targetId among the target's siblings. A drag
   *  from another parent moves there first, then takes its slot — one
   *  gesture, both effects, like every desktop file manager. */
  const dropReorderFolder = async (dragId: string, targetId: string, position: "before" | "after") => {
    const target = folderMap.get(targetId);
    const dragged = folderMap.get(dragId);
    if (!target || !dragged) return;
    try {
      if ((dragged.parentId ?? null) !== (target.parentId ?? null)) {
        await moveFolderServer({ orgId: activeOrgId!, collectionId: dragId, newParentId: target.parentId ?? null });
      }
      // Sibling order as currently DISPLAYED, minus the dragged folder,
      // with it re-inserted at the drop slot.
      const siblings = folders
        .filter((f) => (f.parentId ?? null) === (target.parentId ?? null) && f.id !== dragId)
        .map((f) => f.id!) ;
      const at = siblings.indexOf(targetId);
      const insert = position === "before" ? at : at + 1;
      siblings.splice(insert < 0 ? siblings.length : insert, 0, dragId);
      await reorderFolders(siblings);
      nudgeKnowledgeSources(activeOrgId!, libraryId);
    } catch (e) {
      console.error(e);
      setError("Couldn't reorder that folder.");
    }
  };

  // Deleting a folder opens a window that counts the branch and asks what
  // happens to what's inside. Deleting a SELECTED tile deletes the selection.
  const handleDeleteFolder = (id: string) => {
    const ids = selectedFolderIds.has(id) && selectedFolderIds.size > 1 ? [...selectedFolderIds] : [id];
    const list = ids.map((x) => ({ id: x, name: folderMap.get(x)?.name ?? "Folder" }));
    if (list.length) setDeleteFolders(list);
  };
  const onFoldersDeleted = (r: FolderDeleteResult) => {
    setDeleteFolders(null);
    setSelectedFolderIds(new Set());
    // Reflect the server's work at once — never wait on realtime for deletes.
    const gone = new Set(r.removedFolderIds);
    if (r.mode === "all") {
      setFolders((prev) => prev.filter((x) => !gone.has(x.id!)));
      setDocuments((prev) => prev.filter((d) => !d.collectionId || !gone.has(d.collectionId)));
    } else {
      setFolders((prev) => {
        const parentOf = new Map(prev.map((x) => [x.id!, x.parentId ?? null]));
        const heir = (id: string): string | null => {
          let p = parentOf.get(id) ?? null;
          while (p && gone.has(p)) p = parentOf.get(p) ?? null;
          return p;
        };
        return prev.filter((x) => !gone.has(x.id!))
          .map((x) => (x.parentId && gone.has(x.parentId) ? { ...x, parentId: heir(x.id!) } : x));
      });
      setDocuments((prev) => prev.filter((d) => !d.collectionId || !gone.has(d.collectionId)));
    }
    folderDocsCache.current.clear();
    setDocsRefreshTick((t) => t + 1);
    if (currentFolderId && gone.has(currentFolderId)) {
      let p = folderMap.get(currentFolderId)?.parentId ?? null;
      while (p && gone.has(p)) p = folderMap.get(p)?.parentId ?? null;
      setCurrentFolderId(p);
    }
    nudgeKnowledgeSources(activeOrgId!, libraryId);
  };

  // Up one level: the parent folder, or the library's top when at a
  // top-level folder.
  const goUp = useCallback(() => {
    if (!currentFolderId) return false;
    setCurrentFolderId(folderMap.get(currentFolderId)?.parentId ?? null);
    return true;
  }, [currentFolderId, folderMap]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector('[role="dialog"], .fixed.inset-0')) return;
      if ((e.altKey && e.key === "ArrowUp") || (e.key === "Backspace" && !e.altKey && !e.metaKey && !e.ctrlKey)) {
        if (goUp()) e.preventDefault();
      } else if (e.key === "Delete" && isControllerRole(activeRole) && selectedFolderIds.size > 0 && selectedDocIds.size === 0) {
        e.preventDefault();
        setDeleteFolders([...selectedFolderIds].map((x) => ({ id: x, name: folderMap.get(x)?.name ?? "Folder" })));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goUp, activeRole, selectedFolderIds, selectedDocIds, folderMap]);

  // ── Folder trash (30-day delete hold) ──────────────────────────────
  const openTrash = async () => {
    try {
      setTrashFolders(await listDeletedFolders(activeOrgId!, libraryId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load deleted folders.");
    }
  };
  const restoreFromTrash = async (id: string) => {
    setTrashBusy(id);
    try {
      await restoreDeletedFolder(activeOrgId!, id);
      // The realtime folders listener picks the restored folder up; drop the
      // row from the modal so the list reflects reality immediately.
      setTrashFolders((prev) => (prev ?? []).filter((x) => x.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't restore the folder.");
    } finally {
      setTrashBusy(null);
    }
  };

  const dropMoveDocs = async (docIds: string[], folderId: string | null) => {
    if (docIds.length === 0) return;
    try {
      // Capture each doc's CURRENT folder before the move so Ctrl+Z can
      // put every one back where it came from.
      const bySource = new Map<string | null, string[]>();
      for (const d of documents) {
        if (!docIds.includes(d.id!)) continue;
        const src = d.collectionId ?? null;
        if (src === (folderId ?? null)) continue;
        const arr = bySource.get(src);
        if (arr) arr.push(d.id!); else bySource.set(src, [d.id!]);
      }
      // Server route: authority (additive roles), same-library validation,
      // retention re-clock against the destination, audit entry.
      const res = await moveDocumentsServer({ orgId: activeOrgId!, docIds, targetFolderId: folderId });
      if (res.warning) setError(res.warning);
      if (bySource.size > 0) {
        pushUndo({
          kind: "docs",
          label: `Moved ${docIds.length} document${docIds.length === 1 ? "" : "s"}`,
          groups: [...bySource.entries()].map(([targetFolderId, ids]) => ({ docIds: ids, targetFolderId })),
        });
      }
      const moved = new Set(docIds);
      if (folderId !== currentFolderId) {
        setDocuments((prev) => prev.filter((d) => !moved.has(d.id!)));
      }
      setSelectedDocIds((prev) => {
        const next = new Set(prev);
        for (const id of docIds) next.delete(id);
        return next;
      });
      nudgeKnowledgeSources(activeOrgId!, libraryId);
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message
        : docIds.length === 1 ? "Couldn't move that document." : "Couldn't move those documents.");
    }
  };

  const confirmMoveFolder = async (targetId: string | null) => {
    if (!renameFolderId) return;
    try {
      await moveFolderServer({ orgId: activeOrgId!, collectionId: renameFolderId, newParentId: targetId ?? null });
      nudgeKnowledgeSources(activeOrgId!, libraryId);
      setShowMoveModal(false);
      setRenameFolderId(null);
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : "Failed to move folder.");
    }
  };

  const confirmMoveDoc = async (targetId: string | null) => {
    if (!selectedDoc?.id) return;
    try {
      await moveDocumentsServer({ orgId: activeOrgId!, docIds: [selectedDoc.id], targetFolderId: targetId ?? null });
      setShowMoveDocModal(false);
      nudgeKnowledgeSources(activeOrgId!, libraryId);
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : "Failed to move document.");
    }
  };

  // ── Phase 1: metadata-first upload ──────────────────────────────
  // Step 1: file selection / drag-drop → just stage the files. NO
  // bytes leave the browser yet. The staging modal opens for review.
  const handleUploadFiles = (list: FileList | null) => {
    // Take the files BEFORE resetting the picker: clearing it empties the
    // very list the browser handed over (the pick then did nothing).
    const files = list ? Array.from(list) : [];
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (files.length === 0) return;
    if (!activeOrgId || !uid || !library) {
      setError("Still loading the library - pick the file again in a moment.");
      return;
    }
    uploadPathsRef.current = new Map(); // flat upload — no tree to recreate
    uploadFolderPlanRef.current = null;
    // OS metadata junk (.DS_Store & friends) is filtered on the folder path;
    // filter the flat path too so it never becomes a controlled document.
    const clean = files.filter((f) => !isJunkFile(f.name));
    if (clean.length === 0) return;
    setPendingUploadFiles(clean);
    setShowStagingModal(true);
    setError(null);
  };

  // Step 2: user confirmed metadata for each file → actually upload
  // to R2 + insert document rows with the user's metadata applied.
  //
  // Two important shape decisions, both driven by the prior 409
  // storm + slow sequential pass:
  //
  // 1. One pre-flight query resolves every final doc_number BEFORE
  //    any inserts. We look up existing active doc_numbers that
  //    prefix-match the staged ones, then within-batch + vs-DB we
  //    pick the lowest free "-N" suffix per file. Zero retries.
  //
  // 2. Files run through R2 + DB in parallel (concurrency = 4) so
  //    8 files don't take 8× one-file time.
  const UPLOAD_CONCURRENCY = 6;
  const handleStagedUpload = async (items: StagedItem[], signal?: AbortSignal): Promise<UploadOutcome | void> => {
    // Every document that lands is handed to the estate resolver once the
    // upload is done — unit, project and equipment links from its name,
    // folder and (once read) pages. Fire-and-forget; never blocks an upload.
    const createdDocIds: string[] = [];
    const notifyLibrarySubscribers = (count: number, firstName: string) => {
      if (!activeOrgId || !uid || count === 0) return;
      // The link opens what landed: the one document, or the folder it went to.
      const link = count === 1 && createdDocIds[0]
        ? `/documents/${libraryId}?doc=${createdDocIds[0]}`
        : currentFolderId ? `/documents/${libraryId}?folderId=${currentFolderId}` : `/documents/${libraryId}`;
      void import("@/lib/notify/dispatch").then((m) =>
        m.emit({
          orgId: activeOrgId,
          category: "watched",
          kind: "library_doc_added",
          title: count === 1 ? `New document: ${firstName}` : `${count} new documents added`,
          body: `${userEmail ?? "Someone"} added ${count === 1 ? firstName : `${count} documents`} to a library you subscribe to.`,
          link,
          resource: { type: "library", id: libraryId },
          actorUserId: uid,
          actorName: userEmail ?? "someone",
          audience: { followers: true },
        })).catch(() => undefined);
    };
    if (!activeOrgId || !uid || !library) return;
    // Never send a file twice: anything that already landed from this
    // staged batch is skipped, whatever the window still lists.
    items = items.filter((it) => !landedFilesRef.current.has(it.file));
    const landedFiles: File[] = [];
    const unlinked: string[] = [];
    setLoadingUpload(true);
    setError(null);

    const autoRenamed: Array<{ original: string; final: string }> = [];
    // Park background knowledge indexing for the duration: both want the same
    // connections and the same database, and the upload is the one with a
    // person waiting on it.
    const { beginUpload, endUpload } = await import("@/lib/uploadActivity");
    beginUpload();

    try {
      const folderPath = currentFolder?.pathNames ?? [];

      // ── Folder-tree batches: recreate the dropped subfolder structure ──
      // Only now, at confirm — cancelling the staging modal creates nothing.
      // Existing same-named folders are reused, so re-dropping a tree tops
      // it up instead of duplicating it.
      const pathByFile = uploadPathsRef.current;
      let ensured: EnsuredFolderPlan = { idByKey: new Map(), chainByFolderId: new Map() };
      let foldersCreatedNote = "";
      if (pathByFile.size > 0) {
        const pathed = items
          .filter((it) => pathByFile.has(it.file))
          .map((it) => ({ file: it.file, relPath: pathByFile.get(it.file)! }));
        const plan = buildFolderPlan(pathed);
        // A retry after partial failure reuses the already-built tree.
        if (!uploadFolderPlanRef.current) {
          setUploadProgress({ done: 0, total: plan.folders.length, phase: "Creating folders" });
          uploadFolderPlanRef.current = await ensureFolderPlan(plan,
            (done, total) => setUploadProgress({ done, total, phase: "Creating folders" }));
        }
        ensured = uploadFolderPlanRef.current;
        foldersCreatedNote = `Folder structure preserved (${plan.folders.length} folder${plan.folders.length === 1 ? "" : "s"} in the tree).`;
      }
      const targetFolderFor = (file: File): string | null => {
        const rel = pathByFile.get(file);
        if (!rel || rel.length === 0) return currentFolderId ?? null;
        return ensured.idByKey.get(rel.map((s) => s.toLowerCase()).join("/")) ?? currentFolderId ?? null;
      };
      // The doc's RLS index must reflect its REAL parent chain — the target
      // subfolder's, not the folder the user happened to be viewing.
      const chainForTarget = (targetId: string | null): AccessControl[] => {
        if (targetId === (currentFolderId ?? null)) return buildFolderChain(currentFolder);
        const fromPlan = targetId ? ensured.chainByFolderId.get(targetId) : undefined;
        if (fromPlan) return fromPlan;
        const f = targetId ? folderMap.get(targetId) : null;
        return f ? buildFolderChain(f) : buildFolderChain(currentFolder);
      };

      // ── Already here? Skip it. ───────────────────────────────────
      // Same name + same size already in the target folder = this file
      // landed before (an earlier attempt, a re-dropped folder). Dropping the
      // same folder again therefore FILLS IN what's missing instead of adding
      // a second copy of everything.
      const existingKeys = new Set<string>();
      setUploadProgress({ done: 0, total: 0, phase: "Checking what's already in the library" });
      {
        const targets = [...new Set(items.map((it) => targetFolderFor(it.file)))];
        const ids = targets.filter((t): t is string => !!t);
        // Only documents that actually HAVE a file count — an entry whose
        // upload never attached its file must not cause the real file to
        // be skipped.
        const readFolderDocs = async (folderIds: string[] | null) => {
          for (let from = 0; from < 20000; from += 1000) {
            let q = supabase.from("documents").select("collection_id, name, size:metadata->>size_bytes")
              .eq("org_id", activeOrgId).eq("library_id", libraryId).not("current_version_id", "is", null);
            q = folderIds ? q.in("collection_id", folderIds) : q.is("collection_id", null);
            const { data } = await q.order("id").range(from, from + 999);
            for (const r of (data ?? []) as Array<{ collection_id: string | null; name: string | null; size: string | null }>) {
              if (r.name) existingKeys.add(`${r.collection_id ?? "root"}|${r.name.toLowerCase()}|${r.size ?? "?"}`);
            }
            if ((data ?? []).length < 1000) break;
          }
        };
        for (let i = 0; i < ids.length; i += 100) await readFolderDocs(ids.slice(i, i + 100));
        if (targets.includes(null)) await readFolderDocs(null);
      }
      const alreadyHere: File[] = [];
      items = items.filter((it) => {
        const key = `${targetFolderFor(it.file) ?? "root"}|${it.file.name.toLowerCase()}|${it.file.size}`;
        if (existingKeys.has(key)) { alreadyHere.push(it.file); return false; }
        return true;
      });
      for (const f of alreadyHere) { landedFiles.push(f); landedFilesRef.current.add(f); }

      // ── Pre-flight: resolve final doc numbers ────────────────────
      // Auto-numbering (when this library owns a counter): items whose number
      // was left BLANK get the next issued number — atomic, gap-free, no two
      // uploads can collide. Typed numbers always win; filenames are only the
      // fallback when the counter is off.
      const { getLibraryNumbering, issueDocumentNumber } = await import("@/lib/libraryNumbering");
      const numberingCfg = await getLibraryNumbering(libraryId);
      const originals: string[] = [];
      for (const it of items) {
        const typed = it.documentNumber.trim();
        if (typed) { originals.push(typed); continue; }
        if (numberingCfg?.enabled) {
          const issued = await issueDocumentNumber(libraryId);
          if (issued) { originals.push(issued); continue; }
        }
        originals.push(baseName(it.file.name));
      }
      const distinctBases = Array.from(new Set(originals));
      // Which numbers are already taken. Exact matches in slices (a folder
      // of thousands would otherwise build a URL too long for the API); then,
      // only for numbers that ARE taken, the "-2", "-3"… already issued.
      // A lookup that fails is retried once and then gives way to the
      // database's own uniqueness rule — it never stops the upload.
      const usedNumbers = new Set<string>();
      // What makes a document one document is the library's own rule. With
      // "number and sheet", sixteen sheets share one drawing number and none
      // of them is a duplicate: a number is only taken when the whole key is.
      // (Suffixing by number alone turned sheet 11 into "5602-D 1000-10".)
      const keyRule = library.uniquenessKeys;
      const byKey = !!keyRule?.length && !(keyRule.length === 1 && keyRule[0] === "documentNumber");
      const usedKeys = new Set<string>();
      const live = () => supabase.from("documents").select("document_number, uniqueness_key")
        .eq("library_id", libraryId).not("status", "in", "(Archived,Superseded)");
      const addRows = (rows: unknown[] | null) => {
        for (const r of rows ?? []) {
          const row = r as { document_number: string; uniqueness_key?: string | null };
          usedNumbers.add(String(row.document_number || ""));
          if (row.uniqueness_key) usedKeys.add(row.uniqueness_key);
        }
      };
      for (let i = 0; i < distinctBases.length; i += 100) {
        const slice = distinctBases.slice(i, i + 100);
        let res = await live().in("document_number", slice);
        if (res.error) res = await live().in("document_number", slice);
        if (res.error) console.warn("[upload] duplicate-number check skipped for a slice:", res.error.message);
        addRows(res.data);
      }
      const takenBases = distinctBases.filter((b) => usedNumbers.has(b));
      for (let i = 0; i < takenBases.length; i += 8) {
        const results = await Promise.all(takenBases.slice(i, i + 8).map((b) =>
          live().like("document_number", `${escapeLikeLiteral(b)}-%`).limit(5000)));
        for (const res of results) addRows(res.data);
      }

      const keyOf = (item: StagedItem, documentNumber: string) => computeUniquenessKey({
        documentNumber, title: item.title.trim() || baseName(item.file.name), rev: item.rev.trim() || "0", status: item.status || "Issued", customFields: item.customFields,
      }, keyRule);
      const resolved: Array<{ item: StagedItem; docNumber: string; original: string }> = items.map((item, i) => {
        const original = originals[i];
        let candidate = original;
        let n = 1;
        const taken = (c: string) => { if (!byKey) return usedNumbers.has(c); const k = keyOf(item, c); return !!k && usedKeys.has(k); };
        while (taken(candidate)) {
          n += 1;
          candidate = `${original}-${n}`;
        }
        usedNumbers.add(candidate);
        if (byKey) { const k = keyOf(item, candidate); if (k) usedKeys.add(k); }
        if (candidate !== original) autoRenamed.push({ original, final: candidate });
        return { item, docNumber: candidate, original };
      });

      // ── Upload + insert one file ─────────────────────────────────
      const uploadOne = async (entry: { item: StagedItem; docNumber: string }, sig: AbortSignal | undefined = signal) => {
        const { item, docNumber } = entry;
        const file = item.file;
        const subPath = pathByFile.get(file) ?? [];
        const storagePath = makeLibraryStoragePath({
          orgId: activeOrgId,
          libraryId,
          folderPath: [...folderPath, ...subPath],
          filename: file.name,
        });
        // Fingerprint alongside the transfer when the staging window skipped
        // it (big batches) — duplicates and the estate still match on it.
        const hashing = item.fileHash ? Promise.resolve(item.fileHash) : hashFile(file);
        const uploadResult = await uploadToPath(file, storagePath, {
          contentType: file.type || undefined,
          signal: sig,
        });
        const fileHash = await hashing;

        const now = new Date().toISOString();
        const title = item.title.trim() || baseName(file.name);
        const rev = item.rev.trim() || "0";
        const status = item.status || "Issued";
        const uniquenessKey = computeUniquenessKey(
          { documentNumber: docNumber, title, rev, status, customFields: item.customFields },
          library.uniquenessKeys,
        );
        const targetCollectionId = targetFolderFor(file);
        const { data: newDoc, error: docErr } = await supabase.from("documents").insert({
          org_id: activeOrgId,
          library_id: libraryId,
          collection_id: targetCollectionId,
          name: file.name,
          title,
          document_number: docNumber,
          rev,
          status,
          uniqueness_key: uniquenessKey,
          metadata: {
            extension: file.name.split('.').pop()?.toLowerCase() || '',
            original_name: file.name,
            mime_type: file.type || 'application/octet-stream',
            size_bytes: String(file.size),
            last_modified: String(file.lastModified),
            ...item.customFields,
          },
          ingestion: { status: "queued", updated_at: now },
          visibility: library.defaultNewVisibility ?? "normal",
          acl: library.defaultNewAcl ?? null,
          acl_index: library.defaultNewAcl
            ? buildAclIndexFromChain([...chainForTarget(targetCollectionId), library.defaultNewAcl])
            : null,
          created_at: now,
          created_by: uid,
          updated_at: now,
          updated_by: uid,
        }).select("id").single();

        if (docErr || !newDoc) throw new Error(docErr?.message || "Failed to create document record");

        const versionRow = {
          org_id: activeOrgId,
          record_id: newDoc.id as string,
          revision_label: item.rev.trim() || "0",
          file_url: uploadResult.url,
          file_type: file.type || "application/octet-stream",
          size: uploadResult.size,
          // The key every copy is known by: duplicate warnings, the read
          // copy and the estate all match on it.
          file_hash: fileHash ?? null,
          created_by: uid,
          created_by_name: userEmail || uid,
          created_at: now,
        };
        let newVersion: { id: string } | null = null;
        let verErr: { message: string } | null = null;
        if (!versionsViaServerRef.current) {
          const r = await supabase.from("document_versions").insert(versionRow).select("id").single();
          newVersion = r.data as { id: string } | null;
          verErr = r.error;
          // A database row-rule loop refuses every browser insert. Switch
          // this and every later file to the server route for the session.
          if (verErr && (/infinite recursion/i.test(verErr.message) || (r.error as { code?: string } | null)?.code === "42P17")) {
            versionsViaServerRef.current = true;
          }
        }
        if (versionsViaServerRef.current && !newVersion) {
          try {
            const { data: { session } } = await supabase.auth.getSession();
            const res = await fetch("/api/documents/attach-version", {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${session?.access_token ?? ""}` },
              body: JSON.stringify({
                orgId: activeOrgId, documentId: newDoc.id, revisionLabel: versionRow.revision_label,
                fileUrl: versionRow.file_url, fileType: versionRow.file_type, size: versionRow.size,
                fileHash: versionRow.file_hash,
              }),
            });
            const out = (await res.json().catch(() => null)) as { versionId?: string; error?: string } | null;
            if (res.ok && out?.versionId) { newVersion = { id: out.versionId }; verErr = null; }
            else verErr = { message: out?.error ?? `HTTP ${res.status}` };
          } catch (e) { verErr = { message: (e as Error).message }; }
        }

        if (verErr || !newVersion) {
          // Don't leave a document with no file behind — a retry would add a
          // second one next to it.
          await supabase.from("documents").delete().eq("id", newDoc.id).then(() => undefined, () => undefined);
          throw new Error(verErr?.message || "Failed to create document version");
        }

        if (!versionsViaServerRef.current) {
          // Point the document at its file. One quiet retry; if it still
          // fails the batch says so (the file and record are both saved).
          const point = () => supabase.from("documents").update({ current_version_id: newVersion!.id }).eq("id", newDoc.id);
          let { error: ptrErr } = await point();
          if (ptrErr) ({ error: ptrErr } = await point());
          if (ptrErr) unlinked.push(file.name);
        }
        createdDocIds.push(newDoc.id as string);
        landedFiles.push(file);
        landedFilesRef.current.add(file);
      };

      // ── Run in capped-concurrency chunks ──────────────────────────
      // allSettled, not all: one unreadable file used to reject the chunk and
      // abandon every file after it, so a 40-file batch could stop at file 7
      // with no statement of what landed and what didn't. Every file now gets
      // its attempt and the batch reports the truth at the end.
      // A pool, not fixed chunks: each worker takes the next file the moment
      // its last one lands, so one slow file never idles the other lanes.
      // Files that fail are retried automatically (twice, after a pause) —
      // a transient network or rate-limit blip on file 700 of 1,100 must not
      // turn into "click Upload again".
      let stopped = false;
      let finished = 0;
      setUploadProgress({ done: 0, total: resolved.length });
      // The last round goes through tryUpload, so a file that still fails
      // gets "Try again" on the corner card with the same file. Safe to
      // repeat: a failed file leaves no record behind (see uploadOne).
      const runPool = async (entries: typeof resolved, offerRetry = false) => {
        const failed: Array<{ entry: (typeof resolved)[number]; reason: string }> = [];
        let nextIdx = 0;
        const worker = async () => {
          for (;;) {
            // The user pressed Stop or closed the window. Don't start work
            // nobody is waiting for; files in flight abort on their own.
            if (signal?.aborted) { stopped = true; return; }
            const idx = nextIdx++;
            if (idx >= entries.length) return;
            try {
              const entry = entries[idx];
              if (offerRetry) {
                // A later "Try again" runs after this window may be gone, so
                // it doesn't listen to this window's Stop.
                let first = true;
                await tryUpload(entry.item.file.name, () => { const sig = first ? signal : undefined; first = false; return uploadOne(entry, sig); },
                  { onRetried: () => setDocsRefreshTick((t) => t + 1) });
              } else {
                await uploadOne(entry);
              }
              finished++;
              setUploadProgress({ done: finished, total: resolved.length });
            } catch (err) {
              failed.push({ entry: entries[idx], reason: (err as Error)?.message ?? "unknown error" });
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, entries.length) }, worker));
        return failed;
      };
      let failedRound = await runPool(resolved);
      for (let round = 1; round <= 2 && failedRound.length > 0 && !stopped; round++) {
        await new Promise((r) => setTimeout(r, 2000 * round));
        if (signal?.aborted) { stopped = true; break; }
        failedRound = await runPool(failedRound.map((f) => f.entry), round === 2);
      }
      const failures = failedRound.map((f) => ({ name: f.entry.item.file.name, reason: f.reason }));
      const landed = landedFiles.length - alreadyHere.length;
      const notStarted = resolved.length - landed - failures.length;
      if (landed > 0) {
        notifyLibrarySubscribers(landed, resolved[0]?.docNumber || resolved[0]?.original || "document");
      }

      const notes: string[] = [];
      if (foldersCreatedNote) notes.push(foldersCreatedNote);
      if (unlinked.length) notes.push(`${unlinked.length} file${unlinked.length === 1 ? " was" : "s were"} saved but not yet shown as the current file (${unlinked.slice(0, 3).join(", ")}${unlinked.length > 3 ? "…" : ""}). Reload to check them.`);
      if (alreadyHere.length) notes.push(`${alreadyHere.length.toLocaleString()} file${alreadyHere.length === 1 ? " was" : "s were"} already here and skipped.`);
      if (autoRenamed.length > 0) {
        const sample = autoRenamed.slice(0, 3).map((r) => `${r.original} → ${r.final}`).join(", ");
        const more = autoRenamed.length > 3 ? `, +${autoRenamed.length - 3} more` : "";
        notes.push(`${autoRenamed.length} doc number${autoRenamed.length === 1 ? "" : "s"} auto-suffixed to avoid duplicates: ${sample}${more}.`);
      }
      if (notStarted > 0) {
        notes.push(`${notStarted} file${notStarted === 1 ? " was" : "s were"} not started because you stopped the upload.`);
      }
      if (failures.length > 0 || notStarted > 0) {
        if (failures.length > 0) {
          const sample = failures.slice(0, 3).map((f) => `${f.name} (${f.reason})`).join("; ");
          const more = failures.length > 3 ? `, +${failures.length - 3} more` : "";
          notes.push(`${failures.length} file${failures.length === 1 ? "" : "s"} still did not upload after several tries: ${sample}${more}.`);
        }
        // The window stays open holding ONLY what didn't land, and says so
        // in the window itself.
        if (createdDocIds.length) nudgeKnowledgeSources(activeOrgId!, libraryId);
        return {
          landed: landedFiles,
          message: `Uploaded ${landed.toLocaleString()} of ${resolved.length.toLocaleString()}. ${notes.join(" ")}`,
          failed: failedRound.map((f) => ({ file: f.entry.item.file, reason: f.reason })),
        };
      } else {
        setShowStagingModal(false);
        // A file just landed in doc control — any AI library watching this
        // one picks it up NOW, not at the next cron pass.
        nudgeKnowledgeSources(activeOrgId!, libraryId);
        if (createdDocIds.length) { nudgeEstateResolver(activeOrgId!, { documentIds: createdDocIds }); askWatchdog({ documentIds: createdDocIds }); }
        setPendingUploadFiles([]);
        uploadPathsRef.current = new Map();
        uploadFolderPlanRef.current = null;
        setFolderStaged(false);
        landedFilesRef.current = new WeakSet();
        setNotice(`Upload complete - ${landed.toLocaleString()} file${landed === 1 ? "" : "s"} uploaded${alreadyHere.length ? `, ${alreadyHere.length.toLocaleString()} already there` : ""}, all now in ${currentFolder ? `"${currentFolder.name}"` : library.name}.${notes.length ? " " + notes.join(" ") : ""}`);
      }
    } catch (e) {
      console.error(e);
      const f = translatePostgresError(e, { entity: "document", field: "document_number" });
      setError(`${f.heading} - ${f.message}`);
      throw e;
    } finally {
      endUpload();
      setUploadProgress(null);
      setLoadingUpload(false);
    }
  };

  const saveMetadata = async (next: { metadata: Record<string, MetadataValue>; core?: { title?: string; documentNumber?: string; rev?: string; status?: string } }) => {
    if (!selectedDoc?.id) return;
    const payload: Record<string, unknown> = {
      metadata: next.metadata,
      updated_at: new Date().toISOString(),
      updated_by: uid ?? null,
    };
    if (next.core?.title !== undefined) payload.title = next.core.title;
    if (next.core?.documentNumber !== undefined) payload.document_number = next.core.documentNumber;
    if (next.core?.rev !== undefined) payload.rev = next.core.rev;
    if (next.core?.status !== undefined) payload.status = next.core.status;
    // Recompute uniqueness_key from the freshest field values so that
    // edits to any uniqueness-contributing field stay consistent.
    payload.uniqueness_key = computeUniquenessKey({
      documentNumber: next.core?.documentNumber ?? selectedDoc.documentNumber,
      title: next.core?.title ?? selectedDoc.title,
      rev: next.core?.rev ?? selectedDoc.rev,
      status: next.core?.status ?? selectedDoc.status,
      customFields: next.metadata as Record<string, unknown>,
    }, library?.uniquenessKeys);
    const { error: saveErr } = await supabase.from("documents").update(payload).eq("id", selectedDoc.id);
    if (saveErr) {
      const f = translatePostgresError(saveErr, { entity: "document", field: "document_number" });
      throw new Error(f.message);
    }
  };

  const saveInlineDocNumber = async (docId: string, nextValue: string) => {
    if (!library) return;
    const trimmed = nextValue.trim();
    if (!trimmed) { setEditingDocNumError("Doc number can't be blank"); return; }
    const doc = documents.find((d) => d.id === docId);
    if (!doc) return;
    if (trimmed === doc.documentNumber) {
      setEditingDocNumId(null); setEditingDocNumValue(""); setEditingDocNumError(null);
      return;
    }
    setSavingDocNum(true);
    setEditingDocNumError(null);
    try {
      const uniquenessKey = computeUniquenessKey({
        documentNumber: trimmed,
        title: doc.title,
        rev: doc.rev,
        status: doc.status,
        customFields: doc.metadata as Record<string, unknown>,
      }, library.uniquenessKeys);
      const { error } = await supabase.from("documents").update({
        document_number: trimmed,
        uniqueness_key: uniquenessKey,
        updated_at: new Date().toISOString(),
        updated_by: uid ?? null,
      }).eq("id", docId);
      if (error) {
        const f = translatePostgresError(error, { entity: "document", field: "document_number" });
        setEditingDocNumError(f.message);
        return;
      }
      // Optimistically update local state so the cell shows the new value immediately.
      setDocuments((prev) => prev.map((d) => d.id === docId ? { ...d, documentNumber: trimmed } : d));
      setEditingDocNumId(null);
      setEditingDocNumValue("");
    } catch (e) {
      setEditingDocNumError((e as Error).message);
    } finally {
      setSavingDocNum(false);
    }
  };

  const handleDeleteColumn = async (key: string) => {
    if (!library || !activeOrgId) return;
    const updatedCols = (library.customColumns ?? []).filter((c) => c.key !== key);
    const { error: delErr } = await supabase.from("libraries").update({ custom_columns: updatedCols, updated_by: uid }).eq("id", library.id!);
    if (delErr) throw new Error(delErr.message);
    setLibrary((prev) => prev ? { ...prev, customColumns: updatedCols } : prev);
    // Remove from active view columns too — schema act, lands org-wide so
    // the deleted column doesn't linger as an orphan in the org default.
    const nextActive = activeColumns.filter((k) => k !== key);
    await updateColumns(nextActive, { scope: "org" });
  };

  // Rename a column's display label. Works for both system columns
  // (overrides the built-in label via libraries.column_label_overrides)
  // and custom columns (updates the customColumns entry inline).
  const handleRenameColumn = async (key: string, newLabel: string) => {
    if (!library || !activeOrgId) return;
    const trimmed = newLabel.trim();
    if (!trimmed) throw new Error("Column name can't be blank");

    // Custom column rename: update the customColumns array
    const existingCustom = (library.customColumns ?? []).find((c) => c.key === key);
    if (existingCustom) {
      const updatedCols = (library.customColumns ?? []).map((c) =>
        c.key === key ? { ...c, label: trimmed } : c
      );
      const { error } = await supabase
        .from("libraries")
        .update({ custom_columns: updatedCols, updated_by: uid })
        .eq("id", library.id!);
      if (error) throw new Error(error.message);
      setLibrary((prev) => prev ? { ...prev, customColumns: updatedCols } : prev);
      return;
    }

    // System column rename: persist as a label override on the library
    const overrides = { ...(library.columnLabelOverrides ?? {}), [key]: trimmed };
    const { error } = await supabase
      .from("libraries")
      .update({ column_label_overrides: overrides, updated_by: uid })
      .eq("id", library.id!);
    if (error) throw new Error(error.message);
    setLibrary((prev) => prev ? { ...prev, columnLabelOverrides: overrides } : prev);
  };

  // (Removed: a dead startSession/endSession/abandonSession trio lived here.
  // It created checkout sessions + document locks WITHOUT the required
  // purpose/reason — never called from the UI, but exactly the bypass class
  // the forced checkout flow exists to prevent. CheckoutFlowModal is the
  // single checkout path.)

  const columnMap = useMemo(() => {
    const map = new Map<string, MetadataFieldDefinition>();
    for (const c of columnDefs) {
      if (c?.key) map.set(c.key, c);
    }
    return map;
  }, [columnDefs]);

  // Column width helper — keeps the table from overflowing horizontally
  const getDefaultColWidth = useCallback((colKey: string): number => {
    if (colKey === "title") return 240;
    if (colKey === "documentNumber") return 140;
    if (colKey === "rev") return 68;
    if (colKey === "status") return 104;
    if (colKey === "updatedAt") return 104;
    const def = columnMap.get(colKey);
    if (def?.type === "tags" || def?.isPill) return 236;
    if (def?.type === "date") return 110;
    if (def?.type === "number") return 90;
    if (def?.type === "boolean") return 70;
    if (def?.type === "select") return 130;
    return 120;
  }, [columnMap]);

  // Returns the effective pixel width for a column (user override or default)
  const getColWidth = useCallback((colKey: string): string | undefined => {
    const w = colWidths[colKey];
    if (w) return `${w}px`;
    const d = getDefaultColWidth(colKey);
    return `${d}px`;
  }, [colWidths, getDefaultColWidth]);

  // Starts a column resize drag. Admin/DocCtrl only.
  const handleResizeStart = useCallback((e: React.PointerEvent, colKey: string) => {
    e.preventDefault();
    e.stopPropagation();
    // Start from the width on screen (the title fills what's left, so its
    // default isn't what you see), so the edge doesn't jump under the pointer.
    const shown = (e.currentTarget as HTMLElement).closest("th")?.getBoundingClientRect().width;
    const startWidth = colWidths[colKey] ?? (shown ? Math.round(shown) : getDefaultColWidth(colKey));
    resizingRef.current = { key: colKey, startX: e.clientX, startWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    // Pointer events unify mouse + touch + pen, so column resize now works by
    // dragging the handle on a tablet, not just with a mouse.
    const onMove = (ev: PointerEvent) => {
      // Capture the ref into a local var BEFORE the math — onUp may
      // null out resizingRef.current between the guard and the field
      // access, which would crash with "Cannot read properties of
      // null (reading 'key')".
      const current = resizingRef.current;
      if (!current) return;
      const newWidth = Math.max(50, current.startWidth + ev.clientX - current.startX);
      setColWidths(prev => ({ ...prev, [current.key]: newWidth }));
    };

    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // The release ends a resize; it isn't a click that sorts the column.
      resizeClickGuardRef.current = true;
      setTimeout(() => { resizeClickGuardRef.current = false; }, 0);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      resizingRef.current = null;
      if (library?.id && uid) {
        if (saveWidthsTimerRef.current) clearTimeout(saveWidthsTimerRef.current);
        const snapshot = { ...colWidthsRef.current };
        saveWidthsTimerRef.current = setTimeout(() => {
          void supabase.from("libraries").update({ column_widths: snapshot, updated_by: uid }).eq("id", library.id!)
            .then(({ error: wErr }) => { if (wErr) setError("Couldn't save the column width. It will reset next time."); });
        }, 600);
      }
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  }, [colWidths, getDefaultColWidth, library, uid]);

  // Double-click handle to reset a column to its default width
  const handleResizeReset = useCallback((e: React.MouseEvent, colKey: string) => {
    e.preventDefault();
    e.stopPropagation();
    setColWidths(prev => {
      const next = { ...prev };
      delete next[colKey];
      if (library?.id && uid) {
        void supabase.from("libraries").update({ column_widths: next, updated_by: uid }).eq("id", library.id!)
          .then(({ error: wErr }) => { if (wErr) setError("Couldn't save the column width. It will reset next time."); });
      }
      return next;
    });
  }, [library, uid]);

  const renderDocCell = (docRecord: DocumentRecord, key: string) => {
    if (key === "title") return docRecord.title || docRecord.name || "Untitled";
    if (key === "documentNumber") return docRecord.documentNumber || "-";
    if (key === "rev") return docRecord.rev || "-";
    if (key === "status") return docRecord.status || "-";
    if (key === "updatedAt") return humanDate(docRecord.updatedAt);
    if (key === "createdAt") return humanDate(docRecord.createdAt);
    if (key === "size") return formatBytesShort(docSizeBytes(docRecord));
    if (key === "fileType") {
      const ext = docFileExt(docRecord);
      if (ext) return `.${ext}`;
      const mime = (docRecord.metadata ?? {})["mime_type"];
      return typeof mime === "string" && mime ? mime : "-";
    }

    const def = columnMap.get(key);
    const value = (docRecord.metadata ?? {})[key];

    if (!def) return value == null ? "-" : String(value);

    if (def.type === "review") {
      return <ReviewPill nextReviewDate={docRecord.nextReviewDate} compact />;
    }
    if (def.type === "owner") {
      return docRecord.ownerName || <span className="text-[var(--color-text-faint)]">-</span>;
    }
    if (def.type === "ack") {
      return <AckPill summary={docRecord.id ? ackSummaries.get(docRecord.id) : undefined} compact />;
    }
    if (def.type === "effective") {
      return <EffectivePill effectiveDate={docRecord.effectiveDate} compact />;
    }
    if (def.type === "retention") {
      return <RetentionPill retentionUntil={docRecord.retentionUntil} dispositionState={docRecord.dispositionState} legalHold={docRecord.legalHold} compact />;
    }
    if (def.type === "origin") {
      return docRecord.origin === "external"
        ? <OriginBadge origin="external" source={docRecord.externalSource} reference={docRecord.externalReference} edition={docRecord.externalEdition} />
        : <span className="text-[var(--color-text-faint)]">Internal</span>;
    }

    if (def.type === "tags" || def.isPill) {
      const list = Array.isArray(value) ? value : value ? String(value).split(",").map((v) => v.trim()).filter(Boolean) : [];
      if (!list.length) return "-";
      return (
        <div className="flex flex-wrap gap-1">
          {list.map((tag) => (
            <AssetTagChip
              key={tag}
              tag={tag}
              type={def.pillGroupLabel || "Equipment"}
              orgId={activeOrgId ?? undefined}
              userId={uid ?? undefined}
              canManage={["Admin", "Manager", "Supervisor"].includes(activeRole)}
            />
          ))}
        </div>
      );
    }

    if (Array.isArray(value)) return value.join(", ");
    return value == null ? "-" : String(value);
  };

  // A column's header label: the library's rename, else the built-in or
  // custom column's own name.
  const columnLabel = (colKey: string): string =>
    library?.columnLabelOverrides?.[colKey]
    || BUILTIN_COLUMNS.find((c) => c.key === colKey)?.label
    || OPTIONAL_BUILTIN_COLUMNS.find((c) => c.key === colKey)?.label
    || columnMap.get(colKey)?.label
    || colKey;

  // Drag a header to move its column (pointer events: mouse, pen, touch).
  // Saved like every other column tweak: to your view of this folder.
  const columnDrag = useColumnReorder({
    columns: activeColumns,
    labelFor: columnLabel,
    onReorder: (next) => { void updateColumns(next); },
    scrollEl: tableScrollEl,
  });

  if (!activeOrgId) {
    return (
      <div className="min-h-full px-3 sm:px-4 pt-3 sm:pt-4">
        <PageHero overlap={false} kicker="Document control" title="Pick a workspace."
          sub="Select a workspace in the sidebar to open this library." back={{ href: "/documents", label: "Back to all libraries" }} />
      </div>
    );
  }

  // Until the first fetch answers, "not found" would be a lie: keep the
  // loader up unless the fetch has actually said why it failed.
  if (loadingLibrary || (!library && !error)) {
    return <RouteLoader label="Loading library…" />;
  }

  if (!library) {
    return (
      <div className="min-h-full px-3 sm:px-4 pt-3 sm:pt-4">
        <PageHero overlap={false} kicker="Document control" title="Library not found."
          sub={error || "Unable to load library."} back={{ href: "/documents", label: "Back to all libraries" }} />
      </div>
    );
  }

  const isController = isControllerRole(activeRole);
  // Where this folder's columns come from, and whether "Use the library's"
  // would actually bring the library default here for this person.
  const columnSource: "user" | "org" | "library" | "default" =
    colLevels.user ? "user" : colLevels.folder ? "org" : colLevels.library ? "library" : "default";
  const canUseLibraryColumns = !!colLevels.library
    && (columnSource === "user" || columnSource === "org")
    && (isController || !colLevels.folder);
  const allSelected = sortedDocs.length > 0 && selectedDocIds.size === sortedDocs.length;
  const someSelected = selectedDocIds.size > 0 && !allSelected;

  // ── Per-folder default sort ───────────────────────────────────────────
  // Display label for a sort key (built-in or custom column).
  const sortLabelFor = (key: string) => columnOptions.find((c) => c.key === key)?.label ?? key;
  // Is the current sort already this folder's saved default?
  const isFolderDefaultSort =
    !!folderDefaultSort && folderDefaultSort.key === sortKey && folderDefaultSort.dir === sortDir;

  // Save the WHOLE current presentation (columns, sort, layout, density) as
  // this library/folder's default. Everyone — Viewer to Admin — can save a
  // personal default; only controllers can publish the org-wide default that
  // everyone else inherits until they save their own.
  const saveViewDefault = async (scope: "user" | "org") => {
    if (!activeOrgId || !uid || savingSortDefault) return;
    setSavingSortDefault(true);
    try {
      await saveTableView({
        scope,
        orgId: activeOrgId,
        ownerUserId: scope === "user" ? uid : undefined,
        libraryId,
        collectionId: currentFolderId ?? undefined,
        columns: activeColumns,
        sort: { key: sortKey, dir: sortDir },
        view: { layout: docLayout, density },
      });
      setFolderDefaultSort({ key: sortKey, dir: sortDir });
      setViewDefaults((prev) => scope === "user" ? { ...prev, hasUserRow: true } : { ...prev, hasOrgRow: true });
    } catch (e) {
      await appAlert(`Couldn't save the default view: ${(e as Error).message}`);
    } finally {
      setSavingSortDefault(false);
    }
  };

  // Drop the personal default so this container falls back to the org's.
  const clearMyViewDefault = async () => {
    if (!activeOrgId || !uid) return;
    try {
      await deleteTableView({
        scope: "user",
        orgId: activeOrgId,
        ownerUserId: uid,
        libraryId,
        collectionId: currentFolderId ?? undefined,
      });
      setViewDefaults((prev) => ({ ...prev, hasUserRow: false }));
      // Re-resolve on next folder entry; apply the org state now for feedback.
      const res = await resolveEffectiveViewState({
        orgId: activeOrgId, ownerUserId: uid, libraryId, collectionId: currentFolderId ?? undefined,
      });
      setFolderDefaultSort(res.sort ?? null);
      if (res.sort?.key) { setSortKey(res.sort.key); setSortDir(res.sort.dir === "asc" ? "asc" : "desc"); }
      setDocLayout(res.view?.layout ?? "details");
      if (res.view?.density) setDensity(res.view.density);
    } catch (e) {
      await appAlert(`Couldn't clear your default view: ${(e as Error).message}`);
    }
  };

  const rowPad = density === "compact" ? "py-2" : "py-3";
  const headerPad = "h-10";
  // The table never squeezes below its columns; the title takes what's left.
  const CHECKOUT_COL = 144;
  // Who has it sits right after the status (number, title, rev, status,
  // checked out by, updated), not off at the far right.
  const checkoutAfterKey: string | undefined = activeColumns.includes("status") ? "status" : activeColumns[activeColumns.length - 1];
  const checkoutTh = <th className={`px-3 ${headerPad}`} style={{ width: `${CHECKOUT_COL}px` }}>Checked out by</th>;
  const tableMinWidth = 36 + activeColumns.reduce((n, k) => n + (k === "title" && !colWidths.title ? 140 : colWidths[k] ?? getDefaultColWidth(k)), 0)
    + CHECKOUT_COL + 36 + 44;

  // Right-click menu for a document row/card. Acts on the whole selection
  // when the clicked item is part of it (the gesture handler guarantees it
  // is), so "Archive 5" and "Move 5" read exactly like Explorer.
  const buildDocContextEntries = (doc: DocumentRecord): ContextMenuEntry[] => {
    const n = selectedDocIds.has(doc.id!) ? Math.max(selectedDocIds.size, 1) : 1;
    const many = n > 1;
    const isStaged = stagedDocs.some((d) => d.id === doc.id);
    const entries: ContextMenuEntry[] = [];
    if (!many) {
      entries.push({
        key: "open", label: "Open", icon: <Eye className="w-3.5 h-3.5" />,
        onSelect: () => handleRowDoubleClick(doc),
      });
      entries.push({
        key: "meta", label: "Edit metadata", icon: <Pencil className="w-3.5 h-3.5" />,
        onSelect: () => { setSelectedDoc(doc); setShowMetadataEditor(true); },
      });
      if (docLayout === "details") {
        entries.push({
          key: "rename", label: "Rename number", icon: <Hash className="w-3.5 h-3.5" />,
          onSelect: () => {
            setEditingDocNumId(doc.id!);
            setEditingDocNumValue(doc.documentNumber || "");
            setEditingDocNumError(null);
          },
        });
        entries.push({
          key: "renameTitle", label: "Rename title", icon: <Pencil className="w-3.5 h-3.5" />,
          onSelect: () => startTitleEdit(doc),
        });
      }
      if (doc.documentNumber) {
        entries.push({
          key: "link", label: "Copy link", icon: <LinkIcon className="w-3.5 h-3.5" />,
          onSelect: () => {
            void navigator.clipboard?.writeText(`${window.location.origin}/d/${encodeURIComponent(doc.documentNumber!)}`);
          },
        });
      }
    }
    entries.push({
      key: "stage", separator: !many,
      label: many ? `Add ${n} to Reference Stack` : isStaged ? "Remove from Reference Stack" : "Add to Reference Stack",
      icon: <Layers className="w-3.5 h-3.5" />,
      onSelect: () => {
        if (many) {
          setStagedDocs((prev) => {
            const existing = new Set(prev.map((d) => d.id));
            return [...prev, ...sortedDocs.filter((d) => selectedDocIds.has(d.id!) && !existing.has(d.id))];
          });
        } else {
          setStagedDocs((prev) => prev.some((d) => d.id === doc.id)
            ? prev.filter((d) => d.id !== doc.id)
            : [...prev, doc]);
        }
      },
    });
    entries.push({
      key: "copyLinks", label: many ? `Copy ${n} links` : "Copy link(s)",
      icon: <LinkIcon className="w-3.5 h-3.5" />,
      onSelect: copySelectionLinks,
    });
    if (isController) {
      entries.push({
        key: "cut", label: many ? `Cut ${n} (move with paste)` : "Cut (move with paste)",
        icon: <ArrowRight className="w-3.5 h-3.5" />,
        onSelect: cutSelection,
      });
      if (cutDocIds.size > 0) {
        entries.push({
          key: "paste", label: `Paste ${cutDocIds.size} here`,
          icon: <FolderPlus className="w-3.5 h-3.5" />,
          onSelect: () => void pasteCut(),
        });
      }
      entries.push({
        key: "move", label: many ? `Move ${n} documents…` : "Move to folder…",
        icon: <ArrowRight className="w-3.5 h-3.5" />,
        onSelect: () => setShowBulkMoveModal(true),
      });
      entries.push({
        key: "archive", separator: true,
        label: many ? `Archive ${n}` : "Archive",
        icon: <Archive className="w-3.5 h-3.5" />,
        onSelect: () => void handleBulkArchive(),
      });
      entries.push({
        key: "delete", label: many ? `Delete ${n} permanently…` : "Delete permanently…",
        icon: <Trash2 className="w-3.5 h-3.5" />, danger: true,
        onSelect: () => void handleBulkDelete(),
      });
    }
    return entries;
  };

  // ── The band: the library's answer ─────────────────────────────────
  // "54 drawings." — the count everything below is about, from the folder
  // counts already loaded; the line under it says how they stand.
  const noun = (() => {
    const n = (library.name || "").trim();
    const last = n.split(/\s+/).pop() ?? "";
    if (/^[A-Za-z][A-Za-z ]{0,40}$/.test(n) && n.split(/\s+/).length <= 3 && /[^siu]s$/i.test(last)) {
      const many = n.toLowerCase();
      return { one: many.slice(0, -1), many };
    }
    return { one: "document", many: "documents" };
  })();
  const totalHere = folderCounts
    ? (currentFolderId ? folderCounts.totals.get(currentFolderId) ?? 0 : folderCounts.libraryTotal)
    : null;
  const answer = totalHere === null ? (currentFolder?.name ?? library.name)
    : totalHere === 0 ? (currentFolderId ? "Nothing filed here yet." : `No ${noun.many} yet.`)
    : `${totalHere.toLocaleString()} ${totalHere === 1 ? noun.one : noun.many}.`;
  // The numbers that back the answer up, in ruled cells: how the documents
  // filed here stand, how many are checked out, how many folders.
  const answerStats = (() => {
    if (totalHere === null || (loadingDocs && documents.length === 0)) return null;
    // Filed directly here and readable; a typed filter doesn't change the answer.
    const list = search.trim() ? documents : filteredDocs;
    const by = new Map<string, number>();
    for (const d of list) if (d.status) by.set(d.status, (by.get(d.status) ?? 0) + 1);
    const ranked = [...by.entries()].sort((a, b) => b[1] - a[1]);
    const out = list.filter((d) => isDocumentCheckedOut(d));
    const mine = out.filter((d) => d.checkedOutBy === uid).length;
    return { list, ranked, out: out.length, mine, partial: list.length < (totalHere ?? 0) };
  })();
  const answerSub = (() => {
    if (!answerStats) return undefined;
    if (answerStats.list.length === 0) {
      if (filteredFolders.length > 0) return `In ${filteredFolders.length} folder${filteredFolders.length === 1 ? "" : "s"} below.`;
      return "Drop files anywhere on this page, or use Upload.";
    }
    if (answerStats.mine > 0) return `${answerStats.mine.toLocaleString()} checked out by you.`;
    return undefined;
  })();
  const answerFacts = (() => {
    if (!answerStats || answerStats.list.length === 0) return undefined;
    const facts: { label: string; value: string; tone?: "bad" | "warn" | "good" }[] = [];
    if (answerStats.partial) facts.push({ label: "Filed here", value: answerStats.list.length.toLocaleString() });
    // Three cells at most, so they sit side by side on a phone too. The
    // folders have their own table right below.
    for (const [st, n] of answerStats.ranked.slice(0, 2 - facts.length)) {
      const tone = docStatusTone(st);
      facts.push({ label: st, value: n.toLocaleString(), tone: tone === "warn" || tone === "bad" ? tone : undefined });
    }
    facts.push({ label: "Checked out", value: answerStats.out.toLocaleString(), tone: answerStats.out > 0 ? "warn" : undefined });
    return facts;
  })();
  const libMenuItem = "w-full px-3 min-h-10 py-2 text-left text-[13px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center gap-2.5";
  const upTo = currentFolder?.parentId ? folderMap.get(currentFolder.parentId)?.name ?? "parent folder" : library.name;

  // The one orange action. On a phone it rides in the bottom bar, so its
  // menu opens upward there.
  const uploadPrimary = (
    <div className="relative">
      <button
        type="button"
        onClick={() => setUploadMenuOpen((v) => !v)}
        className={`${heroPrimary} w-full`}
        title="Upload files or a whole folder"
        aria-haspopup="menu"
        aria-expanded={uploadMenuOpen}
      >
        <UploadCloud className="w-4 h-4" />
        Upload {noun.many}
        <ChevronDown className="w-4 h-4 opacity-80" />
      </button>
      {uploadMenuOpen && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setUploadMenuOpen(false)} />
          <div role="menu" className="absolute right-0 top-full mt-2 max-sm:top-auto max-sm:bottom-full max-sm:mb-2 max-sm:left-0 sm:w-72 bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] rounded-xl shadow-xl z-40 overflow-hidden text-left">
                <button role="menuitem"
                  onClick={() => { setUploadMenuOpen(false); fileInputRef.current?.click(); }}
                  className="w-full px-3 py-2.5 text-left hover:bg-[var(--color-surface-2)] flex items-start gap-2.5">
                  <UploadCloud className="w-4 h-4 mt-0.5 text-[var(--color-text-muted)] shrink-0" />
                  <span>
                    <span className="block text-[13px] font-bold">Files…</span>
                    <span className="block text-[13px] text-[var(--color-text-muted)]">Pick one or many files</span>
                  </span>
                </button>
                <button role="menuitem"
                  onClick={() => { setUploadMenuOpen(false); folderInputRef.current?.click(); }}
                  className="w-full px-3 py-2.5 text-left hover:bg-[var(--color-surface-2)] flex items-start gap-2.5 border-t border-[var(--color-border)]">
                  <FolderUp className="w-4 h-4 mt-0.5 text-[var(--color-text-muted)] shrink-0" />
                  <span>
                    <span className="block text-[13px] font-bold">A whole folder…</span>
                    <span className="block text-[13px] text-[var(--color-text-muted)]">
                      {isController ? "Every subfolder and file keeps its place" : "Its files are added here (folders need Doc Control)"}
                    </span>
                  </span>
                </button>
          </div>
        </>
      )}
    </div>
  );

  const libTools = (
    <>
      {/* Library quick-jump (folders + sheets in this library, plus
          in-library actions). ⌘K is the global palette. */}
      <button type="button" onClick={() => setCommandOpen(true)} className={heroQuiet}
        title="Jump to a folder or sheet in this library" aria-label="Find in library">
        <Search className="w-4 h-4" />
        <span className="max-md:hidden">Find in library</span>
      </button>
      {/* Subscribe to this library: watchers get notified when documents
          are added or revised here. */}
      {activeOrgId && uid && (
        <WatchButton orgId={activeOrgId} userId={uid} resourceType="library" resourceId={libraryId} size="sm"
          className="!w-9 !h-9 !rounded-md border border-[var(--color-border-strong)] !bg-[var(--color-surface)] hover:!bg-[var(--color-surface-2)] !text-[var(--color-text-muted)]" />
      )}
      {/* New folder: creating structure is as basic as adding files.
          Creates inside whatever folder you're viewing. */}
      {isController && (
        <button type="button" onClick={openCreateFolder} className={heroQuiet}
          title="New folder (created inside the folder you're viewing)" aria-label="New folder">
          <FolderPlus className="w-4 h-4" />
          <span className="max-lg:hidden">New folder</span>
        </button>
      )}
      <div className="relative">
        <button type="button" onClick={() => setActionsMenuOpen((v) => !v)} className={heroQuiet}
          aria-haspopup="menu" aria-expanded={actionsMenuOpen} aria-label="Library actions" title="Library actions">
          <span className="max-md:hidden">Library</span>
          <MoreHorizontal className="w-4 h-4" />
        </button>
        {actionsMenuOpen && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setActionsMenuOpen(false)} />
            <div role="menu"
              className="absolute right-0 top-full mt-2 w-72 max-w-[calc(100vw-2rem)] max-h-[70vh] overflow-y-auto py-1 bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] rounded-xl shadow-xl z-40 animate-in fade-in zoom-in-95 duration-150 origin-top-right"
            >
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); setShowDuplicates(true); }}
                    role="menuitem" className={libMenuItem}
                  >
                    <Copy className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> Clean up uploads (duplicates, missing files)…
                  </button>
                )}
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); setNumberingOpen(true); }}
                    role="menuitem" className={libMenuItem}
                  >
                    <Hash className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> Auto-numbering…
                  </button>
                )}
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); setShowEquipmentSweep(true); }}
                    role="menuitem" className={libMenuItem}
                    title="Pull equipment tags the AI read from drawings into the equipment column and the registry"
                  >
                    <ScanSearch className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> Equipment sweep
                  </button>
                )}
                <button
                  onClick={() => { setActionsMenuOpen(false); setNewCollection((n) => n + 1); }}
                  role="menuitem" className={libMenuItem}
                  title="Combine related documents into one named book you can read end to end"
                >
                  <FolderKanban className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> New collection
                </button>
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); setHomeAsk((n) => n + 1); }}
                    role="menuitem" className={libMenuItem}
                    title="An about panel, quick folders, recent documents and notices at the top of this library or folder"
                  >
                    <LayoutGrid className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> Custom home
                  </button>
                )}
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); setShowColumnManager(true); }}
                    role="menuitem" className={libMenuItem}
                  >
                    <Columns className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> Manage columns
                  </button>
                )}
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); setShowLibraryOrderModal(true); }}
                    role="menuitem" className={libMenuItem}
                  >
                    <GripVertical className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> Reorder documents
                  </button>
                )}
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); setReviewPolicyTarget({ level: "library", id: libraryId, name: library?.name }); }}
                    role="menuitem" className={libMenuItem}
                    title="Set a periodic-review cycle for every document in this library"
                  >
                    <CalendarClock className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> Review cycle
                  </button>
                )}
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); setAckPolicyTarget({ level: "library", id: libraryId, name: library?.name }); }}
                    role="menuitem" className={libMenuItem}
                    title="Require read-&-understood acknowledgment for every document in this library"
                  >
                    <ClipboardCheck className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> Read &amp; understood
                  </button>
                )}
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); setReviewControlTarget({ level: "library", id: libraryId, name: library?.name }); }}
                    role="menuitem" className={libMenuItem}
                    title="Require reviewer sign-off before a revision publishes in this library"
                  >
                    <ShieldCheck className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> Pre-publish review
                  </button>
                )}
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); setRetentionTarget({ level: "library", id: libraryId, name: library?.name }); }}
                    role="menuitem" className={libMenuItem}
                    title="Set a retention period for records in this library"
                  >
                    <Archive className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> Retention
                  </button>
                )}
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); void openTrash(); }}
                    role="menuitem" className={libMenuItem}
                    title="Deleted folders are held for 30 days and can be restored here"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> Recently deleted…
                  </button>
                )}
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); setRecertOpen(true); }}
                    role="menuitem" className={libMenuItem}
                    title="Review and re-attest who has access to this library"
                  >
                    <KeyRound className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> Access recertification
                  </button>
                )}
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); setShowCsvImport(true); }}
                    role="menuitem" className={libMenuItem}
                    title="Bulk-create document records from a pasted CSV"
                  >
                    <FileText className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> Import from CSV
                  </button>
                )}
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); setShowLibraryPerms(true); }}
                    role="menuitem" className={libMenuItem}
                    title="Grant who can publish revisions / control documents in this library (e.g. a Drafting Supervisor on drawings only)"
                  >
                    <Shield className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> Library access
                  </button>
                )}
                <button
                  onClick={() => { setActionsMenuOpen(false); setShowViewSelector((v) => !v); }}
                  role="menuitem" className={libMenuItem}
                >
                  <Eye className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> Views & save current
                </button>
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); setShowArchivedDocs((v) => !v); }}
                    role="menuitem" className={libMenuItem}
                  >
                    <Archive className="w-3.5 h-3.5 text-[var(--color-text-faint)]" />
                    {showArchivedDocs ? "Hide archived docs" : "Show archived docs"}
                  </button>
                )}
                <button
                  onClick={() => { setActionsMenuOpen(false); window.location.reload(); }}
                  role="menuitem" className={libMenuItem}
                >
                  <RefreshCw className={`w-3.5 h-3.5 text-[var(--color-text-faint)] ${loadingDocs ? "animate-spin" : ""}`} /> Refresh
                </button>
            </div>
          </>
        )}
      </div>
    </>
  );

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {peekDocId && <DocInPlace docId={peekDocId} onClose={() => setPeekDocId(null)} />}
      {showFullScreen && selectedDoc && selectedVersion && (
        <FullScreenViewer
          isOpen={showFullScreen}
          onClose={() => setShowFullScreen(false)}
          url={selectedVersion.fileUrl}
          title={selectedDoc.title || "Document"}
          docNumber={selectedDoc.documentNumber || ""}
          rev={selectedVersion.revisionLabel || ""}
          document={selectedDoc}
          userRole={activeRole}
          currentUserId={uid || undefined}
          currentUserEmail={userEmail || undefined}
          onCheckout={openCheckout}
          orgId={activeOrgId ?? undefined}
          customColumns={(library?.customColumns ?? []) as unknown as Array<{ key: string; label: string; type?: string; pillGroupLabel?: string }>}
        />
      )}

      {showRevUp && selectedDoc && activeOrgId && uid && (
        <RevUpModal
          isOpen={showRevUp}
          onClose={() => setShowRevUp(false)}
          doc={selectedDoc}
          libraryId={libraryId}
          folderPath={(() => {
            const f = selectedDoc.collectionId ? folderMap.get(selectedDoc.collectionId) : null;
            return f ? [...(f.pathNames ?? []), f.name].filter(Boolean) as string[] : [];
          })()}
          orgId={activeOrgId}
          actorUserId={uid}
          actorEmail={userEmail || undefined}
          actorRole={activeRole}
          onSuccess={(newVersion) => {
            // Refresh the doc + the version + the history list
            setSelectedVersion(newVersion);
            setSelectedDoc((prev) => prev ? {
              ...prev,
              rev: newVersion.revisionLabel,
              currentVersionId: newVersion.id,
              status: "Issued",
              updatedAt: new Date().toISOString() as DocumentRecord["updatedAt"],
            } : prev);
            setVersionHistoryRefreshKey((k) => k + 1);
          }}
        />
      )}

      {showSupersede && selectedDoc && activeOrgId && uid && (
        <SupersedeModal
          isOpen={showSupersede}
          onClose={() => setShowSupersede(false)}
          doc={selectedDoc}
          libraryId={libraryId}
          orgId={activeOrgId}
          actorUserId={uid}
          actorEmail={userEmail || undefined}
          actorRole={activeRole}
          onSuccess={() => {
            setSelectedDoc((prev) => prev ? { ...prev, status: "Superseded" } : prev);
            setVersionHistoryRefreshKey((k) => k + 1);
          }}
        />
      )}

      {showArchive && selectedDoc && activeOrgId && uid && (
        <ArchiveConfirmModal
          isOpen={showArchive}
          onClose={() => setShowArchive(false)}
          doc={selectedDoc}
          mode={selectedDoc.status === "Archived" ? "unarchive" : "archive"}
          orgId={activeOrgId}
          actorUserId={uid}
          actorEmail={userEmail || undefined}
          actorRole={activeRole}
          onSuccess={() => {
            const newStatus = selectedDoc.status === "Archived" ? "Issued" : "Archived";
            setSelectedDoc((prev) => prev ? { ...prev, status: newStatus as DocumentRecord["status"] } : prev);
            setVersionHistoryRefreshKey((k) => k + 1);
          }}
        />
      )}

      {showBulkCheckout && activeOrgId && uid && (
        <BulkCheckoutToProjectModal
          isOpen={showBulkCheckout}
          onClose={() => setShowBulkCheckout(false)}
          docs={sortedDocs.filter((d) => selectedDocIds.has(d.id!))}
          orgId={activeOrgId}
          actorUserId={uid}
          actorEmail={userEmail || undefined}
          actorRole={activeRole}
          onSuccess={() => {
            setSelectedDocIds(new Set());
          }}
        />
      )}

      {showBulkEdit && library && uid && (
        <BulkEditModal
          isOpen={showBulkEdit}
          onClose={() => setShowBulkEdit(false)}
          docs={sortedDocs.filter((d) => selectedDocIds.has(d.id!))}
          library={library}
          actorUserId={uid}
          onApplied={() => {
            setDocsRefreshTick((t) => t + 1);
          }}
        />
      )}

      {showCsvImport && library && activeOrgId && uid && (
        <CsvImportModal
          isOpen={showCsvImport}
          onClose={() => setShowCsvImport(false)}
          library={library}
          orgId={activeOrgId}
          collectionId={currentFolderId}
          actorUserId={uid}
          onImported={() => {
            setShowCsvImport(false);
            setDocsRefreshTick((t) => t + 1);
          }}
        />
      )}

      {revertTarget && selectedDoc && activeOrgId && uid && (
        <RevertConfirmModal
          isOpen={!!revertTarget}
          onClose={() => setRevertTarget(null)}
          doc={selectedDoc}
          libraryId={libraryId}
          targetVersion={revertTarget}
          orgId={activeOrgId}
          actorUserId={uid}
          actorEmail={userEmail || undefined}
          actorRole={activeRole}
          onSuccess={(newVersion) => {
            setSelectedVersion(newVersion);
            setSelectedDoc((prev) => prev ? {
              ...prev,
              rev: newVersion.revisionLabel,
              currentVersionId: newVersion.id,
              status: "Issued",
              updatedAt: new Date().toISOString() as DocumentRecord["updatedAt"],
            } : prev);
            setVersionHistoryRefreshKey((k) => k + 1);
          }}
        />
      )}

      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => handleUploadFiles(e.target.files)} />
      {/* webkitdirectory isn't in React's input types — spread it through. */}
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => handleFolderPick(e.target.files)}
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
      />

      {/* BODY: folder rail + full-width main */}
      <div className="flex flex-1 overflow-hidden relative isolate">
        {pageBackground && <PageBackground bg={pageBackground} />}

        <FolderRail
          libraryName={library.name}
          folders={folders}
          docTotals={folderCounts?.totals}
          libraryTotal={folderCounts?.libraryTotal}
          currentFolderId={currentFolderId}
          isController={isController}
          onNavigate={setCurrentFolderId}
          onCreateFolder={openCreateFolder}
          onDropItems={isController ? (targetId, payload) => {
            if (payload.folderIds?.length) void dropMoveFolders(payload.folderIds, targetId);
            else if (payload.folderId) void dropMoveFolder(payload.folderId, targetId);
            else if (payload.docIds?.length) void dropMoveDocs(payload.docIds, targetId);
          } : undefined}
        />

        {/* MAIN AREA: the band with the answer, then cards over its edge */}
        <div className={`flex-1 min-w-0 overflow-auto px-3 sm:px-4 pt-3 sm:pt-4 ${stagedDocs.length > 0 ? "pb-28" : "pb-24 sm:pb-10"}`}>
          <div className="max-w-[1920px] mx-auto">

            <PageHero
              kicker={
                <PathBar
                  onDark
                  home={{ label: "Document control", href: "/documents" }}
                  library={{ name: library.name, icon: library.icon, color: library.color }}
                  segments={currentFolder ? [
                    ...(currentFolder.pathIds ?? []).map((pid, idx) => {
                      const f = folderMap.get(pid);
                      return {
                        id: pid,
                        name: currentFolder.pathNames?.[idx] ?? f?.name ?? "…",
                        icon: f?.icon, color: f?.color,
                      };
                    }),
                    {
                      id: currentFolder.id!, name: currentFolder.name,
                      icon: currentFolder.icon, color: currentFolder.color,
                    },
                  ] : []}
                  onNavigate={(id) => setCurrentFolderId(id)}
                  onDropItems={isController ? (targetId, payload) => {
                    if (payload.folderId) void dropMoveFolder(payload.folderId, targetId);
                    else if (payload.docIds) void dropMoveDocs(payload.docIds, targetId);
                  } : undefined}
                />
              }
              back={currentFolderId
                ? { onClick: () => goUp(), label: `Up to ${upTo} (Backspace or Alt+Up)` }
                : { href: "/documents", label: "Back to all libraries" }}
              title={answer}
              sub={answerSub}
              facts={answerFacts}
              tools={libTools}
              primary={uploadPrimary}
            >
              {/* Search everything: results stay on this page. */}
              <form className="relative" role="search" onSubmit={(e) => e.preventDefault()}>
                <Search className={bandInputIcon} />
                <input
                  value={find}
                  onChange={(e) => setFind(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Escape") setFind(""); }}
                  placeholder="Number, title or tag (E-22)"
                  title="Number, title, equipment tag (E-22) or words inside"
                  aria-label="Search documents and equipment"
                  data-find-input
                  className={`${bandInput} !pr-11 max-sm:text-base`}
                />
                {find && (
                  <button type="button" onClick={() => setFind("")} title="Clear the search" aria-label="Clear the search"
                    className="absolute right-1 top-1/2 -translate-y-1/2 w-8 h-8 grid place-items-center rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                    <X className="w-4 h-4" />
                  </button>
                )}
              </form>
              {/* Messages used to be set and never shown while the library was
                  open: failed deletes and partial uploads looked like "nothing
                  happened". They read on the band, right under the search. */}
              {(error || notice) && (
                <div className="mt-3 space-y-1.5">
                  {error && (
                    <div role="alert" className="text-[14px] font-semibold text-[var(--state-overdue)] flex items-start gap-2">
                      <span className="flex-1 min-w-0">{error}</span>
                      <button onClick={() => setError(null)} className="shrink-0 p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)]" aria-label="Dismiss"><X className="w-3.5 h-3.5" /></button>
                    </div>
                  )}
                  {notice && (
                    <div role="status" className="text-[14px] text-[var(--color-text)] flex items-start gap-2">
                      <Check className="w-4 h-4 mt-0.5 shrink-0 text-[var(--state-released)]" />
                      <span className="flex-1 min-w-0">{notice}</span>
                      <button onClick={() => setNotice(null)} className="shrink-0 p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)]" aria-label="Dismiss"><X className="w-3.5 h-3.5" /></button>
                    </div>
                  )}
                </div>
              )}
            </PageHero>

            <PageBody>
            {findOn && activeOrgId && (
              <Card
                label={<>Search: “{find.trim()}”</>}
                action={
                  <button type="button" onClick={() => setFind("")}
                    className="shrink-0 h-8 px-3 rounded-lg border border-[var(--color-border-strong)] text-[13px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                    Back to {currentFolder?.name ?? library.name}
                  </button>
                }
              >
                <FindPanel orgId={activeOrgId} f={finder} unit={folderUnitCode}
                  onSearchAsset={searchAsset} onUnit={(code) => void openUnitFolder(code)}
                  onOpenFolder={(fo) => {
                    setFind("");
                    if (fo.libraryId === libraryId) setCurrentFolderId(fo.id);
                    else router.push(`/documents/${fo.libraryId}?folderId=${fo.id}`);
                  }}
                  onOpenHref={(href) => router.push(href)} />
              </Card>
            )}
            <div className={findOn ? "hidden" : "contents"}>

            {/* Files dropped anywhere on the folders, map or list upload here. */}
            <div
              {...fileDrag.bind}
              className={`relative flex flex-col gap-4 rounded-lg transition-shadow ${fileDrag.ring}`}
            >
              {fileDrag.over && (
                // Lit up while files are over it, saying what letting go does.
                // The line rides in view however long the list below is.
                <div className="absolute inset-0 z-[35] rounded-lg bg-[color-mix(in_srgb,var(--color-surface)_82%,transparent)] pointer-events-none" aria-live="polite">
                  <div className="sticky top-[38vh] flex flex-col items-center text-center px-4 py-8">
                    <UploadCloud className="w-8 h-8 text-[var(--color-text-muted)] mb-2" />
                    <p className="text-[15px] font-bold text-[var(--color-text)]">
                      {fileDrag.say} to {currentFolder ? `"${currentFolder.name}"` : "this library"}
                    </p>
                    <p className="text-[13px] text-[var(--color-text-muted)] mt-1">A dropped folder keeps its subfolders.</p>
                  </div>
                </div>
              )}

              {/* FOLDERS: a compact table, one row per folder with its counts. */}
              {filteredFolders.length > 0 && (
                <nav aria-labelledby="lib-folders-h">
                  <h2 id="lib-folders-h" className="flex items-center gap-2.5 font-display text-[19px] leading-tight font-semibold text-[var(--color-heading)] mb-2.5">
                    <span className="ui-icon-tile is-sm is-solid" aria-hidden><FolderIcon className="w-4 h-4" /></span>
                    Folders
                    <span className="ui-count is-solid font-sans">{filteredFolders.length.toLocaleString()}</span>
                  </h2>
                  <FolderGrid
                    layout="list"
                    folders={filteredFolders}
                    allFolders={folders}
                    docTotals={folderCounts?.totals}
                    onOpen={(id) => setCurrentFolderId(id)}
                    onRename={isController ? (id) => { setFolderErr(null); setRenameFolderId(id); setRenameValue(folderMap.get(id)?.name || ""); } : undefined}
                    onMove={isController ? (id) => { setRenameFolderId(id); setShowMoveModal(true); } : undefined}
                    onPermissions={isController ? (id) => { setRenameFolderId(id); setShowPermissions(true); } : undefined}
                    onCustomize={isController ? (id) => { setCustomizeFolderId(id); } : undefined}
                    onReviewCycle={isController ? (id) => setReviewPolicyTarget({ level: "collection", id, name: folderMap.get(id)?.name }) : undefined}
                    onAckPolicy={isController ? (id) => setAckPolicyTarget({ level: "collection", id, name: folderMap.get(id)?.name }) : undefined}
                    onReviewControl={isController ? (id) => setReviewControlTarget({ level: "collection", id, name: folderMap.get(id)?.name }) : undefined}
                    onRetention={isController ? (id) => setRetentionTarget({ level: "collection", id, name: folderMap.get(id)?.name }) : undefined}
                    onMoveInto={isController ? (dragId, targetId) => void dropMoveFolder(dragId, targetId) : undefined}
                    onMoveManyInto={isController ? (ids, targetId) => void dropMoveFolders(ids, targetId) : undefined}
                    onDocsDrop={isController ? (docIds, folderId) => void dropMoveDocs(docIds, folderId) : undefined}
                    onReorder={isController ? (dragId, targetId, pos) => void dropReorderFolder(dragId, targetId, pos) : undefined}
                    onDelete={isController ? (id) => handleDeleteFolder(id) : undefined}
                    isController={isController}
                    selectedIds={selectedFolderIds}
                    onTileSelect={handleFolderTileSelect}
                  />
                </nav>
              )}

              <WatchdogBanner suggestions={watchdog} busyId={watchdogBusy} onLink={watchdogLink} onDismiss={watchdogDismiss} onClose={() => setWatchdog([])} />
              {currentFolderId && activeOrgId && <AlsoFiledHere orgId={activeOrgId} folderId={currentFolderId} />}

              {/* Curated collections + favorites */}
              {library && activeOrgId && uid && (
                <div className="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] overflow-hidden empty:hidden">
                <FavoritesStrip
                  orgId={activeOrgId}
                  userId={uid}
                  libraryDocs={documents.map((d) => ({
                    id: d.id!,
                    documentNumber: d.documentNumber || "",
                    title: d.title || d.name || "",
                    rev: d.rev,
                    status: d.status,
                    sheetNumber: d.sheetNumber ?? null,
                  }))}
                  onOpenDoc={(id) => {
                    const doc = documents.find((d) => d.id === id);
                    if (doc) setSelectedDoc(doc);
                  }}
                />
                <CollectionsStrip
                  createSignal={newCollection}
                  orgId={activeOrgId}
                  libraryId={libraryId}
                  userId={uid}
                  userRole={activeRole}
                  folderId={currentFolderId}
                  folderName={currentFolder?.name ?? null}
                  folders={folders}
                  libraryDocs={documents.map((d) => ({
                    id: d.id!,
                    documentNumber: d.documentNumber || "",
                    title: d.title || d.name || "",
                    rev: d.rev,
                    status: d.status,
                    sheetNumber: d.sheetNumber ?? null,
                  }))}
                  onOpenAsBook={(docIds, collectionId) => {
                    // Look up each doc id in the loaded document list and
                    // stage them in the same order the collection defined.
                    const ordered = docIds
                      .map((id) => documents.find((d) => d.id === id))
                      .filter(Boolean) as DocumentRecord[];
                    if (ordered.length === 0) return;
                    setStagedDocs(ordered);
                    // Record the curated-collection id so the URL becomes a
                    // shareable ?book=<id>; mark it handled so the reader doesn't
                    // redundantly re-fetch the same book we just opened.
                    if (collectionId) handledBookLink.current = collectionId;
                    setOpenBookId(collectionId ?? null);
                    setShowMultiView(true);
                  }}
                />
                </div>
              )}

            {/* HERO HEADER (library root or folder; only when customized) */}
            {pageHeader && <PageHeader header={pageHeader} />}

            {/* (The "columns are library-wide" hint lived here; Manage columns
                in the ⋯ menu is the one home for columns now.) */}

            {/* CUSTOMIZABLE HOME — library root OR folder; opt-in, default off */}
            {!currentFolderId && library && (
              <LibraryHomeBoard
                openSignal={homeAsk}
                node={{ name: library.name, description: library.description, icon: library.icon, homeConfig: library.homeConfig }}
                folders={folders.filter((f) => !f.parentId)}
                documents={documents}
                canEdit={isController}
                onOpenFolder={(id) => setCurrentFolderId(id)}
                onOpenDoc={(doc) => setSelectedDoc(doc)}
                onSave={async (cfg) => {
                  const { error: homeErr } = await supabase.from("libraries").update({ home_config: cfg, updated_by: uid }).eq("id", library.id!);
                  if (homeErr) throw new Error(homeErr.message);
                  setLibrary((prev) => (prev ? { ...prev, homeConfig: cfg } : prev));
                }}
              />
            )}
            {currentFolderId && currentFolder && (
              <LibraryHomeBoard
                key={currentFolderId}
                openSignal={homeAsk}
                node={{ name: currentFolder.name, description: currentFolder.description, icon: currentFolder.icon, homeConfig: currentFolder.homeConfig }}
                folders={folders.filter((f) => f.parentId === currentFolderId)}
                documents={documents.filter((d) => d.collectionId === currentFolderId)}
                canEdit={isController}
                onOpenFolder={(id) => setCurrentFolderId(id)}
                onOpenDoc={(doc) => setSelectedDoc(doc)}
                onSave={async (cfg) => {
                  await updateCollectionHomeConfig(currentFolderId, cfg);
                  setFolders((prev) => prev.map((fc) => fc.id === currentFolderId ? { ...fc, homeConfig: cfg } : fc));
                }}
              />
            )}


              {/* THE MAP: the unit this folder is in, its equipment by type,
                  and each one's documents. Opened from the list's toolbar. */}
              {activeOrgId && mapOpen && (
                <Card
                  label={<>Map <span className="font-sans text-[14px] font-normal text-[var(--color-text-muted)]">{mapFolder.name}, its files and the equipment on each</span></>}
                  action={
                    <button type="button" onClick={() => setMapOpen(() => false)} className={heroQuiet}>
                      <X className="w-4 h-4" /> Hide map
                    </button>
                  }
                >
                  {/* The map follows the list: this folder, its files, the
                      equipment on each. A file opens right here, full
                      size; closing it leaves the folder as it was. */}
                  <FindMap orgId={activeOrgId} unit={folderUnitCode} assetId={null} className="h-[340px]"
                    folder={mapFolder} onFolder={(id) => setCurrentFolderId(id)}
                    onUnit={(code) => void openUnitFolder(code)} onPickAsset={searchAsset}
                    onDoc={(d) => {
                      const hit = documents.find((x) => x.id === d.id);
                      if (hit) { setSelectedDoc(hit); setShowFullScreen(true); } else setPeekDocId(d.id);
                    }} />
                </Card>
              )}

            {/* THE LIST: its heading and tools on the panel, the table on one
                white sheet. */}
            <section aria-labelledby="lib-docs-h" className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-2 mb-2.5 min-h-9">
                <h2 id="lib-docs-h" className="flex items-center gap-2.5 min-w-0 mr-auto">
                  <span className="ui-icon-tile is-sm is-solid" aria-hidden><FileText className="w-4 h-4" /></span>
                  <span className="font-display text-[19px] leading-tight font-semibold text-[var(--color-heading)]">{noun.many === "documents" ? "Documents" : library.name}</span>
                  <span className="text-[14px] text-[var(--color-text-muted)] tabular-nums"
                    title="Documents filed directly in this folder"><span className="ui-count is-solid">{filteredDocs.length.toLocaleString()}</span> here</span>
                  {folderCounts && (() => {
                    const below = currentFolderId ? folderCounts.totals.get(currentFolderId) ?? 0 : folderCounts.libraryTotal;
                    return below > (folderCounts.direct.get(currentFolderId ?? null) ?? 0) && below !== filteredDocs.length ? (
                      <span className="max-sm:hidden text-[14px] text-[var(--color-text-muted)] tabular-nums"
                        title={currentFolderId ? "Everything in this folder, including all subfolders" : "Every document in this library"}>
                        {below.toLocaleString()} {currentFolderId ? "with subfolders" : "in library"}
                      </span>
                    ) : null;
                  })()}
                </h2>

                {loadingUpload && (
                  <div className="flex items-center gap-1.5 text-[13px] text-[var(--color-text-muted)]">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    {uploadProgress
                      ? `Uploading ${uploadProgress.done} of ${uploadProgress.total}…`
                      : "Preparing upload…"}
                  </div>
                )}

                {/* Live filter: typing instantly narrows the table to the
                    matching files. Matches the number, title, sheet, rev,
                    status and any custom column value. */}
                <div className="relative max-sm:order-last max-sm:basis-full sm:w-72">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-faint)] pointer-events-none" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Filter this folder"
                    aria-label="Filter this folder by number, title, sheet or any field"
                    title="Number, title, sheet or any field"
                    className="w-full h-9 pl-9 pr-8 text-base sm:text-[14px] rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] outline-none focus:border-[var(--color-main)] focus:ring-2 focus:ring-[var(--color-accent-ring)]/40"
                  />
                  {search && (
                    <button
                      onClick={() => setSearch("")}
                      title="Clear filter"
                      aria-label="Clear filter"
                      className="absolute right-1 top-1/2 -translate-y-1/2 w-7 h-7 grid place-items-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {/* Layout switcher: Details / List / Grid / Thumbnails.
                    Same selection, same gestures, different geometry. */}
                <div className={`${bandSeg} max-md:!hidden`} role="group" aria-label="Layout">
                  {([
                    { key: "details" as ExplorerLayout, icon: <TableIcon className="w-4 h-4" />, label: "Details" },
                    { key: "list" as ExplorerLayout, icon: <ListIcon className="w-4 h-4" />, label: "List" },
                    { key: "grid" as ExplorerLayout, icon: <LayoutGrid className="w-4 h-4" />, label: "Grid" },
                    { key: "thumbs" as ExplorerLayout, icon: <ImageIcon className="w-4 h-4" />, label: "Thumbnails" },
                  ]).map((opt) => (
                    <button
                      key={opt.key}
                      onClick={() => setDocLayout(opt.key)}
                      title={opt.label}
                      aria-label={opt.label}
                      aria-pressed={docLayout === opt.key}
                      className={`${bandSegItem(docLayout === opt.key)} !px-2`}
                    >
                      {opt.icon}
                    </button>
                  ))}
                </div>
                    {/* View defaults — save the current presentation (layout +
                        sort + columns + density) for THIS library/folder.
                        Everyone can save a personal default; controllers can
                        also publish the org-wide default everyone inherits. */}
                    <div className="relative">
                      <button
                        onClick={() => setViewMenuOpen((v) => !v)}
                        title="View defaults for this folder"
                        aria-haspopup="menu"
                        aria-expanded={viewMenuOpen}
                        aria-label="View defaults for this folder"
                        className={`${heroQuiet} ${viewMenuOpen ? "!bg-[var(--color-surface-2)]" : ""}`}
                      >
                        {savingSortDefault ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-4 h-4" />}
                        <span className="hidden lg:inline">View</span>
                        <ChevronDown className="w-3.5 h-3.5" />
                      </button>
                      {viewMenuOpen && (
                        <>
                          <div className="fixed inset-0 z-40" onClick={() => setViewMenuOpen(false)} />
                          <div className="absolute right-0 top-full mt-1.5 z-50 w-72 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl shadow-xl py-2">
                            <div className="px-3 pb-2 border-b border-[var(--color-border)]">
                              <div className="text-[13px] font-semibold text-[var(--color-text)]">
                                {currentFolder ? `Folder: ${currentFolder.name}` : `Library: ${library?.name ?? ""}`}
                              </div>
                              <div className="text-[13px] text-[var(--color-text-muted)] mt-0.5 leading-snug">
                                Current: {docLayout === "details" ? "Details" : docLayout === "list" ? "List" : docLayout === "grid" ? "Grid" : "Thumbnails"} · sorted by {sortLabelFor(sortKey)} ({sortDir === "asc" ? "ascending" : "descending"})
                                {isFolderDefaultSort ? " · saved default sort" : ""}
                              </div>
                            </div>
                            <button
                              onClick={() => { setViewMenuOpen(false); void saveViewDefault("user"); }}
                              className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-[13px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
                            >
                              <Pin className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                              <span className="flex-1">
                                Set as <b>my</b> default here
                                <span className="block text-[13px] font-normal text-[var(--color-text-muted)]">Only you: wins over the org default</span>
                              </span>
                              {viewDefaults.hasUserRow && <Check className="w-3.5 h-3.5 text-[var(--state-released)]" />}
                            </button>
                            {isController && (
                              <button
                                onClick={() => { setViewMenuOpen(false); void saveViewDefault("org"); }}
                                className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-[13px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
                              >
                                <Shield className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                                <span className="flex-1">
                                  Set as <b>org-wide</b> default here
                                  <span className="block text-[13px] font-normal text-[var(--color-text-muted)]">Everyone opens this folder like this</span>
                                </span>
                                {viewDefaults.hasOrgRow && <Check className="w-3.5 h-3.5 text-[var(--state-released)]" />}
                              </button>
                            )}
                            {viewDefaults.hasUserRow && (
                              <button
                                onClick={() => { setViewMenuOpen(false); void clearMyViewDefault(); }}
                                className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-[13px] font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"
                              >
                                <X className="w-3.5 h-3.5" />
                                <span className="flex-1">
                                  Clear my default (use org&apos;s)
                                  <span className="block text-[13px] font-normal">Removes your saved layout, sort AND column setup here</span>
                                </span>
                              </button>
                            )}
                            {/* Columns: where this folder's come from, and the
                                choice of this folder or every folder. */}
                            <div className="mt-1.5 pt-2 border-t border-[var(--color-border)]">
                              <div className="px-3 pb-1 text-[13px] font-semibold text-[var(--color-text)]">Columns</div>
                              <div className="px-3 pb-1.5 text-[13px] text-[var(--color-text-muted)] leading-snug">
                                {columnSource === "user" ? "This folder has your own columns."
                                  : columnSource === "org" ? "This folder has its own columns."
                                  : columnSource === "library" ? "This folder uses the library's columns."
                                  : "Standard columns. The library has no columns of its own yet."}
                              </div>
                              <button
                                onClick={() => { setViewMenuOpen(false); setShowColumnManager(true); }}
                                className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-[13px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
                              >
                                <Columns className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                                <span className="flex-1">
                                  Choose and order columns
                                  <span className="block text-[13px] font-normal text-[var(--color-text-muted)]">Show, hide and move them up or down</span>
                                </span>
                              </button>
                              {isController && (
                                <button
                                  onClick={() => { setViewMenuOpen(false); void applyColumnsToLibrary(activeColumns); }}
                                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-[13px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
                                >
                                  <LibraryIcon className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                                  <span className="flex-1">
                                    Use these for every folder in this library
                                    <span className="block text-[13px] font-normal text-[var(--color-text-muted)]">Everyone in your org, in every folder without its own columns</span>
                                  </span>
                                  {columnSource === "library" && <Check className="w-3.5 h-3.5 text-[var(--state-released)]" />}
                                </button>
                              )}
                              {canUseLibraryColumns && (
                                <button
                                  onClick={() => { setViewMenuOpen(false); void followLibraryColumns(); }}
                                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-[13px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
                                >
                                  <RotateCcw className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                                  <span className="flex-1">
                                    Use the library&apos;s columns here
                                    <span className="block text-[13px] font-normal text-[var(--color-text-muted)]">{isController && colLevels.folder ? "Drops this folder's own columns for everyone" : "Drops your own columns in this folder"}</span>
                                  </span>
                                </button>
                              )}
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  {activeOrgId && (
                    <button type="button" onClick={() => setMapOpen((v) => !v)} aria-expanded={mapOpen}
                      className={`${heroQuiet} ${mapOpen ? "!bg-[var(--color-surface-2)]" : ""}`}
                      title={`Map: ${mapFolder.name}, its files and the equipment on each`}>
                      <MapIcon className="w-4 h-4" />
                      <span className="max-sm:hidden">{mapOpen ? "Hide map" : "Map"}</span>
                    </button>
                  )}
              </div>

            {/* This folder's columns differ from the library's: say so, with
                the way back. */}
            {docLayout === "details" && canUseLibraryColumns && (
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 mb-2 text-[13px] text-[var(--color-text-muted)]">
                <Columns className="w-3.5 h-3.5 text-[var(--color-text-faint)]" aria-hidden />
                <span>{columnSource === "user" ? "You have your own columns in this folder" : "This folder has its own columns"}</span>
                <span aria-hidden>·</span>
                <button type="button" onClick={() => void followLibraryColumns()}
                  className="font-semibold text-[var(--color-accent-text)] underline-offset-2 hover:underline rounded focus-visible:outline-2">
                  Use the library&apos;s
                </button>
              </div>
            )}

            <div
              className="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] overflow-hidden flex flex-col min-h-[320px] relative focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-strong)]"
              tabIndex={0}
              onKeyDown={handleExplorerKeyDown}
              aria-label="Documents"
            >
              <div className="flex-1 flex flex-col">
                {/* Advisory: someone else has live edit work on a doc I'm
                    also editing (edit×edit only — views never trigger it). */}
                {activeOrgId && uid && (
                  <div className="px-4 pt-2 empty:hidden">
                    <EditOverlapBanner
                      orgId={activeOrgId}
                      currentUserId={uid}
                      currentUserName={userEmail?.split("@")[0] ?? null}
                    />
                  </div>
                )}
                {docStreamProgress !== null && (
                  <div className="px-4 py-1.5 bg-[var(--color-surface-2)] border-b border-[var(--color-border)] text-[13px] text-[var(--color-text)] flex items-center gap-2">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Loading the rest of this folder… <b>{docStreamProgress.toLocaleString()}</b> so far. Sorting covers everything once done.
                  </div>
                )}
                {docFetchHitCap && !loadingDocs && docStreamProgress === null && (
                  <div className="mx-4 mt-2 border-l-2 border-[var(--state-held)] pl-3 py-0.5 text-[13px] text-[var(--state-held)]">
                    Showing the first <b>10,000</b> documents, newest first. This folder holds more: filter or open a subfolder to narrow it.
                  </div>
                )}
                {!loadingDocs && filteredDocs.length === 0 && filteredFolders.length === 0 ? (
                  /* INTERACTIVE EMPTY STATE */
                  <div className="flex-1 flex flex-col items-center justify-center p-12">
                    <UploadCloud className="w-8 h-8 text-[var(--color-text-faint)] mb-3" />
                    <h3 className="text-[14px] font-bold text-[var(--color-text)] mb-1">Nothing here yet</h3>
                    {/* Upload (top right) is the one home for adding files. */}
                    <p className="text-sm text-[var(--color-text-muted)] text-center max-w-xs">
                      Drop files or a folder here, or use Upload.
                    </p>
                  </div>
                ) : (
                  <>
                  {/* PHONE: stacked rows of the same docs. Line 1 the number and
                      its status, line 2 the title, rev and date. */}
                  <div className="md:hidden flex-1 divide-y divide-[var(--color-border)]">
                    {loadingDocs && sortedDocs.length === 0 ? (
                      <LoadingBlock what="documents" />
                    ) : sortedDocs.length === 0 ? (
                      <div className="text-center text-[14px] text-[var(--color-text-muted)] py-8">No documents match.</div>
                    ) : sortedDocs.map((doc) => {
                      const out = isDocumentCheckedOut(doc);
                      const showTitle = !!doc.title && !!doc.documentNumber && doc.title !== doc.documentNumber;
                      // Its equipment, as pills you can tap (photos); three, then "+N".
                      const tags = columnDefs
                        .filter((d) => d && (d.type === "tags" || d.isPill))
                        .flatMap((d) => {
                          const v = (doc.metadata ?? {})[d.key];
                          const list = Array.isArray(v) ? v.map(String) : v ? String(v).split(",").map((x) => x.trim()).filter(Boolean) : [];
                          return list.map((tag) => ({ tag, label: d.pillGroupLabel || d.label || "Equipment" }));
                        });
                      const isOpen = selectedDoc?.id === doc.id;
                      return (
                        <div key={doc.id} className={`relative ${isOpen ? "bg-[var(--color-accent-soft)]" : ""}`}>
                          {isOpen && <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--color-main)]" />}
                          <button
                            onClick={() => setSelectedDoc(doc)}
                            className={`w-full text-left px-4 pt-3 ${tags.length ? "pb-1.5" : "pb-3"} active:bg-[var(--color-surface-2)] hover:bg-[var(--color-surface-2)] block`}
                          >
                            <span className="flex items-center gap-3">
                              <span className="ui-id flex-1 min-w-0 truncate text-[17px] leading-snug">{doc.documentNumber || doc.title || doc.name || "-"}</span>
                              {doc.status && <StatusTag status={doc.status} className="shrink-0" />}
                            </span>
                            <span className="mt-0.5 flex items-center gap-x-3 text-[13px] text-[var(--color-text-muted)] min-w-0">
                              {showTitle && <span className="truncate min-w-0">{doc.title}</span>}
                              <span className="shrink-0">Rev <span className="font-display tabular-nums font-semibold text-[var(--color-text)]">{doc.rev || "-"}</span></span>
                              {out
                                ? <span className="shrink-0 font-semibold text-[var(--state-held)] truncate">Checked out{doc.checkedOutBy === uid ? " by you" : doc.checkedOutByName ? ` by ${doc.checkedOutByName}` : ""}</span>
                                : <span className="shrink-0">{humanDate(doc.updatedAt)}</span>}
                            </span>
                          </button>
                          {tags.length > 0 && (
                            <div className="px-4 pb-3 flex flex-wrap items-center gap-1">
                              {tags.slice(0, tags.length > 3 ? 2 : 3).map((t) => (
                                <AssetTagChip key={`${t.label}-${t.tag}`} tag={t.tag} type={t.label}
                                  orgId={activeOrgId ?? undefined} userId={uid ?? undefined}
                                  canManage={["Admin", "Manager", "Supervisor"].includes(activeRole) || activeRole.includes("Engineer") || activeRole === "Drafter"} />
                              ))}
                              {tags.length > 3 && (
                                <button type="button" onClick={() => setSelectedDoc(doc)} className="ui-tag is-more tabular-nums"
                                  aria-label={`${tags.length - 2} more equipment on ${doc.documentNumber || "this document"}: open it`}>
                                  +{tags.length - 2}
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {/* DESKTOP — Details table, or the List/Grid/Thumbnails
                      layouts. Same docs, same selection, same gestures. */}
                  {docLayout !== "details" ? (
                    <div
                      data-doc-marquee
                      className="flex-1 overflow-y-auto hidden md:block"
                      onClick={(e) => { if (e.target === e.currentTarget) clearSelection(); }}
                      onMouseDown={handleMarqueeMouseDown}
                    >
                      <DocGridView
                        docs={sortedDocs}
                        layout={docLayout === "list" ? "list" : docLayout === "grid" ? "grid" : "thumbs"}
                        selectedIds={selectedDocIds}
                        dimmedIds={cutDocIds}
                        focusedId={selFocusId}
                        draggable={isController}
                        onItemClick={(id, e) => {
                          const d = sortedDocs.find((x) => x.id === id);
                          if (d) handleRowClick(d, e);
                        }}
                        onItemDoubleClick={handleRowDoubleClick}
                        onItemContextMenu={handleRowContextMenu}
                        onItemDragStart={handleDocDragStart}
                        onBackgroundClick={clearSelection}
                      />
                    </div>
                  ) : (
                  <div className="relative flex-1 hidden md:block min-w-0">
                  {tableMoreRight && (
                    <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 z-[5] w-16 bg-gradient-to-l from-[var(--color-surface)] to-transparent" />
                  )}
                  <div
                    ref={setTableScrollEl}
                    data-doc-marquee
                    className="h-full overflow-x-auto"
                    onClick={(e) => { if (e.target === e.currentTarget) clearSelection(); }}
                    onMouseDown={handleMarqueeMouseDown}
                  >
                    <table className="w-full text-left text-[14px] table-fixed" style={{ minWidth: tableMinWidth }}>
                      <thead className="bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)] font-semibold">
                        <tr>
                          <th className={`px-3 ${headerPad}`} style={{ width: "36px" }}>
                            <input
                              type="checkbox"
                              checked={allSelected}
                              ref={(el) => { if (el) el.indeterminate = someSelected; }}
                              onChange={toggleSelectAll}
                              className="w-3.5 h-3.5 rounded accent-[var(--color-main)] cursor-pointer"
                            />
                          </th>
                          {activeColumns.map((colKey) => <React.Fragment key={colKey}>{((): React.ReactNode => {
                            const label = columnLabel(colKey);
                            const width = getColWidth(colKey);
                            const isResized = !!colWidths[colKey];
                            const isDragged = columnDrag.draggingKey === colKey;
                            return (
                              <th
                                key={colKey}
                                ref={columnDrag.register(colKey)}
                                className={`relative pl-3 pr-2 ${headerPad} cursor-pointer select-none [-webkit-user-select:none] hover:bg-[var(--color-surface-2)] transition-colors group/th ${isDragged ? "opacity-40" : ""}`}
                                // The title takes whatever width is left, unless it was resized.
                                style={width && !(colKey === "title" && !isResized) ? { width } : undefined}
                                // Press and move to drag the column to the line; a plain click sorts.
                                onPointerDown={columnDrag.onPointerDown(colKey)}
                                onDragStart={(e) => e.preventDefault()}
                                onClick={() => { if (!columnDrag.consumeClick() && !resizeClickGuardRef.current) handleSort(colKey); }}
                                title={`${label}: click to sort, drag to move`}
                                aria-sort={sortKey === colKey ? (sortDir === "asc" ? "ascending" : "descending") : undefined}
                              >
                                {/* The grip: shows on hover (always on a touchscreen, where
                                    it's the one place a drag starts). */}
                                <span data-col-grip aria-hidden
                                  className="absolute left-0 inset-y-0 w-3 grid place-items-center cursor-grab text-[var(--color-text-faint)] opacity-0 group-hover/th:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity"
                                  style={{ touchAction: "none" }}>
                                  <GripVertical className="w-3 h-3.5" />
                                </span>
                                <div className="flex items-center gap-1 min-w-0 pr-1.5">
                                  <span className="truncate flex-1">{label}</span>
                                  {sortKey === colKey ? (
                                    sortDir === "asc"
                                      ? <ChevronUp className="w-3 h-3 text-[var(--color-text-muted)] shrink-0" />
                                      : <ChevronDown className="w-3 h-3 text-[var(--color-text-muted)] shrink-0" />
                                  ) : (
                                    <ArrowUpDown className="w-3 h-3 text-[var(--color-text-faint)] opacity-0 group-hover/th:opacity-100 shrink-0" />
                                  )}
                                </div>

                                {/* Right-edge resize handle — admin/DocCtrl only.
                                    Always-visible vertical bar with a wide hit zone. Brightens on hover. */}
                                {isController && (
                                  <div
                                    data-col-resize
                                    onPointerDown={(e) => handleResizeStart(e, colKey)}
                                    onDoubleClick={(e) => handleResizeReset(e, colKey)}
                                    onClick={(e) => e.stopPropagation()}
                                    title={isResized ? "Drag to resize · double-click to reset" : "Drag to resize column"}
                                    style={{ touchAction: "none" }}
                                    className="absolute top-0 right-0 h-full w-2.5 cursor-col-resize flex items-center justify-center group/grip z-10"
                                  >
                                    <div className={`h-1/2 w-[2px] rounded-full transition-colors ${
                                      isResized ? "bg-[var(--color-border-strong)]" : "bg-[var(--color-border)] group-hover/th:bg-[var(--color-border-strong)] group-hover/grip:bg-[var(--color-text-muted)]"
                                    }`} />
                                  </div>
                                )}
                              </th>
                            );
                          })()}{colKey === checkoutAfterKey && checkoutTh}</React.Fragment>)}
                          {!checkoutAfterKey && checkoutTh}
                          <th className={`px-2 ${headerPad} text-center`} style={{ width: "36px" }} title="Reference stack">
                            <Layers className="w-3.5 h-3.5 inline text-[var(--color-text-faint)]" aria-label="Reference stack" />
                          </th>
                          <th className={`px-2 ${headerPad} text-center print:hidden`} style={{ width: "44px" }}>
                            <ColumnHeaderMenu onAdd={handleAddColumnClick} isController={isController} />
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--color-border)]">
                        {loadingDocs ? (
                          <tr>
                            <td colSpan={activeColumns.length + 5} className="px-6 py-12 text-center text-[var(--color-text-muted)]">
                              <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />Loading documents…
                            </td>
                          </tr>
                        ) : sortedDocs.length === 0 ? (
                          <tr>
                            <td colSpan={activeColumns.length + 5} className="px-6 py-10 text-center text-[var(--color-text-muted)] text-[14px]">
                              No documents match your search.
                            </td>
                          </tr>
                        ) : (
                          sortedDocs.map((docRecord) => {
                            const isRowSelected = selectedDocIds.has(docRecord.id!);
                            const isFocused = selectedDoc?.id === docRecord.id;
                            // Keyboard focus (ctrl+arrows travel without
                            // selecting) — must be VISIBLE or ctrl+space
                            // toggles a row the user can't identify.
                            const isKeyFocused = selFocusId === docRecord.id;
                            const checkoutTd = (
                              <td className={`px-3 ${rowPad}`}>
                                <CheckoutStatusCell
                                  quiet
                                  docRecord={docRecord}
                                  currentUserId={uid ?? undefined}
                                  currentUserEmail={userEmail ?? undefined}
                                  userRole={activeRole}
                                  onCheckout={openCheckout}
                                />
                              </td>
                            );
                            return (
                              <tr
                                key={docRecord.id}
                                data-doc-item={docRecord.id}
                                draggable={isController}
                                onDragStart={(e) => handleDocDragStart(docRecord, e)}
                                onClick={(e) => handleRowClick(docRecord, e)}
                                onDoubleClick={() => handleRowDoubleClick(docRecord)}
                                onContextMenu={(e) => handleRowContextMenu(docRecord, e)}
                                className={`group cursor-pointer transition-colors relative ${
                                  isRowSelected || isFocused
                                    ? "bg-[var(--color-accent-soft)]"
                                    : "hover:bg-[var(--color-surface-2)]"
                                } ${isKeyFocused ? "outline outline-1 -outline-offset-1 outline-[var(--color-border-strong)]" : ""} ${cutDocIds.has(docRecord.id!) ? "opacity-50" : ""}`}
                              >
                                <td className={`relative px-3 ${rowPad}`} onClick={(e) => toggleSelectDoc(docRecord.id!, e)}>
                                  {/* Left edge on the selected row (inside the cell, so it
                                      never takes a column of its own). */}
                                  {(isRowSelected || isFocused) && (
                                    <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--color-main)]" />
                                  )}
                                  <input
                                    type="checkbox"
                                    checked={isRowSelected}
                                    onChange={() => {}}
                                    className="w-3.5 h-3.5 rounded accent-[var(--color-main)] cursor-pointer"
                                  />
                                </td>
                                {activeColumns.map((colKey) => <React.Fragment key={colKey}>{((): React.ReactNode => {
                                  const def = columnMap.get(colKey);
                                  const isPillCol = def && (def.type === "tags" || def.isPill);

                                  if (isPillCol) {
                                    const rawVal = (docRecord.metadata ?? {})[colKey];
                                    const list = Array.isArray(rawVal)
                                      ? rawVal
                                      : rawVal
                                      ? String(rawVal).split(",").map((v) => v.trim()).filter(Boolean)
                                      : [];
                                    return (
                                      <td key={colKey} className={`px-3 ${rowPad} align-middle`}>
                                        <PillCell
                                          values={list}
                                          highlight={deferredSearch}
                                          label={def.pillGroupLabel || def.label || "Equipment"}
                                          canEdit={isController || (activeRole !== "Viewer" && activeRole !== "Auditor")}
                                          orgId={activeOrgId ?? undefined}
                                          userId={uid ?? undefined}
                                          canManageAssets={["Admin", "Manager", "Supervisor"].includes(activeRole) || activeRole.includes("Engineer") || activeRole === "Drafter"}
                                          onSave={async (newVals) => {
                                            const newMeta = { ...(docRecord.metadata ?? {}), [colKey]: newVals };
                                            // Optimistic local update so the chip
                                            // doesn't revert on edit-exit before
                                            // the DB write lands.
                                            const oldMeta = docRecord.metadata;
                                            setDocuments((prev) => prev.map((d) =>
                                              d.id === docRecord.id ? { ...d, metadata: newMeta } : d
                                            ));
                                            const { error: pillErr } = await supabase.from("documents").update({
                                              metadata: newMeta,
                                              updated_at: new Date().toISOString(),
                                            }).eq("id", docRecord.id);
                                            if (pillErr) {
                                              // Put it back and say so: the cell must show what's saved.
                                              setDocuments((prev) => prev.map((d) => d.id === docRecord.id ? { ...d, metadata: oldMeta } : d));
                                              setError(`Couldn't save ${def.label || "that field"} on ${docRecord.documentNumber || docRecord.title || "the document"}: ${pillErr.message}`);
                                            }
                                          }}
                                        />
                                      </td>
                                    );
                                  }

                                  // Stacked Title cell — shows Doc Number underneath unless separate column exists
                                  if (colKey === "title") {
                                    const hasSeparateDocNum = activeColumns.includes("documentNumber");
                                    if (editingTitleId === docRecord.id) {
                                      return (
                                        <td key={colKey} className={`px-3 ${rowPad}`}>
                                          <div className="flex items-center gap-1">
                                            <input
                                              autoFocus
                                              value={editingTitleValue}
                                              onChange={(e) => setEditingTitleValue(e.target.value)}
                                              onClick={(e) => e.stopPropagation()}
                                              onKeyDown={(e) => {
                                                e.stopPropagation();
                                                if (e.key === "Enter") void saveInlineTitle(docRecord.id!, editingTitleValue);
                                                else if (e.key === "Escape") { setEditingTitleId(null); setEditingTitleValue(""); }
                                              }}
                                              onBlur={() => { if (!savingTitle) void saveInlineTitle(docRecord.id!, editingTitleValue); }}
                                              disabled={savingTitle}
                                              className="w-full text-sm px-1.5 py-0.5 rounded border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent-ring)]"
                                            />
                                            {savingTitle && <Loader2 className="w-3 h-3 animate-spin text-[var(--color-text-muted)] shrink-0" />}
                                          </div>
                                        </td>
                                      );
                                    }
                                    return (
                                      <td key={colKey} className={`px-3 ${rowPad}`}>
                                        <div className="min-w-0">
                                          {!hasSeparateDocNum && docRecord.documentNumber && (
                                            <div className="ui-id text-[15px] truncate leading-tight">
                                              {docRecord.documentNumber}
                                            </div>
                                          )}
                                          <div className={`truncate leading-tight ${hasSeparateDocNum || !docRecord.documentNumber ? "text-[14px] text-[var(--color-text)]" : "text-[13px] text-[var(--color-text-muted)] mt-0.5"}`}>
                                            {docRecord.title || docRecord.name || "Untitled"}
                                          </div>
                                        </div>
                                      </td>
                                    );
                                  }

                                  // Status: a quiet tag, the dot carries the state.
                                  if (colKey === "status") {
                                    return (
                                      <td key={colKey} className={`px-3 ${rowPad}`}>
                                        <StatusTag status={docRecord.status || "-"} />
                                      </td>
                                    );
                                  }

                                  // Inline-editable doc number cell. Click to edit,
                                  // Enter to save, Esc to cancel. Recomputes
                                  // uniqueness_key on save so the DB stays consistent.
                                  if (colKey === "documentNumber") {
                                    const isEditing = editingDocNumId === docRecord.id;
                                    return (
                                      <td key={colKey} className={`px-3 ${rowPad}`}>
                                        {isEditing ? (
                                          <div className="flex items-center gap-1">
                                            <input
                                              autoFocus
                                              value={editingDocNumValue}
                                              onChange={(e) => { setEditingDocNumValue(e.target.value); setEditingDocNumError(null); }}
                                              onClick={(e) => e.stopPropagation()}
                                              onKeyDown={(e) => {
                                                e.stopPropagation();
                                                if (e.key === "Enter") { void saveInlineDocNumber(docRecord.id!, editingDocNumValue); }
                                                else if (e.key === "Escape") { setEditingDocNumId(null); setEditingDocNumValue(""); setEditingDocNumError(null); }
                                              }}
                                              onBlur={() => { if (!savingDocNum) void saveInlineDocNumber(docRecord.id!, editingDocNumValue); }}
                                              disabled={savingDocNum}
                                              aria-label="Document number"
                                              className={`w-full font-display text-[15px] font-semibold tabular-nums px-1.5 py-0.5 rounded border ${editingDocNumError ? "border-[var(--state-overdue)]" : "border-[var(--color-border-strong)]"} bg-[var(--color-surface)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-ring)]/40`}
                                            />
                                            {savingDocNum && <Loader2 className="w-3 h-3 animate-spin text-[var(--color-text-muted)] shrink-0" />}
                                          </div>
                                        ) : (
                                          <div className="flex items-center gap-1 min-w-0">
                                            {/* The number opens the document (the click is the row's). */}
                                            <button
                                              type="button"
                                              className="ui-id min-w-0 truncate text-left text-[15px] rounded focus-visible:outline-2"
                                              title={`Open ${docRecord.documentNumber || "this document"}`}
                                            >
                                              {docRecord.documentNumber || "-"}
                                            </button>
                                            <button
                                              type="button"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                setEditingDocNumId(docRecord.id!);
                                                setEditingDocNumValue(docRecord.documentNumber || "");
                                                setEditingDocNumError(null);
                                              }}
                                              className="shrink-0 w-7 h-7 grid place-items-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                                              title="Rename the number"
                                              aria-label={`Rename ${docRecord.documentNumber || "the number"}`}
                                            >
                                              <Pencil className="w-3.5 h-3.5" />
                                            </button>
                                          </div>
                                        )}
                                        {isEditing && editingDocNumError && (
                                          <div className="text-[13px] text-[var(--state-overdue)] mt-0.5 max-w-[20ch] leading-tight">{editingDocNumError}</div>
                                        )}
                                      </td>
                                    );
                                  }

                                  // Generic cell: truncate to prevent overflow. Revs read as identifiers.
                                  return (
                                    <td key={colKey} className={`px-3 ${rowPad} text-[var(--color-text)] text-[14px] truncate ${colKey === "rev" ? "font-display text-[15px] font-semibold tabular-nums" : ""}`}>
                                      <div className="truncate">{renderDocCell(docRecord, colKey)}</div>
                                    </td>
                                  );
                                })()}{colKey === checkoutAfterKey && checkoutTd}</React.Fragment>)}
                                {!checkoutAfterKey && checkoutTd}
                                <td className={`px-2 ${rowPad} text-center`}>
                                  {(() => {
                                    const isStaged = stagedDocs.some((d) => d.id === docRecord.id);
                                    return (
                                      <button
                                        onClick={(e) => handleStageDoc(docRecord, e)}
                                        className={`p-1 rounded-md transition-all ${
                                          isStaged
                                            ? "text-white bg-[var(--color-main)] opacity-100"
                                            : "text-[var(--color-text-faint)] group-hover:text-[var(--color-text-muted)] hover:!text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
                                        }`}
                                        title={isStaged ? "Remove from reference stack" : "Add to reference stack"}
                                        aria-label={isStaged ? "Remove from reference stack" : "Add to reference stack"}
                                        aria-pressed={isStaged}
                                      >
                                        <Layers className="w-3.5 h-3.5" />
                                      </button>
                                    );
                                  })()}
                                </td>
                                <td className={`px-2 ${rowPad} text-center`}>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); setSelectedDoc(docRecord); setShowMetadataEditor(true); }}
                                    className="text-[var(--color-text-faint)] group-hover:text-[var(--color-text-muted)] hover:!text-[var(--color-text)] p-1 rounded-md hover:bg-[var(--color-surface-2)] transition-colors"
                                    title="Edit metadata"
                                    aria-label="Edit metadata"
                                  >
                                    <FileText className="w-3.5 h-3.5" />
                                  </button>
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                  </div>
                  )}
                  </>
                )}
              </div>
            </div>
            </section>
            </div>

            </div>
            </PageBody>
          </div>
        </div>
      </div>

      {/* INSPECTOR DRAWER — overlays the table, never compresses it */}
      <InspectorDrawer
        isOpen={!!selectedDoc}
        onClose={() => setSelectedDoc(null)}
        title={(() => {
          // Where the document lives: library · folders.
          const f = selectedDoc?.collectionId ? folderMap.get(selectedDoc.collectionId) : null;
          return [library.name, ...(f ? [...(f.pathNames ?? []), f.name] : [])].filter(Boolean).join(" · ");
        })()}
      >
        {selectedDoc && (
          <InspectorPanel
            selectedDoc={selectedDoc}
            selectedVersion={selectedVersion}
            activeRole={activeRole}
            uid={uid || null}
            userEmail={userEmail || null}
            onClose={() => setSelectedDoc(null)}
            onMetadata={() => setShowMetadataEditor(true)}
            onHistory={() => setShowHistory(true)}
            onMove={() => setShowMoveDocModal(true)}
            onPermissions={() => setShowPermissions(true)}
            onDelete={confirmDeleteDoc}
            onCheckout={openCheckout}
            onForceUnlock={handleForceUnlock}
            onFullScreen={() => setShowFullScreen(true)}
            onToggleStage={(doc) => {
              setStagedDocs((prev) => {
                if (prev.some((d) => d.id === doc.id)) return prev.filter((d) => d.id !== doc.id);
                return [...prev, doc];
              });
            }}
            isStaged={stagedDocs.some((d) => d.id === selectedDoc.id)}
            orgId={activeOrgId ?? undefined}
            customColumns={library?.customColumns ?? []}
            onRevUp={() => setShowRevUp(true)}
            canPublish={canPublish}
            onSupersede={() => setShowSupersede(true)}
            onArchive={() => setShowArchive(true)}
            onRevertVersion={(v) => setRevertTarget(v)}
            versionHistoryRefreshKey={versionHistoryRefreshKey}
            onOpenVersion={(v) => {
              setSelectedVersion(v);
              setShowFullScreen(true);
            }}
            folderPath={(() => {
              const f = selectedDoc.collectionId ? folderMap.get(selectedDoc.collectionId) : null;
              if (!f) return library.name;
              const parts = [library.name, ...(f.pathNames ?? []), f.name].filter(Boolean);
              return parts.join(" / ");
            })()}
          />
        )}
      </InspectorDrawer>

      {/* A column header on the move: its ghost and the drop line. */}
      {columnDrag.overlay}

      {/* MARQUEE (rubber-band) selection rectangle */}
      {marquee && (
        <div
          className="fixed z-[85] border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] pointer-events-none rounded-sm"
          style={{ left: marquee.x1, top: marquee.y1, width: marquee.x2 - marquee.x1, height: marquee.y2 - marquee.y1 }}
        />
      )}

      {/* RIGHT-CLICK CONTEXT MENU on document rows/cards */}
      {ctxMenu && (
        <DocContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          entries={buildDocContextEntries(ctxMenu.doc)}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {/* (A floating "Select rows for bulk actions" pill sat here; the row
          checkboxes say it themselves, and nothing floats over the list.) */}

      {/* Folder selection bar — ctrl/shift-click tiles, then act on them all. */}
      {isController && selectedFolderIds.size > 0 && selectedDocIds.size === 0 && (
        <div className={`fixed left-1/2 -translate-x-1/2 z-40 ${stagedDocs.length > 0 ? "bottom-16" : "bottom-10"}`}>
          <div className="flex items-center gap-2 px-4 py-2.5 bg-slate-900/95 text-white rounded-lg shadow-2xl border border-slate-700/60"
            style={{ backdropFilter: "blur(20px) saturate(200%)" }}>
            <span className="text-[13px] font-bold">{selectedFolderIds.size} folder{selectedFolderIds.size === 1 ? "" : "s"} selected</span>
            <div className="h-4 w-px bg-slate-700 mx-1" />
            <button onClick={() => setSelectedFolderIds(new Set())}
              className="px-2.5 py-1 text-[13px] font-bold text-[var(--color-text-faint)] hover:text-white hover:bg-slate-700/60 rounded-lg transition-colors">
              Deselect
            </button>
            <button
              onClick={() => setDeleteFolders([...selectedFolderIds].map((x) => ({ id: x, name: folderMap.get(x)?.name ?? "Folder" })))}
              className="flex items-center gap-1.5 px-2.5 py-1 text-[13px] font-bold text-rose-300 hover:text-white hover:bg-[var(--state-overdue)]/80 rounded-lg transition-colors"
              title="Delete the selected folders (Delete key)">
              <Trash2 className="w-3 h-3" /> Delete…
            </button>
          </div>
        </div>
      )}

      {/* FLOATING BULK ACTION BAR — slides up from bottom when items selected */}
      <div
        className={`fixed left-1/2 -translate-x-1/2 z-40 transition-all duration-300 ${
          selectedDocIds.size > 0
            ? `opacity-100 ${stagedDocs.length > 0 ? "bottom-16" : "bottom-10"} pointer-events-auto`
            : "opacity-0 -bottom-20 pointer-events-none"
        }`}
        style={{ transitionTimingFunction: "cubic-bezier(0.34, 1.56, 0.64, 1)" }}
      >
        <div
          className="flex items-center gap-2 px-4 py-2.5 bg-slate-900/95 text-white rounded-lg shadow-2xl border border-slate-700/60"
          style={{ backdropFilter: "blur(20px) saturate(200%)" }}
        >
          <span className="text-[13px] font-bold">{selectedDocIds.size} selected</span>
          <div className="h-4 w-px bg-slate-700 mx-1" />
          <button
            onClick={() => setSelectedDocIds(new Set())}
            className="px-2.5 py-1 text-[13px] font-bold text-[var(--color-text-faint)] hover:text-white hover:bg-slate-700/60 rounded-lg transition-colors"
          >
            Deselect
          </button>
          {/* One orange (Move, unless the stack's Open shows), two quiet, the rest under More. */}
          <button
            onClick={() => setShowBulkMoveModal(true)}
            className={`flex items-center gap-1.5 px-2.5 py-1 text-[13px] font-bold rounded-lg transition-all active:scale-95 ${stagedDocs.length > 0
              // The stack's Open is the orange one while the stack shows.
              ? "text-slate-200 hover:text-white hover:bg-slate-700/60"
              : "bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)]"}`}
            title="Move all selected documents to a folder"
          >
            <ArrowRight className="w-3 h-3" /> Move to…
          </button>
          <button
            onClick={handleStageSelected}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[13px] font-bold text-slate-200 hover:text-white hover:bg-slate-700/60 rounded-lg transition-colors"
            title="Add to the reference stack to read side by side"
          >
            <Layers className="w-3 h-3" /> Stage
          </button>
          <button
            onClick={() => setShowBulkCheckout(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[13px] font-bold text-slate-200 hover:text-white hover:bg-slate-700/60 rounded-lg transition-colors"
            title="Check out the selected documents, on their own or to a project"
          >
            <Briefcase className="w-3 h-3" /> Check out
          </button>
          {bulkDeleting && (
            <span className="flex items-center gap-1.5 px-2 text-[13px] font-bold text-rose-300">
              <Loader2 className="w-3 h-3 animate-spin" /> Deleting {bulkDeleting.done} of {bulkDeleting.total}…
            </span>
          )}
          {isController && !bulkDeleting && (
            <div className="relative">
              <button
                onClick={() => setBulkMoreOpen((v) => !v)}
                aria-haspopup="menu" aria-expanded={bulkMoreOpen}
                className="flex items-center gap-1 px-2.5 py-1 text-[13px] font-bold text-slate-200 hover:text-white hover:bg-slate-700/60 rounded-lg transition-colors"
              >
                <MoreHorizontal className="w-3.5 h-3.5" /> More
              </button>
              {bulkMoreOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setBulkMoreOpen(false)} />
                  {/* Opens upward: the bar sits at the bottom of the screen. */}
                  <div role="menu" className="absolute right-0 bottom-full mb-2 z-50 w-48 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] shadow-xl py-1">
                    <button role="menuitem" onClick={() => { setBulkMoreOpen(false); setShowBulkEdit(true); }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left text-[13px] font-semibold hover:bg-[var(--color-surface-2)]">
                      <Pencil className="w-3.5 h-3.5 text-[var(--color-text-muted)]" /> Edit fields on all
                    </button>
                    <button role="menuitem" onClick={() => { setBulkMoreOpen(false); void handleBulkArchive(); }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left text-[13px] font-semibold hover:bg-[var(--color-surface-2)]">
                      <Archive className="w-3.5 h-3.5 text-[var(--color-text-muted)]" /> Archive
                    </button>
                    <div className="my-1 h-px bg-[var(--color-border)]" />
                    <button role="menuitem" onClick={() => { setBulkMoreOpen(false); void handleBulkDelete(); }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left text-[13px] font-semibold text-[var(--state-overdue)] hover:bg-[var(--color-surface-2)]">
                      <Trash2 className="w-3.5 h-3.5" /> Delete…
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* STATUS FOOTER */}
      <StatusFooter
        docCount={filteredDocs.length}
        folderCount={filteredFolders.length}
        stagedCount={stagedDocs.length}
        selectedCount={selectedDocIds.size}
        loading={loadingDocs || loadingUpload}
        density={density}
        onDensityChange={setDensity}
        onOpenCommand={() => setCommandOpen(true)}
      />

      {/* COMMAND PALETTE */}
      <CommandPalette
        isOpen={commandOpen}
        onClose={() => setCommandOpen(false)}
        libraryName={library.name}
        folders={folders}
        docs={sortedDocs}
        isController={isController}
        onNavigateFolder={setCurrentFolderId}
        onSelectDoc={setSelectedDoc}
        onStageDoc={(doc) => {
          setStagedDocs((prev) => prev.some((d) => d.id === doc.id) ? prev : [...prev, doc]);
        }}
        onUpload={() => fileInputRef.current?.click()}
        onCreateFolder={openCreateFolder}
        onColumnManager={() => setShowColumnManager(true)}
        orgId={activeOrgId || undefined}
        currentLibraryId={libraryId}
      />

      {/* STAGING TRAY — fixed bottom bar */}
      <StagingTray
        docs={stagedDocs}
        onRemove={handleUnstage}
        onClear={handleClearStaged}
        onOpen={() => { setOpenBookId(null); setShowMultiView(true); }}
      />

      {/* MULTI-DOC VIEWER */}
      {showMultiView && stagedDocs.length > 0 && (
        <MultiDocViewer
          docs={stagedDocs}
          onClose={() => { setShowMultiView(false); setOpenBookId(null); }}
          currentUserId={uid ?? undefined}
          currentUserEmail={userEmail ?? undefined}
          orgId={activeOrgId ?? undefined}
          userRole={activeRole}
          customColumns={(library?.customColumns ?? []) as unknown as TagColumnDef[]}
          labelColumns={activeColumns.slice(0, 2).map((k) => ({ key: k, label: columnOptions.find((c) => c.key === k)?.label || k }))}
        />
      )}

      {reviewPolicyTarget && activeOrgId && (
        <ReviewPolicyModal
          level={reviewPolicyTarget.level}
          id={reviewPolicyTarget.id}
          name={reviewPolicyTarget.name}
          orgId={activeOrgId}
          uid={uid}
          userName={userEmail}
          onClose={() => setReviewPolicyTarget(null)}
        />
      )}

      {ackPolicyTarget && activeOrgId && (
        <AckPolicyModal
          level={ackPolicyTarget.level}
          id={ackPolicyTarget.id}
          name={ackPolicyTarget.name}
          orgId={activeOrgId}
          uid={uid}
          userName={userEmail}
          onClose={() => setAckPolicyTarget(null)}
        />
      )}

      {reviewControlTarget && activeOrgId && (
        <ReviewControlModal
          level={reviewControlTarget.level}
          id={reviewControlTarget.id}
          name={reviewControlTarget.name}
          orgId={activeOrgId}
          uid={uid}
          userName={userEmail}
          onClose={() => setReviewControlTarget(null)}
        />
      )}

      {retentionTarget && activeOrgId && (
        <RetentionPolicyModal
          level={retentionTarget.level}
          id={retentionTarget.id}
          name={retentionTarget.name}
          orgId={activeOrgId}
          uid={uid}
          userName={userEmail}
          onClose={() => setRetentionTarget(null)}
        />
      )}

      {recertOpen && activeOrgId && (
        <AccessRecertModal
          libraryId={libraryId}
          orgId={activeOrgId}
          name={library?.name}
          uid={uid}
          userName={userEmail}
          onClose={() => setRecertOpen(false)}
        />
      )}

      {showColumnManager && (
        <ColumnManager
          isOpen={showColumnManager}
          onClose={() => setShowColumnManager(false)}
          columns={columnOptions}
          active={activeColumns}
          onChange={updateColumns}
          folderName={currentFolder ? currentFolder.name : "the top of this library"}
          source={columnSource}
          onApplyToLibrary={isController ? applyColumnsToLibrary : undefined}
          otherFoldersWithOwn={foldersWithOwnColumns.filter((id) => id !== (currentFolderId ?? null)).length}
          onUseLibrary={canUseLibraryColumns ? followLibraryColumns : undefined}
          onDeleteColumn={isController ? handleDeleteColumn : undefined}
          onRenameColumn={isController ? handleRenameColumn : undefined}
          isController={isController}
          uniquenessKeys={library?.uniquenessKeys}
          onChangeUniquenessKeys={isController ? handleSaveUniquenessKeys : undefined}
        />
      )}

      {showCreateColumn && (
        <CreateColumnWizard
          isOpen={showCreateColumn}
          onClose={() => setShowCreateColumn(false)}
          onSave={handleSaveColumn}
          initialType={wizardInitType}
          initialStep={wizardInitStep}
          onOpenColumnManager={isController ? () => setShowColumnManager(true) : undefined}
        />
      )}

      {/* Phase 5: drag-reorder library order */}
      {activeOrgId && (
        <LibraryOrderModal
          isOpen={showLibraryOrderModal}
          orgId={activeOrgId}
          libraryId={libraryId}
          onClose={() => setShowLibraryOrderModal(false)}
          onSaved={() => { /* realtime subscription will refresh */ }}
        />
      )}

      {/* Phase 4: saved views — floating panel anchored top-right */}
      {showViewSelector && activeOrgId && uid && (
        <div className="fixed top-16 right-4 z-[100] bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] ring-1 ring-black/5 rounded-xl shadow-lg p-3 animate-in fade-in zoom-in-95 duration-150 origin-top-right">
          <ViewSelector
            orgId={activeOrgId}
            libraryId={libraryId}
            userId={uid}
            isAdmin={isController}
            currentFilter={{ search }}
            currentSort={{ key: sortKey, dir: sortDir }}
            currentDisplay={{ density }}
            onApply={(filter, sortCfg, display) => {
              if (filter.search !== undefined) setSearch(filter.search);
              if (sortCfg.key) setSortKey(sortCfg.key);
              if (sortCfg.dir) setSortDir(sortCfg.dir);
              if (display.density) setDensity(display.density as "compact" | "comfy");
              setShowViewSelector(false);
            }}
          />
        </div>
      )}

      {/* Phase 1: metadata-first upload staging modal */}
      <MetadataStagingModal
        isOpen={showStagingModal}
        libraryId={libraryId}
        files={pendingUploadFiles}
        customColumns={(library?.customColumns ?? []) as unknown as CustomColumnDef[]}
        defaultStatus="Issued"
        onCancel={() => { setShowStagingModal(false); setPendingUploadFiles([]); uploadPathsRef.current = new Map(); uploadFolderPlanRef.current = null; setFolderStaged(false); landedFilesRef.current = new WeakSet(); }}
        folderUpload={folderStaged ? {
          destination: currentFolder ? [...(currentFolder.pathNames ?? []), currentFolder.name].join(" / ") : (library?.name ?? "this library"),
          pathOf: (f) => uploadPathsRef.current.get(f),
        } : undefined}
        progress={uploadProgress}
        onSubmit={handleStagedUpload}
        onAddColumn={isController ? () => { setWizardInitType("text"); setWizardInitStep(2); setShowCreateColumn(true); } : undefined}
        uniquenessKeys={library?.uniquenessKeys}
        onAddSheetAndUseForUniqueness={isController ? handleAddSheetAndUseForUniqueness : undefined}
        orgId={activeOrgId ?? undefined}
      />

              {readingDrop !== null && (
                // FIXED, not absolute: in a tall library the centre of the
                // file area can be far below the screen, which made this read
                // as a frozen page.
                <div className="fixed inset-0 z-[250] flex items-center justify-center bg-slate-900/40 backdrop-blur-[2px] p-4">
                  <div className="w-full max-w-sm rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] shadow-2xl p-5 text-center">
                    <Loader2 className="w-8 h-8 text-[var(--color-text-muted)] animate-spin mx-auto mb-3" />
                    <p className="text-base font-semibold text-[var(--color-text)]">Reading your folder…</p>
                    <p className="text-sm text-[var(--color-text)] mt-1">
                      <b>{readingDrop.toLocaleString()}</b> file{readingDrop === 1 ? "" : "s"} found
                    </p>
                    <ReadingHint startedAt={readingStartRef.current} />
                    <button onClick={() => { readingCancelledRef.current = true; setReadingDrop(null); }}
                      className="mt-3 px-3 py-1.5 rounded-lg text-[13px] font-bold border border-[var(--color-border)] hover:bg-[var(--color-surface-2)]">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
      {showDuplicates && activeOrgId && (
        <DuplicateUploadsModal
          orgId={activeOrgId}
          libraryId={libraryId}
          folderName={(id) => {
            const f = id ? folderMap.get(id) : null;
            return f ? [...(f.pathNames ?? []), f.name].join(" / ") : `${library?.name ?? "Library"} (top level)`;
          }}
          onClose={() => setShowDuplicates(false)}
          onDeleted={(ids) => {
            const gone = new Set(ids);
            setDocuments((prev) => prev.filter((d) => !gone.has(d.id!)));
            for (const [k, v] of folderDocsCache.current) folderDocsCache.current.set(k, v.filter((d) => !gone.has(d.id!)));
          }}
        />
      )}

      {deleteFolders && activeOrgId && (
        <FolderDeleteModal
          orgId={activeOrgId}
          folders={deleteFolders}
          onClose={() => setDeleteFolders(null)}
          onDone={onFoldersDeleted}
        />
      )}

      {/* NEW: Checkout Flow Modal */}
      {showCheckoutFlow && checkoutDoc && (
        <CheckoutFlowModal
          isOpen={showCheckoutFlow}
          onClose={() => setShowCheckoutFlow(false)}
          document={checkoutDoc}
          currentUser={{ uid: uid || '', email: userEmail, role: activeRole }}
          canPublish={canPublish}
          folderPath={(() => {
            const f = checkoutDoc.collectionId ? folderMap.get(checkoutDoc.collectionId) : null;
            return f ? [...(f.pathNames ?? []), f.name].filter(Boolean) as string[] : [];
          })()}
        />
      )}

      {selectedDoc && showMetadataEditor && (
        <MetadataEditor
          isOpen={showMetadataEditor}
          onClose={() => setShowMetadataEditor(false)}
          document={selectedDoc}
          columns={columnDefs}
          userRole={activeRole}
          currentUserId={uid || undefined}
          currentUserEmail={userEmail || undefined}
          orgId={activeOrgId ?? undefined}
          onCheckout={openCheckout}
          onSave={saveMetadata}
        />
      )}

      {selectedDoc && showHistory && (
        <HistoryDrawer
          isOpen={showHistory}
          onClose={() => setShowHistory(false)}
          docRecord={selectedDoc}
        />
      )}

      {customizeFolderId && (() => {
        const f = folderMap.get(customizeFolderId);
        return (
          <CustomizeNodeModal
            key={customizeFolderId}
            open={!!customizeFolderId}
            title={f ? `Customize “${f.name}”` : "Customize folder"}
            storagePrefix={activeOrgId ? `orgs/${activeOrgId}/branding` : undefined}
            initial={{
              description: f?.description, color: f?.color, icon: f?.icon, coverImageUrl: f?.coverImageUrl, coverTint: f?.coverTint,
              headerHeight: f?.pageConfig?.header?.height ?? "auto",
              bgType: f?.pageConfig?.background?.type ?? "none",
              bgTint: f?.pageConfig?.background?.tint ?? "neutral",
              bgImagePath: f?.pageConfig?.background?.imagePath,
              bgOpacity: f?.pageConfig?.background?.opacity ?? 0.18,
            }}
            onClose={() => setCustomizeFolderId(null)}
            onSave={async (v) => {
              const height = v.headerHeight === "auto" ? undefined : v.headerHeight;
              const background = v.bgType && v.bgType !== "none"
                ? { type: v.bgType, tint: v.bgTint, imagePath: v.bgImagePath, opacity: v.bgOpacity }
                : { type: "none" as const };
              const nextPage = { ...(f?.pageConfig ?? {}), header: { ...(f?.pageConfig?.header ?? {}), height }, background };
              await updateCollectionAppearance(customizeFolderId, v, uid || undefined, nextPage);
              setFolders((prev) => prev.map((fc) => fc.id === customizeFolderId
                ? { ...fc, description: v.description, color: v.color, icon: v.icon, coverImageUrl: v.coverImageUrl, coverTint: v.coverTint, pageConfig: nextPage }
                : fc));
            }}
          />
        );
      })()}

      {showMoveModal && (
        <MoveModal
          isOpen={showMoveModal}
          onClose={() => setShowMoveModal(false)}
          onConfirm={confirmMoveFolder}
          collections={folders}
          currentId={renameFolderId ?? undefined}
          title="Move Folder"
          allowRoot
        />
      )}

      {showBulkMoveModal && (
        <MoveModal
          isOpen={showBulkMoveModal}
          onClose={() => setShowBulkMoveModal(false)}
          onConfirm={(targetId) => {
            void dropMoveDocs([...selectedDocIds], targetId ?? null);
            setShowBulkMoveModal(false);
          }}
          collections={folders}
          title={`Move ${selectedDocIds.size} document${selectedDocIds.size === 1 ? "" : "s"}`}
          allowRoot
        />
      )}

      {showMoveDocModal && (
        <MoveModal
          isOpen={showMoveDocModal}
          onClose={() => setShowMoveDocModal(false)}
          onConfirm={confirmMoveDoc}
          collections={folders}
          title="Move Document"
          allowRoot
        />
      )}

      {showPermissions && (selectedDoc || renameFolderId) && (
        <PermissionsDrawer
          isOpen={showPermissions}
          onClose={() => setShowPermissions(false)}
          nodeType={selectedDoc ? "document" : "collection"}
          nodeId={(selectedDoc?.id ?? renameFolderId) as string}
          acl={selectedDoc?.acl ?? folderMap.get(renameFolderId ?? "")?.acl}
          visibility={
            (selectedDoc?.visibility ?? folderMap.get(renameFolderId ?? "")?.visibility) as NodeVisibility
          }
          aclChain={selectedDoc ? buildDocChain(selectedDoc) : buildFolderChain(folderMap.get(renameFolderId ?? "") ?? null)}
          canEdit={isController}
          title={selectedDoc?.title ?? folderMap.get(renameFolderId ?? "")?.name}
        />
      )}

      {/* Library-level access: where an Admin/DocCtrl grants "Publish Revisions"
          to a role or user for THIS library only (e.g. a Drafting Supervisor on
          drawings, never procedures). Self-persists to libraries.acl. */}
      {showLibraryPerms && library && (
        <PermissionsDrawer
          isOpen={showLibraryPerms}
          onClose={() => setShowLibraryPerms(false)}
          nodeType="library"
          nodeId={libraryId}
          acl={library.acl}
          visibility={library.visibility as NodeVisibility}
          aclChain={[library.acl].filter(Boolean) as AccessControl[]}
          canEdit={isController}
          title={`${library.name} - library access`}
        />
      )}

      {showSetManager && (
        <SetManager
          isOpen={showSetManager}
          onClose={() => setShowSetManager(false)}
          libraryId={libraryId}
        />
      )}

      {showEquipmentSweep && activeOrgId && library && (
        <EquipmentSweepModal
          orgId={activeOrgId}
          libraryId={libraryId}
          libraryName={library.name}
          folderId={currentFolderId ?? null}
          folderName={currentFolder?.name ?? null}
          onClose={() => setShowEquipmentSweep(false)}
          onApplied={() => folderDocsCache.current.clear()}
        />
      )}

      {numberingOpen && activeOrgId && (
        <LibraryNumberingModal orgId={activeOrgId} libraryId={libraryId} onClose={() => setNumberingOpen(false)} />
      )}

      {creatingFolder && (
        <Modal onClose={() => setCreatingFolder(false)} size="sm" zIndex={90}>
          <ModalHeader icon={FolderPlus} title="New folder"
            subtitle={`Inside ${currentFolder?.name ?? library.name}`} onClose={() => setCreatingFolder(false)} />
          <form onSubmit={(e) => { e.preventDefault(); void confirmCreateFolder(); }}>
            <ModalBody>
              <input
                value={renameValue}
                onChange={(e) => { setRenameValue(e.target.value); setFolderErr(null); }}
                placeholder="Folder name"
                aria-label="Folder name"
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm"
                autoFocus
              />
              {folderErr && <p role="alert" className="mt-2 text-[13px] text-[var(--state-overdue)]">{folderErr}</p>}
            </ModalBody>
            <ModalFooter>
              <Button type="button" variant="secondary" onClick={() => setCreatingFolder(false)}>Cancel</Button>
              <Button type="submit" disabled={!renameValue.trim()}>Create and open</Button>
            </ModalFooter>
          </form>
        </Modal>
      )}

      {/* RECENTLY DELETED FOLDERS — the 30-day delete hold. */}
      {trashFolders !== null && (
        <Modal onClose={() => setTrashFolders(null)} size="md" zIndex={90}>
          <ModalHeader icon={Trash2} title="Recently deleted folders"
            subtitle="Kept 30 days. A restored folder comes back empty: its contents moved up a level when it was deleted."
            onClose={() => setTrashFolders(null)} />
            <div className="max-h-80 overflow-y-auto p-3 space-y-1.5">
              {trashFolders.length === 0 ? (
                <div className="text-center text-[13px] text-[var(--color-text-faint)] py-8">Nothing in the trash.</div>
              ) : trashFolders.map((f) => (
                <div key={f.id} className="flex items-center gap-3 px-3 py-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40">
                  <Trash2 className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-bold text-[var(--color-text)] truncate">{f.name}</div>
                    <div className="text-[13px] text-[var(--color-text-muted)] truncate">
                      {f.pathNames.length > 1 ? `${f.pathNames.slice(0, -1).join(" / ")} · ` : ""}
                      deleted {new Date(f.deletedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} · purges {new Date(f.purgeAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                    </div>
                  </div>
                  <button
                    onClick={() => void restoreFromTrash(f.id)}
                    disabled={trashBusy === f.id}
                    className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[13px] font-bold border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-all"
                  >
                    {trashBusy === f.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArchiveRestore className="w-3 h-3" />}
                    Restore
                  </button>
                </div>
              ))}
            </div>
        </Modal>
      )}

      {renameFolderId && !showMoveModal && !showPermissions && (
        <Modal onClose={() => setRenameFolderId(null)} size="sm" zIndex={90}>
          <ModalHeader icon={Pencil} title="Rename folder" onClose={() => setRenameFolderId(null)} />
          <form onSubmit={(e) => { e.preventDefault(); void confirmRenameFolder(); }}>
            <ModalBody>
              <input
                value={renameValue}
                onChange={(e) => { setRenameValue(e.target.value); setFolderErr(null); }}
                placeholder="Folder name"
                aria-label="Folder name"
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm"
                autoFocus
              />
              {folderErr && <p role="alert" className="mt-2 text-[13px] text-[var(--state-overdue)]">{folderErr}</p>}
            </ModalBody>
            <ModalFooter>
              <Button type="button" variant="secondary" onClick={() => setRenameFolderId(null)}>Cancel</Button>
              <Button type="submit" disabled={!renameValue.trim()}>Rename</Button>
            </ModalFooter>
          </form>
        </Modal>
      )}
    </div>
  );
}

// ─── Auto-numbering settings (per library) ─────────────────────────────────
// A library can own a counter (prefix + padded sequence) so blank-numbered
// uploads get clean issued numbers (PROC-0042). Off by default; drawing
// libraries keep their site-standard numbers.
function LibraryNumberingModal({ orgId, libraryId, onClose }: {
  orgId: string; libraryId: string; onClose: () => void;
}) {
  const [cfg, setCfg] = useState<{ enabled: boolean; prefix: string; pad: number; next_number: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [loadErr, setLoadErr] = useState<string | null>(null);
  useEffect(() => {
    void import("@/lib/libraryNumbering").then((m) =>
      m.getLibraryNumbering(libraryId).then((c) =>
        setCfg(c ?? { enabled: false, prefix: "", pad: 4, next_number: 1 })))
      .catch((e: unknown) => setLoadErr(`Couldn't load the numbering settings: ${(e as Error)?.message ?? "try again"}.`));
  }, [libraryId]);

  const save = async () => {
    if (!cfg) return;
    setBusy(true); setErr(null);
    try {
      const m = await import("@/lib/libraryNumbering");
      await m.saveLibraryNumbering(orgId, libraryId, cfg);
      onClose();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const preview = cfg ? `${cfg.prefix}${String(cfg.next_number).padStart(cfg.pad, "0")}` : "";

  return (
    <Modal onClose={onClose} size="sm" zIndex={95}>
        <ModalHeader icon={Hash} title="Auto-numbering" subtitle="Uploads with a blank number get the next one. A typed number always wins." onClose={onClose} />
        {loadErr ? (
          <p role="alert" className="m-5 border-l-2 border-[var(--state-overdue)] pl-3 text-sm text-[var(--state-overdue)]">{loadErr}</p>
        ) : cfg === null ? (
          <div className="p-6 text-center text-sm text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin inline" /> Loading the numbering settings…</div>
        ) : (
          <div className="p-5 space-y-3">
            <label className="flex items-center gap-2 text-sm font-bold text-[var(--color-text)] cursor-pointer">
              <input type="checkbox" checked={cfg.enabled}
                onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })}
                className="w-4 h-4 accent-[var(--color-main)]" />
              Issue numbers automatically in this library
            </label>
            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-1">
                <label className="text-[13px] font-semibold text-[var(--color-text)]">Prefix</label>
                <input value={cfg.prefix} onChange={(e) => setCfg({ ...cfg, prefix: e.target.value })}
                  placeholder="PROC-" className="mt-1 w-full px-2.5 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm font-display tabular-nums" />
              </div>
              <div>
                <label className="text-[13px] font-semibold text-[var(--color-text)]">Digits</label>
                <input type="number" min={1} max={8} value={cfg.pad}
                  onChange={(e) => setCfg({ ...cfg, pad: Math.max(1, Math.min(8, Number(e.target.value) || 4)) })}
                  className="mt-1 w-full px-2.5 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm" />
              </div>
              <div>
                <label className="text-[13px] font-semibold text-[var(--color-text)]">Next #</label>
                <input type="number" min={1} value={cfg.next_number}
                  onChange={(e) => setCfg({ ...cfg, next_number: Math.max(1, Number(e.target.value) || 1) })}
                  className="mt-1 w-full px-2.5 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm" />
              </div>
            </div>
            <div className="text-[13px] text-[var(--color-text-muted)]">
              Next issued number: <span className="font-display font-semibold tabular-nums text-[var(--color-text)]">{preview}</span>
            </div>
            {err && <p role="alert" className="text-[13px] text-[var(--state-overdue)]">{err}</p>}
          </div>
        )}
        <ModalFooter>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button size="sm" onClick={() => void save()} disabled={!cfg} loading={busy}>
            {!busy && <Save className="w-3.5 h-3.5" />} Save
          </Button>
        </ModalFooter>
    </Modal>
  );
}

/** Elapsed time while a dropped folder is read, and — when it's slow — the
 *  usual reason: cloud-only files (OneDrive / SharePoint "Files On-Demand")
 *  that Windows must download before the browser can hand them over. */
function ReadingHint({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.round((now - startedAt) / 1000));
  return (
    <div className="mt-2 text-[13px] text-[var(--color-text-muted)]">
      <div>{secs}s. The upload window opens once every file is found.</div>
      {secs >= 15 && (
        <p className="mt-2 text-left border-l-2 border-[var(--state-held)] pl-2.5 text-[var(--state-held)]">
          Slow? OneDrive or SharePoint files that are online-only must download first. Right-click the folder, pick <b>Always keep on this device</b>, wait for it to sync, then drop it again.
        </p>
      )}
    </div>
  );
}
