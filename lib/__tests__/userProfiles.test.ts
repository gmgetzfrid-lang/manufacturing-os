// Freezes the avatar identity rules — initials come from the person's NAME
// (never a role letter), with sensible fallbacks for emails and single words.

import { describe, it, expect } from "vitest";
import { initialsOf, avatarToneOf } from "@/lib/userProfiles";

describe("initialsOf", () => {
  it("first + last name → two initials", () => {
    expect(initialsOf("Grant Getzfrid")).toBe("GG");
    expect(initialsOf("Maria del Carmen Ruiz")).toBe("MR"); // first + last word
  });

  it("email local part with dot/underscore/dash separators", () => {
    expect(initialsOf("grant.getzfrid@refinery.com")).toBe("GG");
    expect(initialsOf("maria_ruiz@x.com")).toBe("MR");
    expect(initialsOf("j-doe@x.com")).toBe("JD");
  });

  it("single word → first two letters", () => {
    expect(initialsOf("maria")).toBe("MA");
    expect(initialsOf("Q")).toBe("Q");
  });

  it("empty / junk → placeholder", () => {
    expect(initialsOf("")).toBe("?");
    expect(initialsOf(null)).toBe("?");
    expect(initialsOf("   ")).toBe("?");
  });
});

describe("avatarToneOf", () => {
  it("is deterministic — same person, same color everywhere", () => {
    expect(avatarToneOf("Grant Getzfrid")).toBe(avatarToneOf("Grant Getzfrid"));
  });
  it("returns a hex color even for empty input", () => {
    expect(avatarToneOf(null)).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
