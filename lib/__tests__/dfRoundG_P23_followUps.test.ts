// drafting-flow Round G, DF-P23 TRANSITION RECORD AND RECONCILE — the small
// follow-ups as written in the plan entry, and the graph / deliverable limbs:
//
//   * DF-P19: Admin → Permissions confirm_rule carries the policy version it
//     was read at; the route answers 409 policy_changed on a mismatch, as a
//     save does (ALOG-12); a body without the key keeps today's answer.
//   * DF-P20 (c): the routing editor decides the assurance opt-in by the
//     parser's own rule (examinationOptInAllowed), so a stored opt-in on a
//     slot shown as the requester's that is ALSO filled by roles survives the
//     editor's next save.
//   * DF-P22: a standing pre-authorization that released its grantor retires
//     that grantor's "review opened" alert (marked superseded, read_at never
//     touched; an SLA notice kept) — as rosterReleased does.
//   * PROJ-7: the project ↔ request edge from tickets.project_id (requests
//     folded into the project class — no new node type, DEC-67).
//   * GAP-101 acceptance 3: a deliverable copy names the like-in-kind
//     declaration, attributed, beside the request reference; none → the
//     footer exactly as before; unreadable → "not available", never blocking.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import type { MemoryState } from "./helpers/memoryDb";

const h = vi.hoisted(() => ({
  admin: null as unknown as MemoryState,
  user: { id: "u-admin", email: "admin@plant.io" } as { id: string; email: string } | null,
}));

vi.mock("@/lib/supabaseAdmin", async () => {
  const mem = await import("./helpers/memoryDb");
  h.admin = mem.freshState();
  const sb = mem.makeSupabase(h.admin) as Record<string, unknown>;
  sb.auth = { getUser: async () => (h.user ? { data: { user: h.user }, error: null } : { data: { user: null }, error: { message: "bad" } }) };
  return { supabaseAdmin: sb };
});

