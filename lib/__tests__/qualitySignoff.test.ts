// projects Round G — J2b QUALITY-SIGNOFF-AUTHORITY (projects-and-cost QUAL-4).
//
//   dw1  a discipline reviewer is GRANTED write authority on one project's
//        quality records — `quality.sign_off`, scoped by the capability
//        policy's resource dimension (projectId, DEC-13) — without being made
//        a controller or the owner, and never by naming a role in code
//        (DEC-35). The SQL evaluator (20261136) reads the same key.
//   dw2  the author of a checklist (the creator of a turnover item) cannot
//        sign it off — complete it; accept OR waive it, since a waiver clears
//        the item from the package as an acceptance does — while another
//        eligible signer exists; with nobody else it is allowed and MARKED
//        single-signer (DEC-12 / DEC-37) — checked in the lib, enforced by
//        20261136's rails. While the count is unknown the author waits.
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
// refused the evaluator. The review fix re-ran it (all 17 probes true, 54
// scenarios): a creator's waiver refused like an acceptance, a second
// person's signed waiver landing, no item born waived, a required item never
// unmarked, a grantee's delete refused, a signed record or a required item a
// controller's to delete, cascade and purge passing — and the 3-argument
// wrapper still executable by anon, which the probe and the records now say.
// The second review fix re-ran it (18 probes true twice, 50 scenarios): a
// completed checklist voided or reopened only by a controller and a
// once-signed checklist deleted only by one (the void-then-delete gap), no
// checklist or turnover item moved between projects, anon reading 0 rows
// with no error, the capability admitting no controller by token while the
// eligible set still does; the pre-fix file failed 22 of those scenarios.
// These pins keep the file from drifting from those runs.

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
  CAPABILITY_DEFS, PROJECT_SCOPED_CAPS, RESOURCE_KEYS, policyAllows, policyHasProjectScopedRule, validateCapabilityPolicy,
  type CapabilityPolicy,
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

  it("exists in the Quality area, grants nobody by default and is not critical: controllers and the owner are STANDING holders, not tokens a grid could untick", () => {
    expect(def).toBeDefined();
    expect(def!.area).toBe("Quality");
    // the review: with ["Admin","DocCtrl"] as the default, unticking DocCtrl in
    // the permissions grid changed nothing (is_org_controller admits them in
    // every policy) — the row now grants only BEYOND the standing holders
    expect(def!.defaultRoles).toEqual([]);
    expect(def!.critical).toBeUndefined();
    expect(def!.dormant).toBeUndefined();
    // the grid shows the description under the label: the standing holders are said there
    expect(def!.description).toMatch(/^Grants more people what Admin, Document Control and the project owner can always do, whatever this row says/);
  });

  it("projectId is a resource key, so a rule can name one project (and the policy validates)", () => {
    expect(RESOURCE_KEYS).toContain("projectId");
    const policy: CapabilityPolicy = { caps: { "quality.sign_off": [{ tokens: ["Admin", "DocCtrl"] }, { tokens: ["Admin", "DocCtrl", "Safety"], when: { projectId: ["p1"] } }] } };
    expect(validateCapabilityPolicy(policy)).toBeNull();
  });

  // J2b integration: a projectId rule anywhere else never matches in TS — and
  // the evaluator before 20261136 (20261132) reads four keys, so it would read
  // such a rule as UNCONDITIONAL (a widening of whatever it names).
  it("projectId is allowed on quality.sign_off ONLY — a project-scoped rule on any other capability is refused, naming why", () => {
    expect([...PROJECT_SCOPED_CAPS]).toEqual(["quality.sign_off"]);
    expect(validateCapabilityPolicy({ caps: { "quality.sign_off": [{ tokens: ["Safety"], when: { projectId: ["p1"] } }] } })).toBeNull();
    const refused = validateCapabilityPolicy({ caps: { "ticket.assign": [{ tokens: ["Admin"] }, { tokens: ["Admin", "Viewer"], when: { projectId: ["p1"] } }] } });
    expect(refused).toBe('Assign drafters: a rule cannot be scoped to a project — only "Sign off quality records" is decided per project. Anywhere else the rule would never match, and a database without 20261136 would read it as unconditional — applying it everywhere.');
    for (const d of CAPABILITY_DEFS.filter((x) => x.id !== "quality.sign_off")) {
      const tokens = d.critical ? ["Admin"] : ["*"];
      expect(validateCapabilityPolicy({ caps: { [d.id]: [{ tokens, when: { projectId: ["p1"] } }] } }), d.id).toMatch(/a rule cannot be scoped to a project/);
      // combined with another key it is still refused
      expect(validateCapabilityPolicy({ caps: { [d.id]: [{ tokens, when: { requestType: ["ISO"], projectId: ["p1"] } }] } }), d.id).toMatch(/a rule cannot be scoped to a project/);
    }
    // an empty projectId list is no condition (both evaluators skip it) — not refused
    expect(validateCapabilityPolicy({ caps: { "ticket.assign": [{ tokens: ["Admin"], when: { projectId: [] } }] } })).toBeNull();
    // the route's probe trigger
    expect(policyHasProjectScopedRule({ caps: { "quality.sign_off": [{ tokens: ["Safety"], when: { projectId: ["p1"] } }] } })).toBe(true);
    expect(policyHasProjectScopedRule({ caps: { "quality.sign_off": ["Safety"], "ticket.assign": [{ tokens: ["Admin"], when: { requestType: ["ISO"] } }] } })).toBe(false);
    expect(policyHasProjectScopedRule({})).toBe(false);
    expect(policyHasProjectScopedRule(null)).toBe(false);
  });

  it("the policy route refuses to store a project-scoped rule until the live database reads projectId (20261136 probed, fail closed)", () => {
    const route = src("app/api/admin/capability-policy/route.ts");
    expect(route).toContain('const { error } = await supabaseAdmin.rpc("quality_signoff_granted_for", { p_org: orgId, p_project: NIL_UUID, p_uid: NIL_UUID });');
    expect(route).toContain('if (op === "save" && policyHasProjectScopedRule(after)) {');
    // the probe runs after validation (which refuses projectId off the allowlist) and before the write
    expect(route.indexOf("const invalid = validateCapabilityPolicy(after);")).toBeLessThan(route.indexOf("policyHasProjectScopedRule(after)"));
    expect(route.indexOf("policyHasProjectScopedRule(after)")).toBeLessThan(route.indexOf('.from("org_configurations")\n      .update('));
    // the probed function is created inside 20261136's one transaction — with the evaluator that reads projectId
    const begin = m136.indexOf("\nBEGIN;"), commit = m136.indexOf("\nCOMMIT;");
    for (const marker of ["CREATE OR REPLACE FUNCTION quality_signoff_granted_for(", "CREATE OR REPLACE FUNCTION org_capability_allows_for("]) {
      expect(m136.indexOf(marker), marker).toBeGreaterThan(begin);
      expect(m136.indexOf(marker), marker).toBeLessThan(commit);
    }
    expect(m136).toContain("GRANT EXECUTE ON FUNCTION quality_signoff_granted_for(uuid, uuid, uuid) TO service_role;");
    // why the allowlist alone closes the window: before 20261136 nothing in SQL consults quality.sign_off
    const earlier = numbered.filter((f) => f < M136).filter((f) => read(f).includes("'quality.sign_off'"));
    expect(earlier).toEqual([]);
  });

  it("a Safety-role member granted the capability on one project may sign off that project's records and no other", () => {
    const policy: CapabilityPolicy = { caps: { "quality.sign_off": [{ tokens: ["Admin", "DocCtrl"] }, { tokens: ["Admin", "DocCtrl", "Safety"], when: { projectId: ["p1"] } }] } };
    expect(policyAllows(policy, "quality.sign_off", "Safety", ["Safety"], SAFETY, { projectId: "p1" })).toBe(true);
    expect(policyAllows(policy, "quality.sign_off", "Safety", ["Safety"], SAFETY, { projectId: "p2" })).toBe(false);
    expect(policyAllows(policy, "quality.sign_off", "Safety", ["Safety"], SAFETY)).toBe(false);
    // an unconfigured org grants nobody beyond the standing holders (no role
    // widened); a controller's authority is the policies' is_org_controller
    // clause and quality_signer_eligible's is_org_controller_for, not this token
    expect(policyAllows({}, "quality.sign_off", "Safety", ["Safety"], SAFETY, { projectId: "p1" })).toBe(false);
    expect(policyAllows({}, "quality.sign_off", "Manager", ["Manager", "DocCtrl"], ADMIN, { projectId: "p1" })).toBe(false);
    // a rule naming only the project is enough (the base list stays empty)
    const scopedOnly: CapabilityPolicy = { caps: { "quality.sign_off": [{ tokens: ["Safety"], when: { projectId: ["p1"] } }] } };
    expect(validateCapabilityPolicy(scopedOnly)).toBeNull();
    expect(policyAllows(scopedOnly, "quality.sign_off", "Safety", ["Safety"], SAFETY, { projectId: "p1" })).toBe(true);
    expect(policyAllows(scopedOnly, "quality.sign_off", "Safety", ["Safety"], SAFETY, { projectId: "p2" })).toBe(false);
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
    expect(signoffSeparation(OW, OW, 2, "checklist")).toEqual({ blocked: true, singleSigner: false, pending: false, reason: "You created this checklist, so a second person signs it off — 2 other eligible signers on this project." });
    expect(signoffSeparation(OW, OW, 1, "turnover").reason).toBe("You added this turnover item, so a second person accepts or waives it — 1 other eligible signer on this project.");
    expect(signoffSeparation(OW, OW, 0, "checklist")).toEqual({ blocked: false, singleSigner: true, pending: false, reason: null });
    expect(signoffSeparation(OW, SAFETY, 5, "checklist")).toEqual({ blocked: false, singleSigner: false, pending: false, reason: null });
    expect(signoffSeparation(null, OW, 5, "checklist")).toEqual({ blocked: false, singleSigner: false, pending: false, reason: null });
  });
  it("an UNKNOWN count (null: loading, or unreadable) holds the author's sign-off — never a guessed 'nobody else', never single-signer", () => {
    const c = signoffSeparation(OW, OW, null, "checklist");
    expect(c).toMatchObject({ blocked: true, singleSigner: false, pending: true });
    expect(c.reason).toMatch(/not known yet/);
    expect(signoffSeparation(OW, OW, null, "turnover")).toMatchObject({ blocked: true, singleSigner: false, pending: true });
    // nobody else's sign-off depends on the count
    expect(signoffSeparation(OW, SAFETY, null, "turnover")).toEqual({ blocked: false, singleSigner: false, pending: false, reason: null });
  });
});

