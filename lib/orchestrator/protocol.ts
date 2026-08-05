// lib/orchestrator/protocol.ts — forcing a language model to emit commands
// instead of prose, and refusing everything else.
//
// This is the part of the Hermes trick that actually matters. Anyone can put
// a list of tools in a system prompt; the value is in the parsing being
// merciless. A model that "mostly" emits JSON produces a document controller
// that mostly checks out the right document, and mostly is not a standard
// anyone can operate a refinery on.
//
// So: every rule about what a valid tool call looks like lives here, pure and
// unit-tested, with no model and no database anywhere near it. The loop that
// uses this is thin on purpose.

export interface ToolCall {
  tool: string;
  parameters: Record<string, unknown>;
}

export type ParseResult =
  | { kind: "call"; call: ToolCall }
  | { kind: "answer"; text: string }
  | { kind: "invalid"; reason: string };

/**
 * Pull the outermost balanced JSON object out of a model turn.
 *
 * Models wrap JSON in prose, in ```json fences, in both, or in neither. A
 * regex for `{.*}` fails the moment a parameter value contains a brace, which
 * a P&ID line id absolutely will. Bracket counting that respects strings and
 * escapes is the only version that holds up.
 */
export function extractJsonBlock(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // unbalanced — truncated output, usually a token limit
}

/**
 * Read one turn from the model.
 *
 * A turn is either a tool call or a final answer. Anything shaped like a tool
 * call but malformed is INVALID rather than treated as prose — silently
 * showing the user a half-written JSON blob as an "answer" is how these
 * systems lose trust.
 */
export function parseTurn(raw: string, knownTools: ReadonlySet<string>): ParseResult {
  const text = raw.trim();
  if (!text) return { kind: "invalid", reason: "Empty response." };

  const block = extractJsonBlock(text);
  if (!block) return { kind: "answer", text };

  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    // Looks like a call, isn't parseable. If there's prose around it the
    // model was probably just quoting JSON; otherwise it tried and failed.
    const outside = text.replace(block, "").trim();
    if (outside.length > 40) return { kind: "answer", text };
    return { kind: "invalid", reason: "That wasn't valid JSON." };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "answer", text };
  }

  const obj = parsed as Record<string, unknown>;
  // The spec's shape, plus the two spellings models reach for unprompted.
  const name = obj.tool_name ?? obj.tool ?? obj.name;
  if (typeof name !== "string") {
    // A JSON object that isn't a tool call is just an answer that happens to
    // contain JSON — a perfectly normal thing when quoting a config.
    return { kind: "answer", text };
  }

  if (!knownTools.has(name)) {
    return { kind: "invalid", reason: `No tool named "${name}". Use one of the listed tools.` };
  }

  const rawParams = obj.parameters ?? obj.arguments ?? obj.params ?? {};
  if (typeof rawParams !== "object" || rawParams === null || Array.isArray(rawParams)) {
    return { kind: "invalid", reason: `Parameters for "${name}" must be a JSON object.` };
  }

  return { kind: "call", call: { tool: name, parameters: rawParams as Record<string, unknown> } };
}

/** A parameter the tool declares it needs. */
export interface ParamSpec {
  name: string;
  type: "string" | "number" | "boolean";
  required?: boolean;
  description: string;
}

/**
 * Check a call's parameters before anything touches the database.
 *
 * Returns cleaned values or a message the model can act on. Coercion is
 * deliberately narrow — a numeric string becomes a number because models
 * quote numbers constantly, but a word never becomes a number, because
 * silently reading "three" as 0 is worse than saying no.
 */
export function validateParams(
  params: Record<string, unknown>,
  specs: readonly ParamSpec[],
): { ok: true; values: Record<string, string | number | boolean> } | { ok: false; error: string } {
  const values: Record<string, string | number | boolean> = {};
  for (const spec of specs) {
    const v = params[spec.name];
    if (v === undefined || v === null || v === "") {
      if (spec.required) return { ok: false, error: `Missing required parameter "${spec.name}".` };
      continue;
    }
    if (spec.type === "string") {
      if (typeof v !== "string" && typeof v !== "number") {
        return { ok: false, error: `"${spec.name}" must be a string.` };
      }
      values[spec.name] = String(v).trim();
    } else if (spec.type === "number") {
      const n = typeof v === "number" ? v : Number(String(v).trim());
      if (!Number.isFinite(n)) return { ok: false, error: `"${spec.name}" must be a number.` };
      values[spec.name] = n;
    } else {
      if (typeof v === "boolean") values[spec.name] = v;
      else if (v === "true" || v === "false") values[spec.name] = v === "true";
      else return { ok: false, error: `"${spec.name}" must be true or false.` };
    }
  }
  return { ok: true, values };
}

/**
 * Detect a model stuck in a loop.
 *
 * The classic agent failure isn't a wrong answer, it's the same query fired
 * forty times while the user watches a spinner and the bill climbs. Identical
 * consecutive calls mean the last result wasn't understood, and repeating it
 * will not help.
 */
export function isRepeatCall(history: readonly ToolCall[], next: ToolCall): boolean {
  const last = history[history.length - 1];
  if (!last) return false;
  return last.tool === next.tool
    && JSON.stringify(last.parameters) === JSON.stringify(next.parameters);
}
