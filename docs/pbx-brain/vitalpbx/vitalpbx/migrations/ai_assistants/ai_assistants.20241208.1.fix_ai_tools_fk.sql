use `ombutel`;

/* Drop FK who refers to ai_api_keys table */
SET @table_name = 'ai_tools';
SET @column_name = 'ai_api_key_id';
SET @referenced_table_name = 'ai_api_keys';
SET @referenced_column_name = 'id';
SET @db_name = 'ombutel';

SET @constraint_name = (
    SELECT constraint_name
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE TABLE_NAME = @table_name
      AND COLUMN_NAME = @column_name
      AND CONSTRAINT_SCHEMA = @db_name
      AND referenced_table_name = @referenced_table_name
      AND referenced_column_name = @referenced_column_name);

SET @s = concat('alter table ', @table_name, ' drop foreign key ', @constraint_name);
PREPARE stmt FROM @s;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

/* Create new FK, but, more relaxed */
alter table `ai_tools`
    add foreign key (`ai_api_key_id`) references `ai_api_keys` (`id`) on delete cascade;