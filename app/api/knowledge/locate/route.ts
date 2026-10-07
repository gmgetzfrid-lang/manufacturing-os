// /api/knowledge/locate — where a tag sits on a drawing sheet.
//
//   POST { orgId, documentId, page, tags[] }
//        → [{ tag, nx, ny, source: "text" | "vision", approximate?, readOnRevision? }]
//   POST { orgId, documentId, page, tags: [tag], action: "reject" }
//        → clears a cached AI ESTIMATE the viewer says is wrong (PR-10)
//
// Two sources, one answer shape:
//   text-layer sheets  — already stored at ingest from the PDF's own
//                        coordinates. Free, instant; the viewer maps them
//                        through the page's /Rotate, CropBox and /UserUnit.
//   vision-read sheets — the model looks at the rendered page and points.
//                        One call for the WHOLE page (every requested tag at
//                        once), refined on close-ups, then cached as an
//                        APPROXIMATE estimate (pos_source 'vision') until
//                        the sheet is revised or rebuilt (both clear every
//                        page entity — resetKnowledgeIndex), or a viewer
//                        rejects it. A point a close-up REFUTED is never
//                        cached (one relocate round replaces it, or nothing
//                        does); a point no close-up checked — past the first
//                        REFINE_MAX tags, or when time, the cap, a close-up's
//                        provider error or the canvas stopped the refining —
//                        is cached as the coarse estimate it is, drawn as
//                        approximate and rejectable like every other.
//
// The AI step runs behind THE gate stack (lib/ai/aiGates — GOV-13, GOV-11):
// the member's own key, the provider allowlist, the signed agreement and the
// monthly cap over every op (a $0 lock and an unreadable ledger refuse). A
// refusal skips the AI step only: the free answer — text-layer positions,
// notOnPage, the library's 'elsewhere' hits — still comes back, said why.
// Every model call one request makes — the coarse pass, each close-up and
// any relocate round — reserves its worst case BEFORE it is made (refused
// when it no longer fits beside the month and every call in flight: the
// refining stops there, the coarser point kept) and is metered in ONE
// ai_usage_events row — the first call's reservation, settled to every
// call's tokens after each one (DWG-5 / GOV-8), so a request cut short
// part-way leaves what it spent recorded.
//
// ACL: the same fail-closed check as every other knowledge read — a mirror
// of a controlled document the caller can't read never resolves here either.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadPrincipal, readableControlledDocIds } from "@/lib/knowledgeAccess";
import { callAiModel, type AiProviderId } from "@/lib/ai/providerCall";
import { addUsage, ZERO_USAGE, AGREEMENT_VERSION, type AiUsage } from "@/lib/ai/pricing";
import { assertAiGates, GovernedCallError, type AiGatePass, type AiReservation } from "@/lib/ai/aiGates";
import { VISION_MODEL } from "@/lib/knowledgeVision";
import {
  LOCATE_SYSTEM, buildLocateUser, buildRelocateUser, parseLocateResponse, type TagPosition,
} from "@/lib/drawingLocate";
import { ensurePdfPolyfills } from "@/lib/knowledgeText";
import { r2, R2_BUCKET } from "@/lib/r2";
import { GetObjectCommand } from "@aws-sdk/client-s3";

export const runtime = "nodejs";
export const maxDuration = 60;

/** One page render + one model call has to fit comfortably. */
const LOCATE_BUDGET_MS = 40_000;
/** Asking for the world would turn one call into a bad transcription job. */
const MAX_TAGS = 12;

/** The 'where else is this tag' read names what counts as WHERE a tag is:
 *  the equipment occurrence, or the sheet that declares a drawing number as
 *  its own. A `ref` (a neighbouring sheet merely citing the number) or an
 *  `opc` row is never an answer (DWG-12). */
const ELSEWHERE_KINDS: string[] = ["equipment", "self"];

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

/** What the free answer says when the gate stack refuses the AI step — the
 *  sentence each refusal answered with before it moved onto aiGates. */
