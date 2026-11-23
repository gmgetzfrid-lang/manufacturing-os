// An error, in words for the person who hit it (the project screens).
//
// The app's own messages ("Pick a file first.", "Only the owner can do
// that.") are shown as they are. A raw database or network message never
// is: lib/friendlyError turns it into what happened and what to do next.

import { explainError } from "@/lib/friendlyError";

const UNKNOWN = explainError(null).message;

/** What went wrong, ready to show. `fallback` stands in when the error has
 *  no words at all ("Not saved."). */
export function sayError(e: unknown, fallback?: string): string {
  const f = explainError(e);
  const raw = e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string" ? (e as { message: string }).message.trim() : typeof e === "string" ? e.trim() : "";
  if (!raw && fallback) return fallback;
  // The app's own sentence: as written.
  if (f.kind === "unknown" && f.message !== UNKNOWN) return f.message;
  return `${f.message} ${f.next}`;
}

export default sayError;

/** The error's own text, for telling kinds of failure apart in code (never shown). */
export function rawMessage(e: unknown): string {
  if (typeof e === "string") return e;
  return e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string" ? (e as { message: string }).message : "";
}
