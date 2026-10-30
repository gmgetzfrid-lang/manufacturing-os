// /api/knowledge/catalog — the library's map of what it holds.
//
// GET  ?orgId&libraryId → every document's profile (type, designation,
//      purpose, form fields), the catalogs marked here and in linked
//      libraries, and what is still unmapped. Any active member.
// POST { orgId, libraryId, documentId? } → one bounded mapping pass:
//      profile unprofiled documents. The client calls again until
//      `remaining` is 0. Admin/DocCtrl only — it writes the shared catalog —
//      on the caller's own key, fast tier.
// POST { action: "markCatalog", name, documentId? } → mark a document (its
//      sections are entries) or this library (its documents are) as a
//      catalog and read it from its text. "unmarkCatalog" removes it.

import { NextRequest, NextResponse } from "next/server";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { openAiKey } from "@/lib/ai/keyVault";
import { ALLOWED_PROVIDERS, type AiUsage } from "@/lib/ai/pricing";
import { getMonthUsage, getCapUsd, recordAskUsage } from "@/lib/ai/usageServer";
import type { AiProviderId } from "@/lib/ai/providerCall";
import { drainCatalog, profilesFor, listCatalogs, markCatalog, unmarkCatalog } from "@/lib/knowledgeCatalogServer";

export const runtime = "nodejs";
export const maxDuration = 60;
const BUDGET_MS = 48_000;

async function authUser(req: NextRequest) {
  const h = req.headers.get("authorization");
  if (!h?.startsWith("Bearer ")) return null;
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(h.slice(7));
  return error || !user ? null : user;
}

async function memberRoles(orgId: string, uid: string): Promise<Set<string> | null> {
  const { data: m } = await supabaseAdmin
    .from("org_members").select("role, roles")
    .eq("org_id", orgId).eq("uid", uid).eq("status", "active").maybeSingle();
  if (!m) return null;
  return new Set<string>([(m.role as string) ?? "", ...((m.roles as string[]) ?? [])]);
}

export async function GET(req: NextRequest) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const orgId = req.nextUrl.searchParams.get("orgId") ?? "";
  const libraryId = req.nextUrl.searchParams.get("libraryId") ?? "";
  if (!orgId || !libraryId) return NextResponse.json({ error: "orgId and libraryId are required" }, { status: 400 });
  const roles = await memberRoles(orgId, user.id);
  if (!roles) return NextResponse.json({ error: "Not a member of this workspace" }, { status: 403 });

  // Every entry (paged — one read stops at 1,000 rows), minus those set
  // aside: a document deleted or moved out of the source must leave the map.
  const { rows: list } = await fetchAllRows<{ id: string; name: string; status: string }>((from, to) => supabaseAdmin
    .from("knowledge_documents").select("id, name, status")
    .eq("org_id", orgId).eq("library_id", libraryId).neq("status", "retired").order("id").range(from, to));
  const profiles = await profilesFor(supabaseAdmin, list.map((d) => d.id));
  const ready = list.filter((d) => d.status === "ready");
  return NextResponse.json({
    canMap: roles.has("Admin") || roles.has("DocCtrl"),
    entries: list.filter((d) => profiles.has(d.id)).map((d) => {
      const p = profiles.get(d.id)!;
      return {
        documentId: d.id, name: d.name, type: p.type, designation: p.designation, title: p.title,
        purpose: p.purpose, checklistFor: p.checklistFor ?? null,
        form: p.form ? { purpose: p.form.purpose, fillable: p.form.fillable, fieldCount: p.form.fields.length } : null,
        catalog: p.catalog ?? null,
      };
    }),
    unmapped: ready.filter((d) => !profiles.has(d.id)).length,
    catalogs: await listCatalogs(supabaseAdmin, { orgId, libraryId }),
    notReady: list.length - ready.length,
  });
}

export async function POST(req: NextRequest) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { orgId?: string; libraryId?: string; documentId?: string; action?: string; name?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Expected JSON body" }, { status: 400 }); }
  const orgId = String(body.orgId ?? "");
  const libraryId = String(body.libraryId ?? "");
  if (!orgId || !libraryId) return NextResponse.json({ error: "orgId and libraryId are required" }, { status: 400 });
  const roles = await memberRoles(orgId, user.id);
  if (!roles || (!roles.has("Admin") && !roles.has("DocCtrl"))) {
    return NextResponse.json({ error: "Only Admins and Document Control can map a library." }, { status: 403 });
  }

  // Marking a catalog: a person says what a document (or this library) is —
  // "Piping specs", "Valve data sheets" — and it's read from its text. No
  // AI, so no key needed.
  if (body.action === "markCatalog" || body.action === "unmarkCatalog") {
    if (body.documentId) {
      const { data: doc } = await supabaseAdmin.from("knowledge_documents").select("id")
        .eq("id", body.documentId).eq("org_id", orgId).eq("library_id", libraryId).maybeSingle();
      if (!doc) return NextResponse.json({ error: "That document isn't in this library." }, { status: 404 });
    }
    try {
      if (body.action === "unmarkCatalog") {
        await unmarkCatalog(supabaseAdmin, { orgId, libraryId, documentId: body.documentId || undefined });
        return NextResponse.json({ ok: true });
      }
      const name = String(body.name ?? "").trim();
      if (!name) return NextResponse.json({ error: "Give the catalog a name - what your team calls it." }, { status: 400 });
      const mark = await markCatalog(supabaseAdmin, { orgId, libraryId, documentId: body.documentId || undefined, name, by: user.id });
      return NextResponse.json({ mark });
    } catch (e) {
      return NextResponse.json({ error: `Couldn't read the catalog: ${(e as Error).message}` }, { status: 502 });
    }
  }
  const { data: conn } = await supabaseAdmin
    .from("ai_connections").select("provider, model, api_key")
    .eq("org_id", orgId).eq("user_id", user.id).maybeSingle();
  if (!conn || !ALLOWED_PROVIDERS.includes(conn.provider as AiProviderId)) {
    return NextResponse.json({ error: "Add your Claude or OpenAI key in AI settings to map the library." }, { status: 412 });
  }
  const [spent, cap] = await Promise.all([getMonthUsage(orgId, user.id), getCapUsd(orgId, user.id)]);
  if (cap > 0 && spent.spentUsd >= cap) {
    return NextResponse.json({ error: `Monthly AI budget reached ($${spent.spentUsd.toFixed(2)} of $${cap.toFixed(2)}).` }, { status: 402 });
  }

  const usage: AiUsage = { inputTokens: 0, outputTokens: 0 };
  let usedModel = conn.model as string;
  try {
    const conn2 = {
      provider: conn.provider as AiProviderId, model: conn.model as string, apiKey: openAiKey(conn.api_key as string),
      onUsage: (u: AiUsage, model: string) => { usage.inputTokens += u.inputTokens; usage.outputTokens += u.outputTokens; usedModel = model; },
    };
    const result = await drainCatalog(supabaseAdmin, {
      orgId, libraryId, documentId: body.documentId || undefined,
      deadlineMs: Date.now() + BUDGET_MS,
      conn: conn2,
    });
    await recordAskUsage({ orgId, userId: user.id, provider: conn.provider as string, model: usedModel, usage, ok: true, op: "knowledgeCatalog" });
    return NextResponse.json(result);
  } catch (e) {
    await recordAskUsage({ orgId, userId: user.id, provider: conn.provider as string, model: usedModel, usage, ok: false, op: "knowledgeCatalog" });
    return NextResponse.json({ error: `Mapping failed: ${(e as Error).message}` }, { status: 502 });
  }
}
