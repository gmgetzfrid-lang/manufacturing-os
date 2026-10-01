// projects Round G — J2b QUALITY-SIGNOFF-AUTHORITY (projects-and-cost QUAL-4).
//
//   dw1  a discipline reviewer is GRANTED write authority on one project's
//        quality records — `quality.sign_off`, scoped by the capability
//        policy's resource dimension (projectId, DEC-13) — without being made
//        a controller or the owner, and never by naming a role in code
//        (DEC-35). The SQL evaluator (20261136) reads the same key.
//   dw2  the author of a checklist (the creator of a turnover item) cannot
//        sign it off while another eligible signer exists; with nobody else
//        it is allowed and MARKED single-signer (DEC-12 / DEC-37) — checked
//        in the lib, enforced by 20261136's rails.
//   dw3  a sign-off carries a bound identity: an e_signatures row minted by
//        the ceremony's server half (20261050), resource-addressed to the
//        checklist / turnover item, which the database binds to the record.
//   dw4  the Quality tab draws its write controls from the database's
//        decision (quality_signoff_status), not from a role list.
//
// 20261136 was also run end to end against a scratch PostgreSQL 16 cluster
// (stub schema; the real 20260720 / 20261050 / 20261013 quality block /
// 20261091 / 20261102 member reads / 20261125 is_org_controller_for /
// 20261132; then 20261136 twice): every probe true, the apply-order guard
// refusing before 20261132, and 27 signed-in scenarios — the author refused
// with others eligible, a Safety member granted on one project writing that
// project and not another, unsigned / someone-else's / pre-reopen signatures
// refused, the sole signer marked, no item born accepted, a private project
// closed to a non-member grantee, controllers and owners unchanged, anon
// refused the evaluator. These pins keep the file from drifting from that run.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resetState, type MemoryState } from "./helpers/memoryDb";

const state = vi.hoisted<MemoryState>(() => ({
  tables: {}, calls: [], writes: [], refuse: false, writeError: null, readError: {}, nextId: 1,
}));
vi.mock("@/lib/supabase", async () => {
  const { makeSupabase } = await import("./helpers/memoryDb");
  return { supabase: makeSupabase(state) };
});
const ceremony = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>>, fail: null as string | null }));
vi.mock("@/lib/eSignatures", () => ({
  recordSignature: async (input: Record<string, unknown>) => {
    if (ceremony.fail) throw new Error(ceremony.fail);
    ceremony.calls.push(input);
    return { id: `sig-${ceremony.calls.length}`, ...input };
  },
}));

import {
  CAPABILITY_DEFS, RESOURCE_KEYS, policyAllows, validateCapabilityPolicy, type CapabilityPolicy,
} from "@/lib/capabilityPolicy";
import {
  loadSignoffAuthority, setChecklistStatus, signoffSeparation, QUALITY_SIGNOFF_INTENT, QUALITY_SIGNOFF_RESOURCE,
  type Checklist,
} from "@/lib/checklists";
import { reviewTurnoverItem, type TurnoverItem } from "@/lib/turnover";

const root = process.cwd();
const migDir = join(root, "supabase", "migrations");
const read = (f: string) => readFileSync(join(migDir, f), "utf8");
const src = (f: string) => readFileSync(join(root, f), "utf8");
const numbered = readdirSync(migDir).filter((f) => /^\d{8}/.test(f) && f.endsWith(".sql")).sort();
const M136 = "20261136_prj_roundG_quality_signoff.sql";
const m136 = read(M136);
const m132 = read("20261132_dc_roundF_transmit_capability.sql");
const m91 = read("20261091_prj_roundG_quality_rails.sql");
const m13 = read("20261013_project_controls_program.sql");

const OW = "u-owner", ADMIN = "u-admin", SAFETY = "u-safety";
const actorOf = (uid: string) => ({ uid, email: `${uid}@plant.io` });
const signoff = { statement: "I verified this checklist complete", signerName: "Sam Safety", reauth: { method: "password" as const, password: "pw" } };
const audits = () => state.writes.filter((w) => w.table === "audit_logs").map((w) => w.payload as { action: string; details: Record<string, unknown> });

beforeEach(() => {
  resetState(state);
  ceremony.calls = []; ceremony.fail = null;
});

