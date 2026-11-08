// projectUpload - a file uploaded straight from a project screen (the PSSR
// on the close-out) into document control: the project's own library and
// folder (Intake › where its files go), numbered, and linked to the
// project so it shows on its Documents tab and counts as its evidence.

import { supabase } from "@/lib/supabase";
import { createDocumentWithFile } from "@/lib/revisions";
import { noEmDash } from "@/lib/noEmDash";

export interface ProjectFileHome { name: string; libraryId: string | null; collectionId: string | null; libraries: Array<{ id: string; name: string }> }

/** Where the project's files go (its intake library and folder), and the
 *  libraries to pick from when it has none yet. */
export async function projectFileHome(orgId: string, projectId: string): Promise<ProjectFileHome> {
  const [p, libs] = await Promise.all([
    supabase.from("projects").select("name, intake_library_id, intake_collection_id").eq("id", projectId).maybeSingle(),
    supabase.from("libraries").select("id, name").eq("org_id", orgId).order("name"),
  ]);
  const row = (p.data ?? null) as { name?: string | null; intake_library_id?: string | null; intake_collection_id?: string | null } | null;
  return {
    name: row?.name ?? "Project",
    libraryId: row?.intake_library_id ?? null,
    collectionId: row?.intake_collection_id ?? null,
    libraries: ((libs.data ?? []) as Array<{ id: string; name: string | null }>).map((l) => ({ id: l.id, name: l.name ?? "Library" })),
  };
}

/** "PSSR-TRANSMIX-1-AND-2-20261108-1432": the kind, the project, when. */
export function projectDocNumber(prefix: string, projectName: string, at = new Date()): string {
  const slug = noEmDash(projectName).toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28).replace(/-+$/, "");
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return [prefix.toUpperCase(), slug, stamp].filter(Boolean).join("-");
}

/** Upload a file for the project: into its library (set as the project's
 *  file home when picked here for the first time), linked to the project.
 *  Returns the new document. */
export async function uploadProjectFile(input: {
  orgId: string; projectId: string; projectName: string; file: File;
  /** "PSSR" */
  prefix: string; title?: string;
  /** The library picked, when the project has none yet. */
  libraryId?: string | null;
  actorUserId: string; actorEmail?: string | null;
}): Promise<{ documentId: string; label: string }> {
  const home = await projectFileHome(input.orgId, input.projectId);
  const libraryId = home.libraryId ?? input.libraryId ?? null;
  if (!libraryId) throw new Error("Pick the library this project's files go in.");
  if (!home.libraryId) {
    // From now on the project's files go there (Intake shows the same).
    await supabase.from("projects").update({ intake_library_id: libraryId }).eq("id", input.projectId);
  }
  const number = projectDocNumber(input.prefix, input.projectName);
  const title = noEmDash(input.title?.trim() || `${input.prefix} - ${input.projectName}`);
  const { documentId } = await createDocumentWithFile({
    orgId: input.orgId, libraryId, collectionId: home.libraryId ? home.collectionId : null,
    documentNumber: number, title, file: input.file, actorUserId: input.actorUserId, actorEmail: input.actorEmail ?? undefined,
  });
  // On the project's Documents tab, and its evidence.
  await supabase.from("project_documents").upsert(
    { org_id: input.orgId, project_id: input.projectId, document_id: documentId, source: "manual", last_seen_at: new Date().toISOString() },
    { onConflict: "project_id,document_id", ignoreDuplicates: false },
  ).then(() => undefined, () => undefined);
  return { documentId, label: number };
}
