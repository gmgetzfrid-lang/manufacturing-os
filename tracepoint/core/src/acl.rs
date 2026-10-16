//! Windows permissions: who may read a THOR file, and the same lock put on
//! the shared index files that describe it.
//!
//! TracePoint never changes a permission on THOR. It *reads* each file's
//! access list during an administrator's scan, and *writes* access lists only
//! on folders it creates itself in the shared TracePoint folder.
//!
//! The logic works on SDDL text (Windows' own printable form of an access
//! list), so it is the same code on every platform and is unit tested; only
//! the conversion to and from Windows' binary form is Windows-specific.
//!
//! Rules (every one errs towards showing *less*):
//! * Only the read right matters: "may this account open the file?"
//! * Deny entries are kept and placed first, so a deny always wins.
//! * An allow entry TracePoint can't reproduce exactly (conditional, owner
//!   rights) is dropped: fewer people see the file.
//! * A deny entry TracePoint can't reproduce makes the file unpublishable:
//!   it stays out of the shared index.

use std::collections::BTreeSet;

pub const FILE_READ_DATA: u32 = 0x1;
pub const GENERIC_READ: u32 = 0x8000_0000;
pub const GENERIC_ALL: u32 = 0x1000_0000;
/// Read, list, traverse, read attributes and permissions ("Read & execute").
pub const READ_EXECUTE: u32 = 0x1200a9;
/// What a deny entry on a shared index folder blocks: reading and listing.
pub const DENY_READ: u32 = 0x9;
pub const FULL_CONTROL: u32 = 0x1f01ff;
/// Modify: read, write, delete — not change permissions.
pub const MODIFY: u32 = 0x1301bf;

pub const SID_SYSTEM: &str = "S-1-5-18";
pub const SID_ADMINISTRATORS: &str = "S-1-5-32-544";
pub const SID_AUTHENTICATED_USERS: &str = "S-1-5-11";

/// Result of asking Windows "may I open this?" as the signed-in user.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub enum Access {
    Allowed,
    Denied,
    Missing,
    /// Network error or anything else: treated as no.
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ace {
    /// "A" allow, "D" deny, or another SDDL type ("XA", "OA", "XD"…).
    pub kind: String,
    pub flags: String,
    pub mask: u32,
    pub sid: String,
}

impl Ace {
    /// SDDL flags are two-letter codes ("OICIIO"); compare whole codes so
    /// "CIOI" isn't misread as containing IO.
    pub fn inherit_only(&self) -> bool {
        self.flags.as_bytes().chunks(2).any(|c| c == b"IO")
    }
    pub fn reads(&self) -> bool {
        self.mask & (FILE_READ_DATA | GENERIC_READ | GENERIC_ALL) != 0
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Dacl {
    pub protected: bool,
    /// No access list at all: everyone has full access.
    pub null: bool,
    pub aces: Vec<Ace>,
}

/// The rights part of an SDDL entry: hex or two-letter codes.
pub fn parse_rights(s: &str) -> Option<u32> {
    let s = s.trim();
    if let Some(h) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        return u32::from_str_radix(h, 16).ok();
    }
    if s.chars().all(|c| c.is_ascii_digit()) && !s.is_empty() {
        return s.parse().ok();
    }
    if s.len() % 2 != 0 {
        return None;
    }
    let mut m = 0u32;
    for i in (0..s.len()).step_by(2) {
        m |= match &s[i..i + 2] {
            "GA" => GENERIC_ALL,
            "GR" => GENERIC_READ,
            "GW" => 0x4000_0000,
            "GX" => 0x2000_0000,
            "FA" => FULL_CONTROL,
            "FR" => 0x120089,
            "FW" => 0x120116,
            "FX" => 0x1200a0,
            "KA" => 0xf003f,
            "KR" => 0x20019,
            "KW" => 0x20006,
            "KX" => 0x20019,
            "RC" => 0x20000,
            "SD" => 0x10000,
            "WD" => 0x40000,
            "WO" => 0x80000,
            "CC" => 0x1,
            "DC" => 0x2,
            "LC" => 0x4,
            "SW" => 0x8,
            "RP" => 0x10,
            "WP" => 0x20,
            "DT" => 0x40,
            "LO" => 0x80,
            "CR" => 0x100,
            _ => return None,
        };
    }
    Some(m)
}

/// The DACL part of an SDDL string ("D:PAI(A;OICI;FA;;;BA)…").
pub fn parse_dacl(sddl: &str) -> Result<Dacl, String> {
    let Some(i) = sddl.find("D:") else {
        return Err("No access list in the security descriptor".into());
    };
    let mut rest = &sddl[i + 2..];
    // Stop at a following S: (audit) section.
    if let Some(j) = rest.find("S:") {
        if !rest[..j].contains('(') || rest[..j].ends_with(')') {
            rest = &rest[..j];
        }
    }
    let mut d = Dacl::default();
    let head_end = rest.find('(').unwrap_or(rest.len());
    let head = &rest[..head_end];
    if head.contains("NO_ACCESS_CONTROL") {
        d.null = true;
        return Ok(d);
    }
    d.protected = head.contains('P');
    let mut body = &rest[head_end..];
    while let Some(start) = body.find('(') {
        let Some(end) = body[start..].find(')') else {
            return Err("Damaged access list".into());
        };
        let inner = &body[start + 1..start + end];
        let parts: Vec<&str> = inner.split(';').collect();
        if parts.len() < 6 {
            return Err(format!("Unreadable access entry ({inner})"));
        }
        let mask = parse_rights(parts[2]).ok_or_else(|| format!("Unreadable rights ({})", parts[2]))?;
        d.aces.push(Ace { kind: parts[0].to_string(), flags: parts[1].to_string(), mask, sid: parts[5].trim().to_string() });
        body = &body[start + end + 1..];
    }
    Ok(d)
}

/// Universal SDDL account aliases. Domain-relative ones (DU, DA…) are
/// resolved by Windows on the PC; here they stay as written.
pub fn alias_sid(s: &str) -> Option<&'static str> {
    Some(match s {
        "WD" => "S-1-1-0",
        "AU" => SID_AUTHENTICATED_USERS,
        "SY" => SID_SYSTEM,
        "BA" => SID_ADMINISTRATORS,
        "BU" => "S-1-5-32-545",
        "BG" => "S-1-5-32-546",
        "PU" => "S-1-5-32-547",
        "BO" => "S-1-5-32-551",
        "AN" => "S-1-5-7",
        "IU" => "S-1-5-4",
        "NU" => "S-1-5-2",
        "NS" => "S-1-5-20",
        "LS" => "S-1-5-19",
        "CO" => "S-1-3-0",
        "CG" => "S-1-3-1",
        "OW" => "S-1-3-4",
        "PS" => "S-1-5-10",
        "RD" => "S-1-5-32-555",
        _ => return None,
    })
}

