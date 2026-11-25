// lib/packageReturnsServer.ts - the server side of work order package
// returns (server only: it holds the service key).
//
// Two ways in, both without an account:
//   * a package's own code, printed as the QR on its cover: opens that one
//     package and nothing else. The code is the returns link's id, the
//     package's key and a signature only this server can make, so it can't
//     be guessed or edited into another package.
//   * a contractor's returns link (/submit/<token>, an intake link with
//     purpose "package-returns"): the project's packages that are out in the
//     field.
// Either way: upload only. Nothing can be deleted, browsed or downloaded.

import { createHmac, timingSafeEqual } from "crypto";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { EMPTY_PROJECT_PACKAGES, packagesKey, type ProjectPackages, type WoPackage } from "@/lib/woPackagesCore";

export const RETURNS_PURPOSE = "package-returns";

const secret = () => createHmac("sha256", process.env.SUPABASE_SERVICE_ROLE_KEY || "dev-only").update("wo-package-codes/v1").digest();
const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sign = (linkId: string, key: string) => b64url(createHmac("sha256", secret()).update(`${linkId}|${key}`).digest()).slice(0, 22);

/** The code for a package's QR: link id, package key, signature. */
export function packageCode(linkId: string, key: string): string {
  return `${linkId.replace(/-/g, "")}.${b64url(Buffer.from(key, "utf8"))}.${sign(linkId, key)}`;
}

/** A package code read back, or null when it isn't one this server made. */
export function readPackageCode(code: string): { linkId: string; key: string } | null {
  const m = /^([0-9a-f]{32})\.([A-Za-z0-9_-]{1,120})\.([A-Za-z0-9_-]{22})$/.exec(code.trim());
  if (!m) return null;
  const h = m[1];
  const linkId = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  let key: string;
  try { key = Buffer.from(m[2].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); } catch { return null; }
  const want = Buffer.from(sign(linkId, key)), got = Buffer.from(m[3]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return { linkId, key };
}

export interface ReturnsLink { id: string; org_id: string; project_id: string; company_name: string; expires_at: string | null; revoked_at: string | null; purpose?: string | null }

/** The link behind a code or a token, if it's live and is a returns link. */
export async function openReturns(input: { code?: string | null; token?: string | null }): Promise<{ link: ReturnsLink; only: string | null } | { error: string; status: number }> {
  let linkQ;
  let only: string | null = null;
  if (input.code) {
    const c = readPackageCode(input.code);
    if (!c) return { error: "This code isn't valid. Scan the QR on the package's cover again.", status: 404 };
    only = c.key;
    linkQ = supabaseAdmin.from("project_intake_links").select("id, org_id, project_id, company_name, expires_at, revoked_at, purpose").eq("id", c.linkId).maybeSingle();
  } else if (input.token && /^[A-Za-z0-9_-]{16,128}$/.test(input.token)) {
    linkQ = supabaseAdmin.from("project_intake_links").select("id, org_id, project_id, company_name, expires_at, revoked_at, purpose").eq("token", input.token).maybeSingle();
  } else return { error: "This link isn't valid.", status: 400 };
  const { data } = await linkQ;
  const link = data as ReturnsLink | null;
  if (!link || link.purpose !== RETURNS_PURPOSE) return { error: "This link wasn't found. Check it was copied in full.", status: 404 };
  if (link.revoked_at) return { error: "This link has been turned off. Ask your project contact for a new one.", status: 410 };
  if (link.expires_at && Date.parse(link.expires_at) < Date.now()) return { error: "This link has expired. Ask your project contact for a new one.", status: 410 };
  return { link, only };
}

export async function readPackagesAdmin(orgId: string, projectId: string): Promise<{ data: ProjectPackages; updatedAt: string | null }> {
  const { data } = await supabaseAdmin.from("org_configurations").select("data, updated_at").eq("org_id", orgId).eq("key", packagesKey(projectId)).maybeSingle();
  const row = data as { data?: ProjectPackages | null; updated_at?: string | null } | null;
  const d = row?.data ?? null;
  return { data: { ...EMPTY_PROJECT_PACKAGES, ...(d ?? {}), packages: d?.packages ?? {} }, updatedAt: row?.updated_at ?? null };
}

/** One package changed from its latest copy (retried when someone saved in between). */
export async function updatePackageAdmin(orgId: string, projectId: string, key: string, fn: (p: WoPackage) => WoPackage): Promise<WoPackage> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data, updatedAt } = await readPackagesAdmin(orgId, projectId);
    const cur = data.packages[key];
    if (!cur) throw new Error("That package isn't there any more.");
    const now = new Date().toISOString();
    const next = { ...fn(cur), updatedAt: now };
    const all: ProjectPackages = { ...data, packages: { ...data.packages, [key]: next } };
    const q = supabaseAdmin.from("org_configurations").update({ data: all, updated_at: now }).eq("org_id", orgId).eq("key", packagesKey(projectId));
    const { data: rows, error } = await (updatedAt ? q.eq("updated_at", updatedAt) : q.is("updated_at", null)).select("key");
    if (error) throw new Error(error.message);
    if ((rows ?? []).length) return next;
  }
  throw new Error("The package kept changing. Try again in a moment.");
}

/** Packages a returns link may see: one (a package's own code), or the
 *  project's packages that are out in the field (approved or printed). */
export function visiblePackages(all: ProjectPackages, only: string | null): WoPackage[] {
  const list = Object.values(all.packages);
  if (only) return list.filter((p) => p.key === only && p.status !== "filed");
  return list.filter((p) => p.status === "approved" || p.status === "issued").sort((a, b) => (a.equipment ?? "").localeCompare(b.equipment ?? "") || a.key.localeCompare(b.key));
}