function skipFor(e: GovernedCallError): Record<string, unknown> {
  const d = e.details ?? {};
  if (e.status === 412) {
    return {
      skipped: "These tags came from an AI-read sheet, so pointing at them needs your own AI key " +
        "(add one in AI settings). The sheet still opens at the right page.",
    };
  }
  if (e.status === 428) {
    // PR-12, locate limb: pointing sends the rendered page to the provider.
    return {
      skipped: "Pointing at AI-read tags sends this page's image to your AI provider. Read and accept the " +
        "AI acceptable-use agreement first (ask any Knowledge question to see it) — the sheet still opens at the right page.",
      agreementRequired: true,
      agreementText: d.agreementText,
      agreementVersion: d.agreementVersion,
    };
  }
  // GOV-3: a $0 cap locks — refused before the first call, at $0 spent too.
  if (e.status === 402 && d.locked === true) {
    return { skipped: "Your monthly AI cap is set to $0, so AI is locked for you until someone who manages AI caps raises it — the sheet still opens at the right page." };
  }
  if (e.status === 402 && typeof d.spentUsd === "number" && typeof d.capUsd === "number" && !("reservedUsd" in d)) {
    return { skipped: `Monthly AI budget reached ($${d.spentUsd.toFixed(2)} of $${d.capUsd.toFixed(2)}) — the sheet still opens at the right page.` };
  }
  // GOV-4: an unreadable ledger or cap refuses the AI step, never the free answer.
  if (e.status === 503) return { skipped: `${e.message} The sheet still opens at the right page.` };
  return { skipped: `${e.message.replace(/\.$/, "")} — the sheet still opens at the right page.` };
}

/** Said when the agreement record cannot be read: never a prompt to sign
 *  again (the sentence locate gave before it moved onto aiGates). */
const AGREEMENT_UNCONFIRMED = "Couldn't confirm your AI acceptable-use agreement right now — the sheet still opens at the right page.";

/** The gate stack refused on the agreement (428), which it also answers for
 *  a record it could not read. Read it once more: true only when the read
 *  works and finds no acceptance at AGREEMENT_VERSION — the member really
 *  has not signed. A record that is there (the gate's read failed) or that
 *  still cannot be read is not "unsigned". */
async function agreementUnsigned(orgId: string, userId: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from("ai_key_agreements").select("id")
      .eq("org_id", orgId).eq("user_id", userId)
      .eq("scope", "use").eq("agreement_version", AGREEMENT_VERSION).limit(1);
    return !error && (data ?? []).length === 0;
  } catch {
    return false;
  }
}

/** A thrown provider call may still carry the usage the provider reported
 *  (a refusal, an empty answer) — counted when it does. */
