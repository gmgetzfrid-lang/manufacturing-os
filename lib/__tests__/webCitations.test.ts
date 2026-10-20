// The Web switch's provenance: every web-backed sentence must come back
// tied to the page (and the quoted text) it came from.

import { describe, it, expect, vi, afterEach } from "vitest";
import { callAiModel } from "../ai/providerCall";

afterEach(() => { vi.unstubAllGlobals(); });

describe("callAiModel with markWebCitations", () => {
  it("marks each cited text block with its source index and keeps the quoted text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 20 },
      content: [
        { type: "server_tool_use" },
        { type: "text", text: "**Answer:** NO — EP 5-2-2 prohibits it [1]. " },
        { type: "text", text: "ASME explains that slip-ons need straight pipe", citations: [
          { url: "https://asme.org/a", title: "ASME A", cited_text: "Slip-on flanges require straight pipe." },
        ] },
        { type: "text", text: ", and fitting ends are not straight.\n", citations: [
          { url: "https://asme.org/a", title: "ASME A" },
          { url: "https://example.com/b", title: "B", cited_text: "Elbow ends are tapered." },
        ] },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const out = await callAiModel({
      provider: "anthropic", model: "m", apiKey: "k", system: "s", user: "u",
      webSearch: true, markWebCitations: true,
    });
    expect(out.text).toBe(
      "**Answer:** NO — EP 5-2-2 prohibits it [1]. ASME explains that slip-ons need straight pipe[W1], and fitting ends are not straight.[W1][W2]\n");
    expect(out.webSources).toEqual([
      { url: "https://asme.org/a", title: "ASME A", quote: "Slip-on flanges require straight pipe." },
      { url: "https://example.com/b", title: "B", quote: "Elbow ends are tapered." },
    ]);
    expect(out.liveWeb).toBe(true);
  });
});
