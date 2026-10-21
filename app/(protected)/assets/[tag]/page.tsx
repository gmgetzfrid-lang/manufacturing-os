"use client";

// /assets/[tag] — the asset-as-hub "digital twin". One page per equipment tag
// (e.g. FE-201) that pulls together EVERYTHING controlled about that asset:
// its registry entry (type/location/description), every controlled document
// tagged to it, open holds on those docs, and its photos. Scan a QR on the
// equipment → land here. A view no shared-drive competitor can offer.
//
// PHYS-7 / HLD-13 (option (b), 2026-09-17): this stays a STAFF page — the
// label keeps the /assets/<tag> path every sticker in the plant already
// carries, and its caption now says "staff sign-in". A scan with no session
// used to sit on an empty app shell (refresh() returns early without an org,
// so the spinner never ended); it is now sent to sign-in with the tag in
// `next` — but only once getSession itself says there is NO session
// (lib/assetSignIn.ts): RoleContext's `booted` also flips on its boot
// watchdog while a slow network is still refreshing a signed-in token.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Tag as TagIcon, MapPin, FileText, AlertOctagon, Lock, RefreshCw, ImageIcon, Printer, Loader2, QrCode } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { getAssetByTag, listAssetPhotos, type Asset, type AssetPhoto } from "@/lib/assets";
import { tagKey } from "@/lib/codebook";
import { assetSignInHref, watchForNoSession, type NoSessionAnswer } from "@/lib/assetSignIn";
import AliasPanel from "@/components/assets/AliasPanel";
import MentionsPanel from "@/components/assets/MentionsPanel";
import { ScheduledWorkPanel } from "@/components/assets/AreaWorkPanel";
import AssetProvenancePanel from "@/components/assets/AssetProvenancePanel";
import { sheetMarkOf, sheetReadingOf } from "@/lib/relationProvenance";
import { stateStyle, documentState } from "@/lib/stateColors";

interface HubDoc {
  id: string; number: string; title: string; rev: string | null;
  status: string | null; libraryId: string | null; checkedOutByName: string | null;
  /** WIRE-1 / GAP-304: how the document↔equipment link was made, from the
   *  relation (document_assets). Absent for a document found only by its
   *  asset_tags (an unregistered tag). */
  link?: {
    source: string;                 // jsonb_sync | manual | drawing
    sheetLabel: string | null;      // GAP-301: "2002-D-10001 SHT 4"
    pages: number[];
    machine: boolean;               // GAP-303: a machine read it off the sheet — and no person said so
    /** GAP-303: a person also tagged the document with it (its asset_tags
     *  name the tag) — the link is theirs as much as the drawing's: while a
     *  'drawing' row holds the pair, the tag sync's own row is skipped, so
     *  the relation alone cannot say so. */
    personTagged: boolean;
    model: string | null;           // the AI model, when a page was transcribed
    /** I-32 (GOV-9 criterion 4): the mark the sheet address carries — one
     *  reading with the graph and the provenance view (lib/relationProvenance). */
    sheetMark: string | null;
    sourceRevision: string | null;  // the revision it was read from
    vanished: boolean;              // GAP-309: not read on the current revision
    superseded: boolean;            // read from an earlier revision
  };
}

/** Extracted, not applied (or a knowledge upload) — /api/equipment/sheets. */
interface ExtractedSheet {
  knowledgeDocumentId: string; documentId: string | null; name: string; libraryId: string | null;
  pages: number[]; sheets: string[];
}

type LinkRow = {
  document_id: string; source?: string | null; sheet_label?: string | null; pages?: number[] | null;
  asserted_by?: string | null; model?: string | null; source_revision?: string | null;
  vanished_at?: string | null; superseded_at?: string | null;
};

/** Ids per `.in()` request: the request line carries every id, and a longer
 *  list goes past the gateway's URL limit (lib/projects.ts IN_FILTER_CHUNK). */
