// intelligence Round G (I-02) — the knowledge memory ACL.
//
//   * ASK-1 / KACL-1 / IRLS-1 / IEDGE-5 — a stored answer carries what the
//     ASKER's ACL admitted. The browser no longer reads other people's rows
//     (20261120: knowledge_questions_select = the asker or a controller);
//     /api/knowledge/history re-decides every row for the CURRENT reader
//     through the real seam (loadPrincipal + readableControlledDocIds — the
//     real lib/knowledgeAccess runs below, only the service-role client is a
//     stand-in), withholds a row citing anything unreadable, and every later
//     turn of its conversation; a library answer citing NO document (no [n]
//     marker, invented markers stripped, a "Nothing matches" row naming the
//     asker's indexing gaps) proves nothing about its sources and is shown to
//     its asker only. Two members with different ACLs get different history
//     for the same library; a controller gets all of it (DEC-43); an error
//     answers nothing.
//   * KACL-7 / IEDGE-6 / IRLS-9 — the mirror-row and mention policies, pinned
//     by shape (and verified against a scratch PostgreSQL 16 — see the
//     finding records); the backlinks panel counts what it may not show.
//   * The 20260917 chunk lockdown was written as NOT EXISTS over
//     knowledge_documents; once a mirror row is hidden by RLS that turns into
//     a pass, so 20261120 re-creates it as a positive EXISTS — and a policy
//     census replaying every migration asserts no live policy tests NOT
//     EXISTS over a table this package narrowed.
//   * 20261120 — the paste contract, byte fidelity against 20260911 and
//     20260917, and a census replaying every numbered migration.

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
import { citedKnowledgeDocIds, knowledgeDocAccess, planVisibleHistory, readableKnowledgeDocIds, type StoredAnswerRow } from "@/lib/knowledgeHistory";
import {
  searchAskHistory, listKnowledgeQuestions, loadConversation, askKnowledgeLibrary,
  askContextHistory, persistedThread, restoredSeeded, ASK_CONTEXT_TURNS,
} from "@/lib/knowledge";
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
      // E's answer built from the restricted P&ID's passages with no [n]
      // marker (or with invented markers the ask route stripped): citations [].
      q({ question: "Q-uncited: relief valve set points, answered without a marker", answer: "PSV-2001 is set at 285 psig.", citations: [] }),
      // E's "Nothing matches" row (stored with no mode): its text names E's
      // own indexing gaps — a restricted document's number and title.
      q({ question: "Q-nomatch: relief valve set points nowhere", answer: "Nothing in this library matches the question.\n! Indexing gap: PID-2001 Restricted Unit P&ID", citations: [], mode: null }),
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
describe("the rule — an answer is as restricted as its most restricted CITED source (what a row records)", () => {
  it("citedKnowledgeDocIds reads document citations only; web citations name nothing; a malformed id is kept (so it resolves to nothing)", () => {
    expect(citedKnowledgeDocIds([cite(K_OPEN), { n: 2, url: "https://x" }, cite(K_OPEN), { documentId: 42 }, null, "x"])).toEqual([K_OPEN, "42"]);
    expect(citedKnowledgeDocIds({ not: "an array" })).toEqual([]);
    expect(citedKnowledgeDocIds(null)).toEqual([]);
  });
  it("a row citing any unreadable document is withheld whole; a web answer (no document citations) is shown", () => {
    const rows: StoredAnswerRow[] = [
      { id: "r1", library_id: LIB, question: "a", created_at: "1", citations: [cite(K_OPEN), cite(K_PRIV)], mode: "library" },
      { id: "r2", library_id: LIB, question: "b", created_at: "2", citations: [cite(K_OPEN)], mode: "library" },
      { id: "r3", library_id: LIB, question: "c", created_at: "3", citations: [{ url: "https://x" }], mode: "internet" },
    ];
    const plan = planVisibleHistory(rows, [], new Set([K_OPEN]), V);
    expect(plan.visible.map((r) => r.id)).toEqual(["r2", "r3"]);
    expect(plan.withheld.map((r) => r.id)).toEqual(["r1"]);
  });
  it("a LIBRARY answer citing no document is its asker's alone — withheld from every other non-controller, whatever its mode column says short of 'internet'", () => {
    const rows: StoredAnswerRow[] = [
      { id: "u1", library_id: LIB, question: "no marker", created_at: "1", citations: [], mode: "library", user_id: E },
      { id: "u2", library_id: LIB, question: "nothing matches (pre-mode row)", created_at: "2", citations: [], mode: null, user_id: E },
      { id: "u3", library_id: LIB, question: "no citations field at all", created_at: "3", user_id: E },
      { id: "u4", library_id: LIB, question: "web", created_at: "4", citations: [], mode: "internet", user_id: E },
    ];
    expect(planVisibleHistory(rows, [], new Set(), V).withheld.map((r) => r.id)).toEqual(["u1", "u2", "u3"]);
    expect(planVisibleHistory(rows, [], new Set(), E).visible.map((r) => r.id)).toEqual(["u1", "u2", "u3", "u4"]);
    // no reader → nobody's own
    expect(planVisibleHistory(rows, [], new Set(), null).visible.map((r) => r.id)).toEqual(["u4"]);
    // and it taints the rest of its conversation for everyone else
    const t = (id: string, at: string, citations: unknown[], user_id: string): StoredAnswerRow =>
      ({ id, library_id: LIB, thread_id: T1, question: id, created_at: at, citations, mode: "library", user_id });
    const turns = [t("a", "1", [cite(K_OPEN)], E), t("b", "2", [], E), t("c", "3", [cite(K_OPEN)], E)];
    expect(planVisibleHistory(turns, turns, new Set([K_OPEN]), V).visible.map((r) => r.id)).toEqual(["a"]);
    expect(planVisibleHistory(turns, turns, new Set([K_OPEN]), E).visible.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
  it("a conversation is withheld from its first unreadable turn onward (later turns carried it as context); earlier turns stay", () => {
    const t = (id: string, at: string, docId: string): StoredAnswerRow => ({ id, library_id: LIB, thread_id: T1, question: id, created_at: at, citations: [cite(docId)] });
    const turns = [t("t1", "1", K_OPEN), t("t2", "2", K_PRIV), t("t3", "3", K_OPEN), t("t4", "4", K_UP)];
    // Only the listed row t3 is asked about; the other turns decide it.
    const plan = planVisibleHistory([turns[2]], turns, new Set([K_OPEN, K_UP]), V);
    expect(plan.withheld.map((r) => r.id)).toEqual(["t3"]);
    const all = planVisibleHistory(turns, turns, new Set([K_OPEN, K_UP]), V);
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
  it("knowledgeDocAccess: the same readable set, and `gone` names only the uuid-shaped ids that resolve to no document (never a foreign or malformed one)", async () => {
    const { loadPrincipal } = await import("@/lib/knowledgeAccess");
    const pv = (await loadPrincipal(ORG, V))!;
    const ids = [K_UP, K_OPEN, K_PRIV, K_GONE, K_FOREIGN, "not-a-uuid"];
    const access = await knowledgeDocAccess(pv, ids);
    expect([...access.readable].sort()).toEqual([K_UP, K_OPEN].sort());
    expect([...access.gone]).toEqual([K_GONE]);
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
    expect(engineer).toEqual(["Q-nomatch", "Q-open", "Q-priv", "Q-uncited", "Q-upload", "Q-web", "T1-turn1", "T1-turn2", "T2-turn1", "T2-turn2"]);
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
    expect(JSON.parse(text).withheld).toBe(8);                      // priv, gone, foreign, T1×2, T2-turn2, uncited, nomatch
    expect(text).not.toContain("PSV-2001 set at 285 psig");
  });
  it("a library answer with no citations reaches no other member — list or search — and a 'Nothing matches' row's indexing gap never leaks (ASK-1 / KACL-1 / IEDGE-5)", async () => {
    admin.state.user = { id: V };
    const list = await (await post({ orgId: ORG, libraryId: LIB, action: "list" })).text();
    expect(list).not.toContain("PSV-2001 is set at 285 psig");
    expect(list).not.toContain("PID-2001 Restricted Unit P&ID");
    const search = await (await post({ orgId: ORG, libraryId: LIB, action: "search", query: "relief valve set points", limit: 20 })).text();
    expect(search).not.toContain("Q-uncited");
    expect(search).not.toContain("Q-nomatch");
    // its asker still sees both
    admin.state.user = { id: E };
    const mine = await (await post({ orgId: ORG, libraryId: LIB, action: "list" })).json();
    const own = mine.rows.filter((r: { question: string }) => /^Q-(uncited|nomatch)/.test(r.question));
    expect(own).toHaveLength(2);
    expect(own.every((r: { mine: boolean }) => r.mine)).toBe(true);
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
  it("reproduction → fix: a search never says how many MATCHES it withheld — that count answered 'does a restricted answer say X?' one phrase at a time", async () => {
    // Q-uncited (E's) says "PSV-2001 is set at 285 psig." — withheld from V.
    admin.state.user = { id: V };
    const probe = await (await post({ orgId: ORG, libraryId: LIB, action: "search", query: "285 psig", limit: 25 })).json();
    expect(probe.rows).toEqual([]);
    expect(probe).not.toHaveProperty("withheld");                       // was { rows: [], withheld: 1 }
    const miss = await (await post({ orgId: ORG, libraryId: LIB, action: "search", query: "999 psig", limit: 25 })).json();
    expect(miss).toEqual(probe);                                         // a hit and a miss answer alike
    // the asker still finds their own answer
    admin.state.user = { id: E };
    const own = await (await post({ orgId: ORG, libraryId: LIB, action: "search", query: "285 psig", limit: 25 })).json();
    expect(own.rows.map((r: { question: string }) => r.question.split(":")[0])).toEqual(["Q-uncited"]);
    // list and thread still say how many they are not showing (no query picks those rows)
    admin.state.user = { id: V };
    expect((await (await post({ orgId: ORG, libraryId: LIB, action: "list" })).json()).withheld).toBe(8);
    expect((await (await post({ orgId: ORG, libraryId: LIB, action: "thread", threadId: T1 })).json()).withheld).toBe(2);
    expect(repo("app/api/knowledge/history/route.ts")).toContain('...(action === "search" ? {} : { withheld }),');
  });
  describe("reproduction → fix: a search's answer never depends on how many matches were withheld (the fixed window was a count in coarser form)", () => {
    /** V's own matching answer, older than `restricted` matching answers of
     *  E's that cite the restricted P&ID (withheld from V). */
    const seedWindow = (restricted: number) => {
      admin.state.tables.knowledge_questions.push(q({
        question: "Q-mine: flange torque for the open standard", citations: [cite(K_OPEN)], user_id: V, created_at: "2026-10-01T00:00:00Z",
      }));
      for (let i = 0; i < restricted; i++) {
        admin.state.tables.knowledge_questions.push(q({
          question: `Q-hidden-${i}: flange torque from the restricted P&ID`, citations: [cite(K_PRIV, "RESTRICTED TORQUE")],
          created_at: `2026-10-02T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`,
        }));
      }
    };
    const search = async (limit: number) =>
      (await (await post({ orgId: ORG, libraryId: LIB, action: "search", query: "flange torque", limit })).json()) as { rows: Array<{ question: string }> };
    const names = (b: { rows: Array<{ question: string }> }) => b.rows.map((r) => r.question.split(":")[0]);

    it("limit=1 and limit=25 answer alike when 4 newer restricted answers match (was [] vs [Q-mine])", async () => {
      seedWindow(4);
      admin.state.user = { id: V };
      const small = await search(1);
      const large = await search(25);
      expect(names(small)).toEqual(["Q-mine"]);
      expect(large).toEqual(small);
      expect(JSON.stringify(large)).not.toContain("RESTRICTED TORQUE");
    });
    it("more restricted matches than one page (150) still never hide the reader's own answer — the search pages on", async () => {
      seedWindow(150);
      admin.state.user = { id: V };
      expect(names(await search(1))).toEqual(["Q-mine"]);
      expect(names(await search(100))).toEqual(["Q-mine"]);
      const pages = admin.state.calls.filter((c) => c.table === "knowledge_questions" && c.method === "range");
      expect(pages.map((c) => c.args)).toContainEqual([100, 199]);
    });
    it("a caller's limit below the default is ignored: limit=1 returns up to the default of rows the reader may see", async () => {
      admin.state.user = { id: E };
      const one = await (await post({ orgId: ORG, libraryId: LIB, action: "search", query: "relief valve set points", limit: 1 })).json();
      const five = await (await post({ orgId: ORG, libraryId: LIB, action: "search", query: "relief valve set points", limit: 5 })).json();
      expect(one.rows).toHaveLength(5);
      expect(one).toEqual(five);
    });
    it("the scan stops at SEARCH_SCAN_CAP matches (bounded work); what it found is returned and no count is said", async () => {
      seedWindow(520);
      admin.state.user = { id: V };
      const body = await search(5);
      expect(body.rows).toEqual([]);                                   // the residual: beyond the 500th newest match
      expect(body).not.toHaveProperty("withheld");
      const pages = admin.state.calls.filter((c) => c.table === "knowledge_questions" && c.method === "range").map((c) => c.args);
      expect(pages).toEqual([[0, 99], [100, 199], [200, 299], [300, 399], [400, 499]]);
      const route = repo("app/api/knowledge/history/route.ts");
      expect(route).toContain("const SEARCH_SCAN_CAP = 500;");
      expect(route).toContain("Math.max(SEARCH_DEFAULT, Math.min(Number(body.limit) || SEARCH_DEFAULT, 100))");
      expect(route).not.toContain("fetchN");
    });
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
    expect(body.rows).toHaveLength(12);
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
  it("reproduction: the seam judges a document restricted ONLY by its library's ACL as readable when the libraries read fails (loadDcLandscape ignores the error)", async () => {
    const { loadPrincipal, readableControlledDocIds } = await import("@/lib/knowledgeAccess");
    const RLIB = "0c000000-0000-4000-8000-000000000002";
    const DLIB = "0e000000-0000-4000-8000-000000000003";
    admin.state.tables.libraries.push({ id: RLIB, org_id: ORG, name: "Restricted", visibility: "private", owner_user_id: null, owner_team_id: null,
      acl: { visibility: "private", rules: [{ effect: "allow", subject: { type: "user", id: E }, actions: ["read", "discover"] }] } });
    admin.state.tables.documents.push({ id: DLIB, org_id: ORG, library_id: RLIB, collection_id: null, acl: null, visibility: "normal", is_private: false, scope: "org", created_by: A, owner_user_id: null });
    const pv = (await loadPrincipal(ORG, V))!;
    expect([...await readableControlledDocIds(pv, [DLIB])]).toEqual([]);           // the library's ACL denies V
    admin.state.failReads.libraries = { message: "statement timeout" };
    expect([...await readableControlledDocIds(pv, [DLIB])]).toEqual([DLIB]);      // …until the libraries read fails
  });
  it("…so the history route checks the libraries and folders reads first: either failing answers 500 with NO rows (fail closed)", async () => {
    const K_LIBR = "0f000000-0000-4000-8000-000000000003";
    const RLIB = "0c000000-0000-4000-8000-000000000002";
    const DLIB = "0e000000-0000-4000-8000-000000000003";
    admin.state.tables.libraries.push({ id: RLIB, org_id: ORG, name: "Restricted", visibility: "private", owner_user_id: null, owner_team_id: null,
      acl: { visibility: "private", rules: [{ effect: "allow", subject: { type: "user", id: E }, actions: ["read", "discover"] }] } });
    admin.state.tables.documents.push({ id: DLIB, org_id: ORG, library_id: RLIB, collection_id: null, acl: null, visibility: "normal", is_private: false, scope: "org", created_by: A, owner_user_id: null });
    admin.state.tables.knowledge_documents.push({ id: K_LIBR, org_id: ORG, source_document_id: DLIB });
    admin.state.tables.knowledge_questions.push(q({ question: "Q-libr: relief valve set points in the restricted library", citations: [cite(K_LIBR, "LIBRARY-ONLY QUOTE")] }));
    admin.state.user = { id: V };
    // healthy: withheld by the library's ACL
    const ok = await (await post({ orgId: ORG, libraryId: LIB, action: "list" })).text();
    expect(ok).not.toContain("LIBRARY-ONLY QUOTE");
    for (const table of ["libraries", "collections"]) {
      admin.state.failReads = { [table]: { message: "statement timeout" } };
      const res = await post({ orgId: ORG, libraryId: LIB, action: "list" });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text).rows).toBeUndefined();
      expect(JSON.parse(text).error).toMatch(/could not be read: statement timeout/);
      expect(text).not.toContain("LIBRARY-ONLY QUOTE");
    }
    // a controller is not filtered, so nothing is checked for them (DEC-43)
    admin.state.user = { id: A };
    expect((await post({ orgId: ORG, libraryId: LIB, action: "list" })).status).toBe(200);
  });
  it("reproduction: the seam judges a document DENIED to the reader's team as readable when the team_members read fails (loadPrincipal ignores the error)", async () => {
    const { loadPrincipal, readableControlledDocIds } = await import("@/lib/knowledgeAccess");
    const TM = "3a000000-0000-4000-8000-000000000001";
    const DTEAM = "0e000000-0000-4000-8000-000000000004";
    admin.state.tables.team_members.push({ team_id: TM, uid: V });
    admin.state.tables.documents.push({ id: DTEAM, org_id: ORG, library_id: DCLIB, collection_id: null, visibility: "normal", is_private: false, scope: "org", created_by: A, owner_user_id: null,
      acl: { visibility: "normal", rules: [
        { effect: "allow", subject: { type: "org", id: ORG }, actions: ["read", "discover"] },
        { effect: "deny", subject: { type: "team", id: TM }, actions: ["read", "discover"] },
      ] } });
    expect([...await readableControlledDocIds((await loadPrincipal(ORG, V))!, [DTEAM])]).toEqual([]);   // the team DENY binds
    admin.state.failReads.team_members = { message: "statement timeout" };
    const blind = (await loadPrincipal(ORG, V))!;
    expect(blind.teamIds).toEqual([]);                                                                 // the error is dropped
    expect([...await readableControlledDocIds(blind, [DTEAM])]).toEqual([DTEAM]);                     // …and the DENY never matches
  });
  it("…so the history route reads the reader's teams again: a failed read answers 500 with NO rows, and a principal whose teams were lost is judged with the teams actually read", async () => {
    const TM = "3a000000-0000-4000-8000-000000000001";
    const DTEAM = "0e000000-0000-4000-8000-000000000004";
    const K_TEAM = "0f000000-0000-4000-8000-000000000004";
    admin.state.tables.team_members.push({ team_id: TM, uid: V });
    admin.state.tables.documents.push({ id: DTEAM, org_id: ORG, library_id: DCLIB, collection_id: null, visibility: "normal", is_private: false, scope: "org", created_by: A, owner_user_id: null,
      acl: { visibility: "normal", rules: [
        { effect: "allow", subject: { type: "org", id: ORG }, actions: ["read", "discover"] },
        { effect: "deny", subject: { type: "team", id: TM }, actions: ["read", "discover"] },
      ] } });
    admin.state.tables.knowledge_documents.push({ id: K_TEAM, org_id: ORG, source_document_id: DTEAM });
    admin.state.tables.knowledge_questions.push(q({ question: "Q-team: relief valve set points from the team-denied sheet", citations: [cite(K_TEAM, "TEAM-DENIED QUOTE")] }));
    admin.state.user = { id: V };
    // healthy: withheld by the team DENY
    expect(await (await post({ orgId: ORG, libraryId: LIB, action: "list" })).text()).not.toContain("TEAM-DENIED QUOTE");
    // the team read fails: nothing is served
    admin.state.failReads = { team_members: { message: "statement timeout" } };
    const res = await post({ orgId: ORG, libraryId: LIB, action: "list" });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text).rows).toBeUndefined();
    expect(JSON.parse(text).error).toMatch(/teams \(and the access rules that name them\) could not be read: statement timeout/);
    expect(text).not.toContain("TEAM-DENIED QUOTE");
    // loadPrincipal's read failed but the re-read succeeds: judged with the teams read
    admin.state.failReads = {};
    const { loadPrincipal } = await import("@/lib/knowledgeAccess");
    const lost = { ...(await loadPrincipal(ORG, V))!, teamIds: [] };
    expect([...await readableKnowledgeDocIds(lost, [K_TEAM, K_OPEN])]).toEqual([K_OPEN]);
    // a controller is not filtered, so nothing is read for them (DEC-43)
    admin.state.failReads = { team_members: { message: "statement timeout" } };
    admin.state.user = { id: A };
    expect((await post({ orgId: ORG, libraryId: LIB, action: "list" })).status).toBe(200);
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
  it("reproduction → fix: the memory card shows the caller's limit, though the route reads at least its default of 5", async () => {
    const row = (id: string) => ({ id, libraryId: LIB, threadId: null, question: "q" + id, answer: "a" + id, citations: [], userName: "u", mode: "library", createdAt: "t", mine: false });
    fetchMock.mockResolvedValueOnce(reply({ rows: ["1", "2", "3", "4", "5"].map(row) }));
    const out = await searchAskHistory(ORG, LIB, "what are the relief valve set points", 3);
    expect(out.map((p) => p.id)).toEqual(["1", "2", "3"]);
    // the default limit is the route's floor — nothing is trimmed
    fetchMock.mockResolvedValueOnce(reply({ rows: ["1", "2", "3", "4", "5"].map(row) }));
    expect((await searchAskHistory(ORG, LIB, "what are the relief valve set points")).map((p) => p.id)).toEqual(["1", "2", "3", "4", "5"]);
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
  it("openConversation re-reads a thread through the route and keeps the thread only when every turn is the reader's own and none was withheld", () => {
    const fn = page.slice(page.indexOf("const openConversation = async (rows: KnowledgeQuestion[]) => {"), page.indexOf("const onFiles = async"));
    expect(fn).toContain("const page = await loadConversation(activeOrgId, libraryId, threadKey);");
    expect(fn).toContain("withheldTurns = page.withheld;");
    // a turn withheld from the reader's own thread would withhold every new
    // answer appended after it, so such a thread seeds a new one
    expect(fn).toContain("const own = withheldTurns === 0 && ordered.every((q) => q.mine === true);");
    expect(fn).toContain("const kept = own ? ordered[0]?.threadId ?? null : null;");
    expect(fn).toContain("setThreadId(kept ?? crypto.randomUUID());");
    // …and every turn of a seeded conversation is shown, never sent back (review blocker)
    expect(fn).toContain("setSeededTurns(kept ? 0 : turns.length);");
    expect(fn).toContain("Nothing in this conversation is visible to you");
  });
  it("the Conversations list says how many answers it is not showing — in words true of every reason a row is withheld — and a failed read is shown as a failure", () => {
    expect(page).toContain("recent answer{historyWithheld === 1 ? \" is\" : \"s are\"} not shown");
    // a teammate's uncited answer is withheld too: never told the reader it "cites documents you can't open"
    expect(page).not.toMatch(/they cite"\} documents|cite documents you can't open|it cites documents you can't open/);
    expect(page).toContain("{historyWithheld === 1 ? \"it draws\" : \"they draw\"} on documents");
    expect(page).toContain("{historyWithheld === 1 ? \"it is a teammate's answer that cites\" : \"they are teammates' answers that cite\"} no");
    expect(page).toContain("they draw on documents you can't open, or are a teammate's answer that cites no document.");
    expect(page).toContain("Nothing in this conversation is visible to you — it draws on documents you can't open, or is a teammate's answer that cites no document.");
    expect(page).toContain("and an answer that cites no document only to whoever asked it.");
    expect(repo("lib/knowledge.ts")).toContain("or because they are a\n *  teammate's library answer that cites no document (shown to its asker\n *  only)");
    expect(page).toContain("Couldn&apos;t load the conversations: {historyError}");
    expect(page).toContain("applyHistory(await listKnowledgeQuestions(activeOrgId, libraryId));");
  });
});

describe("a conversation seeded from the saved record is SHOWN, never sent back to the model (review blocker — IEDGE-5 / KACL-1)", () => {
  const turn = (question: string, answer: string) => ({ question, answer: { answer } });
  const foreign = turn("T1-turn1: relief valve set points on the restricted sheet", "PSV-2001 set at 285 psig [1]");
  it("reproduction: a follow-up stored in the NEW thread cites only what IT cites — so once it restates a seeded turn, the history rule cannot withhold it", () => {
    // E reopened T's thread (a new thread N) and asked "is that within the
    // ASME limit?" with T's restricted turn sent as history; the answer
    // restated 285 psig and cited only the open standard.
    const N = "1a000000-0000-4000-8000-0000000000aa";
    const followUp: StoredAnswerRow = {
      id: "f1", library_id: LIB, thread_id: N, user_id: E, question: "is that within the ASME limit?",
      answer: "Yes — 285 psig is within the ASME limit [1].", citations: [cite(K_OPEN)], mode: "library", created_at: "9",
    };
    const plan = planVisibleHistory([followUp], [followUp], new Set([K_UP, K_OPEN]), V);
    expect(plan.visible.map((r) => r.id)).toEqual(["f1"]);              // nothing on the row says where "that" came from
  });
  it("askContextHistory sends only the turns AFTER the seeded ones (the last ASK_CONTEXT_TURNS of them); an unreadable count sends nothing", () => {
    const own1 = turn("is that within the ASME limit?", "Yes, per ASME VIII [1].");
    const own2 = turn("and the blowdown?", "7% [1].");
    expect(askContextHistory([foreign], 1)).toEqual([]);
    expect(askContextHistory([foreign, own1, own2], 1)).toEqual([
      { question: own1.question, answer: own1.answer.answer },
      { question: own2.question, answer: own2.answer.answer },
    ]);
    expect(askContextHistory([foreign, foreign, own1], 2).map((t) => t.question)).toEqual([own1.question]);
    expect(askContextHistory([foreign], Number.NaN)).toEqual([]);
    expect(askContextHistory([foreign], -3)).toHaveLength(1);           // a negative count seeds nothing (own thread)
    const many = Array.from({ length: 9 }, (_, i) => turn(`q${i}`, `a${i}`));
    expect(askContextHistory(many, 0).map((t) => t.question)).toEqual(["q5", "q6", "q7", "q8"]);
    expect(ASK_CONTEXT_TURNS).toBe(4);
  });
  it("…so the seeded turn's restricted text never reaches askKnowledgeLibrary's request", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ answer: "ok", citations: [] }) }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const thread = [foreign, turn("my own follow-up", "an answer from the open standard [1]")];
      await askKnowledgeLibrary(ORG, LIB, "is that within the ASME limit?", "library", undefined, undefined,
        { history: askContextHistory(thread, 1), threadId: "1a000000-0000-4000-8000-0000000000aa" });
      const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
      expect(JSON.stringify(body)).not.toContain("285 psig");
      expect(body.history).toEqual([{ question: "my own follow-up", answer: "an answer from the open standard [1]" }]);
    } finally { vi.unstubAllGlobals(); }
  });
  it("the page: every ask sends askContextHistory(thread, seededTurns); reopening a teammate's (or a withheld) conversation seeds all of it; the memory card seeds its answer; a new conversation seeds nothing", () => {
    const page = repo("app/(protected)/knowledge/[id]/page.tsx");
    expect(page).toContain("history: askContextHistory(thread, seededTurns),");
    expect(page).not.toMatch(/history: thread\.slice\(/);
    const card = page.slice(page.indexOf("Show this answer — no AI call") - 1400, page.indexOf("Show this answer — no AI call"));
    expect(card).toContain("setThread([{ question: pa.question, answer: past }]);");
    expect(card).toContain("setSeededTurns(1);");
    expect(page).toContain("onClick={() => { setThread([]); setThreadId(null); setSeededTurns(0); setAnswer(null); setLastQuestion(\"\"); }}");
    // every place the thread is replaced sets the seeded count with it
    const replaced = page.match(/setThread\((?!\(prev\))/g) ?? [];
    const seededSet = page.match(/setSeededTurns\(/g) ?? [];
    expect(replaced.length).toBe(4);                                     // restore, reopen, memory card, new conversation
    expect(seededSet.length).toBe(replaced.length);
    // the reader is told, where they type the follow-up
    expect(page).toContain("never sent to the AI with a follow-up, so ask it in full.");
  });
  it("a reload keeps the count: persisted with the turns (re-based when older turns are dropped); a saved conversation that does not say is seeded whole", () => {
    const t = (i: number) => turn(`q${i}`, `a${i}`);
    expect(persistedThread([t(1), t(2), t(3)], 1)).toEqual({ turns: [t(1), t(2), t(3)], seeded: 1 });
    const eight = Array.from({ length: 8 }, (_, i) => t(i));
    expect(persistedThread(eight, 3)).toEqual({ turns: eight.slice(-6), seeded: 1 });
    expect(persistedThread(eight, 1).seeded).toBe(0);
    expect(persistedThread(eight, 8).seeded).toBe(6);
    expect(restoredSeeded({ turns: [t(1), t(2)], seeded: 1 })).toBe(1);
    expect(restoredSeeded({ turns: [t(1), t(2)] })).toBe(2);             // written before this rule: nothing of it is sent
    expect(restoredSeeded({ turns: [t(1)], seeded: 9 })).toBe(1);
    const page = repo("app/(protected)/knowledge/[id]/page.tsx");
    expect(page).toContain("JSON.stringify({ threadId, ...persistedThread(thread, seededTurns) }),");
    expect(page).toContain("setSeededTurns(restoredSeeded(saved));");
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
  it("the line counts PAGES — the unit both sides of the subtraction count (one entity_mentions row per document page) — never 'mentions', the header's summed mention_count", () => {
    expect(describeWithheldMentions(0, true, "P-204A")).toBeNull();
    expect(describeWithheldMentions(1, true, "P-204A")).toBe("1 further page mentioning P-204A is in documents you don't have access to.");
    expect(describeWithheldMentions(3, false, "P-204A")).toBe("3 pages mentioning P-204A are in documents you don't have access to.");
    expect(describeWithheldMentions(2, true, "P-204A")).not.toMatch(/\bmentions?\b/);
    // the unique index that makes a row a page
    expect(strip(mig("20260929_mention_engine.sql"))).toContain(
      "ON entity_mentions (asset_id, COALESCE(knowledge_document_id, document_id), page);");
    // both counts are row counts: the definer RPC counts rows, the reader's own read counts rows
    expect(strip(mig("20261120_intel_roundG_knowledge_memory_acl.sql"))).toContain(
      "THEN (SELECT COUNT(*) FROM entity_mentions WHERE org_id = p_org_id AND asset_id = p_asset_id)");
    expect(repo("lib/mentions.ts")).toContain('supabase.from("entity_mentions").select("id", { count: "exact", head: true })');
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
    expect(inv.match(/SELECT '[^']*'(?: AS what)?, COUNT\(\*\)/g)?.length).toBe(10);
    // the read 20260917's NOT EXISTS would have widened is counted before apply
    expect(inv).toContain("SELECT 'knowledge_chunks of mirrors of private or hidden documents");
    expect(inv).toContain("JOIN knowledge_documents k ON k.id = c.document_id");
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
  it("reproduction: 20260917's chunk lockdown is a NOT EXISTS over knowledge_documents — under the caller's RLS a HIDDEN mirror row makes it pass", () => {
    const old = strip(mig("20260917_knowledge_sources.sql"));
    const pol = old.slice(old.indexOf("CREATE POLICY knowledge_chunks_select"), old.indexOf("\n);", old.indexOf("CREATE POLICY knowledge_chunks_select")) + 3);
    expect(pol).toMatch(/AND NOT EXISTS \(\s*SELECT 1 FROM knowledge_documents d/);
    expect(pol).toContain("AND d.source_document_id IS NOT NULL");
    // …and 20261120 is the migration that starts hiding mirror rows
    expect(body).toContain("OR EXISTS (SELECT 1 FROM documents d WHERE d.id = knowledge_documents.source_document_id))");
  });
  it("knowledge_chunks_select = 20260917's body with the lockdown written POSITIVELY (an upload row the caller can see), in the same transaction as the mirror-row narrowing", () => {
    const old = strip(mig("20260917_knowledge_sources.sql"));
    const oldPol = old.slice(old.indexOf("CREATE POLICY knowledge_chunks_select"), old.indexOf("\n);", old.indexOf("CREATE POLICY knowledge_chunks_select")) + 3);
    const newPol = body.slice(body.indexOf("CREATE POLICY knowledge_chunks_select"), body.indexOf("\n);", body.indexOf("CREATE POLICY knowledge_chunks_select")) + 3);
    const d = lineDiff(oldPol, newPol);
    expect(d.onlyInA).toEqual(["AND NOT EXISTS (", "AND d.source_document_id IS NOT NULL"]);
    expect(d.onlyInB).toEqual(["AND EXISTS (", "AND d.source_document_id IS NULL"]);
    expect(body).toContain("DROP POLICY IF EXISTS knowledge_chunks_select ON knowledge_chunks;");
    // inside the one transaction, after the knowledge_documents narrowing
    expect(body.indexOf("CREATE POLICY knowledge_chunks_select")).toBeGreaterThan(body.indexOf("CREATE POLICY knowledge_documents_select"));
    // the paste probes the positive form (deparsed: NOT EXISTS reads "NOT (EXISTS (") and every policy in the database
    expect(tail).toContain("AND qual LIKE '%d.source_document_id IS NULL%'");
    expect(tail).toContain("AND qual NOT LIKE '%IS NOT NULL%'");
    expect(tail).toContain("AND qual !~ 'NOT \\(?EXISTS')");
    expect(tail).toContain("~ 'NOT \\(?EXISTS \\( *SELECT[^()]*FROM (public\\.)?(knowledge_documents|knowledge_questions|entity_mentions)\\M'");
    expect(tail).not.toContain("the 20260917 chunk lockdown still closes every mirror chunk");
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
  it("census: 20261120 is the last definer of the four policies; the controller write policies are 20260911's", () => {
    const files = readdirSync(join(process.cwd(), "supabase", "migrations")).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
    const last = (re: RegExp) => files.filter((f) => re.test(strip(mig(f)))).pop();
    expect(last(/CREATE POLICY\s+knowledge_questions_select\b/)).toBe(FILE);
    expect(last(/CREATE POLICY\s+knowledge_documents_select\b/)).toBe(FILE);
    expect(last(/CREATE POLICY\s+knowledge_chunks_select\b/)).toBe(FILE);
    expect(last(/CREATE POLICY\s+entity_mentions_source_readable\b/)).toBe(FILE);
    expect(last(/CREATE POLICY\s+knowledge_documents_write\b/)).toBe("20260911_knowledge_ai.sql");
    expect(last(/CREATE POLICY\s+knowledge_chunks_write\b/)).toBe("20260911_knowledge_ai.sql");
    // schema.sql defines none of them (the baseline predates the tables)
    expect(strip(repo("supabase/schema.sql"))).not.toMatch(/knowledge_questions_select|knowledge_documents_select|knowledge_chunks_select|entity_mentions_source_readable/);
  });
  it("policy census (schema.sql + every migration, in order): no LIVE policy tests NOT EXISTS over a table whose rows RLS now hides — the cross-table read the blocker hid in", () => {
    const files = readdirSync(join(process.cwd(), "supabase", "migrations")).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
    const replay = (upTo: string | null) => {
      const live = new Map<string, string>();
      const sources = [strip(repo("supabase/schema.sql")), ...files.filter((f) => upTo === null || f <= upTo).map((f) => strip(mig(f)))];
      const stmt = /DROP POLICY\s+(?:IF EXISTS\s+)?"?(\w+)"?\s+ON\s+(?:public\.)?(\w+)\s*;|CREATE POLICY\s+"?(\w+)"?\s+ON\s+(?:public\.)?(\w+)([^;]*);/g;
      for (const src of sources) {
        for (const x of src.matchAll(stmt)) {
          if (x[1]) live.delete(`${x[2]}.${x[1]}`);
          else live.set(`${x[4]}.${x[3]}`, x[5]);
        }
      }
      return live;
    };
    const opensOnHidden = /NOT\s+EXISTS\s*\(\s*SELECT[^()]*?\bFROM\s+(?:public\.)?(knowledge_documents|knowledge_questions|entity_mentions)\b/i;
    const offenders = (live: Map<string, string>) => [...live].filter(([, b]) => opensOnHidden.test(b)).map(([k]) => k);
    const now = replay(null);
    // the census sees the policies it must (it is not vacuous)
    for (const k of ["knowledge_chunks.knowledge_chunks_select", "knowledge_documents.knowledge_documents_select",
      "knowledge_questions.knowledge_questions_select", "entity_mentions.entity_mentions_source_readable", "entity_mentions.entity_mentions_read"]) {
      expect(now.has(k)).toBe(true);
    }
    expect(offenders(now)).toEqual([]);
    // reproduction: replayed up to the migration before this one, the 20260917 lockdown is the one offender
    const before = replay(files[files.indexOf(FILE) - 1]);
    expect(offenders(before)).toEqual(["knowledge_chunks.knowledge_chunks_select"]);
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
