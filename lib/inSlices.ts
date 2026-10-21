// lib/inSlices.ts — run a query per slice of ids, a few at a time.
//
// Ids ride in the request URL, so big lists go in slices of ~100. Done one
// after another, 30 slices on a busy database is 30 round trips end to end —
// enough to push a request past the host's 60-second limit. A handful in
// flight at once keeps the URL small and the wall clock short without
// flooding the database.

export async function inSlices<T, R>(
  items: T[], size: number, concurrency: number, run: (slice: T[]) => PromiseLike<R>,
): Promise<R[]> {
  const slices: T[][] = [];
  for (let i = 0; i < items.length; i += size) slices.push(items.slice(i, i + size));
  const out: R[] = new Array(slices.length);
  let next = 0;
  const worker = async () => {
    while (next < slices.length) {
      const k = next++;
      out[k] = await run(slices[k]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, slices.length) }, worker));
  return out;
}
