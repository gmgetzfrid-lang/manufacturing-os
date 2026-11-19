import { describe, it, expect } from "vitest";
import type { Milestone } from "@/types/schema";
import type { AsBuilt } from "@/lib/asBuiltSchedule";
import type { AsBuiltWork } from "@/lib/asBuiltWork";
import { planActivities, nextPlan } from "@/lib/nextPlan";
import { checkPlan, planRisks, workingHours, CHECK_H } from "@/lib/nextPlanCheck";

const tz = "America/Los_Angeles";
const times = { dayStart: "06:00", nightStart: "18:00" };
const t = (d: number, h: number) => Date.UTC(2026, 9, d, h + 7);
const H = 3_600_000;

type S = { id: string; name?: string; crew: string; plannedH: number; planStart?: number | null; start?: number | null; finish?: number | null; worked: string[]; deps?: string[]; found?: "discovery" | "added" };
const job = (orders: Array<{ key: string; name: string; steps: S[] }>) => {
  const milestones = orders.flatMap((o) => o.steps.map((s) => ({
    id: s.id, name: s.name ?? s.id, responsibleParty: s.crew, dependsOn: s.deps ?? [],
    attributes: s.found ? { discovery: { id: `d:${s.id}`, kind: s.found, what: `${s.found} ${s.id}`, foundAt: 0, addedAt: 0, seq: 1, of: 1, impact: {} } } : {},
  }))) as unknown as Milestone[];
  const built = {
    orders: orders.map((o) => ({ key: o.key, name: o.name, foundOn: null, steps: o.steps.map((s) => ({
      id: s.id, name: s.name ?? s.id, crew: s.crew, inPlan: !s.found, plannedH: s.plannedH, planStart: s.planStart ?? null, planFinish: null,
      start: s.start ?? null, finish: s.finish ?? null, status: s.finish != null ? "done" : s.start != null ? "in_progress" : "not_started",
    })) })),
    finish: orders.every((o) => o.steps.every((s) => s.finish != null)) ? Math.max(...orders.flatMap((o) => o.steps.map((s) => s.finish ?? 0))) : null,
  } as unknown as AsBuilt;
  const work = {
    steps: new Map(orders.flatMap((o) => o.steps.map((s) => [s.id, { id: s.id, crew: s.crew, worked: s.worked, moved: {}, earned: {}, waits: [], ready: null, found: !!s.found }] as const))),
    crews: [], shifts: [], orders: new Map(), totals: {}, toolHours: { day: 10, night: 10 },
  } as unknown as AsBuiltWork;
  return { built, work, milestones, tz, times };
};

const D26 = "2026-10-26", D27 = "2026-10-27";
const shutdown = { key: "s", name: "Unit - Shutdown", steps: [{ id: "sd", crew: "Operations", plannedH: 6, planStart: t(26, 6), start: t(26, 6), finish: t(26, 12), worked: [`${D26}:day`] }] };
const startUp = (deps: string[], start: number, finish: number) => ({ key: "u", name: "Unit - Start-Up", steps: [{ id: "u1", crew: "Operations", plannedH: 2, start, finish, worked: [`${D27}:day`], deps }] });

describe("the suggested schedule, from how the job really ran", () => {
  it("nights: a crew that worked a work order on two or more nights; else days; the shutdown round the clock", () => {
    const x = job([
      shutdown,
      { key: "v", name: "V-7", steps: [{ id: "v1", crew: "Schultz", plannedH: 30, deps: ["sd"], start: t(26, 12), finish: t(27, 22), worked: [`${D26}:day`, `${D26}:night`, `${D27}:day`, `${D27}:night`] }] },
      { key: "e", name: "E-12", steps: [{ id: "e1", crew: "Schultz", plannedH: 20, deps: ["sd"], start: t(26, 12), finish: t(27, 20), worked: [`${D26}:day`, `${D27}:day`, `${D27}:night`] }] },
    ]);
    const cal = Object.fromEntries(planActivities(x).map((a) => [a.id, a.cal]));
    expect(cal).toEqual({ sd: "both", v1: "both", e1: "day" });
  });

  it("inspection finds are out of the plan; missed scope is in", () => {
    const x = job([shutdown, { key: "v", name: "V-7", steps: [
      { id: "v1", crew: "Schultz", plannedH: 6, deps: ["sd"], start: t(26, 12), finish: t(26, 18), worked: [`${D26}:day`] },
      { id: "weld", crew: "Maintenance", plannedH: 12, found: "discovery", start: t(27, 6), finish: t(27, 18), worked: [`${D27}:day`] },
      { id: "downcomers", crew: "Schultz", plannedH: 10, found: "added", start: t(27, 6), finish: t(27, 16), worked: [`${D27}:day`] },
    ] }]);
    const p = nextPlan({ ...x, changes: [] });
    expect(p.acts.map((a) => a.id).sort()).toEqual(["downcomers", "sd", "v1"]);
    expect(p.acts.find((a) => a.id === "downcomers")!.basis).toBe("missed scope, added this year");
    expect(nextPlan({ ...x, changes: [], withFound: true }).acts.map((a) => a.id)).toContain("weld");
  });

  it("in the order it was really done: a link not waited on gives way; earlier steps of its work order come first", () => {
    const x = job([shutdown, { key: "e", name: "E-12", steps: [
      { id: "pull", crew: "Schultz", plannedH: 4, deps: ["sd"], start: t(26, 12), finish: t(26, 16), worked: [`${D26}:day`] },
      // Linked to the pull in the file, but started before it was done.
      { id: "blast", crew: "Ancon", plannedH: 4, deps: ["pull"], start: t(26, 13), finish: t(26, 17), worked: [`${D26}:day`] },
      // Linked only to the pull; really went in after the hydroblast too.
      { id: "install", crew: "Schultz", plannedH: 6, deps: ["pull"], start: t(27, 6), finish: t(27, 12), worked: [`${D27}:day`] },
    ] }]);
    const preds = Object.fromEntries(planActivities(x).map((a) => [a.id, a.preds.sort()]));
    expect(preds.blast).toEqual(["sd"]);
    expect(preds.install).toEqual(["blast", "pull"]);
  });
});

