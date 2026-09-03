// Phase 6 severity sweep, Round C1 — SURF-7 / EGRESS-3 (the AI orchestrator
// acts with the CALLER's authority: every document-touching tool filters
// through the caller's ACL principal, controller acts need the controller
// tier by the role collection, and notifications carry the real caller's
// name) and ADD-3 (rank is not relevance: approval routing reads the
// collection, `primaryRole` is display / mirror only).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const state = vi.hoisted(() => ({
  single: {} as Record<string, Record<string, unknown> | null>,
  lists: {} as Record<string, Array<Record<string, unknown>>>,
  readable: new Set<string>(),
  upserts: [] as Array<{ table: string; row: Record<string, unknown>; opts: unknown }>,
  askedFor: [] as string[][],
  emitted: [] as Array<Record<string, unknown>>,
  rpc: [] as Array<Record<string, unknown>>,
}));

function chain(table: string) {
  const c: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => resolve({ data: state.lists[table] ?? [], error: null });
      }
      return (...args: unknown[]) => {
        if (prop === "maybeSingle") return Promise.resolve({ data: state.single[table] ?? null, error: null });
        if (prop === "upsert") {
          state.upserts.push({ table, row: args[0] as Record<string, unknown>, opts: args[1] });
          return Promise.resolve({ data: null, error: null });
        }
        return new Proxy(c, handler);
      };
    },
  };
  return new Proxy(c, handler);
}

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    from: (t: string) => chain(t),
    rpc: async () => ({ data: state.rpc, error: null }),
  },
}));
vi.mock("@/lib/knowledgeAccess", () => ({
  readableControlledDocIds: vi.fn(async (_p: unknown, ids: string[]) => {
    state.askedFor.push(ids);
    return new Set(ids.filter((id) => state.readable.has(id)));
  }),
}));
vi.mock("@/lib/notify/dispatch", () => ({
  emit: vi.fn(async (ev: Record<string, unknown>) => { state.emitted.push(ev); }),
}));

import { toolByName, fingerprint, type ToolContext } from "@/lib/orchestrator/tools";
import { runOrchestrator, type ModelCall } from "@/lib/orchestrator/loop";
import type { KnowledgePrincipal } from "@/lib/knowledgeAccess";
import { relevantRequesterRole, primaryRole } from "@/lib/roleCapabilities";
import { requiresEngineerApproval } from "@/lib/workflow";
import { normalizeTag } from "@/lib/pidTrace";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

function ctxFor(roles: string[], approved: string[] = []): ToolContext {
  const principal = {
    uid: "u1", orgId: "o1", role: roles[0] ?? "Viewer", roles, teamIds: [],
    isController: roles.includes("Admin") || roles.includes("DocCtrl"),
  } as unknown as KnowledgePrincipal;
  return { orgId: "o1", userId: "u1", role: roles[0] ?? "Viewer", principal, actorName: "Pat Example", approved: new Set(approved) };
}
const run = (name: string, args: Record<string, string | number | boolean>, ctx: ToolContext) => toolByName(name)!.run(args, ctx);

beforeEach(() => {
  state.single = {}; state.lists = {}; state.readable = new Set();
  state.upserts = []; state.askedFor = []; state.emitted = []; state.rpc = [];
});

/** Two knowledge mirrors (k1 → d1 denied, k3 → d2 readable) and one
 *  upload-origin knowledge document (k2, no source, org-readable). */
function seedMirrors() {
  state.lists.knowledge_documents = [
    { id: "k1", source_document_id: "d1" },
    { id: "k3", source_document_id: "d2" },
  ];
  state.readable.add("d2");
}

