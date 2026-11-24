import { describe, it, expect } from "vitest";
import type { Milestone, MilestoneNote } from "@/types/schema";
import { buildAsBuilt, type AsBuilt } from "@/lib/asBuiltSchedule";
import { buildAsBuiltWork, type AsBuiltWork, type CrewWork, type WaitRun } from "@/lib/asBuiltWork";
import type { ProgressLogRow } from "@/lib/progressHistory";
import type { ShiftRecord } from "@/lib/shiftRecord";
import { shiftWindowsBetween } from "@/lib/shiftReport";
import { replayAsBuilt, oneOffDelays, type Replay } from "@/lib/asBuiltReplay";
import { planActivities } from "@/lib/nextPlan";

// The job replayed on what really happened: same work, same crews, better timed.

const tz = "America/Los_Angeles";
const times = { dayStart: "06:00", nightStart: "18:00" };
// Mon Oct 26 2026, plant time (PDT, -7).
const t = (d: number, h: number, m = 0) => Date.UTC(2026, 9, d, h + 7, m);
const K = (d: number, k: "day" | "night" = "day") => `2026-10-${d}:${k}`;

type S = { id: string; name?: string; crew: string; plannedH?: number; planStart?: number | null; start?: number | null; finish?: number | null; worked: string[]; deps?: string[]; found?: "discovery" | "added"; foundAt?: number; waits?: WaitRun[] };
type O = { key: string; name: string; steps: S[] };
const wait = (keys: string[], why: string[] = []): WaitRun => ({ from: keys[0], to: keys[keys.length - 1], shifts: keys.length, keys, why });

/** A finished job, as asBuiltSchedule and asBuiltWork give it. */
const job = (orders: O[], crews: CrewWork[] = []) => {
  const milestones = orders.flatMap((o) => o.steps.map((s) => ({
    id: s.id, name: s.name ?? s.id, responsibleParty: s.crew, dependsOn: s.deps ?? [], status: "completed",
    attributes: s.found ? { discovery: { id: `d:${s.id}`, kind: s.found, what: `found on ${o.name}`, foundAt: s.foundAt ?? 0, addedAt: s.foundAt ?? 0, seq: 1, of: 1, impact: {} } } : {},
  }))) as unknown as Milestone[];
  const built = {
    orders: orders.map((o) => ({ key: o.key, name: o.name, foundOn: null, steps: o.steps.map((s) => ({
      id: s.id, name: s.name ?? s.id, crew: s.crew, inPlan: !s.found, plannedH: s.plannedH ?? 4, planStart: s.planStart ?? null, planFinish: null,
      start: s.start ?? null, barStart: s.start ?? null, finish: s.finish ?? null, status: "done",
    })) })),
  } as unknown as AsBuilt;
  const work = {
    steps: new Map(orders.flatMap((o) => o.steps.map((s) => [s.id, { id: s.id, crew: s.crew, worked: s.worked, moved: {}, earned: {}, waits: s.waits ?? [], ready: null, found: !!s.found }] as const))),
    crews, shifts: shiftWindowsBetween(t(26, 6), t(31, 6), tz, times), orders: new Map(), totals: {}, toolHours: { day: 10, night: 10 },
  } as unknown as AsBuiltWork;
  return { built, work, milestones, tz, times, notes: [] as MilestoneNote[] };
};

const shutdown: O = { key: "sd", name: "Unit - Shutdown", steps: [{ id: "sd", name: "Shut down", crew: "Operations", start: t(26, 6), finish: t(26, 12), worked: [K(26)] }] };
const startUp = (deps: string[], d: number): O => ({ key: "su", name: "Unit - Start-Up", steps: [{ id: "su", name: "Start up", crew: "Operations", deps, start: t(d, 16), finish: t(d, 18), worked: [K(d)] }] });
const move = (r: Replay, id: string) => r.moves.find((m) => m.stepId === id);
const placed = (r: Replay, id: string) => r.steps.find((s) => s.id === id)!;
/** Every shift, how many of a crew's steps the replay puts in it. */
const loadOf = (r: Replay, crew: string) => {
  const n = new Map<string, number>();
  for (const s of r.steps) if (s.crew === crew && s.how === "work") for (const k of s.shifts) n.set(k, (n.get(k) ?? 0) + 1);
  return n;
};

