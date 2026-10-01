// projects Round G — J10, MON-7 / COST-12 (the writer limbs). The Known
// Companies scorecard hangs off three keys the normal workflow never wrote:
// a contractor added on the Costs tab had no company link, and turnover and
// punch items never named a contractor. Now the Costs tab links a contractor
// to its Known Company (on add, or later — only while it has no link, never
// re-pointed, and a name that could be a do-not-use company needs a recorded
// reason), and the turnover / punch add rows carry the contractor. Through
// the real gather: a contractor added on the Costs tab appears on the
// company's profile, an accepted turnover item moves Quality off Unrated
// (an unassigned or unlinked one counts for nobody — never as a zero), an
// awarded quote is in the bid history, and a fully-populated fixture scores
// every dimension.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// An in-memory PostgREST double: eq / in / is / or(ilike) filters, ORDER BY,
// range(), insert(...).select().single(), update(...).<filters>.select().
const db = vi.hoisted(() => ({
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  writes: [] as Array<{ table: string; op: "insert" | "update"; payload: unknown; filters: string[] }>,
  seq: 0,
}));
function orPredicate(expr: string): (r: Record<string, unknown>) => boolean {
  const preds = expr.split(",").map((t) => {
    const [col, op, ...rest] = t.split(".");
    let v = rest.join(".");
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(.)/g, "$1");
    if (op !== "ilike") throw new Error(`mock: unsupported or() op ${op}`);
    const re = new RegExp(`^${v.split("").map((ch) => (ch === "*" || ch === "%" ? ".*" : ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))).join("")}$`, "is");
    return (r: Record<string, unknown>) => re.test(String(r[col] ?? ""));
  });
  return (r) => preds.some((p) => p(r));
}
function chain(table: string) {
  const filters: Array<(r: Record<string, unknown>) => boolean> = [];
  const filterNames: string[] = [];
  let range: [number, number] | null = null;
  let op: "select" | "insert" | "update" = "select";
  let payload: Record<string, unknown> | Array<Record<string, unknown>> | null = null;
  let selected = false;
  const all = () => (db.rows[table] ??= []);
  const run = (): { data: unknown; error: null } => {
    if (op === "insert") {
      const rows = (Array.isArray(payload) ? payload : [payload!]).map((r) => ({ id: `${table}-${++db.seq}`, ...r }));
      all().push(...rows);
      db.writes.push({ table, op, payload, filters: filterNames });
      return { data: selected ? rows : null, error: null };
    }
    const hit = all().filter((r) => filters.every((f) => f(r)));
    if (op === "update") {
      for (const r of hit) Object.assign(r, payload);
      db.writes.push({ table, op, payload, filters: filterNames });
      return { data: selected ? hit : null, error: null };
    }
    const sorted = [...hit].sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")));
    return { data: range ? sorted.slice(range[0], range[1] + 1) : sorted, error: null };
  };
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve(run());
      return (...args: unknown[]) => {
        if (prop === "insert") { op = "insert"; payload = args[0] as Record<string, unknown>; }
        if (prop === "update") { op = "update"; payload = args[0] as Record<string, unknown>; }
        if (prop === "select") selected = true;
        if (prop === "eq") { filters.push((r) => r[String(args[0])] === args[1]); filterNames.push(`eq:${String(args[0])}`); }
        if (prop === "in") filters.push((r) => (args[1] as unknown[]).includes(r[String(args[0])]));
        if (prop === "is") { filters.push((r) => (r[String(args[0])] ?? null) === args[1]); filterNames.push(`is:${String(args[0])}`); }
        if (prop === "or") filters.push(orPredicate(String(args[0])));
        if (prop === "range") range = [Number(args[0]), Number(args[1])];
        if (prop === "maybeSingle" || prop === "single") {
          const res = run();
          return Promise.resolve({ data: Array.isArray(res.data) ? (res.data[0] ?? null) : res.data, error: null });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t) } }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => undefined) }));

import { saveParty, linkPartyToCompany, listParties } from "@/lib/costs";
import { addTurnoverItem, addPunchItem } from "@/lib/turnover";
import { gatherCompanyProfile, type Company } from "@/lib/companies";