const usageOf = (e: unknown): AiUsage | null => {
  const u = (e as { usage?: Partial<AiUsage> } | null)?.usage;
  return u && typeof u.inputTokens === "number" && typeof u.outputTokens === "number"
    ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens } : null;
};

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return bad("Unauthorized", 401);

  let body: { orgId?: string; documentId?: string; page?: number; tags?: string[]; action?: string };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  const documentId = String(body.documentId ?? "").trim();
  const page = Number(body.page ?? 0);
  const tags = [...new Set((body.tags ?? []).map((t) => String(t).trim().toUpperCase()).filter(Boolean))]
    .slice(0, MAX_TAGS);
  if (!orgId || !documentId || !page || tags.length === 0) {
    return bad("orgId, documentId, page and tags are required");
  }

  const principal = await loadPrincipal(orgId, user.id);
  if (!principal) return bad("Not a member of this workspace", 403);

  const { data: doc } = await supabaseAdmin
    .from("knowledge_documents")
    .select("id, org_id, library_id, name, file_key, source_document_id, source_rev, vision_pages")
    .eq("id", documentId).eq("org_id", orgId).maybeSingle();
  if (!doc) return bad("Sheet not found", 404);

  // Fail closed: a mirrored controlled document obeys the source's ACL.
  if (doc.source_document_id) {
    try {
      const readable = await readableControlledDocIds(principal, [doc.source_document_id as string]);
      if (!readable.has(doc.source_document_id as string)) return bad("Not permitted", 403);
    } catch {
      return bad("Not permitted", 403);
    }
  }

  // ── A viewer rejects an AI estimate (PR-10) ───────────────────────────
  // Only a model's estimate can be rejected — a text-layer position is read
  // from the PDF itself. The row stays (the tag IS on this page); only the
  // cached point goes, so the next look asks the model afresh.
  if (body.action === "reject") {
    const { data: cleared, error: clearErr } = await supabaseAdmin
      .from("knowledge_page_entities")
      .update({ nx: null, ny: null, pos_source: null })
      .eq("document_id", documentId).eq("page", page).in("tag", tags).eq("pos_source", "vision")
      .select("id");
    if (clearErr) return bad(`Couldn't clear that position: ${clearErr.message}`, 500);
    return NextResponse.json({ cleared: (cleared ?? []).length });
  }
  if (body.action !== undefined) return bad("Unknown action");

  // ── Cached positions ───────────────────────────────────────────────────
  const { data: rows, error: entErr } = await supabaseAdmin
    .from("knowledge_page_entities")
    .select("tag, nx, ny, pos_source")
    .eq("document_id", documentId).eq("page", page).in("tag", tags);
  if (entErr) {
    const missing = entErr.code === "42P01" || /does not exist|nx/i.test(entErr.message);
    return bad(
      missing
        ? "Locating tags on drawings needs migration 20260924 — run it in Supabase, then try again."
        : entErr.message,
      missing ? 424 : 500,
    );
  }

  type Found = { tag: string; nx: number; ny: number; source: string; approximate?: boolean; readOnRevision?: string | null };
  const found = new Map<string, Found>();
  // A cached vision point is the model's estimate: said so, with the
  // revision it was read on (a rev-up clears it — resetKnowledgeIndex).
  const visionMark = (pos: TagPosition): Found => ({
    ...pos, source: "vision", approximate: true, readOnRevision: (doc.source_rev as string | null) ?? null,
  });
  for (const r of (rows ?? []) as Array<{ tag: string; nx: number | null; ny: number | null; pos_source: string | null }>) {
    if (r.nx === null || r.ny === null || found.has(r.tag)) continue;
    found.set(r.tag, r.pos_source === "vision"
      ? visionMark({ tag: r.tag, nx: r.nx, ny: r.ny })
      : { tag: r.tag, nx: r.nx, ny: r.ny, source: r.pos_source ?? "text" });
  }
  const unlocated = tags.filter((t) => !found.has(t));
  // Only tags this page actually carries are worth a model call — asking it
  // to find something that isn't there is how you get a confident wrong dot.
  const onThisPage = new Set(((rows ?? []) as Array<{ tag: string }>).map((r) => r.tag));
  const toLocate = unlocated.filter((t) => onThisPage.has(t));

  // ── Not here? Say WHERE. ───────────────────────────────────────────────
  // "V-3 isn't on this page" leaves an engineer exactly where they started;
  // "V-3 is on 025-PID-0103" is navigation. The entity index knows every
  // tag on every sheet in the library — use it. ACL fails closed: a mirror
  // of a controlled doc the caller can't read is never suggested.
  const missingHere = tags.filter((t) => !onThisPage.has(t));
  const elsewhere: Array<{
    tag: string; documentId: string; documentName: string; fileKey: string;
    page: number; sameDocument: boolean;
  }> = [];
  if (missingHere.length > 0) {
    try {
      // Bounded by the caller's tags (≤ MAX_TAGS) and named kinds — a
      // drawing number cited on hundreds of sheets can no longer fill the
      // read with references (DWG-12).
      const { data: elseRows } = await supabaseAdmin
        .from("knowledge_page_entities")
        .select("document_id, page, tag")
        .eq("library_id", doc.library_id as string)
        .in("tag", missingHere)
        .in("kind", ELSEWHERE_KINDS)
        .order("document_id", { ascending: true }).order("page", { ascending: true })
        .limit(1000);
      const hits = (elseRows ?? []) as Array<{ document_id: string; page: number; tag: string }>;
      const hitDocIds = [...new Set(hits.map((r) => r.document_id))];
      if (hitDocIds.length > 0) {
        const { data: docRows } = await supabaseAdmin
          .from("knowledge_documents")
          .select("id, name, file_key, source_document_id")
          .in("id", hitDocIds);
        const docsById = new Map((docRows ?? []).map((d) => [d.id as string, d]));
        const mirrors = (docRows ?? []).filter((d) => d.source_document_id);
        let readable = new Set<string>();
        if (mirrors.length > 0) {
          try {
            readable = await readableControlledDocIds(
              principal, [...new Set(mirrors.map((d) => d.source_document_id as string))]);
          } catch { readable = new Set(); }
        }
        const best = new Map<string, { document_id: string; page: number }>();
        // Prefer another page of the OPEN sheet, then the lowest page.
        const score = (h: { document_id: string; page: number }) =>
          (h.document_id === documentId ? 0 : 1_000_000) + h.page;
        for (const h of hits) {
          const d = docsById.get(h.document_id);
          if (!d) continue;
          if (d.source_document_id && !readable.has(d.source_document_id as string)) continue;
          const prev = best.get(h.tag);
          if (!prev || score(h) < score(prev)) best.set(h.tag, h);
        }
        for (const [tag, hit] of best) {
          const d = docsById.get(hit.document_id)!;
          elsewhere.push({
            tag, documentId: hit.document_id,
            documentName: d.name as string, fileKey: d.file_key as string,
            page: hit.page, sameDocument: hit.document_id === documentId,
          });
        }
      }
    } catch { /* best-effort — a missing answer here just means less help */ }
  }
  const trulyAbsent = missingHere.filter((t) => !elsewhere.some((e) => e.tag === t));

  if (toLocate.length === 0) {
    return NextResponse.json({
      positions: [...found.values()],
      notOnPage: trulyAbsent,
      elsewhere,
    });
  }

  // ── Vision locate, behind the gate stack (GOV-13 / GOV-11) ─────────────
  //    own key → allowlist → agreement → the cap over every op. A refusal
  //    skips the AI step only: the free answer still comes back.
  const free = () => ({ positions: [...found.values()], notOnPage: trulyAbsent, elsewhere });
  let gate: AiGatePass;
  try {
    gate = await assertAiGates({ orgId, userId: user.id, op: "drawingLocate" });
  } catch (e) {
    if (!(e instanceof GovernedCallError)) throw e;
    // An agreement record that cannot be read is not an unsigned one: a
    // member who has signed is told it couldn't be confirmed, never asked
    // to sign again (which can record a second acceptance).
    if (e.status === 428 && !(await agreementUnsigned(orgId, user.id))) {
      return NextResponse.json({ ...free(), skipped: AGREEMENT_UNCONFIRMED });
    }
    return NextResponse.json({ ...free(), ...skipFor(e) });
  }
  const provider = gate.connection.provider as AiProviderId;
  const model = VISION_MODEL[provider] ?? gate.connection.model;

  // Every model call this request makes reserves its worst case first and
  // folds its tokens into ONE metering row (the first call's reservation,
  // settled after every call — a throw part-way still records what it spent).
  let spent: AiUsage = ZERO_USAGE;
  let row: AiReservation | null = null;
  let failed = false;
  const meter = (u: AiUsage | null) => { if (u) spent = addUsage(spent, u); };

  try {
    ensurePdfPolyfills();
    const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: doc.file_key as string }));
    const bytes = new Uint8Array(await new Response(obj.Body as ReadableStream).arrayBuffer());
    const { getDocumentProxy, renderPageAsImage } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes);
    const img = await renderPageAsImage(pdf, page, {
      width: 1800,
      canvasImport: () => import("@napi-rs/canvas"),
    });
    const pageB64 = Buffer.from(img as ArrayBuffer).toString("base64");
    /** One reserved, metered model call (GOV-13): its worst case is
     *  reserved before it is made — a GovernedCallError when it does not
     *  fit — and its tokens, a throw's included, fold into the one row. */
    const ask = async (userText: string, image: string, maxTokens: number) => {
      const reservation = await gate.reserve({ inputChars: LOCATE_SYSTEM.length + userText.length, images: 1, maxTokens, model });
      try {
        const res = await callAiModel({
          provider, model,
          apiKey: gate.connection.apiKey,
          system: LOCATE_SYSTEM,
          user: userText,
          maxTokens,
          images: [{ base64: image, mediaType: "image/png" }],
          timeoutMs: Math.max(5_000, startedAt + LOCATE_BUDGET_MS - Date.now()),
        });
        meter(res.usage);
        return res;
      } catch (e) {
        meter(usageOf(e));
        throw e;
      } finally {
        if (!row) row = reservation;
        else await reservation.release();
        await row.settle({ usage: spent, ok: true });
      }
    };
    let out;
    try {
      out = await ask(buildLocateUser(toLocate, doc.name as string, page), pageB64, 500);
    } catch (e) {
      // The coarse pass did not fit the month (or the ledger cannot be
      // read): nothing was sent — said as the gate's refusal.
      if (e instanceof GovernedCallError) return NextResponse.json({ ...free(), ...skipFor(e) });
      throw e;
    }

    let located = parseLocateResponse(out.text, toLocate);

    // ── Passes 2-3: refine, zooming in each time. One glance at a whole
    //    E-size sheet gets the model to the right NEIGHBORHOOD; precision
    //    comes from cropping that neighborhood and asking again at full
    //    legibility, then repeating on the tighter answer. Global position =
    //    crop offset + fraction-within-crop, composed across passes.
    //
    //    One pass at 1/3 of the sheet still leaves a marker that reads as
    //    "somewhere around here" — on a 34-inch sheet a third is a foot of
    //    paper. The second pass at 1/9 gets it onto the label itself, which
    //    is the difference between a vague circle and a highlighter swipe.
    //    Bounded per request; a refine that fails on a provider error keeps
    //    the coarser point, so this is never worse than the pass before it.
    //
    //    A close-up that does NOT see the tag is different: it just failed to
    //    confirm the coarse point — the classic symptom of the model pointing
    //    at the equipment summary row instead of the drawn vessel. That point
    //    is not kept: one RELOCATE round asks again on the whole page, told
    //    where the wrong answer was (buildRelocateUser, DWG-13 / PR-10); if
    //    that finds nothing either, the tag is reported not visible and
    //    nothing is cached. A point no close-up checked (beyond REFINE_MAX,
    //    or once the loop stops on time, cap, a provider error or the canvas)
    //    keeps its coarse estimate — refuted by nothing, cached as approximate.
    //    Each extra call reserves its own worst case first (GOV-13): one that
    //    no longer fits ends the refining there, as the clock does.
    const REFINE_MAX = 4;
    const CROP_DIVISORS = [3, 9];
    /** Room each extra call needs to render, call, and still return. */
    const roomForACall = () => Date.now() - startedAt <= LOCATE_BUDGET_MS - 8_000;
    const unconfirmed = new Set<string>();
    try {
      const { createCanvas, loadImage } = await import("@napi-rs/canvas");
      const base = await loadImage(Buffer.from(img as ArrayBuffer));
      for (const pos of located.slice(0, REFINE_MAX)) {
        for (const divisor of CROP_DIVISORS) {
          // Each extra call is reserved before it is made (GOV-13 / DWG-5): a
          // refusal throws inside ask, below, and ends the refining.
          if (!roomForACall()) break;
          const cw = Math.max(200, Math.round(base.width / divisor));
          const ch = Math.max(200, Math.round(base.height / divisor));
          const cx = Math.min(Math.max(Math.round(pos.nx * base.width - cw / 2), 0), base.width - cw);
          const cy = Math.min(Math.max(Math.round(pos.ny * base.height - ch / 2), 0), base.height - ch);
          const outW = 1400;
          const outH = Math.round(ch * (outW / cw));
          const canvas = createCanvas(outW, outH);
          canvas.getContext("2d").drawImage(base, cx, cy, cw, ch, 0, 0, outW, outH);
          const cropB64 = canvas.toBuffer("image/png").toString("base64");
          let fp: TagPosition | undefined;
          try {
            const fine = await ask(
              `This is a CROPPED CLOSE-UP of one region of "${doc.name}", page ${page}. ` +
              `Locate exactly one tag: ${pos.tag}`,
              cropB64, 200,
            );
            fp = parseLocateResponse(fine.text, [pos.tag])[0];
          } catch { break; /* provider error, or the cap: keep the coarser point */ }
          if (!fp) {
            // Not seen up close. The first close-up refutes the coarse
            // point; a later one only fails to tighten an already-confirmed
            // one, which is kept.
            if (divisor === CROP_DIVISORS[0]) unconfirmed.add(pos.tag);
            break;
          }
          pos.nx = (cx + fp.nx * cw) / base.width;
          pos.ny = (cy + fp.ny * ch) / base.height;
        }
      }
    } catch { /* canvas unavailable — coarse points still ship */ }

    if (unconfirmed.size > 0) {
      const wrong: Record<string, [number, number]> = {};
      for (const p of located) if (unconfirmed.has(p.tag)) wrong[p.tag] = [p.nx, p.ny];
      let relocated: TagPosition[] = [];
      if (roomForACall()) {
        try {
          const again = await ask(
            buildRelocateUser([...unconfirmed], doc.name as string, page, wrong), pageB64, 300);
          relocated = parseLocateResponse(again.text, [...unconfirmed])
            // The same wrong spot again is not a second opinion.
            .filter((r) => Math.hypot(r.nx - wrong[r.tag][0], r.ny - wrong[r.tag][1]) > 0.02);
        } catch { /* no second opinion (a provider error, or the cap) — the unconfirmed points are dropped below */ }
      }
      const byTag = new Map(relocated.map((r) => [r.tag, r]));
      located = located.flatMap((p) => !unconfirmed.has(p.tag) ? [p] : byTag.has(p.tag) ? [byTag.get(p.tag)!] : []);
    }

    // Cache, as the model's ESTIMATE (pos_source 'vision' — drawn as
    // approximate): the next person to ask pays nothing, until a rev-up or
    // a rebuild clears it, or a viewer rejects it.
    for (const pos of located) {
      await supabaseAdmin.from("knowledge_page_entities")
        .update({ nx: pos.nx, ny: pos.ny, pos_source: "vision" })
        .eq("document_id", documentId).eq("page", page).eq("tag", pos.tag)
        .then(() => undefined, () => undefined);
      found.set(pos.tag, visionMark(pos));
    }
    return NextResponse.json({
      positions: [...found.values()],
      notOnPage: trulyAbsent,
      elsewhere,
      // Named honestly: "the model looked and couldn't see it" is different
      // from "we never looked".
      notVisible: toLocate.filter((t) => !found.has(t)),
    });
  } catch (e) {
    failed = true;
    // Locating is an enhancement — never let it break opening the sheet.
    return NextResponse.json({
      positions: [...found.values()],
      notOnPage: trulyAbsent,
      elsewhere,
      skipped: `Couldn't point at those tags: ${(e as Error).message}`,
    });
  } finally {
    // ONE metering row covering every call this request made — the first
    // call's reservation, settled once more with the request's outcome
    // (DWG-5): nothing spent goes unrecorded.
    const metered = row as AiReservation | null;
    if (metered) await metered.settle({ usage: spent, ok: !failed });
  }
}
