// The close-out counts added work as the schedule has it now, and says the
// first estimate when it was changed after the find.

import { describe, it, expect } from "vitest";
import type { Milestone } from "@/types/schema";
import { discoveries, hoursNow, impactNowLine } from "@/lib/discovery";

const rec = (id: string, seq: number, hours: number) => JSON.stringify({ id, seq, what: "Welded pipe", foundAt: 1, impact: { hours, critical: false, taskFinish: [0, 0], finish: [0, 0] } });
const m = (id: string, x: Record<string, unknown>) => ({ id, name: id, parentId: "wo", status: "completed", percentComplete: 100, ...x } as unknown as Milestone);
const hrs = (h: number) => `${h} h`;

describe("hoursNow", () => {
  const ms = [
    m("a", { durationHours: 23, attributes: { discovery: rec("d1", 1, 32) } }),
    m("b", { durationHours: 2, attributes: { discovery: rec("d2", 1, 7) } }),
    m("c", { durationHours: 5, attributes: { discovery: rec("d2", 2, 7) } }),
    m("x", { durationHours: 4, cancelledAt: "2026-10-30T00:00:00Z", attributes: { discovery: rec("d2", 3, 7) } }),
  ];
  const [d1, d2] = discoveries(ms);
  it("the steps' hours now, cancelled left out", () => {
    expect(hoursNow(d1)).toBe(23);
    expect(hoursNow(d2)).toBe(7);
  });
  it("the first estimate only when it changed", () => {
    expect(impactNowLine(d1, hrs)).toMatch(/^23 h of work.*first estimated 32 h$/);
    expect(impactNowLine(d2, hrs)).not.toMatch(/first estimated/);
  });
});