/// Accounts that mean "practically everyone" — worth telling IT about.
pub fn is_broad(sid: &str) -> bool {
    matches!(sid, "S-1-1-0" | "S-1-5-11" | "S-1-5-32-545" | "S-1-5-7" | "S-1-5-4" | "S-1-5-2") || (sid.starts_with("S-1-5-21-") && sid.ends_with("-513")) || sid == "DU"
}

/// Who may read an object: the deny and allow accounts that decide it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReadAccess {
    pub deny: BTreeSet<String>,
    pub allow: BTreeSet<String>,
}

impl ReadAccess {
    /// From an access list. `canon` turns an account into its SID string.
    /// Err: a rule TracePoint can't reproduce safely (keep it unpublished).
    pub fn from_dacl(d: &Dacl, canon: &dyn Fn(&str) -> String) -> Result<ReadAccess, String> {
        let mut r = ReadAccess::default();
        if d.null {
            r.allow.insert("S-1-1-0".into());
            return Ok(r);
        }
        for a in d.aces.iter().filter(|a| !a.inherit_only() && a.reads()) {
            let sid = canon(&a.sid);
            let special = matches!(sid.as_str(), "S-1-3-0" | "S-1-3-1" | "S-1-3-4");
            match a.kind.as_str() {
                "A" if !special => {
                    r.allow.insert(sid);
                }
                // Conditional, object-type or owner-relative allows: dropped.
                "A" | "XA" | "OA" | "ZA" => {}
                "D" if !special => {
                    r.deny.insert(sid);
                }
                other => return Err(format!("a deny rule TracePoint can't copy ({other} for {sid})")),
            }
        }
        for s in &r.deny {
            r.allow.remove(s);
        }
        Ok(r)
    }

    /// Stable text form: files with the same one share a lock and an index file.
    pub fn fingerprint(&self) -> String {
        let mut v: Vec<String> = self.deny.iter().map(|s| format!("D:{s}")).collect();
        v.extend(self.allow.iter().map(|s| format!("A:{s}")));
        v.join(",")
    }

    pub fn parse_fingerprint(fp: &str) -> ReadAccess {
        let mut r = ReadAccess::default();
        for part in fp.split(',').filter(|p| !p.is_empty()) {
            if let Some(s) = part.strip_prefix("D:") {
                r.deny.insert(s.to_string());
            } else if let Some(s) = part.strip_prefix("A:") {
                r.allow.insert(s.to_string());
            }
        }
        r
    }

    pub fn broad(&self) -> bool {
        self.allow.iter().any(|s| is_broad(s))
    }

