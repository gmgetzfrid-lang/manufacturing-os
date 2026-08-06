// lib/ai/providerCall.ts — SERVER-ONLY.
//
// One normalized text-completion call across the three BYO providers the
// knowledge libraries support. Deliberately raw fetch (no provider SDKs):
// the request shapes are small and stable, and three SDKs would be three
// dependency trees for what is ultimately one POST each.
//
// Every call runs on the ORG'S OR USER'S OWN KEY (ai_connections) — the app
// never spends its own money here. Errors are mapped to messages a
// non-developer can act on ("key rejected", "out of credits"), because the
// person seeing them is a doc controller, not an API integrator.
//
// webSearch: true turns on the provider's LIVE web tool where one exists —
// Anthropic's server-side web_search and Gemini's google_search grounding.
// OpenAI's classic chat-completions endpoint has no web tool, so there the
// flag falls back to the model's built-in knowledge; the response marks
// which of the two actually happened so the UI never overclaims.

export type AiProviderId = "anthropic" | "openai" | "gemini";

export const PROVIDER_LABELS: Record<AiProviderId, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI",
  gemini: "Google (Gemini)",
};

/** Suggested models per provider — free-text everywhere, these just seed the
 *  pickers so people don't have to guess IDs. First entry = default. */
export const PROVIDER_MODEL_SUGGESTIONS: Record<AiProviderId, string[]> = {
  anthropic: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
  openai: ["gpt-5.1", "gpt-4o", "gpt-4o-mini"],
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash"],
};

export class AiCallError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "AiCallError";
  }
}

function friendly(provider: AiProviderId, status: number, detail: string): AiCallError {
  const who = PROVIDER_LABELS[provider];
  if (status === 401 || status === 403) {
    return new AiCallError(`${who} rejected the API key — check it in AI settings.`, 401);
  }
  if (status === 429) {
    return new AiCallError(
      `${who} rate/credit limit hit — the key's owner may need to add credits or wait a moment.`,
      429,
    );
  }
  if (status === 404) {
    return new AiCallError(`${who} doesn't recognize that model — check the model name in AI settings.`, 400);
  }
  return new AiCallError(`${who} call failed (${status}): ${detail.slice(0, 300)}`, 502);
}

export interface WebSource {
  url: string;
  title: string | null;
}

export interface AiCallResult {
  text: string;
  /** Live web sources the provider consulted (Anthropic/Gemini web tools). */
  webSources: WebSource[];
  /** True only when a LIVE web tool actually ran (vs model knowledge). */
  liveWeb: boolean;
  /** Exact token counts from the provider's response — feeds spend metering. */
  usage: { inputTokens: number; outputTokens: number };
}

export interface AiCallImage {
  /** Base64 (no data: prefix). */
  base64: string;
  mediaType: string;   // "image/png"
}

export interface AiCallInput {
  provider: AiProviderId;
  model: string;
  apiKey: string;
  system: string;
  user: string;
  maxTokens?: number;
  webSearch?: boolean;
  /** Page images attached to the user turn — lets the model read tables,
   *  formulas, and figures exactly as printed. */
  images?: AiCallImage[];
  /** Abort the call after this long. Callers running inside a serverless
   *  invocation use it to guarantee they get control back with time to
   *  commit — an unbounded call that outlives its function loses whatever
   *  the caller hadn't written yet. Surfaces as AiCallError status 408. */
  timeoutMs?: number;
}

/** AbortSignal for a call's time budget (undefined = no limit). */
const budgetSignal = (timeoutMs?: number): AbortSignal | undefined =>
  timeoutMs && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;

/** Recognise "we ran out of time", whatever the runtime calls it. */
export function isTimeoutError(e: unknown): boolean {
  if (e instanceof AiCallError) return e.status === 408;
  const name = (e as { name?: string })?.name ?? "";
  return name === "TimeoutError" || name === "AbortError";
}

