#!/usr/bin/env python3
"""
THOR Indexer — autonomous single-file refinery document intelligence crawler
Version 4.3.3

Goals:
- Strictly read-only against selected THOR/network roots.
- One cumulative SQLite knowledge base across roots and runs.
- Exhaustive cheap metadata inventory; selective high-information content inspection.
- Mandatory Stage Zero reconnaissance on new roots.
- Deterministic identifier/pattern/entity discovery first.
- Optional AI interpretation through Anthropic or OpenAI APIs.
- Evidence/provenance, ambiguity, conflicts, review queue, document families.
- Incremental updates, disappeared-file history, move candidates.
- Atomic self-describing thor_index.json export.

Python 3.10+. Standard library only for the core.
Optional local tools/libraries are detected but never required.
No API secret is stored in DB, logs, checkpoints, or JSON.
"""

from __future__ import annotations
import argparse, collections, concurrent.futures, contextlib, csv, datetime as dt
import hashlib, heapq, html, json, logging, math, mimetypes, os, queue, re, sqlite3
import stat, subprocess, sys, threading, time, traceback, urllib.request, urllib.error
import uuid, zipfile, zlib, getpass
from pathlib import Path
from typing import Any, Iterable, Optional

APP="THOR Indexer"; VERSION="4.3.3"; SCHEMA_VERSION="2.0"
DB_NAME="thor_knowledge.db"; CFG_NAME="thor_config.json"; LOG_NAME="thor_crawl.log"
CP_NAME="thor_checkpoint.json"; EXPORT_NAME="thor_index.json"
CREDENTIAL_NAME="thor_ai_credential.dpapi"  # Windows DPAPI, current user only

REASON_CODES = {
 "AMBIGUOUS_ALIAS","UNIT_CONFLICT","EQUIPMENT_CONFLICT","LOW_CONFIDENCE","LOW_EVIDENCE",
 "TEMPORAL_CONFLICT","MULTIPLE_ENTITY_CANDIDATES","UNRESOLVED_ENTITY","UNRESOLVED_DOCUMENT_TYPE",
 "PERMISSION_DENIED","INACCESSIBLE_PATH","ZERO_BYTE_FILE","POSSIBLE_DUPLICATE","BRIDGE_RELATIONSHIP",
 "HUMAN_REVIEWED","HUMAN_CONFIRMED","HUMAN_REJECTED","MACHINE_GENERATED_FILENAME",
 "HIGH_VALUE_DIRECTORY_CONTEXT","RELATED_NEIGHBOR_FILES","POSSIBLE_SCANNED_DOCUMENT",
 "REPARSE_POINT_SKIPPED","FILE_IO_ERROR","DIRECTORY_IO_ERROR","AI_UNAVAILABLE","AI_ANALYSIS_FAILED",
 "CONTENT_PARSE_FAILED","CONTENT_SOURCE_UNAVAILABLE","CONTENT_SOURCE_IO_ERROR","POSSIBLE_MOVE","EXPECTED_DOCUMENT_NOT_OBSERVED"
}
IDENT_PATTERNS = {
 "afe": re.compile(r"\bAFE[\s_-]?(\d{3,})\b",re.I),
 "equipment_number": re.compile(r"(?<!\d)(\d{4}\.\d{1,3})(?!\d)"),
 "drawing_ke": re.compile(r"\b(KE[\s_-]?\d{3,})\b",re.I),
 "pid_family": re.compile(r"\b(\d{4}[\s_-]?[A-Z][\s_-]?\d{3,})(?:[\s_-]?SHT(?:EET)?[\s_-]?(\d+))?\b",re.I),
 "sheet": re.compile(r"(?<![A-Za-z0-9])SHT(?:EET)?[\s_-]?(\d+)\b",re.I),
 "revision": re.compile(r"\bREV(?:ISION)?[\s_-]?([A-Z0-9]+)\b",re.I),
 "u1a": re.compile(r"\bU[\s_-]?1A\b",re.I),
}
MACHINE_RE=re.compile(r"^(?:DOC|SCAN|IMAGE|IMG|DSC|FILE)[\s_-]?\d{5,}$",re.I)
DATE_RES=[
 re.compile(r"\b(19\d{2}|20\d{2})[-_/](0?[1-9]|1[0-2])[-_/]([0-2]?\d|3[01])\b"),
 re.compile(r"\b(0?[1-9]|1[0-2])[-_/]([0-2]?\d|3[01])[-_/](19\d{2}|20\d{2})\b")
]
GENERIC={"document","drawing","scan","image","file","untitled","new document","copy"}

def utcnow(): return dt.datetime.now(dt.timezone.utc).isoformat()
def normpath(p): return os.path.normcase(os.path.abspath(os.path.normpath(p)))
def clamp(x,a=0.,b=1.): return max(a,min(b,x))
def sigmoid(x): return 1/(1+math.exp(-max(-40,min(40,x))))
def stable_id(prefix,*parts):
    raw="\x1f".join(str(x) for x in parts)
    return prefix+"_"+hashlib.sha256(raw.encode("utf-8","surrogatepass")).hexdigest()[:24]
def atomic_json(path:Path,obj):
    path.parent.mkdir(parents=True,exist_ok=True); tmp=path.with_suffix(path.suffix+".tmp")
    with open(tmp,"w",encoding="utf-8",newline="\n") as f:
        json.dump(obj,f,indent=2,ensure_ascii=False); f.flush(); os.fsync(f.fileno())
    os.replace(tmp,path)
def _dpapi_encrypt(secret: str) -> bytes:
    """Windows DPAPI current-user encryption; never write a plaintext secret."""
    if os.name != 'nt':
        raise RuntimeError('Encrypted credential persistence requires Windows')
    import ctypes
    from ctypes import wintypes
    class Blob(ctypes.Structure):
        _fields_ = [('cbData', wintypes.DWORD), ('pbData', ctypes.POINTER(ctypes.c_ubyte))]
    raw = secret.encode('utf-8')
    data = ctypes.create_string_buffer(raw)
    in_blob = Blob(len(raw), ctypes.cast(data, ctypes.POINTER(ctypes.c_ubyte)))
    out_blob = Blob()
    protect = ctypes.WinDLL('crypt32', use_last_error=True).CryptProtectData
    protect.argtypes = [ctypes.POINTER(Blob), wintypes.LPCWSTR, ctypes.c_void_p,
                        ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    protect.restype = wintypes.BOOL
    if not protect(ctypes.byref(in_blob), 'THOR Indexer encrypted AI credential',
                   None, None, None, 0x01, ctypes.byref(out_blob)):
        raise OSError(ctypes.get_last_error(), 'Windows DPAPI encryption failed')
    try:
        return ctypes.string_at(out_blob.pbData, out_blob.cbData)
    finally:
        _kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        _local_free = _kernel32.LocalFree
        _local_free.argtypes = [ctypes.c_void_p]
        _local_free.restype = ctypes.c_void_p
        _local_free(ctypes.cast(out_blob.pbData, ctypes.c_void_p))

def _dpapi_decrypt(encrypted: bytes) -> str:
    if os.name != 'nt':
        raise RuntimeError('Encrypted credential loading requires Windows')
    import ctypes
    from ctypes import wintypes
    class Blob(ctypes.Structure):
        _fields_ = [('cbData', wintypes.DWORD), ('pbData', ctypes.POINTER(ctypes.c_ubyte))]
    data = ctypes.create_string_buffer(encrypted)
    in_blob = Blob(len(encrypted), ctypes.cast(data, ctypes.POINTER(ctypes.c_ubyte)))
    out_blob = Blob()
    unprotect = ctypes.WinDLL('crypt32', use_last_error=True).CryptUnprotectData
    unprotect.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                          ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    unprotect.restype = wintypes.BOOL
    if not unprotect(ctypes.byref(in_blob), None, None, None, None, 0x01, ctypes.byref(out_blob)):
        raise OSError(ctypes.get_last_error(), 'Windows DPAPI decryption failed (same Windows account required)')
    try:
        return ctypes.string_at(out_blob.pbData, out_blob.cbData).decode('utf-8')
    finally:
        _kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        _local_free = _kernel32.LocalFree
        _local_free.argtypes = [ctypes.c_void_p]
        _local_free.restype = ctypes.c_void_p
        _local_free(ctypes.cast(out_blob.pbData, ctypes.c_void_p))

def _credential_file(workdir: Path) -> Path:
    return safe_output(workdir / CREDENTIAL_NAME, workdir)

def _store_encrypted_key(workdir: Path, secret: str):
    if not secret or not secret.strip():
        raise ValueError('Empty API key cannot be saved')
    blob = _dpapi_encrypt(secret.strip())  # Encrypt BEFORE writing anything to disk.
    path = _credential_file(workdir)
    tmp = path.with_suffix(path.suffix + '.tmp')
    try:
        with open(tmp, 'wb') as f:
            f.write(blob)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()

def _get_ai_key(workdir: Path, ai: dict):
    env_name = ai.get('api_key_env') or 'THOR_AI_API_KEY'
    # A user-managed encrypted credential takes precedence over a stale environment
    # variable from an earlier session, preventing accidental use of a different key.
    path = _credential_file(workdir)
    if path.is_file():
        try:
            key = _dpapi_decrypt(path.read_bytes())
        except Exception as exc:
            raise RuntimeError(f'Saved encrypted API key could not be unlocked: {type(exc).__name__}') from None
        if not key or not key.strip():
            raise RuntimeError('Saved encrypted API key is empty')
        return key.strip(), 'encrypted Windows credential'
    key = os.environ.get(env_name)
    if key and key.strip():
        return key.strip(), 'session environment'
    return None, None

def _prompt_ai_credential(workdir: Path, provider: str):
    if os.name != 'nt':
        print('Encrypted unattended key storage requires Windows; use the configured environment variable.')
        return None
    already = _credential_file(workdir).is_file()
    print('\nAPI KEY: The variable name above is NOT your key.')
    print('  A saved key is encrypted by Windows DPAPI for your Windows user.')
    print('  Your key will NOT be written into thor_config.json or the SQLite database.')
    print('  Existing saved key:', 'PRESENT' if already else 'NONE')
    choice = input('Paste and securely SAVE your actual '+provider+' API key for unattended runs? [y/N]: ').strip().lower()
    if choice not in ('y','yes'):
        return None
    key = getpass.getpass('Paste API key (hidden): ').strip()
    if not key:
        print('No key entered: existing credential remains unchanged.')
        return None
    return key

def child_of(c,p):
    try: return os.path.commonpath([normpath(c),normpath(p)])==normpath(p)
    except ValueError: return False
def safe_local_workspace(path):
    """Reject network/device locations and Windows UNC paths before any writes."""
    raw = str(path).strip()
    if not raw:
        raise SystemExit("SAFETY STOP: empty workspace")
    # Recognize Windows UNC/device paths regardless of host platform.
    canonical = raw.replace("/", chr(92))
    if canonical.startswith("\\\\") or raw.startswith("//"):
        raise SystemExit("SAFETY STOP: workspace cannot be a network/UNC path")
    p = Path(path).expanduser().resolve()
    # On Windows a mapped network drive must also be rejected.
    if os.name == "nt":
        import ctypes
        drive = p.drive
        if not drive or ctypes.windll.kernel32.GetDriveTypeW(str(drive) + chr(92)) != 3:
            raise SystemExit("SAFETY STOP: workspace must be on a fixed local drive")
    return p

def safe_output(path, workspace):
    """Require all generated exports/reports inside the approved local workspace."""
    base = safe_local_workspace(workspace)
    candidate = Path(path).expanduser().resolve()
    if not child_of(candidate, base):
        raise SystemExit("SAFETY STOP: output must remain inside local --workdir")
    return candidate

def json_loads(s,default=None):
    try:return json.loads(s)
    except Exception:return default

def classify_filename(name):
    stem=Path(name).stem.strip()
    if not stem:return "UNKNOWN"
    if MACHINE_RE.fullmatch(stem):return "MACHINE_GENERATED"
    if stem.casefold() in GENERIC:return "GENERIC"
    if any(p.search(stem) for p in IDENT_PATTERNS.values()):return "STRUCTURED_IDENTIFIER"
    if re.search(r"[A-Za-z]{3,}",stem):return "SEMANTIC"
    return "UNKNOWN"

def identifiers(text):
    out=[]
    for typ,p in IDENT_PATTERNS.items():
        for m in p.finditer(text):
            raw=m.group(0)
            if typ=="equipment_number": val=m.group(1)
            elif typ=="afe": val="AFE-"+m.group(1)
            elif typ=="u1a": val="U-1A"
            elif typ=="drawing_ke": val=re.sub(r"[\s_]+","-",m.group(1).upper())
            elif typ=="pid_family": val=re.sub(r"[\s_]+","-",m.group(1).upper())
            else: val=re.sub(r"[\s_]+","-",raw.upper())
            out.append((typ,val,raw))
    return out

def tokenize(s):
    return [x.casefold() for x in re.findall(r"[A-Za-z][A-Za-z0-9]{1,}|\d{4}\.\d+|AFE[-_]?\d+",s)]

SCHEMA=r"""
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS roots(root_id TEXT PRIMARY KEY,path TEXT UNIQUE NOT NULL,norm_path TEXT UNIQUE NOT NULL,
 created_at TEXT NOT NULL,last_crawl_at TEXT,explorer_completed_at TEXT,enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS crawls(crawl_id TEXT PRIMARY KEY,root_id TEXT NOT NULL,started_at TEXT NOT NULL,
 completed_at TEXT,status TEXT NOT NULL,files_seen INTEGER DEFAULT 0,dirs_seen INTEGER DEFAULT 0,issues INTEGER DEFAULT 0,
 FOREIGN KEY(root_id) REFERENCES roots(root_id));
CREATE TABLE IF NOT EXISTS dir_queue(root_id TEXT NOT NULL,path TEXT NOT NULL,state TEXT NOT NULL,crawl_id TEXT,
 updated_at TEXT NOT NULL,error TEXT,PRIMARY KEY(root_id,path));
CREATE TABLE IF NOT EXISTS files(file_id TEXT PRIMARY KEY,root_id TEXT NOT NULL,path TEXT NOT NULL,norm_path TEXT UNIQUE NOT NULL,
 filename TEXT NOT NULL,stem TEXT NOT NULL,extension TEXT NOT NULL,parent_path TEXT NOT NULL,depth INTEGER NOT NULL,
 size_bytes INTEGER,mtime_ns INTEGER,ctime_ns INTEGER,mode INTEGER,filename_class TEXT NOT NULL,useful INTEGER NOT NULL,
 first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,first_crawl TEXT NOT NULL,last_crawl TEXT NOT NULL,
 observation_state TEXT NOT NULL,change_state TEXT NOT NULL,content_hash TEXT,hash_alg TEXT,inspection_value REAL DEFAULT 0,
 parsed_at TEXT,content_excerpt TEXT,content_method TEXT,information_value REAL DEFAULT 0);
CREATE INDEX IF NOT EXISTS ix_files_root ON files(root_id);
CREATE INDEX IF NOT EXISTS ix_files_state ON files(observation_state);
CREATE INDEX IF NOT EXISTS ix_files_size ON files(size_bytes);
CREATE INDEX IF NOT EXISTS ix_files_name ON files(filename);
CREATE TABLE IF NOT EXISTS identifiers(identifier_id TEXT PRIMARY KEY,file_id TEXT,root_id TEXT,type TEXT NOT NULL,
 value TEXT NOT NULL,raw_value TEXT,source TEXT NOT NULL,confidence REAL NOT NULL,semantic_power REAL DEFAULT .5,
 created_at TEXT NOT NULL,FOREIGN KEY(file_id) REFERENCES files(file_id));
CREATE INDEX IF NOT EXISTS ix_ident_value ON identifiers(value);
CREATE INDEX IF NOT EXISTS ix_ident_type ON identifiers(type);
CREATE INDEX IF NOT EXISTS ix_ident_file_root ON identifiers(file_id,root_id);
CREATE TABLE IF NOT EXISTS entities(entity_id TEXT PRIMARY KEY,entity_type TEXT NOT NULL,canonical_name TEXT NOT NULL,
 scope TEXT,status TEXT NOT NULL,confidence REAL NOT NULL,authority TEXT NOT NULL,persistence_class INTEGER NOT NULL,
 first_seen TEXT NOT NULL,last_validated TEXT NOT NULL,attributes_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS aliases(alias_id TEXT PRIMARY KEY,value TEXT NOT NULL,normalized TEXT NOT NULL,alias_type TEXT NOT NULL,
 specificity REAL NOT NULL,globally_unique INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_alias_norm ON aliases(normalized);
CREATE TABLE IF NOT EXISTS alias_candidates(alias_id TEXT NOT NULL,entity_id TEXT NOT NULL,confidence REAL NOT NULL,
 evidence_count INTEGER NOT NULL DEFAULT 0,independent_sources INTEGER NOT NULL DEFAULT 0,scope TEXT,
 PRIMARY KEY(alias_id,entity_id));
CREATE TABLE IF NOT EXISTS relationships(rel_id TEXT PRIMARY KEY,from_id TEXT NOT NULL,to_id TEXT NOT NULL,
 rel_type TEXT NOT NULL,confidence REAL NOT NULL,status TEXT NOT NULL,authority TEXT NOT NULL,persistence_class INTEGER NOT NULL,
 positive_score REAL DEFAULT 0,negative_score REAL DEFAULT 0,created_at TEXT NOT NULL,last_validated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS evidence(evidence_id TEXT PRIMARY KEY,subject_type TEXT NOT NULL,subject_id TEXT NOT NULL,
 evidence_type TEXT NOT NULL,polarity INTEGER NOT NULL,weight REAL NOT NULL,source_file_id TEXT,source_root_id TEXT,
 lineage_key TEXT NOT NULL,description TEXT,observed_or_inferred TEXT NOT NULL,authority TEXT NOT NULL,
 created_at TEXT NOT NULL,details_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_ev_subject ON evidence(subject_type,subject_id);
CREATE TABLE IF NOT EXISTS technical_mentions(
 mention_id TEXT PRIMARY KEY,file_id TEXT NOT NULL,category TEXT NOT NULL,
 matched_text TEXT NOT NULL,context_excerpt TEXT NOT NULL,source_method TEXT NOT NULL,
 confidence REAL NOT NULL,verification_state TEXT NOT NULL DEFAULT 'unverified',
 created_at TEXT NOT NULL,FOREIGN KEY(file_id) REFERENCES files(file_id));
CREATE INDEX IF NOT EXISTS ix_mentions_file ON technical_mentions(file_id);
CREATE TABLE IF NOT EXISTS engineering_observations(
 observation_id TEXT PRIMARY KEY,file_id TEXT NOT NULL,category TEXT NOT NULL,
 property_name TEXT NOT NULL,raw_value TEXT NOT NULL,numeric_value REAL,unit TEXT,
 observed_span TEXT NOT NULL,context_excerpt TEXT NOT NULL,source_method TEXT NOT NULL,
 source_offset INTEGER NOT NULL,claim_scope TEXT NOT NULL DEFAULT 'source_document',
 verification_state TEXT NOT NULL DEFAULT 'source_observed',
 created_at TEXT NOT NULL,FOREIGN KEY(file_id) REFERENCES files(file_id));
CREATE INDEX IF NOT EXISTS ix_eng_observations_file ON engineering_observations(file_id);

CREATE TABLE IF NOT EXISTS document_links(
 link_id TEXT PRIMARY KEY,file_id TEXT NOT NULL,entity_id TEXT NOT NULL,link_type TEXT NOT NULL,
 confidence REAL NOT NULL,basis TEXT NOT NULL,evidence_path TEXT NOT NULL,created_at TEXT NOT NULL,
 UNIQUE(file_id,entity_id,link_type),FOREIGN KEY(file_id) REFERENCES files(file_id));
CREATE INDEX IF NOT EXISTS ix_doclinks_entity ON document_links(entity_id);
CREATE TABLE IF NOT EXISTS file_retrieval_terms(
 file_id TEXT NOT NULL,term TEXT NOT NULL,term_kind TEXT NOT NULL,origin TEXT NOT NULL,
 confidence REAL NOT NULL,entity_id TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(file_id,term,term_kind,origin,entity_id),
 FOREIGN KEY(file_id) REFERENCES files(file_id));
CREATE INDEX IF NOT EXISTS ix_retrieval_term ON file_retrieval_terms(term,term_kind);
CREATE TABLE IF NOT EXISTS doc_families(family_id TEXT PRIMARY KEY,base_identifier TEXT NOT NULL,family_type TEXT NOT NULL,
 confidence REAL NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS doc_members(family_id TEXT NOT NULL,file_id TEXT NOT NULL,sheet TEXT,revision TEXT,member_type TEXT,
 confidence REAL NOT NULL,PRIMARY KEY(family_id,file_id));
CREATE TABLE IF NOT EXISTS issues(issue_id TEXT PRIMARY KEY,crawl_id TEXT,root_id TEXT,path TEXT,reason_code TEXT NOT NULL,
 message TEXT,created_at TEXT NOT NULL,details_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS patterns(root_id TEXT NOT NULL,pattern_type TEXT NOT NULL,value TEXT NOT NULL,count INTEGER NOT NULL,
 example TEXT,last_updated TEXT NOT NULL,PRIMARY KEY(root_id,pattern_type,value));
CREATE TABLE IF NOT EXISTS directory_profiles(profile_id TEXT PRIMARY KEY,root_id TEXT NOT NULL,path TEXT NOT NULL,
 role TEXT NOT NULL,confidence REAL NOT NULL,authority_score REAL NOT NULL,attributes_json TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS explorer_findings(finding_id TEXT PRIMARY KEY,root_id TEXT NOT NULL,finding_type TEXT NOT NULL,
 key TEXT NOT NULL,value_json TEXT NOT NULL,confidence REAL NOT NULL,evidence_count INTEGER NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS enrichment(file_id TEXT PRIMARY KEY,recommended INTEGER NOT NULL,priority REAL NOT NULL,
 reason_codes_json TEXT NOT NULL,actions_json TEXT NOT NULL,expected_information_gain REAL NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS review_queue(review_id TEXT PRIMARY KEY,subject_type TEXT NOT NULL,subject_id TEXT NOT NULL,
 priority REAL NOT NULL,reason_codes_json TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS move_candidates(candidate_id TEXT PRIMARY KEY,old_file_id TEXT NOT NULL,new_file_id TEXT NOT NULL,
 confidence REAL NOT NULL,reasons_json TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_analyses(analysis_id TEXT PRIMARY KEY,scope_type TEXT NOT NULL,scope_id TEXT NOT NULL,
 provider TEXT,model TEXT,prompt_version TEXT,result_json TEXT NOT NULL,confidence REAL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_budget(
 budget_id TEXT PRIMARY KEY CHECK(budget_id='project'), authorized_usd REAL NOT NULL DEFAULT 0,
 estimated_spend_usd REAL NOT NULL DEFAULT 0, actual_spend_usd REAL NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_cost_ledger(
 ledger_id TEXT PRIMARY KEY,analysis_key TEXT NOT NULL,provider TEXT,model TEXT,reason TEXT NOT NULL,
 estimated_cost_usd REAL NOT NULL DEFAULT 0,actual_cost_usd REAL,input_tokens INTEGER,output_tokens INTEGER,
 expected_reuse_count INTEGER NOT NULL DEFAULT 0,expected_value REAL NOT NULL DEFAULT 0,
 decision TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_cost_analysis_key ON ai_cost_ledger(analysis_key) WHERE decision='executed';
-- Paid AI is an explicit, independently resumable local queue.
-- This ledger is intentionally separate from the pre-4.1 estimator.
CREATE TABLE IF NOT EXISTS ai_guard_state(
 guard_id TEXT PRIMARY KEY CHECK(guard_id='project'), legacy_spend_cents INTEGER NOT NULL,
 created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_jobs(
 job_id TEXT PRIMARY KEY, analysis_key TEXT NOT NULL UNIQUE, root_id TEXT NOT NULL,
 provider TEXT NOT NULL, model TEXT NOT NULL, system_prompt TEXT NOT NULL,
 user_prompt TEXT NOT NULL, reason TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','paused_budget','in_flight','uncertain_charge',
 'complete','complete_invalid','charged_no_result')),
 reserved_cents INTEGER NOT NULL DEFAULT 0, charged_cents INTEGER NOT NULL DEFAULT 0,
 input_tokens INTEGER, output_tokens INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
 result_json TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_ai_jobs_state ON ai_jobs(state,created_at);
"""

class AutoClosingConnection(sqlite3.Connection):
    """Ensure context-managed SQLite handles are actually CLOSED on Windows.

    sqlite3.Connection.__exit__ commits/rolls back, but does not close the file.
    """
    def __exit__(self, exc_type, exc_value, exc_tb):
        try:
            return super().__exit__(exc_type, exc_value, exc_tb)
        finally:
            self.close()

def connect(db):
    c=sqlite3.connect(db,timeout=60,factory=AutoClosingConnection); c.row_factory=sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL"); c.execute("PRAGMA foreign_keys=ON"); c.execute("PRAGMA synchronous=NORMAL"); c.execute("PRAGMA cache_size=-32768")
    return c
def init_db(db):
    with connect(db) as c:
        c.executescript(SCHEMA)
        c.execute("INSERT OR REPLACE INTO meta VALUES('schema_version',?)",(SCHEMA_VERSION,))
        c.execute("""INSERT OR IGNORE INTO ai_budget
                     (budget_id,authorized_usd,estimated_spend_usd,actual_spend_usd,updated_at)
                     VALUES('project',0,0,0,?)""",(utcnow(),))
        # Snapshot legacy spend once. New charges are tracked in ai_jobs, avoiding double count.
        old=c.execute("SELECT estimated_spend_usd,actual_spend_usd FROM ai_budget WHERE budget_id='project'").fetchone()
        legacy=max(float(old[0] or 0),float(old[1] or 0)) if old else 0.0
        c.execute("INSERT OR IGNORE INTO ai_guard_state(guard_id,legacy_spend_cents,created_at) VALUES('project',?,?)",
                  (max(0,math.ceil(legacy*100-1e-9)),utcnow()))

def default_config(workdir):
    return {
      "config_version":2,"created_at":utcnow(),"working_directory":str(workdir),
      "ai":{"enabled":False,"provider":"anthropic","model":"","api_key_env":"THOR_AI_API_KEY",
            "project_budget_usd":50.0,"max_input_chars_per_call":50000,
            "estimated_input_usd_per_million_tokens":0.0,
            "estimated_output_usd_per_million_tokens":0.0,
            "base_min_reusable_value":0.20},
      "crawl":{"metadata_workers":2,"follow_reparse_points":False,"checkpoint_seconds":10,"checkpoint_objects":500},
      "analysis":{"max_content_files_per_new_root":20,"max_content_files_per_update":10,
                  "max_file_read_bytes":4_000_000,"min_inspection_value":0.52,
                  "enable_local_content_parsing":True,"enable_ai":True},
      "safety":{"thor_read_only":True}
    }
# Curated identifiers, not a claim of account access or current prices.
# Model IDs verified against Anthropic's published Claude API model documentation
# on 2026-10-14. Availability/prices can change; paid calls always require opt-in.
AI_MODEL_CHOICES = {
    "anthropic": [
        ("Claude Opus 5.5", "claude-opus-5-5"),
        ("Claude Sonnet 5.5", "claude-sonnet-5-5"),
        ("Claude Fable 5.1", "claude-fable-5-1"),
        ("Claude Opus 5", "claude-opus-5"),
        ("Claude Sonnet 5", "claude-sonnet-5"),
        ("Claude Opus 4.6", "claude-opus-4-6"),
    ],
    "openai": [
        ("GPT-5.1", "gpt-5.1"),
        ("GPT-5 mini", "gpt-5-mini"),
        ("GPT-4.1", "gpt-4.1"),
    ],
}
MODEL_PRICE_DEFAULTS = {
    "claude-opus-5":(5.0,25.0),
    "claude-opus-5-5":(4.0,20.0),
    "claude-sonnet-5-5":(2.0,10.0),
    "claude-fable-5-1":(10.0,50.0),
}

def choose_ai_provider(current="anthropic"):
    providers = [("Anthropic (Claude)", "anthropic"), ("OpenAI (GPT)", "openai")]
    print("\nAI provider:")
    for i, (label, value) in enumerate(providers, 1):
        print(f"  {i}. {label} [{value}]")
    default = next((i for i, (_, value) in enumerate(providers, 1) if value == current), 1)
    while True:
        answer = input(f"Choose provider 1-{len(providers)} [Enter={default}]: ").strip()
        if not answer: return providers[default-1][1]
        if answer.isdigit() and 1 <= int(answer) <= len(providers):
            return providers[int(answer)-1][1]
        print("Please select one of the displayed numbers.")

def choose_ai_model(provider, current=""):
    options = AI_MODEL_CHOICES[provider]
    print(f"\n{provider.title()} API models (API availability depends on your account):")
    for i, (label, api_id) in enumerate(options, 1):
        print(f"  {i}. {label} — {api_id}")
    custom_number = len(options)+1
    print(f"  {custom_number}. Other (enter exact API model ID)")
    default = next((i for i, (_, api_id) in enumerate(options, 1) if api_id == current), None)
    if current and default is None:
        print(f"  Current custom model: {current}")
    while True:
        prompt = f"Choose model 1-{custom_number}"
        if current: prompt += " [Enter keeps current]"
        else: prompt += " [Enter leaves AI unconfigured]"
        answer = input(prompt + ": ").strip()
        if not answer: return current
        if answer.isdigit() and 1 <= int(answer) <= len(options):
            return options[int(answer)-1][1]
        if answer == str(custom_number):
            api_id = input("Exact API model ID (not a display name): ").strip()
            # A typo such as 'opus 5.5' cannot silently be accepted.
            if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._:/-]{1,127}", api_id):
                print("Invalid model ID format; no spaces permitted.")
                continue
            return api_id
        print("Please select one of the displayed numbers.")

