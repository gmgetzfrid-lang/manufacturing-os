// Update by note: what's read from the AI is checked here before anything
// can be saved - which step, what changed, and above all when.

import { describe, it, expect } from "vitest";
import {
  stepCatalog, catalogText, parseReply, readTime, roundTime, toLines, checkLine, saveEvents, defaultTimes, hasMeridiem, saidClock,
  type RawUpdate, type CatalogStep,
} from "@/lib/quickUpdate";
import type { ShiftTimes } from "@/lib/shiftReport";
import type { Milestone } from "@/types/schema";

const tz = "America/Los_Angeles";
const times: ShiftTimes = { dayStart: "06:00", nightStart: "18:00" };
const T = (d: string, hm: string) => Date.parse(`2026-11-${d}T${hm}:00-08:00`);
const now = T("03", "09:40");
const ctx = { now, tz, times };
const iso = (d: string, hm: string) => new Date(T(d, hm)).toISOString();
const mk = (p: Partial<Milestone> & { id: string; name: string }): Milestone => ({ orgId: "o", projectId: "p", weight: 1, status: "planned", source: "manual", createdBy: "u", percentComplete: 0, ...p } as Milestone);

const ms: Milestone[] = [
  mk({ id: "e02", name: "E-02 - De-Butanizer Condenser", workOrderRef: "310456" }),
  mk({ id: "rm", parentId: "e02", name: "Remove Channel Head", responsibleParty: "Schultz", plannedStartAt: iso("02", "08:00"), plannedAt: iso("02", "12:00") }),
  mk({ id: "hb", parentId: "e02", name: "Hydroblast Channel Head", responsibleParty: "Ancon", plannedStartAt: iso("02", "12:00"), plannedAt: iso("02", "16:00") }),
  mk({ id: "ri", parentId: "e02", name: "Reinstall Channel Head", responsibleParty: "Schultz", plannedStartAt: iso("03", "08:00"), plannedAt: iso("03", "14:00") }),
  mk({ id: "v01", name: "V-01 - De-Butanizer Column", workOrderRef: "310359" }),
  mk({ id: "tr", parentId: "v01", name: "Remove Trays", responsibleParty: "Schultz", status: "in_progress", percentComplete: 40, actualStartAt: iso("02", "14:00"), plannedStartAt: iso("02", "14:00"), plannedAt: iso("03", "08:00") }),
  mk({ id: "mw", parentId: "v01", name: "Close Manway Covers", plannedStartAt: iso("04", "18:00"), plannedAt: iso("04", "20:00") }),
  mk({ id: "op", parentId: "v01", name: "Remove Manway Covers", status: "completed", percentComplete: 100, actualStartAt: iso("02", "13:00"), actualAt: iso("02", "14:30"), plannedStartAt: iso("02", "10:00"), plannedAt: iso("02", "12:00") }),
  mk({ id: "gone", parentId: "v01", name: "Cancelled step", cancelledAt: iso("02", "06:00") }),
];
const cat = stepCatalog(ms);
const key = (id: string) => cat.find((c) => c.id === id)!.key;
const step = (id: string) => cat.find((c) => c.id === id) as CatalogStep;

describe("the steps the AI is given", () => {
  it("every live step, by work order, each with a short key and its WO and equipment", () => {
    expect(cat.map((c) => c.id)).toEqual(["op", "tr", "mw", "rm", "hb", "ri"]);
    expect(cat[3]).toMatchObject({ key: "s4", wo: "310456", place: "E-02 - De-Butanizer Condenser" });
    const text = catalogText(cat, tz);
    expect(text).toContain("s2 | WO 310359 | V-01 - De-Butanizer Column > Remove Trays | Schultz | in progress 40%");
    expect(text).not.toContain("Cancelled step");
  });
});

describe("times: rounded to the half hour, never later than now", () => {
  it("nearest half hour; one that would land in the future goes down", () => {
    expect(roundTime(T("02", "14:10"), now)).toBe(T("02", "14:00"));
    expect(roundTime(T("02", "14:20"), now)).toBe(T("02", "14:30"));
    expect(roundTime(now, now)).toBe(T("03", "09:30"));
    expect(roundTime(T("03", "09:52"), T("03", "09:52"))).toBe(T("03", "09:30"));
  });
  it("AM or PM said plainly, in all the usual ways", () => {
    for (const w of ["2pm", "2 pm", "2:30 p.m.", "7a", "0730", "1430", "14:30", "noon", "this morning at 7"]) expect(hasMeridiem(w)).toBe(true);
    for (const w of ["at 2", "2:30", "around 9"]) expect(hasMeridiem(w)).toBe(false);
    expect(saidClock("2:30pm")).toEqual({ h: 14, m: 30 });
    expect(saidClock("0730")).toEqual({ h: 7, m: 30 });
    expect(saidClock("at 2")).toBeNull();
  });
});

