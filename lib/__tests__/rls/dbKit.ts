// What a database suite uses (intelligence I-17): the replayed database, and
// a caller that is exactly what PostgREST makes of a request — the role
// (`anon`, `authenticated`, `service_role`) and the JWT claims in
// request.jwt.claims — so row-level security judges the statement as it
// judges that person's request.

import { randomUUID } from "node:crypto";
import { inject } from "vitest";
import { adminSql, dollarQuote, runPsql, type PgConn } from "./pgHarness";
import type { MosDbContext } from "./globalSetup";

export function mosDb(): MosDbContext {
  return inject("mosDb");
}

/** The skip reason, or null when the database is up. Use with describe.skipIf. */
export function skipReason(): string | null {
  return mosDb().skip;
}

export interface Caller {
  role: "anon" | "authenticated" | "service_role";
  uid?: string;
  email?: string;
}

export type Outcome =
  | { ok: true; rows: number }
  | { ok: false; code: string; message: string };

function claims(c: Caller): string {
  const o: Record<string, string> = { role: c.role };
  if (c.uid) o.sub = c.uid;
  if (c.email) o.email = c.email;
  return JSON.stringify(o);
}

/**
 * Runs one statement as the caller and reports what PostgreSQL decided:
 * the rows it touched, or the SQLSTATE that refused it. A refused statement
 * leaves nothing behind (it runs in a subtransaction).
 */
export function asCaller(db: string, c: Caller, statement: string): Outcome {
  const { conn } = mosDb();
  if (!conn) throw new Error("database not started");
  const sql = [
    `SET ROLE ${c.role};`,
    `SELECT set_config('request.jwt.claims', ${dollarQuote(claims(c))}, false);`,
    `SELECT harness.try_sql(${dollarQuote(statement)});`,
  ].join("\n");
  const r = runPsql(conn, db, conn.superuser, { sql });
  if (!r.ok) throw new Error(`harness call failed: ${r.error ?? r.stderr}`);
  const last = r.stdout.split("\n").pop() ?? "";
  const ok = /^ok:(\d+)$/.exec(last);
  if (ok) return { ok: true, rows: Number(ok[1]) };
  const err = /^err:([0-9A-Z]{5}):([\s\S]*)$/.exec(last);
  if (err) return { ok: false, code: err[1], message: err[2] };
  throw new Error(`unexpected harness answer: ${last}`);
}

/** A query as the caller, returning its rows as text (one line per row, `|`-separated). */
export function selectAs(db: string, c: Caller, query: string): string[] {
  const { conn } = mosDb();
  if (!conn) throw new Error("database not started");
  const sql = [
    `SET ROLE ${c.role};`,
    `SELECT set_config('request.jwt.claims', ${dollarQuote(claims(c))}, false);`,
    query,
  ].join("\n");
  const r = runPsql(conn, db, conn.superuser, { sql });
  if (!r.ok) throw new Error(`query as ${c.role} failed: ${r.error ?? r.stderr}`);
  const lines = r.stdout.split("\n");
  // the first line is set_config's echo
  return lines.slice(1).filter((l) => l.length > 0);
}

/** SQL as the cluster superuser (seeding, catalog reads). Throws on error. */
export function admin(db: string, sql: string): string {
  const { conn } = mosDb();
  if (!conn) throw new Error("database not started");
  return adminSql(conn as PgConn, db, sql);
}

export interface SeededMember {
  uid: string;
  email: string;
  caller: Caller;
}

/** A fresh workspace with one active member per role list given. */
export function seedOrg(db: string, members: Record<string, { role: string; roles?: string[] }>): { orgId: string; m: Record<string, SeededMember> } {
  const orgId = randomUUID();
  const m: Record<string, SeededMember> = {};
  const stmts: string[] = [`INSERT INTO orgs (id, name, type) VALUES ('${orgId}', 'Harness ${orgId.slice(0, 8)}', 'business');`];
  for (const [key, spec] of Object.entries(members)) {
    const uid = randomUUID();
    const email = `${key.toLowerCase()}-${uid.slice(0, 8)}@harness.test`;
    const roles = spec.roles ?? [];
    stmts.push(
      `INSERT INTO auth.users (id, email, aud, role) VALUES ('${uid}', '${email}', 'authenticated', 'authenticated');`,
      `INSERT INTO users (id, email, display_name, default_org_id) VALUES ('${uid}', '${email}', '${key}', '${orgId}');`,
      `INSERT INTO org_members (org_id, uid, email, role, roles, status) VALUES ('${orgId}', '${uid}', '${email}', '${spec.role}', ARRAY[${roles.map((r) => `'${r}'`).join(",")}]::text[], 'active');`,
    );
    m[key] = { uid, email, caller: { role: "authenticated", uid, email } };
  }
  admin(db, stmts.join("\n"));
  return { orgId, m };
}
