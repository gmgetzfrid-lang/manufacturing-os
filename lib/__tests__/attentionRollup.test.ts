// @vitest-environment jsdom
//
// notifications Round G, N11 TRAIL — the badge continues below the sidebar
// (GAP-202 step 3; TRAIL-1, TRAIL-6, TRAIL-11, TAX-10, DELIV-3 dw3), and the
// N4 hand-offs it carries (RT-1 dw4 on the bell and the rail; the checked
// mark-read writes).
//
//   GAP-202 acceptance 2   a notification about a document rolls up to its
//                          folder (and every folder on the path) and its
//                          library; both clear when the row is read.
//   GAP-202 acceptance 4   a viewer without read on a document never sees a
//                          count that includes it — both directions: the
//                          roll-up places a document only through the
//                          viewer's own read (the documents ACL).
//   GAP-202 acceptance 6   a failed roll-up read renders as unknown ("?"),
//                          never as zero.
//   GAP-202 "Do not"       no per-container table, no service-role roll-up,
//                          no third chain walk (the resolver's
//                          folderChainFromMap), no number on every row, and
//                          the fan-out does not grow per row.
//   REGRESSION (DEC-90)    a surface with nothing to mark renders exactly as
//                          before (FolderRail, FolderGrid, DocGridView,
//                          AttentionDot) — pinned by markup equality.
//   RT-1 dw4               the bell and the sidebar badge read
//                          useAttentionStatus().stale and say so.
//   N3 → N4 hand-off       markRead / markManyRead / markAllRead read
//                          { error } and throw; the feed says a refusal.
//
// The REAL provider, hook, roll-up, bell and sidebar render here; only the
// database (a row-level-security double for documents), the session and the
// router are doubles.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;
const fx = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  /** Every document in the database: id → { library_id, collection_id }. */
  documents: {} as Record<string, { library_id: string; collection_id: string | null }>,
  /** The documents the signed-in viewer may read (the documents ACL). */
  readable: new Set<string>(),
  collections: {} as Record<string, { path_ids: string[] }>,
  docsFail: false,
  foldersFail: false,
  reads: [] as Array<{ table: string; ids: string[]; filters: Array<[string, unknown]>; cols: string }>,
  channels: [] as Array<{ ons: Array<{ cfg: Record<string, unknown>; cb: (p: unknown) => void }>; status?: (s: string) => void }>,
  role: {
    roles: ["Viewer"], activeRole: "Viewer", activeOrgId: "o1", uid: "u1", userEmail: "me@example.com",
    membershipState: "member", hasAnyRole: (_r: string[]) => false, setActiveOrgId: () => {},
  },
  markFails: false,
  updateError: null as string | null,
  /** Row-level security lets the update reach only these ids (no error): null = every id asked. */
  updateReach: null as string[] | null,
}));

