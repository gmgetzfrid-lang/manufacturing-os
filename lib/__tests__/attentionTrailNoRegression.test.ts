// @vitest-environment jsdom
//
// notifications Round G, N11 TRAIL second fix pass — DEC-90 ruling 4, pinned
// by RENDERING the pages: a surface with nothing to mark renders exactly as
// before. Each page is rendered for real (the in-memory PostgREST behind it)
// twice — once with the badge trail's marker and its unknown line live, once
// with both stubbed out (the page "without the marker") — and the two
// markups must be byte-identical with nothing to mark:
//   * /documents — the library card list;
//   * /documents/[libraryId] — the details-table row and the mobile card;
//   * /projects — ProjectCard;
// for EMPTY_ROLLUP (outside the provider) and for a roll-up that is ready
// but empty. A positive control proves each page does draw the marker when
// there is something to mark (so the equality is not vacuous), and
// AttentionUnknownNote renders nothing while the roll-up is complete.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { newFakeDb, makeFakeSupabase, type FakeDb } from "./helpers/fakeSupabase";

const s = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  /** true: the marker and its unknown line render nothing (the page without them). */
  stubMarker: false,
  role: {
    activeRole: "DocCtrl", roles: ["DocCtrl"], hasAnyRole: (rs: string[]) => rs.includes("DocCtrl"),
    userEmail: "ctl@x.io", activeOrgId: "o1", uid: "ctl1", loading: false, membershipState: "member",
  },
  projects: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabase", () => {
  // The in-memory PostgREST, with a realtime that never fires (the pages
  // subscribe on mount; nothing here depends on an event).
  const channel = () => {
    const api: Record<string, unknown> = {};
    api.on = () => api;
    api.subscribe = () => api;
    api.send = async () => "ok";
    api.httpSend = async () => ({ success: true });
    return api;
  };
  return {
    get supabase() {
      return Object.assign(makeFakeSupabase(s.db), {
        channel, removeChannel: async () => "ok", getChannels: () => [],
      });
    },
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useParams: () => ({ libraryId: "L1" }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/documents/L1",
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => s.role }));
vi.mock("@/components/providers/DialogProvider", () => ({
  appAlert: async () => undefined, appConfirm: async () => true, appPrompt: async () => null,
}));
vi.mock("@/lib/search", () => ({ searchDocuments: async () => [] }));
vi.mock("@/components/ui/RouteLoader", () => ({ default: () => null }));
vi.mock("@/components/documents/NodeCover", () => ({ default: () => null }));
vi.mock("@/components/documents/DocThumb", () => ({ default: () => null }));
vi.mock("@/components/documents/CustomizeNodeModal", () => ({ default: () => null }));
vi.mock("@/components/navigation/ViewTabs", () => ({ default: () => null, DOCUMENT_VIEWS: [] }));
vi.mock("@/components/projects/StaleCheckoutBanner", () => ({ default: () => null }));
vi.mock("@/components/projects/ProjectWizard", () => ({ default: () => null }));
vi.mock("@/lib/projects", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listProjects: async () => s.projects,
}));
vi.mock("@/components/documents/AttentionDot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/documents/AttentionDot")>();
  const Dot = (p: React.ComponentProps<typeof actual.default>) => (s.stubMarker ? null : React.createElement(actual.default, p));
  const Note = (p: React.ComponentProps<typeof actual.AttentionUnknownNote>) => (s.stubMarker ? null : React.createElement(actual.AttentionUnknownNote, p));
  return { ...actual, default: Dot, AttentionUnknownNote: Note };
});

import { AttentionRollupContext } from "@/hooks/useTicketNotifications";
import { EMPTY_ROLLUP, type AttentionRollup } from "@/lib/attentionRollup";
import { AttentionUnknownNote } from "@/components/documents/AttentionDot";
import DocumentsHomePage from "@/app/(protected)/documents/page";
import LibraryExplorerPage from "@/app/(protected)/documents/[libraryId]/page";
import ProjectsPage from "@/app/(protected)/projects/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const D1 = "00000000-0000-4000-8000-0000000000d1";
const D2 = "00000000-0000-4000-8000-0000000000d2";
const READY_EMPTY: AttentionRollup = { byLibrary: new Map(), byFolder: new Map(), byDocument: new Map(), byProject: new Map(), libraries: "ready", folders: "ready" };
const MARKED: AttentionRollup = {
  byLibrary: new Map([["L1", { total: 2, action: 1 }]]), byFolder: new Map(),
  byDocument: new Map([[D1, { total: 1, action: 1 }]]), byProject: new Map([["p1", { total: 1, action: 0 }]]),
  libraries: "ready", folders: "ready",
};

let host: HTMLDivElement;
let root: Root;
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

