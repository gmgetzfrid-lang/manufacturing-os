"use client";

import { nudgeKnowledgeSources } from "@/lib/knowledge";
import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { stateStyle, documentState } from "@/lib/stateColors";
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
import MetadataStagingModal, { type StagedItem, type CustomColumnDef } from "@/components/documents/MetadataStagingModal";
import CollectionsStrip from "@/components/documents/CollectionsStrip";
import FavoritesStrip from "@/components/documents/FavoritesStrip";
import ViewSelector from "@/components/documents/ViewSelector";
import LibraryOrderModal from "@/components/documents/LibraryOrderModal";
import PillCell from "@/components/documents/PillCell";
import FolderRail from "@/components/documents/FolderRail";
import PathBar from "@/components/documents/PathBar";
import { translatePostgresError } from "@/lib/inputValidation";
import { computeUniquenessKey } from "@/lib/uniqueness";
import { forceReleaseDocument } from "@/lib/checkoutEpisodes";
import { appAlert, appConfirm } from "@/components/providers/DialogProvider";
import WatchButton from "@/components/ui/WatchButton";
import CommandPalette from "@/components/documents/CommandPalette";
import DocThumb from "@/components/documents/DocThumb";
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
import { loadMyMarkup, saveMyMarkup, myActiveSessionId, type DocumentMarkup } from "@/lib/markups";
import { listVersions } from "@/lib/revisions";
import SupersedeModal from "@/components/documents/SupersedeModal";
import ArchiveConfirmModal from "@/components/documents/ArchiveConfirmModal";
import RevertConfirmModal from "@/components/documents/RevertConfirmModal";
import BulkCheckoutToProjectModal from "@/components/documents/BulkCheckoutToProjectModal";
import BulkEditModal from "@/components/documents/BulkEditModal";
import CsvImportModal from "@/components/documents/CsvImportModal";
import RouteLoader from "@/components/ui/RouteLoader";
import { listItems as listCollectionItems } from "@/lib/collections";
import { buildAclIndexFromChain } from "@/lib/acl";
import { canDiscover, canWithAclChain, canPublishOnLibrary, canPublishViaIndex } from "@/lib/permissions";
import { getMyTeamIds } from "@/lib/teams";
import {
  createFolder,
  listenLibraryFolders,
  moveFolderServer,
  moveDocumentsServer,
  renameFolderAndDescendants,
  reorderFolders,
  deleteFolder,
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
  resolveEffectiveViewState,
} from "@/lib/tableViews";
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
import { makeLibraryStoragePath, uniqueUploadName, uploadToPath } from "@/lib/storage";
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
  ArrowLeft,
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
  ChevronUp,
  FileText,
  FolderPlus,
  LayoutGrid,
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
  CheckSquare,
  Hash,
  Save, ArrowRight,
  Table as TableIcon,
  List as ListIcon,
  Image as ImageIcon,
  Link as LinkIcon,
} from "lucide-react";

