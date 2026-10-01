// @vitest-environment jsdom
//
// intelligence Round G — I-05: the Intelligence Overview (status board) and
// its navigation.
//   HUB-7   a failed source says "couldn't check" with a retry — never a
//           permanent shimmer — and one failing query blanks nothing else
//   HUB-9   the Meaning-index card holds its own slot (an Admin sees it beside
//           Database), is green only above a threshold, reads "not built"
//           when nothing is indexed, and its row ignores the viewer's key
//   HUB-10  the snapshot is keyed by user + org and discarded on a uid mismatch;
//           a uid or org change while the page is mounted never carries the
//           last identity's status over (nor saves it under the new key) —
//           including an Admin's cached database check, which patches before
//           any other source lands
//   HUB-5   fix CTAs land on the control, or say who can fix it
//   HUB-3   the first Facility setup step is pointed at from the front door,
//           from counts that were read (a failed count is never "not
//           started"); the two "Setup" surfaces have different names
//   HUB-4   the sidebar hint names every tab (derived); no stale tab count
//   HUB-6   AI instructions (playbooks) in the feature atlas and the sidebar
//   HUB-12  copy quotes controls by their on-screen names
//   I-02    "Your recent questions" for a member (knowledge_questions RLS)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MEANING_INDEX_OK_PCT, hubSnapshotKey, hubGapsKey, legacyHubKeys, readHubSnapshot, writeHubSnapshot,
  meaningIndexCard, knowledgeFix, meaningIndexFix, recentQuestionsCopy, firstSetupStep, setupCountsPatch,
} from "@/lib/hubStatus";
import { searchAtlas, FEATURE_ATLAS } from "@/lib/featureAtlas";
import { INTELLIGENCE_VIEWS } from "@/components/navigation/ViewTabs";

const src = (f: string) => readFileSync(join(process.cwd(), f), "utf8");

// ── the page's dependencies ────────────────────────────────────────────────
type Res = { data?: unknown; count?: number | null; error?: { message: string } | null };
const env = vi.hoisted(() => ({
  role: { activeOrgId: "o1", uid: "u1", activeRole: "Engineer", roles: ["Engineer"] as string[] },
  results: {} as Record<string, Res>,
  rpc: { data: [{ total: 0, embedded: 0 }], error: null } as Res,
  conns: { personal: { keyLast4: "abcd", embeddingKeyLast4: null } } as unknown,
  connsFail: null as Error | null,
  gaps: { ok: true, body: { missingTables: [], missingColumns: [] } },
  /** every network source pends forever (the key check's cold start, a slow database) */
  hang: false,
}));
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({ ...env.role, hasAnyRole: (rs: string[]) => rs.some((r) => env.role.roles.includes(r)) }),
}));
vi.mock("@/lib/supabase", () => {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "limit", "is", "not"]) b[m] = () => b;
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => env.hang
      ? new Promise(() => undefined)
      : Promise.resolve({ data: null, count: 0, error: null, ...(env.results[table] ?? {}) }).then(res, rej);
    return b;
  };
  return {
    supabase: {
      from: (t: string) => builder(t),
      rpc: () => (env.hang ? new Promise(() => undefined) : Promise.resolve(env.rpc)),
      auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) },
    },
  };
});
vi.mock("@/lib/knowledge", () => ({
  getAiConnections: vi.fn(async () => {
    if (env.hang) await new Promise(() => undefined);
    if (env.connsFail) throw env.connsFail;
    return env.conns;
  }),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/intelligence" }));

import IntelligencePage from "@/app/(protected)/intelligence/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  window.localStorage.clear();
  window.sessionStorage.clear();
  env.role = { activeOrgId: "o1", uid: "u1", activeRole: "Engineer", roles: ["Engineer"] };
  env.results = {
    knowledge_libraries: { data: [{ id: "lib-9" }], count: 2 },
    knowledge_documents: { count: 14 },
    proposed_links: { count: 0 },
    knowledge_questions: { data: [] },
    codebook_entries: { count: 5 },
    assets: { count: 40 },
  };
  env.rpc = { data: [{ total: 400, embedded: 400 }], error: null };
  env.conns = { personal: { keyLast4: "abcd", embeddingKeyLast4: "wxyz" } };
  env.connsFail = null;
  env.gaps = { ok: true, body: { missingTables: [], missingColumns: [] } };
  env.hang = false;
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: env.gaps.ok, status: env.gaps.ok ? 200 : 500, json: async () => env.gaps.body })));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