// ── dw1: the capability, per project ───────────────────────────────────────
describe("quality.sign_off — the capability (dw1, DEC-13 / DEC-35)", () => {
  const def = CAPABILITY_DEFS.find((d) => d.id === "quality.sign_off");

  it("exists in the Quality area with today's writers as its default (the controller pair; the owner is identity, not a token), and is not critical", () => {
    expect(def).toBeDefined();
    expect(def!.area).toBe("Quality");
    expect(def!.defaultRoles).toEqual(["Admin", "DocCtrl"]);
    expect(def!.critical).toBeUndefined();
  });

  it("projectId is a resource key, so a rule can name one project (and the policy validates)", () => {
    expect(RESOURCE_KEYS).toContain("projectId");
    const policy: CapabilityPolicy = { caps: { "quality.sign_off": [{ tokens: ["Admin", "DocCtrl"] }, { tokens: ["Admin", "DocCtrl", "Safety"], when: { projectId: ["p1"] } }] } };
    expect(validateCapabilityPolicy(policy)).toBeNull();
  });

  it("a Safety-role member granted the capability on one project may sign off that project's records and no other", () => {
    const policy: CapabilityPolicy = { caps: { "quality.sign_off": [{ tokens: ["Admin", "DocCtrl"] }, { tokens: ["Admin", "DocCtrl", "Safety"], when: { projectId: ["p1"] } }] } };
    expect(policyAllows(policy, "quality.sign_off", "Safety", ["Safety"], SAFETY, { projectId: "p1" })).toBe(true);
    expect(policyAllows(policy, "quality.sign_off", "Safety", ["Safety"], SAFETY, { projectId: "p2" })).toBe(false);
    expect(policyAllows(policy, "quality.sign_off", "Safety", ["Safety"], SAFETY)).toBe(false);
    // an unconfigured org: the controller pair only (no role widened)
    expect(policyAllows({}, "quality.sign_off", "Safety", ["Safety"], SAFETY, { projectId: "p1" })).toBe(false);
    expect(policyAllows({}, "quality.sign_off", "Manager", ["Manager", "DocCtrl"], ADMIN, { projectId: "p1" })).toBe(true);
    // a personal grant is org-wide (WF-13 row 6) — every project the person can see
    expect(policyAllows({ grants: [{ cap: "quality.sign_off", uid: SAFETY }] }, "quality.sign_off", "Safety", ["Safety"], SAFETY, { projectId: "p2" })).toBe(true);
  });

  it("DEC-35: the quality layer names no facility role — the grant is data", () => {
    const code = (f: string) => src(f).replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const f of ["lib/checklists.ts", "lib/turnover.ts", "components/projects/QualityTab.tsx"]) {
      expect(code(f), f).not.toMatch(/["'](Safety|Operations|Maintenance|Engineer(-\d)?|Admin|DocCtrl)["']/);
    }
  });
});

// ── dw2: separation of duties, derived from the eligible count ─────────────
describe("signoffSeparation — DEC-12 / DEC-37 per slot (dw2)", () => {
  it("the author with another eligible signer is blocked, with the reason; alone, allowed and marked; anyone else, free", () => {
    expect(signoffSeparation(OW, OW, 2, "checklist")).toEqual({ blocked: true, singleSigner: false, reason: "You created this checklist, so a second person signs it off — 2 other eligible signers on this project." });
    expect(signoffSeparation(OW, OW, 1, "turnover").reason).toBe("You added this turnover item, so a second person accepts it — 1 other eligible signer on this project.");
    expect(signoffSeparation(OW, OW, 0, "checklist")).toEqual({ blocked: false, singleSigner: true, reason: null });
    expect(signoffSeparation(OW, SAFETY, 5, "checklist")).toEqual({ blocked: false, singleSigner: false, reason: null });
    expect(signoffSeparation(null, OW, 5, "checklist")).toEqual({ blocked: false, singleSigner: false, reason: null });
  });
});

describe("loadSignoffAuthority — the database's decision, fail-closed (dw4 / DEC-16)", () => {
  it("reads quality_signoff_status (20261136) for the project", async () => {
    state.rpc = { quality_signoff_status: (args) => ({ data: args.p_project === "p1" ? { maySign: true, otherSigners: 3 } : null, error: null }) };
    expect(await loadSignoffAuthority("o1", "p1", actorOf(SAFETY))).toEqual({ maySign: true, otherSigners: 3, source: "database" });
    // a project the caller cannot see: NULL — no
    expect(await loadSignoffAuthority("o1", "p9", actorOf(SAFETY))).toEqual({ maySign: false, otherSigners: 0, source: "database" });
  });
  it("before 20261136 (no such function) the answer is the controller tier and the active project owner — the writers the policies admit then", async () => {
    state.tables.org_members = [
      { org_id: "o1", uid: ADMIN, role: "Manager", roles: ["Manager", "DocCtrl"], status: "active" },
      { org_id: "o1", uid: OW, role: "Engineer-1", roles: ["Engineer-1"], status: "active" },
      { org_id: "o1", uid: SAFETY, role: "Safety", roles: ["Safety"], status: "active" },
    ];
    state.tables.projects = [{ id: "p1", owner_user_id: OW }];
    expect(await loadSignoffAuthority("o1", "p1", actorOf(OW))).toEqual({ maySign: true, otherSigners: 1, source: "fallback" });
    expect(await loadSignoffAuthority("o1", "p1", actorOf(SAFETY))).toEqual({ maySign: false, otherSigners: 2, source: "fallback" });
  });
  it("an rpc error that is not a missing function is an error, never a yes", async () => {
    state.rpc = { quality_signoff_status: () => ({ data: null, error: { message: "upstream timeout", code: "PGRST000" } }) };
    const a = await loadSignoffAuthority("o1", "p1", actorOf(SAFETY));
    expect(a.maySign).toBe(false);
    expect(a.error).toMatch(/upstream timeout/);
  });
  it("a failed fallback read is an error too", async () => {
    state.readError.org_members = { message: "permission denied", code: "42501" };
    const a = await loadSignoffAuthority("o1", "p1", actorOf(OW));
    expect(a).toMatchObject({ maySign: false, source: "fallback" });
    expect(a.error).toMatch(/permission/);
  });
});

// ── the completion: separation + the signed sign-off (dw2 / dw3) ───────────
const checklist = (over: Partial<Checklist> = {}): Checklist => ({
  id: "cl1", orgId: "o1", projectId: "p1", title: "PSSR", kind: "pssr", sourceDocumentId: null,
  status: "open", completedBasis: null, createdAt: null, createdByName: null, createdBy: OW, ...over,
});
const seedChecklist = () => {
  state.tables.project_checklists = [{ id: "cl1", org_id: "o1", project_id: "p1", status: "open", created_by: OW }];
  state.tables.checklist_items = [{
    id: "i1", org_id: "o1", checklist_id: "cl1", seq: 1, section: null, text: "Hydrotest complete with records",
    applicability: "applies", status: "satisfied", evidence: [], ai_rationale: null,
    manual_note: "Hydro chart reviewed: 150 psig held 30 min", updated_at: "2026-09-01T00:00:00Z", updated_by: SAFETY, updated_by_name: "safety",
  }];
  state.tables.projects = [{ id: "p1", intake_collection_id: null, sow_document_id: null, owner_user_id: OW }];
  state.tables.turnover_items = []; state.tables.assets = [];
};

describe("setChecklistStatus('complete') — QUAL-4", () => {
  beforeEach(seedChecklist);

  it("dw2: the owner who created it cannot complete it while a second signer exists — no signature minted, nothing written, nothing audited", async () => {
    state.rpc = { quality_signoff_status: () => ({ data: { maySign: true, otherSigners: 2 }, error: null }) };
    const res = await setChecklistStatus({ orgId: "o1", projectId: "p1", checklist: checklist(), status: "complete", actor: actorOf(OW), signoff });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("You created this checklist, so a second person signs it off — 2 other eligible signers on this project.");
    expect(ceremony.calls).toHaveLength(0);
    expect(state.writes.filter((w) => w.table === "project_checklists")).toHaveLength(0);
    expect(audits()).toHaveLength(0);
  });

  it("dw2 before 20261136: the same refusal from the fallback (an active controller exists)", async () => {
    state.tables.org_members = [
      { org_id: "o1", uid: ADMIN, role: "Admin", roles: ["Admin"], status: "active" },
      { org_id: "o1", uid: OW, role: "Engineer-1", roles: ["Engineer-1"], status: "active" },
    ];
    const res = await setChecklistStatus({ orgId: "o1", projectId: "p1", checklist: checklist(), status: "complete", actor: actorOf(OW), signoff });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/a second person signs it off — 1 other eligible signer/);
  });

  it("dw2: with nobody else eligible the author completes — signed, and the audit row is marked single-signer", async () => {
    state.rpc = { quality_signoff_status: () => ({ data: { maySign: true, otherSigners: 0 }, error: null }) };
    const res = await setChecklistStatus({ orgId: "o1", projectId: "p1", checklist: checklist(), status: "complete", actor: actorOf(OW), signoff });
    expect(res.ok).toBe(true);
    expect(state.tables.project_checklists[0].status).toBe("complete");
    const a = audits().at(-1)!;
    expect(a.action).toBe("CHECKLIST_STATUS");
    expect(a.details).toMatchObject({ signatureId: "sig-1", singleSigner: true });
  });

  it("dw3: a second person's completion mints THEIR e-signature on THIS checklist first (ceremony output, resource-addressed), then writes the status only", async () => {
    const res = await setChecklistStatus({ orgId: "o1", projectId: "p1", checklist: checklist(), status: "complete", actor: actorOf(SAFETY), signoff });
    expect(res.ok).toBe(true);
    expect(ceremony.calls).toEqual([expect.objectContaining({
      orgId: "o1", resourceType: QUALITY_SIGNOFF_RESOURCE.checklist, resourceId: "cl1",
      intent: QUALITY_SIGNOFF_INTENT, statement: signoff.statement, signerUserId: SAFETY, reauth: signoff.reauth,
    })]);
    expect(QUALITY_SIGNOFF_RESOURCE.checklist).toBe("project_checklist");
    // not the author: the separation count is never read
    expect(state.calls.some((c) => c.table === "rpc:quality_signoff_status")).toBe(false);
    expect(state.writes.filter((w) => w.table === "project_checklists").map((w) => w.payload)).toEqual([{ status: "complete" }]);
    expect(audits().at(-1)!.details).toMatchObject({ signatureId: "sig-1", singleSigner: false });
  });

  it("the single-signer marker the database recorded wins over the lib's reading", async () => {
    state.afterWrite = (table, method, rows) => { if (table === "project_checklists" && method === "update") for (const r of rows) r.completed_single_signer = true; };
    await setChecklistStatus({ orgId: "o1", projectId: "p1", checklist: checklist({ createdBy: ADMIN }), status: "complete", actor: actorOf(SAFETY), signoff });
    expect(audits().at(-1)!.details).toMatchObject({ singleSigner: true });
  });

  it("dw3: no ceremony output, no completion — and a ceremony that fails (wrong password) completes nothing", async () => {
    const none = await setChecklistStatus({ orgId: "o1", projectId: "p1", checklist: checklist(), status: "complete", actor: actorOf(SAFETY) });
    expect(none.ok).toBe(false);
    expect(none.error).toMatch(/signed: confirm the statement with your e-signature/);
    ceremony.fail = "That password doesn't match — signature not applied.";
    const bad = await setChecklistStatus({ orgId: "o1", projectId: "p1", checklist: checklist(), status: "complete", actor: actorOf(SAFETY), signoff });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/Your signature wasn't recorded, so nothing was signed off: That password doesn't match/);
    expect(state.writes.filter((w) => w.table === "project_checklists")).toHaveLength(0);
    expect(audits()).toHaveLength(0);
  });

  it("DEC-16: an unreadable separation decision keeps the author's checklist open", async () => {
    state.rpc = { quality_signoff_status: () => ({ data: null, error: { message: "upstream timeout", code: "PGRST000" } }) };
    const res = await setChecklistStatus({ orgId: "o1", projectId: "p1", checklist: checklist(), status: "complete", actor: actorOf(OW), signoff });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Couldn't check who else can sign this checklist off \(upstream timeout\) — it stays open/);
    expect(ceremony.calls).toHaveLength(0);
  });

  it("reopen / void need no signature (only a completion is a sign-off)", async () => {
    for (const status of ["open", "void"] as const) {
      expect((await setChecklistStatus({ orgId: "o1", projectId: "p1", checklist: checklist(), status, actor: actorOf(OW) })).ok).toBe(true);
    }
    expect(ceremony.calls).toHaveLength(0);
  });
});

