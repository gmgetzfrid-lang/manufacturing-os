#!/usr/bin/env python3
"""
scripts/thor_import.py — copy a THOR Indexer SQLite database into Supabase.

Reads the indexer's database (thor_knowledge.db) and upserts it into the
thor_* tables from supabase/migrations/20261022_thor_index.sql. Metadata only:
no file on the NAS is opened, nothing is re-crawled, no AI is called.

    SUPABASE_ACCESS_TOKEN=sbp_… python3 scripts/thor_import.py \
        --db thor_knowledge.db --project-ref <ref> --org <org uuid>

    python3 scripts/thor_import.py --db thor_knowledge.db --org <uuid> --dry-run

Writes go through the Supabase Management API's SQL endpoint over HTTPS
(api.supabase.com), so it works where a direct Postgres port is blocked.

Restartable and idempotent: every row is keyed by the indexer's own stable id
and upserted, so a re-run (or a later crawl's database) updates in place and
never duplicates. --only <table,…> re-runs part of it; --resume-from <table>
skips tables already done. Ends with a count check against the source.

Standard library only. The token rules mirror lib/thor/tokens.ts — keep the
two in step (lib/__tests__/thorTokens.test.ts pins the shared cases).
"""

import argparse
import json
import os
import re
import secrets
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

API = "https://api.supabase.com/v1/projects/{ref}/database/query"

# ── Tokens (mirror of lib/thor/tokens.ts) ────────────────────────────────────

_SPLIT = re.compile(r"[^a-z0-9.\-]+")
# A dot survives only between two digits (2010.03); anywhere else it separates
# (file.name.pdf, Rev.3).
_LONE_DOT = re.compile(r"(?<![0-9])\.|\.(?![0-9])")


def tokens(text):
    """Lowercase search tokens of [a-z0-9.]: 'V-3 PREFRAC.pdf' → v3 v 3 prefrac pdf."""
    out = []
    seen = set()

    def add(t):
        t = t.strip(".")
        if t and t not in seen:
            seen.add(t)
            out.append(t)

    for raw in _SPLIT.split(_LONE_DOT.sub(" ", (text or "").lower())):
        parts = [p for p in raw.split("-") if p.strip(".")]
        if len(parts) > 1:
            # V-3 → v3 (and v, 3): tags are written V-3, V3 and V 3.
            add("".join(parts))
        for p in parts:
            add(p)
    return out


def match_key(value):
    """Compact alias key: 'V-3' → 'v3', '2010.03' → '2010.03'."""
    return re.sub(r"[^a-z0-9.]", "", (value or "").lower())


# ── Helpers ──────────────────────────────────────────────────────────────────

UNIT_RE = re.compile(r"^(\d{4})\s*-")
EQUIP_RE = re.compile(r"^(\d{4})\.\d")
GENERIC_ROLES = {"directory", "sampled_root"}


def ns_to_iso(ns):
    if ns is None:
        return None
    try:
        return datetime.fromtimestamp(ns / 1e9, tz=timezone.utc).isoformat()
    except (OverflowError, OSError, ValueError):
        return None


