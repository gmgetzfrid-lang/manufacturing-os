//! The shared index, split by who may read it.
//!
//! An administrator's scan records, for every THOR file, which Windows
//! accounts may open it (`tp_file_access`). Files with the same readers form
//! one *lock group*. Publishing writes one small database per lock group —
//! only those files, and only the equipment, drawing families and folder
//! notes that come from them — into its own folder, locked with the same
//! readers (see `acl`). Each PC opens only the groups Windows lets it open
//! and merges them in memory.
//!
//! Nothing that names a file or folder is copied anywhere else: no counts,
//! no examples, no scan log in a shared group file.

use rusqlite::{params, Connection, OpenFlags};
use std::collections::HashSet;
use std::path::Path;

/// Tables a group file carries (everything search, equipment and the graph
/// read), plus the two access tables.
pub const INDEX_TABLES: &[&str] = &[
    "meta",
    "roots",
    "crawls",
    "files",
    "identifiers",
    "document_links",
    "doc_families",
    "doc_members",
    "entities",
    "aliases",
    "alias_candidates",
    "relationships",
    "directory_profiles",
    "tp_access",
    "tp_file_access",
];

fn has_table(c: &Connection, schema: &str, t: &str) -> bool {
    c.query_row(&format!("select count(*) from {schema}.sqlite_master where name=?1 and type='table'"), [t], |r| r.get::<_, i64>(0)).unwrap_or(0) > 0
}

fn columns(c: &Connection, schema: &str, t: &str) -> Vec<String> {
    let Ok(mut st) = c.prepare(&format!("pragma {schema}.table_info(\"{t}\")")) else { return vec![] };
    st.query_map([], |r| r.get::<_, String>(1)).map(|rows| rows.flatten().collect()).unwrap_or_default()
}

