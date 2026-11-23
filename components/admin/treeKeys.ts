// Arrow keys for a tree built from nested <details> (admin trees: the
// permissions console, the role model). Put it on the tree's container:
//   Down / Up     the next or previous row you can see
//   Right         open the row (or step into its first child when open)
//   Left          close the row (or step out to its parent when closed)
//   Home / End    the first or last row
// Rows are the <summary> elements and anything marked data-tree-row.

import type React from "react";

const ROW = "summary, [data-tree-row]";

function visibleRows(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(ROW)).filter((el) => {
    // A row inside a closed <details> (other than its own summary) is hidden.
    let d = el.parentElement?.closest("details") ?? null;
    if (el.tagName === "SUMMARY") d = el.parentElement?.parentElement?.closest("details") ?? null;
    while (d && root.contains(d)) {
      if (!d.open) return false;
      d = d.parentElement?.closest("details") ?? null;
    }
    return true;
  });
}

export function onTreeKeyDown(e: React.KeyboardEvent<HTMLElement>): void {
  const keys = ["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"];
  if (!keys.includes(e.key)) return;
  const target = e.target as HTMLElement;
  // Leave text fields and selects their own arrow keys.
  if (target.closest("input, textarea, select")) return;
  const row = target.closest<HTMLElement>(ROW);
  if (!row || !e.currentTarget.contains(row)) return;
  const rows = visibleRows(e.currentTarget);
  const i = rows.indexOf(row);
  const go = (el: HTMLElement | undefined) => { if (el) { e.preventDefault(); el.focus(); } };
  const details = row.tagName === "SUMMARY" ? (row.parentElement as HTMLDetailsElement) : null;
  switch (e.key) {
    case "ArrowDown": go(rows[i + 1]); break;
    case "ArrowUp": go(rows[i - 1]); break;
    case "Home": go(rows[0]); break;
    case "End": go(rows[rows.length - 1]); break;
    case "ArrowRight":
      if (details && !details.open) { e.preventDefault(); details.open = true; }
      else if (details) go(rows[i + 1]);
      break;
    case "ArrowLeft":
      if (details && details.open) { e.preventDefault(); details.open = false; }
      else {
        const parent = (details ?? row).parentElement?.closest("details");
        const ps = parent?.querySelector<HTMLElement>(":scope > summary") ?? undefined;
        if (ps && e.currentTarget.contains(ps)) go(ps);
      }
      break;
  }
}
