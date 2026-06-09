use `ombutel`;

SET @table_name = 'ombu_queues_callback';
SET @column_name = 'cos_id';
SET @referenced_table_name = 'ombu_classes_of_service';
SET @referenced_column_name = 'class_of_service_id';
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

alter table `ombu_queues_callback`
    add foreign key (`cos_id`) references `ombu_classes_of_service` (`class_of_service_id`) on delete cascade;