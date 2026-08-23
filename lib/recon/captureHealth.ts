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
