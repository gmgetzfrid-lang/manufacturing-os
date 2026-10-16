//! Who you are and what TracePoint lets you do.
//!
//! * No TracePoint passwords. You are the Windows account that started the
//!   program; Windows already checked who you are when you signed in.
//! * Roles (Admin, Indexer; everyone else is a User) are a list of Windows
//!   accounts in `roles.json` in the shared TracePoint folder. Only accounts
//!   Windows lets write there (administrators and indexers, set by TracePoint
//!   with the folder's permissions) can change it.
//! * AI API keys are encrypted with Windows (DPAPI) for your account on your
//!   PC and kept in your own profile folder — never on the shared folder.
//! * The activity log and the AI spending ledger live in `admin\` in the
//!   shared folder, which only administrators and indexers can open.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

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
    pub can_ai: bool,
    pub has_ai_key: bool,
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
    #[serde(default = "yes")]
    pub can_ai: bool,
    #[serde(default)]
    pub added_by: String,
    #[serde(default)]
    pub added_at: String,
}

fn yes() -> bool {
    true
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
    pub fn role_of(&self, sid: &str) -> Role {
        self.members.iter().find(|m| m.sid == sid).map(|m| m.role).unwrap_or(Role::User)
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
    /// name → DPAPI-encrypted value, base64.
    #[serde(default)]
    secrets: BTreeMap<String, String>,
}

const SCHEMA: &str = "
create table if not exists ai_usage(
  id integer primary key,
  user_id text not null,
  account text,
  at text not null,
  month text not null,
  feature text not null,
  provider text,
  model text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  reserved_usd real not null default 0,
  cost_usd real not null default 0,
  status text not null,
  note text
);
create index if not exists ix_ai_usage_month on ai_usage(month);
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
        if standalone && s.roster.members.is_empty() {
            // This PC only: the person running it administers it.
            s.roster.members.push(Member { sid: s.me.sid.clone(), account: s.me.account.clone(), role: Role::Admin, can_ai: true, added_by: "first run".into(), added_at: now() });
            let _ = s.save_roster();
        }
        Ok(s)
    }

    pub fn open_in_memory(me: crate::acl::Identity, role: Role) -> UserStore {
        let roster = Roster { version: 1, members: vec![Member { sid: me.sid.clone(), account: me.account.clone(), role, can_ai: true, added_by: "test".into(), added_at: now() }], policy: BTreeMap::new() };
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
        let role = self.roster.role_of(&self.me.sid);
        let can_ai = self.roster.members.iter().find(|m| m.sid == self.me.sid).map(|m| m.can_ai).unwrap_or(false);
        Session {
            user: UserInfo { id: self.me.sid.clone(), account: self.me.account.clone(), name: self.me.display.clone(), role, can_ai, has_ai_key: self.prefs.secrets.contains_key("ai_key") },
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
        if self.roster.role_of(&self.me.sid) != Role::Admin {
            return err("Only a TracePoint administrator can do that.");
        }
        Ok(())
    }

    /// Start a new shared setup with this person as its first administrator.
    pub fn found_team(&mut self, roster_path: PathBuf, activity_path: PathBuf) -> Result<(), AuthError> {
        self.roster = Roster { version: 1, members: vec![Member { sid: self.me.sid.clone(), account: self.me.account.clone(), role: Role::Admin, can_ai: true, added_by: "set up the shared folder".into(), added_at: now() }], policy: BTreeMap::new() };
        self.roster_path = roster_path;
        self.activity_path = activity_path;
        self.activity = None;
        self.standalone = false;
        self.save_roster()
    }

    /// Give a Windows account a role ("user" removes it from the list).
    pub fn set_member(&mut self, who: &crate::acl::Identity, role: Role, can_ai: Option<bool>) -> Result<(), AuthError> {
        self.require_admin()?;
        self.refresh();
        let before = self.roster.clone();
        if who.sid == self.me.sid && role != Role::Admin {
            return err("You can't remove your own administrator role. Ask another administrator.");
        }
        self.roster.members.retain(|m| m.sid != who.sid);
        if role != Role::User {
            let prev_ai = before.members.iter().find(|m| m.sid == who.sid).map(|m| m.can_ai).unwrap_or(true);
            self.roster.members.push(Member { sid: who.sid.clone(), account: who.account.clone(), role, can_ai: can_ai.unwrap_or(prev_ai), added_by: self.me.account.clone(), added_at: now() });
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

    // ── Secrets (AI keys), encrypted by Windows for this account ────────
    fn save_prefs(&self) -> Result<(), AuthError> {
        if self.local.as_os_str().is_empty() {
            return Ok(());
        }
        let p = self.local.join("prefs.json");
        std::fs::write(&p, serde_json::to_vec_pretty(&self.prefs).unwrap()).map_err(|e| AuthError(format!("Can't save your settings: {e}")))
    }

    pub fn put_secret(&mut self, name: &str, value: &str) -> Result<(), AuthError> {
        use base64::Engine as _;
        let sealed = crate::acl::protect_secret(value.as_bytes(), &self.local).map_err(AuthError)?;
        self.prefs.secrets.insert(name.to_string(), base64::engine::general_purpose::STANDARD.encode(sealed));
        self.save_prefs()?;
        let _ = self.audit("secret_saved", name);
        Ok(())
    }

    pub fn get_secret(&self, name: &str) -> Result<Option<Zeroizing<String>>, AuthError> {
        use base64::Engine as _;
        let Some(b) = self.prefs.secrets.get(name) else { return Ok(None) };
        let raw = base64::engine::general_purpose::STANDARD.decode(b).map_err(|_| AuthError("Saved key is damaged; paste it again.".into()))?;
        let v = crate::acl::unprotect_secret(&raw, &self.local).map_err(|e| AuthError(format!("{e}. Paste your key again.")))?;
        Ok(Some(Zeroizing::new(String::from_utf8_lossy(&v).into_owned())))
    }

    pub fn delete_secret(&mut self, name: &str) -> Result<(), AuthError> {
        self.prefs.secrets.remove(name);
        self.save_prefs()?;
        let _ = self.audit("secret_deleted", name);
        Ok(())
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

    // ── Activity log and AI ledger (administrators and indexers) ───────
    fn activity(&mut self) -> Result<&Connection, AuthError> {
        if self.activity.is_none() {
            if !self.roster.role_of(&self.me.sid).can_rescan() {
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

    /// Team spend this month: ($ charged, $ still on hold, calls). A hold
    /// never settled (the PC lost power mid-call) keeps counting in full.
    pub fn ai_month(&mut self, month: &str) -> Result<(f64, f64, i64), AuthError> {
        let c = self.activity()?;
        Ok(c.query_row(
            "select coalesce(sum(case when status<>'reserved' then cost_usd end),0), coalesce(sum(case when status='reserved' then reserved_usd end),0), count(*) from ai_usage where month=?1",
            params![month],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?)
    }

    pub fn ai_reserve(&mut self, month: &str, feature: &str, provider: &str, model: &str, reserved: f64, note: &str) -> Result<i64, AuthError> {
        let (sid, acct) = (self.me.sid.clone(), self.me.account.clone());
        let c = self.activity()?;
        c.execute(
            "insert into ai_usage(user_id,account,at,month,feature,provider,model,reserved_usd,status,note) values(?1,?2,?3,?4,?5,?6,?7,?8,'reserved',?9)",
            params![sid, acct, now(), month, feature, provider, model, reserved, note],
        )?;
        Ok(c.last_insert_rowid())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn ai_settle(&mut self, id: i64, model: &str, input: u64, output: u64, cache_read: u64, cache_write: u64, cost: f64, status: &str, note: Option<&str>) -> Result<(), AuthError> {
        let c = self.activity()?;
        c.execute(
            "update ai_usage set model=?2,input_tokens=?3,output_tokens=?4,cache_read_tokens=?5,cache_write_tokens=?6,cost_usd=?7,status=?8,note=coalesce(?9,note) where id=?1",
            params![id, model, input as i64, output as i64, cache_read as i64, cache_write as i64, cost, status, note],
        )?;
        Ok(())
    }

    pub fn ai_usage_rows(&mut self, limit: i64) -> Result<Vec<serde_json::Value>, AuthError> {
        let c = self.activity()?;
        let mut st = c.prepare(
            "select at,feature,provider,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reserved_usd,cost_usd,status,note,account from ai_usage order by id desc limit ?1",
        )?;
        let rows = st.query_map(params![limit], |r| {
            Ok(serde_json::json!({
                "at": r.get::<_, String>(0)?, "feature": r.get::<_, String>(1)?, "provider": r.get::<_, Option<String>>(2)?, "model": r.get::<_, Option<String>>(3)?,
                "input_tokens": r.get::<_, i64>(4)?, "output_tokens": r.get::<_, i64>(5)?, "cache_read_tokens": r.get::<_, i64>(6)?, "cache_write_tokens": r.get::<_, i64>(7)?,
                "reserved_usd": r.get::<_, f64>(8)?, "cost_usd": r.get::<_, f64>(9)?, "status": r.get::<_, String>(10)?, "note": r.get::<_, Option<String>>(11)?,
                "account": r.get::<_, Option<String>>(12)?,
            }))
        })?;
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
        Identity { sid: sid.into(), account: format!("KERN\\{n}"), display: n.into() }
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
        a.found_team(team.join("roles.json"), team.join("admin").join("activity.db")).unwrap();
        assert_eq!(a.session().user.role, Role::Admin);
        a.set_member(&id("tech", "S-1-5-21-1-2"), Role::Indexer, None).unwrap();
        // Another person on another PC: roles from the same file.
        let mut b = UserStore::open(id("tech", "S-1-5-21-1-2"), &dir.join("local2"), Some(&team)).unwrap();
        assert_eq!(b.session().user.role, Role::Indexer);
        assert!(b.set_member(&id("x", "S-1-5-21-1-3"), Role::Admin, None).is_err(), "indexers can't hand out roles");
        let c = UserStore::open(id("operator", "S-1-5-21-1-9"), &dir.join("local3"), Some(&team)).unwrap();
        assert_eq!(c.session().user.role, Role::User);
        // Can't remove the last admin or yourself.
        assert!(a.set_member(&id("ggetzfrid", "S-1-5-21-1-1"), Role::User, None).is_err());
        // Keys: encrypted on this PC only.
        std::fs::create_dir_all(dir.join("local2")).unwrap();
        b.put_secret("ai_key", "sk-ant-123").unwrap();
        assert_eq!(b.get_secret("ai_key").unwrap().unwrap().as_str(), "sk-ant-123");
        let raw = std::fs::read_to_string(dir.join("local2").join("prefs.json")).unwrap();
        assert!(!raw.contains("sk-ant-123"));
        assert!(!std::fs::read_to_string(team.join("roles.json")).unwrap().contains("sk-ant"));
        // Spending ledger is team-wide.
        let m = &now()[..7];
        let r = a.ai_reserve(m, "index", "anthropic", "claude-haiku-5-5", 0.05, "").unwrap();
        a.ai_settle(r, "claude-haiku-5-5", 1, 1, 0, 0, 0.01, "charged", None).unwrap();
        b.ai_reserve(m, "index", "anthropic", "claude-haiku-5-5", 0.02, "").unwrap();
        let (spent, held, calls) = a.ai_month(m).unwrap();
        assert!((spent - 0.01).abs() < 1e-9 && (held - 0.02).abs() < 1e-9 && calls == 2);
        let _ = std::fs::remove_dir_all(&dir);
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
