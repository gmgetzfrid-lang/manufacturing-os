// lib/__tests__/ticketNumber.test.ts
//
// Freezes the human request-number format ({ORG}-DDRT-{YY}-{NNNN}). The
// invariants that matter: zero-padded (sortable), prefix omitted cleanly when
// unset, and the sequence NEVER truncates past the pad width (uniqueness can
// never be sacrificed for formatting).

import { describe, it, expect } from "vitest";
import { formatTicketNumber, TICKET_NUMBER_DEFAULTS } from "@/lib/ticketNumber";

describe("formatTicketNumber", () => {
  it("renders the canonical KE-DDRT-26-0001 shape", () => {
    expect(formatTicketNumber({ prefix: "KE", recordCode: "DDRT", pad: 4 }, 2026, 1)).toBe("KE-DDRT-26-0001");
    expect(formatTicketNumber({ prefix: "KE", recordCode: "DDRT", pad: 4 }, 2026, 847)).toBe("KE-DDRT-26-0847");
  });

  it("omits the org prefix cleanly when unset (no leading dash)", () => {
    expect(formatTicketNumber({ prefix: "", recordCode: "DDRT", pad: 4 }, 2026, 12)).toBe("DDRT-26-0012");
  });

  it("uses a 2-digit year", () => {
    expect(formatTicketNumber({ prefix: "KE", recordCode: "DDRT", pad: 4 }, 2027, 1)).toBe("KE-DDRT-27-0001");
    expect(formatTicketNumber({ prefix: "KE", recordCode: "DDRT", pad: 4 }, 2100, 1)).toBe("KE-DDRT-00-0001");
  });

  it("never truncates a sequence wider than the pad (uniqueness over formatting)", () => {
    expect(formatTicketNumber({ prefix: "KE", recordCode: "DDRT", pad: 4 }, 2026, 10000)).toBe("KE-DDRT-26-10000");
  });

  it("respects custom pad widths and clamps a nonsensical pad to at least 1", () => {
    expect(formatTicketNumber({ prefix: "A", recordCode: "REQ", pad: 6 }, 2026, 7)).toBe("A-REQ-26-000007");
    expect(formatTicketNumber({ prefix: "A", recordCode: "REQ", pad: 0 }, 2026, 7)).toBe("A-REQ-26-7");
  });

  it("defaults are DDRT / 4 digits / no prefix", () => {
    expect(TICKET_NUMBER_DEFAULTS).toEqual({ prefix: "", recordCode: "DDRT", pad: 4 });
  });
});
