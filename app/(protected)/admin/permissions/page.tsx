"use client";

// /admin/permissions: the workspace's one permissions console.
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
import { RefreshCw, ChevronRight, FolderOpen, FileText, EyeOff, Lock } from "lucide-react";
import Link from "next/link";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import type { AccessControl } from "@/types/schema";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, heroQuiet } from "@/components/ui/PageHero";
import { tbl, btnRow, link, Section } from "@/components/admin/kit";
import { plural } from "@/components/admin/band";
import Disclosure from "@/components/admin/Disclosure";
import { onTreeKeyDown } from "@/components/admin/treeKeys";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { ErrorNote } from "@/components/ui/ErrorNote";
import HelpTooltip from "@/components/ui/HelpTooltip";
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

/** Hidden or private: a muted icon and a word (it isn't an alarm). */
function Vis({ v }: { v: string }) {
  if (v === "private") return <span className="inline-flex items-center gap-1 text-body text-[var(--color-text-muted)] shrink-0"><Lock aria-hidden className="w-3.5 h-3.5" /> Private</span>;
  if (v === "hidden") return <span className="inline-flex items-center gap-1 text-body text-[var(--color-text-muted)] shrink-0"><EyeOff aria-hidden className="w-3.5 h-3.5" /> Hidden</span>;
  return null;
}

function Rules({ n }: { n: number }) {
  return n > 0 ? <span className="text-body text-[var(--color-text-muted)] whitespace-nowrap tabular-nums">{plural(n, "rule")}</span> : null;
}

