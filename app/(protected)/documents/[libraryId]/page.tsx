"use client";

import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { stateStyle, documentState } from "@/lib/stateColors";
import { useRole } from "@/components/providers/RoleContext";
import FolderGrid from "@/components/documents/FolderGrid";
import CustomizeNodeModal from "@/components/documents/CustomizeNodeModal";
import LibraryHomeBoard from "@/components/documents/LibraryHomeBoard";
import PageHeader from "@/components/documents/PageHeader";
import PageBackground from "@/components/documents/PageBackground";
import { resolvePageHeader, resolvePageBackground } from "@/lib/pageHeader";
import { NodeIcon } from "@/lib/nodeIcons";
import ColumnManager from "@/components/documents/ColumnManager";
import CreateColumnWizard from "@/components/documents/CreateColumnWizard";
import ColumnHeaderMenu from "@/components/documents/ColumnHeaderMenu";
import CheckoutFlowModal from "@/components/documents/CheckoutFlowModal";
import MetadataEditor from "@/components/documents/MetadataEditor";
import InspectorPanel from "@/components/documents/InspectorPanel";
import CheckoutStatusCell from "@/components/documents/CheckoutStatusCell";
import MoveModal from "@/components/documents/MoveModal";
import HistoryDrawer from "@/components/documents/HistoryDrawer";
import PermissionsDrawer from "@/components/permissions/PermissionDrawer";
import SetManager from "@/components/documents/SetManager";
import StagingTray from "@/components/documents/StagingTray";
import MetadataStagingModal, { type StagedItem, type CustomColumnDef } from "@/components/documents/MetadataStagingModal";
import CollectionsStrip from "@/components/documents/CollectionsStrip";
import FavoritesStrip from "@/components/documents/FavoritesStrip";
import ViewSelector from "@/components/documents/ViewSelector";
import LibraryOrderModal from "@/components/documents/LibraryOrderModal";
import PillCell from "@/components/documents/PillCell";
import FolderRail from "@/components/documents/FolderRail";
import { translatePostgresError } from "@/lib/inputValidation";
import { computeUniquenessKey } from "@/lib/uniqueness";
import CommandPalette from "@/components/documents/CommandPalette";
import StatusFooter from "@/components/documents/StatusFooter";
import InspectorDrawer from "@/components/documents/InspectorDrawer";
import AssetTag from "@/components/ui/AssetTag";
import AssetTagChip from "@/components/assets/AssetTagChip";
import SecureDocViewer from "@/components/viewers/SecureDocViewer";
import FullScreenViewer from "@/components/viewers/FullScreenViewer";
import MultiDocViewer from "@/components/viewers/MultiDocViewer";
import RevUpModal from "@/components/documents/RevUpModal";
import SupersedeModal from "@/components/documents/SupersedeModal";
import ArchiveConfirmModal from "@/components/documents/ArchiveConfirmModal";
import RevertConfirmModal from "@/components/documents/RevertConfirmModal";
import BulkCheckoutToProjectModal from "@/components/documents/BulkCheckoutToProjectModal";
import BulkEditModal from "@/components/documents/BulkEditModal";
import CsvImportModal from "@/components/documents/CsvImportModal";
import RouteLoader from "@/components/ui/RouteLoader";
import { buildAclIndexFromChain } from "@/lib/acl";
import { canDiscover, canWithAclChain, isControllerRole } from "@/lib/permissions";
import { getMyTeamIds } from "@/lib/teams";
import {
  createFolder,
  listenLibraryFolders,
  moveFolderAndDescendants,
  renameFolderAndDescendants,
  updateCollectionAppearance,
  updateCollectionHomeConfig,
} from "@/lib/libraryCollections";
import {
  defaultColumnsFromSchema,
  listenEffectiveColumns,
  saveTableView,
} from "@/lib/tableViews";
import { makeLibraryStoragePath, uploadToPath } from "@/lib/storage";
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
} from "@/types/schema";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpDown,
  Columns,
  Command,
  GripVertical,
  Eye,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FileText,
  Folder,
  FolderPlus,
  History,
  Home,
  LayoutGrid,
  Layers,
  Loader2,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Shield,
  Trash2,
  UploadCloud,
  Users,
  Clock,
  X,
  Maximize2,
  Archive,
  Briefcase,
} from "lucide-react";

const BUILTIN_COLUMNS = [
  { key: "title", label: "Title" },
  { key: "documentNumber", label: "Doc No." },
  { key: "rev", label: "Rev" },
  { key: "status", label: "Status" },
  { key: "updatedAt", label: "Updated" },
];

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