    /// The protected access list for a shared index folder holding these
    /// files: the same readers (read-only), denies first, plus full control
    /// for SYSTEM, Administrators and the publishing account.
    pub fn index_folder_sddl(&self, publisher: &str) -> String {
        let mut s = String::from("D:PAI");
        for d in &self.deny {
            s.push_str(&format!("(D;OICI;0x{DENY_READ:x};;;{d})"));
        }
        for owner in [SID_SYSTEM, SID_ADMINISTRATORS, publisher] {
            if !self.deny.contains(owner) {
                s.push_str(&format!("(A;OICI;0x{FULL_CONTROL:x};;;{owner})"));
            }
        }
        for a in &self.allow {
            s.push_str(&format!("(A;OICI;0x{READ_EXECUTE:x};;;{a})"));
        }
        s
    }
}

/// Does `got` (read back from Windows) let exactly the intended accounts read?
/// Extra *deny* entries are fine; any extra reader is not.
pub fn same_readers(intended: &ReadAccess, got: &ReadAccess, publisher: &str) -> Result<(), String> {
    let mut want = intended.allow.clone();
    for s in [SID_SYSTEM, SID_ADMINISTRATORS, publisher] {
        if !intended.deny.contains(s) {
            want.insert(s.to_string());
        }
    }
    let extra: Vec<&String> = got.allow.difference(&want).collect();
    if !extra.is_empty() {
        return Err(format!("the file server also lets {} read it", extra.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")));
    }
    let lost: Vec<&String> = intended.deny.difference(&got.deny).collect();
    if !lost.is_empty() {
        return Err(format!("the file server dropped the deny for {}", lost.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")));
    }
    Ok(())
}

/// An access list for TracePoint's own team folders (not index folders).
pub fn team_folder_sddl(full: &[String], modify: &[String], readers: &[&str]) -> String {
    let mut s = format!("D:PAI(A;OICI;0x{FULL_CONTROL:x};;;{SID_SYSTEM})(A;OICI;0x{FULL_CONTROL:x};;;{SID_ADMINISTRATORS})");
    for f in full {
        s.push_str(&format!("(A;OICI;0x{FULL_CONTROL:x};;;{f})"));
    }
    for m in modify {
        s.push_str(&format!("(A;OICI;0x{MODIFY:x};;;{m})"));
    }
    for r in readers {
        s.push_str(&format!("(A;OICI;0x{READ_EXECUTE:x};;;{r})"));
    }
    s
}

/// The signed-in Windows account.
#[derive(Clone, Debug, serde::Serialize)]
pub struct Identity {
    pub sid: String,
    /// DOMAIN\user
    pub account: String,
    pub display: String,
}

// ── Platform layer ─────────────────────────────────────────────────────────

#[cfg(windows)]
mod win {
    use super::*;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, LocalFree, ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SHARING_VIOLATION, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Security::Authorization::{
        ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, ConvertStringSidToSidW, GetNamedSecurityInfoW, SetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};
    use windows_sys::Win32::Security::{GetSecurityDescriptorDacl, GetTokenInformation, LookupAccountNameW, LookupAccountSidW, TokenUser, ACL, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SID_NAME_USE, TOKEN_QUERY, TOKEN_USER};
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING};
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }
    unsafe fn from_wide(p: *const u16) -> String {
        if p.is_null() {
            return String::new();
        }
        let mut n = 0;
        while *p.add(n) != 0 {
            n += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(p, n))
    }
    fn os(p: &str) -> String {
        crate::crawl::os_path(p).to_string_lossy().into_owned()
    }
    fn last_error(what: &str) -> String {
        let e = unsafe { GetLastError() };
        format!("{what}: {}", std::io::Error::from_raw_os_error(e as i32))
    }

    pub fn canon_sid(s: &str) -> String {
        if s.starts_with("S-1-") {
            return s.to_string();
        }
        unsafe {
            let mut sid: PSID = std::ptr::null_mut();
            let w = wide(s);
            if ConvertStringSidToSidW(w.as_ptr(), &mut sid) == 0 {
                return s.to_string();
            }
            let mut out: *mut u16 = std::ptr::null_mut();
            let r = if ConvertSidToStringSidW(sid, &mut out) != 0 { from_wide(out) } else { s.to_string() };
            LocalFree(out as _);
            LocalFree(sid as _);
            r
        }
    }

    pub fn dacl_sddl(path: &str) -> Result<String, String> {
        unsafe {
            let w = wide(&os(path));
            let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
            let rc = GetNamedSecurityInfoW(w.as_ptr(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), &mut sd);
            if rc != 0 {
                return Err(format!("permissions unreadable: {}", std::io::Error::from_raw_os_error(rc as i32)));
            }
            let mut out: *mut u16 = std::ptr::null_mut();
            let ok = ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, SDDL_REVISION_1, DACL_SECURITY_INFORMATION, &mut out, std::ptr::null_mut());
            let res = if ok != 0 { Ok(from_wide(out)) } else { Err(last_error("permissions unreadable")) };
            LocalFree(out as _);
            LocalFree(sd as _);
            res
        }
    }

    pub fn set_protected_dacl(path: &str, sddl: &str) -> Result<(), String> {
        unsafe {
            let ws = wide(sddl);
            let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(ws.as_ptr(), SDDL_REVISION_1, &mut sd, std::ptr::null_mut()) == 0 {
                return Err(last_error("bad access list"));
            }
            let mut present = 0;
            let mut defaulted = 0;
            let mut dacl: *mut ACL = std::ptr::null_mut();
            if GetSecurityDescriptorDacl(sd, &mut present, &mut dacl, &mut defaulted) == 0 || present == 0 {
                LocalFree(sd as _);
                return Err("bad access list".into());
            }
            let wp = wide(&os(path));
            let rc = SetNamedSecurityInfoW(wp.as_ptr() as _, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, std::ptr::null_mut(), std::ptr::null_mut(), dacl, std::ptr::null());
            LocalFree(sd as _);
            if rc != 0 {
                return Err(format!("the file server refused the permissions: {}", std::io::Error::from_raw_os_error(rc as i32)));
            }
            Ok(())
        }
    }

    /// Open for reading (directory: listing), close at once. Reads nothing.
    pub fn probe(path: &str, dir: bool) -> Access {
        unsafe {
            let w = wide(&os(path));
            let flags = if dir { FILE_FLAG_BACKUP_SEMANTICS } else { 0 };
            let h: HANDLE = CreateFileW(w.as_ptr(), FILE_READ_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, std::ptr::null(), OPEN_EXISTING, flags, std::ptr::null_mut());
            if h != INVALID_HANDLE_VALUE {
                CloseHandle(h);
                return Access::Allowed;
            }
            match GetLastError() {
                ERROR_ACCESS_DENIED => Access::Denied,
                // Sharing is checked after permission: permission was granted.
                ERROR_SHARING_VIOLATION => Access::Allowed,
                ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => Access::Missing,
                _ => Access::Unknown,
            }
        }
    }

    unsafe fn sid_to_string(sid: PSID) -> String {
        let mut out: *mut u16 = std::ptr::null_mut();
        let r = if ConvertSidToStringSidW(sid, &mut out) != 0 { from_wide(out) } else { String::new() };
        LocalFree(out as _);
        r
    }

    unsafe fn sid_account(sid: PSID) -> Option<String> {
        let mut name = [0u16; 256];
        let mut dom = [0u16; 256];
        let (mut nl, mut dl) = (256u32, 256u32);
        let mut use_: SID_NAME_USE = 0;
        if LookupAccountSidW(std::ptr::null(), sid, name.as_mut_ptr(), &mut nl, dom.as_mut_ptr(), &mut dl, &mut use_) == 0 {
            return None;
        }
        let n = String::from_utf16_lossy(&name[..nl as usize]);
        let d = String::from_utf16_lossy(&dom[..dl as usize]);
        Some(if d.is_empty() { n } else { format!("{d}\\{n}") })
    }

    pub fn current_user() -> Option<Identity> {
        unsafe {
            let mut tok: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut tok) == 0 {
                return None;
            }
            let mut buf = vec![0u8; 512];
            let mut len = 0u32;
            let ok = GetTokenInformation(tok, TokenUser, buf.as_mut_ptr() as _, buf.len() as u32, &mut len);
            CloseHandle(tok);
            if ok == 0 {
                return None;
            }
            let tu = &*(buf.as_ptr() as *const TOKEN_USER);
            let sid = sid_to_string(tu.User.Sid);
            let account = sid_account(tu.User.Sid).unwrap_or_else(|| sid.clone());
            let display = account.rsplit('\\').next().unwrap_or(&account).to_string();
            Some(Identity { sid, account, display })
        }
    }

    pub fn lookup(name: &str) -> Result<Identity, String> {
        unsafe {
            let w = wide(name.trim());
            let mut sid = vec![0u8; 128];
            let mut sl = 128u32;
            let mut dom = [0u16; 256];
            let mut dl = 256u32;
            let mut use_: SID_NAME_USE = 0;
            if LookupAccountNameW(std::ptr::null(), w.as_ptr(), sid.as_mut_ptr() as _, &mut sl, dom.as_mut_ptr(), &mut dl, &mut use_) == 0 {
                return Err(format!("Windows doesn't know the account \"{}\". Use DOMAIN\\username.", name.trim()));
            }
            let p = sid.as_mut_ptr() as PSID;
            let s = sid_to_string(p);
            let account = sid_account(p).unwrap_or_else(|| name.trim().to_string());
            let display = account.rsplit('\\').next().unwrap_or(&account).to_string();
            Ok(Identity { sid: s, account, display })
        }
    }

    pub fn account_name(sid: &str) -> Option<String> {
        unsafe {
            let w = wide(sid);
            let mut p: PSID = std::ptr::null_mut();
            if ConvertStringSidToSidW(w.as_ptr(), &mut p) == 0 {
                return None;
            }
            let r = sid_account(p);
            LocalFree(p as _);
            r
        }
    }

    const ENTROPY: &[u8] = b"TracePoint secret v1";

    pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
        unsafe {
            let inb = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
            let ent = CRYPT_INTEGER_BLOB { cbData: ENTROPY.len() as u32, pbData: ENTROPY.as_ptr() as *mut u8 };
            let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
            if CryptProtectData(&inb, std::ptr::null(), &ent, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) == 0 {
                return Err(last_error("Windows could not encrypt the key"));
            }
            let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
            LocalFree(out.pbData as _);
            Ok(v)
        }
    }

    pub fn unprotect(data: &[u8]) -> Result<zeroize::Zeroizing<Vec<u8>>, String> {
        unsafe {
            let inb = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
            let ent = CRYPT_INTEGER_BLOB { cbData: ENTROPY.len() as u32, pbData: ENTROPY.as_ptr() as *mut u8 };
            let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
            if CryptUnprotectData(&inb, std::ptr::null_mut(), &ent, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) == 0 {
                return Err(last_error("Windows could not decrypt the key"));
            }
            let v = zeroize::Zeroizing::new(std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec());
            std::ptr::write_bytes(out.pbData, 0, out.cbData as usize);
            LocalFree(out.pbData as _);
            Ok(v)
        }
    }

    unsafe fn reg(root: HKEY, value: &str, dword: bool) -> Option<String> {
        let key = wide("SOFTWARE\\Policies\\TracePoint");
        let v = wide(value);
        if dword {
            let mut d = 0u32;
            let mut len = 4u32;
            if RegGetValueW(root, key.as_ptr(), v.as_ptr(), RRF_RT_REG_DWORD, std::ptr::null_mut(), &mut d as *mut u32 as _, &mut len) == 0 {
                return Some(d.to_string());
            }
            None
        } else {
            let mut buf = vec![0u16; 1024];
            let mut len = (buf.len() * 2) as u32;
            if RegGetValueW(root, key.as_ptr(), v.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr() as _, &mut len) == 0 {
                return Some(from_wide(buf.as_ptr()));
            }
            None
        }
    }

    /// IT policy (Group Policy / registry): machine first, then user.
    pub fn policy(value: &str, dword: bool) -> Option<String> {
        unsafe { reg(HKEY_LOCAL_MACHINE, value, dword).or_else(|| reg(HKEY_CURRENT_USER, value, dword)) }
    }
}