def unit_of_equipment(number):
    m = EQUIP_RE.match(number or "")
    return str(int(m.group(1)) // 100 * 100) if m else None


def rel_of(unc, root):
    """'\\\\thor\\Equipment Files\\A\\B.pdf' → 'A/B.pdf' (root itself → '')."""
    if unc.lower().rstrip("\\") == root.lower().rstrip("\\"):
        return ""
    if not unc.lower().startswith(root.lower().rstrip("\\") + "\\"):
        return None
    return unc[len(root.rstrip("\\")) + 1:].rstrip("\\").replace("\\", "/")


def parent_rel(rel):
    return rel.rsplit("/", 1)[0] if "/" in rel else ""


def unit_parts(rel):
    segs = rel.split("/") if rel else []
    unit_folder = segs[0] if segs else None
    m = UNIT_RE.match(unit_folder or "")
    return unit_folder, (m.group(1) if m else None), (segs[1] if len(segs) > 1 else None)


# ── Supabase ─────────────────────────────────────────────────────────────────

class Target:
    def __init__(self, ref, token, dry_run):
        self.url = API.format(ref=ref) if ref else None
        self.token = token
        self.dry_run = dry_run

    def sql(self, query, retries=5):
        if self.dry_run:
            return []
        body = json.dumps({"query": query}).encode()
        for attempt in range(retries):
            req = urllib.request.Request(self.url, data=body, method="POST", headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
                "User-Agent": "thor-import/1",
            })
            try:
                with urllib.request.urlopen(req, timeout=300) as r:
                    return json.loads(r.read() or b"[]")
            except urllib.error.HTTPError as e:
                detail = e.read().decode(errors="replace")[:600]
                if e.code in (429, 500, 502, 503, 504) and attempt < retries - 1:
                    time.sleep(2 ** attempt * 2)
                    continue
                raise RuntimeError(f"HTTP {e.code}: {detail}") from None
            except (urllib.error.URLError, TimeoutError) as e:
                if attempt < retries - 1:
                    time.sleep(2 ** attempt * 2)
                    continue
                raise RuntimeError(str(e)) from None


def dollar(payload):
    """Wrap JSON in a dollar-quote whose tag cannot occur in it."""
    while True:
        tag = "$j" + secrets.token_hex(4) + "$"
        if tag not in payload:
            return f"{tag}{payload}{tag}"


# The SQL endpoint refuses large request bodies (HTTP 413); stay well under.
MAX_BATCH_BYTES = 700_000


def chunks(rows, batch):
    """Batches of at most `batch` rows and about MAX_BATCH_BYTES of JSON."""
    out, size = [], 0
    for r in rows:
        n = len(json.dumps(r, ensure_ascii=False, separators=(",", ":")).encode())
        if out and (len(out) >= batch or size + n > MAX_BATCH_BYTES):
            yield out
            out, size = [], 0
        out.append(r)
        size += n
    if out:
        yield out


def upsert(target, table, rows, columns, key, *, select=None, batch=2000, label=None):
    """jsonb_to_recordset → INSERT … ON CONFLICT (key) DO UPDATE, in batches.

    columns: [(name, pg_type)]; select: optional SELECT-list overriding the
    plain column list (for computed columns like search_tsv)."""
    label = label or table
    names = [c for c, _ in columns]
    defs = ", ".join(f"{c} {t}" for c, t in columns)
    target_cols = select[0] if select else names
    select_list = select[1] if select else ", ".join(names)
    updates = ", ".join(f"{c} = EXCLUDED.{c}" for c in target_cols if c not in key)
    done = 0
    t0 = time.time()
    for chunk in chunks(rows, batch):
        payload = json.dumps(chunk, ensure_ascii=False, separators=(",", ":"))
        q = (f"INSERT INTO {table} ({', '.join(target_cols)}) "
             f"SELECT {select_list} FROM jsonb_to_recordset({dollar(payload)}::jsonb) AS x({defs}) "
             f"ON CONFLICT ({', '.join(key)}) DO UPDATE SET {updates}")
        target.sql(q)
        done += len(chunk)
        rate = done / max(time.time() - t0, 0.001)
        print(f"\r  {label}: {done:,}/{len(rows):,}  ({rate:,.0f} rows/s)", end="", file=sys.stderr, flush=True)
    print(file=sys.stderr)


# ── Import ───────────────────────────────────────────────────────────────────