export default function LibraryExplorerPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
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
  // Inline-edit state for the documentNumber cell. Click the cell to
  // begin editing; Enter saves, Esc cancels. Auto-suffix-driven
  // ugly numbers can be cleaned up without opening the metadata editor.
  const [editingDocNumId, setEditingDocNumId] = useState<string | null>(null);
  const [editingDocNumValue, setEditingDocNumValue] = useState("");
  const [editingDocNumError, setEditingDocNumError] = useState<string | null>(null);
  const [savingDocNum, setSavingDocNum] = useState(false);
  // Initial fetch is capped to keep first paint snappy. When the cap is
  // hit we surface a banner with a button to load more.
  const [docFetchLimit, setDocFetchLimit] = useState<number>(500);
  const [docFetchHitCap, setDocFetchHitCap] = useState(false);
  const [loadingUpload, setLoadingUpload] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const [selectedDoc, setSelectedDoc] = useState<DocumentRecord | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<DocumentVersion | null>(null);
  const [sessions, setSessions] = useState<CheckoutSession[]>([]);

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

      // Auto-add to view (active columns)
      const newActive = [...activeColumns, field.key];
      await updateColumns(newActive);

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
        await updateColumns([...activeColumns, "sheet"]);
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
    setIsDragOver(true);
  };
  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragOver(false);
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    handleUploadFiles(e.dataTransfer.files);
  };

  const toggleSelectDoc = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedDocIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedDocIds.size === sortedDocs.length && sortedDocs.length > 0)
      setSelectedDocIds(new Set());
    else
      setSelectedDocIds(new Set(sortedDocs.map((d) => d.id!).filter(Boolean)));
  };

  const handleBulkDelete = async () => {
    if (!confirm(`Permanently delete ${selectedDocIds.size} document(s)? This cannot be undone.`)) return;
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
    if (!confirm(`Archive ${selectedDocIds.size} document${selectedDocIds.size === 1 ? "" : "s"}? They keep their history but disappear from the default view.`)) return;
    const ids = Array.from(selectedDocIds);
    const now = new Date().toISOString();
    await supabase.from("documents").update({
      status: "Archived",
      archived_at: now,
      archived_by: uid ?? null,
      updated_at: now,
      updated_by: uid ?? null,
    }).in("id", ids);
    setDocuments((prev) => prev.map((d) =>
      ids.includes(d.id!) ? { ...d, status: "Archived" as DocumentRecord["status"] } : d
    ));
    setSelectedDocIds(new Set());
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
  const [showHistory, setShowHistory] = useState(false);
  const [showPermissions, setShowPermissions] = useState(false);
  const [showSetManager, setShowSetManager] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [renameFolderId, setRenameFolderId] = useState<string | null>(null);
  const [customizeFolderId, setCustomizeFolderId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // UX enhancements
  const [isDragOver, setIsDragOver] = useState(false);
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<string>("updatedAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // Staging area — persists across folder navigation
  const [stagedDocs, setStagedDocs] = useState<DocumentRecord[]>([]);
  const [showMultiView, setShowMultiView] = useState(false);

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

  // ... (useEffect hooks)

  const handleForceUnlock = async (docRecord: DocumentRecord) => {
    if (!docRecord.id || !activeOrgId) return;
    if (!confirm(`Force release lock for ${docRecord.title}? This will clear the active session.`)) return;
    
    try {
      await supabase.from("documents").update({
        checked_out_by: null, checked_out_by_name: null, checked_out_at: null,
        current_lock_id: null, active_collaborators: [],
      }).eq("id", docRecord.id);

      await supabase.from("checkout_messages").insert({
        org_id: activeOrgId, document_id: docRecord.id,
        text: `SYSTEM ALERT: Lock force released by Admin.`,
        user_id: "system", user_name: "System", lock_id: docRecord.currentLockId,
      });
    } catch (e) {
      console.error("Force unlock failed", e);
      setError("Failed to force unlock.");
    }
  };

  const confirmDeleteDoc = async () => {
    if (!selectedDoc?.id) return;
    if (!confirm(`Delete "${selectedDoc.title || selectedDoc.name || selectedDoc.documentNumber || "this document"}"?\n\nThis removes the document AND every revision attached to it. The file in R2 storage is left untouched (you can clean that up later).\n\nThis cannot be undone.`)) return;

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
      alert(`Delete failed: ${msg}`);
    }
  };

  useEffect(() => {
    const folderId = searchParams.get("folderId");
    if (folderId) setCurrentFolderId(folderId);
  }, [searchParams]);

  // Deep-link via ?doc=<id> — when arriving from the global search,
  // an inbox link, a notification bell row, etc, auto-select the doc
  // and open the inspector. Re-runs whenever documents finish loading
  // so the target row exists by the time we select it.
  useEffect(() => {
    const docId = searchParams.get("doc");
    if (!docId || documents.length === 0) return;
    const target = documents.find((d) => d.id === docId);
    if (target) setSelectedDoc(target);
  }, [searchParams, documents]);

  // Cmd+K / Ctrl+K opens command palette anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
        } as any as LibraryConfig;
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

  useEffect(() => {
    if (!libraryId || !activeOrgId) return;
    let alive = true;
    setLoadingDocs(true);

    const fromDocRow = (r: Record<string, unknown>): DocumentRecord => ({
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
    });

    const fetchDocs = async () => {
      try {
        let q = supabase.from("documents").select("*")
          .eq("org_id", activeOrgId).eq("library_id", libraryId);
        if (currentFolderId) q = q.eq("collection_id", currentFolderId);
        else q = q.is("collection_id", null);
        if (!isControllerRole(activeRole)) q = q.eq("visibility", "normal");
        // Hide archived docs from default view. Admins can flip the toggle
        // (showArchivedDocs) to surface them for restore.
        if (!showArchivedDocs) q = q.neq("status", "Archived");
        q = q.order("updated_at", { ascending: false }).limit(docFetchLimit);
        const { data, error: qErr } = await q;
        if (!alive) return;
        if (qErr) { setError(qErr.message); setDocuments([]); }
        else {
          const rows = (data || []).map((r) => fromDocRow(r as Record<string, unknown>));
          setDocuments(rows);
          setDocFetchHitCap(rows.length >= docFetchLimit);
        }
      } catch (e: unknown) { if (alive) setError((e as Error).message); }
      finally { if (alive) setLoadingDocs(false); }
    };

    fetchDocs();
    const channel = supabase.channel(`docs-lib-${libraryId}-${currentFolderId ?? "root"}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "documents", filter: `library_id=eq.${libraryId}` },
        () => { if (alive) fetchDocs(); })
      .subscribe();

    return () => { alive = false; supabase.removeChannel(channel); };
  }, [libraryId, activeOrgId, currentFolderId, activeRole, showArchivedDocs, docFetchLimit]);

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
      orgId: activeOrgId ?? undefined,
      teamIds: myTeamIds,
    };
  }, [uid, activeRole, activeOrgId, myTeamIds]);

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

  const visibleFolders = useMemo(() => {
    if (!currentFolderId) {
      return folders.filter((f) => !f.parentId);
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
      const hay = `${safeString(docRecord.documentNumber)} ${safeString(docRecord.title)} ${safeString(docRecord.name)}`.toLowerCase();
      return hay.includes(q);
    });
  }, [documents, principal, deferredSearch, buildDocChain]);

  const sortedDocs = useMemo(() => {
    return [...filteredDocs].sort((a, b) => {
      let aVal: unknown, bVal: unknown;
      if (sortKey === "title") { aVal = a.title || a.name; bVal = b.title || b.name; }
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
    const dynamic = columnDefs.map((c) => ({ key: c.key, label: c.label }));
    const known = new Set([...builtins.map((c) => c.key), ...dynamic.map((c) => c.key)]);
    const orphans = activeColumns
      .filter((k) => !known.has(k))
      .map((k) => ({ key: k, label: overrides[k] || k }));
    return [...builtins, ...dynamic, ...orphans];
  }, [columnDefs, activeColumns, library?.columnLabelOverrides]);

  const updateColumns = async (next: string[]) => {
    setActiveColumns(next);
    if (!activeOrgId) return;
    
    // Admins define the Global Default View.
    const scope = isController ? "org" : "user";
    
    await saveTableView({
      scope,
      orgId: activeOrgId,
      ownerUserId: scope === "user" ? (uid ?? undefined) : undefined,
      libraryId,
      collectionId: currentFolderId ?? undefined,
      columns: next,
    });
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
        const aclIndex = buildAclIndexFromChain(chain);
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

  const confirmMoveFolder = async (targetId: string | null) => {
    if (!renameFolderId) return;
    try {
      await moveFolderAndDescendants({ collectionId: renameFolderId, newParentId: targetId ?? null });
      setShowMoveModal(false);
      setRenameFolderId(null);
    } catch (e) {
      console.error(e);
      setError("Failed to move folder.");
    }
  };

  const confirmMoveDoc = async (targetId: string | null) => {
    if (!selectedDoc?.id) return;
    try {
      await supabase.from("documents").update({
        collection_id: targetId ?? null,
        updated_at: new Date().toISOString(),
        updated_by: uid ?? null,
      }).eq("id", selectedDoc.id);
      setShowMoveDocModal(false);
    } catch (e) {
      console.error(e);
      setError("Failed to move document.");
    }
  };

  // ── Phase 1: metadata-first upload ──────────────────────────────
  // Step 1: file selection / drag-drop → just stage the files. NO
  // bytes leave the browser yet. The staging modal opens for review.
  const handleUploadFiles = (files: FileList | null) => {
    if (!files || files.length === 0 || !activeOrgId || !uid || !library) return;
    setPendingUploadFiles(Array.from(files));
    setShowStagingModal(true);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
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
  const handleStagedUpload = async (items: StagedItem[]) => {
    if (!activeOrgId || !uid || !library) return;
    setLoadingUpload(true);
    setError(null);

    const autoRenamed: Array<{ original: string; final: string }> = [];

    try {
      const folderPath = currentFolder?.pathNames ?? [];

      // ── Pre-flight: resolve final doc numbers ────────────────────
      const originals = items.map((it) => it.documentNumber.trim() || baseName(it.file.name));
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
        const storagePath = makeLibraryStoragePath({
          orgId: activeOrgId,
          libraryId,
          folderPath,
          filename: file.name,
        });
        const uploadResult = await uploadToPath(file, storagePath, {
          contentType: file.type || undefined,
        });

        const now = new Date().toISOString();
        const title = item.title.trim() || baseName(file.name);
        const rev = item.rev.trim() || "0";
        const status = item.status || "Issued";
        const uniquenessKey = computeUniquenessKey(
          { documentNumber: docNumber, title, rev, status, customFields: item.customFields },
          library.uniquenessKeys,
        );
        const { data: newDoc, error: docErr } = await supabase.from("documents").insert({
          org_id: activeOrgId,
          library_id: libraryId,
          collection_id: currentFolderId ?? null,
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
            ? buildAclIndexFromChain([...buildFolderChain(currentFolder), library.defaultNewAcl])
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
      for (let i = 0; i < resolved.length; i += UPLOAD_CONCURRENCY) {
        const chunk = resolved.slice(i, i + UPLOAD_CONCURRENCY);
        await Promise.all(chunk.map(uploadOne));
      }

      setShowStagingModal(false);
      setPendingUploadFiles([]);
      if (autoRenamed.length > 0) {
        const sample = autoRenamed.slice(0, 3).map((r) => `${r.original} → ${r.final}`).join(", ");
        const more = autoRenamed.length > 3 ? `, +${autoRenamed.length - 3} more` : "";
        setError(`Uploaded. ${autoRenamed.length} doc number${autoRenamed.length === 1 ? "" : "s"} were auto-suffixed to avoid duplicates: ${sample}${more}.`);
      }
    } catch (e) {
      console.error(e);
      const f = translatePostgresError(e, { entity: "document", field: "document_number" });
      setError(`${f.heading} — ${f.message}`);
      throw e;
    } finally {
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
    // Remove from active view columns too
    const nextActive = activeColumns.filter((k) => k !== key);
    await updateColumns(nextActive);
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

  const startSession = async (mode: CheckoutMode, note: string, linkedTicketId?: string) => {
    if (!selectedDoc?.id || !activeOrgId || !uid) return;

    const now = new Date().toISOString();
    const { data: session, error: sessErr } = await supabase.from("checkout_sessions").insert({
      org_id: activeOrgId,
      document_id: selectedDoc.id,
      library_id: libraryId,
      user_id: uid,
      user_name: userEmail || uid,
      mode,
      note: note || null,
      status: "active",
      linked_ticket_id: linkedTicketId ?? null,
      started_at: now,
      last_seen_at: now,
    }).select("id").single();

    if (sessErr || !session) throw new Error(sessErr?.message || "Failed to create session");

    await supabase.from("documents").update({
      checked_out_by: uid,
      checked_out_by_name: userEmail || uid,
      checked_out_at: now,
    }).eq("id", selectedDoc.id);

    return session.id;
  };

  const endSession = async (sessionId: string) => {
    if (!selectedDoc?.id) return;
    await supabase.from("checkout_sessions").update({
      status: "checked_in",
      last_seen_at: new Date().toISOString(),
    }).eq("id", sessionId);

    const stillActive = sessions.filter((s) => s.status === "active" && s.id !== sessionId);
    if (!stillActive.length) {
      await supabase.from("documents").update({
        checked_out_by: null,
        checked_out_by_name: null,
        checked_out_at: null,
      }).eq("id", selectedDoc.id);
    }
  };

  const abandonSession = async (sessionId: string) => {
    await supabase.from("checkout_sessions").update({
      status: "abandoned",
      last_seen_at: new Date().toISOString(),
    }).eq("id", sessionId);
  };

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
  const handleResizeStart = useCallback((e: React.MouseEvent, colKey: string) => {
    e.preventDefault();
    e.stopPropagation();
    const startWidth = colWidths[colKey] ?? getDefaultColWidth(colKey);
    resizingRef.current = { key: colKey, startX: e.clientX, startWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
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
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      resizingRef.current = null;
      if (library?.id && uid) {
        if (saveWidthsTimerRef.current) clearTimeout(saveWidthsTimerRef.current);
        const snapshot = { ...colWidthsRef.current };
        saveWidthsTimerRef.current = setTimeout(() => {
          supabase.from("libraries").update({ column_widths: snapshot, updated_by: uid }).eq("id", library.id!);
        }, 600);
      }
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
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

    const def = columnMap.get(key);
    const value = (docRecord.metadata ?? {})[key];

    if (!def) return value == null ? "-" : String(value);

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

  if (!activeOrgId) {
    return (
      <div className="min-h-screen bg-slate-50 p-8">
        <div className="max-w-3xl mx-auto bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-slate-900 rounded-xl shadow-lg shadow-slate-900/20">
              <Shield className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-black text-slate-900">Workspace not selected</h1>
              <p className="text-sm text-slate-600 mt-1">
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
      <div className="min-h-screen bg-slate-50 p-8">
        <div className="max-w-3xl mx-auto bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-slate-900 rounded-xl shadow-lg shadow-slate-900/20">
              <Shield className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-black text-slate-900">Library not found</h1>
              <p className="text-sm text-slate-600 mt-1">{error || "Unable to load library."}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const isController = isControllerRole(activeRole);
  const allSelected = sortedDocs.length > 0 && selectedDocIds.size === sortedDocs.length;
  const someSelected = selectedDocIds.size > 0 && !allSelected;

  const rowPad = density === "compact" ? "py-2" : "py-3";
  const headerPad = density === "compact" ? "py-2" : "py-3";

  return (
    <div className="h-screen bg-slate-50 flex flex-col overflow-hidden">
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
              updatedAt: new Date().toISOString() as any,
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
            setSelectedDoc((prev) => prev ? { ...prev, status: newStatus as any } : prev);
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
            // Force a refresh by re-running the docs effect dep
            setDocFetchLimit((n) => n);
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
            setDocFetchLimit((n) => n); // trigger refetch
          }}
        />
      )}

      {revertTarget && selectedDoc && activeOrgId && uid && (
        <RevertConfirmModal
          isOpen={!!revertTarget}
          onClose={() => setRevertTarget(null)}
          doc={selectedDoc}
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
              updatedAt: new Date().toISOString() as any,
            } : prev);
            setVersionHistoryRefreshKey((k) => k + 1);
          }}
        />
      )}

      {/* ── SLIM GLASS TOP BAR ───────────────────────────────────────── */}
      <div
        className="h-11 shrink-0 border-b border-slate-200/80 bg-white/70 z-30 flex items-center gap-2 px-3"
        style={{ backdropFilter: "blur(20px) saturate(180%)", WebkitBackdropFilter: "blur(20px) saturate(180%)" }}
      >
        <button
          onClick={() => router.push("/documents")}
          className="h-7 w-7 rounded-md hover:bg-slate-100 flex items-center justify-center shrink-0 text-slate-500 hover:text-slate-900 transition-colors"
          title="Back to libraries"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>

        {/* Breadcrumb */}
        <div className="flex items-center text-xs font-medium text-slate-500 overflow-hidden min-w-0">
          <button
            onClick={() => setCurrentFolderId(null)}
            className={`hover:text-slate-900 px-1.5 py-1 rounded flex items-center shrink-0 transition-colors ${!currentFolderId ? "text-slate-900 font-bold" : ""}`}
          >
            {library.color || library.icon ? (
              <span
                className="w-4 h-4 rounded grid place-items-center mr-1.5 text-white shrink-0"
                style={{ background: library.color || "var(--brand-gradient)" }}
              >
                <NodeIcon name={library.icon} className="w-2.5 h-2.5" />
              </span>
            ) : (
              <Home className="w-3 h-3 mr-1" />
            )}
            {library.name}
          </button>
          {currentFolder?.pathNames?.map((seg, idx) => {
            const pathId = currentFolder.pathIds?.[idx];
            return (
              <React.Fragment key={`${seg}-${idx}`}>
                <ChevronRight className="w-3 h-3 text-slate-300 mx-0.5 shrink-0" />
                <button
                  onClick={() => pathId && setCurrentFolderId(pathId)}
                  className="hover:text-slate-900 px-1.5 py-1 rounded hover:bg-slate-100 truncate transition-colors"
                >
                  {seg}
                </button>
              </React.Fragment>
            );
          })}
          {currentFolder && (
            <>
              <ChevronRight className="w-3 h-3 text-slate-300 mx-0.5 shrink-0" />
              <span className="font-bold text-slate-900 px-1.5 py-1 truncate">{currentFolder.name}</span>
            </>
          )}
        </div>

        <div className="flex-1" />

        {/* Search */}
        <div className="relative group">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 group-focus-within:text-slate-700 transition-colors pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter…"
            className="pl-7 pr-2 h-7 rounded-md border border-slate-200/80 bg-white/60 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 w-44 text-xs font-medium transition-all"
          />
        </div>

        {/* Command palette trigger */}
        <button
          onClick={() => setCommandOpen(true)}
          className="hidden sm:flex items-center gap-1.5 h-7 px-2 rounded-md border border-slate-200/80 bg-white/60 hover:bg-white text-slate-500 hover:text-slate-900 text-[11px] font-medium transition-all"
          title="Command palette"
        >
          <Command className="w-3 h-3" />
          <span>K</span>
        </button>

        <div className="h-4 w-px bg-slate-200 mx-0.5" />

        <button
          onClick={() => fileInputRef.current?.click()}
          className="h-7 px-2 rounded-md hover:bg-slate-100 flex items-center gap-1 text-slate-600 hover:text-slate-900 text-xs font-bold transition-colors"
          title="Upload files"
        >
          <UploadCloud className="w-3.5 h-3.5" />
          <span className="hidden md:inline">Upload</span>
        </button>

        {/* Overflow menu for secondary actions */}
        <div className="relative">
          <button
            onClick={() => setActionsMenuOpen((v) => !v)}
            className="h-7 w-7 rounded-md hover:bg-slate-100 flex items-center justify-center text-slate-500 hover:text-slate-900 transition-colors"
            title="More actions"
          >
            <MoreHorizontal className="w-3.5 h-3.5" />
          </button>
          {actionsMenuOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setActionsMenuOpen(false)} />
              <div
                className="absolute right-0 top-full mt-1 w-48 rounded-xl bg-white/95 border border-slate-200/80 shadow-2xl z-40 overflow-hidden animate-in zoom-in-95 fade-in duration-100"
                style={{ backdropFilter: "blur(20px) saturate(180%)" }}
              >
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); openCreateFolder(); }}
                    className="w-full px-3 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-100 flex items-center gap-2"
                  >
                    <FolderPlus className="w-3.5 h-3.5 text-slate-400" /> New folder
                  </button>
                )}
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); setShowColumnManager(true); }}
                    className="w-full px-3 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-100 flex items-center gap-2"
                  >
                    <Columns className="w-3.5 h-3.5 text-slate-400" /> Manage columns
                  </button>
                )}
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); setShowLibraryOrderModal(true); }}
                    className="w-full px-3 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-100 flex items-center gap-2"
                  >
                    <GripVertical className="w-3.5 h-3.5 text-slate-400" /> Reorder documents
                  </button>
                )}
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); setShowCsvImport(true); }}
                    className="w-full px-3 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-100 flex items-center gap-2"
                    title="Bulk-create document records from a pasted CSV"
                  >
                    <FileText className="w-3.5 h-3.5 text-slate-400" /> Import from CSV
                  </button>
                )}
                <button
                  onClick={() => { setActionsMenuOpen(false); setShowViewSelector((v) => !v); }}
                  className="w-full px-3 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-100 flex items-center gap-2"
                >
                  <Eye className="w-3.5 h-3.5 text-slate-400" /> Views & save current
                </button>
                {isController && (
                  <button
                    onClick={() => { setActionsMenuOpen(false); setShowArchivedDocs((v) => !v); }}
                    className="w-full px-3 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-100 flex items-center gap-2"
                  >
                    <Archive className="w-3.5 h-3.5 text-slate-400" />
                    {showArchivedDocs ? "Hide archived docs" : "Show archived docs"}
                  </button>
                )}
                <button
                  onClick={() => { setActionsMenuOpen(false); window.location.reload(); }}
                  className="w-full px-3 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-100 flex items-center gap-2"
                >
                  <RefreshCw className={`w-3.5 h-3.5 text-slate-400 ${loadingDocs ? "animate-spin" : ""}`} /> Refresh
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => handleUploadFiles(e.target.files)} />

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
        />

        {/* MAIN AREA — full width, no inspector grid */}
        <div className={`flex-1 overflow-auto p-3 lg:p-4 ${stagedDocs.length > 0 ? "pb-20" : ""}`}>
          <div className="max-w-[1920px] mx-auto">

            {/* Phase 2 + 3: Curated Collections + Favorites */}
            {library && activeOrgId && uid && (
              <div className="mb-3 bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
                <FavoritesStrip
                  orgId={activeOrgId}
                  userId={uid}
                  libraryDocs={documents.map((d) => ({
                    id: d.id!,
                    documentNumber: d.documentNumber || "",
                    title: d.title || d.name || "",
                    rev: d.rev,
                    status: d.status,
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
                  libraryDocs={documents.map((d) => ({
                    id: d.id!,
                    documentNumber: d.documentNumber || "",
                    title: d.title || d.name || "",
                    rev: d.rev,
                    status: d.status,
                  }))}
                  onOpenAsBook={(docIds) => {
                    // Look up each doc id in the loaded document list and
                    // stage them in the same order the collection defined.
                    const ordered = docIds
                      .map((id) => documents.find((d) => d.id === id))
                      .filter(Boolean) as DocumentRecord[];
                    if (ordered.length === 0) return;
                    setStagedDocs(ordered);
                    setShowMultiView(true);
                  }}
                />
              </div>
            )}

            {/* HERO HEADER (library root or folder; only when customized) */}
            {pageHeader && <PageHeader header={pageHeader} />}

            {/* Subtle hint for admins inside a folder — columns are library-wide */}
            {isController && currentFolderId && (
              <div className="mb-2 px-3 py-2 bg-blue-50/60 border border-blue-200 rounded-lg text-[11px] text-slate-700 flex items-center gap-2">
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
              className={`bg-white border rounded-2xl shadow-sm overflow-hidden flex flex-col min-h-[500px] relative transition-all duration-150 ${
                isDragOver ? "border-blue-400 ring-4 ring-blue-100" : "border-slate-200"
              }`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              {/* Drag overlay */}
              {isDragOver && (
                <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-blue-50/95 pointer-events-none">
                  <div className="w-20 h-20 rounded-2xl bg-blue-100 border-2 border-blue-400 border-dashed flex items-center justify-center mb-4">
                    <UploadCloud className="w-9 h-9 text-blue-500" />
                  </div>
                  <p className="text-lg font-bold text-blue-700">Drop files to upload</p>
                  <p className="text-sm text-blue-500 mt-1">
                    Release to add to {currentFolder ? `"${currentFolder.name}"` : "this library"}
                  </p>
                </div>
              )}

              {/* FOLDERS GRID */}
              {filteredFolders.length > 0 && (
                <div className="p-5 border-b border-slate-100 bg-slate-50/30">
                  <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center">
                    <LayoutGrid className="w-3 h-3 mr-1.5" /> Folders
                  </h3>
                  <FolderGrid
                    folders={filteredFolders}
                    onOpen={(id) => setCurrentFolderId(id)}
                    onRename={isController ? (id) => { setRenameFolderId(id); setRenameValue(folderMap.get(id)?.name || ""); } : undefined}
                    onMove={isController ? (id) => { setRenameFolderId(id); setShowMoveModal(true); } : undefined}
                    onPermissions={isController ? (id) => { setRenameFolderId(id); setShowPermissions(true); } : undefined}
                    onCustomize={isController ? (id) => { setCustomizeFolderId(id); } : undefined}
                    isController={isController}
                  />
                </div>
              )}

              {/* DOCUMENTS SECTION */}
              <div className="flex-1 flex flex-col">
                {docFetchHitCap && !loadingDocs && (
                  <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-[11px] text-amber-900 flex items-center justify-between gap-3">
                    <span>
                      Showing the first <b>{docFetchLimit.toLocaleString()}</b> documents (newest first). More exist below this cap.
                    </span>
                    <button
                      onClick={() => setDocFetchLimit((n) => n + 500)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-amber-200 hover:bg-amber-300 text-amber-900 font-bold text-[11px]"
                    >
                      Load 500 more
                    </button>
                  </div>
                )}
                <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between bg-white">
                  <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    <FileText className="w-4 h-4 text-slate-400" />
                    Documents
                    <span className="text-xs font-medium text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">{filteredDocs.length}</span>
                  </h3>
                  {loadingUpload && (
                    <div className="flex items-center gap-1.5 text-xs text-slate-500">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> Uploading…
                    </div>
                  )}
                </div>

                {!loadingDocs && filteredDocs.length === 0 && filteredFolders.length === 0 ? (
                  /* INTERACTIVE EMPTY STATE */
                  <div className="flex-1 flex flex-col items-center justify-center p-12">
                    <div className="w-20 h-20 rounded-2xl bg-slate-100 border-2 border-dashed border-slate-200 flex items-center justify-center mb-5">
                      <UploadCloud className="w-8 h-8 text-slate-300" />
                    </div>
                    <h3 className="text-base font-bold text-slate-900 mb-1">Nothing here yet</h3>
                    <p className="text-sm text-slate-500 text-center max-w-xs mb-6">
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
                          className="flex items-center gap-2 px-5 py-2.5 bg-white border border-slate-200 text-slate-700 rounded-xl text-sm font-bold hover:bg-slate-50 transition-colors"
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
                      <div className="text-center text-xs text-slate-400 py-8">No documents.</div>
                    ) : sortedDocs.map((doc) => (
                      <button
                        key={doc.id}
                        onClick={() => setSelectedDoc(doc)}
                        className="w-full text-left bg-white border border-slate-200 rounded-xl p-3 shadow-sm active:bg-slate-50"
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-bold text-slate-900 truncate flex-1">{doc.documentNumber || doc.title || doc.name || "—"}</span>
                          {doc.rev && <span className="text-[10px] font-bold bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded shrink-0">Rev {doc.rev}</span>}
                        </div>
                        {doc.title && doc.documentNumber && <div className="text-xs text-slate-600 truncate mt-0.5">{doc.title}</div>}
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                          {doc.status && <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border ${stateStyle(documentState(doc.status)).pill}`}>{doc.status}</span>}
                          {doc.checkedOutBy && <span className="text-[10px] font-bold text-blue-700">Checked out{doc.checkedOutByName ? ` · ${doc.checkedOutByName}` : ""}</span>}
                        </div>
                      </button>
                    ))}
                  </div>
                  {/* DESKTOP TABLE — overflow-x-auto for column overflow */}
                  <div className="flex-1 overflow-x-auto hidden md:block">
                    <table className="w-full text-left text-sm table-fixed min-w-[640px]">
                      <thead className="bg-slate-50/70 border-b border-slate-200 text-[10px] text-slate-500 uppercase font-black tracking-wider">
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
                            const builtinLabel = BUILTIN_COLUMNS.find((c) => c.key === colKey)?.label;
                            const overrideLabel = library?.columnLabelOverrides?.[colKey];
                            const label = overrideLabel || builtinLabel || columnMap.get(colKey)?.label || colKey;
                            const width = getColWidth(colKey);
                            const isResized = !!colWidths[colKey];
                            return (
                              <th
                                key={colKey}
                                className={`relative px-2 ${headerPad} cursor-pointer hover:bg-slate-100 select-none transition-colors group`}
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
                                    <ArrowUpDown className="w-3 h-3 text-slate-300 group-hover:text-slate-500 shrink-0" />
                                  )}
                                </div>

                                {/* Right-edge resize handle — admin/DocCtrl only.
                                    Always-visible vertical bar with a wide hit zone. Brightens on hover. */}
                                {isController && (
                                  <div
                                    onMouseDown={(e) => handleResizeStart(e, colKey)}
                                    onDoubleClick={(e) => handleResizeReset(e, colKey)}
                                    onClick={(e) => e.stopPropagation()}
                                    title={isResized ? "Drag to resize · double-click to reset" : "Drag to resize column"}
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
                      <tbody className="divide-y divide-slate-100">
                        {loadingDocs ? (
                          <tr>
                            <td colSpan={activeColumns.length + 5} className="px-6 py-12 text-center text-slate-500">
                              <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />Loading…
                            </td>
                          </tr>
                        ) : sortedDocs.length === 0 ? (
                          <tr>
                            <td colSpan={activeColumns.length + 5} className="px-6 py-10 text-center text-slate-400 text-sm italic">
                              No documents match your search.
                            </td>
                          </tr>
                        ) : (
                          sortedDocs.map((docRecord) => {
                            const isRowSelected = selectedDocIds.has(docRecord.id!);
                            const isFocused = selectedDoc?.id === docRecord.id;
                            return (
                              <tr
                                key={docRecord.id}
                                onClick={() => setSelectedDoc(docRecord)}
                                className={`group cursor-pointer transition-colors relative ${
                                  isRowSelected
                                    ? "bg-blue-50/70"
                                    : isFocused
                                    ? "bg-slate-50"
                                    : "hover:bg-slate-50/60"
                                }`}
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
                                          canEdit={isController || (activeRole !== "Viewer" && activeRole !== "Auditor")}
                                          orgId={activeOrgId ?? undefined}
                                          userId={uid ?? undefined}
                                          canManageAssets={["Admin", "Manager", "Supervisor"].includes(activeRole) || activeRole.includes("Engineer") || activeRole === "Drafter"}
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
                                    return (
                                      <td key={colKey} className={`px-3 ${rowPad}`}>
                                        <div className="min-w-0">
                                          <div className="text-sm font-semibold text-slate-900 truncate leading-tight">
                                            {docRecord.title || docRecord.name || "Untitled"}
                                          </div>
                                          {!hasSeparateDocNum && docRecord.documentNumber && (
                                            <div className="text-[10px] font-mono text-slate-400 truncate mt-0.5">
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
                                      : s === "Draft" ? "bg-slate-100 text-slate-600 border-slate-200"
                                      : s === "Superseded" ? "bg-amber-50 text-amber-700 border-amber-200"
                                      : s === "Void" || s === "Archived" ? "bg-red-50 text-red-700 border-red-200"
                                      : s === "Locked" ? "bg-blue-50 text-blue-700 border-blue-200"
                                      : "bg-slate-50 text-slate-500 border-slate-200";
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
                                              className={`w-full text-xs font-mono px-1.5 py-0.5 rounded border ${editingDocNumError ? "border-red-400 bg-red-50" : "border-blue-400 bg-blue-50"} focus:outline-none focus:ring-1 focus:ring-blue-500`}
                                            />
                                            {savingDocNum && <Loader2 className="w-3 h-3 animate-spin text-slate-500 shrink-0" />}
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
                                            className="w-full text-left text-xs font-mono text-slate-700 truncate hover:bg-blue-50 hover:text-blue-900 px-1 -mx-1 rounded transition-colors"
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
                                    <td key={colKey} className={`px-3 ${rowPad} text-slate-700 text-xs truncate`}>
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
                                            : "text-slate-300 hover:text-orange-500 hover:bg-orange-50 opacity-0 group-hover:opacity-100"
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
                                    className="text-slate-300 hover:text-slate-700 p-1 rounded-md hover:bg-slate-100 transition-all opacity-0 group-hover:opacity-100"
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
        onOpen={() => setShowMultiView(true)}
      />

      {/* MULTI-DOC VIEWER */}
      {showMultiView && stagedDocs.length > 0 && (
        <MultiDocViewer
          docs={stagedDocs}
          onClose={() => setShowMultiView(false)}
          currentUserId={uid ?? undefined}
          currentUserEmail={userEmail ?? undefined}
          orgId={activeOrgId ?? undefined}
          userRole={activeRole}
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
        <div className="fixed top-16 right-4 z-[100] bg-white rounded-xl shadow-2xl border border-slate-200 p-3">
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
        onCancel={() => { setShowStagingModal(false); setPendingUploadFiles([]); }}
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

      {showSetManager && (
        <SetManager
          isOpen={showSetManager}
          onClose={() => setShowSetManager(false)}
          libraryId={libraryId}
        />
      )}

      {creatingFolder && (
        <div className="fixed inset-0 z-[90] flex items-start sm:items-center justify-center overflow-y-auto bg-slate-900/60 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <div>
                <div className="text-sm font-bold text-slate-900">Create Folder</div>
                <div className="text-xs text-slate-500">Add a new subfolder here.</div>
              </div>
              <button onClick={() => setCreatingFolder(false)} className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white hover:bg-slate-50">
                <X className="h-4 w-4 text-slate-600" />
              </button>
            </div>
            <div className="p-6">
              <input
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                placeholder="Folder name"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                autoFocus
              />
            </div>
            <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2">
              <button
                onClick={() => setCreatingFolder(false)}
                className="px-4 py-2 rounded-lg border border-slate-200 bg-white text-sm font-bold text-slate-700 hover:bg-slate-50"
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

      {renameFolderId && !showMoveModal && !showPermissions && (
        <div className="fixed inset-0 z-[90] flex items-start sm:items-center justify-center overflow-y-auto bg-slate-900/60 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <div>
                <div className="text-sm font-bold text-slate-900">Rename Folder</div>
                <div className="text-xs text-slate-500">Update the folder name.</div>
              </div>
              <button onClick={() => setRenameFolderId(null)} className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white hover:bg-slate-50">
                <X className="h-4 w-4 text-slate-600" />
              </button>
            </div>
            <div className="p-6">
              <input
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                placeholder="Folder name"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                autoFocus
              />
            </div>
            <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2">
              <button
                onClick={() => setRenameFolderId(null)}
                className="px-4 py-2 rounded-lg border border-slate-200 bg-white text-sm font-bold text-slate-700 hover:bg-slate-50"
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