const dedupeSources = (sources: WebSource[]): WebSource[] => {
  const seen = new Set<string>();
  return sources.filter((s) => {
    if (!s.url || seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  }).slice(0, 10);
};

/** Run one system+user prompt, return the model's text (+ web sources when
 *  webSearch ran). Throws AiCallError. */
export async function callAiModel(input: AiCallInput): Promise<AiCallResult> {
  const { provider, model, apiKey, system, user, webSearch } = input;
  const maxTokens = input.maxTokens ?? 2048;
  const images = input.images ?? [];
  const signal = budgetSignal(input.timeoutMs);

  if (provider === "anthropic") {
    type Block = {
      type: string;
      text?: string;
      citations?: Array<{ url?: string; title?: string }>;
    };
    // Server-side web search can pause the turn mid-way (stop_reason
    // "pause_turn"); resume by echoing the assistant content back.
    const userContent: unknown = images.length === 0
      ? user
      : [
          ...images.map((img) => ({
            type: "image",
            source: { type: "base64", media_type: img.mediaType, data: img.base64 },
          })),
          { type: "text", text: user },
        ];
    const messages: Array<{ role: string; content: unknown }> = [{ role: "user", content: userContent }];
    let data: {
      stop_reason?: string;
      content?: Block[];
      usage?: { input_tokens?: number; output_tokens?: number };
    } = {};
    const usage = { inputTokens: 0, outputTokens: 0 };
    for (let round = 0; round < 4; round++) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          // Claude 5-generation models THINK BY DEFAULT when this is omitted,
          // and thinking tokens come out of max_tokens before any visible
          // text. Callers here budget 200–4000 tokens for the ANSWER — with
          // default thinking, a tight budget can be consumed entirely by
          // invisible reasoning, returning zero text blocks ("empty answer").
          // This pipeline is single-turn Q&A over already-retrieved passages;
          // every token the user pays for should be answer text.
          thinking: { type: "disabled" },
          system,
          messages,
          ...(webSearch
            ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }] }
            : {}),
        }),
        signal,
      });
      if (!res.ok) throw friendly(provider, res.status, await res.text().catch(() => ""));
      data = (await res.json()) as typeof data;
      // Each pause_turn round bills separately — sum across rounds.
      usage.inputTokens += data.usage?.input_tokens ?? 0;
      usage.outputTokens += data.usage?.output_tokens ?? 0;
      if (data.stop_reason === "refusal") {
        throw new AiCallError("The model declined to answer this question.", 422);
      }
      if (data.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: data.content ?? [] });
    }
    const blocks = data.content ?? [];
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    if (!text.trim()) {
      // Name the reason when the provider gives one — "empty, try again" with
      // no cause is exactly the kind of dead end this app shouldn't produce.
      const why = data.stop_reason === "max_tokens"
        ? "the answer-length budget ran out before any text was produced"
        : `no text in the response (stop_reason: ${data.stop_reason ?? "unknown"})`;
      throw new AiCallError(`The model returned an empty answer — ${why}. Try again.`, 502);
    }
    const webSources = dedupeSources(
      blocks.flatMap((b) => b.citations ?? [])
        .map((c) => ({ url: c.url ?? "", title: c.title ?? null })),
    );
    return { text, webSources, liveWeb: !!webSearch, usage };
  }

  if (provider === "openai") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_completion_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: images.length === 0
              ? user
              : [
                  ...images.map((img) => ({
                    type: "image_url",
                    image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
                  })),
                  { type: "text", text: user },
                ],
          },
        ],
      }),
      signal,
    });
    if (!res.ok) throw friendly(provider, res.status, await res.text().catch(() => ""));
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) throw new AiCallError("The model returned an empty answer — try again.", 502);
    // No live web tool on chat completions — model knowledge only.
    return {
      text, webSources: [], liveWeb: false,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
    };
  }

  // gemini
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: maxTokens },
        ...(webSearch ? { tools: [{ google_search: {} }] } : {}),
      }),
      signal,
    },
  );
  if (!res.ok) throw friendly(provider, res.status, await res.text().catch(() => ""));
  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> };
    }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  if (!text.trim()) throw new AiCallError("The model returned an empty answer — try again.", 502);
  const webSources = dedupeSources(
    (candidate?.groundingMetadata?.groundingChunks ?? [])
      .map((g) => ({ url: g.web?.uri ?? "", title: g.web?.title ?? null })),
  );
  return {
    text, webSources, liveWeb: !!webSearch,
    usage: {
      inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}
