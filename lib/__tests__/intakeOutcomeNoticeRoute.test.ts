// projects-tab SAF-9 (projects Round G J12) — POST /api/intake/outcome-notice:
// the contractor is emailed the decision on their submission, on approval
// and on rejection alike, through the server's email path — by a caller
// who may decide the submission, with the outcome read from the database,
// to the contact the org entered on the link (DEC-56), once.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  rows: {} as Record<string, Row[]>,
  errors: {} as Record<string, { message: string }>,
  inserts: [] as Array<{ table: string; row: Row }>,
}));
function chain(table: string) {
  const preds: Array<(r: Row) => boolean> = [];
  let insertRow: Row | null = null;
  const rows = () => (state.rows[table] ?? []).filter((r) => preds.every((p) => p(r)));
  const answer = () => {
    if (state.errors[table]) return { data: null, error: state.errors[table] };
    if (insertRow) { state.inserts.push({ table, row: insertRow }); return { data: null, error: null }; }
    return { data: rows(), error: null };
  };
  const c: Row = {};
  const h: ProxyHandler<Row> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve(answer());
      return (...args: unknown[]) => {
        if (prop === "eq") preds.push((r) => r[args[0] as string] === args[1]);
        if (prop === "contains") {
          const [col, sub] = args as [string, Row];
          preds.push((r) => Object.entries(sub).every(([k, v]) => (r[col] as Row | undefined)?.[k] === v));
        }
        if (prop === "insert") insertRow = args[0] as Row;
        if (prop === "maybeSingle") {
          const out = answer();
          return Promise.resolve({ data: out.error ? null : (out.data as Row[])[0] ?? null, error: out.error });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: vi.fn(async () => (state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { message: "bad jwt" } })) },
    from: (t: string) => chain(t),
  },
}));

import { POST } from "@/app/api/intake/outcome-notice/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const VER = "22222222-2222-4222-8222-222222222222";
const LINK = "33333333-3333-4333-8333-333333333333";
const PROJ = "44444444-4444-4444-8444-444444444444";
const DOC = "55555555-5555-4555-8555-555555555555";

const post = (body: unknown, auth = "Bearer t") => POST(new NextRequest("http://x/api/intake/outcome-notice", {
  method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body),
}));
const sent = vi.fn();
const audits = () => state.inserts.filter((i) => i.table === "audit_logs").map((i) => i.row);

beforeEach(() => {
  state.user = { id: "u-owner", email: "owner@plant.io" };
  state.errors = {};
  state.inserts = [];
  state.rows = {
    org_members: [
      { org_id: ORG, uid: "u-owner", role: "Requester", roles: [], status: "active" },
      { org_id: ORG, uid: "u-dc", role: "Requester", roles: ["Requester", "DocCtrl"], status: "active" },
      { org_id: ORG, uid: "u-member", role: "Requester", roles: [], status: "active" },
      { org_id: ORG, uid: "u-gone", role: "Admin", roles: ["Admin"], status: "inactive" },
    ],
    document_versions: [{ id: VER, record_id: DOC, intake_link_id: LINK, review_state: "rejected", review_note: "Missing PQR reference.", released_at: null, revision_label: "B" }],
    project_intake_links: [{ id: LINK, org_id: ORG, project_id: PROJ, company_name: "Gulf Mechanical", contact_email: "qa@gulfmech.example" }],
    projects: [{ id: PROJ, org_id: ORG, name: "Unit 300", owner_user_id: "u-owner" }],
    documents: [{ id: DOC, document_number: "WPS-12", title: "Weld procedure", name: null }],
    audit_logs: [],
  };
  process.env.RESEND_API_KEY = "re_test";
  process.env.RESEND_FROM_EMAIL = "noreply@plant.io";
  sent.mockReset();
  sent.mockImplementation(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", sent);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM_EMAIL;
});

describe("POST /api/intake/outcome-notice — who may send it", () => {
  it("400 on a malformed body, 401 without a session", async () => {
    expect((await post({ orgId: "x", versionId: VER })).status).toBe(400);
    expect((await post({ orgId: ORG, versionId: VER }, "")).status).toBe(401);
    state.user = null;
    expect((await post({ orgId: ORG, versionId: VER })).status).toBe(401);
    expect(sent).not.toHaveBeenCalled();
  });
  it("an inactive member or a member who may not decide the submission is refused; nothing is sent", async () => {
    state.user = { id: "u-gone" };
    expect((await post({ orgId: ORG, versionId: VER })).status).toBe(403);
    state.user = { id: "u-member" };
    const res = await post({ orgId: ORG, versionId: VER });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/project owner or a document controller/);
    expect(sent).not.toHaveBeenCalled();
    expect(audits()).toHaveLength(0);
  });
  it("a DocCtrl held additively (roles[], not the headline) may send it, as the project owner may", async () => {
    state.user = { id: "u-dc" };
    expect((await post({ orgId: ORG, versionId: VER })).status).toBe(200);
    expect(sent).toHaveBeenCalledTimes(1);
  });
  it("a version that is not a contractor submission, or a link of another org, is a 404", async () => {
    state.rows.document_versions[0].intake_link_id = null;
    expect((await post({ orgId: ORG, versionId: VER })).status).toBe(404);
    state.rows.document_versions[0].intake_link_id = LINK;
    state.rows.project_intake_links[0].org_id = "99999999-9999-4999-8999-999999999999";
    expect((await post({ orgId: ORG, versionId: VER })).status).toBe(404);
    expect(sent).not.toHaveBeenCalled();
  });
  it("a failed membership read is a 503, never a pass", async () => {
    state.errors.org_members = { message: "network" };
    expect((await post({ orgId: ORG, versionId: VER })).status).toBe(503);
    expect(sent).not.toHaveBeenCalled();
  });
});

