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
import type {
  AiProvider, Entity, NoteInsights, OrganizedNote, BriefContext,
  ScheduleBrief, ScheduleQuestion, GeneratedSchedule, CostDocInput,
} from "./types";
import type { CostExtraction, CostType, CostDocumentKind } from "@/types/schema";
import { mockProvider } from "./mockProvider";

const COST_TYPES: ReadonlySet<string> = new Set(["labor", "material", "equipment", "subcontract", "odc"]);
const DOC_KINDS: ReadonlySet<string> = new Set(["afe", "quote", "estimate", "po", "subcontract", "invoice", "change_order", "other"]);

/** Clamp the model's output to valid enums + numbers; drop junk line items. */
function normalizeExtraction(raw: CostExtraction): CostExtraction {
  const num = (v: unknown): number | null => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const lineItems = (Array.isArray(raw.lineItems) ? raw.lineItems : [])
    .map((li) => ({
      description: String(li?.description ?? "").trim(),
      party: li?.party ? String(li.party).trim() : null,
      quantity: num(li?.quantity),
      unit: li?.unit ? String(li.unit) : null,
      unitCost: num(li?.unitCost),
      amount: num(li?.amount) ?? 0,
      costType: (li?.costType && COST_TYPES.has(li.costType) ? li.costType : null) as CostType | null,
      suggestedAccountId: null,
    }))
    .filter((li) => li.description !== "" || li.amount !== 0);
  return {
    kind: (DOC_KINDS.has(raw.kind) ? raw.kind : "other") as CostDocumentKind,
    vendorName: raw.vendorName ? String(raw.vendorName) : null,
    docNumber: raw.docNumber ? String(raw.docNumber) : null,
    docDate: raw.docDate ? String(raw.docDate) : null,
    currency: raw.currency ? String(raw.currency).toUpperCase().slice(0, 3) : null,
    totalAmount: num(raw.totalAmount),
    lineItems,
    notes: raw.notes ? String(raw.notes) : null,
  };
}

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

  async organizeNote(raw: string): Promise<OrganizedNote> {
    const client = getClient();
    if (!client) return mockProvider.organizeNote(raw);
    try {
      const model = client.getGenerativeModel({
        model: MODEL_ID,
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: SchemaType.OBJECT,
            properties: {
              title: { type: SchemaType.STRING, description: "Synthesized headline (<= 60 chars) capturing the note's OVERALL point in fresh words — never the first sentence copied. Lead with the dominant subject (equipment tag / project / person)." },
              findings: {
                type: SchemaType.ARRAY,
                items: { type: SchemaType.STRING },
                description: "Non-actionable observations / context, verbatim-ish. Empty if none.",
              },
              tasks: {
                type: SchemaType.ARRAY,
                items: { type: SchemaType.STRING },
                description: "Atomic, imperative tasks. One action per item.",
              },
            },
            required: ["title", "findings", "tasks"],
          },
        },
      });
      const result = await model.generateContent(
        [
          "You are a refinery operations assistant. Reorganize this raw, messy note into a clean structure WITHOUT losing detail.",
          "",
          "Rules:",
          "1. tasks must be ATOMIC and independently checkable. Split every compound action:",
          "   - 'follow up with Steve and Dave and Hector on the gaskets' becomes THREE tasks, one per person, each keeping 'on the gaskets'.",
          "   - 'order stud bolts and check P-101A vibration' becomes TWO tasks (different actions).",
          "   - NEVER merge multiple people or multiple distinct actions into one task.",
          "2. Preserve each task's specific context — who, what, which equipment, any date words ('by friday'). Do not vague-ify or shorten to the point of losing meaning.",
          "3. findings = observations that are NOT actions (e.g. 'E-204 flange is weeping'). Keep them; don't drop information.",
          "4. Keep the user's wording and equipment tags (E-204, MOC-2024-051) exactly inside findings/tasks.",
          "5. title: read the WHOLE note first, then write a headline that sums up what it's about and why it matters — like a good subject line. Lead with the dominant subject. NEVER copy or lightly trim the first sentence; synthesize. Example: raw 'walked unit 3, e-204 flange weeping, call joe...' -> title 'E-204 flange leak — repair follow-ups'.",
          "",
          "Return JSON matching the schema. No preamble.",
          "",
          "Raw note:",
          raw,
        ].join("\n"),
      );
      const parsed = JSON.parse(result.response.text()) as { title?: string; findings?: string[]; tasks?: string[] };
      const clean = (arr?: string[]) => (arr ?? [])
        .filter((s) => typeof s === "string" && s.trim().length > 0)
        .map((s) => s.trim().replace(/^[-*]\s*(\[\s*\]\s*)?/, ""));
      return {
        title: (parsed.title ?? "Note").trim().slice(0, 80) || "Note",
        findings: clean(parsed.findings),
        tasks: clean(parsed.tasks),
      };
    } catch {
      return mockProvider.organizeNote(raw);
    }
  },

  async analyzeNote(body): Promise<NoteInsights> {
    const client = getClient();
    if (!client) return mockProvider.analyzeNote(body);
    try {
      const model = client.getGenerativeModel({
        model: MODEL_ID,
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: SchemaType.OBJECT,
            properties: {
              entities: {
                type: SchemaType.ARRAY,
                items: {
                  type: SchemaType.OBJECT,
                  properties: {
                    kind: { type: SchemaType.STRING, description: "equipment | person | moc | date | document | deadline" },
                    text: { type: SchemaType.STRING, description: "exact span from source" },
                  },
                  required: ["kind", "text"],
                },
              },
              suggestedTasks: {
                type: SchemaType.ARRAY,
                items: { type: SchemaType.STRING },
                description: "Imperative one-liners (≤120 chars). Only include actionable items NOT already captured as `- [ ]` checkboxes in the note. Empty array if nothing actionable is hiding in the prose.",
              },
            },
            required: ["entities", "suggestedTasks"],
          },
        },
      });
      const result = await model.generateContent(
        [
          "You are a refinery operations assistant analyzing a single user-authored note. Pull two things from it in one shot:",
          "",
          "1. entities — equipment tags (E-204, P-101A), MOC refs (MOC-2024-051), @mentions, dates, document numbers. Be conservative; only return spans that clearly fit.",
          "2. suggestedTasks — actionable items the user MIGHT want as tasks but hasn't already written as `- [ ]` lines. Convert prose like 'I should call Joe about the inspection' into 'Call Joe about the inspection'. Imperative voice. Don't propose tasks for things already captured as checkboxes. Don't pad. If the note is just an observation with no actionable subtext, return [].",
          "",
          "Return JSON matching the response schema. No prose preamble.",
          "",
          "Note:",
          body,
        ].join("\n"),
      );
      const raw = result.response.text();
      const parsed = JSON.parse(raw) as { entities?: Array<{ kind: string; text: string }>; suggestedTasks?: string[] };
      const seen = new Set<string>();
      const entities: Entity[] = [];
      for (const e of parsed.entities ?? []) {
        if (!e?.kind || !e?.text) continue;
        const k = `${e.kind}::${e.text.toLowerCase()}`;
        if (seen.has(k)) continue;
        seen.add(k);
        entities.push({ kind: e.kind, text: e.text, confidence: 0.9 });
      }
      const suggestedTasks = (parsed.suggestedTasks ?? [])
        .filter((s) => typeof s === "string" && s.trim().length > 0)
        .map((s) => s.trim().replace(/^[-*]\s*\[\s*\]\s*/, ""))
        .slice(0, 5);
      return { entities, suggestedTasks };
    } catch {
      return mockProvider.analyzeNote(body);
    }
  },

  async briefMe(ctx: BriefContext): Promise<string> {
    const totalUrgent = ctx.overdue.length + ctx.today.length + ctx.soon.length;
    if (totalUrgent === 0 && ctx.recentNoteBodies.length === 0) {
      return "Your scratchpad is empty. Add a note in the Notes tab to get started.";
    }
    return safeText(
      [
        "You are an executive assistant briefing a refinery engineer on their personal scratchpad. Write a warm, concise morning briefing in markdown — 4-8 short lines, no headings, no preamble. Open with an actual greeting that varies by what's there. Reference the SPECIFIC equipment tags, MOC refs, and names you see in the context. Be honest if there's not much going on. NEVER invent items that aren't in the context. Highlight overdue items with explicit days past due. Close with one short observation about themes from the recent notes if you see one.",
        "",
        `Today is ${ctx.today_iso}.`,
        "",
        "Overdue tasks:",
        ctx.overdue.length === 0 ? "(none)" : ctx.overdue.map((t) => `- "${t.body}" (due ${t.dueAt ?? "unknown"})`).join("\n"),
        "",
        "Due today:",
        ctx.today.length === 0 ? "(none)" : ctx.today.map((t) => `- "${t.body}"`).join("\n"),
        "",
        "Due this week:",
        ctx.soon.length === 0 ? "(none)" : ctx.soon.map((t) => `- "${t.body}" (due ${t.dueAt ?? "unknown"})`).join("\n"),
        "",
        "Recent note bodies (most recent first):",
        ctx.recentNoteBodies.length === 0 ? "(none yet)" : ctx.recentNoteBodies.slice(0, 5).map((b, i) => `[${i + 1}]\n${b}`).join("\n\n"),
      ].join("\n"),
      () => mockProvider.briefMe(ctx),
    );
  },

  async clarifySchedule(brief: ScheduleBrief): Promise<ScheduleQuestion[]> {
    const client = getClient();
    if (!client) return mockProvider.clarifySchedule(brief);
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
                question: { type: SchemaType.STRING },
                why: { type: SchemaType.STRING, description: "One short line on why this matters." },
                options: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING }, description: "0-4 suggested quick answers." },
              },
              required: ["question"],
            },
          },
        },
      });
      const result = await model.generateContent(
        [
          "You are a senior turnaround/outage planner helping a maintenance supervisor turn a plain-English request into an accurate schedule. Ask ONLY the few clarifying questions that would most change the schedule (sequence, durations, scope, shift, crew). Ask 0 if the brief is already specific. Max 5. Do NOT ask about things already provided below. Plain language a field supervisor uses. Return a JSON array.",
          "",
          briefToText(brief),
        ].join("\n"),
      );
      const parsed = JSON.parse(result.response.text()) as ScheduleQuestion[];
      return (Array.isArray(parsed) ? parsed : [])
        .filter((q) => q && typeof q.question === "string" && q.question.trim())
        .slice(0, 5);
    } catch {
      return mockProvider.clarifySchedule(brief);
    }
  },

  async generateSchedule(brief: ScheduleBrief): Promise<GeneratedSchedule> {
    const client = getClient();
    if (!client) return mockProvider.generateSchedule(brief);
    try {
      const model = client.getGenerativeModel({
        model: MODEL_ID,
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: SchemaType.OBJECT,
            properties: {
              title: { type: SchemaType.STRING },
              tasks: {
                type: SchemaType.ARRAY,
                items: {
                  type: SchemaType.OBJECT,
                  properties: {
                    name: { type: SchemaType.STRING },
                    plannedStartAt: { type: SchemaType.STRING, description: "ISO 8601 start, e.g. 2026-03-02T06:00:00Z" },
                    plannedAt: { type: SchemaType.STRING, description: "ISO 8601 finish." },
                    outlineLevel: { type: SchemaType.INTEGER, description: "1 for a phase, 2 for a task under it, 3 for a sub-step." },
                    isSummary: { type: SchemaType.BOOLEAN, description: "true for phase/parent rows that roll up children." },
                    durationHours: { type: SchemaType.NUMBER, description: "Planned work hours for leaf tasks." },
                    responsibleParty: { type: SchemaType.STRING },
                  },
                  required: ["name", "plannedStartAt", "plannedAt", "outlineLevel"],
                },
              },
              notes: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
            },
            required: ["title", "tasks"],
          },
        },
      });
      const result = await model.generateContent(
        [
          "You are a senior turnaround/outage planner. Build a realistic, EXECUTABLE schedule from the supervisor's description and answers below. Rules:",
          "- Produce a hierarchy: phases (outlineLevel 1, isSummary true) → tasks (level 2) → sub-steps (level 3 only when the user implies them). Output rows in top-down outline order (a phase immediately followed by its children).",
          "- Schedule SEQUENTIALLY from the start date unless the description implies parallel work. Respect the shift pattern for how many hours pack into a day (day-only≈10h, day-night≈20h, 24x7=24h).",
          "- Give every leaf task a sensible durationHours and a plannedStartAt/plannedAt that reflects it. Summary rows should envelope their children's dates.",
          "- Build ONLY what the user describes. Do not invent scope. If unsure, keep it simple and add a note.",
          "- All dates ISO 8601 UTC.",
          "",
          briefToText(brief),
        ].join("\n"),
      );
      const parsed = JSON.parse(result.response.text()) as GeneratedSchedule;
      if (!parsed || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
        return mockProvider.generateSchedule(brief);
      }
      return {
        title: parsed.title?.trim() || "New schedule",
        tasks: parsed.tasks.filter((t) => t && t.name && t.plannedAt),
        notes: Array.isArray(parsed.notes) ? parsed.notes.filter((n) => typeof n === "string") : [],
      };
    } catch {
      return mockProvider.generateSchedule(brief);
    }
  },

  async extractCostDocument(input: CostDocInput): Promise<CostExtraction> {
    const client = getClient();
    if (!client) return mockProvider.extractCostDocument(input);
    try {
      const model = client.getGenerativeModel({
        model: MODEL_ID,
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: SchemaType.OBJECT,
            properties: {
              kind: { type: SchemaType.STRING, description: "One of: afe, quote, estimate, po, subcontract, invoice, change_order, other. An AFE (Authorization for Expenditure) is a budget-authorization document listing contractors and approved amounts." },
              vendorName: { type: SchemaType.STRING },
              docNumber: { type: SchemaType.STRING, description: "Invoice / PO / quote / AFE number." },
              docDate: { type: SchemaType.STRING, description: "ISO date YYYY-MM-DD." },
              currency: { type: SchemaType.STRING, description: "ISO 4217 code, e.g. USD." },
              totalAmount: { type: SchemaType.NUMBER, description: "Total / overall approved amount of the document." },
              lineItems: {
                type: SchemaType.ARRAY,
                items: {
                  type: SchemaType.OBJECT,
                  properties: {
                    description: { type: SchemaType.STRING, description: "The scope / work / item for this line." },
                    party: { type: SchemaType.STRING, description: "Contractor / vendor / department responsible for this line. CRITICAL for an AFE, where each line is a different contractor." },
                    quantity: { type: SchemaType.NUMBER },
                    unit: { type: SchemaType.STRING },
                    unitCost: { type: SchemaType.NUMBER },
                    amount: { type: SchemaType.NUMBER, description: "Extended line total / budgeted amount." },
                    costType: { type: SchemaType.STRING, description: "One of: labor, material, equipment, subcontract, odc." },
                  },
                  required: ["description", "amount"],
                },
              },
              notes: { type: SchemaType.STRING, description: "Caveats about unreadable / ambiguous fields." },
            },
            required: ["kind", "lineItems"],
          },
        },
      });
      const result = await model.generateContent([
        { inlineData: { data: input.dataBase64, mimeType: input.mimeType } },
        {
          text: [
            "You are a construction / industrial cost engineer. Read this cost document and extract its header and EVERY line item as structured JSON.",
            "It may be an AFE (Authorization for Expenditure — a budget-authorization listing contractors and approved amounts), a quote, estimate, purchase order, subcontract, or invoice.",
            "Rules:",
            "- kind: classify the document. Use 'afe' for an Authorization for Expenditure.",
            "- party: for EACH line, the contractor / vendor / department responsible. On an AFE this is essential — every line is typically a different contractor and its budgeted amount. If the whole document is one vendor, repeat it.",
            "- For each line give description (the scope), party, quantity, unit, unit cost, and the extended amount. If only a total per contractor is shown, set amount to it.",
            "- costType: classify each line as labor, material, equipment, subcontract, or odc (other direct cost) from its description.",
            "- totalAmount: the overall approved / total amount of the document.",
            "- Amounts are plain numbers (no currency symbols or thousands separators). Report the document's currency code.",
            "- Do NOT invent figures. If a field is unreadable, omit it and say so in `notes`.",
            input.kindHint ? `The user expects this to be a ${input.kindHint === "afe" ? "AFE (Authorization for Expenditure)" : input.kindHint}.` : "",
            input.accountHints?.length ? `Existing cost accounts for context: ${input.accountHints.join("; ")}.` : "",
          ].filter(Boolean).join("\n"),
        },
      ]);
      const parsed = JSON.parse(result.response.text()) as CostExtraction;
      if (!parsed || !Array.isArray(parsed.lineItems)) return mockProvider.extractCostDocument(input);
      return normalizeExtraction(parsed);
    } catch {
      return mockProvider.extractCostDocument(input);
    }
  },
};

/** Format the brief + prior answers as plain prompt text. */
function briefToText(brief: ScheduleBrief): string {
  const lines = [`Description: ${brief.description}`];
  if (brief.startDate) lines.push(`Start date: ${brief.startDate}`);
  if (brief.shiftPattern) lines.push(`Shift pattern: ${brief.shiftPattern}`);
  if (brief.crew) lines.push(`Crew/contractor: ${brief.crew}`);
  if (brief.answers?.length) {
    lines.push("Answers to clarifying questions:");
    for (const a of brief.answers) lines.push(`- Q: ${a.question}\n  A: ${a.answer}`);
  }
  return lines.join("\n");
}
