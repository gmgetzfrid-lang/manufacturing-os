// Reads of the schedule outside the schedule screen (inbox, health,
// printed project report, company scorecard, costs) leave out jobs taken
// off the schedule (cancelled — done elsewhere), in the query itself so a
// row limit isn't used up by them. Before the cancel columns exist in the
// database, the read runs without the filter.

export async function activeOnly<R extends { error: { message: string } | null }>(run: (active: boolean) => PromiseLike<R>): Promise<R> {
  const r = await run(true);
  return r.error && /cancelled_at/.test(r.error.message) ? run(false) : r;
}
