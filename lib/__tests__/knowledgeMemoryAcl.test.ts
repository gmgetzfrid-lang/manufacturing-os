// intelligence Round G (I-02) — the knowledge memory ACL.
//
//   * ASK-1 / KACL-1 / IRLS-1 / IEDGE-5 — a stored answer carries what the
//     ASKER's ACL admitted. The browser no longer reads other people's rows
//     (20261120: knowledge_questions_select = the asker or a controller);
//     /api/knowledge/history re-decides every row for the CURRENT reader
//     through the real seam (loadPrincipal + readableControlledDocIds — the
//     real lib/knowledgeAccess runs below, only the service-role client is a
//     stand-in), withholds a row citing anything unreadable, and every later
//     turn of its conversation. Two members with different ACLs get different
//     history for the same library; a controller gets all of it (DEC-43); an
//     error answers nothing.
//   * KACL-7 / IEDGE-6 / IRLS-9 — the mirror-row and mention policies, pinned
//     by shape (and verified against a scratch PostgreSQL 16 — see the
//     finding records); the backlinks panel counts what it may not show.
//   * 20261120 — the paste contract, byte fidelity against 20260911, and a
//     census replaying every numbered migration.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { freshAdminState, type Row } from "./helpers/knowledgeFakeAdmin";

const admin = vi.hoisted(() => ({ state: null as unknown as import("./helpers/knowledgeFakeAdmin").FakeAdminState }));
vi.mock("@/lib/supabaseAdmin", async () => {
  const { makeFakeAdmin: make, freshAdminState: fresh } = await import("./helpers/knowledgeFakeAdmin");
  admin.state = fresh();
  const proxy = new Proxy({}, { get: (_t, p: string) => (make(admin.state) as Record<string, unknown>)[p] });
  return { supabaseAdmin: proxy };
});

// The browser client, for lib/knowledge.ts and lib/mentions.ts.
const browser = vi.hoisted(() => ({ state: null as unknown as import("./helpers/knowledgeFakeAdmin").FakeAdminState }));
vi.mock("@/lib/supabase", async () => {
  const { makeFakeAdmin: make, freshAdminState: fresh } = await import("./helpers/knowledgeFakeAdmin");
  browser.state = fresh();
  const client = () => make(browser.state) as Record<string, unknown>;
  const proxy = new Proxy({}, {
    get: (_t, p: string) => (p === "auth"
      ? { getSession: async () => ({ data: { session: { access_token: "tok" } } }) }
      : client()[p]),
  });
  return { supabase: proxy };
});

import { POST as historyPost } from "@/app/api/knowledge/history/route";
import { citedKnowledgeDocIds, planVisibleHistory, readableKnowledgeDocIds, type StoredAnswerRow } from "@/lib/knowledgeHistory";
import { searchAskHistory, listKnowledgeQuestions, loadConversation } from "@/lib/knowledge";
import { mentionAccessGap, describeWithheldMentions } from "@/lib/mentions";

const repo = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const mig = (f: string) => repo(join("supabase", "migrations", f));
const strip = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");
function lineDiff(a: string, b: string) {
  const A = a.split("\n").map((l) => l.trim()).filter(Boolean);
  const B = b.split("\n").map((l) => l.trim()).filter(Boolean);
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}

