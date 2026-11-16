//! Who you are and what TracePoint lets you do.
//!
//! * No TracePoint passwords. You are the Windows account that started the
//!   program; Windows already checked who you are when you signed in.
//! * Roles (Admin, Indexer; everyone else is a User) are a list of Windows
//!   accounts in `roles.json` in the shared TracePoint folder. Only accounts
//!   Windows lets write there (administrators and indexers, set by TracePoint
//!   with the folder's permissions) can change it.
//! * TracePoint contains no AI and stores no keys or passwords.
//! * The activity log lives in `admin\` in the shared folder, which only
//!   administrators and indexers can open.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Admin,
    Indexer,
    User,
}

impl Role {
    pub fn parse(s: &str) -> Option<Role> {
        match s.to_ascii_lowercase().as_str() {
            "admin" => Some(Role::Admin),
            "indexer" => Some(Role::Indexer),
            "user" => Some(Role::User),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Admin => "admin",
            Role::Indexer => "indexer",
            Role::User => "user",
        }
    }
    pub fn can_rescan(self) -> bool {
        matches!(self, Role::Admin | Role::Indexer)
    }
}

/// The signed-in person, as the interface sees them.
#[derive(Clone, Debug, Serialize)]
pub struct UserInfo {
    /// Windows SID.
    pub id: String,
    /// DOMAIN\user
    pub account: String,
    pub name: String,
    pub role: Role,
}

pub struct Session {
    pub user: UserInfo,
}

impl Session {
    pub fn is_admin(&self) -> bool {
        self.user.role == Role::Admin
    }
}

#[derive(Debug)]
pub struct AuthError(pub String);

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<rusqlite::Error> for AuthError {
    fn from(e: rusqlite::Error) -> Self {
        AuthError(format!("Activity log error: {e}"))
    }
}

fn err<T>(m: impl Into<String>) -> Result<T, AuthError> {
    Err(AuthError(m.into()))
}

pub fn now() -> String {
    // RFC 3339 UTC without external crates.
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    format_utc(secs)
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

pub fn format_utc(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, m, d, rem / 3600, (rem % 3600) / 60, rem % 60)
}

// ── Roles ─────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Member {
    pub sid: String,
    pub account: String,
    pub role: Role,
    /// Other SIDs for the same person (an Entra ID sign-in SID).
    #[serde(default)]
    pub also: Vec<String>,
    #[serde(default)]
    pub added_by: String,
    #[serde(default)]
    pub added_at: String,
}

/// roles.json: who administers TracePoint, and team-wide settings.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Roster {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub members: Vec<Member>,
    #[serde(default)]
    pub policy: BTreeMap<String, String>,
}

