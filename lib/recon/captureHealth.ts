// Turning what a run measured into something a person can act on.
//
// A failed capture has three common causes and they need opposite responses, so
// telling them apart is the whole job. The image displacement between
// consecutive kept frames separates two of them outright: too little and there
// is no parallax to triangulate from, too much and consecutive frames stop
// sharing enough to match.

export type MotionVerdict = "too-still" | "healthy" | "too-fast";

/**
 * Judge inter-frame motion relative to frame width, because the same pixel
 * count means very different things at 640px and at 1920px.
 */
export function judgeMotion(medianPx: number, frameLongEdge: number): MotionVerdict {
  if (!(frameLongEdge > 0) || !Number.isFinite(medianPx)) return "healthy";
  const fraction = medianPx / frameLongEdge;
  if (fraction < 0.02) return "too-still";
  if (fraction > 0.25) return "too-fast";
  return "healthy";
}

export function describeMotion(verdict: MotionVerdict): string {
  switch (verdict) {
    case "too-fast":
      return "very large — the camera was moving too fast for consecutive frames to share much";
    case "too-still":
      return "very small — the camera barely travelled, which leaves no depth to triangulate";
    default:
      return "a reasonable amount";
  }
}

/**
 * How many decoded frames to skip per kept frame, given how far the image
 * moved on the last hop.
 *
 * The sampler cannot see the future, so this is reactive: one oversized hop
 * collapses the window to 1 (keep every decoded frame) and calm hops let it
 * relax back one step at a time. Handheld capture is bursty — hold still, then
 * swing — and the cost of reacting a frame late is one weak pair, while the
 * cost of not reacting is the whole capture failing to chain.
 */
export function nextWindowSize(
  current: number,
  base: number,
  movedPx: number,
  budgetPx: number,
): number {
  if (!Number.isFinite(movedPx) || !(budgetPx > 0)) return current;
  if (movedPx > budgetPx) return 1;
  if (movedPx < budgetPx * 0.35) return Math.min(base, current + 1);
  return current;
}