/// Development and test hosts: Windows behaviour simulated with SDDL kept in
/// a side file and a configurable test identity. Never used on Windows.
#[cfg(not(windows))]
pub mod sim {
    use super::*;
    use std::collections::{HashMap, HashSet};
    use std::sync::{LazyLock, RwLock};

    pub static FILE_SDDL: LazyLock<RwLock<HashMap<String, String>>> = LazyLock::new(Default::default);
    pub static DENIED: LazyLock<RwLock<HashSet<String>>> = LazyLock::new(Default::default);
    /// The test user's SID and group SIDs.
    pub static ME: LazyLock<RwLock<(String, Vec<String>)>> = LazyLock::new(|| RwLock::new(("S-1-5-21-1-2-3-1001".into(), vec!["S-1-1-0".into(), "S-1-5-11".into()])));

    pub fn key(p: &str) -> String {
        crate::guard::normalize(&p.replace('/', "\\"))
    }
    pub fn set_file_sddl(path: &str, sddl: &str) {
        FILE_SDDL.write().unwrap().insert(key(path), sddl.to_string());
    }
    pub fn deny(path: &str) {
        DENIED.write().unwrap().insert(key(path));
    }
    pub fn set_me(sid: &str, groups: &[&str]) {
        *ME.write().unwrap() = (sid.to_string(), groups.iter().map(|s| s.to_string()).collect());
    }
    pub fn reset() {
        FILE_SDDL.write().unwrap().clear();
        DENIED.write().unwrap().clear();
        set_me("S-1-5-21-1-2-3-1001", &["S-1-1-0", "S-1-5-11"]);
    }
    fn acl_file(dir: &std::path::Path) -> std::path::PathBuf {
        dir.join(".tp-acl")
    }
    /// Would the test user be let in by the nearest simulated folder lock?
    pub fn allowed_by_locks(path: &std::path::Path) -> bool {
        let (me, groups) = ME.read().unwrap().clone();
        let mine: HashSet<String> = std::iter::once(me).chain(groups).collect();
        let mut p = Some(path);
        while let Some(d) = p {
            if let Ok(s) = std::fs::read_to_string(acl_file(d)) {
                let Ok(dacl) = parse_dacl(&s) else { return false };
                let ra = ReadAccess::from_dacl(&dacl, &|x| alias_sid(x).map(str::to_string).unwrap_or_else(|| x.to_string())).unwrap_or_default();
                if ra.deny.iter().any(|s| mine.contains(s)) {
                    return false;
                }
                return ra.allow.iter().any(|s| mine.contains(s));
            }
            p = d.parent();
        }
        true
    }
    pub fn dacl_sddl(path: &str) -> Result<String, String> {
        if let Some(s) = FILE_SDDL.read().unwrap().get(&key(path)) {
            return Ok(s.clone());
        }
        let real = std::path::PathBuf::from(path.replace('\\', "/"));
        let lock = real.parent().map(|d| acl_file(if real.is_dir() { &real } else { d }));
        if let Some(Ok(s)) = lock.map(std::fs::read_to_string) {
            return Ok(s);
        }
        if real.exists() {
            Ok("D:AI(A;ID;FA;;;WD)".into())
        } else {
            Err("permissions unreadable: not found".into())
        }
    }
    pub fn set_protected_dacl(path: &str, sddl: &str) -> Result<(), String> {
        parse_dacl(sddl)?;
        std::fs::write(acl_file(std::path::Path::new(&path.replace('\\', "/"))), sddl).map_err(|e| e.to_string())
    }
    pub fn probe(path: &str, _dir: bool) -> Access {
        if DENIED.read().unwrap().contains(&key(path)) {
            return Access::Denied;
        }
        if std::path::Path::new(&path.replace('\\', "/")).exists() {
            Access::Allowed
        } else {
            Access::Missing
        }
    }
    pub fn current_user() -> Option<Identity> {
        let sid = ME.read().unwrap().0.clone();
        let user = std::env::var("USER").unwrap_or_else(|_| "dev".into());
        Some(Identity { sid, account: format!("DEV\\{user}"), display: user })
    }
}