describe("SURF-7 / EGRESS-3 — check_permissions evaluates the caller's real ACL", () => {
  it("a document the caller cannot read is 'not visible' even though the service-role fetch found it", async () => {
    state.single.documents = { id: "d1", document_number: "P-1", status: "Issued", org_id: "o1" };
    const out = await run("check_permissions", { document_id: "d1" }, ctxFor(["Viewer"]));
    expect(out.data).toMatchObject({ readable: false, editable: false });
    expect(state.askedFor).toEqual([["d1"]]);
  });
  it("readable but not controller → editable false; controller BY COLLECTION (Requester + DocCtrl) → editable true; a hold blocks editing", async () => {
    state.single.documents = { id: "d1", document_number: "P-1", status: "Issued", org_id: "o1" };
    state.readable.add("d1");
    expect((await run("check_permissions", { document_id: "d1" }, ctxFor(["Drafter"]))).data).toMatchObject({ readable: true, editable: false });
    expect((await run("check_permissions", { document_id: "d1" }, ctxFor(["Requester", "DocCtrl"]))).data).toMatchObject({ readable: true, editable: true, on_hold: false });
    state.lists.document_holds = [{ id: "h1", reason: "legal" }];
    expect((await run("check_permissions", { document_id: "d1" }, ctxFor(["Requester", "DocCtrl"]))).data).toMatchObject({ readable: true, editable: false, on_hold: true, holds: ["legal"] });
  });
});

