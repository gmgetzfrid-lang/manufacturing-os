//! Profiles, sign-in and per-user secrets.
//!
//! * One account ships: ggetzfrid@kernenergy.com (Admin), temporary password
//!   "password", which must be changed before anything else is usable.
//! * Only Admins create profiles and assign roles. Every new profile gets a
//!   temporary password and must change it at first sign-in.
//! * Passwords are stored as Argon2id hashes (PHC strings) only.
//! * Each user's secrets (AI API keys) are encrypted with XChaCha20-Poly1305
//!   under a random data key. That data key is itself encrypted with a key
//!   derived (Argon2id) from the user's own password. No master key exists:
//!   not the admin, not another user, not someone with a copy of the database
//!   can decrypt them. Each ciphertext is bound to its owner and name.
//! * An admin password reset therefore erases that user's saved secrets.

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;
use zeroize::Zeroizing;

pub const SEED_ADMIN_EMAIL: &str = "ggetzfrid@kernenergy.com";
pub const SEED_ADMIN_PASSWORD: &str = "password";
const MAX_FAILED: i64 = 5;
const LOCK_SECONDS: i64 = 300;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
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

#[derive(Clone, Debug, Serialize)]
pub struct UserInfo {
    pub id: i64,
    pub email: String,
    pub name: String,
    pub role: Role,
    pub must_change: bool,
    pub disabled: bool,
    pub can_ai: bool,
    pub created_at: String,
    pub created_by: Option<String>,
    pub pw_changed_at: Option<String>,
    pub last_login_at: Option<String>,
    pub has_ai_key: bool,
}

pub struct Session {
    pub user: UserInfo,
    /// Present only while signed in; derived from the user's password.
    dek: Option<Zeroizing<[u8; 32]>>,
}

impl Session {
    pub fn is_admin(&self) -> bool {
        self.user.role == Role::Admin
    }
    pub fn unlocked(&self) -> bool {
        self.dek.is_some()
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
        AuthError(format!("User database error: {e}"))
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

fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).expect("OS random source");
    b
}

fn argon() -> Argon2<'static> {
    // 64 MiB, 3 passes: ~0.3-0.6 s on a workstation. Deliberately slow.
    Argon2::new(Algorithm::Argon2id, Version::V0x13, Params::new(64 * 1024, 3, 1, Some(32)).unwrap())
}

fn hash_password(pw: &str) -> Result<String, AuthError> {
    let salt = SaltString::encode_b64(&random::<16>()).map_err(|e| AuthError(e.to_string()))?;
    argon().hash_password(pw.as_bytes(), &salt).map(|h| h.to_string()).map_err(|e| AuthError(e.to_string()))
}

fn verify_password(pw: &str, phc: &str) -> bool {
    PasswordHash::new(phc).map(|h| argon().verify_password(pw.as_bytes(), &h).is_ok()).unwrap_or(false)
}

