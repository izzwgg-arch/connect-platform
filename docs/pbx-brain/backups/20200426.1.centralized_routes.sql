use ombutel;

/* DROP FOREIGN KEYS */
SET @table_name = 'ombu_extensions';
SET @column_name = 'ars_id';
SET @referenced_table_name = 'ombu_ars';
SET @referenced_column_name = 'ars_id';
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

SET @table_name = 'ombu_classes_of_service';
SET @column_name = 'shared_ars_id';
SET @referenced_table_name = 'ombu_ars';
SET @referenced_column_name = 'ars_id';
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

/* DROP OBSOLETE COLUMNS*/
alter table ombu_extensions
  drop column ars_id;

update ombu_classes_of_service set `ars_id` = `shared_ars_id` where `ars_id` is null;

alter table ombu_classes_of_service
 drop column `shared_ars_id`;