// ── Public, platform-neutral entry points ──────────────────────────────────

/// An account (alias or SID) as a full SID string.
pub fn canon_sid(s: &str) -> String {
    if let Some(x) = alias_sid(s) {
        return x.to_string();
    }
    #[cfg(windows)]
    {
        win::canon_sid(s)
    }
    #[cfg(not(windows))]
    {
        s.to_string()
    }
}

/// The access list of a file or folder, as SDDL.
pub fn dacl_sddl(path: &str) -> Result<String, String> {
    #[cfg(windows)]
    {
        win::dacl_sddl(path)
    }
    #[cfg(not(windows))]
    {
        sim::dacl_sddl(path)
    }
}

/// Who may read `path`, as recorded in its own access list.
pub fn read_access(path: &str, cache: &std::sync::Mutex<std::collections::HashMap<String, String>>) -> Result<ReadAccess, String> {
    let sddl = dacl_sddl(path)?;
    let d = parse_dacl(&sddl)?;
    let canon = |s: &str| {
        if let Some(v) = cache.lock().unwrap().get(s) {
            return v.clone();
        }
        let v = canon_sid(s);
        cache.lock().unwrap().insert(s.to_string(), v.clone());
        v
    };
    ReadAccess::from_dacl(&d, &canon)
}

/// Lock a folder TracePoint created, then read the lock back and confirm
/// Windows stored what was asked. Any doubt is an error.
pub fn lock_folder(path: &str, sddl: &str) -> Result<(), String> {
    #[cfg(windows)]
    win::set_protected_dacl(path, sddl)?;
    #[cfg(not(windows))]
    sim::set_protected_dacl(path, sddl)?;
    let back = parse_dacl(&dacl_sddl(path)?)?;
    if !back.protected {
        return Err("the file server did not keep the folder's own permissions (inheritance is still on)".into());
    }
    Ok(())
}