impl Roster {
    pub fn load(path: &Path) -> Result<Option<Roster>, String> {
        match std::fs::read(path) {
            Ok(b) => serde_json::from_slice(&b).map(Some).map_err(|e| format!("{} is damaged: {e}", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("Can't read {}: {e}", path.display())),
        }
    }
    /// This person's entry: by any of their SIDs, else by DOMAIN\user
    /// (a cloud-joined PC whose domain SID couldn't be looked up).
    pub fn find(&self, me: &crate::acl::Identity) -> Option<&Member> {
        let mine = me.all_sids();
        self.members
            .iter()
            .find(|m| mine.contains(&m.sid) || m.also.iter().any(|a| mine.contains(a)))
            .or_else(|| self.members.iter().find(|m| m.account.contains('\\') && m.account.eq_ignore_ascii_case(&me.account)))
    }
    pub fn role_of(&self, me: &crate::acl::Identity) -> Role {
        self.find(me).map(|m| m.role).unwrap_or(Role::User)
    }
    pub fn sids(&self, role: Role) -> Vec<String> {
        self.members.iter().filter(|m| m.role == role).map(|m| m.sid.clone()).collect()
    }
}

// ── Per-person settings on this PC ───────────────────────────────────────

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct LocalPrefs {
    #[serde(default)]
    prefs: BTreeMap<String, String>,
    /// Keys saved by older versions (AI). Never used; wiped on open.
    #[serde(default, skip_serializing)]
    secrets: BTreeMap<String, String>,
}

const SCHEMA: &str = "
create table if not exists audit(id integer primary key, at text not null, actor text, action text not null, detail text, machine text);
";

/// Roles, this person's settings and keys, and (for administrators and
/// indexers) the shared activity log.
pub struct UserStore {
    me: crate::acl::Identity,
    /// roles.json — in the team folder, or on this PC when there is none.
    roster_path: PathBuf,
    roster: Roster,
    local: PathBuf,
    prefs: LocalPrefs,
    activity_path: PathBuf,
    activity: Option<Connection>,
    /// No team folder: this PC only, and whoever runs it administers it.
    standalone: bool,
}

impl UserStore {
    /// `team`: the shared TracePoint folder, when there is one.
    pub fn open(me: crate::acl::Identity, local: &Path, team: Option<&Path>) -> Result<UserStore, AuthError> {
        let (roster_path, activity_path, standalone) = match team {
            Some(t) => (t.join("roles.json"), t.join("admin").join("activity.db"), false),
            None => (local.join("roles.json"), local.join("activity.db"), true),
        };
        let roster = Roster::load(&roster_path).map_err(AuthError)?.unwrap_or_default();
        let prefs: LocalPrefs = std::fs::read(local.join("prefs.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let mut s = UserStore { me, roster_path, roster, local: local.to_path_buf(), prefs, activity_path, activity: None, standalone };
        // Keys an older version saved (AI): wiped from disk.
        if !s.prefs.secrets.is_empty() {
            s.prefs.secrets.clear();
            let _ = s.save_prefs();
        }
        if standalone && s.roster.members.is_empty() {
            // This PC only: the person running it administers it.
            s.roster.members.push(Member { sid: s.me.sid.clone(), account: s.me.account.clone(), role: Role::Admin, also: s.me.also.clone(), added_by: "first run".into(), added_at: now() });
            let _ = s.save_roster();
        }
        Ok(s)
    }

    pub fn open_in_memory(me: crate::acl::Identity, role: Role) -> UserStore {
        let roster = Roster { version: 1, members: vec![Member { sid: me.sid.clone(), account: me.account.clone(), role, also: vec![], added_by: "test".into(), added_at: now() }], policy: BTreeMap::new() };
        UserStore {
            me,
            roster_path: PathBuf::new(),
            roster,
            local: PathBuf::new(),
            prefs: LocalPrefs::default(),
            activity_path: PathBuf::new(),
            activity: Connection::open_in_memory().ok().and_then(|c| c.execute_batch(SCHEMA).ok().map(|_| c)),
            standalone: true,
        }
    }

    pub fn me(&self) -> &crate::acl::Identity {
        &self.me
    }
    pub fn roster(&self) -> &Roster {
        &self.roster
    }
    pub fn roster_path(&self) -> &Path {
        &self.roster_path
    }

    /// Re-read roles.json (someone else may have changed it).
    pub fn refresh(&mut self) {
        if let Ok(Some(r)) = Roster::load(&self.roster_path) {
            self.roster = r;
        }
    }

    pub fn session(&self) -> Session {
        let role = self.roster.role_of(&self.me);
        Session {
            user: UserInfo { id: self.me.sid.clone(), account: self.me.account.clone(), name: self.me.display.clone(), role },
        }
    }

    fn save_roster(&self) -> Result<(), AuthError> {
        if self.roster_path.as_os_str().is_empty() {
            return Ok(());
        }
        let body = serde_json::to_vec_pretty(&self.roster).unwrap();
        let tmp = self.roster_path.with_extension("json.tp-tmp");
        std::fs::write(&tmp, &body).and_then(|_| std::fs::rename(&tmp, &self.roster_path)).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            AuthError(format!("Windows didn't let you change the TracePoint roles ({e}). Only TracePoint administrators can."))
        })
    }

    fn require_admin(&self) -> Result<(), AuthError> {
        if self.roster.role_of(&self.me) != Role::Admin {
            return err("Only a TracePoint administrator can do that.");
        }
        Ok(())
    }

    /// Start a new shared setup with `founder` (this person, as the file
    /// server knows them) as its first administrator.
    pub fn found_team(&mut self, roster_path: PathBuf, activity_path: PathBuf, founder: Member) -> Result<(), AuthError> {
        self.roster = Roster { version: 1, members: vec![founder], policy: BTreeMap::new() };
        self.roster_path = roster_path;
        self.activity_path = activity_path;
        self.activity = None;
        self.standalone = false;
        self.save_roster()
    }

