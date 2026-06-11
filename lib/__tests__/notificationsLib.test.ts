// lib/__tests__/notificationsLib.test.ts
//
// Freezes the notification helper logic that the whole fan-out depends on:
// @-mention parsing (drives who gets a mention notification + email) and the
// SLA date helpers. Pure functions, exercised heavily because a regression here
// silently mis-routes notifications.

import { describe, it, expect } from "vitest";
import {
  extractMentionUids,
  tokenizeMentions,
  isPastDue,
  isNearingDue,
  defaultSlaTargetDate,
  DEFAULT_SLA_DAYS,
  ticketUrl,
} from "@/lib/notifications";

const U1 = "11111111-1111-1111-1111-111111111111";
const U2 = "22222222-2222-2222-2222-222222222222";

describe("extractMentionUids", () => {
  it("pulls uids out of @[Name](uuid) syntax", () => {
    expect(extractMentionUids(`hey @[Mike Leonard](${U1}) and @[Brady](${U2})`)).toEqual([U1, U2]);
  });

  it("dedupes a uid mentioned twice", () => {
    expect(extractMentionUids(`@[A](${U1}) ... @[A again](${U1})`)).toEqual([U1]);
  });

  it("returns nothing for plain text or malformed mentions", () => {
    expect(extractMentionUids("no mentions here")).toEqual([]);
    expect(extractMentionUids("")).toEqual([]);
    expect(extractMentionUids("@[Name](not-a-uuid)")).toEqual([]);
    expect(extractMentionUids("@Name plain at-sign")).toEqual([]);
  });
});

describe("tokenizeMentions", () => {
  it("splits text and mention tokens in order", () => {
    const tokens = tokenizeMentions(`Hi @[Mike](${U1}), please review`);
    expect(tokens).toEqual([
      { kind: "text", value: "Hi " },
      { kind: "mention", name: "Mike", uid: U1 },
      { kind: "text", value: ", please review" },
    ]);
  });

  it("handles a leading mention and an empty string", () => {
    expect(tokenizeMentions(`@[Mike](${U1}) hello`)).toEqual([
      { kind: "mention", name: "Mike", uid: U1 },
      { kind: "text", value: " hello" },
    ]);
    expect(tokenizeMentions("")).toEqual([]);
  });
});

describe("SLA date helpers", () => {
  const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const soon = new Date(Date.now() + 12 * 3_600_000).toISOString(); // 12h out

  it("isPastDue: true only for an overdue, still-open ticket", () => {
    expect(isPastDue({ targetCompletionAt: past, status: "DRAFTING" })).toBe(true);
    expect(isPastDue({ targetCompletionAt: future, status: "DRAFTING" })).toBe(false);
    expect(isPastDue({ targetCompletionAt: past, status: "CLOSED" })).toBe(false);
    expect(isPastDue({ targetCompletionAt: past, status: "CANCELED" })).toBe(false);
    expect(isPastDue({})).toBe(false);
  });

  it("isNearingDue: true within the warn window, false outside it", () => {
    expect(isNearingDue({ targetCompletionAt: soon, status: "DRAFTING" }, 1)).toBe(true);
    expect(isNearingDue({ targetCompletionAt: future, status: "DRAFTING" }, 1)).toBe(false);
    expect(isNearingDue({ targetCompletionAt: past, status: "DRAFTING" }, 1)).toBe(false); // already past, not "nearing"
    expect(isNearingDue({ targetCompletionAt: soon, status: "CLOSED" }, 1)).toBe(false);
  });

  it("defaultSlaTargetDate honors the per-type day budget", () => {
    for (const [type, days] of Object.entries(DEFAULT_SLA_DAYS)) {
      const iso = defaultSlaTargetDate(type)!;
      const deltaDays = (new Date(iso).getTime() - Date.now()) / 86_400_000;
      // Within a day of the budget (the helper also pins the time to 17:00).
      expect(deltaDays).toBeGreaterThan(days - 1.5);
      expect(deltaDays).toBeLessThan(days + 1);
    }
  });

  it("defaultSlaTargetDate falls back to 14 days for an unknown type", () => {
    const deltaDays = (new Date(defaultSlaTargetDate("SOMETHING_ELSE")!).getTime() - Date.now()) / 86_400_000;
    expect(deltaDays).toBeGreaterThan(12.5);
    expect(deltaDays).toBeLessThan(15);
  });
});

describe("ticketUrl", () => {
  it("falls back to an app-relative path with no window (server/test)", () => {
    expect(ticketUrl("abc-123")).toBe("/requests/abc-123");
  });
});
