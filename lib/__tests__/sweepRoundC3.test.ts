// Phase 6 severity sweep, Round C3 — SURF-14 (with document-control RG-9 and
// drafting-flow EVID-3, the same defect): the signing ceremony is minted by the
// server. The route verifies re-authentication itself, derives the signer's
// identity from the membership row, takes the content hash from the version
// row, gates "Approved" on approval capability, writes on the service-role key
// and mirrors a CHECKED audit row; 20261050 closes the client INSERT path.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string; app_metadata?: Record<string, unknown>; last_sign_in_at?: string },
  tables: {} as Record<string, unknown>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  probe: { ok: true, userId: "u1" },
  probeCalls: [] as Array<{ email: string; password: string }>,
}));
function chain(table: string) {
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: state.tables[table] ?? null, error: null });
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
  },
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      signInWithPassword: vi.fn(async (a: { email: string; password: string }) => {
        state.probeCalls.push(a);
        return state.probe.ok ? { data: { user: { id: state.probe.userId } }, error: null } : { data: { user: null }, error: { message: "Invalid login credentials" } };
      }),
      signOut: vi.fn(async () => ({ error: null })),
    },
  }),
}));
import { POST as sign } from "@/app/api/signatures/sign/route";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const post = (body: unknown, auth = "Bearer t") => sign(new NextRequest("http://x/api/signatures/sign", {
  method: "POST", headers: auth ? { authorization: auth, "content-type": "application/json", "user-agent": "vitest" } : { "content-type": "application/json" }, body: JSON.stringify(body),
}));
const base = { orgId: "o1", resourceType: "ticket", resourceId: "t1", intent: "Reviewed", statement: "I reviewed it", reauth: { method: "password", password: "hunter2" } };

beforeEach(() => {
  state.user = { id: "u1", email: "pat@x.io", app_metadata: { provider: "email" } };
  state.tables = { org_members: { uid: "u1", email: "pat@x.io", display_name: "Pat Example", role: "Drafter", roles: ["Drafter"] }, e_signatures: { id: "sig1", signer_user_id: "u1" } };
  state.calls = []; state.probe = { ok: true, userId: "u1" }; state.probeCalls = [];
});

describe("/api/signatures/sign — re-authentication is verified by the server", () => {
  it("401 without a bearer; 403 when a password account sends no password; 403 when the password is wrong", async () => {
    expect((await post(base, "")).status).toBe(401);
    expect((await post({ ...base, reauth: { method: "sso" } })).status).toBe(403);
    expect((await post({ ...base, reauth: { method: "password", password: "" } })).status).toBe(403);
    state.probe = { ok: false, userId: "u1" };
    const wrong = await post(base);
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as { error: string }).error).toMatch(/password doesn't match/);
    expect(state.calls.filter((c) => c.table === "e_signatures" && c.method === "insert")).toHaveLength(0);
  });
  it("the password probe is against the BEARER's email, never a body-supplied one, and must resolve to the same user", async () => {
    await post({ ...base, email: "someone@else.io" });
    expect(state.probeCalls).toEqual([{ email: "pat@x.io", password: "hunter2" }]);
    state.probe = { ok: true, userId: "u9" };
    expect((await post(base)).status).toBe(403);
  });
  it("an SSO account signs only inside the freshness window, read from the token's user record", async () => {
    state.user = { id: "u1", email: "pat@x.io", app_metadata: { provider: "azure" }, last_sign_in_at: new Date(Date.now() - 60_000).toISOString() };
    expect((await post({ ...base, reauth: { method: "sso" } })).status).toBe(200);
    expect(state.probeCalls).toHaveLength(0);
    state.user = { ...state.user, last_sign_in_at: new Date(Date.now() - 20 * 60_000).toISOString() };
    expect((await post({ ...base, reauth: { method: "sso" } })).status).toBe(403);
    expect((await post({ ...base, reauth: { method: "password", password: "x" } })).status).toBe(403);
  });
});