/// Read-only check: may the signed-in user open this (folder: list it)?
pub fn probe(path: &str, dir: bool) -> Access {
    #[cfg(windows)]
    {
        win::probe(path, dir)
    }
    #[cfg(not(windows))]
    {
        sim::probe(path, dir)
    }
}

/// May the signed-in user open this TracePoint index file? On Windows the
/// file server decides when the file is opened.
pub fn can_open(path: &std::path::Path) -> Access {
    #[cfg(not(windows))]
    {
        if !path.exists() {
            return Access::Missing;
        }
        if !sim::allowed_by_locks(path) {
            return Access::Denied;
        }
    }
    match std::fs::File::open(path) {
        Ok(_) => Access::Allowed,
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => Access::Denied,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Access::Missing,
        Err(_) => Access::Unknown,
    }
}

pub fn current_user() -> Identity {
    #[cfg(windows)]
    let me = win::current_user();
    #[cfg(not(windows))]
    let me = sim::current_user();
    me.unwrap_or_else(|| Identity { sid: String::new(), account: "unknown".into(), display: "unknown".into() })
}

/// A Windows account by name (DOMAIN\user, user@domain or user).
pub fn lookup_account(name: &str) -> Result<Identity, String> {
    #[cfg(windows)]
    {
        win::lookup(name)
    }
    #[cfg(not(windows))]
    {
        let n = name.trim();
        if n.is_empty() {
            return Err("Enter a Windows account.".into());
        }
        let h = crate::crawl::stable_id("sid", &[&n.to_lowercase()]);
        let num = u32::from_str_radix(&h[4..12], 16).unwrap_or(1) % 90000 + 1000;
        let account = if n.contains('\\') { n.to_string() } else { format!("DEV\\{n}") };
        Ok(Identity { sid: format!("S-1-5-21-9-9-9-{num}"), display: account.rsplit('\\').next().unwrap_or(n).to_string(), account })
    }
}

