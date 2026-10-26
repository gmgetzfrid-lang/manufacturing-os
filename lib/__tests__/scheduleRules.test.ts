import { describe, it, expect } from "vitest";
import { parseIsoDurationHours, mergeImportedProgress, needsFutureConfirm } from "@/lib/scheduleRules";

const at = (d: string, hm: string) => Date.parse(`${d}T${hm}:00-05:00`);
const NOW = "2026-10-25T14:00:00.000Z";

describe("parseIsoDurationHours — MS Project durations become real hours", () => {
  it("handles the shapes MS Project writes", () => {
    expect(parseIsoDurationHours("PT40H0M0S")).toBe(40);
    expect(parseIsoDurationHours("PT4H30M0S")).toBe(4.5);
    expect(parseIsoDurationHours("PT0H45M")).toBe(0.75);
    expect(parseIsoDurationHours("P1DT2H")).toBe(10); // a project day is 8 h
  });
  it("returns null for nothing / zero / garbage so a step keeps its default weight", () => {
    expect(parseIsoDurationHours(null)).toBeNull();
    expect(parseIsoDurationHours("")).toBeNull();
    expect(parseIsoDurationHours("PT0H0M0S")).toBeNull();
    expect(parseIsoDurationHours("40 hours")).toBeNull();
  });
});

describe("mergeImportedProgress — a re-import never takes progress away", () => {
  const live = (status: "planned" | "in_progress" | "completed" | "blocked" | "on_hold" | "missed", percent: number, actualAt: string | null = null, actualStartAt: string | null = null) =>
    ({ status, percent, actualAt, actualStartAt });

  it("file behind the floor → nothing changes (60% stays 60%, done stays done)", () => {
    expect(mergeImportedProgress(live("in_progress", 60, null, "2026-10-24T12:00:00Z"), 0, NOW)).toBeNull();
    expect(mergeImportedProgress(live("in_progress", 60), 40, NOW)).toBeNull();
    expect(mergeImportedProgress(live("completed", 100, "2026-10-24T12:00:00Z"), 0, NOW)).toBeNull();
    expect(mergeImportedProgress(live("completed", 100, "2026-10-24T12:00:00Z"), 100, NOW)).toBeNull();
  });
  it("file ahead of the floor → raises, keeps the start the crew already stamped", () => {
    const r = mergeImportedProgress(live("in_progress", 20, null, "2026-10-24T12:00:00Z"), 70, NOW);
    expect(r).toEqual({ percent_complete: 70, status: "in_progress", actual_start_at: "2026-10-24T12:00:00Z" });
  });
  it("file says 100 on an untouched row → completed, stamped now (no planned-date fiction)", () => {
    const r = mergeImportedProgress(live("planned", 0), 100, NOW);
    expect(r).toEqual({ percent_complete: 100, status: "completed", actual_at: NOW, actual_start_at: NOW, first_completed_at: NOW });
  });
  it("a hold / block set on the floor is not lifted by a file percent below 100", () => {
    expect(mergeImportedProgress(live("blocked", 40), 80, NOW)).toBeNull();
    expect(mergeImportedProgress(live("on_hold", 0), 50, NOW)).toBeNull();
    expect(mergeImportedProgress(live("blocked", 40), 100, NOW)?.status).toBe("completed");
  });
  it("clamps nonsense percents", () => {
    expect(mergeImportedProgress(live("planned", 0), 250, NOW)?.percent_complete).toBe(100);
    expect(mergeImportedProgress(live("planned", 0), -5, NOW)).toBeNull();
    expect(mergeImportedProgress(live("planned", 0), Number.NaN, NOW)).toBeNull();
  });
});

describe("needsFutureConfirm — ask once before progress lands on a far-future step", () => {
  const now = at("2026-10-25", "09:00");
  it("today's and tomorrow's work is never questioned", () => {
    expect(needsFutureConfirm(at("2026-10-25", "14:00"), now, "completed", null)).toBe(false);
    expect(needsFutureConfirm(at("2026-10-26", "08:00"), now, "in_progress", null)).toBe(false); // 23 h ahead
  });
  it("marking done or started on a step 3 days out asks", () => {
    expect(needsFutureConfirm(at("2026-10-28", "08:00"), now, "completed", null)).toBe(true);
    expect(needsFutureConfirm(at("2026-10-28", "08:00"), now, "in_progress", null)).toBe(true);
    expect(needsFutureConfirm(at("2026-10-28", "08:00"), now, null, 30)).toBe(true);
  });
  it("taking progress away, holding or blocking never asks — those are always safe", () => {
    expect(needsFutureConfirm(at("2026-10-28", "08:00"), now, "planned", null)).toBe(false);
    expect(needsFutureConfirm(at("2026-10-28", "08:00"), now, "on_hold", null)).toBe(false);
    expect(needsFutureConfirm(at("2026-10-28", "08:00"), now, "blocked", null)).toBe(false);
    expect(needsFutureConfirm(at("2026-10-28", "08:00"), now, null, 0)).toBe(false);
  });
  it("a step with no planned start can't be 'future'", () => {
    expect(needsFutureConfirm(Number.NaN, now, "completed", null)).toBe(false);
  });
});
