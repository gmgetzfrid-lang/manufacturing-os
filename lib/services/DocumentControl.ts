import { supabase } from "@/lib/supabase";
import type { AssetTag, DocumentRecord, DocumentSet, DocumentVersion } from "@/types/schema";

export type RevisionImpact = {
  summary: string;
  changes: {
    added: AssetTag[];
    removed: AssetTag[];
    unchanged: AssetTag[];
  };
};

function normalizeTag(tag: AssetTag): string {
  return `${(tag.type || "equipment").toLowerCase()}::${tag.tag.toLowerCase()}`;
}

export function analyzeRevisionImpact(
  previous: AssetTag[] = [],
  next: AssetTag[] = []
): RevisionImpact {
  const prevMap = new Map(previous.map((t) => [normalizeTag(t), t]));
  const nextMap = new Map(next.map((t) => [normalizeTag(t), t]));

  const added: AssetTag[] = [];
  const removed: AssetTag[] = [];
  const unchanged: AssetTag[] = [];

  for (const [k, v] of nextMap) {
    if (!prevMap.has(k)) added.push(v);
    else unchanged.push(v);
  }

  for (const [k, v] of prevMap) {
    if (!nextMap.has(k)) removed.push(v);
  }

  const summary = `Asset impact: +${added.length} added, -${removed.length} removed, ${unchanged.length} unchanged.`;
  return { summary, changes: { added, removed, unchanged } };
}

export async function supersedeSheet(
  userId: string,
  userName: string,
  documentId: string | undefined,
  fileUrl: string,
  detectedTags: AssetTag[],
  options: {
    type: "Sheet" | "Set";
    newRevCode: string;
    reason: string;
    changeType: "Major" | "Minor" | "Correction";
  }
) {
  if (!documentId) throw new Error("Missing target document id.");

  const { data: docData, error: docError } = await supabase
    .from("documents")
    .select("*")
    .eq("id", documentId)
    .single();

  if (docError || !docData) throw new Error("Target document not found.");
  const record = docData as unknown as DocumentRecord & { id: string };

  // Create new version
  const { data: versionData, error: versionError } = await supabase
    .from("document_versions")
    .insert({
      org_id: record.orgId ?? null,
      record_id: documentId,
      revision_label: options.newRevCode,
      change_type: options.changeType,
      file_url: fileUrl,
      file_type: "pdf",
      created_by: userId,
      created_by_name: userName,
      change_log: options.reason,
    })
    .select("id")
    .single();

  if (versionError || !versionData) throw new Error("Failed to create version.");
  const versionId = (versionData as { id: string }).id;

  const historyEntry = {
    rev: options.newRevCode,
    date: new Date().toISOString(),
    user: userName,
    description: options.reason,
  };

  const existingHistory = Array.isArray(record.revisionHistory) ? record.revisionHistory : [];

  // Update document
  await supabase
    .from("documents")
    .update({
      current_version_id: versionId,
      rev: options.newRevCode,
      status: "Issued",
      asset_tags: detectedTags,
      updated_at: new Date().toISOString(),
      updated_by: userId,
      revision_history: [...existingHistory, historyEntry],
    })
    .eq("id", documentId);

  // Update set if applicable
  if (record.setId && options.type === "Set") {
    const { data: setData } = await supabase
      .from("document_sets")
      .select("*")
      .eq("id", record.setId)
      .single();

    if (setData) {
      const setRecord = setData as unknown as DocumentSet;
      const updates: Record<string, unknown> = {
        current_set_rev: options.newRevCode,
        updated_at: new Date().toISOString(),
      };

      if (setRecord.assetIndex) {
        const nextIndex = { ...(setRecord.assetIndex || {}) };
        for (const tag of detectedTags) {
          const key = tag.type || "Equipment";
          const list = new Set<string>(nextIndex[key] || []);
          list.add(tag.tag);
          nextIndex[key] = Array.from(list);
        }
        updates.asset_index = nextIndex;
      }

      await supabase.from("document_sets").update(updates).eq("id", record.setId);
    }
  }
}