vi.mock("@/lib/supabase", () => {
  const chain = (table: string): Record<string, unknown> => {
    const q: Record<string, unknown> = {};
    const read = { table, ids: [] as string[], filters: [] as Array<[string, unknown]>, cols: "" };
    let isUpdate = false;
    for (const m of ["not", "order", "limit", "range", "is", "or", "gte", "lt", "contains"]) q[m] = () => q;
    q.select = (cols?: string) => { read.cols = cols ?? "*"; return q; };
    q.eq = (col: string, v: unknown) => { read.filters.push([col, v]); return q; };
    q.in = (_col: string, ids: string[]) => { read.ids = ids; return q; };
    q.update = () => { isUpdate = true; return q; };
    q.maybeSingle = async () => ({ data: null, error: null });
    q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
      if (isUpdate) {
        if (fx.updateError) return Promise.resolve({ data: null, error: { message: fx.updateError } }).then(ok, ko);
        const asked = read.ids.length ? read.ids : read.filters.filter(([c]) => c === "id").map(([, v]) => String(v));
        const reached = asked.filter((id) => fx.updateReach === null || fx.updateReach.includes(id));
        return Promise.resolve({ data: read.cols ? reached.map((id) => ({ id })) : null, error: null }).then(ok, ko);
      }
      if (table === "documents" || table === "collections") fx.reads.push(read);
      let result: unknown = { data: [], error: null, count: 0 };
      if (table === "documents") {
        result = fx.docsFail ? { data: null, error: { message: "documents read refused" } }
          // Row-level security: only the documents the viewer may read come back.
          : { data: read.ids.filter((id) => fx.documents[id] && fx.readable.has(id)).map((id) => ({ id, ...fx.documents[id] })), error: null };
      } else if (table === "collections") {
        result = fx.foldersFail ? { data: null, error: { message: "collections read refused" } }
          : { data: read.ids.filter((id) => fx.collections[id]).map((id) => ({ id, ...fx.collections[id] })), error: null };
      }
      return Promise.resolve(result).then(ok, ko);
    };
    return q;
  };
  return {
    supabase: {
      from: (t: string) => chain(t),
      channel: () => {
        const c = { ons: [] as Array<{ cfg: Record<string, unknown>; cb: (p: unknown) => void }>, status: undefined as undefined | ((s: string) => void) };
        fx.channels.push(c);
        const api: Record<string, unknown> = {
          on: (_e: string, cfg: Record<string, unknown>, cb: (p: unknown) => void) => { c.ons.push({ cfg, cb }); return api; },
          subscribe: (cb?: (s: string) => void) => { c.status = cb; return api; },
        };
        return api;
      },
      removeChannel: () => {},
      auth: { signOut: async () => ({}) },
    },
    setPreferMicrosoft: () => {},
  };
});
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => fx.role }));
vi.mock("@/components/providers/OrgBrandingProvider", () => ({ useOrgBranding: () => ({ logoUrl: null, branding: null, canEdit: false }) }));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }));
vi.mock("@/lib/swSession", () => ({ clearServiceWorkerSession: async () => {}, signOutOfThisBrowser: async () => ({}) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard", useRouter: () => ({ push: () => {}, replace: () => {} }) }));
vi.mock("@/components/documents/DocThumb", () => ({ default: () => null }));
vi.mock("@/components/documents/NodeCover", () => ({ default: () => null }));
vi.mock("@/lib/capabilityPolicy", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadCapabilityPolicy: async () => undefined,
  loadCapabilityPolicyEntry: async () => ({ policy: undefined, version: null }),
}));
vi.mock("@/lib/inAppNotifications", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    listMyNotifications: async () => fx.rows,
    countUnread: async () => fx.rows.length,
    listUnreadKindsBeyond: async () => [],
    markRead: async () => { if (fx.markFails) throw new Error("Marking read was refused: denied"); },
    markAllRead: async () => { if (fx.markFails) throw new Error("Marking read was refused: denied"); },
  };
});
vi.mock("@/lib/notificationReconcile", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestReconcile: async () => ({ retired: [], kept: 0, failed: 0 }),
}));

import {
  buildAttentionRollup, resolvePlacements, attentionFor, documentIdsToPlace, PLACE_CAP, PLACE_CHUNK,
  NO_PLACEMENTS, EMPTY_ROLLUP, type RollupRow, type AttentionRollup,
} from "@/lib/attentionRollup";
import { AttentionProvider } from "@/components/providers/AttentionProvider";
import {
  useAttentionRollup, useAttentionFor, useAttentionStatus, useTicketNotifications, FETCH_DEBOUNCE_MS, MARK_READ_REFUSED,
  type AttentionStatus, type TicketNotifications,
} from "@/hooks/useTicketNotifications";
import AttentionDot, { attentionDotLabel } from "@/components/documents/AttentionDot";
import FolderRail from "@/components/documents/FolderRail";
import FolderGrid from "@/components/documents/FolderGrid";
import DocGridView from "@/components/documents/DocGridView";
import NotificationBell, { bellLabel, BELL_STALE_LINE } from "@/components/notifications/NotificationBell";
import Sidebar from "@/components/navigation/Sidebar";
import { NotificationCenterProvider } from "@/components/notifications/NotificationCenter";
import type { LibraryCollection, DocumentRecord } from "@/types/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = process.cwd();
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");

// ─── the pure roll-up ───────────────────────────────────────────────────────

const docRow = (id: string, action = false, section: string | null = "documents"): RollupRow =>
  ({ section, actionRequired: action, resourceType: "document", resourceId: id });

/** A fake viewer's reads: `readable` is the documents ACL. */
function readers(opts: { readable: string[]; docs: Record<string, { library_id: string; collection_id: string | null }>; folders?: Record<string, string[]>; docsFail?: boolean; foldersFail?: boolean }) {
  const docReads: string[][] = [];
  const folderReads: string[][] = [];
  return {
    docReads, folderReads,
    readDocs: async (ids: string[]) => {
      docReads.push(ids);
      if (opts.docsFail) return { data: null, error: { message: "refused" } };
      return { data: ids.filter((id) => opts.docs[id] && opts.readable.includes(id)).map((id) => ({ id, ...opts.docs[id] })), error: null };
    },
    readFolders: async (ids: string[]) => {
      folderReads.push(ids);
      if (opts.foldersFail) return { data: null, error: { message: "refused" } };
      return { data: ids.filter((id) => opts.folders?.[id]).map((id) => ({ id, path_ids: opts.folders![id] })), error: null };
    },
  };
}