def choose_ai_enabled(current=False):
    print("\nAI-assisted indexing uses a paid external API and is NOT needed for ingestion.")
    print("  1. Disabled (recommended; deterministic indexing only)")
    print("  2. Enabled (requires model, API key, explicit token prices and budget)")
    default = 2 if current else 1
    while True:
        answer = input(f"Choose AI mode 1-2 [Enter={default}]: ").strip()
        if not answer: return bool(current)
        if answer in ("1", "2"): return answer == "2"
        print("Please select 1 or 2.")

def _money_prompt(label, current, upper=100000.0):
    """Require confirmation for every price/budget; never consume a second field silently."""
    while True:
        raw = input(f"\n{label} [current ${float(current):.4f}; Enter keeps]: ").strip()
        try:
            value = float(raw) if raw else float(current)
        except (ValueError, TypeError):
            print("Invalid USD amount; try again.")
            continue
        if not math.isfinite(value) or not (0 <= value < upper):
            print("Invalid USD amount; try again.")
            continue
        print(f"  {label}: ${value:.4f}")
        response = input("Confirm THIS value? Type YES, or R to re-enter: ").strip().upper()
        if response == "YES":
            return value
        print("Value NOT accepted. Re-enter it.")

def _review_configuration(cfg):
    ai = cfg.get("ai", {})
    print("\n" + "="*51)
    print("REVIEW CONFIGURATION — NOTHING HAS BEEN SAVED YET")
    print("="*51)
    print("AI enabled:", "YES (potential paid calls)" if ai.get("enabled") else "NO (deterministic indexing)")
    if ai.get("enabled"):
        print("Provider:", ai.get("provider"))
        print("Model API ID:", ai.get("model"))
        print("Input USD / million tokens:", ai.get("estimated_input_usd_per_million_tokens"))
        print("Output USD / million tokens:", ai.get("estimated_output_usd_per_million_tokens"))
        print("Maximum lifetime AI budget USD:", ai.get("project_budget_usd"))
        if not ai.get("model") or float(ai.get("estimated_input_usd_per_million_tokens",0) or 0)<=0 or float(ai.get("estimated_output_usd_per_million_tokens",0) or 0)<=0:
            print("NOTE: Paid AI calls cannot run without a model and positive token prices.")
    print("All database/index outputs remain in the local workspace.")
    print("To save, type APPLY. Any other answer cancels WITHOUT CHANGING SETTINGS.")
    return input("Save these settings? ").strip().upper() == "APPLY"

def _edit_ai_settings(cfg, current=False, workdir=None):
    ai = cfg.setdefault("ai", {})
    ai["enabled"] = choose_ai_enabled(current)
    if ai["enabled"]:
        old_provider = ai.get("provider", "anthropic")
        ai["provider"] = choose_ai_provider(old_provider)
        ai["model"] = choose_ai_model(ai["provider"], ai.get("model", "") if ai["provider"] == old_provider else "")
        if not ai["model"]:
            ai["enabled"] = False
            print("No model selected: AI stays disabled.")
            return None
        # API key is requested below as an ACTUAL key and stored encrypted.
        # Do not confuse users with environment-variable configuration prompts.
        ai['api_key_env'] = ai.get('api_key_env') or 'THOR_AI_API_KEY'
        if ai['provider']=='anthropic' and ai['model'] in MODEL_PRICE_DEFAULTS:
            standard_in,standard_out=MODEL_PRICE_DEFAULTS[ai['model']]
            print(f"\nPublished Anthropic standard rate for {ai['model']}: input ${standard_in}/MTok, output ${standard_out}/MTok (as verified 2026-10-14).")
            if (input('Use these suggested standard rates? [Y/n]: ').strip().lower() or 'y')=='y':
                ai['estimated_input_usd_per_million_tokens']=standard_in
                ai['estimated_output_usd_per_million_tokens']=standard_out
        print("\nPrice fields are planning values, not binding provider quotes. Confirm before paid execution.")
        ai["estimated_input_usd_per_million_tokens"] = _money_prompt(
            "INPUT price USD per 1,000,000 tokens", ai.get("estimated_input_usd_per_million_tokens", 0))
        ai["estimated_output_usd_per_million_tokens"] = _money_prompt(
            "OUTPUT price USD per 1,000,000 tokens", ai.get("estimated_output_usd_per_million_tokens", 0))
        ai["project_budget_usd"] = _money_prompt("TOTAL lifetime AI budget USD", ai.get("project_budget_usd", 50), 1e9)
        return _prompt_ai_credential(workdir, ai['provider']) if workdir is not None else None
    return None