describe("loadSignoffAuthority — the database's decision, fail-closed (dw4 / DEC-16)", () => {
  it("reads quality_signoff_status (20261136) for the project", async () => {
    state.rpc = { quality_signoff_status: (args) => ({ data: args.p_project === "p1" ? { maySign: true, otherSigners: 3 } : null, error: null }) };
    expect(await loadSignoffAuthority("o1", "p1", actorOf(SAFETY))).toEqual({ maySign: true, otherSigners: 3, source: "database" });
    // a project the caller cannot see: NULL — no, and no count (not a guessed zero)
    expect(await loadSignoffAuthority("o1", "p9", actorOf(SAFETY))).toEqual({ maySign: false, otherSigners: null, source: "database" });
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
    expect(a.otherSigners).toBeNull();
    // REL-3 (J10): the driver's words are translated
    expect(a.error).toBe("The database couldn't be reached just now — try again in a moment.");
  });
  it("a failed fallback read is an error too", async () => {
    state.readError.org_members = { message: "permission denied", code: "42501" };
    const a = await loadSignoffAuthority("o1", "p1", actorOf(OW));
    expect(a).toMatchObject({ maySign: false, otherSigners: null, source: "fallback" });
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
    // J10 third fix: the reason sits inside the sentence — no "….)"
    expect(res.error).toBe("Couldn't check who else can sign this checklist off (The database couldn't be reached just now — try again in a moment) — it stays open.");
    expect(ceremony.calls).toHaveLength(0);
  });

  it("reopen / void need no signature (only a completion is a sign-off)", async () => {
    for (const status of ["open", "void"] as const) {
      expect((await setChecklistStatus({ orgId: "o1", projectId: "p1", checklist: checklist(), status, actor: actorOf(OW) })).ok).toBe(true);
    }
    expect(ceremony.calls).toHaveLength(0);
  });

  // QUAL-15's void half (J2b integration): voiding takes a checklist out of
  // every count closeout reads, so the author the separation rule refused
  // could void it away — 20261136 keeps every void to controllers.
  it("voiding ANY checklist is a controller's: the database's refusal of the owner comes back as the error, nothing audited", async () => {
    state.writeError = { message: "Voiding a checklist takes it out of the project's closeout with no reason on record — only Admin / Document Control voids one. Nothing was changed. QUAL-15, 20261136", code: "23514" };
    const res = await setChecklistStatus({ orgId: "o1", projectId: "p1", checklist: checklist(), status: "void", actor: actorOf(OW) });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/only Admin \/ Document Control voids one/);
    expect(audits()).toHaveLength(0);
    expect(state.tables.project_checklists[0].status).toBe("open");
  });

  // The review's major: a second person's signed completion could be voided or
  // reopened by any writer — no reason, no signature — and then deleted.
  // 20261136 keeps the undo of a COMPLETED checklist to controllers; the lib
  // returns the database's refusal as the error and audits nothing.
  it("undoing a COMPLETED checklist is a controller's: the database's refusal comes back as the error, nothing audited, nothing signed", async () => {
    state.tables.project_checklists[0].status = "complete";
    state.writeError = { message: "A completed checklist is a signed sign-off — only Admin / Document Control reopens or voids it. Nothing was changed. QUAL-4, 20261136", code: "23514" };
    for (const status of ["open", "void"] as const) {
      const res = await setChecklistStatus({ orgId: "o1", projectId: "p1", checklist: checklist({ status: "complete" }), status, actor: actorOf(OW) });
      expect(res.ok, status).toBe(false);
      expect(res.error, status).toMatch(/only Admin \/ Document Control reopens or voids it/);
    }
    expect(audits()).toHaveLength(0);
    expect(ceremony.calls).toHaveLength(0);
    expect(state.tables.project_checklists[0].status).toBe("complete");
  });
});

