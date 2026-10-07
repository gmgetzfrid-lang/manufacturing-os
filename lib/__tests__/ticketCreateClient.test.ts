// drafting-flow Round G, DF-P2 CREATE — the browser's side of the create
// route, and the census that keeps creation in one place.
//
//   * LEAK-6: a check-in's resume read is AWAITED and its error READ before
//     anything is filed (resumeCheckinTicket) — a slow read is waited for, a
//     failed one made once more, and a read that still cannot answer hands
//     over to the route, which resumes by the same episode server-side.
//   * submitTicketCreate never throws and carries the refused field back.
//   * EDGE-8 / EDGE-13 census: no browser file inserts a ticket, emits the
//     new-request notice, or allocates a request number any more.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const s = vi.hoisted(() => ({ session: { access_token: "tok" } as null | { access_token: string } }));
vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: s.session } }) } },
}));

import { resumeCheckinTicket, submitTicketCreate, discardStagedFiles, DISCARD_BATCH, type ResumeRead } from "@/lib/ticketCreateClient";
import {
  ticketStagingFolder, ticketStagingPrefix, isStagedKeyOf, finalAttachmentKey, resolveUnit, resolveDerivedUnit, unitOptionsFor, checkinMocLine,
  contractLimitRefusal, clipToLimit, parseTicketCreateBody, MAX_ATTACHMENTS, MAX_DESCRIPTION, MAX_TITLE, UNIT_UNKNOWN_LABEL,
} from "@/lib/ticketCreate";

const T1 = { id: "t1", number: "KE-DDRT-26-0001" };
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

describe("LEAK-6 — resumeCheckinTicket: never a second ticket from a failed or slow read", () => {
  it("a ticket the read found is resumed", async () => {
    expect(await resumeCheckinTicket(Promise.resolve({ ticket: T1, error: null }), vi.fn())).toEqual(T1);
  });

  it("a PENDING read is awaited — the commit cannot race past it", async () => {
    const d = deferred<ResumeRead>();
    let settled = false;
    const p = resumeCheckinTicket(d.promise, vi.fn()).then((t) => { settled = true; return t; });
    await Promise.resolve();
    expect(settled).toBe(false);          // still waiting on the read
    d.resolve({ ticket: T1, error: null });
    expect(await p).toEqual(T1);
  });

  it("a FAILED read is read once more; its answer decides", async () => {
    const reread = vi.fn(async () => ({ ticket: T1, error: null }));
    expect(await resumeCheckinTicket(Promise.resolve({ ticket: null, error: "timeout" }), reread)).toEqual(T1);
    expect(reread).toHaveBeenCalledTimes(1);
  });

  it("a read that still cannot answer is null — the route then resumes by the episode server-side", async () => {
    const reread = vi.fn(async () => ({ ticket: null, error: "timeout" }));
    expect(await resumeCheckinTicket(Promise.resolve({ ticket: null, error: "timeout" }), reread)).toBeNull();
    expect(await resumeCheckinTicket(null, reread)).toBeNull();
  });

  it("the panel awaits it before creating, and the route resumes by episode for this requester", () => {
    const c = readFileSync(join(process.cwd(), "components/documents/CheckInPanel.tsx"), "utf8");
    expect(c).toContain("const ticket = done.ticket ?? (await resumedTicket()) ?? await createDraftingTicket(selected);");
    // the lookup reads its own error
    expect(c).toMatch(/if \(error\) return \{ ticket: null, error: error\.message \|\| "the lookup failed" \};/);
    // and is never fire-and-forget into a ref the commit trusts
    expect(c).not.toContain("resumedTicketRef");
    const r = readFileSync(join(process.cwd(), "app/api/tickets/create/route.ts"), "utf8");
    const look = r.slice(r.indexOf("if (input.origin.kind === \"checkin\" && input.origin.episodeId)"), r.indexOf("// 4. The request number"));
    expect(look).toContain('.eq("requester_id", caller.id)');
    expect(look).toContain('.eq("metadata->checkin->>episodeId", input.origin.episodeId)');
    expect(look).toContain("if (priorErr) return { status: 503");
  });
});