// Piping (root) / P&IDs / Unit 12 — the RG-3 nesting.
const DOCS = { d1: { library_id: "libA", collection_id: "unit12" }, d2: { library_id: "libA", collection_id: null }, d9: { library_id: "libB", collection_id: "other" } };
const FOLDERS = { unit12: ["piping", "pids"], other: [] as string[] };

describe("GAP-202 acceptance 2 — a document's notification rolls up to every folder on its path and to its library; both clear when read", () => {
  it("folder chain nearest first (the resolver's walk), the library, the document; nothing else is marked", async () => {
    const r = readers({ readable: ["d1", "d2", "d9"], docs: DOCS, folders: FOLDERS });
    const placed = await resolvePlacements(["d1"], r.readDocs, r.readFolders);
    expect(placed.docs.get("d1")).toEqual({ libraryId: "libA", folderIds: ["unit12", "pids", "piping"] });
    const rollup = buildAttentionRollup([docRow("d1", true), docRow("d1")], placed);
    expect(rollup.byDocument.get("d1")).toEqual({ total: 2, action: 1 });
    expect(rollup.byLibrary.get("libA")).toEqual({ total: 2, action: 1 });
    for (const f of ["unit12", "pids", "piping"]) expect(rollup.byFolder.get(f)).toEqual({ total: 2, action: 1 });
    // mark the path to the thing, leave the rest quiet
    expect(rollup.byFolder.has("other")).toBe(false);
    expect(rollup.byLibrary.has("libB")).toBe(false);
    expect(attentionFor(rollup, { folderId: "other" })).toBeNull();
    expect(rollup.libraries).toBe("ready");
    expect(rollup.folders).toBe("ready");
  });

  it("once the rows are read (gone from the feed) the document, its folders and its library all clear", async () => {
    const r = readers({ readable: ["d1"], docs: DOCS, folders: FOLDERS });
    const placed = await resolvePlacements(["d1"], r.readDocs, r.readFolders);
    const after = buildAttentionRollup([], placed);
    expect(after.byDocument.size + after.byFolder.size + after.byLibrary.size).toBe(0);
    expect(attentionFor(after, { libraryId: "libA" })).toBeNull();
  });

  it("a document at the library root counts on the library only; a library row counts on its card", async () => {
    const r = readers({ readable: ["d2"], docs: DOCS, folders: FOLDERS });
    const placed = await resolvePlacements(["d2"], r.readDocs, r.readFolders);
    const rollup = buildAttentionRollup([docRow("d2"), { section: "documents", actionRequired: false, resourceType: "library", resourceId: "libC" }], placed);
    expect(rollup.byLibrary.get("libA")).toEqual({ total: 1, action: 0 });
    expect(rollup.byLibrary.get("libC")).toEqual({ total: 1, action: 0 });
    expect(rollup.byFolder.size).toBe(0);
    expect(r.folderReads).toEqual([]); // no folder to read
  });

  it("only what the sidebar badge counts is rolled up: a bell-only row and another section's row mark no container", () => {
    const placements = { docs: new Map([["d1", { libraryId: "libA", folderIds: ["unit12"] }]]), libraries: "ready" as const, folders: "ready" as const };
    const rollup = buildAttentionRollup([docRow("d1", false, null), docRow("d1", false, "requests")], placements);
    expect(rollup.byLibrary.size + rollup.byFolder.size + rollup.byDocument.size).toBe(0);
    expect(documentIdsToPlace([docRow("d1", false, null)])).toEqual([]);
  });

  it("a project row marks its project card", () => {
    const rollup = buildAttentionRollup([{ section: "projects", actionRequired: true, resourceType: "project", resourceId: "p1" }], NO_PLACEMENTS);
    expect(attentionFor(rollup, { projectId: "p1" })).toEqual({ total: 1, action: 1 });
    expect(attentionFor(rollup, { projectId: "p2" })).toBeNull();
  });
});

