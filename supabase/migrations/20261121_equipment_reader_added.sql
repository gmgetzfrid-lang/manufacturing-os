-- Equipment: remember what the drawing reader itself wrote into a drawing's
-- equipment column, so "Start over from the drawings" (Operating areas,
-- at the bottom) takes exactly that off and never an entry a person typed.
--
-- Until this runs, Start over still works: it takes off only entries the
-- run journal (estate_run_changes, migration 20261021) shows a run added,
-- and leaves the rest. The app writes this column when it exists and skips
-- it when it doesn't. Safe to run more than once.

begin;

alter table public.document_equipment_suggestions
  add column if not exists reader_added jsonb not null default '[]'::jsonb;

comment on column public.document_equipment_suggestions.reader_added is
  'Tags the drawing reader wrote into the document''s equipment column itself (not ones already there). Start over takes these off.';

commit;

notify pgrst, 'reload schema';
