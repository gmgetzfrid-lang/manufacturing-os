// A refresh opens straight into the account with the role it had, checked
// again in the background; another account, workspace or a signed-out
// device opens with nothing remembered.

import { describe, it, expect } from "vitest";
import { readMember, writeMember, storedUid, memberToOpen, MEMBER_KEY } from "@/lib/memberCache";

const store = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k),
    key: (i: number) => [...m.keys()][i] ?? null, get length() { return m.size; },
  };
};
const admin = { uid: "u1", orgId: "o1", role: "Admin" as const, roles: ["Admin" as const], status: "active", email: "a@x" };

describe("memberCache", () => {
  it("remembers an active membership and reads it back", () => {
    const s = store();
    writeMember(s, admin);
    expect(readMember(s)).toEqual({ ...admin, status: "active" });
  });
  it("anything but active is forgotten", () => {
    const s = store();
    writeMember(s, admin);
    writeMember(s, { ...admin, status: "suspended" });
    expect(s.getItem(MEMBER_KEY)).toBeNull();
    writeMember(s, admin); writeMember(s, null);
    expect(readMember(s)).toBeNull();
  });
  it("junk reads as nothing", () => {
    expect(readMember(store({ [MEMBER_KEY]: "{not json" }))).toBeNull();
    expect(readMember(store({ [MEMBER_KEY]: JSON.stringify({ uid: "u1" }) }))).toBeNull();
  });
  it("the signed-in account from the auth client's own storage", () => {
    expect(storedUid(store({ "sb-abc-auth-token": JSON.stringify({ access_token: "t", user: { id: "u1" } }) }))).toBe("u1");
    expect(storedUid(store(), store({ "sb-abc-auth-token": JSON.stringify({ user: { id: "u2" } }) }))).toBe("u2");
    expect(storedUid(store({ other: "x" }))).toBeNull();
  });
  it("opens only for the same account in the same workspace", () => {
    const c = readMember(store({ [MEMBER_KEY]: JSON.stringify(admin) }));
    expect(memberToOpen(c, "u1", "o1")).toMatchObject({ role: "Admin" });
    expect(memberToOpen(c, "u1", null)).toMatchObject({ role: "Admin" });
    expect(memberToOpen(c, "u2", "o1")).toBeNull();
    expect(memberToOpen(c, null, "o1")).toBeNull();
    expect(memberToOpen(c, "u1", "o2")).toBeNull();
  });
});
