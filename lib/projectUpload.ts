// projectUpload - a file uploaded straight from a project screen (the PSSR
// on the close-out, a turnover document) into document control, linked to
// the project so it shows on its Documents tab and counts as its evidence.
//
// Where it goes is the person's choice, asked the first time and kept as the
// project's place for its records (the library and the folder, in the
// project's settings). Nothing is filed until a place is picked: an upload
// never lands in a library or a folder nobody chose. The intake library and
// folder are a different thing (contractor submittals waiting on review) and
// are left alone.

import { supabase } from "@/lib/supabase";
import { createDocumentWithFile } from "@/lib/revisions";
import { moveDocumentsServer } from "@/lib/libraryCollections";
import { noEmDash } from "@/lib/noEmDash";

/** The library and folder a project's records are filed in (null folder:
 *  the top of the library, picked on purpose). */
export interface ProjectFilePlace { libraryId: string; collectionId: string | null }

export interface ProjectFileHome {
  name: string;
  /** The place picked for this project's records. Null: not picked yet. */
  place: ProjectFilePlace | null;
  /** "Procedures › Turnarounds › Transmix 1/2", for the place picked. */
  words: string | null;
  /** The folder's path, for the stored file. */
  folderPath: string[];
  libraries: Array<{ id: string; name: string }>;
}

/** The key the place is kept under in the project's settings. */
export const FILES_KEY = "files";

/** The place as saved, cleaned (null: none, or not a place). */
export function cleanPlace(raw: unknown): ProjectFilePlace | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const lib = typeof r.libraryId === "string" && r.libraryId ? r.libraryId : null;
  if (!lib) return null;
  return { libraryId: lib, collectionId: typeof r.collectionId === "string" && r.collectionId ? r.collectionId : null };
}

/** "Procedures › Turnarounds › Transmix 1/2"; the top of a library reads
 *  "Procedures (top level)". */
export function placeWords(library: string, path: string[]): string {
  return path.length ? [library, ...path].join(" › ") : `${library} (top level)`;
}

/** Where the project's records go, and the libraries to pick from. A place
 *  whose library or folder has since been deleted counts as not picked. */
export async function projectFileHome(orgId: string, projectId: string): Promise<ProjectFileHome> {
  const [p, libs] = await Promise.all([
    supabase.from("projects").select(`name, place:shift_times->${FILES_KEY}`).eq("id", projectId).maybeSingle(),
    supabase.from("libraries").select("id, name").eq("org_id", orgId).order("name"),
  ]);
  const row = (p.data ?? null) as { name?: string | null; place?: unknown } | null;
  const libraries = ((libs.data ?? []) as Array<{ id: string; name: string | null }>).map((l) => ({ id: l.id, name: l.name ?? "Library" }));
  const name = row?.name ?? "Project";
  const none: ProjectFileHome = { name, place: null, words: null, folderPath: [], libraries };
  const place = cleanPlace(row?.place);
  const lib = place ? libraries.find((l) => l.id === place.libraryId) : null;
  if (!place || !lib) return none;
  if (!place.collectionId) return { name, place, words: placeWords(lib.name, []), folderPath: [], libraries };
  const { data: col } = await supabase.from("collections").select("*").eq("id", place.collectionId).maybeSingle();
  const c = (col ?? null) as { name?: string | null; library_id?: string | null; path_names?: unknown; deleted_at?: string | null } | null;
  if (!c || c.deleted_at || c.library_id !== place.libraryId) return none;
  const path = Array.isArray(c.path_names) && c.path_names.length ? (c.path_names as unknown[]).map(String) : [c.name ?? "Folder"];
  return { name, place, words: placeWords(lib.name, path), folderPath: path, libraries };
}

/** Keep the place as the project's own (every other setting saved beside
 *  it stays as it is). */
export async function saveProjectFilePlace(projectId: string, place: ProjectFilePlace): Promise<void> {
  const { data: cur, error: readErr } = await supabase.from("projects").select("shift_times").eq("id", projectId).maybeSingle();
  if (readErr) throw new Error(`Not saved: the project's settings couldn't be read (${readErr.message}). Try again.`);
  const existing = ((cur as { shift_times?: Record<string, unknown> | null } | null)?.shift_times) ?? {};
  const { data, error } = await supabase.from("projects").update({ shift_times: { ...existing, [FILES_KEY]: { libraryId: place.libraryId, collectionId: place.collectionId } } }).eq("id", projectId).select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error("Not saved: only the project's owner, a co-owner or an admin can set where its files go.");
}

/** The project's name as the middle of a document number: whole words, up
 *  to 28 characters, never cut mid-word and never ending on a bare number
 *  ("Transmix-1/2 Turnaround 10-26 & 11-26" reads "TRANSMIX-1-2-TURNAROUND"). */
export function projectSlug(projectName: string): string {
  const words = noEmDash(projectName).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const kept: string[] = [];
  for (const w of words) {
    if ([...kept, w].join("-").length > 28) break;
    kept.push(w);
  }
  if (!kept.length && words.length) kept.push(words[0].slice(0, 28));
  // Trailing numbers are the tail of a date or a count cut short.
  while (kept.length > 1 && /^\d+$/.test(kept[kept.length - 1]) && kept.length < words.length) kept.pop();
  return kept.join("-");
}

