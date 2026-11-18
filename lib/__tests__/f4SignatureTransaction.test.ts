// drafting-flow EVID-11 done-whens 2–3 — F4 SIGNATURE TRANSACTION, the app
// half (the database half: lib/__tests__/rls/f4SignatureTransaction.test.ts).
//
//   * The signing route calls record_signature_transaction with the very rows
//     its fallback inserts (A/B: the RPC's p_signature IS the e_signatures
//     insert; p_audit IS the audit insert but for the signature's id, which
//     the database fills).
//   * Before the paste (PGRST202 / 42883) every write is today's, byte for
//     byte, and the answer carries no `paired` (the browser writes its own
//     roster row, as today); a refused mirror is also kept in the outbox.
//   * After it: one call, no direct insert; the answer is the RPC's row (and
//     `paired` when a roster row was written, today's warning when the mirror
//     was dead-lettered); a roster write that matched nothing or that a guard
//     refused is "Nothing was signed" — never a signature without its
//     sign-off.
//   * The browser sends `pair` only from the two roster ceremonies; every
//     other signing surface's request body is unchanged.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

type Call = { table: string; method: string; args: unknown[] };
const state = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string; app_metadata?: Record<string, unknown> },
  tables: {} as Record<string, unknown>,
  errors: {} as Record<string, { message: string } | undefined>,
  calls: [] as Call[],
  rpc: null as null | { data: unknown; error: { code?: string; message: string } | null },
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}));
function chain(table: string) {
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: state.tables[table] ?? null, error: state.errors[table] ?? null });
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        if (prop === "maybeSingle" || prop === "single") return Promise.resolve({ data: state.tables[table] ?? null, error: null });
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: vi.fn(async () => state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
    from: (t: string) => chain(t),
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      return state.rpc ?? { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    }),
  },
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      signInWithPassword: vi.fn(async () => ({ data: { user: { id: "u1" } }, error: null })),
      signOut: vi.fn(async () => ({ error: null })),
    },
  }),
}));
vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: "tok" } } })) } },
}));
import { POST as sign } from "@/app/api/signatures/sign/route";
import { recordSignature } from "@/lib/eSignatures";

const post = (body: unknown) => sign(new NextRequest("http://x/api/signatures/sign", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json", "user-agent": "vitest" }, body: JSON.stringify(body),
}));
const reauth = { method: "password", password: "hunter2" };
const ROSTER = "aaaaaaaa-0000-4000-8000-000000000001";
const SIGNOFF = "bbbbbbbb-0000-4000-8000-000000000002";
const ack = { orgId: "o1", resourceType: "document", resourceId: "d1", documentVersionId: "v1", intent: "Acknowledged", statement: "Read and understood", reauth, pair: { kind: "acknowledgment", rosterId: ROSTER } };
const review = { orgId: "o1", resourceType: "document_version", resourceId: "v1", documentVersionId: "v1", intent: "Reviewed", statement: "Reviewed", reauth, pair: { kind: "review_signoff", signoffId: SIGNOFF } };
const ticket = { orgId: "o1", resourceType: "ticket", resourceId: "t1", intent: "Reviewed", statement: "Reviewed", reauth };
const inserts = (t: string) => state.calls.filter((c) => c.table === t && c.method === "insert").map((c) => c.args[0] as Record<string, unknown>);
const SIG_ROW = { id: "sig1", org_id: "o1", signer_user_id: "u1", signed_at: "2026-11-18T10:00:00+00:00" };

beforeEach(() => {
  state.user = { id: "u1", email: "pat@x.io", app_metadata: { provider: "email" } };
  state.tables = {
    org_members: { uid: "u1", email: "pat@x.io", display_name: "Pat Example", role: "Viewer", roles: ["Viewer"] },
    document_versions: { id: "v1", org_id: "o1", file_hash: "sha-stored" },
    e_signatures: SIG_ROW,
  };
  state.errors = {}; state.calls = []; state.rpc = null; state.rpcCalls = [];
});

describe("A/B — the RPC is handed the very rows today's path inserts", () => {
  for (const [name, body] of [["acknowledgment", ack], ["review sign-off", review], ["unpaired (ticket)", ticket]] as const) {
    it(`${name}: p_signature is the e_signatures insert; p_audit is the audit insert but for the id the database fills`, async () => {
      const before = await post(body); // PGRST202: today's path
      expect(before.status).toBe(200);
      const tx = state.rpcCalls[0].args;
      expect(state.rpcCalls[0].fn).toBe("record_signature_transaction");
      const [sigInsert] = inserts("e_signatures");
      const [auditInsert] = inserts("audit_logs");
      expect(tx.p_signature).toEqual(sigInsert);
      expect(tx.p_audit).toEqual({ ...auditInsert, details: { ...(auditInsert.details as Record<string, unknown>), signatureId: null } });
      expect((auditInsert.details as { signatureId: string }).signatureId).toBe("sig1");
      expect(tx.p_pair).toEqual("pair" in body ? body.pair : null);
      expect(typeof tx.p_paired_at).toBe("string");
    });
  }
});

