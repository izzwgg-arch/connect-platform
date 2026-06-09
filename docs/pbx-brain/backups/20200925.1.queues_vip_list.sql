use `ombutel`;

/* Drop some FKs */
alter table ombu_queue_vip_list_entries
 drop foreign key if exists  `ombu_queue_vip_list_entries_ibfk_1`;

SET @table_name = 'ombu_queues';
SET @column_name = 'queue_vip_list_id';
SET @referenced_table_name = 'ombu_queue_vip_lists';
SET @referenced_column_name = 'queue_vip_list_id';
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

/* Set field to auto increment*/
alter table ombu_queue_vip_lists
 modify  column `queue_vip_list_id` int unsigned not null auto_increment;

/* Recreate FKs */
alter table ombu_queue_vip_list_entries
  add foreign key (`queue_vip_list_id`) references `ombu_queue_vip_lists` (`queue_vip_list_id`) on delete  cascade;

alter table ombu_queues
    add foreign key (`queue_vip_list_id`) references `ombu_queue_vip_lists` (`queue_vip_list_id`) on delete set null;