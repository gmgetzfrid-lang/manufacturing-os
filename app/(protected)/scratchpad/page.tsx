import { redirect } from "next/navigation";

// The standalone Scratchpad was removed (2026-08 cleanup) — notes now live on
// the surfaces they're about (assets, projects, documents). This route exists
// only so old bookmarks and previously delivered notification links land
// somewhere sensible instead of a 404.
export default function ScratchpadRedirect() {
  redirect("/inbox");
}
