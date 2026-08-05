// lib/orchestrator/loop.ts — the reason-act cycle.
//
// The model never touches the database. It emits a command; this loop decides
// whether that command is real, runs it, and hands the result back. Everything
// that could go wrong with an agent goes wrong here, so everything that could
// go wrong is bounded here:
//
//   • a step budget, so a confused model can't bill for forty round trips
//   • a wall-clock deadline, so a serverless invocation never gets killed
//     mid-thought with nothing to show the user
//   • a correction budget, so "that wasn't valid JSON" can't become a duet
//   • repeat detection, so the same query fired twice ends the pattern
//   • a forced close, so the loop ALWAYS returns prose, never a raw tool dump
//
// The model call is injected. That keeps this file testable with a scripted
// model — you can drive an entire agent conversation in a unit test with no
// network, no key, and no provider — and it keeps provider choice where it
// already lives (the org's own BYO connection).

import { parseTurn, validateParams, isRepeatCall, type ToolCall } from "@/lib/orchestrator/protocol";
import { TOOL_NAMES, toolByName, toolCatalogue, type PendingAction, type ToolContext } from "@/lib/orchestrator/tools";

/** One model turn. Injected so the loop is testable and provider-agnostic. */
export type ModelCall = (system: string, user: string) => Promise<{
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
}>;

export interface OrchestratorStep {
  tool: string;
  parameters: Record<string, unknown>;
  /** Result handed back to the model, already trimmed for the transcript. */
  result: unknown;
  /** Set when the step didn't run: bad JSON, unknown tool, bad parameters. */
  error?: string;
}

export interface OrchestratorRun {
  answer: string;
  steps: OrchestratorStep[];
  /** Writes waiting on a human. Deduped — proposing the same thing twice is
   *  one decision, not two. */
  pending: PendingAction[];
  usage: { inputTokens: number; outputTokens: number };
  /** Set when the loop stopped early: budget, deadline, or a stuck model. */
  stoppedBecause?: string;
}

export interface RunOptions {
  question: string;
  ctx: ToolContext;
  call: ModelCall;
  /** Tool calls allowed before the loop demands an answer. */
  maxSteps?: number;
  /** Extra org instructions (playbooks) folded into the system prompt. */
  playbook?: string;
  /** Wall clock. Default 40s — inside Vercel's 60s kill with room to write. */
  budgetMs?: number;
  /** Injectable clock so tests don't sleep. */
  now?: () => number;
}

const DEFAULT_MAX_STEPS = 6;
const MAX_CORRECTIONS = 3;
const DEFAULT_BUDGET_MS = 40_000;
/** A single tool result can be enormous (a hundred mentions). The model needs
 *  the shape and the top of it, not all of it, and an unbounded transcript is
 *  how a six-step loop turns into a context-limit error on step four. */
const RESULT_CHARS = 4_000;

export function systemPrompt(playbook?: string): string {
  return [
    "You are the document controller for an industrial site: refinery drawings, standards,",
    "procedures, equipment registers. You answer by CALLING TOOLS, not by guessing.",
    "",
    "Reply with EXACTLY ONE of these, and nothing else:",
    "",
    '1. A tool call, as a single JSON object: {"tool_name": "...", "parameters": { ... }}',
    "   No prose before or after it. No markdown fence.",
    "2. Your final answer, as plain prose. No JSON.",
    "",
    "TOOLS",
    toolCatalogue(),
    "",
    "RULES",
    "- Ground every factual claim in a tool result. If the tools found nothing, say so",
    "  plainly — 'I have no documents mentioning that' is a correct and useful answer.",
    "- Cite documents by number or name, and cite the page when you have one.",
    "- Never invent a document number, an equipment tag, a revision, or a person.",
    "- Tools marked [WRITE] are proposals. Calling one does NOT perform it; it asks the",
    "  user. After proposing, do not call it again — carry on and finish your answer.",
    "- Prefer search_documents for questions about content, find_documents for a specific",
    "  document, equipment_mentions for 'what do we have on <tag>'.",
    "- Stop calling tools as soon as you can answer. Extra calls cost the user money.",
    playbook ? `\nSITE INSTRUCTIONS\n${playbook.trim()}` : "",
  ].join("\n").trim();
}

/** Render the run so far as the user turn. The provider layer is single-turn,
 *  so the transcript IS the conversation — which has the side benefit of being
 *  exactly what a reader would want to see when a run goes wrong. */
function transcript(question: string, steps: OrchestratorStep[], note?: string): string {
  const lines = [`QUESTION: ${question}`];
  if (steps.length > 0) {
    lines.push("", "WHAT YOU HAVE DONE SO FAR:");
    for (const s of steps) {
      lines.push(`\n> ${s.tool}(${JSON.stringify(s.parameters)})`);
      lines.push(s.error ? `REJECTED: ${s.error}` : clip(JSON.stringify(s.result)));
    }
  }
  if (note) lines.push("", note);
  return lines.join("\n");
}

function clip(text: string): string {
  return text.length <= RESULT_CHARS
    ? text
    : `${text.slice(0, RESULT_CHARS)}\n…(result truncated — call again with a narrower query if you need more)`;
}