// ── the cast ────────────────────────────────────────────────────────────────
const ORG = "0a000000-0000-4000-8000-000000000001";
const OTHER_ORG = "0a000000-0000-4000-8000-000000000002";
const LIB = "0b000000-0000-4000-8000-000000000001";          // knowledge library
const DCLIB = "0c000000-0000-4000-8000-000000000001";        // doc-control library
const V = "0d000000-0000-4000-8000-00000000000a";            // Viewer — no grant on the private doc
const E = "0d000000-0000-4000-8000-00000000000e";            // Engineer — granted read on it
const A = "0d000000-0000-4000-8000-0000000000ad";            // Admin
const X = "0d000000-0000-4000-8000-0000000000ff";            // not a member
const DOPEN = "0e000000-0000-4000-8000-000000000001";
const DPRIV = "0e000000-0000-4000-8000-000000000002";
const K_UP = "0f000000-0000-4000-8000-000000000000";         // upload-origin knowledge doc
const K_OPEN = "0f000000-0000-4000-8000-000000000001";       // mirror of DOPEN
const K_PRIV = "0f000000-0000-4000-8000-000000000002";       // mirror of DPRIV
const K_GONE = "0f000000-0000-4000-8000-0000000000dd";       // cited, since deleted
const K_FOREIGN = "0f000000-0000-4000-8000-0000000000fe";    // another org's upload
const T1 = "1a000000-0000-4000-8000-000000000001";
const T2 = "1a000000-0000-4000-8000-000000000002";

