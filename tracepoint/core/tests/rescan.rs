//! End to end, as on THOR: an administrator sets up the shared folder and
//! scans; an operator on another PC finds what their Windows account can
//! open — and nothing from a folder they can't (no file names, no folder
//! names, no document text, no equipment). THOR itself is never written.
//!
//! Windows permissions are simulated on this host (`acl::sim`); the same
//! logic runs against the real Windows APIs on a PC.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tp_core::acl::{self, Identity};
use tp_core::service::{Platform, Service};

struct Quiet;
impl Platform for Quiet {
    fn open_path(&self, _: &Path) -> Result<(), String> { Err("no".into()) }
    fn reveal(&self, _: &Path) -> Result<(), String> { Err("no".into()) }
    fn save_dialog(&self, _: &str, _: &str, _: &str) -> Option<PathBuf> { None }
    fn open_dialog(&self, _: &str, _: &str) -> Option<PathBuf> { None }
    fn pick_folder(&self, _: &str) -> Option<PathBuf> { None }
    fn emit(&self, _: &str, _: Value) {}
}

fn listing(dir: &Path) -> Vec<(String, u64)> {
    let mut v = Vec::new();
    for e in walk(dir) {
        let m = std::fs::metadata(&e).unwrap();
        v.push((e.display().to_string(), m.len()));
    }
    v.sort();
    v
}
fn walk(d: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(d).unwrap().flatten() {
        if e.path().is_dir() { out.extend(walk(&e.path())); } else { out.push(e.path()); }
    }
    out
}

const ENG: &str = "S-1-5-21-1-2-3-1500";

fn person(name: &str, sid: &str) -> Identity {
    Identity { sid: sid.into(), account: format!("KERN\\{name}"), display: name.into() }
}

