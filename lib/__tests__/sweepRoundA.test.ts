// Phase 6 severity sweep, Round A (no migration): OWN-7, SURF-8, DEL-2
// residual, DOCACL-2. Pure helpers are unit-tested; client/server modules
// whose import graph reaches a Supabase client are pinned at the source.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isImmutableTable, isSkippedTable, restoredMemberRole, skipReasonFor, planRestore, IMMUTABLE_TABLES } from "@/lib/dataRestore";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/__tests__/.test(p)) out.push(p);
  }
  return out;
}

describe("OWN-7 — every save-time acl_index build honours rule expiry", () => {
  it("no production call to buildAclIndex / buildAclIndexFromChain omits the nowMs argument", () => {
    const files = [...walk(join(process.cwd(), "app")), ...walk(join(process.cwd(), "components")), ...walk(join(process.cwd(), "lib"))]
      .filter((p) => !p.endsWith("/lib/acl.ts"));
    const offenders: string[] = [];
    for (const p of files) {
      const s = readFileSync(p, "utf8");
      const re = /buildAclIndex(?:FromChain)?\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s))) {
        // Walk to the balanced close of THIS call, then count top-level commas.
        let depth = 1, i = m.index + m[0].length, commas = 0;
        for (; i < s.length && depth > 0; i++) {
          const ch = s[i];
          if (ch === "(" || ch === "[" || ch === "{") depth++;
          else if (ch === ")" || ch === "]" || ch === "}") depth--;
          else if (ch === "," && depth === 1) commas++;
        }
        if (commas === 0) offenders.push(`${p.replace(process.cwd() + "/", "")}: ${s.slice(m.index, i).replace(/\s+/g, " ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("SURF-8 — restore refuses immutable tables, audits chunks, mints no role", () => {
  it("append-only / self-insert-only tables are immutable, skipped, and carry a reason", () => {
    for (const t of ["e_signatures", "audit_logs", "drawing_audit_logs", "document_acknowledgments", "distribution_acks", "document_review_signoffs", "org_configurations"]) {
      expect(isImmutableTable(t), t).toBe(true);
      expect(isSkippedTable(t), t).toBe(true);
      expect(skipReasonFor(t)).toBe(IMMUTABLE_TABLES[t]);
    }
    expect(isImmutableTable("documents")).toBe(false);
    expect(isSkippedTable("org_members")).toBe(true); // the reconciled set is untouched
  });

  it("planRestore never plans an immutable table in (no rows counted, a reason shown)", () => {
    const plan = planRestore(
      { manifest: { orgId: "org-b" }, tables: { e_signatures: [{ id: "s1" }], documents: [{ id: "d1" }] } },
      { orgId: "org-a", orgName: "A", members: [] },
    );
    const sig = plan.counts.tables.find((t) => t.name === "e_signatures");
    expect(sig?.willImport).toBe(false);
    expect(sig?.reason).toBe(IMMUTABLE_TABLES.e_signatures);
    expect(plan.counts.tables.find((t) => t.name === "documents")?.willImport).toBe(true);
    expect(plan.counts.totalRows).toBe(1);
  });

  it("a restored placeholder never carries a privileged role the operator did not choose", () => {
    for (const r of ["Admin", "DocCtrl", "Manager", "Supervisor", "DraftingSupervisor", "", undefined, null]) expect(restoredMemberRole(r)).toBe("Viewer");
    expect(restoredMemberRole("Engineer-1")).toBe("Engineer-1");
    expect(restoredMemberRole("Requester")).toBe("Requester");
    for (const f of ["app/api/admin/restore/begin/route.ts", "app/api/admin/restore/apply/route.ts"]) {
      const s = src(f);
      expect(s).toMatch(/role: restoredMemberRole\(u\.role\), roles: \[restoredMemberRole\(u\.role\)\]/);
      expect(s).not.toMatch(/role: u\.role \|\| "Viewer"/);
    }
  });

  it("apply-table refuses immutable tables before writing and audits every chunk as a checked write", () => {
    const s = src("app/api/admin/restore/apply-table/route.ts");
    expect(s.indexOf("if (isImmutableTable(table))")).toBeGreaterThan(0);
    expect(s.indexOf("if (isImmutableTable(table))")).toBeLessThan(s.indexOf("for (let i = 0; i < mapped.length; i += 500)"));
    expect(s).toMatch(/action: "RESTORE_CHUNK", resource_type: "org", resource_id: orgId, org_id: orgId/);
    expect(s).toMatch(/rowsReceived: rows\.length, rowsAfterFilters: mapped\.length, inserted/);
    expect(s).toMatch(/if \(auditErr\) \{/);
    expect(src("app/(protected)/admin/restore/page.tsx")).toMatch(/manifest: \{ orgId: envelope\.manifest\.orgId, orgName: envelope\.manifest\.orgName \}/);
  });
});

describe("DEL-2 residual — the ownership cascade carries read access everywhere the DB applies it", () => {
  it("knowledge access resolves document → folder lineage → library → team supervisor and short-circuits for the owner", () => {
    const k = src("lib/knowledgeAccess.ts");
    expect(k).toMatch(/export function effectiveOwnerFor\(/);
    expect(k).toMatch(/if \(effectiveOwnerUid && effectiveOwnerUid === principal\.uid\) return true;/);
    expect(k).toMatch(/select\("id, name, acl, visibility, owner_user_id, owner_team_id"\)/);
    expect(k).toMatch(/from\("teams"\)\.select\("id, supervisor_user_id"\)/);
    expect(k).toMatch(/const owner = effectiveOwnerFor\(doc\.owner_user_id, doc\.collection_id, doc\.library_id, landscape\);/);
    expect(k).toMatch(/select\("id, library_id, collection_id, acl, visibility, is_private, scope, created_by, owner_user_id"\)/);
  });

  it("the library page's client filter walks the folder lineage for the owner rung", () => {
    const p = src("app/(protected)/documents/[libraryId]/page.tsx");
    expect(p).toMatch(/const folderOwnerFor = useCallback\(/);
    expect(p).toMatch(/effectiveOwnerUserId: docRecord\.ownerUserId \?\? folderOwnerFor\(docRecord\.collectionId\) \?\? library\?\.ownerUserId \?\? null/);
    expect(p).toMatch(/effectiveOwnerUserId: f\.ownerUserId \?\? folderOwnerFor\(f\.parentId\) \?\? library\?\.ownerUserId \?\? null/);
  });
});

describe("DOCACL-2 — default-open is said out loud where rules are written", () => {
  it("the drawer shows the open state, explains it, and offers the one-click restriction", () => {
    const d = src("components/permissions/PermissionDrawer.tsx");
    expect(d).toMatch(/Open to all members/);
    expect(d).toMatch(/Allow rules below add nothing until you restrict it; only deny rules bite\./);
    expect(d).toMatch(/Restrict to the people listed below/);
  });
  it("the library wizard exposes defaultNewVisibility instead of hardcoding normal", () => {
    const w = src("app/(protected)/admin/libraries/LibraryWizard.tsx");
    expect(w).toMatch(/defaultNewVisibility: newNodeVisibility,/);
    expect(w).not.toMatch(/defaultNewVisibility: "normal",/);
    expect(w).toMatch(/setNewNodeVisibility\(initialData\.defaultNewVisibility === "hidden" \? "hidden" : "normal"\);/);
  });
});
