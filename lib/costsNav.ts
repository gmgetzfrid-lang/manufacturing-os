// costsNav - open the Costs tab on a view (a contractor's page) from
// anywhere on the project: the shift meeting's head counts, Close-out's
// checklist, the post-event review. The page switches to Costs
// ("project:tab"); the Costs tab picks up the view asked for.

export type CostsViewAsked = { view: "contractors" | "overview" | "budget" | "quotes"; company?: string | null };
export const OPEN_COSTS_EVENT = "costs:open";
let pending: CostsViewAsked | null = null;

export function openCosts(ask: CostsViewAsked): void {
  pending = ask;
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("project:tab", { detail: "costs" }));
  window.dispatchEvent(new CustomEvent(OPEN_COSTS_EVENT, { detail: ask }));
}
/** A contractor's page in Costs › Contractors (none: the list). */
export const openContractor = (company?: string | null) => openCosts({ view: "contractors", company: company ?? null });

/** What was asked before the Costs tab was on the page, once. */
export function takePendingCosts(): CostsViewAsked | null {
  const p = pending; pending = null; return p;
}
