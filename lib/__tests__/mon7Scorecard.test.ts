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
  /** A table whose reads fail with this driver error (the registry check). */
  readError: {} as Record<string, { code: string; message: string }>,
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
  const run = (): { data: unknown; error: unknown } => {
    if (op === "select" && db.readError[table]) return { data: null, error: db.readError[table] };
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

import { saveParty, linkPartyToCompany, listParties, checkPartyCompanyLink } from "@/lib/costs";
import { addTurnoverItem, addPunchItem, seedTurnoverItems, listTurnoverItems, listPunchItems, assignTurnoverContractor, assignPunchContractor } from "@/lib/turnover";
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
  db.readError = {};
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

  it("final review: an unreadable registry says what did NOT happen on each path — the Costs-tab add says the contractor was not added; a later link says nothing was linked", async () => {
    await saveParty({ orgId: "o1", projectId: "p1", patch: { name: "Gulf Mech (field crew)" }, actor });   // an unlinked contractor, for the link path
    const existing = db.rows.project_parties[0].id as string;
    db.writes = [];
    db.readError = { companies: { code: "57014", message: "canceling statement due to statement timeout" } };
    const why = "Couldn't check the company registry (The database took too long to answer — try again)";

    // the add refuses the WHOLE insert, so it must not read as "added, unlinked"
    const add = await saveParty({ orgId: "o1", projectId: "p1", patch: { name: "Gulf Mechanical", companyId: "c1" }, actor });
    expect(add).toEqual({ ok: false, error: `${why} — the contractor was not added; try again, or add it with no company link.` });
    expect(add.error).not.toContain("nothing was linked");
    expect(db.rows.project_parties.map((p) => p.name)).toEqual(["Gulf Mech (field crew)"]);   // not added
    // …and "add it with no company link" works (no registry read is needed)
    expect((await saveParty({ orgId: "o1", projectId: "p1", patch: { name: "Gulf Mechanical" }, actor })).ok).toBe(true);

    // the later link: the contractor exists, only the link was refused
    const link = await linkPartyToCompany({ orgId: "o1", partyId: existing, companyId: "c1", actor });
    expect(link).toEqual({ ok: false, error: `${why} — nothing was linked.` });
    expect(db.rows.project_parties.find((p) => p.id === existing)!.company_id ?? null).toBeNull();
    expect(db.writes.filter((w) => w.op === "update")).toEqual([]);
    // the wizard's note keeps its own wording (the contractor IS added there, unlinked)
    const note = await checkPartyCompanyLink("o1", "Gulf Mechanical", "c1");
    expect(note).toEqual({ ok: false, note: `"Gulf Mechanical" was added without a company link: ${why}. Link it on the project's Costs tab.` });
  });
});

