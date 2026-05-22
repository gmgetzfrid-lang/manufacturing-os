"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import FolderGrid from "@/components/documents/FolderGrid";
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
import PillCell from "@/components/documents/PillCell";
import AssetTag from "@/components/ui/AssetTag";
import SecureDocViewer from "@/components/viewers/SecureDocViewer";
import FullScreenViewer from "@/components/viewers/FullScreenViewer";
import MultiDocViewer from "@/components/viewers/MultiDocViewer";
import { buildAclIndexFromChain } from "@/lib/acl";
import { canDiscover, canWithAclChain, isControllerRole } from "@/lib/permissions";
import {
  createFolder,
  listenLibraryFolders,
  moveFolderAndDescendants,
  renameFolderAndDescendants,
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
  PanelLeft,
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

function FolderTreeNode({
  folder,
  allFolders,
  depth,
  currentFolderId,
  onNavigate,
}: {
  folder: LibraryCollection;
  allFolders: LibraryCollection[];
  depth: number;
  currentFolderId: string | null;
  onNavigate: (id: string) => void;
}) {
  const [expanded, setExpanded] = React.useState(depth < 2);
  const children = allFolders.filter((f) => f.parentId === folder.id);
  const isActive = currentFolderId === folder.id;

  return (
    <div>
      <div
        className={`flex items-center gap-0.5 rounded-lg transition-colors ${
          isActive ? "bg-blue-50 text-blue-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
        }`}
        style={{ paddingLeft: `${6 + depth * 14}px`, paddingRight: 6, paddingTop: 4, paddingBottom: 4 }}
      >
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
          className={`shrink-0 p-0.5 rounded ${children.length === 0 ? "invisible" : ""}`}
        >
          <ChevronRight className={`w-3 h-3 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`} />
        </button>
        <button
          onClick={() => onNavigate(folder.id!)}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left py-0.5"
        >
          <Folder className={`w-3.5 h-3.5 shrink-0 ${isActive ? "text-blue-500" : "text-amber-400"}`} />
          <span className="text-xs font-medium truncate">{folder.name}</span>
        </button>
      </div>
      {expanded && children.length > 0 && (
        <div>
          {children.map((child) => (
            <FolderTreeNode
              key={child.id}
              folder={child}
              allFolders={allFolders}
              depth={depth + 1}
              currentFolderId={currentFolderId}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </div>
  );
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
  const [loadingLibrary, setLoadingLibrary] = useState(true);
  const [loadingDocs, setLoadingDocs] = useState(true);
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

      // Auto-add to view (active columns)
      const newActive = [...activeColumns, field.key];
      await updateColumns(newActive);
      
    } catch (e) {
      console.error("Failed to add column", e);
      setError("Failed to create column.");
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
  const [renameValue, setRenameValue] = useState("");

  // UX enhancements
  const [isDragOver, setIsDragOver] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<string>("updatedAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // Staging area — persists across folder navigation
  const [stagedDocs, setStagedDocs] = useState<DocumentRecord[]>([]);
  const [showMultiView, setShowMultiView] = useState(false);

  const [activeColumns, setActiveColumns] = useState<string[]>([]);
  const [columnDefs, setColumnDefs] = useState<MetadataFieldDefinition[]>([]);
  const [showFullScreen, setShowFullScreen] = useState(false);

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
    if (!confirm(`Are you sure you want to delete "${selectedDoc.title}"?\n\nThis action cannot be undone.`)) return;
    
    try {
      // 1. Delete main document record
      // Note: In a real app, use a Cloud Function to recursive delete versions/files
      // For now, we just remove the record so it disappears from the list
      await supabase.from("documents").delete().eq("id", selectedDoc.id);
      
      setDocuments(prev => prev.filter(d => d.id !== selectedDoc.id));
      setSelectedDoc(null);
      setSelectedVersion(null);
    } catch (e) {
      console.error(e);
      setError("Failed to delete document.");
    }
  };

  useEffect(() => {
    const folderId = searchParams.get("folderId");
    if (folderId) setCurrentFolderId(folderId);
  }, [searchParams]);

  useEffect(() => {
    if (!libraryId || !activeOrgId) return;
    setLoadingLibrary(true);
    setError(null);

    const fetchLibrary = async () => {
      try {
        const { data } = await supabase.from("libraries").select("*").eq("id", libraryId).single();
        if (!data) { setLibrary(null); setError("Library not found."); return; }
        if (data.org_id && data.org_id !== activeOrgId) { setLibrary(null); setError("Library does not belong to active workspace."); return; }
        setLibrary({
          id: data.id, orgId: data.org_id, name: data.name, description: data.description,
          type: data.type, customColumns: data.custom_columns ?? [],
          writeAccess: data.write_access ?? [], adminAccess: data.admin_access ?? [],
          readAccess: data.read_access ?? "ALL", visibleTo: data.visible_to ?? [],
          folderSecurity: data.folder_security ?? "Inherited",
          defaultNewVisibility: data.default_new_visibility,
          defaultNewAcl: data.default_new_acl, acl: data.acl,
        } as any as LibraryConfig);
      } catch (e) {
        console.error(e);
        setError("Failed to load library.");
      } finally {
        setLoadingLibrary(false);
      }
    };

    fetchLibrary();
  }, [libraryId, activeOrgId]);

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
        q = q.order("updated_at", { ascending: false });
        const { data, error: qErr } = await q;
        if (!alive) return;
        if (qErr) { setError(qErr.message); setDocuments([]); }
        else { setDocuments((data || []).map(r => fromDocRow(r as Record<string, unknown>))); }
      } catch (e: unknown) { if (alive) setError((e as Error).message); }
      finally { if (alive) setLoadingDocs(false); }
    };

    fetchDocs();
    const channel = supabase.channel(`docs-lib-${libraryId}-${currentFolderId ?? "root"}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "documents", filter: `library_id=eq.${libraryId}` },
        () => { if (alive) fetchDocs(); })
      .subscribe();

    return () => { alive = false; supabase.removeChannel(channel); };
  }, [libraryId, activeOrgId, currentFolderId, activeRole]);

  const folderMap = useMemo(() => {
    const map = new Map<string, LibraryCollection>();
    for (const f of folders) {
      if (f.id) map.set(f.id, f);
    }
    return map;
  }, [folders]);

  const currentFolder = currentFolderId ? folderMap.get(currentFolderId) ?? null : null;

  const principal = useMemo(() => {
    return {
      uid: uid ?? "",
      role: activeRole,
      orgId: activeOrgId ?? undefined,
    };
  }, [uid, activeRole, activeOrgId]);

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

  const filteredDocs = useMemo(() => {
    const q = search.trim().toLowerCase();
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
  }, [documents, principal, search, buildDocChain]);

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
    const builtins = BUILTIN_COLUMNS.map((c) => ({ key: c.key, label: c.label, locked: true }));
    const dynamic = columnDefs.map((c) => ({ key: c.key, label: c.label }));
    return [...builtins, ...dynamic];
  }, [columnDefs]);

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

  const handleUploadFiles = async (files: FileList | null) => {
    if (!files || !activeOrgId || !uid || !library) return;
    setLoadingUpload(true);
    setError(null);

    try {
      const folderPath = currentFolder?.pathNames ?? [];
      for (const file of Array.from(files)) {
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
        const { data: newDoc, error: docErr } = await supabase.from("documents").insert({
          org_id: activeOrgId,
          library_id: libraryId,
          collection_id: currentFolderId ?? null,
          name: file.name,
          title: baseName(file.name),
          document_number: baseName(file.name),
          rev: "0",
          status: "Issued",
          metadata: {
            extension: file.name.split('.').pop()?.toLowerCase() || '',
            original_name: file.name,
            mime_type: file.type || 'application/octet-stream',
            size_bytes: String(file.size),
            last_modified: String(file.lastModified),
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
          revision_label: "0",
          file_url: uploadResult.url,
          file_type: file.type || "application/octet-stream",
          size: uploadResult.size,
          created_by: uid,
          created_by_name: userEmail || uid,
          created_at: now,
        }).select("id").single();

        if (verErr || !newVersion) throw new Error(verErr?.message || "Failed to create document version");

        await supabase.from("documents").update({ current_version_id: newVersion.id }).eq("id", newDoc.id);
      }
    } catch (e) {
      console.error(e);
      setError("Upload failed.");
    } finally {
      setLoadingUpload(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const saveMetadata = async (next: { metadata: Record<string, MetadataValue> }) => {
    if (!selectedDoc?.id) return;
    await supabase.from("documents").update({
      metadata: next.metadata,
      updated_at: new Date().toISOString(),
      updated_by: uid ?? null,
    }).eq("id", selectedDoc.id);
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
            <AssetTag key={tag} tag={tag} type={def.pillGroupLabel || "Equipment"} />
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
    return (
      <div className="min-h-screen bg-slate-50 p-8">
        <div className="max-w-6xl mx-auto text-slate-600">Loading library...</div>
      </div>
    );
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
        />
      )}

      {/* STICKY HEADER */}
      <div className="border-b border-slate-200 bg-white z-20 shrink-0">
        <div className="px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <button
                onClick={() => router.push("/documents")}
                className="h-8 w-8 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 flex items-center justify-center shrink-0 transition-colors"
              >
                <ArrowLeft className="h-4 w-4 text-slate-600" />
              </button>
              <button
                onClick={() => setSidebarOpen((v) => !v)}
                className="h-8 w-8 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 flex items-center justify-center shrink-0 transition-colors"
                title="Toggle folder panel"
              >
                <PanelLeft className="h-4 w-4 text-slate-600" />
              </button>
              <div className="flex items-center text-sm font-semibold text-slate-600 overflow-hidden min-w-0">
                <button
                  onClick={() => setCurrentFolderId(null)}
                  className={`hover:text-slate-900 transition-colors px-2 py-1 rounded-md flex items-center shrink-0 ${!currentFolderId ? "text-slate-900 font-bold" : ""}`}
                >
                  <Home className="w-4 h-4 mr-1.5" />
                  {library.name}
                </button>
                {currentFolder?.pathNames?.map((seg, idx) => {
                  const pathId = currentFolder.pathIds?.[idx];
                  return (
                    <React.Fragment key={`${seg}-${idx}`}>
                      <ChevronRight className="w-4 h-4 text-slate-300 mx-0.5 shrink-0" />
                      <button
                        onClick={() => pathId && setCurrentFolderId(pathId)}
                        className="hover:text-slate-900 transition-colors px-2 py-1 rounded-md hover:bg-slate-50 truncate"
                      >
                        {seg}
                      </button>
                    </React.Fragment>
                  );
                })}
                {currentFolder && (
                  <>
                    <ChevronRight className="w-4 h-4 text-slate-300 mx-0.5 shrink-0" />
                    <span className="font-bold text-slate-900 bg-slate-50 px-2 py-1 rounded-md border border-slate-100 truncate">
                      {currentFolder.name}
                    </span>
                  </>
                )}
              </div>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              <div className="relative group">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 group-focus-within:text-slate-600 transition-colors" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search..."
                  className="pl-9 pr-3 py-1.5 rounded-lg border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-slate-900/10 w-40 text-sm transition-all"
                />
              </div>
              <div className="h-5 w-px bg-slate-200 mx-1" />
              {isController && (
                <button onClick={openCreateFolder} className="p-2 hover:bg-slate-100 rounded-lg text-slate-500 hover:text-slate-900 transition-colors" title="New Folder">
                  <FolderPlus className="w-4 h-4" />
                </button>
              )}
              <button onClick={() => fileInputRef.current?.click()} className="p-2 hover:bg-slate-100 rounded-lg text-slate-500 hover:text-slate-900 transition-colors" title="Upload Files">
                <UploadCloud className="w-4 h-4" />
              </button>
              {isController && (
                <button onClick={() => setShowColumnManager(true)} className="p-2 hover:bg-slate-100 rounded-lg text-slate-500 hover:text-slate-900 transition-colors" title="Manage Columns">
                  <Columns className="w-4 h-4" />
                </button>
              )}
              <button onClick={() => window.location.reload()} className="p-2 hover:bg-slate-100 rounded-lg text-slate-500 hover:text-slate-900 transition-colors" title="Refresh">
                <RefreshCw className={`w-4 h-4 ${loadingDocs ? "animate-spin" : ""}`} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* BULK ACTION BAR */}
      {selectedDocIds.size > 0 && (
        <div className="bg-blue-600 text-white px-5 py-2 flex items-center gap-4 shrink-0 z-10">
          <span className="text-sm font-bold">{selectedDocIds.size} selected</span>
          <div className="flex items-center gap-2 ml-auto">
            <button
              onClick={() => setSelectedDocIds(new Set())}
              className="px-3 py-1 text-xs font-bold bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors"
            >
              Deselect all
            </button>
            <button
              onClick={handleStageSelected}
              className="flex items-center gap-1.5 px-3 py-1 text-xs font-bold bg-orange-500 hover:bg-orange-600 rounded-lg transition-colors"
              title="Add selected documents to the Reference Stack for multi-document review"
            >
              <Layers className="w-3.5 h-3.5" /> Stage for Review
            </button>
            {isController && (
              <button
                onClick={handleBulkDelete}
                className="flex items-center gap-1.5 px-3 py-1 text-xs font-bold bg-red-500 hover:bg-red-600 rounded-lg transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" /> Delete selected
              </button>
            )}
          </div>
        </div>
      )}

      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => handleUploadFiles(e.target.files)} />

      {/* BODY: sidebar + main */}
      <div className="flex flex-1 overflow-hidden">

        {/* FOLDER TREE SIDEBAR */}
        <div className={`${sidebarOpen ? "w-52" : "w-0"} shrink-0 overflow-hidden transition-all duration-200 border-r border-slate-200 bg-white flex flex-col`}>
          <div className="px-3 py-2.5 border-b border-slate-100 flex items-center justify-between shrink-0">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Folders</span>
            {isController && (
              <button onClick={openCreateFolder} title="New Folder" className="p-1 hover:bg-slate-100 rounded text-slate-400 hover:text-slate-600 transition-colors">
                <FolderPlus className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto py-1.5 px-1.5 custom-scrollbar">
            <button
              onClick={() => setCurrentFolderId(null)}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors mb-0.5 ${
                !currentFolderId ? "bg-blue-50 text-blue-700 font-bold" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              }`}
            >
              <Home className="w-3.5 h-3.5 shrink-0" />
              <span className="text-xs font-medium truncate">{library.name}</span>
            </button>
            {folders.filter((f) => !f.parentId).map((folder) => (
              <FolderTreeNode
                key={folder.id}
                folder={folder}
                allFolders={folders}
                depth={0}
                currentFolderId={currentFolderId}
                onNavigate={setCurrentFolderId}
              />
            ))}
            {folders.length === 0 && (
              <p className="text-xs text-slate-400 text-center py-6 px-2">No folders yet</p>
            )}
          </div>
        </div>

        {/* MAIN AREA */}
        <div className={`flex-1 overflow-auto p-4 lg:p-5 ${stagedDocs.length > 0 ? "pb-20" : ""}`}>
          <div className={`grid grid-cols-1 ${selectedDoc ? "xl:grid-cols-[1fr_360px]" : ""} gap-5 max-w-[1920px] mx-auto`}>

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
                    isController={isController}
                  />
                </div>
              )}

              {/* DOCUMENTS SECTION */}
              <div className="flex-1 flex flex-col">
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
                  /* DOCUMENTS TABLE */
                  <div className="flex-1 overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500 uppercase font-bold">
                        <tr>
                          <th className="px-4 py-3 w-10">
                            <input
                              type="checkbox"
                              checked={allSelected}
                              ref={(el) => { if (el) el.indeterminate = someSelected; }}
                              onChange={toggleSelectAll}
                              className="w-4 h-4 rounded accent-blue-600 cursor-pointer"
                            />
                          </th>
                          {activeColumns.map((colKey) => {
                            const label = BUILTIN_COLUMNS.find((c) => c.key === colKey)?.label || columnMap.get(colKey)?.label || colKey;
                            return (
                              <th
                                key={colKey}
                                className="px-4 py-3 whitespace-nowrap cursor-pointer hover:bg-slate-100 select-none transition-colors group"
                                onClick={() => handleSort(colKey)}
                              >
                                <div className="flex items-center gap-1">
                                  {label}
                                  {sortKey === colKey ? (
                                    sortDir === "asc"
                                      ? <ChevronUp className="w-3 h-3 text-slate-600" />
                                      : <ChevronDown className="w-3 h-3 text-slate-600" />
                                  ) : (
                                    <ArrowUpDown className="w-3 h-3 text-slate-300 group-hover:text-slate-400" />
                                  )}
                                </div>
                              </th>
                            );
                          })}
                          <th className="px-4 py-3 w-36 text-center">Checkout</th>
                          <th className="px-4 py-3 w-10 text-center" title="Reference Stack">
                            <Layers className="w-3.5 h-3.5 inline text-slate-300" />
                          </th>
                          <th className="px-4 py-2 w-10 text-center print:hidden">
                            <ColumnHeaderMenu onAdd={handleAddColumnClick} isController={isController} />
                          </th>
                          <th className="px-4 py-3 w-10" />
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
                            return (
                              <tr
                                key={docRecord.id}
                                onClick={() => setSelectedDoc(docRecord)}
                                className={`cursor-pointer transition-colors ${
                                  isRowSelected
                                    ? "bg-blue-50"
                                    : selectedDoc?.id === docRecord.id
                                    ? "bg-slate-50"
                                    : "hover:bg-slate-50"
                                }`}
                              >
                                <td className="px-4 py-3" onClick={(e) => toggleSelectDoc(docRecord.id!, e)}>
                                  <input
                                    type="checkbox"
                                    checked={isRowSelected}
                                    onChange={() => {}}
                                    className="w-4 h-4 rounded accent-blue-600 cursor-pointer"
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
                                      <td key={colKey} className="px-4 py-2">
                                        <PillCell
                                          values={list}
                                          label={def.pillGroupLabel || def.label || "Equipment"}
                                          canEdit={isController || (activeRole !== "Viewer" && activeRole !== "Auditor")}
                                          onSave={async (newVals) => {
                                            await supabase.from("documents").update({
                                              metadata: { ...(docRecord.metadata ?? {}), [colKey]: newVals },
                                              updated_at: new Date().toISOString(),
                                            }).eq("id", docRecord.id);
                                          }}
                                        />
                                      </td>
                                    );
                                  }
                                  return (
                                    <td key={colKey} className="px-4 py-3 whitespace-nowrap text-slate-700">
                                      {renderDocCell(docRecord, colKey)}
                                    </td>
                                  );
                                })}
                                <td className="px-4 py-3 text-center">
                                  <CheckoutStatusCell
                                    docRecord={docRecord}
                                    currentUserId={uid ?? undefined}
                                    currentUserEmail={userEmail ?? undefined}
                                    userRole={activeRole}
                                    onCheckout={openCheckout}
                                  />
                                </td>
                                <td className="px-4 py-3 text-center">
                                  {(() => {
                                    const isStaged = stagedDocs.some((d) => d.id === docRecord.id);
                                    return (
                                      <button
                                        onClick={(e) => handleStageDoc(docRecord, e)}
                                        className={`p-1.5 rounded-lg transition-colors ${
                                          isStaged
                                            ? "text-orange-500 bg-orange-50 hover:bg-orange-100"
                                            : "text-slate-300 hover:text-orange-500 hover:bg-orange-50"
                                        }`}
                                        title={isStaged ? "Remove from Reference Stack" : "Add to Reference Stack"}
                                      >
                                        <Layers className="w-3.5 h-3.5" />
                                      </button>
                                    );
                                  })()}
                                </td>
                                <td className="px-4 py-3 text-right">
                                  <button
                                    onClick={(e) => { e.stopPropagation(); setSelectedDoc(docRecord); setShowMetadataEditor(true); }}
                                    className="text-slate-400 hover:text-slate-600 p-1 rounded-md hover:bg-slate-100 transition-colors"
                                  >
                                    <Pencil className="w-3 h-3" />
                                  </button>
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            {/* INSPECTOR PANEL */}
            {selectedDoc && (
              <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm self-start sticky top-4">
                <div className="flex items-center justify-between mb-4">
                  <div className="text-sm font-bold text-slate-900">Inspector</div>
                  <button onClick={() => setSelectedDoc(null)} className="text-slate-400 hover:text-slate-600 transition-colors">
                    <X className="w-4 h-4" />
                  </button>
                </div>
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
                />
              </div>
            )}
          </div>
        </div>
      </div>

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
        />
      )}

      {showColumnManager && (
        <ColumnManager
          isOpen={showColumnManager}
          onClose={() => setShowColumnManager(false)}
          columns={columnOptions}
          active={activeColumns}
          onChange={updateColumns}
        />
      )}

      {showCreateColumn && (
        <CreateColumnWizard 
          isOpen={showCreateColumn} 
          onClose={() => setShowCreateColumn(false)} 
          onSave={handleSaveColumn}
          initialType={wizardInitType}
          initialStep={wizardInitStep}
        />
      )}

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
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-900/60 p-4">
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
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-900/60 p-4">
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
