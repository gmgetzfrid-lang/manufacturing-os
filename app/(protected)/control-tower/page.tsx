import { redirect } from "next/navigation";

// The standalone Control Tower board was folded into /coordination as its
// "Document flow" view — one situational board instead of two overlapping
// ones. This route stays only so old bookmarks and deep links keep working.
export default function ControlTowerRedirect() {
  redirect("/coordination?view=flow");
}
