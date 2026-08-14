-- 20261013_answer_feedback.sql
--
-- Answer feedback: the "how does it get smarter" loop. A thumbs-up/down on
-- an answer is stored on its knowledge_questions row. Future asks search
-- past THUMBS-UP answers for similar questions and pull their cited pages
-- into the passage pool first — retrieval learns which ground actually
-- answered, one rating at a time. (RAG never retrains a model; it
-- accumulates structure. This is the structure.)

ALTER TABLE knowledge_questions
  ADD COLUMN IF NOT EXISTS rating SMALLINT
    CHECK (rating IS NULL OR rating IN (-1, 1));
ALTER TABLE knowledge_questions
  ADD COLUMN IF NOT EXISTS rated_at TIMESTAMPTZ;

-- The proven-ground lookup: "similar past question, rated useful, newest
-- first" — partial index keeps it cheap no matter how big history grows.
CREATE INDEX IF NOT EXISTS knowledge_questions_rated_idx
  ON knowledge_questions (library_id, created_at DESC)
  WHERE rating = 1;
