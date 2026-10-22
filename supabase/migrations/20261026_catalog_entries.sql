-- Catalogs are marked by people, not guessed. Rows from the old guesser
-- ("pipe_class" entries, "pipe_spec" profiles) are cleared; the app reads
-- old pipe_spec profiles as ordinary documents either way.
delete from knowledge_page_entities where kind = 'pipe_class';
update knowledge_page_entities set tag = 'other' where kind = 'profile' and tag = 'pipe_spec';