describe("SURF-7 / EGRESS-3 — reads and acts are filtered through the caller", () => {
  it("find_documents returns only the readable subset of what the service-role query fetched", async () => {
    state.lists.documents = [
      { id: "d1", document_number: "P-1", title: "A", rev: "A", status: "Issued", library_id: "L" },
      { id: "d2", document_number: "P-2", title: "B", rev: "A", status: "Issued", library_id: "L" },
      { id: "d3", document_number: "P-3", title: "C", rev: "A", status: "Issued", library_id: "L" },
    ];
    state.readable.add("d2");
    const out = await run("find_documents", { query: "P" }, ctxFor(["Viewer"]));
    expect((out.data as { matches: Array<{ document_id: string }> }).matches.map((m) => m.document_id)).toEqual(["d2"]);
    expect(state.askedFor).toEqual([["d1", "d2", "d3"]]);
  });
  it("search_documents: a passage from a mirror of a denied document is dropped; upload-origin and readable-mirror passages stay", async () => {
    seedMirrors();
    state.rpc = [
      { knowledge_document_id: "k1", document_name: "HAZOP-7", page: 3, snippet: "relief <b>valve</b> sizing" },
      { knowledge_document_id: "k2", document_name: "Uploaded note", page: 1, snippet: "site note" },
      { knowledge_document_id: "k3", document_name: "STD-14", page: 7, snippet: "pipe supports" },
    ];
    const out = await run("search_documents", { query: "relief" }, ctxFor(["Viewer"]));
    const passages = (out.data as { passages: Array<{ document: string; text: string }> }).passages;
    expect(passages.map((p) => p.document)).toEqual(["Uploaded note", "STD-14"]);
    expect(JSON.stringify(out.data)).not.toContain("HAZOP-7");
    expect(state.askedFor).toEqual([["d1", "d2"]]);
  });
  it("equipment_mentions: the proving sentence is content — mentions from unreadable documents (mirror or direct) are dropped", async () => {
    seedMirrors();
    state.lists.assets = [{ id: "a1", tag: "E-101" }];
    state.lists.entity_mentions = [
      { page: 2, context_snippet: "E-101 relief case", mention_count: 9, knowledge_document_id: "k1", document_id: "d1", knowledge_documents: { name: "HAZOP-7" } },
      { page: 1, context_snippet: "E-101 in the note", mention_count: 4, knowledge_document_id: "k2", document_id: null, knowledge_documents: { name: "Uploaded note" } },
      { page: 5, context_snippet: "E-101 support", mention_count: 2, knowledge_document_id: "k3", document_id: "d2", knowledge_documents: { name: "STD-14" } },
      { page: 1, context_snippet: "E-101 direct-only", mention_count: 1, knowledge_document_id: null, document_id: "d9", knowledge_documents: null },
    ];
    const out = await run("equipment_mentions", { tag: "E-101" }, ctxFor(["Viewer"]));
    const mentions = (out.data as { mentions: Array<{ document: string; evidence: string }> }).mentions;
    expect(mentions.map((m) => m.document)).toEqual(["Uploaded note", "STD-14"]);
    expect(JSON.stringify(out.data)).not.toContain("relief case");
    expect(JSON.stringify(out.data)).not.toContain("direct-only");
  });
  it("the whole loop, driven as a denied Viewer: no passage from the denied document reaches the tool result or the next prompt", async () => {
    seedMirrors();
    state.rpc = [
      { knowledge_document_id: "k1", document_name: "HAZOP-7", page: 3, snippet: "the denied sentence" },
      { knowledge_document_id: "k3", document_name: "STD-14", page: 7, snippet: "the readable sentence" },
    ];
    const prompts: string[] = [];
    let turn = 0;
    const model = (async (_system: string, user: string) => {
      prompts.push(user);
      const lines = [JSON.stringify({ tool_name: "search_documents", parameters: { query: "E-101" } }), "STD-14 page 7 covers it."];
      const text = lines[Math.min(turn, lines.length - 1)]; turn += 1;
      return { text, usage: { inputTokens: 1, outputTokens: 1 } };
    }) as ModelCall;
    const out = await runOrchestrator({ question: "what do we have on E-101?", ctx: ctxFor(["Viewer"]), call: model });
    expect(out.steps).toHaveLength(1);
    expect(JSON.stringify(out.steps[0])).not.toContain("the denied sentence");
    expect(JSON.stringify(out.steps[0])).toContain("the readable sentence");
    expect(prompts.join("\n")).not.toContain("the denied sentence");
    expect(prompts.join("\n")).not.toContain("HAZOP-7");
  });
  it("trace_pid_lines: a sheet the caller cannot read is neither walked nor named; a controller sees the same-sheet hit", async () => {
    seedMirrors();
    state.lists.knowledge_page_entities = [
      { document_id: "k1", page: 1, kind: "equipment", tag: normalizeTag("E-101") },
      { document_id: "k1", page: 1, kind: "equipment", tag: normalizeTag("P-201") },
    ];
    const denied = await run("trace_pid_lines", { start_tag: "E-101", end_tag: "P-201" }, ctxFor(["Viewer"]));
    expect((denied.data as { found: boolean }).found).toBe(false);
    expect(denied.data).not.toHaveProperty("same_sheet");
    state.readable.add("d1");
    const allowed = await run("trace_pid_lines", { start_tag: "E-101", end_tag: "P-201" }, ctxFor(["DocCtrl"]));
    expect((allowed.data as { found: boolean }).found).toBe(true);
    expect((allowed.data as { same_sheet?: Array<{ page: number }> }).same_sheet).toEqual([{ sheet: "Sheet", page: 1 }]);
  });
  it("checkout_document: an unreadable document 'does not exist'; a readable one still needs the controller tier by collection", async () => {
    state.single.documents = { id: "d1", document_number: "P-1", title: "A", library_id: "L", checked_out_by: null, checked_out_by_name: null };
    expect((await run("checkout_document", { document_id: "d1" }, ctxFor(["Drafter"]))).data).toMatchObject({ error: "No such document in this org." });
    state.readable.add("d1");
    expect((await run("checkout_document", { document_id: "d1" }, ctxFor(["Drafter"]))).data).toMatchObject({ error: "This user's role can't check documents out." });
    const asManager = await run("checkout_document", { document_id: "d1" }, ctxFor(["Drafter", "Manager"]));
    expect((asManager.data as { status?: string }).status).toBe("awaiting_confirmation");
  });
  it("notify_personnel: unreadable → 'no such document'; readable + approved → the message is sent in the CALLER's name", async () => {
    state.single.documents = { id: "d1", document_number: "P-1", library_id: "L" };
    state.single.org_members = { uid: "u2" };
    const params = { user_id: "u2", document_id: "d1", message: "hi" };
    const fp = fingerprint("notify_personnel", params);
    expect((await run("notify_personnel", params, ctxFor(["Viewer"], [fp]))).data).toMatchObject({ error: "No such document in this org." });
    expect(state.emitted).toHaveLength(0);
    state.readable.add("d1");
    expect((await run("notify_personnel", params, ctxFor(["Viewer"], [fp]))).data).toMatchObject({ status: "sent" });
    expect(state.emitted).toHaveLength(1);
    expect(state.emitted[0]).toMatchObject({ actorUserId: "u1", actorName: "Pat Example", orgId: "o1" });
    expect(state.emitted[0].actorName).not.toBe("Document controller");
  });
  it("log_audit_completion: a Viewer's confirmation cannot mint an audit row; a controller by collection can", async () => {
    const params = { sheet_number: "P-2030-001", revision: "C", status: "passed" };
    const fp = fingerprint("log_audit_completion", params);
    const denied = await run("log_audit_completion", params, ctxFor(["Viewer"], [fp]));
    expect(String((denied.data as { error?: string }).error)).toMatch(/^Only Admin, Document Control, Manager or Supervisor/);
    expect(state.upserts).toHaveLength(0);
    const ok = await run("log_audit_completion", params, ctxFor(["Requester", "Supervisor"], [fp]));
    expect(ok.data).toMatchObject({ status: "logged" });
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0]).toMatchObject({ table: "drawing_audit_logs", row: { org_id: "o1", sheet_number: "P-2030-001", revision_code: "C", status: "passed" } });
  });
});