    /// Give a Windows account a role ("user" removes it from the list).
    pub fn set_member(&mut self, who: &crate::acl::Identity, role: Role) -> Result<(), AuthError> {
        self.require_admin()?;
        self.refresh();
        let before = self.roster.clone();
        let me_entry = self.roster.find(&self.me).map(|m| m.sid.clone());
        if (who.sid == self.me.sid || Some(&who.sid) == me_entry.as_ref()) && role != Role::Admin {
            return err("You can't remove your own administrator role. Ask another administrator.");
        }
        self.roster.members.retain(|m| m.sid != who.sid);
        if role != Role::User {
            let also = before.members.iter().find(|m| m.sid == who.sid).map(|m| m.also.clone()).unwrap_or_else(|| who.also.clone());
            self.roster.members.push(Member { sid: who.sid.clone(), account: who.account.clone(), role, also, added_by: self.me.account.clone(), added_at: now() });
        }
        if self.roster.sids(Role::Admin).is_empty() {
            self.roster = before;
            return err("At least one administrator must remain.");
        }
        if let Err(e) = self.save_roster() {
            self.roster = before;
            return Err(e);
        }
        self.audit("role_changed", &format!("{} → {}", who.account, role.as_str()))?;
        Ok(())
    }

    pub fn list(&self) -> Vec<Member> {
        self.roster.members.clone()
    }

    // ── Settings on this PC ────────────────────────────────────────────
    fn save_prefs(&self) -> Result<(), AuthError> {
        if self.local.as_os_str().is_empty() {
            return Ok(());
        }
        let p = self.local.join("prefs.json");
        std::fs::write(&p, serde_json::to_vec_pretty(&self.prefs).unwrap()).map_err(|e| AuthError(format!("Can't save your settings: {e}")))
    }


    pub fn set_pref(&mut self, key: &str, value: &str) -> Result<(), AuthError> {
        self.prefs.prefs.insert(key.to_string(), value.to_string());
        self.save_prefs()
    }

