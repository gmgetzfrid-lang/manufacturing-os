//! The shared TracePoint folder (default \\thor\Public\TP\TracePoint Data).
//!
//! ```text
//! TracePoint Data\            locked: administrators full, indexers modify, everyone signed in: read
//!   tracepoint.json           "a TracePoint setup lives here" (written last)
//!   roles.json                Windows accounts with the Admin / Indexer role
//!   index\manifest.json       which group folder is current (no file names)
//!   index\g-<id>-<time>\      one per lock group, locked like the THOR files it lists
//!       index.db              those files' names and links
//!       content.db            their document text
//!   admin\                    administrators and indexers only: activity log, AI ledger, scan lock
//! ```
//!
//! Every folder lock is read back after it is set; if the file server didn't
//! store exactly what was asked, nothing is shared from that folder.

use crate::acl::{self, ReadAccess};
use crate::guard::Guard;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const MARKER: &str = "tracepoint.json";
pub const DEFAULT_TEAM: &str = r"\\thor\Public\TP\TracePoint Data";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct GroupEntry {
    /// Lock group id (a hash; names nothing).
    pub class: String,
    /// Source root id (a hash).
    pub root: String,
    pub folder: String,
    pub updated: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Manifest {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub updated: String,
    #[serde(default)]
    pub by: String,
    #[serde(default)]
    pub groups: Vec<GroupEntry>,
}

pub fn is_setup(team: &Path) -> bool {
    team.join(MARKER).is_file()
}

pub fn read_manifest(team: &Path) -> Result<Manifest, String> {
    match std::fs::read(team.join("index").join("manifest.json")) {
        Ok(b) => serde_json::from_slice(&b).map_err(|e| format!("The shared index list is damaged: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Manifest::default()),
        Err(e) => Err(format!("Can't read the shared index list: {e}")),
    }
}

/// Files earlier TracePoint versions put in a shared folder without
/// per-folder permissions (a full index, a password database). Removed when
/// an administrator sets up or joins, so no unprotected copy is left behind.
pub fn remove_legacy(guard: &Guard, team: &Path) -> Vec<String> {
    let mut removed = Vec::new();
    for dir in std::iter::once(team).chain(team.parent()) {
        let candidates = [
            dir.join("index").join("thor_knowledge.db"),
            dir.join("index").join("thor_content.db"),
            dir.join("index").join("thor_content.json"),
            dir.join("TracePoint_Profiles.db"),
        ];
        let mut found: Vec<PathBuf> = candidates.into_iter().filter(|p| p.is_file()).collect();
        if let Ok(rd) = std::fs::read_dir(dir.join("index")) {
            found.extend(rd.flatten().map(|e| e.path()).filter(|p| p.file_name().and_then(|n| n.to_str()).map(|n| n.starts_with("thor_content-") && n.ends_with(".db")).unwrap_or(false)));
        }
        for p in found {
            if guard.allow(p.parent().unwrap_or(dir)).is_ok() && guard.remove_own_file(&p).is_ok() {
                removed.push(p.display().to_string());
            }
        }
    }
    removed
}

/// The access list for the shared folder itself and for admin\.
fn folder_locks(roster: &crate::auth::Roster) -> (String, String) {
    use crate::auth::Role;
    let admins = roster.sids(Role::Admin);
    let indexers = roster.sids(Role::Indexer);
    (acl::team_folder_sddl(&admins, &indexers, &[acl::SID_AUTHENTICATED_USERS]), acl::team_folder_sddl(&admins, &indexers, &[]))
}

/// Re-apply the shared folder's locks for the current roles.
pub fn apply_locks(team: &Path, roster: &crate::auth::Roster) -> Result<(), String> {
    let (top, admin) = folder_locks(roster);
    acl::lock_folder(&team.to_string_lossy(), &top).map_err(|e| format!("Couldn't set permissions on {}: {e}", team.display()))?;
    acl::lock_folder(&team.join("admin").to_string_lossy(), &admin).map_err(|e| format!("Couldn't set permissions on {}\\admin: {e}", team.display()))?;
    Ok(())
}

/// First-time setup of the shared folder. `found` writes roles.json (the
/// caller's account becomes the first administrator).
pub fn setup(guard: &Guard, team: &Path, by: &str, roster_for_locks: &crate::auth::Roster, found: &mut dyn FnMut() -> Result<(), String>) -> Result<(), String> {
    guard.allow(team).map_err(|e| e.to_string())?;
    guard.create_dir_all(team).map_err(|e| format!("Can't create {} — you need write access there: {e}", team.display()))?;
    guard.create_dir_all(&team.join("index")).map_err(|e| e.to_string())?;
    guard.create_dir_all(&team.join("admin")).map_err(|e| e.to_string())?;
    apply_locks(team, roster_for_locks)?;
    found()?;
    let marker = serde_json::json!({"product": "TracePoint", "created": crate::auth::now(), "by": by, "version": crate::service::VERSION});
    guard.write(&team.join(MARKER), marker.to_string().as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Refused {
    pub group: String,
    pub files: i64,
    pub reason: String,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Published {
    pub at: String,
    pub groups: usize,
    pub files: usize,
    /// Groups readable by everyone signed in (Everyone, Domain Users…): worth
    /// a look by IT in case a share is restricted by share permissions only.
    pub open_to_everyone: usize,
    pub refused: Vec<Refused>,
    /// Files whose permissions couldn't be read (kept out of the shared index).
    pub unreadable: i64,
}

fn write_locked_copy(from: &Path, to: &Path) -> Result<(), String> {
    // A plain create + copy: the new file takes the folder's lock.
    let mut src = std::fs::File::open(from).map_err(|e| e.to_string())?;
    let mut dst = std::fs::File::create(to).map_err(|e| e.to_string())?;
    std::io::copy(&mut src, &mut dst).map_err(|e| e.to_string())?;
    dst.sync_all().map_err(|e| e.to_string())?;
    Ok(())
}

/// Share an administrator's index (and document text) as lock-group files.
/// Groups of roots this index didn't fully cover keep their current files.
#[allow(clippy::too_many_arguments)]
pub fn publish(guard: &Guard, team: &Path, me: &acl::Identity, master: &Path, content_master: Option<&Path>, scratch: &Path, log: &dyn Fn(String)) -> Result<Published, String> {
    let c = rusqlite::Connection::open_with_flags(master, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
    let classes = crate::partition::classes(&c);
    // A root is "complete" when every folder was listed and every file's
    // permissions were read; only then may its old groups be dropped.
    let roots: Vec<(String, bool)> = {
        let mut st = c.prepare("select root_id from roots").map_err(|e| e.to_string())?;
        let ids: Vec<String> = st.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?.flatten().collect();
        ids.into_iter()
            .map(|r| {
                let status: Option<String> = c.query_row("select status from crawls where root_id=?1 order by started_at desc limit 1", [&r], |x| x.get(0)).ok();
                let unread: i64 = c
                    .query_row("select count(*) from files f left join tp_file_access a using(file_id) where f.root_id=?1 and f.observation_state='current' and a.class is null", [&r], |x| x.get(0))
                    .unwrap_or(1);
                (r, status.as_deref() == Some("inventory_complete") && unread == 0)
            })
            .collect()
    };
    let unreadable: i64 = c
        .query_row("select count(*) from files f left join tp_file_access a using(file_id) where f.observation_state='current' and a.class is null", [], |x| x.get(0))
        .unwrap_or(0);
    drop(c);
    if classes.is_empty() {
        return Err("This index has no permission information yet. Run a rescan first — TracePoint reads each file's Windows permissions during the scan.".into());
    }
    let mut report = Published { at: crate::auth::now(), unreadable, ..Default::default() };
    let stamp: String = crate::auth::now().chars().filter(|c| c.is_ascii_digit()).collect();
    let index_dir = team.join("index");
    guard.create_dir_all(&index_dir).map_err(|e| e.to_string())?;
    guard.create_dir_all(scratch).map_err(|e| e.to_string())?;
    let mut fresh: Vec<GroupEntry> = Vec::new();
    for (class, root, readers, broad, files) in &classes {
        let ra = ReadAccess::parse_fingerprint(readers);
        let short = &class[class.len().saturating_sub(12)..];
        let folder = format!("g-{short}-{stamp}");
        let dir = index_dir.join(&folder);
        let refuse = |reason: String, report: &mut Published| {
            let _ = std::fs::remove_dir_all(&dir);
            log(format!("Not shared: a group of {files} files — {reason}"));
            report.refused.push(Refused { group: short.to_string(), files: *files, reason });
        };
        let tmp_index = scratch.join(format!("{short}.index.db"));
        let tmp_content = scratch.join(format!("{short}.content.db"));
        if let Err(e) = crate::partition::split_index(master, class, &tmp_index) {
            refuse(e, &mut report);
            continue;
        }
        let has_content = match content_master.filter(|p| p.is_file()) {
            Some(cm) => match crate::partition::split_content(cm, master, class, &tmp_content) {
                Ok(_) => true,
                Err(e) => {
                    log(format!("Document text for a group couldn't be prepared ({e}); sharing names only."));
                    false
                }
            },
            None => false,
        };
        if let Err(e) = guard.create_dir_all(&dir) {
            refuse(e.to_string(), &mut report);
            continue;
        }
        if let Err(e) = acl::lock_folder(&dir.to_string_lossy(), &ra.index_folder_sddl(&me.sid)) {
            refuse(e, &mut report);
            continue;
        }
        let mut ok = true;
        for (tmp, name) in [(&tmp_index, "index.db"), (&tmp_content, "content.db")] {
            if name == "content.db" && !has_content {
                continue;
            }
            let dest = dir.join(name);
            if let Err(e) = guard.check(&dest).map_err(|e| e.to_string()).and_then(|_| write_locked_copy(tmp, &dest)) {
                refuse(format!("couldn't write the file: {e}"), &mut report);
                ok = false;
                break;
            }
            // Read the lock back from the file itself.
            let cache = std::sync::Mutex::new(std::collections::HashMap::new());
            match acl::read_access(&dest.to_string_lossy(), &cache).and_then(|got| acl::same_readers(&ra, &got, &me.sid)) {
                Ok(()) => {}
                Err(e) => {
                    refuse(format!("the permissions on the shared copy didn't come out right ({e})"), &mut report);
                    ok = false;
                    break;
                }
            }
        }
        let _ = std::fs::remove_file(&tmp_index);
        let _ = std::fs::remove_file(&tmp_content);
        if !ok {
            continue;
        }
        report.groups += 1;
        report.files += *files as usize;
        if *broad {
            report.open_to_everyone += 1;
        }
        fresh.push(GroupEntry { class: class.clone(), root: root.clone(), folder, updated: crate::auth::now() });
    }
    // New list: other roots untouched; complete roots replaced; partial
    // roots keep any group this index couldn't produce.
    let old = read_manifest(team).unwrap_or_default();
    let fresh_classes: std::collections::HashSet<&str> = fresh.iter().map(|g| g.class.as_str()).collect();
    let mut groups: Vec<GroupEntry> = old
        .groups
        .iter()
        .filter(|g| match roots.iter().find(|(r, _)| *r == g.root) {
            None => true,
            Some((_, complete)) => !complete && !fresh_classes.contains(g.class.as_str()),
        })
        .cloned()
        .collect();
    groups.extend(fresh);
    let m = Manifest { version: 1, updated: crate::auth::now(), by: me.account.clone(), groups };
    guard.write(&index_dir.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap().as_slice()).map_err(|e| e.to_string())?;
    // Tidy group folders nothing points to (ones still open elsewhere, or
    // published by someone else's account, are left for later).
    let keep: std::collections::HashSet<String> = m.groups.iter().map(|g| g.folder.clone()).collect();
    if let Ok(rd) = std::fs::read_dir(&index_dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with("g-") && !keep.contains(&name) && e.path().is_dir() {
                let _ = guard.remove_own_dir(&e.path());
            }
        }
    }
    Ok(report)
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Loaded {
    #[serde(skip)]
    pub parts: Vec<PathBuf>,
    #[serde(skip)]
    pub content: Vec<PathBuf>,
    /// Groups this PC loaded.
    pub open: usize,
    /// Groups Windows wouldn't open for this account.
    pub locked: usize,
    /// Groups whose THOR files this account can't open right now (share
    /// permissions, or permissions changed since the last scan).
    pub hidden: usize,
    /// Groups that couldn't be checked (network).
    pub unavailable: usize,
}

/// Open every group this Windows account may open, check a few of its THOR
/// files with Windows on this PC, and copy it to the local cache.
pub fn load_groups(guard: &Guard, team: &Path, cache: &Path) -> Result<Loaded, String> {
    use rayon::prelude::*;
    let m = read_manifest(team)?;
    guard.create_dir_all(cache).map_err(|e| e.to_string())?;
    #[derive(PartialEq)]
    enum Out {
        Open(PathBuf, Option<PathBuf>),
        Locked,
        Hidden,
        Unavailable,
    }
    let results: Vec<(String, Out)> = m
        .groups
        .par_iter()
        .map(|g| {
            let dir = team.join("index").join(&g.folder);
            let db = dir.join("index.db");
            match acl::can_open(&db) {
                acl::Access::Allowed => {}
                acl::Access::Denied => return (g.folder.clone(), Out::Locked),
                _ => return (g.folder.clone(), Out::Unavailable),
            }
            let local = cache.join(format!("{}.db", g.folder));
            let fresh = match (std::fs::metadata(&db), std::fs::metadata(&local)) {
                (Ok(a), Ok(b)) => a.len() == b.len(),
                _ => false,
            };
            if !fresh && guard.copy_into(&db, &local).is_err() {
                return (g.folder.clone(), Out::Unavailable);
            }
            let Ok((class, _readers, reps)) = crate::partition::describe(&local, 5) else {
                return (g.folder.clone(), Out::Unavailable);
            };
            if class != g.class {
                return (g.folder.clone(), Out::Unavailable);
            }
            let checks: Vec<acl::Access> = reps.iter().map(|p| acl::probe(p, false)).collect();
            if checks.contains(&acl::Access::Denied) {
                return (g.folder.clone(), Out::Hidden);
            }
            if !checks.contains(&acl::Access::Allowed) {
                return (g.folder.clone(), if checks.iter().all(|c| *c == acl::Access::Unknown) { Out::Unavailable } else { Out::Hidden });
            }
            let content = Some(dir.join("content.db")).filter(|p| acl::can_open(p) == acl::Access::Allowed);
            (g.folder.clone(), Out::Open(local, content))
        })
        .collect();
    let mut l = Loaded::default();
    let mut keep = std::collections::HashSet::new();
    for (folder, r) in results {
        match r {
            Out::Open(p, c) => {
                keep.insert(format!("{folder}.db"));
                l.parts.push(p);
                l.content.extend(c);
                l.open += 1;
            }
            Out::Locked => l.locked += 1,
            Out::Hidden => l.hidden += 1,
            Out::Unavailable => l.unavailable += 1,
        }
    }
    // A copy of a group this account can no longer open is deleted.
    if let Ok(rd) = std::fs::read_dir(cache) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if !keep.contains(&n) {
                let _ = guard.remove_own_file(&e.path());
            }
        }
    }
    Ok(l)
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;
    use crate::auth::{Member, Role, Roster};

    #[test]
    fn locked_groups_never_reach_other_accounts() {
        acl::sim::reset();
        let dir = std::env::temp_dir().join(format!("tp-team-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // THOR: an open folder and an engineering-only folder.
        let thor = dir.join("thor");
        std::fs::create_dir_all(thor.join("Open")).unwrap();
        std::fs::create_dir_all(thor.join("Engineering")).unwrap();
        std::fs::write(thor.join("Open/5610.15 UT survey.pdf"), b"x").unwrap();
        std::fs::write(thor.join("Engineering/MOC-2291 secret.pdf"), b"y").unwrap();
        let root = thor.to_string_lossy().replace('/', "\\");
        let eng = "S-1-5-21-1-2-3-1500";
        acl::sim::set_file_sddl(&format!("{root}\\Open\\5610.15 UT survey.pdf"), "D:AI(A;ID;FA;;;AU)");
        acl::sim::set_file_sddl(&format!("{root}\\Engineering\\MOC-2291 secret.pdf"), &format!("D:PAI(A;;FA;;;{eng})(A;;FA;;;BA)"));
        // Admin scans and publishes.
        let master = dir.join("master.db");
        let mut c = rusqlite::Connection::open(&master).unwrap();
        let opts = crate::crawl::Options { workers: 2, cancel: Default::default(), permissions: true };
        crate::crawl::scan(&mut c, &root, &opts, &|_| {}).unwrap();
        drop(c);
        let guard = Guard::new(None);
        let team = dir.join("team");
        guard.allow(&team).unwrap();
        guard.allow(&dir.join("scratch")).unwrap();
        let admin = acl::Identity { sid: "S-1-5-21-1-2-3-1001".into(), account: "KERN\\admin".into(), display: "admin".into() };
        acl::sim::set_me(&admin.sid, &["S-1-5-11", eng]);
        let roster = Roster { version: 1, members: vec![Member { sid: admin.sid.clone(), account: admin.account.clone(), role: Role::Admin, can_ai: true, added_by: String::new(), added_at: String::new() }], policy: Default::default() };
        setup(&guard, &team, "KERN\\admin", &roster, &mut || Ok(())).unwrap();
        let rep = publish(&guard, &team, &admin, &master, None, &dir.join("scratch"), &|_| {}).unwrap();
        assert_eq!((rep.groups, rep.files, rep.refused.len()), (2, 2, 0));
        // An operator (not in Engineering) on another PC.
        acl::sim::set_me("S-1-5-21-1-2-3-2002", &["S-1-5-11"]);
        let cache = dir.join("cache-op");
        guard.allow(&cache).unwrap();
        let l = load_groups(&guard, &team, &cache).unwrap();
        assert_eq!((l.open, l.locked), (1, 1));
        let mem = rusqlite::Connection::open_in_memory().unwrap();
        crate::partition::merge(&l.parts, &mem).unwrap();
        let idx = crate::index::Index::load_conn(&mem).unwrap();
        assert_eq!(idx.files.len(), 1);
        assert!(idx.files.iter().all(|f| !f.name.contains("MOC")));
        assert!(idx.dirs.iter().all(|d| !d.path.contains("Engineering")), "not even the folder name");
        for p in std::fs::read_dir(&cache).unwrap().flatten() {
            assert!(!String::from_utf8_lossy(&std::fs::read(p.path()).unwrap()).contains("MOC-2291"), "nothing locked is cached on this PC");
        }
        // An engineer sees both.
        acl::sim::set_me("S-1-5-21-1-2-3-3003", &["S-1-5-11", eng]);
        let cache_e = dir.join("cache-eng");
        guard.allow(&cache_e).unwrap();
        assert_eq!(load_groups(&guard, &team, &cache_e).unwrap().open, 2);
        // The engineer's share access is pulled (or the folder relocked
        // since the scan): Windows says no on this PC, so it's hidden.
        acl::sim::deny(&format!("{root}\\Engineering\\MOC-2291 secret.pdf"));
        let l = load_groups(&guard, &team, &cache_e).unwrap();
        assert_eq!((l.open, l.hidden), (1, 1));
        assert_eq!(std::fs::read_dir(&cache_e).unwrap().count(), 1, "the hidden group's cached copy is deleted");
        acl::sim::reset();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
