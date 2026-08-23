// Pins the email normalization contract (audit finding IDENT-3).
//
// The defect being pinned: `signup`, `admin/create-user` and
// `auth/request-access` compared emails with a case-sensitive `eq` while
// `findAuthUserIdByEmail` case-folded in the same file — Azure/Entra returns
// the UPN in directory casing (`Greg.Getzfrid@…`), password signups carry
// whatever was typed, and the two never matched each other.

import { describe, it, expect } from "vitest";
import { normalizeEmail, emailLikePattern } from "@/lib/identity";

describe("normalizeEmail", () => {
  it("folds case and trims — the Azure-UPN vs typed-signup case", () => {
    expect(normalizeEmail("Greg.Getzfrid@Corp.COM")).toBe("greg.getzfrid@corp.com");
    expect(normalizeEmail("  user@example.com  ")).toBe("user@example.com");
  });

  it("is idempotent", () => {
    const once = normalizeEmail("MiXeD@Case.Org");
    expect(normalizeEmail(once)).toBe(once);
  });

  it("two casings of one address normalize identically", () => {
    expect(normalizeEmail("USER@CORP.COM")).toBe(normalizeEmail("user@corp.com"));
  });
});

describe("emailLikePattern", () => {
  it("escapes LIKE wildcards so an underscore address cannot match a different one", () => {
    // Without escaping, ilike("a_b@x.com") also matches "axb@x.com".
    expect(emailLikePattern("a_b@x.com")).toBe("a\\_b@x.com");
    expect(emailLikePattern("50%off@promo.io")).toBe("50\\%off@promo.io");
    expect(emailLikePattern("back\\slash@x.com")).toBe("back\\\\slash@x.com");
  });

  it("normalizes before escaping", () => {
    expect(emailLikePattern("  A_B@X.COM ")).toBe("a\\_b@x.com");
  });

  it("leaves ordinary addresses untouched", () => {
    expect(emailLikePattern("user@example.com")).toBe("user@example.com");
  });
});