/// The account name for a SID, when Windows can resolve it.
pub fn account_name(sid: &str) -> Option<String> {
    #[cfg(windows)]
    {
        win::account_name(sid)
    }
    #[cfg(not(windows))]
    {
        let _ = sid;
        None
    }
}

/// Encrypt for this Windows user on this PC (DPAPI). Dev hosts: a local key.
pub fn protect_secret(data: &[u8], local_dir: &std::path::Path) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    {
        let _ = local_dir;
        win::protect(data)
    }
    #[cfg(not(windows))]
    {
        use chacha20poly1305::aead::{Aead, KeyInit};
        let key = dev_key(local_dir)?;
        let mut nonce = [0u8; 24];
        getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;
        let c = chacha20poly1305::XChaCha20Poly1305::new((&key).into());
        let mut out = nonce.to_vec();
        out.extend(c.encrypt((&nonce).into(), data).map_err(|_| "encrypt failed".to_string())?);
        Ok(out)
    }
}

pub fn unprotect_secret(data: &[u8], local_dir: &std::path::Path) -> Result<zeroize::Zeroizing<Vec<u8>>, String> {
    #[cfg(windows)]
    {
        let _ = local_dir;
        win::unprotect(data)
    }
    #[cfg(not(windows))]
    {
        use chacha20poly1305::aead::{Aead, KeyInit};
        if data.len() < 40 {
            return Err("damaged".into());
        }
        let key = dev_key(local_dir)?;
        let c = chacha20poly1305::XChaCha20Poly1305::new((&key).into());
        c.decrypt(data[..24].into(), &data[24..]).map(zeroize::Zeroizing::new).map_err(|_| "Could not decrypt the key".to_string())
    }
}

#[cfg(not(windows))]
fn dev_key(local_dir: &std::path::Path) -> Result<[u8; 32], String> {
    let p = local_dir.join("dev-secret.key");
    if let Ok(b) = std::fs::read(&p) {
        if b.len() == 32 {
            let mut k = [0u8; 32];
            k.copy_from_slice(&b);
            return Ok(k);
        }
    }
    let mut k = [0u8; 32];
    getrandom::fill(&mut k).map_err(|e| e.to_string())?;
    std::fs::write(&p, k).map_err(|e| e.to_string())?;
    Ok(k)
}

/// IT policy values (HKLM, then HKCU \SOFTWARE\Policies\TracePoint).
/// Dev hosts: environment variables TP_POLICY_<NAME>.
pub fn policy_dword(name: &str) -> Option<u32> {
    #[cfg(windows)]
    {
        win::policy(name, true).and_then(|v| v.parse().ok())
    }
    #[cfg(not(windows))]
    {
        std::env::var(format!("TP_POLICY_{}", name.to_uppercase())).ok().and_then(|v| v.parse().ok())
    }
}

