// lib/ai/index.ts
//
// Provider resolver. Reads env vars and returns the configured
// AiProvider. With no provider configured, returns the mock so the
// UI affordances still render with sensible heuristic results.
//
// Adding a real provider:
//   1. Implement the AiProvider interface in lib/ai/<vendor>Provider.ts
//   2. Add a NEXT_PUBLIC_AI_PROVIDER env case here that resolves it
//      (lazy import so the real SDK isn't bundled unless configured)
//   3. Update docs/ARCHITECTURE.md AI section
//
// The directive forbids hardcoding vendor assumptions. The mock is
// the contract; any real provider must satisfy the same interface
// without changing UI behavior.

import type { AiProvider } from "./types";
import { mockProvider } from "./mockProvider";

let cached: AiProvider | null = null;

export function getAiProvider(): AiProvider {
  if (cached) return cached;

  // Future-proofing: when a real provider is added, instantiate it
  // here based on the env var. For now, mock is the only choice.
  const which =
    (typeof process !== "undefined" &&
      (process.env.NEXT_PUBLIC_AI_PROVIDER ?? "mock")) ||
    "mock";

  switch (which) {
    case "gemini": {
      // Lazy require so the SDK isn't loaded unless configured.
      // Falls back to mock if the key is missing at call time.
      const { geminiProvider } = require("./geminiProvider") as typeof import("./geminiProvider");
      cached = process.env.GEMINI_API_KEY ? geminiProvider : mockProvider;
      break;
    }
    // case "anthropic": cached = anthropicProvider; break;
    default:
      cached = mockProvider;
  }
  return cached;
}

export type { AiProvider, Entity } from "./types";