describe("before the paste (PGRST202 / 42883): today's path, byte for byte", () => {
  for (const code of ["PGRST202", "42883"]) {
    it(`${code}: the service-role insert, the checked audit insert, no roster write, no 'paired' — the browser writes its roster row as today`, async () => {
      state.rpc = { data: null, error: { code, message: "missing" } };
      const res = await post(ack);
      expect(res.status).toBe(200);
      const out = (await res.json()) as Record<string, unknown>;
      expect(out).toEqual({ signature: SIG_ROW });
      expect(inserts("e_signatures")[0]).toMatchObject({
        org_id: "o1", resource_type: "document", resource_id: "d1", document_version_id: "v1", content_hash: "sha-stored",
        intent: "Acknowledged", statement: "Read and understood", signer_user_id: "u1", signer_name: "Pat Example", signer_role: "Viewer", signer_email: "pat@x.io",
        signature_image: null, user_agent: "vitest", reauth_method: "password",
        metadata: { reauth: { method: "password", provider: "email" }, minted_by: "api/signatures/sign" },
      });
      expect(inserts("audit_logs")).toEqual([{
        action: "ESIGNATURE_CAPTURED", resource_id: "d1", resource_type: "document", org_id: "o1", user_id: "u1", user_email: "pat@x.io", user_role: "Viewer",
        details: { intent: "Acknowledged", statement: "Read and understood", signerName: "Pat Example", signatureId: "sig1", documentVersionId: "v1", reauthMethod: "password" },
      }]);
      expect(state.calls.filter((c) => c.method === "update")).toEqual([]);
      expect(inserts("audit_dead_letters")).toEqual([]);
    });
  }
  it("the fallback is said in the server log, PGRST202 told apart from 42883 (a function the body calls may be the missing one)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      state.rpc = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
      await post(ticket);
      state.rpc = { data: null, error: { code: "42883", message: "function auth.uid() does not exist" } };
      await post(ticket);
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines[0]).toMatch(/pre-paste path: record_signature_transaction is not in the schema \(PGRST202/);
      expect(lines[1]).toMatch(/pre-paste path: a function is missing \(42883: function auth\.uid\(\) does not exist\)/);
    } finally { warn.mockRestore(); }
  });
  it("a refused mirror: today's warning, and (DEC-109) the row kept in the outbox as it was meant", async () => {
    state.errors.audit_logs = { message: "audit refused" };
    const res = await post(ticket);
    expect(((await res.json()) as { warning?: string }).warning).toBe("Signed, but the audit row failed: audit refused");
    const [dl] = inserts("audit_dead_letters");
    expect(dl).toEqual({
      org_id: "o1", action: "ESIGNATURE_CAPTURED", entry: { row: { ...inserts("audit_logs")[0], metadata: null }, reporter: null },
      error: "audit refused", source: "server", reported_by: null,
    });
  });
});

