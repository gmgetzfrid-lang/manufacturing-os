// lib/woPackages.ts - work order packages: the workspace's kit and each
// project's packages.
//
// The kit is uploaded once and serves every project: a cover sheet and a
// contents page (both optional: the app draws clean ones), and the blank
// quality forms (flange log, hydro test, vessel closure, exchanger
// closure...), each saying which equipment it's for. A package per piece of
// equipment (its work orders together) is drafted from the kit in one go:
// cover, contents, the forms its equipment needs, its drawings. The planner
// adds photos or drawings, drags the order, approves and prints. Signed
// forms come back (scanned on a phone, uploaded, or sent through a link)
// and take the blank's place. Filing writes the finished PDF to the
// project's network folder and keeps only the path: the working copies are
// deleted.
//
// Where it's kept: workspace settings rows (org_configurations), the kit
// under "package_kit" and each project's packages under
// "wo_packages:<projectId>", so nothing new is needed in the database.
// Saves read the latest first and write only if nobody saved in between
// (else they retry on the fresh copy), so two people don't undo each other.

import { supabase } from "@/lib/supabase";
import { EMPTY_KIT, EMPTY_PROJECT_PACKAGES, KIT_KEY, draftPackage, packagesKey, type PackageKit, type ProjectPackages, type WoPackage } from "@/lib/woPackagesCore";

export * from "@/lib/woPackagesCore";

// ── Reading and saving ───────────────────────────────────────

async function readConfig<T>(orgId: string, key: string): Promise<{ data: T | null; updatedAt: string | null }> {
  const { data, error } = await supabase.from("org_configurations").select("data, updated_at").eq("org_id", orgId).eq("key", key).maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as { data?: T | null; updated_at?: string | null } | null;
  return { data: row?.data ?? null, updatedAt: row?.updated_at ?? null };
}

/** Change a settings row from its latest copy; if someone saved in between,
 *  do it again on theirs (up to 4 times). */
async function mutateConfig<T>(orgId: string, key: string, empty: T, fn: (cur: T) => T): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data, updatedAt } = await readConfig<T>(orgId, key);
    const next = fn(data ?? empty);
    const now = new Date().toISOString();
    if (updatedAt === null && data === null) {
      const { error } = await supabase.from("org_configurations").insert({ org_id: orgId, key, data: next, updated_at: now });
      if (!error) return next;
      if (!/duplicate|unique|23505/i.test(error.message + (error.code ?? ""))) throw new Error(error.message);
      continue; // someone made it first: do it again on theirs
    }
    const q = supabase.from("org_configurations").update({ data: next, updated_at: now }).eq("org_id", orgId).eq("key", key);
    const { data: rows, error } = await (updatedAt ? q.eq("updated_at", updatedAt) : q.is("updated_at", null)).select("key");
    if (error) throw new Error(error.message);
    if ((rows ?? []).length) return next;
  }
  throw new Error("Someone else kept saving these packages. Try again in a moment.");
}

export async function loadKit(orgId: string): Promise<PackageKit> {
  const { data } = await readConfig<PackageKit>(orgId, KIT_KEY);
  return { ...EMPTY_KIT, ...(data ?? {}), forms: data?.forms ?? [] };
}
export function updateKit(orgId: string, by: string | undefined, fn: (k: PackageKit) => PackageKit): Promise<PackageKit> {
  return mutateConfig(orgId, KIT_KEY, EMPTY_KIT, (k) => ({ ...fn({ ...EMPTY_KIT, ...k, forms: k.forms ?? [] }), updatedAt: new Date().toISOString(), updatedBy: by }));
}

export async function loadPackages(orgId: string, projectId: string): Promise<ProjectPackages> {
  const { data } = await readConfig<ProjectPackages>(orgId, packagesKey(projectId));
  return { ...EMPTY_PROJECT_PACKAGES, ...(data ?? {}), packages: data?.packages ?? {} };
}
export function updatePackages(orgId: string, projectId: string, fn: (p: ProjectPackages) => ProjectPackages): Promise<ProjectPackages> {
  return mutateConfig(orgId, packagesKey(projectId), EMPTY_PROJECT_PACKAGES, (p) => fn({ ...EMPTY_PROJECT_PACKAGES, ...p, packages: p.packages ?? {} }));
}
/** One package changed (stamped with when). */
export function updatePackage(orgId: string, projectId: string, key: string, fn: (p: WoPackage) => WoPackage): Promise<ProjectPackages> {
  return updatePackages(orgId, projectId, (all) => {
    const cur = all.packages[key];
    if (!cur) throw new Error("That package isn't there any more. Refresh the page.");
    return { ...all, packages: { ...all.packages, [key]: { ...fn(cur), updatedAt: new Date().toISOString() } } };
  });
}


/** Build every package the scope doesn't have yet, from the kit. Returns
 *  the work orders now in a package (for marking them on the scope). */
export async function draftMissing(orgId: string, projectId: string, groups: Map<string, import("@/lib/woIntake").ScopeWO[]>, kit: PackageKit): Promise<string[]> {
  const made: string[] = [];
  await updatePackages(orgId, projectId, (p) => {
    const next = { ...p.packages };
    made.length = 0;
    for (const [k, g] of groups) if (!next[k]) { next[k] = draftPackage(g, kit); made.push(...g.map((x) => x.wo)); }
    return { ...p, packages: next };
  });
  return made;
}
