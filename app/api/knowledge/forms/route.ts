// /api/knowledge/forms — fill a library form from a conversation.
//
// POST { action: "draft", orgId, documentId, question, answer, citations, goal? }
//   → { form: { documentId, name, title, purpose, fillable, fields: [{…, value}] },
//       needsInput: [fieldName], notes }
//   Drafts every field from the answer and its quoted proof, on the asker's
//   own key and main model (a justification is reasoning, not cataloging).
//   Fields only a person can supply — names, signatures, approval numbers —
//   are left blank and listed in needsInput, never invented.
//
// POST { action: "render", orgId, documentId, values }
//   → application/pdf. Fillable PDFs are filled in place and left editable;
//   flat ones become completed pages followed by the original form.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { openAiKey } from "@/lib/ai/keyVault";
import { ALLOWED_PROVIDERS, type AiUsage } from "@/lib/ai/pricing";
import { getMonthUsage, getCapUsd, recordAskUsage } from "@/lib/ai/usageServer";
import { callAiModel, type AiProviderId } from "@/lib/ai/providerCall";
import { fetchBytes } from "@/lib/r2Bytes";
import { loadPrincipal, readableControlledDocIds } from "@/lib/knowledgeAccess";
import { profilesFor, readPdfFormFields } from "@/lib/knowledgeCatalogServer";
import { parseModelJson, slugField, FORM_PURPOSE_LABEL, type FormField } from "@/lib/knowledgeCatalog";
import { fillAcroForm, buildCompletedForm } from "@/lib/formFill";
import { jobModel } from "@/lib/ai/jobModelsServer";

export const runtime = "nodejs";
export const maxDuration = 120;

async function authUser(req: NextRequest) {
  const h = req.headers.get("authorization");
  if (!h?.startsWith("Bearer ")) return null;
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(h.slice(7));
  return error || !user ? null : user;
}

type DocRow = { id: string; org_id: string; library_id: string; name: string; file_key: string | null; source_document_id: string | null };

/** The form document, if this user may read it. Controlled-document mirrors
 *  inherit document-control ACLs, exactly as retrieval does. */
async function loadForm(orgId: string, uid: string, documentId: string): Promise<DocRow | null> {
  const { data } = await supabaseAdmin
    .from("knowledge_documents").select("id, org_id, library_id, name, file_key, source_document_id")
    .eq("id", documentId).eq("org_id", orgId).maybeSingle();
  const doc = data as DocRow | null;
  if (!doc) return null;
  if (doc.source_document_id) {
    const principal = await loadPrincipal(orgId, uid);
    if (!principal) return null;
    const readable = await readableControlledDocIds(principal, [doc.source_document_id]);
    if (!readable.has(doc.source_document_id)) return null;
  }
  return doc;
}

/** The form's fields: the catalog profile's, else read live from the PDF. */
async function formFields(doc: DocRow): Promise<{ fields: FormField[]; fillable: boolean; title: string; purpose: string }> {
  const profile = (await profilesFor(supabaseAdmin, [doc.id])).get(doc.id);
  if (profile?.form && profile.form.fields.length > 0) {
    return {
      fields: profile.form.fields, fillable: profile.form.fillable, title: profile.title,
      purpose: FORM_PURPOSE_LABEL[profile.form.purpose],
    };
  }
  if (doc.file_key) {
    try {
      const live = await readPdfFormFields(new Uint8Array(await fetchBytes(doc.file_key)));
      if (live.length > 0) {
        return {
          fields: live.map((f, i) => ({ name: f.name, label: f.name.replace(/[_.]+/g, " ").trim() || slugField("", i), kind: f.kind, ...(f.options ? { options: f.options } : {}) })),
          fillable: true, title: profile?.title ?? doc.name.replace(/\.pdf$/i, ""), purpose: "Form",
        };
      }
    } catch { /* fall through */ }
  }
  return { fields: [], fillable: false, title: profile?.title ?? doc.name.replace(/\.pdf$/i, ""), purpose: "Form" };
}

