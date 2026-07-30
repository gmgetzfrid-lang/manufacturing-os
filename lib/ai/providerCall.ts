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

export interface AiCallInput {
  provider: AiProviderId;
  model: string;
  apiKey: string;
  system: string;
  user: string;
  maxTokens?: number;
}

/** Run one system+user prompt, return the model's text. Throws AiCallError. */
export async function callAiModel(input: AiCallInput): Promise<string> {
  const { provider, model, apiKey, system, user } = input;
  const maxTokens = input.maxTokens ?? 2048;

  if (provider === "anthropic") {
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
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) throw friendly(provider, res.status, await res.text().catch(() => ""));
    const data = (await res.json()) as {
      stop_reason?: string;
      content?: Array<{ type: string; text?: string }>;
    };
    if (data.stop_reason === "refusal") {
      throw new AiCallError("The model declined to answer this question.", 422);
    }
    const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    if (!text.trim()) throw new AiCallError("The model returned an empty answer — try again.", 502);
    return text;
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
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw friendly(provider, res.status, await res.text().catch(() => ""));
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) throw new AiCallError("The model returned an empty answer — try again.", 502);
    return text;
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
      }),
    },
  );
  if (!res.ok) throw friendly(provider, res.status, await res.text().catch(() => ""));
  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  if (!text.trim()) throw new AiCallError("The model returned an empty answer — try again.", 502);
  return text;
}
