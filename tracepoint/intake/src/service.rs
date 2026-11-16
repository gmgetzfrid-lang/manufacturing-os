//! The intake service: watches the drop folder, keeps the queue moving,
//! files finished scans and answers the window's commands.
//!
//! Layout of the scan drive (root = the drop folder, e.g. E:\Digital Project):
//!   <root>\*.pdf                      scans waiting to be picked up
//!   <root>\2000 - CRUDE UNIT\...       finished, organised folders (copy these)
//!   <root>\MASTER INDEX.xlsx
//!   <root>\_ORIGINAL SCANS\<date>\     every scan exactly as it was dropped in
//!   <root>\_INTAKE DATA\               ledger and working files

use crate::analyze::{self, Filing};
use crate::claude;
use crate::ocr::Ocr;
use crate::pages::{self, PageInfo};
use crate::registry::Registry;
use crate::spec::{self, EquipNo};
use crate::store::{Doc, Store};
use crate::util;
use pdfium_render::prelude::Pdfium;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const ORIGINALS: &str = "_ORIGINAL SCANS";
pub const DATA: &str = "_INTAKE DATA";

pub trait Platform: Send + Sync {
    fn open_path(&self, p: &Path) -> Result<(), String>;
    fn reveal(&self, p: &Path) -> Result<(), String>;
    fn pick_folder(&self, title: &str) -> Option<PathBuf>;
    fn emit(&self, event: &str, payload: Value);
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// The drop folder; organised output is written inside it.
    pub root: String,
    /// Existing network folders whose names are reused (read only).
    pub references: Vec<String>,
    pub model: String,
    pub author: String,
    pub parallel: u32,
    pub key_sealed: String,
    pub paused: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { root: r"E:\Digital Project".into(), references: vec![], model: claude::DEFAULT_MODEL.into(), author: "Kern Energy".into(), parallel: 2, key_sealed: String::new(), paused: false }
    }
}

#[derive(Debug)]
pub struct CmdError {
    pub code: u16,
    pub message: String,
}

fn bad(m: impl Into<String>) -> CmdError {
    CmdError { code: 400, message: m.into() }
}

impl From<rusqlite::Error> for CmdError {
    fn from(e: rusqlite::Error) -> Self {
        CmdError { code: 500, message: format!("Ledger: {e}") }
    }
}

type R = Result<Value, CmdError>;

pub struct Service {
    pub local: PathBuf,
    platform: Box<dyn Platform>,
    settings: Mutex<Settings>,
    store: Mutex<Option<Store>>,
    store_root: Mutex<String>,
    registry: RwLock<Registry>,
    registry_state: Mutex<String>,
    pdfium: Mutex<Option<Arc<Pdfium>>>,
    pdfium_error: Mutex<String>,
    ocr: Mutex<Option<Box<dyn Ocr>>>,
    has_ocr: AtomicBool,
    ocr_checked: AtomicBool,
    backoff_until: Mutex<Option<Instant>>,
    refs_missing: Mutex<Vec<String>>,
    running: Mutex<HashMap<i64, Arc<AtomicBool>>>,
    filing_lock: Mutex<()>,
    index_dirty: AtomicBool,
    index_failed: Mutex<Vec<String>>,
    notice: Mutex<String>,
    watch_seen: Mutex<HashMap<PathBuf, (u64, std::time::SystemTime, Instant)>>,
    last_emit: Mutex<Instant>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn rel_to_path(root: &Path, rel: &str) -> PathBuf {
    let mut p = root.to_path_buf();
    for part in rel.split('/') {
        if !part.is_empty() {
            p.push(part);
        }
    }
    p
}

/// Where a scan-drive relative path sits under a reference (network)
/// folder: the reference is either the folder holding the unit folders or
/// a unit folder itself.
fn reference_path(r: &Path, rel: &str) -> PathBuf {
    let name = r.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    match rel.split_once('/') {
        Some((unit, rest)) if spec::unit_of_folder(&name).is_some() && unit.eq_ignore_ascii_case(&name) => rel_to_path(r, rest),
        _ => rel_to_path(r, rel),
    }
}

impl Service {
    pub fn new(platform: Box<dyn Platform>, local: PathBuf) -> Arc<Service> {
        let _ = std::fs::create_dir_all(&local);
        let settings: Settings = std::fs::read(local.join("settings.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Arc::new(Service {
            local,
            platform,
            settings: Mutex::new(settings),
            store: Mutex::new(None),
            store_root: Mutex::new(String::new()),
            registry: RwLock::new(Registry::default()),
            registry_state: Mutex::new("Not read yet".into()),
            pdfium: Mutex::new(None),
            pdfium_error: Mutex::new("PDF engine not loaded".into()),
            ocr: Mutex::new(None),
            has_ocr: AtomicBool::new(false),
            ocr_checked: AtomicBool::new(false),
            backoff_until: Mutex::new(None),
            refs_missing: Mutex::new(vec![]),
            running: Mutex::new(HashMap::new()),
            filing_lock: Mutex::new(()),
            index_dirty: AtomicBool::new(false),
            index_failed: Mutex::new(vec![]),
            notice: Mutex::new(String::new()),
            watch_seen: Mutex::new(HashMap::new()),
            last_emit: Mutex::new(Instant::now()),
        })
    }