const DRAFT_SYSTEM =
  "You fill in an engineering form for a refinery engineer, from their conversation with the site's " +
  "engineering-standards assistant. Reply with ONLY JSON:\n" +
  '{"values": {"<field name>": "<value>"}, "needsInput": ["<field name>"], "notes": "<one or two sentences for the engineer>"}\n' +
  "Rules:\n" +
  "- Use the EXACT field names given. Write values the way an experienced engineer would on this form: " +
  "clear, specific, professional, no markdown.\n" +
  "- Narrative fields (justification, description, reason, technical basis, risk, mitigation): complete " +
  "text built from the answer and its quoted proof. Cite standards by designation, section/table and page " +
  "(\"EP 5-2-1 Table 4, p.20\") — never [n] markers. Quote the requirement being deviated from exactly.\n" +
  "- State the requirement, the proposed alternative, why the requirement exists, why that reason does or " +
  "does not apply here, and the mitigations — in that order — wherever the form gives room for it.\n" +
  "- Never invent facts the conversation doesn't contain: no line numbers, equipment tags, dates, names, " +
  "signatures, approval or reference numbers. Leave those fields \"\" and list them in needsInput.\n" +
  "- Checkbox fields: \"Yes\" or \"\". Choice fields: exactly one of the listed options, or \"\".\n" +
  "- Use ONLY what the question, the answer and the quoted proof contain. Never add engineering content, " +
  "reasons, values or code requirements of your own — if the form asks for something they don't cover, " +
  "leave it \"\" and list it in needsInput.";

