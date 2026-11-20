import { describe, it, expect } from "vitest";
import { domainOf, parseDomains, normalizePolicy, mustUseMicrosoft, passwordProblem, tempState, endOfDay } from "@/lib/signinPolicy";

describe("sign-in policy", () => {
  it("reads email domains", () => {
    expect(domainOf("Jane@KernEnergy.com")).toBe("kernenergy.com");
    expect(domainOf("nobody")).toBe("");
    expect(parseDomains("@kernenergy.com, Kern.com  bad;x.y.z")).toEqual(["kernenergy.com", "kern.com", "x.y.z"]);
  });

  it("sends company emails to Microsoft, others to passwords", () => {
    const p = normalizePolicy({ microsoftDomains: ["kernenergy.com"], allowPasswords: true });
    expect(mustUseMicrosoft("ggetzfrid@kernenergy.com", p)).toBe(true);
    expect(mustUseMicrosoft("ops@site.kernenergy.com", p)).toBe(true);
    expect(mustUseMicrosoft("vendor@acme.com", p)).toBe(false);
    expect(mustUseMicrosoft("someone@notkernenergy.com", p)).toBe(false);
    expect(normalizePolicy(null)).toEqual({ microsoftDomains: [], allowPasswords: true });
  });

  it("refuses weak passwords", () => {
    expect(passwordProblem("short1!")).toMatch(/12/);
    expect(passwordProblem("Welcome2024!!")).toMatch(/common/);
    expect(passwordProblem("onlyletterslong")).toMatch(/numbers/);
    expect(passwordProblem("jsmith-pump-2024", "jsmith@acme.com")).toMatch(/email/);
    expect(passwordProblem("Crude-unit-north-7")).toBeNull();
  });

  it("expires a one-time password at the end of its day", () => {
    const now = new Date("2026-11-20T10:00:00");
    const exp = endOfDay(now);
    expect(tempState({ temp_password: true, temp_expires_at: exp }, now.getTime())).toBe("active");
    expect(tempState({ temp_password: true, temp_expires_at: exp }, Date.parse(exp) + 1)).toBe("expired");
    expect(tempState({ temp_password: true }, now.getTime())).toBe("expired");
    expect(tempState({}, now.getTime())).toBe("none");
  });
});