const IN_CHUNK = 100;
/** The most links the relation read returns, and the most documents the
 *  asset_tags containment read returns. A read that reaches its cap may have
 *  left documents out — said on the page, never a silent cut. */
const HUB_LINK_CAP = 1000;
const HUB_TAGGED_CAP = 500;
/** A hold read that returns this many rows may have been cut at PostgREST's
 *  max-rows (no error): its documents count as not checked. */
const HOLD_ROWS_CAP = 1000;

/** WIRE-1 / WIRE-8: the asset's documents come from the relation
 *  (document_assets — every source: the tags typed on a document, manual
 *  links, and the drawings the Bridge read it on), read under the viewer's
 *  RLS. The columns a database may not have yet (20261170 / 20261171) are
 *  dropped one step at a time, never a failed page. */
async function readAssetLinks(assetId: string): Promise<{ rows: LinkRow[]; error: string | null }> {
  const attempts = [
    "document_id, source, sheet_label, pages, asserted_by, model, source_revision, vanished_at, superseded_at",
    "document_id, source, sheet_label, pages",
    "document_id, source",
  ];
  let last: string | null = null;
  for (const cols of attempts) {
    const { data, error } = await supabase.from("document_assets").select(cols).eq("asset_id", assetId).limit(HUB_LINK_CAP);
    if (!error) return { rows: (data ?? []) as unknown as LinkRow[], error: null };
    last = error.message;
    if (!(error.code === "42703" || error.code === "PGRST204" || /column/i.test(error.message ?? ""))) break;
  }
  return { rows: [], error: last };
}

