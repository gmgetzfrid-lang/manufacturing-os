//! The TracePoint service: every command the interface can call, with all
//! permission checks done here (the interface is never trusted).
//!
//! Platform-neutral. The Windows app plugs in a `Platform` that opens files,
//! shows dialogs and pushes events; the dev server plugs in a stub.

use crate::ai::{self, AiChoice, Provider};
use crate::auth::{self, Role, Session, UserStore};
use crate::engine::{Engine, SearchRequest};
use crate::guard::{DriveResolver, Guard};
use crate::index::Index;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub trait Platform: Send + Sync {
    fn open_path(&self, p: &Path) -> Result<(), String>;
    fn reveal(&self, p: &Path) -> Result<(), String>;
    fn save_dialog(&self, title: &str, default_name: &str, ext: &str) -> Option<PathBuf>;
    fn open_dialog(&self, title: &str, ext: &str) -> Option<PathBuf>;
    fn pick_folder(&self, title: &str) -> Option<PathBuf>;
    fn emit(&self, event: &str, payload: Value);
    fn drive_resolver(&self) -> Option<DriveResolver> {
        None
    }
    fn machine(&self) -> String {
        std::env::var("COMPUTERNAME").unwrap_or_default()
    }
}

#[derive(Clone, Debug, Default, serde::Serialize, Deserialize)]
#[serde(default)]
pub struct LocalConfig {
    pub team_folder: Option<String>,
}