describe("ready work that sat", () => {
  // Schultz worked two steps at once on Monday (Pull and V-7), so it has
  // room for two. Install was ready Monday 4 PM, sat Tuesday while Schultz
  // had only V-7 going, and went in Wednesday.
  const ran = () => job([
    shutdown,
    { key: "e", name: "E-12", steps: [
      { id: "pull", name: "Pull bundle", crew: "Schultz", deps: ["sd"], planStart: t(26, 12), start: t(26, 12), finish: t(26, 16), worked: [K(26)] },
      { id: "install", name: "Install bundle", crew: "Schultz", deps: ["pull"], planStart: t(26, 16), start: t(28, 6), finish: t(28, 16), worked: [K(28)] },
    ] },
    { key: "v", name: "V-7", steps: [{ id: "v1", name: "Clean trays", crew: "Schultz", deps: ["sd"], planStart: t(26, 12), start: t(26, 12), finish: t(27, 16), worked: [K(26), K(27)] }] },
    startUp(["install", "v1"], 28),
  ]);

  it("is pulled in when its crew had room, and says so from the record", () => {
    const r = replayAsBuilt(ran());
    expect(r.actualFinish).toBe(t(28, 18));
    expect(r.replayFinish).toBe(t(27, 18));
    expect(r.savedH).toBe(24);
    expect(placed(r, "install").shifts).toEqual([K(27)]);
    expect(move(r, "install")).toMatchObject({ wasStart: t(28, 6), nowStart: t(27, 6), savedH: 24, crew: "Schultz", order: "E-12" });
    expect(move(r, "install")!.why).toBe("Install bundle was ready at Mon, 10/26 4:00 PM and sat 1 shift while Schultz was on V-7.");
    // Start-up once every work order is done; it moved because Install did.
    expect(move(r, "su")!.why).toBe("Start up started once Install bundle on E-12 was done.");
    expect(move(r, "pull")).toBeUndefined();
    expect(move(r, "v1")).toBeUndefined();
    expect(r.capacity.Schultz).toEqual({ day: 2, night: 0, counted: false });
    expect(r.said).toBe("Same crews, same work, better timed: done Tue, 10/27 6:00 PM instead of Wed, 10/28 6:00 PM, 24 h sooner. Install bundle (E-12) and Clean trays (V-7) set the finish.");
  });

  it("stays when its crew was full", () => {
    // V-7 is worked only on Tuesday, alone: Schultz never had two going.
    const x = ran();
    const v = x.built.orders.find((o) => o.key === "v")!.steps[0] as unknown as { start: number };
    v.start = t(27, 6);
    (x.work.steps.get("v1") as { worked: string[] }).worked = [K(27)];
    const r = replayAsBuilt(x);
    expect(r.capacity.Schultz.day).toBe(1);
    expect(r.savedH).toBe(0);
    expect(r.moves).toEqual([]);
    expect(r.sequence).toBe("as ran");
    expect(r.replayFinish).toBe(r.actualFinish);
    expect(placed(r, "install").shifts).toEqual([K(28)]);
    expect(r.said).toMatch(/^Nothing could be pulled in with the same crews and the same work/);
  });

  it("a phase: only its steps; the crew's room other work really used stays used", () => {
    // V-7 (outside the phase) had Schultz on two steps Tuesday: no room for Install then.
    const x = ran();
    const v = x.built.orders.find((o) => o.key === "v")!;
    v.steps.push({ ...v.steps[0], id: "v2", name: "Box up" });
    x.work.steps.set("v2", { ...x.work.steps.get("v1")!, id: "v2", worked: [K(27)] });
    x.milestones.push({ ...x.milestones.find((m) => m.id === "v1")!, id: "v2", name: "Box up" });
    const r = replayAsBuilt({ ...x, phaseIds: ["sd", "pull", "install", "su"] });
    expect(r.steps.map((s) => s.id).sort()).toEqual(["install", "pull", "sd", "su"]);
    expect(r.capacity.Schultz.day).toBe(2);
    expect(placed(r, "install").shifts).toEqual([K(28)]);
    expect(r.savedH).toBe(0);
    // The whole job: the same, for the same reason.
    expect(replayAsBuilt(x).savedH).toBe(0);
  });

  it("the shutdown stays as it ran", () => {
    const r = replayAsBuilt(ran());
    expect(placed(r, "sd")).toMatchObject({ how: "as ran", shifts: [K(26)], start: t(26, 6), finish: t(26, 12) });
    expect(r.kept).toContain("The shutdown stays as it ran.");
  });
});

