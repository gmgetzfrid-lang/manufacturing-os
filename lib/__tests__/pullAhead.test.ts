// Pulling work forward for the next shift: what's offered, in what order,
// whether it's ready, whose scope it is, how full the crew is, and what
// the turnover and email say.

import { describe, it, expect } from "vitest";
import { buildShiftReport, shiftWindow } from "@/lib/shiftReport";
import { filterLookAhead, scopeOf } from "@/lib/pullAhead";
import { decisionsToShip, capacityOf } from "@/lib/shiftHandover";
import { turnoverUpdate } from "@/lib/managementUpdate";
import { toPlainText } from "@/lib/reportExport";
import type { Milestone } from "@/types/schema";

const CHI = "America/Chicago";
const at = (d: string, hm: string) => new Date(Date.parse(`${d}T${hm}:00-05:00`)).toISOString();
const mk = (p: Partial<Milestone> & { id: string; name: string }): Milestone =>
  ({ orgId: "o", weight: 1, status: "planned", source: "manual", createdBy: "u", ...p } as Milestone);
const f = { D: (x: number) => new Date(x).toISOString().slice(5, 10), DTs: (x: number) => new Date(x).toISOString().slice(5, 16), T: (x: number) => new Date(x).toISOString().slice(11, 16), win: () => "", hrs: (h: number) => `${h} h` };

// E-12: Open (tonight, night crew) → Blast (tomorrow, after Open). E-20:
// Clean (tomorrow, ready, KE). H-1: Inspect (blocked). V-9: Retube (in 5
// days, critical, ready).
const e12 = mk({ id: "e12", name: "E-12 Condenser" });
const open = mk({ id: "op", name: "Open heads", parentId: "e12", plannedStartAt: at("2026-10-26", "18:00"), plannedAt: at("2026-10-27", "02:00"), durationHours: 8, shift: "night", responsibleParty: "Schultz 2" });
const blast = mk({ id: "bl", name: "Hydroblast", parentId: "e12", plannedStartAt: at("2026-10-27", "08:00"), plannedAt: at("2026-10-27", "14:00"), durationHours: 6, responsibleParty: "Ancon", workOrderRef: "4410023" });
const e20 = mk({ id: "e20", name: "E-20 Trim cooler" });
const clean = mk({ id: "cl", name: "Clean flanges", parentId: "e20", plannedStartAt: at("2026-10-27", "06:00"), plannedAt: at("2026-10-27", "10:00"), durationHours: 4, responsibleParty: "Maintenance (KE)" });
const h1 = mk({ id: "h1", name: "H-1 Heater" });
const insp = mk({ id: "in", name: "Inspect tubes", parentId: "h1", plannedStartAt: at("2026-10-27", "07:00"), plannedAt: at("2026-10-27", "11:00"), durationHours: 4, status: "blocked", statusReason: "scaffold" });
const v9 = mk({ id: "v9", name: "V-9 Drum" });
const retube = mk({ id: "rt", name: "Retube bundle", parentId: "v9", plannedStartAt: at("2026-10-31", "06:00"), plannedAt: at("2026-11-01", "17:00"), durationHours: 30, responsibleParty: "Maintenance (KE)" });
const all = [e12, open, blast, e20, clean, h1, insp, v9, retube];
const day = shiftWindow("2026-10-26", "day", CHI);
const build = (pullIds?: string[]) => buildShiftReport({ milestones: all, tz: CHI, shift: day, now: day.end, lookAheadUntil: Infinity, pullIds });