fn wait(svc: &Arc<Service>, cmd: &str, done: impl Fn(&Value) -> bool) -> Value {
    let t0 = std::time::Instant::now();
    loop {
        let st = svc.handle(cmd, &json!({})).unwrap();
        if done(&st) {
            return st;
        }
        assert!(t0.elapsed().as_secs() < 60, "timed out: {st}");
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

fn wait_index(svc: &Arc<Service>) -> Value {
    let t0 = std::time::Instant::now();
    loop {
        let st = svc.handle("state", &json!({})).unwrap();
        if st["index"]["ready"] == true || !st["index"]["error"].is_null() {
            return st;
        }
        assert!(t0.elapsed().as_secs() < 30);
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

fn hits(svc: &Arc<Service>, q: &str) -> Value {
    svc.handle("search", &json!({"query": q, "limit": 50, "include_photos": true, "include_junk": true})).unwrap()
}

#[test]
fn shared_index_respects_windows_permissions() {
    acl::sim::reset();
    let base = std::env::temp_dir().join(format!("tp-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let thor = base.join("thor");
    let v2 = thor.join("5600 - LRU/10 - VESSELS/5610.15 V-2 Suction Bottle/INSPECTIONS/2023 EXT");
    let eng = thor.join("Engineering Only/MOC-2291 Zeolite Reactor Revamp");
    std::fs::create_dir_all(&v2).unwrap();
    std::fs::create_dir_all(&eng).unwrap();
    std::fs::write(v2.join("Bottle EXT INSPECTION REPORT.pdf"), b"%PDF").unwrap();
    std::fs::write(v2.join("5610.15 U-1A scan.pdf"), tp_core::content::minimal_pdf("")).unwrap();
    std::fs::write(v2.join("Field Notes.pdf"), tp_core::content::minimal_pdf("Minimum thickness readings at nozzle N3 were 0.312 inch, below t-min")).unwrap();
    std::fs::write(eng.join("7777.01 Zeolite revamp basis.pdf"), tp_core::content::minimal_pdf("Confidential zeolite catalyst loading plan for reactor 7777.01")).unwrap();
    let before = listing(&thor);
    let root = thor.display().to_string().replace('/', "\\");
    // Windows permissions on THOR: LRU readable by all staff; the project
    // folder only by the Engineering group.
    for f in walk(&thor) {
        let p = f.display().to_string().replace('/', "\\");
        let sddl = if p.contains("Engineering Only") { format!("D:PAI(A;;FA;;;{ENG})(A;;FA;;;BA)") } else { "D:AI(A;ID;0x1200a9;;;AU)(A;ID;FA;;;BA)".into() };
        acl::sim::set_file_sddl(&p, &sddl);
    }

    // ── The administrator (in Engineering) sets up and scans ─────────
    let admin = person("ggetzfrid", "S-1-5-21-1-2-3-1001");
    acl::sim::set_me(&admin.sid, &["S-1-5-11", ENG]);
    let a = Service::new_as(Box::new(Quiet), base.join("pc-admin"), admin.clone()).unwrap();
    let pdfium = std::env::var("TP_PDFIUM").ok();
    if let Some(p) = &pdfium {
        a.set_pdfium(PathBuf::from(p));
    }
    let st = a.handle("state", &json!({})).unwrap();
    assert_eq!(st["user"]["role"], "admin", "a PC on its own: whoever runs it administers it");
    assert!(st["user"].get("password").is_none());
    let team = base.join("TP").join("TracePoint Data");
    // An older version's unprotected full index in the same place is removed.
    std::fs::create_dir_all(base.join("TP/index")).unwrap();
    std::fs::write(base.join("TP/index/thor_knowledge.db"), b"old full index").unwrap();
    let r = a.handle("team.setup", &json!({"path": team.display().to_string()})).unwrap();
    assert_eq!(r["removed_legacy"].as_array().unwrap().len(), 1, "{r}");
    assert!(!base.join("TP/index/thor_knowledge.db").exists());
    assert!(team.join("tracepoint.json").is_file() && team.join("roles.json").is_file());
    a.handle("indexer.start", &json!({"root": root, "workers": 4})).unwrap();
    let st = wait(&a, "indexer.status", |s| !s["running"].as_bool().unwrap() && (s["error"].is_string() || s["log"].as_array().unwrap().iter().any(|x| x.as_str().unwrap_or("").starts_with("Done"))));
    assert!(st["error"].is_null(), "{st}");
    assert_eq!(st["files"], 4, "{st}");
    let shared = st["log"].as_array().unwrap().iter().any(|l| l.as_str().unwrap().starts_with("Shared 4 files in 2 permission groups"));
    assert!(shared, "{st}");
    if pdfium.is_some() {
        wait(&a, "content.status", |s| s["phase"] == "done");
        let sum = a.handle("airead.summary", &json!({})).unwrap();
        assert_eq!(sum["staged"], 1, "{sum}");
        assert_eq!(a.handle("airead.start", &json!({"count": 1})).unwrap_err().code, 400, "needs AI setup first");
    }
    wait_index(&a);
    if pdfium.is_some() {
        let r = hits(&a, "catalyst loading");
        assert!(r["inside"].as_array().map(|x| !x.is_empty()).unwrap_or(false) || r["hits"].as_array().unwrap().iter().any(|h| h["snippet"].is_string()), "the engineer finds text inside the project file: {r}");
    }
    assert!(hits(&a, "zeolite revamp")["total"].as_u64().unwrap() >= 1, "the engineer finds the project");
    assert!(hits(&a, "suction bottle inspection report")["total"].as_u64().unwrap() >= 1);
    // Give a colleague the Indexer role.
    a.handle("admin.member.set", &json!({"account": "KERN\\tech", "role": "indexer"})).unwrap();

    // ── An operator on another PC (not in Engineering) ───────────────
    let op = person("operator", "S-1-5-21-1-2-3-2002");
    acl::sim::set_me(&op.sid, &["S-1-5-11"]);
    std::fs::create_dir_all(base.join("pc-op")).unwrap();
    std::fs::write(base.join("pc-op/config.json"), json!({"team_folder": team.display().to_string()}).to_string()).unwrap();
    let o = Service::new_as(Box::new(Quiet), base.join("pc-op"), op).unwrap();
    o.load_index();
    let st = wait_index(&o);
    assert_eq!(st["index"]["ready"], true, "{st}");
    assert_eq!(st["user"]["role"], "user");
    assert!(hits(&o, "suction bottle inspection report")["total"].as_u64().unwrap() >= 1, "open folders work");
    for q in ["zeolite", "MOC-2291", "7777.01", "Engineering Only", "revamp basis", "catalyst loading"] {
        let r = hits(&o, q);
        assert_eq!(r["total"], 0, "{q}: {r}");
        assert!(r["inside"].as_array().map(|x| x.is_empty()).unwrap_or(true), "{q}: no document text either");
        assert!(!r.to_string().contains("Zeolite"), "{q}");
    }
    let g = o.handle("graph.walk", &json!({"id": "root", "depth": 3})).unwrap();
    assert!(!g.to_string().contains("Engineering Only"), "the graph stops at the lock");
    let eq = o.handle("equipment.list", &json!({})).unwrap();
    assert!(!eq.to_string().contains("7777.01"));
    let status = o.handle("index.status", &json!({})).unwrap();
    assert_eq!(status["groups"]["open"], 1);
    assert_eq!(status["groups"]["locked"], 1);
    for f in walk(&base.join("pc-op")) {
        let raw = String::from_utf8_lossy(&std::fs::read(&f).unwrap()).to_string();
        assert!(!raw.contains("Zeolite") && !raw.contains("MOC-2291"), "nothing locked on this PC: {}", f.display());
    }
    // Normal users: no rescans, no roles, no AI.
    assert_eq!(o.handle("indexer.start", &json!({"root": root})).unwrap_err().code, 403);
    assert_eq!(o.handle("admin.member.set", &json!({"account": "KERN\\operator", "role": "admin"})).unwrap_err().code, 403);
    assert_eq!(o.handle("ai.test", &json!({"provider": "anthropic", "key": "sk-ant-x", "model": "x"})).unwrap_err().code, 403);

    // ── The indexer can rescan; THOR is never written ────────────────
    let tech = acl::lookup_account("KERN\\tech").unwrap();
    acl::sim::set_me(&tech.sid, &["S-1-5-11"]);
    std::fs::create_dir_all(base.join("pc-tech")).unwrap();
    std::fs::write(base.join("pc-tech/config.json"), json!({"team_folder": team.display().to_string()}).to_string()).unwrap();
    let t = Service::new_as(Box::new(Quiet), base.join("pc-tech"), tech).unwrap();
    assert_eq!(t.handle("state", &json!({})).unwrap()["user"]["role"], "indexer");
    assert_eq!(listing(&thor), before, "the scanned folder is untouched");
    acl::sim::reset();
    let _ = std::fs::remove_dir_all(&base);
}