describe("submitTicketCreate", () => {
  beforeEach(() => { s.session = { access_token: "tok" }; vi.unstubAllGlobals(); });

  it("posts the contract with the session token and returns the filed request", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, id: "t1", ticketNumber: "N-1", resumed: false, notified: true }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await submitTicketCreate({ orgId: "o", title: "t", description: "d", requestType: "ISO", origin: { kind: "portal" } });
    expect(r).toEqual({ ok: true, id: "t1", ticketNumber: "N-1", resumed: false, notified: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/tickets/create");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("a refusal carries its message and field; a network failure and a signed-out session are said in words — never thrown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: '"Work Order #" (Work order) is required.', field: "custom:wo.wo_number" }), { status: 400 })));
    expect(await submitTicketCreate({ orgId: "o", title: "t", description: "d", requestType: "ISO", origin: { kind: "portal" } }))
      .toEqual({ ok: false, status: 400, error: '"Work Order #" (Work order) is required.', field: "custom:wo.wo_number" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    expect(await submitTicketCreate({ orgId: "o", title: "t", description: "d", requestType: "ISO", origin: { kind: "portal" } }))
      .toMatchObject({ ok: false, status: 0, error: expect.stringMatching(/Couldn't reach the server/) });
    s.session = null;
    expect(await submitTicketCreate({ orgId: "o", title: "t", description: "d", requestType: "ISO", origin: { kind: "portal" } }))
      .toMatchObject({ ok: false, status: 401 });
  });

  it("discardStagedFiles asks the route (DELETE) and swallows a failure", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("offline"); });
    vi.stubGlobal("fetch", fetchMock);
    await expect(discardStagedFiles("o", ["k"])).resolves.toBeUndefined();
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe("DELETE");
    fetchMock.mockClear();
    await discardStagedFiles("o", []);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("discardStagedFiles sends at most DISCARD_BATCH (the DELETE route's cap) keys per call — a 120-file batch is discarded whole", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const keys = Array.from({ length: 120 }, (_, i) => `k${i}`);
    await discardStagedFiles("o", keys);
    const sent = fetchMock.mock.calls.map((c) => JSON.parse(String((c as unknown as [string, RequestInit])[1].body)).keys as string[]);
    expect(sent.map((k) => k.length)).toEqual([DISCARD_BATCH, DISCARD_BATCH, 20]);
    expect(sent.flat()).toEqual(keys);
    const route = readFileSync(join(process.cwd(), "app/api/tickets/create/route.ts"), "utf8");
    expect(route).toContain(`keys.length > ${DISCARD_BATCH}`);
  });

  it("a filed request's warnings (a hand-off the route dropped) are carried back", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, id: "t1", ticketNumber: "N-1", resumed: false, warnings: ["w1", 7] }), { status: 201 })));
    expect(await submitTicketCreate({ orgId: "o", title: "t", description: "d", requestType: "ISO", origin: { kind: "portal" } }))
      .toEqual({ ok: true, id: "t1", ticketNumber: "N-1", resumed: false, warnings: ["w1"] });
  });
});

describe("the contract's pure parts", () => {
  const ORG = "11111111-1111-4111-8111-111111111111";
  const UID = "aaaaaaaa-0000-4000-8000-000000000001";
  const BATCH = "bbbbbbbb-0000-4000-8000-000000000001";

  it("a staged key is <pending prefix><batch>/<ts>_<name>, the caller's own, in this workspace", () => {
    const key = `orgs/${ORG}/tickets/${ticketStagingFolder(UID, BATCH)}/1727000000000_red line (1).pdf`;
    expect(key.startsWith(ticketStagingPrefix(ORG, UID))).toBe(true);
    expect(isStagedKeyOf(key, ORG, UID)).toBe(true);
    expect(isStagedKeyOf(key, ORG, "aaaaaaaa-0000-4000-8000-000000000002")).toBe(false);
    expect(isStagedKeyOf(key, "22222222-2222-4222-8222-222222222222", UID)).toBe(false);
    expect(isStagedKeyOf(`orgs/${ORG}/tickets/KE-1/1727000000000_x.pdf`, ORG, UID)).toBe(false);
    expect(isStagedKeyOf(`orgs/${ORG}/tickets/pending/${UID}/${BATCH}/../x.pdf`, ORG, UID)).toBe(false);
    expect(finalAttachmentKey(ORG, "KE-DDRT-26-0001", key)).toBe(`orgs/${ORG}/tickets/KE-DDRT-26-0001/1727000000000_red line (1).pdf`);
  });

  it("resolveUnit: none / matched (case, spacing, label) / free / unmatched", () => {
    const opts = unitOptionsFor({ units: { label: "U", enabled: true, options: [{ label: "Unit 200", value: "200" }] } }, []);
    expect(resolveUnit(null, opts)).toEqual({ kind: "none", unit: null });
    expect(resolveUnit("  ", opts)).toEqual({ kind: "none", unit: null });
    expect(resolveUnit("200", opts)).toEqual({ kind: "matched", unit: "200" });
    expect(resolveUnit("unit  200", opts)).toEqual({ kind: "matched", unit: "200" });
    expect(resolveUnit("300", opts)).toEqual({ kind: "unmatched", unit: "300" });
    expect(resolveUnit("20-CRUDE", [])).toEqual({ kind: "free", unit: "20-CRUDE" });
    expect(unitOptionsFor(null, [{ code: "20", label: "Crude" }])).toEqual([{ value: "20", label: "20 — Crude" }]);
    expect(UNIT_UNKNOWN_LABEL).toBe("Unit unknown — triage assigns");
  });

  it("resolveDerivedUnit: the first candidate ON the list wins; else the first given, as resolveUnit classes it", () => {
    const opts = unitOptionsFor({ units: { label: "U", enabled: true, options: [{ label: "20-CRUDE", value: "20-CRUDE" }, { label: "30-VAC", value: "30-VAC" }] } }, []);
    expect(resolveDerivedUnit(["20-CRUDE", "20"], opts)).toEqual({ kind: "matched", unit: "20-CRUDE" });
    expect(resolveDerivedUnit(["Tank farm", "30-vac"], opts)).toEqual({ kind: "matched", unit: "30-VAC" });
    expect(resolveDerivedUnit(["Tank farm", "99"], opts)).toEqual({ kind: "unmatched", unit: "Tank farm" });
    expect(resolveDerivedUnit([null, " ", "99"], opts)).toEqual({ kind: "unmatched", unit: "99" });
    expect(resolveDerivedUnit([null, undefined], opts)).toEqual({ kind: "none", unit: null });
    expect(resolveDerivedUnit(["Tank farm", "20"], [])).toEqual({ kind: "free", unit: "Tank farm" });
  });

  it("the contract's limits: one rule, one message, for the form, the check-in and the route; machine-written text is clipped, not refused", () => {
    expect(MAX_ATTACHMENTS).toBe(200);
    expect(contractLimitRefusal({ title: "t", description: "d", attachmentCount: MAX_ATTACHMENTS })).toBeNull();
    const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => ({ kind: "source_reference", key: `orgs/x/${i}.pdf`, name: `${i}.pdf` }));
    const body = { orgId: "11111111-1111-4111-8111-111111111111", title: "t", description: "d", requestType: "ISO", origin: { kind: "portal" } };
    expect(parseTicketCreateBody({ ...body, attachments: many })).toEqual(contractLimitRefusal({ attachmentCount: MAX_ATTACHMENTS + 1 }));
    expect(parseTicketCreateBody({ ...body, title: "x".repeat(MAX_TITLE + 1) })).toEqual(contractLimitRefusal({ title: "x".repeat(MAX_TITLE + 1) }));
    expect(contractLimitRefusal({ description: "x".repeat(MAX_DESCRIPTION + 1) })).toMatchObject({ field: "description" });
    expect(contractLimitRefusal({ title: `  ${"x".repeat(MAX_TITLE)}  ` })).toBeNull();   // measured trimmed, as the route does
    expect(clipToLimit("short", 10)).toBe("short");
    const clipped = clipToLimit("x".repeat(MAX_TITLE + 40), MAX_TITLE);
    expect(clipped).toHaveLength(MAX_TITLE);
    expect(clipped.endsWith("…")).toBe(true);
  });

  it("the check-in MOC line is the one the panel always wrote", () => {
    const moc = (status: "completed" | "in_progress" | "none" | null, number: string | null) => ({ status, number });
    expect(checkinMocLine(null)).toBeNull();
    expect(checkinMocLine(moc("none", null))).toBe("MOC: NONE ON RECORD — flagged as an undocumented field change.");
    expect(checkinMocLine(moc("completed", "MOC-1"))).toBe("MOC completed: MOC-1");
    expect(checkinMocLine(moc("in_progress", "MOC-2"))).toBe("MOC in progress: MOC-2");
  });
});

