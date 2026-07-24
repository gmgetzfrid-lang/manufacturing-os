-- Archive-aware file opening: /api/storage/resolve AND the (now archive-aware)
-- /api/storage/download-url both look a storage key up in document_versions by
-- file_url on every open/sign. Give that lookup an index — without it each
-- thumbnail/viewer sign is a sequential scan.

CREATE INDEX IF NOT EXISTS document_versions_file_url_idx
  ON document_versions (file_url);
