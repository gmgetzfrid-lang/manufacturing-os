// intelligence Round G (I-09) — /api/flows/read, end to end against a mocked
// service role, the gates, the renderer and the document gate.
//
// Regression pins (the user's top rule): a controller's read works as
// before — proposals land as status 'proposed', origin 'ai', with the
// document and page — and a member under their cap with a signed agreement
// reads flows as today. Then each finding's own mechanism: authority by the
// collection (FLOW-3), the agreement gate before any render (GOV-11 /
// PR-12), the caller's document gate (SEC-10), the roster (FLOW-4), the
// settled set (FLOW-5 / IEDGE-8), the tolerant write (FLOW-12), the
// malformed reply (PR-8), the pages report and width (FLOW-11 / FLOW-13),
// proposals outside the launching unit (FLOW-1), and the read record the
// area checklist counts (AREA-8).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
type PgErr = { code?: string; message: string };
const st = vi.hoisted(() => ({
  user: { id: "admin1", email: "admin@x.io" } as null | { id: string; email?: string },
  rows: {} as Record<string, Row[]>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  order: [] as string[],
  noVersionColumn: false,
  upsertError: null as PgErr | null,
  upsertDropPairs: [] as string[],
  insertError: null as null | ((row: Row) => PgErr | null),
  gateError: null as unknown,
  aiError: null as unknown,
  aiText: '{"flows":[]}',
  aiInputs: [] as Array<Record<string, unknown>>,
  renderArgs: [] as Array<{ key: string; pages: number[]; opts: Record<string, unknown> }>,
  numPages: 6,
  failPages: [] as number[],
  docGate: { ok: true, file: { documentId: "dc1", label: "PFD-1", fileKey: "r2/pfd-1.pdf", fileType: "application/pdf" } } as
    | { ok: true; file: { documentId: string; label: string; fileKey: string; fileType: string | null } }
    | { ok: false; status: number; error: string },
  docGateCalls: [] as Array<unknown[]>,
  seq: 0,
}));

