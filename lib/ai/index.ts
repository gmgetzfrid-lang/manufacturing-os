// lib/ai/index.ts
//
// Provider resolver. Picks the right AiProvider depending on:
//
//   1. Where the code is running (server vs browser)
//   2. Whether the operator has selected a provider via
//      NEXT_PUBLIC_AI_PROVIDER ("gemini" or absent → mock)
//   3. Whether GEMINI_API_KEY is configured on the server
//
// On the SERVER (route handlers, server components):
//   - GEMINI_API_KEY present → geminiProvider (talks to Google directly)
//   - missing                → mockProvider
//
// On the CLIENT (browser, "use client"):
//   - NEXT_PUBLIC_AI_PROVIDER === "gemini" → serverProxyProvider
//     (POSTs to /api/ai; the key never reaches the browser)
//   - anything else → mockProvider
//
// The split exists because process.env.GEMINI_API_KEY is undefined
// in the browser by design — Next.js refuses to ship non-public env
// vars to the client to prevent secret leakage.

import type { AiProvider } from "./types";
import { mockProvider } from "./mockProvider";
import { geminiProvider } from "./geminiProvider";
import { serverProxyProvider } from "./serverProxyProvider";

let cached: AiProvider | null = null;

function isServer(): boolean {
  return typeof window === "undefined";
}

export function getAiProvider(): AiProvider {
  if (cached) return cached;

  const which =
    (typeof process !== "undefined" &&
      (process.env.NEXT_PUBLIC_AI_PROVIDER ?? "mock")) ||
    "mock";

  switch (which) {
    case "gemini": {
      if (isServer()) {
        // Server-side: check the key directly and pick the SDK provider.
        cached = process.env.GEMINI_API_KEY ? geminiProvider : mockProvider;
      } else {
        // Client-side: proxy through /api/ai so the key stays on
        // the server. The proxy itself falls back to mock if the
        // server isn't configured.
        cached = serverProxyProvider;
      }
      break;
    }
    default:
      cached = mockProvider;
  }
  return cached;
}

export type { AiProvider, Entity } from "./types";
