// lib/ai/serverProxyProvider.ts
//
// Client-side AiProvider that forwards every call to /api/ai. The
// real Gemini SDK call happens on the server where GEMINI_API_KEY
// is available; the client never sees the key.
//
// Used by getAiProvider() in browser contexts when AI is configured.
// Falls back to mock results if the request fails so the UI never
// hangs on a 5xx — same contract as the direct gemini provider.

import type {
  AiProvider, Entity, NoteInsights,
  ScheduleQuestion, GeneratedSchedule,
} from "./types";
import { mockProvider } from "./mockProvider";
import { supabase } from "@/lib/supabase";

async function call<T>(op: string, payload: unknown, fallback: () => Promise<T>): Promise<T> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) return fallback();
    const res = await fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ op, payload }),
    });
    if (!res.ok) return fallback();
    const json = await res.json() as { result: T };
    return json.result;
  } catch {
    return fallback();
  }
}

export const serverProxyProvider: AiProvider = {
  name: "Google Gemini (server)",
  isReal: true,

  summarize:        (text) => call("summarize",        { text }, () => mockProvider.summarize(text)),
  extractEntities:  (text) => call<Entity[]>("extractEntities",  { text }, () => mockProvider.extractEntities(text)),
  suggestFollowups: (text) => call<string[]>("suggestFollowups", { text }, () => mockProvider.suggestFollowups(text)),
  generateHandoff:  (text) => call("generateHandoff",  { text }, () => mockProvider.generateHandoff(text)),
  analyzeNote:      (body) => call<NoteInsights>("analyzeNote",  { text: body }, () => mockProvider.analyzeNote(body)),
  briefMe:          (ctx)  => call<string>("briefMe", { ctx }, () => mockProvider.briefMe(ctx)),
  clarifySchedule:  (brief) => call<ScheduleQuestion[]>("clarifySchedule", { brief }, () => mockProvider.clarifySchedule(brief)),
  generateSchedule: (brief) => call<GeneratedSchedule>("generateSchedule", { brief }, () => mockProvider.generateSchedule(brief)),
};
