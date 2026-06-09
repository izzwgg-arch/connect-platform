use `ombutel`;

SET @table_name = 'ai_api_keys';
SET @column_name = 'api_key';

SELECT
    @index_name := INDEX_NAME
FROM
    information_schema.STATISTICS
WHERE
    TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = @table_name
    AND COLUMN_NAME = @column_name
    AND NON_UNIQUE = 0
LIMIT 1;

-- Drop the unique index if it exists
SET @query = CONCAT('ALTER TABLE ', @table_name, ' DROP INDEX ', @index_name);
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