describe("waits in progress", () => {
  const ran = (why: string[]) => job([
    shutdown,
    { key: "e", name: "E-12", steps: [{ id: "bundle", name: "Install bundle", crew: "Schultz", deps: ["sd"], planStart: t(26, 12), start: t(26, 12), finish: t(28, 16), worked: [K(26), K(28)], waits: [wait([K(27)], why)] }] },
    startUp(["bundle"], 28),
  ]);

  it("a parts wait keeps its length, and the work after it starts no sooner", () => {
    const r = replayAsBuilt(ran(["Waiting on gaskets from the warehouse"]));
    expect(r.savedH).toBe(0);
    expect(r.moves).toEqual([]);
    expect(placed(r, "bundle").shifts).toEqual([K(26), K(28)]);
    expect(r.kept).toContain('Install bundle (E-12) waited 1 shift, recorded: "Waiting on gaskets from the warehouse". Kept at its real length; the work after it starts no sooner than it really did.');
  });

  it("a hold, a permit, an inspection keep theirs too", () => {
    for (const why of ["On hold for operations", "Hot work permit not issued", "Inspection of the shell"]) expect(replayAsBuilt(ran([why])).savedH).toBe(0);
  });

  it("a wait with nothing logged and no reason is taken out, and said", () => {
    for (const why of [[], ["Scaffold up, started"]]) {
      const r = replayAsBuilt(ran(why));
      expect(r.savedH).toBe(24);
      expect(placed(r, "bundle").shifts).toEqual([K(26), K(27)]);
      expect(move(r, "bundle")!.why).toBe("Install bundle was open 1 shift with nothing logged and no reason recorded.");
      expect(move(r, "bundle")).toMatchObject({ wasStart: t(26, 12), nowStart: t(26, 12), savedH: 24 });
      expect(r.limits[0]).toBe("1 shift on 1 step had nothing logged and no reason recorded (Install bundle): the replay takes them out. If work went on and wasn't entered, or a reason wasn't written down, the replay is too hopeful there.");
    }
  });
});

describe("found work", () => {
  // The weld repair was found Tuesday 10 AM and started Wednesday. Its crew
  // had nothing else going: it still doesn't move before it really started.
  const ran = (worked: string[], waits: WaitRun[] = [], finishDay = 29) => job([
    shutdown,
    { key: "e", name: "E-12", steps: [
      { id: "pull", name: "Pull bundle", crew: "Schultz", deps: ["sd"], start: t(26, 12), finish: t(26, 16), worked: [K(26)] },
      { id: "weld", name: "Weld repair", crew: "Maintenance", found: "discovery", foundAt: t(27, 10), deps: ["pull"], start: t(28, 6), finish: t(finishDay, 16), worked, waits },
    ] },
    startUp(["weld"], finishDay),
  ]);

  it("never moves before it was found or before it really started", () => {
    const r = replayAsBuilt(ran([K(28), K(29)]));
    expect(placed(r, "weld").start).toBe(t(28, 6));
    expect(placed(r, "weld").start!).toBeGreaterThanOrEqual(t(27, 10));
    expect(move(r, "weld")).toBeUndefined();
    expect(r.savedH).toBe(0);
    expect(r.limits).toContain("Found and added work starts no sooner than it really did: the record doesn't say how long approving it and getting ready for it took.");
  });

  it("a wait inside it with no reason still comes out; its start stays", () => {
    const r = replayAsBuilt(ran([K(28), K(30)], [wait([K(29)])], 30));
    expect(move(r, "weld")).toMatchObject({ wasStart: t(28, 6), nowStart: t(28, 6), savedH: 24 });
    expect(r.savedH).toBe(24);
  });
});