pub struct Paths {
    pub local: PathBuf,
    pub temp: PathBuf,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct IndexState {
    pub ready: bool,
    pub message: String,
    pub source: String,
    pub source_kind: String,
    pub error: Option<String>,
}

pub struct Service {
    pub platform: Box<dyn Platform>,
    pub guard: Guard,
    pub paths: Paths,
    pub embedded_index: Option<&'static [u8]>,
    engine: RwLock<Option<Arc<Engine>>>,
    index_state: RwLock<IndexState>,
    users: Mutex<UserStore>,
    profiles_path: PathBuf,
    session: Mutex<Option<Session>>,
    config: RwLock<LocalConfig>,
    chat_cancel: AtomicBool,
}

#[derive(Debug)]
pub struct ApiError {
    pub code: u16,
    pub message: String,
}

impl ApiError {
    fn new(code: u16, m: impl Into<String>) -> ApiError {
        ApiError { code, message: m.into() }
    }
}

impl From<auth::AuthError> for ApiError {
    fn from(e: auth::AuthError) -> Self {
        ApiError::new(400, e.0)
    }
}
impl From<ai::AiError> for ApiError {
    fn from(e: ai::AiError) -> Self {
        ApiError::new(e.status.unwrap_or(502), e.message)
    }
}
impl From<crate::guard::GuardError> for ApiError {
    fn from(e: crate::guard::GuardError) -> Self {
        ApiError::new(403, e.to_string())
    }
}

type R = Result<Value, ApiError>;

fn arg<T: for<'de> Deserialize<'de>>(v: &Value) -> Result<T, ApiError> {
    serde_json::from_value(v.clone()).map_err(|e| ApiError::new(400, format!("Bad request: {e}")))
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

impl Service {
    pub fn new(platform: Box<dyn Platform>, local: PathBuf, embedded_index: Option<&'static [u8]>) -> Result<Arc<Service>, String> {
        let guard = Guard::new(platform.drive_resolver());
        let temp = std::env::temp_dir().join("TracePoint");
        std::fs::create_dir_all(&local).map_err(|e| format!("Cannot create {}: {e}", local.display()))?;
        guard.allow(&local).map_err(|e| e.to_string())?;
        guard.allow(&temp).map_err(|e| e.to_string())?;
        let config: LocalConfig = std::fs::read(local.join("config.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        // Profiles live in the team folder when one is set and reachable.
        let mut profiles_path = local.join("profiles.db");
        if let Some(t) = &config.team_folder {
            let tp = PathBuf::from(t);
            if tp.is_dir() && guard.allow(&tp).is_ok() {
                profiles_path = tp.join("TracePoint_Profiles.db");
            }
        }
        let users = UserStore::open(&profiles_path).map_err(|e| e.0)?;
        Ok(Arc::new(Service {
            platform,
            guard,
            paths: Paths { local, temp },
            embedded_index,
            engine: RwLock::new(None),
            index_state: RwLock::new(IndexState { ready: false, message: "Starting…".into(), source: String::new(), source_kind: String::new(), error: None }),
            users: Mutex::new(users),
            profiles_path,
            session: Mutex::new(None),
            config: RwLock::new(config),
            chat_cancel: AtomicBool::new(false),
        }))
    }

    fn set_index_msg(&self, m: &str) {
        self.index_state.write().unwrap().message = m.to_string();
        self.platform.emit("index", json!({"message": m}));
    }

    /// Find the best available index and load it. Runs on a background thread.
    pub fn load_index(self: &Arc<Self>) {
        let t0 = std::time::Instant::now();
        let mut candidates: Vec<(PathBuf, &str)> = Vec::new();
        if let Some(t) = &self.config.read().unwrap().team_folder {
            candidates.push((PathBuf::from(t).join("index").join("thor_knowledge.db"), "team"));
        }
        candidates.push((self.paths.local.join("index").join("thor_knowledge.db"), "local"));
        let mut chosen: Option<(PathBuf, String)> = None;
        for (p, kind) in candidates {
            if p.is_file() {
                if kind == "team" {
                    // Copy the published index locally when it is newer, then load the copy.
                    let local_copy = self.paths.local.join("index").join("team_copy.db");
                    let newer = match (std::fs::metadata(&p), std::fs::metadata(&local_copy)) {
                        (Ok(a), Ok(b)) => a.modified().ok() > b.modified().ok() || a.len() != b.len(),
                        (Ok(_), Err(_)) => true,
                        _ => false,
                    };
                    if newer {
                        self.set_index_msg("Copying the team index from the shared folder…");
                        if self.guard.copy_into(&p, &local_copy).is_err() {
                            continue;
                        }
                    }
                    chosen = Some((local_copy, format!("Team index ({})", p.display())));
                } else {
                    chosen = Some((p.clone(), format!("Local index ({})", p.display())));
                }
                break;
            }
        }
        if chosen.is_none() {
            if let Some(bytes) = self.embedded_index {
                let h = {
                    let mut x: u64 = 1469598103934665603;
                    for b in bytes.iter().step_by(4096) {
                        x = (x ^ *b as u64).wrapping_mul(1099511628211);
                    }
                    x ^ bytes.len() as u64
                };
                let path = self.paths.local.join("index").join(format!("built-in-{h:016x}.db"));
                if !path.is_file() {
                    self.set_index_msg("Unpacking the built-in THOR index (first start only)…");
                    match crate::snapshot::decompress(bytes) {
                        Ok(raw) => {
                            if let Err(e) = self.guard.write(&path, &raw) {
                                self.fail_index(&format!("Could not unpack the built-in index: {e}"));
                                return;
                            }
                        }
                        Err(e) => {
                            self.fail_index(&format!("Built-in index is damaged: {e}"));
                            return;
                        }
                    }
                }
                chosen = Some((path, "Built-in index (shipped inside TracePoint.exe)".into()));
            }
        }
        let Some((path, source)) = chosen else {
            self.fail_index("No THOR index is available yet. An administrator can import one under Sources.");
            return;
        };
        self.set_index_msg("Reading 200,000+ THOR file records…");
        match Index::load(&path) {
            Ok(idx) => {
                for r in &idx.roots {
                    self.guard.protect(&r.path);
                }
                self.set_index_msg("Building the search engine…");
                let engine = Engine::new(idx);
                let files = engine.idx.files.len();
                *self.engine.write().unwrap() = Some(Arc::new(engine));
                let kind = if source.starts_with("Team") { "team" } else if source.starts_with("Local") { "local" } else { "builtin" };
                *self.index_state.write().unwrap() = IndexState {
                    ready: true,
                    message: format!("{files} files ready in {:.1} s", t0.elapsed().as_secs_f64()),
                    source,
                    source_kind: kind.into(),
                    error: None,
                };
                self.platform.emit("index", json!({"ready": true}));
            }
            Err(e) => self.fail_index(&e),
        }
    }

    fn fail_index(&self, e: &str) {
        let mut st = self.index_state.write().unwrap();
        st.ready = false;
        st.error = Some(e.to_string());
        st.message = e.to_string();
        drop(st);
        self.platform.emit("index", json!({"error": e}));
    }

    fn engine(&self) -> Result<Arc<Engine>, ApiError> {
        self.engine.read().unwrap().clone().ok_or_else(|| ApiError::new(503, "The THOR index is still loading."))
    }

    fn with_session<T>(&self, f: impl FnOnce(&Session) -> Result<T, ApiError>) -> Result<T, ApiError> {
        let g = self.session.lock().unwrap();
        match g.as_ref() {
            Some(s) if !s.user.must_change => f(s),
            Some(_) => Err(ApiError::new(403, "Change your temporary password first.")),
            None => Err(ApiError::new(401, "Please sign in.")),
        }
    }

    fn require(&self, pred: impl FnOnce(&Session) -> bool, msg: &str) -> Result<(), ApiError> {
        self.with_session(|s| if pred(s) { Ok(()) } else { Err(ApiError::new(403, msg)) })
    }

    fn state(&self) -> Value {
        let sess = self.session.lock().unwrap();
        let stage = match sess.as_ref() {
            None => "login",
            Some(s) if s.user.must_change => "change_password",
            Some(_) => "ready",
        };
        let users = self.users.lock().unwrap();
        let ai_enabled = users.policy("ai_enabled").ok().flatten().map(|v| v == "true").unwrap_or(true);
        let allowed = users.policy("ai_providers").ok().flatten().unwrap_or_else(|| "anthropic,openai,gemini".into());
        let prefs: Vec<(String, String)> = sess.as_ref().and_then(|s| users.prefs(s).ok()).unwrap_or_default();
        let idx = self.index_state.read().unwrap().clone();
        json!({
            "stage": stage,
            "version": VERSION,
            "user": sess.as_ref().map(|s| &s.user),
            "keys_unlocked": sess.as_ref().map(|s| s.unlocked()).unwrap_or(false),
            "index": idx,
            "policy": {"ai_enabled": ai_enabled, "ai_providers": allowed.split(',').collect::<Vec<_>>()},
            "prefs": prefs.into_iter().collect::<std::collections::HashMap<_, _>>(),
            "profiles_location": self.profiles_path.display().to_string(),
        })
    }

    fn file_path(&self, id: u32) -> Result<PathBuf, ApiError> {
        let e = self.engine()?;
        if id as usize >= e.idx.files.len() {
            return Err(ApiError::new(404, "No such file."));
        }
        Ok(PathBuf::from(e.idx.full_path(id)))
    }

    /// Handle one command. `cmd` is a dotted name, `a` its JSON arguments.
    pub fn handle(self: &Arc<Self>, cmd: &str, a: &Value) -> R {
        match cmd {
            // ── Session ──────────────────────────────────────────────
            "state" => Ok(self.state()),
            "auth.login" => {
                let sess = self.users.lock().unwrap().login(&s(a, "email"), &s(a, "password"))?;
                *self.session.lock().unwrap() = Some(sess);
                Ok(self.state())
            }
            "auth.change_password" => {
                let mut g = self.session.lock().unwrap();
                let sess = g.as_mut().ok_or_else(|| ApiError::new(401, "Please sign in."))?;
                self.users.lock().unwrap().change_password(sess, &s(a, "current"), &s(a, "new"))?;
                drop(g);
                Ok(self.state())
            }
            "auth.check_password" => {
                let email = self.session.lock().unwrap().as_ref().map(|s| s.user.email.clone()).unwrap_or_default();
                Ok(json!({"problem": auth::password_problem(&email, &s(a, "password"))}))
            }
            "auth.logout" => {
                if let Some(sess) = self.session.lock().unwrap().take() {
                    let _ = self.users.lock().unwrap().audit(Some(&sess.user.email), "logout", "Signed out");
                }
                Ok(self.state())
            }
            "auth.set_pref" => self.with_session(|sess| {
                let k = s(a, "key");
                if !["open_mode", "density", "results_view", "home_hint"].contains(&k.as_str()) {
                    return Err(ApiError::new(400, "Unknown preference."));
                }
                self.users.lock().unwrap().set_pref(sess, &k, &s(a, "value"))?;
                Ok(json!({"ok": true}))
            }),

            // ── Search ───────────────────────────────────────────────
            "search" => {
                self.with_session(|_| Ok(()))?;
                let req: SearchRequest = arg(a)?;
                Ok(serde_json::to_value(self.engine()?.search(&req)).unwrap())
            }
            "suggest" => {
                self.with_session(|_| Ok(()))?;
                Ok(serde_json::to_value(self.engine()?.suggest(&s(a, "q"), 8)).unwrap())
            }
            "equipment.card" => {
                self.with_session(|_| Ok(()))?;
                let e = self.engine()?;
                let id = a["id"].as_u64().unwrap_or(u64::MAX) as usize;
                if id >= e.idx.equipment.len() {
                    return Err(ApiError::new(404, "No such equipment."));
                }
                Ok(serde_json::to_value(e.equipment_card(id as u32)).unwrap())
            }
            "equipment.list" => {
                self.with_session(|_| Ok(()))?;
                let e = self.engine()?;
                let q = s(a, "q").to_lowercase();
                let unit = s(a, "unit");
                let mut list: Vec<Value> = e
                    .idx
                    .equipment
                    .iter()
                    .enumerate()
                    .filter(|(_, x)| x.file_count > 0)
                    .filter(|(_, x)| unit.is_empty() || x.unit.map(|u| e.idx.units[u as usize].label == unit).unwrap_or(false))
                    .filter(|(_, x)| {
                        q.is_empty()
                            || x.number.to_lowercase().contains(&q)
                            || x.description.to_lowercase().contains(&q)
                            || x.tags.iter().any(|t| t.to_lowercase().replace('-', "").contains(&q.replace('-', "")))
                            || x.kind.to_lowercase().contains(&q)
                    })
                    .map(|(i, x)| {
                        json!({"id": i, "number": x.number, "tags": x.tags, "description": x.description, "kind": x.kind,
                               "unit": x.unit.map(|u| e.idx.units[u as usize].label.clone()), "files": x.file_count,
                               "historical": x.historical})
                    })
                    .collect();
                list.sort_by(|x, y| x["number"].as_str().cmp(&y["number"].as_str()));
                let units: Vec<Value> = e.idx.units.iter().map(|u| json!({"label": u.label, "code": u.code, "name": u.name})).collect();
                Ok(json!({"equipment": list, "units": units}))
            }
            "graph.equipment" => {
                self.with_session(|_| Ok(()))?;
                let e = self.engine()?;
                let id = a["id"].as_u64().unwrap_or(u64::MAX) as usize;
                if id >= e.idx.equipment.len() {
                    return Err(ApiError::new(404, "No such equipment."));
                }
                Ok(crate::graph::equipment_graph(&e, id as u32))
            }
            "file.info" => {
                self.with_session(|_| Ok(()))?;
                let e = self.engine()?;
                let id = a["id"].as_u64().unwrap_or(u64::MAX) as u32;
                if id as usize >= e.idx.files.len() {
                    return Err(ApiError::new(404, "No such file."));
                }
                let f = &e.idx.files[id as usize];
                let family = f.family.map(|fa| {
                    let fam = &e.idx.families[fa as usize];
                    let mut members: Vec<Value> = fam
                        .members
                        .iter()
                        .map(|&m| {
                            let mf = &e.idx.files[m as usize];
                            json!({"id": m, "name": mf.name, "sheet": mf.sheet, "rev": mf.rev, "latest": mf.flags & crate::index::F_LATEST != 0})
                        })
                        .collect();
                    members.sort_by(|x, y| x["name"].as_str().cmp(&y["name"].as_str()));
                    json!({"base": fam.base, "kind": fam.kind, "members": members})
                });
                let siblings = e.idx.files.iter().filter(|x| x.dir == f.dir).count();
                Ok(json!({"hit": e.hit(id, 0, 0, vec![]), "family": family, "folder_files": siblings}))
            }
            "file.open" => {
                self.with_session(|_| Ok(()))?;
                let id = a["id"].as_u64().unwrap_or(u64::MAX) as u32;
                let path = self.file_path(id)?;
                let mode = s(a, "mode");
                if mode == "original" {
                    self.platform.open_path(&path).map_err(|e| ApiError::new(500, e))?;
                } else {
                    // Default: open a temporary read-only copy so nothing can be
                    // saved back to THOR by accident.
                    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
                    let dir = self.paths.temp.join("open").join(format!("{id}"));
                    let dest = dir.join(&name);
                    self.guard.copy_into(&path, &dest).map_err(|e| ApiError::new(500, format!("Could not copy the file for viewing: {e}")))?;
                    if let Ok(meta) = std::fs::metadata(&dest) {
                        let mut p = meta.permissions();
                        p.set_readonly(true);
                        let _ = std::fs::set_permissions(&dest, p);
                    }
                    self.platform.open_path(&dest).map_err(|e| ApiError::new(500, e))?;
                }
                Ok(json!({"ok": true}))
            }
            "file.reachable" => {
                self.with_session(|_| Ok(()))?;
                let path = self.file_path(a["id"].as_u64().unwrap_or(u64::MAX) as u32)?;
                let meta = std::fs::metadata(&path).ok();
                Ok(json!({"ok": meta.is_some(), "size": meta.map(|m| m.len())}))
            }
            "file.reveal" => {
                self.with_session(|_| Ok(()))?;
                let path = self.file_path(a["id"].as_u64().unwrap_or(u64::MAX) as u32)?;
                self.platform.reveal(&path).map_err(|e| ApiError::new(500, e))?;
                Ok(json!({"ok": true}))
            }
            "export.xlsx" => {
                self.with_session(|_| Ok(()))?;
                let mut req: SearchRequest = arg(&a["request"])?;
                req.limit = 5000;
                req.offset = 0;
                let e = self.engine()?;
                let resp = e.search(&req);
                let name = format!("TracePoint_Results_{}.xlsx", auth::now().replace([':', '-'], "").replace('T', "_").trim_end_matches('Z'));
                let Some(dest) = self.platform.save_dialog("Export search results", &name, "xlsx") else {
                    return Ok(json!({"cancelled": true}));
                };
                self.guard.check(&dest)?;
                let filters = format!("{:?} {:?} {:?}", req.categories, req.units, req.exts);
                let source = self.index_state.read().unwrap().source.clone();
                crate::export::write_xlsx(&dest, &resp.hits, &req.query, &filters, &source).map_err(|e| ApiError::new(500, e))?;
                Ok(json!({"path": dest.display().to_string(), "rows": resp.hits.len()}))
            }

            // ── Index and sources ────────────────────────────────────
            "index.status" => {
                self.with_session(|_| Ok(()))?;
                let st = self.index_state.read().unwrap().clone();
                let e = self.engine.read().unwrap().clone();
                let (roots, stats, generated) = match &e {
                    Some(e) => {
                        let mut by_cat: std::collections::HashMap<&str, u32> = std::collections::HashMap::new();
                        for f in &e.idx.files {
                            *by_cat.entry(f.cat.label()).or_default() += 1;
                        }
                        (
                            serde_json::to_value(&e.idx.roots).unwrap(),
                            json!({
                                "files": e.idx.files.len(), "folders": e.idx.dirs.len(), "equipment": e.idx.equipment.iter().filter(|x| x.file_count > 0).count(),
                                "units": e.idx.units.len(), "families": e.idx.families.len(), "load_ms": e.idx.load_ms,
                                "with_equipment": e.idx.files.iter().filter(|f| !f.equip.is_empty()).count(),
                                "categories": by_cat,
                            }),
                            e.idx.generated_at.clone(),
                        )
                    }
                    None => (json!([]), json!({}), None),
                };
                Ok(json!({"state": st, "roots": roots, "stats": stats, "generated_at": generated, "protected": self.guard.protected_roots(),
                          "writable": self.guard.writable_dirs(), "team_folder": self.config.read().unwrap().team_folder}))
            }
            "index.reload" => {
                self.require(|s| s.user.role.can_rescan(), "Only administrators and indexers can reload the index.")?;
                let me = self.clone();
                std::thread::spawn(move || me.load_index());
                Ok(json!({"started": true}))
            }
            "index.import" => {
                self.require(|s| s.user.role.can_rescan(), "Only administrators and indexers can import an index.")?;
                let Some(src) = self.platform.open_dialog("Choose a THOR knowledge database (thor_knowledge.db)", "db") else {
                    return Ok(json!({"cancelled": true}));
                };
                // Validate before copying.
                Index::load(&src).map_err(|e| ApiError::new(400, format!("That file can't be used: {e}")))?;
                let dest = self.paths.local.join("index").join("thor_knowledge.db");
                self.guard.copy_into(&src, &dest)?;
                self.audit("index_imported", &src.display().to_string());
                let me = self.clone();
                std::thread::spawn(move || me.load_index());
                Ok(json!({"imported": dest.display().to_string()}))
            }

            // ── Administration ───────────────────────────────────────
            "admin.users" => self.with_session(|sess| {
                if !sess.is_admin() {
                    return Err(ApiError::new(403, "Administrators only."));
                }
                Ok(serde_json::to_value(self.users.lock().unwrap().list()?).unwrap())
            }),
            "admin.user.create" => self.with_session(|sess| {
                let role = Role::parse(&s(a, "role")).ok_or_else(|| ApiError::new(400, "Choose a role."))?;
                let u = self.users.lock().unwrap().create_user(sess, &s(a, "email"), &s(a, "name"), role, &s(a, "temp_password"))?;
                Ok(serde_json::to_value(u).unwrap())
            }),
            "admin.user.update" => self.with_session(|sess| {
                let id = a["id"].as_i64().unwrap_or(0);
                let role = a.get("role").and_then(|r| r.as_str()).and_then(Role::parse);
                let u = self.users.lock().unwrap().update_user(
                    sess,
                    id,
                    a.get("name").and_then(|x| x.as_str()),
                    role,
                    a.get("disabled").and_then(|x| x.as_bool()),
                    a.get("can_ai").and_then(|x| x.as_bool()),
                )?;
                Ok(serde_json::to_value(u).unwrap())
            }),
            "admin.user.reset" => self.with_session(|sess| {
                let u = self.users.lock().unwrap().reset_password(sess, a["id"].as_i64().unwrap_or(0), &s(a, "temp_password"))?;
                Ok(serde_json::to_value(u).unwrap())
            }),
            "admin.user.delete" => self.with_session(|sess| {
                self.users.lock().unwrap().delete_user(sess, a["id"].as_i64().unwrap_or(0))?;
                Ok(json!({"ok": true}))
            }),
            "admin.policy.set" => self.with_session(|sess| {
                let k = s(a, "key");
                if !["ai_enabled", "ai_providers", "ai_send_documents"].contains(&k.as_str()) {
                    return Err(ApiError::new(400, "Unknown policy."));
                }
                self.users.lock().unwrap().set_policy(sess, &k, &s(a, "value"))?;
                Ok(self.state())
            }),
            "admin.audit" => self.with_session(|sess| {
                if !sess.is_admin() {
                    return Err(ApiError::new(403, "Administrators only."));
                }
                let rows = self.users.lock().unwrap().audit_log(500)?;
                Ok(Value::Array(rows.into_iter().map(|r| json!({"at": r.0, "actor": r.1, "action": r.2, "detail": r.3, "machine": r.4})).collect()))
            }),
            "admin.team_folder" => self.with_session(|sess| {
                if !sess.is_admin() {
                    return Err(ApiError::new(403, "Administrators only."));
                }
                let folder = if a.get("pick").and_then(|x| x.as_bool()).unwrap_or(false) {
                    match self.platform.pick_folder("Choose the shared TracePoint team folder") {
                        Some(p) => Some(p.display().to_string()),
                        None => return Ok(json!({"cancelled": true})),
                    }
                } else {
                    a.get("path").and_then(|x| x.as_str()).filter(|x| !x.is_empty()).map(|x| x.to_string())
                };
                if let Some(f) = &folder {
                    self.guard.allow(Path::new(f))?;
                }
                let mut cfg = self.config.write().unwrap();
                cfg.team_folder = folder.clone();
                self.guard.write(&self.paths.local.join("config.json"), serde_json::to_string_pretty(&*cfg).unwrap().as_bytes())?;
                drop(cfg);
                self.audit("team_folder_set", folder.as_deref().unwrap_or("(none)"));
                Ok(json!({"team_folder": folder, "restart_required": true}))
            }),

            // ── AI ───────────────────────────────────────────────────
            "ai.providers" => Ok(serde_json::to_value(ai::providers()).unwrap()),
            "ai.get" => self.with_session(|sess| {
                let users = self.users.lock().unwrap();
                let prefs: std::collections::HashMap<String, String> = users.prefs(sess)?.into_iter().collect();
                let key = users.get_secret(sess, "ai_key")?;
                Ok(json!({
                    "provider": prefs.get("ai_provider"), "model": prefs.get("ai_model"), "reasoning": prefs.get("ai_reasoning"),
                    "key_mask": key.as_ref().map(|k| ai::mask_key(k)), "has_key": key.is_some(), "can_ai": sess.user.can_ai,
                }))
            }),
            "ai.models" => {
                let (provider, key) = self.ai_key_for(a)?;
                Ok(serde_json::to_value(ai::list_models(provider, &key)?).unwrap())
            }
            "ai.test" => {
                let (provider, key) = self.ai_key_for(a)?;
                let choice = AiChoice { provider, model: s(a, "model"), reasoning: a.get("reasoning").and_then(|x| x.as_str()).filter(|x| !x.is_empty()).map(|x| x.to_string()) };
                let t0 = std::time::Instant::now();
                let r = ai::test(&choice, &key)?;
                Ok(json!({"ok": true, "reply": r.text, "model": r.model, "reasoning_used": r.reasoning_used, "ms": t0.elapsed().as_millis()}))
            }
            "ai.save" => {
                let (provider, key) = self.ai_key_for(a)?;
                self.with_session(|sess| {
                    let users = self.users.lock().unwrap();
                    if a.get("key").and_then(|k| k.as_str()).map(|k| !k.trim().is_empty()).unwrap_or(false) {
                        users.put_secret(sess, "ai_key", key.trim())?;
                    }
                    users.set_pref(sess, "ai_provider", provider.as_str())?;
                    users.set_pref(sess, "ai_model", &s(a, "model"))?;
                    users.set_pref(sess, "ai_reasoning", &s(a, "reasoning"))?;
                    users.audit(Some(&sess.user.email), "ai_configured", &format!("{} / {} / {}", provider.as_str(), s(a, "model"), s(a, "reasoning")))?;
                    Ok(json!({"ok": true}))
                })
            }
            "ai.delete" => self.with_session(|sess| {
                let users = self.users.lock().unwrap();
                users.delete_secret(sess, "ai_key")?;
                Ok(json!({"ok": true}))
            }),
            "search.ai" => {
                let (choice, key) = self.current_ai()?;
                let e = self.engine()?;
                let history: Vec<ai::Msg> = a.get("history").and_then(|h| serde_json::from_value(h.clone()).ok()).unwrap_or_default();
                let q = s(a, "query");
                if q.trim().is_empty() {
                    return Err(ApiError::new(400, "Describe what you're looking for."));
                }
                let plat = &self.platform;
                let r = crate::aifind::find(&e, &choice, &key, &q, &history, &|m| plat.emit("aifind", json!({"status": m})))?;
                self.audit("ai_find", &format!("{} / {}", choice.provider.as_str(), choice.model));
                Ok(r.value)
            }
            "ai.cancel" => {
                self.chat_cancel.store(true, Ordering::SeqCst);
                Ok(json!({"ok": true}))
            }

            // ── About / for IT ───────────────────────────────────────
            "about" => Ok(self.about()),
            "chat.threads" | "library.list" => {
                self.with_session(|_| Ok(()))?;
                Ok(json!([]))
            }
            "indexer.status" => {
                self.with_session(|_| Ok(()))?;
                Ok(json!({"running": false}))
            }
            _ => Err(ApiError::new(404, format!("Unknown command {cmd}"))),
        }
    }

    fn audit(&self, action: &str, detail: &str) {
        let who = self.session.lock().unwrap().as_ref().map(|s| s.user.email.clone());
        let _ = self.users.lock().unwrap().audit(who.as_deref(), action, detail);
    }

    /// The key for an AI call: one typed in the wizard (not yet saved), or the
    /// user's own saved key. Enforces admin AI policy.
    fn ai_key_for(&self, a: &Value) -> Result<(Provider, zeroize::Zeroizing<String>), ApiError> {
        let provider = Provider::parse(&s(a, "provider")).ok_or_else(|| ApiError::new(400, "Choose a provider."))?;
        self.with_session(|sess| {
            let users = self.users.lock().unwrap();
            if users.policy("ai_enabled")?.map(|v| v == "false").unwrap_or(false) {
                return Err(ApiError::new(403, "AI features are turned off by your administrator."));
            }
            if !sess.user.can_ai {
                return Err(ApiError::new(403, "AI is not enabled for your profile. Ask an administrator."));
            }
            let allowed = users.policy("ai_providers")?.unwrap_or_else(|| "anthropic,openai,gemini".into());
            if !allowed.split(',').any(|p| p == provider.as_str()) {
                return Err(ApiError::new(403, "Your administrator has not allowed this provider."));
            }
            if let Some(k) = a.get("key").and_then(|k| k.as_str()).filter(|k| !k.trim().is_empty()) {
                return Ok((provider, zeroize::Zeroizing::new(k.trim().to_string())));
            }
            match users.get_secret(sess, "ai_key")? {
                Some(k) => Ok((provider, k)),
                None => Err(ApiError::new(400, "Paste your API key first.")),
            }
        })
    }

    pub fn current_ai(&self) -> Result<(AiChoice, zeroize::Zeroizing<String>), ApiError> {
        self.with_session(|sess| {
            let users = self.users.lock().unwrap();
            let prefs: std::collections::HashMap<String, String> = users.prefs(sess)?.into_iter().collect();
            let provider = prefs.get("ai_provider").and_then(|p| Provider::parse(p)).ok_or_else(|| ApiError::new(400, "Set up AI first (Profile › AI)."))?;
            let model = prefs.get("ai_model").cloned().unwrap_or_default();
            let reasoning = prefs.get("ai_reasoning").cloned().filter(|r| !r.is_empty());
            drop(users);
            Ok((provider, model, reasoning))
        })
        .and_then(|(provider, model, reasoning)| {
            let (_, key) = self.ai_key_for(&json!({"provider": provider.as_str()}))?;
            Ok((AiChoice { provider, model, reasoning }, key))
        })
    }

    /// Bytes for the preview pane: the file itself, a PNG of a TIFF's first
    /// page, or the first 256 KB of a text file. Read-only.
    pub fn serve_file(&self, id: u32, as_: &str) -> Result<(String, Vec<u8>), ApiError> {
        self.with_session(|_| Ok(()))?;
        let path = self.file_path(id)?;
        let meta = std::fs::metadata(&path).map_err(|_| ApiError::new(404, "File not reachable"))?;
        if meta.len() > 300 * 1024 * 1024 {
            return Err(ApiError::new(413, "Too large to preview"));
        }
        let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        match as_ {
            "png" => {
                let img = image::open(&path).map_err(|e| ApiError::new(415, format!("Can't render this image: {e}")))?;
                let img = if img.width() > 2400 || img.height() > 2400 { img.thumbnail(2400, 2400) } else { img };
                let mut out = std::io::Cursor::new(Vec::new());
                img.write_to(&mut out, image::ImageFormat::Png).map_err(|e| ApiError::new(500, e.to_string()))?;
                Ok(("image/png".into(), out.into_inner()))
            }
            "text" => {
                use std::io::Read;
                let mut buf = Vec::new();
                std::fs::File::open(&path).and_then(|f| f.take(256 * 1024).read_to_end(&mut buf)).map_err(|_| ApiError::new(404, "File not reachable"))?;
                Ok(("text/plain; charset=utf-8".into(), String::from_utf8_lossy(&buf).into_owned().into_bytes()))
            }
            _ => {
                let ct = match ext.as_str() {
                    "pdf" => "application/pdf",
                    "jpg" | "jpeg" | "jfif" => "image/jpeg",
                    "png" => "image/png",
                    "gif" => "image/gif",
                    "bmp" => "image/bmp",
                    "webp" => "image/webp",
                    "txt" | "log" | "csv" => "text/plain; charset=utf-8",
                    _ => "application/octet-stream",
                };
                let bytes = std::fs::read(&path).map_err(|_| ApiError::new(404, "File not reachable"))?;
                Ok((ct.into(), bytes))
            }
        }
    }

    pub fn serve_asset(name: &str) -> Option<(&'static str, &'static [u8])> {
        match name {
            "cat.gif" => Some(("image/gif", include_bytes!("../../assets/Loading_Cat.gif"))),
            "logo.png" => Some(("image/png", include_bytes!("../../assets/TracePoint_Logo_Transparent.png"))),
            "mark.png" => Some(("image/png", include_bytes!("../../assets/mark512.png"))),
            _ => None,
        }
    }

    pub fn cancel_flag(&self) -> &AtomicBool {
        &self.chat_cancel
    }

    pub fn about(&self) -> Value {
        json!({
            "version": VERSION,
            "local_data": self.paths.local.display().to_string(),
            "temp": self.paths.temp.display().to_string(),
            "profiles": self.profiles_path.display().to_string(),
            "team_folder": self.config.read().unwrap().team_folder,
            "protected_roots": self.guard.protected_roots(),
            "writable": self.guard.writable_dirs(),
            "index": self.index_state.read().unwrap().clone(),
            "ai_hosts": ai::providers().iter().map(|p| p.host).collect::<Vec<_>>(),
            "exe": std::env::current_exe().ok().map(|p| p.display().to_string()),
            "machine": self.platform.machine(),
        })
    }
}
