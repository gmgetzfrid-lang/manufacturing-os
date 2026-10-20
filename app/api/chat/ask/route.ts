// /api/chat/ask — one streamed turn of a conversation, persisted either side.
//
// POST { orgId, scope, libraryId?, threadId?, question, mode?, focus?,
//        inputs?, approved?, attachments? }
//   → application/x-ndjson, one JSON object per line:
//       { t: "thread",  thread }            the conversation (created if new)
//       { t: "user",    message }           the question, already saved
//       { t: "status",  text }              what the engine is doing right now
//       { t: "delta",   text }              a piece of the answer as it streams
//       { t: "reset" }                      discard streamed text, it restarts
//       { t: "result",  message, reply }    the saved answer + the engine's reply
//       { t: "error",   status, error, … }  the engine refused or failed
//
// What this route owns, and the engines do not:
//   • the thread: load or create it, keep its title and last-activity fresh
//   • the turns: the question is written BEFORE the engine runs (a question
//     that outlives a crash is still a question), the answer after
//   • the context the shell adds: per-thread instructions, the asker's
//     profile, prior turns, and the asker's own attachments as images
//   • attachments are context for THIS turn only — read from storage, handed
//     to the model, never indexed into a library

import { NextRequest } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { handleKnowledgeAsk } from "@/lib/ask/knowledgeAskHandler";
import { handleOrchestrator } from "@/lib/ask/orchestratorHandler";
import type { AskEvent, AskHandlerResult } from "@/lib/ask/types";
import { renderKnowledgePages } from "@/lib/knowledgePageRender";
import type { AiCallImage } from "@/lib/ai/providerCall";

export const runtime = "nodejs";
export const maxDuration = 120;

type Scope = "library" | "tools" | "internet";
const SCOPES: Scope[] = ["library", "tools", "internet"];

interface AttachmentRef {
  id: string;
  kind: "image" | "pdf";
  name: string;
  path: string;
  size: number;
  mediaType: string;
}

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_PDF_PAGES = 3;

/** Errors that mean the question never ran (precondition failed). The saved
 *  question is withdrawn so the thread doesn't keep a dangling turn. */
const PRECONDITION = new Set([400, 401, 402, 403, 404, 412, 428]);

async function authUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (error || !user) return null;
  return user;
}

const line = (obj: Record<string, unknown>) => JSON.stringify(obj) + "\n";

