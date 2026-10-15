//! Compact snapshot of a THOR knowledge database for embedding in the exe.
//!
//! Same schema 2.0 tables (so the same loader reads it), keeping only what
//! search needs; the crawler's working tables (retrieval terms, evidence,
//! queues, patterns, AI ledgers) are left out and rebuilt by the next scan.

use rusqlite::{Connection, OpenFlags};
use std::path::Path;

const KEEP: &[(&str, &str)] = &[
    ("meta", "select * from src.meta"),
    ("roots", "select * from src.roots"),
    ("crawls", "select * from src.crawls"),
    ("files", "select * from src.files"),
    ("entities", "select * from src.entities"),
    ("aliases", "select * from src.aliases"),
    ("alias_candidates", "select * from src.alias_candidates"),
    ("document_links", "select * from src.document_links"),
    ("doc_families", "select * from src.doc_families"),
    ("doc_members", "select * from src.doc_members"),
    ("relationships", "select * from src.relationships"),
    ("directory_profiles", "select profile_id,root_id,path,role,confidence,authority_score,'{}',updated_at from src.directory_profiles where role<>'directory'"),
    ("identifiers", "select * from src.identifiers where type in ('sheet','revision') and file_id is not null"),
    ("issues", "select * from src.issues"),
];

/// Write a pruned copy of `src` to `dst` and return its size in bytes.
pub fn make(src: &Path, dst: &Path) -> Result<u64, String> {
    let e = |x: rusqlite::Error| x.to_string();
    if dst.exists() {
        std::fs::remove_file(dst).map_err(|x| x.to_string())?;
    }
    let out = Connection::open(dst).map_err(e)?;
    let srcc = Connection::open_with_flags(src, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(e)?;
    out.execute("attach database ?1 as src", [format!("file:{}?mode=ro", src.display())]).ok();
    // Fall back to a plain attach if URI filenames are disabled.
    let attached: i64 = out.query_row("select count(*) from pragma_database_list where name='src'", [], |r| r.get(0)).map_err(e)?;
    if attached == 0 {
        out.execute("attach database ?1 as src", [src.display().to_string()]).map_err(e)?;
    }
    out.execute_batch("pragma synchronous=off; begin;").map_err(e)?;
    for (table, select) in KEEP {
        let sql: Option<String> = srcc
            .query_row("select sql from sqlite_master where type='table' and name=?1", [table], |r| r.get(0))
            .ok();
        let Some(sql) = sql else { continue };
        out.execute_batch(&sql).map_err(e)?;
        out.execute(&format!("insert into main.{table} {select}"), []).map_err(e)?;
    }
    out.execute_batch("commit; detach database src; vacuum;").map_err(e)?;
    drop(out);
    Ok(std::fs::metadata(dst).map(|m| m.len()).unwrap_or(0))
}

/// zstd-compress a file (level 19, long window) for embedding.
pub fn compress(src: &Path, dst: &Path) -> Result<u64, String> {
    let data = std::fs::read(src).map_err(|e| e.to_string())?;
    let mut enc = zstd::stream::Encoder::new(Vec::new(), 19).map_err(|e| e.to_string())?;
    enc.long_distance_matching(true).map_err(|e| e.to_string())?;
    enc.window_log(27).map_err(|e| e.to_string())?;
    std::io::Write::write_all(&mut enc, &data).map_err(|e| e.to_string())?;
    let out = enc.finish().map_err(|e| e.to_string())?;
    std::fs::write(dst, &out).map_err(|e| e.to_string())?;
    Ok(out.len() as u64)
}

pub fn decompress(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut dec = zstd::stream::Decoder::new(data).map_err(|e| e.to_string())?;
    dec.window_log_max(27).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    std::io::Read::read_to_end(&mut dec, &mut out).map_err(|e| e.to_string())?;
    Ok(out)
}
