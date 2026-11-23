import { describe, it, expect } from "vitest";
import type { Milestone } from "@/types/schema";
import type { AsBuilt } from "@/lib/asBuiltSchedule";
import type { AsBuiltWork, CrewWork } from "@/lib/asBuiltWork";
import { nextPlan, dayNumber, rampWarning, mostAtOnce, type PlanChange } from "@/lib/nextPlan";
import { toTarget } from "@/lib/nextPlanLessons";
import { checkPlan } from "@/lib/nextPlanCheck";
import { shiftWindowsBetween } from "@/lib/shiftReport";

// A crew's size is set before the job starts and held for the whole job.

const tz = "America/Los_Angeles";
const times = { dayStart: "06:00", nightStart: "18:00" };
// Day 1 is Mon Oct 26 2026 (PDT, -7).
const t = (d: number, h: number) => Date.UTC(2026, 9, 25 + d, h + 7);
const key = (d: number, k: "day" | "night" = "day") => `2026-10-${25 + d}:${k}`;

type S = { id: string; crew: string; plannedH: number; day: number; startDay?: number; worked: number[] };
/** A job of single-step work orders, each on days, worked on the days given. */
const job = (steps: S[], crews: CrewWork[] = []) => {
  const milestones = steps.map((s) => ({ id: s.id, name: s.id, responsibleParty: s.crew, dependsOn: [], attributes: {} })) as unknown as Milestone[];
  const built = {
    orders: steps.map((s) => ({ key: `o-${s.id}`, name: `WO ${s.id}`, foundOn: null, steps: [{
      id: s.id, name: s.id, crew: s.crew, inPlan: true, plannedH: s.plannedH, planStart: t(s.day, 6), planFinish: null,
      start: t(s.startDay ?? s.day, 6), finish: t(s.worked[s.worked.length - 1], 6) + s.plannedH * 3_600_000, status: "done",
    }] })),
    finish: Math.max(...steps.map((s) => t(s.worked[s.worked.length - 1], 6) + s.plannedH * 3_600_000)),
  } as unknown as AsBuilt;
  const work = {
    steps: new Map(steps.map((s) => [s.id, { id: s.id, crew: s.crew, worked: s.worked.map((d) => key(d)), moved: {}, earned: {}, waits: [], ready: null, found: false }] as const)),
    crews, shifts: shiftWindowsBetween(t(1, 6), t(8, 6), tz, times), orders: new Map(), totals: {}, toolHours: { day: 10, night: 10 },
  } as unknown as AsBuiltWork;
  return { built, work, milestones, tz, times };
};
/** A contractor's record: a staffing plan's hands on the tools by day (days only). */
const planned = (crew: string, byDay: Record<number, number>, mhPerPlanH: number): CrewWork => ({
  crew, company: crew, mostMoved: 2, perHand: null, pace: { mhPerPlanH, from: "plan", shifts: Object.keys(byDay).length },
  byShift: Object.fromEntries(Object.entries(byDay).map(([d, n]) => [key(Number(d)), { moved: 0, earned: 0, counted: null, planned: { direct: n, indirect: 2 }, verdict: null }])),
});
const c = (x: Record<string, unknown>): PlanChange => ({ id: `${String(x.kind)}${Math.random()}`, said: "", at: 0, ...x } as PlanChange);
type Plan = ReturnType<typeof nextPlan>;
const going = (p: Plan, crew: string) => Math.max(0, ...(p.jobs[crew] ?? []));
const atOnce = (p: Plan, crew: string) => mostAtOnce(p.acts.filter((a) => a.crew === crew && a.hours > 0));

