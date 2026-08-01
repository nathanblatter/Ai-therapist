-- Rollback 052: drops the pseudonym mapping. WARNING: previously published
-- exports can no longer be re-linked to source rows after this.
DROP TABLE IF EXISTS research_pseudonyms;
