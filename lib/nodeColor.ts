// ORG-21 — a library's or folder's colour (libraries.color / collections.color)
// is drawn into inline CSS (a gradient on the card, the path chip, the folder
// rail). A value that is not a colour can close the gradient and add a
// url(...) layer, so every viewer's browser fetches an external URL. Every
// render site therefore draws a stored colour only when it is a hex colour,
// #rgb or #rrggbb, and otherwise draws what it draws for no colour at all.
//
// The node editor (components/documents/CustomizeNodeModal.tsx) offers twelve
// #rrggbb swatches and "Theme" (no colour); the app offers no named colour
// token, so none is accepted. The database refuses any other value from a
// signed-in writer on INSERT and UPDATE (20261216, the same pattern, held
// equal to NODE_COLOR_SQL_PATTERN by lib/__tests__/aoRoundGP15AppearanceFollowups.test.ts);
// a value already stored is never rewritten — it renders as no colour.

/** A hex colour: `#rgb` or `#rrggbb`. Nothing else is drawn. */
export const NODE_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** The same rule as a PostgreSQL regular expression (20261216's rail). */
export const NODE_COLOR_SQL_PATTERN = "^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$";

/** The stored colour when it is a hex colour, else undefined (draw the default). */
export function safeNodeColor(value: unknown): string | undefined {
  return typeof value === "string" && NODE_COLOR_PATTERN.test(value) ? value : undefined;
}
