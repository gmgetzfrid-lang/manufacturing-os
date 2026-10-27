// The turnover as decided and shipped: only the exceptions are kept, the
// crews offered say why, and the next shift reads back what was asked.

import { describe, it, expect } from "vitest";
import { buildShiftReport, shiftWindow } from "@/lib/shiftReport";
import { applyNightStaffing } from "@/lib/nightStaffing";
import { decisionsToShip, suggestCrews, askedOutcomes, handoverKey } from "@/lib/shiftHandover";
import { turnoverUpdate } from "@/lib/managementUpdate";
import { toPlainText } from "@/lib/reportExport";
import type { Milestone } from "@/types/schema";

const CHI = "America/Chicago";
const at = (d: string, hm: string) => new Date(Date.parse(`${d}T${hm}:00-05:00`)).toISOString();
const mk = (p: Partial<Milestone> & { id: string; name: string }): Milestone =>
  ({ orgId: "o", weight: 1, status: "planned", source: "manual", createdBy: "u", ...p } as Milestone);
const f = { D: (x: number) => new Date(x).toISOString().slice(5, 10), DTs: (x: number) => new Date(x).toISOString().slice(5, 16), T: (x: number) => new Date(x).toISOString().slice(11, 16), win: () => "", hrs: (h: number) => `${h} h` };

const v7 = mk({ id: "v7", name: "V-7" });
const trays = mk({ id: "tr", name: "Pull trays", parentId: "v7", responsibleParty: "Schultz - Tower", plannedStartAt: at("2026-10-26", "18:00"), plannedAt: at("2026-10-27", "04:00"), durationHours: 10 });
const e17 = mk({ id: "e17", name: "E-17" });
const hydro = mk({ id: "hb", name: "Hydroblast", parentId: "e17", responsibleParty: "Ancon", plannedStartAt: at("2026-10-26", "18:00"), plannedAt: at("2026-10-26", "22:00"), durationHours: 4 });
const blinds = mk({ id: "bl", name: "Set blinds", parentId: "v7", responsibleParty: "Schultz 1", plannedStartAt: at("2026-10-26", "10:00"), plannedAt: at("2026-10-26", "12:00"), durationHours: 2, status: "in_progress", percentComplete: 50 });
const all = applyNightStaffing([v7, trays, e17, hydro, blinds], ["v7"]);
const day = shiftWindow("2026-10-26", "day", CHI);
const r = buildShiftReport({ milestones: all, tz: CHI, shift: day, now: day.end });
const carried = [...r.goals.otherShift, ...r.goals.movedOff];

describe("shift handover", () => {
  it("keys on the shift the work is handed to", () => {
    expect(handoverKey(r.next)).toBe("2026-10-26:night");
  });
  it("ships only the steps marked to try, with where each stood", () => {
    const d = decisionsToShip({ hb: { tryIt: true, crew: "Schultz - Tower", note: "  if trays wait  " }, bl: { tryIt: false } }, carried);
    expect(d).toEqual({ hb: { tryIt: true, crew: "Schultz - Tower", note: "if trays wait", pctAtShip: 0, name: "Hydroblast", why: "other crew's work" } });
  });
  it("offers the crew already on that job first, then the lightest load — and says why", () => {
    const blindsRow = carried.find((x) => x.leaf.id === "bl")!;
    expect(suggestCrews(blindsRow, r)[0]).toEqual({ crew: "Schultz - Tower", why: "on V-7 this night" });
    const hbRow = carried.find((x) => x.leaf.id === "hb")!;
    expect(suggestCrews(hbRow, r)[0].why).toMatch(/h planned this night$/);
  });
  it("reads back what was asked, as entered", () => {
    const out = askedOutcomes({ shiftKey: "k", shippedAt: "x", shippedByName: null, decisions: { hb: { tryIt: true, crew: "Schultz - Tower", pctAtShip: 0, name: "Hydroblast" } } }, () => 100);
    expect(out).toEqual([{ id: "hb", name: "Hydroblast", crew: "Schultz - Tower", from: 0, now: 100, pulled: false, why: "carry-over" }]);
  });
  it("a draft nobody shipped wasn't handed over — nothing to read back", () => {
    expect(askedOutcomes({ shiftKey: "k", shippedAt: null, shippedByName: null, decisions: { hb: { tryIt: true, name: "Hydroblast" } } }, () => 100)).toEqual([]);
  });
  it("the email lists it under Next shift as could-try, not under Carries", () => {
    const text = toPlainText({ kind: "k", project: "p", when: "w", asOf: "a", sections: turnoverUpdate(r, f, {
      pctOf: () => 0, finishOf: () => undefined, tryOf: (id) => (id === "hb" ? { crew: "Schultz - Tower", note: null } : undefined),
      asked: [{ id: "x", name: "Old step", crew: null, from: 20, now: 100 }],
    }) });
    expect(text).toMatch(/Hydroblast · .*Could try \(Schultz - Tower\) — day crew's/);
    expect(text).toMatch(/Asked to try last turnover: 1 of 1 done \(as entered\)/);
    expect(text).toMatch(/Could try if there's time: 1 step, 4 h\./);
    // Once: marked to try, it isn't also "waits for day crew".
    expect(text.split("CARRIES TO THE DAY SHIFT")[1] ?? "").not.toMatch(/Hydroblast/);
    expect(text.match(/Hydroblast ·/g)?.length).toBe(1);
  });
});