def setup(workdir):
    safe_local_workspace(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    cp = workdir/CFG_NAME
    if not cp.exists():
        print("\nTHOR Indexer — First-Time Setup\n" + "="*35)
        cfg = default_config(workdir)
        print("THOR is read-only; all DB/log/index output stays in this local workspace.")
        pending_key = _edit_ai_settings(cfg, False, workdir)
        if not _review_configuration(cfg):
            print("SETUP CANCELLED: No configuration saved or budget modified.")
            return None
        if pending_key is not None:
            _store_encrypted_key(workdir, pending_key)
            print('API KEY: encrypted and saved for this Windows account.')
        atomic_json(cp, cfg)
    else:
        cfg = json.loads(cp.read_text(encoding="utf-8"))
    init_db(workdir/DB_NAME)
    _retarget_unstarted_ai_jobs(workdir, cfg.get('ai', {}))
    with connect(workdir/DB_NAME) as c:
        budget = float(cfg.get("ai", {}).get("project_budget_usd", 0.0) or 0.0)
        c.execute("UPDATE ai_budget SET authorized_usd=?,updated_at=? WHERE budget_id='project'",
                  (budget, utcnow()))
    logging.basicConfig(filename=workdir/LOG_NAME, level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    return cfg

def reconfigure(workdir):
    """Safely reconfigure, with explicit per-value confirmation and final APPLY gate."""
    safe_local_workspace(workdir)
    cp = workdir/CFG_NAME
    if not cp.is_file():
        print("No previous configuration found; starting first-time setup.")
        return setup(workdir)
    cfg = json.loads(cp.read_text(encoding="utf-8"))
    print("\nTHOR Indexer — Reconfigure")
    print("Existing knowledge, crawl history and AI spending will be preserved.")
    pending_key = _edit_ai_settings(cfg, bool(cfg.get("ai", {}).get("enabled", False)), workdir)
    if not _review_configuration(cfg):
        print("SETUP CANCELLED: No configuration saved or budget modified.")
        return None
    if pending_key is not None:
        _store_encrypted_key(workdir, pending_key)
        print('API KEY: encrypted and saved for this Windows account.')
    init_db(workdir/DB_NAME)
    ai = cfg["ai"]
    budget = float(ai.get("project_budget_usd", 0.0) or 0.0)
    with connect(workdir/DB_NAME) as c:
        row = c.execute("SELECT estimated_spend_usd,actual_spend_usd FROM ai_budget WHERE budget_id='project'").fetchone()
        spent = max(float(row[0]), float(row[1])) if row else 0.0
        if budget < spent:
            print(f"Warning: budget below recorded spend (${spent:.4f}); future paid calls blocked.")
        c.execute("UPDATE ai_budget SET authorized_usd=?,updated_at=? WHERE budget_id='project'", (budget,utcnow()))
    atomic_json(cp, cfg)
    converted = _retarget_unstarted_ai_jobs(workdir, ai)
    print("Configuration saved:", cp)
    if converted:
        print(f'PENDING AI JOBS: {converted} unstarted job(s) updated to {ai["model"]}; no AI charges.')
    print(f"AI: {'enabled' if ai['enabled'] else 'disabled'}; prior spend: ${spent:.4f}")
    return cfg


def _retarget_unstarted_ai_jobs(workdir: Path, ai: dict) -> int:
    """Keep prior queued work usable after setup switches model; never resubmit a billed job.

    Operates only on never-attempted queued jobs (including paused_budget).
    If an existing job for target model exists, keep both untouched and let
    the paid runner fail closed so an operator can investigate.
    """
    if not ai.get('enabled') or not ai.get('model') or ai.get('provider')!='anthropic':
        return 0
    db = workdir / DB_NAME
    if not db.exists():
        return 0
    changed = 0
    with connect(db) as c:
        c.execute('BEGIN IMMEDIATE')
        jobs = c.execute("""SELECT job_id,provider,model,system_prompt,user_prompt
                     FROM ai_jobs WHERE state IN ('queued','paused_budget') AND attempts=0
                     ORDER BY created_at""").fetchall()
        for job in jobs:
            if job['provider']==ai['provider'] and job['model']==ai['model']:
                continue
            new_analysis_key=stable_id('ai-cache',ai['provider'],ai['model'],job['system_prompt'],job['user_prompt'])
            collision=c.execute('SELECT job_id FROM ai_jobs WHERE analysis_key=?',(new_analysis_key,)).fetchone()
            if collision:
                continue
            c.execute("""UPDATE ai_jobs SET provider=?,model=?,analysis_key=?,updated_at=?
                         WHERE job_id=? AND state IN ('queued','paused_budget') AND attempts=0""",
                      (ai['provider'],ai['model'],new_analysis_key,utcnow(),job['job_id']))
            changed+=1
    return changed

def issue(c,crawl,root,path,code,msg,details=None):
    iid=stable_id("issue",crawl,path,code,str(msg),uuid.uuid4())
    c.execute("INSERT INTO issues VALUES(?,?,?,?,?,?,?,?)",
              (iid,crawl,root,path,code,str(msg),utcnow(),json.dumps(details or {})))
def safety(workdir,root):
    safe_local_workspace(workdir)
    if child_of(workdir,root): raise SystemExit("SAFETY STOP: local working directory is inside the selected THOR root.")
    if not os.path.isdir(root): raise SystemExit(f"Root unavailable: {root}")

def validate_disjoint_roots(workdir, requested):
    """Prevent nested/overlapping roots from corrupting root ownership.

    Identical roots may be revisited. Nested roots are rejected until a
    deliberate cross-root ownership policy is implemented.
    """
    requested=[os.path.abspath(os.path.normpath(r)) for r in requested]
    with connect(workdir/DB_NAME) as db:
        existing=[r[0] for r in db.execute("SELECT path FROM roots")]
    for i,a in enumerate(requested):
        for b in existing + requested[:i]:
            if normpath(a)==normpath(b):
                continue
            if child_of(a,b) or child_of(b,a):
                raise SystemExit("SAFETY STOP: overlapping source roots cannot share a cumulative index yet: " + repr(a) + " / " + repr(b))

def register_root(c,root):
    root=os.path.abspath(os.path.normpath(root)); n=normpath(root)
    r=c.execute("SELECT * FROM roots WHERE norm_path=?",(n,)).fetchone()
    if r:return r
    rid=stable_id("root",n)
    c.execute("INSERT INTO roots(root_id,path,norm_path,created_at) VALUES(?,?,?,?)",(rid,root,n,utcnow()))
    return c.execute("SELECT * FROM roots WHERE root_id=?",(rid,)).fetchone()

def is_reparse(e):
    try:
        if e.is_symlink():return True
        return bool(getattr(e.stat(follow_symlinks=False),"st_file_attributes",0)&0x400)
    except OSError:return False

_PATTERN_BATCH = None

def up_pattern(c,rid,typ,val,example):
    global _PATTERN_BATCH
    if _PATTERN_BATCH is not None:
        key=(rid,typ,val)
        if key in _PATTERN_BATCH:
            old=_PATTERN_BATCH[key]
            _PATTERN_BATCH[key]=(old[0]+1,old[1])
        else:
            _PATTERN_BATCH[key]=(1,example[:500])
        return
    c.execute("""INSERT INTO patterns VALUES(?,?,?,?,?,?)
      ON CONFLICT(root_id,pattern_type,value) DO UPDATE SET count=count+1,last_updated=excluded.last_updated""",
      (rid,typ,val,1,example[:500],utcnow()))

def flush_patterns(c):
    global _PATTERN_BATCH
    if not _PATTERN_BATCH:return
    now=utcnow()
    data=[(rid,typ,val,n,example,now) for (rid,typ,val),(n,example) in _PATTERN_BATCH.items()]
    c.executemany("""INSERT INTO patterns VALUES(?,?,?,?,?,?) ON CONFLICT(root_id,pattern_type,value)
                     DO UPDATE SET count=patterns.count+excluded.count,last_updated=excluded.last_updated""",data)
    _PATTERN_BATCH.clear()

def inspection_score(path,size,fclass,depth):
    s=.12
    ext=Path(path).suffix.casefold()
    if fclass=="STRUCTURED_IDENTIFIER":s+=.20
    if fclass=="MACHINE_GENERATED":s+=.16
    if ext in {".pdf",".docx",".xlsx",".xlsm",".txt",".csv",".xml",".html",".htm"}:s+=.18
    low=path.casefold()
    if any(x in low for x in ("drawing","inspection","code document","project","afe","engineering","issued for construction")):s+=.18
    if any(x in low for x in ("archive","temp","backup","personal")):s-=.05
    if size and size<20_000_000:s+=.05
    if depth>=2:s+=.03
    return clamp(s)

def observe(c,rootrow,crawl,path,st,depth):
    n=normpath(path); old=c.execute("SELECT * FROM files WHERE norm_path=?",(n,)).fetchone()
    name=os.path.basename(path); stem,ext=os.path.splitext(name); fc=classify_filename(name)
    mtime=getattr(st,"st_mtime_ns",int(st.st_mtime*1e9)); ctime=getattr(st,"st_ctime_ns",int(st.st_ctime*1e9))
    # Keep incidental OS/CAD sidecars in the inventory, but never treat them as searchable engineering content.
    incidental=(name.casefold() in {"thumbs.db","desktop.ini",".ds_store"} or ext.casefold() in {".dwl",".dwl2",".tmp",".lock"} or name.startswith("~$"))
    if incidental: fc="GENERIC"
    useful=int(st.st_size>0 and not incidental); score=(0.0 if incidental else inspection_score(path,st.st_size,fc,depth)); now=utcnow()
    if old:
        changed=old["size_bytes"]!=st.st_size or old["mtime_ns"]!=mtime
        fid=old["file_id"]
        c.execute("""UPDATE files SET path=?,filename=?,stem=?,extension=?,parent_path=?,depth=?,size_bytes=?,
          mtime_ns=?,ctime_ns=?,mode=?,filename_class=?,useful=?,last_seen=?,last_crawl=?,observation_state='current',
          change_state=?,inspection_value=? WHERE file_id=?""",
          (path,name,stem,ext.casefold(),os.path.dirname(path),depth,st.st_size,mtime,ctime,st.st_mode,fc,useful,now,crawl,
           "changed" if changed else "unchanged",score,fid))
    else:
        fid=stable_id("file",n); changed=True
        c.execute("""INSERT INTO files(file_id,root_id,path,norm_path,filename,stem,extension,parent_path,depth,size_bytes,
          mtime_ns,ctime_ns,mode,filename_class,useful,first_seen,last_seen,first_crawl,last_crawl,observation_state,
          change_state,inspection_value) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
          (fid,rootrow["root_id"],path,n,name,stem,ext.casefold(),os.path.dirname(path),depth,st.st_size,mtime,ctime,st.st_mode,
           fc,useful,now,now,crawl,crawl,"current","new",score))
    c.execute("DELETE FROM identifiers WHERE file_id=? AND source='path_or_filename'",(fid,))
    # Do not inherit an unrelated identifier from a higher-level root/path segment.
    for typ,val,raw in identifiers(os.path.relpath(path,rootrow["path"])):
        sem=.9 if typ in {"equipment_number","afe","drawing_ke","pid_family"} else .65
        iid=stable_id("ident",fid,typ,val,"path")
        c.execute("INSERT OR REPLACE INTO identifiers VALUES(?,?,?,?,?,?,?,?,?,?)",
                  (iid,fid,rootrow["root_id"],typ,val,raw,"path_or_filename",1.,sem,now))
    up_pattern(c,rootrow["root_id"],"extension",ext.casefold() or "<none>",path)
    up_pattern(c,rootrow["root_id"],"filename_class",fc,path)
    # Folder-name patterns are important Stage Zero observations.
    for seg in Path(os.path.relpath(os.path.dirname(path),rootrow["path"])).parts:
        if seg not in {".",".."}: up_pattern(c,rootrow["root_id"],"directory_name",seg,path)
    return fid,changed

def directory_scan_priority(path, root):
    """Breadth first, then active before archival folders, using bounded metadata only.

    Preserves files in archives for eventual full inventory. Does not skip folders.
    """
    relative=os.path.relpath(path, root)
    parts=() if relative=='.' else Path(relative).parts
    archival=any(re.search(r'(^|[\s_-])(?:archive|archived|old revs?|history)(?:$|[\s_-])', part, re.I)
                 for part in parts)
    templated=any('template' in part.casefold() for part in parts)
    return (len(parts), bool(templated), bool(archival), relative.casefold())

PROJECT_AFE_RE=re.compile(r'(?<![A-Za-z0-9])AFE[\s_-]*(\d{4,7})(?:[-_](?:\d{2}|XX))?(?!\d)',re.I)
PROJECT_DS_REV_RE=re.compile(r'(?i)(?:^|[\s_-])r([A-Z0-9]{1,3})(?=\.[^.]+$)')

def root_project_identity(root):
    """Use only an explicit real AFE number in the indexed project's folder name."""
    label=os.path.basename(os.path.normpath(root))
    if 'template' in label.casefold():return None
    match=PROJECT_AFE_RE.search(label)
    return 'AFE-'+match.group(1) if match else None

def conservative_datasheet_family(filename, project):
    """Revisions only for explicit V-3 equipment datasheets; never merge other types."""
    if not project or not re.search(r'(?i)\bV[-_ ]?3\b',filename):return None
    if not re.search(r'(?i)\bDS\b',filename):return None
    rev=PROJECT_DS_REV_RE.search(filename)
    if not rev:return None
    label=filename.casefold().replace('prefactionator','prefractionator')
    if 'prefractionator' not in label:return None
    if not re.search(r'2010\.03',filename):return None
    return (project+' / 2010.03 / V-3 PREFRACTIONATOR DATASHEET',rev.group(1).upper())

PROJECT_REV_RE=re.compile(r"(?i)(?:^|[\s_.-])(?:rev(?:ision)?|r)[\s_.-]*([A-Z0-9]{1,3})(?=$|[\s_.-])")

def conservative_project_revision_family(filename, project):
    """Only explicit revisioned descriptive documents; preserve filenames and every member.

    Does not infer latest/current/superseded and does not merge source files.
    """
    if not project or filename.startswith('~$'):
        return None
    stem=Path(filename).stem
    hits=list(PROJECT_REV_RE.finditer(stem))
    if not hits:return None
    match=hits[-1]
    rev=match.group(1).upper()
    base=(stem[:match.start()]+stem[match.end():]).strip(' ._-')
    # Explicit annotations are variants of a revision, not a new revision.
    comment=bool(re.search(r'(?i)\b(?:commented|comments|markup|redline|marked)\b',base))
    base=re.sub(r'(?i)(?:[\s_.-]+)(?:commented|comments|markup|redline|marked)\b','',base).strip(' ._-')
    normalized=re.sub(r'[\s_.-]+',' ',base).strip().casefold()
    # Require a meaningful document name, not generic REV files or number-only images.
    if len(normalized)<16 or len(normalized.split())<3 or not re.search(r'[a-z]{3,}',normalized):
        return None
    if Path(filename).suffix.casefold() not in {'.pdf','.docx','.doc','.xlsx','.xlsm','.dwg','.txt'}:
        return None
    return (project+' / '+normalized,rev,comment)

def _inventory_directory(path):
    """Worker: filesystem metadata ONLY. No SQLite calls or source writes.

    Work is bounded by the configured number of active directories, not one
    future per file. Large individual directories can still use memory;
    the watcher exposes those cases via progress and the user can interrupt.
    """
    subdirs=[]; files=[]; problems=[]
    try:
        with os.scandir(path) as entries:
            for e in entries:
                try:
                    if is_reparse(e):
                        problems.append((e.path,'REPARSE_POINT_SKIPPED','Reparse point not traversed'))
                    elif e.is_dir(follow_symlinks=False):
                        subdirs.append(e.path)
                    elif e.is_file(follow_symlinks=False):
                        files.append((e.path,e.stat(follow_symlinks=False)))
                except OSError as ex:
                    problems.append((e.path,'FILE_IO_ERROR',str(ex)))
        return (subdirs,files,problems,None)
    except OSError as ex:
        return (subdirs,files,problems,ex)

def _lower_process_priority_for_workstation():
    """Make indexing polite to interactive Windows work; never adjust THOR/NAS."""
    if os.name!='nt':return
    try:
        import ctypes
        k=ctypes.windll.kernel32
        # BELOW_NORMAL_PRIORITY_CLASS for THIS process only, never global/system-wide.
        k.SetPriorityClass(k.GetCurrentProcess(),0x00004000)
        print('Windows process priority: Below Normal (keeps workstation responsive).',flush=True)
    except Exception as ex:
        print(f'WARNING: could not lower local process priority: {ex}',flush=True)

def _load_census(census, root):
    if not census:return None
    ref=Path(census).expanduser().resolve()
    safe_local_workspace(ref.parent)  # must be a fixed local drive
    obj=json.loads(ref.read_text(encoding='utf-8'))
    if normpath(obj.get('root',''))!=normpath(root):
        raise SystemExit('CENSUS STOP: census root does not match source root')
    info=obj.get('census',{})
    if not info.get('exact') or info.get('errors',1)!=0:
        raise SystemExit('CENSUS STOP: reference is not an error-free exact census')
    return {'files':int(info['files']),'directories':int(info['directories']),
            'bytes':int(info.get('bytes',0)),'path':str(ref)}

def crawl(workdir,root,cfg,max_files=None,max_dirs=None,workers=None,census=None):
    """Bounded concurrent read-only directory discovery with one SQLite writer.

    On Ctrl+C, committed directory states remain on the local drive. Restart
    the same command to resume an interrupted full inventory; tests rescan.
    """
    global _PATTERN_BATCH
    safety(workdir,root)
    validate_disjoint_roots(workdir,[root])
    known=_load_census(census,root) if census else None
    parallel=min(4,max(1,int(workers if workers is not None else cfg['crawl'].get('metadata_workers',2))))
    # Respect single-threaded limited tests; they have stronger deterministic file diversity requirements.
    if max_files is not None or max_dirs is not None:parallel=1
    initial=time.monotonic(); limited=max_files is not None or max_dirs is not None
    with connect(workdir/DB_NAME) as c:
        rr=register_root(c,root);rid=rr['root_id']
        previous=c.execute('SELECT * FROM crawls WHERE root_id=? ORDER BY started_at DESC LIMIT 1',(rid,)).fetchone()
        resume=(not limited and previous is not None and previous['status']=='interrupted'
                and c.execute("SELECT COUNT(*) FROM dir_queue WHERE root_id=? AND state IN ('pending','in_progress')",(rid,)).fetchone()[0]>0)
        if resume:
            cid=previous['crawl_id']
            files=c.execute('SELECT COUNT(*) FROM files WHERE root_id=? AND last_crawl=?',(rid,cid)).fetchone()[0]
            dirs=c.execute("SELECT COUNT(*) FROM dir_queue WHERE root_id=? AND state='completed'",(rid,)).fetchone()[0]
            problems=int(previous['issues'] or 0)
            c.execute("UPDATE crawls SET status='running' WHERE crawl_id=?",(cid,))
            c.execute("UPDATE dir_queue SET state='pending' WHERE root_id=? AND state='in_progress'",(rid,))
            print(f'RESUMING interrupted inventory: {files:,} files and {dirs:,} completed directories',flush=True)
        else:
            cid=str(uuid.uuid4());now=utcnow();files=dirs=problems=0
            c.execute("INSERT INTO crawls(crawl_id,root_id,started_at,status) VALUES(?,?,?,'running')",(cid,rid,now))
            c.execute("DELETE FROM patterns WHERE root_id=?",(rid,))
            c.execute("UPDATE dir_queue SET state='pending',crawl_id=?,updated_at=?,error=NULL WHERE root_id=?",(cid,now,rid))
            c.execute("""INSERT INTO dir_queue VALUES(?,?,'pending',?,?,NULL)
              ON CONFLICT(root_id,path) DO UPDATE SET state='pending',crawl_id=excluded.crawl_id,updated_at=excluded.updated_at,error=NULL""",
              (rid,os.path.abspath(root),cid,now))
        # In-memory heap replaces the O(directories^2) SELECT/sort in earlier builds.
        heap=[]; queued=set()
        for r in c.execute("SELECT path FROM dir_queue WHERE root_id=? AND state='pending'",(rid,)):
            name=r['path'];key=normpath(name)
            if key not in queued:
                heapq.heappush(heap,(directory_scan_priority(name,root),name))
                queued.add(key)
        c.commit()
        _PATTERN_BATCH={}
        objects=0;last_commit=time.monotonic();last_display=0;last_observed=files
        per_dir_quota=(min(12,max(3,max_files//12)) if max_files and max_files<=500 and 'projects' in root.casefold() else None)
        active={}; visited=set(); stopped=False
        def display(force=False,stage='INDEX INVENTORY'):
            nonlocal last_display
            now=time.monotonic()
            if not force and now-last_display<2:return
            elapsed=max(0.01,now-initial)
            file_rate=max(0,(files-last_observed)/elapsed)
            directory_rate=max(0,dirs/elapsed)
            if known:
                # Census is a point-in-time baseline, not a guarantee the share has not changed.
                file_pct=100*files/max(1,known['files'])
                dir_pct=100*dirs/max(1,known['directories'])
                pct=min(file_pct,dir_pct,100.0)
                remain_files=max(0,known['files']-files)
                remain_dirs=max(0,known['directories']-dirs)
                approx_eta=max(remain_files/max(.01,file_rate),remain_dirs/max(.01,directory_rate))
                eta=f' | census progress ~{pct:.1f}% | ETA ~{approx_eta/60:.0f}m' if elapsed>=8 else ' | ETA learning'
                target=f"/{known['files']:,}"
            else:eta=' | full percentage unknown (no census baseline)';target=''
            print(f'\r{stage}: files {files:,}{target} | dirs {dirs:,} | discovered queued {len(heap)+len(active):,} | '
                  f'{file_rate:.1f} files/s | {directory_rate:.1f} dirs/s | issues {problems}{eta}    ',end='',flush=True)
            last_display=now
        def checkpoint(force=False):
            nonlocal objects,last_commit
            if not force and objects<cfg['crawl']['checkpoint_objects'] and time.monotonic()-last_commit<cfg['crawl']['checkpoint_seconds']:
                return
            flush_patterns(c)
            c.execute('UPDATE crawls SET files_seen=?,dirs_seen=?,issues=? WHERE crawl_id=?',(files,dirs,problems,cid))
            c.commit()
            atomic_json(workdir/CP_NAME,{'crawl_id':cid,'root':root,'files':files,'dirs':dirs,
                                       'issues':problems,'workers':parallel,'updated_at':utcnow()})
            objects=0;last_commit=time.monotonic()
        print(f'INDEX INVENTORY: {parallel} bounded metadata workers, one local SQLite writer; Ctrl+C checkpoints.',flush=True)
        if known:print(f'CENSUS REFERENCE: {known["files"]:,} files / {known["directories"]:,} directories (counts can change).',flush=True)
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=parallel,thread_name_prefix='thor-read') as pool:
                while heap or active:
                    while heap and len(active)<parallel and (max_files is None or files<max_files) and (max_dirs is None or dirs+len(active)<max_dirs):
                        _,dp=heapq.heappop(heap);queued.discard(normpath(dp))
                        if normpath(dp) in visited:continue
                        visited.add(normpath(dp))
                        c.execute("UPDATE dir_queue SET state='in_progress',crawl_id=?,updated_at=? WHERE root_id=? AND path=?",
                                  (cid,utcnow(),rid,dp))
                        active[pool.submit(_inventory_directory,dp)]=dp
                    if not active:break
                    done,_=concurrent.futures.wait(active,timeout=1,return_when=concurrent.futures.FIRST_COMPLETED)
                    if not done:
                        display();checkpoint();continue
                    for fut in done:
                        dp=active.pop(fut)
                        try:subdirs,observed,errors,directory_error=fut.result()
                        except Exception as ex:subdirs,observed,errors,directory_error=[],[],[],ex
                        dirs+=1;objects+=1
                        for d in subdirs:
                            c.execute("INSERT OR IGNORE INTO dir_queue VALUES(?,?,'pending',?,?,NULL)",
                                      (rid,d,cid,utcnow()))
                            key=normpath(d)
                            if key not in queued and key not in visited:
                                heapq.heappush(heap,(directory_scan_priority(d,root),d));queued.add(key)
                        for path,code,msg in errors:
                            issue(c,cid,rid,path,code,msg);problems+=1
                        if directory_error is not None:
                            code='PERMISSION_DENIED' if isinstance(directory_error,PermissionError) else 'DIRECTORY_IO_ERROR'
                            c.execute("UPDATE dir_queue SET state='failed_retryable',updated_at=?,error=? WHERE root_id=? AND path=?",
                                      (utcnow(),str(directory_error),rid,dp))
                            issue(c,cid,rid,dp,code,directory_error);problems+=1
                        else:
                            deferred=False
                            if per_dir_quota is not None:
                                ranked=[]
                                for path,st in observed:
                                    photo=os.path.splitext(path)[1].casefold() in {'.jpg','.jpeg','.png','.heic','.bmp','.gif','.tif','.tiff','.webp'}
                                    prior=bool(c.execute('SELECT 1 FROM files WHERE norm_path=?',(normpath(path),)).fetchone())
                                    ranked.append(((prior,photo,os.path.basename(path).casefold()),path,st))
                                ranked.sort(key=lambda p:p[0]);observed=[(p,st) for _,p,st in ranked]
                                deferred=len(observed)>per_dir_quota
                                observed=observed[:per_dir_quota]
                            for path,st in observed:
                                if max_files is not None and files>=max_files:
                                    deferred=True;break
                                depth=max(0,len(Path(os.path.relpath(path,root)).parts)-1)
                                observe(c,rr,cid,path,st,depth);files+=1;objects+=1
                                if st.st_size==0:
                                    issue(c,cid,rid,path,'ZERO_BYTE_FILE','Retained for audit; excluded from useful search.')
                                    problems+=1
                            c.execute("UPDATE dir_queue SET state=?,updated_at=?,error=NULL WHERE root_id=? AND path=?",
                                      ('pending' if deferred else 'completed',utcnow(),rid,dp))
                        display();checkpoint()
                    if (max_files is not None and files>=max_files) or (max_dirs is not None and dirs>=max_dirs):
                        stopped=True;break
                # If a limit is reached, drain any prefetched readers safely without ingesting their data.
                for f in active: f.cancel()
            flush_patterns(c)
            unresolved=[x['path'] for x in c.execute("SELECT path FROM dir_queue WHERE root_id=? AND state IN ('permission_denied','failed_retryable','pending','in_progress')",(rid,))]
            if not limited:
                if not unresolved:
                    c.execute("UPDATE files SET observation_state='not_currently_observed',change_state='missing' WHERE root_id=? AND last_crawl<>?",(rid,cid))
                else:
                    # Preserve prior observations beneath inaccessible or unfinished directories.
                    old=c.execute("SELECT file_id,path FROM files WHERE root_id=? AND last_crawl<>?",(rid,cid))
                    missing=[(r['file_id'],) for r in old if not any(child_of(r['path'],bad) for bad in unresolved)]
                    c.executemany("UPDATE files SET observation_state='not_currently_observed',change_state='missing' WHERE file_id=?",missing)
            serious_errors=c.execute("""SELECT COUNT(*) FROM issues WHERE crawl_id=? AND
                reason_code IN ('PERMISSION_DENIED','FILE_IO_ERROR','DIRECTORY_IO_ERROR')""",(cid,)).fetchone()[0]
            coverage_status='sample_complete' if limited else ('inventory_partial' if unresolved or serious_errors else 'inventory_complete')
            c.execute('UPDATE crawls SET completed_at=?,status=?,files_seen=?,dirs_seen=?,issues=? WHERE crawl_id=?',
                      (utcnow(),coverage_status,files,dirs,problems,cid))
            c.execute('UPDATE roots SET last_crawl_at=? WHERE root_id=?',(utcnow(),rid))
            checkpoint(force=True);c.commit();display(force=True);print()
            if known:
                print(f'CENSUS DIFFERENCE: files {files-known["files"]:+,}; dirs {dirs-known["directories"]:+,} (share may have changed).',flush=True)
            print(f'Inventory complete: {files:,} files, {dirs:,} directories; {problems:,} issues; {coverage_status}.',flush=True)
            return cid,rid
        except KeyboardInterrupt:
            checkpoint(force=True)
            c.execute("UPDATE dir_queue SET state='pending' WHERE root_id=? AND state='in_progress'",(rid,))
            c.execute("UPDATE crawls SET status='interrupted',files_seen=?,dirs_seen=?,issues=? WHERE crawl_id=?",
                      (files,dirs,problems,cid));c.commit()
            print('\nINTERRUPTED — progress checkpointed locally; rerun crawl with the same workspace to resume.',flush=True)
            return None
        finally:
            _PATTERN_BATCH=None

def is_inspection_activity_label(label):
    """An inspection method is not the description/name of the equipment."""
    normalized=re.sub(r"[^a-z0-9]+"," ",label.casefold()).strip()
    return bool(re.fullmatch(
        r"(?:ext|external|int|internal) (?:visual|visual inspection|inspection)|"
        r"(?:ut|mt|pt|rt|pmi|thickness survey|api 510 inspection)", normalized
    ))

# ---------- local selective content extraction ----------
def xml_text_from_zip(path, members, maxchars):
    chunks=[]
    with zipfile.ZipFile(path) as z:
        for n in z.namelist():
            if any(n.startswith(prefix) for prefix in members) and n.endswith(".xml"):
                try:
                    raw=z.read(n).decode("utf-8","ignore")
                    txt=html.unescape(re.sub(r"<[^>]+>"," ",raw))
                    txt=re.sub(r"\s+"," ",txt).strip()
                    chunks.append(txt)
                    if sum(map(len,chunks))>=maxchars:break
                except Exception:pass
    return "\n".join(chunks)[:maxchars]

def pdf_text_fallback(path, maxbytes=4_000_000, maxchars=60000):
    """Best-effort bounded extraction from simple PDF text streams; never OCR.

    Deliberately refuses complex encodings rather than claiming complete PDF text.
    """
    with open(path,"rb") as fh:
        raw=fh.read(min(maxbytes,8_000_000))
    if not raw.startswith(b"%PDF-"):
        return ""
    pieces=[]; total=0
    for m in re.finditer(rb"stream\r?\n",raw):
        if total>=maxchars:break
        end=raw.find(b"endstream",m.end())
        if end<0 or end-m.end()>2_000_000:continue
        chunk=raw[m.end():end].rstrip(b"\r\n")
        # Common PDF compression; bound the expanded bytes to prevent zip bombs.
        if b"/FlateDecode" in raw[max(0,m.start()-700):m.start()]:
            try:
                d=zlib.decompressobj()
                chunk=d.decompress(chunk,min(maxchars*12,750_000))
            except (zlib.error,ValueError):continue
        if b"BT" not in chunk or b"ET" not in chunk:continue
        for block in re.findall(rb"\bBT\b(.*?)\bET\b",chunk,re.S):
            if total>=maxchars:break
            # Only text shown by Tj/TJ operators, never arbitrary PDF metadata.
            for token in re.findall(rb"(\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]+>)\s*Tj\b|\[(.*?)\]\s*TJ\b",block,re.S):
                data=token[0] if token[0] else token[1]
                words=[]
                for literal,hexd in re.findall(rb"\(((?:\\.|[^\\)])*)\)|<([0-9A-Fa-f\s]+)>",data,re.S):
                    try:
                        if hexd:
                            by=bytes.fromhex(hexd.decode('ascii'))
                        else:
                            by=re.sub(rb"\\([nrtbf()\\])", lambda v:{b'n':b'\n',b'r':b'\r',b't':b'\t',b'b':b' ',b'f':b' ',b'(':b'(',b')':b')',b'\\':b'\\'}[v.group(1)], literal)
                        if by.startswith((b'\xfe\xff',b'\xff\xfe')): t=by.decode('utf-16','ignore')
                        elif b'\x00' in by: t=by.decode('utf-16-be','ignore')
                        else: t=by.decode('cp1252','ignore')
                        if t.strip():words.append(t)
                    except (UnicodeError,ValueError,KeyError):continue
                if words:
                    piece=' '.join(words)
                    pieces.append(piece);total+=len(piece)
    text='\n'.join(pieces)[:maxchars]
    text=re.sub(r"[ \t]+"," ",text)
    return text if sum(ch.isalnum() for ch in text)>=12 else ""

# Bounded textual observations, not validated technical facts.
TECHNICAL_PATTERNS={
 "pressure":re.compile(r"(?<![A-Za-z0-9])(?:MAWP|MDMT|design\s+pressure|operating\s+pressure|test\s+pressure)\s*[:=\-]?\s*[-+]?\d{1,5}(?:\.\d+)?\s*(?:psig|psi|kpa|bar)\b",re.I),
 "temperature":re.compile(r"(?<![A-Za-z0-9])(?:design\s+temperature|operating\s+temperature|MDMT)\s*[:=\-]?\s*[-+]?\d{1,4}(?:\.\d+)?\s*(?:°?F|°?C|deg\s*[FC])\b",re.I),
 "material":re.compile(r"\b(?:SA[- ]?516\s*(?:Gr(?:ade)?\.?\s*)?70|A[- ]?106\s*(?:Gr(?:ade)?\.?\s*)?B|SA[- ]?240\s*(?:304|316)[L]?)\b",re.I),
 "code_reference":re.compile(r"\b(?:ASME\s+(?:B31\.3|Section\s+VIII(?:\s+Div(?:ision)?\s*1)?|B16\.5)|API\s+(?:510|570|579|650|653))\b",re.I),
}

def record_technical_mentions(c,file_id,text,method):
    # Each row is a literal observed text span. No engineering conclusion is inferred.
    c.execute("DELETE FROM technical_mentions WHERE file_id=?",(file_id,))
    if not text:return 0
    count=0; seen=set()
    for category,pattern in TECHNICAL_PATTERNS.items():
        for m in pattern.finditer(text):
            if count>=40:return count
            literal=m.group(0).strip(); key=(category,literal.casefold())
            if key in seen:continue
            seen.add(key)
            left=max(0,m.start()-100);right=min(len(text),m.end()+100)
            context=re.sub(r"\s+"," ",text[left:right]).strip()
            mid=stable_id("mention",file_id,category,literal.casefold())
            confidence=.70 if method in ("pdftotext","pymupdf","pypdf","office_openxml","plain_text") else .45
            c.execute("INSERT OR REPLACE INTO technical_mentions VALUES(?,?,?,?,?,?,?, ?,?)",
                 (mid,file_id,category,literal,context,method,confidence,"unverified",utcnow()))
            count+=1
    return count

# Extract a literal value from text already read locally. No OCR, AI, or document-merging.
# A value found here belongs to its SOURCE DOCUMENT, not automatically to an equipment entity.
ENGINEERING_VALUE_PATTERNS=(
 ("pressure", "mawp", re.compile(r"(?<![\w])MAWP\s*[:=\-]?\s*(?P<value>[-+]?\d{1,5}(?:\.\d+)?)\s*(?P<unit>psig|psia|psi|kpa|bar)\b", re.I)),
 ("pressure", "design_pressure", re.compile(r"(?<![\w])design\s+pressure\s*[:=\-]?\s*(?P<value>[-+]?\d{1,5}(?:\.\d+)?)\s*(?P<unit>psig|psia|psi|kpa|bar)\b", re.I)),
 ("pressure", "operating_pressure", re.compile(r"(?<![\w])operating\s+pressure\s*[:=\-]?\s*(?P<value>[-+]?\d{1,5}(?:\.\d+)?)\s*(?P<unit>psig|psia|psi|kpa|bar)\b", re.I)),
 ("pressure", "test_pressure", re.compile(r"(?<![\w])(?:hydro(?:static)?\s+)?test\s+pressure\s*[:=\-]?\s*(?P<value>[-+]?\d{1,5}(?:\.\d+)?)\s*(?P<unit>psig|psia|psi|kpa|bar)\b", re.I)),
 ("temperature", "mdmt", re.compile(r"(?<![\w])MDMT\s*[:=\-]?\s*(?P<value>[-+]?\d{1,4}(?:\.\d+)?)\s*°?\s*(?P<unit>F|C)\b", re.I)),
 ("temperature", "design_temperature", re.compile(r"(?<![\w])design\s+temperature\s*[:=\-]?\s*(?P<value>[-+]?\d{1,4}(?:\.\d+)?)\s*°?\s*(?P<unit>F|C)\b", re.I)),
 ("temperature", "operating_temperature", re.compile(r"(?<![\w])operating\s+temperature\s*[:=\-]?\s*(?P<value>[-+]?\d{1,4}(?:\.\d+)?)\s*°?\s*(?P<unit>F|C)\b", re.I)),
 ("material", "material_designation", re.compile(r"\b(?P<value>(?:SA[- ]?516\s*(?:Gr(?:ade)?\.?\s*)?70|A[- ]?106\s*(?:Gr(?:ade)?\.?\s*)?B|SA[- ]?240\s*(?:304|316)L?))\b", re.I)),
)

def record_engineering_observations(c,file_id,text,method):
    """Only observed literals, never authoritative design properties or relationship evidence."""
    c.execute("DELETE FROM engineering_observations WHERE file_id=?",(file_id,))
    if not text:return 0
    found=[]
    for category,prop,pattern in ENGINEERING_VALUE_PATTERNS:
        for m in pattern.finditer(text):
            value=m.group('value').strip()
            unit=(m.groupdict().get('unit') or '').strip() or None
            number=float(value) if category!='material' else None
            # Distinct occurrences remain distinct, even for the same literal value.
            found.append((m.start(),category,prop,value,number,unit,m.group(0)))
    count=0
    for offset,category,prop,value,number,unit,span in sorted(found)[:100]:
        context=re.sub(r"\s+"," ",text[max(0,offset-120):min(len(text),offset+len(span)+120)]).strip()
        oid=stable_id("engobs",file_id,prop,str(offset),span.casefold())
        c.execute("""INSERT OR REPLACE INTO engineering_observations
          (observation_id,file_id,category,property_name,raw_value,numeric_value,unit,
           observed_span,context_excerpt,source_method,source_offset,claim_scope,verification_state,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
          (oid,file_id,category,prop,value,number,unit,span,context,method,offset,
           "source_document","source_observed",utcnow()))
        count+=1
    return count

def extract_text(path,maxbytes=4_000_000,maxchars=60000):
    if os.path.basename(path).startswith("~$"):
        return "","office_lock_file_skipped"
    ext=Path(path).suffix.casefold()
    if ext in {".txt",".csv",".xml",".html",".htm",".log",".ini",".md"}:
        with open(path,"rb") as f:return f.read(maxbytes).decode("utf-8","ignore")[:maxchars],"plain_text"
    if ext in {".docx",".xlsx",".xlsm",".pptx"}:
        prefixes={".docx":["word/"],".xlsx":["xl/sharedStrings","xl/worksheets/"],".xlsm":["xl/sharedStrings","xl/worksheets/"],".pptx":["ppt/slides/"]}[ext]
        return xml_text_from_zip(path,prefixes,maxchars),"office_openxml"
    if ext==".pdf":
        # Optional proper PDF parsers, when present in the portable interpreter.
        # Imports are optional; running the indexer never requires installation.
        try:
            import fitz
            doc=fitz.open(path)
            try:
                parts=[];total=0
                for page in doc:
                    if total>=maxchars or len(parts)>=30:break
                    t=page.get_text("text")
                    if t:parts.append(t[:maxchars-total]);total+=len(parts[-1])
                if sum(ch.isalnum() for t in parts for ch in t)>=12:
                    return "\n".join(parts)[:maxchars],"pymupdf"
            finally:doc.close()
        except Exception:pass
        try:
            from pypdf import PdfReader
            with open(path,"rb") as fh:
                pdf=PdfReader(fh,strict=False)
                parts=[];total=0
                for page in pdf.pages[:30]:
                    if total>=maxchars:break
                    t=page.extract_text() or ""
                    parts.append(t[:maxchars-total]);total+=len(parts[-1])
                if sum(ch.isalnum() for t in parts for ch in t)>=12:
                    return "\n".join(parts)[:maxchars],"pypdf"
        except Exception:pass
        # Optional pdftotext if installed; no mutation of source.
        try:
            p=subprocess.run(["pdftotext","-layout",path,"-"],capture_output=True,timeout=30)
            if p.returncode==0 and p.stdout:
                return p.stdout.decode("utf-8","ignore")[:maxchars],"pdftotext"
        except Exception:pass
        try:
            text=pdf_text_fallback(path,maxbytes,maxchars)
            if text:return text,"pdf_builtin_partial_text"
        except (OSError,ValueError,zlib.error):pass
        return "","pdf_requires_parser_or_ocr"
    return "","unsupported"

def info_value(text):
    ids=identifiers(text); types=len(set(t for t,_,_ in ids)); unique=len(set(v for _,v,_ in ids))
    words=len(set(tokenize(text)))
    return clamp(.12*types+.025*min(unique,12)+.001*min(words,250))

def select_for_inspection(c,rid,cfg,new_root):
    # Guardrail remains effective for previously-created workspaces with older config values.
    lim=min(20 if new_root else 10,
            max(0,int(cfg["analysis"]["max_content_files_per_new_root" if new_root else "max_content_files_per_update"])))
    rows=c.execute("""SELECT * FROM files WHERE root_id=? AND observation_state='current' AND useful=1
      AND (change_state IN ('new','changed') OR parsed_at IS NULL)
      ORDER BY inspection_value DESC,size_bytes ASC LIMIT ?""",(rid,lim*4)).fetchall()
    # Diversity: cap repeated extension/parent clusters.
    chosen=[]; buckets=collections.Counter()
    for r in rows:
        key=(r["extension"],os.path.basename(r["parent_path"]).casefold())
        if buckets[key]>=5:continue
        if r["inspection_value"]<cfg["analysis"]["min_inspection_value"]:continue
        chosen.append(r);buckets[key]+=1
        if len(chosen)>=lim:break
    return chosen

# ---------- AI provider ----------
class AI:
    """
    Paid AI is a reusable-knowledge accelerator, never a per-file metered search loop.
    Budget is project-persistent in SQLite. As remaining budget shrinks, the reusable-value
    threshold rises continuously. Equivalent executed analyses are cached by analysis_key.
    """
    def __init__(self,cfg,db_path=None):
        self.cfg=cfg["ai"]; self.db_path=db_path

    @property
    def enabled(self):
        return bool(self.cfg.get("enabled") and self.cfg.get("model") and
                    os.environ.get(self.cfg.get("api_key_env","THOR_AI_API_KEY")))

    def _budget_state(self):
        if not self.db_path:
            cap=float(self.cfg.get("project_budget_usd",0) or 0)
            return cap,0.0,cap
        with connect(self.db_path) as c:
            r=c.execute("SELECT * FROM ai_budget WHERE budget_id='project'").fetchone()
            cap=float(r["authorized_usd"] or 0); spent=max(float(r["actual_spend_usd"] or 0),
                                                          float(r["estimated_spend_usd"] or 0))
            return cap,spent,max(0.0,cap-spent)

    def _estimate_cost(self,system,user,max_output_tokens=3000):
        # Conservative token approximation until provider tokenizer/usage is available.
        input_tokens=max(1,int((len(system)+len(user))/4))
        in_rate=float(self.cfg.get("estimated_input_usd_per_million_tokens",0) or 0)
        out_rate=float(self.cfg.get("estimated_output_usd_per_million_tokens",0) or 0)
        return input_tokens/1_000_000*in_rate + max_output_tokens/1_000_000*out_rate, input_tokens

    def _required_value(self):
        cap,spent,remaining=self._budget_state()
        if cap<=0:return 1.0
        pressure=min(1.0,max(0.0,spent/cap))
        base=float(self.cfg.get("base_min_reusable_value",.20) or .20)
        # Smoothly tightens; no cliff until the hard monetary ceiling itself.
        return min(.98,base + (1.0-base)*(pressure**2.2))

    def analyze(self,*args,**kwargs):
        """Legacy entry point intentionally disabled: it bypassed durable reservations."""
        raise RuntimeError('Paid AI is disabled through the legacy analyze() method. '
                           'Use ai-prepare and ai-run with provider-side spending protection.')

AI_SYSTEM="""You analyze a refinery engineering file repository. Return ONLY valid JSON.
Never invent facts. Distinguish observation from inference. Preserve ambiguity.
A recurring token may be machine-generated and semantically useless. Equipment tags such as V1 can be scoped and non-unique.
Identify likely folder/document roles, identifier semantics, aliases, bridge identifiers, document types, equipment/unit/project references,
uncertainties, contradictions, and suggested enrichment. Confidence is 0..1. Evidence must cite supplied sample paths/text labels.
Do not treat filesystem timestamps as engineering event dates."""

# ----- v4.1 fail-closed, checkpointed lifetime paid-AI budget -----
# The only paid-call path is ai-run; ordinary crawl/estimate/export never call the API.
# Anthropic standard pricing floors checked 2026-10-14; changes require updating
# this code/rates BEFORE paying. Requests have no tools, caching or fast mode.
GUARD_PROVIDER_FLOOR={
 'claude-opus-5':(5.0,25.0),
 'claude-opus-5-5':(4.0,20.0),
 'claude-sonnet-5':(2.0,10.0),
 'claude-sonnet-5-5':(2.0,10.0),
 'claude-fable-5-1':(10.0,50.0),
}
AI_OUTPUT_LIMIT=3000

def make_stage_zero_prompt(root_path,patterns,files):
    prompt=json.dumps({'root':root_path,'patterns':patterns,'representative_files':files},ensure_ascii=False)
    return prompt+"""\nReturn JSON with keys:
 directory_roles[], identifier_classes[], alias_hypotheses[], bridge_identifier_classes[],
 document_expectations[], era_conventions[], unresolved_questions[], recommended_sampling[].
 Each item must include confidence and evidence/sample references where applicable."""

def enqueue_ai(c,root_id,cfg,system,prompt,reason):
    ai=cfg.get('ai',{})
    provider=ai.get('provider','anthropic'); model=ai.get('model','')
    if not model: return None
    prompt=prompt[:int(ai.get('max_input_chars_per_call',50000))]
    analysis_key=stable_id('ai-cache',provider,model,system,prompt)
    job_id=stable_id('ai-job',analysis_key)
    # Stage-zero is a per-root learning pass, not a paid task per crawl.
    # Prevent duplicate billing if prepare is run after a crawl or multiple times.
    previous=c.execute('SELECT job_id FROM ai_jobs WHERE root_id=? AND provider=? AND model=? AND reason=? LIMIT 1',
                       (root_id,provider,model,reason)).fetchone()
    if previous:return previous['job_id']
    c.execute("""INSERT OR IGNORE INTO ai_jobs
     (job_id,analysis_key,root_id,provider,model,system_prompt,user_prompt,reason,state,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
     (job_id,analysis_key,root_id,provider,model,system,prompt,reason,'queued',utcnow(),utcnow()))
    return job_id

def ai_prepare_offline(workdir,cfg):
    """Queue stage-zero work from existing LOCAL database; no NAS or paid API calls."""
    db=workdir/DB_NAME
    if not db.is_file():raise SystemExit('AI PREPARE STOP: No local index exists')
    if not cfg.get('ai',{}).get('model'):
        raise SystemExit('AI PREPARE STOP: Set a provider/model through setup first')
    init_db(db)
    with connect(db) as c:
        roots=c.execute('SELECT root_id,path FROM roots ORDER BY path').fetchall()
        for root in roots:
            rid=root['root_id']
            patterns=[dict(x) for x in c.execute(
             'SELECT pattern_type,value,count,example FROM patterns WHERE root_id=? ORDER BY count DESC LIMIT 180',(rid,))]
            samples=c.execute("""SELECT path,filename_class,content_method,information_value,content_excerpt
             FROM files WHERE root_id=? AND parsed_at IS NOT NULL
             ORDER BY inspection_value DESC,size_bytes ASC LIMIT 20""",(rid,)).fetchall()
            reps=[{'path':r['path'],'class':r['filename_class'],'method':r['content_method'],
                   'information_value':r['information_value'],'text':(r['content_excerpt'] or '')[:3500]}
                  for r in samples]
            job_id=enqueue_ai(c,rid,cfg,AI_SYSTEM,make_stage_zero_prompt(root['path'],patterns,reps),
                              'stage_zero_repository_convention_learning')
            print('QUEUED:',job_id,'from',len(reps),'previously inspected files',flush=True)
    return ai_guard_status(workdir)

def _usd_to_cents(usd):
    v=float(usd)
    if not math.isfinite(v) or v<0: raise ValueError('Invalid USD amount')
    return math.ceil(v*100-1e-9)

def _guard_prices(ai):
    if ai.get('provider')!='anthropic' or ai.get('model') not in GUARD_PROVIDER_FLOOR:
        raise SystemExit('PAID AI STOP: this guarded runner supports verified Anthropic model IDs only')
    floor_in,floor_out=GUARD_PROVIDER_FLOOR[ai['model']]
    configured_in=float(ai.get('estimated_input_usd_per_million_tokens') or 0)
    configured_out=float(ai.get('estimated_output_usd_per_million_tokens') or 0)
    if not all(math.isfinite(p) for p in (configured_in,configured_out)):
        raise SystemExit('PAID AI STOP: invalid token prices')
    # Never trust rates LOWER than the provider-published standard prices.
    # If provider rates change, pause and update the floor before continuing.
    return max(floor_in,configured_in),max(floor_out,configured_out)

def _guard_totals(c):
    budget=c.execute("SELECT authorized_usd FROM ai_budget WHERE budget_id='project'").fetchone()
    legacy=c.execute("SELECT legacy_spend_cents FROM ai_guard_state WHERE guard_id='project'").fetchone()
    charged=c.execute("SELECT COALESCE(SUM(charged_cents),0) FROM ai_jobs").fetchone()[0]
    pending=c.execute("SELECT COALESCE(SUM(reserved_cents),0) FROM ai_jobs WHERE state IN ('in_flight','uncertain_charge')").fetchone()[0]
    cap=_usd_to_cents(budget[0]) if budget else 0
    return {'cap_cents':cap,'legacy_cents':int(legacy[0]) if legacy else 0,
            'charged_cents':int(charged),'reserved_cents':int(pending),
            'available_cents':cap-(int(legacy[0]) if legacy else 0)-int(charged)-int(pending)}

def ai_guard_status(workdir):
    init_db(workdir/DB_NAME)
    with connect(workdir/DB_NAME) as c:
        x=_guard_totals(c)
        statuses={r[0]:r[1] for r in c.execute('SELECT state,COUNT(*) FROM ai_jobs GROUP BY state')}
        x.update({'cap_usd':x['cap_cents']/100,'legacy_usd':x['legacy_cents']/100,
                  'completed_charges_usd':x['charged_cents']/100,
                  'uncertain_or_inflight_reserved_usd':x['reserved_cents']/100,
                  'remaining_usd':max(0,x['available_cents'])/100,
                  'jobs_by_state':statuses,
                  'source':'local SQLite ledger; NOT the provider billing statement'})
        return x

def _anthropic_error_summary(error, key=''):
    """Report provider failure reason, not the request, key, or prompt body."""
    status=getattr(error,'code','?')
    detail=''
    try:
        raw=error.read(4096)
        data=json.loads(raw.decode('utf-8','replace'))
        provider_error=data.get('error',{}) if isinstance(data,dict) else {}
        if isinstance(provider_error,dict):
            typ=provider_error.get('type','')
            detail=str(provider_error.get('message',''))
            if typ: detail=f'{typ}: {detail}'
    except (ValueError,TypeError,AttributeError,UnicodeError):
        pass
    if key: detail=detail.replace(key,'[REDACTED]')
    detail=re.sub(r'sk-ant-[a-zA-Z0-9_-]+','[REDACTED]',detail)
    detail=' '.join(detail.split())[:320]
    return f'Anthropic HTTP {status}'+(f' — {detail}' if detail else ' — no readable provider reason')

def _anthropic_request_headers(ai, key):
    """Consistent workspace routing for both free counting and paid Messages calls."""
    headers={'x-api-key':key,'anthropic-version':'2023-06-01',
             'content-type':'application/json'}
    workspace_id=(ai.get('workspace_id') or '').strip()
    if workspace_id:
        if not re.fullmatch(r'wrkspc_[A-Za-z0-9_-]{8,128}',workspace_id):
            raise ValueError('Saved Anthropic workspace ID has invalid format; paid AI stopped')
        headers['anthropic-workspace-id']=workspace_id
    return headers

def _missing_workspace_error(reason):
    """Only recognize the provider's specific missing-workspace response."""
    msg=str(reason).lower()
    return ('anthropic http 400' in msg and
            ('anthropic-workspace-id' in msg or 'not scoped to a workspace' in msg) and
            ('required' in msg or 'must include' in msg or 'not scoped' in msg))

def _prompt_and_save_workspace(workdir, cfg):
    """Collect only the non-secret workspace ID, once, when Anthropic requests it."""
    if not sys.stdin.isatty():
        raise RuntimeError('Workspace ID required. Open Claude Console > Settings > Workspaces, '
                           'then rerun ai-run in interactive PowerShell. No paid call sent.')
    print('\nANTHROPIC WORKSPACE REQUIRED (your key is saved; no setup or rescan).',flush=True)
    print('Claude Console > Settings > Workspaces > copy your workspace ID (starts wrkspc_).',flush=True)
    try:
        value=input('Workspace ID (wrkspc_...): ').strip()
    except (KeyboardInterrupt, EOFError):
        raise RuntimeError('Workspace ID entry cancelled; no paid AI call sent') from None
    if not re.fullmatch(r'wrkspc_[A-Za-z0-9_-]{8,128}',value):
        raise RuntimeError('Workspace ID must start with wrkspc_ and contain the exact Console ID; '
                           'no paid AI call sent')
    cfg['ai']['workspace_id']=value
    atomic_json(workdir/CFG_NAME,cfg)
    print('WORKSPACE SAVED: subsequent AI calls automatically use this workspace; '
          'existing queued work and $20 cap unchanged.',flush=True)
    return value

def _count_anthropic_tokens(ai,system,user,key):
    """Free provider token count, fail-closed on rejection. No paid request fallback."""
    body={'model':ai['model'],'system':system,'messages':[{'role':'user','content':user}]}
    req=urllib.request.Request('https://api.anthropic.com/v1/messages/count_tokens',
        data=json.dumps(body).encode('utf-8'),
        headers=_anthropic_request_headers(ai,key),method='POST')
    try:
        with urllib.request.urlopen(req,timeout=45) as response:
            data=json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(_anthropic_error_summary(error,key)) from None
    count=data.get('input_tokens')
    if type(count) is not int or count<1:
        raise ValueError('Provider token count missing/invalid; no paid call authorized')
    return count

def _guard_reservation_cents(ai,system,user,token_count):
    rate_in,rate_out=_guard_prices(ai)
    # Text-only BPE prompts: input tokens ordinarily <= encoded bytes. Add a
    # large fixed protocol margin AND a >2x token-count margin, whichever larger.
    # This is an intentionally pessimistic REQUEST reservation, not a billing promise.
    input_ceiling=max(len((system+user).encode('utf-8','surrogatepass'))+8192,
                      math.ceil(token_count*2.0)+8192)
    return _usd_to_cents((input_ceiling*rate_in+AI_OUTPUT_LIMIT*rate_out)/1e6)

def _apply_ai_findings(c,job,result):
    # Scoped as root-level unverified inference; source documents remain unchanged.
    root_id=job['root_id']
    analysis_id=job['analysis_key']
    c.execute("""INSERT OR REPLACE INTO ai_analyses
      (analysis_id,scope_type,scope_id,provider,model,prompt_version,result_json,confidence,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)""",
      (analysis_id,'root',root_id,job['provider'],job['model'],'stage0_v4_1',
       json.dumps(result),None,utcnow()))
    for typ,items in result.items():
        if not isinstance(items,list):continue
        for j,item in enumerate(items):
            confidence=float(item.get('confidence',.5)) if isinstance(item,dict) else .5
            fid=stable_id('finding',root_id,typ,j,json.dumps(item,sort_keys=True))
            c.execute('INSERT OR REPLACE INTO explorer_findings VALUES(?,?,?,?,?,?,?,?)',
                      (fid,root_id,typ,str(j),json.dumps(item),clamp(confidence),1,utcnow()))

def _align_explicit_opus5_choice(workdir,cfg):
    """One-time migration of the previously selected Opus 5.5 to requested Opus 5.

    Preserve existing index and project lifetime cap. Only unattempted jobs can
    be retargeted; if any job was already submitted, do not silently migrate.
    """
    ai=cfg.get('ai',{})
    if ai.get('provider')!='anthropic' or ai.get('model')!='claude-opus-5-5':
        return cfg
    with connect(workdir/DB_NAME) as c:
        blocked=c.execute("""SELECT COUNT(*) FROM ai_jobs WHERE provider='anthropic'
            AND model='claude-opus-5-5' AND (attempts>0 OR state NOT IN ('queued','paused_budget'))""").fetchone()[0]
    if blocked:
        print('MODEL CORRECTION PAUSED: an earlier job was attempted under Opus 5.5. No silent conversion; no paid call.',flush=True)
        return cfg
    revised=json.loads(json.dumps(cfg))
    revised['ai']['model']='claude-opus-5'
    revised['ai']['estimated_input_usd_per_million_tokens']=5.0
    revised['ai']['estimated_output_usd_per_million_tokens']=25.0
    # All DB state is local; do not modify budget, existing charges or crawl.
    changed=_retarget_unstarted_ai_jobs(workdir,revised['ai'])
    with connect(workdir/DB_NAME) as c:
        mismatches=c.execute("""SELECT COUNT(*) FROM ai_jobs WHERE provider='anthropic'
          AND model='claude-opus-5-5' AND state IN ('queued','paused_budget') AND attempts=0""").fetchone()[0]
    if mismatches:
        raise SystemExit('PAID AI STOP: queued model conversion incomplete; existing jobs preserved')
    atomic_json(workdir/CFG_NAME,revised)
    print('MODEL CORRECTED: claude-opus-5-5 -> claude-opus-5 as requested;',
          f'{changed} unattempted job(s) retargeted, $20 project cap unchanged.',flush=True)
    return revised

def ai_run_guarded(workdir,cfg,allow_paid=False,provider_confirmed=False):
    if not allow_paid or not provider_confirmed:
        raise SystemExit('PAID AI STOP: require --allow-paid-ai AND --provider-cap-confirmed; '
         'confirm an Anthropic workspace/organization spend limit no higher than your project budget and disable auto-reload first')
    ai=cfg['ai']
    if not ai.get('enabled'):
        raise SystemExit('PAID AI STOP: AI disabled in setup; use setup to enable it')
    if ai.get('provider')!='anthropic':
        raise SystemExit('PAID AI STOP: only Anthropic Messages API is implemented in guarded runner')
    try:
        api_key, key_source = _get_ai_key(workdir, ai)
    except Exception as error:
        raise SystemExit(f'PAID AI STOP: unable to unlock saved credential ({error})') from None
    if not api_key:
        # A missing optional setup entry must not send the user through the entire
        # configuration wizard again. Collect it once at the point of authorized
        # use, encrypt it under the current Windows login, verify the round trip,
        # then continue the *same* explicitly authorized run.
        if os.name != 'nt' or not sys.stdin.isatty():
            raise SystemExit('PAID AI STOP: no saved API key; interactive Windows PowerShell is required to enter one securely. No paid request sent.')
        print('\nAPI KEY NOT YET SAVED. Enter it once; no reconfiguration needed.',flush=True)
        print('It will be stored encrypted for your Windows account; the key will not be displayed.',flush=True)
        try:
            entered = getpass.getpass('Anthropic API key (hidden): ').strip()
        except (EOFError,KeyboardInterrupt):
            raise SystemExit('PAID AI STOP: key entry cancelled. No paid request sent.') from None
        if not entered:
            raise SystemExit('PAID AI STOP: no API key entered. No paid request sent.')
        try:
            _store_encrypted_key(workdir, entered)
            api_key, key_source = _get_ai_key(workdir, ai)
            if api_key != entered:
                raise RuntimeError('encrypted credential verification mismatch')
        except Exception as error:
            raise SystemExit(f'PAID AI STOP: could not securely save and verify API key ({type(error).__name__}). No paid request sent.') from None
        finally:
            entered = None
        print('API KEY SAVED: encrypted credential verified; setup not required.',flush=True)
    print('API KEY: available from', key_source, '(secret never displayed)',flush=True)
    rates=_guard_prices(ai)
    with connect(workdir / DB_NAME) as c:
        if _guard_totals(c)['cap_cents'] <= 0:
            raise SystemExit('PAID AI STOP: project spending cap must be positive; run setup first')
    print('GUARDED AI: local lifetime cap with prior reservations;',
          'provider spend guard must be configured separately.',flush=True)
    print('MODEL',ai['model'],'billing reservation price/MTok input',rates[0],'output',rates[1],flush=True)
    ran=0
    while True:
        with connect(workdir/DB_NAME) as c:
            busy=c.execute("SELECT COUNT(*) FROM ai_jobs WHERE state IN ('in_flight','uncertain_charge')").fetchone()[0]
            if busy:
                print('PAUSED: existing in-flight or uncertain-billing request. Do not retry until reconciled.',flush=True)
                break
            row=c.execute("""SELECT * FROM ai_jobs WHERE state IN ('queued','paused_budget')
                       ORDER BY created_at,job_id LIMIT 1""").fetchone()
            if row is None:
                print('AI QUEUE EMPTY: no paid work remaining.',flush=True)
                break
            job=dict(row)
        if job['provider']!=ai.get('provider') or job['model']!=ai.get('model'):
            print('PAUSED: saved job model differs from current setup. No paid request sent.',flush=True)
            break
        try:
            try:
                counted=_count_anthropic_tokens(ai,job['system_prompt'],job['user_prompt'],api_key)
            except RuntimeError as first_error:
                if _missing_workspace_error(first_error) and not ai.get('workspace_id'):
                    # Counting tokens is a non-billable endpoint. Prompt only after the
                    # exact provider missing-workspace rejection; do not guess a workspace.
                    _prompt_and_save_workspace(workdir,cfg)
                    # One retry of the FREE count endpoint; no paid request until success.
                    counted=_count_anthropic_tokens(ai,job['system_prompt'],job['user_prompt'],api_key)
                else:
                    raise
            reserve=_guard_reservation_cents(ai,job['system_prompt'],job['user_prompt'],counted)
        except Exception as error:
            print('PAUSED: unable to safely count prompt tokens:',type(error).__name__,str(error),flush=True)
            break
        with connect(workdir/DB_NAME) as c:
            c.execute('BEGIN IMMEDIATE')
            again=c.execute('SELECT state FROM ai_jobs WHERE job_id=?',(job['job_id'],)).fetchone()
            totals=_guard_totals(c)
            locked=c.execute("SELECT COUNT(*) FROM ai_jobs WHERE state IN ('in_flight','uncertain_charge')").fetchone()[0]
            if not again or again[0] not in ('queued','paused_budget') or locked:
                print('PAUSED: concurrent AI change detected; no request sent.',flush=True)
                break
            if reserve>totals['available_cents']:
                c.execute("UPDATE ai_jobs SET state='paused_budget',updated_at=? WHERE job_id=?",
                          (utcnow(),job['job_id']))
                print('BUDGET PAUSE: requires',f'${reserve/100:.2f}',
                      'but only',f'${max(0,totals["available_cents"])/100:.2f}',
                      'remains. Job saved for after you increase the cap.',flush=True)
                break
            c.execute("""UPDATE ai_jobs SET state='in_flight',reserved_cents=?,attempts=attempts+1,
                         input_tokens=?,updated_at=? WHERE job_id=?""",
                      (reserve,counted,utcnow(),job['job_id']))
        # From this point a transport failure is treated as possibly billable.
        # NO auto-retry; the full reservation survives crashes and timeouts.
        body={'model':job['model'],'max_tokens':AI_OUTPUT_LIMIT,
              'system':job['system_prompt'],'messages':[{'role':'user','content':job['user_prompt']}]}
        req=urllib.request.Request('https://api.anthropic.com/v1/messages',
             data=json.dumps(body).encode('utf-8'),
             headers=_anthropic_request_headers(ai,api_key),method='POST')
        try:
            with urllib.request.urlopen(req,timeout=90) as response: raw=json.load(response)
            usage=raw.get('usage',{})
            used_in=usage.get('input_tokens');used_out=usage.get('output_tokens')
            cache_creation=usage.get('cache_creation_input_tokens',0)
            cache_read=usage.get('cache_read_input_tokens',0)
            if not all(type(v) is int and v>=0 for v in (used_in,used_out,cache_creation,cache_read)):
                raise ValueError('Successful response has no usable billing-token counts')
            rate_in,rate_out=rates
            # Without explicit caching this normally reduces to ordinary input/output.
            # Count cache tokens pessimistically at ordinary input rates too, rather than
            # understating charges when a cached prompt unexpectedly occurs.
            billed_input=used_in+cache_creation+cache_read
            actual=_usd_to_cents((billed_input*rate_in+used_out*rate_out)/1e6)
            output=''.join(part.get('text','') for part in raw.get('content',[]) if part.get('type')=='text')
            match=re.search(r'\{.*\}',output,re.S)
            try:result=json.loads(match.group(0)) if match else None
            except (ValueError,TypeError):result=None
            if not isinstance(result,dict):result=None
            with connect(workdir/DB_NAME) as c:
                c.execute('BEGIN IMMEDIATE')
                c.execute("""UPDATE ai_jobs SET state=?,reserved_cents=0,charged_cents=?,
                      input_tokens=?,output_tokens=?,result_json=?,last_error=?,updated_at=? WHERE job_id=?""",
                      ('complete' if result else 'complete_invalid',actual,used_in,used_out,
                       json.dumps(result) if result else None,
                       None if result else 'Billed successful request but response was not a usable JSON object; no automatic retry',
                       utcnow(),job['job_id']))
                if result:_apply_ai_findings(c,job,result)
            ran+=1
            print('AI JOB FINISHED:',job['job_id'],f'charged ledger ${actual/100:.2f}',
                  'usable' if result else 'unusable output; not retried',flush=True)
            if actual>reserve:
                print('SAFETY PAUSE: actual token charge exceeded reservation; no further paid requests.',flush=True)
                break
        except Exception as error:
            detail=(_anthropic_error_summary(error,api_key) if isinstance(error,urllib.error.HTTPError)
                    else f'{type(error).__name__}: {str(error)[:250]}')
            with connect(workdir/DB_NAME) as c:
                c.execute("""UPDATE ai_jobs SET state='uncertain_charge',last_error=?,updated_at=?
                             WHERE job_id=? AND state='in_flight'""",
                          (detail[:400],utcnow(),job['job_id']))
            print('UNCERTAIN BILLING: stopped ALL paid AI. Reservation held, no automatic retry.',
                  detail,flush=True)
            break
    print('AI BUDGET STATUS:',json.dumps(ai_guard_status(workdir),indent=2),flush=True)
    if ran:
        print('EXPORTING updated local JSON (no THOR rescan)...',flush=True)
        export_index(workdir,workdir/EXPORT_NAME)
        atomic_json(workdir/'ai_execution_plan.json',ai_execution_plan(workdir))
    return ran

def ai_reconcile(workdir,job_id,billed_usd,console_confirmed,orphan_confirmed=False):
    if not console_confirmed:
        raise SystemExit('RECONCILE STOP: check Anthropic billing first and provide --confirmed-on-console')
    billed=_usd_to_cents(billed_usd)
    with connect(workdir/DB_NAME) as c:
        c.execute('BEGIN IMMEDIATE')
        row=c.execute('SELECT * FROM ai_jobs WHERE job_id=?',(job_id,)).fetchone()
        if not row or row['state'] not in ('uncertain_charge','in_flight'):
            raise SystemExit('RECONCILE STOP: job not in an uncertain state')
        if row['state']=='in_flight' and not orphan_confirmed:
            raise SystemExit('RECONCILE STOP: job may still be executing; confirm runner is STOPPED '
                             'and pass --orphaned-inflight-confirmed')
        # Uncertain billed calls cannot be silently re-submitted if they cost money.
        state='queued' if billed==0 else 'charged_no_result'
        c.execute("""UPDATE ai_jobs SET state=?,charged_cents=?,reserved_cents=0,
                  last_error=?,updated_at=? WHERE job_id=?""",
                  (state,billed,'Billing reconciled manually from Anthropic console',utcnow(),job_id))
    return ai_guard_status(workdir)

def stage_zero_and_content(workdir,rid,cid,cfg):
    ai=AI(cfg,workdir/DB_NAME)
    with connect(workdir/DB_NAME) as c:
        rr=c.execute("SELECT * FROM roots WHERE root_id=?",(rid,)).fetchone()
        new_root=not bool(rr["explorer_completed_at"])
        samples=select_for_inspection(c,rid,cfg,new_root)
        print(f"Stage Zero: selected {len(samples)} high-information files for bounded inspection.")
        analyzed=[]
        for i,r in enumerate(samples,1):
            try:
                # Files can disappear after the inventory; log a recoverable observation,
                # never re-create, change or touch the source file.
                if r['filename'].startswith('~$'):
                    c.execute("UPDATE files SET parsed_at=?,content_method=? WHERE file_id=?",
                              (utcnow(),'office_lock_file_skipped',r['file_id']))
                    continue
                if not os.path.isfile(r['path']):
                    issue(c,cid,rid,r['path'],'CONTENT_SOURCE_UNAVAILABLE',
                          'Source was missing or inaccessible at content-analysis time; retry on later crawl.')
                    continue
                txt,method=extract_text(r["path"],cfg["analysis"]["max_file_read_bytes"])
                iv=info_value(txt) if txt else 0
                c.execute("UPDATE files SET parsed_at=?,content_excerpt=?,content_method=?,information_value=? WHERE file_id=?",
                          (utcnow(),txt[:12000] if txt else None,method,iv,r["file_id"]))
                record_technical_mentions(c,r["file_id"],txt,method)
                record_engineering_observations(c,r["file_id"],txt,method)
                # content-derived identifiers
                for typ,val,raw in identifiers(txt):
                    iid=stable_id("ident",r["file_id"],typ,val,"content")
                    c.execute("INSERT OR REPLACE INTO identifiers VALUES(?,?,?,?,?,?,?,?,?,?)",
                              (iid,r["file_id"],rid,typ,val,raw,"embedded_text",.96,.9,utcnow()))
                if not txt and r["extension"]==".pdf":
                    reasons=["POSSIBLE_SCANNED_DOCUMENT"]
                    if r["filename_class"]=="MACHINE_GENERATED":reasons.append("MACHINE_GENERATED_FILENAME")
                    c.execute("INSERT OR REPLACE INTO enrichment VALUES(?,?,?,?,?,?,?)",
                              (r["file_id"],1,max(.65,r["inspection_value"]),json.dumps(reasons),
                               json.dumps(["extract_embedded_text","ocr_document","vision_analyze_pages","extract_identifiers","recalculate_relationships"]),
                               max(.65,r["inspection_value"]),utcnow()))
                analyzed.append({"file_id":r["file_id"],"path":r["path"],"class":r["filename_class"],
                                 "method":method,"information_value":iv,"text":txt[:3500]})
            except (FileNotFoundError,PermissionError) as ex:
                issue(c,cid,rid,r['path'],'CONTENT_SOURCE_UNAVAILABLE',ex)
            except OSError as ex:
                issue(c,cid,rid,r['path'],'CONTENT_SOURCE_IO_ERROR',ex)
            except Exception as ex:
                issue(c,cid,rid,r["path"],"CONTENT_PARSE_FAILED",ex)
        c.commit()

        # Always queue the optional paid task locally. NEVER send paid requests from crawl.
        # Queue persists even when the user is away or paid AI is disabled.
        if cfg["analysis"].get("enable_ai",True) and cfg.get("ai",{}).get("model"):
            pats=[dict(x) for x in c.execute("""SELECT pattern_type,value,count,example FROM patterns WHERE root_id=?
                 ORDER BY count DESC LIMIT 180""",(rid,))]
            prompt=make_stage_zero_prompt(rr["path"],pats,analyzed[:30])
            job_id=enqueue_ai(c,rid,cfg,AI_SYSTEM,prompt,"stage_zero_repository_convention_learning")
            print('AI TASK QUEUED LOCALLY:',job_id,'(no paid call; resume with ai-run)',flush=True)
        c.execute("UPDATE roots SET explorer_completed_at=COALESCE(explorer_completed_at,?) WHERE root_id=?",(utcnow(),rid))
        c.commit()

# ---------- deterministic knowledge building ----------
def ensure_entity(c,etype,name,scope,confidence=.75,attrs=None,authority="algorithmic",pclass=2):
    eid=stable_id("entity",etype,name.casefold(),(scope or "").casefold())
    now=utcnow()
    c.execute("""INSERT INTO entities VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(entity_id) DO UPDATE SET confidence=MAX(confidence,excluded.confidence),last_validated=excluded.last_validated""",
      (eid,etype,name,scope,"active",confidence,authority,pclass,now,now,json.dumps(attrs or {})))
    return eid
def ensure_alias(c,value,atype,specificity):
    norm=re.sub(r"[\s_-]+","",value.casefold())
    aid=stable_id("alias",atype,norm)
    c.execute("INSERT OR IGNORE INTO aliases VALUES(?,?,?,?,?,0,'active',?)",
              (aid,value,norm,atype,specificity,utcnow()))
    return aid
def evidence(c,stype,sid,etype,polarity,weight,fileid,rootid,lineage,desc,mode="observed",authority="algorithmic",details=None):
    eid=stable_id("ev",stype,sid,etype,fileid,lineage,desc)
    c.execute("INSERT OR IGNORE INTO evidence VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
              (eid,stype,sid,etype,polarity,weight,fileid,rootid,lineage,desc,mode,authority,utcnow(),json.dumps(details or {})))
    return eid
def relationship(c,a,b,typ,pos,neg=0,authority="algorithmic",pclass=2):
    rid=stable_id("rel",a,b,typ); conf=clamp(sigmoid((pos-neg-35)/18))
    c.execute("""INSERT INTO relationships VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(rel_id) DO UPDATE SET confidence=excluded.confidence,positive_score=excluded.positive_score,
      negative_score=excluded.negative_score,last_validated=excluded.last_validated""",
      (rid,a,b,typ,conf,"active",authority,pclass,pos,neg,utcnow(),utcnow()))
    return rid

def build_knowledge(workdir,rid):
    with connect(workdir/DB_NAME) as c:
        # Stream identifiers: 200k+ documents must NOT be materialized as a
        # rows.fetchall()/by_file dictionary. SQLite holds the ordered cursor,
        # and only one file's identifiers are grouped at a time in Python.
        ident_sql="""SELECT i.*,f.parent_path,f.path FROM identifiers i JOIN files f ON f.file_id=i.file_id
                     WHERE i.root_id=? AND i.type IN ('equipment_number','afe','drawing_ke','pid_family','u1a')
                     ORDER BY i.file_id"""
        project_root=c.execute('SELECT path FROM roots WHERE root_id=?',(rid,)).fetchone()['path']
        scoped_project=root_project_identity(project_root)
        kinds={'equipment_number':'equipment','afe':'project','drawing_ke':'document_family',
               'pid_family':'document_family','u1a':'document_concept'}
        def valid(r):
            return not (r['type']=='afe' and scoped_project and r['value']!=scoped_project)
        print('  Knowledge stage: indexing identifier entities...',flush=True)
        for n,r in enumerate(c.execute(ident_sql,(rid,)),1):
            if not valid(r):continue
            typ,val=r['type'],r['value'];scoped=project_root if typ=='afe' and val==scoped_project else None
            ent=ensure_entity(c,kinds[typ],val,scoped,.96 if scoped else .82,{'discovered_from':typ})
            aid=ensure_alias(c,val,typ,.95 if typ!='u1a' else .8)
            c.execute("""INSERT INTO alias_candidates VALUES(?,?,?,?,?,?)
                ON CONFLICT(alias_id,entity_id) DO UPDATE SET evidence_count=MAX(evidence_count,excluded.evidence_count),
                confidence=MAX(confidence,excluded.confidence)""",(aid,ent,.9,1,1,None))
            evidence(c,'entity',ent,'IDENTIFIER_OCCURRENCE',1,35,r['file_id'],rid,r['parent_path'],
                     f'{val} observed in path/content')
            if n%20000==0:print(f'  Knowledge stage: {n:,} identifier records...',flush=True)
        # Pair co-occurrence is a candidate retrieval clue only, never verified
        # engineering linkage. Retain at most one example file per lineage.
        print('  Knowledge stage: identifying candidate bridges...',flush=True)
        pair_support=collections.defaultdict(dict) # pair -> lineage -> first file id
        current_fid=None; current_items=[]
        def flush_file_pairs(items):
            if len(items)<2:return
            ents=[]
            for r in items:
                scope=project_root if r['type']=='afe' and r['value']==scoped_project else None
                ent=stable_id('entity',kinds[r['type']],r['value'].casefold(),(scope or '').casefold())
                ents.append((ent,r))
            for i in range(len(ents)):
                for j in range(i+1,len(ents)):
                    a,ra=ents[i];b,_=ents[j]
                    if a==b:continue
                    key=tuple(sorted((a,b)))
                    lineage=ra['parent_path']
                    pair_support[key].setdefault(lineage,ra['file_id'])
        for n,r in enumerate(c.execute(ident_sql,(rid,)),1):
            if not valid(r):continue
            fid=r['file_id']
            if current_fid is not None and fid!=current_fid:
                flush_file_pairs(current_items);current_items=[]
            current_fid=fid;current_items.append(r)
            if n%30000==0:print(f'  Knowledge stage: examined {n:,} identifier co-occurrences...',flush=True)
        flush_file_pairs(current_items)
        for (a,b),lineages in pair_support.items():
            independent=len(lineages);pos=min(80,35+25*max(0,independent-1))
            rel=relationship(c,a,b,'CO_OCCURS_OR_BRIDGES',pos)
            for lin,fid in list(lineages.items())[:20]:
                evidence(c,'relationship',rel,'CO_OCCURRENCE',1,35,fid,rid,lin,
                         'Identifiers co-occur in a file/path; independent directory lineage tracked.')
        # Learn directory roles from observed folder names and their local context.
        # Profiles are scoped to paths, not assumed to be global plant conventions.
        rr=c.execute("SELECT path FROM roots WHERE root_id=?",(rid,)).fetchone()
        rootpath=rr["path"]
        project=root_project_identity(rootpath)
        if project:
            project_ent=ensure_entity(c,'project',project,rootpath,.96,
                                      {'discovered_from':'scanned_root_folder','source_path':rootpath})
            alias=ensure_alias(c,project,'afe',.96)
            c.execute("""INSERT INTO alias_candidates VALUES(?,?,?,?,?,?)
                  ON CONFLICT(alias_id,entity_id) DO UPDATE SET confidence=MAX(confidence,excluded.confidence)""",
                      (alias,project_ent,.96,1,1,rootpath))
            # Folder context is provenance, not proof of technical project content.
            for pf in c.execute("SELECT file_id,path,parent_path FROM files WHERE root_id=? AND observation_state='current'",(rid,)).fetchall():
                lid=stable_id('doclink',pf['file_id'],project_ent,'PROJECT_FOLDER_CONTEXT')
                c.execute("""INSERT INTO document_links VALUES(?,?,?,?,?,?,?,?)
                   ON CONFLICT(link_id) DO NOTHING""",
                   (lid,pf['file_id'],project_ent,'PROJECT_FOLDER_CONTEXT',.85,
                    'indexed_project_root_folder',rootpath,utcnow()))
                evidence(c,'document_link',lid,'PROJECT_FOLDER_CONTEXT',1,20,pf['file_id'],rid,
                         rootpath,'File located under indexed project folder '+project,mode='inferred')
        dirs=c.execute("""SELECT parent_path,COUNT(*) AS n FROM files
                         WHERE root_id=? AND observation_state='current'
                         GROUP BY parent_path""",(rid,)).fetchall()
        role_words={"drawings":"drawings","drawing":"drawings","calculations":"calculations",
                    "code documents":"code_documents","datasheets":"datasheets","data sheets":"datasheets",
                    "inspection":"inspection","archive":"archive","p&id":"p_and_id",
                    "vessels":"equipment_category","buildings":"equipment_category"}
        for d in dirs:
            path=d["parent_path"]
            parts=Path(os.path.relpath(path,rootpath)).parts
            for level in range(len(parts)+1):
                folder=rootpath if level==0 else os.path.join(rootpath,*parts[:level])
                label=os.path.basename(folder).casefold()
                role=next((v for k,v in role_words.items() if k in label),None)
                equipment_match=re.search(r"(?<!\d)(\d{4}\.\d{1,3})(?!\d)",label)
                if equipment_match: role="equipment_folder"
                if level==0: role="sampled_root"
                if not role: role="directory"
                profile=stable_id("profile",normpath(folder))
                attrs={"folder_name":os.path.basename(folder),"relative_path":os.path.relpath(folder,rootpath),
                       "parent_path":os.path.dirname(folder),"role_basis":"folder_name_heuristic",
                       "sample_root_only":level==0}
                c.execute("""INSERT OR REPLACE INTO directory_profiles VALUES(?,?,?,?,?,?,?,?)""",
                          (profile,rid,folder,role,.85 if equipment_match else (.7 if role!="directory" else .4),
                           .5,json.dumps(attrs),utcnow()))
                if equipment_match:
                    num=equipment_match.group(1)
                    ent=ensure_entity(c,"equipment",num,None,.82,{"discovered_from":"equipment_folder"})
                    # Discover a local equipment tag and description as aliases, not separate equipment.
                    tail=os.path.basename(folder)[equipment_match.end():].strip(" -_()")
                    tail=re.sub(r"^\(?[A-Za-z]{1,4}\)\s*", "", tail).strip()
                    tag=re.search(r"\b([A-Z]{1,4}[- ]?\d{1,4}[A-Z]?)\b",tail,re.I)
                    if tag:
                        value=re.sub(r"\s+","-",tag.group(1).upper())
                        aid=ensure_alias(c,value,"equipment_tag",.65)
                        c.execute("""INSERT INTO alias_candidates VALUES(?,?,?,?,?,?)
                          ON CONFLICT(alias_id,entity_id) DO UPDATE SET confidence=MAX(confidence,excluded.confidence)""",
                          (aid,ent,.85,1,1,rootpath))
                        evidence(c,"entity",ent,"FOLDER_TAG_ALIAS",1,25,None,rid,folder,
                                 f"Folder identifies {num} as {value}")
                    if tail and not is_inspection_activity_label(tail):
                        aid=ensure_alias(c,tail,"equipment_description",.55)
                        c.execute("""INSERT INTO alias_candidates VALUES(?,?,?,?,?,?)
                          ON CONFLICT(alias_id,entity_id) DO UPDATE SET confidence=MAX(confidence,excluded.confidence)""",
                          (aid,ent,.8,1,1,rootpath))
        # Document families, sheet/revision.
        for n,f in enumerate(c.execute("SELECT * FROM files WHERE root_id=? AND observation_state='current'",(rid,)),1):
            if n%10000==0:print(f"  Knowledge stage: reviewed {n:,} files for document families...",flush=True)
            ids=c.execute("SELECT * FROM identifiers WHERE file_id=?",(f["file_id"],)).fetchall()
            base=next((x["value"] for x in ids if x["type"] in ("pid_family","drawing_ke")),None)
            ds=conservative_datasheet_family(f['filename'],project)
            if ds:
                famname,dsrev=ds
                dsfid=stable_id('family','project_datasheet',famname.casefold())
                c.execute('INSERT OR IGNORE INTO doc_families VALUES(?,?,?,?,?)',
                          (dsfid,famname,'project_datasheet_candidate',.72,utcnow()))
                c.execute('INSERT OR REPLACE INTO doc_members VALUES(?,?,?,?,?,?)',
                          (dsfid,f['file_id'],None,dsrev,'possible_revision_same_family',.72))
            pr=conservative_project_revision_family(f['filename'],project)
            if pr:
                famname,rev,commented=pr
                famid=stable_id('family','project_revision',famname)
                c.execute('INSERT OR IGNORE INTO doc_families VALUES(?,?,?,?,?)',
                          (famid,famname,'project_revision_candidate',.70,utcnow()))
                c.execute('INSERT OR REPLACE INTO doc_members VALUES(?,?,?,?,?,?)',
                          (famid,f['file_id'],None,rev,
                           'commented_revision_variant' if commented else 'possible_revision_same_family',.70))
            if base:
                fam=stable_id("family",base);ft="drawing"
                c.execute("INSERT OR IGNORE INTO doc_families VALUES(?,?,?,?,?)",(fam,base,ft,.9,utcnow()))
                # Extract sheet/revision from the filename, not the full parent path.
                # Sheet 04 and sheet 05 are separate members of the same family.
                sm=IDENT_PATTERNS["sheet"].search(f["filename"])
                sh=sm.group(1).zfill(2) if sm else None
                rm=IDENT_PATTERNS["revision"].search(f["filename"])
                rv=rm.group(1).upper() if rm else None
                c.execute("INSERT OR REPLACE INTO doc_members VALUES(?,?,?,?,?,?)",(fam,f["file_id"],sh,rv,"sheet_or_revision",.88))
        # Explicit document-to-equipment associations, with conservative provenance.
        # The nearest equipment-number folder wins; an explicit filename identifier
        # can add another link, but never globally equate two equipment numbers.
        files_current=c.execute("SELECT * FROM files WHERE root_id=? AND observation_state='current' AND useful=1",(rid,))
        for n,f in enumerate(files_current,1):
            if n%10000==0:print(f"  Knowledge stage: associated {n:,} files to equipment/families...",flush=True)
            candidates={}
            folder=f["parent_path"]
            while child_of(folder,rootpath):
                label=os.path.basename(folder)
                hit=IDENT_PATTERNS["equipment_number"].search(label)
                if hit:
                    num=hit.group(1)
                    candidates[num]=(0.88,"equipment_folder",folder)
                    break
                if normpath(folder)==normpath(rootpath):break
                next_folder=os.path.dirname(folder)
                if next_folder==folder:break
                folder=next_folder
            for typ,val,_ in identifiers(f["filename"]):
                if typ=="equipment_number":
                    candidates[val]=(.95,"filename_identifier",f["path"])
            for typ,val,_ in identifiers(f["content_excerpt"] or ""):
                if typ=="equipment_number" and val in candidates:
                    old=candidates[val]
                    candidates[val]=(min(.98,old[0]+.02),old[1]+"+embedded_text",old[2])
            for num,(confidence,basis,evpath) in candidates.items():
                ent=ensure_entity(c,"equipment",num,None,.82,{"discovered_from":"document_association"})
                lid=stable_id("doclink",f["file_id"],ent,"DOCUMENT_FOR_EQUIPMENT")
                c.execute("""INSERT INTO document_links VALUES(?,?,?,?,?,?,?,?)
                  ON CONFLICT(link_id) DO UPDATE SET confidence=excluded.confidence,
                  basis=excluded.basis,evidence_path=excluded.evidence_path""",
                  (lid,f["file_id"],ent,"DOCUMENT_FOR_EQUIPMENT",confidence,basis,evpath,utcnow()))
                evidence(c,"document_link",lid,"EQUIPMENT_ASSOCIATION",1,round(confidence*35,1),
                         f["file_id"],rid,f["parent_path"],f"Document associated to {num} by {basis}",
                         mode="inferred",details={"basis_path":evpath})
            # Family linkage also makes documents queryable by their precise family.
            members=c.execute("SELECT family_id FROM doc_members WHERE file_id=?",(f["file_id"],)).fetchall()
            for mem in members:
                family=c.execute("SELECT base_identifier FROM doc_families WHERE family_id=?",(mem["family_id"],)).fetchone()
                if not family:continue
                ent=ensure_entity(c,"document_family",family["base_identifier"],None,.82)
                lid=stable_id("doclink",f["file_id"],ent,"MEMBER_OF_DOCUMENT_FAMILY")
                c.execute("""INSERT INTO document_links VALUES(?,?,?,?,?,?,?,?)
                  ON CONFLICT(link_id) DO UPDATE SET confidence=excluded.confidence""",
                  (lid,f["file_id"],ent,"MEMBER_OF_DOCUMENT_FAMILY",.98,"parsed_filename",f["path"],utcnow()))
                # A family in the equipment's folder suggests contextual association,
                # not proof that every sheet depicts that equipment.
                for num,(_,basis,evpath) in candidates.items():
                    eq=ensure_entity(c,"equipment",num,None,.82)
                    rel=relationship(c,eq,ent,"EQUIPMENT_DOCUMENT_FAMILY_CONTEXT",25)
                    evidence(c,"relationship",rel,"DIRECTORY_DOCUMENT_FAMILY",1,25,f["file_id"],rid,
                             f["parent_path"],f"Family {family['base_identifier']} located within equipment context {num}",
                             mode="inferred")
        # Local deterministic findings must exist even when paid AI is disabled.
        for profile in c.execute("SELECT * FROM directory_profiles WHERE root_id=?",(rid,)).fetchall():
            if profile["role"]=="directory": continue
            finding=stable_id("finding",rid,"directory_role",normpath(profile["path"]))
            c.execute("INSERT OR REPLACE INTO explorer_findings VALUES(?,?,?,?,?,?,?,?)",
                      (finding,rid,"directory_role",profile["path"],
                       json.dumps({"role":profile["role"],"source":"observed_directory_name"}),
                       profile["confidence"],1,utcnow()))
        # Machine filenames + context -> enrichment.
        for f in c.execute("""SELECT * FROM files WHERE root_id=? AND observation_state='current'
                              AND filename_class='MACHINE_GENERATED' AND useful=1""",(rid,)):
            pri=max(.45,f["inspection_value"])
            reasons=["MACHINE_GENERATED_FILENAME"]
            if any(x in f["path"].casefold() for x in ("drawing","inspection","project","afe","engineering")):
                reasons.append("HIGH_VALUE_DIRECTORY_CONTEXT");pri=max(pri,.72)
            c.execute("INSERT OR REPLACE INTO enrichment VALUES(?,?,?,?,?,?,?)",
                      (f["file_id"],1,pri,json.dumps(reasons),
                       json.dumps(["extract_embedded_text","ocr_document","vision_analyze_pages","extract_identifiers","recalculate_relationships"]),
                       pri,utcnow()))
        # Review ambiguity based on aliases with >1 plausible candidate.
        for a in c.execute("""SELECT a.*,COUNT(ac.entity_id) n FROM aliases a JOIN alias_candidates ac USING(alias_id)
                              WHERE ac.confidence>=.6 GROUP BY a.alias_id HAVING n>1"""):
            c.execute("UPDATE aliases SET globally_unique=0,status='ambiguous' WHERE alias_id=?",(a["alias_id"],))
            qid=stable_id("review","alias",a["alias_id"])
            c.execute("INSERT OR REPLACE INTO review_queue VALUES(?,?,?,?,?,?,?)",
                      (qid,"alias",a["alias_id"],.75,json.dumps(["AMBIGUOUS_ALIAS","MULTIPLE_ENTITY_CANDIDATES"]),"open",utcnow()))
        c.commit()

# Index-side retrieval vocabulary; not a query engine. Facts remain attached to files.
def build_retrieval_terms(workdir,rid):
    stop={"the","and","for","with","from","into","files","file","documents","document",
          "rev","revision","pdf","docx","xlsx","dwg","bak","unit"}
    def words(s):
        return {w.casefold() for w in re.findall(r"[A-Za-z][A-Za-z0-9]{2,}",s or "")
                if w.casefold() not in stop and len(w)<=64}
    with connect(workdir/DB_NAME) as db:
        rootrow=db.execute("SELECT path FROM roots WHERE root_id=?",(rid,)).fetchone()
        rootpath=rootrow['path'] if rootrow else ''
        files=db.execute("SELECT file_id,filename,parent_path,useful FROM files WHERE root_id=? AND observation_state='current'",(rid,))
        for n,f in enumerate(files,1):
            if n%10000==0:print(f"  Retrieval stage: processed {n:,} files...",flush=True)
            fid=f['file_id']
            db.execute("DELETE FROM file_retrieval_terms WHERE file_id=?",(fid,))
            if not f['useful']: continue
            terms=[]
            for w in words(Path(f['filename']).stem): terms.append((w,'filename_token','filename',.92,''))
            # Folder terms are context only and must never be mistaken for document title terms.
            for component in re.split(r"[\\/]",os.path.relpath(f['parent_path'],rootpath)):
                for w in words(component): terms.append((w,'folder_context','directory',.48,''))
            for ident in db.execute("SELECT type,value,source FROM identifiers WHERE file_id=?",(fid,)):
                if ident['source'] in ('filename','path','folder','embedded_text','content'):
                    conf=.98 if ident['source']=='filename' else (.60 if ident['source'] in ('embedded_text','content') else .52)
                    terms.append((ident['value'].casefold(),'exact_identifier',ident['source'],conf,''))
            for link in db.execute('''SELECT dl.entity_id,dl.link_type,dl.basis,dl.confidence,e.canonical_name
                                      FROM document_links dl JOIN entities e ON e.entity_id=dl.entity_id
                                      WHERE dl.file_id=?''',(fid,)):
                origin='document_family' if link['link_type']=='MEMBER_OF_DOCUMENT_FAMILY' else 'equipment_association'
                base_conf=min(float(link['confidence']),.90) if origin=='document_family' else min(float(link['confidence']),.73)
                terms.append((link['canonical_name'].casefold(),'linked_entity',origin,base_conf,link['entity_id']))
                for a in db.execute('''SELECT a.value,ac.scope FROM alias_candidates ac
                                       JOIN aliases a ON a.alias_id=ac.alias_id
                                       WHERE ac.entity_id=?''',(link['entity_id'],)):
                    # Alias is derived from a contextual relationship, never independent proof.
                    terms.append((a['value'].casefold(),'linked_alias',origin,min(base_conf,.69),link['entity_id']))
            for t in set(terms):
                db.execute('''INSERT OR IGNORE INTO file_retrieval_terms
                              (file_id,term,term_kind,origin,confidence,entity_id)
                              VALUES(?,?,?,?,?,?)''',(fid,*t))
        db.commit()

def detect_moves(workdir,rid):
    with connect(workdir/DB_NAME) as c:
        new=c.execute("SELECT * FROM files WHERE root_id=? AND change_state='new' AND useful=1",(rid,))
        for n in new:
            olds=c.execute("""SELECT * FROM files WHERE observation_state='not_currently_observed' AND size_bytes=? AND file_id<>?
                              LIMIT 50""",(n["size_bytes"],n["file_id"])).fetchall()
            for o in olds:
                score=.45; reasons=["SAME_SIZE"]
                if o["filename"].casefold()==n["filename"].casefold():score+=.25;reasons.append("SAME_FILENAME")
                if o["mtime_ns"]==n["mtime_ns"]:score+=.20;reasons.append("SAME_MTIME")
                if score>=.65:
                    mid=stable_id("move",o["file_id"],n["file_id"])
                    c.execute("INSERT OR REPLACE INTO move_candidates VALUES(?,?,?,?,?,?,?)",
                              (mid,o["file_id"],n["file_id"],min(score,.9),json.dumps(reasons),"candidate",utcnow()))
        c.commit()

def deterministic_quality_report(c):
    """Reproducible audit of observed index facts. No network reads and no AI."""
    one=lambda sql: c.execute(sql).fetchone()[0]
    report={
      "current_files":one("SELECT COUNT(*) FROM files WHERE observation_state='current'"),
      "useful_files":one("SELECT COUNT(*) FROM files WHERE observation_state='current' AND useful=1"),
      "parsed_content_files":one("SELECT COUNT(*) FROM files WHERE observation_state='current' AND useful=1 AND information_value>0"),
      "unparsed_pdf_files":one("SELECT COUNT(*) FROM files WHERE observation_state='current' AND useful=1 AND lower(extension)='.pdf' AND (information_value IS NULL OR information_value=0)"),
      "associated_files":one("SELECT COUNT(DISTINCT l.file_id) FROM document_links l JOIN files f ON f.file_id=l.file_id WHERE f.observation_state='current' AND l.link_type='DOCUMENT_FOR_EQUIPMENT'"),
      "document_family_files":one("SELECT COUNT(DISTINCT l.file_id) FROM document_links l JOIN files f ON f.file_id=l.file_id WHERE f.observation_state='current' AND l.link_type='MEMBER_OF_DOCUMENT_FAMILY'"),
      "technical_mentions_unverified":one("SELECT COUNT(*) FROM technical_mentions WHERE verification_state='unverified'"),
      "engineering_source_observations":one("SELECT COUNT(*) FROM engineering_observations"),
    }
    # Two file paths can appear to be a duplicate; size/name alone is not proof.
    dupes=c.execute("""SELECT lower(filename) name,size_bytes size,COUNT(*) n
       FROM files WHERE observation_state='current' AND useful=1
       GROUP BY lower(filename),size_bytes HAVING COUNT(*)>1 ORDER BY n DESC,name LIMIT 100""").fetchall()
    report["possible_duplicate_name_size_groups"]=[dict(x) for x in dupes]
    # Same drawing family, sheet, and revision at different paths should be reviewed,
    # not automatically merged or deemed a superseded document.
    drawing=c.execute("""SELECT d.base_identifier family,m.sheet,m.revision,COUNT(DISTINCT m.file_id) n
      FROM doc_members m JOIN doc_families d ON d.family_id=m.family_id
      JOIN files f ON f.file_id=m.file_id WHERE f.observation_state='current'
      AND m.sheet IS NOT NULL AND m.revision IS NOT NULL
      GROUP BY d.base_identifier,m.sheet,m.revision HAVING COUNT(DISTINCT m.file_id)>1
      ORDER BY n DESC,family,sheet LIMIT 100""").fetchall()
    report["same_sheet_revision_candidates"]=[dict(x) for x in drawing]
    # A file naming a different equipment number than its nearest numbered folder
    # is a possible association conflict, not proof of wrong filing.
    conflicts=[]
    roots={r['root_id']:r['path'] for r in c.execute('SELECT root_id,path FROM roots')}
    for f in c.execute("SELECT file_id,root_id,path,filename,parent_path FROM files WHERE observation_state='current' AND useful=1"):
        folder=f['parent_path'];root=roots.get(f['root_id'],'')
        parent_num=None
        while root and child_of(folder,root):
            hit=IDENT_PATTERNS['equipment_number'].search(os.path.basename(folder))
            if hit:parent_num=hit.group(1);break
            if normpath(folder)==normpath(root):break
            nxt=os.path.dirname(folder)
            if nxt==folder:break
            folder=nxt
        if not parent_num:continue
        names={v for t,v,_ in identifiers(f['filename']) if t=='equipment_number'}
        if names and parent_num not in names:
            conflicts.append({'file_id':f['file_id'],'path':f['path'],
                              'folder_equipment':parent_num,'filename_equipment':sorted(names)})
        if len(conflicts)>=100:break
    report['equipment_folder_filename_conflicts']=conflicts
    report['notes']=[
      'Possible duplicates and conflicts are review candidates, not established errors.',
      'Unparsed PDFs include scans and PDFs that were not selected for content inspection.',
      'Associations based on folder placement do not prove a technical statement applies to that equipment.',
      'Technical observations describe source text only; no automatic equipment design specification, document authority, or equipment relationship is asserted.'
    ]
    return report

def scan_coverage_report(c):
    """Expose directory ledger and crawl provenance, never invent full-root coverage."""
    report=[]
    for root in c.execute('SELECT * FROM roots ORDER BY path').fetchall():
        rid=root['root_id']
        directory_rows=[dict(x) for x in c.execute(
            'SELECT path,state,crawl_id,updated_at,error FROM dir_queue WHERE root_id=? ORDER BY path',(rid,)).fetchall()]
        latest=c.execute('SELECT * FROM crawls WHERE root_id=? ORDER BY started_at DESC,crawl_id DESC LIMIT 1',(rid,)).fetchone()
        states=collections.Counter(d['state'] for d in directory_rows)
        known=len(directory_rows)
        completed=states.get('completed',0)
        # This is progress only among paths the indexer has discovered; unseen subtrees are unknowable.
        known_percent=round(100*completed/known,2) if known else None
        status=latest['status'] if latest else 'never_scanned'
        fully_verified=(status=='inventory_complete' and known>0 and completed==known)
        report.append({
            'root_id':rid,'root_path':root['path'],
            'last_crawl_started_at':latest['started_at'] if latest else None,
            'last_crawl_finished_at':latest['completed_at'] if latest else None,
            'last_crawl_status':status,
            'last_crawl_files_seen':latest['files_seen'] if latest else 0,
            'last_crawl_directories_seen':latest['dirs_seen'] if latest else 0,
            'last_crawl_issues':latest['issues'] if latest else 0,
            'known_directories':known,'completed_known_directories':completed,
            'known_directory_progress_percent':known_percent,
            'full_root_completion_percent':100.0 if fully_verified else None,
            'root_fully_inventoried':fully_verified,
            'coverage_note':'Known-directory progress is not whole-root coverage; unknown means not measured. Bounded samples cannot prove full-root completion. Reparse points are intentionally not followed.',
            'directory_states':dict(states),'directories':directory_rows
        })
    return report

def equipment_format_candidates(c):
    """Review-only formatting suggestions. No identity rewrite or entity merge."""
    grouped=collections.defaultdict(list)
    for r in c.execute("SELECT entity_id,canonical_name FROM entities WHERE entity_type='equipment'"):
        m=re.fullmatch(r'(\d{4})\.(\d{1,3})',r['canonical_name'])
        if m:
            key=m.group(1)+'.'+(m.group(2).zfill(2) if len(m.group(2))<=2 else m.group(2))
            grouped[key].append({'entity_id':r['entity_id'],'canonical_name':r['canonical_name']})
    return [{'comparison_key':k,'records':v,'resolution_status':'review_required',
             'auto_merge_permitted':False}
            for k,v in sorted(grouped.items()) if len({x['canonical_name'] for x in v})>1]


def export_relationship_record(item):
    """Derive consumer safety labels without changing stored evidence."""
    if item.get('rel_type')=='CO_OCCURS_OR_BRIDGES':
        item['verification_status']='unverified_candidate'
        item['consumer_use']='retrieval_clue_only'
        item['confirmed_engineering_relationship']=False
        item['explanation']='Identifiers co-occur; co-occurrence is not equipment or engineering linkage proof.'
    else:
        # Algorithmic links remain unverified even when their confidence score is high.
        item['verification_status']='unverified_algorithmic' if item.get('authority')!='human' else 'human_asserted_check_provenance'
        item['consumer_use']='contextual_relationship_check_evidence'
        item['confirmed_engineering_relationship']=False
    return item

def export_index(workdir,out=None,read_only=False,output_workspace=None):
    out=safe_output(out if out else workdir/EXPORT_NAME,output_workspace or workdir)
    if read_only:
        from urllib.parse import quote
        dbpath=(workdir/DB_NAME).resolve()
        if not dbpath.is_file():raise SystemExit('EXPORT STOP: existing local database not found: '+str(dbpath))
        wal=Path(str(dbpath)+'-wal')
        if wal.exists() and wal.stat().st_size>0:
            raise SystemExit('EXPORT STOP: active SQLite WAL present. Finish/close all indexing processes before read-only export; refusing possibly stale snapshot.')
        uri='file:'+quote(str(dbpath).replace(chr(92),'/'),safe='/:')+'?mode=ro&immutable=1'
        conn=sqlite3.connect(uri,uri=True)
        conn.row_factory=sqlite3.Row
    else:
        conn=connect(workdir/DB_NAME)
    with contextlib.closing(conn) as c:
        def rows(sql,args=()):return {"__stream_sql__":sql,"__stream_args__":args}
        stats={
          "roots":c.execute("SELECT COUNT(*) n FROM roots").fetchone()["n"],
          "files_historical":c.execute("SELECT COUNT(*) n FROM files").fetchone()["n"],
          "files_current":c.execute("SELECT COUNT(*) n FROM files WHERE observation_state='current'").fetchone()["n"],
          "files_not_currently_observed":c.execute("SELECT COUNT(*) n FROM files WHERE observation_state='not_currently_observed'").fetchone()["n"],
          "entities":c.execute("SELECT COUNT(*) n FROM entities").fetchone()["n"],
          "aliases":c.execute("SELECT COUNT(*) n FROM aliases").fetchone()["n"],
          "relationships":c.execute("SELECT COUNT(*) n FROM relationships").fetchone()["n"],
          "document_links":c.execute("SELECT COUNT(*) n FROM document_links").fetchone()["n"],
          "retrieval_terms":c.execute("SELECT COUNT(*) n FROM file_retrieval_terms").fetchone()["n"],
          "technical_mentions":c.execute("SELECT COUNT(*) n FROM technical_mentions").fetchone()["n"],
          "engineering_observations":c.execute("SELECT COUNT(*) n FROM engineering_observations").fetchone()["n"],
          "evidence":c.execute("SELECT COUNT(*) n FROM evidence").fetchone()["n"],
          "issues":c.execute("SELECT COUNT(*) n FROM issues").fetchone()["n"],
        }
        obj={
          "schema_version":SCHEMA_VERSION,"generator":{"name":APP,"version":VERSION},"generated_at":utcnow(),
          "index":{"type":"cumulative_thor_knowledge_index","roots":rows("SELECT * FROM roots ORDER BY path")},
          "contract":{
            "authority":"THOR remains authoritative; this index contains observations and challengeable knowledge about THOR.",
            "observation_vs_inference":"Never rewrite observed filesystem facts to match an inference.",
            "ambiguity":"Aliases may be scoped and ambiguous. Never assume equipment tags such as V1 are globally unique.",
            "disambiguation":"Prefer unit/scope and high-specificity identifiers. If multiple strong candidates remain, consuming UI should ask for clarification.",
            "history":"A disappeared file is retained as not_currently_observed. Absence from index does not prove absence on THOR.",
            "dates":"Date provenance matters. Filesystem timestamps are not automatically engineering-event dates. Earlier-than-event can be strong negative evidence; later timestamps may represent scans/migrations.",
            "confidence":"Confidence is not query relevance, importance, or review priority. Independent evidence matters more than repetition in one lineage.",
            "graph":"Derived evidence retains lineage; circular reinforcement must not manufacture independence; confidence should decay through hops.",
            "ai":"AI conclusions are inference, not filesystem fact. Deterministic indexing remains usable without AI.",
            "enrichment":"Expensive parsing/OCR/vision/AI should follow expected information gain rather than blanket processing."
          },
          "schema_dictionary":{
            "persistence_class":{"1":"refreshable observed filesystem fact","2":"retained machine inference; re-evaluate","3":"durable high-authority human knowledge; challengeable","4":"query-specific ephemeral conclusion"},
            "observation_state":{"current":"seen in latest root crawl","not_currently_observed":"historical observation not seen in latest root crawl"},
            "filename_class":{"SEMANTIC":"human-semantic filename","STRUCTURED_IDENTIFIER":"recognized structured identifier","GENERIC":"little identity value","MACHINE_GENERATED":"likely source/scanner serial; uniqueness != semantic power","UNKNOWN":"unclassified"},
            "evidence.lineage_key":"origin branch/path used to prevent correlated or circular evidence from being counted as independent."
          },
          "retrieval_contract":{
            "role":"index artifact for downstream search consumers; this program does not answer search queries",
            "filename_and_path":"preserve raw labels, hierarchy and exact paths; downstream fuzzy matching must not modify identifiers",
            "relationships":"all algorithmic relationships are unverified; CO_OCCURS_OR_BRIDGES only supports candidate retrieval, never a confirmed engineering relationship",
            "engineering_values":"may add context but never prove file equivalence or equipment identity",
            "query_interpretation":"implemented by a separate consumer, not by the indexer"
          },
          "search_guidance":{
            "resolution_order":["exact high-specificity identifiers","unit/scoped aliases","bridge identifiers/projects","related terminology","directory/neighborhood context"],
            "ambiguity_action":"request clarification when multiple strong scoped entities remain",
            "temporal_rule":"rank dates by provenance and asymmetric relation to requested engineering event",
            "enrichment_ladder":["filesystem metadata","filename/path","embedded text","cheap parsing","OCR","vision/layout","AI semantic interpretation"]
          },
          "relationship_consumer_contract":{"cooccurrence_verification_status":"unverified_candidate",
            "cooccurrence_consumer_use":"retrieval_clue_only",
            "confidence_is_not_verification":True,"confirmed_engineering_relationships_asserted":False,
            "note":"No consumer may promote co-occurrence into a verified technical/equipment relationship without independent authority."},
          "identifier_format_candidates":equipment_format_candidates(c),
          "statistics":stats,"scan_coverage":scan_coverage_report(c),"quality_report":deterministic_quality_report(c),
          "entities":rows("SELECT * FROM entities"),"aliases":rows("SELECT * FROM aliases"),
          "alias_candidates":rows("SELECT * FROM alias_candidates"),"relationships":rows("SELECT * FROM relationships"),
          "document_links":rows("SELECT * FROM document_links"),
          "file_retrieval_terms":rows("SELECT * FROM file_retrieval_terms"),
          "technical_mentions":rows("SELECT * FROM technical_mentions"),
          "engineering_observations":rows("SELECT * FROM engineering_observations"),
          "files":rows("""SELECT file_id,root_id,path,filename,extension,parent_path,depth,size_bytes,mtime_ns,ctime_ns,filename_class,
                         useful,first_seen,last_seen,observation_state,change_state,inspection_value,content_method,information_value FROM files"""),
          "identifiers":rows("SELECT * FROM identifiers"),"evidence":rows("SELECT * FROM evidence"),
          "document_families":rows("SELECT * FROM doc_families"),"document_members":rows("SELECT * FROM doc_members"),
          "directory_profiles":rows("SELECT * FROM directory_profiles"),"explorer_findings":rows("SELECT * FROM explorer_findings"),
          "enrichment":rows("SELECT * FROM enrichment"),"review_queue":rows("SELECT * FROM review_queue"),
          "move_candidates":rows("SELECT * FROM move_candidates"),"crawl_issues":rows("SELECT * FROM issues")
        }
        json_columns={
          "entities":["attributes_json"],"evidence":["details_json"],"explorer_findings":["value_json"],
          "enrichment":["reason_codes_json","actions_json"],"review_queue":["reason_codes_json"],
          "move_candidates":["reasons_json"],"crawl_issues":["details_json"]
        }
        out.parent.mkdir(parents=True,exist_ok=True)
        temp=out.with_suffix(out.suffix+".tmp")
        try:
            with open(temp,"w",encoding="utf-8",newline="\n") as f:
                f.write("{\n")
                for index,(section,value) in enumerate(obj.items()):
                    if index:f.write(",\n")
                    f.write(json.dumps(section,ensure_ascii=False)+":")
                    if isinstance(value,dict) and "__stream_sql__" in value:
                        f.write("[")
                        for n,record in enumerate(c.execute(value["__stream_sql__"],value["__stream_args__"])):
                            if n:f.write(",\n")
                            if n and n%50000==0:
                                print(f"  JSON export {section}: {n:,} records streamed...",flush=True)
                            item=dict(record)
                            if section=='relationships':item=export_relationship_record(item)
                            for key in json_columns.get(section,[]):
                                if key in item:
                                    item[key[:-5] if key.endswith("_json") else key]=json_loads(item.pop(key),{})
                            f.write(json.dumps(item,ensure_ascii=False,separators=(",",":"),default=str))
                        f.write("]")
                    elif section=="index" and isinstance(value,dict) and isinstance(value.get("roots"),dict) and "__stream_sql__" in value["roots"]:
                        f.write('{"type":"cumulative_thor_knowledge_index","roots":[')
                        for n,record in enumerate(c.execute(value["roots"]["__stream_sql__"])):
                            if n:f.write(",")
                            f.write(json.dumps(dict(record),ensure_ascii=False))
                        f.write("]}")
                    else:f.write(json.dumps(value,ensure_ascii=False,default=str))
                f.write("\n}\n")
                f.flush();os.fsync(f.fileno())
            os.replace(temp,out)
        finally:
            if temp.exists():temp.unlink()
    with open(out,'rb') as f:
        header=f.read(200)
        if b'"schema_version"' not in header:
            raise RuntimeError('Export schema header validation failed')
        if out.stat().st_size<50_000_000:
            f.seek(0)
            if json.load(f)['schema_version']!=SCHEMA_VERSION:
                raise RuntimeError('Export JSON validation failed')
    # Large exports are kept streaming; loading hundreds of MB into memory is unsafe.
    # An integrity manifest records the SQLite state and artifact size/hash locally.
    with connect(workdir/DB_NAME) as audit:
        sql_integrity=audit.execute('PRAGMA integrity_check').fetchone()[0]
        if sql_integrity!='ok':raise RuntimeError('SQLite integrity failed: '+sql_integrity)
    digest=hashlib.sha256()
    with out.open('rb') as f:
        for block in iter(lambda:f.read(4*1024*1024),b''):digest.update(block)
    atomic_json(out.with_suffix(out.suffix+'.manifest.json'),
                {'generator_version':VERSION,'schema_version':SCHEMA_VERSION,
                 'sqlite_integrity':sql_integrity,'files_current':stats['files_current'],
                 'export_bytes':out.stat().st_size,'sha256':digest.hexdigest(),
                 'note':'JSON produced by streaming serializer; files >50MB are not reloaded into RAM for full syntactic validation.'})
    print(f"Exported {out} ({stats['files_current']:,} current files, {stats['entities']:,} entities, {stats['relationships']:,} relationships)")
    return out

def final_ingestion_report(workdir,root,cid,census=None):
    """Audit indexed records against an earlier census without reading THOR."""
    with connect(workdir/DB_NAME) as c:
        crawl_row=c.execute('SELECT * FROM crawls WHERE crawl_id=?',(cid,)).fetchone()
        rid=crawl_row['root_id']
        files=c.execute("SELECT COUNT(*) FROM files WHERE root_id=? AND observation_state='current'",(rid,)).fetchone()[0]
        dir_counts={r['state']:r['n'] for r in c.execute('SELECT state,COUNT(*) n FROM dir_queue WHERE root_id=? GROUP BY state',(rid,))}
        extensions={r['extension'] or '<none>':r['n'] for r in c.execute("SELECT extension,COUNT(*) n FROM files WHERE root_id=? AND observation_state='current' GROUP BY extension ORDER BY n DESC",(rid,))}
        size=int(c.execute("SELECT COALESCE(SUM(size_bytes),0) FROM files WHERE root_id=? AND observation_state='current'",(rid,)).fetchone()[0])
        problems=[dict(r) for r in c.execute("SELECT reason_code,COUNT(*) n FROM issues WHERE crawl_id=? GROUP BY reason_code ORDER BY n DESC",(cid,))]
        db_integrity=c.execute('PRAGMA integrity_check').fetchone()[0]
        recorded_paid_ai_calls=int(c.execute("SELECT COUNT(*) FROM ai_cost_ledger WHERE decision='executed'").fetchone()[0])
    prior=_load_census(census,root) if census else None
    complete=(crawl_row['status']=='inventory_complete' and not any(n for state,n in dir_counts.items() if state!='completed') and db_integrity=='ok')
    report={'generator_version':VERSION,'root':root,'generated_at':utcnow(),
            'fully_indexed_accessible_tree':bool(complete),
            'exact_file_count_for_completed_index':files if complete else None,
            'observed_current_files':files,'known_directories_by_state':dir_counts,
            'observed_current_bytes':size,'extensions':extensions,
            'crawl':dict(crawl_row),'issues_by_reason':problems,
            'sqlite_integrity':db_integrity,'census_reference':prior,
            'difference_vs_prior_census':{'files':files-prior['files'],'completed_directories':dir_counts.get('completed',0)-prior['directories']} if prior else None,
            'output':{'sqlite':str(workdir/DB_NAME),'json':str(workdir/EXPORT_NAME),
                      'json_manifest':str(workdir/(EXPORT_NAME+'.manifest.json')),
                      'ai_plan':str(workdir/'ai_execution_plan.json')},
            'paid_ai_calls_recorded_in_local_ledger':recorded_paid_ai_calls,
            'source_safety':'No source writes are implemented; OS-level read-only THOR credentials remain the enforceable boundary.',
            'scope_note':'Reparse points are intentionally not traversed. Files can change between the census and ingestion.'}
    atomic_json(workdir/'ingestion_report.json',report)
    print('FINAL LOCAL AUDIT:', 'COMPLETE' if complete else 'PARTIAL / REVIEW REQUIRED',
          '| indexed files',f'{files:,}','| SQLite',db_integrity,flush=True)
    return report

def _pipeline_key(root):
    return 'production_pipeline:'+normpath(root)

def _pipeline_save(workdir,root,cid,rid,phase):
    payload={'crawl_id':cid,'root_id':rid,'root':root,'phase':phase,'updated_at':utcnow()}
    with connect(workdir/DB_NAME) as c:
        c.execute('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)',(_pipeline_key(root),json.dumps(payload)))

def _pipeline_pending(workdir,root):
    db=workdir/DB_NAME
    if not db.exists():return None
    with connect(db) as c:
        r=c.execute('SELECT value FROM meta WHERE key=?',(_pipeline_key(root),)).fetchone()
        if not r:return None
        p=json_loads(r[0],{})
        if p.get('phase') in ('complete','complete_no_export'):return None
        crawl_row=c.execute('SELECT status FROM crawls WHERE crawl_id=?',(p.get('crawl_id'),)).fetchone()
        if not crawl_row or crawl_row[0]!='inventory_complete':return None
        # Resume only completed, error-free metadata pass. Never call it complete
        # if any directories were skipped or incomplete.
        bad=c.execute("SELECT COUNT(*) FROM dir_queue WHERE root_id=? AND state<>'completed'",(p.get('root_id'),)).fetchone()[0]
        if bad:return None
        return p

def run_full(workdir,root,cfg,max_files=None,max_dirs=None,test_mode=False,auto_export=False,workers=None,census=None):
    pending=_pipeline_pending(workdir,root) if max_files is None and max_dirs is None else None
    if pending:
        cid,rid=pending['crawl_id'],pending['root_id'];phase=pending['phase']
        print(f'RESUMING LOCAL POST-INVENTORY PROCESSING: {phase}; no NAS re-inventory required.',flush=True)
    else:
        result=crawl(workdir,root,cfg,max_files=max_files,max_dirs=max_dirs,workers=workers,census=census)
        if not result:return
        cid,rid=result;phase='inventory_done'
        if not test_mode:_pipeline_save(workdir,root,cid,rid,phase)
    if phase=='inventory_done':
        print('STAGE 2/4: Selective local-content reconnaissance (bounded)...',flush=True)
        stage_zero_and_content(workdir,rid,cid,cfg)
        phase='content_done'
        if not test_mode:_pipeline_save(workdir,root,cid,rid,phase)
    if phase=='content_done':
        print('STAGE 3/4: Deterministic document/equipment knowledge and retrieval indexes...',flush=True)
        build_knowledge(workdir,rid)
        detect_moves(workdir,rid)
        build_retrieval_terms(workdir,rid)
        phase='knowledge_done'
        if not test_mode:_pipeline_save(workdir,root,cid,rid,phase)
    with connect(workdir/DB_NAME) as c:
        c.execute('UPDATE crawls SET completed_at=? WHERE crawl_id=?',(utcnow(),cid))
    if auto_export or test_mode:
        print('STAGE 4/4: Atomic JSON export and local SQLite verification...',flush=True)
        export_index(workdir,workdir/('thor_index_test.json' if test_mode else EXPORT_NAME))
        if not test_mode:
            atomic_json(workdir/'ai_execution_plan.json',ai_execution_plan(workdir))
            final_ingestion_report(workdir,root,cid,census=census)
            _pipeline_save(workdir,root,cid,rid,'complete')
    else:
        if not test_mode:_pipeline_save(workdir,root,cid,rid,'complete_no_export')
        print('Knowledge saved to thor_knowledge.db. Export later with: python thor_indexer.py export')

def refine_knowledge(workdir, iterations=1):
    """Recompute correlations from accumulated observations without network traversal or paid AI."""
    with connect(workdir/DB_NAME) as db:
        roots=[r['root_id'] for r in db.execute('SELECT root_id FROM roots')]
    if not roots:
        print('No indexed roots. Run crawl first.');return
    for n in range(iterations):
        print(f'Refinement iteration {n+1}/{iterations} — {len(roots)} accumulated roots')
        for rid in roots: build_knowledge(workdir,rid)
    print('Refinement complete. Production export remains unchanged until export is requested.')

def run_workflow(workdir, roots, cfg, iterations=1, export_final=False):
    """Full discovery for each supplied root, then iterative local refinement and optional export."""
    for i,root in enumerate(roots,1):
        print(f'\nROOT {i}/{len(roots)}: {root}')
        run_full(workdir,root,cfg,auto_export=False)
    if iterations>1: refine_knowledge(workdir,iterations-1)
    if export_final: export_index(workdir)
    else: print('All discoveries are saved. Run `python thor_indexer.py export` whenever ready.')

def accumulation_test(workdir, roots, max_files, max_dirs):
    """Bounded, AI-free tests in one isolated local workspace; no THOR writes."""
    if len(roots)<2:
        raise SystemExit("accumulation-test requires at least two root arguments (repeat a root if needed)")
    if max_files<1 or max_dirs<1:
        raise SystemExit("Test limits must be positive")
    twd=workdir/"thor_accumulation_workspace"
    safe_local_workspace(twd)
    for root in roots:
        safety(twd,root)
    twd.mkdir(parents=True,exist_ok=True)
    init_db(twd/DB_NAME)
    validate_disjoint_roots(twd,roots)
    cfg=default_config(twd)
    cfg['ai']['enabled']=False
    atomic_json(twd/CFG_NAME,cfg)
    with connect(twd/DB_NAME) as db:
        before={r['norm_path']:r['n'] for r in db.execute('SELECT r.norm_path,COUNT(f.file_id) n FROM roots r LEFT JOIN files f ON f.root_id=r.root_id GROUP BY r.root_id')}
    results=[]
    for i,root in enumerate(roots,1):
        print(f"\nACCUMULATION PASS {i}/{len(roots)}: {root}")
        run_full(twd,root,cfg,max_files=max_files,max_dirs=max_dirs,test_mode=False)
        with connect(twd/DB_NAME) as db:
            assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok', 'SQLite integrity failed'
            rid=stable_id('root',normpath(root))
            fcount=db.execute('SELECT COUNT(*) FROM files WHERE root_id=?',(rid,)).fetchone()[0]
            current=db.execute("SELECT COUNT(*) FROM files WHERE root_id=? AND observation_state='current'",(rid,)).fetchone()[0]
            status=db.execute('SELECT status FROM crawls WHERE root_id=? ORDER BY started_at DESC LIMIT 1',(rid,)).fetchone()[0]
            assert status=='sample_complete', f'Bounded scan incorrectly classified as {status}'
            assert fcount==current, 'Bounded pass incorrectly marked known files missing'
            for key,old in before.items():
                current_count=db.execute('SELECT COUNT(*) FROM files WHERE root_id=(SELECT root_id FROM roots WHERE norm_path=?)',(key,)).fetchone()[0]
                assert current_count>=old,'Previously indexed root lost file records'
            total=db.execute('SELECT COUNT(*) FROM files').fetchone()[0]
            root_count=db.execute('SELECT COUNT(*) FROM roots').fetchone()[0]
            results.append({'pass':i,'root':str(root),'root_files':fcount,'total_files':total,'registered_roots':root_count,'crawl_status':status,'sqlite_integrity':'ok'})
            before={r['norm_path']:r['n'] for r in db.execute('SELECT r.norm_path,COUNT(f.file_id) n FROM roots r LEFT JOIN files f ON f.root_id=r.root_id GROUP BY r.root_id')}
    export_index(twd,twd/'thor_accumulation_test.json')
    atomic_json(twd/'accumulation_validation.json', {'generator_version':VERSION,'passes':results,'notes':['Each supplied root was scanned with independent per-pass limits.','No bounded scan marks earlier files missing.','Overlapping roots are intentionally rejected pending deduplication design.','The tested workspace is isolated from the production database.']})
    print('ACCUMULATION VALIDATED:',twd/'accumulation_validation.json')
    print('CUMULATIVE INDEX:',twd/'thor_accumulation_test.json')

def self_test(workdir, file_count=1100):
    """Offline regression: local fixtures only; never opens THOR or any network path.

    Each accumulation invocation is an independent Python process, exercising
    persistence across process lifetimes. Separate small interruption fixture
    tests retry after KeyboardInterrupt without marking files missing.
    """
    import tempfile
    from unittest import mock
    if file_count<1000 or file_count>5000:
        raise SystemExit('self-test --files must be between 1000 and 5000')
    started=time.monotonic()
    with tempfile.TemporaryDirectory(prefix='thor_v30_offline_') as folder:
        base=Path(folder).resolve()
        a=base/'Crude'/ '10 - VESSELS'
        b=base/'DHT'/'10 - VESSELS'
        a.mkdir(parents=True);b.mkdir(parents=True)
        n_a=file_count//2;n_b=file_count-n_a
        for root,n,tag in ((a,n_a,'2010.03 V-3 PREFRACTIONATOR TOWER'),(b,n_b,'2510.01 V-1 PRODUCT SEPARATOR')):
            target=root/tag
            target.mkdir()
            for i in range(n):
                (target/f'{i:05d} Inspection Notes.txt').write_text(f'inspection note {i}',encoding='utf-8')
        (a/'2010.03 Ext. Visual').mkdir()
        (a/'2010.03 Ext. Visual'/'2010.03 External Visual Report.txt').write_text('External visual inspection',encoding='utf-8')
        # Snapshot fixture content and metadata; indexing must not touch source.
        source_snapshot={str(p):(p.stat().st_size,p.stat().st_mtime_ns,hashlib.sha256(p.read_bytes()).hexdigest())
                         for p in list(a.rglob('*'))+list(b.rglob('*')) if p.is_file()}
        workspace=base/'workspace';workspace.mkdir()
        cmd=[sys.executable,str(Path(__file__).resolve()),'--workdir',str(workspace),'accumulation-test']
        reports=[]
        def invoke(root):
            run=subprocess.run(cmd+[str(root),str(root),'--max-files',str(file_count+10),'--max-dirs','200'],
                               capture_output=True,text=True,timeout=180)
            if run.returncode:
                raise AssertionError('Separate-process accumulation failed: '+run.stdout[-1200:]+' '+run.stderr[-1200:])
            with connect(workspace/'thor_accumulation_workspace'/DB_NAME) as db:
                assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
                rows=db.execute('SELECT path FROM roots ORDER BY path').fetchall()
                num=db.execute('SELECT COUNT(*) FROM files').fetchone()[0]
                names={r[0] for r in rows}
                reports.append({'root':str(root),'total_files':num,'roots':len(rows)})
                return num,names
        n1,r1=invoke(a)
        assert n1==n_a+1 and len(r1)==1,(n1,r1)
        n2,r2=invoke(b)
        assert n2==file_count+1 and len(r2)==2,(n2,r2)
        n3,r3=invoke(a)
        assert n3==n2 and r3==r2,(n3,r3)
        with connect(workspace/'thor_accumulation_workspace'/DB_NAME) as db:
            false_alias=db.execute("SELECT COUNT(*) FROM aliases WHERE lower(value)='ext. visual' AND alias_type='equipment_description'").fetchone()[0]
            assert false_alias==0,'External Visual incorrectly classified as equipment description'
            originals=db.execute('SELECT file_id FROM files').fetchall()
            assert len({x[0] for x in originals})==n3,'Duplicate file identities'
        # Nested root is rejected before performing a crawl.
        nested=a/'2010.03 V-3 PREFRACTIONATOR TOWER'
        bad=subprocess.run(cmd+[str(nested),str(nested),'--max-files','10'],capture_output=True,text=True,timeout=45)
        assert bad.returncode!=0 and 'overlapping' in (bad.stdout+bad.stderr).lower(),'Overlapping root not rejected'
        with connect(workspace/'thor_accumulation_workspace'/DB_NAME) as db:
            assert db.execute('SELECT COUNT(*) FROM files').fetchone()[0]==n3
        # Controlled mid-scan interruption against a DIFFERENT LOCAL fixture/database.
        interrupted_dir=base/'interrupted';interrupted_dir.mkdir()
        for i in range(45):
            (interrupted_dir/f'file_{i:03d}.txt').write_text('local test',encoding='utf-8')
        iw=base/'interrupt_work';iw.mkdir();init_db(iw/DB_NAME)
        real_scandir=os.scandir; calls=[0]
        def interrupted_scandir(path):
            calls[0]+=1
            if calls[0]==1:
                raise KeyboardInterrupt()
            return real_scandir(path)
        with mock.patch('os.scandir',side_effect=interrupted_scandir):
            result=crawl(iw,str(interrupted_dir),default_config(iw),max_files=100,max_dirs=30)
        assert result is None,'Interrupted crawl did not stop'
        with connect(iw/DB_NAME) as db:
            stat=db.execute('SELECT status FROM crawls ORDER BY started_at DESC LIMIT 1').fetchone()[0]
            assert stat=='interrupted',stat
        # Restart in a new process; it must recover and index the complete fixture.
        resumed=subprocess.run([sys.executable,str(Path(__file__).resolve()),'--workdir',str(base/'resume'),
                                'accumulation-test',str(interrupted_dir),str(interrupted_dir),'--max-files','100','--max-dirs','30'],
                               capture_output=True,text=True,timeout=60)
        assert resumed.returncode==0,'Resume process failed: '+resumed.stderr[-800:]
        with connect(base/'resume'/'thor_accumulation_workspace'/DB_NAME) as db:
            assert db.execute('SELECT COUNT(*) FROM files').fetchone()[0]==45
        # Exercise retry in the actual interrupted database rather than a new one.
        r=crawl(iw,str(interrupted_dir),default_config(iw),max_files=100,max_dirs=30)
        assert r is not None
        with connect(iw/DB_NAME) as db:
            assert db.execute('SELECT COUNT(*) FROM files').fetchone()[0]==45
            assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        for path,prior in source_snapshot.items():
            p=Path(path)
            now=(p.stat().st_size,p.stat().st_mtime_ns,hashlib.sha256(p.read_bytes()).hexdigest())
            assert now==prior,'Source fixture was modified during indexing: '+path
        result={'version':VERSION,'result':'PASS','source':'generated local fixtures only',
                'generated_files':file_count+1,'accumulation_runs':reports,
                'repeat_root_stable':True,'overlap_rejected':True,
                'interruption_resume_passed':True,'inspection_alias_correct':True,'fixture_source_bytes_and_mtime_unchanged':True,
                'seconds':round(time.monotonic()-started,2)}
        safe_output(workdir/'thor_v30_selftest.json',workdir)
        workdir.mkdir(parents=True,exist_ok=True)
        atomic_json(workdir/'thor_v30_selftest.json',result)
        print(json.dumps(result,indent=2))
        print('SELF-TEST REPORT:',workdir/'thor_v30_selftest.json')

def status(workdir):
    with connect(workdir/DB_NAME) as c:
        print("\nTHOR Indexer Status\n"+"="*60)
        for r in c.execute("""SELECT r.*,COUNT(f.file_id) files,SUM(f.observation_state='current') current
                              FROM roots r LEFT JOIN files f ON f.root_id=r.root_id GROUP BY r.root_id ORDER BY r.path"""):
            print(r["path"]);print(f"  current {r['current'] or 0:,} | historical {r['files'] or 0:,} | last crawl {r['last_crawl_at'] or 'never'}")
        for table in ("entities","aliases","relationships","evidence","review_queue","issues"):
            print(f"{table}: {c.execute('SELECT COUNT(*) n FROM '+table).fetchone()['n']:,}")

def menu(workdir,cfg):
    while True:
        print(f"""\n{APP} {VERSION}
1. Analyze / index a THOR path (full autonomous pipeline)
2. Update a previously indexed path
3. View status
4. Export combined thor_index.json
5. Settings
6. Exit""")
        x=input("Select: ").strip()
        if x in {"1","2"}:
            p=input("THOR/root path: ").strip().strip('"')
            if p:run_full(workdir,p,cfg)
        elif x=="3":status(workdir)
        elif x=="4":export_index(workdir)
        elif x=="5":print(json.dumps(cfg,indent=2))
        elif x=="6":return

def estimate_run(root,workdir,config_path=None,max_dirs=None,max_files=None,ai_calls=None,seconds=None):
    """Read-only exact census when no limits are supplied; no source file opened.

    Estimates content/AI workloads from observed extensions and an explicitly
    labeled earlier bounded end-to-end benchmark, never from a fictitious call count.
    """
    root=os.path.abspath(root)
    if not os.path.isdir(root): raise SystemExit("Root unavailable: "+root)
    if child_of(workdir,root): raise SystemExit("SAFETY STOP: workspace is inside source root")
    cfg=default_config(workdir)
    cp=Path(config_path) if config_path else workdir/CFG_NAME
    if cp.is_file():
        try: cfg=json.loads(cp.read_text(encoding='utf-8'))
        except Exception as ex: print('WARNING: configuration unreadable:',ex)
    if seconds is not None and not (5 <= seconds <= 3600):
        raise SystemExit('--seconds must be between 5 and 3600')
    started=time.monotonic()
    todo=collections.deque([(root,0)])
    seen_dirs=seen_files=errors=0
    extensions=collections.Counter();bytes_seen=0
    last_ui=started-2;last_path='';time_limit_hit=False
    file_limit_hit=dir_limit_hit=False
    print('READ-ONLY CENSUS: exact totals require walking every directory. No OCR or AI calls.',flush=True)
    if seconds is None and max_files is None and max_dirs is None:
        print('Progress shows files, completed directories and outstanding known folders; total folders are UNKNOWN until finished.',flush=True)
    def show_progress(force=False):
        nonlocal last_ui
        now=time.monotonic()
        if not force and now-last_ui<1.: return
        elapsed=max(.001,now-started)
        speed=seen_dirs/elapsed
        if seconds is None:
            label='CENSUS'; bar='[ scanning ]' if todo else '[ COMPLETE ]'
        else:
            frac=min(1.,elapsed/seconds);k=round(20*frac)
            bar='['+'#'*k+'-'*(20-k)+']';label='TIME SAMPLE'
        msg=(f'{label} {bar} {elapsed:,.0f}s | files {seen_files:,} | '
             f'dirs {seen_dirs:,} | discovered not yet visited {len(todo):,} | '
             f'{speed:.1f} dirs/s | issues {errors}')
        print('\r'+msg[:190].ljust(190),end='',flush=True)
        last_ui=now
    try:
        while todo and (max_dirs is None or seen_dirs<max_dirs) and (max_files is None or seen_files<max_files):
            if seconds is not None and time.monotonic()-started>=seconds:
                time_limit_hit=True;break
            directory,depth=todo.popleft()
            seen_dirs+=1;last_path=directory
            try:
                with os.scandir(directory) as it:
                    for entry in it:
                        if seconds is not None and time.monotonic()-started>=seconds:
                            time_limit_hit=True;todo.appendleft((directory,depth));break
                        try:
                            if is_reparse(entry):continue
                            if entry.is_dir(follow_symlinks=False):
                                todo.append((entry.path,depth+1))
                            elif entry.is_file(follow_symlinks=False):
                                seen_files+=1
                                extensions[Path(entry.name).suffix.lower() or '<none>']+=1
                                try: bytes_seen+=entry.stat(follow_symlinks=False).st_size
                                except OSError: errors+=1
                                if max_files is not None and seen_files>=max_files:break
                        except OSError:errors+=1
                        show_progress()
            except OSError as ex:
                errors+=1
                if errors<=10:print(f'\nWARNING: cannot enumerate {directory}: {ex}',flush=True)
            show_progress()
            if time_limit_hit:break
    except KeyboardInterrupt:
        print('\nCENSUS INTERRUPTED: no exact totals available; no THOR writes made.',flush=True)
        raise SystemExit(130)
    elapsed=max(.001,time.monotonic()-started)
    file_limit_hit=max_files is not None and seen_files>=max_files
    dir_limit_hit=bool(todo) and max_dirs is not None and seen_dirs>=max_dirs
    complete=not todo and not file_limit_hit and not time_limit_hit and errors==0
    show_progress(force=True);print()
    print(('EXACT CENSUS COMPLETE' if complete else 'PARTIAL CENSUS')+
          f': {seen_files:,} files, {seen_dirs:,} directories, {errors} errors, {elapsed:.1f}s.',flush=True)
    # A failed enumeration means that the counts are LOWER BOUNDS, never exact.
    # Reference is the user's 2026-10-14 isolated test: 285 files, 300 dirs, 35.09s,
    # with up to 20 high-information files parsed. It is NOT a guaranteed throughput.
    reference={'source':'THOR Engineering Dept bounded 2026-10-14 test',
               'files':285,'directories':300,'elapsed_seconds':35.0905061,
               'content_selection_cap':20}
    # Directory traversal + local content and indexing; extrapolate from reference
    # with a deliberately broad 0.5x-3x range for different NAS layouts/file types.
    scale=max(seen_dirs/max(1,reference['directories']),seen_files/max(1,reference['files']))
    reference_hours=reference['elapsed_seconds']*scale/3600
    if complete:
        full_runtime={'optimistic_hours':round(reference_hours*.5,2),
                      'reference_scaled_hours':round(reference_hours,2),
                      'conservative_hours':round(reference_hours*3,2),
                      'includes_inventory_and_bounded_selective_content':True,
                      'excludes':'OCR, bulk full-text extraction, and paid AI latency',
                      'basis':'Prior bounded test scaled by max(directory ratio,file ratio); 0.5x..3x scenario, not a measured full-run promise'}
    else:
        full_runtime={'optimistic_hours':None,'reference_scaled_hours':None,
                      'conservative_hours':None,
                      'meaning':'Full-tree totals unavailable: unfinished census or filesystem errors.'}
    ai_cfg=cfg.get('ai',{})
    budget=float(ai_cfg.get('project_budget_usd',50) or 0)
    spent=0.;db=workdir/DB_NAME
    if db.is_file():
        try:
            with connect(db) as c:
                rec=c.execute("SELECT * FROM ai_budget WHERE budget_id='project'").fetchone()
                if rec:
                    budget=float(rec['authorized_usd'])
                    spent=max(float(rec['estimated_spend_usd']),float(rec['actual_spend_usd']))
        except Exception:pass
    remaining=max(0,budget-spent)
    # This program does not submit every PDF individually. Its implemented paid
    # AI feature is ONE Stage Zero root-summary prompt per new crawl, at most,
    # using up to 20 representative files. Do not fabricate per-document calls.
    eligible_ext={'.pdf','.doc','.docx','.txt','.msg','.xls','.xlsx','.ppt','.pptx'}
    eligible=sum(n for ext,n in extensions.items() if ext in eligible_ext)
    price_in=float(ai_cfg.get('estimated_input_usd_per_million_tokens') or 0)
    price_out=float(ai_cfg.get('estimated_output_usd_per_million_tokens') or 0)
    max_chars=max(0,int(ai_cfg.get('max_input_chars_per_call',50000)))
    # Bytes-plus-overhead is a deliberately conservative token ceiling for
    # an unknown prompt. It is NOT a provider quote or guaranteed billing cap.
    conservative_prompt_tokens=max_chars+2048
    max_output_tokens=3000
    estimated_ceiling=(conservative_prompt_tokens*price_in+max_output_tokens*price_out)/1e6 if price_in>0 and price_out>0 else None
    ai_policy={
        'actual_implemented_policy':'ONE optional Stage Zero summary request per crawled root, containing snippets from at most 20 files; no per-document AI requests',
        'exact_individual_document_ai_calls_per_root':0,
        'maximum_stage_zero_ai_calls_per_new_root':1,
        'maximum_representative_files_in_one_prompt':20,
        'eligible_by_extension_but_not_scheduled_for_individual_ai':eligible,
        'model_configured':ai_cfg.get('model'),
        'ai_enabled_in_setup':bool(ai_cfg.get('enabled')),
        'paid_calls_this_estimate':0,
        'cost_without_explicit_paid_opt_in_usd':0,
        'input_price_per_million_configured_usd':price_in,
        'output_price_per_million_configured_usd':price_out,
        'hypothetical_one_call_conservative_cost_usd':round(estimated_ceiling,4) if estimated_ceiling is not None else None,
        'cost_limit_note':'This is a conservative configured-rate scenario, not an exact invoice or hard billing guarantee; actual tokens/model prices may differ.',
        'budget_usd':budget,'previous_spend_usd':spent,'remaining_budget_usd':remaining,
        'why_exact_cost_unknown':'The prompt is built after representative files have been selected and parsed, and output usage is unknown until an API response exists.'
    }
    return {'mode':'read_only_exact_census' if complete else 'read_only_partial_census',
            'generator_version':VERSION,'root':root,'generated_at':utcnow(),
            'census':{'exact':complete,'files':seen_files if complete else None,
                      'directories':seen_dirs if complete else None,
                      'observed_files_lower_bound':seen_files,
                      'observed_directories_lower_bound':seen_dirs,
                      'errors':errors,'remaining_discovered_directories':len(todo),
                      'seconds':round(elapsed,2),'file_extensions':dict(extensions),
                      'bytes':bytes_seen,'limits':{'seconds':seconds,'max_files':max_files,'max_dirs':max_dirs}},
            'benchmark_reference':reference,
            'full_ingestion_estimate':full_runtime,
            'ai_cost_estimate':ai_policy,
            'limitations':['Exact totals require traversal of the entire accessible tree with zero enumeration errors.',
               'No reliable percent-complete indicator is possible before total directories are known.',
               'Full-ingestion runtime projections use a prior different-root benchmark, not a full-run measurement.',
               'Network operations may block; Ctrl+C stops safely between operations.',
               'No OCR or AI performed, so their execution time is not included.'],
            'safety':'Only network metadata was enumerated/read. No network source file opened or modified; reports written locally.'}


def ai_execution_plan(workdir):
    """Report what the implemented AI policy actually does: one stage-zero
    prompt per root, incorporating representative file snippets, NOT one
    separate model call for every eligible PDF. No THOR reads or API calls.

    The content plan is reconstructed from indexed excerpts, so final remote
    tokenizer usage is necessarily an estimate; actual output is unknown.
    """
    db=workdir/DB_NAME
    if not db.is_file():raise SystemExit('No local index DB yet. Complete crawl before ai-plan.')
    cfg_path=workdir/CFG_NAME
    cfg=json.loads(cfg_path.read_text(encoding='utf-8')) if cfg_path.is_file() else default_config(workdir)
    ai=cfg['ai'];roots=[];total_candidates=0;max_in=0;max_out=0
    if ai.get('provider')=='anthropic' and ai.get('model') in GUARD_PROVIDER_FLOOR:
        rate_in,rate_out=_guard_prices(ai)
    else:
        rate_in=0.0;rate_out=0.0
    with connect(db) as c:
        for root in c.execute('SELECT * FROM roots').fetchall():
            rid=root['root_id']
            pats=[dict(x) for x in c.execute('SELECT pattern_type,value,count,example FROM patterns WHERE root_id=? ORDER BY count DESC LIMIT 180',(rid,))]
            # Use the exact indexed text sections and selection criteria: 20 on initial root,
            # 10 on updates. Files already parsed may be re-used without opening THOR.
            samples=c.execute("""SELECT path,filename_class,content_method,information_value,content_excerpt
                                   FROM files WHERE root_id=? AND parsed_at IS NOT NULL
                                   ORDER BY inspection_value DESC,size_bytes ASC LIMIT 20""",(rid,)).fetchall()
            reps=[{'path':r['path'],'class':r['filename_class'],'method':r['content_method'],
                   'information_value':r['information_value'], 'text':(r['content_excerpt'] or '')[:3500]} for r in samples]
            prompt=json.dumps({'root':root['path'],'patterns':pats,'representative_files':reps},ensure_ascii=False)
            prompt+="""\nReturn JSON with keys:
                directory_roles[], identifier_classes[], alias_hypotheses[], bridge_identifier_classes[],
                document_expectations[], era_conventions[], unresolved_questions[], recommended_sampling[].
                Each item must include confidence and evidence/sample references where applicable."""
            submitted=prompt[:int(ai.get('max_input_chars_per_call',50000))]
            in_chars=len(AI_SYSTEM)+len(submitted)
            # This token rule matches the current indexer's own _estimate_cost approximation.
            tokens=max(1,in_chars//4)
            output_ceiling=3000
            cost_upper=(tokens*rate_in+output_ceiling*rate_out)/1e6 if rate_in>0 and rate_out>0 else None
            roots.append({'root':root['path'],'stage_zero_ai_calls_planned_if_opted_in':1,
                          'individual_document_ai_calls_planned':0,
                          'representative_files_in_call':len(reps),
                          'representative_paths':[r['path'] for r in reps],
                          'estimated_input_tokens':tokens,'max_output_tokens':output_ceiling,
                          'estimated_max_cost_usd':round(cost_upper,6) if cost_upper is not None else None,
                          'note':'Estimated prompt tokens; provider tokenizer/caching may differ. Model output may be shorter.'})
            total_candidates+=1;max_in+=tokens;max_out+=output_ceiling
        present=c.execute("SELECT COUNT(*) FROM files WHERE observation_state='current'").fetchone()[0]
        eligible=c.execute("SELECT COUNT(*) FROM files WHERE observation_state='current' AND extension IN ('.pdf','.doc','.docx','.xlsx','.xls','.xlsm','.txt','.csv','.xml')").fetchone()[0]
        ledger=c.execute("SELECT * FROM ai_budget WHERE budget_id='project'").fetchone()
        budget=dict(ledger) if ledger else {}
    max_cost=((max_in*rate_in+max_out*rate_out)/1e6) if rate_in>0 and rate_out>0 else None
    return {'generator_version':VERSION,'offline':True,'paid_calls_made':0,
            'files_in_current_index':present,'document_format_candidates':eligible,
            'actual_ai_policy':'at most one stage_zero_repository_convention_learning call per root per crawl; representative snippets in one prompt; no per-document API calls',
            'AI_enabled_in_saved_setup':bool(ai.get('enabled')),'API_calls_if_explicitly_opted_in':total_candidates,
            'individual_documents_sent_as_separate_calls':0,
            'representative_documents_embedded_in_prompts':sum(x['representative_files_in_call'] for x in roots),
            'estimated_total_input_tokens':max_in,'max_total_output_tokens':max_out,
            'estimated_upper_cost_usd':round(max_cost,4) if max_cost is not None else None,
            'pricing_per_million_usd':{'input':rate_in,'output':rate_out},'cost_is_exact':False,
            'remaining_budget_usd':float(budget.get('authorized_usd',0))-max(float(budget.get('estimated_spend_usd',0)),float(budget.get('actual_spend_usd',0))),
            'roots':roots,'guarded_queue':ai_guard_status(workdir),'warning':'This plan shows representative stage-zero tasks, not bulk document enrichment; the paid queue uses conservative reservations and requires provider-side billing limits.'}

def benchmark_plan_offline(workdir, index_json, max_workers=1, memory_mb=512, max_pages_per_file=30,
                           ocr_seconds_per_page=2.0, ai_input_tokens=4000, ai_output_tokens=800,
                           input_usd_per_million=0.0, output_usd_per_million=0.0):
    """Planning only. No file/document opening, OCR, AI, or NAS access.

    The existing reviewed JSON is a local index artifact. Resource and price inputs
    are hypothetical user-selected planning assumptions, not measured OCR timings.
    """
    if not 1 <= max_workers <= 2: raise SystemExit('BENCHMARK STOP: workers must be 1 or 2')
    if not 256 <= memory_mb <= 2048: raise SystemExit('BENCHMARK STOP: memory cap must be 256..2048 MB')
    if not 1 <= max_pages_per_file <= 100: raise SystemExit('BENCHMARK STOP: pages/file must be 1..100')
    if not .1 <= ocr_seconds_per_page <= 120: raise SystemExit('BENCHMARK STOP: seconds/page must be 0.1..120')
    if min(ai_input_tokens,ai_output_tokens,input_usd_per_million,output_usd_per_million)<0:
        raise SystemExit('BENCHMARK STOP: negative pricing/tokens not allowed')
    src=safe_output(index_json,workdir)
    if not src.is_file(): raise SystemExit('BENCHMARK STOP: reviewed JSON missing: '+str(src))
    # Keep this planning command from loading arbitrarily large JSON into a laptop.
    if src.stat().st_size>250*1024*1024:
        raise SystemExit('BENCHMARK STOP: JSON exceeds 250 MB; use a smaller export')
    with src.open('r',encoding='utf-8') as fh: obj=json.load(fh)
    stats=obj.get('statistics',{})
    qr=obj.get('quality_report',{})
    files=int(stats.get('files_current',0))
    # 'unparsed_pdf_files' is a category for prioritization, NOT a guarantee OCR is required.
    candidates=int(qr.get('unparsed_pdf_files',0))
    if not candidates and isinstance(qr.get('unparsed_pdf_files'),list):candidates=len(qr['unparsed_pdf_files'])
    # Conservative upper-bound assumes every candidate has the capped number of pages.
    upper_pages=candidates*max_pages_per_file
    est_ocr_seconds=upper_pages*ocr_seconds_per_page/max_workers
    ai_per_call=(ai_input_tokens*input_usd_per_million+ai_output_tokens*output_usd_per_million)/1e6
    return {
      'generator_version':VERSION,'mode':'offline_planning_only','read_only':True,
      'index_path':str(src),'files_indexed':files,'pdfs_without_extracted_text':candidates,
      'classification_warning':'Unparsed includes skipped PDFs; it does not establish that OCR is necessary.',
      'operating_limits':{'ocr_workers':max_workers,'memory_budget_mb':memory_mb,
           'max_pages_per_document':max_pages_per_file,'no_paid_ai':True,'ocr_executed':False,'nas_accessed':False},
      'ocr_scenario':{'assumed_seconds_per_page':ocr_seconds_per_page,
           'upper_scenario_pages':upper_pages,'upper_scenario_hours':round(est_ocr_seconds/3600,3),
           'note':'Illustrative ceiling, not measured OCR throughput; actual page counts unknown.'},
      'ai_scenario':{'hypothetical_calls':candidates,'input_tokens_per_call':ai_input_tokens,
           'output_tokens_per_call':ai_output_tokens,'input_price_per_million':input_usd_per_million,
           'output_price_per_million':output_usd_per_million,
           'estimated_usd_if_one_call_per_candidate':round(ai_per_call*candidates,4) if input_usd_per_million>0 and output_usd_per_million>0 else None,
           'note':'User-supplied rates only; zero means unknown/unconfigured, not free.'},
      'recommendation':'Before real OCR, perform a separate 5-10 document benchmark using local scratch copies, one worker, process memory limits, no paid AI, and stop-on-pressure checks.'
    }

def parser():
    """Operational CLI reference. All examples use Windows UNC roots."""
    fmt=argparse.RawDescriptionHelpFormatter
    p=argparse.ArgumentParser(
        prog="thor_indexer.py", formatter_class=fmt,
        description=("THOR Indexer — read-only refinery document inventory and knowledge index.\n"
                     'Use a Windows UNC source such as \\\\thor\\maintenance; no drive mapping is required.'),
        epilog=(
            "QUICK START (Windows PowerShell / Command Prompt)\n"
            "  python thor_indexer.py --help\n"
            "  python thor_indexer.py estimate \"\\\\thor\\maintenance\"\n"
            "  python thor_indexer.py crawl \"\\\\thor\\maintenance\"\n"
            "  python thor_indexer.py setup\n"
            "  python thor_indexer.py status\n"
            "  python thor_indexer.py export\n"
            "  python thor_indexer.py run \"\\\\thor\\maintenance\" \"\\\\thor\\engineering\" --iterations 3 --export-final\n"
            "  python thor_indexer.py refine --iterations 2\n"
            "  python thor_indexer.py test \"\\\\thor\\maintenance\"\n\n"
            "COMMAND REFERENCE\n"
            "  setup      Reopen the interactive configuration wizard at any time.\n"
            "             Preserves all existing knowledge and accumulated AI spend.\n"
            "  estimate   Read-only reconnaissance and projected workload/AI cost.\n"
            "             By default counts the whole selected directory tree;\n"
            "             network errors can prevent a complete census.\n"
            "             No AI API calls and no production DB/JSON writes.\n"
            "  crawl      Inventory selected source; selectively inspect content, learn\n"
            "             identifiers/relationships, then save cumulative knowledge (export separately).\n"
            "             No file-count cap by default. Repeated runs update history.\n"
            "  test       Isolated, limited integration run. Defaults: 100 files,\n"
            "             30 directories; paid AI off unless explicitly enabled.\n"
            "  status     Print registered roots and cumulative DB counts.\n"
            "  export     Rebuild the combined JSON from the existing local DB.\n"
            "  run        Crawl several roots; refine N passes; optionally export.\n"
            "  refine     Repeat local graph analysis without re-crawling THOR.\n\n"
            "PERSISTENT LOCAL FILES (default: ~/ThorIndexer)\n"
            "  thor_knowledge.db    Cumulative SQLite database and AI spending ledger\n"
            "  thor_index.json      Latest production export for the web application\n"
            "  thor_config.json     Local settings; never store API secrets here\n"
            "  thor_checkpoint.json Recovery/progress checkpoint\n"
            "  thor_crawl.log       Operational log\n"
            "  thor_test_workspace/ Separate test DB, logs, ledger and JSON\n"
            "    thor_index_test.json  Test-only export; not production\n\n"
            "AI AND COST CONTROLS\n"
            "  Setup prompts for the actual API key and saves it encrypted with Windows DPAPI.\n"
            "  The key is never saved in the database, settings JSON, logs or export.\n"
            "  A cumulative project budget is enforced by conservative pre-call reservations.\n"
            "  IMPORTANT: only provider-controlled spend limits can constrain provider billing.\n"
            "  Estimates are projections, not provider invoices.\n  Paid requests are ONLY made by ai-run after explicit approval.\n  Failed/time-out calls keep their reservation until reconciled.\n\n"
            "SAFETY / LIMITATIONS\n"
            "  Source THOR directories are scanned using current Windows access\n"
            "  permissions. The crawler is designed not to write to the source.\n"
            "  Use a writable LOCAL --workdir, never a THOR folder.\n"
            "  Network interruptions/ACL denials can reduce coverage.\n"
            "  This release has not been validated on your actual THOR server.\n\n"
            "For every flag: python thor_indexer.py COMMAND --help"
        ))
    p.add_argument("--workdir", default=str(Path.home()/"ThorIndexer"), metavar="LOCAL_PATH",
                   help="Persistent local workspace (default: ~/ThorIndexer); place BEFORE subcommand")
    s=p.add_subparsers(dest="cmd",title="commands",metavar="{self-test,setup,crawl,test,accumulation-test,estimate,run,refine,status,export}")
    bp=s.add_parser('benchmark-plan',help='Offline OCR/AI workload scenarios from local reviewed JSON (no OCR, no AI, no NAS)')
    bp.add_argument('--index',default=None,help='Existing reviewed JSON under --workdir')
    bp.add_argument('--workers',type=int,default=1,help='Scenario workers (1-2); no workers are started')
    bp.add_argument('--memory-mb',type=int,default=512,help='Planned memory budget 256-2048 MB')
    bp.add_argument('--max-pages',type=int,default=30,help='Assumed max OCR pages per candidate')
    bp.add_argument('--seconds-per-page',type=float,default=2.,help='Hypothetical OCR seconds/page, not measured')
    bp.add_argument('--input-price',type=float,default=0.,help='User-supplied USD per million input tokens')
    bp.add_argument('--output-price',type=float,default=0.,help='User-supplied USD per million output tokens')
    s.add_parser('ai-prepare',help='Queue existing index AI tasks locally; zero paid calls, no THOR rescan')
    s.add_parser('ai-status',help='Read saved $20 budget, charges, reservations and pending work (no paid calls)')
    s.add_parser('ai-key-check',help='Verify key is retrievable locally without displaying it or making API calls')
    air=s.add_parser('ai-run',help='Execute saved AI queue with fail-closed budget reservations; never rescans THOR')
    air.add_argument('--allow-paid-ai',action='store_true',help='Explicitly authorize billed requests')
    air.add_argument('--provider-cap-confirmed',action='store_true',
      help='You have set Anthropic Console provider cap and disabled prepaid auto-reload')
    rec=s.add_parser('ai-reconcile',help='Manually reconcile potentially billed timeout before any paid retry')
    rec.add_argument('job_id',help='Local saved job ID from ai-status or log')
    rec.add_argument('--billed-usd',type=float,required=True,
      help='Amount verified against provider usage after accounting for reporting delay')
    rec.add_argument('--confirmed-on-console',action='store_true',help='Confirm billed amount checked in provider')
    rec.add_argument('--orphaned-inflight-confirmed',action='store_true',
      help='Only when a crashed runner has definitely stopped and no paid API call is still processing')
    aipl=s.add_parser('ai-plan',help='Offline AI execution plan and cost bound from actual index; NO API calls')
    aipl.add_argument('--report',help='Local output plan JSON (default: ai_execution_plan.json)')
    s.add_parser('audit-index',help='Offline read-only audit of accumulated test SQLite; no NAS access')
    st=s.add_parser('self-test',formatter_class=fmt,help='Offline local-only v3.0 accumulation, overlap, interruption and scale regression')
    st.add_argument('--files',type=int,default=1100,help='Number of synthetic test files, 1000-5000')
    s.add_parser("setup",formatter_class=fmt,help="Reopen setup wizard without resetting knowledge or AI spending",
                 description="Interactively edit provider, model, securely stored Windows API key, token pricing and lifetime budget. Existing database and ledger are preserved.")
    c=s.add_parser("crawl",formatter_class=fmt,
                   help="Full source crawl and cumulative knowledge/export update",
                   description="Crawl the supplied UNC or local root without an arbitrary file limit. Writes only to local workspace.",
                   epilog='Example: python thor_indexer.py crawl "\\\\thor\\maintenance"')
    c.add_argument("root",help=r'Source root, e.g. \\thor\maintenance')
    c.add_argument('--workers',type=int,choices=(1,2,3,4),default=2,
                   help='Bounded concurrent metadata readers (default 2; never more than 4)')
    c.add_argument('--census',help='Existing exact, local census JSON; enables measured baseline progress')
    c.add_argument('--allow-paid-ai',action='store_true',
                   help='EXPLICIT opt-in to paid AI (otherwise disabled regardless of setup)')
    t=s.add_parser("test",formatter_class=fmt,
                   help="Isolated integration test; paid AI disabled by default",
                   description="Runs in thor_test_workspace; never merges test discoveries into production.",
                   epilog='Example: python thor_indexer.py test "\\\\thor\\maintenance"')
    t.add_argument("root",help=r'Source root, e.g. \\thor\maintenance')
    t.add_argument("--max-files",type=int,default=100,metavar="N",help="TEST ONLY: stop after N files (default: 100)")
    t.add_argument("--max-dirs",type=int,default=30,metavar="N",help="TEST ONLY: stop after N directories (default: 30)")
    t.add_argument("--allow-paid-ai",action="store_true",help="Opt in to provider-billed AI calls during test (off by default)")
    ac=s.add_parser('accumulation-test',formatter_class=fmt,
        help='Bounded multi-root and repeat-root accumulation test (isolated local SQLite, no AI)',
        description='Runs multiple limited crawls into one isolated cumulative workspace. Identical roots can be repeated; nested roots are rejected.')
    ac.add_argument('roots',nargs='+',help='Two or more source directories; repeat a root to test idempotence')
    ac.add_argument('--max-files',type=int,default=100)
    ac.add_argument('--max-dirs',type=int,default=30)
    q=s.add_parser("estimate",formatter_class=fmt,
                   help="Exact read-only file/directory census and time/AI-cost scenarios; no production writes",
                   description="Default: enumerate full tree to obtain exact totals (if no errors). Optional bounds produce partial counts only.",
                   epilog='Example: python thor_indexer.py estimate "\\\\thor\\maintenance"')
    q.add_argument("root",help=r'Source root, e.g. \\thor\maintenance')
    q.add_argument("--max-files",type=int,default=None,metavar="N",help="OPTIONAL ceiling; default is full root (no limit)")
    q.add_argument("--max-dirs",type=int,default=None,metavar="N",help="OPTIONAL ceiling; default is full root (no limit)")
    q.add_argument("--ai-calls",type=int,default=None,metavar="N",help="Optional override for AI calls per cost scenario (no API calls made)")
    q.add_argument("--seconds",type=float,default=None,metavar="N",help="Stop sample after N seconds (5-3600); display a live TIME progress bar. Best effort for remote calls")
    q.add_argument("--report",metavar="LOCAL_JSON",help="Optional local estimate report path; never source THOR")
    run=s.add_parser('run',formatter_class=fmt,help='Crawl multiple UNC roots, refine locally, optionally export',
        description='Crawl each supplied root into the SAME persistent knowledge DB. Additional iterations refine locally without repeating network traversal.')
    run.add_argument('roots',nargs='+',help=r'One or more UNC roots, e.g. \\thor\maintenance \\thor\engineering')
    run.add_argument('--iterations',type=int,default=1,help='Total analysis passes; first crawls roots, remaining passes refine local DB (default: 1)')
    run.add_argument('--export-final',action='store_true',help='Validate and export combined JSON only after the workflow finishes')
    refine=s.add_parser('refine',formatter_class=fmt,help='Iteratively refine all accumulated roots without rescanning THOR')
    refine.add_argument('--iterations',type=int,default=1,help='Number of local refinement passes (default: 1)')
    s.add_parser("status",formatter_class=fmt,help="Show registered roots and database statistics",
                 description="Reads cumulative local SQLite state; no THOR traversal.")
    e=s.add_parser("export",formatter_class=fmt,help="Regenerate combined production JSON index",
                   description="Export local cumulative knowledge; source THOR paths are never export destinations.")
    e.add_argument("--output",metavar="LOCAL_JSON",help="Override local JSON destination (default: thor_index.json in workspace)")
    s.add_parser('export-reviewed',formatter_class=fmt,
        help='Read-only export of existing accumulation DB with relationship review labels; no NAS access')
    return p



def audit_existing_index(workdir):
    """Offline, non-mutating quality audit of an existing test workspace.

    SQLite is opened in immutable READ-ONLY mode; source NAS is never accessed.
    Report goes to the supplied *local* --workdir, outside the test DB.
    """
    from urllib.parse import quote
    dbpath=workdir/'thor_accumulation_workspace'/DB_NAME
    if not dbpath.is_file():
        raise SystemExit('AUDIT STOP: cannot find existing accumulation database: '+str(dbpath))
    report_path=safe_output(workdir/'thor_round3_audit.json',workdir)
    uri='file:'+quote(str(dbpath.resolve()).replace(chr(92),'/'),safe='/:')+'?mode=ro&immutable=1'
    db=sqlite3.connect(uri,uri=True)
    db.row_factory=sqlite3.Row
    try:
        integrity=db.execute('PRAGMA integrity_check').fetchone()[0]
        total=db.execute('SELECT COUNT(*) FROM files').fetchone()[0]
        distinct=db.execute('SELECT COUNT(DISTINCT file_id) FROM files').fetchone()[0]
        roots=[dict(x) for x in db.execute('SELECT root_id,path,last_crawl_at FROM roots ORDER BY path')]
        rels=[dict(x) for x in db.execute('SELECT rel_id,rel_type,confidence,status,positive_score FROM relationships')]
        weak=[r for r in rels if r['rel_type']=='CO_OCCURS_OR_BRIDGES' and r['confidence']<=0.5]
        raw=[dict(x) for x in db.execute("SELECT entity_id,canonical_name FROM entities WHERE entity_type='equipment'")]
        from collections import defaultdict
        groups=defaultdict(list)
        for r in raw:
            match=re.fullmatch(r'(\d{4})\.(\d{1,3})',r['canonical_name'])
            if match:
                canonical=match.group(1)+'.'+(match.group(2).zfill(2) if len(match.group(2))<=2 else match.group(2))
                groups[canonical].append(r)
        variants=[{'comparison_key':key,'records':rows,'action':'review_only_no_auto_merge'}
                  for key,rows in sorted(groups.items()) if len(set(r['canonical_name'] for r in rows))>1]
        crawl=[dict(x) for x in db.execute('SELECT root_id,status,started_at,completed_at FROM crawls ORDER BY started_at')]
        report={
            'audit_version':'3.0.2','mode':'offline_sqlite_read_only',
            'source':'existing local accumulation database only (no NAS access)',
            'sqlite_integrity':integrity,
            'files_total':total,'file_ids_unique':total==distinct,
            'roots':roots,'crawls':crawl,
            'relationships_total':len(rels),
            'cooccurrence_candidates':sum(r['rel_type']=='CO_OCCURS_OR_BRIDGES' for r in rels),
            'weak_cooccurrence_candidates':len(weak),
            'weak_cooccurrence_fraction':round(len(weak)/max(1,len(rels)),4),
            'recommendation':'Treat all CO_OCCURS_OR_BRIDGES links as unconfirmed retrieval clues; never verified equipment relationships',
            'identifier_format_candidates':variants,
            'identifier_resolution_rule':'Preserve source spellings, do not merge equipment automatically',
            'read_only_qualification':'This audits the local DB; it does not prove NAS source metadata or permissions were unchanged',
        }
    finally:
        db.close()
    atomic_json(report_path,report)
    print(json.dumps({k:v for k,v in report.items() if k not in ('roots','crawls')},indent=2))
    print('AUDIT REPORT:',report_path)

def main():
    a=parser().parse_args();wd=safe_local_workspace(a.workdir)
    if a.cmd=='benchmark-plan':
        src=a.index or str(wd/'thor_index_reviewed.json')
        report=benchmark_plan_offline(wd,src,max_workers=a.workers,memory_mb=a.memory_mb,
              max_pages_per_file=a.max_pages,ocr_seconds_per_page=a.seconds_per_page,
              input_usd_per_million=a.input_price,output_usd_per_million=a.output_price)
        dest=safe_output(wd/'thor_benchmark_plan.json',wd)
        atomic_json(dest,report)
        print(json.dumps(report,indent=2))
        print('OFFLINE BENCHMARK PLAN:',dest)
        return
    if a.cmd=="export-reviewed":
        indexdir=wd/'thor_accumulation_workspace'
        result=export_index(indexdir,wd/'thor_index_reviewed.json',read_only=True,output_workspace=wd)
        print('REVIEWED EXPORT:',result)
        return
    if a.cmd=="audit-index":
        audit_existing_index(wd)
        return
    if a.cmd=="self-test":
        self_test(wd,a.files)
        return
    if a.cmd=='ai-key-check':
        if not (wd/CFG_NAME).is_file():
            raise SystemExit('KEY CHECK STOP: no saved THOR configuration')
        cfg=json.loads((wd/CFG_NAME).read_text(encoding='utf-8'))
        try:
            key,source=_get_ai_key(wd,cfg.get('ai',{}))
        except Exception as error:
            raise SystemExit(f'KEY CHECK FAILED: {error}') from None
        if not key:
            print('KEY CHECK: MISSING. Run setup, save the actual API key, then APPLY.')
        else:
            print('KEY CHECK: READY ('+source+'). Secret not displayed; zero API calls.')
        return
    if a.cmd in ('ai-prepare','ai-status','ai-run','ai-reconcile'):
        if not (wd/DB_NAME).is_file():raise SystemExit('No local THOR index database in workdir')
        init_db(wd/DB_NAME)
        if a.cmd=='ai-status':
            print(json.dumps(ai_guard_status(wd),indent=2));return
        if a.cmd=='ai-reconcile':
            print(json.dumps(ai_reconcile(wd,a.job_id,a.billed_usd,a.confirmed_on_console,a.orphaned_inflight_confirmed),indent=2));return
        cfg=setup(wd)
        if cfg is None:return
        if a.cmd=='ai-prepare':
            print(json.dumps(ai_prepare_offline(wd,cfg),indent=2));return
        if a.cmd=='ai-run':
            if a.allow_paid_ai and a.provider_cap_confirmed:
                cfg=_align_explicit_opus5_choice(wd,cfg)
            ai_run_guarded(wd,cfg,a.allow_paid_ai,a.provider_cap_confirmed);return
    if a.cmd=='ai-plan':
        target=safe_output(a.report if a.report else wd/'ai_execution_plan.json',wd)
        result=ai_execution_plan(wd)
        atomic_json(target,result)
        print(json.dumps(result,indent=2))
        print('AI PLAN (NO API CALLS):',target)
        return
    if a.cmd=="estimate":
        if (a.max_files is not None and a.max_files<1) or (a.max_dirs is not None and a.max_dirs<1) or (a.ai_calls is not None and a.ai_calls<0):
            raise SystemExit("Estimate limits must be positive; AI calls must be nonnegative")
        if a.report: safe_output(a.report,wd)
        if a.report and child_of(a.report,a.root):
            raise SystemExit("SAFETY STOP: estimate report destination is inside THOR root")
        report=estimate_run(a.root,wd,max_dirs=a.max_dirs,max_files=a.max_files,ai_calls=a.ai_calls,seconds=a.seconds)
        print(json.dumps(report,indent=2))
        if a.report:
            atomic_json(Path(a.report).expanduser(),report)
            print("Estimate saved:",a.report)
        return
    if a.cmd=='accumulation-test':
        accumulation_test(wd,a.roots,a.max_files,a.max_dirs)
        return
    if a.cmd=="test":
        if a.max_files < 1 or a.max_dirs < 1: raise SystemExit("Test limits must be positive")
        # Completely independent workspace, database, ledger, checkpoints, and logs.
        # Never invoke setup() against the production workspace in test mode.
        twd=wd/"thor_test_workspace"
        if child_of(twd,a.root): raise SystemExit("SAFETY STOP: test workspace inside source root")
        twd.mkdir(parents=True,exist_ok=True)
        cfg_path=wd/CFG_NAME
        cfg=json.loads(cfg_path.read_text(encoding="utf-8")) if cfg_path.is_file() else default_config(twd)
        cfg["ai"]["enabled"]=bool(a.allow_paid_ai and cfg["ai"].get("enabled"))
        # Paid tests are charged externally by provider and not against production ledger.
        # Explicit opt-in is required; do not silently assume zero-cost.
        atomic_json(twd/CFG_NAME,cfg)
        init_db(twd/DB_NAME)
        with connect(twd/DB_NAME) as db:
            db.execute("UPDATE ai_budget SET authorized_usd=?,updated_at=? WHERE budget_id='project'",
                       (float(cfg['ai'].get('project_budget_usd',0)),utcnow()))
        logging.basicConfig(filename=twd/LOG_NAME,level=logging.INFO)
        print(f"ISOLATED TEST: {a.max_files} files / {a.max_dirs} dirs maximum; paid AI {'ENABLED' if cfg['ai']['enabled'] else 'DISABLED'}")
        run_full(twd,a.root,cfg,max_files=a.max_files,max_dirs=a.max_dirs,test_mode=True)
        with connect(twd/DB_NAME) as db:
            integrity=db.execute("PRAGMA integrity_check").fetchone()[0]
            assert integrity=="ok",integrity
        exported=twd/"thor_index_test.json"
        with exported.open(encoding="utf-8") as f: obj=json.load(f)
        assert obj["statistics"]["files_current"]<=a.max_files
        assert all(0<=r["confidence"]<=1 for r in obj["entities"])
        print("TEST VALIDATED: isolated DB integrity, export JSON, file limit and confidence range")
        print(f"TEST OUTPUT: {exported}")
        return
    if a.cmd=="setup":
        reconfigure(wd)
        return
    cfg=setup(wd)
    if cfg is None:return
    if a.cmd=='crawl':
        import shutil
        free=shutil.disk_usage(wd).free
        print(f'LOCAL DISK FREE: {free/(1024**3):.1f} GiB. Source data is NOT copied.',flush=True)
        if free<5*1024**3:raise SystemExit('LOCAL DISK SAFETY STOP: at least 5 GiB free space needed for a large index/export.')
        if free<10*1024**3:print('WARNING: under 10 GiB free; final large JSON/SQLite may exhaust space.',flush=True)
    if a.cmd=="crawl":
        # Setup is not authorization to spend. A separate command flag is necessary.
        cfg['ai']['enabled']=bool(a.allow_paid_ai and cfg['ai'].get('enabled'))
        print('PAID AI: no calls during crawl (tasks are queued locally). Run ai-run explicitly later.',flush=True)
        cfg['ai']['enabled']=False
        _lower_process_priority_for_workstation()
        run_full(wd,a.root,cfg,workers=a.workers,census=a.census,auto_export=True)
    elif a.cmd=="run":
        # Never authorize provider charges through the multi-root shortcut.
        cfg['ai']['enabled']=False
        print('MULTI-ROOT RUN: paid AI disabled ($0 API calls)',flush=True)
        if a.iterations<1:raise SystemExit("--iterations must be >= 1")
        run_workflow(wd,a.roots,cfg,a.iterations,a.export_final)
    elif a.cmd=="refine":
        if a.iterations<1:raise SystemExit("--iterations must be >= 1")
        refine_knowledge(wd,a.iterations)
    elif a.cmd=="status":status(wd)
    elif a.cmd=="export":
        if a.output:
            safe_output(a.output,wd)
            with connect(wd/DB_NAME) as db:
                for root in db.execute('SELECT path FROM roots'):
                    if child_of(a.output,root['path']):
                        raise SystemExit('SAFETY STOP: export destination is inside an indexed THOR root')
        export_index(wd,a.output)
    else:
        cfg['ai']['enabled']=False
        menu(wd,cfg)

if __name__=="__main__":main()
