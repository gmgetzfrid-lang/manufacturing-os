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
  RefreshCw, ChevronRight, FolderOpen, FileText,
  EyeOff, Lock, Loader2, Library, ShieldCheck,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import type { AccessControl } from "@/types/schema";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, heroQuiet } from "@/components/ui/PageHero";
import { tbl, btnRow, btnQuiet, Section, Problem, Pill } from "@/components/admin/kit";
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
  if (v === "private") return <Pill tone="bad"><Lock className="w-3.5 h-3.5" /> Private</Pill>;
  if (v === "hidden") return <Pill tone="warn"><EyeOff className="w-3.5 h-3.5" /> Hidden</Pill>;
  return null;
}

function Rules({ n }: { n: number }) {
  return n > 0 ? <span className="inline-flex items-center gap-1 text-[13px] text-[var(--color-text-muted)]"><span className="ui-count">{n}</span> rule{n === 1 ? "" : "s"}</span> : null;
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
    <div key={node.id} className={`flex items-center gap-2.5 ${indent} pl-1 pr-4 py-1.5 border-t border-[var(--color-border)] hover:bg-[var(--color-surface-2)]`}>
      {icon}
      <span className="ui-id text-[15px] truncate">{node.name}</span>
      <VisBadge v={node.visibility} />
      <Rules n={ruleCount(node.acl)} />
      <button type="button" onClick={() => openDrawer(nodeType, node, node.name, chain)} className={`ml-auto shrink-0 ${btnRow}`}>
        {canEdit ? "Edit" : "View"}
      </button>
    </div>
  );

  // The answer: how many places carry their own rules (or are hidden).
  const ruled = [...libs, ...folders].filter((n) => ruleCount(n.acl) > 0 || n.visibility !== "normal").length;
  const answer = loading && libs.length === 0 ? "Permissions"
    : loadError ? "Couldn't load permissions."
    : libs.length === 0 ? "No libraries yet."
    : ruled === 0 ? "No special rules."
    : `${ruled} place${ruled === 1 ? " has" : "s have"} their own rules.`;

  return (
    <PageShell width="work">
      <PageHero
        kicker="Admin · Permissions"
        title={answer}
        sub="Who can see and change each library, folder and document. Deny beats allow."
        facts={libs.length > 0 ? [
          { label: "Libraries", value: libs.length },
          { label: "Folders", value: folders.length },
          { label: "Own rules", value: ruled },
        ] : undefined}
        tools={
          <button type="button" className={heroQuiet} onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
        }
      />

      <PageBody>
      {/* ── Content permissions: the real editor ── */}
      <Section label="Content permissions" icon={ShieldCheck} action={<span className="text-[13px] text-[var(--color-text-muted)]">Library, then folder, then document</span>}>
        {loading && libs.length === 0 ? (
          <LoadingBlock what="libraries and folders" />
        ) : loadError ? (
          <Problem retry={() => void refresh()}>Couldn&apos;t load libraries and folders: {loadError}</Problem>
        ) : libs.length === 0 ? (
          <div className={`${tbl.wrap} p-8 text-center text-[var(--color-text-muted)]`}>No libraries yet. Make one in Libraries, then set who sees it here.</div>
        ) : (
          <div className={`${tbl.wrap} divide-y divide-[var(--color-border)]`}>
            {libs.map((lib) => (
              <details key={lib.id} className="group/lib" open={libs.length <= 3}>
                <summary className="cursor-pointer list-none flex items-center gap-2.5 px-4 h-12 select-none hover:bg-[var(--color-surface-2)]">
                  <ChevronRight className="w-4 h-4 text-[var(--color-text-muted)] transition-transform group-open/lib:rotate-90" />
                  <span aria-hidden className="ui-icon-tile is-sm"><Library className="w-4 h-4" /></span>
                  <span className="font-semibold text-[var(--color-text)]">{lib.name}</span>
                  <span className="inline-flex items-center gap-1 text-[13px] text-[var(--color-text-muted)] max-sm:hidden"><span className="ui-count">{folders.filter((f) => f.libraryId === lib.id).length.toLocaleString()}</span> {folders.filter((f) => f.libraryId === lib.id).length === 1 ? "folder" : "folders"}</span>
                  <VisBadge v={lib.visibility} />
                  <Rules n={ruleCount(lib.acl)} />
                  <button type="button" onClick={(e) => { e.preventDefault(); openDrawer("library", lib, lib.name, []); }} className={`ml-auto shrink-0 ${btnRow}`}>
                    <span className="max-sm:hidden">{canEdit ? "Edit permissions" : "View permissions"}</span><span className="sm:hidden">{canEdit ? "Edit" : "View"}</span>
                  </button>
                </summary>
                <div className="ml-9 border-l border-[var(--color-border)] pb-1">
                  {folders.filter((f) => f.libraryId === lib.id).map((f) => (
                    <details key={f.id} className="group/fold" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) void loadDocs(f.id, lib.id); }}>
                      <summary className="cursor-pointer list-none flex items-center gap-2.5 pl-2 pr-4 py-1.5 select-none border-t border-[var(--color-border)] hover:bg-[var(--color-surface-2)]">
                        <ChevronRight className="w-3.5 h-3.5 text-[var(--color-text-muted)] transition-transform group-open/fold:rotate-90" />
                        <span aria-hidden className="ui-icon-tile is-sm !w-6 !h-6"><FolderOpen className="w-3.5 h-3.5" /></span>
                        <span className="text-[15px] text-[var(--color-text)]">{f.name}</span>
                        <VisBadge v={f.visibility} />
                        <Rules n={ruleCount(f.acl)} />
                        <button type="button" onClick={(e) => { e.preventDefault(); openDrawer("collection", f, f.name, [lib.acl ?? undefined]); }} className={`ml-auto shrink-0 ${btnRow}`}>
                          {canEdit ? "Edit" : "View"}
                        </button>
                      </summary>
                      <div className="ml-6">
                        {loadingDocsFor === f.id && <div className="py-2 text-[13px] text-[var(--color-text-muted)]"><Loader2 className="w-3.5 h-3.5 animate-spin inline mr-1.5" />Loading documents…</div>}
                        {(docsByFolder.get(f.id) ?? []).map((d) =>
                          nodeRow(d, "document", [lib.acl ?? undefined, f.acl ?? undefined],
                            <span aria-hidden className="ui-icon-tile is-sm !w-6 !h-6"><FileText className="w-3.5 h-3.5" /></span>, ""),
                        )}
                        {docsFailed.has(f.id) && (
                          <Problem className="py-1.5">Couldn&apos;t load this folder&apos;s documents. Close and open it again.</Problem>
                        )}
                        {docsByFolder.has(f.id) && (docsByFolder.get(f.id) ?? []).length === 0 && (
                          <div className="py-1.5 text-[13px] text-[var(--color-text-muted)]">No documents directly in this folder.</div>
                        )}
                      </div>
                    </details>
                  ))}
                  {folders.filter((f) => f.libraryId === lib.id).length === 0 && (
                    <div className="pl-3 py-1.5 text-[13px] text-[var(--color-text-muted)]">No folders.</div>
                  )}
                </div>
              </details>
            ))}
          </div>
        )}
      </Section>

      {/* ── Action permissions: configurable workflow authority ── */}
      <CapabilityPolicyEditor canEdit={canEdit} />

      {/* ── "View as" + per-person delegations ── */}
      <ViewAsSimulator canEdit={canEdit} />

      <PermissionsExplorer />

      {/* Deep detail: audit-derived tree with live holders & known gaps. */}
      <details className="group/tree">
        <summary className={`${btnQuiet} cursor-pointer list-none select-none`}>
          <ChevronRight className="w-4 h-4 transition-transform group-open/tree:rotate-90" /> Detailed role tree
        </summary>
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
