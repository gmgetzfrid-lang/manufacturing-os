// projects Round G — J1 INTAKE-DOOR (INTK-2 / DEC-50): the shared client's
// service-role binding for a sessionless route is REQUEST-SCOPED. Real
// modules: lib/supabase.ts's proxy and lib/serverClientScope.ts's
// AsyncLocalStorage — no mock of either.

import { describe, it, expect } from "vitest";
import { supabase } from "@/lib/supabase";
import { runWithServerClient } from "@/lib/serverClientScope";

const fake = (name: string) => ({ from: (t: string) => `${name}:${t}` });
const tick = () => new Promise<void>((r) => setImmediate(r));
const who = () => String((supabase as unknown as { from: (t: string) => unknown }).from("documents"));

describe("runWithServerClient — the shared client resolves to the bound client in that async context only", () => {
  it("outside a scope the shared client is the ordinary one", () => {
    expect(who()).not.toMatch(/^admin:/);
  });
  it("inside a scope — across awaits and in work it starts — the shared client is the bound one; afterwards it is not", async () => {
    let detached: Promise<string> | null = null;
    const seen = await runWithServerClient(fake("admin"), async () => {
      const before = who();
      await tick();
      detached = (async () => { await tick(); await tick(); return who(); })();
      return [before, who()];
    });
    expect(seen).toEqual(["admin:documents", "admin:documents"]);
    // fire-and-forget work started inside keeps the scope after fn returned
    expect(await detached).toBe("admin:documents");
    expect(who()).not.toMatch(/^admin:/);
  });
  it("two concurrent contexts never see each other's client — and an unscoped one sees neither", async () => {
    const samples: string[] = [];
    const a = runWithServerClient(fake("admin"), async () => { for (let i = 0; i < 3; i++) { await tick(); samples.push(`a=${who()}`); } });
    const b = runWithServerClient(fake("other"), async () => { for (let i = 0; i < 3; i++) { await tick(); samples.push(`b=${who()}`); } });
    const c = (async () => { for (let i = 0; i < 3; i++) { await tick(); samples.push(`c=${who().startsWith("admin:") || who().startsWith("other:") ? "bound" : "plain"}`); } })();
    await Promise.all([a, b, c]);
    expect(samples.filter((x) => x.startsWith("a="))).toEqual(Array(3).fill("a=admin:documents"));
    expect(samples.filter((x) => x.startsWith("b="))).toEqual(Array(3).fill("b=other:documents"));
    expect(samples.filter((x) => x.startsWith("c="))).toEqual(Array(3).fill("c=plain"));
    // interleaved, not serialised — the case a module-wide swap got wrong
    expect(samples.slice(0, 3).map((x) => x[0]).sort()).toEqual(["a", "b", "c"]);
  });
  it("the intake route binds through the scope, never the module-wide swap", async () => {
    const { readFileSync } = await import("node:fs");
    const r = readFileSync(`${process.cwd()}/app/api/intake/upload/route.ts`, "utf8");
    expect(r).toContain('import { runWithServerClient } from "@/lib/serverClientScope";');
    expect(r).toContain("return runWithServerClient(supabaseAdmin, fn);");
    expect(r).not.toMatch(/__setServerSupabaseClient|__resetServerSupabaseClient|serviceClientHolds/);
  });
});
