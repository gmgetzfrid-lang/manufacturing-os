//! `TracePoint.exe --selftest`: checks IT can run to confirm the build does
//! what the About page says. Prints PASS/FAIL lines; exit code 0 only if all
//! pass. Writes only inside the system temp folder, then removes it.

use crate::engine::{Engine, SearchRequest};
use crate::guard::{Guard, GuardError};
use crate::index::Index;
use std::path::Path;

pub struct Check {
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

fn check(out: &mut Vec<Check>, name: &str, ok: bool, detail: impl Into<String>) {
    out.push(Check { name: name.into(), ok, detail: detail.into() });
}

pub fn run(extra_protect: &[String]) -> Vec<Check> {
    let mut out = Vec::new();
    let tmp = std::env::temp_dir().join(format!("TracePoint-selftest-{}", std::process::id()));

    // ── THOR write guard ─────────────────────────────────────────────
    let g = Guard::new(None);
    g.protect(r"\\thor\Equipment Files");
    for r in extra_protect {
        g.protect(r);
    }
    let allowed = g.allow(&tmp).is_ok();
    check(&mut out, "Guard: temp folder is writable", allowed, tmp.display().to_string());
    let attempts = [
        r"\\thor\Equipment Files\selftest.txt",
        r"\\THOR\equipment files\any folder\..\selftest.txt",
        r"\\?\UNC\thor\Equipment Files\selftest.txt",
        r"//thor/Equipment Files/x/y.pdf",
    ];
    for p in attempts {
        let refused = matches!(g.check(Path::new(p)), Err(GuardError::InsideSource { .. }));
        check(&mut out, "Guard: write into THOR refused", refused, p);
    }
    for r in extra_protect {
        let p = format!("{r}\\TracePoint-selftest.txt");
        let refused = matches!(g.check(Path::new(&p)), Err(GuardError::InsideSource { .. }));
        check(&mut out, "Guard: write into indexed root refused", refused, p);
    }
    check(&mut out, "Guard: write outside own folders refused", g.check(Path::new(r"C:\Windows\tracepoint.txt")).is_err(), r"C:\Windows\tracepoint.txt");
    check(&mut out, "Guard: THOR can't be made a data folder", g.allow(Path::new(r"\\thor\Equipment Files\TracePoint")).is_err(), r"\\thor\Equipment Files\TracePoint");
    let w = g.write(&tmp.join("probe.txt"), b"ok").is_ok() && std::fs::read(tmp.join("probe.txt")).map(|b| b == b"ok").unwrap_or(false);
    check(&mut out, "Guard: atomic write in own folder works", w, "probe.txt");

    // ── Who you are, and permissions ─────────────────────────────────
    let me = crate::acl::current_user();
    check(&mut out, "Identity: Windows account (no TracePoint passwords)", !me.sid.is_empty(), format!("{} ({})", me.account, me.sid));
    // A real lock on a real folder: set it, read it back from a file inside.
    let lockdir = tmp.join("lock-test");
    let _ = g.create_dir_all(&lockdir);
    let want = crate::acl::ReadAccess::parse_fingerprint(&format!("A:{}", me.sid));
    let locked = crate::acl::lock_folder(&lockdir.to_string_lossy(), &want.index_folder_sddl(&me.sid));
    check(&mut out, "Permissions: TracePoint can lock a folder it created", locked.is_ok(), locked.err().unwrap_or_else(|| "protected, inheritance off".into()));
    let f = lockdir.join("index.db");
    let _ = std::fs::write(&f, b"x");
    let cache = std::sync::Mutex::new(std::collections::HashMap::new());
    let back = crate::acl::read_access(&f.to_string_lossy(), &cache).and_then(|got| crate::acl::same_readers(&want, &got, &me.sid));
    check(&mut out, "Permissions: a file in it carries exactly that lock", back.is_ok(), back.err().unwrap_or_else(|| "read back from Windows".into()));
    check(&mut out, "Permissions: Windows says you may open it", crate::acl::can_open(&f) == crate::acl::Access::Allowed, "");

    // ── Scan → split by permissions → merge → search ────────────────
    let thor = tmp.join("thor");
    let inspections = thor.join("1000 - TEST UNIT").join("10 - VESSELS").join("1234.56 V-1 Test Receiver").join("INSPECTIONS");
    if g.create_dir_all(&inspections).is_ok() && g.write(&inspections.join("1234.56 UT Survey 2022.pdf"), b"%PDF-1.4").is_ok() {
        let root = thor.to_string_lossy().replace('/', "\\");
        let master = tmp.join("master.db");
        let scanned = rusqlite::Connection::open(&master).map_err(|e| e.to_string()).and_then(|mut c| {
            let opts = crate::crawl::Options { workers: 2, cancel: Default::default(), permissions: true };
            crate::crawl::scan(&mut c, &root, &opts, &|_| {})
        });
        check(&mut out, "Scan: reads files and their permissions (read-only)", scanned.as_ref().map(|s| s.progress.files == 1).unwrap_or(false), scanned.as_ref().map(|s| s.status.clone()).unwrap_or_else(|e| e.clone()));
        let classes = rusqlite::Connection::open(&master).map(|c| crate::partition::classes(&c)).unwrap_or_default();
        check(&mut out, "Scan: file grouped by who may read it", classes.len() == 1, format!("{} group(s)", classes.len()));
        if let Some((class, ..)) = classes.first() {
            let part = tmp.join("group.db");
            let split = crate::partition::split_index(&master, class, &part);
            let mem = rusqlite::Connection::open_in_memory().unwrap();
            let merged = split.and_then(|_| crate::partition::merge(&[part], &mem)).and_then(|_| Index::load_conn(&mem));
            match merged {
                Ok(idx) => {
                    let e = Engine::new(idx);
                    let r = e.search(&SearchRequest { query: "1234.56 inspection".into(), limit: 5, ..Default::default() });
                    check(&mut out, "Search: finds it through the shared-index path", r.total == 1, format!("{} result(s)", r.total));
                }
                Err(err) => check(&mut out, "Search: finds it through the shared-index path", false, err),
            }
        }
    }
    let _ = std::fs::remove_dir_all(&tmp);
    out
}

/// The real thing on the file server: in `folder` (default \\thor\Public\TP),
/// create a test folder, lock it, write a file, read the lock back from the
/// server, then delete it all. Shows who the server thinks you are.
pub fn run_share(folder: &Path) -> Vec<Check> {
    let mut out = Vec::new();
    let me = crate::acl::current_user();
    if !folder.is_dir() {
        check(&mut out, "Shared folder: reachable", false, format!("{} — not reachable from this PC", folder.display()));
        return out;
    }
    let g = Guard::new(None);
    if g.allow(folder).is_err() {
        check(&mut out, "Shared folder: usable", false, folder.display().to_string());
        return out;
    }
    let writer = crate::acl::server_identity(&folder.to_string_lossy(), &me);
    check(&mut out, "Shared folder: the server knows you as", crate::acl::is_person_sid(&writer), format!("{writer}{}", if writer != me.sid { format!(" (this PC signs you in as {})", me.sid) } else { String::new() }));
    let dir = folder.join(format!("tp-selftest-{}", std::process::id()));
    let p = dir.to_string_lossy().to_string();
    let want = crate::acl::ReadAccess::parse_fingerprint(&format!("A:{writer}"));
    let sddl = want.index_folder_sddl(&writer);
    let made = crate::acl::create_locked_dir(&p, &sddl);
    check(&mut out, "Shared folder: create a locked folder", made.is_ok(), made.clone().err().unwrap_or_else(|| "locked as it was created".into()));
    if made.is_ok() {
        let f = dir.join("index.db");
        let wrote = std::fs::write(&f, b"x");
        check(&mut out, "Shared folder: you can write into it", wrote.is_ok(), wrote.err().map(|e| e.to_string()).unwrap_or_default());
        let cache = std::sync::Mutex::new(std::collections::HashMap::new());
        let back = crate::acl::read_access(&f.to_string_lossy(), &cache).and_then(|got| crate::acl::same_readers(&want, &got, &writer));
        check(&mut out, "Shared folder: only you can read it (from the server)", back.is_ok(), back.err().unwrap_or_else(|| "read back from the server".into()));
        // Changing a lock later: only needed when giving someone a role.
        let relock = crate::acl::lock_folder(&p, &sddl);
        check(&mut out, "Shared folder: change permissions later (optional)", true, match relock {
            Ok(()) => "yes — role changes update the folder automatically".into(),
            Err(e) => format!("no ({e}) — when you give someone a role, IT adds them to the folder"),
        });
    }
    let removed = if dir.exists() { std::fs::remove_dir_all(&dir) } else { Ok(()) };
    check(&mut out, "Shared folder: test folder removed", removed.is_ok(), removed.err().map(|e| e.to_string()).unwrap_or_else(|| p.clone()));
    out
}

/// Document reading: the embedded PDF engine opens and reads a test PDF, and
/// Windows OCR is reported (not required: scanned pages are then skipped).
pub fn run_content(pdfium: Option<&std::path::Path>) -> Vec<Check> {
    let mut out = Vec::new();
    let ex = crate::content::Extractor::new(pdfium, true);
    check(&mut out, "Contents: PDF engine loads", ex.has_pdf(), ex.pdfium_error.clone().unwrap_or_else(|| "PDFium 157.0.8100".into()));
    if ex.has_pdf() {
        let x = ex.extract(crate::content::minimal_pdf("Minimum thickness 0.312 at nozzle N3"), ".pdf", 0);
        check(&mut out, "Contents: reads PDF text", x.pages.first().map(|p| p.text.contains("thickness")).unwrap_or(false), "in memory; no file written");
    }
    check(&mut out, "Contents: Windows OCR available", true, if ex.has_ocr() { "yes — scanned pages are read locally" } else { "no — scanned pages will be listed as unreadable" });
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn share_check_runs_clean() {
        let d = std::env::temp_dir().join(format!("tp-share-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let out = super::run_share(&d);
        for c in &out {
            assert!(c.ok, "{}: {}", c.name, c.detail);
        }
        assert!(std::fs::read_dir(&d).unwrap().next().is_none(), "test folder removed");
        let _ = std::fs::remove_dir_all(&d);
    }
}