describe("a crew held at its size for the whole job", () => {
  // Ancon: 2 jobs on Day 1, then 6 ready on Day 3. No hands entered; this
  // year it worked 3 in a shift at the most (Day 3 and Day 4).
  const ancon = () => job([
    { id: "a1", crew: "Ancon", plannedH: 10, day: 1, worked: [1] },
    { id: "a2", crew: "Ancon", plannedH: 10, day: 1, worked: [1] },
    ...[1, 2, 3].map((i) => ({ id: `b${i}`, crew: "Ancon", plannedH: 10, day: 3, worked: [3] })),
    ...[4, 5, 6].map((i) => ({ id: `b${i}`, crew: "Ancon", plannedH: 10, day: 3, startDay: 4, worked: [4] })),
  ]);

  it("no hands known: never more going at once than it worked this year; the rest wait, and the finish moves later", () => {
    const x = ancon();
    const p = nextPlan({ ...x, changes: [] });
    expect(p.sizes.Ancon).toMatchObject({ hands: null, jobs: 3, from: "worked", worked: 3 });
    expect(going(p, "Ancon")).toBe(3);
    expect(atOnce(p, "Ancon")).toBeLessThanOrEqual(3);
    // Three of the six wait for the crew, and finish the next day.
    const bs = p.acts.filter((a) => a.id.startsWith("b"));
    expect(bs.filter((a) => a.start === t(3, 6))).toHaveLength(3);
    expect(bs.filter((a) => a.heldForCrew)).toHaveLength(3);
    expect(p.finish).toBe(t(4, 14)); // 4 PM to 6 PM on Day 3, then 6 AM to 2 PM on Day 4
    // Six at once (no crew held) would finish Day 3 at 4 PM.
    expect(nextPlan({ ...x, changes: [c({ kind: "jobs", crew: "Ancon", n: 6 })] }).finish).toBe(t(3, 16));
  });

  it("a person's setting replaces it and is held from Day 1: \"Ancon has 2 crews\"", () => {
    const p = nextPlan({ ...ancon(), changes: [c({ kind: "jobs", crew: "Ancon", n: 2 })] });
    expect(p.sizes.Ancon).toMatchObject({ jobs: 2, from: "person" });
    expect(p.jobs.Ancon[0]).toBe(2); // Day 1, day shift: both of its jobs
    for (const n of p.jobs.Ancon) expect(n).toBeLessThanOrEqual(2);
    expect(atOnce(p, "Ancon")).toBe(2);
    expect(p.finish).toBeGreaterThan(t(4, 14));
  });

  it("a staffing plan that adds people mid-job: held at its first count every shift, and said", () => {
    // 10 on the tools on Days 1 and 2, 18 from Day 3. At 5 man-hours a plan
    // hour and 10 h on the tools, 10 hands carry two 10 h jobs a shift.
    const x = job([
      { id: "s1", crew: "Schultz", plannedH: 10, day: 1, worked: [1] },
      { id: "s2", crew: "Schultz", plannedH: 10, day: 1, worked: [1] },
      ...[3, 4, 5, 6, 7, 8].map((i) => ({ id: `s${i}`, crew: "Schultz", plannedH: 10, day: 3, worked: [3] })),
    ], [planned("Schultz", { 1: 10, 2: 10, 3: 18, 4: 18, 5: 18 }, 5)]);
    const p = nextPlan({ ...x, changes: [] });
    const s = p.sizes.Schultz;
    expect(s).toMatchObject({ hands: { day: 10, night: null }, jobs: null, from: "plan" });
    for (const n of p.heads.Schultz) expect(n).toBeLessThanOrEqual(10);
    // Two at a time from Day 3: Days 3, 4 and 5.
    expect(p.acts.filter((a) => a.start === t(3, 6))).toHaveLength(2);
    expect(p.finish).toBe(t(5, 16));
    expect(s.ramp).toEqual([{ kind: "day", first: 10, firstAt: t(1, 6), rises: [{ at: t(3, 6), n: 8 }] }]);
    const words = rampWarning("Schultz", s, (at) => dayNumber(p, at, tz), dayNumber(p, p.finish, tz));
    expect(words).toBe("Schultz's staffing plan adds 8 on the tools on Day 3. People can't be found mid-job on a one-week job: this schedule holds Schultz at its Day 1 count (10).");
  });

  it("a flat staffing plan says nothing", () => {
    const x = job([{ id: "s1", crew: "Schultz", plannedH: 10, day: 1, worked: [1] }], [planned("Schultz", { 1: 10, 2: 10, 3: 10 }, 5)]);
    const p = nextPlan({ ...x, changes: [] });
    expect(rampWarning("Schultz", p.sizes.Schultz, (at) => dayNumber(p, at, tz), 3)).toBeNull();
  });

  it("another crew to make the target is brought for the whole job: more on every shift from Day 1, not mid-job", () => {
    // Three of Schultz's jobs on Day 1; 10 hands carry two.
    const x = job([1, 2, 3].map((i) => ({ id: `s${i}`, crew: "Schultz", plannedH: 10, day: 1, worked: [1] })), [planned("Schultz", { 1: 10, 2: 10 }, 5)]);
    const p = nextPlan({ ...x, changes: [] });
    expect(p.finish).toBe(t(2, 16));
    const reach = toTarget(x, [], p, t(1, 18), (k) => k);
    expect(reach.levers).toHaveLength(1);
    const l = reach.levers[0];
    expect(l.change).toMatchObject({ kind: "more", crew: "Schultz", crews: 1 });
    expect(l.words).toBe("Bring another Schultz crew for the whole job, Day 1 to Day 1: 6 more on the tools every day shift (72 man-hours)");
    const more = nextPlan({ ...x, changes: [l.change] });
    // One size, every shift: 10 plus one more crew (one 12 h job at 5 man-hours a plan hour, 10 h on the tools).
    expect(more.sizes.Schultz.hands).toEqual({ day: 16, night: null });
    expect(more.crewSize.Schultz).toEqual({ day: 16, night: null });
    // The third job goes on Day 1 with the others.
    expect(more.acts.every((a) => a.start === t(1, 6))).toBe(true);
    expect(more.finish).toBe(t(1, 16));
  });

  it("the check runs this year back through the same rule", () => {
    const x = ancon();
    const k = checkPlan(x);
    expect(k.can).toBe(true);
    // This year Ancon really did b4 to b6 on Day 4: held at 3, the replay lands with it.
    expect(k.ok).toBe(true);
  });
});
