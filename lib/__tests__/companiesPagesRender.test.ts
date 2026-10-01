// @vitest-environment jsdom
//
// projects Round G — REL-1 / UX-9 / COST-3 on the RENDERED pages, not on
// their source text: the registry with no resolvable org shows an
// actionable error whose Retry does something; a failed action on the
// company profile leaves the record mounted, says what failed, and keeps
// what the user typed; a blank "record as" field never records 0%.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const role = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));
const lib = vi.hoisted(() => ({
  listCompaniesPage: vi.fn(),
  gatherCompanyProfiles: vi.fn(),
  getCompany: vi.fn(),
  gatherCompanyProfile: vi.fn(),
  addCompanyEvent: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({ supabase: { from: () => ({}), auth: { getSession: async () => ({ data: { session: null } }) } } }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => undefined) }));
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => role.value }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "c1" }), useRouter: () => ({ back: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/ChartKit", () => ({ ScoreDial: () => null, scoreBandColor: () => "#888" }));
vi.mock("@/lib/companies", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/companies")>();
  return { ...actual, ...lib };
});

import CompaniesPage from "@/app/(protected)/companies/page";
import CompanyProfilePage from "@/app/(protected)/companies/[id]/page";
import { recordedQualityScore, type Company } from "@/lib/companies";
import { computeCompanyScorecard } from "@/lib/companyScore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  for (const f of Object.values(lib)) f.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const byText = (sel: string, text: RegExp) => [...host.querySelectorAll(sel)].find((el) => text.test(el.textContent ?? "")) as HTMLElement | undefined;

describe("REL-1 — /companies with no resolvable organization", () => {
  it("renders an actionable error (never a spinner) and Retry re-runs the org resolution", async () => {
    role.value = { activeOrgId: null, uid: null, hasAnyRole: () => false, loading: false, membershipState: "error" };
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    await act(async () => { root.render(React.createElement(CompaniesPage)); });
    await flush();
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/Couldn't determine your organization — the membership lookup failed/);
    expect(host.textContent).not.toMatch(/Loading the registry/);
    expect(lib.listCompaniesPage).not.toHaveBeenCalled();
    const retry = byText("button", /Retry/)!;
    await act(async () => { retry.click(); });
    // Retry is not a no-op: with no org the list read has nothing to re-run, so the shell reloads.
    expect(reload).toHaveBeenCalledTimes(1);
    expect(lib.listCompaniesPage).not.toHaveBeenCalled();
  });

  it("with an org, a failed list read is an error with a Retry that re-reads the list", async () => {
    role.value = { activeOrgId: "o1", uid: "u1", hasAnyRole: () => false, loading: false, membershipState: "member" };
    lib.listCompaniesPage.mockRejectedValueOnce(new Error("statement timeout"));
    lib.listCompaniesPage.mockResolvedValue({ rows: [], total: 0, page: 0, pageSize: 50 });
    lib.gatherCompanyProfiles.mockResolvedValue(new Map());
    await act(async () => { root.render(React.createElement(CompaniesPage)); });
    await flush();
    // REL-3: the screen says it in plain words — never the driver's text
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/The database took too long to answer — try again\./);
    await act(async () => { byText("button", /Retry/)!.click(); });
    await flush();
    expect(lib.listCompaniesPage).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toMatch(/No companies in the registry yet/);
  });
});

describe("UX-9 — a failed action on the company profile", () => {
  const company: Company = {
    id: "c1", orgId: "o1", name: "Apex Industrial", kind: "contractor", trade: "piping", status: "active",
    contactName: null, contactEmail: null, contactPhone: null, qualityManualDocId: null, qualityManualScore: null,
    qualityManualGaps: null, qualityManualReviewedAt: null, qualityManualPagesRead: null, qualityManualPagesTotal: null,
    notes: null, createdAt: null,
  };

  it("leaves the record mounted, reports the failure in a dismissible banner, and keeps what the user typed", async () => {
    role.value = { activeOrgId: "o1", uid: "u1", userEmail: "pm@example.com", hasAnyRole: () => true };
    lib.getCompany.mockResolvedValue(company);
    lib.gatherCompanyProfile.mockResolvedValue({
      company, events: [], partiesLinked: 1, awardsSource: "none", projects: [], bids: [], changeOrders: [],
      scorecard: computeCompanyScorecard({
        recordables: 0, nearMisses: 0, warnings: 0, stopWorks: 0, commendations: 0, qualityManualScore: null,
        turnoverAccepted: 0, turnoverRejected: 0, punchClosed: 0, punchTotal: 0, awardsTotal: 0, finalCostTotal: 0,
        changeOrderCount: 0, changeOrderScopeGapCount: 0, milestonesOnTheirScopes: 0, milestonesHitOnTime: 0,
        submissionCount: 0, avgSubmitToReviewDays: null, avgAssignToSubmitDays: null,
      }),
    });
    lib.addCompanyEvent.mockRejectedValue(new Error("new row violates row-level security policy"));
    await act(async () => { root.render(React.createElement(CompanyProfilePage)); });
    await flush();
    expect(host.querySelector("h1")?.textContent).toMatch(/Apex Industrial/);

    const input = host.querySelector('input[placeholder^="What happened?"]') as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setValue.call(input, "Crane swing near miss at E-301"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { byText("button", /Log it/)!.click(); });
    await flush();

    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/You don't have permission to do this — nothing was changed\./);   // REL-3: never the policy text
    expect(alert?.textContent).not.toMatch(/row-level security/);
    expect(host.querySelector("h1")?.textContent).toMatch(/Apex Industrial/);   // still mounted
    expect((host.querySelector('input[placeholder^="What happened?"]') as HTMLInputElement).value).toBe("Crane swing near miss at E-301");
    // Dismissible.
    await act(async () => { (host.querySelector('[aria-label="Dismiss"]') as HTMLButtonElement).click(); });
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("COST-3 dw4 — the 'record as' field", () => {
  it("a blank field records nothing (never 0%); numbers are clamped and rounded", () => {
    expect(recordedQualityScore("")).toBeNull();
    expect(recordedQualityScore("   ")).toBeNull();
    expect(recordedQualityScore("abc")).toBeNull();
    expect(recordedQualityScore("0")).toBe(0);
    expect(recordedQualityScore("62.4")).toBe(62);
    expect(recordedQualityScore("140")).toBe(100);
  });
});