function chain(table: string) {
  let op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
  let cols = "";
  let payload: unknown = null;
  let opts: Record<string, unknown> = {};
  let returning = false;
  let head = false;
  const filters: Array<(r: Row) => boolean> = [];
  const orders: Array<[string, boolean]> = [];
  let range: [number, number] | null = null;
  const all = () => (st.rows[table] ??= []);
  const matching = () => all().filter((r) => filters.every((f) => f(r)));
  const sorted = (rows: Row[]) => [...rows].sort((a, b) => {
    for (const [k, asc] of orders) {
      const x = String(a[k] ?? ""), y = String(b[k] ?? "");
      if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
    }
    return 0;
  });
  const key = (r: Row) => `${r.from_kind}:${r.from_ref}>${r.to_kind}:${r.to_ref}`;
  const run = (): { data: unknown; error: PgErr | null; count?: number } => {
    if (op === "select") {
      if (table === "process_flows" && st.noVersionColumn && cols.includes("source_version_id")) {
        return { data: null, error: { code: "42703", message: "column process_flows.source_version_id does not exist" } };
      }
      const rows = sorted(matching());
      if (head) return { data: null, error: null, count: rows.length };
      return { data: range ? rows.slice(range[0], range[1] + 1) : rows, error: null };
    }
    if (op === "insert") {
      const list = (Array.isArray(payload) ? payload : [payload]) as Row[];
      for (const r of list) {
        const e = st.insertError?.(r) ?? null;
        if (e) return { data: null, error: e };
        if (table === "process_flows" && "source_version_id" in r && st.noVersionColumn) return { data: null, error: { code: "PGRST204", message: "Could not find the 'source_version_id' column" } };
        if (table === "process_flows" && all().some((x) => key(x) === key(r) && x.org_id === r.org_id)) return { data: null, error: { code: "23505", message: "duplicate key value" } };
      }
      const made = list.map((r) => ({ id: `new-${++st.seq}`, ...r }));
      all().push(...made);
      return { data: returning ? made : null, error: null };
    }
    if (op === "upsert") {
      if (st.upsertError) return { data: null, error: st.upsertError };
      const list = payload as Row[];
      const made: Row[] = [];
      for (const r of list) {
        if (st.upsertDropPairs.includes(key(r))) continue; // written by someone else meanwhile
        if (all().some((x) => key(x) === key(r) && x.org_id === r.org_id)) continue;
        const row = { id: `new-${++st.seq}`, ...r };
        all().push(row); made.push(row);
      }
      return { data: returning ? made : null, error: null };
    }
    if (op === "update") {
      const hit = matching();
      for (const r of hit) Object.assign(r, payload as Row);
      return { data: returning ? hit : null, error: null };
    }
    const hit = matching();
    st.rows[table] = all().filter((r) => !hit.includes(r));
    return { data: returning ? hit : null, error: null };
  };
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => { try { resolve(run()); } catch (e) { reject(e); } };
      return (...args: unknown[]) => {
        st.calls.push({ table, method: prop, args });
        switch (prop) {
          case "select":
            if (op === "select") { cols = String(args[0] ?? "*"); head = !!(args[1] as { head?: boolean } | undefined)?.head; }
            else returning = true;
            break;
          case "insert": op = "insert"; payload = args[0]; break;
          case "upsert": op = "upsert"; payload = args[0]; opts = (args[1] as Row) ?? {}; break;
          case "update": op = "update"; payload = args[0]; break;
          case "delete": op = "delete"; break;
          case "eq": filters.push((r) => r[String(args[0])] === args[1]); break;
          case "neq": filters.push((r) => r[String(args[0])] !== args[1]); break;
          case "in": filters.push((r) => (args[1] as unknown[]).includes(r[String(args[0])])); break;
          case "not": filters.push((r) => r[String(args[0])] !== null && r[String(args[0])] !== undefined); break;
          case "order": orders.push([String(args[0]), (args[1] as { ascending?: boolean } | undefined)?.ascending !== false]); break;
          case "range": range = [Number(args[0]), Number(args[1])]; break;
          case "maybeSingle": case "single": {
            const r = run();
            const d = Array.isArray(r.data) ? (r.data as Row[])[0] ?? null : r.data;
            return Promise.resolve({ data: r.error ? null : d, error: r.error });
          }
        }
        void opts;
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: vi.fn(async () => st.user ? { data: { user: st.user }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
    from: (t: string) => chain(t),
  },
}));
vi.mock("@/lib/ai/aiGates", () => ({
  assertAiGates: vi.fn(async () => {
    st.order.push("gates");
    if (st.gateError) throw st.gateError;
    return { connection: { provider: "anthropic", model: "m", apiKey: "k" }, capUsd: 10, month: { spentUsd: 0 }, reserve: vi.fn() };
  }),
}));
vi.mock("@/lib/ai/governedCall", async () => {
  const g = await import("@/lib/ai/gateError");
  return {
    GovernedCallError: g.GovernedCallError,
    governedAiCall: vi.fn(async (input: Record<string, unknown>) => {
      st.order.push("call");
      st.aiInputs.push(input);
      if (st.aiError) throw st.aiError;
      return { text: st.aiText, usage: { inputTokens: 100, outputTokens: 50 } };
    }),
  };
});
vi.mock("@/lib/knowledgePageRender", () => ({
  DRAWING_RENDER_WIDTH: 1800,
  renderKnowledgePagesReport: vi.fn(async (key: string, pages: number[], opts: Record<string, unknown>) => {
    st.order.push("render");
    st.renderArgs.push({ key, pages, opts });
    const inRange = pages.filter((p) => p >= 1 && p <= st.numPages);
    return {
      images: inRange.filter((p) => !st.failPages.includes(p)).map((page) => ({ page, mediaType: "image/png", base64: `img${page}` })),
      numPages: st.numPages,
      outOfRange: pages.filter((p) => p > st.numPages),
      failed: inRange.filter((p) => st.failPages.includes(p)),
      notStarted: [],
      width: opts.width,
      openFailed: false,
    };
  }),
}));
vi.mock("@/lib/docFileServer", () => ({
  resolveDocumentFile: vi.fn(async (...args: unknown[]) => { st.docGateCalls.push(args); return st.docGate; }),
}));

import { POST } from "@/app/api/flows/read/route";
import { GovernedCallError } from "@/lib/ai/gateError";

const post = (body: Record<string, unknown>) => POST(new NextRequest("http://x/api/flows/read", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" },
  body: JSON.stringify({ orgId: "o1", knowledgeDocumentId: "kd1", ...body }),
}));
const member = (uid: string, role: string, roles: string[] = [role]) => ({ org_id: "o1", uid, role, roles, status: "active" });
const a = (id: string, tag: string, unit: string | null) => ({ id, org_id: "o1", tag, unit_code: unit, archived: false });
const flowsOf = () => st.rows.process_flows ?? [];