// ── the turnover acceptance ────────────────────────────────────────────────
const titem = (over: Partial<TurnoverItem> = {}): TurnoverItem => ({
  id: "t1", orgId: "o1", projectId: "p1", partyId: null, name: "NDE reports", description: null,
  required: true, status: "received", documentId: null, reviewedAt: null, reviewedByName: null, reviewNote: null,
  createdAt: null, createdBy: OW, ...over,
});

describe("reviewTurnoverItem('accepted' / 'waived') — QUAL-4", () => {
  beforeEach(() => {
    state.tables.turnover_items = [{ id: "t1", org_id: "o1", project_id: "p1", name: "NDE reports", status: "received", created_by: OW }];
  });

  it("dw2: whoever added the item cannot accept it while a second signer exists", async () => {
    state.rpc = { quality_signoff_status: () => ({ data: { maySign: true, otherSigners: 1 }, error: null }) };
    const res = await reviewTurnoverItem({ item: titem(), status: "accepted", actor: actorOf(OW), signoff });
    expect(res).toEqual({ ok: false, error: "You added this turnover item, so a second person accepts or waives it — 1 other eligible signer on this project." });
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

  it("dw3: an unsigned acceptance or waiver is refused; received / rejected are not sign-offs and mint nothing", async () => {
    expect((await reviewTurnoverItem({ item: titem(), status: "accepted", actor: actorOf(SAFETY) })).ok).toBe(false);
    const unsignedWaiver = await reviewTurnoverItem({ item: titem(), status: "waived", note: "Vendor data sheets were not part of this scope", actor: actorOf(SAFETY) });
    expect(unsignedWaiver.ok).toBe(false);
    expect(unsignedWaiver.error).toMatch(/signed: confirm the statement with your e-signature/);
    expect(state.tables.turnover_items[0].status).toBe("received");
    expect((await reviewTurnoverItem({ item: titem({ status: "open" }), status: "received", actor: actorOf(OW) })).ok).toBe(true);
    expect((await reviewTurnoverItem({ item: titem(), status: "rejected", note: "Two RT films are unreadable at the root", actor: actorOf(OW) })).ok).toBe(true);
    expect(ceremony.calls).toHaveLength(0);
  });

  it("dw2: alone on the project, the creator accepts — marked single-signer", async () => {
    state.rpc = { quality_signoff_status: () => ({ data: { maySign: true, otherSigners: 0 }, error: null }) };
    expect((await reviewTurnoverItem({ item: titem(), status: "accepted", actor: actorOf(OW), signoff })).ok).toBe(true);
    expect(audits().at(-1)!.details).toMatchObject({ singleSigner: true });
  });

  // The review's major: a waiver clears a required item from the progress,
  // the snapshot and the closeout gate exactly as an acceptance does, so the
  // creator of a seeded item cannot route around the second person by waiving.
  it("dw2: whoever added (or seeded) the item cannot WAIVE it while a second signer exists either — nothing minted, nothing written", async () => {
    state.rpc = { quality_signoff_status: () => ({ data: { maySign: true, otherSigners: 1 }, error: null }) };
    const res = await reviewTurnoverItem({ item: titem({ status: "open" }), status: "waived", note: "Contractor confirmed by phone it is not needed", actor: actorOf(OW), signoff });
    expect(res).toEqual({ ok: false, error: "You added this turnover item, so a second person accepts or waives it — 1 other eligible signer on this project." });
    expect(ceremony.calls).toHaveLength(0);
    expect(state.writes.filter((w) => w.table === "turnover_items")).toHaveLength(0);
    expect(audits()).toHaveLength(0);
  });

  it("dw3: a second person's waiver mints THEIR e-signature on THIS item first, keeps the reason, and the audit row names the signature", async () => {
    const res = await reviewTurnoverItem({ item: titem(), status: "waived", note: "Vendor data sheets were not part of this scope", actor: actorOf(SAFETY), signoff });
    expect(res).toEqual({ ok: true });
    expect(ceremony.calls).toEqual([expect.objectContaining({ resourceType: "turnover_item", resourceId: "t1", intent: "Reviewed", signerUserId: SAFETY })]);
    expect(state.tables.turnover_items[0]).toMatchObject({ status: "waived", reviewed_by: SAFETY, review_note: "Vendor data sheets were not part of this scope" });
    expect(audits().at(-1)!.details).toMatchObject({ status: "waived", signatureId: "sig-1", singleSigner: false });
  });

  it("the waiver's reason is checked BEFORE anyone signs — a canned or short reason mints no signature", async () => {
    for (const note of ["n/a", "too short", ""]) {
      const res = await reviewTurnoverItem({ item: titem(), status: "waived", note, actor: actorOf(SAFETY), signoff });
      expect(res.ok, note).toBe(false);
    }
    expect(ceremony.calls).toHaveLength(0);
    expect(state.writes).toHaveLength(0);
  });

  it("dw2: alone on the project, the creator waives — signed and marked single-signer; DEC-16: an unreadable count waives nothing", async () => {
    state.rpc = { quality_signoff_status: () => ({ data: { maySign: true, otherSigners: 0 }, error: null }) };
    expect((await reviewTurnoverItem({ item: titem(), status: "waived", note: "Vendor data sheets were not part of this scope", actor: actorOf(OW), signoff })).ok).toBe(true);
    expect(audits().at(-1)!.details).toMatchObject({ status: "waived", singleSigner: true });
    state.tables.turnover_items[0].status = "received";
    state.rpc = { quality_signoff_status: () => ({ data: null, error: { message: "upstream timeout", code: "PGRST000" } }) };
    const res = await reviewTurnoverItem({ item: titem(), status: "waived", note: "Vendor data sheets were not part of this scope", actor: actorOf(OW), signoff });
    expect(res.ok).toBe(false);
    // J10 third fix: the reason sits inside the sentence — no "….)"
    expect(res.error).toBe("Couldn't check who else can accept or waive this item (The database couldn't be reached just now — try again in a moment) — nothing was changed.");
    expect(ceremony.calls).toHaveLength(1);
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
    // the review: "the org has other active members" counted members who could
    // never sign — the measure is another ELIGIBLE signer on that project (an
    // active controller other than the owner: the only other writer before
    // 20261136), plus the plan's literal reading, another active project member
    const inventory = m136.slice(m136.indexOf("CREATE TEMP TABLE prj_roundg_signoff_before AS"), m136.indexOf("\nBEGIN;"));
    expect(inventory).toContain("accepted turnover items whose reviewer is the project owner, on projects where another eligible signer existed");
    expect(inventory).toContain("AND is_org_controller_for(p.org_id, m.uid)))::text");
    expect(inventory).toContain("accepted turnover items whose reviewer is the project owner, on projects with another active project member (project_members");
    expect(inventory).toMatch(/FROM project_members pm\s+JOIN org_members m ON m\.org_id = p\.org_id AND m\.uid::text = pm\.user_id::text AND m\.status = 'active'/);
    expect(inventory).not.toContain("on projects whose org has other active members");
    // is_org_controller_for exists before the inventory runs: the apply-order guard refuses without 20261125
    expect(m136.indexOf("to_regprocedure('public.is_org_controller_for(uuid,uuid)') IS NULL")).toBeLessThan(m136.indexOf("CREATE TEMP TABLE prj_roundg_signoff_before AS"));
    expect(m136).toContain("stored capability rules conditioned on a projectId (expect 0");
  });
});

describe("20261136 — org_capability_allows_for re-created from 20261132 (lineDiff)", () => {
  const H = "CREATE OR REPLACE FUNCTION org_capability_allows_for";
  const fn132 = fnBody(m132, H);
  const fn136 = fnBody(m136, H);
  const OLD_KEYS = "ARRAY['requestType', 'unit', 'libraryId', 'discipline']";
  const NEW_KEYS = `ARRAY[${RESOURCE_KEYS.map((k) => `'${k}'`).join(", ")}]`;
  const ADDED = `      WHEN 'quality.sign_off'         THEN '[]'::jsonb`;

  it("started from the NEWEST definition: 20261132 was the last file to re-create the evaluator before this one (intelligence Round G's 20261137 re-creates it again from THIS body — pinned in intelRoundGAiCapsMigration.test.ts)", () => {
    const definers = numbered.filter((f) => read(f).includes(`${H}(`));
    const at = definers.indexOf(M136);
    expect(at).toBeGreaterThan(0);
    expect(definers[at - 1]).toBe("20261132_dc_roundF_transmit_capability.sql");
    expect(definers[at + 1]).toBe("20261137_intel_roundG_ai_manage_caps.sql");
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
  it("the CASE mirrored CAPABILITY_DEFS exactly when it shipped (every id, same defaults) — the later 20261137 row (ai.manage_caps) is the only id it lacks; the live census is rpPhase4Migration.test.ts", () => {
    const caseBlock = fn136.slice(fn136.indexOf("v_tokens := CASE p_cap"), fn136.indexOf("END;", fn136.indexOf("v_tokens := CASE p_cap")));
    const sql = new Map<string, string[]>();
    for (const m of caseBlock.matchAll(/WHEN '([^']+)'\s+THEN '(\[[^\]]*\])'::jsonb/g)) sql.set(m[1], JSON.parse(m[2]) as string[]);
    const later = new Set(["ai.manage_caps"]);
    for (const d of CAPABILITY_DEFS) if (!later.has(d.id)) expect(sql.get(d.id), d.id).toEqual(d.defaultRoles);
    expect(sql.size).toBe(CAPABILITY_DEFS.length - later.size);
    for (const id of later) expect(sql.has(id), id).toBe(false);
  });
  it("revokes EXECUTE from PUBLIC and anon, grants authenticated and service_role; the wrapper is untouched", () => {
    expect(m136).toContain("REVOKE ALL ON FUNCTION org_capability_allows_for(uuid, text, uuid, jsonb) FROM PUBLIC;");
    expect(m136).toContain("REVOKE ALL ON FUNCTION org_capability_allows_for(uuid, text, uuid, jsonb) FROM anon;");
    expect(m136).toContain("GRANT EXECUTE ON FUNCTION org_capability_allows_for(uuid, text, uuid, jsonb) TO authenticated, service_role;");
    expect(m136).not.toMatch(/CREATE OR REPLACE FUNCTION org_capability_allows\(/);
    expect(m136).not.toMatch(/DROP FUNCTION/);
  });
});

describe("20261136 — the four write policies: replaced, newest body + one disjunct + TO authenticated (DRLS-1)", () => {
  const OWNER = "user_owns_project(project_id))";
  const OWNER_OR = "user_owns_project(project_id) OR quality_signoff_granted(org_id, project_id))";
  // The review: the policies had no TO clause, so anon evaluated them — and
  // anon has no EXECUTE on quality_signoff_granted, which PostgreSQL checks
  // while planning the policy: an anonymous read raised "permission denied
  // for function" where it used to return no rows. One clause, the same bodies.
  const toAuthenticated = (body: string) => {
    expect(body.split(" FOR ALL\n").length - 1).toBe(1);
    return body.replace(" FOR ALL\n", " FOR ALL TO authenticated\n");
  };

  it("project_checklists_write = 20261091's body with the disjunct on USING and WITH CHECK, TO authenticated", () => {
    const base = policy(m91, "project_checklists_write");
    expect(policy(m136, "project_checklists_write")).toBe(toAuthenticated(base).split(OWNER).join(OWNER_OR));
    expect(base.split(OWNER).length - 1).toBe(2);
  });
  it("checklist_items_write = 20261091's body with the disjunct inside the checklist lookup, on USING and WITH CHECK, TO authenticated", () => {
    const base = policy(m91, "checklist_items_write");
    const before = "AND user_owns_project(c.project_id)))";
    const after = "AND (user_owns_project(c.project_id) OR quality_signoff_granted(c.org_id, c.project_id))))";
    expect(base.split(before).length - 1).toBe(2);
    expect(policy(m136, "checklist_items_write")).toBe(toAuthenticated(base).split(before).join(after));
  });
  it("turnover_items_write / punch_items_write = 20261013's bodies (their newest) with the disjunct, TO authenticated", () => {
    for (const name of ["turnover_items_write", "punch_items_write"]) {
      const base = policy(m13, name);
      expect(base.split(OWNER).length - 1, name).toBe(2);
      expect(policy(m136, name), name).toBe(toAuthenticated(base).split(OWNER).join(OWNER_OR));
    }
  });
  it("every policy that calls quality_signoff_granted is TO authenticated — the helper anon cannot execute is never in a policy anon evaluates", () => {
    const code = codeOnly(m136);
    const policies = [...code.matchAll(/CREATE POLICY (\w+) ON (\w+) FOR ALL([^\n]*)\n[\s\S]*?;/g)];
    expect(policies).toHaveLength(4);
    for (const p of policies) {
      expect(p[0], p[1]).toContain("quality_signoff_granted(");
      expect(p[3].trim(), p[1]).toBe("TO authenticated");
    }
    expect(m136).toContain("REVOKE ALL ON FUNCTION quality_signoff_granted(uuid, uuid) FROM anon;");
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
  it("the checklist rail (review major): a COMPLETED checklist is reopened or voided by a controller only — before the completion record is cleared — and a checklist never changes project", () => {
    const r = fnBody(m136, "CREATE OR REPLACE FUNCTION project_checklists_signoff_rail()");
    const undo = "  IF OLD.status = 'complete' AND NEW.status IS DISTINCT FROM 'complete'\n     AND NOT is_org_controller(OLD.org_id) THEN\n    RAISE EXCEPTION 'A completed checklist is a signed sign-off — only Admin / Document Control reopens or voids it.";
    expect(r).toContain(undo);
    // check_violation, not insufficient_privilege: describeWriteError keeps the message (42501 becomes a generic line)
    expect(r.slice(r.indexOf(undo), r.indexOf("END IF;", r.indexOf(undo)))).toContain("USING ERRCODE = 'check_violation';");
    const move = "  IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN\n    RAISE EXCEPTION 'A checklist stays on the project it was written for";
    expect(r).toContain(move);
    // both run on every signed-in UPDATE, after the author check and before anything is stamped or cleared
    const order = [
      "IF TG_OP = 'INSERT' THEN",
      "IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN",
      move,
      undo,
      "NEW.status_changed_at := CASE WHEN NEW.status IS DISTINCT FROM OLD.status",
      "-- Not complete: no completion record (the signature row itself stays,",
    ];
    let at = -1;
    for (const line of order) { const i = r.indexOf(line); expect(i, line).toBeGreaterThan(at); at = i; }
    // the service pass (restores, server routes) still passes first
    expect(r.indexOf("IF v_uid IS NULL THEN RETURN NEW; END IF;")).toBeLessThan(r.indexOf(undo));
    // no product path reopens or voids a checklist: the tab calls setChecklistStatus for "complete" only
    const tab = src("components/projects/QualityTab.tsx");
    expect((tab.match(/setChecklistStatus\(/g) ?? []).length).toBe(1);
    expect(tab).toContain('setChecklistStatus({ orgId, projectId, checklist, status: "complete"');
    // an org always keeps an active Admin (the last-Admin guard), so a controller exists to undo one
    expect(read("20260831_capability_policy_and_rails.sql")).toContain("CREATE OR REPLACE FUNCTION prevent_last_admin_removal()");
  });
  it("the checklist rail (QUAL-15 void half): ANY move to void is a controller's — after the completion-undo rule, before anything is stamped", () => {
    const r = fnBody(m136, "CREATE OR REPLACE FUNCTION project_checklists_signoff_rail()");
    const voidRule = "  IF NEW.status = 'void' AND OLD.status IS DISTINCT FROM 'void'\n     AND NOT is_org_controller(OLD.org_id) THEN\n    RAISE EXCEPTION 'Voiding a checklist takes it out of the project''s closeout with no reason on record — only Admin / Document Control voids one. Nothing was changed. QUAL-15, 20261136'\n      USING ERRCODE = 'check_violation';";
    expect(r).toContain(voidRule);
    expect(r.indexOf(voidRule)).toBeGreaterThan(r.indexOf("IF OLD.status = 'complete' AND NEW.status IS DISTINCT FROM 'complete'"));
    expect(r.indexOf(voidRule)).toBeLessThan(r.indexOf("NEW.status_changed_at := CASE WHEN NEW.status IS DISTINCT FROM OLD.status"));
    // the service pass (restores, server routes) still passes first
    expect(r.indexOf("IF v_uid IS NULL THEN RETURN NEW; END IF;")).toBeLessThan(r.indexOf(voidRule));
    // checklists carry no reason column, so the void asks none (the schema was checked: 20261013's table, 20261091 and 20261136's columns)
    const ddl = m13.slice(m13.indexOf("CREATE TABLE IF NOT EXISTS project_checklists ("), m13.indexOf(");", m13.indexOf("CREATE TABLE IF NOT EXISTS project_checklists (")));
    expect(ddl).not.toMatch(/reason|note/i);
    const added = numbered.flatMap((f) => [...read(f).matchAll(/ALTER TABLE project_checklists ADD COLUMN IF NOT EXISTS (\w+)/g)].map((m) => m[1]));
    expect(added.filter((c) => /reason|note/i.test(c))).toEqual([]);
  });
  it("the checklist rail keeps a DURABLE sign-off mark: ever_completed_signature_id is cleared at insert, set to the completion's signature, and carried through every reopen and void — never a client's value", () => {
    const r = fnBody(m136, "CREATE OR REPLACE FUNCTION project_checklists_signoff_rail()");
    expect(m136).toContain("ALTER TABLE project_checklists ADD COLUMN IF NOT EXISTS ever_completed_signature_id UUID;");
    const insert = r.slice(r.indexOf("IF TG_OP = 'INSERT' THEN"), r.indexOf("RETURN NEW;", r.indexOf("IF TG_OP = 'INSERT' THEN")));
    expect(insert).toContain("NEW.ever_completed_signature_id := NULL;");
    // carried from OLD on every signed-in update, before the status branches
    const keep = "  NEW.ever_completed_signature_id := OLD.ever_completed_signature_id;";
    expect(r).toContain(keep);
    expect(r.indexOf(keep)).toBeLessThan(r.indexOf("IF NEW.status = 'complete' AND OLD.status IS DISTINCT FROM 'complete' THEN"));
    // set only where a completion is recorded
    expect(r.split("NEW.ever_completed_signature_id := v_sig;").length - 1).toBe(1);
    const recorded = r.slice(r.indexOf("NEW.completed_signature_id := v_sig;"), r.indexOf("ELSIF NEW.status = 'complete' THEN"));
    expect(recorded).toContain("NEW.ever_completed_signature_id := v_sig;");
    // nothing else assigns it (the not-complete branch clears the completion record, not the mark)
    expect((r.match(/NEW\.ever_completed_signature_id :=/g) ?? []).length).toBe(3);
    const notComplete = r.slice(r.indexOf("-- Not complete: no completion record"), r.indexOf("RETURN NEW;", r.indexOf("-- Not complete: no completion record")));
    expect(notComplete).not.toContain("ever_completed_signature_id :=");
  });
  it("the turnover rail: creator stamped and never rewritten; never born accepted or waived; self-acceptance AND self-waiver refused while others can sign; a fresh signature on THIS item, newer than its last history row", () => {
    const r = fnBody(m136, "CREATE OR REPLACE FUNCTION turnover_items_signoff_rail()");
    expect(r).toContain("IF v_uid IS NULL THEN RETURN NEW; END IF;");
    expect(r).toMatch(/IF TG_OP = 'INSERT' THEN\n    NEW\.created_by := v_uid;\n    IF NEW\.status IN \('accepted', 'waived'\) THEN\n      RAISE EXCEPTION '[^']*never born accepted or waived/);
    // a waiver clears the item exactly as an acceptance does: the same sign-off branch
    expect(r).toContain("IF NEW.status IN ('accepted', 'waived') AND NEW.status IS DISTINCT FROM OLD.status THEN");
    expect(r).toContain("ELSIF NEW.status IN ('accepted', 'waived') THEN");
    expect(r).not.toMatch(/NEW\.status = 'accepted'/);
    // a required item leaves only by a signed waiver
    expect(r).toContain("IF OLD.required AND NOT NEW.required THEN");
    // nor by a project move (review minor): no item changes project for a signed-in writer
    expect(r).toContain("  IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN\n    RAISE EXCEPTION 'A turnover item stays in the package it was added to");
    expect(r.indexOf("IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN")).toBeGreaterThan(r.indexOf("IF OLD.required AND NOT NEW.required THEN"));
    expect(r.indexOf("IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN")).toBeLessThan(r.indexOf("IF NEW.status IN ('accepted', 'waived') AND NEW.status IS DISTINCT FROM OLD.status THEN"));
    // no product path moves one: the only project_id the lib writes is an insert's (two turnover inserts, one punch insert)
    expect(src("lib/turnover.ts").match(/project_id:/g)).toHaveLength(3);
    expect(src("lib/turnover.ts").match(/project_id: input\.projectId,/g)).toHaveLength(3);
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
  it("the delete rail: BEFORE DELETE on the three project quality tables; a grant never deletes (but the create rollback of its own item-less header); a signed sign-off or a required turnover item is a controller's; service, cascade and purge pass", () => {
    const r = fnBody(m136, "CREATE OR REPLACE FUNCTION quality_records_delete_rail()");
    expect(r).toMatch(/RETURNS trigger\nLANGUAGE plpgsql\nSECURITY DEFINER SET search_path = public/);
    const order = [
      "IF v_uid IS NULL THEN RETURN OLD; END IF;",
      "IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;",
      "IF COALESCE(current_setting('app.record_purge', true), '') = 'project:' || OLD.project_id::text THEN",
      "IF is_org_controller(OLD.org_id) THEN RETURN OLD; END IF;",
      "IF TG_TABLE_NAME = 'project_checklists'\n     AND (v_status = 'complete'",
      // the review: void (or reopen) then delete erased a signed completion —
      // a checklist that was EVER signed off is a controller's to delete. The
      // integration fix: the test is the rail's durable mark, never a bare
      // e_signatures row (/api/signatures/sign mints one for any resource an
      // active member names; a refused completion leaves an orphan)
      "     AND (v_status = 'complete' OR v_old->>'ever_completed_signature_id' IS NOT NULL) THEN",
      "AND (v_status IN ('accepted', 'waived') OR COALESCE((v_old->>'required')::boolean, true)) THEN",
      "IF NOT user_owns_project(OLD.project_id) THEN",
      "AND NOT EXISTS (SELECT 1 FROM checklist_items i WHERE i.checklist_id = OLD.id) THEN",
    ];
    let at = -1;
    for (const line of order) { const i = r.indexOf(line); expect(i, line).toBeGreaterThan(at); at = i; }
    expect(r).not.toContain("e_signatures");
    // turnover keeps its status test: it never read e_signatures (a reopened
    // item's signed decision lives on in turnover_review_events, J2)
    expect(r).toContain("AND (v_status IN ('accepted', 'waived') OR COALESCE((v_old->>'required')::boolean, true)) THEN");
    // the purge GUC is 20261103's, set by delete_project_record
    expect(read("20261103_prj_roundG_project_closeout_rails.sql")).toContain("PERFORM set_config('app.record_purge', 'project:' || p_project::text, true);");
    for (const t of ["project_checklists", "turnover_items", "punch_items"]) {
      expect(m136, t).toContain(`DROP TRIGGER IF EXISTS trg_${t}_signoff_delete_rail ON ${t};\nCREATE TRIGGER trg_${t}_signoff_delete_rail\n  BEFORE DELETE ON ${t}\n  FOR EACH ROW EXECUTE FUNCTION quality_records_delete_rail();`);
    }
    expect(m136).toContain("REVOKE ALL ON FUNCTION quality_records_delete_rail() FROM anon;");
    // the only delete the app makes on these tables is createChecklist's rollback of its fresh header
    expect(src("lib/checklists.ts").match(/\.delete\(\)/g)).toHaveLength(1);
    expect(src("lib/turnover.ts")).not.toContain(".delete()");
    expect(src("components/projects/QualityTab.tsx")).not.toContain(".delete()");
  });
  it("probes cover the evaluator, the policies, the helpers' grants, the columns and every rail", () => {
    for (const label of [
      "the evaluator carries the quality.sign_off default (none — controllers and the project owner sign off by standing, not through the capability) and every earlier default",
      "the evaluator reads five resource keys (projectId added) in both rule passes",
      // only the resource-aware entry point is closed to anon; the wrapper's default grant is said, not claimed closed
      "anon cannot execute the resource-aware evaluator org_capability_allows_for; authenticated and service_role can (DRLS-16) — the 3-argument wrapper keeps its default grant",
      "project_checklists_write is the ONLY permissive write policy on project_checklists",
      "checklist_items_write is the ONLY permissive write policy on checklist_items",
      "turnover_items_write is the ONLY permissive write policy on turnover_items",
      "punch_items_write is the ONLY permissive write policy on punch_items",
      "the four write policies apply TO authenticated only",
      "the sign-off record columns exist",
      "keeps a completed checklist's reopen or void — and any checklist's void (QUAL-15) — to controllers, keeps the durable sign-off mark through every reopen and void, and never moves a checklist to another project",
      "both sign-off rails fire BEFORE INSERT OR UPDATE",
      "the turnover rail treats an acceptance AND a waiver as a sign-off",
      "never moves an item to another project",
      "the delete rail fires BEFORE DELETE on project_checklists, turnover_items and punch_items",
      "a signed sign-off (a checklist complete or ever signed off — the durable mark, never a bare signature row)",
      "the sign-off record columns exist (7 on project_checklists — the durable mark ever_completed_signature_id among them — 2 on turnover_items)",
    ]) expect(tail, label.replace(/'/g, "''")).toContain(label.replace(/'/g, "''"));
    expect(tail).not.toContain("anon cannot execute the evaluator;");
    // the probes pin the void rule, the durable mark and the delete rail's test
    expect(tail).toContain("AND prosrc LIKE '%IF NEW.status = ''void'' AND OLD.status IS DISTINCT FROM ''void''%AND NOT is_org_controller(OLD.org_id) THEN%'");
    expect(tail).toContain("AND prosrc LIKE '%NEW.ever_completed_signature_id := v_sig;%'");
    expect(tail).toContain("AND prosrc LIKE '%AND (v_status = ''complete'' OR v_old->>''ever_completed_signature_id'' IS NOT NULL) THEN%'");
    expect(tail).toContain("AND prosrc NOT LIKE '%FROM e_signatures%'");
    expect(tail).not.toContain("OR EXISTS (SELECT 1 FROM e_signatures e%");
    // the inventory names the signed-but-not-complete checklists the mark is not derived for
    expect(m136.slice(m136.indexOf("CREATE TEMP TABLE prj_roundg_signoff_before AS"), m136.indexOf("\nBEGIN;")))
      .toContain("BEFORE (informational): checklists not complete that carry an e_signatures row on them");
    // the AFTER count includes open items (every seeded item is born open)
    expect(tail).toContain("WHERE t.status NOT IN ('accepted', 'waived') AND t.created_by IS NOT NULL");
    expect(tail).not.toContain("t.status IN ('received', 'rejected')");
    // 18 probes: every probe row carries `NULL::text` as n (the first spells `NULL::text AS n`)
    expect((codeOnly(tail).match(/NULL::text(?! AS n)/g) ?? []).length + (codeOnly(tail).match(/NULL::text AS n/g) ?? []).length).toBe(18);
    // the review: the AFTER rows ask quality_other_signers once per (org, project, author), never once per row
    const after = tail.slice(tail.indexOf("SELECT label, NULL::boolean, n FROM prj_roundg_signoff_before"));
    const helperCalls = [...after.matchAll(/quality_other_signers\(([^)]*)\)/g)].map((m) => m[1]);
    expect(helperCalls).toEqual(["g.org_id, g.project_id, g.created_by", "g.org_id, g.project_id, g.created_by", "g.org_id, g.project_id, g.created_by"]);
    expect((after.match(/GROUP BY (c|t)\.org_id, (c|t)\.project_id, (c|t)\.created_by\) g/g) ?? []).length).toBe(3);
    expect((after.match(/COALESCE\(SUM\(g\.n\), 0\)::text/g) ?? []).length).toBe(3);
    // the grid row grants beyond the standing holders: no AFTER row compares it to the controller pair
    expect(tail).not.toContain("controller-pair answer differs");
    expect(tail).toContain("AFTER: active controllers (Admin / Document Control) — standing signers on every project they can see");
    // deparsed policy text is matched on the function call, never a bare cast
    expect(tail).toContain("qual LIKE '%quality_signoff_granted(org_id, project_id)%'");
    expect(tail).toContain("with_check LIKE '%quality_signoff_granted(c.org_id, c.project_id)%'");
  });
});

// ── dw4: the surface draws its controls from the decision ──────────────────
describe("QualityTab census — controls from the decision (dw4)", () => {
  const tab = src("components/projects/QualityTab.tsx");

  it("reads the database's decision and passes it — never the page's canManage — to every section", () => {
    expect(tab).toContain("return loadSignoffAuthority(orgId, projectId, actor).then((a) => {");
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
  // J2b integration: the decision was read once on mount — Retry and every
  // onChanged re-read the lists but never the decision.
  // projects Round G J10b (PERF-4): the loaders set state in their settled
  // callbacks (react-hooks/set-state-in-effect, live once the suppression
  // went), and every section's onChanged is afterWrite — refresh, then the
  // page is told. Retry stays refresh alone.
  it("refresh() — mount, Retry and every section's onChanged — re-reads the sign-off decision beside the lists; only the newest answer lands", () => {
    const loader = tab.slice(tab.indexOf("const loadAuthority = useCallback((): Promise<void> => {"), tab.indexOf("}, [orgId, projectId, actor]);", tab.indexOf("const loadAuthority = useCallback(")));
    expect(loader).toContain("const seq = ++authoritySeq.current;");
    expect(loader).toContain("return loadSignoffAuthority(orgId, projectId, actor).then((a) => {");
    expect(loader).toContain("if (seq === authoritySeq.current) setAuthority(a);");
    const refresh = tab.slice(tab.indexOf("const refresh = useCallback((): Promise<void> => {"), tab.indexOf("useEffect(() => { void refresh(); }, [refresh]);"));
    expect(refresh).toContain("void loadAuthority();");
    expect(refresh.indexOf("void loadAuthority();")).toBeLessThan(refresh.indexOf("return Promise.allSettled(["));
    expect(refresh).toContain("}, [orgId, projectId, loadAuthority]);");
    // the decision is read in ONE place — no separate mount-only effect remains
    expect((tab.match(/loadSignoffAuthority\(/g) ?? []).length).toBe(1);
    // Retry is refresh; every section's onChanged is afterWrite, which is refresh first
    expect(tab).toContain("const retry = () => void refresh();");
    expect(tab).toContain("void refresh().then(() => {");
    const top = tab.slice(tab.indexOf("export default function QualityTab("), tab.indexOf("\nfunction LoadFailed("));
    expect((top.match(/onChanged=\{afterWrite\}/g) ?? []).length).toBe(3);
    expect((top.match(/onRetry=\{retry\}/g) ?? []).length).toBe(3);
  });
  it("the fallback notice names everyone the fallback admits: the project owner, Admin and Document Control", () => {
    expect(tab).toContain("<Notice notice={info(`Couldn't read who may sign off on this project (${asClause(authority.error)}) — the controls shown are the ones the project owner, Admin and Document Control always have.`)} />");
    expect(tab).not.toContain("the project owner's and Document Control's");
    // the fallback it describes: the page's canManage = owner || Admin / DocCtrl
    expect(src("app/(protected)/projects/[id]/page.tsx")).toContain('const isAdmin = hasAnyRole(["Admin", "DocCtrl"]);');
    expect(src("app/(protected)/projects/[id]/page.tsx")).toContain("const canManage = isOwner || isAdmin;");
  });
  // J2b integration: the turnover ceremony closed before reviewTurnoverItem
  // ran, so a failed signature dropped the reviewer's document pick or reason.
  it("the turnover ceremony stays open (busy) until the decision lands — a failure keeps the pick / reason and says why inside the ceremony", () => {
    const sign = tab.slice(tab.indexOf("{signingDecision?.item.id === it.id && ("), tab.indexOf("</li>", tab.indexOf("{signingDecision?.item.id === it.id && (")));
    expect(sign).not.toMatch(/const pending = signingDecision;\s*setSigningDecision\(null\);/);
    expect(sign).toContain("if (res?.ok) setSigningDecision((cur) => (cur === pending ? null : cur));");
    expect(sign).toContain('else if (res) setSigningError(res.error ?? "Couldn\'t update.");');
    expect(sign).toContain("error={signingError}");
    expect(sign).toContain("busy={busy === it.id}");
    expect(sign).toContain("onCancel={() => { if (busy !== it.id) { setSigningError(null); setSigningDecision(null); } }}");
    // review hands the write's result back (null: the reject prompt was cancelled)
    expect(tab).toContain("return finish(await reviewTurnoverItem({ item, status, note,");
    // the ceremony renders the caller's error, as an alert
    const c = src("components/signatures/SignatureCeremony.tsx");
    expect(c).toContain("error?: string | null;");
    expect(c).toMatch(/\{error && \(\s*<div role="alert"/);
    // ChecklistCard's ceremony likewise stays open while complete() runs
    expect(tab).toContain('onCancel={() => { if (busy !== "complete") setSigning(false); }}');
  });
  it("Mark complete and turnover Accept / Waive go through the signing ceremony and pass its output to the lib", () => {
    expect(tab).toContain('<button onClick={() => setSigning(true)} disabled={busy != null || completeBlocked}');
    expect(tab).toContain("setChecklistStatus({ orgId, projectId, checklist, status: \"complete\", actor, signoff: signed })");
    expect(tab).toContain("setSigningDecision({ item: it, status: \"accepted\", documentId: d.id })");
    expect(tab).toContain("...(signed ? { signoff: signed } : {})");
    // Waive: the reason first (checked against the bar), then the ceremony — never a direct unsigned write
    expect(tab).toContain("onClick={() => void startWaive(it)}");
    expect(tab).not.toContain('review(it, "waived")');
    expect(tab).toContain("const problem = reasonProblem(note);");
    expect(tab).toContain("setSigningDecision({ item, status: \"waived\", note: note.trim() });");
    expect(tab).toContain(": review(pending.item, \"waived\", undefined, signed, pending.note);");
    expect((tab.match(/<SignatureCeremony/g) ?? []).length).toBe(2);
    expect((tab.match(/lockIntent/g) ?? []).length).toBe(2);
  });
  it("a blocked author sees why (DEC-12: an explanation, not a missing button); a lone signer's sign-off is marked", () => {
    expect(tab).toContain("const separation = signoffSeparation(checklist.createdBy, actor.uid, signoff.otherSigners, \"checklist\");");
    expect(tab).toContain("completeBlocked = progress != null && (progress.total === 0 || blocking > 0 || staleGreens > 0 || separation.blocked)");
    expect(tab).toContain("Accept — needs a second person");
    expect(tab).toContain("Waive — needs a second person");
    expect(tab).toContain("single-signer");
    expect(tab).toContain("signed off by {checklist.completedByName}");
  });
  it("the separation count is never guessed: unknown (loading or unreadable) is NULL, and the author's controls wait with the reason", () => {
    expect(tab).toContain("otherSigners: authority && !authority.error ? authority.otherSigners : null,");
    expect(tab).not.toMatch(/otherSigners \?\? 0/);
    expect(tab).toContain("const separationReason = separation.pending ? signoff.pendingReason : separation.reason;");
    expect(tab).toContain("Accept — checking who else can sign");
    expect(tab).toContain("Waive — checking who else can sign");
    // the single-signer promise only on a known zero (pending is never singleSigner)
    expect(tab).toContain("{!completeBlocked && progress && separation.singleSigner && (");
  });
});