describe("census — creation lives in one place (EDGE-8, EDGE-13, FRIC-8)", () => {
  const root = process.cwd();
  const walk = (d: string): string[] => readdirSync(join(root, d), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "__tests__" || e.name === "node_modules" ? [] : walk(join(d, e.name))) : /\.(ts|tsx)$/.test(e.name) ? [join(d, e.name)] : []);
  const files = ["app", "lib", "components", "hooks"].flatMap(walk);
  const src = (f: string) => readFileSync(join(root, f), "utf8");

  it("no browser file allocates a request number; the create route allocates it as the caller", () => {
    const allocating = files.filter((f) => /rpc\(\s*["']next_ticket_number["']|\bgenerateTicketNumber\s*\(/.test(src(f)));
    expect(allocating.sort()).toEqual(["app/api/tickets/create/route.ts", "lib/ticketNumber.ts"]);
    expect(src("app/api/tickets/create/route.ts")).toContain('await caller_client.rpc("next_ticket_number", { p_org: orgId, p_year: year })');
  });

  it("the request form no longer imports emit, routes recipients or numbers anything (EDGE-8 done-when 2)", () => {
    const page = src("app/(protected)/requests/new/page.tsx");
    expect(page).not.toMatch(/from ['"]@\/lib\/notify\/dispatch['"]/);
    expect(page).not.toMatch(/resolveTicketRecipients|generateTicketNumber|setTimeout\(/);
    expect(page).toContain("submitTicketCreate({");
    // the redirect follows the route's answer, not a 500 ms timer
    expect(page.indexOf("if (!res.ok) {")).toBeLessThan(page.indexOf("router.push('/requests');"));
  });

  it("the creation notice is written only by the route (one channel set for every door — ROUTE-4)", () => {
    const noticeWriters = files.filter((f) => /New drafting request:|Intake collision flagged:/.test(src(f)));
    expect(noticeWriters.sort()).toEqual(["lib/ticketCreate.ts"]);
    const route = src("app/api/tickets/create/route.ts");
    expect(route).toContain("await runWithServerClient(supabaseAdmin, () => emit({");
    expect(route).toContain('category: "assignment",');
  });
});