    pub fn set_pdfium(&self, lib: &Path) {
        match Pdfium::bind_to_library(lib.display().to_string()) {
            Ok(b) => {
                *lock(&self.pdfium) = Some(Arc::new(Pdfium::new(b)));
                lock(&self.pdfium_error).clear();
            }
            Err(e) => *lock(&self.pdfium_error) = format!("PDF engine could not load: {e}"),
        }
    }

    pub fn set_ocr(&self, ocr: Option<Box<dyn Ocr>>) {
        self.has_ocr.store(ocr.is_some(), Ordering::SeqCst);
        *lock(&self.ocr) = ocr;
        self.ocr_checked.store(true, Ordering::SeqCst);
    }

    fn settings(&self) -> Settings {
        lock(&self.settings).clone()
    }

    fn save_settings(&self, s: &Settings) {
        let _ = util::write_atomic(&self.local.join("settings.json"), &serde_json::to_vec_pretty(s).unwrap_or_default());
        *lock(&self.settings) = s.clone();
    }

    fn root(&self) -> PathBuf {
        PathBuf::from(self.settings().root)
    }

    fn key(&self) -> Option<String> {
        let s = self.settings();
        if s.key_sealed.is_empty() {
            return std::env::var("ANTHROPIC_API_KEY").ok().filter(|k| !k.is_empty());
        }
        crate::secret::open(&s.key_sealed)
    }

    /// The ledger for the current drop folder (opened on first use; reopened
    /// when the folder changes or the drive comes back).
    fn with_store<T>(&self, f: impl FnOnce(&Store) -> rusqlite::Result<T>) -> Result<T, CmdError> {
        let root = self.root();
        let mut g = lock(&self.store);
        let rs = root.display().to_string();
        if g.is_none() || *lock(&self.store_root) != rs {
            if !root.is_dir() {
                return Err(CmdError { code: 503, message: format!("The drop folder {} isn't available. Is the drive plugged in?", root.display()) });
            }
            let s = Store::open(&root.join(DATA).join("intake.db"))?;
            let _ = s.requeue_interrupted();
            *g = Some(s);
            *lock(&self.store_root) = rs;
        }
        Ok(f(g.as_ref().unwrap())?)
    }

    pub fn emit_changed(&self) {
        *lock(&self.last_emit) = Instant::now();
        self.platform.emit("changed", json!({}));
    }

    fn set_notice(&self, m: &str) {
        *lock(&self.notice) = m.to_string();
        self.emit_changed();
    }

    // ── Background loops ─────────────────────────────────────────────────

