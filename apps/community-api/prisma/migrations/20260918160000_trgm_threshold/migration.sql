-- Trigram typo tolerance: the search uses the index-backed `%` operator, whose
-- cut-off is pg_trgm.similarity_threshold (default 0.3 misses "embroidry").
-- Set it at the database level so every pooled connection agrees.
DO $$ BEGIN
  EXECUTE format('ALTER DATABASE %I SET pg_trgm.similarity_threshold = 0.12', current_database());
END $$;
