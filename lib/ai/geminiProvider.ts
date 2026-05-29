// lib/ai/geminiProvider.ts
//
// Google Gemini provider. Implements the AiProvider contract using
// `gemini-2.5-flash` — the current stable flash model. Generous free
// tier, native JSON-mode output (responseSchema), and noticeably
// better instruction-following than 2.0-flash for the extract /
// suggest tasks here. Override via GEMINI_MODEL env var if you want
// to point at -pro for higher quality or pin a specific revision.
//
// Per the directive:
//   - Non-mutating only (summarize / extract / suggest / handoff).
//   - Degrades to mockProvider if the SDK call throws or the API key
//     is missing — caller path is lib/ai/index.ts:getAiProvider().
//   - Never auto-applies output to the database. UI surfaces results
//     as suggestions for a human to commit.

import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import type { AiProvider, Entity } from "./types";
import { mockProvider } from "./mockProvider";

const MODEL_ID = process.env.GEMINI_MODEL || "gemini-2.5-flash";

function getClient(): GoogleGenerativeAI | null {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  return new GoogleGenerativeAI(key);
}

async function safeText(prompt: string, fallback: () => Promise<string>): Promise<string> {
  const client = getClient();
  if (!client) return fallback();
  try {
    const model = client.getGenerativeModel({ model: MODEL_ID });
    const result = await model.generateContent(prompt);
    const out = result.response.text().trim();
    return out || (await fallback());
  } catch {
    return fallback();
  }
}

export const geminiProvider: AiProvider = {
  name: `Google Gemini (${MODEL_ID})`,
  isReal: true,

  async summarize(text) {
    const trimmed = text.trim();
    if (!trimmed) return "Nothing to summarize.";
    return safeText(
      [
        "Summarize the following operator/engineer notes in ONE short paragraph (≤3 sentences, no headings, no bullets, no preamble). Plain prose only. Preserve equipment tags, MOC refs, and dates verbatim.",
        "",
        "Notes:",
        trimmed,
      ].join("\n"),
      () => mockProvider.summarize(text),
    );
  },

  async extractEntities(text) {
    const client = getClient();
    if (!client) return mockProvider.extractEntities(text);
    try {
      const model = client.getGenerativeModel({
        model: MODEL_ID,
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                kind: {
                  type: SchemaType.STRING,
                  description:
                    "One of: equipment, person, moc, date, document, deadline.",
                },
                text: {
                  type: SchemaType.STRING,
                  description: "The exact span as it appears in the source text.",
                },
              },
              required: ["kind", "text"],
            },
          },
        },
      });
      const result = await model.generateContent(
        [
          "Extract entities from these refinery/plant engineering notes. Be conservative — only return spans that clearly fit a category. Categories:",
          "  - equipment: equipment tags like E-204, P-101A, V-3201",
          "  - person: @mentions like @joe.smith",
          "  - moc: management-of-change refs like MOC-2024-051",
          "  - date: ISO-ish dates like 2026-07-15",
          "  - document: document numbers / drawing numbers",
          "  - deadline: explicit deadlines",
          "Return JSON array. Empty array if nothing fits.",
          "",
          "Notes:",
          text,
        ].join("\n"),
      );
      const raw = result.response.text();
      const parsed: Array<{ kind: string; text: string }> = JSON.parse(raw);
      const seen = new Set<string>();
      const out: Entity[] = [];
      for (const e of parsed) {
        if (!e?.kind || !e?.text) continue;
        const k = `${e.kind}::${e.text.toLowerCase()}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ kind: e.kind, text: e.text, confidence: 0.9 });
      }
      return out;
    } catch {
      return mockProvider.extractEntities(text);
    }
  },

  async suggestFollowups(text) {
    const client = getClient();
    if (!client) return mockProvider.suggestFollowups(text);
    try {
      const model = client.getGenerativeModel({
        model: MODEL_ID,
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.STRING },
          },
        },
      });
      const result = await model.generateContent(
        [
          "Given these operator/engineer notes, propose 3–5 concrete follow-up actions. Each item should be a single short imperative line (≤120 chars). No numbering, no markdown, no preamble. Prioritize unchecked tasks (`- [ ]`) if present. Return a JSON array of strings.",
          "",
          "Notes:",
          text,
        ].join("\n"),
      );
      const raw = result.response.text();
      const parsed: string[] = JSON.parse(raw);
      return parsed
        .filter((s) => typeof s === "string" && s.trim().length > 0)
        .map((s) => s.trim())
        .slice(0, 5);
    } catch {
      return mockProvider.suggestFollowups(text);
    }
  },

  async generateHandoff(context) {
    const trimmed = context.trim();
    if (!trimmed) return mockProvider.generateHandoff(context);
    return safeText(
      [
        "Draft a shift/coverage handoff note in markdown for the next person taking over. Sections: a short Status line, Open items as a checklist (`- [ ]`), and Next shift suggestions. Keep it tight — no filler. Treat the context below as ground truth; do NOT invent equipment tags, names, or dates that aren't there.",
        "",
        "Context:",
        trimmed,
      ].join("\n"),
      () => mockProvider.generateHandoff(context),
    );
  },
};
