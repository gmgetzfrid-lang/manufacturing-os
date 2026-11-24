import { describe, it, expect, vi, beforeEach } from "vitest";

// Two databases. "missing": no project_materials table yet, so the project
// row's settings (shift_times) are where the register lives. "old": the
// table is there but 20261125_materials_two_owners.sql isn't, so it turns
// down the crew_owner column and the "used" status.
const db = vi.hoisted(() => ({
  project: { id: "p1", shift_times: { review: { all: { items: {} } } } as Record<string, unknown> },
  updates: 0,
  table: "missing" as "missing" | "old",
  sent: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/lib/supabase", () => {
  const missing = { message: "Could not find the table 'public.project_materials' in the schema cache", code: "PGRST205" };
  const noColumn = { message: "Could not find the 'crew_owner' column of 'project_materials' in the schema cache", code: "PGRST204" };
  const noUsed = { message: 'new row for relation "project_materials" violates check constraint "project_materials_status_check"', code: "23514" };
  const table = () => {
    let sent: Record<string, unknown> = {};
    const q: Record<string, unknown> = {};
    for (const k of ["select", "eq", "order", "delete"]) q[k] = () => q;
    q.insert = (r: Record<string, unknown>) => { sent = r; return q; };
    q.update = (r: Record<string, unknown>) => { sent = r; return q; };
    q.range = async () => (db.table === "missing" ? { data: null, error: missing } : { data: [], error: null });
    q.single = async () => {
      if (db.table === "missing") return { data: null, error: missing };
      db.sent.push({ ...sent });
      if ("crew_owner" in sent) return { data: null, error: noColumn };
      if (sent.status === "used") return { data: null, error: noUsed };
      return { data: { id: "t1", org_id: "o1", project_id: "p1", created_at: "2026-11-24T12:00:00Z", ...sent }, error: null };
    };
    return q;
  };
  const projects = () => {
    let patch: Record<string, unknown> | null = null;
    const q: Record<string, unknown> = {
      select: () => q, eq: () => q,
      update: (p: Record<string, unknown>) => { patch = p; return q; },
      maybeSingle: async () => ({ data: { shift_times: db.project.shift_times }, error: null }),
      then: (ok: (v: unknown) => void) => { if (patch) { db.project.shift_times = patch.shift_times as Record<string, unknown>; db.updates++; } ok({ data: [{ id: "p1" }], error: null }); },
    };
    return q;
  };
  return { supabase: { from: (t: string) => (t === "projects" ? projects() : table()) } };
});

import { blankMaterial, deleteMaterial, listMaterials, saveMaterial } from "@/lib/materials";

const actor = { id: "u1", name: "eng@kern.test" };
beforeEach(() => { db.project.shift_times = { review: { all: { items: {} } } }; db.updates = 0; db.table = "missing"; db.sent = []; });

describe("materials register without its table", () => {
  it("adds, changes and removes lines in the project's settings, leaving the rest of the settings alone", async () => {
    expect((await listMaterials("p1")).rows).toEqual([]);
    const a = await saveMaterial({ orgId: "o1", projectId: "p1", fields: { ...blankMaterial(null), item: "Seal rings, E-12 bundle", spec: "Per task sheet", owner: "Buyer", workOrder: "E-12", needBy: "2026-10-27" }, actor });
    expect(a.id).toMatch(/^s-/);
    expect(a.status).toBe("ready");
    expect(a.heldBack).toEqual([]);
    expect(db.project.shift_times.review).toEqual({ all: { items: {} } });
    const b = await saveMaterial({ id: a.id, orgId: "o1", projectId: "p1", fields: { ...a, status: "short", question: "When do the rest come?" }, was: a, actor });
    expect(b).toMatchObject({ id: a.id, status: "short", question: "When do the rest come?", createdByName: "eng@kern.test" });
    expect(b.questionAt).not.toBeNull();
    // Both owners and "Used on the job" keep there as they are.
    const c = await saveMaterial({ id: a.id, orgId: "o1", projectId: "p1", fields: { ...b, status: "used", crewOwner: "Pipefitter foreman" }, was: b, actor });
    expect(c).toMatchObject({ status: "used", owner: "Buyer", crewOwner: "Pipefitter foreman", heldBack: [] });
    const list = (await listMaterials("p1")).rows;
    expect(list.map((r) => [r.item, r.status, r.crewOwner])).toEqual([["Seal rings, E-12 bundle", "used", "Pipefitter foreman"]]);
    await deleteMaterial(a.id, "p1");
    expect((await listMaterials("p1")).rows).toEqual([]);
    expect(db.updates).toBe(4);
  });
  it("won't mark a line used without a crew owner", async () => {
    await expect(saveMaterial({ orgId: "o1", projectId: "p1", fields: { ...blankMaterial(null), item: "Gaskets", spec: "Spiral wound", status: "used" }, actor }))
      .rejects.toThrow(/crew owner/);
  });
});

describe("materials register before the two-owner update", () => {
  it("saves the line without the crew owner and 'used', and says which were held back", async () => {
    db.table = "old";
    const a = await saveMaterial({ orgId: "o1", projectId: "p1", fields: { ...blankMaterial(null), item: "Gaskets", spec: "Spiral wound", owner: "Warehouse lead", crewOwner: "Pipefitter foreman", needBy: "2026-11-30" }, actor });
    // A new line goes to the table, not the settings: a missing column is not a missing table.
    expect(a.id).toBe("t1");
    expect(db.updates).toBe(0);
    expect(a).toMatchObject({ owner: "Warehouse lead", crewOwner: "", heldBack: ["crewOwner"] });
    const b = await saveMaterial({ id: a.id, orgId: "o1", projectId: "p1", fields: { ...a, status: "used", crewOwner: "Pipefitter foreman" }, was: { ...a, status: "checked" }, actor });
    expect(b.status).toBe("checked");
    expect(b.heldBack).toEqual(["crewOwner", "used"]);
    // Nothing else is lost: the last try sends every other field.
    expect(db.sent.at(-1)).toMatchObject({ item: "Gaskets", owner: "Warehouse lead", status: "checked" });
    expect(db.sent.at(-1)).not.toHaveProperty("crew_owner");
  });
  it("a blank crew owner isn't reported as held back", async () => {
    db.table = "old";
    const a = await saveMaterial({ orgId: "o1", projectId: "p1", fields: { ...blankMaterial(null), item: "Stud bolts", spec: "B7, 7/8 in" }, actor });
    expect(a.heldBack).toEqual([]);
  });
});