beforeEach(() => {
  s.db = newFakeDb();
  s.db.tables.orgs = [{ id: "o1", name: "Plant" }];
  s.db.tables.libraries = [
    { id: "L1", org_id: "o1", name: "Piping Isometrics", read_access: "ALL", created_at: "2026-09-01T00:00:00Z" },
    { id: "L2", org_id: "o1", name: "Specs", read_access: "ALL", created_at: "2026-08-01T00:00:00Z" },
  ];
  s.db.tables.collections = [];
  s.db.tables.documents = [
    { id: D1, org_id: "o1", library_id: "L1", collection_id: null, document_number: "P-001", title: "Line list", status: "Issued", rev: "A", legal_hold: false, created_at: "2026-09-02T00:00:00Z", updated_at: "2026-09-02T00:00:00Z" },
    { id: D2, org_id: "o1", library_id: "L1", collection_id: null, document_number: "P-002", title: "Isometric", status: "Draft", rev: "0", legal_hold: false, created_at: "2026-09-03T00:00:00Z", updated_at: "2026-09-03T00:00:00Z" },
  ];
  s.db.tables.tickets = [];
  s.projects = [
    { id: "p1", orgId: "o1", name: "Unit 12 revamp", status: "active", visibility: "public", ownerName: "Ann", memberIds: [], updatedAt: "2026-09-01T00:00:00Z", createdAt: "2026-08-01T00:00:00Z" },
    { id: "p2", orgId: "o1", name: "Tank farm", status: "active", visibility: "private", ownerName: "Bo", memberIds: [], updatedAt: "2026-09-01T00:00:00Z", createdAt: "2026-08-01T00:00:00Z" },
  ];
  s.stubMarker = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

/** The page's markup once its reads settle, under `rollup` (undefined: no
 *  provider — the hook answers EMPTY_ROLLUP), with the marker live or stubbed. */
async function markup(Page: React.ComponentType, rollup: AttentionRollup | undefined, stub: boolean): Promise<string> {
  s.stubMarker = stub;
  const page = React.createElement(Page);
  await act(async () => {
    root.render(rollup === undefined ? page : React.createElement(AttentionRollupContext.Provider, { value: rollup }, page));
  });
  await flush();
  const html = host.innerHTML;
  act(() => root.unmount());
  root = createRoot(host);
  return html;
}

/** [name, page, what must have rendered, how many marks MARKED draws there] */
const PAGES: Array<[string, React.ComponentType, (html: string) => void, number]> = [
  ["/documents — the library card list", DocumentsHomePage, (html) => { expect(html).toContain("Piping Isometrics"); expect(html).toContain("Specs"); }, 1],
  ["/documents/[libraryId] — the details-table row and the mobile card", LibraryExplorerPage, (html) => {
    // both document rows, in the table and in the mobile card list
    expect(html.match(/P-001/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(html).toContain("md:hidden flex-1 overflow-y-auto p-2 space-y-2");
    expect(html).toMatch(/<tr[^>]*>/);
  }, 2],
  ["/projects — ProjectCard", ProjectsPage, (html) => { expect(html).toContain("Unit 12 revamp"); expect(html).toContain("Tank farm"); }, 1],
];

describe("DEC-90 ruling 4 (rendered) — nothing to mark renders byte-identical markup to the page without the marker", () => {
  for (const [name, Page, rendered, marks] of PAGES) {
    it(`${name}: EMPTY_ROLLUP and a ready-but-empty roll-up both equal the page without the marker`, async () => {
      const without = await markup(Page, undefined, true);
      rendered(without);
      expect(without).not.toContain("data-attention");
      expect(await markup(Page, undefined, false)).toBe(without);
      expect(await markup(Page, EMPTY_ROLLUP, false)).toBe(without);
      expect(await markup(Page, READY_EMPTY, false)).toBe(without);
    });

    it(`${name}: positive control — with something to mark the marker is drawn (the equality above is not vacuous)`, async () => {
      const without = await markup(Page, MARKED, true);
      const withMark = await markup(Page, MARKED, false);
      expect(withMark).not.toBe(without);
      // the library card (L1), the document's table row and mobile card (D1), the project card (p1)
      expect(withMark.match(/data-attention="[a-z]+"/g)?.length ?? 0).toBe(marks);
      // stripping the marker's own element gives the page back exactly
      expect(withMark.replace(/<span role="img"[^>]*data-attention="[a-z]+"[^>]*>(?:\d+\+?)?<\/span>/g, "")).toBe(without);
    });
  }

  it("AttentionUnknownNote renders nothing (byte-empty) while the roll-up is complete — idle, ready, or empty", () => {
    for (const rollup of [EMPTY_ROLLUP, READY_EMPTY, MARKED, { ...READY_EMPTY, libraries: "idle" as const, folders: "idle" as const }]) {
      for (const level of ["libraries", "folders"] as const) {
        expect(renderToStaticMarkup(React.createElement(AttentionUnknownNote, { rollup, level }))).toBe("");
      }
    }
    expect(renderToStaticMarkup(React.createElement(AttentionUnknownNote, { rollup: { ...READY_EMPTY, folders: "unknown" }, level: "folders" }))).toContain("data-attention-unknown-note");
  });
});