describe("GAP-202 acceptance 4 — the permission trap, both directions", () => {
  it("a document the viewer cannot read is placed nowhere: no folder, no library count includes it", async () => {
    const r = readers({ readable: ["d2"], docs: DOCS, folders: FOLDERS }); // d1 is hidden from this viewer
    const placed = await resolvePlacements(["d1", "d2"], r.readDocs, r.readFolders);
    expect(placed.docs.has("d1")).toBe(false);
    const rollup = buildAttentionRollup([docRow("d1", true), docRow("d2")], placed);
    expect(rollup.byLibrary.get("libA")).toEqual({ total: 1, action: 0 }); // d2 only
    for (const f of ["unit12", "pids", "piping"]) expect(rollup.byFolder.has(f)).toBe(false);
    // a missing row is not a failure: the roll-up is complete, not unknown
    expect(rollup.libraries).toBe("ready");
  });

  it("the same notification, for a viewer who CAN read the document, is counted", async () => {
    const r = readers({ readable: ["d1", "d2"], docs: DOCS, folders: FOLDERS });
    const placed = await resolvePlacements(["d1", "d2"], r.readDocs, r.readFolders);
    const rollup = buildAttentionRollup([docRow("d1", true), docRow("d2")], placed);
    expect(rollup.byLibrary.get("libA")).toEqual({ total: 2, action: 1 });
    expect(rollup.byFolder.get("pids")).toEqual({ total: 1, action: 1 });
  });

  it("no service role: the roll-up's reads are the provider's browser client — neither file imports a service-role client", () => {
    for (const f of ["lib/attentionRollup.ts", "hooks/useTicketNotifications.ts", "components/providers/AttentionProvider.tsx"]) {
      expect(src(f), f).not.toMatch(/supabaseAdmin|serviceRole|SERVICE_ROLE|@\/lib\/supabaseServer|@\/lib\/supabase-admin/);
    }
    expect(src("hooks/useTicketNotifications.ts")).toMatch(/import \{ supabase \} from '@\/lib\/supabase';/);
  });
});

describe("GAP-202 acceptance 6 — a failed roll-up read is unknown, never zero", () => {
  it("documents read refused → libraries and folders unknown; a card with no count shows '?', not nothing", async () => {
    const r = readers({ readable: ["d1"], docs: DOCS, folders: FOLDERS, docsFail: true });
    const placed = await resolvePlacements(["d1"], r.readDocs, r.readFolders);
    const rollup = buildAttentionRollup([docRow("d1")], placed);
    expect(rollup.libraries).toBe("unknown");
    expect(rollup.folders).toBe("unknown");
    expect(attentionFor(rollup, { libraryId: "libA" })).toBe("unknown");
    expect(attentionFor(rollup, { folderId: "pids" })).toBe("unknown");
    // the document row needs no placement: its own dot still shows
    expect(attentionFor(rollup, { documentId: "d1" })).toEqual({ total: 1, action: 0 });
    expect(renderToStaticMarkup(React.createElement(AttentionDot, { mark: "unknown", variant: "count" }))).toContain(">?</span>");
  });

  it("folders read refused → folder counts unknown, library counts still known", async () => {
    const r = readers({ readable: ["d1"], docs: DOCS, folders: FOLDERS, foldersFail: true });
    const placed = await resolvePlacements(["d1"], r.readDocs, r.readFolders);
    const rollup = buildAttentionRollup([docRow("d1")], placed);
    expect(rollup.libraries).toBe("ready");
    expect(attentionFor(rollup, { libraryId: "libA" })).toEqual({ total: 1, action: 0 });
    expect(attentionFor(rollup, { folderId: "pids" })).toBe("unknown");
  });

  it("a read that throws is unknown too; nothing to place is ready (no false '?')", async () => {
    const placed = await resolvePlacements(["d1"], async () => { throw new Error("offline"); }, async () => ({ data: [], error: null }));
    expect(placed.libraries).toBe("unknown");
    const none = buildAttentionRollup([], NO_PLACEMENTS);
    expect(none.libraries).toBe("ready");
    expect(attentionFor(none, { libraryId: "libA" })).toBeNull();
    expect(attentionFor(EMPTY_ROLLUP, { libraryId: "libA" })).toBeNull();
  });

  it("past the per-pass cap the roll-up is unknown, and the reads stay bounded (chunked, never one per row)", async () => {
    const ids = Array.from({ length: PLACE_CAP + 40 }, (_, i) => `x${i}`);
    const r = readers({ readable: [], docs: {} });
    const placed = await resolvePlacements(ids, r.readDocs, r.readFolders);
    expect(placed.libraries).toBe("unknown");
    expect(r.docReads.length).toBe(Math.ceil(PLACE_CAP / PLACE_CHUNK));
    for (const chunk of r.docReads) expect(chunk.length).toBeLessThanOrEqual(PLACE_CHUNK);
  });

  it("a count known while incomplete is a lower bound ('3+'), and the label says 'or more'", () => {
    const html = renderToStaticMarkup(React.createElement(AttentionDot, { mark: { total: 3, action: 0 }, variant: "count", partial: true }));
    expect(html).toContain(">3+</span>");
    expect(attentionDotLabel({ total: 3, action: 0 }, "here", true)).toMatch(/3 or more notifications/);
  });
});

