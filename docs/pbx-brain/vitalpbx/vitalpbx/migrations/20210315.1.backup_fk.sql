use `ombutel`;

SET @table_name = 'ombu_backup_groups';
SET @column_name = 'cron_profile_id';
SET @referenced_table_name = 'ombu_cron_profiles';
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

alter table `ombu_backup_groups`
    add foreign key (`cron_profile_id`) references `ombu_cron_profiles` (`id`) on delete set null;