describe("crews held to what they really did", () => {
  // Ancon: five jobs all ready Monday morning; it really worked two at once
  // on Monday and Tuesday, then one a day. Days only.
  const one = (id: string, worked: number[]): O => ({ key: id, name: `WO ${id}`, steps: [{ id, name: `Job ${id}`, crew: "Ancon", planStart: t(26, 6), start: t(worked[0], 6), finish: t(worked[worked.length - 1], 16), worked: worked.map((d) => K(d)) }] });
  const ran = () => job([one("a1", [26, 27]), one("a2", [26]), one("a3", [28]), one("a4", [29]), one("a5", [30])], [
    { crew: "Ancon", company: "Ancon", mostMoved: 2, pace: null, perHand: null, byShift: { [K(26)]: { moved: 2, earned: 0, counted: { total: 8, direct: 7, indirect: 1 }, planned: null, verdict: null }, [K(28)]: { moved: 1, earned: 0, counted: { total: 4, direct: 3, indirect: 1 }, planned: null, verdict: null } } },
  ]);

  it("capacity never exceeds the most it really had going in one shift, and no nights it never worked", () => {
    const r = replayAsBuilt(ran());
    expect(r.capacity.Ancon).toEqual({ day: 2, night: 0, counted: true });
    for (const [k, n] of loadOf(r, "Ancon")) { expect(n).toBeLessThanOrEqual(2); expect(k.endsWith(":day")).toBe(true); }
    expect(r.replayFinish).toBe(t(28, 16));
    expect(r.savedH).toBe(48);
    // Said when its head count went down: the replay may ask more of it than were there.
    expect(r.limits).toContain("Ancon's head count ran from 4 to 8 on day shifts. The replay holds it to 2 steps at once every day shift, so on its smaller shifts it may ask more of it than were there.");
  });

  it("a crew with no head count is said", () => {
    const x = ran(); x.work.crews = [];
    expect(replayAsBuilt(x).limits).toContain("Ancon: no head count was recorded on the shifts it worked. It is held to the most steps it worked at once (2 on days); the replay can't know whether it had the hands for more or for fewer.");
  });

  it("never before its first shift on the job", () => {
    // Both ready Monday morning, but Ancon first came Tuesday: nothing of
    // its goes Monday, and one at a time is all it ever did.
    const r = replayAsBuilt(job([one("b1", [27]), one("b2", [28])]));
    expect(r.capacity.Ancon.day).toBe(1);
    for (const s of r.steps) for (const k of s.shifts) expect(k >= K(27)).toBe(true);
    expect(r.moves).toEqual([]);
  });
});