describe("POST /api/intake/outcome-notice — what it sends, and when", () => {
  it("a rejection: the contact the org entered gets the reason; the audit row is INTAKE_OUTCOME_NOTIFIED with the project", async () => {
    const res = await post({ orgId: ORG, versionId: VER });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true, outcome: "rejected" });
    expect(sent).toHaveBeenCalledTimes(1);
    const [url, init] = sent.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers.Authorization).toBe("Bearer re_test");
    const mail = JSON.parse(init.body) as { from: string; to: string; subject: string; text: string };
    expect(mail).toMatchObject({ from: "noreply@plant.io", to: "qa@gulfmech.example", subject: "Not accepted — resubmit: WPS-12 — Weld procedure Rev B for Unit 300" });
    expect(mail.text).toContain("Reviewer's reason: Missing PQR reference.");
    expect(audits()).toEqual([expect.objectContaining({
      action: "INTAKE_OUTCOME_NOTIFIED", resource_type: "document", resource_id: DOC, org_id: ORG, user_id: "u-owner",
      details: { versionId: VER, projectId: PROJ, linkId: LINK, company: "Gulf Mechanical", outcome: "rejected" },
    })]);
  });
  it("an approval (or a release with no review state) is sent as accepted", async () => {
    Object.assign(state.rows.document_versions[0], { review_state: null, released_at: "2026-10-01T00:00:00Z" });
    const res = await post({ orgId: ORG, versionId: VER });
    expect(await res.json()).toEqual({ sent: true, outcome: "approved" });
    expect(JSON.parse((sent.mock.calls[0][1] as { body: string }).body).subject).toBe("Accepted: WPS-12 — Weld procedure Rev B for Unit 300");
  });
  it("the outcome is the database's: an undecided submission is a 409 and nothing is sent", async () => {
    Object.assign(state.rows.document_versions[0], { review_state: "pending", released_at: null });
    expect((await post({ orgId: ORG, versionId: VER, outcome: "approved" })).status).toBe(409);
    expect(sent).not.toHaveBeenCalled();
  });
  it("no contact on the link: nothing is sent, and the answer says why", async () => {
    state.rows.project_intake_links[0].contact_email = "  ";
    expect(await (await post({ orgId: ORG, versionId: VER })).json()).toEqual({ sent: false, reason: "no_contact" });
    expect(sent).not.toHaveBeenCalled();
  });
  it("once per submission: a second call answers 'already' and sends nothing", async () => {
    state.rows.audit_logs.push({ org_id: ORG, action: "INTAKE_OUTCOME_NOTIFIED", resource_id: DOC, details: { versionId: VER } });
    expect(await (await post({ orgId: ORG, versionId: VER })).json()).toEqual({ sent: false, reason: "already" });
    expect(sent).not.toHaveBeenCalled();
    // a notice for another version of the same document does not count
    state.rows.audit_logs[0].details = { versionId: "66666666-6666-4666-8666-666666666666" };
    expect((await (await post({ orgId: ORG, versionId: VER })).json()).sent).toBe(true);
  });
  it("email not configured: nothing is sent, nothing is audited, the answer says so", async () => {
    delete process.env.RESEND_API_KEY;
    expect(await (await post({ orgId: ORG, versionId: VER })).json()).toEqual({ sent: false, reason: "not_configured" });
    expect(sent).not.toHaveBeenCalled();
    expect(audits()).toHaveLength(0);
  });
  it("the provider refuses: 502 send_failed and an INTAKE_OUTCOME_NOTICE_FAILED row carrying the error", async () => {
    sent.mockImplementation(async () => new Response("domain not verified", { status: 403 }));
    const res = await post({ orgId: ORG, versionId: VER });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ sent: false, reason: "send_failed" });
    const [row] = audits();
    expect(row.action).toBe("INTAKE_OUTCOME_NOTICE_FAILED");
    expect((row.details as { error: string }).error).toBe("Resend 403: domain not verified");
  });
});
