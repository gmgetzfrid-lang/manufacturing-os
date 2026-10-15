// lib/find/client.ts — call the one find service from the browser.
import { estatePost } from "@/lib/estate/client";
import type { FindRequest, FindResponse } from "./types";

export async function findEstate(req: FindRequest): Promise<FindResponse> {
  return estatePost<FindResponse>("/api/find", req);
}
