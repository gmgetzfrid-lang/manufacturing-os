// @vitest-environment jsdom
//
// projects Round G — J10, UX-13: preconditions are announced BEFORE the
// effort. Every AI entry point on the Projects / Companies pages says what
// it needs (your own key, the acceptable-use agreement, budget left this
// month) before the click — read from the AI settings dialog's own routes,
// once a minute per org, never a refusal of its own; and "needs a budget
// line" offers the fix where the need shows.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const costs = vi.hoisted(() => ({ saveAccount: vi.fn() }));
const reg = vi.hoisted(() => ({ listCompanies: vi.fn(async () => []), listBarredCompanies: vi.fn(async () => []) }));

vi.mock("@/lib/supabase", () => {
  const chain = (): unknown => new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
      return () => chain();
    },
  });
  return { supabase: { from: () => chain(), auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } } };
});
vi.mock("@/components/providers/DialogProvider", () => ({ appPrompt: vi.fn(), appConfirm: vi.fn(), appAlert: vi.fn() }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => undefined) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));
vi.mock("@/lib/costs", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/costs")>()), ...costs }));
vi.mock("@/lib/companies", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/companies")>()), ...reg }));

import { aiReadinessFrom, fetchAiReadiness, clearAiReadinessCache, AI_SETTINGS_HREF } from "@/lib/aiReadiness";
import QuotesPanel from "@/components/projects/cost/QuotesPanel";
import type { CostDocument } from "@/lib/costDocs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const src = (f: string) => readFileSync(join(process.cwd(), f), "utf8");

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  clearAiReadinessCache();
  costs.saveAccount.mockReset();
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("UX-13 — the AI precondition, derived (governedCall's order: key, agreement, cap)", () => {
  it("no key of your own → no_key, with the place to add it; it wins over everything after it", () => {
    const r = aiReadinessFrom({ connection: { personal: null }, agreement: { accepted: false }, usage: { spentUsd: 99, capUsd: 10 } });
    expect(r.state).toBe("no_key");
    expect(r.message).toMatch(/Needs your AI key/);
    expect(r.href).toBe(AI_SETTINGS_HREF);
    expect(r.cta).toBe("Set it up (1 min)");
  });
  it("the agreement not accepted → no_agreement; a spent cap → over_cap with the figures", () => {
    expect(aiReadinessFrom({ connection: { personal: { provider: "anthropic" } }, agreement: { accepted: false }, usage: { spentUsd: 0, capUsd: 10 } }).state).toBe("no_agreement");
    const cap = aiReadinessFrom({ connection: { personal: { provider: "anthropic" } }, agreement: { accepted: true }, usage: { spentUsd: 10, capUsd: 10 } });
    expect(cap.state).toBe("over_cap");
    expect(cap.message).toContain("$10.00 of $10.00");
  });
  it("everything in place → ready; a fact that could not be read is unknown, never a refusal", () => {
    expect(aiReadinessFrom({ connection: { personal: { provider: "openai" } }, agreement: { accepted: true }, usage: { spentUsd: 1, capUsd: 10 } }).state).toBe("ready");
    expect(aiReadinessFrom({ connection: null, agreement: null, usage: null }).state).toBe("unknown");
    expect(aiReadinessFrom({ connection: { personal: { provider: "openai" } }, agreement: null, usage: { spentUsd: 1, capUsd: 0 } }).state).toBe("unknown");
  });
  it("fetchAiReadiness: 'ready' is shared by the page for a minute; it never throws", async () => {
    const fetcher = vi.fn(async (url: string) => url.startsWith("/api/ai/connection") ? ok({ personal: { provider: "anthropic" } }) : ok({ accepted: true, spentUsd: 0, capUsd: 10 }));
    const a = await fetchAiReadiness("o1", fetcher, 1_000);
    const b = await fetchAiReadiness("o1", fetcher, 30_000);
    expect(a.state).toBe("ready");
    expect(b).toBe(a);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.map((c) => c[0]).sort()).toEqual(["/api/ai/agreement?orgId=o1", "/api/ai/connection?orgId=o1", "/api/ai/usage?orgId=o1"]);
    const failing = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    expect((await fetchAiReadiness("o2", failing, 1_000)).state).toBe("unknown");
  });

  it("review fix: a refusal (no key, the cap spent) is NOT kept for a minute — only the buttons mounting together share it; the next read after the key is saved sees it", async () => {
    let hasKey = false;
    const fetcher = vi.fn(async (url: string) => url.startsWith("/api/ai/connection") ? ok({ personal: hasKey ? { provider: "anthropic" } : null }) : ok({ accepted: true, spentUsd: 0, capUsd: 10 }));
    const a = await fetchAiReadiness("o1", fetcher, 1_000);
    expect(a.state).toBe("no_key");
    expect(await fetchAiReadiness("o1", fetcher, 2_000)).toBe(a);        // the same page's buttons
    expect(fetcher).toHaveBeenCalledTimes(3);
    hasKey = true;                                                        // saved in another tab, back within the minute
    expect((await fetchAiReadiness("o1", fetcher, 10_000)).state).toBe("ready");
    expect(fetcher).toHaveBeenCalledTimes(6);
    // `fresh` skips the cache outright (a re-check on focus)
    expect((await fetchAiReadiness("o1", fetcher, 10_500, { fresh: true })).state).toBe("ready");
    expect(fetcher).toHaveBeenCalledTimes(9);
  });

  it("review fix: a button disabled by a refusal re-checks when the window regains focus, and enables once the key is there", async () => {
    let hasKey = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).startsWith("/api/ai/connection") ? ok({ personal: hasKey ? { provider: "anthropic" } : null }) : ok({ accepted: true, spentUsd: 0, capUsd: 10 })));
    await renderPanel([{ id: "a1", projectId: "p1", code: null, name: "Piping", costType: null, budget: 1, currency: "USD", partyId: null, wbsMilestoneId: null, status: "active" }], [draft]);
    const read = () => [...host.querySelectorAll("button")].find((b) => /^\s*Read\s*$/.test(b.textContent ?? "")) as HTMLButtonElement;
    expect(read().disabled).toBe(true);
    hasKey = true;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await flush();
    expect(read().disabled).toBe(false);
    expect(host.querySelector("#quotes-ai-precondition")).toBeNull();
  });
});