    pub fn start(self: &Arc<Self>) {
        let s = self.clone();
        std::thread::spawn(move || s.refresh_registry());
        let s = self.clone();
        std::thread::spawn(move || loop {
            s.watch_once();
            std::thread::sleep(Duration::from_secs(3));
        });
        let s = self.clone();
        std::thread::spawn(move || loop {
            s.dispatch_once();
            std::thread::sleep(Duration::from_secs(2));
        });
        let s = self.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(8));
            if s.index_dirty.swap(false, Ordering::SeqCst) {
                s.rebuild_indexes();
            }
        });
    }

    pub fn refresh_registry(&self) {
        let st = self.settings();
        *lock(&self.registry_state) = "Reading existing folders…".into();
        self.emit_changed();
        let refs: Vec<PathBuf> = st.references.iter().map(PathBuf::from).collect();
        let root = PathBuf::from(&st.root);
        let r = Registry::scan(&refs, root.is_dir().then_some(root.as_path()));
        let msg = if r.errors.is_empty() {
            format!("{} equipment folders known", r.equipment.len())
        } else {
            format!("{} equipment folders known; could not read: {}", r.equipment.len(), r.errors.join("; "))
        };
        *self.registry.write().unwrap_or_else(|e| e.into_inner()) = r;
        *lock(&self.registry_state) = msg;
        self.emit_changed();
    }

    /// Pick up scans that have finished arriving in the drop folder.
    fn watch_once(&self) {
        let st = self.settings();
        let root = PathBuf::from(&st.root);
        if !root.is_dir() {
            return;
        }
        let Ok(entries) = std::fs::read_dir(&root) else { return };
        let mut present = HashSet::new();
        let mut ready = vec![];
        for e in entries.flatten() {
            let p = e.path();
            let Ok(md) = e.metadata() else { continue };
            if !md.is_file() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if !name.to_ascii_lowercase().ends_with(".pdf") || name.starts_with('~') || name.starts_with('.') {
                continue;
            }
            present.insert(p.clone());
            let size = md.len();
            let mtime = md.modified().unwrap_or(std::time::UNIX_EPOCH);
            let mut seen = lock(&self.watch_seen);
            match seen.get(&p) {
                Some((s0, m0, since)) if *s0 == size && *m0 == mtime => {
                    // Unchanged for a while and not held open by the scanner.
                    if since.elapsed() >= Duration::from_secs(5) && size > 0 && std::fs::OpenOptions::new().read(true).write(true).open(&p).is_ok() {
                        ready.push(p.clone());
                    }
                }
                _ => {
                    seen.insert(p.clone(), (size, mtime, Instant::now()));
                }
            }
        }
        lock(&self.watch_seen).retain(|p, _| present.contains(p));
        for p in ready {
            if let Err(e) = self.ingest(&root, &p) {
                self.set_notice(&format!("Couldn't pick up {}: {}", p.display(), e.message));
            }
            lock(&self.watch_seen).remove(&p);
        }
    }

    /// Move a dropped scan into the originals folder and queue it.
    pub fn ingest(&self, root: &Path, p: &Path) -> Result<i64, CmdError> {
        let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let sha = util::sha256_file(p).map_err(|e| bad(e.to_string()))?;
        let now = util::now_secs();
        let dir = root.join(ORIGINALS).join(util::iso_date(now));
        std::fs::create_dir_all(&dir).map_err(|e| bad(format!("Can't create {}: {e}", dir.display())))?;
        let dest = util::unique_path(&dir, &name);
        util::move_file(p, &dest).map_err(|e| bad(format!("Can't move the scan: {e}")))?;
        let dup = self.with_store(|s| s.by_sha(&sha))?;
        let id = self.with_store(|s| s.add_scan(&name, &dest.display().to_string(), &sha, now))?;
        if let Some(d) = dup {
            self.with_store(|s| s.set_status(id, "duplicate", &format!("Same file as scan #{} ({}), not read again.", d.id, d.file_name)))?;
        }
        self.emit_changed();
        Ok(id)
    }

    fn dispatch_once(self: &Arc<Self>) {
        let st = self.settings();
        if st.paused || self.key().is_none() || lock(&self.pdfium).is_none() {
            return;
        }
        if !self.ocr_checked.load(Ordering::SeqCst) || lock(&self.registry_state).starts_with("Reading") {
            return;
        }
        if let Some(t) = *lock(&self.backoff_until) {
            if Instant::now() < t {
                return;
            }
        }
        // Never file while the network folders can't be read: new folder
        // names could then differ from the ones already on the network.
        let missing: Vec<String> = st.references.iter().filter(|r| !Path::new(r).is_dir()).cloned().collect();
        let was_missing = std::mem::replace(&mut *lock(&self.refs_missing), missing.clone());
        if !missing.is_empty() {
            if was_missing != missing {
                self.set_notice(&format!("Waiting for the network folder {} (not reachable). Scans stay in line and continue once it is back. To work without it, remove it in Settings.", missing.join(", ")));
            }
            return;
        }
        if !was_missing.is_empty() {
            // Back again: re-read the folder names before filing anything.
            lock(&self.notice).clear();
            let me = self.clone();
            std::thread::spawn(move || me.refresh_registry());
            return;
        }
        let busy = lock(&self.running).len() as u32;
        if busy >= st.parallel.clamp(1, 4) {
            return;
        }
        let Ok(queued) = self.with_store(|s| s.scans(Some("queued"), 500)) else { return };
        let running: HashSet<i64> = lock(&self.running).keys().copied().collect();
        // Oldest first; one scan per equipment number at a time so two scans
        // of the same folder never create two different new folders.
        let running_equip: HashSet<String> = running.iter().filter_map(|id| self.with_store(|s| s.scan(*id)).ok().flatten()).filter_map(|s| spec::equip_from_filename(&s.file_name).map(|n| n.key())).collect();
        let next = queued.iter().rev().find(|s| !running.contains(&s.id) && spec::equip_from_filename(&s.file_name).map(|n| !running_equip.contains(&n.key())).unwrap_or(true));
        let Some(next) = next else { return };
        let id = next.id;
        let cancel = Arc::new(AtomicBool::new(false));
        lock(&self.running).insert(id, cancel.clone());
        let _ = self.with_store(|s| s.set_status(id, "reading", "Starting"));
        let me = self.clone();
        std::thread::spawn(move || {
            let r = me.process(id, &cancel);
            lock(&me.running).remove(&id);
            if let Err(e) = r {
                if e.code == 503 {
                    // Temporary (network, overload, rate limit): back in line
                    // and a cool-down for everything.
                    let _ = me.with_store(|s| s.set_status(id, "queued", &format!("Will try again shortly: {}", e.message)));
                    *lock(&me.backoff_until) = Some(Instant::now() + Duration::from_secs(300));
                    me.set_notice(&format!("Reading paused for 5 minutes: {}", e.message));
                } else if e.message == "Stopped" {
                    let _ = me.with_store(|s| s.set_error(id, "Stopped by you. Use Read again to start over.", util::now_secs()));
                } else {
                    let _ = me.with_store(|s| s.set_error(id, &e.message, util::now_secs()));
                }
                if e.code == 402 {
                    let mut st = me.settings();
                    st.paused = true;
                    me.save_settings(&st);
                    me.set_notice(&format!("Intake paused: {}", e.message));
                }
            }
            me.emit_changed();
        });
        self.emit_changed();
    }

    fn work_dir(&self, id: i64) -> PathBuf {
        self.root().join(DATA).join("work").join(format!("scan-{id:06}"))
    }

    /// Page images and OCR for a scan (made once, reused by review).
    fn ensure_pages(&self, id: i64, cancel: &AtomicBool) -> Result<Vec<PageInfo>, CmdError> {
        let scan = self.with_store(|s| s.scan(id))?.ok_or_else(|| bad("No such scan"))?;
        let work = self.work_dir(id);
        if let Ok(b) = std::fs::read(work.join("pages.json")) {
            if let Ok(p) = serde_json::from_slice::<Vec<PageInfo>>(&b) {
                if p.iter().all(|x| Path::new(&x.image).exists()) && !p.is_empty() {
                    return Ok(p);
                }
            }
        }
        let pdfium = lock(&self.pdfium).clone().ok_or_else(|| bad(lock(&self.pdfium_error).clone()))?;
        let ocr_guard = lock(&self.ocr);
        let reader = pages::Reader { pdfium: &pdfium, ocr: ocr_guard.as_deref() };
        let mut last = Instant::now();
        let pages = reader
            .read(Path::new(&scan.original_path), &work, &|| cancel.load(Ordering::SeqCst), &mut |d, t| {
                if last.elapsed() > Duration::from_millis(700) || d == t {
                    last = Instant::now();
                    let _ = self.with_store(|s| s.set_stage(id, &format!("Reading page {d} of {t}")));
                    self.emit_changed();
                }
            })
            .map_err(bad)?;
        drop(ocr_guard);
        let _ = util::write_atomic(&work.join("pages.json"), &serde_json::to_vec(&pages).unwrap_or_default());
        self.with_store(|s| s.set_read(id, pages.len() as i64, &work.display().to_string()))?;
        Ok(pages)
    }

    fn process(&self, id: i64, cancel: &AtomicBool) -> Result<(), CmdError> {
        let scan = self.with_store(|s| s.scan(id))?.ok_or_else(|| bad("No such scan"))?;
        self.with_store(|s| s.set_status(id, "reading", "Reading pages"))?;
        self.emit_changed();
        let pages = self.ensure_pages(id, cancel)?;
        if pages.is_empty() {
            return Err(bad("The scan has no pages."));
        }
        let key = self.key().ok_or_else(|| bad("No API key set"))?;
        let st = self.settings();
        self.with_store(|s| s.set_status(id, "analyzing", "Reading the documents"))?;
        self.emit_changed();
        let file_equip = spec::equip_from_filename(&scan.file_name);
        let reg = self.registry.read().unwrap_or_else(|e| e.into_inner()).clone();
        let ctx = analyze::Context { file_name: &scan.file_name, file_equip: file_equip.as_ref(), registry: &reg };
        let out = analyze::analyze(&key, &st.model, &ctx, &pages, &|| cancel.load(Ordering::SeqCst), &mut |m| {
            let _ = self.with_store(|s| s.set_stage(id, m));
            self.emit_changed();
        });
        let out = match out {
            Ok(o) => o,
            Err(e) => {
                let code = if e.message.contains("no remaining credit") || e.message.contains("rejected") {
                    402
                } else if e.retryable {
                    503
                } else {
                    500
                };
                return Err(CmdError { code, message: e.message });
            }
        };
        self.with_store(|s| s.add_cost(id, out.usage.cost_usd))?;
        let mut filing = out.filing;
        let _ = util::write_atomic(&self.work_dir(id).join("first-reading.json"), &serde_json::to_vec_pretty(&out.first).unwrap_or_default());
        let decision = analyze::decide(&mut filing, &pages, file_equip.as_ref(), &reg);
        let filing_json = serde_json::to_string(&filing).unwrap_or_default();
        let eq = decision.equipment.as_ref().map(|n| n.text.clone()).unwrap_or_default();
        let rel = decision.equipment_rel.clone().unwrap_or_default();
        if !decision.problems.is_empty() || decision.equipment_rel.is_none() {
            let mut problems = decision.problems.clone();
            if problems.is_empty() {
                problems.push("The equipment folder could not be settled.".into());
            }
            self.with_store(|s| s.set_result(id, "review", &eq, &rel, decision.new_folder, &problems, &filing_json, util::now_secs()))?;
            return Ok(());
        }
        self.with_store(|s| s.set_result(id, "filing", &eq, &rel, decision.new_folder, &[], &filing_json, 0))?;
        self.with_store(|s| s.set_stage(id, "Writing the documents"))?;
        self.emit_changed();
        self.file(id, &filing, decision.equipment.as_ref().unwrap(), &rel, &pages)?;
        Ok(())
    }

    /// Write every document of a scan into its equipment folder.
    fn file(&self, id: i64, f: &Filing, no: &EquipNo, rel: &str, pages: &[PageInfo]) -> Result<(), CmdError> {
        let _g = lock(&self.filing_lock);
        let st = self.settings();
        let root = self.root();
        // Filing again replaces what this scan filed before.
        for d in self.with_store(|s| s.delete_docs_of_scan(id))? {
            let _ = std::fs::remove_file(rel_to_path(&root, &d.file_rel));
        }
        // Another scan may have just created this equipment's folder.
        let mut rel = rel.to_string();
        {
            let reg = self.registry.read().unwrap_or_else(|e| e.into_inner());
            let found = reg.find(no);
            if !found.iter().any(|e| e.rel.eq_ignore_ascii_case(&rel)) && found.len() == 1 {
                rel = found[0].rel.clone();
            }
        }
        let equip_dir = rel_to_path(&root, &rel);
        // New = exists neither on the network nor on the scan drive yet.
        let on_network = self.registry.read().unwrap_or_else(|e| e.into_inner()).equipment.iter().any(|e| e.reference && e.rel.eq_ignore_ascii_case(&rel));
        let new_folder = !equip_dir.exists() && !on_network;
        std::fs::create_dir_all(&equip_dir).map_err(|e| bad(format!("Can't create {}: {e}", equip_dir.display())))?;
        if new_folder {
            self.with_store(|s| s.note_folder(&rel, &no.text, util::now_secs()))?;
        }
        self.registry.write().unwrap_or_else(|e| e.into_inner()).add_created(no, &rel);
        let subs: Vec<String> = self.registry.read().unwrap_or_else(|e| e.into_inner()).equipment.iter().filter(|e| e.rel.eq_ignore_ascii_case(&rel)).flat_map(|e| e.subfolders.clone()).collect();
        let pdfium = lock(&self.pdfium).clone().ok_or_else(|| bad("PDF engine not available"))?;
        let scan = self.with_store(|s| s.scan(id))?.ok_or_else(|| bad("No such scan"))?;
        let source = std::fs::read(&scan.original_path).map_err(|e| bad(format!("Can't read the original scan: {e}")))?;
        let work = self.work_dir(id);
        let refs: Vec<PathBuf> = st.references.iter().map(PathBuf::from).collect();
        let tag = self.registry.read().unwrap_or_else(|e| e.into_inner()).equipment.iter().find(|e| e.rel.eq_ignore_ascii_case(&rel)).and_then(|e| e.tag()).unwrap_or_default();
        let folder_name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
        let now = util::now_secs();
        let total = f.documents.len();
        for (i, x) in f.documents.iter().enumerate() {
            let _ = self.with_store(|s| s.set_stage(id, &format!("Writing document {} of {total}", i + 1)));
            let sub = Registry::doc_subfolder(&subs, &x.folder);
            self.registry.write().unwrap_or_else(|e| e.into_inner()).note_subfolder(&rel, &sub);
            let dir = equip_dir.join(&sub);
            std::fs::create_dir_all(&dir).map_err(|e| bad(format!("Can't create {}: {e}", dir.display())))?;
            let other = analyze::as_other(x, no);
            let date = (!x.date.is_empty()).then_some(x.date.as_str());
            let mut title = x.title.clone();
            let mut name = spec::document_file_name(no, &title, date, other.as_deref());
            // Keep whole paths short enough for the network drive.
            while format!("{rel}/{sub}/{name}").chars().count() > 200 && title.chars().count() > 24 {
                title = spec::clip(&title, title.chars().count() - 8);
                name = spec::document_file_name(no, &title, date, other.as_deref());
            }
            // Never collide with a file already on the scan drive or on the network.
            let mut target = util::unique_path(&dir, &name);
            let mut note = String::new();
            loop {
                let fname = target.file_name().unwrap().to_string_lossy().to_string();
                let clash = refs.iter().any(|r| reference_path(r, &format!("{rel}/{sub}/{fname}")).exists());
                if !clash {
                    break;
                }
                note = format!("A file named \"{fname}\" is already in this folder on the network; this may be a second copy.");
                let stem = fname.trim_end_matches(".pdf");
                target = util::unique_path(&dir, &format!("{stem} (2).pdf"));
            }
            let kept = analyze::kept_pages(x, pages);
            let bytes = crate::pdfout::extract_pages(&pdfium, &source, &kept).map_err(bad)?;
            let layers: Vec<Option<crate::ocr::OcrPage>> = kept.iter().map(|&p| if pages[p as usize].had_text { None } else { pages::load_ocr(&work, p) }).collect();
            let file_stem = target.file_name().unwrap().to_string_lossy().trim_end_matches(".pdf").to_string();
            let mut keywords = vec![no.text.clone()];
            if !tag.is_empty() {
                keywords.push(tag.clone());
            }
            if let Some(o) = &other {
                keywords.push(o.clone());
            }
            if !x.drawing_number.is_empty() {
                keywords.push(x.drawing_number.clone());
            }
            let props = crate::pdfout::Properties { title: file_stem.clone(), subject: format!("{folder_name} - {sub}"), keywords: keywords.join("; "), author: st.author.clone(), date: crate::pdfout::pdf_now() };
            let out = crate::pdfout::finalize(&bytes, &layers, &props).map_err(bad)?;
            util::write_atomic(&target, &out).map_err(|e| bad(format!("Can't write {}: {e}", target.display())))?;
            let file_rel = target.strip_prefix(&root).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default();
            self.with_store(|s| {
                s.add_doc(&Doc {
                    scan_id: id,
                    equipment: no.text.clone(),
                    equipment_rel: rel.clone(),
                    folder: sub.clone(),
                    file_rel,
                    title: x.title.clone(),
                    date: x.date.clone(),
                    pages: kept.len() as i64,
                    first_page: x.first_page as i64,
                    last_page: x.last_page as i64,
                    as_other: other.clone().unwrap_or_default(),
                    drawing_number: x.drawing_number.clone(),
                    revision: x.revision.clone(),
                    summary: x.summary.clone(),
                    note: note.clone(),
                    filed_at: now,
                    ..Default::default()
                })
            })?;
        }
        self.with_store(|s| s.set_result(id, "filed", &no.text, &rel, new_folder, &[], &serde_json::to_string(f).unwrap_or_default(), util::now_secs()))?;
        // Working images are only needed until a scan is filed.
        let _ = std::fs::remove_dir_all(&work);
        self.index_dirty.store(true, Ordering::SeqCst);
        self.emit_changed();
        Ok(())
    }

    pub fn rebuild_indexes(&self) {
        let st = self.settings();
        let Ok(docs) = self.with_store(|s| s.all_docs()) else { return };
        let failed = crate::index::rebuild(&self.root(), &docs, &st.author);
        if !failed.is_empty() {
            // Probably open in Excel: try again later.
            self.index_dirty.store(true, Ordering::SeqCst);
        }
        *lock(&self.index_failed) = failed;
        self.emit_changed();
    }

    // ── Commands from the window ─────────────────────────────────────────

    pub fn handle(self: &Arc<Self>, cmd: &str, a: &Value) -> R {
        match cmd {
            "state" => self.cmd_state(),
            "scans" => {
                let status = a["status"].as_str();
                let limit = a["limit"].as_i64().unwrap_or(200).clamp(1, 2000);
                let scans = self.with_store(|s| s.scans(status, limit))?;
                Ok(json!(scans))
            }
            "scan" => self.cmd_scan(a["id"].as_i64().unwrap_or(0)),
            "scan.retry" => {
                let id = a["id"].as_i64().unwrap_or(0);
                let scan = self.with_store(|s| s.scan(id))?.ok_or_else(|| bad("No such scan"))?;
                if !matches!(scan.status.as_str(), "failed" | "review" | "set_aside" | "duplicate") {
                    return Err(bad("Only failed, held or set-aside scans can be read again."));
                }
                self.with_store(|s| s.set_status(id, "queued", "Waiting to be read again"))?;
                self.emit_changed();
                Ok(json!({"ok": true}))
            }
            "scan.stop" => {
                let id = a["id"].as_i64().unwrap_or(0);
                if let Some(c) = lock(&self.running).get(&id) {
                    c.store(true, Ordering::SeqCst);
                }
                Ok(json!({"ok": true}))
            }
            "scan.set_aside" => {
                let id = a["id"].as_i64().unwrap_or(0);
                self.with_store(|s| s.set_status(id, "set_aside", "Set aside by you; the original is kept in _ORIGINAL SCANS."))?;
                self.emit_changed();
                Ok(json!({"ok": true}))
            }
            "scan.unfile" => self.cmd_unfile(a["id"].as_i64().unwrap_or(0)),
            "scan.open_original" => {
                let id = a["id"].as_i64().unwrap_or(0);
                let scan = self.with_store(|s| s.scan(id))?.ok_or_else(|| bad("No such scan"))?;
                self.platform.open_path(Path::new(&scan.original_path)).map_err(bad)?;
                Ok(json!({"ok": true}))
            }
            "review.file" => self.cmd_review_file(a),
            "doc.open" | "doc.reveal" => {
                let rel = a["file_rel"].as_str().unwrap_or("");
                if rel.contains("..") {
                    return Err(bad("Bad path"));
                }
                let p = rel_to_path(&self.root(), rel);
                if cmd == "doc.open" { self.platform.open_path(&p) } else { self.platform.reveal(&p) }.map_err(bad)?;
                Ok(json!({"ok": true}))
            }
            "folder.open" => {
                let which = a["which"].as_str().unwrap_or("root");
                let root = self.root();
                let p = match which {
                    "originals" => root.join(ORIGINALS),
                    "rel" => rel_to_path(&root, a["rel"].as_str().unwrap_or("")),
                    _ => root,
                };
                self.platform.open_path(&p).map_err(bad)?;
                Ok(json!({"ok": true}))
            }
            "settings.save" => self.cmd_settings_save(a),
            "settings.pick_folder" => {
                let p = self.platform.pick_folder(a["title"].as_str().unwrap_or("Choose a folder"));
                Ok(json!({"path": p.map(|p| p.display().to_string())}))
            }
            "key.set" => {
                let key = a["key"].as_str().unwrap_or("").trim().to_string();
                if !key.starts_with("sk-ant-") {
                    return Err(bad("Anthropic API keys start with sk-ant-. Copy the whole key from console.anthropic.com → Settings → API keys."));
                }
                let st = self.settings();
                let name = claude::check_key(&key, &st.model).map_err(|e| bad(e.message))?;
                let mut st = st;
                st.key_sealed = crate::secret::seal(&key).ok_or_else(|| bad("Windows could not protect the key."))?;
                self.save_settings(&st);
                self.emit_changed();
                Ok(json!({"ok": true, "model": name}))
            }
            "key.clear" => {
                let mut st = self.settings();
                st.key_sealed.clear();
                self.save_settings(&st);
                self.emit_changed();
                Ok(json!({"ok": true}))
            }
            "intake.pause" | "intake.resume" => {
                let mut st = self.settings();
                st.paused = cmd == "intake.pause";
                self.save_settings(&st);
                if !st.paused {
                    lock(&self.notice).clear();
                }
                self.emit_changed();
                Ok(json!({"ok": true}))
            }
            "registry.refresh" => {
                let me = self.clone();
                std::thread::spawn(move || me.refresh_registry());
                Ok(json!({"ok": true}))
            }
            "registry.lookup" => {
                let q = a["q"].as_str().unwrap_or("");
                let reg = self.registry.read().unwrap_or_else(|e| e.into_inner());
                let hits: Vec<&crate::registry::EquipEntry> = match spec::parse_equip(q) {
                    Some(n) => reg.find(&n),
                    None if !q.trim().is_empty() => reg.find_by_tag(q, None),
                    None => vec![],
                };
                let new_rel = spec::parse_equip(q).filter(|_| hits.is_empty()).map(|n| reg.new_equipment_rel(&n, a["tag"].as_str().unwrap_or(""), a["description"].as_str().unwrap_or("")));
                Ok(json!({"hits": hits, "new_rel": new_rel}))
            }
            "index.rebuild" => {
                self.rebuild_indexes();
                Ok(json!({"failed": *lock(&self.index_failed)}))
            }
            "notice.clear" => {
                lock(&self.notice).clear();
                self.emit_changed();
                Ok(json!({"ok": true}))
            }
            _ => Err(CmdError { code: 404, message: format!("Unknown command {cmd}") }),
        }
    }

    fn cmd_state(&self) -> R {
        let st = self.settings();
        let root = self.root();
        let root_ok = root.is_dir();
        let counts = if root_ok { self.with_store(|s| s.counts()).unwrap_or(json!({})) } else { json!({}) };
        let waiting = if root_ok {
            std::fs::read_dir(&root).map(|it| it.flatten().filter(|e| e.file_name().to_string_lossy().to_ascii_lowercase().ends_with(".pdf") && e.metadata().map(|m| m.is_file()).unwrap_or(false)).count()).unwrap_or(0)
        } else {
            0
        };
        let running: Vec<i64> = lock(&self.running).keys().copied().collect();
        Ok(json!({
            "version": VERSION,
            "settings": {
                "root": st.root, "references": st.references, "model": st.model, "author": st.author,
                "parallel": st.parallel, "paused": st.paused,
                "key": if st.key_sealed.is_empty() { Value::Null } else { json!(self.key().map(|k| claude::mask_key(&k)).unwrap_or_else(|| "(unreadable — enter it again)".into())) },
            },
            "models": claude::MODELS.iter().map(|(id, label)| json!({"id": id, "label": label})).collect::<Vec<_>>(),
            "root_ok": root_ok,
            "waiting_in_drop": waiting,
            "counts": counts,
            "running": running,
            "registry": *lock(&self.registry_state),
            "references_ok": st.references.iter().map(|r| json!({"path": r, "ok": Path::new(r).is_dir()})).collect::<Vec<_>>(),
            "pdf_engine": lock(&self.pdfium).is_some(),
            "pdf_engine_error": *lock(&self.pdfium_error),
            "ocr": self.has_ocr.load(Ordering::SeqCst),
            "index_failed": *lock(&self.index_failed),
            "notice": *lock(&self.notice),
            "folders": spec::DOC_FOLDERS.iter().map(|(n, d)| json!({"name": n, "about": d})).collect::<Vec<_>>(),
        }))
    }

    fn cmd_scan(&self, id: i64) -> R {
        let scan = self.with_store(|s| s.scan(id))?.ok_or_else(|| bad("No such scan"))?;
        let filing: Value = self.with_store(|s| s.filing(id)).ok().and_then(|f| serde_json::from_str(&f).ok()).unwrap_or(Value::Null);
        let docs = self.with_store(|s| s.docs_of_scan(id))?;
        let work = self.work_dir(id);
        let pages: Vec<PageInfo> = std::fs::read(work.join("pages.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let reg = self.registry.read().unwrap_or_else(|e| e.into_inner());
        let file_equip = spec::equip_from_filename(&scan.file_name);
        let num = filing["equipment"]["number"].as_str().and_then(spec::parse_equip).or(file_equip.clone()).or_else(|| spec::parse_equip(&scan.equipment));
        let candidates: Vec<&crate::registry::EquipEntry> = num.as_ref().map(|n| reg.find(n)).unwrap_or_default();
        let flagged: Vec<usize> = {
            let mut f: Filing = serde_json::from_value(filing.clone()).unwrap_or_default();
            if pages.is_empty() { vec![] } else { analyze::decide(&mut f, &pages, file_equip.as_ref(), &reg).flagged_docs }
        };
        Ok(json!({
            "scan": scan,
            "filing": filing,
            "documents": docs,
            "pages": pages.iter().map(|p| json!({"n": p.index + 1, "blank": pages::looks_blank(p), "sheet": p.sheet()})).collect::<Vec<_>>(),
            "file_equipment": file_equip.map(|n| n.text),
            "candidates": candidates,
            "flagged": flagged,
        }))
    }

    /// A person's corrections from the review screen. The person's word is
    /// final on content; the coverage and folder rules still apply.
    fn cmd_review_file(self: &Arc<Self>, a: &Value) -> R {
        let id = a["id"].as_i64().unwrap_or(0);
        let mut f: Filing = serde_json::from_value(a["filing"].clone()).map_err(|e| bad(format!("Bad filing: {e}")))?;
        let scan = self.with_store(|s| s.scan(id))?.ok_or_else(|| bad("No such scan"))?;
        if !matches!(scan.status.as_str(), "review" | "failed" | "set_aside") {
            return Err(bad("This scan isn't waiting for review."));
        }
        let no = spec::parse_equip(&f.equipment.number).ok_or_else(|| bad("Enter the equipment number (e.g. 2010.06)."))?;
        let cancel = AtomicBool::new(false);
        let pages = self.ensure_pages(id, &cancel)?;
        for d in f.documents.iter_mut() {
            d.verdict = "confirmed".into();
            d.confidence = "high".into();
        }
        f.equipment.confidence = "high".into();
        f.equipment.matches_file_name = "yes".into();
        let reg = self.registry.read().unwrap_or_else(|e| e.into_inner()).clone();
        let mut dcs = analyze::decide(&mut f, &pages, Some(&no), &reg);
        // The person chose the folder explicitly.
        let chosen = a["equipment_rel"].as_str().unwrap_or("").trim().to_string();
        if !chosen.is_empty() {
            if chosen.contains("..") || chosen.starts_with('/') || chosen.split('/').count() < 2 {
                return Err(bad("Bad folder path"));
            }
            dcs.equipment_rel = Some(chosen);
            dcs.problems.retain(|p| !p.contains("folders ("));
        }
        let problems: Vec<String> = dcs.problems.into_iter().filter(|p| !p.contains("need a look")).collect();
        if !problems.is_empty() {
            return Err(bad(problems.join(" ")));
        }
        let rel = dcs.equipment_rel.ok_or_else(|| bad("Choose the equipment folder."))?;
        self.with_store(|s| s.set_result(id, "filing", &no.text, &rel, false, &[], &serde_json::to_string(&f).unwrap_or_default(), 0))?;
        let me = self.clone();
        let fr = f.clone();
        let res = me.file(id, &fr, &no, &rel, &pages);
        if let Err(e) = &res {
            let _ = self.with_store(|s| s.set_result(id, "review", &no.text, &rel, false, &[e.message.clone()], &serde_json::to_string(&f).unwrap_or_default(), util::now_secs()));
        }
        res?;
        Ok(json!({"ok": true}))
    }

    /// Take a filed scan back out (its generated PDFs are removed; the
    /// original is untouched) and put it in review.
    fn cmd_unfile(&self, id: i64) -> R {
        let _g = lock(&self.filing_lock);
        let scan = self.with_store(|s| s.scan(id))?.ok_or_else(|| bad("No such scan"))?;
        if scan.status != "filed" {
            return Err(bad("Only filed scans can be taken back."));
        }
        let root = self.root();
        for d in self.with_store(|s| s.delete_docs_of_scan(id))? {
            let _ = std::fs::remove_file(rel_to_path(&root, &d.file_rel));
        }
        let filing = self.with_store(|s| s.filing(id))?;
        self.with_store(|s| s.set_result(id, "review", &scan.equipment, &scan.equipment_rel, false, &["Taken back for correction.".to_string()], &filing, util::now_secs()))?;
        self.index_dirty.store(true, Ordering::SeqCst);
        self.emit_changed();
        Ok(json!({"ok": true}))
    }

    fn cmd_settings_save(self: &Arc<Self>, a: &Value) -> R {
        let mut st = self.settings();
        let old_refs = st.references.clone();
        let old_root = st.root.clone();
        if let Some(r) = a["root"].as_str() {
            let r = r.trim();
            if r.is_empty() {
                return Err(bad("Choose the drop folder."));
            }
            st.root = r.to_string();
        }
        if let Some(v) = a["references"].as_array() {
            st.references = v.iter().filter_map(|x| x.as_str()).map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect();
            let root_lower = st.root.to_ascii_lowercase();
            if st.references.iter().any(|r| r.to_ascii_lowercase() == root_lower) {
                return Err(bad("The network folder can't be the drop folder itself."));
            }
        }
        if let Some(m) = a["model"].as_str() {
            if claude::MODELS.iter().any(|(id, _)| *id == m) {
                st.model = m.to_string();
            }
        }
        if let Some(au) = a["author"].as_str() {
            let au = au.trim();
            if !au.is_empty() {
                st.author = au.to_string();
            }
        }
        if let Some(p) = a["parallel"].as_u64() {
            st.parallel = (p as u32).clamp(1, 4);
        }
        self.save_settings(&st);
        if st.references != old_refs || st.root != old_root {
            let me = self.clone();
            std::thread::spawn(move || me.refresh_registry());
        }
        self.emit_changed();
        Ok(json!({"ok": true}))
    }

    /// A page image for the review screen.
    pub fn page_image(&self, id: i64, n: u32) -> Option<Vec<u8>> {
        if n == 0 {
            return None;
        }
        let p = pages::page_image(&self.work_dir(id), n - 1);
        if let Ok(b) = std::fs::read(&p) {
            return Some(b);
        }
        // Filed scans: render on demand from the original.
        let scan = self.with_store(|s| s.scan(id)).ok().flatten()?;
        let pdfium = lock(&self.pdfium).clone()?;
        let doc = pdfium.load_pdf_from_file(&scan.original_path, None).ok()?;
        let page = doc.pages().get((n - 1) as i32).ok()?;
        let cfg = pdfium_render::prelude::PdfRenderConfig::new().set_target_width(1400).set_maximum_height(1800);
        let img = page.render_with_config(&cfg).ok()?.as_image().ok()?;
        let mut buf = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 80).encode_image(&img.to_rgb8()).ok()?;
        Some(buf)
    }
}
