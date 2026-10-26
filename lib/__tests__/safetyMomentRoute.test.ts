// /api/projects/safety-moment — who may build one, what reaches the model,
// that only lessons backed by a page the search returned survive, and that
// the result is saved for the shift.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  tables: {} as Record<string, { data?: unknown; error?: unknown }>,
  upserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  aiInputs: [] as Array<{ user: string; webSearch?: boolean; requireLiveWeb?: boolean }>,
  aiOut: { text: "", webSources: [], searchResults: [] } as { text: string; webSources: unknown[]; searchResults: Array<{ url: string; title: string | null }> },
}));

function chain(table: string) {
  const res = () => state.tables[table] ?? { data: null, error: null };
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: res().data ?? null, error: res().error ?? null });
      if (prop === "upsert") return (row: Record<string, unknown>) => {
        state.upserts.push({ table, row });
        return Promise.resolve({ error: state.tables[`${table}:upsert`]?.error ?? null });
      };
      return () => (prop === "maybeSingle" || prop === "single")
        ? Promise.resolve({ data: res().data ?? null, error: res().error ?? null })
        : new Proxy({}, h);
    },
  };
  return new Proxy({}, h);
}

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: vi.fn(async () => state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
    from: (t: string) => chain(t),
  },
}));
vi.mock("@/lib/ai/governedCall", () => ({
  GovernedCallError: class extends Error { constructor(m: string, public status: number) { super(m); } },
  governedAiCall: vi.fn(async (input: { user: string; webSearch?: boolean; requireLiveWeb?: boolean }) => {
    state.aiInputs.push(input);
    return state.aiOut;
  }),
}));

import { POST } from "@/app/api/projects/safety-moment/route";

const HAZARDS = [
  { kind: "hydroblast", jobs: [{ id: "6", equipment: "E-17", name: "Hydroblast 10K Tubes and Shell", who: "Evergreen 1", when: "18:00–22:00" }], hours: 4 },
  { kind: "line_break", jobs: [{ id: "4", equipment: "PSVs", name: "PSV-021 swap", who: null, when: "…–23:00" }], hours: 5 },
  { kind: "not_a_kind", jobs: [] },
];
const body = (extra: Record<string, unknown> = {}) => ({
  orgId: "org-1", projectId: "p-1", shiftStart: Date.parse("2026-10-27T01:00:00Z"), shiftKind: "night",
  shiftLabel: "Night shift Mon, Oct 26 18:00–6:00", hazards: HAZARDS, note: "Flex lance on the tubes", ...extra,
});
const req = (b: Record<string, unknown>, token = "t") => new NextRequest("http://x/api/projects/safety-moment", {
  method: "POST",
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(b),
});

beforeEach(() => {
  state.user = { id: "u1", email: "sup@x.test" };
  state.tables = {
    org_members: { data: { status: "active" } },
    projects: { data: { id: "p-1", name: "Transmix-1 Turnaround" } },
    shift_safety_moments: { data: [{ moment: { items: [{ gems: [{ source: { url: "https://old.example/used" } }] }] } }] },
  };
  state.upserts = [];
  state.aiInputs = [];
  state.aiOut = {
    text: JSON.stringify({ hazards: [
      { kind: "hydroblast", title: "Hydroblasting 10K", gems: [
        { what: "Pedal taped down; fatal (Germany, 2018).", do: "Pedal dumps on release.", source: "https://eusalt.com/x.pdf" },
        { what: "Invented.", do: "Nothing.", source: "https://made.up/page" },
      ] },
      { kind: "line_break", title: "PSV-021 swap", gems: [
        { what: "Undrainable line cut as routine; 4 killed (Tosco Avon, 1999).", do: "Won't drain? Stop.", source: "https://www.csb.gov/tosco/" },
      ] },
    ] }),
    webSources: [],
    searchResults: [{ url: "https://eusalt.com/x.pdf", title: "Inovyn" }, { url: "https://www.csb.gov/tosco/", title: "CSB" }],
  };
});

describe("POST /api/projects/safety-moment", () => {
  it("needs a signed-in member", async () => {
    expect((await POST(req(body(), ""))).status).toBe(401);
    state.tables.org_members = { data: { status: "invited" } };
    expect((await POST(req(body()))).status).toBe(403);
  });

  it("needs something to build from", async () => {
    const res = await POST(req(body({ hazards: [] })));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/add a note/);
  });

  it("searches live, keeps only sourced lessons and saves them for the shift", async () => {
    const res = await POST(req(body()));
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.saved).toBe(true);
    expect(out.dropped).toBe(1);
    expect(out.moment.items.map((i: { kind: string }) => i.kind)).toEqual(["hydroblast", "line_break"]);
    expect(out.moment.items[0].gems).toHaveLength(1);
    expect(out.moment.items[0].context).toBe("E-17 18:00–22:00 · Evergreen 1");
    expect(out.moment.note).toBe("Flex lance on the tubes");

    const ai = state.aiInputs[0];
    expect(ai.webSearch).toBe(true);
    expect(ai.requireLiveWeb).toBe(true);
    expect(ai.user).toContain("Supervisor's note: Flex lance on the tubes");
    expect(ai.user).toContain("https://old.example/used");
    expect(ai.user).not.toContain("not_a_kind");

    expect(state.upserts).toHaveLength(1);
    const row = state.upserts[0].row;
    expect(row.project_id).toBe("p-1");
    expect(row.shift_kind).toBe("night");
    expect(row.shift_start).toBe("2026-10-27T01:00:00.000Z");
  });

  it("refuses when nothing could be sourced", async () => {
    state.aiOut.searchResults = [];
    const res = await POST(req(body()));
    expect(res.status).toBe(502);
    expect(state.upserts).toHaveLength(0);
  });

  it("still returns the moment when the table isn't there yet, and says so", async () => {
    state.tables["shift_safety_moments:upsert"] = { error: { code: "42P01", message: "relation does not exist" } };
    const out = await (await POST(req(body()))).json();
    expect(out.saved).toBe(false);
    expect(out.warning).toMatch(/20261031_shift_safety_moments/);
    expect(out.moment.items).toHaveLength(2);
  });
});