export default function AssetHubPage() {
  const params = useParams();
  const tag = decodeURIComponent(String(params?.tag ?? ""));
  const { activeOrgId, hasAnyRole, uid, userEmail, booted, loading: roleLoading } = useRole();
  const router = useRouter();
  // Where a no-session scan goes: sign-in, carrying this tag (`next`).
  const signInHref = assetSignInHref(tag);
  // RoleContext settled with no user — which its boot watchdog also reports
  // while getSession is still pending. Confirm with getSession first: only a
  // definitive "no session" redirects; an errored read shows the sign-in
  // link without navigating away; until an answer comes the spinner stays.
  const maybeSignedOut = booted && !roleLoading && !uid;
  const [sessionAnswer, setSessionAnswer] = useState<NoSessionAnswer | null>(null);
  useEffect(() => {
    if (!maybeSignedOut) return;
    return watchForNoSession(() => supabase.auth.getSession(), (answer) => {
      setSessionAnswer(answer);
      if (answer === "none") router.replace(signInHref);
    });
  }, [maybeSignedOut, router, signInHref]);
  const signedOut = maybeSignedOut && sessionAnswer !== null;
  const [packing, setPacking] = useState(false);
  const [packProgress, setPackProgress] = useState<[number, number] | null>(null);
  const [packNote, setPackNote] = useState<string | null>(null);
  // PKG-12 (document-control P8): a pack over the field budget is refused
  // with a split — these are the parts this page then offers to print.
  const [packParts, setPackParts] = useState<string[][] | null>(null);

  const [asset, setAsset] = useState<Asset | null>(null);
  const [docs, setDocs] = useState<HubDoc[]>([]);
  const [holdsByDoc, setHoldsByDoc] = useState<Map<string, number>>(new Map());
  // Documents whose holds could not be read (a failed or cut read) — the
  // page says so, never "0 on hold" (fail closed), and the reason.
  const [holdsUnchecked, setHoldsUnchecked] = useState<{ ids: Set<string>; why: string } | null>(null);
  // A read that reached its cap — documents may be missing from the list.
  const [listCut, setListCut] = useState<string[]>([]);
  const [photos, setPhotos] = useState<AssetPhoto[]>([]);
  const [extracted, setExtracted] = useState<ExtractedSheet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** Print a doc pack of `ids` — the whole tag, or one part of the split a
   *  refused pack offers (PKG-12: "Print part 1 of N"). */
  const runPack = async (ids: string[], part?: { n: number; of: number }) => {
    if (!uid || !activeOrgId) return;
    setPacking(true);
    setPackNote(null);
    // No pre-seeded total: the pack gate may refuse sheets, so
    // the denominator comes from the builder's first progress
    // callback (the GATED count), never this page's raw count.
    setPackProgress(null);
    const partLabel = part ? ` (part ${part.n} of ${part.of})` : "";
    try {
      const { buildAndDownloadDocPack, PackTooLargeError, splitPackIds } = await import("@/lib/docPack");
      try {
        const result = await buildAndDownloadDocPack({
          orgId: activeOrgId,
          packLabel: `${tag}${partLabel}`,
          documentIds: ids,
          userId: uid,
          userEmail,
          onProgress: (done, total) => setPackProgress([done, total]),
          // PKG-12: this pack has no cover QR or print snapshot, so a sheet
          // too large for any pack is left out and named (never on a record
          // the field verifies against), not a refusal of the whole tag.
          sheetTooLarge: "leave_out",
        });
        // "all current" is an earned claim: docPack refuses
        // every sheet outside the verify allow-list (VFY-17),
        // held, unreadable or ack-gated, so zero skips means
        // every included sheet was Issued/Locked and hold-free
        // (PKG-4). A copy missing from the distribution record
        // is said (EGR-6, document-control P8).
        setPackNote(
          (result.skipped.length === 0
            ? `Pack${partLabel} ready — ${result.included} drawing${result.included === 1 ? "" : "s"}, all current, all stamped.`
            : `Pack${partLabel} ready — ${result.included} included; ${result.skipped.length} left out: ${result.skipped.map((s) => `${s.label} (${s.reason})`).join(", ")}.`) +
          (result.unrecorded.length > 0
            ? ` ${result.unrecorded.length} sheet${result.unrecorded.length === 1 ? " is" : "s are"} NOT on the distribution record (the record write was refused) — tell Document Control.`
            : ""),
        );
      } catch (e) {
        // PKG-12: over the budget → the split the refusal names, as parts
        // this page prints: the builder's own split, filled from the sheets'
        // sizes (`e.split` — one large sheet costs its own part, not a
        // one-sheet split of the tag), else uniform parts of `perPack`. A
        // refused PART is replaced by its own finer split. (A sheet over the
        // budget ON ITS OWN never refuses the pack: the builder leaves it out
        // as too large, names it in the note above, and builds the rest — it
        // is downloaded on its own.)
        if (e instanceof PackTooLargeError && e.perPack >= 1) {
          const split = e.split && e.split.length > 1 ? e.split : splitPackIds(ids, e.perPack);
          if (split.length > 1) {
            setPackParts((prev) => (part && prev && prev.length === part.of
              ? [...prev.slice(0, part.n - 1), ...split, ...prev.slice(part.n)]
              : split));
          }
        }
        throw e;
      }
    } catch (e) {
      setPackNote(`Pack${partLabel} failed: ${(e as Error).message}`);
    } finally {
      setPacking(false);
      setPackProgress(null);
    }
  };

  const refresh = useCallback(async () => {
    if (!activeOrgId || !tag) return;
    setLoading(true); setError(null); setPackParts(null);
    try {
      const a = await getAssetByTag(activeOrgId, tag).catch(() => null);
      setAsset(a);

      // WIRE-1 / BR-2: every controlled document the RELATION links to this
      // asset (document_assets, under the viewer's RLS) — so a drawing the
      // Bridge read the tag on is listed with its sheet. The asset_tags
      // containment read is kept beside it: it is the only answer for an
      // unregistered tag, and no document listed before disappears.
      // asset_tags: whether a person tagged the document with it (GAP-303).
      const docCols = "id, document_number, title, name, rev, status, library_id, checked_out_by_name, asset_tags";
      const keys = new Set([tagKey(tag), ...(a?.tag ? [tagKey(a.tag)] : [])].filter(Boolean));
      const typedOn = (r: Record<string, unknown>) => Array.isArray(r.asset_tags)
        && (r.asset_tags as Array<Record<string, unknown> | null>).some((e) => !!e && typeof e.tag === "string" && keys.has(tagKey(e.tag)));
      const links = a?.id ? await readAssetLinks(a.id) : { rows: [] as LinkRow[], error: null };
      if (links.error) throw new Error(links.error);
      const linkByDoc = new Map<string, LinkRow>();
      for (const l of links.rows) linkByDoc.set(String(l.document_id), l);
      const rowsById = new Map<string, Record<string, unknown>>();
      const linkedIds = [...linkByDoc.keys()];
      for (let i = 0; i < linkedIds.length; i += IN_CHUNK) {
        const { data, error: le } = await supabase.from("documents").select(docCols)
          .eq("org_id", activeOrgId).in("id", linkedIds.slice(i, i + IN_CHUNK)).neq("status", "Archived");
        if (le) throw new Error(le.message);
        for (const r of (data ?? []) as Array<Record<string, unknown>>) rowsById.set(String(r.id), r);
      }
      const { data: docRows, error: de } = await supabase
        .from("documents")
        .select(docCols)
        .eq("org_id", activeOrgId)
        .contains("asset_tags", [{ tag }])
        .neq("status", "Archived")
        .limit(HUB_TAGGED_CAP);
      if (de) throw new Error(de.message);
      const cut: string[] = [];
      if (links.rows.length >= HUB_LINK_CAP) cut.push(`the first ${HUB_LINK_CAP} links to ${tag}`);
      if ((docRows ?? []).length >= HUB_TAGGED_CAP) cut.push(`the first ${HUB_TAGGED_CAP} documents whose equipment tags name ${tag}`);
      setListCut(cut);
      for (const r of (docRows ?? []) as Array<Record<string, unknown>>) if (!rowsById.has(String(r.id))) rowsById.set(String(r.id), r);
      const mapped: HubDoc[] = [...rowsById.values()].map((r) => {
        const l = linkByDoc.get(String(r.id));
        const personTagged = typedOn(r);
        return {
          id: String(r.id),
          number: String(r.document_number || r.title || r.name || "—"),
          title: String(r.title || ""),
          rev: (r.rev as string) ?? null,
          status: (r.status as string) ?? null,
          libraryId: (r.library_id as string) ?? null,
          checkedOutByName: (r.checked_out_by_name as string) ?? null,
          link: l ? {
            source: String(l.source ?? "jsonb_sync"),
            sheetLabel: l.sheet_label ?? null,
            pages: Array.isArray(l.pages) ? l.pages : [],
            machine: (l.asserted_by ? l.asserted_by === "machine" : l.source === "drawing") && !personTagged,
            personTagged,
            model: l.model ?? null,
            sheetMark: sheetMarkOf(sheetReadingOf(l)),
            sourceRevision: l.source_revision ?? null,
            vanished: !!l.vanished_at,
            superseded: !!l.superseded_at,
          } : undefined,
        };
      }).sort((x, y) => x.number.localeCompare(y.number, undefined, { numeric: true }));
      setDocs(mapped);

      // GM-14: sheets whose indexed copy carries the tag but where no link
      // was recorded yet — served by the route (the entity index stays
      // service-role only), filtered to what this viewer can open.
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const res = await fetch(`/api/equipment/sheets?orgId=${encodeURIComponent(activeOrgId)}&tag=${encodeURIComponent(tag)}`, {
          headers: { Authorization: `Bearer ${session?.access_token ?? ""}` },
        });
        const json = await res.json().catch(() => ({}));
        setExtracted(res.ok ? ((json.extracted as ExtractedSheet[]) ?? []) : []);
        // The route's read reached its ceiling: the "Also read on" list may
        // be incomplete, said with the other cuts (never silently).
        if (res.ok && json.extractedCut === true) {
          cut.push(`the first ${typeof json.extractedCap === "number" ? `${json.extractedCap} ` : ""}indexed pages naming ${tag}`);
          setListCut([...cut]);
        }
      } catch { setExtracted([]); }

      // Open holds on those documents — in batches of IN_CHUNK ids (the list
      // grows with every drawing the relation links), each read checked. A
      // batch that fails, or comes back at the max-rows cap, leaves its
      // documents NOT CHECKED: the page says so instead of "0 on hold" — the
      // equipment QR code opens this page in the field.
      const ids = mapped.map((d) => d.id);
      const hold = new Map<string, number>();
      const unchecked = new Set<string>();
      let why: string | null = null;
      for (let i = 0; i < ids.length; i += IN_CHUNK) {
        const batch = ids.slice(i, i + IN_CHUNK);
        const { data: holdRows, error: he } = await supabase
          .from("document_holds").select("document_id").in("document_id", batch).is("released_at", null);
        const rows = (holdRows ?? []) as Array<{ document_id: string }>;
        if (he || rows.length >= HOLD_ROWS_CAP) {
          for (const id of batch) unchecked.add(id);
          why ??= he ? (he.message || "the read failed") : "too many open holds to read in one request";
          continue;
        }
        for (const h of rows) hold.set(h.document_id, (hold.get(h.document_id) ?? 0) + 1);
      }
      setHoldsByDoc(hold);
      setHoldsUnchecked(unchecked.size > 0 ? { ids: unchecked, why: why ?? "the read failed" } : null);

      if (a?.id) setPhotos(await listAssetPhotos(a.id).catch(() => []));
      else setPhotos([]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [activeOrgId, tag]);

  useEffect(() => { void refresh(); }, [refresh]);

  const docCount = docs.length;
  const heldCount = useMemo(() => Array.from(holdsByDoc.values()).reduce((a, b) => a + (b > 0 ? 1 : 0), 0), [holdsByDoc]);

  if (signedOut) {
    return (
      <div className="min-h-full flex flex-col items-center justify-center gap-2 p-6 text-center">
        <div className="text-sm font-bold text-[var(--color-text)]">Equipment <span className="font-mono">{tag}</span></div>
        <div className="text-xs text-[var(--color-text-muted)]">Drawings, holds and problem reports for this equipment are for signed-in staff.</div>
        <Link href={signInHref} className="text-xs font-bold text-blue-600 underline">Sign in to continue</Link>
      </div>
    );
  }

  if (loading && docs.length === 0 && !asset) {
    return <div className="min-h-full flex items-center justify-center"><Spinner /></div>;
  }

  return (
    <PageShell width="work">
        {/* Header */}
        <PageHeaderBar
          icon={TagIcon}
          title={<span className="font-mono">{tag}</span>}
          subtitle={
            <>
              {asset?.description || (asset ? "Registered asset" : "Unregistered tag — showing tagged documents")}
              {asset?.location && (
                <span className="mt-1 flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
                  <MapPin className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> {asset.location}
                </span>
              )}
            </>
          }
          actions={
            <>
              {/* One click from equipment tag → single stamped PDF of every
                  current drawing, each sheet carrying its own verify-QR. */}
              {docs.length > 0 && uid && activeOrgId && (
                <Button
                  size="sm"
                  disabled={packing}
                  onClick={() => void runPack(docs.map((d) => d.id))}
                >
                  {packing
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> {packProgress ? `Packing ${packProgress[0]}/${packProgress[1]}…` : "Packing…"}</>
                    : <><Printer className="w-3.5 h-3.5" /> Print doc pack</>}
                </Button>
              )}
              {/* Print the QR sticker that turns this equipment into an app
                  entry point: scan at the pump → this page. */}
              <Button
                variant="secondary"
                size="sm"
                onClick={async () => {
                  const { printEquipmentLabels } = await import("@/lib/physicalBridge");
                  await printEquipmentLabels([{
                    tag,
                    description: asset?.description ?? null,
                    location: asset?.location ?? null,
                  }]);
                }}
              >
                <QrCode className="w-3.5 h-3.5" /> QR label
              </Button>
              {/* Report a problem — pre-filled drafting request. The scan
                  landing must let the field WRITE, not just read. */}
              <Link
                href={`/requests/new?title=${encodeURIComponent(`Issue at ${tag}`)}&description=${encodeURIComponent(`Equipment: ${tag}${asset?.location ? ` (${asset.location})` : ""}\n\nDescribe the problem: `)}`}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold text-white bg-rose-600 hover:bg-rose-500 shadow-sm"
              >
                <AlertOctagon className="w-3.5 h-3.5" /> Report a problem
              </Link>
              <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={loading}>
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
              </Button>
            </>
          }
        />

        {packNote && (
          <div className={`mb-4 rounded-xl border p-3 text-xs ${/^Pack( \(part \d+ of \d+\))? failed/.test(packNote) ? "border-red-200 bg-red-50 text-red-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}>
            {packNote}
          </div>
        )}
        {packParts && packParts.length > 1 && uid && activeOrgId && (
          <div className="mb-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-xs flex flex-wrap items-center gap-2">
            <span className="text-[var(--color-text-muted)]">Too large for one field pack — print it in {packParts.length} parts:</span>
            {packParts.map((ids, i) => (
              <Button key={i} size="sm" variant="secondary" disabled={packing}
                onClick={() => void runPack(ids, { n: i + 1, of: packParts.length })}>
                <Printer className="w-3.5 h-3.5" /> Print part {i + 1} of {packParts.length} ({ids.length})
              </Button>
            ))}
          </div>
        )}

        {error && <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800">{error}</div>}

        {holdsUnchecked && (
          <div role="alert" data-testid="holds-unchecked" className="mb-4 rounded-xl border border-rose-300 bg-rose-50 p-3 text-xs text-rose-800">
            Holds could not be checked for {holdsUnchecked.ids.size === docs.length ? "these documents" : `${holdsUnchecked.ids.size} of these documents`} ({holdsUnchecked.why}).
            Treat {holdsUnchecked.ids.size === 1 ? "it" : "them"} as possibly on hold, and Refresh before you work from {holdsUnchecked.ids.size === 1 ? "it" : "them"}.
          </div>
        )}
        {listCut.length > 0 && (
          <div data-testid="list-cut" className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            Only {listCut.join(" and ")} were read — some documents may not be listed here. Search the register for {tag} to see them all.
          </div>
        )}

        {/* Stat strip */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
          <Stat icon={FileText} tone="blue" label="Controlled documents" value={docCount} />
          <Stat icon={AlertOctagon} tone="rose" label="On hold" value={holdsUnchecked ? (heldCount > 0 ? `${heldCount}+` : "not checked") : heldCount} />
          <Stat icon={ImageIcon} tone="violet" label="Photos" value={photos.length} />
        </div>

        {/* Documents */}
        <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm overflow-hidden mb-5">
          <div className="px-4 py-3 border-b border-[var(--color-border)] text-sm font-black text-[var(--color-text)] inline-flex items-center gap-2"><FileText className="w-4 h-4 text-blue-500" /> Controlled documents</div>
          {docs.length === 0 ? (
            <div className="p-8 text-center text-xs text-[var(--color-text-faint)] italic">No controlled documents are tagged to {tag} yet.</div>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {docs.map((d) => (
                <li key={d.id}>
                  <Link href={d.libraryId ? `/documents/${d.libraryId}?doc=${d.id}` : "/documents"} className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--color-surface-2)] transition-colors">
                    <span className="font-mono text-xs font-bold text-[var(--color-text)] truncate flex-1">{d.number}{d.title && d.title !== d.number ? <span className="font-sans font-normal text-[var(--color-text-muted)]"> — {d.title}</span> : ""}</span>
                    {/* GAP-301: the sheet the tag is on; GAP-303: who said so. */}
                    {/* GOV-9: a sheet address read off an AI transcription is unconfirmed — said here
                        when no "AI-read" badge stands beside it. I-32: so is the sweep's address on a
                        person's link (adopted: the row no longer names the model). */}
                    {d.link?.sheetLabel && <span className="text-[10px] font-bold font-mono text-[var(--color-text)] bg-[var(--color-surface-2)] px-1.5 py-0.5 rounded shrink-0">{d.link.sheetLabel}{d.link.sheetMark && !d.link.machine ? ` (${d.link.sheetMark})` : ""}</span>}
                    {d.link?.personTagged && d.link.source === "drawing" && (
                      <span className="text-[10px] font-bold text-[var(--color-text-muted)] bg-[var(--color-surface-2)] border border-[var(--color-border)] px-1.5 py-0.5 rounded shrink-0"
                        title={`Tagged on this document by a person (its equipment tags). The equipment sweep also read it off the drawing${d.link.model ? ` from an AI transcription (${d.link.model})` : ""}${d.link.sourceRevision ? `, Rev ${d.link.sourceRevision}` : ""}.`}>
                        tagged · also on drawing
                      </span>
                    )}
                    {d.link?.machine && (
                      <span className="text-[10px] font-bold text-violet-700 bg-violet-50 border border-violet-200 px-1.5 py-0.5 rounded shrink-0"
                        title={`Read off the drawing by the equipment sweep${d.link.model ? ` from an AI transcription (${d.link.model}) — check it against the sheet` : " from the drawing's own text"}${d.link.sourceRevision ? `, Rev ${d.link.sourceRevision}` : ""}. Not typed by a person.`}>
                        {d.link.model ? "AI-read" : "read from drawing"}
                      </span>
                    )}
                    {d.link?.vanished && <span className="text-[10px] font-bold text-amber-800 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded shrink-0" title={d.link.personTagged
                      ? "The current revision's drawing no longer shows this tag. The document's own equipment tags still name it, so the link stays whatever the sweep's review decides."
                      : "The current revision no longer shows this tag — waiting for a person to confirm in the equipment sweep."}>not on current rev</span>}
                    {d.link?.superseded && !d.link.vanished && <span className="text-[10px] font-bold text-[var(--color-text-muted)] shrink-0" title="Read from an earlier revision; the next sweep refreshes it.">earlier rev</span>}
                    {d.rev && <span className="text-[10px] font-bold bg-[var(--color-surface-2)] text-[var(--color-text-muted)] px-1.5 py-0.5 rounded shrink-0">Rev {d.rev}</span>}
                    {d.status && <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border shrink-0 ${stateStyle(documentState(d.status)).pill}`}>{d.status}</span>}
                    {(holdsByDoc.get(d.id) ?? 0) > 0 && <span className="text-[10px] font-bold text-rose-700 inline-flex items-center gap-0.5 shrink-0"><AlertOctagon className="w-3 h-3" /> hold</span>}
                    {holdsUnchecked?.ids.has(d.id) && <span className="text-[10px] font-bold text-rose-700 border border-rose-300 px-1 rounded inline-flex items-center gap-0.5 shrink-0" title="This document's holds could not be read — it may be on hold."><AlertOctagon className="w-3 h-3" /> hold not checked</span>}
                    {d.checkedOutByName && <span className="text-[10px] font-bold text-blue-700 inline-flex items-center gap-0.5 shrink-0"><Lock className="w-3 h-3" />{d.checkedOutByName}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* GM-14: read on these sheets, not linked yet (the sweep has not
            applied it, or the P&ID was uploaded straight into a knowledge
            library). Proposals, never presented as links. */}
        {extracted.length > 0 && (
          <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm overflow-hidden mb-5" data-testid="extracted-sheets">
            <div className="px-4 py-3 border-b border-[var(--color-border)] text-sm font-black text-[var(--color-text)]">Also read on (not linked yet)</div>
            <ul className="divide-y divide-[var(--color-border)]">
              {extracted.map((x) => (
                <li key={x.knowledgeDocumentId} className="px-4 py-2 text-xs flex items-center gap-2">
                  {x.documentId && x.libraryId
                    ? <Link href={`/documents/${x.libraryId}?doc=${x.documentId}`} className="font-mono font-bold hover:underline">{x.name}</Link>
                    : <span className="font-mono font-bold">{x.name}</span>}
                  <span className="text-[var(--color-text-muted)]">{x.sheets.join("; ")}</span>
                  <span className="ml-auto text-[10px] text-[var(--color-text-faint)]">{x.documentId ? "apply it from the equipment sweep" : "knowledge upload — see the coverage report"}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* GAP-303 acceptance 1 / GAP-316 (I-32): how we came to believe this —
            every relation with who or what asserted it, read under the
            viewer's own access. Closed until asked: the hub's load is
            unchanged. */}
        {asset?.id && activeOrgId && (
          <AssetProvenancePanel orgId={activeOrgId} assetId={asset.id} tag={asset.tag || tag} />
        )}

        {/* Every document that TALKS about this equipment, whether or not
            anyone remembered to tag it. Derived from the indexed text, with
            the sentence attached. */}
        {asset?.id && activeOrgId && (
          <MentionsPanel orgId={activeOrgId} assetId={asset.id} tag={tag} />
        )}

        {/* WIRE-7 (I-26): the open milestones whose location names this
            equipment — scheduled work, on its page. */}
        {asset?.id && activeOrgId && (
          <ScheduledWorkPanel orgId={activeOrgId} asset={{ id: asset.id, tag: asset.tag || tag }} />
        )}

        {/* What people actually call it — nicknames, old tags, vendor names */}
        {asset?.id && activeOrgId && (
          <AliasPanel
            orgId={activeOrgId}
            assetId={asset.id}
            canManage={hasAnyRole(["Admin", "DocCtrl", "Manager", "Supervisor"])}
            userId={uid ?? undefined}
            userName={userEmail ?? undefined}
          />
        )}

        {/* Photos */}
        {photos.length > 0 && (
          <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm p-4">
            <div className="text-sm font-black text-[var(--color-text)] inline-flex items-center gap-2 mb-3"><ImageIcon className="w-4 h-4 text-violet-500" /> Photos</div>
            <div className="flex flex-wrap gap-2">
              {photos.slice(0, 12).map((p) => (
                <div key={p.id} className="w-24 h-24 rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-border)] flex items-center justify-center text-[10px] text-[var(--color-text-faint)] overflow-hidden" title={p.caption || ""}>
                  {p.caption || "photo"}
                </div>
              ))}
            </div>
          </div>
        )}
    </PageShell>
  );
}

function Stat({ icon: Icon, label, value, tone }: { icon: React.ComponentType<{ className?: string }>; label: string; value: number | string; tone: "blue" | "rose" | "violet" }) {
  const tones = { blue: "text-blue-700 bg-blue-50 border-blue-200", rose: "text-rose-700 bg-rose-50 border-rose-200", violet: "text-violet-700 bg-violet-50 border-violet-200" };
  return (
    <div className={`rounded-2xl border p-3 ${tones[tone]}`}>
      <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide opacity-80"><Icon className="w-3.5 h-3.5" /> {label}</div>
      <div className="text-2xl font-black mt-1">{value}</div>
    </div>
  );
}