describe("one-off delays as a what-if", () => {
  // Two one-offs: a leak on E-12 (2 shifts), gaskets short on V-7 (1 shift).
  const ran = () => job([
    shutdown,
    { key: "e", name: "E-12", steps: [{ id: "hydro", name: "Hydro test", crew: "Maintenance", deps: ["sd"], start: t(26, 12), finish: t(29, 16), worked: [K(26), K(29)], waits: [wait([K(27), K(28)], ["Leak at the channel head flange, re-test"])] }] },
    { key: "v", name: "V-7", steps: [{ id: "trays", name: "Install trays", crew: "Schultz", deps: ["sd"], start: t(26, 12), finish: t(28, 16), worked: [K(26), K(28)], waits: [wait([K(27)], ["Waiting on gaskets, not delivered"])] }] },
    startUp(["hydro", "trays"], 29),
  ]);

  it("lists them from what was written, each with an id and a plain label", () => {
    expect(oneOffDelays(ran())).toEqual([
      expect.objectContaining({ id: `wait:hydro:${K(27)}`, label: 'Hydro test (E-12) waited 2 shifts: "Leak at the channel head flange, re-test"', cause: "test", shifts: 2, kind: "wait", from: "comment" }),
      expect.objectContaining({ id: `wait:trays:${K(27)}`, label: 'Install trays (V-7) waited 1 shift: "Waiting on gaskets, not delivered"', cause: "material", shifts: 1 }),
    ]);
  });

  it("taking one out removes only that one; the other path then sets the finish", () => {
    const x = ran();
    const base = replayAsBuilt(x);
    expect(base.savedH).toBe(0);
    const r = replayAsBuilt({ ...x, without: [`wait:hydro:${K(27)}`] });
    expect(placed(r, "hydro").shifts).toEqual([K(26), K(27)]);
    // The gaskets wait stays as it was.
    expect(placed(r, "trays").shifts).toEqual([K(26), K(28)]);
    expect(r.kept.some((k) => k.includes("Waiting on gaskets"))).toBe(true);
    expect(r.kept.some((k) => k.includes("Leak"))).toBe(false);
    expect(r.whatIf).toMatchObject({ finishWith: t(29, 18), finishWithout: t(28, 18), savedH: 24 });
    expect(r.whatIf!.said).toBe('Without Hydro test (E-12) waited 2 shifts: done Wed, 10/28 6:00 PM instead of Thu, 10/29 6:00 PM, 24 h sooner. Install trays (V-7) sets the finish then.');
    expect(move(r, "hydro")!.why).toBe('Hydro test had its 2-shift wait (recorded: "Leak at the channel head flange, re-test") taken out.');
    // Both out: the finish comes in further.
    expect(replayAsBuilt({ ...x, without: [`wait:hydro:${K(27)}`, `wait:trays:${K(27)}`] }).replayFinish).toBe(t(27, 18));
  });

  it("from the post-event review: its finding and the causes it put on each shift", () => {
    // Nothing written on the wait; the review's answer puts it on materials.
    const x = job([
      shutdown,
      { key: "e", name: "E-12 - Exchanger", steps: [{ id: "bolt", name: "Bolt up", crew: "Schultz", deps: ["sd"], start: t(26, 12), finish: t(28, 16), worked: [K(26), K(28)], waits: [wait([K(27)])] }] },
      startUp(["bolt"], 28),
    ]);
    const review = {
      findings: [{ key: "materials", title: "A material shortfall on E-12 set the finish", because: "E-12 ran short of parts", status: "draft" as const }],
      stuck: [{ id: "bolt", name: "Bolt up", order: "E-12 - Exchanger", crew: "Schultz", added: false, shifts: [{ key: K(27), cause: "material" as const, said: "Studs short", crewOn: [], answered: true }] }],
    };
    // With the review's reason, the wait is kept.
    expect(replayAsBuilt({ ...x, review }).savedH).toBe(0);
    const list = oneOffDelays({ ...x, review });
    expect(list).toEqual([expect.objectContaining({ id: "review:materials", label: "A material shortfall on E-12 set the finish: Bolt up, 1 shift", from: "review", stepIds: ["bolt"] })]);
    const r = replayAsBuilt({ ...x, review, without: ["review:materials"] });
    expect(r.whatIf).toMatchObject({ finishWith: t(28, 18), finishWithout: t(27, 18), savedH: 24 });
  });

  it("ran long for a leak: the steps past plan after it was written, per work order", () => {
    // Tube side hydro was planned at 4 h (one shift) and took three; a leak
    // was written on it on the first.
    const x = job([
      shutdown,
      { key: "e", name: "E-12", steps: [{ id: "tube", name: "Tube side hydro", crew: "Maintenance", plannedH: 4, deps: ["sd"], planStart: t(26, 12), start: t(26, 12), finish: t(28, 16), worked: [K(26), K(27), K(28)] }] },
      startUp(["tube"], 28),
    ]);
    const notes = [{ milestoneId: "tube", kind: "note", body: "Leaks on shell side preventing tube side.", createdAt: new Date(t(26, 14)).toISOString(), createdBy: "u", orgId: "o" }] as MilestoneNote[];
    const list = oneOffDelays({ ...x, notes });
    expect(list).toEqual([expect.objectContaining({ id: "long:e", kind: "ran long", stepIds: ["tube"], shifts: 2, label: 'E-12: Tube side hydro ran 2 shifts past plan, written: "Leaks on shell side preventing tube side."' })]);
    // Nothing written: nothing to take out.
    expect(oneOffDelays(x).some((d) => d.kind === "ran long")).toBe(false);
    const r = replayAsBuilt({ ...x, notes, without: ["long:e"] });
    expect(placed(r, "tube").shifts).toEqual([K(26)]);
    expect(r.whatIf!.finishWith).toBe(t(28, 18));
    expect(r.whatIf!.finishWithout!).toBeLessThan(t(27, 6));
    expect(r.whatIf!.savedH).toBeGreaterThanOrEqual(24);
  });

  it("one line per work order: a wait and an overrun on the same event go together", () => {
    const x = job([
      shutdown,
      { key: "e", name: "E-12", steps: [
        { id: "tube", name: "Tube side hydro", crew: "Maintenance", plannedH: 4, deps: ["sd"], planStart: t(26, 12), start: t(26, 12), finish: t(29, 16), worked: [K(26), K(27), K(29)], waits: [wait([K(28)], ["Leak at the shell flange"])] },
      ] },
      startUp(["tube"], 29),
    ]);
    const notes = [{ milestoneId: "tube", kind: "note", body: "Leak at the shell flange", createdAt: new Date(t(26, 14)).toISOString(), createdBy: "u", orgId: "o" }] as MilestoneNote[];
    const list = oneOffDelays({ ...x, notes });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "order:e", short: "E-12: Tube side hydro waited 1 shift; Tube side hydro ran 2 shifts past plan", said: "Leak at the shell flange", shifts: 3 });
    const r = replayAsBuilt({ ...x, notes, without: ["order:e"] });
    expect(placed(r, "tube").shifts).toEqual([K(26)]);
  });

  it("each phase's start-up waits only on its own phase's work", () => {
    const x = job([
      { key: "sd1", name: "Unit 1 - Shutdown", steps: [{ id: "sd1", crew: "Operations", start: t(26, 6), finish: t(26, 12), worked: [K(26)] }] },
      { key: "w1", name: "E-12", steps: [{ id: "w1", crew: "Schultz", deps: ["sd1"], start: t(26, 12), finish: t(27, 16), worked: [K(26), K(27)] }] },
      { key: "su1", name: "Unit 1 - Start-Up", steps: [{ id: "su1", crew: "Operations", start: t(28, 6), finish: t(28, 12), worked: [K(28)] }] },
      { key: "sd2", name: "Unit 2 - Shutdown", steps: [{ id: "sd2", crew: "Operations", start: t(29, 6), finish: t(29, 12), worked: [K(29)] }] },
      { key: "w2", name: "V-7", steps: [{ id: "w2", crew: "Schultz", deps: ["sd2"], start: t(29, 12), finish: t(30, 16), worked: [K(29), K(30)] }] },
      { key: "su2", name: "Unit 2 - Start-Up", steps: [{ id: "su2", crew: "Operations", start: t(30, 16), finish: t(30, 18), worked: [K(30)] }] },
    ]);
    const ph: Record<string, string> = { sd1: "Phase 1", w1: "Phase 1", su1: "Phase 1", sd2: "Phase 2", w2: "Phase 2", su2: "Phase 2" };
    for (const o of x.built.orders) (o as { phase?: string }).phase = ph[o.key];
    const acts = planActivities(x);
    const pre = (id: string) => acts.find((a) => a.id === id)!.preds;
    expect(pre("su1")).toContain("w1");
    expect(pre("su1")).not.toContain("w2");
    expect(pre("su2")).toContain("w2");
    expect(pre("su2")).not.toContain("w1");
  });

  it("an id the record doesn't list is left in, and said", () => {
    const r = replayAsBuilt({ ...ran(), without: ["wait:nope"] });
    expect(r.whatIf).toBeNull();
    expect(r.limits).toContain('"wait:nope" is not a delay the record lists: left in.');
  });
});

