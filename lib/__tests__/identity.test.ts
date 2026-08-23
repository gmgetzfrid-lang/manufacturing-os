// Pins the email normalization contract (audit finding IDENT-3).
//
// The defect being pinned: `signup`, `admin/create-user` and
// `auth/request-access` compared emails with a case-sensitive `eq` while
// `findAuthUserIdByEmail` case-folded in the same file — Azure/Entra returns
// the UPN in directory casing (`Greg.Getzfrid@…`), password signups carry
// whatever was typed, and the two never matched each other.

import { describe, it, expect } from "vitest";
import { normalizeEmail, emailLikePattern, applyEmailLookup } from "@/lib/identity";

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

describe("applyEmailLookup", () => {
  // A stub builder recording which filter was applied — the contract under
  // test is the ROUTING between ilike and eq, per address shape.
  type Stub = { calls: Array<{ op: string; column: string; value: string }>; eq(c: string, v: string): Stub; ilike(c: string, v: string): Stub };
  const stub = (): Stub => ({
    calls: [],
    eq(c: string, v: string) { this.calls.push({ op: "eq", column: c, value: v }); return this; },
    ilike(c: string, v: string) { this.calls.push({ op: "ilike", column: c, value: v }); return this; },
  });

  it("uses the escaped ilike pattern for ordinary addresses", () => {
    const q = applyEmailLookup(stub(), "email", "  A_B@X.COM ");
    expect(q.calls).toEqual([{ op: "ilike", column: "email", value: "a\\_b@x.com" }]);
  });

  it("never sends `*` through ilike — PostgREST would rewrite it to the % wildcard", () => {
    // The adversarial-review scenario: 'greg*@corp.com' via ilike becomes
    // ILIKE 'greg%@corp.com' and matches gregory@corp.com — a role granted
    // to the wrong human. Such addresses must exact-match instead.
    const q = applyEmailLookup(stub(), "email", "greg*@Corp.com");
    expect(q.calls).toEqual([{ op: "eq", column: "email", value: "greg*@corp.com" }]);
  });
});