describe("look-ahead", () => {
  const r = build();
  const byId = new Map(r.goals.lookAhead.map((x) => [x.row.leaf.id, x]));
  it("offers upcoming steps not on any list — not tonight's own work", () => {
    expect(byId.has("op")).toBe(false);
    expect([...byId.keys()].sort()).toEqual(["bl", "cl", "in", "rt"]);
  });
  it("reads readiness from the step order: after tonight's step, ready, blocked", () => {
    expect(byId.get("bl")!.readiness).toBe("after-tonight");
    expect(byId.get("bl")!.waits).toEqual(["Open heads"]);
    expect(byId.get("cl")!.readiness).toBe("ready");
    expect(byId.get("rt")!.readiness).toBe("ready");
    expect(byId.get("in")!.readiness).toBe("held");
  });
  it("readiest first, then soonest", () => {
    expect(r.goals.lookAhead.map((x) => x.row.leaf.id)).toEqual(["cl", "rt", "bl", "in"]);
  });
  it("without a search: the window and ready-only; a search finds anything in the job", () => {
    const next = r.next;
    const in3 = filterLookAhead(r.goals.lookAhead, { query: "", readyOnly: true, criticalOnly: false, until: next.end + 3 * 86_400_000 });
    expect(in3.map((x) => x.row.leaf.id)).toEqual(["cl", "bl"]);
    expect(filterLookAhead(r.goals.lookAhead, { query: "4410023", readyOnly: true, criticalOnly: false, until: 0 }).map((x) => x.row.leaf.id)).toEqual(["bl"]);
    expect(filterLookAhead(r.goals.lookAhead, { query: "h-1 inspect", readyOnly: true, criticalOnly: false, until: 0 }).map((x) => x.row.leaf.id)).toEqual(["in"]);
    expect(filterLookAhead(r.goals.lookAhead, { query: "e-20 nothing-like-this", readyOnly: false, criticalOnly: false, until: Infinity })).toEqual([]);
  });
  it("names another crew's scope; not the crew doing the work", () => {
    const bl = byId.get("bl")!, cl = byId.get("cl")!;
    expect(scopeOf(bl, "Maintenance (KE)")).toBe("Ancon");
    expect(scopeOf(cl, "maintenance (ke)")).toBeNull();
  });
});

