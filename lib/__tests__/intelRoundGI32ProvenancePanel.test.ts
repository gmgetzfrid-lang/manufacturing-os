// @vitest-environment jsdom
//
// intelligence Round G I-32 — the asset hub's "How we came to believe this"
// view (GAP-303 acceptance 1 / GAP-316), RENDERED on /assets/<tag>, and the
// hub's sheet chip marking the sweep's address on a person's link (GOV-9
// criterion 4, as the graph marks it).
//
//   * REGRESSION (DEC-90 ruling 4): opening the hub reads exactly what it read
//     before — the view is closed and asks nothing until opened;
//   * opened, it shows the discovery, every link with its asserter and the
//     decisions, from GET /api/assets/provenance;
//   * a refused or failed answer is said, never "none"; a partial answer's
//     notes stand above, and a section whose read failed says it could not
//     be read, with no count — never "no link" / "no decision" (DEC-90 (1));
//     a section that WAS read still says "none" when it is empty;
//   * an unregistered tag has no story to tell (no panel).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { newFakeDb, type FakeDb } from "./helpers/fakeSupabase";

const s = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  tag: "E-22",
  asset: null as null | { id: string; tag: string; description: string | null; location: string | null },
  provenance: { status: 200, body: {} as unknown },
}));

vi.mock("next/navigation", () => ({ useParams: () => ({ tag: s.tag }), useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children) }));
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({ activeOrgId: "o1", hasAnyRole: () => true, uid: "u1", userEmail: "u1@x", booted: true, loading: false }),
}));
vi.mock("@/lib/supabase", async () => {
  const { makeFakeSupabase: make, newFakeDb: fresh } = await import("./helpers/fakeSupabase");
  s.db = fresh();
  const client = new Proxy({}, {
    get: (_t, p: string) => (p === "auth"
      ? { getSession: async () => ({ data: { session: { access_token: "t" } } }) }
      : (make(s.db) as Record<string, unknown>)[p]),
  });
  return { supabase: client };
});
vi.mock("@/lib/assets", () => ({
  getAssetByTag: async () => s.asset,
  listAssetPhotos: async () => [],
}));
vi.mock("@/components/assets/AliasPanel", () => ({ default: () => null }));
vi.mock("@/components/assets/MentionsPanel", () => ({ default: () => null }));

import AssetHubPage from "@/app/(protected)/assets/[tag]/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn(async (url: string, _init?: { headers?: Record<string, string> }) => {
  void _init;
  if (url.startsWith("/api/assets/provenance")) {
    return { ok: s.provenance.status < 400, status: s.provenance.status, json: async () => s.provenance.body };
  }
  return { ok: true, status: 200, json: async () => ({ extracted: [] }) };
});

async function flush() { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }
async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(React.createElement(AssetHubPage)); });
  await flush();
}
const panel = () => container.querySelector('[data-testid="asset-provenance"]') as HTMLElement | null;
const opener = () => [...(panel()?.querySelectorAll("button") ?? [])].find((b) => (b.textContent ?? "").includes("How we came to believe this")) as HTMLButtonElement;
const provCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).startsWith("/api/assets/provenance"));

const STORY = {
  asset: { id: "a-e22", tag: "E-22" },
  discovery: { kind: "sweep", door: "drawing", source: { kind: "document", id: "d1", label: "2002-D-10001", href: "/documents/lib1?doc=d1", archived: false }, sourceHidden: false, pages: [4], sheets: [{ page: 4, label: "2002-D-10001 SHT 4", aiRead: true }], revision: "B", automatic: false, confirmedByPerson: true, recordedBy: "Ann Operator" },
  links: [
    { key: "d:r1", target: { kind: "document", id: "d1", label: "2002-D-10001", href: "/documents/lib1?doc=d1", archived: false }, standing: "machine", assertedBy: "The equipment sweep read it off the drawing — AI-read (vision-x); not typed by a person", personName: null, model: "vision-x", revision: "B", sheet: "2002-D-10001 SHT 4", sheetMark: "AI-read, unconfirmed", pages: [4], vanished: false, superseded: false, at: "2026-09-02T00:00:00Z" },
    { key: "d:r3", target: { kind: "document", id: "d3", label: "PID-3", href: "/documents/lib1?doc=d3", archived: false }, standing: "person", assertedBy: "Linked by Ann Operator", personName: "Ann Operator", model: null, revision: null, sheet: "PID-3 SHT 1", sheetMark: "read by the equipment sweep, unconfirmed", pages: [1], vanished: false, superseded: false, at: "2026-09-04T00:00:00Z" },
    { key: "k:k1", target: { kind: "knowledge", id: "kU", label: "upload.pdf", href: "/knowledge/KL1?doc=kU", archived: false }, standing: "machine", assertedBy: "The equipment sweep read it off the knowledge upload — read from drawing (the PDF's own text); not typed by a person", personName: null, model: null, revision: null, sheet: null, sheetMark: null, pages: [2], vanished: false, superseded: false, at: "2026-09-06T00:00:00Z" },
  ],
  decisions: [
    { key: "a:au2", action: "EQUIPMENT_BRIDGE_RELATION_ADOPTED", words: "Made a person's link (adopted from the sweep's reading)", actor: "Ann Operator", target: { kind: "document", id: "d3", label: "PID-3", href: "/documents/lib1?doc=d3", archived: false }, detail: "PID-3 SHT 1, Rev A", at: "2026-09-04T00:00:01Z" },
  ],
  notes: [],
  linksIncomplete: false,
  decisionsUnread: false,
  knowledgeRelationInstalled: true,
};