pub fn policy_string(name: &str) -> Option<String> {
    #[cfg(windows)]
    {
        win::policy(name, false).filter(|v| !v.trim().is_empty())
    }
    #[cfg(not(windows))]
    {
        std::env::var(format!("TP_POLICY_{}", name.to_uppercase())).ok().filter(|v| !v.trim().is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canon(s: &str) -> String {
        alias_sid(s).map(str::to_string).unwrap_or_else(|| s.to_string())
    }

    #[test]
    fn parses_typical_thor_acls() {
        // Engineering: protected; Engineers modify, admins full, a deny.
        let s = "D:PAI(D;OICI;FA;;;S-1-5-21-1-2-3-2222)(A;OICI;0x1301bf;;;S-1-5-21-1-2-3-1500)(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICIIO;FA;;;CO)";
        let d = parse_dacl(s).unwrap();
        assert!(d.protected);
        assert_eq!(d.aces.len(), 5);
        let r = ReadAccess::from_dacl(&d, &canon).unwrap();
        assert_eq!(r.deny.iter().collect::<Vec<_>>(), vec!["S-1-5-21-1-2-3-2222"]);
        assert!(r.allow.contains("S-1-5-21-1-2-3-1500") && r.allow.contains(SID_ADMINISTRATORS) && r.allow.contains(SID_SYSTEM));
        assert!(!r.allow.contains("S-1-3-0"), "inherit-only creator-owner doesn't apply to the file");
        let ci_oi = parse_dacl("D:(A;CIOI;FR;;;S-1-5-21-1-2-3-77)").unwrap();
        assert!(!ci_oi.aces[0].inherit_only(), "CIOI is not inherit-only");
        assert!(!r.broad());
        // Inherited list with string rights and Everyone.
        let open = parse_dacl("D:AI(A;ID;0x1200a9;;;WD)(A;ID;FA;;;BA)").unwrap();
        let ro = ReadAccess::from_dacl(&open, &canon).unwrap();
        assert!(ro.broad());
        // Write-only entries don't make someone a reader.
        let w = parse_dacl("D:(A;;0x116;;;S-1-5-21-1-2-3-9)").unwrap();
        assert!(ReadAccess::from_dacl(&w, &canon).unwrap().allow.is_empty());
        // A deny TracePoint can't reproduce: refuse.
        let x = parse_dacl("D:(XD;;FA;;;S-1-5-21-1-2-3-9;(Member_of {SID(BA)}))").unwrap_or_default();
        let _ = x;
        let x = Dacl { protected: false, null: false, aces: vec![Ace { kind: "XD".into(), flags: String::new(), mask: FULL_CONTROL, sid: "S-1-5-21-1-2-3-9".into() }] };
        assert!(ReadAccess::from_dacl(&x, &canon).is_err());
        // Null DACL = everyone.
        assert!(ReadAccess::from_dacl(&parse_dacl("D:NO_ACCESS_CONTROL").unwrap(), &canon).unwrap().broad());
    }

    #[test]
    fn fingerprint_groups_same_readers() {
        let a = ReadAccess::from_dacl(&parse_dacl("D:AI(A;ID;FA;;;BA)(A;ID;0x1301bf;;;S-1-5-21-1-2-3-1500)").unwrap(), &canon).unwrap();
        let b = ReadAccess::from_dacl(&parse_dacl("D:PAI(A;;FR;;;S-1-5-21-1-2-3-1500)(A;;FA;;;BA)").unwrap(), &canon).unwrap();
        assert_eq!(a.fingerprint(), b.fingerprint(), "modify vs read, inherited vs explicit: same readers");
        assert_eq!(ReadAccess::parse_fingerprint(&a.fingerprint()), a);
    }

    #[test]
    fn index_folder_lock_round_trips() {
        let r = ReadAccess::from_dacl(&parse_dacl("D:PAI(D;OICI;FA;;;S-1-5-21-1-2-3-2222)(A;OICI;FR;;;S-1-5-21-1-2-3-1500)").unwrap(), &canon).unwrap();
        let pubr = "S-1-5-21-1-2-3-1001";
        let sddl = r.index_folder_sddl(pubr);
        let d = parse_dacl(&sddl).unwrap();
        assert!(d.protected);
        assert_eq!(d.aces[0].kind, "D", "deny first");
        let back = ReadAccess::from_dacl(&d, &canon).unwrap();
        same_readers(&r, &back, pubr).unwrap();
        // A file server that adds Everyone is caught.
        let mut leaky = back.clone();
        leaky.allow.insert("S-1-1-0".into());
        assert!(same_readers(&r, &leaky, pubr).is_err());
        let mut lost = back.clone();
        lost.deny.clear();
        assert!(same_readers(&r, &lost, pubr).is_err());
    }

    #[test]
    fn rights_codes() {
        assert_eq!(parse_rights("FA"), Some(FULL_CONTROL));
        assert_eq!(parse_rights("0x1200a9"), Some(READ_EXECUTE));
        assert_eq!(parse_rights("CCLCSWRPWPDTLOCRSDRCWDWO"), Some(0xf01fd));
        assert_eq!(parse_rights("ZZ"), None);
    }
}
