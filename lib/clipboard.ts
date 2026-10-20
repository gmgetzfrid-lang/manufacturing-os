// lib/clipboard.ts — copy text that actually lands, or says it didn't.
//
// navigator.clipboard.writeText rejects whenever the page isn't the focused
// document (DevTools open, focus in another frame, some embedded webviews)
// and an unhandled rejection surfaced as a console error with no copy.
// Fall back to the old selection-based copy, which works in those cases,
// and report whether either worked so buttons never claim "Copied" falsely.

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the selection copy */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