beforeEach(() => {
  st.user = { id: "admin1", email: "admin@x.io" };
  st.calls = []; st.order = []; st.aiInputs = []; st.renderArgs = []; st.docGateCalls = [];
  st.noVersionColumn = false; st.upsertError = null; st.upsertDropPairs = []; st.insertError = null;
  st.gateError = null; st.aiError = null; st.numPages = 6; st.failPages = []; st.seq = 0;
  st.docGate = { ok: true, file: { documentId: "dc1", label: "PFD-1", fileKey: "r2/pfd-1.pdf", fileType: "application/pdf" } };
  st.rows = {
    org_members: [
      member("admin1", "Admin"), member("mgrdc", "Manager", ["Manager", "DocCtrl"]),
      member("sup1", "Supervisor"), member("mgr1", "Manager"), member("viewer1", "Viewer"),
    ],
    knowledge_documents: [{ id: "kd1", org_id: "o1", name: "PFD-1", file_key: "r2/pfd-1.pdf", page_count: 6, source_document_id: "dc1", source_version_id: "rev1" }],
    documents: [{ id: "dc1", org_id: "o1", unit_code: "20" }],
    assets: [a("a1", "V-101", "20"), a("a2", "E-201", "20"), a("a3", "P-310", "25"), a("a4", "T-401", null)],
    codebook_entries: [{ org_id: "o1", kind: "unit", code: "20", label: "Crude" }, { org_id: "o1", kind: "unit", code: "25", label: "DHT" }],
    process_flows: [],
    audit_logs: [],
  };
  // roster order for these four (unit 20 first, then 25 by drawing decode = 20 too, then by tag):
  // A1 E-201, A2 V-101, A3 P-310, A4 T-401; U1 20, U2 25
  st.aiText = JSON.stringify({ flows: [{ from: "A2", to: "A1", label: "crude feed", page: 2, confidence: 0.9 }] });
});

describe("regression pins — a controller's flow reading works as before", () => {
  it("an Admin reads a PFD: the proposal lands proposed / ai / with the document and page, and the answer names it", async () => {
    const res = await post({});
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.proposed).toBe(1);
    expect(json.pagesRead).toEqual([1, 2, 3, 4, 5, 6]);
    expect(flowsOf()).toEqual([expect.objectContaining({
      from_kind: "asset", from_ref: "a1", to_kind: "asset", to_ref: "a2", label: "crude feed",
      status: "proposed", origin: "ai", source_document_id: "kd1", source_page: 2, source_version_id: "rev1",
      evidence: { docName: "PFD-1", confidence: 0.9 }, created_by: "admin1",
    })]);
    expect(json.note).toMatch(/Read pages 1–6 of 6\. 1 flow proposed/);
  });

  it("a member with DocCtrl held additively (headline Manager) reads flows (FLOW-3: the collection, not the headline)", async () => {
    st.user = { id: "mgrdc" };
    expect((await post({})).status).toBe(200);
  });

  it("Manager, Supervisor and Viewer are refused with the route's sentence, before any render or call", async () => {
    for (const uid of ["mgr1", "sup1", "viewer1"]) {
      st.user = { id: uid }; st.order = [];
      const res = await post({});
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("Only admins and document controllers shape the process map.");
      expect(st.order).toEqual([]);
    }
  });
});

describe("GOV-11 / PR-12 — the gates run before any render; the call is governedAiCall with the images", () => {
  it("an unsigned member gets 428 with the agreement text; nothing is rendered or sent", async () => {
    st.gateError = new GovernedCallError("Accept the AI acceptable-use agreement first.", 428, {
      agreementRequired: true, agreementText: "the rules", agreementVersion: "2026-10-v3",
    });
    const res = await post({});
    expect(res.status).toBe(428);
    const json = await res.json();
    expect(json).toMatchObject({ agreementRequired: true, agreementText: "the rules", agreementVersion: "2026-10-v3" });
    expect(st.order).toEqual(["gates"]);
  });

  it("a $0 lock (402) and an unreadable ledger (503) refuse the same way, before the render", async () => {
    st.gateError = new GovernedCallError("Your monthly AI cap is set to $0, so AI is locked for you until someone who manages AI caps raises it.", 402, { locked: true });
    let res = await post({});
    expect(res.status).toBe(402);
    expect((await res.json()).locked).toBe(true);
    st.order = [];
    st.gateError = new GovernedCallError("AI usage can't be read right now, so AI calls are refused until it can (down).", 503, { usageUnavailable: true });
    res = await post({});
    expect(res.status).toBe(503);
    expect(st.order).toEqual(["gates"]);
  });

  it("a signed member under their cap: gates, then render, then ONE governed call carrying the rendered pages", async () => {
    await post({});
    expect(st.order).toEqual(["gates", "render", "call"]);
    expect(st.aiInputs).toHaveLength(1);
    expect(st.aiInputs[0]).toMatchObject({ orgId: "o1", userId: "admin1", op: "flowRead", maxTokens: 1600 });
    expect((st.aiInputs[0].images as unknown[]).length).toBe(6);
  });

  it("a refusal from the governed call itself (the reservation does not fit) is its own status", async () => {
    st.aiError = new GovernedCallError("Monthly AI budget reached ($9.99 of $10.00).", 402);
    const res = await post({});
    expect(res.status).toBe(402);
    expect(flowsOf()).toHaveLength(0);
  });
});