describe("/api/signatures/sign — identity, hash and intent are the server's, not the body's", () => {
  it("signer name / role / email come from org_members; client-supplied signer fields are ignored; the audit row is written", async () => {
    const res = await post({ ...base, signerName: "Forged Name", signerRole: "Admin", signerUserId: "someone-else" });
    expect(res.status).toBe(200);
    const ins = state.calls.find((c) => c.table === "e_signatures" && c.method === "insert")!;
    expect(ins.args[0]).toMatchObject({
      org_id: "o1", resource_type: "ticket", resource_id: "t1", intent: "Reviewed",
      signer_user_id: "u1", signer_name: "Pat Example", signer_role: "Drafter", signer_email: "pat@x.io",
      reauth_method: "password", user_agent: "vitest",
    });
    expect((ins.args[0] as { reauth_at: string }).reauth_at).toBe((ins.args[0] as { signed_at: string }).signed_at);
    const audit = state.calls.find((c) => c.table === "audit_logs" && c.method === "insert")!;
    expect(audit.args[0]).toMatchObject({ action: "ESIGNATURE_CAPTURED", org_id: "o1", user_id: "u1", resource_id: "t1" });
    expect((audit.args[0] as { details: { signerName: string; reauthMethod: string } }).details).toMatchObject({ signerName: "Pat Example", reauthMethod: "password" });
  });
  it("403 for a non-member; a member without a display name is recorded under the email local part", async () => {
    state.tables.org_members = null;
    expect((await post(base)).status).toBe(403);
    state.tables.org_members = { uid: "u1", email: "pat@x.io", display_name: null, role: "Drafter", roles: ["Drafter"] };
    await post(base);
    expect((state.calls.find((c) => c.table === "e_signatures" && c.method === "insert")!.args[0] as { signer_name: string }).signer_name).toBe("pat");
  });
  it("the content hash is the stored version's; a disagreeing client hash is refused; a foreign version is 404", async () => {
    state.tables.document_versions = { id: "v1", org_id: "o1", file_hash: "sha-stored" };
    await post({ ...base, documentVersionId: "v1", contentHash: "sha-stored" });
    expect((state.calls.find((c) => c.table === "e_signatures" && c.method === "insert")!.args[0] as { content_hash: string }).content_hash).toBe("sha-stored");
    state.calls = [];
    await post({ ...base, documentVersionId: "v1" });
    expect((state.calls.find((c) => c.table === "e_signatures" && c.method === "insert")!.args[0] as { content_hash: string }).content_hash).toBe("sha-stored");
    expect((await post({ ...base, documentVersionId: "v1", contentHash: "sha-client" })).status).toBe(409);
    state.tables.document_versions = { id: "v1", org_id: "o2", file_hash: "x" };
    expect((await post({ ...base, documentVersionId: "v1" })).status).toBe(404);
  });
  it("'Approved' needs approval capability by the role collection; other intents need membership only; unknown intents are refused", async () => {
    expect((await post({ ...base, intent: "Approved" })).status).toBe(403);
    state.tables.org_members = { uid: "u1", email: "pat@x.io", display_name: "Pat", role: "Requester", roles: ["Requester", "Engineer-2"] };
    expect((await post({ ...base, intent: "Approved" })).status).toBe(200);
    expect((await post({ ...base, intent: "Witnessed" })).status).toBe(200);
    expect((await post({ ...base, intent: "Blessed" })).status).toBe(400);
  });
});