describe("when it happened", () => {
  const def = T("03", "09:30");
  const read = (words: string | null, kind: RawUpdate["when"]["kind"], local: string | null) => readTime({ words, kind, local }, def, ctx);
  it("no time said: the time chosen for the batch", () => {
    expect(read(null, "none", null)).toEqual({ at: def, from: "default" });
  });
  it("a plain time in the past: that time, to the half hour", () => {
    expect(read("2pm yesterday", "day", "2026-11-02 14:10")).toEqual({ ask: "time", why: expect.stringContaining("Couldn't be sure") });
    expect(read("2pm yesterday", "day", "2026-11-02 14:00")).toEqual({ at: T("02", "14:00"), from: "said" });
    expect(read("0730", "clock", "2026-11-03 07:30")).toEqual({ at: T("03", "07:30"), from: "said" });
  });
  it("the AI's reading must match the words: 2pm read as 2 AM is asked", () => {
    expect(read("2pm", "clock", "2026-11-03 02:00")).toMatchObject({ ask: "time" });
  });
  it("no AM or PM and both readings already past: asked, with both", () => {
    const r = read("at 2", "clock", "2026-11-03 02:00");
    expect(r).toEqual({ ask: "ampm", options: [T("02", "14:00"), T("03", "02:00")], why: "“at 2”: AM or PM?" });
  });
  it("no AM or PM, read as later today: still asked, the last 4 AM and the last 4 PM", () => {
    expect(read("at 4", "clock", "2026-11-03 16:00")).toEqual({ ask: "ampm", options: [T("02", "16:00"), T("03", "04:00")], why: "“at 4”: AM or PM?" });
  });
  it("not come yet: an expectation, never done", () => {
    expect(read("in a couple hours", "future", null)).toEqual({ future: true });
    expect(read("by 2pm", "clock", "2026-11-03 14:00")).toEqual({ future: true });
  });
  it("past with no time, or a day with no time: asked", () => {
    expect(read("earlier", "unclear", null)).toMatchObject({ ask: "time" });
    expect(read("yesterday", "day", "2026-11-02 00:00")).toMatchObject({ ask: "time", why: "You said “yesterday” but not what time." });
  });
  it("the day words must agree with the reading", () => {
    expect(read("yesterday at 3pm", "day", "2026-11-03 15:00")).toMatchObject({ ask: "time" });
    expect(read("this morning at 7", "day", "2026-11-02 07:00")).toMatchObject({ ask: "time" });
    expect(read("last night at 11pm", "day", "2026-11-02 23:00")).toEqual({ at: T("02", "23:00"), from: "said" });
    expect(read("last night at 11am", "day", "2026-11-02 11:00")).toMatchObject({ ask: "time" });
  });
  it("more than two weeks back: asked", () => {
    expect(read("Oct 1 at 2pm", "day", "2026-10-01 14:00")).toMatchObject({ ask: "time" });
  });
  it("the batch's time choices: now, the end of the last shift, the start of this one", () => {
    const d = defaultTimes(ctx);
    expect(d.map((x) => x.id)).toEqual(["now", "last", "start"]);
    expect(d[0].at).toBe(T("03", "09:30"));
    expect(d[1].at).toBe(T("03", "05:30"));
    expect(d[2].at).toBe(T("03", "06:00"));
  });
});