// ── the turnover acceptance ────────────────────────────────────────────────
const titem = (over: Partial<TurnoverItem> = {}): TurnoverItem => ({
  id: "t1", orgId: "o1", projectId: "p1", partyId: null, name: "NDE reports", description: null,
  required: true, status: "received", documentId: null, reviewedAt: null, reviewedByName: null, reviewNote: null,
  createdAt: null, createdBy: OW, ...over,
});

describe("reviewTurnoverItem('accepted') — QUAL-4", () => {
  beforeEach(() => {
    state.tables.turnover_items = [{ id: "t1", org_id: "o1", project_id: "p1", name: "NDE reports", status: "received", created_by: OW }];
  });

  it("dw2: whoever added the item cannot accept it while a second signer exists", async () => {
    state.rpc = { quality_signoff_status: () => ({ data: { maySign: true, otherSigners: 1 }, error: null }) };
    const res = await reviewTurnoverItem({ item: titem(), status: "accepted", actor: actorOf(OW), signoff });
    expect(res).toEqual({ ok: false, error: "You added this turnover item, so a second person accepts it — 1 other eligible signer on this project." });
    expect(ceremony.calls).toHaveLength(0);
    expect(state.tables.turnover_items[0].status).toBe("received");
  });

  it("dw3: the acceptor's e-signature on THIS item is minted first; the audit row names it", async () => {
    const res = await reviewTurnoverItem({ item: titem(), status: "accepted", documentId: "doc-nde", actor: actorOf(SAFETY), signoff });
    expect(res).toEqual({ ok: true });
    expect(ceremony.calls).toEqual([expect.objectContaining({ resourceType: "turnover_item", resourceId: "t1", intent: "Reviewed", signerUserId: SAFETY })]);
    expect(state.tables.turnover_items[0]).toMatchObject({ status: "accepted", document_id: "doc-nde", reviewed_by: SAFETY });
    expect(audits().at(-1)!.details).toMatchObject({ signatureId: "sig-1", singleSigner: false });
  });

  it("dw3: an unsigned acceptance is refused; received / rejected / waived are not sign-offs and mint nothing", async () => {
    expect((await reviewTurnoverItem({ item: titem(), status: "accepted", actor: actorOf(SAFETY) })).ok).toBe(false);
    expect((await reviewTurnoverItem({ item: titem({ status: "open" }), status: "received", actor: actorOf(OW) })).ok).toBe(true);
    expect((await reviewTurnoverItem({ item: titem(), status: "rejected", note: "Two RT films are unreadable at the root", actor: actorOf(OW) })).ok).toBe(true);
    expect(ceremony.calls).toHaveLength(0);
  });

  it("dw2: alone on the project, the creator accepts — marked single-signer", async () => {
    state.rpc = { quality_signoff_status: () => ({ data: { maySign: true, otherSigners: 0 }, error: null }) };
    expect((await reviewTurnoverItem({ item: titem(), status: "accepted", actor: actorOf(OW), signoff })).ok).toBe(true);
    expect(audits().at(-1)!.details).toMatchObject({ singleSigner: true });
  });
});

