//! What already exists: the unit, item and equipment folders on the network
//! drive (read only, never changed) and on the scan drive. New scans are
//! filed into the folder that already exists for their equipment, spelled
//! exactly as it is spelled there, so copying a finished unit onto the
//! network merges into the existing folders instead of creating near-copies.

use crate::spec::{self, EquipNo};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, serde::Serialize)]
pub struct EquipEntry {
    pub no: EquipNo,
    pub oos: bool,
    /// Path relative to the root it was found under, with `/` separators:
    /// `2000 - CRUDE UNIT/10 - VESSELS/2010.03 (CS) V-3 PREFRACTIONATOR TOWER`.
    pub rel: String,
    pub folder_name: String,
    /// Document-type folders already inside it.
    pub subfolders: Vec<String>,
    /// Found on a reference (network) folder rather than the scan drive.
    pub reference: bool,
}

impl EquipEntry {
    /// `V-3` from `2010.03 (CS) V-3 PREFRACTIONATOR TOWER`.
    pub fn tag(&self) -> Option<String> {
        tag_in(&self.folder_name)
    }
    pub fn description(&self) -> String {
        let rest = self.folder_name.splitn(2, &self.no.text).nth(1).unwrap_or("").trim().to_string();
        rest
    }
}

/// First plant tag in a text: `V-3`, `P-32A`, `E-101`, `TK-2`, `H-1`.
pub fn tag_in(s: &str) -> Option<String> {
    static R: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let r = R.get_or_init(|| regex::Regex::new(r"(?i)\b([A-Z]{1,3})\s?-\s?(\d{1,4}[A-Z]?)\b").unwrap());
    r.captures(s).map(|c| format!("{}-{}", c[1].to_ascii_uppercase(), c[2].to_ascii_uppercase()))
}

#[derive(Default, Clone, Debug)]
pub struct Registry {
    /// Unit number -> unit folder name.
    pub units: HashMap<u8, String>,
    /// (unit, item) -> item folder name inside that unit folder.
    pub items: HashMap<(u8, u8), String>,
    pub equipment: Vec<EquipEntry>,
    pub errors: Vec<String>,
    pub scanned_folders: usize,
}

const MAX_DEPTH: usize = 4;

impl Registry {
    /// Read the folder layout under each root. `reference` roots are the
    /// network drive (read only); the output root is the scan drive.
    pub fn scan(references: &[PathBuf], output: Option<&Path>) -> Registry {
        let mut r = Registry::default();
        for root in references {
            r.scan_root(root, true);
        }
        if let Some(o) = output {
            r.scan_root(o, false);
        }
        r
    }

    fn scan_root(&mut self, root: &Path, reference: bool) {
        let name = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        // A root that is itself a unit folder.
        if let Some(u) = spec::unit_of_folder(&name) {
            self.units.entry(u).or_insert_with(|| name.clone());
            self.walk(root, &name, Some(u), 1, reference);
            return;
        }
        let entries = match std::fs::read_dir(root) {
            Ok(e) => e,
            Err(e) => {
                self.errors.push(format!("{}: {e}", root.display()));
                return;
            }
        };
        for e in entries.flatten() {
            if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let n = e.file_name().to_string_lossy().to_string();
            if n.starts_with('_') || n.starts_with('.') {
                continue;
            }
            if let Some(u) = spec::unit_of_folder(&n) {
                // Reference spellings win over the scan drive's.
                if reference || !self.units.contains_key(&u) {
                    self.units.insert(u, n.clone());
                }
                self.walk(&e.path(), &n, Some(u), 1, reference);
            }
        }
    }