export async function POST(req: NextRequest) {
  const user = await authUser(req);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return Response.json({ error: "Expected JSON body" }, { status: 400 }); }

  const orgId = String(body.orgId ?? "").trim();
  const scope = SCOPES.includes(body.scope as Scope) ? (body.scope as Scope) : "library";
  const libraryId = typeof body.libraryId === "string" && body.libraryId ? body.libraryId : null;
  const threadIdIn = typeof body.threadId === "string" && /^[0-9a-f-]{36}$/i.test(body.threadId) ? body.threadId : null;
  const question = String(body.question ?? "").trim().slice(0, 2000);
  if (!orgId || !question) return Response.json({ error: "orgId and question are required" }, { status: 400 });
  if (scope !== "tools" && !libraryId) return Response.json({ error: "libraryId is required for this scope" }, { status: 400 });

  const { data: member } = await supabaseAdmin
    .from("org_members").select("uid, display_name, email")
    .eq("org_id", orgId).eq("uid", user.id).eq("status", "active")
    .maybeSingle();
  if (!member) return Response.json({ error: "Not a member of this workspace" }, { status: 403 });
  const userName = (member.display_name as string) || (member.email as string) || "Member";

  // Attachments: only keys under this org's chat prefix are ever read.
  const attachments: AttachmentRef[] = (Array.isArray(body.attachments) ? body.attachments : [])
    .filter((a): a is AttachmentRef =>
      !!a && typeof a === "object"
      && typeof (a as AttachmentRef).path === "string"
      && (a as AttachmentRef).path.startsWith(`orgs/${orgId}/chat/`)
      && !(a as AttachmentRef).path.includes("..")
      && ((a as AttachmentRef).kind === "image" || (a as AttachmentRef).kind === "pdf"))
    .slice(0, 6)
    .map((a) => ({
      id: String(a.id ?? ""), kind: a.kind, name: String(a.name ?? "").slice(0, 160),
      path: a.path, size: Number(a.size ?? 0), mediaType: String(a.mediaType ?? ""),
    }));

  // ── The thread ───────────────────────────────────────────────────────────
  let thread: Record<string, unknown> | null = null;
  if (threadIdIn) {
    const { data } = await supabaseAdmin.from("chat_threads").select("*")
      .eq("id", threadIdIn).eq("org_id", orgId).maybeSingle();
    if (!data) return Response.json({ error: "Conversation not found" }, { status: 404 });
    thread = data as Record<string, unknown>;
  } else {
    const { data, error } = await supabaseAdmin.from("chat_threads").insert({
      org_id: orgId, scope, library_id: scope === "tools" ? null : libraryId,
      title: question.slice(0, 120),
      created_by: user.id, created_by_name: userName,
    }).select("*").maybeSingle();
    if (error || !data) {
      const missing = error?.code === "42P01" || /does not exist/i.test(error?.message ?? "");
      return Response.json({
        error: missing
          ? "The chat tables are missing — run migration 20261019_chat_shell.sql in Supabase."
          : (error?.message ?? "Couldn't start the conversation."),
      }, { status: missing ? 409 : 500 });
    }
    thread = data as Record<string, unknown>;
  }
  const threadId = thread.id as string;
  const threadScope = (thread.scope as Scope) ?? scope;
  const threadLibrary = (thread.library_id as string | null) ?? libraryId;

  // ── Context the shell adds ───────────────────────────────────────────────
  const [profileRes, priorRes] = await Promise.all([
    supabaseAdmin.from("chat_user_profiles").select("discipline, units, notes")
      .eq("org_id", orgId).eq("user_id", user.id).maybeSingle(),
    supabaseAdmin.from("chat_messages").select("role, content, status, payload")
      .eq("thread_id", threadId).eq("status", "done")
      .order("created_at", { ascending: false }).limit(16),
  ]);
  const profile = (profileRes.data ?? null) as { discipline?: string | null; units?: string | null; notes?: string | null } | null;
  const profileLines = [
    profile?.discipline ? `- Discipline: ${String(profile.discipline).slice(0, 120)}` : "",
    profile?.units ? `- Preferred units: ${String(profile.units).slice(0, 60)}` : "",
    profile?.notes ? `- Notes: ${String(profile.notes).slice(0, 600)}` : "",
  ].filter(Boolean);
  const instructions = String(thread.instructions ?? "").trim().slice(0, 2000);
  const extraSystem =
    (profileLines.length > 0
      ? "\n\nABOUT THE ASKER (their own standing profile — tailor units, depth and vocabulary to it):\n" + profileLines.join("\n")
      : "") +
    (instructions
      ? "\n\nINSTRUCTIONS FOR THIS CONVERSATION (from the asker — follow them for every answer in it):\n" + instructions
      : "");

  // Prior turns, oldest first, paired question → answer.
  const priorTurns: Array<{ question: string; answer: string }> = [];
  {
    const rows = ((priorRes.data ?? []) as Array<{ role: string; content: string }>).reverse();
    let pendingQ: string | null = null;
    for (const r of rows) {
      if (r.role === "user") pendingQ = r.content;
      else if (r.role === "assistant" && pendingQ !== null && r.content) {
        priorTurns.push({ question: pendingQ, answer: r.content });
        pendingQ = null;
      }
    }
  }

  // Pages the last three answers cited, decisive proof first — the
  // conversation's evidence, carried into the next turn so a follow-up
  // never loses the passage it is following up on.
  const pinned: Array<{ documentId: string; page: number }> = [];
  {
    const roleRank = (r: unknown) => r === "decides" ? 0 : r === "limits" ? 1 : 2;
    const answers = ((priorRes.data ?? []) as Array<{ role: string; payload: unknown }>)
      .filter((r) => r.role === "assistant").slice(0, 3);
    const seen = new Set<string>();
    for (const r of answers) {
      const cites = ((r.payload as { citations?: unknown } | null)?.citations ?? []) as Array<{
        documentId?: unknown; page?: unknown; role?: unknown; url?: unknown;
      }>;
      if (!Array.isArray(cites)) continue;
      for (const c of [...cites].sort((a, b) => roleRank(a.role) - roleRank(b.role))) {
        if (c.url || typeof c.documentId !== "string" || typeof c.page !== "number") continue;
        const key = `${c.documentId}:${c.page}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pinned.push({ documentId: c.documentId, page: c.page });
      }
    }
    pinned.splice(12);
  }

  // ── The question, saved before anything runs ─────────────────────────────
  const userPayload: Record<string, unknown> = {};
  if (Array.isArray(body.focus) && body.focus.length > 0) userPayload.focus = body.focus;
  if (typeof body.inputs === "string" && body.inputs) userPayload.inputs = body.inputs;
  if (body.useWeb === true) userPayload.useWeb = true;
  const { data: userMsg } = await supabaseAdmin.from("chat_messages").insert({
    org_id: orgId, thread_id: threadId, role: "user", content: question,
    payload: Object.keys(userPayload).length > 0 ? userPayload : null,
    attachments: attachments.length > 0 ? attachments : null,
    user_id: user.id, user_name: userName, status: "done",
  }).select("*").maybeSingle();

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: Record<string, unknown>) => {
        try { controller.enqueue(encoder.encode(line(obj))); } catch { /* client went away */ }
      };
      // Keep intermediaries from closing an idle connection mid-think.
      const ping = setInterval(() => send({ t: "ping" }), 10_000);
      try {
        send({ t: "thread", thread });
        if (userMsg) send({ t: "user", message: userMsg });

        // Attachments → images for the model.
        let userImages: AiCallImage[] = [];
        if (attachments.length > 0) {
          send({ t: "status", text: `Reading ${attachments.length} attachment${attachments.length === 1 ? "" : "s"}` });
          userImages = await loadAttachmentImages(attachments);
        }

        const emit = (ev: AskEvent) => send(ev as unknown as Record<string, unknown>);
        let result: AskHandlerResult;
        if (threadScope === "tools") {
          result = await handleOrchestrator({
            user: { id: user.id },
            body: { orgId, question, approved: body.approved ?? [] },
            emit, extraSystem, userImages, priorTurns,
          });
        } else {
          result = await handleKnowledgeAsk({
            user: { id: user.id },
            body: {
              orgId, libraryId: threadLibrary, question,
              mode: threadScope === "internet" ? "internet" : "library",
              focus: body.focus, inputs: body.inputs, answerMode: body.answerMode,
              useWeb: body.useWeb === true,
              history: priorTurns.slice(-4), threadId, pinned,
            },
            emit, extraSystem, userImages,
          });
        }

        if (result.status !== 200) {
          if (PRECONDITION.has(result.status) && userMsg) {
            await supabaseAdmin.from("chat_messages").delete().eq("id", userMsg.id as string);
            // A brand-new thread with nothing in it is noise in the rail.
            if (!threadIdIn) await supabaseAdmin.from("chat_threads").delete().eq("id", threadId);
          } else {
            await supabaseAdmin.from("chat_messages").insert({
              org_id: orgId, thread_id: threadId, role: "assistant", content: "",
              payload: { kind: threadScope === "tools" ? "tools" : "library", question },
              user_id: user.id, user_name: userName, status: "error",
              error: String(result.json.error ?? "The question failed."),
            });
          }
          send({ t: "error", status: result.status, ...result.json, threadId, withdrawn: PRECONDITION.has(result.status) });
          return;
        }

        const reply = result.json;
        const answer = String(reply.answer ?? "");
        // Remember which revision each cited document was on. A past answer
        // replayed later can then say "the source moved on" instead of
        // quietly answering from yesterday's paper.
        const citedRevs = await citedRevisions(reply.citations);
        const { data: assistantMsg } = await supabaseAdmin.from("chat_messages").insert({
          org_id: orgId, thread_id: threadId, role: "assistant", content: answer,
          payload: {
            kind: threadScope === "tools" ? "tools" : "library", question, ...reply,
            ...(citedRevs ? { citedRevs } : {}),
          },
          user_id: user.id, user_name: userName, status: "done",
        }).select("*").maybeSingle();
        await supabaseAdmin.from("chat_threads").update({
          last_message_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          ...(String(thread?.title ?? "").trim() ? {} : { title: question.slice(0, 120) }),
        }).eq("id", threadId);
        send({ t: "result", message: assistantMsg, reply, threadId });
      } catch (e) {
        send({ t: "error", status: 500, error: e instanceof Error ? e.message : "The question failed.", threadId });
      } finally {
        clearInterval(ping);
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

/** Read the asker's attachments from storage as model images: images as
 *  they are (bounded), PDFs as their first pages rendered. Best-effort —
 *  an unreadable attachment is skipped, never a reason the turn fails. */
async function loadAttachmentImages(attachments: AttachmentRef[]): Promise<AiCallImage[]> {
  const out: AiCallImage[] = [];
  for (const a of attachments) {
    if (out.length >= MAX_IMAGES) break;
    try {
      if (a.kind === "image") {
        if (a.size > MAX_IMAGE_BYTES) continue;
        const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: a.path }));
        const bytes = Buffer.from(await new Response(obj.Body as ReadableStream).arrayBuffer());
        if (bytes.length > MAX_IMAGE_BYTES) continue;
        const mediaType = /^image\/(png|jpeg|webp|gif)$/.test(a.mediaType) ? a.mediaType : "image/png";
        out.push({ base64: bytes.toString("base64"), mediaType });
      } else {
        const pages = await renderKnowledgePages(a.path, [1, 2, 3], MAX_PDF_PAGES);
        for (const p of pages) {
          if (out.length >= MAX_IMAGES) break;
          out.push({ base64: p.base64, mediaType: p.mediaType });
        }
      }
    } catch { /* skip */ }
  }
  return out;
}

/** { documentId → source_rev | "" } for every library document an answer
 *  cites. Null when nothing was cited or the lookup fails. */
async function citedRevisions(citations: unknown): Promise<Record<string, string> | null> {
  try {
    const ids = [...new Set((Array.isArray(citations) ? citations : [])
      .map((c) => (c as { documentId?: unknown }).documentId)
      .filter((id): id is string => typeof id === "string" && id.length > 0))].slice(0, 40);
    if (ids.length === 0) return null;
    const { data } = await supabaseAdmin.from("knowledge_documents").select("id, source_rev").in("id", ids);
    const out: Record<string, string> = {};
    for (const d of (data ?? []) as Array<{ id: string; source_rev: string | null }>) out[d.id] = d.source_rev ?? "";
    return out;
  } catch {
    return null;
  }
}
