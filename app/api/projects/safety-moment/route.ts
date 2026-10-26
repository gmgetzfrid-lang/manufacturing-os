// POST /api/projects/safety-moment — build the turnover's safety moment.
//
// The report ranks the next shift's riskiest kinds of work (lib/
// safetyMoment rankHazards) and sends them here with the supervisor's
// optional note. The model searches the web live for real incidents that
// match each one and writes two short lessons per kind; any lesson whose
// page the search didn't actually return is dropped. The result is saved
// for the project and shift, so everyone sees the same moment, and later
// moments steer away from the same sources.
//
// Authority: any active member (it spends the caller's own AI key).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { governedAiCall, GovernedCallError } from "@/lib/ai/governedCall";
import { AiCallError, isTimeoutError } from "@/lib/ai/providerCall";
import {
  HAZARD_KINDS, SAFETY_SYSTEM, safetyMomentPrompt, parseSafetyMoment,
  type HazardKind, type RankedHazard, type SafetyMoment,
} from "@/lib/safetyMoment";

export const runtime = "nodejs";
export const maxDuration = 120;

const bad = (error: string, status: number) => NextResponse.json({ error }, { status });
const str = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** The ranked kinds as sent by the report, checked and trimmed. */
function readHazards(v: unknown): RankedHazard[] {
  if (!Array.isArray(v)) return [];
  const out: RankedHazard[] = [];
  for (const h of v.slice(0, 3)) {
    const kind = (h as { kind?: string })?.kind as HazardKind;
    if (!kind || !(kind in HAZARD_KINDS) || out.some((x) => x.kind === kind)) continue;
    const r = h as Partial<RankedHazard>;
    out.push({
      kind, label: HAZARD_KINDS[kind].label, severity: HAZARD_KINDS[kind].severity,
      hours: Number(r.hours) || 0, fromNote: !!r.fromNote, score: Number(r.score) || 0,
      jobs: (Array.isArray(r.jobs) ? r.jobs : []).slice(0, 8).map((j) => ({
        id: str(j?.id, 80), equipment: j?.equipment ? str(j.equipment, 80) : null,
        name: str(j?.name, 240), who: j?.who ? str(j.who, 80) : null, when: str(j?.when, 40),
      })).filter((j) => j.name),
    });
  }
  return out;
}

export async function POST(req: NextRequest) {
  let body: {
    orgId?: string; projectId?: string; shiftStart?: number | string; shiftKind?: string;
    shiftLabel?: string; hazards?: unknown; note?: string | null;
  };
  try { body = await req.json(); } catch { return bad("Bad JSON", 400); }
  const orgId = str(body.orgId, 80), projectId = str(body.projectId, 80);
  const shiftStartMs = typeof body.shiftStart === "number" ? body.shiftStart : Date.parse(String(body.shiftStart ?? ""));
  const shiftKind = body.shiftKind === "day" || body.shiftKind === "night" ? body.shiftKind : null;
  if (!orgId || !projectId) return bad("orgId and projectId required", 400);
  if (!Number.isFinite(shiftStartMs) || !shiftKind) return bad("shiftStart and shiftKind required", 400);
  const hazards = readHazards(body.hazards);
  if (hazards.length === 0) return bad("Nothing on this shift to build a safety moment from — add a note naming the work.", 400);
  const note = str(body.note, 500) || null;

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return bad("Not signed in", 401);
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) return bad("Not signed in", 401);
  const user = userData.user;

  const [{ data: member }, { data: project }] = await Promise.all([
    supabaseAdmin.from("org_members").select("status").eq("org_id", orgId).eq("uid", user.id).maybeSingle(),
    supabaseAdmin.from("projects").select("id, name").eq("id", projectId).eq("org_id", orgId).maybeSingle(),
  ]);
  if (!member || (member as { status?: string }).status !== "active") return bad("Not a member of this workspace.", 403);
  if (!project) return bad("Project not found.", 404);

  // Sources the org's recent moments already used — find new ones.
  const { data: recent } = await supabaseAdmin
    .from("shift_safety_moments").select("moment")
    .eq("org_id", orgId).order("updated_at", { ascending: false }).limit(30);
  const avoidUrls = [...new Set(((recent ?? []) as Array<{ moment: SafetyMoment | null }>)
    .flatMap((r) => r.moment?.items ?? []).flatMap((i) => i.gems ?? []).map((g) => g.source?.url).filter((u): u is string => !!u))];

  let out;
  try {
    out = await governedAiCall({
      orgId, userId: user.id, op: "safetyMoment",
      system: SAFETY_SYSTEM,
      user: safetyMomentPrompt({
        projectName: (project as { name?: string }).name, shiftLabel: str(body.shiftLabel, 120) || `${shiftKind} shift`,
        hazards, note, avoidUrls,
      }),
      webSearch: true, requireLiveWeb: true, maxSearches: Math.min(8, hazards.length * 2 + 1),
      maxTokens: 3000, timeoutMs: 105_000,
    });
  } catch (e) {
    if (e instanceof GovernedCallError) return bad(e.message, e.status);
    if (isTimeoutError(e)) return bad("The web search took too long. Try again — it's usually quicker the second time.", 504);
    if (e instanceof AiCallError) return bad(e.message, e.status);
    return bad((e as Error).message || "Couldn't build the safety moment.", 500);
  }

  let parsed;
  try { parsed = parseSafetyMoment(out.text, hazards, out.searchResults ?? out.webSources); }
  catch (e) { return bad((e as Error).message, 502); }
  if (parsed.items.every((i) => i.gems.length === 0)) {
    return bad("The search didn't turn up lessons it could back with a source. Try again, or add a note with more detail.", 502);
  }

  const builtByName = str((user.user_metadata as { full_name?: string; name?: string } | undefined)?.full_name
    ?? (user.user_metadata as { name?: string } | undefined)?.name ?? user.email ?? "", 120) || null;
  const moment: SafetyMoment = { v: 1, items: parsed.items, note, builtAt: new Date().toISOString(), builtByName };
  const { error: saveErr } = await supabaseAdmin.from("shift_safety_moments").upsert({
    org_id: orgId, project_id: projectId, shift_start: new Date(shiftStartMs).toISOString(), shift_kind: shiftKind,
    note, moment, built_by: user.id, built_by_name: builtByName, updated_at: moment.builtAt,
  }, { onConflict: "project_id,shift_start" });
  const missingTable = !!saveErr && (saveErr.code === "42P01" || /does not exist|schema cache/i.test(saveErr.message ?? ""));
  return NextResponse.json({
    moment,
    dropped: parsed.dropped,
    saved: !saveErr,
    ...(saveErr ? { warning: missingTable
      ? "Shown here only — run migration 20261031_shift_safety_moments.sql so it's saved for everyone."
      : `Built, but not saved: ${saveErr.message}` } : {}),
  });
}