const quote: CostDocument = {
  id: "q1", orgId: "o1", projectId: "p1", partyId: null, kind: "quote", fileUrl: "k", fileName: "q.pdf", mimeType: "application/pdf",
  docNumber: null, docDate: null, vendorName: "Bayline", currency: "USD", totalAmount: 140_000, status: "parsed",
  parsed: { vendorName: "Bayline", total: 140_000, currency: "USD", lineItems: [{ description: "Repipe", total: 140_000, hours: 1500 }], exclusions: [] },
  rfqGroup: "Unit 300 Repipe", intakeLinkId: null, postedAt: null, createdAt: null,
};
const draft: CostDocument = { ...quote, id: "q2", status: "draft", totalAmount: null, parsed: null, vendorName: "Apex" };

const renderPanel = async (accounts: unknown[], docs: CostDocument[], onChanged = vi.fn()) => {
  await act(async () => {
    root.render(React.createElement(QuotesPanel, {
      orgId: "o1", projectId: "p1", canManage: true, actor: { uid: "u1", email: "u1@example.com" },
      accounts: accounts as never, docs, onChanged, setErr: () => undefined,
    }));
  });
  await flush();
  return onChanged;
};

describe("UX-13 — the bid table says what Read and Award need before the effort", () => {
  it("no AI key: the panel says so up front with the place to fix it, and every Read is disabled", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).startsWith("/api/ai/connection") ? ok({ personal: null }) : ok({ accepted: true, spentUsd: 0, capUsd: 10 })));
    await renderPanel([{ id: "a1", projectId: "p1", code: null, name: "Piping", costType: null, budget: 1, currency: "USD", partyId: null, wbsMilestoneId: null, status: "active" }], [quote, draft]);
    const note = host.querySelector("#quotes-ai-precondition [role=note]");
    expect(note?.textContent).toMatch(/Needs your AI key — AI features here run on your own Claude or OpenAI key\. Set it up \(1 min\)/);
    expect(note?.querySelector("a")?.getAttribute("href")).toBe("/intelligence/setup");
    const reads = [...host.querySelectorAll("button")].filter((b) => /^\s*Read\s*$/.test(b.textContent ?? "")) as HTMLButtonElement[];
    expect(reads.length).toBeGreaterThan(0);
    for (const b of reads) expect(b.disabled).toBe(true);
  });

  it("key in place: no note, Read is enabled", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).startsWith("/api/ai/connection") ? ok({ personal: { provider: "anthropic" } }) : ok({ accepted: true, spentUsd: 0, capUsd: 10 })));
    await renderPanel([{ id: "a1", projectId: "p1", code: null, name: "Piping", costType: null, budget: 1, currency: "USD", partyId: null, wbsMilestoneId: null, status: "active" }], [draft]);
    expect(host.querySelector("#quotes-ai-precondition")).toBeNull();
    const read = [...host.querySelectorAll("button")].find((b) => /^\s*Read\s*$/.test(b.textContent ?? "")) as HTMLButtonElement;
    expect(read.disabled).toBe(false);
  });

  it("no budget line: the need is said before the upload, and 'Create budget line' makes one in place — the row's Award appears once it lands", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ personal: { provider: "anthropic" }, accepted: true, spentUsd: 0, capUsd: 10 })));
    costs.saveAccount.mockResolvedValue({ ok: true });
    const onChanged = await renderPanel([], [quote]);
    expect(host.textContent).toMatch(/Awarding a quote or posting an invoice needs a budget line —/);
    expect(host.textContent).not.toMatch(/needs a budget line(?! —)/);
    const creates = [...host.querySelectorAll("button")].filter((b) => /Create budget line/.test(b.textContent ?? ""));
    expect(creates.length).toBeGreaterThanOrEqual(2);   // up front, and on the bid row
    await act(async () => { (creates[creates.length - 1] as HTMLButtonElement).click(); });
    const name = host.querySelector('input[aria-label="New budget line name"]') as HTMLInputElement;
    const budget = host.querySelector('input[aria-label="New budget line budget"]') as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setValue.call(name, "Piping subcontract"); name.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { setValue.call(budget, "250,000"); budget.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { ([...host.querySelectorAll("button")].find((b) => /^\s*Create\s*$/.test(b.textContent ?? "")) as HTMLButtonElement).click(); });
    await flush();
    expect(costs.saveAccount).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "o1", projectId: "p1", patch: { name: "Piping subcontract", budget: 250_000, costType: "subcontract", currency: "USD" },
    }));
    expect(onChanged).toHaveBeenCalled();
    // with the line in place the row offers Award on it
    await renderPanel([{ id: "a1", projectId: "p1", code: null, name: "Piping subcontract", costType: "subcontract", budget: 250_000, currency: "USD", partyId: null, wbsMilestoneId: null, status: "active" }], [quote], onChanged);
    expect([...host.querySelectorAll("button")].some((b) => /Award/.test(b.textContent ?? ""))).toBe(true);
  });
});

