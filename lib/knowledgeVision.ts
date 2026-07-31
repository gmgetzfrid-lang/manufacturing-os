// lib/knowledgeVision.ts — SERVER-ONLY. Read pages that have NO text layer.
//
// Two very common cases produce PDFs with no machine-readable text:
//
//   1. AutoCAD exports using SHX shape fonts. The PDF is genuine vector —
//      but SHX text plots as LINE-WORK shaped like letters, not text
//      objects. Every equipment tag is invisible to extraction. (TrueType
//      text in the same drawing survives; that's why some sheets look
//      half-readable.)
//   2. Scanned paper.
//
// Both are solved the same way a human solves them: LOOK at the page. We
// render the page and have the asker's own AI model transcribe it. The
// transcript then flows through the normal pipeline — chunks, tags,
// references, citations — so a vision-read sheet is a first-class citizen.
//
// Cost control: transcription runs on a CHEAP model tier by default (bulk
// OCR does not need a frontier model), is billed to the user who triggered
// indexing, metered as its own op, and stops at their monthly cap.

import { callAiModel, type AiProviderId } from "@/lib/ai/providerCall";

/** Bulk transcription tier per provider — ~10× cheaper than frontier and
 *  entirely adequate for reading tags off a drawing. Falls back to the
 *  user's configured model if the provider rejects this one. */
export const VISION_MODEL: Record<AiProviderId, string> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4o-mini",
  gemini: "gemini-2.5-flash",
};

const VISION_SYSTEM =
  "You transcribe engineering documents from page images so they become searchable. " +
  "Output ONLY the transcription — no preamble, no commentary, no markdown fences.\n\n" +
  "Transcribe EVERYTHING legible on the page:\n" +
  "- every equipment tag, line number, valve tag, instrument bubble (V-3, P-101A, PSV-2001, " +
  "6\"-P-1024-A1A) exactly as written;\n" +
  "- every off-page connector / continuation reference with its drawing number and the direction " +
  "or service it names (e.g. 'TO 025-PID-0107', 'CONT ON DWG 21-D-1105');\n" +
  "- the title block: drawing number, title, revision, unit, sheet;\n" +
  "- all notes, legends, and callouts, in reading order;\n" +
  "- table contents row by row, keeping columns aligned with ' | ' separators.\n\n" +
  "Preserve exact alphanumerics — a tag transcribed wrong is worse than one omitted. " +
  "If a region is genuinely illegible, write [illegible] rather than guessing.";

export interface VisionResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}

/** Transcribe one rendered page. Throws on hard provider failure (the
 *  caller decides whether that kills the batch). */
export async function transcribePageImage(input: {
  provider: AiProviderId;
  fallbackModel: string;
  apiKey: string;
  base64: string;
  mediaType: string;
  /** Shown to the model for context — helps it read the title block. */
  documentName: string;
  page: number;
}): Promise<VisionResult> {
  const { provider, apiKey, base64, mediaType, documentName, page } = input;
  const user =
    `Transcribe this page. It is page ${page} of "${documentName}".`;

  const attempt = async (model: string) => {
    const out = await callAiModel({
      provider, model, apiKey,
      system: VISION_SYSTEM,
      user,
      maxTokens: 4000,
      images: [{ base64, mediaType }],
    });
    return { text: out.text, usage: out.usage, model };
  };

  const cheap = VISION_MODEL[provider];
  try {
    return await attempt(cheap);
  } catch (e) {
    // 400/404 = this account can't use the cheap tier; use their model.
    const status = (e as { status?: number }).status ?? 0;
    if (status === 404 || status === 400) return await attempt(input.fallbackModel);
    throw e;
  }
}