describe("DEC-76 item 3 — the wizard's name-bound link meets the same do-not-use rule", () => {
  it("a link that would need a reason is refused with a note (the wizard adds the contractor unlinked); a clean one passes; the barred company itself passes", async () => {
    // "Apex Industrial LLC" normalises to the do-not-use "Apex Industrial";
    // bound by name to the clean "Apex Holdings" it would carry awards past the flag.
    const refused = await checkPartyCompanyLink("o1", "Apex Industrial LLC", "c8");
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.note).toMatch(/^"Apex Industrial LLC" was added without a company link: the name could be Apex Industrial, flagged DO NOT USE in the registry\. Link it on the project's Costs tab, where the link records a reason\.$/);
    expect(await checkPartyCompanyLink("o1", "Gulf Mechanical", "c1")).toEqual({ ok: true });
    expect(await checkPartyCompanyLink("o1", "Apex Industrial", "c9")).toEqual({ ok: true });
    // nothing was written by the check
    expect(db.writes).toEqual([]);
  });

  it("the wizard wires the check into its writes (a required dependency — the rule cannot be skipped by omission)", () => {
    const w = readFileSync(join(process.cwd(), "components/projects/ProjectWizard.tsx"), "utf8");
    expect(w).toContain("checkPartyLink: (partyName, companyId) => checkPartyCompanyLink(orgId, partyName, companyId),");
    const lib = readFileSync(join(process.cwd(), "lib/projectWizardWrites.ts"), "utf8");
    expect(lib).toContain("checkPartyLink(name: string, companyId: string): Promise<{ ok: true } | { ok: false; note: string }>;");
    expect(lib).toContain("const chk = await deps.checkPartyLink(r.name, r.companyId);");
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

describe("MON-7 dw2 / COST-12 dw3 (fix pass) — a SEEDED or existing item is assigned its contractor, and its acceptance reaches the company", () => {
  const quality = async () => (await gatherCompanyProfile(GULF)).scorecard.dimensions.find((d) => d.key === "quality")!;
  const addGulf = async () => {
    await saveParty({ orgId: "o1", projectId: "p1", patch: { name: "Gulf Mechanical", companyId: "c1" }, actor });
    return db.rows.project_parties.find((p) => p.name === "Gulf Mechanical")!.id as string;
  };

  it("the normal workflow: the package is seeded with no contractor and accepted — Unrated; each item assigned to its contractor on the Quality tab — Quality moves off Unrated", async () => {
    const gulf = await addGulf();
    expect((await seedTurnoverItems({ orgId: "o1", projectId: "p1", jobKind: "small", actor })).ok).toBe(true);
    expect(db.rows.turnover_items.map((t) => t.party_id)).toEqual([null, null, null]);
    // QA/QC accepted the whole package before anyone named who delivered it
    // (the signed review is reviewTurnoverItem's — pinned in qualitySignoff.test).
    for (const t of db.rows.turnover_items) t.status = "accepted";
    expect((await quality()).score).toBeNull();

    for (const it of await listTurnoverItems("o1", "p1")) {
      expect(it.partyId).toBeNull();
      expect(await assignTurnoverContractor({ item: it, partyId: gulf, actor })).toEqual({ ok: true });
    }
    const q = await quality();
    expect(q.score).toBe(100);
    expect(q.detail).toBe("turnover 3/3 accepted");
    // guarded on what the caller saw, and audited with what it replaced
    const upd = db.writes.filter((w) => w.table === "turnover_items" && w.op === "update");
    expect(upd).toHaveLength(3);
    for (const w of upd) expect(w.filters).toEqual(expect.arrayContaining(["eq:id", "eq:org_id", "eq:status", "is:party_id"]));
    expect(audits("TURNOVER_CONTRACTOR_SET").map((a) => a.details)).toEqual(
      db.rows.turnover_items.map((t) => expect.objectContaining({ itemId: t.id, status: "accepted", from: null, to: gulf })));
  });

  it("the seed itself carries the contractor picked beside Seed required contents", async () => {
    const gulf = await addGulf();
    expect((await seedTurnoverItems({ orgId: "o1", projectId: "p1", jobKind: "small", partyId: gulf, actor })).ok).toBe(true);
    expect(db.rows.turnover_items.map((t) => t.party_id)).toEqual([gulf, gulf, gulf]);
    db.rows.turnover_items[0].status = "accepted";
    expect((await quality()).detail).toBe("turnover 1/1 accepted");
  });

  it("a decided item keeps its contractor (never moved to another company's record); an undecided one can move; a contractor from another project is refused; a refusal writes nothing", async () => {
    const gulf = await addGulf();
    await saveParty({ orgId: "o1", projectId: "p1", patch: { name: "Apex Holdings", companyId: "c8" }, actor });
    const apex = db.rows.project_parties.find((p) => p.name === "Apex Holdings")!.id as string;
    db.rows.project_parties.push({ id: "elsewhere", org_id: "o1", project_id: "p2", name: "Other job's crew" });
    await addTurnoverItem({ orgId: "o1", projectId: "p1", name: "Torque records", partyId: gulf, actor });
    await addTurnoverItem({ orgId: "o1", projectId: "p1", name: "Weld map", partyId: gulf, actor });
    db.rows.turnover_items[0].status = "accepted";
    db.rows.turnover_items[1].status = "received";
    const [accepted, received] = await listTurnoverItems("o1", "p1");
    db.writes = [];

    const moved = await assignTurnoverContractor({ item: accepted, partyId: apex, actor });
    expect(moved.ok).toBe(false);
    expect(moved.error).toMatch(/^This turnover item is accepted — its contractor stays as recorded\. Reopen it/);
    expect((await assignTurnoverContractor({ item: accepted, partyId: null, actor })).ok).toBe(false);
    expect((await assignTurnoverContractor({ item: received, partyId: "elsewhere", actor })).error).toBe("That contractor isn't on this project — add them on the Costs tab first.");
    expect(db.writes).toEqual([]);
    expect(db.rows.turnover_items.map((t) => t.party_id)).toEqual([gulf, gulf]);

    // undecided: moves, and its acceptance then counts for the new company
    expect(await assignTurnoverContractor({ item: received, partyId: apex, actor })).toEqual({ ok: true });
    expect(db.rows.turnover_items[1].party_id).toBe(apex);
    expect(audits("TURNOVER_CONTRACTOR_SET")[0].details).toMatchObject({ from: gulf, to: apex, status: "received" });
    // a stale view (someone decided it meanwhile) is refused by the guard, not overwritten
    db.rows.turnover_items[1].status = "accepted";
    const stale = await assignTurnoverContractor({ item: { ...received, partyId: apex }, partyId: gulf, actor });
    expect(stale.ok).toBe(false);
    expect(stale.error).toMatch(/changed since you loaded it/);
    expect(db.rows.turnover_items[1].party_id).toBe(apex);
  });

  it("an existing punch item is assigned after the fact; its close-out then counts; a closed one keeps its contractor", async () => {
    const gulf = await addGulf();
    expect((await addPunchItem({ orgId: "o1", projectId: "p1", title: "Reinstall insulation at E-301", actor })).ok).toBe(true);
    db.rows.punch_items[0].status = "done";
    expect((await quality()).score).toBeNull();
    const [done] = await listPunchItems("o1", "p1");
    expect(await assignPunchContractor({ item: done, partyId: gulf, actor })).toEqual({ ok: true });
    expect((await quality()).detail).toBe("punch 1/1 closed");
    const [assigned] = await listPunchItems("o1", "p1");
    expect((await assignPunchContractor({ item: assigned, partyId: null, actor })).error).toMatch(/^This punch item is closed — its contractor stays as recorded/);
    expect(audits("PUNCH_CONTRACTOR_SET")).toHaveLength(1);
  });

  it("J10 third fix: a REJECTED turnover item is never named after the fact (no reopen — a wrong name could not be corrected); a waived one and a voided punch item can be, once", async () => {
    const gulf = await addGulf();
    await addTurnoverItem({ orgId: "o1", projectId: "p1", name: "Hydro test pack", actor });
    await addTurnoverItem({ orgId: "o1", projectId: "p1", name: "Vendor manuals", actor });
    await addPunchItem({ orgId: "o1", projectId: "p1", title: "Not a real snag", actor });
    db.rows.turnover_items[0].status = "rejected";
    db.rows.turnover_items[1].status = "waived";
    db.rows.punch_items[0].status = "void";
    const [rejected, waived] = await listTurnoverItems("o1", "p1");
    db.writes = [];

    const refused = await assignTurnoverContractor({ item: rejected, partyId: gulf, actor });
    expect(refused).toEqual({ ok: false, error: "This turnover item is rejected — its contractor can't be named now: a rejection can't be reopened, so a wrong name could never be corrected. Name the contractor once the resubmission is accepted." });
    expect(db.writes).toEqual([]);
    expect(db.rows.turnover_items[0].party_id).toBeNull();
    expect(audits("TURNOVER_CONTRACTOR_SET")).toEqual([]);
    // the nonconformance stays on nobody's record — never on a guessed one
    expect((await quality()).score).toBeNull();

    expect(await assignTurnoverContractor({ item: waived, partyId: gulf, actor })).toEqual({ ok: true });
    const [voided] = await listPunchItems("o1", "p1");
    expect(await assignPunchContractor({ item: voided, partyId: gulf, actor })).toEqual({ ok: true });
    // and once named, a closed / voided punch item keeps it — no "Reopen it" (the app has none for punch)
    const [named] = await listPunchItems("o1", "p1");
    expect((await assignPunchContractor({ item: named, partyId: null, actor })).error).toBe("This punch item is voided — its contractor stays as recorded.");
  });

  it("the Quality tab wires it: an undecided row is written by its Assign / Save (final review — never by the select alone); a decided, unassigned row (accepted / waived, closed / voided) goes through Assign and a confirm; a rejected one has no control; a picker beside Seed required contents", () => {
    const q = readFileSync(join(process.cwd(), "components/projects/QualityTab.tsx"), "utf8");
    expect(q).toContain("seedTurnoverItems({ orgId, projectId, jobKind, partyId: seedParty || null, actor })");
    expect(q).toContain('label="Contractor who delivers the seeded items"');
    expect(q).toContain("finish(await assignTurnoverContractor({ item, partyId: partyId || null, actor }));");
    expect(q).toContain('{canManage && busy !== it.id && pickable.length > 0 && (it.status === "open" || it.status === "received") ? (');
    expect(q).toContain('canManage && busy !== it.id && pickable.length > 0 && !it.partyId && (it.status === "accepted" || it.status === "waived") ? (');
    expect(q).toContain("if (!(await confirmLateContractor({ itemName: item.name, decided: item.status, contractor }))) return;");
    expect(q).toContain("label={`Contractor who delivers ${it.name}`}");
    expect(q).toContain("const r = await assignPunchContractor({ item: it, partyId: partyId || null, actor });");
    expect(q).toContain('{canManage && busy !== it.id && pickable.length > 0 && it.status === "open" ? (');
    expect(q).toContain("if (!(await confirmLateContractor({ itemName: it.title, decided: it.status, contractor }))) return;");
    expect(q).toContain("label={`Contractor responsible for ${it.title}`}");
    expect(q).toContain("onSave={(v) => void assign(it, v)} />");
    expect(q).not.toContain("onChange={(v) => void assign(it, v)}");
    // rendered behaviour: qualityTabContractorAssign.test.ts
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