const BUILTIN_COLUMNS = [
  { key: "title", label: "Title" },
  { key: "documentNumber", label: "Doc No." },
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
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
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

function formatTimestamp(value: unknown) {
  if (!value) return "-";
  try {
    if (typeof (value as { toDate?: () => Date })?.toDate === "function") {
      return (value as { toDate: () => Date }).toDate().toLocaleDateString();
    }
    if (typeof (value as { seconds?: number })?.seconds === "number") {
      return new Date((value as { seconds: number }).seconds * 1000).toLocaleDateString();
    }
    if (value instanceof Date) return value.toLocaleDateString();
    if (typeof value === "string") return new Date(value).toLocaleDateString();
    return String(value);
  } catch {
    return "-";
  }
}

function baseName(filename: string) {
  const idx = filename.lastIndexOf(".");
  return idx > 0 ? filename.slice(0, idx) : filename;
}

// Escape user-controlled strings going into a Supabase .or() ilike
// pattern. Commas and parentheses would otherwise break the filter
// syntax; %_ are SQL wildcards we don't want users to inject.
function escapeIlikeLiteral(s: string): string {
  return s.replace(/[\\%_,()]/g, (m) => `\\${m}`);
}

// Map a raw `documents` row to a DocumentRecord. Module-level so both the
// folder fetch and the deep-link loaders (which fetch docs by id, outside the
// current folder) share one mapper.
function docRecordFromRow(r: Record<string, unknown>): DocumentRecord {
  return {
    id: r.id as string, orgId: r.org_id as string, libraryId: r.library_id as string,
    collectionId: r.collection_id as string | undefined, documentNumber: r.document_number as string,
    title: r.title as string, name: r.name as string, status: r.status as DocumentRecord['status'],
    rev: r.rev as string, currentVersionId: r.current_version_id as string | undefined,
    checkedOutBy: r.checked_out_by as string | undefined, checkedOutByName: r.checked_out_by_name as string | undefined,
    checkedOutAt: r.checked_out_at as unknown as DocumentRecord['checkedOutAt'], activeCollaborators: (r.active_collaborators as string[]) ?? [],
    currentLockId: r.current_lock_id as string | undefined, setId: r.set_id as string | undefined,
    sheetNumber: r.sheet_number as number | undefined, sheetTotal: r.sheet_total as number | undefined,
    visibility: r.visibility as NodeVisibility | undefined, acl: r.acl as AccessControl | undefined,
    aclIndex: r.acl_index as unknown as DocumentRecord['aclIndex'], metadata: r.metadata as unknown as DocumentRecord['metadata'],
    updatedAt: r.updated_at as unknown as DocumentRecord['updatedAt'], createdAt: r.created_at as unknown as DocumentRecord['createdAt'],
    createdBy: (r.created_by as string) ?? '',
    reviewPolicy: (r.review_policy as DocumentRecord['reviewPolicy']) ?? null,
    lastReviewedAt: (r.last_reviewed_at as string | null) ?? null,
    lastReviewedBy: (r.last_reviewed_by as string | null) ?? null,
    nextReviewDate: (r.next_review_date as string | null) ?? null,
    ownerUserId: (r.owner_user_id as string | null) ?? null,
    ownerName: (r.owner_name as string | null) ?? null,
    ackPolicy: (r.ack_policy as DocumentRecord['ackPolicy']) ?? null,
    reviewControl: (r.review_control as DocumentRecord['reviewControl']) ?? null,
    effectiveDate: (r.effective_date as string | null) ?? null,
    retentionPolicy: (r.retention_policy as DocumentRecord['retentionPolicy']) ?? null,
    retentionUntil: (r.retention_until as string | null) ?? null,
    dispositionState: (r.disposition_state as DocumentRecord['dispositionState']) ?? null,
    legalHold: !!r.legal_hold,
    legalHoldMatter: (r.legal_hold_matter as string | null) ?? null,
    legalHoldReason: (r.legal_hold_reason as string | null) ?? null,
    origin: (r.origin as DocumentRecord['origin']) ?? "internal",
    externalSource: (r.external_source as string | null) ?? null,
    externalReference: (r.external_reference as string | null) ?? null,
    externalEdition: (r.external_edition as string | null) ?? null,
    externalUrl: (r.external_url as string | null) ?? null,
  };
}

// Exactly the columns the list view consumes (mirrors docRecordFromRow). Using
// this instead of select("*") keeps the large `search_tsv` tsvector and the
// deprecated `revision_history` JSONB off the wire on every folder open.
const DOC_LIST_COLUMNS =
  "id, org_id, library_id, collection_id, document_number, title, name, status, rev, " +
  "current_version_id, checked_out_by, checked_out_by_name, checked_out_at, active_collaborators, " +
  "current_lock_id, set_id, sheet_number, sheet_total, visibility, acl, acl_index, metadata, " +
  "updated_at, created_at, created_by, review_policy, last_reviewed_at, last_reviewed_by, next_review_date, owner_user_id, owner_name, ack_policy, review_control, effective_date, " +
  "retention_policy, retention_until, disposition_state, legal_hold, legal_hold_matter, legal_hold_reason, " +
  "origin, external_source, external_reference, external_edition, external_url";

export default function LibraryExplorerPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const { activeOrgId, activeRole, roles, hasAnyRole, uid, userEmail } = useRole();

  const libraryId = params.libraryId as string;

  const [library, setLibrary] = useState<LibraryConfig | null>(null);
  const [folders, setFolders] = useState<LibraryCollection[]>([]);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  // Default false — only flip true while a real fetch is in flight, so a
  // transient null activeOrgId (e.g. on refresh before RoleContext resolves)
  // doesn't leave the page wedged on "Loading library...".
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [loadingDocs, setLoadingDocs] = useState(false);
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
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

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

      await supabase.from("libraries").update({ custom_columns: updatedCols, updated_by: uid }).eq("id", library.id!);
      setLibrary((prev) => prev ? { ...prev, customColumns: updatedCols } : prev);

      // Auto-add to view (active columns) — schema act, lands org-wide.
      const newActive = [...activeColumns, field.key];
      await updateColumns(newActive, { scope: "org" });

    } catch (e) {
      console.error("Failed to add column", e);
      setError("Failed to create column.");
    }
  };

  const handleSaveUniquenessKeys = async (next: string[]) => {
    if (!library || !activeOrgId) return;
    try {
      await supabase.from("libraries").update({
        uniqueness_keys: next.length ? next : null,
        updated_by: uid,
      }).eq("id", library.id!);
      setLibrary((prev) => prev ? { ...prev, uniquenessKeys: next.length ? next : undefined } : prev);
    } catch (e) {
      console.error("Failed to save uniqueness keys", e);
      const f = translatePostgresError(e, { entity: "library" });
      setError(`${f.heading} — ${f.message}`);
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
        await supabase.from("libraries").update({ custom_columns: nextCols, updated_by: uid }).eq("id", library.id!);
      }
      const baseKeys = library.uniquenessKeys?.length ? library.uniquenessKeys : ["documentNumber"];
      const nextKeys = Array.from(new Set([...baseKeys, "sheet"]));
      await supabase.from("libraries").update({ uniqueness_keys: nextKeys, updated_by: uid }).eq("id", library.id!);
      setLibrary((prev) => prev ? { ...prev, customColumns: nextCols, uniquenessKeys: nextKeys } : prev);
      if (!hasSheet && !activeColumns.includes("sheet")) {
        await updateColumns([...activeColumns, "sheet"], { scope: "org" });
      }
    } catch (e) {
      console.error("Failed to add Sheet column + uniqueness", e);
      const f = translatePostgresError(e, { entity: "library" });
      setError(`${f.heading} — ${f.message}`);
    }
  };

  const handleSort = (key: string) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    // The upload overlay is for FILES from the OS. Internal drags (a folder
    // tile, a document row) carry their own MIME keys and their own drop
    // targets — flashing "Drop files to upload" over them reads as the app
    // asking you to re-upload the thing you're organizing.
    if (e.dataTransfer.types.includes("Files")) setIsDragOver(true);
  };
  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragOver(false);
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    // Entries must be captured SYNCHRONOUSLY — the DataTransferItemList is
    // dead once the handler returns. Dropped FOLDERS are traversed and their
    // subtree recreated; plain files take the classic path.
    if (e.dataTransfer.items?.length) {
      const { hasDirectories, promise } = collectDroppedFiles(e.dataTransfer.items);
      if (hasDirectories) {
        void promise
          .then((pathed) => handleUploadPathedFiles(pathed))
          .catch((err) => {
            setError(err instanceof FolderUploadLimitError
              ? err.message
              : "Couldn't read the dropped folder. Try the Upload folder button instead.");
          });
        return;
      }
      // Plain-file drop: the classic path handles it; the traversal promise
      // is redundant here but still running — silence its rejection.
      promise.catch(() => undefined);
    }
    handleUploadFiles(e.dataTransfer.files);
  };

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
  const ensureFolderPlan = async (plan: FolderPlan): Promise<EnsuredFolderPlan> => {
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
    for (const node of plan.folders) {
      const parentCollectionId = node.parentKey
        ? idByKey.get(node.parentKey) ?? (currentFolderId ?? null)
        : (currentFolderId ?? null);
      const reuse = existingByParent.get(parentCollectionId)?.get(node.name.trim().toLowerCase());
      if (reuse) {
        idByKey.set(node.key, reuse);
        chainByFolderId.set(reuse, chainOf(reuse));
        continue;
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
        const aclIndex = buildAclIndexFromChain(myChain, Date.now()); // OWN-7
        // A failed index write would leave the folder's RLS index missing its
        // inherited restrictions — that must fail the upload, not pass silently.
        const { error: idxErr } = await supabase.from("collections")
          .update({ acl_index: aclIndex ?? null }).eq("id", newId);
        if (idxErr) throw new Error(`Couldn't apply permissions to the new folder "${node.name}": ${idxErr.message}`);
      }
      chainByFolderId.set(newId, myChain);
      register(parentCollectionId, node.name, newId);
      idByKey.set(node.key, newId);
    }
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
    if (target.closest("[data-doc-item], button, a, input, textarea, select")) return;
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
    // Records management: legal holds freeze records against deletion — same
    // rule as the single-doc path, checked against the DB (server truth).
    const { data: held } = await supabase.from("documents")
      .select("id, document_number, title, name")
      .in("id", Array.from(selectedDocIds)).eq("legal_hold", true);
    if (held && held.length > 0) {
      const label = (held[0] as Record<string, unknown>);
      setError(`${held.length} of the selected document${held.length === 1 ? " is" : "s are"} under a legal hold (e.g. ${(label.document_number as string) || (label.title as string) || (label.name as string) || "a record"}) and can't be deleted. Release the hold first.`);
      return;
    }
    if (!(await appConfirm({ title: `Permanently delete ${selectedDocIds.size} document(s)?`, message: "This cannot be undone.", tone: "danger" }))) return;
    for (const id of selectedDocIds) {
      await supabase.from("documents").delete().eq("id", id);
    }
    setDocuments((prev) => prev.filter((d) => !selectedDocIds.has(d.id!)));
    setSelectedDocIds(new Set());
    setSelectedDoc(null);
  };

  // Bulk archive — preserves history, sets status=Archived. Reversible
  // via the metadata editor or the per-doc inspector.
  const handleBulkArchive = async () => {
    if (selectedDocIds.size === 0) return;
    if (!(await appConfirm({ title: `Archive ${selectedDocIds.size} document${selectedDocIds.size === 1 ? "" : "s"}?`, message: "They keep their history but disappear from the default view." }))) return;
    const ids = Array.from(selectedDocIds);
    const now = new Date().toISOString();
    // SURF-3: a legal hold freezes the record against every destructive verb,
    // archive included (the DB guard refuses it too). Skip held ones loudly.
    const { data: heldRows } = await supabase.from("documents").select("id").in("id", ids).eq("legal_hold", true);
    const held = new Set(((heldRows ?? []) as Array<{ id: string }>).map((r) => r.id));
    const targets = ids.filter((id) => !held.has(id));
    if (targets.length === 0) {
      await appAlert({ message: `All ${ids.length} selected document${ids.length === 1 ? " is" : "s are"} under legal hold and cannot be archived.`, tone: "danger" });
      return;
    }
    const { data: archived, error: archErr } = await supabase.from("documents").update({
      status: "Archived",
      archived_at: now,
      archived_by: uid ?? null,
      updated_at: now,
      updated_by: uid ?? null,
    }).in("id", targets).select("id");
    if (archErr) { await appAlert({ message: `Archive failed: ${archErr.message}`, tone: "danger" }); return; }
    const done = new Set(((archived ?? []) as Array<{ id: string }>).map((r) => r.id));
    setDocuments((prev) => prev.map((d) =>
      done.has(d.id!) ? { ...d, status: "Archived" as DocumentRecord["status"] } : d
    ));
    setSelectedDocIds(new Set());
    if (held.size > 0 || done.size < targets.length) {
      await appAlert({ message: `Archived ${done.size} of ${ids.length}. ${held.size ? `${held.size} under legal hold were skipped.` : ""} ${done.size < targets.length ? `${targets.length - done.size} were refused.` : ""}`.trim() });
    }
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

  // UX enhancements
  const [isDragOver, setIsDragOver] = useState(false);
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
  const saveWidthsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep colWidthsRef in sync so resize handler can read latest value on mouseup
  useEffect(() => { colWidthsRef.current = colWidths; }, [colWidths]);

  const [activeColumns, setActiveColumns] = useState<string[]>([]);
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
      setError("Failed to force unlock.");
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
      message: "This removes the document AND every revision attached to it. The file in R2 storage is left untouched (you can clean that up later). This cannot be undone.",
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

  useEffect(() => {
    const folderId = searchParams.get("folderId");
    if (folderId) setCurrentFolderId(folderId);
  }, [searchParams]);

  // Deep-link via ?doc=<id> — when arriving from the global search,
  // an inbox link, a notification bell row, etc, auto-select the doc
  // and open the inspector. The document list is FOLDER-SCOPED, so a doc
  // living inside a folder won't be in `documents` when we land at the
  // library root — in that case look it up directly and jump to its
  // folder first (once per docId), then the re-run selects it.
  const handledDocLink = useRef<string | null>(null);
  const autoFullScreenedDoc = useRef<string | null>(null);
  // True while an incoming ?doc/?book link is still being resolved into state
  // (e.g. navigating to the doc's folder before its row is loaded). The URL
  // writer below pauses while this is set so it can't strip the link out of the
  // address bar before the readers have applied it. Cleared in every terminal
  // branch so it can never wedge the writer.
  const deepLinkPending = useRef(false);
  useEffect(() => {
    const docId = searchParams.get("doc");
    if (!docId) return;
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
    // Not in the (folder-scoped) list. Navigate to the doc's folder once; after
    // that folder's docs load this effect re-runs and selects it.
    if (handledDocLink.current === docId) {
      // Already navigated and it STILL isn't here → it's gone or not permitted.
      // Stop blocking the writer so the URL can resume syncing.
      deepLinkPending.current = false;
      return;
    }
    handledDocLink.current = docId;
    deepLinkPending.current = true;
    (async () => {
      const { data } = await supabase
        .from("documents")
        .select("id, collection_id")
        .eq("id", docId)
        .maybeSingle();
      if (data) setCurrentFolderId((data.collection_id as string | null) ?? null);
      else deepLinkPending.current = false;
    })();
  }, [searchParams, documents]);

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
  useEffect(() => {
    if (!urlSyncMounted.current) { urlSyncMounted.current = true; return; }
    if (deepLinkPending.current) return; // a deep link is still resolving — leave the URL alone
    const sp = new URLSearchParams(searchParams.toString());
    sp.delete("doc"); sp.delete("fs"); sp.delete("book");
    if (selectedDoc?.id) {
      sp.set("doc", selectedDoc.id);
      if (showFullScreen) sp.set("fs", "1");
    } else if (showMultiView && openBookId) {
      sp.set("book", openBookId);
    }
    if (currentFolderId) sp.set("folderId", currentFolderId); else sp.delete("folderId");
    const next = sp.toString();
    if (next !== searchParams.toString()) {
      router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
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
      setError("Library load timed out after 15s. Check console / network tab.");
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
          "id,org_id,name,description,type,custom_columns,column_label_overrides,uniqueness_keys,write_access,admin_access,read_access,visible_to,folder_security,default_new_visibility,default_new_acl,acl,acl_index,column_widths,color,icon,cover_image_url,cover_tint,home_config,page_config";
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
          aclIndex: data.acl_index ?? undefined,
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
        hideHidden: !hasAnyRole(["Admin", "DocCtrl"])
      }
    );

    return () => {
      if (unsub) unsub();
    };
  }, [libraryId, activeOrgId, activeRole, hasAnyRole]);

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
  useEffect(() => {
    if (!libraryId) return;
    const channel = supabase.channel(`docs-lib-${libraryId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "documents", filter: `library_id=eq.${libraryId}` },
        () => setDocsRefreshTick((t) => t + 1))
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [libraryId]);

  useEffect(() => {
    if (!libraryId || !activeOrgId) return;
    let alive = true;

    const fromDocRow = docRecordFromRow;
    // Stale-while-revalidate: if this folder was loaded before, paint its last
    // docs INSTANTLY and refresh in the background instead of a spinner on every
    // switch. Keyed by library so folders never bleed across libraries.
    const cacheKey = `${libraryId}|${currentFolderId ?? "root"}|${showArchivedDocs}`;
    const cached = folderDocsCache.current.get(cacheKey);
    if (cached) { setDocuments(cached); setLoadingDocs(false); }
    else { setLoadingDocs(true); }

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
          if (!hasAnyRole(["Admin", "DocCtrl"])) q = q.eq("visibility", "normal");
          // Hide archived docs from default view. Admins can flip the toggle
          // (showArchivedDocs) to surface them for restore.
          if (!showArchivedDocs) q = q.neq("status", "Archived");
          // Stable two-key order so pages never overlap or skip rows.
          q = q.order("updated_at", { ascending: false }).order("id").range(from, from + PAGE - 1);
          const { data, error: qErr } = await q;
          if (!alive) return;
          if (qErr) {
            if (from === 0) { setError(qErr.message); setDocuments([]); }
            else setError(`Loaded the first ${all.length.toLocaleString()} documents; the rest failed: ${qErr.message}`);
            break;
          }
          const rows = (data || []).map((r) => fromDocRow(r as unknown as Record<string, unknown>));
          all = all.concat(rows);
          folderDocsCache.current.set(cacheKey, all);
          setDocuments(all);
          const morePagesLikely = rows.length === PAGE;
          setDocStreamProgress(morePagesLikely && from + PAGE < HARD_CAP ? all.length : null);
          setDocFetchHitCap(morePagesLikely && from + PAGE >= HARD_CAP);
          if (from === 0) setLoadingDocs(false); // first page is on screen
          if (!morePagesLikely) break;
        }
      } catch (e: unknown) { if (alive) setError((e as Error).message); }
      finally {
        if (alive) { setLoadingDocs(false); setDocStreamProgress(null); }
      }
    };

    fetchDocs();

    return () => { alive = false; };
  }, [libraryId, activeOrgId, currentFolderId, activeRole, showArchivedDocs, docsRefreshTick, hasAnyRole]);

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

  const folderMap = useMemo(() => {
    const map = new Map<string, LibraryCollection>();
    for (const f of folders) {
      if (f.id) map.set(f.id, f);
    }
    return map;
  }, [folders]);

  const currentFolder = currentFolderId ? folderMap.get(currentFolderId) ?? null : null;

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
      // OWN-3 / CHAIN-1: the full collection — controller tier and ACL role
      // subjects (allow AND deny) evaluate against every held role.
      roles,
      orgId: activeOrgId ?? undefined,
      teamIds: myTeamIds,
    };
  }, [uid, activeRole, roles, activeOrgId, myTeamIds]);

  // May this user publish revisions in THIS library? True for Admin/DocCtrl
  // (broad tier) and for anyone the library's ACL grants the "publish" action
  // (e.g. a Drafting Supervisor on a drawings library). Gates the Publish/Revert
  // controls; the lib mutators + DB trigger enforce the same rule for real.
  // Mirrors resolveCanControlLibrary (the mutator's rule): the chain-resolved
  // acl_index first — the SAME column the DB publish guard reads — then the
  // raw ACL fallback. The button and the mutator can no longer disagree.
  const canPublish = useMemo(() => {
    const viaIndex = canPublishViaIndex(library?.aclIndex ?? null, principal);
    if (viaIndex !== null) return viaIndex;
    return canPublishOnLibrary({ principal, libraryAcl: library?.acl });
  }, [principal, library?.acl, library?.aclIndex]);

  // GAP-7 / DEC-24: the viewer is seeded from the markup STORE and saves back
  // to it — the caller's own markup by default, or a chosen stored markup from
  // the inspector (the author continues; anyone else views, nothing is saved).
  const [markupSeed, setMarkupSeed] = useState<{ key: string; states: Record<number, object>; readOnly: boolean } | null>(null);
  const [pendingMarkup, setPendingMarkup] = useState<DocumentMarkup | null>(null);
  const [markupsRefreshKey, setMarkupsRefreshKey] = useState(0);
  useEffect(() => {
    let alive = true;
    if (!showFullScreen || !selectedDoc?.id || !selectedVersion?.id || !uid) { setMarkupSeed(null); return; }
    const docId = selectedDoc.id, versionId = selectedVersion.id;
    (async () => {
      try {
        if (pendingMarkup && pendingMarkup.documentId === docId && pendingMarkup.versionId === versionId) {
          if (alive) setMarkupSeed({ key: `${docId}:${versionId}:${pendingMarkup.userId}`, states: pendingMarkup.pageStates, readOnly: pendingMarkup.userId !== uid });
          return;
        }
        const mine = await loadMyMarkup(docId, versionId, uid);
        if (alive) setMarkupSeed({ key: `${docId}:${versionId}:${uid}`, states: mine?.pageStates ?? {}, readOnly: false });
      } catch {
        // The store could not be read: open the sheet blank rather than not at all — but never save over an unknown state.
        if (alive) setMarkupSeed({ key: `${docId}:${versionId}:unavailable`, states: {}, readOnly: true });
      }
    })();
    return () => { alive = false; };
  }, [showFullScreen, selectedDoc?.id, selectedVersion?.id, uid, pendingMarkup]);
  const persistMarkup = useCallback(async (states: Record<number, object>) => {
    if (!selectedDoc?.id || !selectedVersion?.id || !uid || !activeOrgId) return;
    const sessionId = await myActiveSessionId(selectedDoc.id, uid);
    await saveMyMarkup({ orgId: activeOrgId, documentId: selectedDoc.id, versionId: selectedVersion.id, uid, checkoutSessionId: sessionId, pageStates: states });
    setMarkupsRefreshKey((k) => k + 1);
  }, [selectedDoc?.id, selectedVersion?.id, uid, activeOrgId]);

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

  // DEL-2: the effective-owner cascade the database applies (document →
  // folder lineage → library) — the client filter must never re-hide a row
  // the DB's ownership branch deliberately returned. (Team-supervisor rung
  // resolves DB-side only.)
  const folderOwnerFor = useCallback(
    (collectionId?: string | null): string | null => {
      let cur = collectionId ? folderMap.get(collectionId) : undefined;
      const seen = new Set<string>();
      while (cur) {
        const id = cur.id ?? "";
        if (!id || seen.has(id)) break;
        seen.add(id);
        if (cur.ownerUserId) return cur.ownerUserId;
        cur = cur.parentId ? folderMap.get(cur.parentId) : undefined;
      }
      return null;
    },
    [folderMap],
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
        // GAP-15 / DEL-2: ownership carries read access — the folder's own
        // owner, an ancestor folder's owner, or the library's owner must not
        // be re-hidden client-side after the DB deliberately returned the row.
        effectiveOwnerUserId: f.ownerUserId ?? folderOwnerFor(f.parentId) ?? library?.ownerUserId ?? null,
      })
    );
  }, [visibleFolders, principal, buildFolderChain, folderOwnerFor, library?.ownerUserId]);

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
        // GAP-15 / DEL-2: ownership carries read access — never re-hide a row
        // the DB's ownership branch deliberately returned (folder rung included).
        effectiveOwnerUserId: docRecord.ownerUserId ?? folderOwnerFor(docRecord.collectionId) ?? library?.ownerUserId ?? null,
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
  }, [folderOwnerFor, documents, principal, deferredSearch, buildDocChain, library?.ownerUserId]);

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

    const defaults = defaultColumnsFromSchema({
      customColumns: custom,
    });

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
      }
    );

    return () => {
      if (unsub) unsub();
    };
  }, [library, currentFolderId, activeOrgId, uid, libraryId, currentFolder?.columnOverrides]);

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

    const fromVersionRow = (r: Record<string, unknown>): DocumentVersion => ({
      id: r.id as string,
      orgId: r.org_id as string,
      recordId: r.record_id as string,
      revisionLabel: r.revision_label as string,
      issueType: r.issue_type as DocumentVersion['issueType'],
      changeType: r.change_type as DocumentVersion['changeType'],
      fileUrl: r.file_url as string,
      fileType: r.file_type as string,
      size: r.size as number,
      isFlattened: r.is_flattened as boolean | undefined,
      hasWatermark: r.has_watermark as boolean | undefined,
      watermarkPolicyId: r.watermark_policy_id as string | undefined,
      downloadPolicy: r.download_policy as DocumentVersion['downloadPolicy'],
      changeLog: r.change_log as string | undefined,
      relatedTicketId: r.related_ticket_id as string | undefined,
      createdBy: r.created_by as string,
      createdByName: r.created_by_name as string | undefined,
      createdAt: r.created_at as unknown as DocumentVersion['createdAt'],
      approvedBy: r.approved_by as string | undefined,
      supersedesVersionId: r.supersedes_version_id as string | undefined,
      drawnBy: r.drawn_by as string | undefined,
      drawnByName: r.drawn_by_name as string | undefined,
      checkedBy: r.checked_by as string | undefined,
      checkedByName: r.checked_by_name as string | undefined,
      approvedByName: r.approved_by_name as string | undefined,
      approvedAt: r.approved_at as unknown as DocumentVersion['approvedAt'],
      releasedAt: r.released_at as unknown as DocumentVersion['releasedAt'],
      supersededAt: r.superseded_at as unknown as DocumentVersion['supersededAt'],
      mocReference: r.moc_reference as string | undefined,
      sourceFileName: r.source_file_name as string | undefined,
      revertedFromVersionId: r.reverted_from_version_id as string | undefined,
      fileHash: r.file_hash as string | undefined,
    });

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
            setSelectedVersion(fromVersionRow(data as Record<string, unknown>));
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
        setSelectedVersion(data && data.length > 0 ? fromVersionRow(data[0] as Record<string, unknown>) : null);
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
    const dynamic = columnDefs.map((c) => ({ key: c.key, label: c.label }));
    const known = new Set([
      ...builtins.map((c) => c.key),
      ...optional.map((c) => c.key),
      ...dynamic.map((c) => c.key),
    ]);
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
    setActiveColumns(next);
    if (!activeOrgId || !uid) return;
    const scope = opts?.scope === "org" && isController ? "org" : "user";
    await saveTableView({
      scope,
      orgId: activeOrgId,
      ownerUserId: scope === "user" ? uid : undefined,
      libraryId,
      collectionId: currentFolderId ?? undefined,
      columns: next,
    });
    // A user row now exists here — surface the "Clear my default" escape
    // hatch immediately, not on the next folder visit.
    setViewDefaults((prev) => scope === "user"
      ? { ...prev, hasUserRow: true }
      : { ...prev, hasOrgRow: true });
  };

  const openCreateFolder = () => {
    setRenameValue("");
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
        const aclIndex = buildAclIndexFromChain(chain, Date.now()); // OWN-7
        await supabase.from("collections").update({ acl_index: aclIndex ?? null }).eq("id", newId);
      }

      setCreatingFolder(false);
      setRenameValue("");
    } catch (e) {
      console.error(e);
      setError("Failed to create folder.");
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
      setError("Failed to rename folder.");
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

  const handleDeleteFolder = async (id: string) => {
    const f = folderMap.get(id);
    if (!f) return;
    const childCount = folders.filter((x) => x.parentId === id).length;
    const ok = await appConfirm({
      title: `Delete "${f.name}"?`,
      message:
        "Nothing inside is lost. Its documents"
        + (childCount > 0 ? ` and ${childCount} subfolder${childCount === 1 ? "" : "s"}` : "")
        + " move up one level, and the folder itself is held in Recently deleted (⋯ menu)"
        + " for 30 days — restore it from there if this was a mistake. If an AI knowledge"
        + " library watches this specific folder, its contents leave that library's scope.",
      confirmLabel: "Delete folder",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await deleteFolder(id, activeOrgId!);
      // The server confirmed; the screen must not wait for a realtime event
      // that (for deletes) may never arrive. Remove the folder and step its
      // children up a level locally — exactly what the server just did.
      setFolders((prev) => prev
        .filter((x) => x.id !== id)
        .map((x) => (x.parentId === id ? { ...x, parentId: f.parentId ?? null } : x)));
      setDocuments((prev) => prev.map((d) =>
        d.collectionId === id ? { ...d, collectionId: f.parentId ?? null } : d));
      if (currentFolderId === id) setCurrentFolderId(f.parentId ?? null);
      nudgeKnowledgeSources(activeOrgId!, libraryId);
    } catch (e) {
      console.error(e);
      setError("Couldn't delete that folder.");
    }
  };

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
  const handleUploadFiles = (files: FileList | null) => {
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!files || files.length === 0 || !activeOrgId || !uid || !library) return;
    uploadPathsRef.current = new Map(); // flat upload — no tree to recreate
    uploadFolderPlanRef.current = null;
    // OS metadata junk (.DS_Store & friends) is filtered on the folder path;
    // filter the flat path too so it never becomes a controlled document.
    const clean = Array.from(files).filter((f) => !isJunkFile(f.name));
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
  const UPLOAD_CONCURRENCY = 4;
  const handleStagedUpload = async (items: StagedItem[], signal?: AbortSignal) => {
    const notifyLibrarySubscribers = (count: number, firstName: string) => {
      if (!activeOrgId || !uid || count === 0) return;
      void import("@/lib/notify/dispatch").then((m) =>
        m.emit({
          orgId: activeOrgId,
          category: "watched",
          kind: "library_doc_added",
          title: count === 1 ? `New document: ${firstName}` : `${count} new documents added`,
          body: `${userEmail ?? "Someone"} added ${count === 1 ? firstName : `${count} documents`} to a library you subscribe to.`,
          link: `/documents/${libraryId}`,
          resource: { type: "library", id: libraryId },
          actorUserId: uid,
          actorName: userEmail ?? "someone",
          audience: { followers: true },
        })).catch(() => undefined);
    };
    if (!activeOrgId || !uid || !library) return;
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
          uploadFolderPlanRef.current = await ensureFolderPlan(plan);
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
      const orClause = distinctBases.map((b) => `document_number.ilike.${escapeIlikeLiteral(b)}%`).join(",");
      const { data: existingRows } = await supabase
        .from("documents")
        .select("document_number")
        .eq("library_id", libraryId)
        .or(orClause)
        .not("status", "in", "(Archived,Superseded)");
      const usedNumbers = new Set<string>((existingRows ?? []).map((r) => String((r as { document_number: string }).document_number || "")));

      const resolved: Array<{ item: StagedItem; docNumber: string; original: string }> = items.map((item, i) => {
        const original = originals[i];
        let candidate = original;
        let n = 1;
        while (usedNumbers.has(candidate)) {
          n += 1;
          candidate = `${original}-${n}`;
        }
        usedNumbers.add(candidate);
        if (candidate !== original) autoRenamed.push({ original, final: candidate });
        return { item, docNumber: candidate, original };
      });

      // ── Upload + insert one file ─────────────────────────────────
      const uploadOne = async (entry: { item: StagedItem; docNumber: string }) => {
        const { item, docNumber } = entry;
        const file = item.file;
        const subPath = pathByFile.get(file) ?? [];
        // PKG-3: salted per-upload name — the raw filename made the key a pure
        // function of (org, library, folder, name), so a second same-named
        // upload silently overwrote the first document's bytes while the
        // auto-rename (`P-101` → `P-101-2`) hid the collision.
        const storagePath = makeLibraryStoragePath({
          orgId: activeOrgId,
          libraryId,
          folderPath: [...folderPath, ...subPath],
          filename: uniqueUploadName(file.name, item.rev.trim() || "0"),
        });
        const uploadResult = await uploadToPath(file, storagePath, {
          contentType: file.type || undefined,
          signal,
        });

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
            ? buildAclIndexFromChain([...chainForTarget(targetCollectionId), library.defaultNewAcl], Date.now()) // OWN-7
            : null,
          created_at: now,
          created_by: uid,
          updated_at: now,
          updated_by: uid,
        }).select("id").single();

        if (docErr || !newDoc) throw new Error(docErr?.message || "Failed to create document record");

        const { data: newVersion, error: verErr } = await supabase.from("document_versions").insert({
          org_id: activeOrgId,
          record_id: newDoc.id,
          revision_label: item.rev.trim() || "0",
          file_url: uploadResult.url,
          file_type: file.type || "application/octet-stream",
          size: uploadResult.size,
          created_by: uid,
          created_by_name: userEmail || uid,
          created_at: now,
        }).select("id").single();

        if (verErr || !newVersion) throw new Error(verErr?.message || "Failed to create document version");

        await supabase.from("documents").update({ current_version_id: newVersion.id }).eq("id", newDoc.id);
      };

      // ── Run in capped-concurrency chunks ──────────────────────────
      // allSettled, not all: one unreadable file used to reject the chunk and
      // abandon every file after it, so a 40-file batch could stop at file 7
      // with no statement of what landed and what didn't. Every file now gets
      // its attempt and the batch reports the truth at the end.
      const failures: Array<{ name: string; reason: string }> = [];
      let stoppedAt = -1;
      setUploadProgress({ done: 0, total: resolved.length });
      for (let i = 0; i < resolved.length; i += UPLOAD_CONCURRENCY) {
        // The user pressed Stop or closed the modal. Don't start work nobody
        // is waiting for; the files already in flight abort on their own.
        if (signal?.aborted) { stoppedAt = i; break; }
        const chunk = resolved.slice(i, i + UPLOAD_CONCURRENCY);
        const results = await Promise.allSettled(chunk.map(uploadOne));
        results.forEach((r, j) => {
          if (r.status === "rejected") {
            failures.push({
              name: chunk[j].item.file.name,
              reason: (r.reason as Error)?.message ?? "unknown error",
            });
          }
        });
        setUploadProgress({ done: Math.min(i + chunk.length, resolved.length), total: resolved.length });
      }
      // stoppedAt is the index of the first chunk we never started, which is
      // exactly the number of files that did get an attempt.
      const attempted = stoppedAt >= 0 ? stoppedAt : resolved.length;
      const notStarted = resolved.length - attempted;
      const landed = attempted - failures.length;
      if (landed > 0) {
        notifyLibrarySubscribers(landed, resolved[0]?.docNumber || resolved[0]?.original || "document");
      }

      const notes: string[] = [];
      if (foldersCreatedNote) notes.push(foldersCreatedNote);
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
          notes.push(`${failures.length} file${failures.length === 1 ? "" : "s"} did NOT upload: ${sample}${more}. Everything else landed — re-stage just the failures.`);
        }
        // Keep the staging modal open so the failures are still in hand.
        setError(`Uploaded ${landed} of ${resolved.length}. ${notes.join(" ")}`);
      } else {
        setShowStagingModal(false);
        // A file just landed in doc control — any AI library watching this
        // one picks it up NOW, not at the next cron pass.
        nudgeKnowledgeSources(activeOrgId!, libraryId);
        setPendingUploadFiles([]);
        uploadPathsRef.current = new Map();
        uploadFolderPlanRef.current = null;
        if (notes.length > 0) setError(`Uploaded. ${notes.join(" ")}`);
      }
    } catch (e) {
      console.error(e);
      const f = translatePostgresError(e, { entity: "document", field: "document_number" });
      setError(`${f.heading} — ${f.message}`);
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
    await supabase.from("documents").update(payload).eq("id", selectedDoc.id);
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
    await supabase.from("libraries").update({ custom_columns: updatedCols, updated_by: uid }).eq("id", library.id!);
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
    if (colKey === "rev") return 70;
    if (colKey === "status") return 100;
    if (colKey === "updatedAt") return 110;
    const def = columnMap.get(colKey);
    if (def?.type === "tags" || def?.isPill) return 180;
    if (def?.type === "date") return 110;
    if (def?.type === "number") return 90;
    if (def?.type === "boolean") return 70;
    if (def?.type === "select") return 130;
    return 150;
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
    const startWidth = colWidths[colKey] ?? getDefaultColWidth(colKey);
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
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      resizingRef.current = null;
      if (library?.id && uid) {
        if (saveWidthsTimerRef.current) clearTimeout(saveWidthsTimerRef.current);
        const snapshot = { ...colWidthsRef.current };
        saveWidthsTimerRef.current = setTimeout(() => {
          supabase.from("libraries").update({ column_widths: snapshot, updated_by: uid }).eq("id", library.id!);
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
        supabase.from("libraries").update({ column_widths: next, updated_by: uid }).eq("id", library.id!);
      }
      return next;
    });
  }, [library, uid]);

  const renderDocCell = (docRecord: DocumentRecord, key: string) => {
    if (key === "title") return docRecord.title || docRecord.name || "Untitled";
    if (key === "documentNumber") return docRecord.documentNumber || "-";
    if (key === "rev") return docRecord.rev || "-";
    if (key === "status") return docRecord.status || "-";
    if (key === "updatedAt") return formatTimestamp(docRecord.updatedAt);
    if (key === "createdAt") return formatTimestamp(docRecord.createdAt);
    if (key === "size") return formatBytesShort(docSizeBytes(docRecord));
    if (key === "fileType") {
      const ext = docFileExt(docRecord);
      if (ext) return `.${ext}`;
      const mime = (docRecord.metadata ?? {})["mime_type"];
      return typeof mime === "string" && mime ? mime : "—";
    }

    const def = columnMap.get(key);
    const value = (docRecord.metadata ?? {})[key];

    if (!def) return value == null ? "-" : String(value);

    if (def.type === "review") {
      return <ReviewPill nextReviewDate={docRecord.nextReviewDate} compact />;
    }
    if (def.type === "owner") {
      return docRecord.ownerName || <span className="text-[var(--color-text-faint)]">—</span>;
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
              canManage={hasAnyRole(["Admin", "Manager", "Supervisor"])}
            />
          ))}
        </div>
      );
    }

    if (Array.isArray(value)) return value.join(", ");
    return value == null ? "-" : String(value);
  };

  if (!activeOrgId) {
    return (
      <div className="min-h-full p-4 sm:p-8">
        <div className="max-w-3xl mx-auto bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-slate-900 rounded-xl shadow-lg shadow-slate-900/20">
              <Shield className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-black text-[var(--color-text)]">Workspace not selected</h1>
              <p className="text-sm text-[var(--color-text-muted)] mt-1">
                Select a workspace in the sidebar to access this library.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (loadingLibrary) {
    return <RouteLoader label="Loading library…" />;
  }

  if (!library) {
    return (
      <div className="min-h-full p-4 sm:p-8">
        <div className="max-w-3xl mx-auto bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-slate-900 rounded-xl shadow-lg shadow-slate-900/20">
              <Shield className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-black text-[var(--color-text)]">Library not found</h1>
              <p className="text-sm text-[var(--color-text-muted)] mt-1">{error || "Unable to load library."}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // OWN-3: controller tier follows the full role collection, not the headline.
  const isController = hasAnyRole(["Admin", "DocCtrl"]);
  // DEL-6: the library's owner is told to recertify access — they can.
  const isLibraryOwner = !!uid && !!library?.ownerUserId && library.ownerUserId === uid;
  // DEL-1 / GAP-3: the Permissions drawer's authority is controller, OR the
  // node's effective owner, OR a managePermissions/admin grant on its chain
  // (canWithAclChain mirrors the DB's can_manage_node). Owners edit in
  // delegation mode — bounded grants with an expiry.
  const drawerDelegationAuthority = (() => {
    if (!uid) return false;
    const folder = renameFolderId ? folderMap.get(renameFolderId) ?? null : null;
    const ownerId = selectedDoc
      ? (selectedDoc.ownerUserId ?? library?.ownerUserId ?? null)
      : (folder?.ownerUserId ?? library?.ownerUserId ?? null);
    if (ownerId && ownerId === uid) return true;
    const chain = selectedDoc ? buildDocChain(selectedDoc) : buildFolderChain(folder);
    return canWithAclChain({ principal, action: "managePermissions", aclChain: chain, defaultAllow: false });
  })();
  const libraryDelegationAuthority = !!uid && !!library?.ownerUserId && library.ownerUserId === uid;
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
  const headerPad = density === "compact" ? "py-2" : "py-3";

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

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {showFullScreen && selectedDoc && selectedVersion && markupSeed && (
        <FullScreenViewer
          key={markupSeed.key}
          isOpen={showFullScreen}
          onClose={() => { setShowFullScreen(false); setPendingMarkup(null); }}
          url={selectedVersion.fileUrl}
          title={selectedDoc.title || "Document"}
          docNumber={selectedDoc.documentNumber || ""}
          rev={selectedVersion.revisionLabel || ""}
          viewingVersionId={selectedVersion.id}
          document={selectedDoc}
          userRole={activeRole}
          userRoles={roles}
          currentUserId={uid || undefined}
          currentUserEmail={userEmail || undefined}
          onCheckout={openCheckout}
          orgId={activeOrgId ?? undefined}
          customColumns={(library?.customColumns ?? []) as unknown as Array<{ key: string; label: string; type?: string; pillGroupLabel?: string }>}
          initialPageStates={markupSeed.states}
          onPageStatesChange={markupSeed.readOnly ? undefined : (states) => { void persistMarkup(states).catch((e) => console.warn("[markups] autosave failed", e)); }}
          onCommit={markupSeed.readOnly ? undefined : async (states) => {
            try { await persistMarkup(states); }
            catch (e) { void appAlert({ title: "Markup not saved", message: (e as Error).message }); }
          }}
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

      {/* ── SLIM GLASS TOP BAR ───────────────────────────────────────── */}
      <div
        className="h-11 shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)]/70 z-30 flex items-center gap-2 px-3"
        style={{ backdropFilter: "blur(20px) saturate(180%)", WebkitBackdropFilter: "blur(20px) saturate(180%)" }}
      >
        <button
          onClick={() => router.push("/documents")}
          className="h-7 w-7 rounded-md hover:bg-[var(--color-surface-2)] flex items-center justify-center shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          title="Back to libraries"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>

        {/* Breadcrumb — each segment wears its folder's own icon + color;
            deep paths fold their middle into a "…" menu. */}
        <PathBar
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

        <div className="flex-1" />

        {/* Search */}
        <div className="relative group">
          <Search className="w-3.5 h-3.5 text-[var(--color-text-faint)] absolute left-2.5 top-1/2 -translate-y-1/2 group-focus-within:text-[var(--color-text)] transition-colors pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter…"
            className="pl-7 pr-2 h-8 sm:h-7 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]/60 focus:bg-[var(--color-surface)] focus:outline-none focus:ring-2 focus:ring-blue-500/30 w-32 sm:w-44 text-base sm:text-xs font-medium transition-all"
          />
        </div>

        {/* Library quick-jump (folders + sheets in this library, plus
            in-library actions). ⌘K is the global palette. */}
        <button
          onClick={() => setCommandOpen(true)}
          className="hidden sm:flex items-center gap-1.5 h-7 px-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]/60 hover:bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-[11px] font-medium transition-all"
          title="Jump to a folder or sheet in this library"
        >
          <Search className="w-3 h-3" />
          <span>Find in library</span>
        </button>

        <div className="h-4 w-px bg-slate-200 mx-0.5" />

        {/* Subscribe to this library: watchers get notified when documents
            are added or revised here — no more finding out by accident. */}
        {activeOrgId && uid && (
          <WatchButton orgId={activeOrgId} userId={uid} resourceType="library" resourceId={libraryId} size="sm" />
        )}

        <button
          onClick={() => fileInputRef.current?.click()}
          className="h-7 px-2 rounded-md hover:bg-[var(--color-surface-2)] flex items-center gap-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-xs font-bold transition-colors"
          title="Upload files"
        >
          <UploadCloud className="w-3.5 h-3.5" />
          <span className="hidden md:inline">Upload</span>
        </button>

        {/* Upload a whole FOLDER — its subfolder tree is recreated here.
            (Dropping a folder from the OS onto the file area does the same.) */}
        {isController && (
          <button
            onClick={() => folderInputRef.current?.click()}
            className="h-7 px-2 rounded-md hover:bg-[var(--color-surface-2)] flex items-center gap-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-xs font-bold transition-colors"
            title="Upload a folder — subfolders and their files keep their structure"
          >
            <FolderPlus className="w-3.5 h-3.5" />
            <span className="hidden md:inline">Upload folder</span>
          </button>
        )}

        {/* New folder is a FIRST-CLASS action, right beside Upload — creating
            structure is as basic as adding files; it must never hide in an
            overflow menu. Creates inside whatever folder you're viewing. */}
        {isController && (
          <button
            onClick={openCreateFolder}
            className="h-7 px-2 rounded-md hover:bg-[var(--color-surface-2)] flex items-center gap-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-xs font-bold transition-colors"
            title="New folder (created inside the folder you're viewing)"
          >
            <FolderPlus className="w-3.5 h-3.5" />
            <span className="hidden md:inline">New folder</span>
          </button>
        )}

        {/* Overflow menu for secondary actions */}
        <div className="relative">
          <button
            onClick={() => setActionsMenuOpen((v) => !v)}
            className="h-7 w-7 rounded-md hover:bg-[var(--color-surface-2)] flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            title="More actions"
          >
            <MoreHorizontal className="w-3.5 h-3.5" />
          </button>
          {actionsMenuOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setActionsMenuOpen(false)} />
              <div
                className="absolute right-0 top-full mt-1 w-48 bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] ring-1 ring-black/5 rounded-xl shadow-lg z-40 overflow-hidden animate-in fade-in zoom-in-95 duration-150 origin-top-right"
              >
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); setNumberingOpen(true); }}
                    className="w-full px-3 py-2 text-left text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center gap-2"
                  >
                    <Hash className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> Auto-numbering…
                  </button>
                )}
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); openCreateFolder(); }}
                    className="w-full px-3 py-2 text-left text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center gap-2"
                  >
                    <FolderPlus className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> New folder
                  </button>
                )}
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); setShowColumnManager(true); }}
                    className="w-full px-3 py-2 text-left text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center gap-2"
                  >
                    <Columns className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> Manage columns
                  </button>
                )}
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); setShowLibraryOrderModal(true); }}
                    className="w-full px-3 py-2 text-left text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center gap-2"
                  >
                    <GripVertical className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> Reorder documents
                  </button>
                )}
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); setReviewPolicyTarget({ level: "library", id: libraryId, name: library?.name }); }}
                    className="w-full px-3 py-2 text-left text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center gap-2"
                    title="Assign the accountable owner and set a periodic-review cycle for every document in this library"
                  >
                    <CalendarClock className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> Ownership &amp; review cycle
                  </button>
                )}
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); setAckPolicyTarget({ level: "library", id: libraryId, name: library?.name }); }}
                    className="w-full px-3 py-2 text-left text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center gap-2"
                    title="Require read-&-understood acknowledgment for every document in this library"
                  >
                    <ClipboardCheck className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> Read &amp; understood
                  </button>
                )}
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); setReviewControlTarget({ level: "library", id: libraryId, name: library?.name }); }}
                    className="w-full px-3 py-2 text-left text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center gap-2"
                    title="Require reviewer sign-off before a revision publishes in this library"
                  >
                    <ShieldCheck className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> Pre-publish review
                  </button>
                )}
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); setRetentionTarget({ level: "library", id: libraryId, name: library?.name }); }}
                    className="w-full px-3 py-2 text-left text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center gap-2"
                    title="Set a retention period for records in this library"
                  >
                    <Archive className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> Retention
                  </button>
                )}
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); void openTrash(); }}
                    className="w-full px-3 py-2 text-left text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center gap-2"
                    title="Deleted folders are held for 30 days and can be restored here"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> Recently deleted…
                  </button>
                )}
                {(isController || isLibraryOwner) && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); setRecertOpen(true); }}
                    className="w-full px-3 py-2 text-left text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center gap-2"
                    title="Review and re-attest who has access to this library"
                  >
                    <KeyRound className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> Access recertification
                  </button>
                )}
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); setShowCsvImport(true); }}
                    className="w-full px-3 py-2 text-left text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center gap-2"
                    title="Bulk-create document records from a pasted CSV"
                  >
                    <FileText className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> Import from CSV
                  </button>
                )}
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); setShowLibraryPerms(true); }}
                    className="w-full px-3 py-2 text-left text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center gap-2"
                    title="Grant who can publish revisions / control documents in this library (e.g. a Drafting Supervisor on drawings only)"
                  >
                    <Shield className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> Library access
                  </button>
                )}
                <button
                  onClick={() => { setActionsMenuOpen(false); setShowViewSelector((v) => !v); }}
                  className="w-full px-3 py-2 text-left text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center gap-2"
                >
                  <Eye className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> Views & save current
                </button>
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); setShowArchivedDocs((v) => !v); }}
                    className="w-full px-3 py-2 text-left text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center gap-2"
                  >
                    <Archive className="w-3.5 h-3.5 text-[var(--color-text-faint)]" />
                    {showArchivedDocs ? "Hide archived docs" : "Show archived docs"}
                  </button>
                )}
                <button
                  onClick={() => { setActionsMenuOpen(false); window.location.reload(); }}
                  className="w-full px-3 py-2 text-left text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center gap-2"
                >
                  <RefreshCw className={`w-3.5 h-3.5 text-[var(--color-text-faint)] ${loadingDocs ? "animate-spin" : ""}`} /> Refresh
                </button>
              </div>
            </>
          )}
        </div>
      </div>

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

        {/* MAIN AREA — full width, no inspector grid */}
        <div className={`flex-1 overflow-auto p-3 lg:p-4 ${stagedDocs.length > 0 ? "pb-20" : ""}`}>
          <div className="max-w-[1920px] mx-auto">

            {/* Phase 2 + 3: Curated Collections + Favorites */}
            {library && activeOrgId && uid && (
              <div className="mb-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl shadow-sm overflow-hidden">
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
                  orgId={activeOrgId}
                  libraryId={libraryId}
                  userId={uid}
                  userRole={activeRole}
                  userRoles={roles}
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

            {/* Subtle hint for admins inside a folder — columns are library-wide */}
            {isController && currentFolderId && (
              <div className="mb-2 px-3 py-2 bg-blue-50/60 border border-blue-200 rounded-lg text-[11px] text-[var(--color-text)] flex items-center gap-2">
                <Columns className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                <span>
                  Columns shown here apply to <b>every folder</b> in <b>{library?.name}</b>. To rename, reorder, or add columns,
                  open <button onClick={() => setShowColumnManager(true)} className="font-bold text-blue-700 underline hover:text-blue-800">Library Column Manager</button>.
                </span>
              </div>
            )}

            {/* CUSTOMIZABLE HOME — library root OR folder; opt-in, default off */}
            {!currentFolderId && library && (
              <LibraryHomeBoard
                node={{ name: library.name, description: library.description, icon: library.icon, homeConfig: library.homeConfig }}
                folders={folders.filter((f) => !f.parentId)}
                documents={documents}
                canEdit={isController}
                onOpenFolder={(id) => setCurrentFolderId(id)}
                onOpenDoc={(doc) => setSelectedDoc(doc)}
                onSave={async (cfg) => {
                  await supabase.from("libraries").update({ home_config: cfg, updated_by: uid }).eq("id", library.id!);
                  setLibrary((prev) => (prev ? { ...prev, homeConfig: cfg } : prev));
                }}
              />
            )}
            {currentFolderId && currentFolder && (
              <LibraryHomeBoard
                key={currentFolderId}
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

            {/* BROWSER CARD */}
            <div
              className={`bg-[var(--color-surface)] border rounded-2xl shadow-sm overflow-hidden flex flex-col min-h-[500px] relative transition-all duration-150 focus:outline-none ${
                isDragOver ? "border-blue-400 ring-4 ring-blue-100" : "border-[var(--color-border)]"
              }`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              tabIndex={0}
              onKeyDown={handleExplorerKeyDown}
            >
              {/* Drag overlay */}
              {isDragOver && (
                <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-blue-50/95 pointer-events-none">
                  <div className="w-20 h-20 rounded-2xl bg-blue-100 border-2 border-blue-400 border-dashed flex items-center justify-center mb-4">
                    <UploadCloud className="w-9 h-9 text-blue-500" />
                  </div>
                  <p className="text-lg font-bold text-blue-700">Drop files or folders to upload</p>
                  <p className="text-sm text-blue-500 mt-1">
                    Release to add to {currentFolder ? `"${currentFolder.name}"` : "this library"} — a dropped folder keeps its subfolder structure
                  </p>
                </div>
              )}

              {/* FOLDERS GRID */}
              {filteredFolders.length > 0 && (
                <div className="p-5 border-b border-[var(--color-border)] bg-[var(--color-surface-2)]/40">
                  <h3 className="text-xs font-bold text-[var(--color-text-faint)] uppercase tracking-wider mb-3 flex items-center">
                    <LayoutGrid className="w-3 h-3 mr-1.5" /> Folders
                  </h3>
                  <FolderGrid
                    folders={filteredFolders}
                    allFolders={folders}
                    onOpen={(id) => setCurrentFolderId(id)}
                    onRename={isController ? (id) => { setRenameFolderId(id); setRenameValue(folderMap.get(id)?.name || ""); } : undefined}
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
                    onDelete={isController ? (id) => void handleDeleteFolder(id) : undefined}
                    isController={isController}
                    selectedIds={selectedFolderIds}
                    onTileSelect={handleFolderTileSelect}
                  />
                </div>
              )}

              {/* DOCUMENTS SECTION */}
              <div className="flex-1 flex flex-col">
                {/* Advisory: someone else has live edit work on a doc I'm
                    also editing (edit×edit only — views never trigger it). */}
                {activeOrgId && uid && (
                  <div className="px-4 pt-2">
                    <EditOverlapBanner
                      orgId={activeOrgId}
                      currentUserId={uid}
                      currentUserName={userEmail?.split("@")[0] ?? null}
                    />
                  </div>
                )}
                {docStreamProgress !== null && (
                  <div className="px-4 py-1.5 bg-blue-50 border-b border-blue-200 text-[11px] text-blue-900 flex items-center gap-2">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Loading the rest of this folder… <b>{docStreamProgress.toLocaleString()}</b> so far. Sorting covers everything once done.
                  </div>
                )}
                {docFetchHitCap && !loadingDocs && docStreamProgress === null && (
                  <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-[11px] text-amber-900">
                    Showing the first <b>10,000</b> documents (newest first) — this folder holds more. Use the filter box or subfolders to narrow it.
                  </div>
                )}
                <div className="px-5 py-3 border-b border-[var(--color-border)] flex items-center gap-3 bg-[var(--color-surface)]">
                  <h3 className="text-sm font-bold text-[var(--color-text)] flex items-center gap-2 shrink-0">
                    <FileText className="w-4 h-4 text-[var(--color-text-faint)]" />
                    Documents
                    <span className="text-xs font-medium text-[var(--color-text-faint)] bg-[var(--color-surface-2)] px-2 py-0.5 rounded-full">{filteredDocs.length}</span>
                  </h3>

                  {/* Live filter — typing instantly narrows the table to just the
                      matching files (acts like autocomplete). Matches the number,
                      title, sheet #, rev, status and any custom column value. */}
                  <div className="relative flex-1 max-w-md">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-faint)] pointer-events-none" />
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Filter this folder — number, title, sheet #, any field…"
                      className="w-full pl-8 pr-7 py-1.5 text-base sm:text-xs rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40 focus:border-[var(--color-accent)] transition-shadow"
                    />
                    {search && (
                      <button
                        onClick={() => setSearch("")}
                        title="Clear filter"
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)] transition-colors"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {loadingUpload && (
                      <div className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        {uploadProgress
                          ? `Uploading ${uploadProgress.done} of ${uploadProgress.total}…`
                          : "Preparing upload…"}
                      </div>
                    )}
                    {/* Layout switcher — Details / List / Grid / Thumbnails.
                        Same selection, same gestures, different geometry. */}
                    <div className="hidden md:inline-flex items-center rounded-lg border border-[var(--color-border)] overflow-hidden" role="group" aria-label="Layout">
                      {([
                        { key: "details" as ExplorerLayout, icon: <TableIcon className="w-3.5 h-3.5" />, label: "Details" },
                        { key: "list" as ExplorerLayout, icon: <ListIcon className="w-3.5 h-3.5" />, label: "List" },
                        { key: "grid" as ExplorerLayout, icon: <LayoutGrid className="w-3.5 h-3.5" />, label: "Grid" },
                        { key: "thumbs" as ExplorerLayout, icon: <ImageIcon className="w-3.5 h-3.5" />, label: "Thumbnails" },
                      ]).map((opt) => (
                        <button
                          key={opt.key}
                          onClick={() => setDocLayout(opt.key)}
                          title={opt.label}
                          aria-pressed={docLayout === opt.key}
                          className={`px-2 py-1.5 transition-colors ${
                            docLayout === opt.key
                              ? "bg-slate-900 text-white"
                              : "bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
                          }`}
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
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold border transition-all ${
                          viewMenuOpen
                            ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                            : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
                        }`}
                      >
                        {savingSortDefault ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
                        <span className="hidden lg:inline">View</span>
                        <ChevronDown className="w-3 h-3" />
                      </button>
                      {viewMenuOpen && (
                        <>
                          <div className="fixed inset-0 z-40" onClick={() => setViewMenuOpen(false)} />
                          <div className="absolute right-0 top-full mt-1.5 z-50 w-72 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl shadow-xl py-2">
                            <div className="px-3 pb-2 border-b border-[var(--color-border)]">
                              <div className="text-[11px] font-black text-[var(--color-text)]">
                                {currentFolder ? `Folder: ${currentFolder.name}` : `Library: ${library?.name ?? ""}`}
                              </div>
                              <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5 leading-snug">
                                Current: {docLayout === "details" ? "Details" : docLayout === "list" ? "List" : docLayout === "grid" ? "Grid" : "Thumbnails"} · sorted by {sortLabelFor(sortKey)} ({sortDir === "asc" ? "ascending" : "descending"})
                                {isFolderDefaultSort ? " · saved default sort" : ""}
                              </div>
                            </div>
                            <button
                              onClick={() => { setViewMenuOpen(false); void saveViewDefault("user"); }}
                              className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
                            >
                              <Pin className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                              <span className="flex-1">
                                Set as <b>my</b> default here
                                <span className="block text-[10px] font-normal text-[var(--color-text-muted)]">Only you — wins over the org default</span>
                              </span>
                              {viewDefaults.hasUserRow && <Check className="w-3.5 h-3.5 text-emerald-600" />}
                            </button>
                            {isController && (
                              <button
                                onClick={() => { setViewMenuOpen(false); void saveViewDefault("org"); }}
                                className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
                              >
                                <Shield className="w-3.5 h-3.5 text-[var(--color-accent)]" />
                                <span className="flex-1">
                                  Set as <b>org-wide</b> default here
                                  <span className="block text-[10px] font-normal text-[var(--color-text-muted)]">Everyone opens this folder like this</span>
                                </span>
                                {viewDefaults.hasOrgRow && <Check className="w-3.5 h-3.5 text-emerald-600" />}
                              </button>
                            )}
                            {viewDefaults.hasUserRow && (
                              <button
                                onClick={() => { setViewMenuOpen(false); void clearMyViewDefault(); }}
                                className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"
                              >
                                <X className="w-3.5 h-3.5" />
                                <span className="flex-1">
                                  Clear my default (use org&apos;s)
                                  <span className="block text-[10px] font-normal">Removes your saved layout, sort AND column setup here</span>
                                </span>
                              </button>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                    {isController && (
                      <button
                        onClick={() => setShowEquipmentSweep(true)}
                        title="Equipment sweep — pull AI-extracted equipment tags from indexed drawings into your equipment column and the registry"
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold border border-orange-200 bg-orange-50/60 text-orange-700 hover:bg-orange-100 hover:border-orange-300 transition-all"
                      >
                        <ScanSearch className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Equipment</span>
                      </button>
                    )}
                    {isController && (
                      <button
                        onClick={() => setShowColumnManager(true)}
                        title="Configure columns — hide, rename, or reorder"
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-border-strong)] transition-all"
                      >
                        <Columns className="w-3.5 h-3.5" /> Columns
                      </button>
                    )}
                  </div>
                </div>

                {!loadingDocs && filteredDocs.length === 0 && filteredFolders.length === 0 ? (
                  /* INTERACTIVE EMPTY STATE */
                  <div className="flex-1 flex flex-col items-center justify-center p-12">
                    <div className="w-20 h-20 rounded-2xl bg-[var(--color-surface-2)] border-2 border-dashed border-[var(--color-border)] flex items-center justify-center mb-5">
                      <UploadCloud className="w-8 h-8 text-slate-300" />
                    </div>
                    <h3 className="text-base font-bold text-[var(--color-text)] mb-1">Nothing here yet</h3>
                    <p className="text-sm text-[var(--color-text-muted)] text-center max-w-xs mb-6">
                      Drag and drop files into this window, or use the buttons below to add your first document or folder.
                    </p>
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        className="flex items-center gap-2 px-5 py-2.5 bg-slate-900 text-white rounded-xl text-sm font-bold hover:bg-slate-800 transition-colors shadow-sm"
                      >
                        <UploadCloud className="w-4 h-4" /> Upload Files
                      </button>
                      {isController && (
                        <button
                          onClick={openCreateFolder}
                          className="flex items-center gap-2 px-5 py-2.5 bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text)] rounded-xl text-sm font-bold hover:bg-[var(--color-surface-2)] transition-colors"
                        >
                          <FolderPlus className="w-4 h-4" /> New Folder
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <>
                  {/* MOBILE CARD LIST — the table is unusable on a phone, so
                      below md we render tappable cards of the same docs. */}
                  <div className="md:hidden flex-1 overflow-y-auto p-2 space-y-2">
                    {sortedDocs.length === 0 ? (
                      <div className="text-center text-xs text-[var(--color-text-faint)] py-8">No documents.</div>
                    ) : sortedDocs.map((doc) => (
                      <button
                        key={doc.id}
                        onClick={() => setSelectedDoc(doc)}
                        className="w-full text-left bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-3 shadow-sm active:bg-[var(--color-surface-2)] flex items-start gap-3"
                      >
                        <DocThumb documentId={doc.id} width={40} className="mt-0.5" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs font-bold text-[var(--color-text)] truncate flex-1">{doc.documentNumber || doc.title || doc.name || "—"}</span>
                            {doc.rev && <span className="text-[10px] font-bold bg-[var(--color-surface-2)] text-[var(--color-text-muted)] px-1.5 py-0.5 rounded shrink-0">Rev {doc.rev}</span>}
                          </div>
                          {doc.title && doc.documentNumber && <div className="text-xs text-[var(--color-text-muted)] truncate mt-0.5">{doc.title}</div>}
                          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                            {doc.status && <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border ${stateStyle(documentState(doc.status)).pill}`}>{doc.status}</span>}
                            {doc.checkedOutBy && <span className="text-[10px] font-bold text-blue-700">Checked out{doc.checkedOutByName ? ` · ${doc.checkedOutByName}` : ""}</span>}
                          </div>
                        </div>
                      </button>
                    ))}
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
                  <div
                    data-doc-marquee
                    className="flex-1 overflow-x-auto hidden md:block"
                    onClick={(e) => { if (e.target === e.currentTarget) clearSelection(); }}
                    onMouseDown={handleMarqueeMouseDown}
                  >
                    <table className="w-full text-left text-sm table-fixed min-w-[640px]">
                      <thead className="bg-slate-50/70 border-b border-[var(--color-border)] text-[10px] text-[var(--color-text-muted)] uppercase font-black tracking-wider">
                        <tr>
                          <th className={`px-3 ${headerPad}`} style={{ width: "36px" }}>
                            <input
                              type="checkbox"
                              checked={allSelected}
                              ref={(el) => { if (el) el.indeterminate = someSelected; }}
                              onChange={toggleSelectAll}
                              className="w-3.5 h-3.5 rounded accent-blue-600 cursor-pointer"
                            />
                          </th>
                          {activeColumns.map((colKey) => {
                            const builtinLabel = BUILTIN_COLUMNS.find((c) => c.key === colKey)?.label
                              ?? OPTIONAL_BUILTIN_COLUMNS.find((c) => c.key === colKey)?.label;
                            const overrideLabel = library?.columnLabelOverrides?.[colKey];
                            const label = overrideLabel || builtinLabel || columnMap.get(colKey)?.label || colKey;
                            const width = getColWidth(colKey);
                            const isResized = !!colWidths[colKey];
                            return (
                              <th
                                key={colKey}
                                className={`relative px-2 ${headerPad} cursor-pointer hover:bg-[var(--color-surface-2)] select-none transition-colors group`}
                                style={width ? { width } : undefined}
                                onClick={() => handleSort(colKey)}
                              >
                                <div className="flex items-center gap-1 min-w-0 pr-2">
                                  <span className="truncate flex-1">{label}</span>
                                  {sortKey === colKey ? (
                                    sortDir === "asc"
                                      ? <ChevronUp className="w-3 h-3 text-blue-600 shrink-0" />
                                      : <ChevronDown className="w-3 h-3 text-blue-600 shrink-0" />
                                  ) : (
                                    <ArrowUpDown className="w-3 h-3 text-slate-300 group-hover:text-[var(--color-text-muted)] shrink-0" />
                                  )}
                                </div>

                                {/* Right-edge resize handle — admin/DocCtrl only.
                                    Always-visible vertical bar with a wide hit zone. Brightens on hover. */}
                                {isController && (
                                  <div
                                    onPointerDown={(e) => handleResizeStart(e, colKey)}
                                    onDoubleClick={(e) => handleResizeReset(e, colKey)}
                                    onClick={(e) => e.stopPropagation()}
                                    title={isResized ? "Drag to resize · double-click to reset" : "Drag to resize column"}
                                    style={{ touchAction: "none" }}
                                    className="absolute top-0 right-0 h-full w-2.5 cursor-col-resize flex items-center justify-center group/grip z-10 hover:bg-blue-100/60"
                                  >
                                    <div className={`h-2/3 w-[3px] rounded-full transition-colors ${
                                      isResized ? "bg-blue-600" : "bg-slate-400 group-hover/grip:bg-blue-600"
                                    }`} />
                                  </div>
                                )}
                              </th>
                            );
                          })}
                          <th className={`px-2 ${headerPad} text-center`} style={{ width: "200px" }}>Checkout</th>
                          <th className={`px-2 ${headerPad} text-center`} style={{ width: "36px" }} title="Reference Stack">
                            <Layers className="w-3 h-3 inline text-slate-300" />
                          </th>
                          <th className={`px-2 ${headerPad} text-center print:hidden`} style={{ width: "44px" }}>
                            <ColumnHeaderMenu onAdd={handleAddColumnClick} isController={isController} />
                          </th>
                          <th style={{ width: "36px" }} />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--color-border)]">
                        {loadingDocs ? (
                          <tr>
                            <td colSpan={activeColumns.length + 5} className="px-6 py-12 text-center text-[var(--color-text-muted)]">
                              <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />Loading…
                            </td>
                          </tr>
                        ) : sortedDocs.length === 0 ? (
                          <tr>
                            <td colSpan={activeColumns.length + 5} className="px-6 py-10 text-center text-[var(--color-text-faint)] text-sm italic">
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
                                  isRowSelected
                                    ? "bg-blue-50/70"
                                    : isFocused
                                    ? "bg-[var(--color-surface-2)]"
                                    : "hover:bg-slate-50/60"
                                } ${isKeyFocused ? "outline outline-1 -outline-offset-1 outline-blue-400" : ""} ${cutDocIds.has(docRecord.id!) ? "opacity-50" : ""}`}
                              >
                                {/* Left edge accent on selected row */}
                                {(isRowSelected || isFocused) && (
                                  <td className="absolute left-0 top-0 bottom-0 w-0.5 bg-gradient-to-b from-blue-400 to-blue-600 p-0" />
                                )}
                                <td className={`px-3 ${rowPad}`} onClick={(e) => toggleSelectDoc(docRecord.id!, e)}>
                                  <input
                                    type="checkbox"
                                    checked={isRowSelected}
                                    onChange={() => {}}
                                    className="w-3.5 h-3.5 rounded accent-blue-600 cursor-pointer"
                                  />
                                </td>
                                {activeColumns.map((colKey) => {
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
                                      <td key={colKey} className={`px-3 ${rowPad} align-top`}>
                                        <PillCell
                                          values={list}
                                          label={def.pillGroupLabel || def.label || "Equipment"}
                                          canEdit={isController || !hasAnyRole(["Viewer", "Auditor"])}
                                          orgId={activeOrgId ?? undefined}
                                          userId={uid ?? undefined}
                                          canManageAssets={hasAnyRole(["Admin", "Manager", "Supervisor", "Drafter"]) || roles.some((r) => r.includes("Engineer"))}
                                          onSave={async (newVals) => {
                                            const newMeta = { ...(docRecord.metadata ?? {}), [colKey]: newVals };
                                            // Optimistic local update so the chip
                                            // doesn't revert on edit-exit before
                                            // the DB write lands.
                                            setDocuments((prev) => prev.map((d) =>
                                              d.id === docRecord.id ? { ...d, metadata: newMeta } : d
                                            ));
                                            await supabase.from("documents").update({
                                              metadata: newMeta,
                                              updated_at: new Date().toISOString(),
                                            }).eq("id", docRecord.id);
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
                                              className="w-full text-sm px-1.5 py-0.5 rounded border border-blue-400 bg-blue-50 focus:outline-none focus:ring-1 focus:ring-[var(--color-accent-ring)]"
                                            />
                                            {savingTitle && <Loader2 className="w-3 h-3 animate-spin text-[var(--color-text-muted)] shrink-0" />}
                                          </div>
                                        </td>
                                      );
                                    }
                                    return (
                                      <td key={colKey} className={`px-3 ${rowPad}`}>
                                        <div className="min-w-0">
                                          <div className="text-sm font-semibold text-[var(--color-text)] truncate leading-tight">
                                            {docRecord.title || docRecord.name || "Untitled"}
                                          </div>
                                          {!hasSeparateDocNum && docRecord.documentNumber && (
                                            <div className="text-[10px] font-mono text-[var(--color-text-faint)] truncate mt-0.5">
                                              {docRecord.documentNumber}
                                            </div>
                                          )}
                                        </div>
                                      </td>
                                    );
                                  }

                                  // Status pill rendering
                                  if (colKey === "status") {
                                    const s = docRecord.status || "—";
                                    const tone =
                                      s === "Issued" ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                      : s === "Draft" ? "bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-[var(--color-border)]"
                                      : s === "Superseded" ? "bg-amber-50 text-amber-700 border-amber-200"
                                      : s === "Void" || s === "Archived" ? "bg-red-50 text-red-700 border-red-200"
                                      : s === "Locked" ? "bg-blue-50 text-blue-700 border-blue-200"
                                      : "bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-[var(--color-border)]";
                                    return (
                                      <td key={colKey} className={`px-3 ${rowPad}`}>
                                        <span className={`inline-flex items-center text-[10px] font-bold border px-1.5 py-0.5 rounded-md ${tone}`}>
                                          {s}
                                        </span>
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
                                              className={`w-full text-xs font-mono px-1.5 py-0.5 rounded border ${editingDocNumError ? "border-red-400 bg-red-50" : "border-blue-400 bg-blue-50"} focus:outline-none focus:ring-1 focus:ring-[var(--color-accent-ring)]`}
                                            />
                                            {savingDocNum && <Loader2 className="w-3 h-3 animate-spin text-[var(--color-text-muted)] shrink-0" />}
                                          </div>
                                        ) : (
                                          <button
                                            type="button"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setEditingDocNumId(docRecord.id!);
                                              setEditingDocNumValue(docRecord.documentNumber || "");
                                              setEditingDocNumError(null);
                                            }}
                                            className="w-full text-left text-xs font-mono text-[var(--color-text)] truncate hover:bg-blue-50 hover:text-blue-900 px-1 -mx-1 rounded transition-colors"
                                            title="Click to rename"
                                          >
                                            {docRecord.documentNumber || "-"}
                                          </button>
                                        )}
                                        {isEditing && editingDocNumError && (
                                          <div className="text-[10px] text-red-600 mt-0.5 max-w-[20ch] leading-tight">{editingDocNumError}</div>
                                        )}
                                      </td>
                                    );
                                  }

                                  // Generic cell — truncate to prevent overflow
                                  return (
                                    <td key={colKey} className={`px-3 ${rowPad} text-[var(--color-text)] text-xs truncate`}>
                                      <div className="truncate">{renderDocCell(docRecord, colKey)}</div>
                                    </td>
                                  );
                                })}
                                <td className={`px-2 ${rowPad}`}>
                                  <CheckoutStatusCell
                                    docRecord={docRecord}
                                    currentUserId={uid ?? undefined}
                                    currentUserEmail={userEmail ?? undefined}
                                    userRole={activeRole}
                                    userRoles={roles}
                                    onCheckout={openCheckout}
                                  />
                                </td>
                                <td className={`px-2 ${rowPad} text-center`}>
                                  {(() => {
                                    const isStaged = stagedDocs.some((d) => d.id === docRecord.id);
                                    return (
                                      <button
                                        onClick={(e) => handleStageDoc(docRecord, e)}
                                        className={`p-1 rounded-md transition-all ${
                                          isStaged
                                            ? "text-orange-500 bg-orange-50 ring-1 ring-orange-200 opacity-100"
                                            : "text-slate-300 hover:text-orange-500 hover:bg-orange-50 opacity-60 sm:opacity-0 group-hover:opacity-100"
                                        }`}
                                        title={isStaged ? "Remove from Reference Stack" : "Add to Reference Stack"}
                                      >
                                        <Layers className="w-3 h-3" />
                                      </button>
                                    );
                                  })()}
                                </td>
                                <td className={`px-2 ${rowPad} text-center`}>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); setSelectedDoc(docRecord); setShowMetadataEditor(true); }}
                                    className="text-slate-300 hover:text-[var(--color-text)] p-1 rounded-md hover:bg-[var(--color-surface-2)] transition-all opacity-60 sm:opacity-0 group-hover:opacity-100"
                                    title="Edit metadata"
                                  >
                                    <Pencil className="w-3 h-3" />
                                  </button>
                                </td>
                                <td />
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                  )}
                  </>
                )}
              </div>
            </div>

          </div>
        </div>
      </div>

      {/* INSPECTOR DRAWER — overlays the table, never compresses it */}
      <InspectorDrawer
        isOpen={!!selectedDoc}
        onClose={() => setSelectedDoc(null)}
        title={selectedDoc?.documentNumber || selectedDoc?.title || "Inspector"}
      >
        {selectedDoc && (
          <InspectorPanel
            selectedDoc={selectedDoc}
            selectedVersion={selectedVersion}
            activeRole={activeRole}
            activeRoles={roles}
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
            onOpenMarkup={(m) => {
              void (async () => {
                if (!selectedDoc?.id) return;
                if (selectedVersion?.id !== m.versionId) {
                  const vs = await listVersions(selectedDoc.id).catch(() => [] as DocumentVersion[]);
                  const v = vs.find((x) => x.id === m.versionId);
                  if (!v) { void appAlert({ title: "Revision not found", message: "The revision this markup was drawn on is no longer available." }); return; }
                  setSelectedVersion(v);
                }
                setPendingMarkup(m);
                setShowFullScreen(true);
              })();
            }}
            markupsRefreshKey={markupsRefreshKey}
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

      {/* MARQUEE (rubber-band) selection rectangle */}
      {marquee && (
        <div
          className="fixed z-[85] border border-blue-400 bg-blue-400/10 pointer-events-none rounded-sm"
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

      {/* Persistent discoverability hint — teaches that bulk actions exist,
          shown only when nothing's selected and there are rows to act on. The
          full action bar (below) takes over the moment a row is checked. */}
      {selectedDocIds.size === 0 && sortedDocs.length > 0 && (
        <div className={`fixed left-1/2 -translate-x-1/2 z-30 ${stagedDocs.length > 0 ? "bottom-16" : "bottom-10"} pointer-events-none`}>
          <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-slate-900/80 text-slate-300 text-[11px] font-bold shadow-lg" style={{ backdropFilter: "blur(12px)" }}>
            <CheckSquare className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> Select rows for bulk actions
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
          className="flex items-center gap-2 px-4 py-2.5 bg-slate-900/95 text-white rounded-2xl shadow-2xl border border-slate-700/60"
          style={{ backdropFilter: "blur(20px) saturate(200%)" }}
        >
          <span className="text-xs font-bold">{selectedDocIds.size} selected</span>
          <div className="h-4 w-px bg-slate-700 mx-1" />
          <button
            onClick={() => setSelectedDocIds(new Set())}
            className="px-2.5 py-1 text-[11px] font-bold text-slate-300 hover:text-white hover:bg-slate-700/60 rounded-lg transition-colors"
          >
            Deselect
          </button>
          <button
            onClick={() => setShowBulkMoveModal(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-bold bg-blue-500 hover:bg-blue-600 rounded-lg transition-all active:scale-95"
            title="Move all selected documents to a folder"
          >
            <ArrowRight className="w-3 h-3" /> Move to…
          </button>
          <button
            onClick={handleStageSelected}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-bold bg-orange-500 hover:bg-orange-600 rounded-lg transition-all active:scale-95"
          >
            <Layers className="w-3 h-3" /> Stage
          </button>
          <button
            onClick={() => setShowBulkCheckout(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-bold bg-indigo-500 hover:bg-indigo-600 rounded-lg transition-all active:scale-95"
            title="Bulk-check-out selected docs — ad-hoc or to a project"
          >
            <Briefcase className="w-3 h-3" /> Bulk Checkout
          </button>
          {isController && (
            <button
              onClick={() => setShowBulkEdit(true)}
              className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-bold bg-violet-500 hover:bg-violet-600 rounded-lg transition-all active:scale-95"
              title="Apply one metadata change across all selected docs"
            >
              <Pencil className="w-3 h-3" /> Bulk Edit
            </button>
          )}
          {isController && (
            <button
              onClick={handleBulkArchive}
              className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-bold bg-amber-500/90 hover:bg-amber-500 rounded-lg transition-all active:scale-95"
              title="Mark selected as Archived (preserves history)"
            >
              <Archive className="w-3 h-3" /> Archive
            </button>
          )}
          {isController && (
            <button
              onClick={handleBulkDelete}
              className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-bold bg-red-500/90 hover:bg-red-500 rounded-lg transition-all active:scale-95"
            >
              <Trash2 className="w-3 h-3" /> Delete
            </button>
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
        files={pendingUploadFiles}
        customColumns={(library?.customColumns ?? []) as unknown as CustomColumnDef[]}
        defaultStatus="Issued"
        onCancel={() => { setShowStagingModal(false); setPendingUploadFiles([]); uploadPathsRef.current = new Map(); uploadFolderPlanRef.current = null; }}
        onSubmit={handleStagedUpload}
        onAddColumn={isController ? () => { setWizardInitType("text"); setWizardInitStep(2); setShowCreateColumn(true); } : undefined}
        uniquenessKeys={library?.uniquenessKeys}
        onAddSheetAndUseForUniqueness={isController ? handleAddSheetAndUseForUniqueness : undefined}
      />

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
          userRoles={roles}
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
          canEdit={isController || drawerDelegationAuthority}
          delegationOnly={!isController && drawerDelegationAuthority}
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
          canEdit={isController || libraryDelegationAuthority}
          delegationOnly={!isController && libraryDelegationAuthority}
          title={`${library.name} — library access`}
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
          onClose={() => setShowEquipmentSweep(false)}
          onApplied={() => folderDocsCache.current.clear()}
        />
      )}

      {numberingOpen && activeOrgId && (
        <LibraryNumberingModal orgId={activeOrgId} libraryId={libraryId} onClose={() => setNumberingOpen(false)} />
      )}

      {creatingFolder && (
        <div className="fixed inset-0 z-[90] flex items-start sm:items-center justify-center overflow-y-auto bg-slate-900/60 backdrop-blur-sm animate-in fade-in p-4">
          <div className="w-full max-w-md rounded-2xl bg-[var(--color-surface)] shadow-2xl border border-[var(--color-border)] overflow-hidden animate-in fade-in zoom-in-95">
            <div className="px-6 py-4 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] flex items-center justify-between">
              <div>
                <div className="text-sm font-bold text-[var(--color-text)]">Create Folder</div>
                <div className="text-xs text-[var(--color-text-muted)]">Add a new subfolder here.</div>
              </div>
              <button onClick={() => setCreatingFolder(false)} className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)]">
                <X className="h-4 w-4 text-[var(--color-text-muted)]" />
              </button>
            </div>
            <div className="p-6">
              <input
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                placeholder="Folder name"
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm"
                autoFocus
              />
            </div>
            <div className="px-6 py-4 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] flex items-center justify-end gap-2">
              <button
                onClick={() => setCreatingFolder(false)}
                className="px-4 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
              >
                Cancel
              </button>
              <button
                onClick={confirmCreateFolder}
                className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-bold hover:bg-slate-800"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* RECENTLY DELETED FOLDERS — the 30-day delete hold. */}
      {trashFolders !== null && (
        <div className="fixed inset-0 z-[90] flex items-start sm:items-center justify-center overflow-y-auto bg-slate-900/60 backdrop-blur-sm animate-in fade-in p-4" onClick={() => setTrashFolders(null)}>
          <div className="w-full max-w-lg rounded-2xl bg-[var(--color-surface)] shadow-2xl border border-[var(--color-border)] overflow-hidden animate-in fade-in zoom-in-95" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] flex items-center justify-between">
              <div>
                <div className="text-sm font-bold text-[var(--color-text)]">Recently deleted folders</div>
                <div className="text-xs text-[var(--color-text-muted)]">
                  Held for 30 days, then removed for good. Restoring brings the folder back empty at its old spot — its former contents moved up a level when it was deleted.
                </div>
              </div>
              <button onClick={() => setTrashFolders(null)} className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-surface)]">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="max-h-80 overflow-y-auto p-3 space-y-1.5">
              {trashFolders.length === 0 ? (
                <div className="text-center text-xs text-[var(--color-text-faint)] py-8">Nothing in the trash.</div>
              ) : trashFolders.map((f) => (
                <div key={f.id} className="flex items-center gap-3 px-3 py-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40">
                  <Trash2 className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-bold text-[var(--color-text)] truncate">{f.name}</div>
                    <div className="text-[10px] text-[var(--color-text-muted)] truncate">
                      {f.pathNames.length > 1 ? `${f.pathNames.slice(0, -1).join(" / ")} · ` : ""}
                      deleted {new Date(f.deletedAt).toLocaleDateString()} · purges {new Date(f.purgeAt).toLocaleDateString()}
                    </div>
                  </div>
                  <button
                    onClick={() => void restoreFromTrash(f.id)}
                    disabled={trashBusy === f.id}
                    className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold border border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 disabled:opacity-50 transition-all"
                  >
                    {trashBusy === f.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArchiveRestore className="w-3 h-3" />}
                    Restore
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {renameFolderId && !showMoveModal && !showPermissions && (
        <div className="fixed inset-0 z-[90] flex items-start sm:items-center justify-center overflow-y-auto bg-slate-900/60 backdrop-blur-sm animate-in fade-in p-4">
          <div className="w-full max-w-md rounded-2xl bg-[var(--color-surface)] shadow-2xl border border-[var(--color-border)] overflow-hidden animate-in fade-in zoom-in-95">
            <div className="px-6 py-4 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] flex items-center justify-between">
              <div>
                <div className="text-sm font-bold text-[var(--color-text)]">Rename Folder</div>
                <div className="text-xs text-[var(--color-text-muted)]">Update the folder name.</div>
              </div>
              <button onClick={() => setRenameFolderId(null)} className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)]">
                <X className="h-4 w-4 text-[var(--color-text-muted)]" />
              </button>
            </div>
            <div className="p-6">
              <input
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                placeholder="Folder name"
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm"
                autoFocus
              />
            </div>
            <div className="px-6 py-4 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] flex items-center justify-end gap-2">
              <button
                onClick={() => setRenameFolderId(null)}
                className="px-4 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
              >
                Cancel
              </button>
              <button
                onClick={confirmRenameFolder}
                className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-bold hover:bg-slate-800"
              >
                Rename
              </button>
            </div>
          </div>
        </div>
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

  useEffect(() => {
    void import("@/lib/libraryNumbering").then((m) =>
      m.getLibraryNumbering(libraryId).then((c) =>
        setCfg(c ?? { enabled: false, prefix: "", pad: 4, next_number: 1 })));
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
    <div className="fixed inset-0 z-[95] flex items-start sm:items-center justify-center overflow-y-auto bg-slate-900/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-2xl bg-[var(--color-surface)] shadow-2xl border border-[var(--color-border)]">
        <div className="px-5 py-3.5 border-b border-[var(--color-border)] flex items-center gap-2.5">
          <Hash className="w-4 h-4 text-[var(--color-accent)]" />
          <div className="flex-1">
            <div className="text-sm font-black text-[var(--color-text)]">Auto-numbering</div>
            <div className="text-[11px] text-[var(--color-text-muted)]">Uploads with a BLANK number get the next issued one. Typed numbers always win.</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4 text-[var(--color-text-muted)]" /></button>
        </div>
        {cfg === null ? (
          <div className="p-6 text-center text-sm text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin inline" /> Loading…</div>
        ) : (
          <div className="p-5 space-y-3">
            <label className="flex items-center gap-2 text-sm font-bold text-[var(--color-text)] cursor-pointer">
              <input type="checkbox" checked={cfg.enabled}
                onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })}
                className="w-4 h-4 accent-[var(--color-accent)]" />
              Issue numbers automatically in this library
            </label>
            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-1">
                <label className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text)]">Prefix</label>
                <input value={cfg.prefix} onChange={(e) => setCfg({ ...cfg, prefix: e.target.value })}
                  placeholder="PROC-" className="mt-1 w-full px-2.5 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm font-mono" />
              </div>
              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text)]">Digits</label>
                <input type="number" min={1} max={8} value={cfg.pad}
                  onChange={(e) => setCfg({ ...cfg, pad: Math.max(1, Math.min(8, Number(e.target.value) || 4)) })}
                  className="mt-1 w-full px-2.5 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm" />
              </div>
              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text)]">Next #</label>
                <input type="number" min={1} value={cfg.next_number}
                  onChange={(e) => setCfg({ ...cfg, next_number: Math.max(1, Number(e.target.value) || 1) })}
                  className="mt-1 w-full px-2.5 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm" />
              </div>
            </div>
            <div className="text-xs text-[var(--color-text-muted)]">
              Next issued number: <span className="font-mono font-black text-[var(--color-text)]">{preview}</span>
            </div>
            {err && <div className="rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700">{err}</div>}
          </div>
        )}
        <div className="px-5 py-3 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] rounded-b-2xl flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)]">Cancel</button>
          <button onClick={() => void save()} disabled={busy || !cfg}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-black text-white bg-[var(--color-accent)] hover:opacity-90 disabled:opacity-50">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save
          </button>
        </div>
      </div>
    </div>
  );
}