fn derive_kek(pw: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>, AuthError> {
    let mut k = Zeroizing::new([0u8; 32]);
    argon().hash_password_into(pw.as_bytes(), salt, k.as_mut()).map_err(|e| AuthError(e.to_string()))?;
    Ok(k)
}

fn seal(key: &[u8; 32], plaintext: &[u8], aad: &[u8]) -> Vec<u8> {
    let cipher = XChaCha20Poly1305::new(key.into());
    let nonce = random::<24>();
    let mut out = nonce.to_vec();
    out.extend(cipher.encrypt(XNonce::from_slice(&nonce), Payload { msg: plaintext, aad }).expect("encrypt"));
    out
}

fn open(key: &[u8; 32], sealed: &[u8], aad: &[u8]) -> Option<Zeroizing<Vec<u8>>> {
    if sealed.len() < 24 + 16 {
        return None;
    }
    let cipher = XChaCha20Poly1305::new(key.into());
    cipher.decrypt(XNonce::from_slice(&sealed[..24]), Payload { msg: &sealed[24..], aad }).ok().map(Zeroizing::new)
}

/// Rules for a new password. Returns a human sentence on failure.
pub fn password_problem(email: &str, pw: &str) -> Option<String> {
    let lower = pw.to_lowercase();
    if pw.chars().count() < 10 {
        return Some("Use at least 10 characters.".into());
    }
    if ["password", "password1", "password123", "tracepoint", "kernenergy", "changeme", "welcome1", "letmein"].iter().any(|b| lower.contains(b)) {
        return Some("That password is too easy to guess.".into());
    }
    let local = email.split('@').next().unwrap_or("").to_lowercase();
    if local.len() >= 3 && lower.contains(&local) {
        return Some("Don't include your email name in the password.".into());
    }
    let classes = [pw.chars().any(|c| c.is_lowercase()), pw.chars().any(|c| c.is_uppercase()), pw.chars().any(|c| c.is_ascii_digit()), pw.chars().any(|c| !c.is_alphanumeric())]
        .iter()
        .filter(|x| **x)
        .count();
    if classes < 3 {
        return Some("Mix at least three of: lowercase, uppercase, numbers, symbols.".into());
    }
    None
}

pub struct UserStore {
    conn: Connection,
}

const SCHEMA: &str = "
create table if not exists meta(key text primary key, value text not null);
create table if not exists users(
  id integer primary key,
  email text not null unique collate nocase,
  name text not null default '',
  role text not null check(role in ('admin','indexer','user')),
  pw_hash text not null,
  must_change integer not null default 1,
  disabled integer not null default 0,
  can_ai integer not null default 1,
  failed_logins integer not null default 0,
  locked_until integer,
  created_at text not null,
  created_by text,
  pw_changed_at text,
  last_login_at text,
  vault_salt blob,
  vault_wrapped blob
);
create table if not exists secrets(
  user_id integer not null references users(id) on delete cascade,
  name text not null,
  sealed blob not null,
  updated_at text not null,
  primary key(user_id, name)
);
create table if not exists user_prefs(
  user_id integer not null references users(id) on delete cascade,
  key text not null,
  value text not null,
  primary key(user_id, key)
);
create table if not exists policy(key text primary key, value text not null, updated_by text, updated_at text);
create table if not exists ai_usage(
  id integer primary key,
  user_id integer not null,
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
create index if not exists ix_ai_usage_user_month on ai_usage(user_id, month);
create table if not exists audit(id integer primary key, at text not null, actor text, action text not null, detail text, machine text);
";

impl UserStore {
    /// Opens (or creates) the profile database. Uses a rollback journal, not
    /// WAL, so it is safe on a network share.
    pub fn open(path: &Path) -> Result<UserStore, AuthError> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<UserStore, AuthError> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<UserStore, AuthError> {
        conn.busy_timeout(std::time::Duration::from_secs(8))?;
        conn.pragma_update(None, "journal_mode", "DELETE")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(SCHEMA)?;
        let s = UserStore { conn };
        s.seed()?;
        Ok(s)
    }

    fn seed(&self) -> Result<(), AuthError> {
        let n: i64 = self.conn.query_row("select count(*) from users", [], |r| r.get(0))?;
        if n == 0 {
            self.conn.execute(
                "insert into users(email,name,role,pw_hash,must_change,created_at,created_by) values(?1,'Admin','admin',?2,1,?3,'seed')",
                params![SEED_ADMIN_EMAIL, hash_password(SEED_ADMIN_PASSWORD)?, now()],
            )?;
            self.audit(None, "seed_admin", &format!("Created the built-in admin profile {SEED_ADMIN_EMAIL}"))?;
        }
        Ok(())
    }

    pub fn audit(&self, actor: Option<&str>, action: &str, detail: &str) -> Result<(), AuthError> {
        let machine = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default();
        self.conn.execute("insert into audit(at,actor,action,detail,machine) values(?1,?2,?3,?4,?5)", params![now(), actor, action, detail, machine])?;
        Ok(())
    }

    pub fn audit_log(&self, limit: i64) -> Result<Vec<(String, Option<String>, String, Option<String>, Option<String>)>, AuthError> {
        let mut st = self.conn.prepare("select at,actor,action,detail,machine from audit order by id desc limit ?1")?;
        let rows = st.query_map([limit], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    fn row_user(r: &rusqlite::Row) -> rusqlite::Result<UserInfo> {
        Ok(UserInfo {
            id: r.get("id")?,
            email: r.get("email")?,
            name: r.get("name")?,
            role: Role::parse(&r.get::<_, String>("role")?).unwrap_or(Role::User),
            must_change: r.get::<_, i64>("must_change")? != 0,
            disabled: r.get::<_, i64>("disabled")? != 0,
            can_ai: r.get::<_, i64>("can_ai")? != 0,
            created_at: r.get("created_at")?,
            created_by: r.get("created_by")?,
            pw_changed_at: r.get("pw_changed_at")?,
            last_login_at: r.get("last_login_at")?,
            has_ai_key: r.get::<_, i64>("has_key")? != 0,
        })
    }

    const USER_SELECT: &'static str = "select u.*, exists(select 1 from secrets s where s.user_id=u.id) as has_key from users u";

    pub fn get(&self, id: i64) -> Result<UserInfo, AuthError> {
        self.conn
            .query_row(&format!("{} where u.id=?1", Self::USER_SELECT), [id], Self::row_user)
            .optional()?
            .ok_or_else(|| AuthError("No such profile.".into()))
    }

    pub fn list(&self) -> Result<Vec<UserInfo>, AuthError> {
        let mut st = self.conn.prepare(&format!("{} order by u.role, u.email", Self::USER_SELECT))?;
        let rows = st.query_map([], Self::row_user)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn login(&self, email: &str, password: &str) -> Result<Session, AuthError> {
        let email = email.trim();
        let row: Option<(i64, String, i64, Option<i64>, Option<Vec<u8>>, Option<Vec<u8>>, i64)> = self
            .conn
            .query_row(
                "select id,pw_hash,failed_logins,locked_until,vault_salt,vault_wrapped,disabled from users where email=?1 collate nocase",
                [email],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
            )
            .optional()?;
        let Some((id, hash, failed, locked_until, salt, wrapped, disabled)) = row else {
            // Same work and message as a wrong password: no user enumeration.
            let _ = verify_password(password, "$argon2id$v=19$m=65536,t=3,p=1$c29tZXNhbHRzb21lc2FsdA$Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFy");
            return err("Email or password is incorrect.");
        };
        if disabled != 0 {
            self.audit(Some(email), "login_denied", "Profile is disabled")?;
            return err("This profile is disabled. Ask an administrator.");
        }
        if let Some(until) = locked_until {
            if until > now_secs() {
                return err(format!("Too many attempts. Try again in {} minute(s).", (until - now_secs()) / 60 + 1));
            }
        }
        if !verify_password(password, &hash) {
            let failed = failed + 1;
            let lock = (failed >= MAX_FAILED).then(|| now_secs() + LOCK_SECONDS);
            self.conn.execute("update users set failed_logins=?1, locked_until=?2 where id=?3", params![if lock.is_some() { 0 } else { failed }, lock, id])?;
            self.audit(Some(email), "login_failed", if lock.is_some() { "Locked for 5 minutes after 5 failures" } else { "Wrong password" })?;
            return err("Email or password is incorrect.");
        }
        self.conn.execute("update users set failed_logins=0, locked_until=null, last_login_at=?1 where id=?2", params![now(), id])?;
        let dek = match (salt, wrapped) {
            (Some(s), Some(w)) => {
                let kek = derive_kek(password, &s)?;
                open(&kek, &w, format!("tp-dek:{id}").as_bytes()).map(|v| {
                    let mut k = Zeroizing::new([0u8; 32]);
                    k.copy_from_slice(&v[..32]);
                    k
                })
            }
            _ => None,
        };
        let user = self.get(id)?;
        self.audit(Some(&user.email), "login", if user.must_change { "Signed in; password change required" } else { "Signed in" })?;
        Ok(Session { user, dek })
    }

    /// Change your own password. Re-wraps (or creates) your secret key.
    pub fn change_password(&self, s: &mut Session, current: &str, new: &str) -> Result<(), AuthError> {
        let (hash, salt, wrapped): (String, Option<Vec<u8>>, Option<Vec<u8>>) =
            self.conn.query_row("select pw_hash,vault_salt,vault_wrapped from users where id=?1", [s.user.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        if !verify_password(current, &hash) {
            return err("Your current password is not correct.");
        }
        if current == new {
            return err("Choose a password different from the current one.");
        }
        if let Some(p) = password_problem(&s.user.email, new) {
            return err(p);
        }
        // Keep the existing data key if it can be unwrapped, else start fresh.
        let dek: Zeroizing<[u8; 32]> = match (&salt, &wrapped) {
            (Some(sa), Some(w)) => {
                let kek = derive_kek(current, sa)?;
                match open(&kek, w, format!("tp-dek:{}", s.user.id).as_bytes()) {
                    Some(v) => {
                        let mut k = Zeroizing::new([0u8; 32]);
                        k.copy_from_slice(&v[..32]);
                        k
                    }
                    None => Zeroizing::new(random::<32>()),
                }
            }
            _ => Zeroizing::new(random::<32>()),
        };
        let new_salt = random::<16>();
        let kek = derive_kek(new, &new_salt)?;
        let new_wrapped = seal(&kek, dek.as_ref(), format!("tp-dek:{}", s.user.id).as_bytes());
        self.conn.execute(
            "update users set pw_hash=?1, must_change=0, pw_changed_at=?2, vault_salt=?3, vault_wrapped=?4 where id=?5",
            params![hash_password(new)?, now(), new_salt.to_vec(), new_wrapped, s.user.id],
        )?;
        self.audit(Some(&s.user.email), "password_changed", "Changed own password")?;
        s.dek = Some(dek);
        s.user = self.get(s.user.id)?;
        Ok(())
    }

    fn require_admin(s: &Session) -> Result<(), AuthError> {
        if s.user.role != Role::Admin || s.user.must_change {
            return err("Only an administrator can do that.");
        }
        Ok(())
    }

    pub fn create_user(&self, admin: &Session, email: &str, name: &str, role: Role, temp_password: &str) -> Result<UserInfo, AuthError> {
        Self::require_admin(admin)?;
        let email = email.trim();
        if !email.contains('@') || email.len() < 5 {
            return err("Enter a valid email address.");
        }
        if temp_password.chars().count() < 8 {
            return err("Temporary passwords need at least 8 characters.");
        }
        let exists: i64 = self.conn.query_row("select count(*) from users where email=?1 collate nocase", [email], |r| r.get(0))?;
        if exists > 0 {
            return err("A profile with that email already exists.");
        }
        self.conn.execute(
            "insert into users(email,name,role,pw_hash,must_change,created_at,created_by) values(?1,?2,?3,?4,1,?5,?6)",
            params![email, name.trim(), role.as_str(), hash_password(temp_password)?, now(), admin.user.email],
        )?;
        let id = self.conn.last_insert_rowid();
        self.audit(Some(&admin.user.email), "user_created", &format!("{email} as {}", role.as_str()))?;
        self.get(id)
    }

    fn admins_active(&self) -> Result<i64, AuthError> {
        Ok(self.conn.query_row("select count(*) from users where role='admin' and disabled=0", [], |r| r.get(0))?)
    }

    pub fn update_user(&self, admin: &Session, id: i64, name: Option<&str>, role: Option<Role>, disabled: Option<bool>, can_ai: Option<bool>) -> Result<UserInfo, AuthError> {
        Self::require_admin(admin)?;
        let before = self.get(id)?;
        let demoting = before.role == Role::Admin && (role.map(|r| r != Role::Admin).unwrap_or(false) || disabled == Some(true));
        if demoting && self.admins_active()? <= 1 {
            return err("At least one active administrator must remain.");
        }
        if id == admin.user.id && disabled == Some(true) {
            return err("You can't disable your own profile.");
        }
        if let Some(n) = name {
            self.conn.execute("update users set name=?1 where id=?2", params![n.trim(), id])?;
        }
        if let Some(r) = role {
            self.conn.execute("update users set role=?1 where id=?2", params![r.as_str(), id])?;
        }
        if let Some(d) = disabled {
            self.conn.execute("update users set disabled=?1 where id=?2", params![d as i64, id])?;
        }
        if let Some(a) = can_ai {
            self.conn.execute("update users set can_ai=?1 where id=?2", params![a as i64, id])?;
        }
        let after = self.get(id)?;
        self.audit(
            Some(&admin.user.email),
            "user_updated",
            &format!("{}: role {}→{}, disabled {}→{}, AI {}→{}", after.email, before.role.as_str(), after.role.as_str(), before.disabled, after.disabled, before.can_ai, after.can_ai),
        )?;
        Ok(after)
    }

    /// Admin reset: new temporary password, forced change, saved secrets erased
    /// (they were locked with the old password and cannot be recovered).
    pub fn reset_password(&self, admin: &Session, id: i64, temp_password: &str) -> Result<UserInfo, AuthError> {
        Self::require_admin(admin)?;
        if temp_password.chars().count() < 8 {
            return err("Temporary passwords need at least 8 characters.");
        }
        self.conn.execute(
            "update users set pw_hash=?1, must_change=1, failed_logins=0, locked_until=null, vault_salt=null, vault_wrapped=null where id=?2",
            params![hash_password(temp_password)?, id],
        )?;
        let removed = self.conn.execute("delete from secrets where user_id=?1", [id])?;
        let u = self.get(id)?;
        self.audit(Some(&admin.user.email), "password_reset", &format!("{} reset; {} saved key(s) erased", u.email, removed))?;
        Ok(u)
    }

    pub fn delete_user(&self, admin: &Session, id: i64) -> Result<(), AuthError> {
        Self::require_admin(admin)?;
        let u = self.get(id)?;
        if u.id == admin.user.id {
            return err("You can't delete your own profile.");
        }
        if u.role == Role::Admin && self.admins_active()? <= 1 {
            return err("At least one active administrator must remain.");
        }
        self.conn.execute("delete from users where id=?1", [id])?;
        self.audit(Some(&admin.user.email), "user_deleted", &u.email)?;
        Ok(())
    }

    // ── Secrets (AI keys) ────────────────────────────────────────────
    pub fn put_secret(&self, s: &Session, name: &str, value: &str) -> Result<(), AuthError> {
        let Some(dek) = &s.dek else {
            return err("Sign in again to unlock your saved keys.");
        };
        let sealed = seal(dek, value.as_bytes(), format!("tp-secret:{}:{name}", s.user.id).as_bytes());
        self.conn.execute(
            "insert into secrets(user_id,name,sealed,updated_at) values(?1,?2,?3,?4) on conflict(user_id,name) do update set sealed=excluded.sealed, updated_at=excluded.updated_at",
            params![s.user.id, name, sealed, now()],
        )?;
        self.audit(Some(&s.user.email), "secret_saved", name)?;
        Ok(())
    }

    pub fn get_secret(&self, s: &Session, name: &str) -> Result<Option<Zeroizing<String>>, AuthError> {
        let Some(dek) = &s.dek else { return Ok(None) };
        let sealed: Option<Vec<u8>> = self.conn.query_row("select sealed from secrets where user_id=?1 and name=?2", params![s.user.id, name], |r| r.get(0)).optional()?;
        Ok(sealed.and_then(|b| open(dek, &b, format!("tp-secret:{}:{name}", s.user.id).as_bytes())).map(|v| Zeroizing::new(String::from_utf8_lossy(&v).into_owned())))
    }

    pub fn delete_secret(&self, s: &Session, name: &str) -> Result<(), AuthError> {
        self.conn.execute("delete from secrets where user_id=?1 and name=?2", params![s.user.id, name])?;
        self.audit(Some(&s.user.email), "secret_deleted", name)?;
        Ok(())
    }

    // ── AI spending ledger ──────────────────────────────────────────
    /// Spend this month: (questions $, indexing $, $ still on hold, calls).
    /// A hold that was never settled (e.g. the PC lost power mid-call) keeps
    /// counting at its full amount: the cap errs on the safe side.
    pub fn ai_month(&self, user_id: i64, month: &str) -> Result<(f64, f64, f64, i64), AuthError> {
        Ok(self.conn.query_row(
            "select coalesce(sum(case when feature<>'index' and status<>'reserved' then cost_usd end),0),
                    coalesce(sum(case when feature='index' and status<>'reserved' then cost_usd end),0),
                    coalesce(sum(case when status='reserved' then reserved_usd end),0),
                    count(*)
             from ai_usage where user_id=?1 and month=?2",
            params![user_id, month],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?)
    }

    pub fn ai_reserve(&self, user_id: i64, month: &str, feature: &str, provider: &str, model: &str, reserved: f64, note: &str) -> Result<i64, AuthError> {
        self.conn.execute(
            "insert into ai_usage(user_id,at,month,feature,provider,model,reserved_usd,status,note) values(?1,?2,?3,?4,?5,?6,?7,'reserved',?8)",
            params![user_id, now(), month, feature, provider, model, reserved, note],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn ai_settle(&self, id: i64, model: &str, input: u64, output: u64, cache_read: u64, cache_write: u64, cost: f64, status: &str, note: Option<&str>) -> Result<(), AuthError> {
        self.conn.execute(
            "update ai_usage set model=?2,input_tokens=?3,output_tokens=?4,cache_read_tokens=?5,cache_write_tokens=?6,cost_usd=?7,status=?8,note=coalesce(?9,note) where id=?1",
            params![id, model, input as i64, output as i64, cache_read as i64, cache_write as i64, cost, status, note],
        )?;
        Ok(())
    }

    pub fn ai_usage_rows(&self, user_id: i64, limit: i64) -> Result<Vec<serde_json::Value>, AuthError> {
        let mut st = self.conn.prepare(
            "select at,feature,provider,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reserved_usd,cost_usd,status,note from ai_usage where user_id=?1 order by id desc limit ?2",
        )?;
        let rows = st.query_map(params![user_id, limit], |r| {
            Ok(serde_json::json!({
                "at": r.get::<_, String>(0)?, "feature": r.get::<_, String>(1)?, "provider": r.get::<_, Option<String>>(2)?, "model": r.get::<_, Option<String>>(3)?,
                "input_tokens": r.get::<_, i64>(4)?, "output_tokens": r.get::<_, i64>(5)?, "cache_read_tokens": r.get::<_, i64>(6)?, "cache_write_tokens": r.get::<_, i64>(7)?,
                "reserved_usd": r.get::<_, f64>(8)?, "cost_usd": r.get::<_, f64>(9)?, "status": r.get::<_, String>(10)?, "note": r.get::<_, Option<String>>(11)?,
            }))
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    // ── Preferences and policy ──────────────────────────────────────
    pub fn set_pref(&self, s: &Session, key: &str, value: &str) -> Result<(), AuthError> {
        self.conn.execute(
            "insert into user_prefs(user_id,key,value) values(?1,?2,?3) on conflict(user_id,key) do update set value=excluded.value",
            params![s.user.id, key, value],
        )?;
        Ok(())
    }

    pub fn prefs(&self, s: &Session) -> Result<Vec<(String, String)>, AuthError> {
        let mut st = self.conn.prepare("select key,value from user_prefs where user_id=?1")?;
        let rows = st.query_map([s.user.id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn policy(&self, key: &str) -> Result<Option<String>, AuthError> {
        Ok(self.conn.query_row("select value from policy where key=?1", [key], |r| r.get(0)).optional()?)
    }

    pub fn set_policy(&self, admin: &Session, key: &str, value: &str) -> Result<(), AuthError> {
        Self::require_admin(admin)?;
        self.conn.execute(
            "insert into policy(key,value,updated_by,updated_at) values(?1,?2,?3,?4) on conflict(key) do update set value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at",
            params![key, value, admin.user.email, now()],
        )?;
        self.audit(Some(&admin.user.email), "policy_changed", &format!("{key} = {value}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeded_admin_must_change_and_secrets_are_private() {
        let st = UserStore::open_in_memory().unwrap();
        let mut admin = st.login("GGetzfrid@kernenergy.com", "password").unwrap();
        assert!(admin.user.must_change);
        assert_eq!(admin.user.role, Role::Admin);
        // Nothing administrative works before the forced change.
        assert!(st.create_user(&admin, "a@b.com", "A", Role::User, "temp-pass-1").is_err());
        assert!(st.change_password(&mut admin, "password", "password123!").is_err(), "weak");
        st.change_password(&mut admin, "password", "Refinery#Search2026").unwrap();
        assert!(!admin.user.must_change);

        let u = st.create_user(&admin, "tech@kernenergy.com", "Tech", Role::User, "Temp-pass-77").unwrap();
        assert!(u.must_change);
        let mut tech = st.login("tech@kernenergy.com", "Temp-pass-77").unwrap();
        st.change_password(&mut tech, "Temp-pass-77", "Tank#Farm-7272").unwrap();
        st.put_secret(&tech, "ai_key", "sk-ant-secret-123").unwrap();
        assert_eq!(st.get_secret(&tech, "ai_key").unwrap().unwrap().as_str(), "sk-ant-secret-123");
        // The admin cannot read the tech's key, even by name.
        assert!(st.get_secret(&admin, "ai_key").unwrap().is_none());
        // Copying the ciphertext into the admin's row does not decrypt either.
        st.conn.execute("insert into secrets(user_id,name,sealed,updated_at) select ?1,name,sealed,updated_at from secrets where user_id=?2", params![admin.user.id, tech.user.id]).unwrap();
        assert!(st.get_secret(&admin, "ai_key").unwrap().is_none());
        // A fresh login re-derives the key from the password.
        let tech2 = st.login("tech@kernenergy.com", "Tank#Farm-7272").unwrap();
        assert_eq!(st.get_secret(&tech2, "ai_key").unwrap().unwrap().as_str(), "sk-ant-secret-123");
        // Changing the password keeps the key.
        let mut tech3 = st.login("tech@kernenergy.com", "Tank#Farm-7272").unwrap();
        st.change_password(&mut tech3, "Tank#Farm-7272", "Crude-Unit#2000x").unwrap();
        let tech4 = st.login("tech@kernenergy.com", "Crude-Unit#2000x").unwrap();
        assert_eq!(st.get_secret(&tech4, "ai_key").unwrap().unwrap().as_str(), "sk-ant-secret-123");
        // Admin reset erases it and forces a change.
        st.reset_password(&admin, tech.user.id, "New-temp-99").unwrap();
        let t5 = st.login("tech@kernenergy.com", "New-temp-99").unwrap();
        assert!(t5.user.must_change);
        assert!(st.get_secret(&t5, "ai_key").unwrap().is_none());
        // Non-admins cannot manage profiles.
        assert!(st.create_user(&t5, "x@y.com", "X", Role::Admin, "Temp-pass-77").is_err());
        // Last admin cannot be demoted.
        assert!(st.update_user(&admin, admin.user.id, None, Some(Role::User), None, None).is_err());
    }

    #[test]
    fn lockout_after_failures() {
        let st = UserStore::open_in_memory().unwrap();
        for _ in 0..5 {
            assert!(st.login(SEED_ADMIN_EMAIL, "nope").is_err());
        }
        let e = st.login(SEED_ADMIN_EMAIL, "password").err().unwrap();
        assert!(e.0.contains("Too many attempts"));
    }

    #[test]
    fn dates() {
        assert_eq!(format_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_utc(1_792_022_400), "2026-10-15T00:00:00Z");
    }
}
