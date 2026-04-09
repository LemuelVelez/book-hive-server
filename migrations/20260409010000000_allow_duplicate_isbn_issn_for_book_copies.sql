BEGIN;

DO $$
DECLARE
  constraint_record RECORD;
  index_record RECORD;
BEGIN
  FOR constraint_record IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE t.relname = 'books'
      AND n.nspname = current_schema()
      AND c.contype = 'u'
      AND EXISTS (
        SELECT 1
        FROM unnest(c.conkey) AS key_cols(attnum)
        JOIN pg_attribute a
          ON a.attrelid = c.conrelid
         AND a.attnum = key_cols.attnum
        WHERE a.attname IN ('isbn', 'issn')
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I DROP CONSTRAINT IF EXISTS %I',
      current_schema(),
      'books',
      constraint_record.conname
    );
  END LOOP;

  FOR index_record IN
    SELECT schemaname, indexname
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'books'
      AND indexdef ILIKE 'CREATE UNIQUE INDEX%'
      AND (
        indexdef ILIKE '%(isbn%' OR
        indexdef ILIKE '%(issn%' OR
        indexdef ILIKE '% isbn %' OR
        indexdef ILIKE '% issn %'
      )
  LOOP
    EXECUTE format(
      'DROP INDEX IF EXISTS %I.%I',
      index_record.schemaname,
      index_record.indexname
    );
  END LOOP;
END $$;

COMMIT;