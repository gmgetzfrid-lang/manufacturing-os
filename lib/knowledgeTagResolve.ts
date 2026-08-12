// lib/knowledgeTagResolve.ts — SERVER-ONLY. Resolve a human-typed equipment
// tag against what the entity index ACTUALLY stores.
//
// Salvaged from the retired line tracer, where it earned its keep in one
// production session: a trace refused with "X-35 is not in the tag index"
// while the index held the tag under a different spelling on another sheet,
// and the diagnosis it printed (nearest stored tags, index size) turned a
// dead end into a fix. People type X35, X-35, x 35, and unicode hyphens
// arrive via copy-paste; the index stores exactly one spelling. Every
// tag-keyed feature — census answers, sheet pointing, mentions — hits this
// same wall, so the resolver outlived the feature it was built for.

import { supabaseAdmin } from "@/lib/supabaseAdmin";

const squash = (t: string) => t.toUpperCase().replace(/[^A-Z0-9]/g, "");

export interface TagResolution {
  /** The index's own spelling, or null when the tag genuinely isn't there. */
  resolved: string | null;
  /** Human-readable account when resolution failed or corrected spelling. */
  diagnosis: string;
}

export async function resolveTagAgainstIndex(
  orgId: string, tag: string,
): Promise<TagResolution> {
  const exact = await supabaseAdmin
    .from("knowledge_page_entities").select("tag")
    .eq("org_id", orgId).eq("tag", tag).eq("kind", "equipment").limit(1).maybeSingle();
  if (exact.data) return { resolved: tag, diagnosis: "" };

  // Same letters+digits under a different spelling?
  const m = /^([A-Z]+)[^A-Z0-9]*(\d.*)$/i.exec(tag);
  if (m) {
    const { data } = await supabaseAdmin
      .from("knowledge_page_entities").select("tag")
      .eq("org_id", orgId).eq("kind", "equipment")
      .ilike("tag", `${m[1]}%`).limit(2000);
    const stored = [...new Set(((data ?? []) as Array<{ tag: string }>).map((r) => r.tag))];
    const hit = stored.find((t) => squash(t) === squash(tag));
    if (hit) return { resolved: hit, diagnosis: `${tag} is stored as ${hit}` };
    if (stored.length > 0) {
      return {
        resolved: null,
        diagnosis: `${tag} is not in the tag index; nearest stored ${m[1]}-tags: `
          + stored.sort().slice(0, 8).join(", "),
      };
    }
  }
  const { count } = await supabaseAdmin
    .from("knowledge_page_entities").select("id", { count: "exact", head: true })
    .eq("org_id", orgId).eq("kind", "equipment");
  return {
    resolved: null,
    diagnosis: `${tag} is not in the tag index (the index holds ${count ?? 0} equipment `
      + "tag entries in total"
      + ((count ?? 0) === 0
        ? " — a rebuild with image indexing ON has not completed for this library)"
        : ")"),
  };
}
