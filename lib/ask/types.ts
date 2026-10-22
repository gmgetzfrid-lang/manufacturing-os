// lib/ask/types.ts — the shared shape of an AI ask handler.
//
// Both answer engines (the library RAG pipeline and the tool-calling
// controller) used to be route files that read the request and wrote the
// response themselves. The chat shell needs to drive them from ONE route,
// over a stream, with the turn persisted either side — so each engine is
// now a function of (authenticated user, body, emit) that returns a status
// and a JSON body. The original routes are thin wrappers that call it with
// a no-op emitter; the chat route calls it with a streaming one.

import type { AiCallImage } from "@/lib/ai/providerCall";

/** Progress events an engine can raise while it works. */
export type AskEvent =
  /** A phase of work started — shown as the live status line. */
  | { t: "status"; text: string }
  /** A chunk of the final answer as it streams from the provider. */
  | { t: "delta"; text: string }
  /** The answer is being re-generated (e.g. after a Fetch round) — the
   *  client discards what it streamed so far. */
  | { t: "reset" };

export type AskEmit = (event: AskEvent) => void;

export interface AskHandlerInput {
  user: { id: string };
  body: Record<string, unknown>;
  emit: AskEmit;
  /** Extra system-prompt text from the chat shell: per-thread instructions
   *  and the asker's standing profile. Appended after org playbooks. */
  extraSystem?: string;
  /** Images the asker attached to THIS turn (photos, marked-up drawings,
   *  rendered PDF pages). Context for the question — never indexed. */
  userImages?: AiCallImage[];
  /** Prior turns of the conversation, oldest first. Library asks already
   *  take `history` in the body; the controller takes them here. */
  priorTurns?: Array<{ question: string; answer: string }>;
  /** Set only by the server's answer-test runner — never from a request
   *  body. The ask runs clean: no conversation, no 👍 pages from earlier
   *  answers (or a test would grade itself), and no entry in the library's
   *  question log. */
  evalRun?: { runId: string; caseId: string };
}

export interface AskHandlerResult {
  status: number;
  json: Record<string, unknown>;
}

export const noopEmit: AskEmit = () => undefined;

export const ok = (json: Record<string, unknown>): AskHandlerResult => ({ status: 200, json });
export const fail = (msg: string, status = 400): AskHandlerResult => ({ status, json: { error: msg } });
