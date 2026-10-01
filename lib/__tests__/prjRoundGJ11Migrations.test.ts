// projects Round G — J11 PROJECTS RESIDUALS: the shape of 20261141 (SEC-19:
// the intake token stored as its SHA-256; INTK-16: adoption's number rule in
// the database) and 20261142 (SEC-20: project audit rows follow the
// project's visibility), and the lib half of SEC-19 (lib/intakeLinks.ts).
//
// There is no live database here: the migrations are read as text — the
// one-paste protocol (DEC-30), the grants (DRLS-16), the pinned search_path
// and the byte-fidelity of every re-created object against its NEWEST
// definition (lineDiff). Both files were also run end to end on a scratch
// PostgreSQL 16 cluster with a Supabase-shaped stub (the records name the
// cases); the node:crypto sha256 below is the value that run compared.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  readIntakeLinkByToken, linkCredentialView, isMissingColumnError, firstReadWithColumns,
  reissueIntakeLink, newIntakeToken, intakePortalPath, INTAKE_TOKEN_RE,
} from "@/lib/intakeLinks";

const root = process.cwd();
const mig = (f: string) => readFileSync(join(root, "supabase", "migrations", f), "utf8");
const src = (f: string) => readFileSync(join(root, f), "utf8");
const M141 = mig("20261141_prj_roundG_intake_token_hash_and_adoption.sql");
const M142 = mig("20261142_prj_roundG_project_audit_rows.sql");
const M063 = mig("20261063_rp_roundE_audit_view_capability.sql");
const M105 = mig("20261105_prj_roundG_intake_review_and_attempts.sql");

