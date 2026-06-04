// lib/scheduleDeps.ts
//
// Small helpers for drawing finish-to-start dependency links on the execution
// timeline. The connectors are purely visual; the scheduling consequences of a
// dependency (pushing successors forward) live in scheduleReflow.cascadeDependents.

/**
 * Resolve a milestone id to the index of the row that should *visually*
 * represent it on the timeline:
 *
 *   • itself, if that row is currently visible, otherwise
 *   • its nearest visible ancestor (so a finish-to-start link still shows when
 *     the predecessor/successor is tucked inside a collapsed phase), otherwise
 *   • undefined, when nothing in its ancestry is on screen (e.g. filtered out).
 *
 * Walking up to a visible ancestor is what stops dependencies from silently
 * disappearing the moment a user collapses a phase — the link just re-points to
 * the phase bar instead. `parentOf` is consulted for the parent chain and we
 * guard against cycles defensively.
 */
export function resolveVisibleDepIndex(
  id: string,
  visibleIndexById: Map<string, number>,
  parentOf: (id: string) => string | null | undefined,
): number | undefined {
  let cur: string | null | undefined = id;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    const idx = visibleIndexById.get(cur);
    if (idx !== undefined) return idx;
    seen.add(cur);
    cur = parentOf(cur);
  }
  return undefined;
}
