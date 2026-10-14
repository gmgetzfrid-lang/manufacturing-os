// lib/fileFinder/remote.ts — the map's data from the server in one call,
// with the browser-side loader as the fallback when the route is not there.

import { estatePost } from "@/lib/estate/client";
import { loadFinderData, type FinderData } from "./load";
import type { Role } from "@/types/schema";

type Wire = Omit<FinderData, "folders"> & { folders: Array<[string, FinderData["folders"] extends Map<string, infer V> ? V : never]> };

export async function fetchFinderData(orgId: string, role: Role, controller: boolean): Promise<FinderData> {
  const t0 = Date.now();
  try {
    const w = await estatePost<Wire>("/api/estate/map", { orgId });
    console.info(`[finder] server map in ${Date.now() - t0}ms`);
    return { ...w, folders: new Map(w.folders), assets: w.assets ?? [] };
  } catch (e) {
    console.warn("[finder] server map failed, loading in the browser:", (e as Error).message);
    return loadFinderData(orgId, role, controller);
  }
}