describe("GAP-202 'Do not' — no third chain walk, no per-container table", () => {
  it("the folder fan-up is the container-chain resolver's folderChainFromMap; no ancestor read of its own", () => {
    const code = src("lib/attentionRollup.ts");
    expect(code).toMatch(/import \{ folderChainFromMap \} from "@\/lib\/containerChain";/);
    expect(code).toMatch(/folderChainFromMap\(r\.collectionId, folderMap\)/);
    // the walk is not re-implemented here: no parent_id climb
    expect(code).not.toMatch(/parent_id/);
  });

  it("no migration in this package (no notifications-per-container table)", () => {
    const files = readFileSync(join(ROOT, "audit-reports/notifications/04-cold-trail.md"), "utf8");
    expect(files).toContain("TRAIL-1");
    expect(() => readFileSync(join(ROOT, "supabase/migrations/20261243_notif_roundG_trail.sql"))).toThrow();
  });
});

// ─── the marker and the surfaces: nothing to mark renders as before ─────────

const FOLDER_LIST = [
  { id: "piping", name: "Piping", parentId: null },
  { id: "pids", name: "P&IDs", parentId: "piping" },
  { id: "unit12", name: "Unit 12", parentId: "pids" },
  { id: "other", name: "Other", parentId: null },
] as unknown as LibraryCollection[];
const DOC_LIST = [{ id: "d1", title: "Doc one", documentNumber: "D-1", status: "Issued" }, { id: "d2", title: "Doc two", status: "Draft" }] as unknown as DocumentRecord[];
const railProps = { libraryName: "Lib A", folders: FOLDER_LIST, currentFolderId: null, isController: false, onNavigate: () => {}, onCreateFolder: () => {} };
const gridProps = { folders: FOLDER_LIST, allFolders: FOLDER_LIST, onOpen: () => {}, isController: false };
const docProps = { docs: DOC_LIST, selectedIds: new Set<string>(), onItemClick: () => {}, onItemDoubleClick: () => {} };