describe("UX-13 review fix — the in-place budget line can take the post it was made for", () => {
  it("a CAD quote's 'Create budget line' makes a CAD line (COST-15 refuses a USD line for it); the currency and cost type are shown and changeable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ personal: { provider: "anthropic" }, accepted: true, spentUsd: 0, capUsd: 10 })));
    costs.saveAccount.mockResolvedValue({ ok: true });
    await renderPanel([], [{ ...quote, currency: "CAD", parsed: { ...quote.parsed!, currency: "CAD" } }]);
    const creates = [...host.querySelectorAll("button")].filter((b) => /Create budget line/.test(b.textContent ?? ""));
    await act(async () => { (creates[creates.length - 1] as HTMLButtonElement).click(); });   // the bid row's
    const cur = host.querySelector('input[aria-label="New budget line currency"]') as HTMLInputElement;
    const type = host.querySelector('select[aria-label="New budget line cost type"]') as HTMLSelectElement;
    expect(cur.value).toBe("CAD");
    expect(type.value).toBe("subcontract");
    const name = host.querySelector('input[aria-label="New budget line name"]') as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setValue.call(name, "Piping (CAD)"); name.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { ([...host.querySelectorAll("button")].find((b) => /^\s*Create\s*$/.test(b.textContent ?? "")) as HTMLButtonElement).click(); });
    await flush();
    expect(costs.saveAccount).toHaveBeenCalledWith(expect.objectContaining({ patch: { name: "Piping (CAD)", budget: 0, costType: "subcontract", currency: "CAD" } }));
  });

  it("an invoice's line defaults to its own currency and a material cost type; a typed currency that is not a code is refused before any write", async () => {
    const src2 = src("components/projects/cost/QuotesPanel.tsx");
    expect(src2).toContain('label="Post as actual" currency={doc.currency} costType="material" />');
    expect(src2).toContain('label="Award" currency={doc.currency} />');
    vi.stubGlobal("fetch", vi.fn(async () => ok({ personal: { provider: "anthropic" }, accepted: true, spentUsd: 0, capUsd: 10 })));
    await renderPanel([], [quote]);
    const creates = [...host.querySelectorAll("button")].filter((b) => /Create budget line/.test(b.textContent ?? ""));
    await act(async () => { (creates[0] as HTMLButtonElement).click(); });   // the up-front one: no document, so USD
    const cur = host.querySelector('input[aria-label="New budget line currency"]') as HTMLInputElement;
    expect(cur.value).toBe("USD");
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const name = host.querySelector('input[aria-label="New budget line name"]') as HTMLInputElement;
    await act(async () => { setValue.call(name, "Misc"); name.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { setValue.call(cur, "dollars"); cur.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { ([...host.querySelectorAll("button")].find((b) => /^\s*Create\s*$/.test(b.textContent ?? "")) as HTMLButtonElement).click(); });
    await flush();
    expect(costs.saveAccount).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/is not a currency code/);
  });
});