describe("off site", () => {
  it("keeps its real clock time and isn't pulled in", () => {
    const x = job([
      shutdown,
      { key: "e", name: "E-12", steps: [
        { id: "pull", name: "Pull bundle", crew: "Schultz", deps: ["sd"], start: t(26, 12), finish: t(26, 16), worked: [K(26)] },
        { id: "trip", name: "Hotshot bundle to the shop", crew: "Schultz", deps: ["pull"], start: t(27, 8), finish: t(29, 8), worked: [K(27), K(29)] },
        { id: "set", name: "Set bundle", crew: "Schultz", deps: ["trip"], start: t(29, 8), finish: t(29, 16), worked: [K(29)] },
      ] },
      startUp(["set"], 29),
    ]);
    const r = replayAsBuilt(x);
    expect(placed(r, "trip")).toMatchObject({ how: "off site", start: t(27, 8), finish: t(29, 8) });
    expect(r.savedH).toBe(0);
    expect(oneOffDelays(x).map((d) => d.label)).toEqual(["Hotshot bundle to the shop (E-12): 2 days off site"]);
    const w = replayAsBuilt({ ...x, without: ["offsite:trip"] });
    expect(w.whatIf!.finishWithout!).toBeLessThan(w.whatIf!.finishWith!);
  });
});

