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
import {
  OPC_LINE_FORMAT, OPC_LINE_EXAMPLE, OPC_NO_DRAWING, TITLE_BLOCK_OPEN, TITLE_BLOCK_CLOSE,
} from "@/lib/drawingText";

/** Bulk transcription tier per provider — ~10× cheaper than frontier and
 *  entirely adequate for reading tags off a drawing. Falls back to the
 *  user's configured model if the provider rejects this one. */
export const VISION_MODEL: Record<AiProviderId, string> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4o-mini",
  gemini: "gemini-2.5-flash",
};

// The lines the drawing parsers read back (lib/drawingText.ts) are built
// from that module's own constants, so this prompt and its parsers share ONE
// contract: connector lines parseOpcBoxes can match (DWG-4), line numbers
// labelled so they never count as equipment (DWG-2), and a fenced title
// block extractTitleBlock reads alone (PR-11). Exported for the tests.
export const VISION_SYSTEM =
  "You transcribe engineering documents from page images so they become searchable. " +
  "Output ONLY the transcription — no preamble, no commentary, no markdown fences.\n\n" +
  "Transcribe EVERYTHING legible on the page:\n" +
  "- every equipment tag, valve tag and instrument bubble (V-3, P-101A, PSV-2001) exactly as " +
  "written;\n" +
  "- every pipe line number on its own line, labelled LINE, exactly as written (e.g. " +
  "'LINE 6\"-P-1024-A1A') — a line number is never an equipment tag;\n" +
  "- every off-page connector (the numbered box or pennant at the sheet edge) on its own line, " +
  `EXACTLY in this form: ${OPC_LINE_FORMAT} — e.g. '${OPC_LINE_EXAMPLE}'. Put the destination ` +
  "drawing number FIRST, right after the box number and the word DWG, exactly as written. Leave " +
  "out 'SH <sheet>' when the connector shows no sheet. If the connector shows no drawing number, " +
  `write ${OPC_NO_DRAWING} in its place. Any other continuation reference (e.g. 'CONT ON DWG ` +
  "21-D-1105 SH 3') is transcribed as written;\n" +
  "- the title block, from the border's own fields ONLY — never from a connector, a note or a " +
  "reference list — as labeled lines EXACTLY in this form, fenced so the sheet's identity is " +
  "machine-readable:\n" +
  `    ${TITLE_BLOCK_OPEN}\n` +
  "    DRAWING NO: <value from the drawing number field>\n" +
  "    SHEET: <n> OF <m>\n" +
  "    REV: <value>\n" +
  "    TITLE: <drawing title>\n" +
  `    ${TITLE_BLOCK_CLOSE}\n` +
  "  (write the fence once, only around the border's fields; leave out any field the border " +
  "does not show — never infer one from elsewhere on the sheet);\n" +
  "- all notes, legends, and callouts, in reading order;\n" +
  "- table contents row by row, keeping columns aligned with ' | ' separators. Put the table's " +
  "caption (e.g. 'TABLE 3 — BOLT TORQUE') on its own line DIRECTLY above its first row, and start " +
  "the rows with the header row. For figures/charts, transcribe the caption line, then describe " +
  "the figure in one sentence and list any values it presents.\n\n" +
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
  /** Hard stop, so a slow page can't outlive the serverless invocation and
   *  take the batch's uncommitted progress with it. */
  timeoutMs?: number;
  /** Org Playbooks block (standing instructions) appended to the system
   *  prompt — "vendor X drawings put the tag in the lower-right block". */
  instructions?: string;
}): Promise<VisionResult> {
  const { provider, apiKey, base64, mediaType, documentName, page } = input;
  const user =
    `Transcribe this page. It is page ${page} of "${documentName}".`;

  const attempt = async (model: string) => {
    const out = await callAiModel({
      provider, model, apiKey,
      system: VISION_SYSTEM + (input.instructions ?? ""),
      user,
      maxTokens: 4000,
      images: [{ base64, mediaType }],
      timeoutMs: input.timeoutMs,
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