describe("REGRESSION (DEC-90 ruling 4) — a surface with nothing to mark renders exactly as before", () => {
  it("AttentionDot renders nothing for a null mark (and for a zero count)", () => {
    expect(renderToStaticMarkup(React.createElement(AttentionDot, { mark: null }))).toBe("");
    expect(renderToStaticMarkup(React.createElement(AttentionDot, { mark: { total: 0, action: 0 }, variant: "count" }))).toBe("");
  });

  it("FolderRail, FolderGrid and DocGridView: markup with an all-null attention lookup equals the markup without one", () => {
    const none = () => null;
    expect(renderToStaticMarkup(React.createElement(FolderRail, { ...railProps, attentionFor: none }))).toBe(renderToStaticMarkup(React.createElement(FolderRail, railProps)));
    expect(renderToStaticMarkup(React.createElement(FolderGrid, { ...gridProps, attentionFor: none }))).toBe(renderToStaticMarkup(React.createElement(FolderGrid, gridProps)));
    for (const layout of ["list", "grid", "thumbs"] as const) {
      expect(renderToStaticMarkup(React.createElement(DocGridView, { ...docProps, layout, attentionFor: none }))).toBe(renderToStaticMarkup(React.createElement(DocGridView, { ...docProps, layout })));
    }
  });

  it("the pages add only an AttentionDot (null mark → nothing) — no wrapper, no class change around existing markup", () => {
    const lib = src("app/(protected)/documents/[libraryId]/page.tsx");
    expect(lib).toContain('<td className={`px-3 ${rowPad}`} onClick={(e) => toggleSelectDoc(docRecord.id!, e)}>');
    expect(lib).toMatch(/\{docRecord\.id && <AttentionDot mark=\{docAttention\(docRecord\.id\)\} variant="dot"/);
    const home = src("app/(protected)/documents/page.tsx");
    expect(home).toMatch(/<AttentionDot\s+mark=\{attentionFor\(attention, \{ libraryId: lib\._id \}\)\}\s+variant="count"/);
    const projects = src("app/(protected)/projects/page.tsx");
    expect(projects).toMatch(/<AttentionDot mark=\{attention\} variant="dot" where="on this project" \/>/);
  });
});

describe("marker density (DEC-90 ruling 1): a count on library cards and the folders on the path; a dot on the document row; nothing elsewhere", () => {
  const rollup: AttentionRollup = {
    byLibrary: new Map([["libA", { total: 2, action: 1 }]]),
    byFolder: new Map([["piping", { total: 2, action: 1 }], ["pids", { total: 2, action: 1 }], ["unit12", { total: 1, action: 0 }]]),
    byDocument: new Map([["d1", { total: 1, action: 1 }]]),
    byProject: new Map(), libraries: "ready", folders: "ready",
  };
  const folderAt = (id: string) => attentionFor(rollup, { folderId: id });
  const docAt = (id: string) => attentionFor(rollup, { documentId: id });

  it("FolderGrid: counts on the folders on the path; the unaffected folder carries nothing", () => {
    const html = renderToStaticMarkup(React.createElement(FolderGrid, { ...gridProps, attentionFor: folderAt }));
    const marks = html.match(/data-attention="[a-z]+"/g) ?? [];
    expect(marks.length).toBe(3);
    expect(html).toContain('data-attention="action"');
    expect(html).toMatch(/>2<\/span>/);
  });

  it("DocGridView: a dot (no number) on the badged document only; red-pulse vocabulary, still under reduced motion", () => {
    const html = renderToStaticMarkup(React.createElement(DocGridView, { ...docProps, layout: "list", attentionFor: docAt }));
    expect((html.match(/data-attention=/g) ?? []).length).toBe(1);
    expect(html).toContain("bg-red-500 motion-safe:animate-pulse");
    expect(html).not.toMatch(/data-attention="action"[^>]*>\d/);
  });

  it("FolderRail: the tree rows carry counts on the path; the icon rail a dot", () => {
    const html = renderToStaticMarkup(React.createElement(FolderRail, { ...railProps, attentionFor: folderAt }));
    const dom = new DOMParser().parseFromString(html, "text/html");
    // the icon rail: a dot (no number) on Piping, nothing on Other
    expect(dom.querySelector('button[title="Piping"] [data-attention]')?.textContent).toBe("");
    expect(dom.querySelector('button[title="Other"] [data-attention]')).toBeNull();
    // the tree: counts on the expanded folders on the path, none on Other
    const rows = [...dom.querySelectorAll("button.flex-1")].map((b) => [b.querySelector(".truncate")?.textContent, b.querySelector("[data-attention]")?.textContent ?? null]);
    expect(rows).toEqual([["Piping", "2"], ["P&IDs", "2"], ["Other", null]]);
  });

  it("the blue dot is unread, the red one action — the requests queue's vocabulary", () => {
    expect(renderToStaticMarkup(React.createElement(AttentionDot, { mark: { total: 1, action: 0 } }))).toContain("bg-blue-500");
    expect(attentionDotLabel({ total: 2, action: 1 }, "in this folder")).toBe("2 notifications in this folder, 1 needs your action");
  });
});

// ─── the provider, rendered ─────────────────────────────────────────────────

let host: HTMLDivElement;
let root: Root;
const flush = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const wait = async (ms: number) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); await flush(); };
const notif = (id: string, resourceId: string, kind = "library_doc_revised", extra: Row = {}): Row => ({
  id, orgId: "o1", userId: "u1", kind, title: `t ${id}`, body: null, link: `/documents/libA?doc=${resourceId}`,
  resourceType: "document", resourceId, actorUserId: null, actorName: null, metadata: null, readAt: null,
  createdAt: `2026-10-21T00:00:${id.replace(/\D/g, "").padStart(2, "0")}Z`, ...extra,
});

