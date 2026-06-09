use ombutel;

/* Drop some FKs */
SET @table_name = 'ombu_classes_of_service';
SET @column_name = 'feature_code_category_id';
SET @referenced_table_name = 'ombu_feature_code_categories';
SET @referenced_column_name = 'feature_code_category_id';
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

alter table ombu_classes_of_service
    add constraint ombu_cos_fcc_fk
        foreign key (feature_code_category_id) references ombu_feature_code_categories (feature_code_category_id)
            on delete set null,
    add constraint ombu_cos_ars_fk
        foreign key (ars_id) references ombu_ars (ars_id)
            on delete set null;