const actor = { uid: "u1", email: "pm@plant.example" };
const company = (id: string, name: string, over: Partial<Company> = {}): Company => ({
  id, orgId: "o1", name, kind: "contractor", trade: null, status: "active",
  contactName: null, contactEmail: null, contactPhone: null, qualityManualDocId: null, qualityManualScore: null,
  qualityManualGaps: null, qualityManualReviewedAt: null, qualityManualPagesRead: null, qualityManualPagesTotal: null,
  notes: null, createdAt: null, ...over,
});
const companyRow = (c: Company) => ({ id: c.id, org_id: c.orgId, name: c.name, kind: c.kind, status: c.status });
const GULF = company("c1", "Gulf Mechanical");
const APEX_BARRED = company("c9", "Apex Industrial", { status: "do_not_use" });
const APEX_OTHER = company("c8", "Apex Holdings");
const audits = (action: string) => (db.rows.audit_logs ?? []).filter((r) => r.action === action);

beforeEach(() => {
  db.rows = { companies: [GULF, APEX_BARRED, APEX_OTHER].map(companyRow), projects: [{ id: "p1", name: "Unit 3 turnaround" }] };
  db.writes = [];
  db.seq = 0;
});

describe("MON-7 dw1 / COST-12 dw1 — a contractor added on the Costs tab appears on its company's profile", () => {
  it("saveParty writes the Known Company link; the profile finds the project through it", async () => {
    const before = await gatherCompanyProfile(GULF);
    expect(before.partiesLinked).toBe(0);
    const r = await saveParty({ orgId: "o1", projectId: "p1", patch: { name: "Gulf Mechanical", kind: "contractor", companyId: "c1" }, actor });
    expect(r).toEqual({ ok: true });
    const [party] = await listParties("o1", "p1");
    expect(party.companyId).toBe("c1");
    const after = await gatherCompanyProfile(GULF);
    expect(after.partiesLinked).toBe(1);
    expect(after.projects.map((p) => p.projectName)).toEqual(["Unit 3 turnaround"]);
    expect(audits("COST_PARTY_CREATED")[0].details).toMatchObject({ companyId: "c1" });
  });

  it("an unlinked contractor is linked later — once, never re-pointed, and only while it has no link", async () => {
    await saveParty({ orgId: "o1", projectId: "p1", patch: { name: "Gulf Mech (field crew)" }, actor });
    const [party] = await listParties("o1", "p1");
    expect(party.companyId).toBeNull();
    expect(await linkPartyToCompany({ orgId: "o1", partyId: party.id, companyId: "c1", actor })).toEqual({ ok: true });
    const upd = db.writes.find((w) => w.table === "project_parties" && w.op === "update")!;
    expect(upd.filters).toEqual(expect.arrayContaining(["eq:id", "eq:org_id", "is:company_id"]));   // a concurrent link is never overwritten
    expect(audits("COST_PARTY_LINKED")[0].details).toMatchObject({ companyId: "c1" });
    expect((await gatherCompanyProfile(GULF)).partiesLinked).toBe(1);
    // A second link — to anyone — is refused: a link is never re-pointed.
    const again = await linkPartyToCompany({ orgId: "o1", partyId: party.id, companyId: "c8", actor });
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/already linked/);
    expect((await listParties("o1", "p1"))[0].companyId).toBe("c1");
    // …and saveParty's edit path cannot move it either.
    const edit = await saveParty({ orgId: "o1", projectId: "p1", id: party.id, patch: { companyId: "c8" }, actor });
    expect(edit.ok).toBe(false);
    expect((await listParties("o1", "p1"))[0].companyId).toBe("c1");
  });

  it("a name that could be a do-not-use company, linked elsewhere, needs a reason — recorded — so an award can't slip past the flag", async () => {
    const refused = await saveParty({ orgId: "o1", projectId: "p1", patch: { name: "Apex Industrial", companyId: "c8" }, actor });
    expect(refused.ok).toBe(false);
    expect(refused.needsOverride).toEqual({ companyId: "c9", company: "Apex Industrial" });
    expect(db.rows.project_parties ?? []).toHaveLength(0);
    const withReason = await saveParty({ orgId: "o1", projectId: "p1", patch: { name: "Apex Industrial", companyId: "c8" }, linkOverrideReason: "Holdings is the parent; licence checked", actor });
    expect(withReason.ok).toBe(true);
    expect(audits("COST_PARTY_CREATED")[0].details).toMatchObject({ overrideDoNotUse: { companyId: "c9", company: "Apex Industrial", reason: "Holdings is the parent; licence checked" } });
    // Linking to the barred company itself needs no reason (the flag stays on).
    expect((await saveParty({ orgId: "o1", projectId: "p1", patch: { name: "Apex Industrial", companyId: "c9" }, actor })).ok).toBe(true);
    // The later link path applies the same rule.
    await saveParty({ orgId: "o1", projectId: "p1", patch: { name: "APEX INDUSTRIAL LLC" }, actor });
    const unlinked = (await listParties("o1", "p1")).find((p) => p.name === "APEX INDUSTRIAL LLC")!;
    const r = await linkPartyToCompany({ orgId: "o1", partyId: unlinked.id, companyId: "c1", actor });
    expect(r.needsOverride).toEqual({ companyId: "c9", company: "Apex Industrial" });
    expect((await listParties("o1", "p1")).find((p) => p.id === unlinked.id)!.companyId).toBeNull();
  });
});

