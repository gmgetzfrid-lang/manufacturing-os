// Local motion consistency: a cheap, geometry-free way to find the matches that
// agree with their neighbours.
//
// RANSAC's chance of drawing a clean eight-point sample is r^8 in the inlier
// ratio, so at r = 0.3 it is one draw in fifteen thousand and no affordable
// iteration budget rescues it. Nothing inside the estimator can beat that;
// the only real lever is r itself.
//
// The observation this exploits, from Bian et al., "GMS: Grid-based Motion
// Statistics for Fast, Ultra-robust Feature Correspondence" (CVPR 2017), is
// that correct matches move like their neighbours and wrong ones do not. A
// true match sits in a small image neighbourhood whose other true matches all
// displace by roughly the same amount; a false match points somewhere
// unrelated. Comparing each match against the median displacement of its cell
// separates the two without knowing anything about camera geometry.
//
// Written from the published description. This is used to FIND the model, never
// to decide the final inlier set — see the note in reconstruct.ts.

export interface MotionMatch {
  ax: number; ay: number;
  bx: number; by: number;
}

/**
 * Indices of the matches whose displacement agrees with their neighbourhood.
 *
 * Returns null when the filter would throw away too much to be trusted, so the
 * caller falls back to using everything rather than reasoning about a handful
 * of survivors.
 */
export function motionConsistent(
  matches: MotionMatch[],
  width: number,
  height: number,
  gridSize = 8,
): number[] | null {
  const n = matches.length;
  if (n < 16) return null;

  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  const magnitudes: number[] = [];
  for (let i = 0; i < n; i++) {
    dx[i] = matches[i].bx - matches[i].ax;
    dy[i] = matches[i].by - matches[i].ay;
    magnitudes.push(Math.hypot(dx[i], dy[i]));
  }
  magnitudes.sort((a, b) => a - b);
  const medianMagnitude = magnitudes[Math.floor(magnitudes.length / 2)];
  // Generous, because real motion is not uniform across the frame: rotation and
  // parallax both make near and far pixels move at genuinely different rates.
  const tolerance = Math.max(0.02 * Math.max(width, height), 0.6 * medianMagnitude);

  const cellW = width / gridSize;
  const cellH = height / gridSize;
  const cells = new Map<number, number[]>();
  const cellOf = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const cx = Math.min(gridSize - 1, Math.max(0, Math.floor(matches[i].ax / cellW)));
    const cy = Math.min(gridSize - 1, Math.max(0, Math.floor(matches[i].ay / cellH)));
    const key = cy * gridSize + cx;
    cellOf[i] = key;
    const list = cells.get(key);
    if (list) list.push(i);
    else cells.set(key, [i]);
  }

  const median = (xs: number[]) => {
    xs.sort((a, b) => a - b);
    return xs[Math.floor(xs.length / 2)];
  };

  const keep: number[] = [];
  for (let i = 0; i < n; i++) {
    const key = cellOf[i];
    const cx = key % gridSize;
    const cy = (key - cx) / gridSize;

    // Pool the cell with its eight neighbours, so a sparsely matched cell still
    // has something to be compared against.
    const pool: number[] = [];
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const nx = cx + ox;
        const ny = cy + oy;
        if (nx < 0 || ny < 0 || nx >= gridSize || ny >= gridSize) continue;
        const list = cells.get(ny * gridSize + nx);
        if (list) pool.push(...list);
      }
    }
    // Too few neighbours to have an opinion: keep the match rather than guess.
    if (pool.length < 8) { keep.push(i); continue; }

    const mx = median(pool.map((j) => dx[j]));
    const my = median(pool.map((j) => dy[j]));
    if (Math.hypot(dx[i] - mx, dy[i] - my) <= tolerance) keep.push(i);
  }

  // If it wants to discard most of the pair, it has not found a consensus
  // motion — it has found noise, and its opinion is worth nothing.
  if (keep.length < 16 || keep.length < n * 0.4) return null;
  return keep;
}
