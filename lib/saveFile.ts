// saveFile - hand a file to the person, on a computer or a phone.

/** A phone or tablet: its browser hands a file to the share sheet. */
const handheld = () => typeof navigator !== "undefined" && (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1));

/** Hand a file to the person. On a computer it downloads. On a phone or
 *  tablet it opens the share sheet (Save to Files, open in PowerPoint or
 *  Word), since browsers there often drop a plain download. `false`: the
 *  browser wants a fresh tap first (the file took a moment to make), so
 *  offer a Save button and call this again from it. */
export async function saveFile(data: Uint8Array | Blob, name: string, mime: string): Promise<boolean> {
  const blob = new Blob([data as BlobPart], { type: mime });
  if (handheld() && typeof File !== "undefined" && typeof navigator.share === "function") {
    const file = new File([blob], name, { type: mime });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return true; }
      catch (e) {
        const n = (e as { name?: string }).name;
        if (n === "AbortError") return true; // the person closed the sheet
        if (n === "NotAllowedError") return false;
      }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove();
  // Long enough for a phone to ask "Download?" and be answered.
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
  return true;
}