describe("SURF-7 / EGRESS-3 — pinned at the source", () => {
  const tools = src("lib/orchestrator/tools.ts");
  const chat = src("app/api/orchestrator/route.ts");
  const exec = src("app/api/orchestrator/execute/route.ts");
  it("no tool reads the headline role for authority, and no notification is attributed to a fictional controller", () => {
    expect(tools).not.toMatch(/CONTROLLER_ROLES\.includes\(ctx\.role\)/);
    expect(tools).not.toContain('"Document controller"');
    expect(tools).toContain("actorName: ctx.actorName");
    expect(tools).toMatch(/function holdsControllerTier\(ctx: ToolContext\): boolean \{\s*\n\s*return ctx\.principal\.roles\.some/);
  });
  it("every document-touching tool asks readableIds; the mirror hop in search_documents fails closed", () => {
    const uses = tools.match(/readableIds\(ctx, /g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(5);
    for (const name of ["const findDocuments", "const searchDocuments", "const checkPermissions", "const checkoutDocument", "const notifyPersonnel", "const equipmentMentions"]) {
      const a = tools.indexOf(name); const b = tools.indexOf("\nconst ", a + 10);
      expect(tools.slice(a, b < 0 ? undefined : b), name).toMatch(/(?:readableIds|unreadableMirrors)\(ctx,/);
    }
    expect(between(tools, "async function readableIds", "\n}")).toMatch(/catch \{ return new Set\(\); \}/);
    // The mirror hop fails closed: an evaluation failure treats every id as unreadable.
    expect(between(tools, "async function unreadableMirrors", "\n}")).toMatch(/catch \{ return new Set\(ids\); \}/);
    // equipment_mentions and both P&ID trace reads go through the same hop.
    expect(between(tools, "const equipmentMentions", "\nconst ")).toContain("unreadableMirrors(ctx,");
    expect(between(tools, "const tracePidLines", "\nconst ")).toContain("unreadableMirrors(ctx,");
    expect(between(tools, "async function loadLineGraph(ctx: ToolContext)", "\n}")).toMatch(/if \(hidden\.has\(row\.document_id\)\) continue;/);
    expect(tools).not.toMatch(/loadLineGraph\(ctx\.orgId\)/);
  });
  it("check_permissions' comment now describes the mechanism that runs", () => {
    const body = between(tools, "const checkPermissions", "\nconst ");
    expect(body).toContain("RLS is NOT the gate");
    expect(body).not.toContain("RLS is the real gate");
  });
  it("both routes load the ACL principal, derive the role from it, and pass the caller's name; chips are filtered by readability", () => {
    for (const r of [chat, exec]) {
      expect(r).toContain("loadPrincipal(orgId, user.id)");
      expect(r).toContain("const role = principal.role;");
      expect(r).not.toContain('(member.role as string) ?? "Viewer"');
      expect(r).toMatch(/principal, actorName/);
    }
    expect(chat).toContain("readableControlledDocIds(principal, [...new Set([...ctrlIds, ...mirrorSrc.values()])])");
    expect(chat).toContain("catch { mentionedDocs = []; }");
  });
});

describe("ADD-3 — rank is not relevance", () => {
  it("relevantRequesterRole: an engineer tier held anywhere wins; then management / DocCtrl; then the headline", () => {
    expect(relevantRequesterRole(["Manager", "Engineer-2"])).toBe("Engineer-2");
    expect(relevantRequesterRole(["Requester", "Engineer-1", "Engineer-3"])).toBe("Engineer-3");
    expect(relevantRequesterRole(["Requester", "DocCtrl"])).toBe("DocCtrl");
    expect(relevantRequesterRole(["Drafter", "DraftingSupervisor"])).toBe("DraftingSupervisor");
    expect(relevantRequesterRole(["Requester", "Safety"], "Requester")).toBe("Requester");
    expect(relevantRequesterRole(["Safety", "Requester"])).toBe("Requester");
    expect(relevantRequesterRole([])).toBe("Viewer");
    expect(primaryRole(["Manager", "Engineer-2"])).toBe("Manager");
  });
  it("requiresEngineerApproval: the collection waives the engineer route when any held role approves directly", () => {
    expect(requiresEngineerApproval("Requester")).toBe(true);
    expect(requiresEngineerApproval("Requester", ["Requester"])).toBe(true);
    expect(requiresEngineerApproval("Requester", [])).toBe(true);
    expect(requiresEngineerApproval("Requester", ["Requester", "Engineer-2"])).toBe(false);
    expect(requiresEngineerApproval("Requester", ["Requester", "DocCtrl"])).toBe(false);
    expect(requiresEngineerApproval("Drafter", ["Drafter", "Manager"])).toBe(false);
    expect(requiresEngineerApproval("Drafter", ["Drafter"])).toBe(true);
    expect(requiresEngineerApproval("Engineer-1")).toBe(false);
  });
  it("pinned at the source: primaryRole is labelled display/mirror only; the request pages read the collection", () => {
    const rc = src("lib/roleCapabilities.ts");
    const doc = between(rc, "/** Highest-ranked role in the collection", "export function primaryRole");
    expect(doc).toMatch(/NEVER an authority or\s+\*\s+applicability test/);
    expect(doc).toContain("rank is not relevance");
    expect(src("app/(protected)/requests/new/page.tsx")).toContain("requester_role: relevantRequesterRole(roles, activeRole)");
    expect(src("app/(protected)/requests/[id]/page.tsx")).toContain("canSign={hasAnyRole(['Admin', 'DocCtrl']) || roles.some((r) => r.startsWith('Engineer'))}");
    expect(src("app/(protected)/requests/page.tsx")).toContain("{hasAnyRole(['Manager', 'Admin']) && (");
  });
});

describe("20261048 — drawing_audit_logs gets the write policy that matches the app gate", () => {
  const m48 = src("supabase/migrations/20261048_rp_phase6_sweep_audit_log_write_policy.sql");
  it("INSERT and UPDATE for the controller tier by collection, org-scoped, no DELETE, SELECT untouched", () => {
    const ins = between(m48, "CREATE POLICY drawing_audit_logs_controller_insert", ";");
    const upd = between(m48, "CREATE POLICY drawing_audit_logs_controller_update", ";");
    expect(ins).toMatch(/FOR INSERT TO authenticated/);
    expect(ins).toMatch(/WITH CHECK \(caller_holds_any_role\(org_id, ARRAY\['Admin','DocCtrl','Manager','Supervisor'\]::text\[\]\)\)/);
    expect(upd).toMatch(/FOR UPDATE TO authenticated/);
    expect(upd).toMatch(/USING \(caller_holds_any_role\(org_id, ARRAY\['Admin','DocCtrl','Manager','Supervisor'\]::text\[\]\)\)\s*\n\s*WITH CHECK \(caller_holds_any_role\(org_id, ARRAY\['Admin','DocCtrl','Manager','Supervisor'\]::text\[\]\)\)/);
    expect(m48).not.toMatch(/FOR DELETE/);
    expect(m48).not.toMatch(/DROP POLICY IF EXISTS drawing_audit_logs_read/);
  });
  it("probe hygiene: no bare cast in policy probes; COMMIT before verification; inventory before DDL", () => {
    const v = m48.slice(m48.indexOf("── Verification"));
    for (const x of v.matchAll(/(?:qual|with_check) LIKE '((?:[^']|'')*)'/g)) {
      expect(x[1], x[1]).not.toMatch(/\w::\w/);
      expect(x[1], x[1]).not.toMatch(/\]::\w+\[\]/);
    }
    expect(m48.indexOf("COMMIT;")).toBeLessThan(m48.indexOf("── Verification"));
    expect(m48).toMatch(/── Inventory \(read-only, aggregate\) — run BEFORE the DDL/);
  });
});

function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from); if (a < 0) throw new Error(`anchor not found: ${from}`);
  const b = text.indexOf(to, a + from.length); if (b < 0) throw new Error(`end not found after ${from}: ${to}`);
  return text.slice(a, b);
}