import { POST as policyPost } from "@/app/api/admin/capability-policy/route";
import { capabilityRuleKey, POLICY_CHANGED, type CapabilityRule } from "@/lib/capabilityPolicy";
import { resetState } from "./helpers/memoryDb";
import { assuranceOptInFor, controlToDraft, draftToControl, preauthOptInFor } from "@/components/documents/RoutingControlSection";
import { parseRoutingControl } from "@/lib/routingControl";
import { retireReleasedAlerts, PREAUTH_RELEASED_SUPERSEDED_BY } from "@/lib/ticketPreauthorizationApply";
import { assembleOrgGraph, emptyGraphRows } from "@/lib/orgGraph";
import { ticketCopyPlan, declarationFooterClause, DECLARATION_NOT_AVAILABLE, DECLARATION_FOOTER_MAX } from "@/lib/ticketDeliverableCopy";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// ── DF-P19 follow-up: confirm_rule carries the version ──────────────────────
describe("DF-P19 follow-up — confirm_rule carries the policy version it was read at (409 on a mismatch, as save)", () => {
  const ORG = "o-1";
  const STORED_AT = "2026-10-01T00:00:00+00:00";
  const LIB_RULE: CapabilityRule = { tokens: ["Engineer-3"], when: { libraryId: ["L1"] } };
  const call = (body: Record<string, unknown>) => policyPost(new NextRequest("https://app.plant.io/api/admin/capability-policy", {
    method: "POST", headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  const seedPolicy = () => {
    resetState(h.admin);
    h.user = { id: "u-admin", email: "admin@plant.io" };
    h.admin.tables.org_members = [{ org_id: ORG, uid: "u-admin", role: "Admin", roles: ["Admin"], email: "admin@plant.io", status: "active" }];
    h.admin.tables.org_configurations = [{
      org_id: ORG, key: "capability_policy", updated_at: STORED_AT,
      data: { caps: { "ticket.final_approve": [{ tokens: ["Admin", "Engineer"] }, LIB_RULE] } },
    }];
  };
  const confirm = (extra: Record<string, unknown>) => call({ op: "confirm_rule", orgId: ORG, cap: "ticket.final_approve", key: capabilityRuleKey(LIB_RULE), ordinal: 0, ...extra });
  const storedRule = () => ((h.admin.tables.org_configurations[0].data as { caps: Record<string, CapabilityRule[]> }).caps["ticket.final_approve"])[1];
  beforeEach(seedPolicy);

  it("a version that matches the stored row confirms the rule (audited)", async () => {
    const res = await confirm({ version: "2026-10-01T00:00:00.000Z" });
    expect(res.status).toBe(200);
    expect(storedRule()).toHaveProperty("confirmedAt");
    expect((h.admin.tables.audit_logs ?? []).map((a) => a.action)).toEqual(["CAPABILITY_POLICY_CHANGED"]);
  });
  it("a stale version (another save since) is refused 409 policy_changed — nothing written, nothing confirmed", async () => {
    const res = await confirm({ version: "2026-09-30T00:00:00.000Z" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: POLICY_CHANGED });
    expect(storedRule()).not.toHaveProperty("confirmedAt");
    expect(h.admin.writes).toEqual([]);
  });
  it("a version that is not text is a 400; REGRESSION: a body without the key keeps today's answer (confirmed)", async () => {
    expect((await confirm({ version: 7 })).status).toBe(400);
    seedPolicy();
    expect((await confirm({})).status).toBe(200);
    expect(storedRule()).toHaveProperty("confirmedAt");
  });
  it("the console sends the version it read and reloads on policy_changed (source pins)", () => {
    const editor = src("components/permissions/CapabilityPolicyEditor.tsx");
    expect(editor).toContain("await confirmCapabilityRule({ orgId: activeOrgId, cap: r.cap, rule: r.rule, ordinal: r.ordinal, version });");
    expect(editor).toContain("if (e instanceof CapabilityPolicyChangeError && e.code === POLICY_CHANGED) {");
    expect(src("lib/capabilityPolicy.ts")).toContain("...(input.version !== undefined ? { version: input.version } : {}),");
  });
});

// ── DF-P20 follow-up (c): the editor keeps a stored opt-in ──────────────────
describe("DF-P20 follow-up (c) — the routing editor decides the assurance opt-in by examinationOptInAllowed alone", () => {
  it("a stored opt-in on a slot shown as the requester's that is ALSO filled by roles survives the editor's round trip", () => {
    const parsed = parseRoutingControl({ slots: [
      { kind: "accept", label: "Acceptance", mode: "blocking", fill: { identity: "requester", roles: ["Supervisor"] }, records_examination: true, accepts_preauthorization: false },
      { kind: "other", label: "Other", mode: "blocking", fill: { roles: ["Engineer-2"] } },
    ] });
    expect(parsed && parsed.ok).toBe(true);
    if (!parsed || !parsed.ok) return;
    expect(parsed.control.slots[0].records_examination).toBe(true);
    const drafts = controlToDraft(parsed.control);
    expect(drafts[0].fillKind).toBe("requester");
    expect(assuranceOptInFor(drafts[0])).toBe("offer");
    expect(draftToControl(drafts).slots[0]).toMatchObject({ records_examination: true, fill: { identity: "requester", roles: ["Supervisor"] } });
  });
  it("REGRESSION: the requester's own slot alone offers nothing; an engineering-capability slot says why; other modes offer nothing; a roles slot offers", () => {
    const drafts = controlToDraft({ slots: [
      { kind: "a", label: "", mode: "blocking", fill: { identity: "requester" } },
      { kind: "b", label: "", mode: "blocking", fill: { capability: "ticket.final_approve" } },
      { kind: "c", label: "", mode: "notify_only", fill: { roles: ["Viewer"] } },
      { kind: "d", label: "", mode: "blocking", fill: { roles: ["Viewer"] } },
      { kind: "e", label: "", mode: "blocking", fill: { users: ["u-1"] } },
    ] } as never);
    expect(drafts.map((d) => assuranceOptInFor(d))).toEqual(["none", "engineering", "none", "offer", "offer"]);
    expect(drafts.map((d) => preauthOptInFor(d))).toEqual(["none", "none", "none", "offer", "offer"]);
  });
});

// ── DF-P22 follow-up: the released grantor's alert ──────────────────────────
describe("DF-P22 follow-up — a released grantor's 'review opened' alert is retired (as rosterReleased does)", () => {
  const T = "t-1";
  // A stand-in that reads JSON-path filters the way PostgREST does
  // (metadata->>key), recording every call.
  const db = () => {
    const s = { rows: [
      { id: "n-open", org_id: "o-1", resource_id: T, user_id: "g-1", read_at: null, metadata: { action: "submit_draft", status: "PENDING_REVIEW" } },
      { id: "n-sla", org_id: "o-1", resource_id: T, user_id: "g-1", read_at: null, metadata: { action: "sla_breach" } },
      { id: "n-read", org_id: "o-1", resource_id: T, user_id: "g-1", read_at: "2026-10-22T07:00:00Z", metadata: { action: "submit_draft" } },
      { id: "n-other", org_id: "o-1", resource_id: T, user_id: "u-2", read_at: null, metadata: { action: "submit_draft" } },
      { id: "n-comment", org_id: "o-1", resource_id: T, user_id: "g-1", read_at: null, metadata: {} },
    ] as Array<Record<string, unknown>>, calls: [] as Array<{ method: string; args: unknown[] }>, writes: [] as Array<Record<string, unknown>>, readError: null as null | { message: string } };
    const field = (r: Record<string, unknown>, k: string) => {
      const m = /^(\w+)->>(\w+)$/.exec(k);
      return m ? ((r[m[1]] as Record<string, unknown> | null)?.[m[2]] ?? null) : (r[k] ?? null);
    };
    const client = {
      from: () => {
        const preds: Array<(r: Record<string, unknown>) => boolean> = [];
        let patch: Record<string, unknown> | null = null;
        const q: Record<string, unknown> = {
          select: (...a: unknown[]) => { s.calls.push({ method: "select", args: a }); return q; },
          update: (p: Record<string, unknown>) => { s.calls.push({ method: "update", args: [p] }); patch = p; return q; },
          eq: (k: string, v: unknown) => { preds.push((r) => field(r, k) === v); return q; },
          in: (k: string, v: unknown[]) => { preds.push((r) => v.includes(field(r, k))); return q; },
          is: (k: string, v: unknown) => { preds.push((r) => field(r, k) === v); return q; },
          not: (k: string, _op: string, v: unknown) => { preds.push((r) => field(r, k) !== v); return q; },
          then: (resolve: (x: unknown) => void) => {
            const hit = s.rows.filter((r) => preds.every((p) => p(r)));
            if (patch) { for (const r of hit) Object.assign(r, patch); s.writes.push(patch); return resolve({ data: hit, error: null }); }
            return resolve(s.readError ? { data: null, error: s.readError } : { data: hit.map((r) => ({ ...r })), error: null });
          },
        };
        return q;
      },
    };
    return { s, client: client as never };
  };
  it("marks only the released person's unread workflow alert superseded; the SLA notice, a read row, a comment row and another person's alert are left; read_at never written", async () => {
    const { s, client } = db();
    expect(await retireReleasedAlerts(client, { ticketId: T, orgId: "o-1", released: ["g-1"], at: "2026-10-22T08:00:00.000Z" })).toBeNull();
    const by = (id: string) => s.rows.find((n) => n.id === id)!;
    expect(by("n-open").metadata).toEqual({ action: "submit_draft", status: "PENDING_REVIEW", superseded_at: "2026-10-22T08:00:00.000Z", superseded_by: PREAUTH_RELEASED_SUPERSEDED_BY });
    for (const id of ["n-sla", "n-read", "n-other", "n-comment"]) expect(by(id).metadata, id).not.toHaveProperty("superseded_at");
    expect(s.writes).toHaveLength(1);
    expect(s.writes.every((w) => !("read_at" in w))).toBe(true);
  });
  it("nobody released → no read, no write; a failed read is a note, never a throw", async () => {
    const { s, client } = db();
    expect(await retireReleasedAlerts(client, { ticketId: T, orgId: "o-1", released: [], at: "x" })).toBeNull();
    expect(s.calls).toEqual([]);
    s.readError = { message: "connection lost" };
    expect(await retireReleasedAlerts(client, { ticketId: T, orgId: "o-1", released: ["g-1"], at: "x" })).toBe("connection lost");
  });
  it("the apply step retires the released people's alerts after the request was written, before the 'signed off by your pre-authorization' bell (source pin)", () => {
    const apply = src("lib/ticketPreauthorizationApply.ts");
    const write = apply.indexOf("await db.rpc(PREAUTH_APPLY_RPC");
    const retire = apply.indexOf("await retireReleasedAlerts(db, { ticketId: input.ticketId, orgId: input.orgId, released: [...released], at: nowIso });");
    const bell = apply.indexOf("Signed off by your standing pre-authorization");
    expect(write).toBeGreaterThan(-1);
    expect(write).toBeLessThan(retire);
    expect(retire).toBeLessThan(bell);
  });
});

// ── PROJ-7: the project ↔ request edge ──────────────────────────────────────
describe("PROJ-7 — the project ↔ request edge, from tickets.project_id", () => {
  const rows = () => ({
    ...emptyGraphRows(),
    projects: [{ id: "p1", name: "Turnaround", status: "active" }],
    projectRequests: [
      { id: "t1", ticket_id: "KE-1", title: "Pump iso", status: "DRAFTING", project_id: "p1" },
      { id: "t2", ticket_id: "KE-2", title: "Elsewhere", status: "PENDING_REVIEW", project_id: "p-off-map" },
    ],
  });
  it("a request on a project is a node of the project class (req:<id>, links to the request) with a 'project' edge from its project", () => {
    const g = assembleOrgGraph(rows());
    const node = g.nodes.find((n) => n.id === "req:t1")!;
    expect(node).toMatchObject({ type: "project", label: "KE-1 · Pump iso", href: "/requests/t1" });
    expect(node.sub).toMatch(/^Drafting request · /);
    expect(g.edges).toContainEqual(expect.objectContaining({ a: "proj:p1", b: "req:t1", type: "project", note: "Drafting request on this project" }));
  });
  it("a request whose project is not on the map is not drawn as an edge (and its lone node is pruned like any unlinked project-class node)", () => {
    const g = assembleOrgGraph(rows());
    expect(g.edges.some((e) => e.b === "req:t2")).toBe(false);
    expect(g.nodes.some((n) => n.id === "req:t2")).toBe(false);
  });
  it("REGRESSION: a map with no project requests is exactly the map it was", () => {
    const base = { ...emptyGraphRows(), projects: [{ id: "p1", name: "Turnaround", status: "active" }] };
    expect(JSON.stringify(assembleOrgGraph({ ...base, projectRequests: [] }))).toBe(JSON.stringify(assembleOrgGraph(base)));
  });
  it("the read is the reader's own (client entry only), keyset-paged and capped like every link table; before 20261256 it draws nothing silently (source pin)", () => {
    const g = src("lib/orgGraph.ts");
    expect(g).toContain("const projectRequests = gate === null ? await readProjectRequests(orgId, notes) : [];");
    expect(g).toContain(`pageRows<Row>("tickets", "id, ticket_id, title, status, project_id, archived_at", orgId, EDGE_CAP,`);
    expect(g).toContain("if (!isMissingColumn(r.error)) notes.push(");
    expect(g).toContain('cappedNote("Project request links", r)');
  });
});

// ── GAP-101 acceptance 3: the declaration on the deliverable ────────────────
describe("GAP-101 acceptance 3 — the like-in-kind declaration on the issued deliverable", () => {
  const FINAL = { id: "a-f", type: "Final", rev: "1" } as const;
  const DRAFT = { id: "a-d", type: "Draft", rev: "1A" } as const;
  const decl = { by: "Pat Requester", declaredAt: "2026-10-01T09:30:00.000Z", statement: "Replacing the gasket with an identical one" };
  const plan = (file: typeof FINAL | typeof DRAFT, declaration: unknown) =>
    ticketCopyPlan({ file, ticketNumber: "KE-1", ticketRowId: "t1", origin: "https://app.plant.io", channel: "print",
      live: { status: "PENDING_IFC", deliverableRev: "1", history: [], revisionCount: 0, declaration: declaration as never } });
  it("a deliverable of a declared request names it, attributed, beside the request reference", () => {
    expect(plan(FINAL, decl).footerNotice).toBe(
      'This file is KE-1 (declared like-in-kind by Pat Requester on 2026-10-01: "Replacing the gasket with an identical one") deliverable Rev 1 — not a controlled document revision — scan the QR to confirm it is still the latest.',
    );
  });
  it("REGRESSION: no declaration (or a database before 20261250) → the footer exactly as before; a review Draft never carries it", () => {
    const before = plan(FINAL, undefined).footerNotice;
    expect(before).toBe("This file is KE-1 deliverable Rev 1 — not a controlled document revision — scan the QR to confirm it is still the latest.");
    expect(plan(FINAL, null).footerNotice).toBe(before);
    expect(plan(DRAFT, decl).footerNotice).toBe(plan(DRAFT, undefined).footerNotice);
  });
  it("a declaration that could not be read is said, never guessed; the confirm messages name only the request", () => {
    expect(plan(FINAL, "unavailable").footerNotice).toContain(`KE-1 (${DECLARATION_NOT_AVAILABLE}) deliverable Rev 1`);
    expect(declarationFooterClause({ by: null, declaredAt: null, statement: null })).toBe(" (declared like-in-kind by the requester)");
    const long = declarationFooterClause({ by: "P", declaredAt: "2026-10-01T00:00:00Z", statement: "x — ".repeat(80) });
    expect(long).not.toContain(" — ");
    expect(long.length).toBeLessThan(DECLARATION_FOOTER_MAX + 80);
  });
  it("the server copy route reads the declaration with the row, and any failure of that read falls back to the row as before (never a 503 for it); the page passes the ticket's own (source pins)", () => {
    const route = src("app/api/tickets/copy/route.ts");
    expect(route).toContain("let { data: row, error: rowErr } = await read(true, true);");
    expect(route).toContain('declarationRead = isMissingDeclarationColumn(rowErr) ? "absent" : "unavailable";');
    expect(route).toContain("({ data: row, error: rowErr } = await read(withGuard));");
    const page = src("app/(protected)/requests/[id]/page.tsx");
    // DF-P23 fix pass: the page passes the ticket's own through copyDeclarationFacts (dfRoundG_P23_copyDeclaration.test.ts)
    expect(page).toContain("declaredAt: ticket.likeInKindDeclaredAt ?? null, statement: ticket.likeInKindStatement");
  });
});