/**
 * Run the cycle.
 *
 * Always resolves. A run that fails to reach an answer still returns the steps
 * it took and says why it stopped — a controller that goes quiet is worse than
 * one that says "I got three of the way there, here's what I found".
 */
export async function runOrchestrator(opts: RunOptions): Promise<OrchestratorRun> {
  const { question, ctx, call } = opts;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const now = opts.now ?? Date.now;
  const startedAt = now();

  const system = systemPrompt(opts.playbook);
  const steps: OrchestratorStep[] = [];
  const history: ToolCall[] = [];
  const pending = new Map<string, PendingAction>();
  const usage = { inputTokens: 0, outputTokens: 0 };

  let corrections = 0;
  let note: string | undefined;
  let stoppedBecause: string | undefined;

  const spend = (u?: { inputTokens: number; outputTokens: number }) => {
    if (!u) return;
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
  };
  const outOfTime = () => now() - startedAt > budgetMs;

  while (steps.length < maxSteps) {
    if (outOfTime()) { stoppedBecause = "ran out of time"; break; }

    let turn;
    try {
      turn = await call(system, transcript(question, steps, note));
    } catch (e) {
      // A provider failure is the user's problem to see, not something to
      // paper over with a confident-sounding answer.
      return {
        answer: e instanceof Error ? e.message : "The AI provider call failed.",
        steps, pending: [...pending.values()], usage,
        stoppedBecause: "provider error",
      };
    }
    spend(turn.usage);
    note = undefined;

    const parsed = parseTurn(turn.text, TOOL_NAMES);

    if (parsed.kind === "answer") {
      return { answer: parsed.text, steps, pending: [...pending.values()], usage };
    }

    if (parsed.kind === "invalid") {
      corrections += 1;
      if (corrections > MAX_CORRECTIONS) {
        stoppedBecause = "the model kept emitting malformed tool calls";
        break;
      }
      note = `YOUR LAST REPLY WAS REJECTED: ${parsed.reason}\n`
        + "Reply with either one valid JSON tool call or your final answer in plain prose.";
      continue;
    }

    const def = toolByName(parsed.call.tool);
    if (!def) {                                      // parseTurn already checked
      note = `No tool named "${parsed.call.tool}".`;
      continue;
    }

    if (isRepeatCall(history, parsed.call)) {
      // Repeating a call means the result wasn't understood. Running it again
      // burns money to produce the identical bytes.
      note = "You just made that exact call. The result above is all there is — "
        + "either try a different tool or different parameters, or answer now.";
      history.push(parsed.call);
      steps.push({
        tool: parsed.call.tool, parameters: parsed.call.parameters,
        result: null, error: "Repeated call — not run.",
      });
      continue;
    }

    const checked = validateParams(parsed.call.parameters, def.params);
    if (!checked.ok) {
      corrections += 1;
      if (corrections > MAX_CORRECTIONS) {
        stoppedBecause = "the model kept sending invalid parameters";
        break;
      }
      steps.push({
        tool: parsed.call.tool, parameters: parsed.call.parameters,
        result: null, error: checked.error,
      });
      note = `PARAMETERS REJECTED: ${checked.error}`;
      continue;
    }

    history.push(parsed.call);
    try {
      const out = await def.run(checked.values, ctx);
      if (out.pending) pending.set(out.pending.fingerprint, out.pending);
      steps.push({ tool: def.name, parameters: checked.values, result: out.data });
    } catch (e) {
      // A tool throwing is a bug in OUR code, not a reason to abandon the run.
      // Report it into the transcript and let the model route around it.
      const message = e instanceof Error ? e.message : "Tool failed.";
      steps.push({ tool: def.name, parameters: checked.values, result: null, error: message });
      note = `That tool failed: ${message}. Try another approach or answer with what you have.`;
    }
  }

  if (!stoppedBecause && steps.length >= maxSteps) stoppedBecause = "reached the tool-call limit";

  // FORCED CLOSE. Whatever happened above, the user gets prose. Skipped only
  // when there's no time left to ask for it.
  if (!outOfTime()) {
    try {
      const closing = await call(
        system,
        transcript(
          question, steps,
          "STOP CALLING TOOLS. Answer the question now in plain prose using only what is above. "
          + "If it isn't enough, say exactly what you could not determine and what would settle it.",
        ),
      );
      spend(closing.usage);
      // Only prose is acceptable here. A model that answers the "stop calling
      // tools" turn with another tool call has nothing to say, and printing
      // its JSON verbatim is the exact failure the whole parser exists to
      // prevent — it just moved to the last line of the function.
      const parsed = parseTurn(closing.text, TOOL_NAMES);
      if (parsed.kind === "answer" && parsed.text.trim()) {
        return { answer: parsed.text, steps, pending: [...pending.values()], usage, stoppedBecause };
      }
    } catch {
      // fall through to the honest fallback
    }
  }

  return {
    answer: steps.length > 0
      ? "I couldn't finish this one. What I gathered is listed below — it may still answer part of it."
      : "I couldn't answer this. Nothing came back from the search.",
    steps, pending: [...pending.values()], usage, stoppedBecause,
  };
}