/** "PSSR-TRANSMIX-1-2-TURNAROUND-2026-11-08": the kind, the project, the
 *  day. A second one that day gets "-2" (uniqueNumber). */
export function projectDocNumber(prefix: string, projectName: string, at = new Date(), part?: string | null): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const day = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
  const partSlug = part ? noEmDash(part).toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") : "";
  return [prefix.toUpperCase(), projectSlug(projectName), partSlug, day].filter(Boolean).join("-");
}

/** `base`, or `base-2`, `base-3`... : the first not in `taken`. */
export function uniqueNumber(base: string, taken: Iterable<string>): string {
  const have = new Set([...taken].map((t) => t.trim().toUpperCase()));
  if (!have.has(base.toUpperCase())) return base;
  for (let n = 2; n < 1000; n++) if (!have.has(`${base}-${n}`.toUpperCase())) return `${base}-${n}`;
  return `${base}-${Date.now()}`;
}

/** Upload a file for the project into the place picked for its records,
 *  linked to the project. Returns the new document. */
export async function uploadProjectFile(input: {
  orgId: string; projectId: string; projectName: string; file: File;
  /** "PSSR" */
  prefix: string; title?: string;
  /** The phase or part it is for, when there is one ("Phase 2"). */
  part?: string | null;
  actorUserId: string; actorEmail?: string | null;
}): Promise<{ documentId: string; label: string; words: string }> {
  const home = await projectFileHome(input.orgId, input.projectId);
  if (!home.place || !home.words) throw new Error("Pick where this project's files go first.");
  const base = projectDocNumber(input.prefix, input.projectName, new Date(), input.part);
  // Numbers already used in the organization that start the same way.
  const { data: same } = await supabase.from("documents").select("document_number").eq("org_id", input.orgId).ilike("document_number", `${base}%`).limit(1000);
  const number = uniqueNumber(base, ((same ?? []) as Array<{ document_number: string | null }>).map((d) => d.document_number ?? ""));
  const title = noEmDash(input.title?.trim() || `${input.prefix} - ${input.projectName}`);
  const { documentId } = await createDocumentWithFile({
    orgId: input.orgId, libraryId: home.place.libraryId, collectionId: home.place.collectionId, folderPath: home.folderPath,
    documentNumber: number, title, file: input.file, actorUserId: input.actorUserId, actorEmail: input.actorEmail ?? undefined,
  });
  // On the project's Documents tab, and its evidence.
  await supabase.from("project_documents").upsert(
    { org_id: input.orgId, project_id: input.projectId, document_id: documentId, source: "manual", last_seen_at: new Date().toISOString() },
    { onConflict: "project_id,document_id", ignoreDuplicates: false },
  ).then(() => undefined, () => undefined);
  return { documentId, label: number, words: home.words };
}

/** The kinds of file a project screen uploads (their numbers start with these). */
export const UPLOAD_PREFIXES = ["PSSR", "TURNOVER", "MI", "QAQC", "CHECKLIST"] as const;

export interface StrayFile { id: string; number: string; title: string; libraryId: string; libraryName: string; collectionId: string | null; sameLibrary: boolean }

/** Was this number made by a project screen's upload for this project? */
export function isProjectUploadNumber(number: string, projectName: string): boolean {
  const slug = projectSlug(projectName);
  const n = number.toUpperCase();
  return !!slug && UPLOAD_PREFIXES.some((p) => n.startsWith(`${p}-${slug}`));
}

/** Files uploaded from this project's screens that sit somewhere other
 *  than the place picked (uploads made before a place was asked for). */
export async function strayProjectFiles(orgId: string, projectId: string, home: ProjectFileHome): Promise<StrayFile[]> {
  if (!home.place) return [];
  const { data: links } = await supabase.from("project_documents").select("document_id").eq("project_id", projectId).limit(1000);
  const ids = ((links ?? []) as Array<{ document_id: string }>).map((l) => l.document_id);
  if (!ids.length) return [];
  const { data: docs } = await supabase.from("documents").select("id, document_number, title, name, library_id, collection_id").eq("org_id", orgId).in("id", ids);
  return ((docs ?? []) as Array<{ id: string; document_number: string | null; title: string | null; name: string | null; library_id: string; collection_id: string | null }>)
    .filter((d) => isProjectUploadNumber(d.document_number ?? "", home.name))
    .filter((d) => d.library_id !== home.place!.libraryId || (d.collection_id ?? null) !== home.place!.collectionId)
    .map((d) => ({
      id: d.id, number: d.document_number ?? "", title: d.title ?? d.name ?? "", libraryId: d.library_id,
      libraryName: home.libraries.find((l) => l.id === d.library_id)?.name ?? "another library",
      collectionId: d.collection_id ?? null, sameLibrary: d.library_id === home.place!.libraryId,
    }));
}

/** Move the strays that can be moved (same library) into the place picked. */
export async function moveStraysHere(orgId: string, home: ProjectFileHome, strays: StrayFile[]): Promise<number> {
  const ids = strays.filter((s) => s.sameLibrary).map((s) => s.id);
  if (!home.place || !ids.length) return 0;
  const r = await moveDocumentsServer({ orgId, docIds: ids, targetFolderId: home.place.collectionId });
  return r.moved;
}
