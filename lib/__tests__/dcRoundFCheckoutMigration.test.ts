// Document-control Round F — DCK-14 at the database: 20261075 installs the
// checkout_episodes seal guard. The enforcement is a trigger, so it cannot be
// exercised from vitest without a live database; these pins hold the shape
// (the two refusals, the service pass, the search_path pin, the ONE-result-
// set protocol) and keep the app's refusal-text match in lock-step with the
// migration's message.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const migDir = join(root, "supabase", "migrations");
const file = "20261075_dc_roundF_checkout_episode_seal.sql";
const sql = readFileSync(join(migDir, file), "utf8");
const stripSqlComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");

function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  expect(b, `marker not found after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(a, b);
}

describe("20261075 — checkout_episodes seal guard (DCK-14)", () => {
  const fn = between(sql, "CREATE OR REPLACE FUNCTION enforce_checkout_episode_guard()", "DROP TRIGGER IF EXISTS trg_checkout_episode_guard");

  it("is a SECURITY DEFINER trigger function with search_path pinned, attached BEFORE UPDATE FOR EACH ROW", () => {
    expect(fn).toMatch(/RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$\$/);
    expect(sql).toMatch(/DROP TRIGGER IF EXISTS trg_checkout_episode_guard ON checkout_episodes;\s*\nCREATE TRIGGER trg_checkout_episode_guard\s*\n\s*BEFORE UPDATE ON checkout_episodes\s*\n\s*FOR EACH ROW EXECUTE FUNCTION enforce_checkout_episode_guard\(\);/);
  });

  it("the service role passes (the trusted-backend seam every checkout guard uses)", () => {
    expect(fn).toMatch(/IF auth\.uid\(\) IS NULL THEN RETURN NEW; END IF;/);
  });

  it("done-when 1: a CLOSED episode is immutable to every signed-in writer", () => {
    expect(fn).toMatch(/IF OLD\.status = 'closed' THEN\s*\n\s*RAISE EXCEPTION 'A closed checkout episode is a sealed record and cannot be changed\.'\s*\n\s*USING ERRCODE = 'check_violation';/);
  });

  it("done-when 3 (the rail half): active → closed is refused while a member session tied to the episode is still active", () => {
    expect(fn).toMatch(/IF NEW\.status = 'closed' AND OLD\.status = 'active'\s*\n\s*AND EXISTS \(SELECT 1 FROM checkout_sessions s\s*\n\s*WHERE s\.episode_id = OLD\.id AND s\.status = 'active'\) THEN/);
    expect(fn).toMatch(/RAISE EXCEPTION 'This checkout episode still has active sessions and cannot be sealed\.'/);
  });

  it("the app's refusal match is the migration's message: closeEpisode reads that refusal as 'reconcile, do not seal'", () => {
    const lib = readFileSync(join(root, "lib", "checkoutEpisodes.ts"), "utf8");
    const m = lib.match(/const EPISODE_LIVE_SESSIONS_RAIL = "([^"]+)";/);
    expect(m, "the rail constant").not.toBeNull();
    expect(fn).toContain(m![1]);
    expect(lib).toMatch(/\.includes\(EPISODE_LIVE_SESSIONS_RAIL\)\) return "live_sessions";/);
    // and the re-read is inside the close, before the write
    const close = between(lib, "async function closeEpisode(", "// ─── System messages");
    expect(close.indexOf('.from("checkout_sessions")')).toBeLessThan(close.indexOf('.from("checkout_episodes")'));
    expect(close).toMatch(/\.eq\("episode_id", input\.episodeId\)\s*\n\s*\.eq\("status", "active"\)/);
  });

  it("ONE result set: inventory captured into a TEMP TABLE before BEGIN, then BEGIN … COMMIT, then a single final SELECT of (check, ok, n)", () => {
    const body = stripSqlComments(sql);
    const temp = body.indexOf("CREATE TEMP TABLE _dc_roundf_episode_seal_inventory");
    const begin = body.indexOf("BEGIN;");
    const commit = body.indexOf("COMMIT;");
    expect(temp).toBeGreaterThanOrEqual(0);
    expect(temp).toBeLessThan(begin);
    expect(begin).toBeLessThan(commit);
    const tail = body.slice(commit + "COMMIT;".length);
    // exactly one statement after COMMIT — the verification SELECT (string
    // literals stripped first: the prosrc probes quote plpgsql that carries
    // its own semicolons)
    const literalsStripped = tail.replace(/'(?:[^']|'')*'/g, "''");
    expect(literalsStripped.trim().split(";").filter((s) => s.trim()).length).toBe(1);
    expect(tail).toMatch(/SELECT 'guard installed: BEFORE UPDATE ON checkout_episodes, FOR EACH ROW'::text AS check,/);
    expect(tail).toMatch(/AS ok,\s*\n\s*NULL::text AS n/);
    expect(tail).toMatch(/SELECT check, NULL::boolean, n FROM _dc_roundf_episode_seal_inventory;/);
    expect((tail.match(/UNION ALL/g) ?? []).length).toBe(5);
    // the inventory is aggregate counts only — never a customer row
    const inv = between(body, "CREATE TEMP TABLE _dc_roundf_episode_seal_inventory", "BEGIN;");
    expect(inv.match(/SELECT '/g)?.length).toBe(4);
    expect(inv.match(/COUNT\(\*\)::text/g)?.length).toBe(4);
  });

  it("probes follow the rules: prosrc is verbatim (an apostrophe inside a literal is ''''); the trigger probe deparses via pg_get_triggerdef", () => {
    const tail = sql.slice(sql.indexOf("COMMIT;"));
    expect(tail).toContain("prosrc LIKE '%IF OLD.status = ''closed'' THEN%'");
    expect(tail).toContain("prosrc LIKE '%s.episode_id = OLD.id AND s.status = ''active''%'");
    expect(tail).toContain("pg_get_triggerdef(t.oid) LIKE 'CREATE TRIGGER trg_checkout_episode_guard BEFORE UPDATE ON public.checkout_episodes FOR EACH ROW%'");
    expect(tail).toContain("array_to_string(proconfig, ',') LIKE '%search_path=public%'");
  });

  it("this migration is the ONLY definer of the guard in the numbered sequence (no re-creation to prove byte-fidelity against)", () => {
    const definers = readdirSync(migDir)
      .filter((f) => /^\d{8}/.test(f) && f.endsWith(".sql"))
      .filter((f) => /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+enforce_checkout_episode_guard\(/i.test(stripSqlComments(readFileSync(join(migDir, f), "utf8"))));
    expect(definers).toEqual([file]);
    const schema = stripSqlComments(readFileSync(join(root, "supabase", "schema.sql"), "utf8"));
    expect(schema).not.toMatch(/enforce_checkout_episode_guard/);
  });

  it("does not touch the checkout_episodes policies (a guard, not a policy change — the app's cross-user close keeps working)", () => {
    expect(stripSqlComments(sql)).not.toMatch(/CREATE POLICY/);
    expect(stripSqlComments(sql)).not.toMatch(/DROP POLICY/);
  });
});