function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  expect(a, `missing: ${from}`).toBeGreaterThanOrEqual(0);
  const b = text.indexOf(to, a + from.length);
  expect(b, `missing after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(a, b + to.length);
}
function lineDiff(a: string, b: string) {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}
const code = (sql: string) => sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");

describe("the one-paste protocol (DEC-30) — both files", () => {
  for (const [name, sql, temp] of [["20261141", M141, "prj_g_j11a_inventory"], ["20261142", M142, "prj_g_j11b_inventory"]] as const) {
    it(`${name}: the inventory is a TEMP table of counts captured BEFORE the one transaction, and ONE final SELECT (check, ok, n) closes the file`, () => {
      const c = code(sql);
      const temp_ = c.indexOf(`CREATE TEMP TABLE ${temp} AS`);
      const begin = c.indexOf("\nBEGIN;");
      const commit = c.indexOf("\nCOMMIT;");
      expect(temp_).toBeGreaterThan(0);
      expect(temp_).toBeLessThan(begin);
      expect(begin).toBeLessThan(commit);
      expect(c.match(/\nBEGIN;/g)).toHaveLength(1);
      expect(c.match(/\nCOMMIT;/g)).toHaveLength(1);
      const tail = c.slice(commit);
      expect(tail).toMatch(/SELECT '[^']+' AS check,\s*\n\s*\([\s\S]*?\) AS ok,\s*\n\s*NULL::text AS n/);
      // nothing after the final SELECT but its UNION ALL rows
      expect(tail.trimEnd().endsWith(";")).toBe(true);
      expect(tail.match(/;\s*$/gm)).toHaveLength(2); // "COMMIT;" and the one SELECT's end
      // counts only, never rows: every inventory row is a COUNT
      const inv = between(c, `CREATE TEMP TABLE ${temp} AS`, "\nBEGIN;");
      expect(inv.match(/AS n|::text/g)?.length).toBeGreaterThan(0);
      for (const sel of inv.split(/UNION ALL/)) expect(sel, sel).toMatch(/COUNT\(/);
      expect(tail).toMatch(new RegExp(`SELECT inventory, NULL::boolean, n FROM ${temp}`));
    });
  }
});

describe("20261141 — SEC-19: the intake token stored as its SHA-256", () => {
  const c = code(M141);
  it("adds token_hash / token_prefix, frees the plain column and hashes every existing link IN PLACE before the trigger exists", () => {
    expect(c).toContain("ALTER TABLE project_intake_links ADD COLUMN IF NOT EXISTS token_hash TEXT;");
    expect(c).toContain("ALTER TABLE project_intake_links ADD COLUMN IF NOT EXISTS token_prefix TEXT;");
    expect(c).toContain("ALTER TABLE project_intake_links ALTER COLUMN token DROP NOT NULL;");
    const backfill = c.indexOf("SET token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex'),");
    expect(backfill).toBeGreaterThan(0);
    expect(backfill).toBeLessThan(c.indexOf("CREATE TRIGGER trg_project_intake_links_hash_token"));
    expect(c).toMatch(/token_prefix = left\(token, 6\),\s*\n\s*token = NULL\s*\n\s*WHERE token IS NOT NULL;/);
  });
  it("the trigger hashes any written token and nulls it; a direct hash write on an existing link is refused", () => {
    const fn = between(c, "CREATE OR REPLACE FUNCTION project_intake_links_hash_token()", "$$;");
    expect(fn).toMatch(/LANGUAGE plpgsql SET search_path = public/);
    expect(fn).not.toMatch(/SECURITY DEFINER/);
    expect(fn).toContain("NEW.token_hash := encode(sha256(convert_to(NEW.token, 'UTF8')), 'hex');");
    expect(fn).toContain("NEW.token_prefix := left(NEW.token, 6);");
    expect(fn).toContain("NEW.token := NULL;");
    expect(fn).toMatch(/ELSIF TG_OP = 'UPDATE'\s*\n\s*AND \(NEW\.token_hash IS DISTINCT FROM OLD\.token_hash OR NEW\.token_prefix IS DISTINCT FROM OLD\.token_prefix\) THEN\s*\n\s*RAISE EXCEPTION/);
    expect(c).toMatch(/CREATE TRIGGER trg_project_intake_links_hash_token\s*\n\s*BEFORE INSERT OR UPDATE ON project_intake_links\s*\n\s*FOR EACH ROW EXECUTE FUNCTION project_intake_links_hash_token\(\);/);
  });
  it("the database holds no usable token (CHECK), and the hash is the unique lookup key", () => {
    expect(c).toContain("ADD CONSTRAINT project_intake_links_no_plain_token CHECK (token IS NULL);");
    expect(c).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS project_intake_links_token_hash_key\s*\n\s*ON project_intake_links \(token_hash\) WHERE token_hash IS NOT NULL;/);
  });
  it("the database's hash is the routes' hash: the probe's fixed vector is node:crypto's sha256 hex", () => {
    const vector = /encode\(sha256\(convert_to\('abc', 'UTF8'\)\), 'hex'\) = '([0-9a-f]{64})'/.exec(M141)?.[1];
    expect(vector).toBe(createHash("sha256").update("abc").digest("hex"));
  });
  it("20261104's TTL CHECK, budget columns and bump_intake_use grants are not touched", () => {
    expect(c).not.toMatch(/project_intake_links_ttl|max_submissions|bump_intake_use/);
  });
});

describe("20261141 — INTK-16: adoption's number rule in the database", () => {
  const c = code(M141);
  const guard = between(c, "CREATE OR REPLACE FUNCTION documents_intake_adoption_guard()", "\n$$;");
  const adopt = between(c, "CREATE OR REPLACE FUNCTION adopt_intake_document(", "\n$$;");
  it("the guard: SECURITY DEFINER, search_path pinned, the service pass exempt, intake-born documents only, on a library / folder / number change", () => {
    expect(guard).toMatch(/LANGUAGE plpgsql SECURITY DEFINER SET search_path = public/);
    expect(guard).toContain("IF v_uid IS NULL THEN RETURN NEW; END IF;");
    expect(guard).toContain("IF NEW.authored_by_link_id IS NULL THEN RETURN NEW; END IF;");
    expect(c).toMatch(/CREATE TRIGGER trg_documents_intake_adoption_guard\s*\n\s*BEFORE UPDATE OF library_id, collection_id, document_number ON documents/);
  });
  it("the SAF-12 rule (DEC-56 item 6): a live same number outside the sheet's folder blocks — anywhere when the number is the destination's key, in ANOTHER library when it is a multi-part library", () => {
    expect(guard).toMatch(/l\.uniqueness_keys IS NULL OR cardinality\(l\.uniqueness_keys\) = 0\s*\n\s*OR l\.uniqueness_keys = ARRAY\['documentNumber'\]::text\[\]/);
    expect(guard).toContain("AND lower(btrim(d.document_number)) = lower(btrim(NEW.document_number))");
    expect(guard).toContain("AND d.status NOT IN ('Archived', 'Superseded')");
    expect(guard).toContain("AND d.collection_id IS DISTINCT FROM OLD.collection_id");
    expect(guard).toContain("AND (v_decides OR d.library_id IS DISTINCT FROM NEW.library_id)");
    expect(guard).toMatch(/USING ERRCODE = 'check_violation'/);
  });
  it("adopt_intake_document: refuses a NULL uid (DRLS-16), controller-only, approved and not in review, destination in the org, writes the move and its audit row", () => {
    expect(adopt).toMatch(/RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public/);
    expect(adopt).toMatch(/IF v_uid IS NULL THEN\s*\n\s*RAISE EXCEPTION/);
    expect(adopt).toContain("IF NOT is_org_controller(v_doc.org_id) THEN");
    expect(adopt).toContain("IF v_doc.current_version_id IS NULL OR v_doc.pending_version_id IS NOT NULL THEN");
    expect(adopt).toContain("IF NOT FOUND OR v_lib_org IS DISTINCT FROM v_doc.org_id THEN");
    expect(adopt).toContain("IF NOT FOUND OR v_col.org_id IS DISTINCT FROM v_doc.org_id OR v_col.library_id IS DISTINCT FROM p_library THEN");
    expect(adopt).toMatch(/UPDATE documents\s*\n\s*SET library_id = p_library,/);
    expect(adopt).toMatch(/INSERT INTO audit_logs \(action, resource_type, resource_id, org_id, user_id, user_email, details\)\s*\n\s*VALUES \('TRANSITION_IN', 'document', p_doc::text/);
    // the server's before / after override anything the caller sent
    expect(adopt).toMatch(/COALESCE\(p_details, '\{\}'::jsonb\) \|\| jsonb_build_object\(\s*\n\s*'before'/);
  });
  it("the key is lib/uniqueness.ts's rule, byte-faithful to 20261105's backfill expression (only the number source and the row alias differ)", () => {
    const back = between(M105, "(SELECT CASE WHEN bool_or(p.v = '') THEN NULL ELSE string_agg(p.v, '::' ORDER BY p.ord) END", "WITH ORDINALITY AS k(key, ord)) p)");
    const mine = between(adopt, "SELECT CASE WHEN bool_or(p.v = '') THEN NULL ELSE string_agg(p.v, '::' ORDER BY p.ord) END", "WITH ORDINALITY AS k(key, ord)) p;");
    const norm = (s: string) => s.split("\n").map((l) => l.trim()).filter((l) => l && l !== "INTO v_key")
      .map((l) => l.replace(/^\(SELECT CASE/, "SELECT CASE").replace(/\) p\)$/, ") p").replace(/\) p;$/, ") p"));
    const { onlyInA, onlyInB } = lineDiff(norm(back).join("\n"), norm(mine).join("\n"));
    expect(onlyInA).toEqual([
      "WHEN 'documentNumber' THEN d.document_number",
      "WHEN 'title' THEN d.title",
      "WHEN 'rev' THEN d.rev",
      "WHEN 'status' THEN d.status",
      "ELSE d.metadata->>k.key",
      "FROM unnest(CASE WHEN l.uniqueness_keys IS NULL OR cardinality(l.uniqueness_keys) = 0",
      "THEN ARRAY['documentNumber']::text[] ELSE l.uniqueness_keys END)",
    ]);
    expect(onlyInB).toEqual([
      "WHEN 'documentNumber' THEN v_number",
      "WHEN 'title' THEN v_doc.title",
      "WHEN 'rev' THEN v_doc.rev",
      "WHEN 'status' THEN v_doc.status",
      "ELSE v_doc.metadata->>k.key",
      "FROM unnest(CASE WHEN v_keys IS NULL OR cardinality(v_keys) = 0",
      "THEN ARRAY['documentNumber']::text[] ELSE v_keys END)",
    ]);
  });
  it("grants (DRLS-16): adopt_intake_document to authenticated only; no new function is anon's", () => {
    expect(c).toContain("REVOKE ALL ON FUNCTION adopt_intake_document(uuid, uuid, uuid, text, jsonb) FROM PUBLIC;");
    expect(c).toContain("REVOKE ALL ON FUNCTION adopt_intake_document(uuid, uuid, uuid, text, jsonb) FROM anon;");
    expect(c).toContain("GRANT EXECUTE ON FUNCTION adopt_intake_document(uuid, uuid, uuid, text, jsonb) TO authenticated;");
    for (const fn of ["documents_intake_adoption_guard()", "project_intake_links_hash_token()"]) {
      expect(c).toContain(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC;`);
      expect(c).toContain(`REVOKE ALL ON FUNCTION ${fn} FROM anon;`);
    }
  });
  it("stops with a sentence on a database without 20261104", () => {
    expect(c.indexOf("RAISE EXCEPTION 'Apply 20261104_prj_roundG_intake_links.sql")).toBeLessThan(c.indexOf("CREATE TEMP TABLE"));
  });
});