describe("after the paste: one transaction", () => {
  it("one call, no direct insert; the RPC's row is the answer, with `paired` when it wrote the roster row", async () => {
    state.rpc = { data: { signature: SIG_ROW, paired: { kind: "acknowledgment", rosterIds: [ROSTER] }, auditError: null }, error: null };
    const res = await post(ack);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signature: SIG_ROW, paired: { kind: "acknowledgment", rosterIds: [ROSTER] } });
    expect(state.calls.filter((c) => c.method === "insert" || c.method === "update")).toEqual([]);
  });
  it("an unpaired signature answers exactly today's shape", async () => {
    state.rpc = { data: { signature: SIG_ROW, paired: null, auditError: null }, error: null };
    expect(await (await post(ticket)).json()).toEqual({ signature: SIG_ROW });
  });
  it("a dead-lettered mirror answers today's warning", async () => {
    state.rpc = { data: { signature: SIG_ROW, paired: null, auditError: "audit refused" }, error: null };
    expect(await (await post(ticket)).json()).toEqual({ signature: SIG_ROW, warning: "Signed, but the audit row failed: audit refused" });
  });
  it("no row of the signer's (P0002): 409, 'Nothing was signed', in the roster's own words; never the fallback", async () => {
    state.rpc = { data: null, error: { code: "P0002", message: "no acknowledgment row" } };
    const a = await post(ack);
    expect(a.status).toBe(409);
    expect(((await a.json()) as { error: string }).error).toMatch(/^There was no pending acknowledgment of yours to mark .* Nothing was signed/);
    state.rpc = { data: null, error: { code: "P0002", message: "no review_signoff row" } };
    const r = await post(review);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/^That roster row is not yours to sign .* Nothing was signed\.$/);
    expect(state.calls.filter((c) => c.method === "insert")).toEqual([]);
  });
  it("a guard's refusal (23514): 409 with its sentence and 'Nothing was signed.'; anything else 500 — never the fallback", async () => {
    state.rpc = { data: null, error: { code: "23514", message: "You authored this revision, so you can't sign it as its reviewer." } };
    const g = await post(review);
    expect(g.status).toBe(409);
    expect(((await g.json()) as { error: string }).error).toBe("You authored this revision, so you can't sign it as its reviewer. Nothing was signed.");
    state.rpc = { data: null, error: { code: "42501", message: "permission denied for function record_signature_transaction" } };
    const p = await post(ticket);
    expect(p.status).toBe(500);
    expect(((await p.json()) as { error: string }).error).toBe("Nothing was signed. You don't have permission to do this.");
    expect(state.calls.filter((c) => c.method === "insert")).toEqual([]);
  });
  it("the mirror and the outbox both refused: the signer reads plain language, never driver text", async () => {
    state.rpc = { data: null, error: { code: "P0001", message: "The audit trail could not record this signature, so it was not kept. Try again; if it keeps happening, tell your administrator." } };
    const res = await post(ack);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("Nothing was signed. The audit trail could not record this signature, so it was not kept. Try again; if it keeps happening, tell your administrator.");
    state.rpc = { data: null, error: { code: "23514", message: 'new row for relation "e_signatures" violates check constraint "x"' } };
    const c = await post(ticket);
    expect(((await c.json()) as { error: string }).error).toBe("That value isn't allowed here. Nothing was signed.");
    expect(state.calls.filter((x) => x.method === "insert")).toEqual([]);
  });
  it("a roster id that is not a uuid is refused in plain language before anything is written", async () => {
    for (const body of [{ ...ack, pair: { kind: "acknowledgment", rosterId: "a1" } }, { ...review, pair: { kind: "review_signoff", signoffId: "so1; drop" } }]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("Your roster row could not be identified — reload and sign again. Nothing was signed.");
    }
    expect(state.rpcCalls).toEqual([]);
    expect(state.calls.filter((c) => c.method === "insert")).toEqual([]);
  });
  it("an answer with no row is a 500, never a second write through the fallback", async () => {
    state.rpc = { data: null, error: null };
    expect((await post(ack)).status).toBe(500);
    expect(state.calls.filter((c) => c.method === "insert")).toEqual([]);
  });
  it("a pair that is not the one its signature signs is refused before anything is written", async () => {
    for (const body of [{ ...ack, intent: "Approved" }, { ...ack, resourceType: "ticket" }, { ...review, pair: { kind: "review_signoff" } }, { ...ticket, pair: { kind: "other" } }]) {
      const res = await post(body);
      expect(res.status).toBe(400);
    }
    expect(state.rpcCalls).toEqual([]);
    expect(state.calls.filter((c) => c.method === "insert")).toEqual([]);
  });
});

describe("the browser: `pair` only from the roster ceremonies; `pairedRosterIds` only for the pair it sent", () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
  const answer = (body: unknown) => fetchMock.mockResolvedValueOnce({ ok: true, json: async () => body });
  const input = { orgId: "o1", resourceType: "ticket", resourceId: "t1", intent: "Reviewed" as const, statement: "s", signerUserId: "u1", signerName: "Pat" };
  it("a signing surface that names no pair sends today's body exactly", async () => {
    answer({ signature: { ...SIG_ROW, resource_type: "ticket", resource_id: "t1", intent: "Reviewed", statement: "s", signer_name: "Pat" } });
    const sig = await recordSignature(input);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      orgId: "o1", resourceType: "ticket", resourceId: "t1", documentVersionId: null, contentHash: null,
      intent: "Reviewed", statement: "s", signatureImage: null, reauth: { method: "sso" },
    });
    expect(sig.pairedRosterIds).toBeUndefined();
  });
  it("a pair is sent; the ids come back only when the route answered for that pair", async () => {
    answer({ signature: SIG_ROW, paired: { kind: "acknowledgment", rosterIds: ["a1"] } });
    const s1 = await recordSignature({ ...input, pair: { kind: "acknowledgment", rosterId: "a1" } });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).pair).toEqual({ kind: "acknowledgment", rosterId: "a1" });
    expect(s1.pairedRosterIds).toEqual(["a1"]);
    answer({ signature: SIG_ROW }); // before the paste
    expect((await recordSignature({ ...input, pair: { kind: "acknowledgment" } })).pairedRosterIds).toBeUndefined();
    answer({ signature: SIG_ROW, paired: { kind: "review_signoff", rosterIds: ["x"] } }); // not the pair sent
    expect((await recordSignature({ ...input, pair: { kind: "acknowledgment" } })).pairedRosterIds).toBeUndefined();
  });
  it("only the two roster ceremonies send a pair", () => {
    const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
    expect(src("lib/acknowledgments.ts")).toContain('pair: { kind: "acknowledgment", rosterId: input.rosterId ?? null },');
    expect(src("lib/reviewControl.ts")).toContain('pair: { kind: "review_signoff", signoffId: input.signoffId },');
    for (const f of ["components/signatures/SignatureCaptureHost.tsx", "components/requests/TicketRosterPanel.tsx", "components/requests/PreauthorizationPanel.tsx", "lib/checklists.ts", "app/(protected)/requests/new/page.tsx"]) {
      expect(src(f), f).not.toMatch(/\bpair:/);
    }
  });
});