// ── 20261136: the one paste ────────────────────────────────────────────────
function fnBody(text: string, header: string): string {
  const a = text.indexOf(header);
  expect(a, `function not found: ${header}`).toBeGreaterThanOrEqual(0);
  return text.slice(a, text.indexOf("$$;", text.indexOf("AS $$", a) + 5) + 3);
}
function lineDiff(a: string, b: string) {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}
function policy(text: string, name: string): string {
  const a = text.indexOf(`CREATE POLICY ${name} ON`);
  expect(a, `policy not found: ${name}`).toBeGreaterThanOrEqual(0);
  return text.slice(a, text.indexOf(";", a) + 1);
}
const codeOnly = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/'(?:[^']|'')*'/g, "''");
const tail = m136.slice(m136.indexOf("\nCOMMIT;") + "\nCOMMIT;".length);

describe("20261136 — one paste (DEC-30)", () => {
  it("apply-order guard and the TEMP inventory run BEFORE the transaction; one BEGIN / COMMIT; ONE final SELECT", () => {
    const begin = m136.indexOf("\nBEGIN;");
    expect(m136.indexOf("RAISE EXCEPTION 'Apply 20261091_prj_roundG_quality_rails.sql first")).toBeLessThan(begin);
    expect(m136.indexOf("RAISE EXCEPTION 'Apply 20261132_dc_roundF_transmit_capability.sql first")).toBeLessThan(begin);
    expect(m136.indexOf("RAISE EXCEPTION 'Apply 20261125_intel_roundG_skills_authority.sql first")).toBeLessThan(begin);
    expect(m136.indexOf("CREATE TEMP TABLE prj_roundg_signoff_before AS")).toBeLessThan(begin);
    expect(m136.indexOf("DO $$")).toBeLessThan(m136.indexOf("CREATE TEMP TABLE prj_roundg_signoff_before AS"));
    expect((m136.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((m136.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
    expect((codeOnly(tail).match(/;/g) ?? []).length).toBe(1);
    expect(codeOnly(tail)).not.toMatch(/\b(UPDATE|INSERT|DELETE|ALTER|DROP|CREATE|GRANT|REVOKE)\b/);
  });
  it("the result set's shape is (check, ok, n): probes carry ok, inventory rows carry n; aggregate counts only, never rows", () => {
    expect(tail).toMatch(/AS check,\s*\n[\s\S]*?AS ok,\s*\n\s*NULL::text AS n/);
    expect(tail).toContain("SELECT label, NULL::boolean, n FROM prj_roundg_signoff_before");
    expect(tail).not.toMatch(/SELECT \*|SELECT data\b|SELECT uid\b|SELECT email/);
    const inventory = m136.slice(m136.indexOf("CREATE TEMP TABLE prj_roundg_signoff_before AS"), m136.indexOf("\nBEGIN;"));
    expect(inventory).not.toMatch(/SELECT \*/);
    expect((inventory.match(/COUNT\(\*\)/g) ?? []).length).toBeGreaterThanOrEqual(9);
  });
  it("carries the DEC-30 informational counts the plan names: self-completed checklists, owner-accepted turnover on projects with other members", () => {
    expect(m136).toContain("completed checklists whose completion audit row names their own author");
    expect(m136).toContain("accepted turnover items whose reviewer is the project owner, on projects whose org has other active members");
    expect(m136).toContain("stored capability rules conditioned on a projectId (expect 0");
  });
});

describe("20261136 — org_capability_allows_for re-created from 20261132 (lineDiff)", () => {
  const H = "CREATE OR REPLACE FUNCTION org_capability_allows_for";
  const fn132 = fnBody(m132, H);
  const fn136 = fnBody(m136, H);
  const OLD_KEYS = "ARRAY['requestType', 'unit', 'libraryId', 'discipline']";
  const NEW_KEYS = `ARRAY[${RESOURCE_KEYS.map((k) => `'${k}'`).join(", ")}]`;
  const ADDED = `      WHEN 'quality.sign_off'         THEN '["Admin","DocCtrl"]'::jsonb`;

  it("starts from the NEWEST definition: 20261132 was the last file to re-create the evaluator, and this is the newest now", () => {
    const definers = numbered.filter((f) => read(f).includes(`${H}(`));
    expect(definers.slice(-2)).toEqual(["20261132_dc_roundF_transmit_capability.sql", M136]);
  });
  it("is the 20261132 body with the two key lists widened by projectId and ONE CASE row — nothing else changed", () => {
    const { onlyInA, onlyInB } = lineDiff(fn132, fn136);
    expect(onlyInA.map((l) => l.trim())).toEqual([`FOREACH v_key IN ARRAY ${OLD_KEYS} LOOP`, `FOREACH v_key IN ARRAY ${OLD_KEYS} LOOP`]);
    expect(onlyInB.map((l) => l.trim())).toEqual([`FOREACH v_key IN ARRAY ${NEW_KEYS} LOOP`, `FOREACH v_key IN ARRAY ${NEW_KEYS} LOOP`, ADDED.trim()]);
    expect(fn136.split("\n").length).toBe(fn132.split("\n").length + 1);
    // exactly: the old body with the key list replaced and the row inserted after transmittal.issue
    const expected = fn132.split(OLD_KEYS).join(NEW_KEYS)
      .replace(`      WHEN 'transmittal.issue'        THEN '["Admin","DocCtrl"]'::jsonb\n`, `      WHEN 'transmittal.issue'        THEN '["Admin","DocCtrl"]'::jsonb\n${ADDED}\n`);
    expect(fn136).toBe(expected);
    expect(fn136.split(NEW_KEYS).length - 1).toBe(2);
  });
  it("the live CASE mirrors CAPABILITY_DEFS exactly (every id, same defaults, same count)", () => {
    const caseBlock = fn136.slice(fn136.indexOf("v_tokens := CASE p_cap"), fn136.indexOf("END;", fn136.indexOf("v_tokens := CASE p_cap")));
    const sql = new Map<string, string[]>();
    for (const m of caseBlock.matchAll(/WHEN '([^']+)'\s+THEN '(\[[^\]]*\])'::jsonb/g)) sql.set(m[1], JSON.parse(m[2]) as string[]);
    for (const d of CAPABILITY_DEFS) expect(sql.get(d.id), d.id).toEqual(d.defaultRoles);
    expect(sql.size).toBe(CAPABILITY_DEFS.length);
  });
  it("revokes EXECUTE from PUBLIC and anon, grants authenticated and service_role; the wrapper is untouched", () => {
    expect(m136).toContain("REVOKE ALL ON FUNCTION org_capability_allows_for(uuid, text, uuid, jsonb) FROM PUBLIC;");
    expect(m136).toContain("REVOKE ALL ON FUNCTION org_capability_allows_for(uuid, text, uuid, jsonb) FROM anon;");
    expect(m136).toContain("GRANT EXECUTE ON FUNCTION org_capability_allows_for(uuid, text, uuid, jsonb) TO authenticated, service_role;");
    expect(m136).not.toMatch(/CREATE OR REPLACE FUNCTION org_capability_allows\(/);
    expect(m136).not.toMatch(/DROP FUNCTION/);
  });
});

describe("20261136 — the four write policies: replaced, newest body + one disjunct (DRLS-1)", () => {
  const OWNER = "user_owns_project(project_id))";
  const OWNER_OR = "user_owns_project(project_id) OR quality_signoff_granted(org_id, project_id))";

  it("project_checklists_write = 20261091's body with the disjunct on USING and WITH CHECK", () => {
    const base = policy(m91, "project_checklists_write");
    expect(policy(m136, "project_checklists_write")).toBe(base.split(OWNER).join(OWNER_OR));
    expect(base.split(OWNER).length - 1).toBe(2);
  });
  it("checklist_items_write = 20261091's body with the disjunct inside the checklist lookup, on USING and WITH CHECK", () => {
    const base = policy(m91, "checklist_items_write");
    const before = "AND user_owns_project(c.project_id)))";
    const after = "AND (user_owns_project(c.project_id) OR quality_signoff_granted(c.org_id, c.project_id))))";
    expect(base.split(before).length - 1).toBe(2);
    expect(policy(m136, "checklist_items_write")).toBe(base.split(before).join(after));
  });
  it("turnover_items_write / punch_items_write = 20261013's bodies (their newest) with the disjunct", () => {
    for (const name of ["turnover_items_write", "punch_items_write"]) {
      const base = policy(m13, name);
      expect(base.split(OWNER).length - 1, name).toBe(2);
      expect(policy(m136, name), name).toBe(base.split(OWNER).join(OWNER_OR));
    }
  });
  it("each is DROPped and re-created under its own name — no second permissive policy beside it; 20261136 is the newest definition of all four", () => {
    for (const name of ["project_checklists_write", "checklist_items_write", "turnover_items_write", "punch_items_write"]) {
      const table = name.replace(/_write$/, "");
      expect(m136.indexOf(`DROP POLICY IF EXISTS ${name} ON ${table};`), name).toBeLessThan(m136.indexOf(`CREATE POLICY ${name} ON ${table} FOR ALL`));
      const definers = numbered.filter((f) => new RegExp(`CREATE POLICY ${name}\\b`).test(read(f)));
      expect(definers.at(-1), name).toBe(M136);
    }
    expect((codeOnly(m136).match(/CREATE POLICY/g) ?? []).length).toBe(4);
  });
});

describe("20261136 — the sign-off helpers and rails", () => {
  const helpers = ["quality_signoff_granted_for", "quality_signoff_granted", "quality_signer_eligible", "quality_other_signers", "quality_signoff_status"];

  it("every helper is SECURITY DEFINER with search_path pinned, and EXECUTE is revoked from PUBLIC and anon", () => {
    for (const h of helpers) {
      const body = fnBody(m136, `CREATE OR REPLACE FUNCTION ${h}(`);
      expect(body, h).toMatch(/LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public/);
      expect(m136, h).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${h}\\([^)]*\\) FROM PUBLIC;`));
      expect(m136, h).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${h}\\([^)]*\\) FROM anon;`));
    }
    // the per-uid helpers answer for ANY uid: no client may call them
    for (const h of ["quality_signoff_granted_for", "quality_signer_eligible", "quality_other_signers"]) {
      expect(m136, h).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${h}\\([^)]*\\) FROM authenticated;`));
      expect(m136, h).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${h}\\([^)]*\\) TO service_role;`));
    }
    for (const h of ["quality_signoff_granted", "quality_signoff_status"]) {
      expect(m136, h).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${h}\\([^)]*\\) TO authenticated, service_role;`));
    }
  });
  it("the grant is per project, through the evaluator, and never opens a private project the grantee cannot see (SEC-2)", () => {
    const g = fnBody(m136, "CREATE OR REPLACE FUNCTION quality_signoff_granted_for(");
    expect(g).toContain("org_capability_allows_for(p_org, 'quality.sign_off', p_uid, jsonb_build_object('projectId', p_project::text))");
    expect(g).toContain("p.visibility IS DISTINCT FROM 'private'");
    expect(g).toContain("FROM project_members pm");
    expect(fnBody(m136, "CREATE OR REPLACE FUNCTION quality_signoff_granted(")).toContain("quality_signoff_granted_for(p_org, p_project, auth.uid())");
    const e = fnBody(m136, "CREATE OR REPLACE FUNCTION quality_signer_eligible(");
    expect(e).toContain("is_org_controller_for(p_org, p_uid)");
    expect(e).toContain("p.owner_user_id::text = p_uid::text");
    expect(e).toContain("m.status = 'active'");
    expect(fnBody(m136, "CREATE OR REPLACE FUNCTION quality_other_signers(")).toContain("m.uid IS DISTINCT FROM p_uid");
    expect(fnBody(m136, "CREATE OR REPLACE FUNCTION quality_signoff_status(")).toContain("project_visible_to_me(p.id)");
  });
  it("the checklist rail: author stamped at insert and never rewritten; self-completion refused while others can sign, else marked; a fresh signature on THIS checklist, newer than its last status change", () => {
    const r = fnBody(m136, "CREATE OR REPLACE FUNCTION project_checklists_signoff_rail()");
    expect(r).toMatch(/RETURNS trigger\nLANGUAGE plpgsql\nSECURITY DEFINER SET search_path = public/);
    expect(r).toContain("IF v_uid IS NULL THEN RETURN NEW; END IF;");
    expect(r).toContain("NEW.created_by := v_uid;");
    expect(r).toContain("IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN");
    expect(r).toContain("v_others := quality_other_signers(NEW.org_id, NEW.project_id, v_uid);");
    expect(r).toContain(`AND e.resource_type = '${QUALITY_SIGNOFF_RESOURCE.checklist}'`);
    expect(r).toContain("AND e.signer_user_id = v_uid");
    expect(r).toContain(`AND e.intent IN ('${QUALITY_SIGNOFF_INTENT}', 'Approved')`);
    expect(r).toContain("AND e.signed_at > NOW() - interval '15 minutes'");
    expect(r).toContain("AND e.signed_at > COALESCE(OLD.status_changed_at, '-infinity'::timestamptz)");
    expect(r).toContain("NEW.completed_single_signer := (OLD.created_by IS NOT NULL AND OLD.created_by = v_uid);");
    expect(r).toContain("A completed checklist keeps its sign-off");
  });
  it("the turnover rail: creator stamped and never rewritten; never born accepted; self-acceptance refused while others can sign; a fresh signature on THIS item, newer than its last history row", () => {
    const r = fnBody(m136, "CREATE OR REPLACE FUNCTION turnover_items_signoff_rail()");
    expect(r).toContain("IF v_uid IS NULL THEN RETURN NEW; END IF;");
    expect(r).toContain("never born accepted");
    expect(r).toContain("v_others := quality_other_signers(NEW.org_id, NEW.project_id, v_uid);");
    expect(r).toContain("SELECT max(h.created_at) INTO v_since FROM turnover_review_events h WHERE h.item_id = NEW.id;");
    expect(r).toContain(`AND s.resource_type = '${QUALITY_SIGNOFF_RESOURCE.turnoverItem}'`);
    expect(r).toContain("AND s.signed_at > COALESCE(v_since, '-infinity'::timestamptz)");
    expect(r).toContain("NEW.reviewed_single_signer := (OLD.created_by IS NOT NULL AND OLD.created_by = v_uid);");
  });
  it("the 15-minute window is the ceremony's own freshness window (lib/eSignatures SSO_REAUTH_WINDOW_MS)", () => {
    expect(src("lib/eSignatures.ts")).toContain("export const SSO_REAUTH_WINDOW_MS = 15 * 60 * 1000;");
  });
  it("both rails fire BEFORE INSERT OR UPDATE and sort AFTER J2's rails on the same table (trigger-name order)", () => {
    expect(m136).toContain("CREATE TRIGGER trg_project_checklists_signoff_rail\n  BEFORE INSERT OR UPDATE ON project_checklists");
    expect(m136).toContain("CREATE TRIGGER trg_turnover_items_signoff_rail\n  BEFORE INSERT OR UPDATE ON turnover_items");
    expect("trg_project_checklists_signoff_rail" > "trg_project_checklists_completion_basis").toBe(true);
    expect("trg_project_checklists_signoff_rail" > "trg_project_checklists_org_matches_project").toBe(true);
    expect("trg_turnover_items_signoff_rail" > "trg_turnover_items_decision_rail").toBe(true);
    expect("trg_turnover_items_signoff_rail" > "trg_turnover_items_org_matches_project").toBe(true);
  });
  it("probes cover the evaluator, the policies, the helpers' grants, the columns and both rails", () => {
    for (const label of [
      "the evaluator carries the quality.sign_off default (Admin, DocCtrl) and every earlier default",
      "the evaluator reads five resource keys (projectId added) in both rule passes",
      "anon cannot execute the evaluator; authenticated and service_role can (DRLS-16)",
      "project_checklists_write is the ONLY permissive write policy on project_checklists",
      "checklist_items_write is the ONLY permissive write policy on checklist_items",
      "turnover_items_write is the ONLY permissive write policy on turnover_items",
      "punch_items_write is the ONLY permissive write policy on punch_items",
      "the sign-off record columns exist",
      "both sign-off rails fire BEFORE INSERT OR UPDATE",
    ]) expect(tail, label).toContain(label);
    // deparsed policy text is matched on the function call, never a bare cast
    expect(tail).toContain("qual LIKE '%quality_signoff_granted(org_id, project_id)%'");
    expect(tail).toContain("with_check LIKE '%quality_signoff_granted(c.org_id, c.project_id)%'");
  });
});

// ── dw4: the surface draws its controls from the decision ──────────────────
describe("QualityTab census — controls from the decision (dw4)", () => {
  const tab = src("components/projects/QualityTab.tsx");

  it("reads the database's decision and passes it — never the page's canManage — to every section", () => {
    expect(tab).toContain("void loadSignoffAuthority(orgId, projectId, actor).then((a) => { if (!cancelled) setAuthority(a); });");
    expect(tab).toContain("const canSignOff = authority && !authority.error ? authority.maySign : canManage;");
    const top = tab.slice(tab.indexOf("export default function QualityTab("), tab.indexOf("\nfunction LoadFailed("));
    for (const section of ["ChecklistsSection", "TurnoverSection", "PunchSection"]) {
      const at = top.indexOf(`<${section} `);
      expect(at, section).toBeGreaterThan(0);
      const tag = top.slice(at, top.indexOf("/>", at));
      expect(tag, section).toContain("canManage={canSignOff}");
    }
    // the page's prop is read once: the fallback while the decision loads or cannot be read
    expect(top.match(/canManage=\{canManage\}/g)).toBeNull();
    expect((top.match(/\bcanManage\b(?!=)/g) ?? []).length).toBe(3);   // the destructure, its type, the fallback
  });
  it("Mark complete and turnover Accept go through the signing ceremony and pass its output to the lib", () => {
    expect(tab).toContain('<button onClick={() => setSigning(true)} disabled={busy != null || completeBlocked}');
    expect(tab).toContain("setChecklistStatus({ orgId, projectId, checklist, status: \"complete\", actor, signoff: signed })");
    expect(tab).toContain("setSigningAccept({ item: it, documentId: d.id })");
    expect(tab).toContain("...(signed ? { signoff: signed } : {})");
    expect((tab.match(/<SignatureCeremony/g) ?? []).length).toBe(2);
    expect((tab.match(/lockIntent/g) ?? []).length).toBe(2);
  });
  it("a blocked author sees why (DEC-12: an explanation, not a missing button); a lone signer's sign-off is marked", () => {
    expect(tab).toContain("const separation = signoffSeparation(checklist.createdBy, actor.uid, signoff.otherSigners, \"checklist\");");
    expect(tab).toContain("completeBlocked = progress != null && (progress.total === 0 || blocking > 0 || staleGreens > 0 || separation.blocked)");
    expect(tab).toContain("Accept — needs a second person");
    expect(tab).toContain("single-signer");
    expect(tab).toContain("signed off by {checklist.completedByName}");
  });
});