describe("the lines to check", () => {
  const def = T("03", "09:30");
  const reply = parseReply({
    updates: [
      { step: key("rm"), action: "done", implied: true, evidence: "channel head is on the ground", when: { kind: "none" } },
      { step: key("hb"), action: "done", evidence: "they washed it", when: { kind: "none" } },
      { step: key("ri"), action: "progress", percent: null, percentFrom: "guess", suggest: 5, evidence: "must be staging to put it back", when: { kind: "none" } },
      { step: null, candidates: [key("mw"), key("op")], action: "done", evidence: "v1 manway done", when: { kind: "none" } },
      { step: key("tr"), action: "progress", percent: "30", percentFrom: "said", evidence: "v1 trays 30", when: { kind: "none" } },
      { step: "s99", action: "done", evidence: "pump p-9 done" },
      { step: key("tr"), action: "dance", evidence: "weird" },
      { step: key("ri"), action: "done", evidence: "should be back on in a couple hours", when: { words: "in a couple hours", kind: "future" } },
    ],
    unplaced: [{ text: "crane showed up late", why: "no step for it" }],
  });
  const { lines, unplaced } = toLines(reply, cat, def, ctx);
  const line = (i: number) => lines[i];
  it("unknown steps and unreadable parts are listed, never dropped", () => {
    expect(unplaced.map((u) => u.text)).toEqual(expect.arrayContaining(["weird", "crane showed up late", "pump p-9 done"]));
  });
  it("a step the note implies comes unticked; one it names, ticked", () => {
    expect(line(0)).toMatchObject({ stepId: "rm", implied: true, include: false });
    expect(line(1)).toMatchObject({ stepId: "hb", include: true, at: def, timeFrom: "default" });
  });
  it("a % guessed from words is asked, never saved", () => {
    expect(checkLine(line(2), step("ri"), now, tz).needs).toEqual(["How far along? (not said)"]);
  });
  it("two possible steps: the person picks", () => {
    expect(line(3)).toMatchObject({ stepId: null, options: ["mw", "op"] });
    expect(checkLine(line(3), undefined, now, tz).needs).toEqual(["Which step is it?"]);
  });
  it("a % lower than the step already is: not saved here", () => {
    expect(checkLine(line(4), step("tr"), now, tz).needs[0]).toMatch(/at 40% already/);
  });
  it("an expectation becomes a comment, not done", () => {
    const l = lines.find((x) => x.expected)!;
    expect(l).toMatchObject({ action: "comment", comment: "Expected: should be back on in a couple hours" });
  });
  it("ready lines save in time order with the person's words on the step; blocked and unticked ones don't", () => {
    const ev = saveEvents(lines, cat, now, tz);
    expect([...ev.keys()].sort()).toEqual(["hb", "ri"]);
    expect(ev.get("hb")).toEqual([{ kind: "done", at: def }, { kind: "note", at: def, text: "they washed it" }]);
    // The guessed-% line is held back; the expectation still goes on as a comment.
    expect(ev.get("ri")).toEqual([{ kind: "note", at: def, text: "Expected: should be back on in a couple hours · should be back on in a couple hours" .split(" · ")[0] }]);
  });
  it("once the person answers, the line is ready", () => {
    const fixed = { ...line(2), percent: 10 };
    expect(checkLine(fixed, step("ri"), now, tz).needs).toEqual([]);
    const picked = { ...line(3), stepId: "mw" };
    expect(checkLine(picked, step("mw"), now, tz).needs).toEqual([]);
  });
});