const seen: { rollup?: AttentionRollup; status?: AttentionStatus; value?: TicketNotifications; lib?: unknown } = {};
function Probe() {
  const rollup = useAttentionRollup();
  const status = useAttentionStatus();
  const value = useTicketNotifications();
  const lib = useAttentionFor({ libraryId: "libA" });
  React.useEffect(() => { Object.assign(seen, { rollup, status, value, lib }); });
  return null;
}
function LibraryView() {
  const rollup = useAttentionRollup();
  return React.createElement(FolderGrid, { ...gridProps, attentionFor: (id: string) => attentionFor(rollup, { folderId: id }) });
}
const mount = async (...children: React.ReactElement[]) => {
  await act(async () => { root.render(React.createElement(AttentionProvider, null, ...children)); });
  await flush();
};

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  fx.rows = []; fx.documents = { ...DOCS }; fx.readable = new Set(["d1", "d2", "d9"]); fx.collections = { unit12: { path_ids: ["piping", "pids"] }, other: { path_ids: [] } };
  fx.docsFail = false; fx.foldersFail = false; fx.reads = []; fx.channels = []; fx.markFails = false; fx.updateError = null; fx.updateReach = null;
  for (const k of Object.keys(seen)) delete (seen as Record<string, unknown>)[k];
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("the provider's roll-up (TRAIL-6 dw2/dw3, TAX-10 dw1) — resolved once per pass under the viewer's client", () => {
  it("one documents read (columns, org-scoped) and one folders read for the rows; the selector answers per library", async () => {
    fx.rows = [notif("n1", "d1", "checkout_conflict"), notif("n2", "d1"), notif("n3", "d2")];
    await mount(React.createElement(Probe));
    const docReads = fx.reads.filter((r) => r.table === "documents");
    expect(docReads.length).toBe(1);
    expect(docReads[0].cols).toBe("id, library_id, collection_id");
    expect(docReads[0].filters).toContainEqual(["org_id", "o1"]);
    expect([...docReads[0].ids].sort()).toEqual(["d1", "d2"]);
    expect(fx.reads.filter((r) => r.table === "collections").map((r) => r.ids)).toEqual([["unit12"]]);
    expect(seen.rollup!.byLibrary.get("libA")).toEqual({ total: 3, action: 1 });
    expect(seen.rollup!.byFolder.get("piping")).toEqual({ total: 2, action: 1 });
    expect(seen.lib).toEqual({ total: 3, action: 1 });
    // the sidebar's number is unchanged by the roll-up
    expect(seen.value!.sectionCounts.documents).toEqual({ total: 3, actionRequired: 1 });
  });

  it("permission trap, rendered: a row about a document the viewer cannot read badges Documents (as before) but no library or folder", async () => {
    fx.readable = new Set(["d2"]);
    fx.rows = [notif("n1", "d1", "checkout_conflict"), notif("n3", "d2")];
    await mount(React.createElement(Probe));
    expect(seen.value!.sectionCounts.documents.total).toBe(2);
    expect(seen.rollup!.byLibrary.get("libA")).toEqual({ total: 1, action: 0 });
    expect(seen.rollup!.byFolder.size).toBe(0);
  });

  it("a refused documents read leaves the library unknown — '?' on the card's marker, never a quiet zero", async () => {
    fx.docsFail = true;
    fx.rows = [notif("n1", "d1")];
    await mount(React.createElement(Probe), React.createElement(LibraryView));
    expect(seen.rollup!.libraries).toBe("unknown");
    expect(seen.lib).toBe("unknown");
    expect(host.querySelectorAll('[data-attention="unknown"]').length).toBe(FOLDER_LIST.length);
  });

  it("the fan-out does not grow per row: 40 folder tiles reading the roll-up add no query", async () => {
    fx.rows = [notif("n1", "d1")];
    await mount(React.createElement(Probe));
    const before = fx.reads.length;
    const many = Array.from({ length: 40 }, (_, i) => React.createElement(LibraryView, { key: i }));
    await act(async () => { root.render(React.createElement(AttentionProvider, null, React.createElement(Probe), ...many)); });
    await flush();
    expect(fx.reads.length).toBe(before);
    expect(fx.channels.length).toBe(1);
  });

  it("reading the document clears its folder and library markers on the next pass", async () => {
    fx.rows = [notif("n1", "d1", "checkout_conflict")];
    await mount(React.createElement(Probe), React.createElement(LibraryView));
    expect(host.querySelectorAll("[data-attention]").length).toBe(3); // unit12, pids, piping
    fx.rows = [];
    const notifs = fx.channels[0].ons.find((o) => o.cfg.table === "notifications")!;
    act(() => notifs.cb({ eventType: "UPDATE", new: { id: "n1", read_at: "2026-10-21T00:01:00Z" } }));
    await wait(FETCH_DEBOUNCE_MS + 150);
    expect(host.querySelectorAll("[data-attention]").length).toBe(0);
    expect(seen.lib).toBeNull();
  });

  it("no document rows → no documents read at all, and nothing marked (the page renders as before)", async () => {
    fx.rows = [notif("n4", "t1", "ticket_comment", { resourceType: "ticket", link: "/requests/t1" })];
    await mount(React.createElement(Probe), React.createElement(LibraryView));
    expect(fx.reads.filter((r) => r.table === "documents").length).toBe(0);
    expect(host.querySelectorAll("[data-attention]").length).toBe(0);
  });
});