describe("the check: this year replayed through the rules", () => {
  const ran = () => job([
    shutdown,
    { key: "e", name: "E-12", steps: [
      { id: "pull", crew: "Schultz", plannedH: 4, deps: ["sd"], start: t(26, 12), finish: t(26, 16), worked: [`${D26}:day`] },
      // The leak: 4 h planned, 30 h of day shifts.
      { id: "hydro", crew: "Maintenance", plannedH: 4, deps: ["pull"], start: t(26, 16), finish: t(28, 16), worked: [`${D26}:day`, `${D27}:day`, "2026-10-28:day"] },
    ] },
    { key: "u", name: "Unit - Start-Up", steps: [{ id: "u1", crew: "Operations", plannedH: 2, start: t(28, 16), finish: t(28, 18), worked: ["2026-10-28:day"], deps: ["hydro"] }] },
  ]);
  it("working hours count only its own shifts", () => {
    expect(workingHours(t(26, 16), t(28, 16), "day", tz, times)).toBe(2 + 12 + 10);
    expect(workingHours(t(26, 16), t(28, 16), "both", tz, times)).toBe(48);
  });
  it("lands on the real finish when the rules hold", () => {
    const x = ran();
    const c = checkPlan(x);
    expect(c.can).toBe(true);
    expect(c.actual).toBe(t(28, 18));
    expect(Math.abs(c.offH!)).toBeLessThanOrEqual(CHECK_H);
    expect(c.ok).toBe(true);
  });
  it("not finished: no check", () => {
    const x = job([shutdown, startUp(["sd"], t(26, 12), null as unknown as number)]);
    (x.built as { finish: number | null }).finish = null;
    expect(checkPlan(x).can).toBe(false);
  });
  it("off by more than a shift: not trusted, and it says where the job and the replay part ways", () => {
    const x = job([
      shutdown,
      { key: "e", name: "E-22", steps: [
        { id: "pull", crew: "Schultz", plannedH: 4, deps: ["sd"], start: t(26, 12), finish: t(26, 16), worked: [`${D26}:day`] },
        // Started two days after the pull with nothing on the schedule in between.
        { id: "blinds", name: "Pull Blinds", crew: "Schultz", plannedH: 2, deps: ["pull"], start: t(28, 14), finish: t(28, 16), worked: ["2026-10-28:day"] },
      ] },
      { key: "u", name: "Unit - Start-Up", steps: [{ id: "u1", crew: "Operations", plannedH: 2, start: t(28, 16), finish: t(28, 18), worked: ["2026-10-28:day"], deps: ["blinds"] }] },
    ]);
    const c = checkPlan(x);
    expect(c.ok).toBe(false);
    expect(c.offH!).toBeLessThan(-CHECK_H);
    expect(c.gap).toMatchObject({ name: "Pull Blinds", order: "E-22", after: "pull", hours: 46 });
  });
  it("a trip off site runs on the clock", () => {
    const x = job([shutdown, { key: "e", name: "E-22", steps: [{ id: "trip", name: "Hotshot Exchanger to Redman", crew: "Maintenance", plannedH: 6, deps: ["sd"], start: t(26, 12), finish: t(28, 12), worked: [`${D26}:day`] }] }]);
    expect(planActivities(x).find((a) => a.id === "trip")!.cal).toBe("both");
  });
  it("a job that ran long is a risk, with what it does to the finish", () => {
    const x = ran();
    const plan = nextPlan({ ...x, changes: [] });
    const r = planRisks({ ...x, changes: [] }, plan);
    expect(r[0].kind).toBe("long");
    expect(r[0].where).toBe("E-12");
    expect(r[0].hours).toBe(20);
    expect(r[0].finishH).toBeGreaterThanOrEqual(20);
    expect(plan.finish).toBeLessThan(x.built.finish! - 12 * H);
  });
});
