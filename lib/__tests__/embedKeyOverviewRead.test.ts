// intelligence Round G — I-20 fix pass, SEM-1: AI settings reads
// /api/knowledge/embed's `key-overview` before a switch of embedding model or
// provider. With `models` asked for, an answer that carries no `indexes` —
// a route instance on an earlier build, a body some intermediary rewrote —
// is NOT "no library affected": it throws, so the editor shows the general
// warning instead of saving the switch with no confirm (fail closed).
//
// REGRESSION: the builds-only read (no `models`) still needs only `builds`,
// and a full answer is returned as it came.
//
// GOV-14 (I-20 fix pass 2): the Stop in AI settings' list releases through
// `releaseBuildOnMyKey`, which sends `onlyMine` — the route refuses (409) a
// consent that no longer names the caller — and throws the route's sentence.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } },
}));

import { getEmbedKeyOverview, embeddingSwitchImpact, switchImpactIsEmpty, releaseBuildOnMyKey } from "@/lib/embedKeyOverview";
import { EMBEDDING_PROVIDERS } from "@/lib/ai/embeddings";

const VOYAGE = EMBEDDING_PROVIDERS.find((p) => p.id === "voyage")!.models;
const OPENAI = EMBEDDING_PROVIDERS.find((p) => p.id === "openai")!.models;

let answer: { status: number; body: unknown };
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(answer.body), { status: answer.status })));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("SEM-1 — the overview read before a switch fails closed", () => {
  it("reproduction → fix: with models asked for, a 200 with builds but no indexes throws — never an empty impact that saves without a confirm", async () => {
    answer = { status: 200, body: { builds: [] } };
    await expect(getEmbedKeyOverview("o1", { models: true })).rejects.toThrow(/did not list the libraries' meaning indexes/);
    // what the editor then does with it: a general warning, never "nothing affected"
    const impact = embeddingSwitchImpact(
      { provider: "voyage", model: VOYAGE[0] }, { provider: "openai", model: OPENAI[0] },
      null, "The answer did not list the libraries' meaning indexes",
    )!;
    expect(switchImpactIsEmpty(impact)).toBe(false);
  });

  it("…and an indexes field that is not a list is refused the same way", async () => {
    answer = { status: 200, body: { builds: [], indexes: { L1: {} } } };
    await expect(getEmbedKeyOverview("o1", { models: true })).rejects.toThrow(/did not list the libraries' meaning indexes/);
  });

  it("the route's refusal is thrown with its own sentence", async () => {
    answer = { status: 403, body: { error: "Not a member of this workspace" } };
    await expect(getEmbedKeyOverview("o1", { models: true })).rejects.toThrow("Not a member of this workspace");
  });

  it("REGRESSION: the builds-only read needs only builds; a full answer is returned as it came", async () => {
    answer = { status: 200, body: { builds: [] } };
    await expect(getEmbedKeyOverview("o1")).resolves.toEqual({ builds: [] });
    const full = { builds: [], indexes: [{ libraryId: "L1", libraryName: "Standards", models: { [VOYAGE[0]]: 3 } }] };
    answer = { status: 200, body: full };
    await expect(getEmbedKeyOverview("o1", { models: true })).resolves.toEqual(full);
    expect(fetch).toHaveBeenLastCalledWith("/api/knowledge/embed", expect.objectContaining({
      body: JSON.stringify({ orgId: "o1", action: "key-overview", models: true }),
    }));
  });
});

describe("GOV-14 — the list's Stop releases only a build still on the caller's key", () => {
  it("sends the release with onlyMine and returns the route's answer", async () => {
    answer = { status: 200, body: { released: true } };
    await expect(releaseBuildOnMyKey("o1", "L1")).resolves.toEqual({ released: true });
    expect(fetch).toHaveBeenLastCalledWith("/api/knowledge/embed", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ orgId: "o1", libraryId: "L1", action: "release", onlyMine: true }),
    }));
    answer = { status: 200, body: { released: false } };
    await expect(releaseBuildOnMyKey("o1", "L1")).resolves.toEqual({ released: false });
  });

  it("a refusal (the 409 for a build no longer on the caller's key) is thrown with the route's own sentence", async () => {
    answer = { status: 409, body: { error: "This background build no longer runs on your key — another member's build replaced it after the list was read — so nothing was stopped.", released: false, changed: true } };
    await expect(releaseBuildOnMyKey("o1", "L1")).rejects.toThrow(/no longer runs on your key/);
  });
});
