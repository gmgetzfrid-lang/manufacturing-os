// lib/sideUtility.ts - what the side menu shows under the tools: the
// documents checked out to this person (others wait on those), and "Jump
// back in": their starred documents first, then what they opened last
// (documents and projects), newest first.
//
// Light on the database: read once a little after the page loads, kept for
// the session (lib/warmLoads, cleared on sign-out), and read again when the
// window comes back after a few minutes. Projects come from this device
// (lib/recentProjects), never the database.

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { sharedLoad, keepLoaded, lastLoaded } from "@/lib/warmLoads";
import { useRecentProjects } from "@/lib/recentProjects";
import { DOC_VIEWED, type DocViewed } from "@/lib/recentDocs";
import { FAVORITES_CHANGED } from "@/lib/favorites";

export interface HeldDoc {
  documentId: string;
  libraryId: string | null;
  label: string;
  /** When it's due back (the person's own date, else the automatic one). */
  dueAt: string | null;
}

export interface JumpItem {
  kind: "doc" | "project";
  id: string;
  href: string;
  /** The document number, when it has one. */
  code: string | null;
  title: string;
  starred: boolean;
  at: number;
}

interface SideLoad { held: HeldDoc[]; starred: JumpItem[]; recentDocs: JumpItem[] }

const docHref = (libraryId: string | null, id: string) => (libraryId ? `/documents/${libraryId}?doc=${id}` : `/documents?doc=${id}`);
const KEY = (orgId: string, uid: string) => `side:${orgId}|${uid}`;

async function loadSide(orgId: string, uid: string): Promise<SideLoad> {
  const [sessions, favs, views] = await Promise.all([
    supabase.from("checkout_sessions")
      .select("document_id, library_id, auto_expires_at, expected_release_at")
      .eq("org_id", orgId).eq("user_id", uid).eq("status", "active")
      .order("started_at", { ascending: true }).limit(20),
    supabase.from("document_favorites").select("document_id, created_at")
      .eq("org_id", orgId).eq("user_id", uid)
      .order("created_at", { ascending: false }).limit(5),
    supabase.from("recently_viewed_docs").select("document_id, viewed_at")
      .eq("user_id", uid).eq("org_id", orgId).order("viewed_at", { ascending: false }).limit(8),
  ]);
  const held0 = (sessions.data ?? []) as Array<{ document_id: string; library_id: string | null; auto_expires_at: string | null; expected_release_at: string | null }>;
  const fav0 = (favs.data ?? []) as Array<{ document_id: string; created_at: string | null }>;
  const view0 = (views.data ?? []) as Array<{ document_id: string; viewed_at: string }>;
  const ids = [...new Set([...held0.map((r) => r.document_id), ...fav0.map((r) => r.document_id), ...view0.map((r) => r.document_id)])];
  const docs = new Map<string, { number: string | null; title: string; libraryId: string | null }>();
  if (ids.length) {
    // Only this workspace's documents (a recently viewed one may be another's).
    const { data } = await supabase.from("documents")
      .select("id, document_number, title, name, library_id").in("id", ids).eq("org_id", orgId);
    for (const d of (data ?? []) as Array<{ id: string; document_number: string | null; title: string | null; name: string | null; library_id: string | null }>) {
      docs.set(d.id, { number: d.document_number, title: (d.title || d.name || d.document_number || "Untitled").trim(), libraryId: d.library_id });
    }
  }
  const held: HeldDoc[] = held0.filter((r) => docs.has(r.document_id)).map((r) => {
    const d = docs.get(r.document_id)!;
    return { documentId: r.document_id, libraryId: r.library_id ?? d.libraryId, label: d.number || d.title, dueAt: r.expected_release_at || r.auto_expires_at };
  });
  const item = (id: string, at: string | null, starred: boolean): JumpItem | null => {
    const d = docs.get(id);
    if (!d) return null;
    return { kind: "doc", id, href: docHref(d.libraryId, id), code: d.number, title: d.title, starred, at: at ? Date.parse(at) : 0 };
  };
  const starred = fav0.map((r) => item(r.document_id, r.created_at, true)).filter(Boolean) as JumpItem[];
  const starredIds = new Set(starred.map((s) => s.id));
  const recentDocs = view0.filter((r) => !starredIds.has(r.document_id))
    .map((r) => item(r.document_id, r.viewed_at, false)).filter(Boolean) as JumpItem[];
  return { held, starred, recentDocs };
}

/** The side menu's lists for this person in this workspace. Null until read. */
export function useSideUtility(orgId: string | null | undefined, uid: string | null | undefined, max = 5): { held: HeldDoc[]; jump: JumpItem[] } | null {
  const [load, setLoad] = useState<SideLoad | null>(() => (orgId && uid ? lastLoaded<SideLoad>(KEY(orgId, uid)) ?? null : null));
  const projects = useRecentProjects(orgId);
  useEffect(() => {
    if (!orgId || !uid) return;
    let alive = true;
    let lastRead = 0;
    const read = () => {
      lastRead = Date.now();
      sharedLoad(KEY(orgId, uid), () => loadSide(orgId, uid))
        .then((l) => { keepLoaded(KEY(orgId, uid), l); if (alive) setLoad(l); }, () => undefined);
    };
    // After the page itself has loaded: never in the way of what's on screen.
    const t = window.setTimeout(read, 1500);
    // Back after a while: read again (a check-in elsewhere, a new star).
    const onFocus = () => { if (Date.now() - lastRead > 3 * 60_000) read(); };
    // A star added or taken off here: read again shortly (stars are rare).
    let starT: number | undefined;
    const onStars = () => { window.clearTimeout(starT); starT = window.setTimeout(read, 800); };
    // A document opened here: put it first from what the page already
    // knows. No database read (people click through many documents).
    const onViewed = (e: Event) => {
      const d = (e as CustomEvent<DocViewed>).detail;
      if (!d || d.orgId !== orgId) return;
      setLoad((cur) => {
        if (!cur) return cur;
        const code = d.number || null;
        const title = (d.title || code || "Untitled").trim();
        const fresh: JumpItem = { kind: "doc", id: d.documentId, href: docHref(d.libraryId, d.documentId), code, title, starred: false, at: d.at };
        const next: SideLoad = {
          ...cur,
          // A starred one keeps its place in the starred list.
          recentDocs: cur.starred.some((s) => s.id === d.documentId) ? cur.recentDocs : [fresh, ...cur.recentDocs.filter((r) => r.id !== d.documentId)].slice(0, 8),
        };
        keepLoaded(KEY(orgId, uid), next);
        return next;
      });
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener(FAVORITES_CHANGED, onStars);
    window.addEventListener(DOC_VIEWED, onViewed);
    return () => {
      alive = false; window.clearTimeout(t); window.clearTimeout(starT);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(FAVORITES_CHANGED, onStars);
      window.removeEventListener(DOC_VIEWED, onViewed);
    };
  }, [orgId, uid]);
  if (!load) return null;
  // Starred first; then documents and projects together, newest first.
  const recent: JumpItem[] = [
    ...load.recentDocs,
    ...projects.map((p) => ({ kind: "project" as const, id: p.id, href: `/projects/${p.id}`, code: null, title: p.name, starred: false, at: p.at ?? 0 })),
  ].sort((a, b) => b.at - a.at);
  return { held: load.held, jump: [...load.starred, ...recent].slice(0, max) };
}
