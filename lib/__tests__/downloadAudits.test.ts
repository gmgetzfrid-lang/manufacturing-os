// document-control Round F — P2 EGRESS: download_audits is a RECORD
// (DIST-9 / DRLS-8 / XEDGE-3 limb, DEC-44 §1).
//
//   * Migration 20261068 replaces the one FOR ALL policy (any active member
//     could rewrite or delete the distribution record) with SELECT for
//     members + INSERT of the caller's OWN rows, nothing else; adds the
//     external-attribution shape (source, share_id, transmittal_id; user_id
//     nullable behind a CHECK that every row is attributed to something);
//     backfills org_id from the document and makes it NOT NULL (NOT VALID
//     fallback when data this repo cannot see forbids it). Shape-pinned, and
//     the SELECT arm is byte-carried from the schema.sql policy it replaces.
//   * A census replays schema.sql + every numbered migration and proves the
//     LIVE policy set on download_audits is exactly {insert_own, select}.
//   * lib/staleCopies.getDocumentRecall reads the new shape (legacy fallback
//     on a pre-migration database), flags EXTERNAL copies, and says
//     `unavailable` when the record cannot be read instead of returning an
//     empty, confident-looking list; nudgeStaleHolders reaches members only
//     and records how many external copies it could not reach.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const MIGRATION = "supabase/migrations/20261068_dc_roundF_download_audits_record.sql";

