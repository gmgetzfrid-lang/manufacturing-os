// A11Y-8 / A11Y-14: the decision-control target, shared by every Projects
// surface that decides something — the Quality tab's reviews, the intake
// approvals, the bid table's actions, the change-order decisions and the
// Costs tab's ledger controls.
//
// A decision control is never under 24 px (WCAG 2.2 SC 2.5.8), and on a
// coarse pointer (a tablet, a gloved hand) it is 44 px — set on the control,
// never by a bare element rule in the shared stylesheet. Clusters of them
// are spaced 8 px (gap-2).
export const DECISION_TARGET = "min-h-6 min-w-6 pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:px-3";
