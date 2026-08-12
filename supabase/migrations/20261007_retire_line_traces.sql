-- Retire the pixel line-tracer's cache.
--
-- Line tracing on P&IDs was tried in earnest, in several revisions, against
-- real SHX drawings. Endpoint location plus dense line-work kept it below
-- the reliability an engineer can act on, and a confidently wrong route on
-- a drawing is worse than no route. The feature is removed; this drops its
-- only table. Everything else the drawing work produced stays: the entity
-- index, the equipment census, the reference audit, and tag pointing.
DROP TABLE IF EXISTS knowledge_line_traces;