function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  expect(b, `marker not found after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(a, b);
}
const stripSqlComments = (sql: string) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");

// ── the staleCopies mock: every chain resolves through state.respond ─────────
const state = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; select: string }>,
  respond: ((_table: string, _select: string) => ({ data: [] as unknown, error: null as unknown })) as
    (table: string, select: string) => { data: unknown; error: unknown },
  emits: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/lib/supabase", () => {
  function chain(table: string) {
    let select = "";
    const c: Record<string, unknown> = {};
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void) => {
            state.calls.push({ table, select });
            resolve(state.respond(table, select));
          };
        }
        return (...args: unknown[]) => {
          if (prop === "select") select = String(args[0] ?? "");
          return new Proxy(c, handler);
        };
      },
    };
    return new Proxy(c, handler);
  }
  return { supabase: { from: (t: string) => chain(t) } };
});
vi.mock("@/lib/notify/dispatch", () => ({
  emit: vi.fn(async (payload: Record<string, unknown>) => { state.emits.push(payload); }),
}));
vi.mock("@/lib/audit", () => ({
  logRevisionEvent: vi.fn(async (params: Record<string, unknown>) => { state.audits.push(params); }),
}));
import { getDocumentRecall, nudgeStaleHolders, type RecallHolder } from "@/lib/staleCopies";

beforeEach(() => {
  state.calls = [];
  state.emits = [];
  state.audits = [];
  state.respond = () => ({ data: [], error: null });
});

// ── 1. migration shape ───────────────────────────────────────────────────────
describe("20261068 — download_audits becomes an append-only, attributed record", () => {
  const m = read(MIGRATION);
  const code = stripSqlComments(m);

  it("captures the DEC-30 inventory BEFORE the transaction, aggregate counts only, and ends in ONE result set", () => {
    const temp = m.indexOf("CREATE TEMP TABLE dc_round_f_68_before AS");
    const begin = m.indexOf("\nBEGIN;");
    const commit = m.indexOf("\nCOMMIT;");
    expect(temp).toBeGreaterThan(0);
    expect(begin).toBeGreaterThan(temp);
    expect(commit).toBeGreaterThan(begin);
    const inv = m.slice(temp, begin);
    expect(inv).toMatch(/NULL org_id/);
    expect(inv).toMatch(/NULL user_id/);
    expect(inv).toMatch(/no document to backfill from/);
    expect(inv).toMatch(/not a member of the row org/);
    expect(inv).not.toMatch(/SELECT\s+(uid|user_id|user_email|id)\b/i); // never customer rows
    for (const s of inv.split("UNION ALL")) expect(s).toMatch(/COUNT\(\*\)/);
    const tail = m.slice(commit);
    expect(tail).toMatch(/AS check,/);
    expect(tail).toMatch(/AS ok,/);
    expect(tail).toMatch(/NULL::text AS n/);
    expect(tail).toMatch(/SELECT inventory, NULL, n FROM dc_round_f_68_before/);
    // probes read pg_policies DEPARSED — never a bare cast inside a LIKE pattern
    for (const like of tail.matchAll(/LIKE\s+'([^']*)'/g)) expect(like[1], like[0]).not.toMatch(/::/);
    expect(tail).toMatch(/with_check LIKE '%user_id = auth\.uid\(\)%'/);
    expect(tail).toMatch(/cmd IN \('UPDATE', 'DELETE', 'ALL'\)/);
  });

  it("adds source / share_id / transmittal_id as plain columns and lets user_id be NULL only behind the attribution CHECK", () => {
    expect(code).toMatch(/ALTER TABLE download_audits ADD COLUMN IF NOT EXISTS source TEXT;/);
    expect(code).toMatch(/ALTER TABLE download_audits ADD COLUMN IF NOT EXISTS share_id UUID;/);
    expect(code).toMatch(/ALTER TABLE download_audits ADD COLUMN IF NOT EXISTS transmittal_id UUID;/);
    expect(code).not.toMatch(/share_id UUID REFERENCES/);        // a record, not a live reference
    expect(code).not.toMatch(/transmittal_id UUID REFERENCES/);
    expect(code).toMatch(/ALTER TABLE download_audits ALTER COLUMN user_id DROP NOT NULL;/);
    expect(code).toMatch(/ADD CONSTRAINT download_audits_attributed\s+CHECK \(user_id IS NOT NULL OR share_id IS NOT NULL OR transmittal_id IS NOT NULL\)/);
  });

  it("backfills org_id from the document, then SET NOT NULL — or the NOT VALID fallback when rows have nowhere to backfill from", () => {
    expect(code).toMatch(/UPDATE download_audits a SET org_id = d\.org_id\s+FROM documents d\s+WHERE a\.org_id IS NULL AND a\.document_id = d\.id AND d\.org_id IS NOT NULL;/);
    const block = between(code, "DO $$", "$$;");
    expect(block).toMatch(/IF EXISTS \(SELECT 1 FROM download_audits WHERE org_id IS NULL\) THEN/);
    expect(block).toMatch(/ADD CONSTRAINT download_audits_org_id_present CHECK \(org_id IS NOT NULL\) NOT VALID;/);
    expect(block).toMatch(/ELSE\s+ALTER TABLE download_audits ALTER COLUMN org_id SET NOT NULL;/);
    // the backfill runs before the decision
    expect(code.indexOf("UPDATE download_audits a SET org_id")).toBeLessThan(code.indexOf("DO $$"));
  });

  it("drops the FOR ALL policy; SELECT is byte-carried from schema.sql; INSERT pins the caller's own row in their org; nothing else", () => {
    expect(code).toMatch(/DROP POLICY IF EXISTS "download_audits_org_access" ON download_audits;/);
    const schema = read("supabase/schema.sql");
    const old = between(schema, 'CREATE POLICY "download_audits_org_access" ON download_audits FOR ALL', ";");
    const oldUsing = old.slice(old.indexOf("USING")).trim();
    const sel = between(code, "CREATE POLICY download_audits_select ON download_audits FOR SELECT", ";");
    expect(sel.slice(sel.indexOf("USING")).trim()).toBe(oldUsing);
    expect(oldUsing).toBe("USING (org_id IN (SELECT my_org_ids()))");
    const ins = between(code, "CREATE POLICY download_audits_insert_own ON download_audits FOR INSERT", ";");
    expect(ins.replace(/\s+/g, " ")).toContain("WITH CHECK (org_id IN (SELECT my_org_ids()) AND user_id = auth.uid())");
    const policies = [...code.matchAll(/CREATE POLICY\s+"?(\w+)"?\s+ON\s+download_audits\s+FOR\s+(\w+)/g)].map((x) => `${x[1]}:${x[2]}`);
    expect(policies.sort()).toEqual(["download_audits_insert_own:INSERT", "download_audits_select:SELECT"]);
    expect(code).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i); // nothing SECURITY DEFINER to pin
    expect(code).not.toMatch(/CREATE\s+TRIGGER/i);
  });
});

// ── 2. the live policy census ────────────────────────────────────────────────
describe("policy census — the live download_audits policy set, replayed from schema.sql through every numbered migration", () => {
  function migrationFiles(): string[] {
    const dir = join(root, "supabase", "migrations");
    const files = readdirSync(dir).filter((f) => /^\d{8}/.test(f) && f.endsWith(".sql")).sort().map((f) => join(dir, f));
    return [join(root, "supabase", "schema.sql"), ...files];
  }
  const polRe = /CREATE\s+POLICY\s+"?(\w+)"?\s+ON\s+(?:public\.)?"?download_audits"?\s+(?:AS\s+\w+\s+)?FOR\s+(\w+)/gi;
  const dropRe = /DROP\s+POLICY\s+IF\s+EXISTS\s+"?(\w+)"?\s+ON\s+(?:public\.)?"?download_audits"?/gi;
  const doRe = /\bDO\s+(\$\w*\$)([\s\S]*?)\1\s*;/gi;

  it("is exactly {download_audits_insert_own: INSERT, download_audits_select: SELECT} — no UPDATE, DELETE or ALL survives", () => {
    const live = new Map<string, string>();
    let sawOriginal = false;
    for (const file of migrationFiles()) {
      const txt = stripSqlComments(readFileSync(file, "utf8"));
      // A DO block that creates policies dynamically (the 20260819 loop shape
      // DRLS-1 found) and names the table would add policies this static
      // replay cannot see — refuse to guess: fail loudly so the census is
      // extended, not silently wrong. (20261068's own DO block only decides
      // NOT NULL vs the NOT VALID fallback; it creates no policy.)
      for (const d of txt.matchAll(doRe)) {
        if (/EXECUTE\s+format|CREATE\s+POLICY/i.test(d[2])) expect(d[2], `${file}: a DO block creates policies and names download_audits`).not.toMatch(/download_audits/);
      }
      type Ev = { at: number; kind: "create" | "drop"; name: string; cmd?: string };
      const events: Ev[] = [];
      for (const m of txt.matchAll(polRe)) events.push({ at: m.index ?? 0, kind: "create", name: m[1], cmd: m[2].toUpperCase() });
      for (const m of txt.matchAll(dropRe)) events.push({ at: m.index ?? 0, kind: "drop", name: m[1] });
      events.sort((a, b) => a.at - b.at);
      for (const ev of events) {
        if (ev.kind === "create") { live.set(ev.name, ev.cmd!); if (ev.name === "download_audits_org_access") sawOriginal = true; }
        else live.delete(ev.name);
      }
    }
    expect(sawOriginal).toBe(true); // the census really saw the schema.sql policy before it was dropped
    expect(Object.fromEntries([...live.entries()].sort())).toEqual({
      download_audits_insert_own: "INSERT",
      download_audits_select: "SELECT",
    });
  });
});

// ── 3. the reader: new shape, legacy fallback, external copies, the gap ──────
const row = (over: Record<string, unknown>) => ({
  user_id: "u1", user_email: "u1@x.co", version_id: "v1", created_at: "2026-09-01T00:00:00Z",
  source: null, share_id: null, transmittal_id: null, ...over,
});

describe("getDocumentRecall (DIST-9 dw3, DIST-7 chain)", () => {
  it("asks for the attribution columns and flags copies that left through a share or the portal as EXTERNAL", async () => {
    state.respond = (table) => table === "download_audits"
      ? { data: [
          row({ user_id: "u1", version_id: "v2" }),
          row({ user_id: null, user_email: null, share_id: "sh-1", source: "share_link", version_id: "v1", created_at: "2026-09-03T00:00:00Z" }),
          row({ user_id: null, user_email: null, share_id: "sh-1", source: "share_link", version_id: "v1", created_at: "2026-09-02T00:00:00Z" }),
          row({ user_id: null, user_email: null, transmittal_id: "tx-9", source: "transmittal_portal", version_id: "v2" }),
        ], error: null }
      : { data: [{ id: "v1", revision_label: "3" }, { id: "v2", revision_label: "4" }], error: null };
    const r = await getDocumentRecall("d1", "v2");
    expect(r.unavailable).toBe(false);
    expect(state.calls[0].select).toMatch(/share_id/);
    expect(state.calls[0].select).toMatch(/transmittal_id/);
    expect(state.calls[0].select).toMatch(/source/);
    const byKey = Object.fromEntries(r.holders.map((h) => [h.userId, h]));
    expect(Object.keys(byKey).sort()).toEqual(["share:sh-1", "transmittal:tx-9", "u1"]);
    expect(byKey.u1.external).toBe(false);
    expect(byKey.u1.hasCurrent).toBe(true);
    expect(byKey["share:sh-1"]).toMatchObject({ external: true, source: "share_link", hasCurrent: false, lastDownloadedRev: "3", userEmail: null, lastDownloadedAt: "2026-09-03T00:00:00Z" });
    expect(byKey["transmittal:tx-9"]).toMatchObject({ external: true, source: "transmittal_portal", hasCurrent: true });
    // outdated first — the external stale copy leads
    expect(r.holders[0].userId).toBe("share:sh-1");
  });

  it("falls back to the legacy column list on a pre-migration database (unknown column), still not a gap", async () => {
    state.respond = (table, select) => {
      if (table !== "download_audits") return { data: [{ id: "v1", revision_label: "3" }], error: null };
      if (/share_id/.test(select)) return { data: null, error: { code: "42703", message: "column download_audits.share_id does not exist" } };
      return { data: [{ user_id: "u1", user_email: null, version_id: "v1", created_at: "2026-09-01T00:00:00Z" }], error: null };
    };
    const r = await getDocumentRecall("d1", "v2");
    expect(r.unavailable).toBe(false);
    expect(state.calls.filter((c) => c.table === "download_audits").map((c) => /share_id/.test(c.select))).toEqual([true, false]);
    expect(r.holders).toHaveLength(1);
    expect(r.holders[0]).toMatchObject({ userId: "u1", external: false, hasCurrent: false, lastDownloadedRev: "3" });
  });

  it("says UNAVAILABLE when the record cannot be read — never an empty, confident list", async () => {
    state.respond = (table) => table === "download_audits"
      ? { data: null, error: { code: "42501", message: "permission denied for table download_audits" } }
      : { data: [], error: null };
    const r = await getDocumentRecall("d1", "v2");
    expect(r).toEqual({ holders: [], capped: false, unavailable: true });
    state.respond = () => { throw new Error("network"); };
    expect(await getDocumentRecall("d1", "v2")).toEqual({ holders: [], capped: false, unavailable: true });
  });

  it("no current version → nothing to compare, and that is not a gap", async () => {
    expect(await getDocumentRecall("d1", null)).toEqual({ holders: [], capped: false, unavailable: false });
    expect(state.calls).toEqual([]);
  });
});

describe("nudgeStaleHolders reaches MEMBERS only and records the external copies it cannot reach", () => {
  const holder = (userId: string, hasCurrent: boolean, external = false): RecallHolder => ({
    userId, userEmail: external ? null : `${userId}@x.co`, lastDownloadedRev: "3",
    lastDownloadedAt: "2026-08-01T00:00:00Z", hasCurrent, external, source: external ? "share_link" : null,
  });

  it("the audience is the outdated members; the audit row counts the external copies left out", async () => {
    const n = await nudgeStaleHolders({
      orgId: "org1", documentId: "d1", docLabel: "P-101", currentRev: "5", currentVersionId: "v5",
      holders: [holder("u1", false), holder("share:sh-1", false, true), holder("u2", true), holder("transmittal:tx-1", false, true)],
      actorUserId: "ctrl", actorName: "doccontrol", source: "manual",
    });
    expect(n).toBe(1);
    expect(state.emits).toHaveLength(1);
    expect((state.emits[0] as { audience: { involved: string[] } }).audience.involved).toEqual(["u1"]);
    const details = state.audits[0].details as { recipients: Array<{ userId: string }>; recipientCount: number; externalCopies: number };
    expect(details.recipients.map((r) => r.userId)).toEqual(["u1"]);
    expect(details.recipientCount).toBe(1);
    expect(details.externalCopies).toBe(2);
  });

  it("only external copies outdated → nobody to notify: 0, no emit, no audit row", async () => {
    const n = await nudgeStaleHolders({
      orgId: "org1", documentId: "d1", docLabel: "P-101", currentRev: "5",
      holders: [holder("share:sh-1", false, true), holder("u2", true)], actorUserId: "ctrl",
    });
    expect(n).toBe(0);
    expect(state.emits).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });
});

// ── 4. the panel renders the gap and nudges members only ─────────────────────
describe("DistributionRecall renders the record's gaps instead of a green badge", () => {
  const src = read("components/documents/DistributionRecall.tsx");
  it("an unreadable record is shown as a gap, not hidden", () => {
    expect(src).toMatch(/setUnavailable\(recall\.unavailable\)/);
    expect(src).toMatch(/if \(holders\.length === 0 && !unavailable\) return null;/);
    expect(src).toMatch(/Distribution record unavailable/);
  });
  it("external copies are labelled and excluded from the nudge and the close-out rows", () => {
    expect(src).toMatch(/const reachable = outdated\.filter\(\(h\) => !h\.external\);/);
    expect(src).toMatch(/recipients: reachable\.map/);
    expect(src).toMatch(/externalOutdated/);
    expect(src).toMatch(/via share link|via transmittal/);
  });
});
