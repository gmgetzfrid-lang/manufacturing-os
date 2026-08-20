// /api/links/skill-assist — the AI co-author behind the Skill Studio.
//
// A member describes, in their own words, how their facility's documents
// reference each other ("our maintenance procedures call out work orders
// like WO-48122"). Their own model drafts the skill: a name, a description,
// the regex patterns, and a sample line per pattern so the studio's live
// tester immediately PROVES the draft against real text. The member remains
// the author — the draft lands in the editor, not in the database.
//
// Patterns are validated with the same compiler the engine runs
// (compileSkillPatterns), so nothing uncompilable or empty-matching ever
// reaches the editor as a "working" draft.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { governedAiCall, GovernedCallError } from "@/lib/ai/governedCall";
import { extractJsonBlock } from "@/lib/orchestrator/protocol";
import { compileSkillPatterns } from "@/lib/linkProposalLogic";

export const runtime = "nodejs";
export const maxDuration = 60;

const bad = (error: string, status: number) => NextResponse.json({ error }, { status });

export async function POST(req: NextRequest) {
  let body: { orgId?: string; description?: string };
  try { body = await req.json(); } catch { return bad("Bad JSON", 400); }
  const orgId = (body.orgId ?? "").trim();
  const description = (body.description ?? "").trim().slice(0, 2000);
  if (!orgId || description.length < 8) {
    return bad("Describe the connection in at least a sentence.", 400);
  }

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return bad("Not signed in", 401);
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) return bad("Not signed in", 401);
  const userId = userData.user.id;

  const { data: member } = await supabaseAdmin
    .from("org_members").select("status")
    .eq("org_id", orgId).eq("uid", userId).maybeSingle();
  if (!member || (member as { status?: string }).status !== "active") {
    return bad("Not a member of this workspace.", 403);
  }

  const SYSTEM =
    "You author Connection Skills for an industrial document platform. A skill is a set of " +
    "JavaScript-compatible regular expressions that find IDENTIFIERS in document text (work " +
    "order numbers, permit numbers, drawing numbers, SOP codes…). When matched text resolves " +
    "to a document that owns that number, the two documents connect.\n" +
    "Rules for patterns:\n" +
    "- JavaScript regex source strings (no surrounding slashes, no flags — the engine applies 'gi').\n" +
    "- Anchor with \\b where sensible; be specific enough not to match prose. Never write a " +
    "pattern that can match empty text or a bare number with no shape.\n" +
    "- Prefer ONE tight pattern per identifier form; 1–4 patterns total.\n" +
    "- For each pattern include a short realistic sample line of document text it should match.\n" +
    "Also write a 2–6 word name and a one-sentence description of what the skill connects.\n" +
    "Return STRICT JSON: {\"name\":\"…\",\"description\":\"…\",\"patterns\":[\"…\"],\"samples\":[\"…\"]}";

  try {
    const out = await governedAiCall({
      orgId, userId, op: "skillAssist",
      system: SYSTEM,
      user: `The member describes the connection their documents make:\n\n${description}`,
      maxTokens: 900,
      timeoutMs: 35_000,
    });
    const block = extractJsonBlock(out.text);
    if (!block) return bad("The model returned no usable draft — try rephrasing.", 502);
    const parsed = JSON.parse(block) as {
      name?: string; description?: string; patterns?: unknown[]; samples?: unknown[];
    };
    const rawPatterns = (parsed.patterns ?? [])
      .filter((p): p is string => typeof p === "string").slice(0, 4);
    const { regexes, errors } = compileSkillPatterns(rawPatterns);
    // Keep only patterns that survive the engine's own compiler.
    const good = rawPatterns.filter((p) => {
      const one = compileSkillPatterns([p]);
      return one.regexes.length === 1;
    });
    if (good.length === 0) {
      return bad(
        `The drafted patterns don't compile (${errors[0] ?? "no valid patterns"}) — try describing the identifier's exact shape, e.g. "WO- followed by five digits".`,
        502,
      );
    }
    void regexes;
    return NextResponse.json({
      name: String(parsed.name ?? "").slice(0, 80),
      description: String(parsed.description ?? "").slice(0, 300),
      patterns: good,
      samples: (parsed.samples ?? []).filter((s): s is string => typeof s === "string").slice(0, 4),
      dropped: rawPatterns.length - good.length,
    });
  } catch (e) {
    if (e instanceof GovernedCallError) return bad(e.message, e.status);
    return bad((e as Error).message, 502);
  }
}
