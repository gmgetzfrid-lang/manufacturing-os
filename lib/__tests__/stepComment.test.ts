// A step's comment goes with the change it was typed with, or a later one.

import { describe, it, expect } from "vitest";
import { saidWithLatest, lastChanges } from "@/lib/stepComment";

const t = (hm: string) => Date.parse(`2026-10-29T${hm}:00-07:00`);

describe("which comment goes with a step", () => {
  it("one from an earlier update isn't shown with a later change", () => {
    // "53 of 57 downcomers" at 10:00 with 73%; the step finished at 11:00, no comment.
    expect(saidWithLatest(t("10:00"), t("11:00"))).toBe(false);
  });
  it("one typed with the change, or after it, is", () => {
    expect(saidWithLatest(t("11:00"), t("11:00"))).toBe(true);
    expect(saidWithLatest(t("10:59"), t("11:00"))).toBe(true); // same form, a moment apart
    expect(saidWithLatest(t("15:00"), t("11:00"))).toBe(true); // added later
    expect(saidWithLatest(t("10:00"), undefined)).toBe(true); // no change on record
  });
  it("the last change from the log, not the line from when the step was made", () => {
    const log = [
      { milestone_id: "a", at: "2026-10-29T08:00:00-07:00", old_status: null },
      { milestone_id: "a", at: "2026-10-29T10:00:00-07:00", old_status: "planned" },
      { milestone_id: "a", at: "2026-10-29T11:00:00-07:00", old_status: "in_progress" },
      { milestone_id: "a", at: "2026-10-30T07:00:00-07:00", old_status: "completed" },
    ];
    expect(lastChanges(log).get("a")).toBe(t("11:00") + 20 * 3_600_000);
    expect(lastChanges(log, t("12:00")).get("a")).toBe(t("11:00"));
  });
});
