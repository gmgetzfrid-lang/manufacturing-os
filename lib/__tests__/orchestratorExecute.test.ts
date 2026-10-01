// intelligence Round G, package I-04 — the assistant's write path, end to end.
//
// ORCH-4 / PR-1 (criterion 2): a run stores every write it proposes
// server-side (orchestrator_proposals, 20261147) and /api/orchestrator/execute
// runs only a STORED proposal, by id — for the person it was proposed to, in
// that org, within 15 minutes, once. The regression this file pins first:
// the legitimate flow keeps working (propose → confirm → execute once), and a
// stale assistant tab gets a clear 409, not a silent failure.
//
// Driven through both real routes, the real tools and the real ACL seam
// (lib/knowledgeAccess) over the in-memory PostgREST stand-in
// (./knowledgeFakeDb). The provider is a scripted model; the meter, key vault
// and prompt blocks are stubs (no network, no key).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { db, resetDb, rowsOf, type Row } from "./knowledgeFakeDb";
import { AGREEMENT_VERSION } from "@/lib/ai/pricing";

const net = vi.hoisted(() => ({
  script: [] as string[],
  prompts: [] as string[],
  users: { dc: "u-dc", viewer: "u-viewer", other: "u-other" } as Record<string, string>,
  emitted: [] as Array<Record<string, unknown>>,
  rpc: {} as Record<string, (args: Record<string, unknown>) => { data: unknown; error: unknown }>,
}));

