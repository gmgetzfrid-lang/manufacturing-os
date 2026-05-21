import {
  addDoc,
  collection,
  doc,
  getDoc,
  serverTimestamp,
  updateDoc,
  writeBatch,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
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

  const docRef = doc(db, "documents", documentId);
  const docSnap = await getDoc(docRef);
  if (!docSnap.exists()) throw new Error("Target document not found.");

  const record = { id: docSnap.id, ...(docSnap.data() as Record<string, unknown>) } as DocumentRecord;

  const versionPayload: Omit<DocumentVersion, "id"> = {
    orgId: record.orgId,
    recordId: documentId,
    revisionLabel: options.newRevCode,
    changeType: options.changeType,
    fileUrl,
    fileType: "pdf",
    createdBy: userId,
    createdByName: userName,
    createdAt: serverTimestamp(),
    changeLog: options.reason,
  };

  const batch = writeBatch(db);

  const versionRef = await addDoc(
    collection(db, "document_versions"),
    versionPayload as Record<string, unknown>
  );

  const historyEntry = {
    rev: options.newRevCode,
    date: serverTimestamp(),
    user: userName,
    description: options.reason,
  };

  batch.update(docRef, {
    currentVersionId: versionRef.id,
    rev: options.newRevCode,
    status: "Issued",
    assetTags: detectedTags,
    updatedAt: serverTimestamp(),
    updatedBy: userId,
    revisionHistory: Array.isArray(record.revisionHistory)
      ? [...record.revisionHistory, historyEntry]
      : [historyEntry],
  } as Record<string, unknown>);

  if (record.setId && options.type === "Set") {
    const setRef = doc(db, "documentSets", record.setId);
    const setSnap = await getDoc(setRef);
    if (setSnap.exists()) {
      const setData = { id: setSnap.id, ...(setSnap.data() as Record<string, unknown>) } as DocumentSet;
      batch.update(setRef, {
        currentSetRev: options.newRevCode,
        updatedAt: serverTimestamp(),
      } as Record<string, unknown>);

      if (setData.assetIndex) {
        const nextIndex = { ...(setData.assetIndex || {}) };
        for (const tag of detectedTags) {
          const key = tag.type || "Equipment";
          const list = new Set(nextIndex[key] || []);
          list.add(tag.tag);
          nextIndex[key] = Array.from(list);
        }
        batch.update(setRef, { assetIndex: nextIndex } as Record<string, unknown>);
      }
    }
  }

  await batch.commit();
}
