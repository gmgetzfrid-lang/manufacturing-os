// Times always carry their date — "Mon" alone is ambiguous on a multi-week job.

import { describe, it, expect } from "vitest";
import { whenDated, spanDated, hoursShort } from "@/lib/timeWords";

const tz = "America/Los_Angeles";
const at = (d: string, hm: string) => Date.parse(`${d}T${hm}:00-07:00`);

describe("timeWords", () => {
  it("a time with its date", () => {
    expect(whenDated(at("2026-10-26", "10:00"), tz)).toBe("Mon, Oct 26, 10:00 AM");
  });
  it("a span: the finish's date only when it's another day", () => {
    expect(spanDated(at("2026-10-26", "08:00"), at("2026-10-26", "10:00"), tz)).toBe("Mon, Oct 26, 8:00 AM → 10:00 AM");
    expect(spanDated(at("2026-10-28", "16:00"), at("2026-10-29", "08:00"), tz)).toBe("Wed, Oct 28, 4:00 PM → Thu, Oct 29, 8:00 AM");
  });
  it("hours", () => {
    expect(hoursShort(0.33)).toBe("20 min");
    expect(hoursShort(4)).toBe("4 h");
    expect(hoursShort(4.25)).toBe("4.3 h");
  });
});