TABLE_ORDER = ["roots", "crawls", "directories", "entities", "aliases", "alias_entities",
               "files", "file_entities", "relationships", "doc_families", "doc_members",
               "identifiers", "evidence", "issues"]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", required=True, help="THOR Indexer SQLite database")
    ap.add_argument("--org", required=True, help="orgs.id the index belongs to")
    ap.add_argument("--project-ref", help="Supabase project ref (the subdomain of <ref>.supabase.co)")
    ap.add_argument("--dry-run", action="store_true", help="read and transform only; write nothing")
    ap.add_argument("--only", help="comma-separated subset of: " + ",".join(TABLE_ORDER))
    ap.add_argument("--resume-from", help="skip tables before this one")
    ap.add_argument("--batch", type=int, default=2000)
    args = ap.parse_args()

    token = os.environ.get("SUPABASE_ACCESS_TOKEN")
    if not args.dry_run and (not token or not args.project_ref):
        sys.exit("need SUPABASE_ACCESS_TOKEN and --project-ref (or --dry-run)")
    if not re.fullmatch(r"[0-9a-f-]{36}", args.org):
        sys.exit("--org must be a uuid")

    tables = TABLE_ORDER
    if args.only:
        tables = [t for t in TABLE_ORDER if t in args.only.split(",")]
    if args.resume_from:
        tables = tables[tables.index(args.resume_from):]

    db = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    tgt = Target(args.project_ref, token, args.dry_run)
    org = args.org
    skipped = []

    def rows(q):
        return [dict(r) for r in db.execute(q)]

    meta = {r["key"]: r["value"] for r in rows("SELECT key, value FROM meta")}
    roots = rows("SELECT * FROM roots")
    root_path = {r["root_id"]: r["path"] for r in roots}

    # Directory roles, for each file's nearest meaningful ancestor role.
    profiles = {}
    for p in rows("SELECT root_id, path, role, confidence, attributes_json FROM directory_profiles"):
        profiles[(p["root_id"], p["path"])] = p

    def role_for(root_id, folder_unc):
        path = folder_unc.rstrip("\\")
        root = root_path[root_id].rstrip("\\")
        while True:
            p = profiles.get((root_id, path))
            if p and p["role"] not in GENERIC_ROLES:
                return p["role"]
            if len(path) <= len(root):
                return None
            path = path.rsplit("\\", 1)[0]

    # Equipment: entity per number, aliases per entity.
    entities = rows("SELECT * FROM entities")
    entity_name = {e["entity_id"]: e["canonical_name"] for e in entities}
    equip_entity_by_number = {e["canonical_name"]: e["entity_id"] for e in entities if e["entity_type"] == "equipment"}
    aliases_by_entity = {}
    for r in rows("SELECT ac.entity_id, a.value FROM alias_candidates ac JOIN aliases a ON a.alias_id = ac.alias_id"):
        aliases_by_entity.setdefault(r["entity_id"], []).append(r["value"])

    # Equipment numbers per file: identifiers read from path/name + indexer links.
    file_equipment = {}
    for r in rows("SELECT file_id, value FROM identifiers WHERE type = 'equipment_number' AND file_id IS NOT NULL"):
        file_equipment.setdefault(r["file_id"], set()).add(r["value"])
    for r in rows("SELECT file_id, entity_id FROM document_links WHERE link_type = 'DOCUMENT_FOR_EQUIPMENT'"):
        n = entity_name.get(r["entity_id"])
        if n:
            file_equipment.setdefault(r["file_id"], set()).add(n)

    def j(v):
        try:
            return json.loads(v) if v else {}
        except ValueError:
            return {"raw": v}

    gen = j(meta.get(next((k for k in meta if k.startswith("production_pipeline")), ""), "{}"))

    # ── roots / crawls
    if "roots" in tables:
        upsert(tgt, "thor_roots", [{
            "org_id": org, "root_id": r["root_id"], "source": "THOR", "unc_path": r["path"],
            "norm_path": r["norm_path"], "created_at": r["created_at"], "last_crawl_at": r["last_crawl_at"],
            "explorer_completed_at": r["explorer_completed_at"], "enabled": bool(r["enabled"]),
            "indexer_name": "THOR Indexer", "indexer_version": gen.get("version"),
            "index_generated_at": gen.get("updated_at"),
        } for r in roots], [
            ("org_id", "uuid"), ("root_id", "text"), ("source", "text"), ("unc_path", "text"),
            ("norm_path", "text"), ("created_at", "timestamptz"), ("last_crawl_at", "timestamptz"),
            ("explorer_completed_at", "timestamptz"), ("enabled", "boolean"), ("indexer_name", "text"),
            ("indexer_version", "text"), ("index_generated_at", "timestamptz"),
        ], ["org_id", "root_id"], batch=args.batch)

    if "crawls" in tables:
        upsert(tgt, "thor_crawls", [dict(r, org_id=org) for r in rows("SELECT * FROM crawls")], [
            ("org_id", "uuid"), ("crawl_id", "text"), ("root_id", "text"), ("started_at", "timestamptz"),
            ("completed_at", "timestamptz"), ("status", "text"), ("files_seen", "int"),
            ("dirs_seen", "int"), ("issues", "int"),
        ], ["org_id", "crawl_id"], batch=args.batch)

    # ── files (built first in memory: directories roll up from them)
    print("reading files…", file=sys.stderr)
    file_rows = []
    dir_stats = {}  # (root_id, rel) → [direct, total, bytes, latest_ns]
    for f in db.execute("SELECT * FROM files"):
        f = dict(f)
        root = root_path.get(f["root_id"])
        rel = rel_of(f["path"], root) if root else None
        if rel is None or not f["filename"]:
            skipped.append(("files", f["file_id"], "path outside its root or no filename"))
            continue
        folder = parent_rel(rel)
        unit_folder, unit_code, category = unit_parts(rel)
        equipment = sorted(file_equipment.get(f["file_id"], ()))
        eq_tokens = []
        for n in equipment:
            eq_tokens += tokens(n)
            for a in aliases_by_entity.get(equip_entity_by_number.get(n), []):
                eq_tokens += tokens(a)
        ext = (f["extension"] or "").lower().lstrip(".")
        file_rows.append({
            "org_id": org, "file_id": f["file_id"], "root_id": f["root_id"], "unc_path": f["path"],
            "norm_path": f["norm_path"], "rel_path": rel, "folder_rel": folder,
            "filename": f["filename"], "stem": f["stem"], "extension": f["extension"] or "", "ext": ext,
            "depth": f["depth"], "size_bytes": f["size_bytes"], "mtime_ns": f["mtime_ns"],
            "ctime_ns": f["ctime_ns"], "modified_at": ns_to_iso(f["mtime_ns"]),
            "fs_created_at": ns_to_iso(f["ctime_ns"]),
            "unit_folder": unit_folder if folder else None, "unit_code": unit_code if folder else None,
            "category_folder": category if folder and "/" in folder else None,
            "folder_role": role_for(f["root_id"], f["parent_path"]),
            "equipment_numbers": equipment, "filename_class": f["filename_class"],
            "useful": bool(f["useful"]), "observation_state": f["observation_state"],
            "change_state": f["change_state"], "first_seen": f["first_seen"], "last_seen": f["last_seen"],
            "first_crawl": f["first_crawl"], "last_crawl": f["last_crawl"], "content_hash": f["content_hash"],
            "hash_alg": f["hash_alg"], "inspection_value": f["inspection_value"],
            "information_value": f["information_value"], "parsed_at": f["parsed_at"],
            "content_excerpt": f["content_excerpt"], "content_method": f["content_method"],
            "name_tok": tokens(f["filename"]),
            "eq_tok": list(dict.fromkeys(eq_tokens)),
            "path_tok": tokens(folder.replace("/", " ")),
        })
        # roll up into every ancestor folder
        segs = folder.split("/") if folder else []
        for k in range(len(segs) + 1):
            key = (f["root_id"], "/".join(segs[:k]))
            s = dir_stats.setdefault(key, [0, 0, 0, None])
            s[1] += 1
            s[2] += f["size_bytes"] or 0
            if f["mtime_ns"] and (s[3] is None or f["mtime_ns"] > s[3]):
                s[3] = f["mtime_ns"]
            if k == len(segs):
                s[0] += 1

    # ── directories: every folder the crawl walked + its role
    if "directories" in tables:
        dir_rows = []
        for d in rows("SELECT * FROM dir_queue"):
            root = root_path.get(d["root_id"])
            rel = rel_of(d["path"], root) if root else None
            if rel is None:
                skipped.append(("directories", d["path"], "outside its root"))
                continue
            p = profiles.get((d["root_id"], d["path"].rstrip("\\"))) or {}
            attrs = j(p.get("attributes_json"))
            unit_folder, unit_code, _ = unit_parts(rel)
            s = dir_stats.get((d["root_id"], rel), [0, 0, 0, None])
            dir_rows.append({
                "org_id": org, "root_id": d["root_id"], "rel_path": rel, "unc_path": d["path"],
                "parent_rel": parent_rel(rel) if rel else None,
                "name": rel.rsplit("/", 1)[-1] if rel else d["path"].rstrip("\\").rsplit("\\", 1)[-1],
                "depth": rel.count("/") + 1 if rel else 0, "unit_folder": unit_folder,
                "unit_code": unit_code, "role": p.get("role"), "role_confidence": p.get("confidence"),
                "role_basis": attrs.get("role_basis"), "indexed_at": d["updated_at"],
                "crawl_state": d["state"], "crawl_id": d["crawl_id"], "crawl_error": d["error"],
                "file_count": s[0], "total_files": s[1], "total_bytes": s[2],
                "latest_modified_at": ns_to_iso(s[3]),
            })
        upsert(tgt, "thor_directories", dir_rows, [
            ("org_id", "uuid"), ("root_id", "text"), ("rel_path", "text"), ("unc_path", "text"),
            ("parent_rel", "text"), ("name", "text"), ("depth", "int"), ("unit_folder", "text"),
            ("unit_code", "text"), ("role", "text"), ("role_confidence", "real"), ("role_basis", "text"),
            ("indexed_at", "timestamptz"), ("crawl_state", "text"), ("crawl_id", "text"),
            ("crawl_error", "text"), ("file_count", "int"), ("total_files", "int"),
            ("total_bytes", "bigint"), ("latest_modified_at", "timestamptz"),
        ], ["org_id", "root_id", "rel_path"], batch=args.batch)

    if "entities" in tables:
        upsert(tgt, "thor_entities", [{
            "org_id": org, "entity_id": e["entity_id"], "entity_type": e["entity_type"],
            "canonical_name": e["canonical_name"],
            "unit_code": unit_of_equipment(e["canonical_name"]) if e["entity_type"] == "equipment" else None,
            "scope": e["scope"], "status": e["status"], "confidence": e["confidence"],
            "authority": e["authority"], "persistence_class": e["persistence_class"],
            "first_seen": e["first_seen"], "last_validated": e["last_validated"],
            "attributes": j(e["attributes_json"]),
        } for e in entities], [
            ("org_id", "uuid"), ("entity_id", "text"), ("entity_type", "text"), ("canonical_name", "text"),
            ("unit_code", "text"), ("scope", "text"), ("status", "text"), ("confidence", "real"),
            ("authority", "text"), ("persistence_class", "int"), ("first_seen", "timestamptz"),
            ("last_validated", "timestamptz"), ("attributes", "jsonb"),
        ], ["org_id", "entity_id"], batch=args.batch)

    if "aliases" in tables:
        upsert(tgt, "thor_aliases", [dict(a, org_id=org, match_key=match_key(a["value"]),
                                          globally_unique=bool(a["globally_unique"]))
                                     for a in rows("SELECT * FROM aliases")], [
            ("org_id", "uuid"), ("alias_id", "text"), ("value", "text"), ("normalized", "text"),
            ("match_key", "text"), ("alias_type", "text"), ("specificity", "real"),
            ("globally_unique", "boolean"), ("status", "text"), ("created_at", "timestamptz"),
        ], ["org_id", "alias_id"], batch=args.batch)

    if "alias_entities" in tables:
        upsert(tgt, "thor_alias_entities", [dict(r, org_id=org) for r in rows("SELECT * FROM alias_candidates")], [
            ("org_id", "uuid"), ("alias_id", "text"), ("entity_id", "text"), ("confidence", "real"),
            ("evidence_count", "int"), ("independent_sources", "int"), ("scope", "text"),
        ], ["org_id", "alias_id", "entity_id"], batch=args.batch)

    if "files" in tables:
        cols = [
            ("org_id", "uuid"), ("file_id", "text"), ("root_id", "text"), ("unc_path", "text"),
            ("norm_path", "text"), ("rel_path", "text"), ("folder_rel", "text"), ("filename", "text"),
            ("stem", "text"), ("extension", "text"), ("ext", "text"), ("depth", "int"),
            ("size_bytes", "bigint"), ("mtime_ns", "bigint"), ("ctime_ns", "bigint"),
            ("modified_at", "timestamptz"), ("fs_created_at", "timestamptz"), ("unit_folder", "text"),
            ("unit_code", "text"), ("category_folder", "text"), ("folder_role", "text"),
            ("equipment_numbers", "text[]"), ("filename_class", "text"), ("useful", "boolean"),
            ("observation_state", "text"), ("change_state", "text"), ("first_seen", "timestamptz"),
            ("last_seen", "timestamptz"), ("first_crawl", "text"), ("last_crawl", "text"),
            ("content_hash", "text"), ("hash_alg", "text"), ("inspection_value", "real"),
            ("information_value", "real"), ("parsed_at", "timestamptz"), ("content_excerpt", "text"),
            ("content_method", "text"),
        ]
        plain = [c for c, _ in cols]
        tsv = ("setweight(array_to_tsvector(x.name_tok), 'A') || setweight(array_to_tsvector(x.eq_tok), 'B')"
               " || setweight(array_to_tsvector(x.path_tok), 'C')")
        upsert(tgt, "thor_files", file_rows,
               cols + [("name_tok", "text[]"), ("eq_tok", "text[]"), ("path_tok", "text[]")],
               ["org_id", "file_id"],
               select=(plain + ["search_tsv"], ", ".join("x." + c for c in plain) + ", " + tsv),
               batch=args.batch)

    if "file_entities" in tables:
        upsert(tgt, "thor_file_entities", [dict(r, org_id=org) for r in rows("SELECT * FROM document_links")], [
            ("org_id", "uuid"), ("link_id", "text"), ("file_id", "text"), ("entity_id", "text"),
            ("link_type", "text"), ("confidence", "real"), ("basis", "text"), ("evidence_path", "text"),
            ("created_at", "timestamptz"),
        ], ["org_id", "link_id"], batch=args.batch)

    if "relationships" in tables:
        upsert(tgt, "thor_relationships", [dict(r, org_id=org) for r in rows("SELECT * FROM relationships")], [
            ("org_id", "uuid"), ("rel_id", "text"), ("from_id", "text"), ("to_id", "text"),
            ("rel_type", "text"), ("confidence", "real"), ("status", "text"), ("authority", "text"),
            ("persistence_class", "int"), ("positive_score", "real"), ("negative_score", "real"),
            ("created_at", "timestamptz"), ("last_validated", "timestamptz"),
        ], ["org_id", "rel_id"], batch=args.batch)

    if "doc_families" in tables:
        upsert(tgt, "thor_doc_families", [dict(r, org_id=org) for r in rows("SELECT * FROM doc_families")], [
            ("org_id", "uuid"), ("family_id", "text"), ("base_identifier", "text"), ("family_type", "text"),
            ("confidence", "real"), ("created_at", "timestamptz"),
        ], ["org_id", "family_id"], batch=args.batch)

    if "doc_members" in tables:
        upsert(tgt, "thor_doc_members", [dict(r, org_id=org) for r in rows("SELECT * FROM doc_members")], [
            ("org_id", "uuid"), ("family_id", "text"), ("file_id", "text"), ("sheet", "text"),
            ("revision", "text"), ("member_type", "text"), ("confidence", "real"),
        ], ["org_id", "family_id", "file_id"], batch=args.batch)

    if "identifiers" in tables:
        upsert(tgt, "thor_identifiers", [dict(r, org_id=org) for r in rows("SELECT * FROM identifiers")], [
            ("org_id", "uuid"), ("identifier_id", "text"), ("file_id", "text"), ("root_id", "text"),
            ("type", "text"), ("value", "text"), ("raw_value", "text"), ("source", "text"),
            ("confidence", "real"), ("semantic_power", "real"), ("created_at", "timestamptz"),
        ], ["org_id", "identifier_id"], batch=args.batch * 2)

    if "evidence" in tables:
        ev = []
        for r in rows("SELECT * FROM evidence"):
            r["details"] = j(r.pop("details_json"))
            ev.append(dict(r, org_id=org))
        upsert(tgt, "thor_evidence", ev, [
            ("org_id", "uuid"), ("evidence_id", "text"), ("subject_type", "text"), ("subject_id", "text"),
            ("evidence_type", "text"), ("polarity", "int"), ("weight", "real"), ("source_file_id", "text"),
            ("source_root_id", "text"), ("lineage_key", "text"), ("description", "text"),
            ("observed_or_inferred", "text"), ("authority", "text"), ("created_at", "timestamptz"),
            ("details", "jsonb"),
        ], ["org_id", "evidence_id"], batch=args.batch * 2)

    if "issues" in tables:
        iss = []
        for r in rows("SELECT * FROM issues"):
            r["details"] = j(r.pop("details_json"))
            r["unc_path"] = r.pop("path")
            iss.append(dict(r, org_id=org))
        upsert(tgt, "thor_issues", iss, [
            ("org_id", "uuid"), ("issue_id", "text"), ("crawl_id", "text"), ("root_id", "text"),
            ("unc_path", "text"), ("reason_code", "text"), ("message", "text"),
            ("created_at", "timestamptz"), ("details", "jsonb"),
        ], ["org_id", "issue_id"], batch=args.batch)

    # ── Validate
    print("\nvalidation", file=sys.stderr)
    checks = [("thor_roots", "roots"), ("thor_crawls", "crawls"), ("thor_directories", "dir_queue"),
              ("thor_files", "files"), ("thor_entities", "entities"), ("thor_aliases", "aliases"),
              ("thor_alias_entities", "alias_candidates"), ("thor_file_entities", "document_links"),
              ("thor_relationships", "relationships"), ("thor_doc_families", "doc_families"),
              ("thor_doc_members", "doc_members"), ("thor_identifiers", "identifiers"),
              ("thor_evidence", "evidence"), ("thor_issues", "issues")]
    ok = True
    for pg, sq in checks:
        src = db.execute(f"SELECT COUNT(*) FROM {sq}").fetchone()[0]
        if args.dry_run:
            print(f"  {pg:<22} source {src:>9,}", file=sys.stderr)
            continue
        dst = tgt.sql(f"SELECT COUNT(*) AS n FROM {pg} WHERE org_id = '{org}'")[0]["n"]
        flag = "ok" if dst == src else "MISMATCH"
        ok &= dst == src
        print(f"  {pg:<22} source {src:>9,}  supabase {dst:>9,}  {flag}", file=sys.stderr)
    if not args.dry_run:
        bad = tgt.sql(f"SELECT COUNT(*) AS n FROM thor_files WHERE org_id = '{org}' AND "
                      "(unc_path IS NULL OR rel_path IS NULL OR filename = '' OR search_tsv IS NULL)")[0]["n"]
        print(f"  files missing required fields: {bad}", file=sys.stderr)
        ok &= bad == 0
    print(f"  skipped rows: {len(skipped)}", file=sys.stderr)
    for s in skipped[:50]:
        print("   ", s, file=sys.stderr)
    print("  NOT imported (crawler internals): file_retrieval_terms (rebuilt as thor_files.search_tsv), "
          "patterns, explorer_findings, enrichment, review_queue, ai_* tables", file=sys.stderr)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