export async function POST(req: NextRequest) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Expected JSON body" }, { status: 400 }); }
  const orgId = String(body.orgId ?? "");
  const documentId = String(body.documentId ?? "");
  if (!orgId || !documentId) return NextResponse.json({ error: "orgId and documentId are required" }, { status: 400 });
  const { data: member } = await supabaseAdmin
    .from("org_members").select("uid, display_name, email")
    .eq("org_id", orgId).eq("uid", user.id).eq("status", "active").maybeSingle();
  if (!member) return NextResponse.json({ error: "Not a member of this workspace" }, { status: 403 });
  const doc = await loadForm(orgId, user.id, documentId);
  if (!doc) return NextResponse.json({ error: "Form not found, or you don't have access to it." }, { status: 404 });
  const meta = await formFields(doc);

  // ── Render: values → PDF ──────────────────────────────────────────────
  if (body.action === "render") {
    const raw = (body.values ?? {}) as Record<string, unknown>;
    const values: Record<string, string> = {};
    for (const f of meta.fields) if (typeof raw[f.name] === "string") values[f.name] = (raw[f.name] as string).slice(0, 8000);
    const original = doc.file_key ? new Uint8Array(await fetchBytes(doc.file_key)) : null;
    let bytes: Uint8Array;
    if (meta.fillable && original) {
      bytes = (await fillAcroForm(original, values)).bytes;
    } else {
      bytes = await buildCompletedForm({
        original, title: meta.title, sourceName: doc.name, fields: meta.fields, values,
        preparedBy: (member.display_name as string) || (member.email as string) || "Member",
      });
    }
    await supabaseAdmin.from("audit_logs").insert({
      action: "KNOWLEDGE_FORM_FILLED", resource_type: "knowledge_document", resource_id: doc.id,
      org_id: orgId, user_id: user.id, details: { form: doc.name, fillable: meta.fillable },
    }).then(() => undefined, () => undefined);
    const filename = `${doc.name.replace(/\.pdf$/i, "")} - completed.pdf`.replace(/["\\]/g, "");
    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  // ── Draft: conversation → field values ────────────────────────────────
  if (body.action !== "draft") return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  if (meta.fields.length === 0) {
    return NextResponse.json({
      error: "This form's fields aren't mapped yet. Open its library and press \"Map the library\", then try again.",
    }, { status: 409 });
  }
  const { data: conn } = await supabaseAdmin
    .from("ai_connections").select("provider, model, api_key")
    .eq("org_id", orgId).eq("user_id", user.id).maybeSingle();
  if (!conn || !ALLOWED_PROVIDERS.includes(conn.provider as AiProviderId)) {
    return NextResponse.json({ error: "Add your Claude or OpenAI key in AI settings first." }, { status: 412 });
  }
  const [spent, cap] = await Promise.all([getMonthUsage(orgId, user.id), getCapUsd(orgId, user.id)]);
  if (cap > 0 && spent.spentUsd >= cap) {
    return NextResponse.json({ error: `Monthly AI budget reached ($${spent.spentUsd.toFixed(2)} of $${cap.toFixed(2)}).` }, { status: 402 });
  }
  // The form's own printed instructions guide how it's filled.
  const { data: formText } = await supabaseAdmin
    .from("knowledge_chunks").select("content").eq("document_id", doc.id)
    .order("page", { ascending: true }).order("seq", { ascending: true }).limit(8);
  const citations = (Array.isArray(body.citations) ? body.citations : []).slice(0, 12) as Array<Record<string, unknown>>;
  const proof = citations.map((c) =>
    `- ${String(c.documentName ?? "Document")}${c.section ? `, ${String(c.section)}` : ""}, p.${String(c.page ?? "?")}: "${String(c.highlight ?? c.quote ?? "").slice(0, 500)}"`).join("\n");
  const usage: AiUsage = { inputTokens: 0, outputTokens: 0 };
  const model = await jobModel(orgId, user.id, { provider: conn.provider as string, model: conn.model as string }, "drafting");
  try {
    const out = await callAiModel({
      provider: conn.provider as AiProviderId, model, apiKey: openAiKey(conn.api_key as string),
      system: DRAFT_SYSTEM,
      user: [
        `FORM: ${meta.title} (${meta.purpose}) — file "${doc.name}"`,
        `FIELDS (name | label | kind | options):\n${meta.fields.map((f) => `${f.name} | ${f.label} | ${f.kind}${f.options ? ` | ${f.options.join(" / ")}` : ""}`).join("\n")}`,
        `THE FORM'S OWN TEXT (instructions printed on it):\n${((formText ?? []) as Array<{ content: string }>).map((c) => c.content).join("\n").slice(0, 4000) || "(none)"}`,
        body.goal ? `WHAT THE ENGINEER IS DOING: ${String(body.goal).slice(0, 300)}` : "",
        `THEIR QUESTION: ${String(body.question ?? "").slice(0, 1500)}`,
        `THE ASSISTANT'S ANSWER:\n${String(body.answer ?? "").slice(0, 9000)}`,
        proof ? `QUOTED PROOF:\n${proof}` : "",
        `Today is ${new Date().toISOString().slice(0, 10)}.`,
      ].filter(Boolean).join("\n\n"),
      maxTokens: 4000,
    });
    usage.inputTokens += out.usage.inputTokens;
    usage.outputTokens += out.usage.outputTokens;
    const parsed = parseModelJson(out.text) ?? {};
    const rawValues = (parsed.values ?? {}) as Record<string, unknown>;
    const needsInput = (Array.isArray(parsed.needsInput) ? parsed.needsInput : []).map(String)
      .filter((n) => meta.fields.some((f) => f.name === n));
    const fields = meta.fields.map((f) => {
      let value = typeof rawValues[f.name] === "string" ? (rawValues[f.name] as string).trim() : "";
      if (f.kind === "choice" && f.options && value && !f.options.includes(value)) {
        value = f.options.find((o) => o.toLowerCase() === value.toLowerCase()) ?? "";
      }
      return { ...f, value };
    });
    // A blank field nobody flagged still needs a person.
    for (const f of fields) if (!f.value && !needsInput.includes(f.name)) needsInput.push(f.name);
    await recordAskUsage({ orgId, userId: user.id, provider: conn.provider as string, model, usage, ok: true, op: "formDraft" });
    return NextResponse.json({
      form: { documentId: doc.id, name: doc.name, title: meta.title, purpose: meta.purpose, fillable: meta.fillable, fields },
      needsInput,
      notes: typeof parsed.notes === "string" ? parsed.notes.slice(0, 600) : "",
    });
  } catch (e) {
    await recordAskUsage({ orgId, userId: user.id, provider: conn.provider as string, model, usage, ok: false, op: "formDraft" });
    return NextResponse.json({ error: `Couldn't draft the form: ${(e as Error).message}` }, { status: 502 });
  }
}
