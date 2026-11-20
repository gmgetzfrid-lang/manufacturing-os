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
  RefreshCw, ChevronRight, FolderOpen, FileText, KeyRound,
  EyeOff, Lock, Loader2,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import type { AccessControl } from "@/types/schema";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroQuiet } from "@/components/ui/PageHero";
import { plural } from "@/components/admin/band";
import LoadingBlock from "@/components/ui/LoadingBlock";
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
  if (v === "private") return <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-rose-500/10 border border-rose-500/30 text-rose-700 dark:text-rose-300 text-[11px] font-bold"><Lock className="w-2.5 h-2.5" /> private</span>;
  if (v === "hidden") return <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-300 text-[11px] font-bold"><EyeOff className="w-2.5 h-2.5" /> hidden</span>;
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [docsFailed, setDocsFailed] = useState<Set<string>>(new Set());

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
      if (l.error || c.error) throw new Error((l.error ?? c.error)?.message);
      setLoadError(null);
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
      setDocsFailed(new Set());
    } catch (e) {
      setLoadError((e as Error).message || "Couldn't load libraries and folders.");
    } finally { setLoading(false); }
  }, [activeOrgId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const loadDocs = useCallback(async (folderId: string, libraryId: string) => {
    if (!activeOrgId || docsByFolder.has(folderId)) return;
    setLoadingDocsFor(folderId);
    try {
      const { data, error } = await supabase
        .from("documents")
        .select("id, document_number, title, name, acl, visibility, collection_id")
        .eq("org_id", activeOrgId).eq("library_id", libraryId).eq("collection_id", folderId)
        .order("document_number").limit(200);
      if (error) { setDocsFailed((s) => new Set(s).add(folderId)); return; }
      setDocsFailed((s) => { if (!s.has(folderId)) return s; const n = new Set(s); n.delete(folderId); return n; });
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
        <span className="text-[11px] font-bold text-[var(--color-text-muted)]">{ruleCount(node.acl)} rule{ruleCount(node.acl) === 1 ? "" : "s"}</span>
      )}
      <button
        onClick={() => openDrawer(nodeType, node, node.name, chain)}
        className="ml-auto shrink-0 inline-flex items-center gap-1 h-8 px-2.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[12px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
      >
        <KeyRound className="w-3 h-3 text-[var(--color-text-muted)]" /> <span className="max-sm:hidden">{canEdit ? "Edit permissions" : "View permissions"}</span><span className="sm:hidden">{canEdit ? "Edit" : "View"}</span>
      </button>
    </div>
  );

  // The answer: how many places carry their own rules (or are hidden).
  const ruled = [...libs, ...folders].filter((n) => ruleCount(n.acl) > 0 || n.visibility !== "normal").length;
  const answer = loading && libs.length === 0 ? "Permissions"
    : loadError ? "Couldn't load permissions."
    : libs.length === 0 ? "No libraries yet."
    : ruled === 0 ? `${plural(libs.length, "library", "libraries")}, no special rules.`
    : `${plural(libs.length, "library", "libraries")}, ${ruled} place${ruled === 1 ? "" : "s"} with own rules.`;

  return (
    <PageShell width="work">
      <PageHero
        kicker="Admin · Permissions"
        title={answer}
        sub={loading ? "Who can see and change each library, folder and document." : `${plural(folders.length, "folder")}. Deny beats allow, and a folder can stop inheriting.`}
        tools={
          <button type="button" className={heroQuiet} onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
        }
      />

      <PageBody>
      {/* ── Content permissions: the real editor ── */}
      <Card pad={false} className="overflow-hidden">
        <div className="px-4 sm:px-5 py-3.5 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap">
          <KeyRound className="w-4 h-4 text-[var(--color-text-muted)]" />
          <h2 className="text-[13px] font-semibold text-[var(--color-text-muted)]">Content permissions</h2>
          <span className="text-[13px] text-[var(--color-text-muted)]">Library, then folder, then document.</span>
        </div>
        {loading && libs.length === 0 ? (
          <LoadingBlock what="libraries and folders" className="border-0 rounded-none p-5" />
        ) : loadError ? (
          <p role="alert" className="p-5 text-[14px] text-red-700 dark:text-red-400">
            Couldn&apos;t load libraries and folders: {loadError}{" "}
            <button type="button" onClick={() => void refresh()} className="font-bold underline">Try again</button>
          </p>
        ) : libs.length === 0 ? (
          <div className="p-8 text-center text-[14px] text-[var(--color-text-muted)]">No libraries yet. Make one in Libraries, then set who sees it here.</div>
        ) : (
          <div className="px-4 sm:px-5 pb-3">
            {libs.map((lib) => (
              <details key={lib.id} className="group/lib" open={libs.length <= 3}>
                <summary className="cursor-pointer list-none flex items-center gap-2 py-2 select-none">
                  <ChevronRight className="w-4 h-4 text-[var(--color-text-faint)] transition-transform group-open/lib:rotate-90" />
                  <span className="text-[14px] font-bold text-[var(--color-text)]">{lib.name}</span>
                  <span className="text-[12px] text-[var(--color-text-muted)] max-sm:hidden">library</span>
                  <VisBadge v={lib.visibility} />
                  {ruleCount(lib.acl) > 0 && <span className="text-[11px] font-bold text-[var(--color-text-muted)]">{ruleCount(lib.acl)} rules</span>}
                  <button
                    onClick={(e) => { e.preventDefault(); openDrawer("library", lib, lib.name, []); }}
                    className="ml-auto shrink-0 inline-flex items-center gap-1 h-8 px-2.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[12px] font-semibold hover:bg-[var(--color-surface-2)]"
                  >
                    <KeyRound className="w-3 h-3 text-[var(--color-text-muted)]" /> <span className="max-sm:hidden">{canEdit ? "Edit permissions" : "View permissions"}</span><span className="sm:hidden">{canEdit ? "Edit" : "View"}</span>
                  </button>
                </summary>
                <div className="ml-5 border-l border-[var(--color-border)] pl-2 pb-1">
                  {folders.filter((f) => f.libraryId === lib.id).map((f) => (
                    <details key={f.id} className="group/fold" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) void loadDocs(f.id, lib.id); }}>
                      <summary className="cursor-pointer list-none flex items-center gap-2 py-1.5 select-none border-t border-[var(--color-border)]">
                        <ChevronRight className="w-3.5 h-3.5 text-[var(--color-text-faint)] transition-transform group-open/fold:rotate-90" />
                        <FolderOpen className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                        <span className="text-sm font-medium text-[var(--color-text)]">{f.name}</span>
                        <VisBadge v={f.visibility} />
                        {ruleCount(f.acl) > 0 && <span className="text-[11px] font-bold text-[var(--color-text-muted)]">{ruleCount(f.acl)} rules</span>}
                        <button
                          onClick={(e) => { e.preventDefault(); openDrawer("collection", f, f.name, [lib.acl ?? undefined]); }}
                          className="ml-auto shrink-0 inline-flex items-center gap-1 h-8 px-2.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[12px] font-semibold hover:bg-[var(--color-surface-2)]"
                        >
                          <KeyRound className="w-3 h-3 text-[var(--color-text-muted)]" /> {canEdit ? "Edit" : "View"}
                        </button>
                      </summary>
                      <div className="ml-5">
                        {loadingDocsFor === f.id && <div className="py-2 text-xs text-[var(--color-text-muted)]"><Loader2 className="w-3 h-3 animate-spin inline mr-1" />Loading documents…</div>}
                        {(docsByFolder.get(f.id) ?? []).map((d) =>
                          nodeRow(d, "document", [lib.acl ?? undefined, f.acl ?? undefined],
                            <FileText className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />, ""),
                        )}
                        {docsFailed.has(f.id) && (
                          <div role="alert" className="py-1.5 text-[11px] text-red-700 dark:text-red-400">Couldn&apos;t load this folder&apos;s documents. Close and open it again.</div>
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
      </Card>

      {/* ── Action permissions: configurable workflow authority ── */}
      <CapabilityPolicyEditor canEdit={canEdit} />

      {/* ── "View as" + per-person delegations ── */}
      <ViewAsSimulator canEdit={canEdit} />

      <PermissionsExplorer />

      {/* Deep detail: audit-derived tree with live holders & known gaps. */}
      <details>
        <summary className="cursor-pointer text-[13px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-1 py-1">Detailed role tree (live holders, situational authority, known gaps)</summary>
        {activeOrgId && <RoleModelTree orgId={activeOrgId} />}
      </details>
      </PageBody>

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