describe("nothing invented", () => {
  it("every reason names only what the record holds", () => {
    const x = job([
      shutdown,
      { key: "e", name: "E-12", steps: [
        { id: "pull", name: "Pull bundle", crew: "Schultz", deps: ["sd"], planStart: t(26, 12), start: t(26, 12), finish: t(26, 16), worked: [K(26)] },
        { id: "install", name: "Install bundle", crew: "Schultz", deps: ["pull"], planStart: t(26, 16), start: t(29, 6), finish: t(29, 16), worked: [K(29)] },
      ] },
      startUp(["install"], 29),
    ]);
    const r = replayAsBuilt(x);
    // Schultz logged nothing while it sat: said so, no crew move made up.
    expect(move(r, "install")!.why).toBe("Install bundle was ready at Mon, 10/26 4:00 PM and sat 2 shifts while Schultz logged no work.");
    const known = ["Pull bundle", "Install bundle", "Start up", "E-12", "Schultz", "Operations"];
    for (const m of r.moves) {
      expect(known.some((k) => m.why.startsWith(k))).toBe(true);
      for (const q of m.why.match(/"[^"]+"/g) ?? []) expect([]).toContain(q);
    }
  });

  it("a step with no links and no planned time isn't pulled in: when it was ready isn't recorded", () => {
    const x = job([
      { key: "a", name: "WO A", steps: [{ id: "a", name: "Job A", crew: "Ancon", start: t(26, 6), finish: t(26, 16), worked: [K(26)] }] },
      { key: "b", name: "WO B", steps: [{ id: "b", name: "Job B", crew: "Ancon", start: t(28, 6), finish: t(28, 16), worked: [K(28)] }] },
    ]);
    const r = replayAsBuilt(x);
    expect(r.moves).toEqual([]);
    expect(r.savedH).toBe(0);
  });

  it("not finished: nothing to replay against", () => {
    const x = job([shutdown]);
    (x.built.orders[0].steps[0] as { status: string }).status = "in_progress";
    const r = replayAsBuilt(x);
    expect(r).toMatchObject({ actualFinish: null, savedH: 0, moves: [] });
  });
});

describe("on the as-built work fixture (lib/asBuiltWork's own)", () => {
  const at = (d: number, h: number, m = 0) => new Date(Date.UTC(2026, 9, d, h + 7, m)).toISOString();
  const ms = (x: Partial<Milestone> & { id: string; name: string }): Milestone => ({ status: "completed", plannedAt: at(26, 18), percentComplete: 100, durationHours: 8, ...x } as Milestone);
  const wo: Milestone = { id: "wo", name: "PSVs", status: "completed", plannedAt: at(26, 18), isSummary: true, attributes: { "Work Order": "300" } } as unknown as Milestone;
  const psv = ms({ id: "psv", parentId: "wo", name: "PSV-021 swap", plannedStartAt: at(26, 10), plannedAt: at(26, 18), actualStartAt: at(26, 10), actualAt: at(30, 21, 30), actualParty: "Maintenance (KE)" });
  const pull = ms({ id: "pull", parentId: "wo", name: "Remove piping", plannedStartAt: at(26, 6), plannedAt: at(26, 8), actualStartAt: at(26, 14), actualAt: at(26, 16), responsibleParty: "Maintenance (KE)", durationHours: 2 });
  const blast = ms({ id: "blast", parentId: "wo", name: "Hydroblast piping", plannedStartAt: at(26, 8), plannedAt: at(26, 10), actualStartAt: at(28, 19), actualAt: at(29, 1), responsibleParty: "Ancon", durationHours: 2, dependsOn: ["pull"] });
  const other = ms({ id: "other", parentId: "wo2", name: "E-12 hydroblast", plannedStartAt: at(27, 6), plannedAt: at(27, 10), actualStartAt: at(27, 7), actualAt: at(28, 15), responsibleParty: "Ancon", durationHours: 4 });
  const wo2: Milestone = { id: "wo2", name: "E-12", status: "completed", plannedAt: at(27, 18), isSummary: true, attributes: { "Work Order": "301" } } as unknown as Milestone;
  const all = [wo, wo2, psv, pull, blast, other];
  const kids = new Map<string, Milestone[]>([["wo", [psv, pull, blast]], ["wo2", [other]]]);
  const row = (id: string, tt: string, from: number | null, to: number | null, st: ProgressLogRow["new_status"], old: ProgressLogRow["old_status"] = "in_progress"): ProgressLogRow => ({ milestone_id: id, at: tt, old_status: old, new_status: st, old_percent: from, new_percent: to });
  const log: ProgressLogRow[] = [
    row("psv", at(26, 10), 0, 0, "in_progress", "planned"), row("psv", at(27, 11), 0, 20, "in_progress"), row("psv", at(28, 14), 20, 40, "in_progress"),
    row("psv", at(30, 13), 40, 75, "in_progress"), row("psv", at(30, 21, 30), 75, 100, "completed"),
    row("pull", at(26, 16), 0, 100, "completed", "planned"),
    row("other", at(27, 9), 0, 50, "in_progress", "planned"), row("other", at(27, 20), 50, 80, "in_progress"), row("other", at(28, 15), 80, 100, "completed"),
    row("blast", at(29, 1), 0, 100, "completed", "planned"),
  ];
  const note = (id: string, tt: string, body: string): MilestoneNote => ({ milestoneId: id, kind: "note", body, createdAt: tt, createdBy: "u", orgId: "o" });
  const notes = [note("psv", at(27, 11), "PSV pulled. Discovered plugging in line."), note("psv", at(28, 10), "New PSV installed ready for E/I to run tubing for pilot")];
  const records = new Map<string, ShiftRecord>([["2026-10-27:day", { crews: { Ancon: { headcount: 10 } } }], ["2026-10-28:day", { crews: { Ancon: { headcount: 10, direct: 8, indirect: 2 } } }]]);
  const built = buildAsBuilt({ milestones: all, childrenByParent: kids, tz });
  const timesB = { ...times, breaks: [{ shift: "day" as const, start: "11:00", minutes: 30, label: "Lunch" }] };
  const work = buildAsBuiltWork({ built, milestones: all, log, notes, records, companyOf: (c) => c, tz, times: timesB, now: Date.parse(at(31, 12)) });

  it("Hydroblast piping sat because Ancon was on E-12 every night it had; the PSV's wait for E/I is kept; nothing to pull in", () => {
    const r = replayAsBuilt({ built, work, milestones: all, tz, times: timesB, notes });
    expect(r.actualFinish).toBe(Date.parse(at(30, 21, 30)));
    expect(r.capacity.Ancon).toEqual({ day: 1, night: 1, counted: true });
    expect(r.capacity["Maintenance (KE)"]).toEqual({ day: 2, night: 1, counted: false });
    expect(placed(r, "blast").shifts).toEqual(["2026-10-28:night"]);
    expect(r.kept).toContain('PSV-021 swap (PSVs) waited 1 shift, recorded: "New PSV installed ready for E/I to run tubing for pilot". Kept at its real length; the work after it starts no sooner than it really did.');
    expect(r.savedH).toBe(0);
    expect(r.moves).toEqual([]);
    expect(r.said).toBe("Nothing could be pulled in with the same crews and the same work: the finish stays at Fri, 10/30 9:30 PM, set by PSV-021 swap (PSVs).");
    expect(r.limits).toContain("Maintenance (KE): no head count was recorded on the shifts it worked. It is held to the most steps it worked at once (2 on days, 1 on nights); the replay can't know whether it had the hands for more or for fewer.");
    expect(oneOffDelays({ built, work, milestones: all, tz, times: timesB, notes })).toEqual([]);
  });

  it("with the E/I wait unexplained, the PSV comes in; nothing else moves", () => {
    const r = replayAsBuilt({ built, work: { ...work, steps: new Map([...work.steps].map(([k, w]) => [k, k === "psv" ? { ...w, waits: w.waits.map((x) => ({ ...x, why: [] })) } : w])) }, milestones: all, tz, times: timesB, notes });
    // Its one night goes on a day shift: Maintenance (KE) worked no night before 10/30.
    expect(placed(r, "psv").shifts).toEqual(["2026-10-26:day", "2026-10-27:day", "2026-10-28:day", "2026-10-29:day", "2026-10-30:day"]);
    expect(r.savedH).toBe(12);
    expect(move(r, "psv")!.why).toBe("PSV-021 swap was open 1 shift with nothing logged and no reason recorded.");
    expect(r.moves.map((m) => m.stepId)).toEqual(["psv"]);
  });
});