describe("20261142 — SEC-20: audit_logs_admin_trail re-created from its NEWEST definition (20261063) + ONE clause", () => {
  const live = between(M063, "DROP POLICY IF EXISTS audit_logs_admin_trail ON audit_logs;", "\n  );");
  const next = between(M142, "DROP POLICY IF EXISTS audit_logs_admin_trail ON audit_logs;", "\n  );");
  it("no other migration re-creates the overlay after 20261063 (this file builds on the newest)", () => {
    const files = readdirSync(join(root, "supabase", "migrations")).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
    const definers = files.filter((f) => /CREATE POLICY audit_logs_admin_trail/.test(mig(f)));
    expect(definers).toEqual([
      "20261045_rp_phase6_admin_gates_team_fk_reviewer_independence.sql",
      "20261063_rp_roundE_audit_view_capability.sql",
      "20261142_prj_roundG_project_audit_rows.sql",
    ]);
  });
  it("lineDiff: nothing of 20261063's body is lost; only the comment and the project clause are added", () => {
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect(onlyInA).toEqual([]);
    expect(onlyInB.filter((l) => !/^\s*--/.test(l))).toEqual(["    AND audit_row_project_visible(resource_type, resource_id)"]);
    expect(onlyInB.filter((l) => /^\s*--/.test(l)).length).toBeGreaterThan(0);
  });
  it("still RESTRICTIVE SELECT, still no TO clause, and the INSERT policy and the base member policy are untouched", () => {
    expect(next).toMatch(/AS RESTRICTIVE FOR SELECT\s*\n\s*USING \(/);
    expect(next).not.toMatch(/\bTO\b\s+(anon|authenticated|public)/i);
    expect(code(M142)).not.toMatch(/audit_logs_insert|audit_logs_org_access/);
  });
  it("audit_row_project_visible: SECURITY INVOKER (reads only what the caller may read), search_path pinned, project rows by project_visible_to_me, cost rows through every 'cost' writer's table", () => {
    const fn = between(code(M142), "CREATE OR REPLACE FUNCTION audit_row_project_visible(p_type text, p_resource text)", "\n$$;");
    expect(fn).toMatch(/RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS \$\$/);
    expect(fn).not.toMatch(/SECURITY DEFINER/);
    expect(fn).toContain("WHEN p_type IS DISTINCT FROM 'project' AND p_type IS DISTINCT FROM 'cost' THEN true");
    expect(fn).toContain("WHEN p_type = 'project' THEN project_visible_to_me(p_resource::uuid)");
    for (const t of ["cost_documents", "cost_entries", "cost_accounts", "project_parties"]) {
      expect(fn).toContain(`EXISTS (SELECT 1 FROM ${t} c WHERE c.id = p_resource::uuid AND project_visible_to_me(c.project_id))`);
    }
    // a non-UUID id is answered false, never a cast error inside a policy
    expect(fn.indexOf("p_resource !~*")).toBeLessThan(fn.indexOf("p_resource::uuid"));
  });
  it("every 'cost' audit writer names a row of those four tables (the vocabulary the function covers)", () => {
    const writers = ["lib/costs.ts", "lib/costDocs.ts", "app/api/projects/cost-docs/route.ts", "app/api/intake/upload/route.ts", "components/projects/cost/QuotesPanel.tsx"];
    for (const f of writers) expect(src(f), f).toMatch(/resource_type: "cost"/);
    expect(src("lib/costs.ts")).toMatch(/COST_ACCOUNT_CREATED|COST_PARTY_CREATED|COST_ENTRY_POSTED/);
  });
});

// ── the lib half of SEC-19 ─────────────────────────────────────────────────
type Res = { data: unknown; error: { message: string; code?: string } | null };
function fakeClient(answers: (q: { table: string; filters: Array<[string, unknown]>; op: string; payload?: unknown }) => Res) {
  const calls: Array<{ table: string; filters: Array<[string, unknown]>; op: string; payload?: unknown }> = [];
  const client = {
    from(table: string) {
      const q = { table, filters: [] as Array<[string, unknown]>, op: "select", payload: undefined as unknown };
      const chain: Record<string, unknown> = {};
      const self = new Proxy(chain, {
        get(_t, prop: string) {
          if (prop === "then") return (resolve: (v: unknown) => void) => { calls.push(q); resolve(answers(q)); };
          return (...args: unknown[]) => {
            if (prop === "eq" || prop === "is") q.filters.push([String(args[0]), args[1]]);
            if (prop === "update" || prop === "insert") { q.op = prop; q.payload = args[0]; }
            if (prop === "maybeSingle") { calls.push(q); return Promise.resolve(answers(q)); }
            return self;
          };
        },
      });
      return self;
    },
  };
  return { client: client as unknown as Parameters<typeof readIntakeLinkByToken>[0], calls };
}

describe("lib/intakeLinks — SEC-19", () => {
  const TOKEN = "t".repeat(40);
  const HASH = createHash("sha256").update(TOKEN).digest("hex");

  it("readIntakeLinkByToken looks a link up by the token's hash — never by the token — once 20261141 is live", async () => {
    const { client, calls } = fakeClient(() => ({ data: { id: "l1" }, error: null }));
    const r = await readIntakeLinkByToken(client, { token: TOKEN, tokenHash: HASH, columns: "id" });
    expect(r).toEqual({ data: { id: "l1" }, error: null });
    expect(calls.map((c) => c.filters)).toEqual([[["token_hash", HASH]]]);
  });
  it("before 20261141 (no token_hash column) it reads the plain column; any other error is returned, never retried", async () => {
    const pre = fakeClient((q) => (q.filters[0][0] === "token_hash"
      ? { data: null, error: { message: "column project_intake_links.token_hash does not exist", code: "42703" } }
      : { data: { id: "l1" }, error: null }));
    expect(await readIntakeLinkByToken(pre.client, { token: TOKEN, tokenHash: HASH, columns: "id" })).toEqual({ data: { id: "l1" }, error: null });
    expect(pre.calls.map((c) => c.filters)).toEqual([[["token_hash", HASH]], [["token", TOKEN]]]);
    const down = fakeClient(() => ({ data: null, error: { message: "timeout", code: "57014" } }));
    expect((await readIntakeLinkByToken(down.client, { token: TOKEN, tokenHash: HASH, columns: "id" })).error?.code).toBe("57014");
    expect(down.calls).toHaveLength(1);
  });
  it("both public routes find the link through it, with the hash the rate window keys on", () => {
    const up = src("app/api/intake/upload/route.ts");
    const res = src("app/api/intake/resolve/route.ts");
    expect(up).toMatch(/readIntakeLinkByToken\(supabaseAdmin, \{\s*\n\s*token, tokenHash,/);
    expect(res).toMatch(/readIntakeLinkByToken\(supabaseAdmin, \{\s*\n\s*token, tokenHash: sha256Hex\(token\),/);
    for (const s of [up, res]) expect(s).not.toMatch(/\.eq\("token", token\)/);
  });
  it("the lists show a prefix, never read the token back once it is hashed; the plain column only before 20261141", () => {
    expect(linkCredentialView({ token: null, token_prefix: "abc123" })).toEqual({ token: null, prefix: "abc123" });
    expect(linkCredentialView({ token: "abcdefghijkl" })).toEqual({ token: "abcdefghijkl", prefix: "abcdef" });
    expect(linkCredentialView({})).toEqual({ token: null, prefix: null });
    for (const f of ["components/projects/IntakePanel.tsx", "components/projects/cost/QuotesPanel.tsx"]) {
      const s = src(f);
      expect(s, f).toMatch(/firstReadWithColumns</);
      expect(s, f).toMatch(/"token_prefix" \| "token"/);
      expect(s, f).not.toMatch(/token: String\(r\.token\)/);
      expect(s, f).toMatch(/const token = newIntakeToken\(\);/);
      expect(s, f).toMatch(/setFreshUrls\(\(prev\) => new Map\(prev\)\.set\(/);
      expect(s, f).toMatch(/reissueIntakeLink\(\{/);
    }
  });
  it("firstReadWithColumns moves on only for a missing column", async () => {
    const seen: string[] = [];
    const r = await firstReadWithColumns([
      async () => { seen.push("a"); return { data: null, error: { message: "column x.token_prefix does not exist", code: "42703" } }; },
      async () => { seen.push("b"); return { data: [1], error: null }; },
      async () => { seen.push("c"); return { data: [2], error: null }; },
    ]);
    expect(r.data).toEqual([1]);
    expect(seen).toEqual(["a", "b"]);
    const denied = await firstReadWithColumns([async () => ({ data: null, error: { message: "permission denied", code: "42501" } }), async () => ({ data: [1], error: null })]);
    expect(denied.error?.code).toBe("42501");
    expect(isMissingColumnError({ message: "Could not find the 'token_prefix' column", code: "PGRST204" }, "token_prefix")).toBe(true);
    expect(isMissingColumnError({ message: "column purpose does not exist", code: "42703" }, "token_prefix")).toBe(false);
  });
  it("re-issue writes a NEW token on the live link only, refuses zero rows, and audits the link — never token material", async () => {
    const ok = fakeClient((q) => (q.op === "update" ? { data: [{ id: "l1" }], error: null } : { data: null, error: null }));
    const r = await reissueIntakeLink({ linkId: "l1", orgId: "o1", projectId: "p1", company: "Acme", actorId: "u1", actorEmail: "u1@x", client: ok.client });
    expect(r.ok).toBe(true);
    const upd = ok.calls.find((c) => c.op === "update")!;
    expect(upd.filters).toEqual([["id", "l1"], ["revoked_at", null]]);
    const newToken = (upd.payload as { token: string }).token;
    expect(newToken).toMatch(INTAKE_TOKEN_RE);
    expect(r.ok && r.token).toBe(newToken);
    const audit = ok.calls.find((c) => c.op === "insert")!;
    expect(audit.payload).toMatchObject({ action: "INTAKE_LINK_REISSUED", resource_type: "project_intake_link", resource_id: "l1" });
    expect(JSON.stringify(audit.payload)).not.toContain(newToken);
    expect(JSON.stringify(audit.payload)).not.toMatch(/token/i);
    const none = fakeClient((q) => (q.op === "update" ? { data: [], error: null } : { data: null, error: null }));
    const refused = await reissueIntakeLink({ linkId: "l1", orgId: "o1", projectId: "p1", company: "Acme", actorId: "u1", client: none.client });
    expect(refused).toEqual({ ok: false, error: expect.stringMatching(/was not re-issued/) });
    expect(none.calls.some((c) => c.op === "insert")).toBe(false);
  });
  it("a fresh token is 40 url-safe characters the door accepts; the portal path is /submit/<token>", () => {
    const t = newIntakeToken();
    expect(t).toHaveLength(40);
    expect(t).toMatch(INTAKE_TOKEN_RE);
    expect(newIntakeToken()).not.toBe(t);
    expect(intakePortalPath("abc")).toBe("/submit/abc");
  });
  it("DEC-45: the export redacts the hash and its prefix with the token (a restored hash would revive the link)", async () => {
    const { REDACT_COLUMNS } = await import("@/lib/exportTables");
    expect(REDACT_COLUMNS.project_intake_links.columns).toEqual(["token", "token_hash", "token_prefix"]);
  });
});

// ── INTK-15: the PUT the door signs, on the REAL presigner ─────────────────
describe("INTK-15 — the direct door's presigned PUT binds the declared size", () => {
  it("with the route's options the signature covers content-length (and the fixed content-type): storage refuses a body of any other size", async () => {
    const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    const client = new S3Client({
      region: "auto", endpoint: "https://acct.r2.cloudflarestorage.com",
      credentials: { accessKeyId: "AK", secretAccessKey: "SK" }, requestChecksumCalculation: "WHEN_REQUIRED",
    });
    const url = new URL(await getSignedUrl(client, new PutObjectCommand({
      Bucket: "b", Key: "orgs/o1/project-intake/p1/staging/l1/00000000-0000-4000-8000-000000000000",
      ContentLength: 1234, ContentType: "application/octet-stream",
    }), { expiresIn: 600, signableHeaders: new Set(["content-length", "content-type"]) }));
    expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";").sort()).toEqual(["content-length", "content-type", "host"]);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    // the route passes exactly these options
    const route = src("app/api/intake/upload/route.ts");
    expect(route).toContain('Bucket: R2_BUCKET, Key: uploadKey, ContentLength: size, ContentType: "application/octet-stream",');
    expect(route).toContain('{ expiresIn: 600, signableHeaders: new Set(["content-length", "content-type"]) }');
    expect(route).toContain("const DIRECT_PUT_SECONDS = 600;");
  });
});