describe("UX-13 — every AI entry point states its precondition before the click", () => {
  it("the checklist read, the assessment and the quality-manual evaluation are gated on the same readiness and say it", () => {
    const q = src("components/projects/QualityTab.tsx");
    expect(q).toContain("<button onClick={() => void read()} disabled={!doc || reading || aiBlocked(ai)}");
    expect(q).toContain("<button onClick={() => void assess()} disabled={busy != null || aiBlocked(ai)}");
    expect((q.match(/<AiPreconditionNote readiness=\{ai\}/g) ?? []).length).toBe(2);
    const c = src("app/(protected)/companies/[id]/page.tsx");
    expect(c).toContain("<button onClick={() => void evaluate()} disabled={!doc || evaluating || aiBlocked(ai)}");
    expect(c).toContain('<AiPreconditionNote readiness={ai} className="basis-full" />');
    // the server's gates are not edited (intelligence's file)
    expect(src("lib/ai/governedCall.ts")).toContain("Add your Claude or OpenAI key in AI settings first");
  });
  it("the empty checklist state offers the way in — document control, or pointing at a document already there", () => {
    const q = src("components/projects/QualityTab.tsx");
    expect(q).toContain('<Link href="/documents" className="underline text-[var(--color-accent)]">Upload it in document control</Link>');
    expect(q).toContain('onClick={() => setShowNew(true)} className="underline text-[var(--color-accent)]">Point at one already uploaded</button>');
  });
});