const cite = (documentId: string, quote = "verbatim passage") => ({ n: 1, documentId, documentName: "Doc", page: 3, quote });
let seq = 0;
const q = (over: Partial<Row>): Row => ({
  id: `2a000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
  org_id: ORG, library_id: LIB, thread_id: null, user_id: E, user_name: "e@x.io",
  question: "what are the relief valve set points", answer: "The set points are …", citations: [], mode: "library",
  created_at: `2026-09-${String(10 + seq).padStart(2, "0")}T00:00:00Z`, ...over,
});

function seed() {
  seq = 0;
  admin.state.tables = {
    org_members: [
      { org_id: ORG, uid: V, role: "Viewer", roles: ["Viewer"], status: "active" },
      { org_id: ORG, uid: E, role: "Engineer-2", roles: ["Engineer-2"], status: "active" },
      { org_id: ORG, uid: A, role: "Admin", roles: ["Admin"], status: "active" },
    ],
    team_members: [],
    teams: [],
    libraries: [{ id: DCLIB, org_id: ORG, name: "Controlled", acl: null, visibility: "normal", owner_user_id: null, owner_team_id: null }],
    collections: [],
    documents: [
      { id: DOPEN, org_id: ORG, library_id: DCLIB, collection_id: null, acl: null, visibility: "normal", is_private: false, scope: "org", created_by: A, owner_user_id: null },
      {
        id: DPRIV, org_id: ORG, library_id: DCLIB, collection_id: null, visibility: "private", is_private: false, scope: "org", created_by: A, owner_user_id: null,
        acl: { visibility: "private", rules: [{ effect: "allow", subject: { type: "user", id: E }, actions: ["read", "discover"] }] },
      },
    ],
    knowledge_libraries: [{ id: LIB, org_id: ORG }],
    knowledge_documents: [
      { id: K_UP, org_id: ORG, source_document_id: null },
      { id: K_OPEN, org_id: ORG, source_document_id: DOPEN },
      { id: K_PRIV, org_id: ORG, source_document_id: DPRIV },
      { id: K_FOREIGN, org_id: OTHER_ORG, source_document_id: null },
    ],
    knowledge_questions: [
      q({ question: "Q-open: relief valve set points in the open standard", citations: [cite(K_OPEN)], user_id: V }),
      q({ question: "Q-priv: relief valve set points from the restricted P&ID", citations: [cite(K_PRIV, "PSV-2001 set at 285 psig")] }),
      q({ question: "Q-upload: relief valve sizing from the uploaded manual", citations: [cite(K_UP)] }),
      q({ question: "Q-gone: relief valve set points from a removed document", citations: [cite(K_GONE)] }),
      q({ question: "Q-foreign: relief valve set points from another org", citations: [cite(K_FOREIGN)] }),
      q({ question: "Q-web: relief valve set points on the internet", citations: [{ n: 1, url: "https://example.com", title: "x" }], mode: "internet" }),
      // A conversation: turn 1 cites the restricted P&ID, turn 2 cites only
      // the open standard — but was answered WITH turn 1 as its context.
      q({ question: "T1-turn1: relief valve set points on the restricted sheet", citations: [cite(K_PRIV)], thread_id: T1 }),
      q({ question: "T1-turn2: relief valve follow-up on the open standard", citations: [cite(K_OPEN)], thread_id: T1 }),
      // A conversation whose FIRST turn is fine and second is restricted.
      q({ question: "T2-turn1: relief valve basis in the open standard", citations: [cite(K_OPEN)], thread_id: T2, user_id: V }),
      q({ question: "T2-turn2: relief valve detail from the restricted sheet", citations: [cite(K_PRIV)], thread_id: T2, user_id: V }),
      // Another library of the same org — never leaks into this one.
      q({ question: "Q-otherlib: relief valve set points elsewhere", citations: [cite(K_UP)], library_id: "0b000000-0000-4000-8000-000000000099" }),
    ],
  };
}

const post = (body: unknown) => historyPost(new NextRequest("http://x/api/knowledge/history", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
}));
const questionsOf = async (res: Response) => ((await res.json()).rows as Array<{ question: string }>).map((r) => r.question.split(":")[0]).sort();

beforeEach(() => {
  Object.assign(admin.state, freshAdminState());
  Object.assign(browser.state, freshAdminState());
  seed();
});

// ── the pure rule ───────────────────────────────────────────────────────────
describe("the rule — an answer is as restricted as its most restricted source", () => {
  it("citedKnowledgeDocIds reads document citations only; web citations name nothing; a malformed id is kept (so it resolves to nothing)", () => {
    expect(citedKnowledgeDocIds([cite(K_OPEN), { n: 2, url: "https://x" }, cite(K_OPEN), { documentId: 42 }, null, "x"])).toEqual([K_OPEN, "42"]);
    expect(citedKnowledgeDocIds({ not: "an array" })).toEqual([]);
    expect(citedKnowledgeDocIds(null)).toEqual([]);
  });
  it("a row citing any unreadable document is withheld whole; a row with no document citations is shown", () => {
    const rows: StoredAnswerRow[] = [
      { id: "r1", library_id: LIB, question: "a", created_at: "1", citations: [cite(K_OPEN), cite(K_PRIV)] },
      { id: "r2", library_id: LIB, question: "b", created_at: "2", citations: [cite(K_OPEN)] },
      { id: "r3", library_id: LIB, question: "c", created_at: "3", citations: [{ url: "https://x" }] },
    ];
    const plan = planVisibleHistory(rows, [], new Set([K_OPEN]));
    expect(plan.visible.map((r) => r.id)).toEqual(["r2", "r3"]);
    expect(plan.withheld.map((r) => r.id)).toEqual(["r1"]);
  });
  it("a conversation is withheld from its first unreadable turn onward (later turns carried it as context); earlier turns stay", () => {
    const t = (id: string, at: string, docId: string): StoredAnswerRow => ({ id, library_id: LIB, thread_id: T1, question: id, created_at: at, citations: [cite(docId)] });
    const turns = [t("t1", "1", K_OPEN), t("t2", "2", K_PRIV), t("t3", "3", K_OPEN), t("t4", "4", K_UP)];
    // Only the listed row t3 is asked about; the other turns decide it.
    const plan = planVisibleHistory([turns[2]], turns, new Set([K_OPEN, K_UP]));
    expect(plan.withheld.map((r) => r.id)).toEqual(["t3"]);
    const all = planVisibleHistory(turns, turns, new Set([K_OPEN, K_UP]));
    expect(all.visible.map((r) => r.id)).toEqual(["t1"]);
    expect(all.withheld.map((r) => r.id)).toEqual(["t2", "t3", "t4"]);
  });
  it("readableKnowledgeDocIds: uploads of the reader's org yes; mirrors by the controlled document's ACL; gone / foreign / malformed never", async () => {
    const { loadPrincipal } = await import("@/lib/knowledgeAccess");
    const pv = (await loadPrincipal(ORG, V))!;
    const pe = (await loadPrincipal(ORG, E))!;
    const ids = [K_UP, K_OPEN, K_PRIV, K_GONE, K_FOREIGN, "not-a-uuid"];
    expect([...await readableKnowledgeDocIds(pv, ids)].sort()).toEqual([K_UP, K_OPEN].sort());
    expect([...await readableKnowledgeDocIds(pe, ids)].sort()).toEqual([K_UP, K_OPEN, K_PRIV].sort());
  });
  it("a knowledge-documents read error throws (the route then fails closed)", async () => {
    const { loadPrincipal } = await import("@/lib/knowledgeAccess");
    const pv = (await loadPrincipal(ORG, V))!;
    admin.state.failReads.knowledge_documents = { message: "boom" };
    await expect(readableKnowledgeDocIds(pv, [K_UP])).rejects.toThrow(/boom/);
  });
});

// ── the route ───────────────────────────────────────────────────────────────
describe("/api/knowledge/history — the team's record, re-decided per reader", () => {
  it("reproduction: before 20261120 the only read policy was org membership — every member could read the restricted quote", () => {
    const before = strip(mig("20260911_knowledge_ai.sql"));
    const pol = before.slice(before.indexOf("CREATE POLICY knowledge_questions_select"), before.indexOf(");", before.indexOf("CREATE POLICY knowledge_questions_select")) + 2);
    expect(pol).toContain("EXISTS (SELECT 1 FROM org_members WHERE org_id = knowledge_questions.org_id");
    expect(pol).not.toMatch(/user_id|is_org_controller/);
    // and the old browser read was org-wide with no ACL step
    const old = repo("lib/knowledge.ts");
    expect(old).not.toContain('.from("knowledge_questions")');
  });
  it("two members with different ACLs get different history for the same library (KACL-1 done-when 4)", async () => {
    admin.state.user = { id: V };
    const viewer = await questionsOf(await post({ orgId: ORG, libraryId: LIB, action: "list" }));
    admin.state.user = { id: E };
    const engineer = await questionsOf(await post({ orgId: ORG, libraryId: LIB, action: "list" }));
    expect(viewer).toEqual(["Q-open", "Q-upload", "Q-web", "T2-turn1"]);
    expect(engineer).toEqual(["Q-open", "Q-priv", "Q-upload", "Q-web", "T1-turn1", "T1-turn2", "T2-turn1", "T2-turn2"]);
    expect(viewer).not.toContain("Q-priv");
    // nothing from another library, another org's document, or a removed document
    for (const list of [viewer, engineer]) {
      expect(list).not.toContain("Q-otherlib");
      expect(list).not.toContain("Q-gone");
      expect(list).not.toContain("Q-foreign");
    }
  });
  it("the withheld count is reported, and a withheld answer's quote never reaches the response body", async () => {
    admin.state.user = { id: V };
    const res = await post({ orgId: ORG, libraryId: LIB, action: "list" });
    const text = await res.text();
    expect(JSON.parse(text).withheld).toBe(6);                      // priv, gone, foreign, T1×2, T2-turn2
    expect(text).not.toContain("PSV-2001 set at 285 psig");
  });
  it("a member with no ACL on a source-linked document cannot retrieve an answer whose citations point at it — search, list or thread (IRLS-1 / IEDGE-5)", async () => {
    admin.state.user = { id: V };
    const search = await (await post({ orgId: ORG, libraryId: LIB, action: "search", query: "restricted P&ID", limit: 3 })).json();
    expect(search.rows).toEqual([]);
    const thread = await (await post({ orgId: ORG, libraryId: LIB, action: "thread", threadId: T1 })).json();
    expect(thread.rows).toEqual([]);
    expect(thread.withheld).toBe(2);
    const own = await (await post({ orgId: ORG, libraryId: LIB, action: "thread", threadId: T2 })).json();
    expect(own.rows.map((r: { question: string }) => r.question.split(":")[0])).toEqual(["T2-turn1"]);
    expect(own.rows[0].mine).toBe(true);
  });
  it("ask memory is scoped to THIS library (ASK-1 done-when 2) and to readable answers", async () => {
    admin.state.user = { id: E };
    const res = await (await post({ orgId: ORG, libraryId: LIB, action: "search", query: "relief valve set points", limit: 10 })).json();
    const qs = res.rows.map((r: { question: string }) => r.question.split(":")[0]);
    expect(qs).toContain("Q-priv");                                 // E may read it
    expect(qs).not.toContain("Q-otherlib");
    const scoped = admin.state.calls.filter((c) => c.table === "knowledge_questions" && c.method === "eq" && c.args[0] === "library_id");
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((c) => c.args[1] === LIB)).toBe(true);
  });
  it("controllers read all memory (DEC-43) — no filter, nothing withheld", async () => {
    admin.state.user = { id: A };
    const body = await (await post({ orgId: ORG, libraryId: LIB, action: "list" })).json();
    expect(body.withheld).toBe(0);
    expect(body.rows).toHaveLength(10);
  });
  it("fails closed: a non-member is 403, an ACL read error is 500 with NO rows, a bad token is 401", async () => {
    admin.state.user = { id: X };
    expect((await post({ orgId: ORG, libraryId: LIB, action: "list" })).status).toBe(403);
    admin.state.user = { id: V };
    admin.state.failReads.knowledge_documents = { message: "db down" };
    const res = await post({ orgId: ORG, libraryId: LIB, action: "list" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.rows).toBeUndefined();
    expect(body.error).toMatch(/Couldn't check access to the cited documents/);
    admin.state.user = null;
    expect((await post({ orgId: ORG, libraryId: LIB, action: "list" })).status).toBe(401);
  });
  it("a library of another org is 404; malformed ids are 400", async () => {
    admin.state.user = { id: V };
    admin.state.tables.knowledge_libraries = [{ id: LIB, org_id: OTHER_ORG }];
    expect((await post({ orgId: ORG, libraryId: LIB, action: "list" })).status).toBe(404);
    admin.state.tables.knowledge_libraries = [{ id: LIB, org_id: ORG }];
    expect((await post({ orgId: "x", libraryId: LIB, action: "list" })).status).toBe(400);
    expect((await post({ orgId: ORG, libraryId: LIB, action: "thread", threadId: "nope" })).status).toBe(400);
  });
});

// ── the browser side ────────────────────────────────────────────────────────
describe("lib/knowledge.ts — every read of the team's record goes through the route", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

  it("searchAskHistory posts action 'search' with the LIBRARY, never reads the table", async () => {
    fetchMock.mockResolvedValueOnce(reply({ rows: [{ id: "1", libraryId: LIB, threadId: null, question: "q", answer: "a", citations: [], userName: "u", mode: "library", createdAt: "t", mine: false }] }));
    const out = await searchAskHistory(ORG, LIB, "what are the relief valve set points", 3);
    expect(out).toEqual([{ id: "1", library_id: LIB, question: "q", answer: "a", user_name: "u", created_at: "t", citations: [] }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/knowledge/history");
    expect(JSON.parse(init.body)).toEqual({ orgId: ORG, libraryId: LIB, action: "search", query: "what are the relief valve set points", limit: 3 });
    expect(browser.state.calls.filter((c) => c.table === "knowledge_questions")).toEqual([]);
  });
  it("listKnowledgeQuestions carries the withheld count and reports a failure instead of an empty record", async () => {
    fetchMock.mockResolvedValueOnce(reply({ rows: [], withheld: 3 }));
    expect(await listKnowledgeQuestions(ORG, LIB)).toEqual({ questions: [], withheld: 3 });
    fetchMock.mockResolvedValueOnce(reply({ error: "Couldn't check access to the cited documents: db down" }, 500));
    const failed = await listKnowledgeQuestions(ORG, LIB);
    expect(failed.questions).toEqual([]);
    expect(failed.error).toMatch(/db down/);
  });
  it("loadConversation posts action 'thread' and maps `mine`", async () => {
    fetchMock.mockResolvedValueOnce(reply({ rows: [{ id: "1", libraryId: LIB, threadId: T1, question: "q", answer: "a", citations: [cite(K_OPEN)], userName: "u", mode: "library", createdAt: "t", mine: true }], withheld: 1 }));
    const page = await loadConversation(ORG, LIB, T1);
    expect(page.withheld).toBe(1);
    expect(page.questions[0]).toMatchObject({ threadId: T1, mine: true, citations: [cite(K_OPEN)] });
  });
  it("no browser module in lib/ or the knowledge page reads knowledge_questions directly any more", () => {
    for (const f of ["lib/knowledge.ts", "app/(protected)/knowledge/[id]/page.tsx"]) {
      expect(repo(f)).not.toMatch(/from\(\s*["']knowledge_questions["']\s*\)/);
    }
  });
});

describe("the knowledge page — memory card, conversations, reopen", () => {
  const page = repo("app/(protected)/knowledge/[id]/page.tsx");
  it("the memory card searches THIS library through the route", () => {
    expect(page).toContain("const past = await searchAskHistory(activeOrgId, libraryId, q, 3);");
  });
  it("openConversation re-reads a thread through the route and keeps the thread only when every turn is the reader's own", () => {
    const fn = page.slice(page.indexOf("const openConversation = async (rows: KnowledgeQuestion[]) => {"), page.indexOf("const onFiles = async"));
    expect(fn).toContain("const page = await loadConversation(activeOrgId, libraryId, threadKey);");
    expect(fn).toContain("const own = ordered.every((q) => q.mine === true);");
    expect(fn).toContain("setThreadId(own && ordered[0]?.threadId ? ordered[0].threadId : crypto.randomUUID());");
    expect(fn).toContain("Nothing in this conversation is visible to you");
  });
  it("the Conversations list says how many answers it is not showing, and a failed read is shown as a failure", () => {
    expect(page).toContain("recent answer{historyWithheld === 1 ? \" is\" : \"s are\"} not shown");
    expect(page).toContain("Couldn&apos;t load the conversations: {historyError}");
    expect(page).toContain("applyHistory(await listKnowledgeQuestions(activeOrgId, libraryId));");
  });
});

describe("IEDGE-6 — the backlinks panel counts the mentions it may not show", () => {
  it("mentionAccessGap = the org-wide count (definer RPC) minus the reader's own visible count", async () => {
    browser.state.rpc.entity_mentions_total_for_asset = () => ({ data: 5, error: null });
    browser.state.tables.entity_mentions = [
      { id: "m1", org_id: ORG, asset_id: "as1" }, { id: "m2", org_id: ORG, asset_id: "as1" }, { id: "m3", org_id: ORG, asset_id: "as2" },
    ];
    expect(await mentionAccessGap(ORG, "as1")).toEqual({ total: 5, visible: 2, withheld: 3 });
  });
  it("pre-migration (no RPC) it says nothing rather than guessing", async () => {
    expect(await mentionAccessGap(ORG, "as1")).toBeNull();
  });
  it("the line reads naturally with and without visible rows; nothing when nothing is withheld", () => {
    expect(describeWithheldMentions(0, true, "P-204A")).toBeNull();
    expect(describeWithheldMentions(1, true, "P-204A")).toBe("1 further mention is in documents you don't have access to.");
    expect(describeWithheldMentions(3, false, "P-204A")).toBe("3 mentions of P-204A are in documents you don't have access to.");
  });
  it("MentionsPanel renders it and never shows 'nothing mentions' while mentions are withheld", () => {
    const panel = repo("components/assets/MentionsPanel.tsx");
    expect(panel).toContain("mentionAccessGap(orgId, assetId).catch(() => null)");
    expect(panel).toContain("{docs !== null && docs.length === 0 && !error && withheld === 0 && (");
    expect(panel).toContain("{describeWithheldMentions(withheld, docs.length > 0, tag)}");
  });
});

// ── 20261120 ────────────────────────────────────────────────────────────────
describe("20261120 — the paste contract, the predicates, byte fidelity, the census", () => {
  const FILE = "20261120_intel_roundG_knowledge_memory_acl.sql";
  const m = mig(FILE);
  const body = strip(m.slice(m.indexOf("\nBEGIN;"), m.indexOf("\nCOMMIT;")));
  const tail = m.slice(m.indexOf("\nCOMMIT;"));

  it("one paste: TEMP inventory before BEGIN, DDL in one transaction, ONE final SELECT with (check, ok, n)", () => {
    expect(m.indexOf("CREATE TEMP TABLE IF NOT EXISTS _intel_g20_before AS")).toBeLessThan(m.indexOf("\nBEGIN;"));
    expect((m.match(/\nBEGIN;/g) ?? []).length).toBe(1);
    expect((m.match(/\nCOMMIT;/g) ?? []).length).toBe(1);
    const selects = strip(tail.slice("\nCOMMIT;".length)).split(";").map((s) => s.trim()).filter(Boolean);
    expect(selects).toHaveLength(1);
    expect(selects[0]).toMatch(/^SELECT '[\s\S]*?' AS "check",/);
    expect(selects[0]).toContain("AS ok,");
    expect(selects[0]).toContain("NULL::text AS n");
    expect(selects[0]).toContain("SELECT 'inventory (before): ' || what, NULL, n::text FROM _intel_g20_before");
    // inventory is aggregate only
    const inv = strip(m.slice(m.indexOf("CREATE TEMP TABLE"), m.indexOf("\nBEGIN;")));
    expect(inv.match(/SELECT '[^']*'(?: AS what)?, COUNT\(\*\)/g)?.length).toBe(9);
    // probes use no bare cast inside a LIKE pattern (pg_policies.qual is deparsed)
    expect(tail).not.toMatch(/LIKE '[^']*::[^']*'/);
  });
  it("knowledge_questions_select = the 20260911 membership clause verbatim AND (asker OR controller)", () => {
    const before = strip(mig("20260911_knowledge_ai.sql"));
    const oldPol = before.slice(before.indexOf("CREATE POLICY knowledge_questions_select"), before.indexOf(");", before.indexOf("CREATE POLICY knowledge_questions_select")) + 2);
    const newPol = body.slice(body.indexOf("CREATE POLICY knowledge_questions_select"), body.indexOf(");", body.indexOf("CREATE POLICY knowledge_questions_select")) + 2);
    const d = lineDiff(oldPol, newPol);
    expect(d.onlyInA).toEqual([]);                                  // nothing of the old policy is lost
    expect(d.onlyInB).toEqual(["AND (knowledge_questions.user_id = auth.uid() OR is_org_controller(knowledge_questions.org_id))"]);
  });
  it("knowledge_documents_select = the 20260911 membership clause verbatim AND (upload OR controlled document visible under the caller's RLS)", () => {
    const before = strip(mig("20260911_knowledge_ai.sql"));
    const oldPol = before.slice(before.indexOf("CREATE POLICY knowledge_documents_select"), before.indexOf(");", before.indexOf("CREATE POLICY knowledge_documents_select")) + 2);
    const newPol = body.slice(body.indexOf("CREATE POLICY knowledge_documents_select"), body.indexOf("\n);", body.indexOf("CREATE POLICY knowledge_documents_select")) + 3);
    const d = lineDiff(oldPol, newPol);
    expect(d.onlyInA).toEqual([]);
    expect(d.onlyInB).toEqual([
      "AND (knowledge_documents.source_document_id IS NULL",
      "OR EXISTS (SELECT 1 FROM documents d WHERE d.id = knowledge_documents.source_document_id))",
    ]);
  });
  it("entity_mentions_source_readable is RESTRICTIVE for SELECT and reads both hops through RLS; entity_mentions_read is untouched", () => {
    expect(body).toMatch(/CREATE POLICY entity_mentions_source_readable ON entity_mentions AS RESTRICTIVE FOR SELECT USING \(\n\s+\(entity_mentions\.document_id IS NULL\n\s+OR EXISTS \(SELECT 1 FROM documents d WHERE d\.id = entity_mentions\.document_id\)\)\n\s+AND \(entity_mentions\.knowledge_document_id IS NULL\n\s+OR EXISTS \(SELECT 1 FROM knowledge_documents k WHERE k\.id = entity_mentions\.knowledge_document_id\)\)\n\);/);
    expect(body).not.toMatch(/CREATE POLICY entity_mentions_read\b/);
    expect(body).not.toMatch(/entity_mentions_write/);
  });
  it("the hub's count is a SECURITY DEFINER sql function with search_path pinned, members only, never rows", () => {
    const fn = body.slice(body.indexOf("CREATE OR REPLACE FUNCTION entity_mentions_total_for_asset"), body.indexOf("REVOKE ALL ON FUNCTION entity_mentions_total_for_asset"));
    expect(fn).toContain("RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$");
    expect(fn).toContain("WHERE org_id = p_org_id AND uid = auth.uid() AND status = 'active')");
    expect(fn).toContain("ELSE 0");
    expect(body).toContain("REVOKE ALL ON FUNCTION entity_mentions_total_for_asset(uuid, uuid) FROM public, anon;");
    expect(body).toContain("GRANT EXECUTE ON FUNCTION entity_mentions_total_for_asset(uuid, uuid) TO authenticated;");
  });
  it("no probe relies on anything but the deparsed forms it names", () => {
    expect(tail).toContain("AND qual LIKE '%user_id = auth.uid()%'");
    expect(tail).toContain("AND qual LIKE '%d.id = knowledge_documents.source_document_id%'");
    expect(tail).toContain("AND permissive = 'RESTRICTIVE' AND cmd = 'SELECT'");
  });
  it("census: 20261120 is the last definer of the three policies; the 20260917 chunk lockdown is the live chunk read", () => {
    const files = readdirSync(join(process.cwd(), "supabase", "migrations")).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
    const last = (re: RegExp) => files.filter((f) => re.test(strip(mig(f)))).pop();
    expect(last(/CREATE POLICY\s+knowledge_questions_select\b/)).toBe(FILE);
    expect(last(/CREATE POLICY\s+knowledge_documents_select\b/)).toBe(FILE);
    expect(last(/CREATE POLICY\s+entity_mentions_source_readable\b/)).toBe(FILE);
    expect(last(/CREATE POLICY\s+knowledge_chunks_select\b/)).toBe("20260917_knowledge_sources.sql");
    expect(last(/CREATE POLICY\s+knowledge_documents_write\b/)).toBe("20260911_knowledge_ai.sql");
    // schema.sql defines none of them (the baseline predates the tables)
    expect(strip(repo("supabase/schema.sql"))).not.toMatch(/knowledge_questions_select|knowledge_documents_select|entity_mentions_source_readable/);
  });
});

describe("the history route never judges a turn on a partial conversation", () => {
  it("when the conversation read comes back full, a listed turn later than what was read is withheld (fail-safe)", async () => {
    admin.state.user = { id: V };
    const T3 = "1a000000-0000-4000-8000-000000000003";
    // 1,001 readable turns in one thread: the context read (1,000, oldest
    // first) cannot see the last one's predecessors in full.
    admin.state.tables.knowledge_questions = Array.from({ length: 1001 }, (_, i) => ({
      id: `3a000000-0000-4000-8000-${String(i).padStart(12, "0")}`, org_id: ORG, library_id: LIB, thread_id: T3,
      user_id: V, user_name: "v", question: `turn ${i}`, answer: "a", citations: [cite(K_UP)], mode: "library",
      created_at: `2026-09-01T00:00:00.${String(i).padStart(4, "0")}Z`,
    }));
    const body = await (await post({ orgId: ORG, libraryId: LIB, action: "list", limit: 3 })).json();
    // the three newest turns: the 1,000th read row is turn 999, so turn 1000 is withheld
    expect(body.rows.map((r: { question: string }) => r.question)).toEqual(["turn 999", "turn 998"]);
    expect(body.withheld).toBe(1);
  });
});