describe("pulled forward", () => {
  const r = build(["cl", "rt"]);
  it("comes back as next-shift rows (still in the look-ahead, shown as added), at most one shift's hours each", () => {
    expect(r.goals.pulled.map((x) => x.leaf.id)).toEqual(["cl", "rt"]);
    expect(r.goals.lookAhead.map((x) => x.row.leaf.id)).toContain("cl");
    const rt = r.goals.pulled.find((x) => x.leaf.id === "rt")!;
    expect(rt.hoursNext).toBeLessThanOrEqual(12);
  });
  it("capacity counts each step's share of one shift", () => {
    const c = capacityOf({ crew: "Maintenance (KE)", hands: 2, hours: 12 }, r.goals.pulled, 12);
    expect(c).toEqual({ hours: 24, used: 16, over: false });
    expect(capacityOf({ crew: null, hands: 1, hours: 12 }, r.goals.pulled, 12).over).toBe(true);
  });
  it("ships with where each stood and when it was planned", () => {
    const d = decisionsToShip({ cl: { tryIt: true, pulled: true, crew: "Maintenance (KE)" } }, r.goals.pulled);
    expect(d.cl).toMatchObject({ tryIt: true, pulled: true, pctAtShip: 0, name: "Clean flanges" });
    expect(typeof d.cl.plannedStart).toBe("number");
  });
  it("the email lists them on the next shift's list with the crew, hours of capacity and why", () => {
    const text = toPlainText({ kind: "k", project: "p", when: "w", asOf: "a", sections: turnoverUpdate(r, f, {
      pctOf: () => 0, finishOf: () => undefined,
      tryOf: (id) => (id === "cl" || id === "rt" ? { crew: "Maintenance (KE)", note: null } : undefined),
      pull: { crew: "Maintenance (KE)", hands: 2, hours: 12 },
    }) });
    expect(text).toMatch(/Could try if there's time: 2 steps, 16 h of 24 h \(Maintenance \(KE\), 2 × 12 h\)\./);
    expect(text).toMatch(/Clean flanges · .*Could try \(Maintenance \(KE\)\) — pulled ahead — planned/);
  });
});

describe("audit fixes", () => {
  it("a pulled step that gets blocked comes off the list, flagged — not counted or shipped", () => {
    const blocked = { ...clean, status: "blocked", statusReason: "no scaffold" } as Milestone;
    const r = buildShiftReport({ milestones: [e12, open, blast, e20, blocked, h1, insp, v9, retube], tz: CHI, shift: day, now: day.end, pullIds: ["cl"] });
    expect(r.goals.pulled).toEqual([]);
    expect(r.goals.pulledHeld.map((x) => x.leaf.id)).toEqual(["cl"]);
    expect(decisionsToShip({ cl: { tryIt: true, pulled: true } }, [...r.goals.pulled])).toEqual({});
  });
  it("the other crew's work under way isn't offered (it's already listed as paused)", () => {
    const weld = mk({ id: "wd", name: "Weld nozzle", parentId: "e20", plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-29", "17:00"), shift: "day", status: "in_progress", percentComplete: 30 });
    const night = shiftWindow("2026-10-25", "night", CHI);
    const r = buildShiftReport({ milestones: [...all, weld], tz: CHI, shift: night, now: night.end, lookAheadUntil: Infinity });
    const r2 = buildShiftReport({ milestones: [...all, weld], tz: CHI, shift: day, now: day.end, lookAheadUntil: Infinity });
    expect(r2.goals.paused.map((x) => x.leaf.id)).toContain("wd");
    expect(r2.goals.lookAhead.map((x) => x.row.leaf.id)).not.toContain("wd");
    expect(r.goals.lookAhead.length).toBeGreaterThan(0);
  });
  it("'after X' only when X can be finished on that shift; a blocked predecessor means it can't start", () => {
    // Open heads is a 36 h carry-over: one shift won't finish it.
    const bigOpen = { ...open, plannedStartAt: at("2026-10-25", "18:00"), plannedAt: at("2026-10-26", "06:00"), durationHours: 36, status: "in_progress", percentComplete: 10 } as Milestone;
    const r = buildShiftReport({ milestones: [e12, bigOpen, blast], tz: CHI, shift: day, now: day.end, lookAheadUntil: Infinity });
    expect(r.goals.lookAhead.find((x) => x.row.leaf.id === "bl")!.readiness).toBe("waiting");
    const heldOpen = { ...open, status: "on_hold", statusReason: "permit" } as Milestone;
    const r2 = buildShiftReport({ milestones: [e12, heldOpen, blast], tz: CHI, shift: day, now: day.end, lookAheadUntil: Infinity });
    expect(r2.goals.lookAhead.find((x) => x.row.leaf.id === "bl")!.blockedBy).toBe("Open heads");
  });
  it("ships why each step was asked, and reads back progress honestly", async () => {
    const { askedResult } = await import("@/lib/shiftHandover");
    const r = build(["cl"]);
    expect(decisionsToShip({ cl: { tryIt: true, pulled: true } }, r.goals.pulled, "Maintenance (KE)").cl).toMatchObject({ why: "pulled ahead", crew: "Maintenance (KE)" });
    expect(askedResult({ from: 30, now: 30 })).toBe("no progress");
    expect(askedResult({ from: 0, now: 0 })).toBe("not started");
    expect(askedResult({ from: 30, now: 60 })).toBe("30% → 60%");
    expect(askedResult({ from: 30, now: 100 })).toBe("done ✓");
  });
  it("no crew size set: the email claims no capacity; set: hours shown as counted (a shift at most)", () => {
    const r = build(["cl"]);
    const mail = (pull: { crew: string | null; hands: number; hours: number } | null) => toPlainText({ kind: "k", project: "p", when: "w", asOf: "a", sections: turnoverUpdate(r, f, {
      pctOf: () => 0, finishOf: () => undefined, tryOf: (id) => (id === "cl" ? { crew: null, note: null } : undefined), pull,
    }) });
    expect(mail(null)).toMatch(/Could try if there's time: 1 step, 4 h\./);
    expect(mail({ crew: "KE", hands: 2, hours: 14 })).toMatch(/4 h of 24 h \(KE, 2 × 12 h\)/i);
  });
});
