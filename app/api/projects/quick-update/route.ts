// POST /api/projects/quick-update - Update by note: read a supervisor's
// field note into proposed step updates. READ-ONLY: nothing is saved here.
// The app checks every line (lib/quickUpdate) and the person saves.
//
// The steps come from the person's own schedule (sent by the page, which
// already holds it); the call runs on the person's own AI key, under the
// org's cap and metering (lib/ai/governedCall).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { governedAiCall, GovernedCallError } from "@/lib/ai/governedCall";
import { extractJsonBlock } from "@/lib/orchestrator/protocol";
import { QUICK_SYSTEM, quickUserPrompt, parseReply } from "@/lib/quickUpdate";

export const runtime = "nodejs";
export const maxDuration = 150;

const bad = (error: string, status: number) => NextResponse.json({ error }, { status });
// A whole day typed out: up to about 40,000 characters.
const MAX_NOTE = 40_000;
const MAX_IMAGES = 8;

const TRANSCRIBE_SYSTEM = [
  "You copy out field notes from pictures: a notebook page, a whiteboard, a printed or handwritten log, a scanned page.",
  "Copy every word exactly as written, line by line, in the order on the page. Keep times, numbers, equipment tags (V-01, E-2, PSV-209), WO numbers and abbreviations as written.",
  "Don't fix spelling, summarize, explain or add anything. A word you can't read: [?]. A page with nothing on it: say (blank page).",
  "Return only the words, no headings.",
].join("\n");
const MAX_CATALOG = 160_000;

/** The person's learned words ("mee too" = E-2), checked and kept short. */
function wordsOf(v: unknown): Array<{ said: string; as: string }> {
  if (!Array.isArray(v)) return [];
  return v.flatMap((w) => {
    const said = typeof w?.said === "string" ? w.said.replace(/["\n]/g, " ").trim().slice(0, 40) : "";
    const as = typeof w?.as === "string" ? w.as.replace(/["\n]/g, " ").trim().slice(0, 40) : "";
    return said && as ? [{ said, as }] : [];
  }).slice(0, 40);
}

export async function POST(req: NextRequest) {
  let body: {
    orgId?: string; projectId?: string; action?: string; note?: string; catalog?: string; now?: number; tz?: string; shift?: string; notesFrom?: string;
    words?: Array<{ said?: unknown; as?: unknown }>;
    images?: Array<{ base64?: string; mediaType?: string }>;
  };
  try { body = await req.json(); } catch { return bad("Bad JSON", 400); }
  const orgId = (body.orgId ?? "").trim(), projectId = (body.projectId ?? "").trim();
  const note = (body.note ?? "").trim(), catalog = body.catalog ?? "";
  const tz = (body.tz ?? "").trim(), now = Number(body.now);
  if (!orgId || !projectId) return bad("orgId and projectId required", 400);
  const transcribe = body.action === "transcribe";
  if (transcribe) {
    const imgs = (body.images ?? []).filter((i) => typeof i.base64 === "string" && i.base64.length > 100);
    if (!imgs.length) return bad("No pictures came through.", 400);
    if (imgs.length > MAX_IMAGES) return bad(`Up to ${MAX_IMAGES} pages at a time.`, 413);
    if (imgs.some((i) => (i.base64 ?? "").length > 6_000_000)) return bad("A picture is too big - take it again a little further back.", 413);
    const who = await signedIn(req, orgId, projectId);
    if ("error" in who) return bad(who.error, who.status);
    try {
      const out = await governedAiCall({
        orgId, userId: who.userId, op: "quickUpdate", system: TRANSCRIBE_SYSTEM,
        user: `Copy out ${imgs.length === 1 ? "this page" : `these ${imgs.length} pages, in order`}.`,
        images: imgs.map((i) => ({ base64: i.base64!, mediaType: (i.mediaType === "image/png" ? "image/png" : "image/jpeg") as "image/jpeg" })),
        maxTokens: 6_000, timeoutMs: 110_000,
      });
      return NextResponse.json({ text: out.text.trim() });
    } catch (e) {
      if (e instanceof GovernedCallError) return bad(e.message, e.status);
      return bad(`The pictures couldn't be read: ${(e as Error).message}`, 502);
    }
  }
  if (!note) return bad("Say or type what happened first.", 400);
  if (note.length > MAX_NOTE) return bad("That note is too long - split it into a few.", 413);
  if (!catalog || catalog.length > MAX_CATALOG) return bad("The schedule didn't come through - reload the page.", 400);
  if (!tz || !Number.isFinite(now)) return bad("The time didn't come through - reload the page.", 400);
  // The page's clock: a phone set to the wrong day would put every time wrong.
  if (Math.abs(now - Date.now()) > 15 * 60_000) return bad("This device's clock is off by more than 15 minutes. Fix the phone's time, then try again.", 409);

  const who = await signedIn(req, orgId, projectId);
  if ("error" in who) return bad(who.error, who.status);
  const userId = who.userId;

  let text: string;
  try {
    const out = await governedAiCall({
      orgId, userId, op: "quickUpdate",
      system: QUICK_SYSTEM,
      user: quickUserPrompt({ note, catalog, now, tz, shift: (body.shift ?? "").slice(0, 300), notesFrom: body.notesFrom ? body.notesFrom.slice(0, 400) : undefined, words: wordsOf(body.words) }),
      // A day's log can come back with dozens of updates.
      maxTokens: note.length > 6_000 ? 12_000 : 4_000,
      timeoutMs: 140_000,
    });
    text = out.text;
  } catch (e) {
    if (e instanceof GovernedCallError) return bad(e.message, e.status);
    return bad(`The AI didn't answer: ${(e as Error).message}`, 502);
  }
  const block = extractJsonBlock(text);
  let parsed: unknown;
  try { parsed = block ? JSON.parse(block) : null; } catch { parsed = null; }
  if (!parsed) return bad("Couldn't read the AI's answer. Try again, or say it a different way.", 422);
  return NextResponse.json(parseReply(parsed));
}

/** The caller: signed in, an active member, the project in the workspace. */
async function signedIn(req: NextRequest, orgId: string, projectId: string): Promise<{ userId: string } | { error: string; status: number }> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return { error: "Not signed in", status: 401 };
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) return { error: "Not signed in", status: 401 };
  const userId = userData.user.id;
  const [{ data: member }, { data: project }] = await Promise.all([
    supabaseAdmin.from("org_members").select("status").eq("org_id", orgId).eq("uid", userId).maybeSingle(),
    supabaseAdmin.from("projects").select("id").eq("id", projectId).eq("org_id", orgId).maybeSingle(),
  ]);
  if (!member || (member as { status?: string }).status !== "active") return { error: "Not a member of this workspace.", status: 403 };
  if (!project) return { error: "Project not found.", status: 404 };
  return { userId };
}