describe("pinned at the source — no browser path mints a signature", () => {
  it("lib/eSignatures.ts records through the route and never inserts; the client-side credential check is gone", () => {
    const e = src("lib/eSignatures.ts");
    expect(e).toContain('fetch("/api/signatures/sign"');
    expect(e).not.toMatch(/from\("e_signatures"\)\s*\.insert/);
    expect(e).not.toContain("verifySigningCredential");
    expect(e).not.toContain("signInWithPassword");
    expect(e).toMatch(/reauthMethod\?: "password" \| "sso" \| null;/);
  });
  it("the ceremony sends the credential with the signature instead of verifying it in the browser", () => {
    const c = src("components/signatures/SignatureCeremony.tsx");
    expect(c).not.toContain("verifySigningCredential");
    expect(c).toContain("onSign(intent, statement, mode === \"draw\" ? drawn : null, credential);");
    expect(c).toMatch(/const credential: SigningCredential = /);
  });
  it("every signing surface forwards the credential and confirms against the membership display name", () => {
    for (const f of ["components/signatures/SignatureCaptureHost.tsx", "components/documents/ReviewGateSection.tsx", "components/documents/AckSection.tsx"]) {
      const s = src(f);
      expect(s, f).toContain("reauth: reauth ?? null,");
      expect(s, f).toMatch(/const signerName = \(member\?\.displayName \?\? ""\)\.trim\(\) \|\| \(userEmail\?\.split\("@"\)\[0\] \?\? ""\)\.trim\(\) \|\| "user";/);
    }
    for (const f of ["lib/reviewControl.ts", "lib/acknowledgments.ts"]) expect(src(f), f).toContain("reauth: input.reauth ?? null,");
    expect(src("components/signatures/SignaturePanel.tsx")).toContain("re-authenticated by");
  });
  it("the route never trusts the body for identity, and writes the audit row as a checked write", () => {
    const r = src("app/api/signatures/sign/route.ts");
    expect(r).not.toMatch(/body\.signer(Name|Role|Email|UserId)/);
    expect(r).toContain("signer_user_id: user.id, signer_name: signerName, signer_role: signerRole, signer_email: signerEmail,");
    expect(r).toContain('const { error: auditErr } = await supabaseAdmin.from("audit_logs").insert({');
    expect(r).toContain("signInWithPassword({ email: user.email, password })");
  });
});

describe("20261050 — the client INSERT path is closed and stays closed", () => {
  const m = src("supabase/migrations/20261050_rp_phase6_sweep_signature_ceremony.sql");
  it("drops e_signatures_self_insert, adds no INSERT policy, installs the ceremony guard with a pinned search_path, adds the re-auth columns", () => {
    expect(m).toContain('DROP POLICY IF EXISTS "e_signatures_self_insert" ON e_signatures;');
    expect(m).not.toMatch(/CREATE POLICY[^;]*ON e_signatures[^;]*FOR INSERT/);
    expect(m).toMatch(/CREATE OR REPLACE FUNCTION enforce_signature_ceremony\(\)\s*\nRETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$\$/);
    expect(m).toContain("IF auth.uid() IS NULL THEN RETURN NEW; END IF;");
    expect(m).toMatch(/BEFORE INSERT ON e_signatures\s*\nFOR EACH ROW EXECUTE FUNCTION enforce_signature_ceremony\(\);/);
    expect(m).toContain("ALTER TABLE e_signatures ADD COLUMN IF NOT EXISTS reauth_method TEXT;");
    expect(m).toContain("ALTER TABLE e_signatures ADD COLUMN IF NOT EXISTS reauth_at TIMESTAMPTZ;");
    expect(m).not.toMatch(/e_signatures_member_read.*DROP|DROP POLICY IF EXISTS "e_signatures_member_read"/);
  });
  it("COMMIT before verification; inventory before the DDL; probes carry no bare cast", () => {
    expect(m.indexOf("COMMIT;")).toBeLessThan(m.indexOf("── Verification"));
    expect(m).toMatch(/── Inventory \(read-only, aggregate\) — run BEFORE the DDL/);
    const v = m.slice(m.indexOf("── Verification"));
    for (const x of v.matchAll(/(?:qual|with_check) LIKE '((?:[^']|'')*)'/g)) expect(x[1]).not.toMatch(/\w::\w/);
  });
});
