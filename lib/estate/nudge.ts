// lib/estate/nudge.ts — "something just landed; link it." Fire-and-forget
// from the browser after an upload or a folder creation. A failure here is
// invisible by design: the nightly resolver catches anything missed.

import { estatePost } from "./client";

export function nudgeEstateResolver(orgId: string, what: { documentIds?: string[]; folderIds?: string[] }): void {
  if (!orgId) return;
  if (!what.documentIds?.length && !what.folderIds?.length) return;
  void estatePost("/api/estate/resolve", { orgId, ...what }).catch(() => undefined);
}