    pub fn prefs(&self) -> Vec<(String, String)> {
        self.prefs.prefs.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    // ── Team policy (in roles.json) ─────────────────────────────────────
    pub fn policy(&self, key: &str) -> Option<String> {
        self.roster.policy.get(key).cloned()
    }

    pub fn set_policy(&mut self, key: &str, value: &str) -> Result<(), AuthError> {
        self.require_admin()?;
        self.refresh();
        let before = self.roster.clone();
        self.roster.policy.insert(key.to_string(), value.to_string());
        if let Err(e) = self.save_roster() {
            self.roster = before;
            return Err(e);
        }
        let _ = self.audit("policy_changed", &format!("{key} = {value}"));
        Ok(())
    }

    // ── Activity log (administrators and indexers) ─────────────────────
    fn activity(&mut self) -> Result<&Connection, AuthError> {
        if self.activity.is_none() {
            if !self.roster.role_of(&self.me).can_rescan() {
                return err("The activity log is for administrators and indexers.");
            }
            if let Some(d) = self.activity_path.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            let c = Connection::open(&self.activity_path).map_err(|e| AuthError(format!("Can't open the activity log: {e}")))?;
            c.busy_timeout(std::time::Duration::from_secs(8))?;
            // Rollback journal, not WAL: safe on a network share.
            c.pragma_update(None, "journal_mode", "DELETE")?;
            c.execute_batch(SCHEMA)?;
            self.activity = Some(c);
        }
        Ok(self.activity.as_ref().unwrap())
    }

    pub fn audit(&mut self, action: &str, detail: &str) -> Result<(), AuthError> {
        let actor = self.me.account.clone();
        let machine = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default();
        let c = self.activity()?;
        c.execute("insert into audit(at,actor,action,detail,machine) values(?1,?2,?3,?4,?5)", params![now(), actor, action, detail, machine])?;
        Ok(())
    }

    pub fn audit_log(&mut self, limit: i64) -> Result<Vec<(String, Option<String>, String, Option<String>, Option<String>)>, AuthError> {
        let c = self.activity()?;
        let mut st = c.prepare("select at,actor,action,detail,machine from audit order by id desc limit ?1")?;
        let rows = st.query_map([limit], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn standalone(&self) -> bool {
        self.standalone
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acl::Identity;

    fn id(n: &str, sid: &str) -> Identity {
        Identity { sid: sid.into(), account: format!("KERN\\{n}"), display: n.into(), also: vec![] }
    }

    #[test]
    fn roles_by_windows_account() {
        let dir = std::env::temp_dir().join(format!("tp-auth-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let (local, team) = (dir.join("local"), dir.join("team"));
        std::fs::create_dir_all(&local).unwrap();
        std::fs::create_dir_all(team.join("admin")).unwrap();
        // First person sets up the shared folder: administrator.
        let mut a = UserStore::open(id("ggetzfrid", "S-1-5-21-1-1"), &local, Some(&team)).unwrap();
        assert_eq!(a.session().user.role, Role::User, "nobody is admin of a folder they didn't set up");
        let founder = Member { sid: "S-1-5-21-1-1".into(), account: "KERN\\ggetzfrid".into(), role: Role::Admin, also: vec![], added_by: String::new(), added_at: String::new() };
        a.found_team(team.join("roles.json"), team.join("admin").join("activity.db"), founder).unwrap();
        assert_eq!(a.session().user.role, Role::Admin);
        a.set_member(&id("tech", "S-1-5-21-1-2"), Role::Indexer).unwrap();
        // Another person on another PC: roles from the same file.
        let mut b = UserStore::open(id("tech", "S-1-5-21-1-2"), &dir.join("local2"), Some(&team)).unwrap();
        assert_eq!(b.session().user.role, Role::Indexer);
        assert!(b.set_member(&id("x", "S-1-5-21-1-3"), Role::Admin).is_err(), "indexers can't hand out roles");
        let c = UserStore::open(id("operator", "S-1-5-21-1-9"), &dir.join("local3"), Some(&team)).unwrap();
        assert_eq!(c.session().user.role, Role::User);
        // Can't remove the last admin or yourself.
        assert!(a.set_member(&id("ggetzfrid", "S-1-5-21-1-1"), Role::User).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cloud_signin_matches_domain_entry() {
        let r = Roster { version: 1, members: vec![Member { sid: "S-1-5-21-7-7-7-1001".into(), account: "KERNOIL\\ggetzfrid".into(), role: Role::Admin, also: vec![], added_by: String::new(), added_at: String::new() }], policy: BTreeMap::new() };
        // Domain SID looked up on a cloud-joined PC.
        let me = Identity { sid: "S-1-5-21-7-7-7-1001".into(), account: "KERNOIL\\ggetzfrid".into(), display: "ggetzfrid".into(), also: vec!["S-1-12-1-1-2-3-4".into()] };
        assert_eq!(r.role_of(&me), Role::Admin);
        // Lookup failed: only the cloud SID, same domain account name.
        let cloud = Identity { sid: "S-1-12-1-1-2-3-4".into(), account: "KERNOIL\\ggetzfrid".into(), display: "ggetzfrid".into(), also: vec![] };
        assert_eq!(r.role_of(&cloud), Role::Admin);
        let other = Identity { sid: "S-1-12-1-9".into(), account: "KERNOIL\\someone".into(), display: "x".into(), also: vec![] };
        assert_eq!(r.role_of(&other), Role::User);
        // Added by name only (the admin's PC couldn't look the account up).
        let mut r2 = r.clone();
        r2.members.push(Member { sid: "account:kernoil\\jsmith".into(), account: "KERNOIL\\jsmith".into(), role: Role::Indexer, also: vec![], added_by: String::new(), added_at: String::new() });
        let js = Identity { sid: "S-1-12-1-55".into(), account: "KERNOIL\\JSmith".into(), display: "JSmith".into(), also: vec![] };
        assert_eq!(r2.role_of(&js), Role::Indexer);
    }

    #[test]
    fn standalone_runner_is_admin() {
        let dir = std::env::temp_dir().join(format!("tp-auth-sa-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let s = UserStore::open(id("solo", "S-1-5-21-7"), &dir, None).unwrap();
        assert_eq!(s.session().user.role, Role::Admin);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dates() {
        assert_eq!(format_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_utc(1_792_022_400), "2026-10-15T00:00:00Z");
    }
}