describe("SEC-10 — the pages are the caller's to read", () => {
  it("a mirror of a controlled document goes through resolveDocumentFile (channel flows_read); a refusal is its status and nothing is rendered", async () => {
    st.docGate = { ok: false, status: 403, error: "You don't have access to read that document." };
    const res = await post({});
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("You don't have access to read that document.");
    expect(st.docGateCalls[0]).toEqual(["o1", "dc1", { uid: "admin1", email: "admin@x.io", channel: "flows_read" }]);
    expect(st.order).toEqual([]);
  });

  it("a broken folder chain is named (409); a gate that cannot read is 503 — both before any spend", async () => {
    st.docGate = { ok: false, status: 409, error: "This document's folder chain is broken (folder f9 no longer exists), so access to it can't be checked." };
    expect((await post({})).status).toBe(409);
    st.docGate = { ok: false, status: 503, error: "Couldn't verify your access to that document — try again." };
    expect((await post({})).status).toBe(503);
    expect(st.order).toEqual([]);
  });

  it("the pages rendered are the file the gate decided on; a mirror a sync has not caught up with reads the current revision, recorded as unknown", async () => {
    st.docGate = { ok: true, file: { documentId: "dc1", label: "PFD-1", fileKey: "r2/pfd-1-rev2.pdf", fileType: "application/pdf" } };
    await post({});
    expect(st.renderArgs[0].key).toBe("r2/pfd-1-rev2.pdf");
    expect(flowsOf()[0].source_version_id).toBeNull();
  });

  it("an upload with no controlled source keeps its own rule: no document gate, its own file", async () => {
    st.rows.knowledge_documents[0] = { ...st.rows.knowledge_documents[0], source_document_id: null, source_version_id: null, file_key: "r2/upload.pdf" };
    expect((await post({})).status).toBe(200);
    expect(st.docGateCalls).toHaveLength(0);
    expect(st.renderArgs[0].key).toBe("r2/upload.pdf");
  });
});

describe("FLOW-4 / AREA-5 / WIRE-6 — the roster", () => {
  it("350 registry assets read from the Crude Unit: all of Crude's equipment is offered, 50 left off are said to the model and to the person", async () => {
    st.rows.assets = [
      ...Array.from({ length: 330 }, (_, i) => a(`b${i}`, `A-${String(i).padStart(3, "0")}`, null)),
      ...Array.from({ length: 20 }, (_, i) => a(`c${i}`, `Z-${i}`, "20")),
    ];
    st.rows.documents = [{ id: "dc1", org_id: "o1", unit_code: null }];
    st.aiText = '{"flows":[]}';
    const json = await (await post({ unitCode: "20" })).json();
    expect(json.roster).toMatchObject({ assetsListed: 300, assetsTotal: 350, assetsOmitted: 50, launchingUnit: "20", launchingUnitListed: 20, launchingUnitOmitted: 0 });
    const user = String(st.aiInputs[0].user);
    expect(user).toContain("50 more registry equipment items are NOT listed (Crude's equipment is listed first)");
    expect(user).toContain("A1 [asset] Z-0");
    expect(json.note).toContain("50 registry equipment items were not offered to the reader");
  });

  it("the assets are read in pages, ordered (the same document read twice grounds on the same roster)", async () => {
    await post({});
    const assetReads = st.calls.filter((c) => c.table === "assets");
    expect(assetReads.some((c) => c.method === "order" && c.args[0] === "tag")).toBe(true);
    expect(assetReads.some((c) => c.method === "range")).toBe(true);
    expect(assetReads.some((c) => c.method === "limit")).toBe(false);
  });
});