async function renderPage() {
  await act(async () => { root.render(React.createElement(IntelligencePage)); });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
}
const card = (title: string) => [...host.querySelectorAll("div")].find((d) => d.className.includes("rounded-2xl") && d.querySelector("span")?.textContent === title);

describe("HUB-7 — a failed source is said, with a retry", () => {
  it("a semantic_coverage 500 (supabase-js resolves with .error) shows 'Couldn't check' on the card, not a shimmer", async () => {
    env.rpc = { data: null, error: { message: "canceling statement due to statement timeout" } };
    await renderPage();
    const c = card("Meaning index")!;
    expect(c.textContent).toMatch(/Couldn't check \(canceling statement due to statement timeout\)/);
    expect(c.querySelector(".animate-pulse")).toBeNull();
    // retry re-asks
    env.rpc = { data: [{ total: 400, embedded: 400 }], error: null };
    const btn = [...c.querySelectorAll("button")].find((b) => b.textContent?.includes("Retry"))!;
    await act(async () => { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(card("Meaning index")!.textContent).toMatch(/100% of passages embedded/);
  });

  it("an unreadable knowledge_questions blanks only its own panel — counts and proposals still render", async () => {
    env.results.knowledge_questions = { error: { message: 'relation "knowledge_questions" does not exist' } };
    await renderPage();
    expect(host.textContent).toMatch(/Couldn't check recent questions/);
    expect(card("Knowledge")!.textContent).toMatch(/14 documents across 2 libraries/);
    expect(host.textContent).toMatch(/Nothing pending/);
  });

  it("a key check that fails says so — it does not paint a false 'No key saved'", async () => {
    env.connsFail = new Error("Couldn't load AI settings (HTTP 504)");
    await renderPage();
    expect(card("Chat key")!.textContent).toMatch(/Couldn't check/);
    expect(card("Chat key")!.textContent).not.toMatch(/No key saved/);
  });
});

describe("HUB-9 — the Meaning-index card", () => {
  it("an Admin sees Database AND Meaning index, each in its own slot", async () => {
    env.role = { activeOrgId: "o1", uid: "u-admin", activeRole: "Admin", roles: ["Admin"] };
    await renderPage();
    expect(card("Database")).toBeDefined();
    expect(card("Meaning index")).toBeDefined();
  });

  it("is not green at 1% and reads 'not built' with nothing indexed; the % row shows without the viewer's own key", async () => {
    env.rpc = { data: [{ total: 400, embedded: 4 }], error: null };
    env.conns = { personal: { keyLast4: "abcd", embeddingKeyLast4: null } };
    await renderPage();
    expect(card("Meaning index")!.textContent).toMatch(/Only 1% of passages embedded/);
    expect(host.textContent).toMatch(/Meaning index 1% built/);
    expect(meaningIndexCard(0, 0)).toEqual({ ok: false, pct: 0, text: "Not built — nothing has been indexed yet" });
    expect(meaningIndexCard(100, MEANING_INDEX_OK_PCT).ok).toBe(true);
    expect(meaningIndexCard(100, MEANING_INDEX_OK_PCT - 1).ok).toBe(false);
  });
});

describe("HUB-10 — the snapshot belongs to one user", () => {
  it("keys carry uid and org; a snapshot written for another uid is never read", () => {
    expect(hubSnapshotKey("u1", "o1")).toBe("intel-status-u1-o1");
    expect(hubGapsKey("u1", "o1")).toBe("schema-gaps-u1-o1");
    // the RoleContext sign-out sweep still matches the prefixes
    expect(hubSnapshotKey("u1", "o1").startsWith("intel-status-")).toBe(true);
    const raw = writeHubSnapshot("u1", { chatKey: "abcd", keysKnown: true, keysFailed: "boom" });
    expect(readHubSnapshot(raw, "u1")).toEqual({ chatKey: "abcd", keysKnown: true }); // failures are never persisted
    expect(readHubSnapshot(raw, "u2")).toBeNull();
    expect(readHubSnapshot(JSON.stringify({ chatKey: "abcd" }), "u1")).toBeNull(); // the org-only shape of before
    expect(readHubSnapshot("not json", "u1")).toBeNull();
  });

  it("on a shared device the next person is not painted the last person's key state; legacy org-only keys are removed", async () => {
    window.localStorage.setItem(hubSnapshotKey("u-prev", "o1"), writeHubSnapshot("u-prev", { chatKey: "4f2a", keysKnown: true }));
    for (const k of legacyHubKeys("o1")) window.localStorage.setItem(k, JSON.stringify({ chatKey: "4f2a", keysKnown: true }));
    env.connsFail = new Error("cold start");
    await renderPage();
    expect(host.textContent).not.toMatch(/4f2a/);
    for (const k of legacyHubKeys("o1")) expect(window.localStorage.getItem(k)).toBeNull();
  });

  it("a uid change while the page is mounted (an account switched in another tab) starts from the NEW person's snapshot — the last person's status is neither shown nor saved under the new key", async () => {
    env.conns = { personal: { keyLast4: "4f2a", embeddingKeyLast4: null } };
    env.results.knowledge_questions = { data: [{ id: "q1", question: "Where is the relief valve on V-101?", user_name: "Prev", library_id: "lib-9", created_at: "2026-10-01" }] };
    await renderPage();
    expect(host.textContent).toMatch(/4f2a/);
    expect(host.textContent).toMatch(/relief valve on V-101/);

    // user 2 signs in from another tab; this tab re-renders with the new uid
    // and every per-user source fails for them
    env.role = { ...env.role, uid: "u2" };
    env.connsFail = new Error("cold start");
    env.results.knowledge_questions = { error: { message: "permission denied" } };
    await renderPage();
    expect(host.textContent).not.toMatch(/4f2a/);
    expect(host.textContent).not.toMatch(/relief valve on V-101/);
    const saved = readHubSnapshot<Record<string, unknown>>(window.localStorage.getItem(hubSnapshotKey("u2", "o1")), "u2");
    expect(saved).not.toBeNull();
    expect(JSON.stringify(saved)).not.toMatch(/4f2a|relief valve/);
    expect(saved?.keysKnown).not.toBe(true);
    expect(saved?.asksKnown).not.toBe(true);
    // user 1's own snapshot is untouched
    expect(window.localStorage.getItem(hubSnapshotKey("u1", "o1"))).toMatch(/4f2a/);
  });

  it("an Admin whose database check is cached (patched before anything else lands) starts from THEIR snapshot on a uid change — the last person's key, counts and library are neither painted nor saved under the new key", async () => {
    env.conns = { personal: { keyLast4: "aaaa", embeddingKeyLast4: null } };
    env.results.knowledge_documents = { count: 77 };
    env.results.knowledge_libraries = { data: [{ id: "lib-o1" }], count: 1 };
    await renderPage();
    expect(card("Chat key")!.textContent).toMatch(/aaaa/);

    // u-admin opened the hub within the hour on this device: their gaps
    // check is cached, so it patches synchronously. Every other source is
    // still pending (the key check's cold start).
    window.localStorage.setItem(hubGapsKey("u-admin", "o1"), JSON.stringify({ uid: "u-admin", gaps: 0, at: Date.now() }));
    env.hang = true;
    env.role = { activeOrgId: "o1", uid: "u-admin", activeRole: "Admin", roles: ["Admin"] };
    await renderPage();
    expect(host.textContent).not.toMatch(/aaaa/);
    expect(host.textContent).not.toMatch(/77 documents/);
    expect(card("Database")!.textContent).toMatch(/All expected tables present/);
    const saved = readHubSnapshot<Record<string, unknown>>(window.localStorage.getItem(hubSnapshotKey("u-admin", "o1")), "u-admin");
    expect(saved).not.toBeNull();
    expect(JSON.stringify(saved)).not.toMatch(/aaaa|lib-o1/);
    expect(saved).toMatchObject({ schemaGaps: 0, docs: 0, chatKey: null, firstLibraryId: null });
    for (const k of ["keysKnown", "librariesKnown", "docsKnown", "asksKnown", "coverageKnown", "setupKnown"]) expect(saved?.[k], k).not.toBe(true);
    // user 1's own snapshot is untouched
    expect(window.localStorage.getItem(hubSnapshotKey("u1", "o1"))).toMatch(/aaaa/);
  });

  it("an Admin's workspace switch with the new workspace's gaps cached never paints, links to or saves the old workspace's figures", async () => {
    env.role = { activeOrgId: "o1", uid: "u-admin", activeRole: "Admin", roles: ["Admin"] };
    env.conns = { personal: { keyLast4: "aaaa", embeddingKeyLast4: null } };
    env.results.knowledge_documents = { count: 77 };
    env.results.knowledge_libraries = { data: [{ id: "lib-o1" }], count: 1 };
    env.results.knowledge_questions = { data: [{ id: "q1", question: "Where is the o1 relief valve?", user_name: "Ada", library_id: "lib-o1", created_at: "2026-10-01" }] };
    env.rpc = { data: [{ total: 400, embedded: 4 }], error: null };
    await renderPage();
    expect(host.textContent).toMatch(/77 documents/);
    expect(host.querySelector('a[href="/knowledge/lib-o1"]')).not.toBeNull(); // "Build index" lands in o1's library

    window.localStorage.setItem(hubGapsKey("u-admin", "o2"), JSON.stringify({ uid: "u-admin", gaps: 3, at: Date.now() }));
    env.hang = true;
    env.role = { ...env.role, activeOrgId: "o2" };
    await renderPage();
    expect(host.textContent).not.toMatch(/77 documents|aaaa|o1 relief valve/);
    expect(host.querySelector('a[href="/knowledge/lib-o1"]')).toBeNull();
    expect(card("Database")!.textContent).toMatch(/3 schema gaps/);
    const saved = readHubSnapshot<Record<string, unknown>>(window.localStorage.getItem(hubSnapshotKey("u-admin", "o2")), "u-admin");
    expect(JSON.stringify(saved)).not.toMatch(/aaaa|lib-o1|o1 relief valve/);
    expect(saved).toMatchObject({ schemaGaps: 3, docs: 0, firstLibraryId: null, recentAsks: [] });
    // o1's own snapshot is untouched
    expect(window.localStorage.getItem(hubSnapshotKey("u-admin", "o1"))).toMatch(/lib-o1/);
  });

  it("a Retry for the SAME person keeps what is on screen while it re-asks", async () => {
    await renderPage();
    expect(host.textContent).toMatch(/abcd/);
    env.connsFail = new Error("cold start");
    await act(async () => { [...host.querySelectorAll("button")].find((b) => /Retry/.test(b.textContent ?? ""))?.click(); });
    await renderPage();
    expect(host.textContent).toMatch(/abcd/);
  });
});

describe("HUB-5 — every fix lands on its control, or says who can", () => {
  it("rules", () => {
    expect(knowledgeFix({ isController: true, libraries: 0, firstLibraryId: null })).toEqual({ href: "/knowledge?create=1", cta: "Create a library" });
    expect(knowledgeFix({ isController: true, libraries: 3, firstLibraryId: "L" })).toEqual({ href: "/knowledge/L", cta: "Upload documents" });
    expect(knowledgeFix({ isController: false, libraries: 0, firstLibraryId: null }).href).toBeUndefined();
    expect(meaningIndexFix({ isController: true, chunksTotal: 10, libraries: 1, firstLibraryId: "L" })).toEqual({ href: "/knowledge/L", cta: "Build index" });
    expect(meaningIndexFix({ isController: false, chunksTotal: 10, libraries: 1, firstLibraryId: "L" }).whoCan).toMatch(/Admin or Doc Control builds/);
  });

  it("a member sees who can fix 'Nothing indexed' instead of a button; a controller gets the deep link", async () => {
    env.results.knowledge_documents = { count: 0 };
    await renderPage();
    const c = card("Knowledge")!;
    expect(c.querySelector("a")).toBeNull();
    expect(c.textContent).toMatch(/Admin or Doc Control adds documents/);
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    env.role = { activeOrgId: "o1", uid: "u-dc", activeRole: "Manager", roles: ["Manager", "DocCtrl"] };
    await renderPage();
    expect(card("Knowledge")!.querySelector("a")?.getAttribute("href")).toBe("/knowledge/lib-9");
  });

  it("the shelf page opens its create dialog for /knowledge?create=1", () => {
    const page = src("app/(protected)/knowledge/page.tsx");
    expect(page).toMatch(/get\("create"\) === "1"\) setShowCreate\(true\)/);
  });
});

describe("HUB-3 — the first step from the front door; two Setups with two names", () => {
  it("a workspace without a codebook is pointed at Facility setup", async () => {
    env.results.codebook_entries = { count: 0 };
    await renderPage();
    const start = [...host.querySelectorAll("a")].find((a) => a.getAttribute("href") === "/setup");
    expect(start?.textContent).toMatch(/Start here — Facility setup/);
    expect(start?.textContent).toMatch(/Next step: Site codebook/);
    expect(firstSetupStep({ codebookEntries: 3, assets: 0, libraries: 1 })?.stage).toBe("Equipment registry");
    expect(firstSetupStep({ codebookEntries: 3, assets: 2, libraries: 1 })).toBeNull();
  });
  it("a count that FAILED is never 'not started': a codebook timeout in a configured workspace shows no card and saves no false zero", async () => {
    env.results.codebook_entries = { count: null, error: { message: "canceling statement due to statement timeout" } };
    await renderPage();
    expect(host.textContent).not.toMatch(/Start here — Facility setup/);
    const saved = readHubSnapshot<Record<string, unknown>>(window.localStorage.getItem(hubSnapshotKey("u1", "o1")), "u1");
    expect(saved?.setupKnown).not.toBe(true); // the zero in the snapshot is the empty default, never "known"
    expect(saved?.assets).toBe(40); // the registry count that WAS read is kept
    expect(JSON.stringify(saved)).not.toMatch(/setupFailed|statement timeout/); // a failure is not "last known"
    // the next visit paints from that snapshot while its reads pend: still no false card
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    env.hang = true;
    await renderPage();
    expect(host.textContent).not.toMatch(/Start here — Facility setup/);
  });

  it("a last-known snapshot of a configured workspace is not turned into a false card by a failed re-read", async () => {
    window.localStorage.setItem(hubSnapshotKey("u1", "o1"), writeHubSnapshot("u1", { codebookEntries: 5, assets: 40, setupKnown: true }));
    env.results.assets = { count: null, error: { message: "connection reset" } };
    env.results.codebook_entries = { count: null, error: { message: "connection reset" } };
    await renderPage();
    expect(host.textContent).not.toMatch(/Start here — Facility setup/);
    const saved = readHubSnapshot<Record<string, unknown>>(window.localStorage.getItem(hubSnapshotKey("u1", "o1")), "u1");
    expect(saved).toMatchObject({ codebookEntries: 5, assets: 40, setupKnown: true });
  });

  it("setupCountsPatch: a missing table is 0 (not started); any other error is setupFailed with setupKnown left alone", () => {
    expect(setupCountsPatch({ count: 5 }, { count: 40 })).toEqual({ codebookEntries: 5, assets: 40, setupKnown: true });
    expect(setupCountsPatch({ count: null, error: { code: "42P01", message: 'relation "codebook_entries" does not exist' } }, { count: 2 }))
      .toEqual({ codebookEntries: 0, assets: 2, setupKnown: true });
    expect(setupCountsPatch({ count: null, error: { code: "PGRST205", message: "Could not find the table in the schema cache" } }, { count: 2 }).codebookEntries).toBe(0);
    const timeout = setupCountsPatch({ count: null, error: { code: "57014", message: "statement timeout" } }, { count: 40 });
    expect(timeout).toEqual({ assets: 40, setupFailed: "codebook: statement timeout" });
    expect(timeout.setupKnown).toBeUndefined();
    expect(writeHubSnapshot("u1", timeout)).not.toMatch(/setupFailed/);
  });

  it("the AI keys page is 'AI setup' everywhere; Facility setup keeps its name and is linked from it", () => {
    expect(INTELLIGENCE_VIEWS.find((v) => v.href === "/intelligence/setup")?.label).toBe("AI setup");
    expect(FEATURE_ATLAS.find((e) => e.href === "/intelligence/setup")?.label).toBe("AI setup");
    expect(FEATURE_ATLAS.find((e) => e.href === "/setup")?.label).toBe("Facility setup");
    expect(src("app/(protected)/intelligence/setup/page.tsx")).toMatch(/<SetupLink href="\/setup" icon=\{Compass\}\s*\n\s*title="Facility setup"/);
  });
});

describe("HUB-4 / HUB-6 — the navigation tells the truth", () => {
  it("the sidebar hint is derived from INTELLIGENCE_VIEWS (every tab, Skills included); no stale tab count remains", () => {
    const sb = src("components/navigation/Sidebar.tsx");
    expect(sb).toContain("hint: `AI in one place — ${INTELLIGENCE_VIEWS.map((v) => v.label).join(' · ')}`");
    expect(INTELLIGENCE_VIEWS.map((v) => v.label)).toContain("Skills");
    expect(src("components/navigation/ViewTabs.tsx")).not.toMatch(/six lenses/i);
    expect(src("app/(protected)/intelligence/page.tsx")).not.toMatch(/Six tabs/);
  });
  it("AI instructions (playbooks) is in the atlas under the words people use, and in the admin nav", () => {
    for (const q of ["playbook", "house rules", "standing instructions", "tell the ai"]) {
      expect(searchAtlas(q)[0]?.href, q).toBe("/admin/ai-instructions");
    }
    expect(src("components/navigation/Sidebar.tsx")).toContain("{ label: 'AI instructions',   href: '/admin/ai-instructions'");
  });
});

describe("HUB-12 (this package's lines) / I-02 label", () => {
  it("the modal's help names the real re-index control; the equipment table names the real export button", () => {
    const modal = src("components/knowledge/LibraryAiModal.tsx");
    expect(modal).toContain("Text doesn&apos;t extract from these files — index every page as an image");
    expect(modal).toContain("<b> Re-index all</b> in the Documents header");
    expect(modal).not.toMatch(/Turn it on, then\s*\n\s*<b> Rebuild index<\/b>/);
    const table = src("components/knowledge/EquipmentTablePanel.tsx");
    expect(table).toContain("&ldquo;Equipment register (CSV)&rdquo; button");
    expect(table).toContain("&ldquo;This is a drawing set&rdquo; in Library AI setup");
    expect(src("components/knowledge/DrawingIntelPanel.tsx")).toContain("Equipment register (CSV)");
  });
  it("Drawing intelligence's footer quotes the checkbox by its on-screen label (I-07's line, recorded at the I-05 merge)", () => {
    const panel = src("components/knowledge/DrawingIntelPanel.tsx");
    expect(panel).toContain("<b>&ldquo;Text doesn&apos;t extract from these files — index every page as an image&rdquo;</b> in");
    expect(panel).not.toContain("Index every page with AI vision");
    expect(src("components/knowledge/SemanticIndexPanel.tsx")).not.toContain("These are CAD exports or scans");
  });
  it("a member's panel is 'Your recent questions'; a controller's says it is everyone's", async () => {
    expect(recentQuestionsCopy(false).title).toBe("Your recent questions");
    expect(recentQuestionsCopy(true).title).toBe("Recent questions — everyone");
    await renderPage();
    expect(host.textContent).toMatch(/Your recent questions/);
    expect(host.textContent).toMatch(/You haven't asked anything yet/);
  });
});