describe("guards on a line", () => {
  const base = { id: "x", options: [], percentFrom: "said" as const, suggest: null, reason: null, comment: null, evidence: "e", implied: false, timeWords: null, expected: false, include: true, timeFrom: "said" as const };
  it("done before the step started: asked", () => {
    const l = { ...base, stepId: "tr", action: "done" as const, percent: null, at: T("02", "12:00") };
    expect(checkLine(l, step("tr"), now, tz).needs[0]).toMatch(/before it started/);
  });
  it("on hold needs a reason", () => {
    const l = { ...base, stepId: "tr", action: "hold" as const, percent: null, at: T("03", "09:00") };
    expect(checkLine(l, step("tr"), now, tz).needs).toEqual(["Why is it on hold?"]);
  });
  it("done again on a done step changes nothing, but the words are kept", () => {
    const l = { ...base, stepId: "op", action: "done" as const, percent: null, at: T("03", "09:00") };
    expect(checkLine(l, step("op"), now, tz)).toMatchObject({ needs: [], nothing: "Already done." });
    expect(saveEvents([l], cat, now, tz).get("op")).toEqual([{ kind: "note", at: T("03", "09:00"), text: "e" }]);
  });
  it("a time not come yet can't be saved as having happened", () => {
    const l = { ...base, stepId: "tr", action: "progress" as const, percent: 60, at: T("03", "11:00") };
    expect(checkLine(l, step("tr"), now, tz).needs[0]).toMatch(/hasn't come yet/);
  });
});

import { inNote, namesStep, fitsStep, sameTask, stepCheck } from "@/lib/quickUpdate";

describe("which step, when the note isn't descriptive", () => {
  // Pull Bundle on two exchangers, Remove Trays on two towers, one Reinstall.
  const job: Milestone[] = [
    mk({ id: "e02", name: "E-02 - De-Butanizer Condenser", workOrderRef: "310456" }),
    mk({ id: "pb2", parentId: "e02", name: "Pull Bundle", status: "in_progress", percentComplete: 10, actualStartAt: iso("03", "07:00"), plannedStartAt: iso("03", "06:00"), plannedAt: iso("03", "12:00") }),
    mk({ id: "hb2", parentId: "e02", name: "Hydroblast Tubes", plannedStartAt: iso("03", "12:00"), plannedAt: iso("03", "16:00") }),
    mk({ id: "e22", name: "E-22 - Interstage Cooler", workOrderRef: "312478" }),
    mk({ id: "pb22", parentId: "e22", name: "Pull Bundle", plannedStartAt: iso("05", "06:00"), plannedAt: iso("05", "12:00") }),
    mk({ id: "v01", name: "V-01 - De-Butanizer Column", workOrderRef: "310359" }),
    mk({ id: "tr1", parentId: "v01", name: "Remove Trays", plannedStartAt: iso("03", "06:00"), plannedAt: iso("03", "18:00") }),
    mk({ id: "v03", name: "V-03 - De-Ethanizer Column", workOrderRef: "310357" }),
    mk({ id: "tr3", parentId: "v03", name: "Remove Trays", plannedStartAt: iso("04", "06:00"), plannedAt: iso("04", "18:00") }),
    mk({ id: "cl3", parentId: "v03", name: "Clean Tower (Orbijet)", plannedStartAt: iso("04", "18:00"), plannedAt: iso("05", "06:00") }),
  ];
  const c = stepCatalog(job, undefined, { now, notes: [
    { id: "n1", orgId: "o", milestoneId: "cl3", kind: "note", body: "Orbijet crew on site, rigging up", createdAt: iso("03", "08:00"), createdBy: "u" } as never,
  ] });
  const S = (id: string) => c.find((x) => x.id === id)!;
  it("the catalog says what's going and what's next, and how the field described it", () => {
    expect(S("pb2")).toMatchObject({ live: true, next: true });
    expect(S("pb22").live).toBe(false);
    expect(S("cl3").said).toEqual(["Orbijet crew on site, rigging up"]);
    expect(catalogText(c, tz)).toContain('said lately: "Orbijet crew on site, rigging up"');
  });
  it("a tag any way it's written, or the WO number, names the equipment", () => {
    expect(namesStep("e2 pulled bundle", S("pb2"))).toBe(true);
    expect(namesStep("E-02 bundle", S("pb2"))).toBe(true);
    expect(namesStep("310456 bundle out", S("pb2"))).toBe(true);
    expect(namesStep("pulled the bundle", S("pb2"))).toBe(false);
    expect(namesStep("e22 bundle", S("pb2"))).toBe(false);
  });
  it("the same task on other equipment is a twin; a different task isn't", () => {
    expect(sameTask(S("pb2"), S("pb22"))).toBe(true);
    expect(sameTask(S("tr1"), S("tr3"))).toBe(true);
    expect(sameTask(S("pb2"), S("hb2"))).toBe(false);
    expect(fitsStep("they pulled it", S("pb2"))).toBe(true);
    expect(fitsStep("washed it", S("hb2"))).toBe(false);
  });
  const note = "Pulled the bundle. E-2 washed it. Trays out on V-3. The orbijet guys are rigging up";
  it("'pulled the bundle', no equipment, two open Pull Bundles: asked, the live one first", () => {
    const r = stepCheck(S("pb2"), { evidence: "Pulled the bundle", context: null }, note, c);
    expect(r.options).toEqual(["pb2", "pb22"]);
    expect(r.unsure).toMatch(/doesn't say which equipment/);
  });
  it("'E-2 washed it': named, but no word in common with Hydroblast Tubes: by meaning", () => {
    expect(stepCheck(S("hb2"), { evidence: "E-2 washed it", context: null }, note, c)).toMatchObject({ found: "meaning" });
  });
  it("named earlier in the note: from context, only when those words are really in the note", () => {
    expect(stepCheck(S("tr3"), { evidence: "Trays out", context: "on V-3" }, note, c)).toMatchObject({ found: "context" });
    expect(stepCheck(S("tr3"), { evidence: "Trays out", context: "V-3 tower" }, note, c).options).toEqual(["tr3", "tr1"]);
  });
  it("not named, but only one step by that name: sure", () => {
    expect(stepCheck(S("cl3"), { evidence: "The orbijet guys are rigging up", context: null }, note, c)).toMatchObject({ found: "only" });
  });
  it("words the AI says are in the note must be in it", () => {
    expect(inNote("pulled the bundle", note)).toBe(true);
    expect(inNote("E-2, washed it", note)).toBe(true);
    expect(inNote("hydroblast complete on E-2", note)).toBe(false);
  });
  it("whole lines: an unsure step blocks Save until it's picked; made-up words block it", () => {
    const reply = parseReply({ updates: [
      { step: S("pb2").key, basis: "only", action: "done", evidence: "Pulled the bundle", when: { kind: "none" } },
      { step: S("hb2").key, basis: "named", action: "done", evidence: "hydroblast complete on E-2", when: { kind: "none" } },
    ] });
    const { lines } = toLines(reply, c, T("03", "09:30"), ctx, note);
    expect(lines[0]).toMatchObject({ stepId: null, options: ["pb2", "pb22"] });
    expect(checkLine(lines[0], undefined, now, tz).needs[0]).toMatch(/which equipment/);
    expect(checkLine({ ...lines[0], stepId: "pb2" }, S("pb2"), now, tz).needs).toEqual([]);
    expect(checkLine(lines[1], S("hb2"), now, tz).needs[0]).toMatch(/aren't in your note/);
  });
});

describe("a day's log from an earlier shift", () => {
  const night = { kind: "night" as const, dayKey: "2026-11-02", start: T("02", "18:00"), end: T("03", "06:00") };
  const lctx = { ...ctx, window: night };
  const read = (words: string, kind: RawUpdate["when"]["kind"], local: string) => readTime({ words, kind, local }, 0, lctx);
  it("a clock time is placed in that shift: 0200 is 2 AM that night, 1900 the evening before", () => {
    expect(read("0200", "clock", "2026-11-03 02:00")).toEqual({ at: T("03", "02:00"), from: "said" });
    expect(read("1900", "clock", "2026-11-03 19:00")).toEqual({ at: T("02", "19:00"), from: "said" });
  });
  it("no AM or PM: only one reading is in a 12-hour shift, so no question", () => {
    expect(read("at 2", "clock", "2026-11-03 14:00")).toEqual({ at: T("03", "02:00"), from: "said" });
  });
  it("a time not in that shift is asked", () => {
    expect(read("2pm", "clock", "2026-11-03 14:00")).toMatchObject({ ask: "time" });
  });
  it("lines with no time go in at the end of that shift first", () => {
    const d = defaultTimes(lctx);
    expect(d[0]).toMatchObject({ id: "last", at: T("03", "05:30") });
  });
  it("a log from two shifts back: that shift's end is offered first", () => {
    const day = { kind: "day" as const, dayKey: "2026-11-02", start: T("02", "06:00"), end: T("02", "18:00") };
    expect(defaultTimes({ ...ctx, window: day })[0]).toMatchObject({ id: "window", at: T("02", "17:30") });
  });
});

describe("found in the field: rounding and short words", () => {
  const night = { kind: "night" as const, dayKey: "2026-11-02", start: T("02", "18:00"), end: T("03", "06:00") };
  it("5:45 AM on a night log stays on the night shift: 5:30 AM, not 6:00 AM", () => {
    expect(readTime({ words: "0545", kind: "clock", local: "2026-11-03 05:45" }, 0, { ...ctx, window: night })).toEqual({ at: T("03", "05:30"), from: "said" });
    expect(roundTime(T("02", "17:50"), now, { tz, times })).toBe(T("02", "17:30"));
    expect(roundTime(T("02", "17:40"), now, { tz, times })).toBe(T("02", "17:30"));
  });
  it("QC done fits QC Complete: short words count, done and complete don't", () => {
    const qc = { key: "s1", id: "q", wo: "310352", place: "V-02 - De-Butanizer Receiver", name: "QC Complete", crew: "", status: "planned", pct: 0, planStart: 0, planFinish: 0, actStart: null, actFinish: null } as CatalogStep;
    expect(fitsStep("0545 QC done on V-2", qc)).toBe(true);
    expect(fitsStep("done on V-2", qc)).toBe(false);
  });
});