export default function PermissionsConsolePage() {
  const { activeRole, activeOrgId } = useRole();
  const canEdit = !!activeRole && ADMIN_ROLES.has(activeRole);

  const [libs, setLibs] = useState<NodeRow[]>([]);
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [docsByFolder, setDocsByFolder] = useState<Map<string, DocRow[]>>(new Map());
  const [loadingDocsFor, setLoadingDocsFor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
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
      if (l.error || c.error) throw l.error ?? c.error;
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
      setLoadError(e);
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

  // Edit (or View) on a row: always on the library rows; on folder and
  // document rows it shows on hover or focus (always on touch screens), so a
  // long tree isn't a column of identical buttons.
  const editBtn = (onClick: () => void, quietUntilHover: boolean, label: string) => (
    <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick(); }} aria-label={label}
      className={`ml-auto shrink-0 ${btnRow} ${quietUntilHover ? "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 group-focus-within/row:opacity-100 pointer-coarse:opacity-100" : ""}`}>
      {canEdit ? "Edit" : "View"}
    </button>
  );

  // The answer: how many places carry their own rules (or are hidden).
  const ruled = [...libs, ...folders].filter((n) => ruleCount(n.acl) > 0 || n.visibility !== "normal").length;
  const answer = loading && libs.length === 0 ? "Permissions"
    : loadError != null ? "Couldn't load permissions."
    : libs.length === 0 ? "No libraries yet."
    : ruled === 0 ? "No special rules."
    : `${ruled} place${ruled === 1 ? " has" : "s have"} their own rules.`;

  return (
    <PageShell width="work">
      <PageHero
        kicker="Admin · Permissions"
        title={answer}
        sub="Who can see and change each library, folder and document. Deny beats allow."
        factsHero="none"
        facts={libs.length > 0 ? [
          { label: "Libraries", value: libs.length },
          { label: "Folders", value: folders.length },
          { label: "With their own rules", value: ruled },
        ] : undefined}
        tools={
          <button type="button" className={heroQuiet} onClick={() => void refresh()} disabled={loading} aria-label="Check again" title="Check again">
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        }
      />

      <PageBody>
      {/* ── Content permissions: the real editor, as a tree ── */}
      <Section label={<>Content permissions <HelpTooltip>A library&apos;s rules apply to its folders and documents unless a folder or document sets its own. Open a library or folder to see what&apos;s inside; arrow keys move through the tree.</HelpTooltip></>}>
        {loading && libs.length === 0 ? (
          <SkeletonRows rows={4} cols={2} what="libraries and folders" />
        ) : loadError != null ? (
          <ErrorNote error={loadError} title="Couldn't load libraries and folders." onRetry={() => void refresh()} />
        ) : libs.length === 0 ? (
          <div className={`${tbl.wrap} px-4 py-8 text-center`}>
            <p className="text-reading text-[var(--color-text)]">Permissions are set per library. Make a library first.</p>
            <Link href="/admin/libraries" className={`${link} mt-1.5 inline-block font-medium`}>Go to Libraries</Link>
          </div>
        ) : (
          <div role="tree" aria-label="Libraries, folders and documents" onKeyDown={onTreeKeyDown} className={`${tbl.wrap} divide-y divide-[var(--color-border)]`}>
            {libs.map((lib) => {
              const libFolders = folders.filter((f) => f.libraryId === lib.id);
              return (
                <details key={lib.id} className="group/lib" open={libs.length <= 3}>
                  <summary role="treeitem" aria-selected={false} className="group/row cursor-pointer list-none [&::-webkit-details-marker]:hidden flex items-center gap-2.5 px-4 min-h-12 select-none hover:bg-[var(--color-surface-2)]">
                    <ChevronRight aria-hidden className="ui-chevron w-4 h-4 shrink-0 text-[var(--color-text-muted)] group-open/lib:rotate-90" />
                    <span className="font-medium text-[var(--color-text)] truncate">{lib.name}</span>
                    <span className="text-body text-[var(--color-text-muted)] max-sm:hidden whitespace-nowrap">{plural(libFolders.length, "folder")}</span>
                    <Vis v={lib.visibility} />
                    <Rules n={ruleCount(lib.acl)} />
                    {editBtn(() => openDrawer("library", lib, lib.name, []), false, `${canEdit ? "Edit" : "View"} permissions for ${lib.name}`)}
                  </summary>
                  {/* One level in: 16 px, along a guide line. */}
                  <div role="group" className="ml-4 border-l border-[var(--color-border)] pb-1">
                    {libFolders.map((f) => (
                      <details key={f.id} className="group/fold" onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) void loadDocs(f.id, lib.id); }}>
                        <summary role="treeitem" aria-selected={false} className="group/row cursor-pointer list-none [&::-webkit-details-marker]:hidden flex items-center gap-2 pl-4 pr-4 min-h-10 pointer-coarse:min-h-11 select-none border-t border-[var(--color-border)] hover:bg-[var(--color-surface-2)]">
                          <ChevronRight aria-hidden className="ui-chevron w-3.5 h-3.5 shrink-0 text-[var(--color-text-muted)] group-open/fold:rotate-90" />
                          <FolderOpen aria-hidden className="w-4 h-4 shrink-0 text-[var(--color-text-faint)]" />
                          <span className="text-body text-[var(--color-text)] truncate">{f.name}</span>
                          <Vis v={f.visibility} />
                          <Rules n={ruleCount(f.acl)} />
                          {editBtn(() => openDrawer("collection", f, f.name, [lib.acl ?? undefined]), true, `${canEdit ? "Edit" : "View"} permissions for ${f.name}`)}
                        </summary>
                        <div role="group" className="ml-4 border-l border-[var(--color-border)]">
                          {loadingDocsFor === f.id && <SkeletonRows rows={2} cols={1} sheet={false} what="documents" className="[&>div]:h-10" />}
                          {(docsByFolder.get(f.id) ?? []).map((d) => (
                            <div key={d.id} role="treeitem" aria-selected={false} tabIndex={-1} data-tree-row className="group/row flex items-center gap-2 pl-4 pr-4 min-h-10 pointer-coarse:min-h-11 border-t border-[var(--color-border)] hover:bg-[var(--color-surface-2)] focus:bg-[var(--color-surface-2)]">
                              <FileText aria-hidden className="w-4 h-4 shrink-0 text-[var(--color-text-faint)]" />
                              <span className="ui-id text-body truncate">{d.name}</span>
                              <Vis v={d.visibility} />
                              <Rules n={ruleCount(d.acl)} />
                              {editBtn(() => openDrawer("document", d, d.name, [lib.acl ?? undefined, f.acl ?? undefined]), true, `${canEdit ? "Edit" : "View"} permissions for ${d.name}`)}
                            </div>
                          ))}
                          {docsFailed.has(f.id) && (
                            <p role="alert" className="pl-4 py-2 border-t border-[var(--color-border)] text-body text-[var(--state-overdue-text)]">Couldn&apos;t load this folder&apos;s documents. Close it and open it again.</p>
                          )}
                          {docsByFolder.has(f.id) && (docsByFolder.get(f.id) ?? []).length === 0 && (
                            <p className="pl-4 py-2 border-t border-[var(--color-border)] text-body text-[var(--color-text-muted)]">No documents directly in this folder.</p>
                          )}
                        </div>
                      </details>
                    ))}
                    {libFolders.length === 0 && (
                      <p className="pl-4 py-2 border-t border-[var(--color-border)] text-body text-[var(--color-text-muted)]">No folders.</p>
                    )}
                  </div>
                </details>
              );
            })}
          </div>
        )}
      </Section>

      {/* ── Action permissions: who may do each workflow action ── */}
      <CapabilityPolicyEditor canEdit={canEdit} />

      {/* ── "View as" and per-person delegations ── */}
      <ViewAsSimulator canEdit={canEdit} />

      {/* Reference, rarely needed: folded away. */}
      <Section label="Reference">
        <div className="space-y-2">
          <Disclosure title="Every permission in the app, by role" meta="Every role, side by side">
            <PermissionsExplorer />
          </Disclosure>
          <Disclosure title="Role model: who can do what, and why" meta="With the people who hold each role">
            {activeOrgId && <RoleModelTree orgId={activeOrgId} />}
          </Disclosure>
        </div>
      </Section>
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