describe("FLOW-5 / IEDGE-8 / AREA-3 — the settled set, whole and by status", () => {
  const existing = (over: Row) => ({ id: "f-old", org_id: "o1", from_kind: "asset", from_ref: "a1", to_kind: "asset", to_ref: "a2", status: "dismissed", origin: "ai", source_document_id: "kd1", source_version_id: "rev1", ...over });

  it("a dismissed pair survives a second read of the same document (same revision)", async () => {
    st.rows.process_flows = [existing({})];
    const json = await (await post({})).json();
    expect(json.proposed).toBe(0);
    expect(json.skippedDismissed).toBe(1);
    expect(json.skippedSettled).toBe(1);
    expect(flowsOf()).toEqual([expect.objectContaining({ id: "f-old", status: "dismissed" })]);
    expect(json.note).toContain("1 dismissed by a person");
    // IEDGE-8: the pair itself, with its reason — not folded into a count
    expect(json.skippedPairs).toEqual([{ from: "V-101", to: "E-201", reason: "dismissed", why: "dismissed by a person — it stands until the drawing is revised" }]);
  });

  it("the drawing revised (rev2): the dismissed pair is re-proposed in place, with the new revision", async () => {
    st.rows.process_flows = [existing({ decided_by: "admin1", decided_by_name: "admin@x.io", decided_at: "2026-09-01" })];
    st.rows.knowledge_documents[0].source_version_id = "rev2";
    const json = await (await post({})).json();
    expect(json.proposed).toBe(1);
    expect(json.reproposed).toBe(1);
    expect(flowsOf()).toEqual([expect.objectContaining({
      id: "f-old", status: "proposed", source_version_id: "rev2", decided_by: null, decided_by_name: null, decided_at: null,
      evidence: { docName: "PFD-1", confidence: 0.9, previousRevision: "rev1" },
    })]);
  });

  it("a hand-drawn confirmed row is 'already on the map'; a pending one is 'awaiting review' — neither is called a dismissal", async () => {
    st.rows.process_flows = [existing({ status: "confirmed", origin: "manual", source_document_id: null, source_version_id: null })];
    let json = await (await post({})).json();
    expect(json).toMatchObject({ proposed: 0, skippedConfirmed: 1, skippedDismissed: 0 });
    st.rows.process_flows = [existing({ status: "proposed" })];
    json = await (await post({})).json();
    expect(json).toMatchObject({ proposed: 0, skippedPending: 1, skippedDismissed: 0 });
  });

  it("the prior flows are read whole in pages (no 4,000-row slice): a dismissal on row 4,500 still holds", async () => {
    st.rows.process_flows = [
      ...Array.from({ length: 4500 }, (_, i) => ({ id: `f${String(i).padStart(5, "0")}`, org_id: "o1", from_kind: "unit", from_ref: "20", to_kind: "asset", to_ref: `x${i}`, status: "confirmed", origin: "manual" })),
      existing({ id: "zz-last" }),
    ];
    const json = await (await post({})).json();
    expect(json.skippedDismissed).toBe(1);
    expect(json.proposed).toBe(0);
  });

  it("before 20261155 (no source_version_id): the read still works, writes without the column, and every dismissal sticks", async () => {
    st.noVersionColumn = true;
    const json = await (await post({})).json();
    expect(json.proposed).toBe(1);
    expect(flowsOf()[0]).not.toHaveProperty("source_version_id");
  });
});

describe("FLOW-12 — one colliding pair never costs the read", () => {
  beforeEach(() => {
    st.aiText = JSON.stringify({ flows: [
      { from: "A2", to: "A1", page: 1, confidence: 0.9 }, { from: "A1", to: "A3", page: 1, confidence: 0.9 }, { from: "A3", to: "A4", page: 1, confidence: 0.9 },
    ] });
  });

  it("a pair written by someone else while the read ran is skipped and counted; the rest land", async () => {
    st.upsertDropPairs = ["asset:a2>asset:a3"];
    const json = await (await post({})).json();
    expect(json.proposed).toBe(2);
    expect(json.skippedDuplicate).toBe(1);
    expect(json.skippedPairs).toEqual([{ from: "E-201", to: "P-310", reason: "duplicate", why: "written by someone else while this read ran" }]);
    const up = st.calls.find((c) => c.table === "process_flows" && c.method === "upsert");
    expect(up?.args[1]).toEqual({ onConflict: "org_id,from_kind,from_ref,to_kind,to_ref", ignoreDuplicates: true });
  });

  it("a batch the database refuses (an endpoint deleted meanwhile) is written row by row: the good rows land, the bad one is counted", async () => {
    st.upsertError = { code: "23503", message: "process_flows_endpoint: equipment a4 is not in this workspace's registry" };
    st.insertError = (r) => (r.to_ref === "a4" ? { code: "23503", message: "process_flows_endpoint: equipment a4 is not in this workspace's registry" } : null);
    const res = await post({});
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.proposed).toBe(2);
    expect(json.writeFailed).toBe(1);
    expect(json.note).toContain("1 proposal could not be written.");
  });

  it("when nothing could be written the failure is said WITH the charge (500), never a silent zero", async () => {
    st.upsertError = { code: "XX000", message: "boom" };
    st.insertError = () => ({ code: "XX000", message: "boom" });
    const res = await post({});
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/^The drawing was read \(the call was charged to your key\), but writing the proposals failed: boom/);
  });
});

