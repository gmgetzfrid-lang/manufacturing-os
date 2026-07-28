"use client";

// /admin/permissions — the org's single permissions console.
//
//   1. App-wide capability × role matrix (PermissionsExplorer) — the IT view.
//   2. CONTENT PERMISSIONS — the real, enforced editor: browse every library,
//      folder, and document and open its ACL drawer (visibility + allow/deny
//      rules per user/team/role, inheritance, expiry). This is the model the
//      database actually enforces (node_visible, user_can_publish_on_library,
//      can_manage_node).
//   3. Detailed role tree (live holders, situational authority, known gaps).
//
// The old read/write/admin role matrix is GONE: it wrote columns
// (libraries.read_access/write_access/admin_access) that no policy, trigger,
// or query ever read — a decorative permission system is worse than none.
// Confirmed safe to remove: no org data depended on it.

import React, { useCallback, useEffect, useState } from "react";
import {
  Shield, RefreshCw, ChevronRight, FolderOpen, FileText, KeyRound,
  EyeOff, Lock, Loader2,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import type { AccessControl } from "@/types/schema";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import RoleModelTree from "@/components/permissions/RoleModelTree";
import PermissionsExplorer from "@/components/permissions/PermissionsExplorer";
import PermissionsDrawer, { type NodeType } from "@/components/permissions/PermissionDrawer";
import CapabilityPolicyEditor from "@/components/permissions/CapabilityPolicyEditor";
import ViewAsSimulator from "@/components/permissions/ViewAsSimulator";

const ADMIN_ROLES = new Set(["Admin", "DocCtrl"]);

interface NodeRow {
  id: string;
  name: string;
  acl: AccessControl | null;
  visibility: "normal" | "hidden" | "private";
}
interface FolderRow extends NodeRow { libraryId: string }
interface DocRow extends NodeRow { collectionId: string | null }

function ruleCount(acl: AccessControl | null): number {
  return acl?.rules?.length ?? 0;
}

function VisBadge({ v }: { v: string }) {
  if (v === "private") return <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-rose-500/10 border border-rose-500/30 text-rose-700 dark:text-rose-300 text-[10px] font-bold"><Lock className="w-2.5 h-2.5" /> private</span>;
  if (v === "hidden") return <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-300 text-[10px] font-bold"><EyeOff className="w-2.5 h-2.5" /> hidden</span>;
  return null;
}

export default function PermissionsConsolePage() {
  const { activeRole, activeOrgId } = useRole();
  const canEdit = !!activeRole && ADMIN_ROLES.has(activeRole);

  const [libs, setLibs] = useState<NodeRow[]>([]);
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [docsByFolder, setDocsByFolder] = useState<Map<string, DocRow[]>>(new Map());
  const [loadingDocsFor, setLoadingDocsFor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [drawer, setDrawer] = useState<{
    nodeType: NodeType; nodeId: string; title: string;
    acl: AccessControl | null; visibility: "normal" | "hidden" | "private";
    aclChain: (AccessControl | undefined)[];
  } | null>(null);

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    setLoading(true);
    try {
      const [l, c] = await Promise.all([
        supabase.from("libraries").select("id, name, acl, visibility").eq("org_id", activeOrgId).order("name"),
        supabase.from("collections").select("id, name, library_id, acl, visibility").eq("org_id", activeOrgId).order("name"),
      ]);
      setLibs((((l.data ?? []) as Array<Record<string, unknown>>)).map((r) => ({
        id: String(r.id), name: String(r.name),
        acl: (r.acl as AccessControl | null) ?? null,
        visibility: ((r.visibility as string) || "normal") as NodeRow["visibility"],
      })));
      setFolders((((c.data ?? []) as Array<Record<string, unknown>>)).map((r) => ({
        id: String(r.id), name: String(r.name), libraryId: String(r.library_id),
        acl: (r.acl as AccessControl | null) ?? null,
        visibility: ((r.visibility as string) || "normal") as NodeRow["visibility"],
      })));
      setDocsByFolder(new Map());
    } finally { setLoading(false); }
  }, [activeOrgId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const loadDocs = useCallback(async (folderId: string, libraryId: string) => {
    if (!activeOrgId || docsByFolder.has(folderId)) return;
    setLoadingDocsFor(folderId);
    try {
      const { data } = await supabase
        .from("documents")
        .select("id, document_number, title, name, acl, visibility, collection_id")
        .eq("org_id", activeOrgId).eq("library_id", libraryId).eq("collection_id", folderId)
        .order("document_number").limit(200);
      const rows: DocRow[] = (((data ?? []) as Array<Record<string, unknown>>)).map((r) => ({
        id: String(r.id),
        name: String(r.document_number || r.title || r.name || "Document"),
        acl: (r.acl as AccessControl | null) ?? null,
        visibility: ((r.visibility as string) || "normal") as NodeRow["visibility"],
        collectionId: (r.collection_id as string | null) ?? null,
      }));
      setDocsByFolder((m) => new Map(m).set(folderId, rows));
    } finally { setLoadingDocsFor(null); }
  }, [activeOrgId, docsByFolder]);

  const openDrawer = (nodeType: NodeType, node: NodeRow, title: string, chain: (AccessControl | undefined)[]) =>
    setDrawer({ nodeType, nodeId: node.id, title, acl: node.acl, visibility: node.visibility, aclChain: chain });

  const nodeRow = (node: NodeRow, nodeType: NodeType, chain: (AccessControl | undefined)[], icon: React.ReactNode, indent: string) => (
    <div key={node.id} className={`flex items-center gap-2 ${indent} py-1.5 border-t border-[var(--color-border)] hover:bg-[var(--color-surface-2)]/50`}>
      {icon}
      <span className="text-sm font-medium text-[var(--color-text)] truncate">{node.name}</span>
      <VisBadge v={node.visibility} />
      {ruleCount(node.acl) > 0 && (
        <span className="text-[10px] font-bold text-[var(--color-text-muted)]">{ruleCount(node.acl)} rule{ruleCount(node.acl) === 1 ? "" : "s"}</span>
      )}
      <button
        onClick={() => openDrawer(nodeType, node, node.name, chain)}
        className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[11px] font-bold text-[var(--color-text)] hover:border-[var(--color-accent-ring)]"
      >
        <KeyRound className="w-3 h-3 text-[var(--color-accent)]" /> {canEdit ? "Edit permissions" : "View permissions"}
      </button>
    </div>
  );

  return (
    <PageShell width="work">
      <PageHeaderBar
        icon={Shield}
        title="Permissions"
        subtitle={<>The enforced model: per-node visibility + allow/deny rules (user, team, role) with inheritance and expiry — grant one person one nested folder without exposing anything else.</>}
        actions={
          <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        }
      />

      <PermissionsExplorer />

      {/* ── Content permissions: the real editor ── */}
      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] mb-5 overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-[var(--color-accent)]" />
          <span className="text-base font-bold text-[var(--color-text)]">Content permissions</span>
          <span className="text-xs text-[var(--color-text-muted)]">every library → folder → document; deny beats allow; child rules can cut inheritance</span>
        </div>
        {loading ? (
          <div className="py-10 flex justify-center"><Spinner /></div>
        ) : libs.length === 0 ? (
          <div className="p-8 text-center text-sm italic text-[var(--color-text-muted)]">No libraries yet.</div>
        ) : (
          <div className="px-4 pb-3">
            {libs.map((lib) => (
              <details key={lib.id} className="group/lib" open={libs.length <= 3}>
                <summary className="cursor-pointer list-none flex items-center gap-2 py-2 select-none">
                  <ChevronRight className="w-4 h-4 text-[var(--color-text-faint)] transition-transform group-open/lib:rotate-90" />
                  <span className="text-sm font-bold text-[var(--color-text)]">{lib.name}</span>
                  <span className="text-[10px] text-[var(--color-text-faint)]">library</span>
                  <VisBadge v={lib.visibility} />
                  {ruleCount(lib.acl) > 0 && <span className="text-[10px] font-bold text-[var(--color-text-muted)]">{ruleCount(lib.acl)} rules</span>}
                  <button
                    onClick={(e) => { e.preventDefault(); openDrawer("library", lib, lib.name, []); }}
                    className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[11px] font-bold hover:border-[var(--color-accent-ring)]"
                  >
                    <KeyRound className="w-3 h-3 text-[var(--color-accent)]" /> {canEdit ? "Edit permissions" : "View permissions"}
                  </button>
                </summary>
                <div className="ml-5 border-l border-[var(--color-border)] pl-2 pb-1">
                  {folders.filter((f) => f.libraryId === lib.id).map((f) => (
                    <details key={f.id} className="group/fold" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) void loadDocs(f.id, lib.id); }}>
                      <summary className="cursor-pointer list-none flex items-center gap-2 py-1.5 select-none border-t border-[var(--color-border)]">
                        <ChevronRight className="w-3.5 h-3.5 text-[var(--color-text-faint)] transition-transform group-open/fold:rotate-90" />
                        <FolderOpen className="w-3.5 h-3.5 text-amber-500" />
                        <span className="text-sm font-medium text-[var(--color-text)]">{f.name}</span>
                        <VisBadge v={f.visibility} />
                        {ruleCount(f.acl) > 0 && <span className="text-[10px] font-bold text-[var(--color-text-muted)]">{ruleCount(f.acl)} rules</span>}
                        <button
                          onClick={(e) => { e.preventDefault(); openDrawer("collection", f, f.name, [lib.acl ?? undefined]); }}
                          className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[11px] font-bold hover:border-[var(--color-accent-ring)]"
                        >
                          <KeyRound className="w-3 h-3 text-[var(--color-accent)]" /> {canEdit ? "Edit" : "View"}
                        </button>
                      </summary>
                      <div className="ml-5">
                        {loadingDocsFor === f.id && <div className="py-2 text-xs text-[var(--color-text-muted)]"><Loader2 className="w-3 h-3 animate-spin inline mr-1" />Loading documents…</div>}
                        {(docsByFolder.get(f.id) ?? []).map((d) =>
                          nodeRow(d, "document", [lib.acl ?? undefined, f.acl ?? undefined],
                            <FileText className="w-3.5 h-3.5 text-blue-500 shrink-0" />, ""),
                        )}
                        {docsByFolder.has(f.id) && (docsByFolder.get(f.id) ?? []).length === 0 && (
                          <div className="py-1.5 text-[11px] italic text-[var(--color-text-faint)]">No documents directly in this folder.</div>
                        )}
                      </div>
                    </details>
                  ))}
                  {folders.filter((f) => f.libraryId === lib.id).length === 0 && (
                    <div className="py-1.5 text-[11px] italic text-[var(--color-text-faint)]">No folders.</div>
                  )}
                </div>
              </details>
            ))}
          </div>
        )}
      </div>

      {/* ── Action permissions: configurable workflow authority ── */}
      <CapabilityPolicyEditor canEdit={canEdit} />

      {/* ── "View as" — simulate any member's effective access ── */}
      <ViewAsSimulator />

      {/* Deep detail: audit-derived tree with live holders & known gaps. */}
      <details className="mb-5">
        <summary className="cursor-pointer text-sm font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-1 py-1">Detailed role tree (live holders, situational authority, known gaps)</summary>
        {activeOrgId && <RoleModelTree orgId={activeOrgId} />}
      </details>

      {drawer && (
        <PermissionsDrawer
          isOpen
          onClose={() => { setDrawer(null); void refresh(); }}
          nodeType={drawer.nodeType}
          nodeId={drawer.nodeId}
          acl={drawer.acl}
          visibility={drawer.visibility}
          aclChain={drawer.aclChain}
          canEdit={canEdit}
          title={drawer.title}
        />
      )}
    </PageShell>
  );
}