describe("MON-7 dw2 / COST-12 dw3 — turnover and punch carry the contractor, and acceptance reaches the company", () => {
  it("an accepted turnover item moves Quality off Unrated; one on an unassigned or unlinked contractor counts for nobody", async () => {
    await saveParty({ orgId: "o1", projectId: "p1", patch: { name: "Gulf Mechanical", companyId: "c1" }, actor });
    await saveParty({ orgId: "o1", projectId: "p1", patch: { name: "Day labour (no registry record)" }, actor });
    const [gulf, day] = ["Gulf Mechanical", "Day labour (no registry record)"].map((n) => db.rows.project_parties.find((p) => p.name === n)!.id as string);
    expect((await gatherCompanyProfile(GULF)).scorecard.dimensions.find((d) => d.key === "quality")!.score).toBeNull();

    expect((await addTurnoverItem({ orgId: "o1", projectId: "p1", name: "Torque records", partyId: gulf, actor })).ok).toBe(true);
    expect((await addTurnoverItem({ orgId: "o1", projectId: "p1", name: "Hydro test pack", partyId: day, actor })).ok).toBe(true);
    expect((await addTurnoverItem({ orgId: "o1", projectId: "p1", name: "As-builts", actor })).ok).toBe(true);
    expect(db.rows.turnover_items.map((t) => t.party_id)).toEqual([gulf, day, null]);
    // QA/QC accepts all three (the signed review is reviewTurnoverItem's —
    // pinned in turnover.test / qualitySignoff.test; here the row state).
    for (const t of db.rows.turnover_items) t.status = "accepted";

    const quality = (await gatherCompanyProfile(GULF)).scorecard.dimensions.find((d) => d.key === "quality")!;
    expect(quality.score).toBe(100);
    expect(quality.detail).toBe("turnover 1/1 accepted");   // the unlinked and unassigned items are not Gulf's
  });

  it("a punch item carries its contractor, and its close-out counts for that company", async () => {
    await saveParty({ orgId: "o1", projectId: "p1", patch: { name: "Gulf Mechanical", companyId: "c1" }, actor });
    const gulf = db.rows.project_parties[0].id as string;
    expect((await addPunchItem({ orgId: "o1", projectId: "p1", title: "Reinstall insulation at E-301", partyId: gulf, actor })).ok).toBe(true);
    expect(db.rows.punch_items[0].party_id).toBe(gulf);
    db.rows.punch_items[0].status = "done";
    expect((await gatherCompanyProfile(GULF)).scorecard.dimensions.find((d) => d.key === "quality")!.detail).toBe("punch 1/1 closed");
  });

  it("the Quality tab's add rows pass the picked contractor (and never block an add when the list is unreadable)", () => {
    const q = readFileSync(join(process.cwd(), "components/projects/QualityTab.tsx"), "utf8");
    expect(q).toContain("addTurnoverItem({ orgId, projectId, name: addName, partyId: addParty || null, actor })");
    expect(q).toContain("partyId: party || null, actor });");
    expect(q).toMatch(/listParties\(orgId, projectId\)[\s\S]{0,200}\.catch\(/);
    expect(q).toContain('label="Contractor who delivers it"');
    expect(q).toContain('label="Contractor responsible"');
  });
});

describe("MON-7 dw3 / dw4 — the bid history and a fully-populated fixture", () => {
  it("every dimension is scored, and the awarded quote is in the bid history", async () => {
    await saveParty({ orgId: "o1", projectId: "p1", patch: { name: "Gulf Mechanical", companyId: "c1", trade: "piping" }, actor });
    const gulf = db.rows.project_parties[0].id as string;
    await addTurnoverItem({ orgId: "o1", projectId: "p1", name: "Torque records", partyId: gulf, actor });
    await addTurnoverItem({ orgId: "o1", projectId: "p1", name: "Weld map", partyId: gulf, actor });
    db.rows.turnover_items[0].status = "accepted";
    db.rows.turnover_items[1].status = "rejected";
    db.rows.cost_documents = [
      { id: "q1", project_id: "p1", party_id: gulf, rfq_group: "Piping", total_amount: 400_000, status: "awarded", doc_date: "2026-08-01", kind: "quote", company_id: null },
      { id: "q2", project_id: "p1", party_id: null, rfq_group: "Insulation", total_amount: 90_000, status: "declined", doc_date: "2026-08-02", kind: "quote", company_id: "c1" },
    ];
    db.rows.cost_entries = [{ id: "e1", party_id: gulf, amount: 400_000, reference: "PO-1", entry_type: "commitment", status: "posted" }];
    db.rows.change_orders = [{ id: "co1", project_id: "p1", party_id: gulf, co_number: "CO-001", title: "Extra spool", amount: 20_000, reason_code: "scope_gap", status: "approved", posted_entry_id: null }];
    db.rows.company_events = [{ id: "ev1", company_id: "c1", project_id: "p1", kind: "commendation", event_date: "2026-08-20", description: "Clean permit audit" }];
    db.rows.milestones = [
      { id: "m1", project_id: "p1", status: "completed", planned_at: "2026-08-10T12:00:00Z", actual_at: "2026-08-10T12:00:00Z", responsible_party: "Gulf Mechanical" },
      { id: "m2", project_id: "p1", status: "completed", planned_at: "2026-08-12T12:00:00Z", actual_at: "2026-08-20T12:00:00Z", responsible_party: "gulf mechanical" },
    ];
    db.rows.project_intake_links = [{ id: "l1", project_id: "p1", company_name: "Gulf Mechanical", submission_count: 3, created_at: "2026-08-01T00:00:00Z", last_used_at: "2026-08-04T00:00:00Z" }];

    const profile = await gatherCompanyProfile(GULF);
    const dims = Object.fromEntries(profile.scorecard.dimensions.map((d) => [d.key, d]));
    for (const k of ["safety", "quality", "cost", "schedule", "responsiveness"]) {
      expect(dims[k].score, `${k}: ${dims[k].detail}`).not.toBeNull();
    }
    expect(dims.quality.detail).toBe("turnover 1/2 accepted");
    expect(dims.schedule.detail).toBe("1/2 tasks on time");
    expect(dims.cost.detail).toMatch(/^5% cost growth over bid/);
    expect(profile.scorecard.composite).not.toBeNull();
    // Bid history: the quote reached through the contractor AND the one
    // linked to the company directly, each once; the award is marked won.
    expect(profile.bids.map((b) => [b.rfqGroup, b.won])).toEqual([["Insulation", false], ["Piping", true]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  });
});