describe("PR-8 / PR-7 — the reply", () => {
  it("balanced but invalid JSON is a readable 502 that says the call was charged; nothing is written", async () => {
    st.aiText = "Here you go: {flows: [{from: A1, to: A2}]}";
    const res = await post({});
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.malformedReply).toBe(true);
    expect(json.error).toMatch(/replied in a form that couldn't be understood, so nothing was written\. The call was charged to your key/);
    expect(flowsOf()).toHaveLength(0);
  });

  it("a reply cut off at the token limit (no JSON) is the same 502, not 'no flows found'", async () => {
    st.aiText = '{"flows":[{"from":"A1","to":"A2"';
    expect((await post({})).status).toBe(502);
  });

  it("a missing confidence is stored as unknown (null), never 0.5, and low ones are counted", async () => {
    st.aiText = JSON.stringify({ flows: [{ from: "A2", to: "A1" }, { from: "A1", to: "A3", confidence: 0.2 }] });
    const json = await (await post({})).json();
    expect(json.lowConfidence).toBe(2);
    expect(flowsOf().map((f) => (f.evidence as Row).confidence)).toEqual([null, 0.2]);
    expect(flowsOf().every((f) => f.status === "proposed")).toBe(true);
  });
});

describe("FLOW-11 / FLOW-13 — the pages, and the width they are read at", () => {
  it("a 40-page book read by default: pages 1–6 of 40 on the zero branch, truncated, and rendered at 1800 px", async () => {
    st.numPages = 40;
    st.rows.knowledge_documents[0].page_count = 40;
    st.aiText = '{"flows":[]}';
    const json = await (await post({})).json();
    expect(json).toMatchObject({ proposed: 0, pagesRead: [1, 2, 3, 4, 5, 6], pagesTotal: 40, truncated: true, renderWidth: 1800 });
    expect(json.note).toMatch(/^Read pages 1–6 of 40\. Only the first pages are read by default/);
    expect(st.renderArgs[0].opts).toMatchObject({ width: 1800, maxPages: 6 });
    expect(typeof st.renderArgs[0].opts.deadlineAt).toBe("number");
  });

  it("a page that failed to render and one past the end are reported, not absorbed", async () => {
    st.failPages = [3];
    const json = await (await post({ pages: [2, 3, 9] })).json();
    expect(json.pagesRead).toEqual([2]);
    expect(json.pagesFailed).toEqual([3]);
    expect(json.pagesNotRead).toEqual([9]);
    expect(json.note).toContain("Page 3 could not be rendered.");
  });
});

describe("FLOW-1 / AREA-8 — outside the unit, and the read record", () => {
  it("a read launched from Crude (20) says how many of its proposals touch nothing in Crude", async () => {
    st.aiText = JSON.stringify({ flows: [{ from: "A2", to: "A1", confidence: 0.9 }, { from: "A3", to: "A4", confidence: 0.9 }] });
    const json = await (await post({ unitCode: "20" })).json();
    expect(json.proposed).toBe(2);
    expect(json.outsideUnit).toBe(1);
  });

  it("every read writes a FLOWS_READ record for the area checklist — flows found or not", async () => {
    st.aiText = '{"flows":[]}';
    await post({ unitCode: "20" });
    expect(st.rows.audit_logs).toEqual([expect.objectContaining({
      action: "FLOWS_READ", resource_type: "knowledge_document", resource_id: "kd1", org_id: "o1", user_id: "admin1",
      details: expect.objectContaining({ pagesRead: [1, 2, 3, 4, 5, 6], proposed: 0, unitCode: "20" }),
    })]);
  });
});