vi.mock("@/lib/supabaseAdmin", async () => {
  const { fakeAdmin } = await import("./knowledgeFakeDb");
  return {
    supabaseAdmin: {
      from: fakeAdmin.from,
      rpc: async (fn: string, args: Record<string, unknown>) => (net.rpc[fn]
        ? net.rpc[fn](args)
        : { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}` } }),
      auth: {
        getUser: async (token: string) => (net.users[token]
          ? { data: { user: { id: net.users[token] } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } }),
      },
    },
  };
});
vi.mock("@/lib/ai/providerCall", () => ({
  callAiModel: vi.fn(async (input: { user: string }) => {
    net.prompts.push(input.user);
    const text = net.script[Math.min(net.prompts.length - 1, net.script.length - 1)] ?? "Done.";
    return { text, usage: { inputTokens: 1, outputTokens: 1 } };
  }),
  AiCallError: class AiCallError extends Error { status = 502; },
}));
vi.mock("@/lib/ai/usageServer", () => ({
  getMonthUsage: vi.fn(async () => ({ spentUsd: 0, inputTokens: 0, outputTokens: 0, asks: 0 })),
  getCapUsd: vi.fn(async () => 0),
  recordAskUsage: vi.fn(async () => undefined),
}));
vi.mock("@/lib/ai/keyVault", () => ({ openAiKey: (k: string) => k }));
vi.mock("@/lib/aiInstructionsServer", () => ({ loadOrgInstructionsBlock: vi.fn(async () => "") }));
vi.mock("@/lib/answerSkillsServer", () => ({ loadAnswerSkillsBlock: vi.fn(async () => "") }));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async (ev: Record<string, unknown>) => { net.emitted.push(ev); }) }));
// lib/ownership (pulled in by lib/knowledgeAccess) imports these at load.
vi.mock("@/lib/supabase", () => ({ supabase: {} }));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => {}) }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => {}), logRevisionEvent: vi.fn(async () => {}), logHoldEvent: vi.fn(async () => {}) }));

import { POST as runPOST } from "@/app/api/orchestrator/route";
import { POST as executePOST } from "@/app/api/orchestrator/execute/route";
import { REFUSAL, NOT_INSTALLED, PROPOSAL_TTL_MS } from "@/lib/orchestrator/proposals";

const ORG = "o1";
const AUDIT_CALL = JSON.stringify({
  tool_name: "log_audit_completion",
  parameters: { sheet_number: "025-PID-0103", revision: "C", status: "broken_connectors" },
});

function seed(extra: Record<string, Row[]> = {}): void {
  resetDb({
    org_members: [
      { org_id: ORG, uid: "u-dc", role: "Requester", roles: ["Requester", "DocCtrl"], status: "active", display_name: "Dana Control", email: "dana@example.com" },
      { org_id: ORG, uid: "u-viewer", role: "Viewer", roles: ["Viewer"], status: "active", display_name: "Vic Viewer", email: "vic@example.com" },
      { org_id: ORG, uid: "u-other", role: "Requester", roles: ["Requester", "DocCtrl"], status: "active", display_name: "Olly Other", email: "olly@example.com" },
    ],
    team_members: [], teams: [], collections: [],
    libraries: [{ id: "L-ops", org_id: ORG, name: "Operations", acl: null, visibility: "normal", owner_user_id: null, owner_team_id: null }],
    documents: [
      { id: "d-1", org_id: ORG, library_id: "L-ops", collection_id: null, document_number: "025-PID-0103", title: "P&ID 0103", acl: null, visibility: "normal", is_private: false, scope: null, created_by: "u-dc", owner_user_id: null, status: "Issued", ai_excluded: false },
    ],
    ai_connections: [
      { org_id: ORG, user_id: "u-dc", provider: "anthropic", model: "test-model", api_key: "sealed" },
      { org_id: ORG, user_id: "u-viewer", provider: "anthropic", model: "test-model", api_key: "sealed" },
    ],
    ai_key_agreements: [
      { id: "ag1", org_id: ORG, user_id: "u-dc", scope: "use", agreement_version: AGREEMENT_VERSION },
      { id: "ag2", org_id: ORG, user_id: "u-viewer", scope: "use", agreement_version: AGREEMENT_VERSION },
    ],
    knowledge_documents: [],
    drawing_audit_logs: [],
    audit_logs: [],
    orchestrator_proposals: [],
    ...extra,
  });
}

const req = (url: string, token: string, body: unknown) => new NextRequest(url, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});
async function ask(token: string, question: string) {
  const res = await runPOST(req("http://test/api/orchestrator", token, { orgId: ORG, question }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
async function execute(token: string, body: Record<string, unknown>) {
  const res = await executePOST(req("http://test/api/orchestrator/execute", token, { orgId: ORG, ...body }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
type Pending = { fingerprint: string; tool: string; proposalId?: string; expiresAt?: string; unavailable?: string; parameters: Record<string, unknown>; href?: string };
const pendingOf = (b: Record<string, unknown>) => (b.pending ?? []) as Pending[];
const auditRows = (action: string) => rowsOf("audit_logs").filter((r) => r.action === action);

/** One proposed audit record, as the assistant tab holds it. */
async function proposeAudit(token = "dc"): Promise<Pending> {
  net.script = [AUDIT_CALL, "I've asked you to confirm the audit record."];
  net.prompts = [];
  const { status, body } = await ask(token, "record 0103 rev C as broken");
  expect(status).toBe(200);
  const pending = pendingOf(body);
  expect(pending).toHaveLength(1);
  return pending[0];
}

beforeEach(() => {
  seed();
  net.script = []; net.prompts = []; net.emitted = []; net.rpc = {};
});

describe("ORCH-4 — the legitimate flow keeps working: propose → confirm → execute ONCE", () => {
  it("a run stores its proposal server-side and the card carries the id; confirming runs the stored action once", async () => {
    const card = await proposeAudit();
    expect(card.proposalId).toEqual(expect.any(String));
    expect(card.unavailable).toBeUndefined();
    expect(Date.parse(card.expiresAt!) - Date.now()).toBeGreaterThan(PROPOSAL_TTL_MS - 60_000);
    const stored = rowsOf("orchestrator_proposals");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ org_id: ORG, user_id: "u-dc", tool: "log_audit_completion", fingerprint: card.fingerprint });
    expect(stored[0].executed_at ?? null).toBeNull();
    // Proposing wrote nothing.
    expect(rowsOf("drawing_audit_logs")).toHaveLength(0);

    const first = await execute("dc", { proposalId: card.proposalId, fingerprint: card.fingerprint });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, result: { status: "logged" } });
    expect(rowsOf("drawing_audit_logs")).toHaveLength(1);
    expect(rowsOf("drawing_audit_logs")[0]).toMatchObject({ org_id: ORG, sheet_number: "025-PID-0103", revision_code: "C", status: "broken_connectors" });
    expect(rowsOf("orchestrator_proposals")[0].executed_at).toEqual(expect.any(String));
    expect(auditRows("AI_ACTION_EXECUTED")).toHaveLength(1);
    expect(auditRows("AI_ACTION_EXECUTED")[0]).toMatchObject({ org_id: ORG, user_id: "u-dc", details: expect.objectContaining({ tool: "log_audit_completion", proposalId: card.proposalId }) });

    // Once.
    const again = await execute("dc", { proposalId: card.proposalId, fingerprint: card.fingerprint });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe(REFUSAL.executed);
    expect(rowsOf("drawing_audit_logs")).toHaveLength(1);
    expect(auditRows("AI_ACTION_EXECUTED")).toHaveLength(1);
  });

  it("two confirmations racing each other: exactly one runs", async () => {
    const card = await proposeAudit();
    const [a, b] = await Promise.all([
      execute("dc", { proposalId: card.proposalId }),
      execute("dc", { proposalId: card.proposalId }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(auditRows("AI_ACTION_EXECUTED")).toHaveLength(1);
  });
});

describe("ORCH-4 — /execute refuses everything that is not a live stored proposal of this caller (409, nothing runs)", () => {
  it("a stale assistant tab posting the tool and its parameters gets a clear 409 telling it to reload", async () => {
    const res = await execute("dc", {
      tool: "log_audit_completion",
      parameters: { sheet_number: "025-PID-0103", revision: "C", status: "passed" },
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(REFUSAL.legacy);
    expect(String(res.body.error)).toMatch(/Reload the page/);
    expect(rowsOf("drawing_audit_logs")).toHaveLength(0);
    expect(auditRows("AI_ACTION_EXECUTED")).toHaveLength(0);
  });

  it("a card holding a fingerprint that is not the stored one is refused", async () => {
    const card = await proposeAudit();
    const res = await execute("dc", { proposalId: card.proposalId, fingerprint: "log_audit_completion(revision=C&sheet_number=025-PID-0103&status=passed)" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(REFUSAL.unknown);
    expect(rowsOf("drawing_audit_logs")).toHaveLength(0);
  });

  it("an unknown id, and another member's proposal, read the same: 409 'doesn't match'", async () => {
    const card = await proposeAudit();
    const unknown = await execute("dc", { proposalId: "00000000-0000-0000-0000-000000000000" });
    expect(unknown.status).toBe(409);
    expect(unknown.body.error).toBe(REFUSAL.unknown);
    const someoneElse = await execute("other", { proposalId: card.proposalId });
    expect(someoneElse.status).toBe(409);
    expect(someoneElse.body.error).toBe(REFUSAL.unknown);
    expect(rowsOf("drawing_audit_logs")).toHaveLength(0);
    expect(rowsOf("orchestrator_proposals")[0].executed_at ?? null).toBeNull();
  });

  it("an expired proposal is refused with 'expired — ask again'", async () => {
    const card = await proposeAudit();
    rowsOf("orchestrator_proposals")[0].expires_at = new Date(Date.now() - 1000).toISOString();
    const res = await execute("dc", { proposalId: card.proposalId });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(REFUSAL.expired);
    expect(rowsOf("drawing_audit_logs")).toHaveLength(0);
  });

  it("a dismissed proposal can never be run; dismissing twice says it is already gone", async () => {
    const card = await proposeAudit();
    const dismissed = await execute("dc", { proposalId: card.proposalId, decision: "dismiss" });
    expect(dismissed).toMatchObject({ status: 200, body: { ok: true, dismissed: true } });
    expect(rowsOf("orchestrator_proposals")[0].dismissed_at).toEqual(expect.any(String));
    const run = await execute("dc", { proposalId: card.proposalId });
    expect(run.status).toBe(409);
    expect(run.body.error).toBe(REFUSAL.dismissed);
    expect((await execute("dc", { proposalId: card.proposalId, decision: "dismiss" })).status).toBe(409);
    expect(rowsOf("drawing_audit_logs")).toHaveLength(0);
  });

  it("a stranger and a non-member are refused before any proposal is read", async () => {
    expect((await execute("nobody", { proposalId: "x" })).status).toBe(401);
    db.tables.org_members = db.tables.org_members.filter((m) => m.uid !== "u-other");
    expect((await execute("other", { proposalId: "x" })).status).toBe(403);
  });
});

describe("ORCH-4 / ORCH-10 — an action that does not run gives its claim back and is recorded", () => {
  it("the audit row cannot be written → nothing runs, 503, and the proposal is still confirmable", async () => {
    const card = await proposeAudit();
    db.hooks.push((op) => (op.table === "audit_logs" && op.kind === "insert" ? { error: { code: "57014", message: "statement timeout" } } : undefined));
    const res = await execute("dc", { proposalId: card.proposalId });
    expect(res.status).toBe(503);
    expect(rowsOf("drawing_audit_logs")).toHaveLength(0);
    expect(rowsOf("orchestrator_proposals")[0].executed_at).toBeNull();
    db.hooks = [];
    expect((await execute("dc", { proposalId: card.proposalId })).status).toBe(200);
    expect(rowsOf("drawing_audit_logs")).toHaveLength(1);
  });

  it("the tool refuses at execute time (the caller lost the controller tier) → nothing written, AI_ACTION_FAILED, claim released", async () => {
    const card = await proposeAudit();
    const dc = db.tables.org_members.find((m) => m.uid === "u-dc")!;
    dc.roles = ["Requester"];
    const res = await execute("dc", { proposalId: card.proposalId });
    expect([403, 409]).toContain(res.status);
    expect(rowsOf("drawing_audit_logs")).toHaveLength(0);
    expect(auditRows("AI_ACTION_FAILED")).toHaveLength(1);
    expect(auditRows("AI_ACTION_FAILED")[0].details).toMatchObject({ proposalId: card.proposalId });
    expect(rowsOf("orchestrator_proposals")[0].executed_at).toBeNull();
  });
});

describe("ORCH-4 — before 20261147 is applied the write path fails CLOSED", () => {
  it("the run still answers, the card says the migration is needed and carries no id; /execute answers 503", async () => {
    db.missingTables.push("orchestrator_proposals");
    net.script = [AUDIT_CALL, "I've asked you to confirm the audit record."];
    const { status, body } = await ask("dc", "record 0103 rev C as broken");
    expect(status).toBe(200);
    expect(body.answer).toMatch(/confirm/);
    const [card] = pendingOf(body);
    expect(card.proposalId).toBeUndefined();
    expect(card.unavailable).toBe(NOT_INSTALLED);
    const res = await execute("dc", { proposalId: "anything" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe(NOT_INSTALLED);
    expect(rowsOf("drawing_audit_logs")).toHaveLength(0);
  });

  it("a handoff (checkout) is never stored — its href is the confirmation", async () => {
    net.script = [JSON.stringify({ tool_name: "checkout_document", parameters: { document_id: "d-1", reason: "markup" } }), "Open it to check it out."];
    const { body } = await ask("dc", "check out 0103");
    const [card] = pendingOf(body);
    expect(card.href).toBe("/documents/L-ops?doc=d-1");
    expect(card.proposalId).toBeUndefined();
    expect(card.unavailable).toBeUndefined();
    expect(rowsOf("orchestrator_proposals")).toHaveLength(0);
  });
});

describe("20261147 — orchestrator_proposals: one paste, service role only, probes and inventory", () => {
  const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261147_intel_roundG_orchestrator_proposals.sql"), "utf8");
  const ddl = sql.slice(sql.indexOf("BEGIN;"), sql.indexOf("COMMIT;"));
  const verification = sql.slice(sql.indexOf("── Verification"));

  it("is one script: TEMP inventory BEFORE the transaction, BEGIN/COMMIT, then ONE final SELECT", () => {
    expect(sql.indexOf("CREATE TEMP TABLE _intel_g47_before")).toBeGreaterThan(0);
    expect(sql.indexOf("CREATE TEMP TABLE _intel_g47_before")).toBeLessThan(sql.indexOf("BEGIN;"));
    expect(sql.indexOf("BEGIN;")).toBeLessThan(sql.indexOf("COMMIT;"));
    expect(sql.indexOf("COMMIT;")).toBeLessThan(sql.indexOf("── Verification"));
    expect((verification.match(/^SELECT /gm) ?? [])).toHaveLength(1);
    expect(verification).toMatch(/AS check,[\s\S]*AS ok,\s*NULL::text AS n/);
    expect(verification).toMatch(/UNION ALL SELECT inventory, NULL, n FROM _intel_g47_before;/);
  });

  it("inventory is aggregate counts only — never rows", () => {
    const inv = sql.slice(sql.indexOf("CREATE TEMP TABLE"), sql.indexOf("BEGIN;"));
    for (const sel of inv.split(/UNION ALL/)) expect(sel).toMatch(/COUNT\(\*\)|to_regclass/);
  });

  it("the table is RLS-on with no policies and no anon / authenticated grants; no function, policy or trigger is created", () => {
    expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS orchestrator_proposals \(/);
    for (const col of ["org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE", "user_id      UUID NOT NULL", "fingerprint  TEXT NOT NULL",
      "tool         TEXT NOT NULL", "parameters   JSONB NOT NULL", "expires_at   TIMESTAMPTZ NOT NULL", "executed_at  TIMESTAMPTZ", "dismissed_at TIMESTAMPTZ"]) {
      expect(ddl).toContain(col);
    }
    expect(ddl).toMatch(/CHECK \(executed_at IS NULL OR dismissed_at IS NULL\)/);
    expect(ddl).toMatch(/ALTER TABLE orchestrator_proposals ENABLE ROW LEVEL SECURITY;/);
    expect(ddl).toMatch(/REVOKE ALL ON TABLE orchestrator_proposals FROM anon, authenticated;/);
    expect(ddl).not.toMatch(/CREATE (OR REPLACE )?(FUNCTION|POLICY|TRIGGER)/i);
    expect(ddl).not.toMatch(/SECURITY DEFINER/i);
    expect(verification).toMatch(/NOT EXISTS \(SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'orchestrator_proposals'\)/);
  });

  it("the health check expects the table and the backup excludes it with a reason", async () => {
    const { EXPECTED_TABLES } = await import("@/lib/schemaExpectations");
    expect(EXPECTED_TABLES.find((t) => t.table === "orchestrator_proposals")?.migration).toBe("20261147_intel_roundG_orchestrator_proposals.sql");
    const { EXPORT_EXCLUDED_TABLES } = await import("@/lib/exportTables");
    expect(EXPORT_EXCLUDED_TABLES.orchestrator_proposals).toMatch(/never become runnable again/);
  });

  it("no vercel.json cron entry: the prune is a lib DELETE on the store path", () => {
    expect(readFileSync(join(process.cwd(), "vercel.json"), "utf8")).not.toMatch(/orchestrator/);
    const lib = readFileSync(join(process.cwd(), "lib/orchestrator/proposals.ts"), "utf8");
    expect(lib).toMatch(/await pruneOrchestratorProposals\(now\)/);
  });
});