// ─── RT-1 dw4 and the checked mark-read (N4 hand-offs) ──────────────────────

describe("RT-1 dw4 — the bell and the sidebar badge say when the feed is stale", () => {
  const chrome = () => React.createElement(NotificationCenterProvider, null, React.createElement(Sidebar), React.createElement(NotificationBell), React.createElement(Probe));

  it("live: no mark; dropped (CHANNEL_ERROR): a mark on the bell and on the badge, the names say so; rejoined: gone", async () => {
    fx.rows = [notif("n1", "d1")];
    await mount(chrome());
    const trigger = () => host.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement;
    const badge = () => [...host.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? "").startsWith("Documents:")) as HTMLButtonElement;
    expect(host.querySelector("[data-bell-stale]")).toBeNull();
    expect(badge().hasAttribute("data-badge-stale")).toBe(false);
    act(() => fx.channels[0].status!("SUBSCRIBED"));
    act(() => fx.channels[0].status!("CHANNEL_ERROR"));
    await flush();
    expect(seen.status!.stale).toBe(true);
    expect(host.querySelector("[data-bell-stale]")).not.toBeNull();
    expect(trigger().getAttribute("aria-label")).toBe(bellLabel(1, true));
    expect(trigger().getAttribute("aria-label")).toMatch(/reconnecting, the count may be out of date/);
    expect(badge().hasAttribute("data-badge-stale")).toBe(true);
    expect(badge().getAttribute("aria-label")).toMatch(/reconnecting — the count may be out of date/);
    // the drawer says it in words
    act(() => trigger().click());
    await flush();
    expect((host.querySelector("[data-bell-stale-line]") as HTMLElement).textContent).toBe(BELL_STALE_LINE);
    act(() => fx.channels[0].status!("SUBSCRIBED"));
    await flush();
    expect(host.querySelector("[data-bell-stale]")).toBeNull();
    expect(host.querySelector("[data-bell-stale-line]")).toBeNull();
    expect(badge().hasAttribute("data-badge-stale")).toBe(false);
  });
});

describe("the checked mark-read (the N3 → N4 hand-off; SAF-18)", () => {
  it("lib: markRead / markManyRead / markAllRead read { error } and throw on a refusal; resolve when the update lands", async () => {
    const actual = await vi.importActual<typeof import("@/lib/inAppNotifications")>("@/lib/inAppNotifications");
    await expect(actual.markRead("n1")).resolves.toBeUndefined();
    await expect(actual.markManyRead(["n1"])).resolves.toBeUndefined();
    await expect(actual.markAllRead("o1")).resolves.toBeUndefined();
    await expect(actual.markManyRead([])).resolves.toBeUndefined();
    // row-level security filters a refused update to zero rows, with no error: still a refusal
    fx.updateReach = [];
    await expect(actual.markRead("n1")).rejects.toThrow(/not marked/);
    fx.updateReach = ["n1"];
    await expect(actual.markManyRead(["n1", "n2"])).rejects.toThrow(/1 of 2 notifications were marked/);
    fx.updateReach = null;
    fx.updateError = "permission denied for table notifications";
    await expect(actual.markRead("n1")).rejects.toThrow(/Marking read was refused: permission denied/);
    await expect(actual.markManyRead(["n1"])).rejects.toThrow(/refused/);
    await expect(actual.markAllRead("o1")).rejects.toThrow(/refused/);
  });

  it("feed: a refused row mark is said (status.markError, the bell's drawer) — never an unhandled rejection; the next mark that lands clears it", async () => {
    fx.rows = [notif("n1", "d1")];
    await mount(React.createElement(NotificationCenterProvider, null, React.createElement(NotificationBell), React.createElement(Probe)));
    fx.markFails = true;
    await act(async () => { await seen.value!.markRead("n1"); });
    expect(seen.status!.markError).toBe(MARK_READ_REFUSED);
    act(() => (host.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement).click());
    await flush();
    expect((host.querySelector("[data-bell-mark-error]") as HTMLElement).textContent).toBe(MARK_READ_REFUSED);
    // "Mark all read" rethrows to its awaiting caller (and says it too)
    await expect(seen.value!.markAllRead()).rejects.toThrow(/refused/);
    fx.markFails = false;
    await act(async () => { await seen.value!.markRead("n1"); });
    expect(seen.status!.markError).toBeNull();
  });
});