    fn walk(&mut self, dir: &Path, rel: &str, unit: Option<u8>, depth: usize, reference: bool) {
        if depth > MAX_DEPTH {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        self.scanned_folders += 1;
        for e in entries.flatten() {
            if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let n = e.file_name().to_string_lossy().to_string();
            let child_rel = format!("{rel}/{n}");
            if let Some((no, oos)) = spec::equip_folder(&n) {
                let subfolders = std::fs::read_dir(e.path())
                    .map(|it| it.flatten().filter(|x| x.file_type().map(|t| t.is_dir()).unwrap_or(false)).map(|x| x.file_name().to_string_lossy().to_string()).collect())
                    .unwrap_or_default();
                if !self.equipment.iter().any(|x| x.rel.eq_ignore_ascii_case(&child_rel)) {
                    self.equipment.push(EquipEntry { no, oos, rel: child_rel, folder_name: n, subfolders, reference });
                } else if let Some(x) = self.equipment.iter_mut().find(|x| x.rel.eq_ignore_ascii_case(&child_rel)) {
                    // Same folder on both drives: remember every subfolder.
                    for s in subfolders {
                        if !x.subfolders.iter().any(|y| y.eq_ignore_ascii_case(&s)) {
                            x.subfolders.push(s);
                        }
                    }
                    x.reference |= reference;
                }
                continue;
            }
            if depth == 1 {
                if let (Some(u), Some(i)) = (unit, spec::item_of_folder(&n)) {
                    if reference || !self.items.contains_key(&(u, i)) {
                        self.items.insert((u, i), n.clone());
                    }
                }
            }
            self.walk(&e.path(), &child_rel, unit, depth + 1, reference);
        }
    }

    /// Every existing folder for this number (an in-service and an
    /// out-of-service vessel can share one).
    pub fn find(&self, no: &EquipNo) -> Vec<&EquipEntry> {
        let k = no.key();
        let mut v: Vec<&EquipEntry> = self.equipment.iter().filter(|e| e.no.key() == k).collect();
        v.sort_by_key(|e| (!e.reference, e.oos, e.rel.len()));
        v
    }

    /// Folders whose name carries this tag (`V-6`), preferring the unit given.
    pub fn find_by_tag(&self, tag: &str, unit: Option<u8>) -> Vec<&EquipEntry> {
        let want = tag_in(tag).unwrap_or_else(|| tag.to_ascii_uppercase());
        let mut v: Vec<&EquipEntry> = self.equipment.iter().filter(|e| e.tag().as_deref() == Some(want.as_str())).collect();
        if let Some(u) = unit {
            let same: Vec<&EquipEntry> = v.iter().copied().filter(|e| e.no.unit == Some(u)).collect();
            if !same.is_empty() {
                v = same;
            }
        }
        v
    }

    pub fn unit_folder(&self, unit: u8) -> String {
        self.units.get(&unit).cloned().unwrap_or_else(|| spec::unit_folder(unit))
    }

    pub fn item_folder(&self, unit: u8, item: u8) -> String {
        if let Some(n) = self.items.get(&(unit, item)) {
            return n.clone();
        }
        // The same item spelled in another unit keeps folders consistent.
        if let Some(n) = self.items.iter().filter(|((_, i), _)| *i == item).map(|(_, n)| n).min() {
            return n.clone();
        }
        spec::item_folder(item)
    }

    /// Where a brand-new equipment folder goes (relative path).
    pub fn new_equipment_rel(&self, no: &EquipNo, tag: &str, description: &str) -> String {
        let folder = spec::equipment_folder_name(no, tag, description);
        let (unit, item) = match (no.unit, no.item) {
            (Some(u), Some(i)) => (u, i),
            // Tanks: storage, tanks.
            _ => (72, 72),
        };
        format!("{}/{}/{}", self.unit_folder(unit), self.item_folder(unit, item), folder)
    }

    /// The document-type folder inside an equipment folder, reusing an
    /// existing spelling (`DATA SHEETS`, `Emails`, `Photos`).
    pub fn doc_subfolder(entry_subfolders: &[String], wanted: &str) -> String {
        let w = spec::loose(wanted);
        let w1 = w.trim_end_matches('S').to_string();
        let aliases: &[&str] = match wanted {
            "PICTURES" => &["PHOTOS", "PHOTOGRAPHS"],
            "CODE DOCUMENTS" => &["CODEPACKAGE", "CODEDOCS"],
            "VENDOR DATA" => &["VENDORDOCUMENTS", "VENDORINFO"],
            _ => &[],
        };
        for s in entry_subfolders {
            let l = spec::loose(s);
            if l == w || l.trim_end_matches('S') == w1 || aliases.contains(&l.as_str()) {
                return s.clone();
            }
        }
        wanted.to_string()
    }

    /// Remember a folder this program just created.
    pub fn add_created(&mut self, no: &EquipNo, rel: &str) {
        if self.equipment.iter().any(|e| e.rel.eq_ignore_ascii_case(rel)) {
            return;
        }
        let name = rel.rsplit('/').next().unwrap_or(rel).to_string();
        self.equipment.push(EquipEntry { no: no.clone(), oos: false, rel: rel.to_string(), folder_name: name, subfolders: vec![], reference: false });
        let mut parts = rel.split('/');
        if let (Some(u), Some(i)) = (parts.next(), parts.next()) {
            if let Some(un) = spec::unit_of_folder(u) {
                self.units.entry(un).or_insert_with(|| u.to_string());
                if let Some(it) = spec::item_of_folder(i) {
                    self.items.entry((un, it)).or_insert_with(|| i.to_string());
                }
            }
        }
    }

    pub fn note_subfolder(&mut self, rel: &str, sub: &str) {
        if let Some(e) = self.equipment.iter_mut().find(|e| e.rel.eq_ignore_ascii_case(rel)) {
            if !e.subfolders.iter().any(|s| s.eq_ignore_ascii_case(sub)) {
                e.subfolders.push(sub.to_string());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_and_place() {
        let t = std::env::temp_dir().join(format!("intake-reg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&t);
        let net = t.join("net");
        let out = t.join("out");
        for p in [
            "2000 - CRUDE UNIT/10 - VESSELS/2010.03 (CS) V-3 PREFRACTIONATOR TOWER/DATA SHEETS",
            "2000 - CRUDE UNIT/10 - VESSELS/O - OOS - 2010.03 (SS) PRE-FRACTIONATOR TOWER",
            "2000 - CRUDE UNIT/10 - VESSELS/6110.14 V-14 35# Steam Drum",
            "2000 - CRUDE UNIT/15 - PIPING/2015-001 Crude Charge to P32 & P33",
            "2000 - CRUDE UNIT/26 - PUMPS (CENTRIFUGAL)/2026.14 P-14 CHARGE PUMP/Emails",
        ] {
            std::fs::create_dir_all(net.join(p)).unwrap();
        }
        std::fs::create_dir_all(&out).unwrap();
        let r = Registry::scan(&[net.clone()], Some(&out));
        let v = r.find(&spec::parse_equip("2010.03").unwrap());
        assert_eq!(v.len(), 2);
        assert!(!v[0].oos, "in-service first");
        assert_eq!(r.find(&spec::parse_equip("6110.14").unwrap())[0].rel, "2000 - CRUDE UNIT/10 - VESSELS/6110.14 V-14 35# Steam Drum");
        assert_eq!(r.find(&spec::parse_equip("2015-001").unwrap()).len(), 1);
        assert_eq!(Registry::doc_subfolder(&v[0].subfolders, "DATASHEETS"), "DATA SHEETS");
        let p = r.find(&spec::parse_equip("2026.14").unwrap())[0];
        assert_eq!(Registry::doc_subfolder(&p.subfolders, "EMAILS"), "Emails");
        assert_eq!(p.tag().as_deref(), Some("P-14"));
        assert_eq!(r.find_by_tag("v-3", Some(20)).len(), 1);
        let rel = r.new_equipment_rel(&spec::parse_equip("2010.06").unwrap(), "V-6", "Stabilizer");
        assert_eq!(rel, "2000 - CRUDE UNIT/10 - VESSELS/2010.06 V-6 STABILIZER");
        let rel = r.new_equipment_rel(&spec::parse_equip("2530.01").unwrap(), "E-1", "Feed Exchanger");
        assert_eq!(rel, "2500 - DIESEL HYDROTREATER UNIT (DHT)/30 - EXCHANGERS/2530.01 E-1 FEED EXCHANGER");
        let _ = std::fs::remove_dir_all(&t);
    }
}