beforeEach(() => {
  Object.assign(s.db, newFakeDb());
  s.db.tables = {
    documents: [
      { id: "d1", org_id: "o1", document_number: "2002-D-10001", title: "Crude charge", rev: "B", status: "Issued", library_id: "lib1", asset_tags: [] },
      { id: "d3", org_id: "o1", document_number: "PID-3", title: "Adopted", rev: "A", status: "Issued", library_id: "lib1", asset_tags: [] },
    ],
    document_assets: [
      { id: "r1", org_id: "o1", document_id: "d1", asset_id: "a-e22", tag_text: "E-22", source: "drawing", sheet_label: "2002-D-10001 SHT 4", pages: [4], asserted_by: "machine", model: "vision-x", source_revision: "B", vanished_at: null, superseded_at: null },
      { id: "r3", org_id: "o1", document_id: "d3", asset_id: "a-e22", tag_text: "E-22", source: "manual", sheet_label: "PID-3 SHT 1", pages: [1], asserted_by: "human", model: null, source_revision: null, vanished_at: null, superseded_at: null },
    ],
    document_holds: [],
  };
  s.tag = "E-22";
  s.asset = { id: "a-e22", tag: "E-22", description: "Charge exchanger", location: null };
  s.provenance = { status: 200, body: structuredClone(STORY) };
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("GAP-303 acceptance 1 / GAP-316 — the hub's provenance view", () => {
  it("REGRESSION: opening the hub reads what it read before — the view is closed and asks nothing until opened", async () => {
    await render();
    expect(panel()).not.toBeNull();
    expect(opener().getAttribute("aria-expanded")).toBe("false");
    expect(provCalls()).toHaveLength(0);
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(["/api/equipment/sheets?orgId=o1&tag=E-22"]);
    // the document list is the list it was
    expect(container.textContent).toMatch(/Controlled documents\s*2/);
  });

  it("opened: how it entered the registry, every link with who or what asserted it, and the decisions — asked as the viewer", async () => {
    await render();
    await act(async () => { opener().click(); });
    await flush();
    expect(provCalls()).toHaveLength(1);
    expect(String(provCalls()[0][0])).toBe("/api/assets/provenance?orgId=o1&assetId=a-e22");
    expect(provCalls()[0][1]?.headers?.Authorization).toBe("Bearer t");
    const p = panel()!;
    expect(p.querySelector('[data-testid="prov-discovery"]')!.textContent).toMatch(/Created by the equipment sweep, read off 2002-D-10001 \(2002-D-10001 SHT 4 \(AI-read, unconfirmed\)\), Rev B\. The registry records Ann Operator as having applied it\. A person has since confirmed it as real equipment\./);
    const links = [...p.querySelectorAll('[data-testid="prov-link"]')].map((li) => li.textContent ?? "");
    expect(links).toHaveLength(3);
    expect(links[0]).toMatch(/AI-read.*2002-D-10001 SHT 4 \(AI-read, unconfirmed\).*AI-read \(vision-x\)/);
    expect(links[1]).toMatch(/a person's link.*PID-3 SHT 1 \(read by the equipment sweep, unconfirmed\).*Linked by Ann Operator/);
    expect(links[2]).toMatch(/upload\.pdf \(knowledge upload\).*read from drawing/);
    expect(p.textContent).toContain("Links you can read (3)");
    expect(p.querySelector('[data-testid="prov-decision"]')!.textContent).toMatch(/Made a person's link \(adopted from the sweep's reading\)\s*on\s*PID-3\s*· by Ann Operator · PID-3 SHT 1, Rev A/);
  });

  it("a refused answer is said — never 'none'", async () => {
    s.provenance = { status: 503, body: { error: "Your document access couldn't be checked just now, so this equipment's story is not shown." } };
    await render();
    await act(async () => { opener().click(); });
    await flush();
    expect(panel()!.querySelector('[data-testid="prov-error"]')!.textContent).toMatch(/couldn't be checked/);
    expect(panel()!.textContent).not.toMatch(/No document or upload you can read links/);
  });

  it("a failed links read: the notes stand above, the empty list says it could not be read and shows no count — not 'no link'; the decisions, which were read, still say 'none'", async () => {
    s.provenance = { status: 200, body: { ...structuredClone(STORY), links: [], decisions: [], linksIncomplete: true, notes: ["The links to controlled documents could not be read (statement timeout) — none of them is shown, which is not the same as none."] } };
    await render();
    await act(async () => { opener().click(); });
    await flush();
    const p = panel()!;
    expect(p.querySelector('[data-testid="prov-notes"]')!.textContent).toMatch(/which is not the same as none/);
    expect(p.querySelector('[data-testid="prov-no-links"]')!.textContent).toBe("The links could not be read — see above.");
    expect(p.textContent).not.toMatch(/Links you can read \(0\)/);
    expect(p.textContent).not.toMatch(/No document or upload you can read links/);
    expect(p.textContent).toContain("Decisions recorded (0)");
    expect(p.querySelector('[data-testid="prov-no-decisions"]')!.textContent).toMatch(/No recorded equipment-sweep decision about E-22/);
  });

  it("DEC-90 ruling (1): a FAILED audit read never shows 'No recorded … decision' nor a (0) count — it says the decisions could not be read; the links, which were read, keep their 'none'", async () => {
    s.provenance = { status: 200, body: { ...structuredClone(STORY), links: [], decisions: [], decisionsUnread: true, notes: ["The equipment sweep's recorded decisions could not be read (statement timeout) — none is shown, which is not the same as none."] } };
    await render();
    await act(async () => { opener().click(); });
    await flush();
    const p = panel()!;
    expect(p.querySelector('[data-testid="prov-notes"]')!.textContent).toMatch(/recorded decisions could not be read/);
    expect(p.textContent).not.toMatch(/No recorded equipment-sweep decision/);
    expect(p.textContent).not.toMatch(/Decisions recorded \(0\)/);
    expect(p.querySelector('[data-testid="prov-decisions-unread"]')!.textContent).toBe("The recorded decisions could not be read — see above.");
    // the links were read: an empty list there is a real "none" (keyed on the links' own state, not on any note)
    expect(p.querySelector('[data-testid="prov-no-links"]')!.textContent).toBe("No document or upload you can read links this equipment.");
    expect(p.textContent).toContain("Links you can read (0)");
  });

  it("a partly failed read with some rows shown keeps the rows and says some could not be read, with no count", async () => {
    s.provenance = { status: 200, body: { ...structuredClone(STORY), linksIncomplete: true, decisionsUnread: true, notes: ["The linked knowledge-library uploads could not be read (timeout) — links and decisions on them are not shown."] } };
    await render();
    await act(async () => { opener().click(); });
    await flush();
    const p = panel()!;
    expect(p.querySelectorAll('[data-testid="prov-link"]')).toHaveLength(3);
    expect(p.querySelector('[data-testid="prov-links-incomplete"]')!.textContent).toBe("Some links could not be read — see above.");
    expect(p.querySelector('[data-testid="prov-decisions-unread"]')!.textContent).toBe("Some recorded decisions could not be read — see above.");
    expect(p.textContent).not.toMatch(/Links you can read \(3\)/);
    expect(p.textContent).not.toMatch(/Decisions recorded \(1\)/);
  });

  it("GAP-316 discovery 'who': origin 'manual' alone is said as the registry's record, never as fact, with the recorded creator's name; an automatic sweep names who the registry holds accountable", async () => {
    s.provenance = { status: 200, body: { ...structuredClone(STORY), discovery: { kind: "person", recordedBy: "Bob Planner" } } };
    await render();
    await act(async () => { opener().click(); });
    await flush();
    expect(panel()!.querySelector('[data-testid="prov-discovery"]')!.textContent).toBe("Recorded in the registry as entered by a person (Bob Planner).");
    expect(panel()!.textContent).not.toMatch(/Registered by a person/);
    act(() => root.unmount());
    container.remove();

    s.provenance = { status: 200, body: { ...structuredClone(STORY), discovery: { ...structuredClone(STORY.discovery), automatic: true, confirmedByPerson: false, recordedBy: "Cy Admin" } } };
    await render();
    await act(async () => { opener().click(); });
    await flush();
    expect(panel()!.querySelector('[data-testid="prov-discovery"]')!.textContent).toMatch(/Created by the equipment sweep \(applied automatically\).*The registry records Cy Admin as accountable for it \(who turned automatic apply on, or filed the drawing\)\. Not yet confirmed by a person\./);
  });

  it("an unregistered tag has no story to tell: no panel", async () => {
    s.asset = null;
    s.tag = "Q-1";
    await render();
    expect(panel()).toBeNull();
  });
});

describe("GOV-9 criterion 4 — the hub's sheet chip marks the sweep's address on a person's link, as the graph does", () => {
  it("a person's adopted link shows its sheet '(read by the equipment sweep, unconfirmed)'; the sweep's own AI reading keeps its 'AI-read' badge with the chip unmarked (as before)", async () => {
    await render();
    const items = [...container.querySelectorAll("li")].map((li) => li.textContent ?? "");
    const adopted = items.find((t) => t.includes("PID-3"))!;
    expect(adopted).toContain("PID-3 SHT 1 (read by the equipment sweep, unconfirmed)");
    expect(adopted).not.toMatch(/AI-read/);
    const machine = items.find((t) => t.includes("2002-D-10001 SHT 4"))!;
    expect(machine).toContain("AI-read");
    expect(machine).not.toContain("2002-D-10001 SHT 4 (");
  });
});