/// Create `t` in main like it is in `schema` (same columns and keys).
fn copy_table_def(c: &Connection, schema: &str, t: &str) -> rusqlite::Result<bool> {
    if has_table(c, "main", t) {
        return Ok(true);
    }
    let sql: Option<String> = c.query_row(&format!("select sql from {schema}.sqlite_master where name=?1 and type='table'"), [t], |r| r.get(0)).ok();
    match sql {
        Some(sql) => {
            c.execute_batch(&sql)?;
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Insert rows of `schema.t` into main.t for the columns both have.
fn copy_rows(c: &Connection, schema: &str, t: &str, filter: &str) -> rusqlite::Result<usize> {
    let mine: HashSet<String> = columns(c, "main", t).into_iter().collect();
    let cols: Vec<String> = columns(c, schema, t).into_iter().filter(|x| mine.contains(x)).map(|x| format!("\"{x}\"")).collect();
    if cols.is_empty() {
        return Ok(0);
    }
    let list = cols.join(",");
    c.execute(&format!("insert or ignore into main.\"{t}\"({list}) select {list} from {schema}.\"{t}\" {filter}"), [])
}

/// Write the group file for `class` from an administrator's index.
/// Returns how many files it holds.
pub fn split_index(master: &Path, class: &str, out: &Path) -> Result<usize, String> {
    let e = |x: rusqlite::Error| format!("Building the shared index: {x}");
    let _ = std::fs::remove_file(out);
    let c = Connection::open(out).map_err(e)?;
    c.pragma_update(None, "journal_mode", "OFF").map_err(e)?;
    c.pragma_update(None, "synchronous", "OFF").map_err(e)?;
    c.execute("attach database ?1 as m", [master.to_string_lossy()]).map_err(e)?;
    for t in INDEX_TABLES {
        copy_table_def(&c, "m", t).map_err(e)?;
    }
    c.execute_batch("begin").map_err(e)?;
    c.execute("create temp table cf(file_id text primary key)", []).map_err(e)?;
    c.execute("insert into cf select file_id from m.tp_file_access where class=?1", [class]).map_err(e)?;
    let n = copy_rows(&c, "m", "files", "where file_id in (select file_id from temp.cf)").map_err(e)?;
    copy_rows(&c, "m", "tp_file_access", "where file_id in (select file_id from temp.cf)").map_err(e)?;
    c.execute("insert or ignore into tp_access select * from m.tp_access where class=?1", [class]).map_err(e)?;
    // Counts would tell readers about files they can't see.
    c.execute("update tp_access set files=0", []).map_err(e)?;
    copy_rows(&c, "m", "roots", "where root_id in (select distinct root_id from main.files)").map_err(e)?;
    if has_table(&c, "m", "crawls") {
        copy_rows(&c, "m", "crawls", "where root_id in (select distinct root_id from main.files)").map_err(e)?;
        c.execute("update crawls set files_seen=0, dirs_seen=0, issues=0", []).map_err(e)?;
    }
    if has_table(&c, "m", "meta") {
        copy_rows(&c, "m", "meta", "").map_err(e)?;
    }
    for t in ["identifiers", "document_links", "doc_members"] {
        if has_table(&c, "m", t) {
            copy_rows(&c, "m", t, "where file_id in (select file_id from temp.cf)").map_err(e)?;
        }
    }
    if has_table(&c, "m", "doc_families") {
        copy_rows(&c, "m", "doc_families", "where family_id in (select family_id from main.doc_members)").map_err(e)?;
    }
    if has_table(&c, "m", "entities") {
        // Equipment these files are about: linked, or named by number.
        copy_rows(
            &c,
            "m",
            "entities",
            "where entity_id in (select entity_id from main.document_links)
               or (entity_type='equipment' and canonical_name in (select value from main.identifiers where type='equipment_number'))",
        )
        .map_err(e)?;
        if has_table(&c, "m", "alias_candidates") {
            copy_rows(&c, "m", "alias_candidates", "where entity_id in (select entity_id from main.entities)").map_err(e)?;
        }
        if has_table(&c, "m", "aliases") {
            copy_rows(&c, "m", "aliases", "where alias_id in (select alias_id from main.alias_candidates)").map_err(e)?;
        }
        if has_table(&c, "m", "relationships") {
            copy_rows(&c, "m", "relationships", "where from_id in (select entity_id from main.entities) and to_id in (select entity_id from main.entities)").map_err(e)?;
        }
    }
    if has_table(&c, "m", "directory_profiles") {
        // Notes on folders these files are in (and above them), nothing else.
        let mut dirs: HashSet<String> = HashSet::new();
        {
            let mut st = c.prepare("select parent_path from main.files").map_err(e)?;
            let rows = st.query_map([], |r| r.get::<_, String>(0)).map_err(e)?;
            for p in rows.flatten() {
                let mut d = p.trim_end_matches('\\').to_lowercase();
                while dirs.insert(d.clone()) {
                    match d.rfind('\\') {
                        Some(i) if i > 2 => d.truncate(i),
                        _ => break,
                    }
                }
            }
        }
        c.execute("create temp table dirs(d text primary key)", []).map_err(e)?;
        {
            let mut ins = c.prepare("insert or ignore into temp.dirs values(?1)").map_err(e)?;
            for d in &dirs {
                ins.execute([d]).map_err(e)?;
            }
        }
        copy_rows(&c, "m", "directory_profiles", "where rtrim(lower(path),'\\') in (select d from temp.dirs)").map_err(e)?;
    }
    c.execute_batch("commit").map_err(e)?;
    c.execute("detach database m", []).map_err(e)?;
    Ok(n)
}

/// The document text of one group's files.
pub fn split_content(content_master: &Path, index_master: &Path, class: &str, out: &Path) -> Result<usize, String> {
    let e = |x: rusqlite::Error| format!("Building the shared document text: {x}");
    let _ = std::fs::remove_file(out);
    let c = Connection::open(out).map_err(e)?;
    c.pragma_update(None, "journal_mode", "OFF").map_err(e)?;
    c.pragma_update(None, "synchronous", "OFF").map_err(e)?;
    crate::content::ensure_schema(&c).map_err(e)?;
    c.execute("attach database ?1 as m", [content_master.to_string_lossy()]).map_err(e)?;
    c.execute("attach database ?1 as ix", [index_master.to_string_lossy()]).map_err(e)?;
    c.execute_batch("begin").map_err(e)?;
    c.execute("create temp table cf(file_id text primary key)", []).map_err(e)?;
    c.execute("insert into cf select file_id from ix.tp_file_access where class=?1", [class]).map_err(e)?;
    let n = copy_rows(&c, "m", "content_files", "where file_id in (select file_id from temp.cf)").map_err(e)?;
    c.execute("insert into content_fts(text,file_id,page,method) select text,file_id,page,method from m.content_fts where file_id in (select file_id from temp.cf)", []).map_err(e)?;
    if has_table(&c, "m", "ai_stage") {
        copy_rows(&c, "m", "ai_stage", "where file_id in (select file_id from temp.cf)").map_err(e)?;
    }
    c.execute_batch("commit").map_err(e)?;
    c.execute_batch("detach database m; detach database ix;").map_err(e)?;
    Ok(n)
}

/// Merge group files into `out` (usually in memory). Rows already present
/// win; columns are matched by name, so files from older versions mix.
pub fn merge(parts: &[std::path::PathBuf], out: &Connection) -> Result<(), String> {
    let e = |x: rusqlite::Error| format!("Merging the index: {x}");
    for (i, p) in parts.iter().enumerate() {
        let alias = format!("p{i}");
        let uri = format!("file:{}?mode=ro", p.to_string_lossy().replace('?', "%3f").replace('#', "%23"));
        out.execute(&format!("attach database ?1 as {alias}"), [uri]).map_err(e)?;
        let tables: Vec<String> = {
            let mut st = out.prepare(&format!("select name from {alias}.sqlite_master where type='table'")).map_err(e)?;
            let rows = st.query_map([], |r| r.get::<_, String>(0)).map_err(e)?;
            rows.flatten().filter(|t| !t.starts_with("sqlite_") && !t.starts_with("content_fts_")).collect()
        };
        out.execute_batch("begin").map_err(e)?;
        for t in &tables {
            if copy_table_def(out, &alias, t).map_err(e)? {
                if t == "content_fts" {
                    out.execute(&format!("insert into main.content_fts(text,file_id,page,method) select text,file_id,page,method from {alias}.content_fts"), []).map_err(e)?;
                } else {
                    copy_rows(out, &alias, t, "").map_err(e)?;
                }
            }
        }
        out.execute_batch("commit").map_err(e)?;
        out.execute(&format!("detach database {alias}"), []).map_err(e)?;
    }
    Ok(())
}

/// A group file's own description: (class, readers, representative files to
/// check with Windows on this PC).
pub fn describe(path: &Path, reps: usize) -> Result<(String, String, Vec<String>), String> {
    let c = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(|e| e.to_string())?;
    let (class, readers): (String, String) = c.query_row("select class, readers from tp_access limit 1", [], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?;
    // Spread across folders: one file from each of the first `reps` folders.
    let mut st = c
        .prepare("select path from files where observation_state='current' group by parent_path order by random() limit ?1")
        .map_err(|e| e.to_string())?;
    let paths = st.query_map(params![reps as i64], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?.flatten().collect();
    Ok((class, readers, paths))
}

/// Lock groups of an administrator's index: (class, root_id, readers, broad, files).
pub fn classes(master: &Connection) -> Vec<(String, String, String, bool, i64)> {
    let Ok(mut st) = master.prepare("select class, root_id, readers, broad, files from tp_access where files > 0 order by root_id, files desc") else { return vec![] };
    st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, i64>(3)? != 0, r.get(4)?))).map(|rows| rows.flatten().collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn master(dir: &Path) -> std::path::PathBuf {
        let p = dir.join("master.db");
        let c = Connection::open(&p).unwrap();
        crate::crawl::ensure_schema(&c).unwrap();
        c.execute_batch(
            r"insert into roots values('r1','\\thor\Share','\\thor\share','2026',null,null,1);
              insert into crawls values('c1','r1','2026','2026','inventory_complete',100,10,3);
              create table entities(entity_id text primary key, entity_type text, canonical_name text, status text);
              create table document_links(link_id text primary key, file_id text, entity_id text, link_type text);
              create table directory_profiles(profile_id text primary key, root_id text, path text, role text);
              insert into entities values('e1','equipment','5610.15','active'),('e2','equipment','7777.01','active');
              insert into directory_profiles values('d1','r1','\\thor\Share\Open','EQUIPMENT'),('d2','r1','\\thor\Share\Secret Project','PROJECT');
              insert into tp_access values('open','r1','A:S-1-1-0',1,1,'2026'),('secret','r1','A:S-1-5-21-1-2-3-1500',0,1,'2026');
              insert into tp_file_access values('f1','open',null),('f2','secret',null);
              insert into document_links values('l1','f1','e1','DOCUMENT_FOR_EQUIPMENT'),('l2','f2','e2','DOCUMENT_FOR_EQUIPMENT');",
        )
        .unwrap();
        for (id, path, parent) in [("f1", r"\\thor\Share\Open\5610.15 UT.pdf", r"\\thor\Share\Open"), ("f2", r"\\thor\Share\Secret Project\7777.01 plan.pdf", r"\\thor\Share\Secret Project")] {
            c.execute(
                "insert into files(file_id,root_id,path,norm_path,filename,stem,extension,parent_path,depth,filename_class,useful,first_seen,last_seen,first_crawl,last_crawl,observation_state,change_state)
                 values(?1,'r1',?2,lower(?2),'x','x','.pdf',?3,1,'SEMANTIC',1,'','','','','current','new')",
                params![id, path, parent],
            )
            .unwrap();
        }
        p
    }

    #[test]
    fn group_files_hold_only_their_own_names() {
        let dir = std::env::temp_dir().join(format!("tp-part-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let m = master(&dir);
        let open = dir.join("open.db");
        assert_eq!(split_index(&m, "open", &open).unwrap(), 1);
        let raw = String::from_utf8_lossy(&std::fs::read(&open).unwrap()).to_string();
        assert!(!raw.contains("Secret Project") && !raw.contains("7777.01"), "no trace of the locked group in the open file");
        let c = Connection::open(&open).unwrap();
        let ents: Vec<String> = c.prepare("select canonical_name from entities").unwrap().query_map([], |r| r.get(0)).unwrap().flatten().collect();
        assert_eq!(ents, vec!["5610.15"]);
        let seen: i64 = c.query_row("select files_seen from crawls", [], |r| r.get(0)).unwrap();
        assert_eq!(seen, 0, "no totals that count other groups");
        // Merge two groups: both visible.
        let secret = dir.join("secret.db");
        split_index(&m, "secret", &secret).unwrap();
        let mem = Connection::open_in_memory().unwrap();
        merge(&[open.clone(), secret], &mem).unwrap();
        let n: i64 = mem.query_row("select count(*) from files", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
        let idx = crate::index::Index::load_conn(&mem).unwrap();
        assert_eq!(idx.files.len(), 2);
        // Only the open group: the locked one leaves nothing behind.
        let mem = Connection::open_in_memory().unwrap();
        merge(&[open], &mem).unwrap();
        let idx = crate::index::Index::load_conn(&mem).unwrap();
        assert_eq!(idx.files.len(), 1);
        assert!(idx.dirs.iter().all(|d| !d.path.to_lowercase().contains("secret")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
