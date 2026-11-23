// Document screens write many messages as "What failed: <reason>", where
// the reason is whatever the database or the network said. On screen the
// first part stays (it says what you were doing) and a raw reason is put
// in plain words (lib/friendlyError): "Couldn't save the columns. You
// don't have access to this. Ask an admin in your workspace for access."
// A reason the app wrote for people passes through unchanged.

import { explainError } from "@/lib/friendlyError";

export function plainError(msg: string | null | undefined): string {
  if (!msg) return "";
  const text = String(msg).trim();
  const cut = text.search(/:\s|\s-\s/);
  if (cut > 0) {
    const head = text.slice(0, cut).replace(/[.:\s]+$/, "");
    const tail = text.slice(cut).replace(/^(:\s|\s-\s)/, "").trim();
    const f = explainError(tail);
    const kept = f.kind === "unknown" && f.message.replace(/\.$/, "") === tail.replace(/\.$/, "");
    if (kept) return text;
    return `${head}. ${f.message} ${f.next}`;
  }
  const f = explainError(text);
  if (f.kind === "unknown" && f.message.replace(/\.$/, "") === text.replace(/\.$/, "")) return text;
  return `${f.message} ${f.next}`;
}

export default plainError;
