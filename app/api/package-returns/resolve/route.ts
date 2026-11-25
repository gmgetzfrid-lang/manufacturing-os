// GET /api/package-returns/resolve?c=<package code> | ?t=<returns link token>
//
// What the returns page shows, without an account: the package (or the
// project's packages out in the field), each blank form and whether its
// signed copy is in, and whether each drawing in it is still the current
// revision. Nothing else about the project.

import { NextRequest, NextResponse } from "next/server";
import { logoLinkFor } from "@/lib/brandServer";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { openReturns, readPackagesAdmin, visiblePackages } from "@/lib/packageReturnsServer";

export const runtime = "nodejs";

export interface ReturnsForm { id: string; title: string; signed: { at: string; via: string } | null }
export interface ReturnsDrawing { title: string; rev: string | null; current: boolean; currentRev: string | null }
export interface ReturnsPackage { key: string; wos: string[]; equipment: string; description: string; forms: ReturnsForm[]; added: Array<{ id: string; title: string; at: string | null }>; drawings: ReturnsDrawing[] }
export interface ReturnsView { projectName: string; orgName: string | null; orgLogo: string | null; company: string; scope: "package" | "project"; packages: ReturnsPackage[] }

export async function GET(req: NextRequest) {
  const opened = await openReturns({ code: req.nextUrl.searchParams.get("c"), token: req.nextUrl.searchParams.get("t") });
  if ("error" in opened) return NextResponse.json({ error: opened.error }, { status: opened.status });
  const { link, only } = opened;

  const [{ data: project }, { data: org }, orgLogo, { data: all }] = await Promise.all([
    supabaseAdmin.from("projects").select("name").eq("id", link.project_id).maybeSingle(),
    supabaseAdmin.from("orgs").select("name").eq("id", link.org_id).maybeSingle(),
    logoLinkFor(link.org_id),
    readPackagesAdmin(link.org_id, link.project_id),
  ]);
  const pkgs = visiblePackages(all, only);
  if (only && !pkgs.length) return NextResponse.json({ error: "This package has been filed or taken off the project. Ask your project contact." }, { status: 404 });

  // Drawings: the revision printed vs the current one.
  const docIds = [...new Set(pkgs.flatMap((p) => p.items.filter((i) => i.kind === "drawing" && i.documentId).map((i) => i.documentId!)))];
  const current = new Map<string, { versionId: string | null; rev: string | null }>();
  if (docIds.length) {
    const { data: docs } = await supabaseAdmin.from("documents").select("id, current_version_id").in("id", docIds);
    const vIds = ((docs ?? []) as Array<{ current_version_id: string | null }>).map((d) => d.current_version_id).filter(Boolean) as string[];
    const { data: vers } = vIds.length ? await supabaseAdmin.from("document_versions").select("id, revision_label").in("id", vIds) : { data: [] };
    const revOf = new Map(((vers ?? []) as Array<{ id: string; revision_label: string | null }>).map((v) => [v.id, v.revision_label]));
    for (const d of (docs ?? []) as Array<{ id: string; current_version_id: string | null }>) current.set(d.id, { versionId: d.current_version_id, rev: d.current_version_id ? revOf.get(d.current_version_id) ?? null : null });
  }

  const view: ReturnsView = {
    projectName: String(project?.name ?? "Project"),
    orgName: (org?.name as string | null) ?? null,
    orgLogo,
    company: link.company_name,
    scope: only ? "package" : "project",
    packages: pkgs.map((p) => ({
      key: p.key, wos: p.wos, equipment: p.equipment, description: p.description,
      forms: p.items.filter((i) => i.kind === "form").map((i) => ({ id: i.id, title: i.title, signed: i.signed ? { at: i.signed.at, via: i.signed.via } : null })),
      added: p.items.filter((i) => i.kind === "file" && i.signed).map((i) => ({ id: i.id, title: i.title, at: i.signed?.at ?? null })),
      drawings: p.items.filter((i) => i.kind === "drawing").map((i) => {
        const c = i.documentId ? current.get(i.documentId) : undefined;
        return { title: i.title, rev: i.rev ?? null, current: !c || !i.versionId || c.versionId === i.versionId, currentRev: c?.rev ?? null };
      }),
    })),
  };
  return NextResponse.json(view, { headers: { "cache-control": "no-store" } });
}
